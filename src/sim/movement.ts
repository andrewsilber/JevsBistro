import type { Layout, Point, TableDef } from "./types";
import { distance, findPath } from "./layout";

export const GUEST_SPEED = 1.1;
export const pathLength = (path: Point[]) => path.slice(1).reduce((sum, p, i) => sum + distance(path[i], p), 0);

/** Distance-based sampling keeps motion uniform, including unequal segments. */
export function samplePath(path: Point[], travelled: number): { position: Point; heading: number } {
  if (!path.length) throw Error("Cannot sample an empty route");
  let remaining = Math.max(0, travelled), heading = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], length = distance(a, b);
    if (!length) continue;
    heading = Math.atan2(b.x - a.x, b.y - a.y);
    if (remaining <= length) return { position: {
      x: a.x + (b.x - a.x) * remaining / length,
      y: a.y + (b.y - a.y) * remaining / length,
    }, heading };
    remaining -= length;
  }
  return { position: { ...path[path.length - 1] }, heading };
}

/** Short seat connector skirts the table before joining the grid aisle. */
export function seatAccessPath(table: TableDef, dinerId: number): Point[] {
  const angle = (dinerId - 1) / table.seats * Math.PI * 2;
  const point = (a: number, radius: number) => ({ x: table.x + Math.sin(a) * radius, y: table.y + Math.cos(a) * radius });
  const turn = Math.atan2(Math.sin(Math.PI - angle), Math.cos(Math.PI - angle));
  const steps = Math.max(1, Math.ceil(Math.abs(turn) / (Math.PI / 12)));
  return [point(angle, 1.2), ...Array.from({ length: steps + 1 }, (_, i) => point(angle + turn * i / steps, 2)), { ...table.approach }];
}

export function guestRoute(layout: Layout, table: TableDef, dinerId: number, destination: Point): Point[] {
  return [...seatAccessPath(table, dinerId), ...findPath(layout, table.approach, destination)];
}

export function guestTravelSeconds(layout: Layout, table: TableDef): number {
  return Math.max(...Array.from({ length: table.seats }, (_, i) => pathLength(guestRoute(layout, table, i + 1, layout.entrance)) / GUEST_SPEED + i * 0.4));
}
