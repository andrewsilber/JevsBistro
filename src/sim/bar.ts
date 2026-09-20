export const COCKTAILS = [
  { id: "spritz", name: "Citrus spritz", seconds: 35, price: 12, color: "#ef9145" },
  { id: "martini", name: "House martini", seconds: 50, price: 15, color: "#cdddac" },
  { id: "old-fashioned", name: "Old fashioned", seconds: 60, price: 14, color: "#b56e35" },
];
export interface DrinkTicket {
  id: string; table: number; party: number; diner: number;
  item: typeof COCKTAILS[number]; orderedAt: number; startedAt: number; readyAt: number;
  pickedAt?: number; deliveredAt?: number; carriedBy?: number;
}
/** FIFO tickets, one preparation slot per bartender. Ready tickets are shared operational evidence. */
export class Bar {
  tickets: DrinkTicket[] = [];
  private freeAt: number[];
  constructor(bartenders: number) { this.freeAt = Array(bartenders).fill(0); }
  submit(table: number, party: number, selections: (string | null)[], now: number) {
    selections.forEach((id, i) => {
      const item = COCKTAILS.find((item) => item.id === id);
      if (!item) return;
      const slot = this.freeAt.indexOf(Math.min(...this.freeAt));
      const startedAt = Math.max(now, this.freeAt[slot]), readyAt = startedAt + item.seconds;
      this.freeAt[slot] = readyAt;
      this.tickets.push({ id: `${party}:${i + 1}:drink`, table, party, diner: i + 1, item, orderedAt: now, startedAt, readyAt });
    });
  }
  ready(now: number) { return this.tickets.filter((d) => d.readyAt <= now && d.pickedAt === undefined); }
}
