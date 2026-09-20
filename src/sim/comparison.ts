import { Simulation, average } from "./engine";
import type { Config, Metrics } from "./types";
import type { ProxyUsage } from "../llm/protocol";
import type { RunDiagnostics } from "./diagnostics";

export interface ComparisonRun {
  seed: number; planner: Config["planner"]; mode: Config["mode"];
  finished: boolean; simulatedSeconds: number; metrics: Metrics;
  provider?: "openai" | "jev"; proxy?: boolean; usage?: ProxyUsage; error?: string;
  diagnostics?: RunDiagnostics;
}
export const PROXY_CONDITIONS = [
  { planner: "route", mode: "patrol", proxy: false },
  { planner: "route", mode: "camera", proxy: false },
  { planner: "route", mode: "camera", proxy: true },
] as const;
export const CONDITIONS = [
  { planner: "greedy", mode: "patrol" }, { planner: "route", mode: "patrol" },
  { planner: "greedy", mode: "camera" }, { planner: "route", mode: "camera" },
] as const;
export function compareRun(config: Config): ComparisonRun {
  const sim = new Simulation(config, undefined, undefined, { recordHistory: false });
  const limit = config.duration * 60 + 14400;
  while (!sim.finished && sim.now < limit) sim.step();
  return { seed: config.seed, planner: config.planner, mode: config.mode, finished: sim.finished, simulatedSeconds: sim.now, metrics: sim.metrics };
}
export function summarize(runs: ComparisonRun[]) {
  const totals = (key: "walking" | "completed" | "turnedAway" | "revenue" | "cocktailsServed") => runs.reduce((sum, r) => sum + r.metrics[key], 0);
  const waits = (key: "foodWaits" | "greetingWaits" | "drinkOrderWaits" | "requestResponseWaits" | "requestResolutionWaits") => runs.flatMap((r) => r.metrics[key]);
  const food = waits("foodWaits").sort((a, b) => a - b);
  const dinerSeconds = runs.reduce((sum, r) => sum + r.metrics.occupiedDinerSeconds, 0);
  return { completed: totals("completed"), leftQueue: totals("turnedAway"), revenue: totals("revenue"),
    metersPerGuest: totals("walking") / Math.max(1, totals("completed")),
    greeting: average(waits("greetingWaits")), food: average(food), foodP90: food.length ? food[Math.ceil(food.length * 0.9) - 1] : 0,
    requestResponse: average(waits("requestResponseWaits")), requestResolution: average(waits("requestResolutionWaits")),
    requestsRaised: runs.reduce((n, r) => n + r.metrics.requestsRaised, 0), requestsResolved: waits("requestResolutionWaits").length,
    emptyWater: dinerSeconds ? runs.reduce((sum, r) => sum + r.metrics.emptyGlassSeconds, 0) / dinerSeconds * 100 : 0,
    drinks: average(waits("drinkOrderWaits")), cocktails: totals("cocktailsServed"), allFinished: runs.every((r) => r.finished) };
}
