import type { Diner, Server, TableState } from "../sim/types";

export const MAX_BUBBLES = 4;
export interface BubbleCandidate { id: string; group?: string; priority?: number }

export function dinerBubblePriority(table: TableState, diner: Diner) {
  if (diner.restroomTrip || ["arriving", "leaving", "dirty", "empty"].includes(table.stage)) return 0;
  if (table.request && diner.id === (table.request.diner ?? 1)) return 5;
  if (diner.water < .15) return 4;
  if (diner.id === 1 && ["order", "dessert_order", "pay"].includes(table.stage)) return 4;
  if (diner.id === 1 && ["greet", "between", "dessert_offer"].includes(table.stage)) return 2;
  if (diner.finished && !diner.cleared && diner.deliveredAt !== undefined) return 2;
  return 0;
}
export function serverBubblePriority(server: Server, now: number, planning: boolean) {
  if (server.interruptUntil > now) return 5;
  if (planning) return 3;
  if (!server.job || server.job.kind === "patrol") return 0;
  return server.job.startedService && !server.job.path.length ? 3 : 1;
}

/** Presentation-only wall-clock scheduling. Independent of restaurant RNG/time. */
export class BubbleBudget {
  private slots = new Map<string, { until: number; priority: number }>();
  private cooldowns = new Map<string, { until: number; priority: number }>();
  private nextAmbientAt = 0;
  clear() { this.slots.clear(); this.cooldowns.clear(); this.nextAmbientAt = 0; }

  choose<T extends BubbleCandidate>(candidates: T[], now: number): T[] {
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    for (const [id, slot] of this.slots) {
      const becameCasual = byId.has(id) && !(byId.get(id)!.priority ?? 0) && slot.priority > 0;
      if (!byId.has(id) || now >= slot.until || becameCasual) {
        this.slots.delete(id);
        this.cooldowns.set(id, { until: now + (slot.priority && !becameCasual ? 10000 : 30000), priority: becameCasual ? 0 : slot.priority });
      }
    }
    for (const [id, cooldown] of this.cooldowns) if (now >= cooldown.until) this.cooldowns.delete(id);
    const eligible = candidates.filter((candidate) => {
      const priority = candidate.priority ?? 0, cooldown = this.cooldowns.get(candidate.id);
      if (cooldown && priority <= cooldown.priority) return false;
      return priority > 0 || this.slots.has(candidate.id) || now >= this.nextAmbientAt;
    });
    eligible.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)
      || Number(this.slots.has(b.id)) - Number(this.slots.has(a.id)));
    const chosen: T[] = [], groups = new Set<string>();
    let ambient = false;
    for (const candidate of eligible) {
      const priority = candidate.priority ?? 0, group = candidate.group ?? candidate.id;
      if (groups.has(group) || (!priority && ambient)) continue;
      chosen.push(candidate); groups.add(group);
      if (!priority) ambient = true;
      if (!this.slots.has(candidate.id)) {
        this.slots.set(candidate.id, { until: now + (priority ? 6000 : 3500), priority });
        if (!priority) this.nextAmbientAt = now + 15000;
      }
      this.slots.get(candidate.id)!.priority = priority;
      if (chosen.length === MAX_BUBBLES) break;
    }
    const selected = new Set(chosen.map((candidate) => candidate.id));
    for (const [id, slot] of this.slots) if (!selected.has(id)) {
      this.slots.delete(id);
      this.cooldowns.set(id, { until: now + 10000, priority: slot.priority });
    }
    return chosen;
  }
}
