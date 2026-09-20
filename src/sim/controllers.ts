import type { DecisionContext, DecisionEngine } from "./types";
/** Next-task reference planner; observation source is configured independently. */
export class ServiceController implements DecisionEngine {
  constructor(readonly id = "patrol") {}
  choose(ctx: DecisionContext): string | undefined {
    return [...ctx.candidates].sort(
      (a, b) =>
        b.priority -
          ctx.travelSeconds.start[b.id] * 2.25 -
          (a.priority - ctx.travelSeconds.start[a.id] * 2.25) ||
        a.id.localeCompare(b.id),
    )[0]?.id;
  }
}

/** Three-stop beam search over observed needs, true route costs and carried inventory.
 * Plans end at supply/pickup stops because their resulting inventory must be observed.
 * The engine revalidates each next stop, and replans after interruption or urgency changes.
 */
export class RouteController implements DecisionEngine {
  readonly id = "route";
  choose(ctx: DecisionContext) { return this.plan(ctx)[0]; }
  plan(ctx: DecisionContext): string[] {
    const urgent = ctx.candidates.filter((c) => ["pickup", "bar_pickup"].includes(c.kind) && c.priority >= 128);
    const candidates = [...(urgent.length ? urgent : ctx.candidates)].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)).slice(0, 14);
    type Tour = { ids: string[]; tables: number[]; at: string; elapsed: number; reward: number; score: number; dirty: number; water: number; done: boolean };
    let beam: Tour[] = [{ ids: [], tables: [], at: "start", elapsed: 0, reward: 0, score: 0, dirty: ctx.server.dirty, water: ctx.server.water, done: false }];
    let best: Tour | undefined;
    for (let depth = 0; depth < 3; depth++) {
      const expanded: Tour[] = [];
      for (const tour of beam) for (const c of candidates) {
        if (depth === 0 && urgent.length && !urgent.includes(c)) continue;
        if (tour.done || tour.ids.includes(c.id) || (c.table && tour.tables.includes(c.table))) continue;
        if (c.kind === "refill" && tour.water < 0.5) continue;
        if ((c.kind === "pickup" || c.kind === "bar_pickup") && tour.dirty) continue;
        if ((c.dirtyLoad ?? 0) + tour.dirty > 4) continue;
        const travel = ctx.travelSeconds[tour.at]?.[c.id] ?? Infinity;
        if (!Number.isFinite(travel)) continue;
        const elapsed = tour.elapsed + travel + (c.duration ?? 5);
        // Compare useful work per tour time, not raw task count. A fixed dispatch
        // allowance rewards adjacent stops without automatically preferring three stops.
        const reward = tour.reward + c.priority * Math.exp(-elapsed / 180);
        const score = reward / (20 + elapsed);
        const next: Tour = { ids: [...tour.ids, c.id], tables: c.table ? [...tour.tables, c.table] : tour.tables,
          at: c.id, elapsed, reward, score, dirty: tour.dirty + (c.dirtyLoad ?? 0), water: Math.max(0, tour.water - (c.waterNeeded ?? 0)),
          done: ["pickup", "bar_pickup", "supplies", "pitcher", "drop"].includes(c.kind) };
        expanded.push(next);
        if (!best || next.score > best.score || (next.score === best.score && next.ids.join() < best.ids.join())) best = next;
      }
      beam = expanded.sort((a, b) => b.score - a.score || a.ids.join().localeCompare(b.ids.join())).slice(0, 18);
    }
    return best?.ids ?? [];
  }
}
/** Future live adapter contract. Responses must pass action validation before execution.
 * Never expose an API key in the browser. Live HTTP belongs in a server-side adapter.
 * Async results need an observation version, deadline, and fallback controller.
 */
export interface JevDecisionRequest {
  requestId: string;
  observationTime: number;
  context: DecisionContext;
}
export interface JevDecisionResponse {
  requestId: string;
  observationTime: number;
  candidateId: string;
  probability: number;
  latencyMs: number;
  inputTokens: number;
  model: string;
}
