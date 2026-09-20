import type { Config, Layout, Point, TableDef } from "./types";
export const key = (p: Point) => `${p.x},${p.y}`;
export const distance = (a: Point, b: Point) =>
  Math.hypot(a.x - b.x, a.y - b.y);
export function generateLayout(config: Config): Layout {
  const perRoom = Math.ceil(config.tables / config.rooms);
  const cols = Math.min(3, Math.ceil(Math.sqrt(perRoom)));
  const rows = Math.ceil(perRoom / cols);
  const spacing = 3 + config.aisleWidth;
  const courtyard = config.layoutStyle === "courtyard" && cols > 1;
  const stagger = config.layoutStyle === "staggered" ? 2 : 0;
  const splitCol = Math.floor(cols / 2);
  const roomWidth = (cols - 1) * spacing + 6 + (courtyard ? 4 : 0) + stagger * 2;
  const height = (rows - 1) * spacing + 9;
  const tables: TableDef[] = [];
  const blocked = new Set<string>();
  const obstacles: Layout["obstacles"] = [];
  for (let i = 0; i < config.tables; i++) {
    const room = Math.floor(i / perRoom),
      local = i % perRoom;
    const col = local % cols, row = Math.floor(local / cols);
    const x = room * roomWidth + 3 + col * spacing + (courtyard && col >= splitCol ? 4 : 0) + (row % 2 ? stagger : 0),
      y = 5 + row * spacing;
    tables.push({
      id: i + 1,
      room,
      x,
      y,
      seats: config.seats,
      approach: { x, y: y - 2 },
    });
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        blocked.add(key({ x: x + dx, y: y + dy }));
  }
  if (courtyard) for (let room = 0; room < config.rooms; room++) {
    const x = room * roomWidth + Math.round(3 + (splitCol - 0.5) * spacing + 2);
    const y = Math.round(5 + (rows - 1) * spacing / 2);
    obstacles.push({ id: `fountain-${room}`, kind: "fountain", x, y, width: 3, height: 3, occludes: false });
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) blocked.add(key({ x: x + dx, y: y + dy }));
  }
  // Room dividers have a service opening at the front and a rear cross-aisle.
  if (config.layoutStyle === "staggered") for (let room = 1; room < config.rooms; room++) {
    const x = room * roomWidth - 1;
    obstacles.push({ id: `screen-${room}`, kind: "screen", x, y: (height - 1) / 2, width: 1, height: height - 6, occludes: true });
    for (let y = 3; y < height - 3; y++) blocked.add(key({ x, y }));
  }
  const layout: Layout = {
    width: config.rooms * roomWidth,
    height,
    tables,
    blocked,
    kitchen: { x: 2, y: 1 },
    station: config.stationPlacement === "split" ? { x: config.rooms * roomWidth - 1, y: Math.floor(height / 2) } : { x: Math.floor(config.rooms * roomWidth / 2), y: 1 },
    bar: { x: config.rooms * roomWidth - 3, y: config.stationPlacement === "split" ? height - 2 : 1 },
    entrance: { x: 1, y: height - 2 },
    restroom: { x: config.rooms * roomWidth - 1, y: height - 3 },
    obstacles,
    roomBounds: Array.from({ length: config.rooms }, (_, r) => ({
      x: r * roomWidth,
      width: roomWidth,
    })),
  };
  return layout;
}

/** Geometry is public operational knowledge. Cached grid routes are shared by planning and walking. */
const routeCache = new WeakMap<Layout, Map<string, Point[]>>();
export function routeDistance(layout: Layout, from: Point, to: Point): number {
  const start = { x: Math.round(from.x), y: Math.round(from.y) };
  let cache = routeCache.get(layout);
  if (!cache) { cache = new Map(); routeCache.set(layout, cache); }
  const id = `${key(start)}:${key(to)}`;
  let path = cache.get(id);
  if (!path) { path = findPath(layout, start, to); cache.set(id, path); }
  if (!path.length && distance(start, to) > 0.01) return Infinity;
  let total = distance(from, start), previous = start;
  for (const p of path) { total += distance(previous, p); previous = p; }
  return total;
}

export function canObserve(layout: Layout, from: Point, table: TableDef, heading: number, moving: boolean): boolean {
  if (distance(from, table) > 4.5) return false;
  const room = layout.roomBounds.findIndex((b) => from.x >= b.x && from.x < b.x + b.width);
  if (room !== table.room) return false;
  const angle = Math.atan2(table.x - from.x, table.y - from.y);
  if (moving && Math.cos(angle - heading) < -0.25) return false;
  const steps = Math.ceil(distance(from, table) * 8);
  for (let i = 1; i < steps; i++) {
    const x = from.x + (table.x - from.x) * i / steps, y = from.y + (table.y - from.y) * i / steps;
    if (layout.obstacles.some((o) => o.occludes && Math.abs(x - o.x) <= o.width / 2 && Math.abs(y - o.y) <= o.height / 2)) return false;
  }
  return true;
}
/** Four-connected grid routing. Dining furniture occupies blocked cells. */
export function findPath(layout: Layout, from: Point, to: Point): Point[] {
  const start = { x: Math.round(from.x), y: Math.round(from.y) },
    end = key(to);
  const queue = [start],
    previous = new Map<string, Point | null>([[key(start), null]]);
  for (let head = 0; head < queue.length; head++) {
    const p = queue[head];
    if (key(p) === end) {
      const path: Point[] = [];
      let q: Point | null = p;
      while (q) {
        path.push(q);
        q = previous.get(key(q)) ?? null;
      }
      return path.reverse().filter((p, i) => i > 0 || distance(from, p) > 0.01);
    }
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ]) {
      const q = { x: p.x + dx, y: p.y + dy },
        k = key(q);
      if (
        q.x < 0 ||
        q.y < 0 ||
        q.x >= layout.width ||
        q.y >= layout.height ||
        layout.blocked.has(k) ||
        previous.has(k)
      )
        continue;
      previous.set(k, p);
      queue.push(q);
    }
  }
  return [];
}
