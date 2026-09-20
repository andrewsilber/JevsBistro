import type { Simulation } from "./engine";
import type { DecisionContext, SimulationObserver } from "./types";
import type { LlmInteraction } from "../llm/activity";
import { inferenceBody, inferenceInstructions, inferenceState } from "../llm/protocol";
import { payloadSizes } from "../llm/compact-state";

const round = (n: number) => Math.round(n * 100) / 100;
export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, mean: sorted.length ? round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null,
    median: sorted.length ? round((sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2) : null,
    p90: sorted.length ? round(sorted[Math.ceil(sorted.length * .9) - 1]) : null, max: sorted.at(-1) ?? null };
}
export function fingerprint(value: unknown) {
  let hash = 2166136261;
  for (const ch of JSON.stringify(value)) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function planRow(context: DecisionContext, ids: (string | undefined)[], accepted: boolean) {
  const greets = context.candidates.filter((c) => c.kind === "greet").map((c) => ({
    id: c.id, table: c.table, party: c.party, wait: round(context.now - (context.observations.find((o) => o.table === c.table)?.since ?? context.now)),
    evidenceAge: round(context.now - c.observedAt), priority: round(c.priority), travel: round(context.travelSeconds.start[c.id]),
  }));
  return { at: context.now, server: context.server.id, inventory: { plates: context.server.plates, drinks: context.server.drinks, dirty: context.server.dirty, water: round(context.server.water) },
    ids, accepted, greets,
    alternatives: context.candidates.map((c) => ({ id: c.id, party: c.party, priority: round(c.priority), travel: round(context.travelSeconds.start[c.id]),
      service: c.duration, evidenceAge: round(context.now - c.observedAt), reason: c.reason })),
  };
}
type PlanRow = ReturnType<typeof planRow>;
type Episode = { table: number; party: number; seatedAt: number; greetedAt?: number; wait?: number };
type ActionEvent = Parameters<NonNullable<SimulationObserver["action"]>>[0];
const TRACE_LIMIT = 4000;

/** Read-only measurement. Full totals survive bounded trace retention. */
export class DiagnosticRecorder implements SimulationObserver {
  private episodes = new Map<number, Episode>();
  private plans: PlanRow[] = [];
  private actions: ActionEvent[] = [];
  private omittedPlans = 0;
  private omittedActions = 0;
  private planCount = 0;
  private greetOffered = 0;
  private greetNotFirst = 0;
  private greetOmitted = 0;
  private actionCounts: Record<string, { start: number; complete: number; cancel: number }> = {};
  private worstDeferrals: PlanRow[] = [];
  private firstChoice: Record<string, number> = {};
  private serverTime: Record<number, { walking: number; serving: number; idle: number; previousWalking: number }> = {};
  private lastSample = 0;
  private peakQueue = 0;
  private peakUngreeted = 0;
  private seenInteractions = new Set<string>();
  private interactions: { at: number; server: number; status: string; attempts: number; input?: number; output?: number; cached?: number; wallMs: number; error?: string; diagnostics?: unknown; ids?: string[]; payloadChars: Record<string, number> }[] = [];
  private requestSamples: { score: number; request: ReturnType<typeof inferenceBody>; response?: LlmInteraction["response"]; error?: string }[] = [];
  private payloads: Record<string, number[]> = {};
  private inputs: number[] = [];
  private outputTokens: number[] = [];
  private latencies: number[] = [];
  private omittedInteractions = 0;
  private instructions?: string;
  transition: NonNullable<SimulationObserver["transition"]> = (event) => {
    if (!event.party) return;
    if (event.to === "greet") this.episodes.set(event.party, { table: event.table, party: event.party, seatedAt: event.at });
    if (event.from === "greet" && event.to === "reading") {
      const episode = this.episodes.get(event.party);
      if (episode) { episode.greetedAt = event.at; episode.wait = event.at - event.since; }
    }
  };
  plan: NonNullable<SimulationObserver["plan"]> = (context, ids, accepted) => {
    const row = planRow(context, ids, accepted);
    this.planCount++;
    const kind = context.candidates.find((c) => c.id === ids[0])?.kind ?? "none";
    this.firstChoice[kind] = (this.firstChoice[kind] ?? 0) + 1;
    if (row.greets.length) {
      this.greetOffered++;
      if (!row.greets.some((g) => g.id === ids[0])) this.greetNotFirst++;
      if (!row.greets.some((g) => ids.includes(g.id))) {
        this.greetOmitted++;
        this.worstDeferrals.push(row);
        this.worstDeferrals.sort((a, b) => Math.max(...b.greets.map((g) => g.wait)) - Math.max(...a.greets.map((g) => g.wait)));
        this.worstDeferrals.length = Math.min(12, this.worstDeferrals.length);
      }
    }
    if (this.plans.length === TRACE_LIMIT) { this.plans.shift(); this.omittedPlans++; }
    this.plans.push(row);
  };
  action: NonNullable<SimulationObserver["action"]> = (event) => {
    const counts = this.actionCounts[event.action.kind] ??= { start: 0, complete: 0, cancel: 0 };
    counts[event.event]++;
    if (this.actions.length === TRACE_LIMIT) { this.actions.shift(); this.omittedActions++; }
    this.actions.push(event);
  };
  sample(sim: Simulation) {
    if (sim.pendingDecision || sim.now <= this.lastSample) return;
    const dt = sim.now - this.lastSample;
    for (const s of sim.servers) {
      const times = this.serverTime[s.id] ??= { walking: 0, serving: 0, idle: 0, previousWalking: 0 };
      const walking = Math.min(dt, (s.walking - times.previousWalking) / 1.25);
      times.walking += walking;
      if (s.job) times.serving += dt - walking; else times.idle += dt - walking;
      times.previousWalking = s.walking;
    }
    this.peakQueue = Math.max(this.peakQueue, sim.queue.length);
    this.peakUngreeted = Math.max(this.peakUngreeted, sim.tables.filter((t) => t.stage === "greet").length);
    this.lastSample = sim.now;
  }
  interaction = (entry: LlmInteraction) => {
    if (["waiting", "cooldown"].includes(entry.status) || this.seenInteractions.has(entry.id)) return;
    this.seenInteractions.add(entry.id);
    const request = inferenceBody(entry.context, entry.model, entry.provider);
    this.instructions = inferenceInstructions(request);
    const sizes = { compactState: inferenceState(request).length, originalState: payloadSizes(entry.context).originalStateCharacters, originalObservations: JSON.stringify(entry.context.observations).length,
      candidates: JSON.stringify(entry.context.candidates).length, travel: JSON.stringify(entry.context.travelSeconds).length,
      fullBody: JSON.stringify(request).length };
    for (const [key, value] of Object.entries(sizes)) (this.payloads[key] ??= []).push(value);
    const response = entry.response;
    if (response) { this.inputs.push(response.inputTokens); this.outputTokens.push(response.outputTokens); }
    const wallMs = (entry.endedAt ?? entry.startedAt) - entry.startedAt;
    this.latencies.push(wallMs);
    if (this.interactions.length === TRACE_LIMIT) { this.interactions.shift(); this.omittedInteractions++; }
    this.interactions.push({ at: entry.context.now, server: entry.context.server.id, status: entry.status, attempts: entry.attempt ?? 1,
      input: response?.inputTokens, output: response?.outputTokens, cached: response?.cachedTokens, wallMs,
      error: entry.error, diagnostics: entry.diagnostics, ids: response?.ids, payloadChars: sizes });
    const selected = response?.ids ?? [];
    const deferred = entry.context.candidates.filter((c) => c.kind === "greet" && !selected.includes(c.id));
    const oldest = Math.max(0, ...deferred.map((c) => entry.context.now - (entry.context.observations.find((o) => o.table === c.table)?.since ?? entry.context.now)));
    // Retain exact prompt/response evidence for the worst private-planner deferrals.
    this.requestSamples.push({ score: oldest, request, response, error: entry.error });
    this.requestSamples.sort((a, b) => b.score - a.score || inferenceState(b.request).length - inferenceState(a.request).length);
    this.requestSamples.length = Math.min(3, this.requestSamples.length);
  };
  finish(sim: Simulation) {
    this.sample(sim);
    const pending = sim.tables.filter((t) => t.party && !["empty", "dirty"].includes(t.stage)).map((t) => ({ table: t.id, party: t.party!.id,
      stage: t.stage, wait: round(sim.now - t.since), reservedBy: t.reservedBy, request: t.request?.kind }));
    return {
      schemaVersion: 1, scenarioFingerprint: fingerprint(sim.scenario), layoutFingerprint: fingerprint({ ...sim.layout, blocked: [...sim.layout.blocked] }),
      units: "Simulation seconds and metres unless named otherwise; payload lengths are characters, NOT tokens.",
      waits: Object.fromEntries((["seatingWaits", "greetingWaits", "orderWaits", "foodWaits", "paymentWaits", "drinkOrderWaits", "requestResponseWaits", "requestResolutionWaits"] as const).map((key) => [key, distribution(sim.metrics[key])])),
      pending, pendingQueue: sim.queue.map((p) => ({ party: p.id, wait: round(sim.now - p.arrivedAt) })),
      greetingEpisodes: [...this.episodes.values()].map((e) => ({ ...e, wait: e.wait ?? sim.now - e.seatedAt, pending: e.greetedAt === undefined })).sort((a, b) => b.wait - a.wait),
      peakQueueParties: this.peakQueue, peakUngreetedTables: this.peakUngreeted,
      serverTime: Object.fromEntries(Object.entries(this.serverTime).map(([id, { previousWalking, ...times }]) => [id, Object.fromEntries(Object.entries(times).map(([k, v]) => [k, round(v)]))])),
      currentServers: sim.servers.map((s) => ({ id: s.id, position: s.position, status: s.status, job: s.job, itinerary: s.itinerary,
        plates: s.plates.length, drinks: s.drinks.length, dirty: s.dirty, water: round(s.water), completed: s.completed, walking: round(s.walking) })),
      plans: { total: this.planCount, firstChoice: this.firstChoice, greetOffered: this.greetOffered, greetNotFirst: this.greetNotFirst, greetOmitted: this.greetOmitted, worstDeferrals: this.worstDeferrals },
      actionCounts: this.actionCounts,
      llm: { interactions: this.seenInteractions.size, inputTokens: distribution(this.inputs), outputTokens: distribution(this.outputTokens),
        wallMs: distribution(this.latencies), payloadCharacters: Object.fromEntries(Object.entries(this.payloads).map(([k, v]) => [k, distribution(v)])), instructions: this.instructions },
      traces: { plans: this.plans, actions: this.actions, interactions: this.interactions, requestSamples: this.requestSamples,
        omittedPlans: this.omittedPlans, omittedActions: this.omittedActions, omittedInteractions: this.omittedInteractions },
      recentEvents: sim.events.slice(0, 50),
    };
  }
}
export type RunDiagnostics = ReturnType<DiagnosticRecorder["finish"]>;

