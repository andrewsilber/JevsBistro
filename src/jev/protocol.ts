import type { Candidate, DecisionContext } from "../sim/types";

export const JEV_MODELS = ["jev-1.13.0", "jev-latest", "jev-preview"] as const;
export const JEV_INSTRUCTIONS = "Choose the best next restaurant service tour for this server. Balance overdue greetings, waiting guests, ready food, empty water and efficient walking. Do not starve older needs. All offered tours are feasible; durations and waits are already calculated in seconds. A tour ends at an inventory-changing station. Evidence may be stale; an unknown request needs a conversation, not an inferred hidden intention. Priority is only a rules heuristic. Choose based on the observed needs and consequences. Tour alternatives are not an exhaustive search of every itinerary.";
const terminal = new Set(["pickup", "bar_pickup", "supplies", "pitcher", "drop"]);
const round = (n: number) => Math.round(n * 10) / 10;

/** One single-stop and one useful multi-stop option per first action. No first-action pruning.
 * Follow-ups use the same discounted work/time objective as the rules baseline.
 * This bounds inference size; Jev chooses tours, code owns routing and inventory math. */
export function jevTours(ctx: DecisionContext) {
  type Tour = { ids: string[]; elapsed: number; walking: number; reward: number; dirty: number; water: number; tables: number[] };
  const extend = (tour: Tour, c: Candidate): Tour | undefined => {
    const last = ctx.candidates.find((item) => item.id === tour.ids.at(-1));
    if (last && terminal.has(last.kind) || tour.ids.includes(c.id) || c.table && tour.tables.includes(c.table)) return;
    if (c.kind === "refill" && tour.water < .5 || ["pickup", "bar_pickup"].includes(c.kind) && tour.dirty || tour.dirty + (c.dirtyLoad ?? 0) > 4) return;
    const travel = ctx.travelSeconds[tour.ids.at(-1) ?? "start"]?.[c.id];
    if (!Number.isFinite(travel)) return;
    const elapsed = tour.elapsed + travel + (c.duration ?? 5);
    return { ids: [...tour.ids, c.id], elapsed, walking: tour.walking + travel, reward: tour.reward + c.priority * Math.exp(-elapsed / 180),
      dirty: tour.dirty + (c.dirtyLoad ?? 0), water: Math.max(0, tour.water - (c.waterNeeded ?? 0)), tables: c.table ? [...tour.tables, c.table] : tour.tables };
  };
  const tours: Record<string, Tour> = {};
  const add = (tour: Tour) => { tours[`tour_${Object.keys(tours).length + 1}`] = tour; };
  for (const first of ctx.candidates) {
    const single = extend({ ids: [], elapsed: 0, walking: 0, reward: 0, dirty: ctx.server.dirty, water: ctx.server.water, tables: [] }, first);
    if (!single) continue;
    add(single);
    let best = single, frontier = [single];
    for (let depth = 1; depth < 3; depth++) {
      const next = frontier.flatMap((tour) => ctx.candidates.map((c) => extend(tour, c)).filter((t): t is Tour => !!t));
      next.sort((a, b) => b.reward / (20 + b.elapsed) - a.reward / (20 + a.elapsed) || a.ids.join().localeCompare(b.ids.join()));
      if (next[0] && next[0].reward / (20 + next[0].elapsed) > best.reward / (20 + best.elapsed)) best = next[0];
      frontier = next.slice(0, 8);
    }
    if (best !== single) add(best);
  }
  return tours;
}

export function jevRequest(context: DecisionContext, model: string) {
  const tours = jevTours(context);
  const tasks = context.candidates.map((c) => {
    const o = context.observations.find((o) => o.table === c.table);
    return { action: c.id, kind: c.kind, table: c.table, reason: c.reason, heuristicPriority: round(c.priority),
      serviceSeconds: c.duration ?? 5, evidenceAgeSeconds: round(Math.max(0, context.now - c.observedAt)),
      tableState: o && { stage: o.stage, stageAgeSeconds: round(Math.max(0, context.now - o.since)), source: o.source,
        evidenceAgeSeconds: round(Math.max(0, context.now - o.at)), request: o.request, requestPhase: o.requestPhase,
        bill: o.bill, waterPercent: o.diners.map((d) => d.waterPercent), finishedPlates: o.finished.filter(Boolean).length } };
  });
  const criteria = Object.fromEntries(Object.entries(tours).map(([id, t]) => [id,
    `Perform in order: ${t.ids.join(" then ")}. Walking ${round(t.walking)} seconds; finish all service in ${round(t.elapsed)} seconds.`]));
  return { model, state: { server: context.server, tasks }, questions: { service_tour: { type: "choice" as const, instructions: JEV_INSTRUCTIONS, criteria } } };
}

export function readJevAnswer(context: DecisionContext, result: any) {
  const tours = jevTours(context), answer = result?.answers?.service_tour;
  const keys = Object.keys(tours), probabilities = answer?.probabilities;
  const validProbability = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
  const invalid = (detail: string): never => { throw Error(`Jev returned an invalid response: ${detail}. Restaurant remains paused; inspect LLM activity.`); };
  if (answer?.type !== "choice") invalid("answers.service_tour.type must be choice");
  if (typeof answer.choice !== "string" || !Object.hasOwn(tours, answer.choice)) invalid("the chosen tour was not offered in this request");
  if (!validProbability(answer.confidence)) invalid("confidence must be a finite number between 0 and 1");
  if (!probabilities || typeof probabilities !== "object" || Array.isArray(probabilities) ||
    Object.keys(probabilities).length !== keys.length || keys.some((k) => !Object.hasOwn(probabilities, k)))
    invalid("probability option IDs do not match the offered tours");
  if (keys.some((k) => !validProbability(probabilities[k]))) invalid("each probability must be a finite number between 0 and 1");
  if (typeof result.model !== "string" || !/^jev-[\w.-]+$/.test(result.model)) invalid("model must identify the Jev model used");
  if (!Number.isSafeInteger(result.usage?.input_tokens) || result.usage.input_tokens < 0) invalid("usage.input_tokens must be a non-negative integer");
  if (!Number.isSafeInteger(result.usage?.output_tokens) || result.usage.output_tokens < 0) invalid("usage.output_tokens must be a non-negative integer");

  // Treat the provider's explicit choice as its decision, not the argmax of the
  // reported distribution. Live responses can disagree. Preserve that evidence;
  // never silently replace the selected plan or renormalize reported probabilities.
  const warnings: string[] = [];
  const probabilitySum = keys.reduce((n, k) => n + probabilities[k], 0);
  const highestProbability = Math.max(...keys.map((k) => probabilities[k]));
  if (highestProbability > probabilities[answer.choice] + .000001)
    warnings.push(`Jev's explicit choice has reported probability ${probabilities[answer.choice]}, below the maximum ${highestProbability}. Following the explicit choice; tour feasibility is validated separately.`);
  if (Math.abs(probabilitySum - 1) > .01)
    warnings.push(`Reported probabilities sum to ${Number(probabilitySum.toFixed(8))}, not 1. Preserved as received; following Jev's explicit choice.`);
  return { ids: tours[answer.choice].ids, model: result.model, inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens,
    cachedTokens: 0, provider: "jev" as const, diagnostics: { choice: answer.choice, confidence: answer.confidence, probabilities,
      choicePolicy: "follow-explicit-choice", probabilitySum, highestProbability, warnings } };
}
