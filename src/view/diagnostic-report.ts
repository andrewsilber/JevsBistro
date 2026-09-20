import type { ComparisonRun } from "../sim/comparison";
import type { Config } from "../sim/types";
import type { ProxySettings } from "../llm/protocol";
import { COMPACT_STATE_VERSION } from "../llm/compact-state";

export function diagnosticReport(config: Config, runs: ComparisonRun[], seeds: number, settings: ProxySettings, status: string) {
  const json = (value: unknown) => JSON.stringify(value);
  const lines = ["JEVSBISTRO DIAGNOSTIC REPORT v1", `Generated: ${new Date().toISOString()}`, `Comparison status: ${status}`,
    `Requested: ${seeds} paired seed(s), 3 conditions each. Recorded: ${runs.length} runs. Encoding: ${settings.provider === "jev" ? "Jev named-state / typed Choice tours v1" : COMPACT_STATE_VERSION}.`,
    `Conditions: multi-stop rules/local scans; multi-stop rules/full-room cameras; ${settings.provider === "jev" ? "real Jev" : "OpenAI proxy"}/full-room cameras. Same configuration and pre-generated guests for each seed.`,
    "All waits below are SIMULATED SECONDS. Real inference, cooldowns and retries freeze the simulation clock. Provider is identified in settings; this is a held-clock benchmark, not a measurement of deployment latency.",
    "Greeting = seated to greeting/menu delivery COMPLETED (includes 8s service). Seating wait is separate.",
    "Order = ready to order to order SUBMITTED (includes 12s service), not food arrival. Food = kitchen-ready to delivered.",
    "Wait statistics include completed stages only; inspect pending waits and completion counts. Server activity is sampled per tick (approximate).",
    "Action completion counts include service attempts that may be stale/no-ops; greeting episodes and wait counts measure actual stage transitions. Plan counts include automatic single-candidate choices.",
    "Greeting omission means a feasible greeting was offered but absent from the selected plan; it does not prove that the choice was wrong.",
    "Payload sizes are characters, not token estimates. Tokens are provider-reported for received responses. Failed/cancelled requests can have unknown charges.",
    "Configuration: " + json(config), "Proxy settings (call limit PER proxy run): " + json(settings), ""];
  for (let i = 0; i < seeds; i++) {
    const seed = (config.seed + i) % 2147483648, group = runs.filter((r) => r.seed === seed);
    const hashes = new Set(group.map((r) => r.diagnostics?.scenarioFingerprint)), layouts = new Set(group.map((r) => r.diagnostics?.layoutFingerprint));
    const conditions = new Set(group.map((r) => r.proxy ? "proxy" : r.mode));
    lines.push(`Seed ${seed}: ${group.length}/3 recorded; all finished=${group.length === 3 && group.every((r) => r.finished)}; unique conditions=${conditions.size}; matched scenario/layout=${group.length === 3 && !hashes.has(undefined) && !layouts.has(undefined) && hashes.size === 1 && layouts.size === 1}.`);
  }
  for (const run of runs) {
    const d = run.diagnostics;
    lines.push("", `=== Seed ${run.seed} | ${run.proxy ? (settings.provider === "jev" ? "REAL JEV / CAMERA" : "OPENAI PROXY / CAMERA") : run.mode === "patrol" ? "RULES / LOCAL" : "RULES / CAMERA"} ===`,
      `Finished=${run.finished}; elapsed=${run.simulatedSeconds}s; error=${run.error ?? "none"}`);
    const totals = Object.fromEntries(Object.entries(run.metrics).filter(([, value]) => !Array.isArray(value)));
    lines.push("Totals: " + json(totals), "AI usage: " + json(run.usage ?? { calls: 0 }));
    if (!d) { lines.push("Diagnostic instrumentation unavailable for this run."); continue; }
    lines.push("Scenario/layout fingerprints: " + d.scenarioFingerprint + " / " + d.layoutFingerprint,
      "Completed waits (n, mean, median, p90, max): " + json(d.waits),
      "Pending table stages: " + json(d.pending), "Pending entrance queue: " + json(d.pendingQueue),
      `Peak entrance parties=${d.peakQueueParties}; peak ungreeted tables=${d.peakUngreetedTables}`,
      "Server seconds (walking/serving/idle): " + json(d.serverTime),
      "Current server tasks: " + json(d.currentServers.map(({ job, ...s }) => ({ ...s, job: job ? { id: job.id, serviceLeft: job.serviceLeft, startedService: job.startedService, remainingPathCells: job.path.length } : null }))),
      "Actual actions (start/complete/cancel counts): " + json(d.actionCounts),
      "Plans: " + json({ total: d.plans.total, firstChoice: d.plans.firstChoice, greetingOffered: d.plans.greetOffered, greetingNotFirst: d.plans.greetNotFirst, greetingOmittedEntirely: d.plans.greetOmitted }),
      "Longest 12 greeting waits (completed AND pending): " + json(d.greetingEpisodes.slice(0, 12)),
      "Worst greeting omissions (up to 8; chosen actions plus highest-priority alternatives):");
    for (const row of d.plans.worstDeferrals.slice(0, 8)) {
      const selected = row.alternatives.filter((c) => row.ids.includes(c.id));
      const alternatives = [...row.alternatives].sort((a, b) => b.priority - a.priority).slice(0, 8);
      lines.push(json({ at: row.at, server: row.server, inventory: row.inventory, chosen: row.ids, accepted: row.accepted, greets: row.greets, selected, alternatives }));
    }
    lines.push("LLM token/payload/latency distributions: " + json({ ...d.llm, instructions: undefined }));
    lines.push("LLM failures/cancellations (latest 10): " + json(d.traces.interactions.filter((e) => e.status !== "received").slice(-10)));
    if (settings.provider === "jev") lines.push("Jev choice evidence (up to 3 exact request/response samples): " + json(d.traces.requestSamples));
    const worst = d.plans.worstDeferrals[0];
    if (worst) {
      lines.push(`Actual actions around worst omission at ${worst.at}s (±30s; latest 40 within window):`);
      lines.push(json(d.traces.actions.filter((e) => Math.abs(e.at - worst.at) <= 30).slice(-40).map((e) => ({ at: e.at, server: e.server, event: e.event, id: e.action.id, party: e.action.party }))));
    }
    lines.push("Last 12 events: " + json(d.recentEvents.slice(0, 12)),
      `Full-export trace retention: plans=${d.traces.plans.length} (${d.traces.omittedPlans} older omitted), actions=${d.traces.actions.length} (${d.traces.omittedActions} older omitted), LLM interactions=${d.traces.interactions.length} (${d.traces.omittedInteractions} older omitted). Totals cover the entire run.`,
      `Full export also includes ${d.traces.requestSamples.length} exact prompt/response samples, selected for oldest deferred greeting, then largest payload.`);
  }
  const instructions = runs.find((r) => r.diagnostics?.llm.instructions)?.diagnostics?.llm.instructions;
  if (instructions) lines.push("", "Exact planner instructions: " + instructions);
  lines.push("", "This paste contains summaries and targeted evidence, not every retained event. Export comparison JSON for retained detailed traces and exact prompt samples. No API keys or authentication headers are included.", "END JEVSBISTRO DIAGNOSTIC REPORT");
  return lines.join("\n");
}
