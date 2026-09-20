import { jevRequest } from "../jev/protocol";
import type { DecisionContext } from "../sim/types";
import { compactState, COMPACT_STATE_LEGEND } from "./compact-state";

export const MODELS = ["gpt-5.4-nano", "gpt-5-nano", "gpt-5.4-mini"] as const;
export type Provider = "openai" | "jev";
export interface ProxySettings { provider?: Provider; model: string; maxCalls: number }
export interface ProxyUsage {
  calls: number; inputTokens: number; outputTokens: number; cachedTokens: number;
  wallMs: number; failures: number; estimatedUsd: number; unknownPriceCalls?: number;
}
export const emptyUsage = (): ProxyUsage => ({ calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, wallMs: 0, failures: 0, estimatedUsd: 0 });
export interface PlanResponse { provider?: Provider; ids: string[]; inputTokens: number; outputTokens: number; cachedTokens: number; wallMs: number; model: string; diagnostics?: unknown }
export function addUsage(usage: ProxyUsage, result: PlanResponse) {
  usage.inputTokens += result.inputTokens; usage.outputTokens += result.outputTokens;
  usage.cachedTokens += result.cachedTokens; usage.wallMs += result.wallMs;
  const rates: Record<string, number[]> = { "jev-1.13.0": [0.042, 0.042, 0], "gpt-5.4-nano": [0.2, 0.02, 1.25], "gpt-5-nano": [0.05, 0.005, 0.4], "gpt-5.4-mini": [0.75, 0.075, 4.5] };
  if (!rates[result.model]) usage.unknownPriceCalls = (usage.unknownPriceCalls ?? 0) + 1;
  const [input, cached, output] = rates[result.model] ?? [0, 0, 0];
  usage.estimatedUsd += ((result.inputTokens - result.cachedTokens) * input + result.cachedTokens * cached + result.outputTokens * output) / 1e6;
}
/** Stable, bounded action IDs; no hidden guest intentions or simulation object. */
export function responseBody(context: DecisionContext, model: string) {
  return {
    model, store: false, max_output_tokens: model === "gpt-5-nano" ? 2048 : 512,
    reasoning: { effort: model === "gpt-5-nano" ? "minimal" : "none" },
    instructions: `You dispatch a restaurant server using only observed evidence. Choose 1–3 distinct candidate IDs in execution order. Minimize guest waits, hot food delay, empty water, and walking; avoid starving old tasks. Observations may be stale. Priority is a heuristic hint, not an instruction to copy. Travel and action durations are seconds. Tray capacity is 4; never mix dirty dishes with clean food/drinks. Do not visit a table twice in one plan. Track waterNeeded and dirtyLoad across stops. End a plan at pickup, bar_pickup, supplies, pitcher, or drop, since inventory must be observed again. Refill requires at least 0.5 water. Only use provided candidates; never invent an action. Respond only with the itinerary.\n${COMPACT_STATE_LEGEND}`,
    input: JSON.stringify(compactState(context)),
    text: { format: { type: "json_schema", name: "server_itinerary", strict: true, schema: {
      type: "object", properties: { ids: { type: "array", items: { type: "string", enum: context.candidates.map((c) => c.id) }, minItems: 1, maxItems: 3 } },
      required: ["ids"], additionalProperties: false,
    } } },
  };
}

export function inferenceBody(context: DecisionContext, model: string, provider?: Provider) {
  return provider === "jev" ? jevRequest(context, model) : responseBody(context, model);
}
export function inferenceInstructions(body: ReturnType<typeof inferenceBody>): string { return "instructions" in body ? body.instructions : body.questions.service_tour.instructions; }
export function inferenceState(body: ReturnType<typeof inferenceBody>): string { return "input" in body ? body.input : JSON.stringify(body.state); }
