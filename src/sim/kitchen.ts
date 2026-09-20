import type { Dish, KitchenPort, TableState } from "./types";
export class TimerKitchen implements KitchenPort {
  dishes: Dish[] = [];
  submit(table: TableState, now: number) {
    for (const diner of table.diners)
      if (diner.active !== false)
      this.dishes.push({
        id: `${table.party!.id}:${diner.id}:${diner.item.course}`,
        party: table.party!.id,
        table: table.id,
        diner: diner.id,
        item: diner.item,
        readyAt: now + diner.item.seconds,
      });
  }
  ready(now: number) {
    return this.dishes.filter(
      (d) => d.readyAt <= now && d.pickedAt === undefined,
    );
  }
}
