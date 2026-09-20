import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, createScenario } from "../src/sim/scenario";
import { canObserve, findPath, generateLayout, key, routeDistance } from "../src/sim/layout";
import { RouteController } from "../src/sim/controllers";
import { Simulation } from "../src/sim/engine";
import { Bar } from "../src/sim/bar";
import { CONDITIONS, compareRun } from "../src/sim/comparison";
import type { DecisionContext } from "../src/sim/types";

test("all layout styles, station placements and aisle widths keep service points connected", () => {
  for (const layoutStyle of ["classic", "courtyard", "staggered"] as const)
    for (const stationPlacement of ["front", "split"] as const)
      for (const rooms of [1, 2, 3]) for (const aisleWidth of [1, 2, 3]) {
        const l = generateLayout({ ...DEFAULT_CONFIG, layoutStyle, stationPlacement, rooms, aisleWidth, tables: 12 });
        for (const to of [...l.tables.map((t) => t.approach), l.station, l.bar, l.restroom]) {
          assert.ok(!l.blocked.has(key(to)), `${layoutStyle}: blocked service point ${key(to)}`);
          const path = findPath(l, l.kitchen, to);
          assert.deepEqual(path.at(-1), to);
          assert.ok(path.every((p) => !l.blocked.has(key(p))));
        }
      }
});

test("fountains and station placement change actual routing costs", () => {
  const l = generateLayout({ ...DEFAULT_CONFIG, layoutStyle: "courtyard" });
  const fountain = l.obstacles[0];
  const a = { x: fountain.x - 2, y: fountain.y }, b = { x: fountain.x + 2, y: fountain.y };
  assert.ok(routeDistance(l, a, b) > 4);
  const front = generateLayout(DEFAULT_CONFIG), split = generateLayout({ ...DEFAULT_CONFIG, stationPlacement: "split" });
  assert.notEqual(routeDistance(front, front.tables[0].approach, front.bar), routeDistance(split, split.tables[0].approach, split.bar));
});

test("local observations obey facing, room boundaries, occlusion and scan cadence", () => {
  const sim = new Simulation({ ...DEFAULT_CONFIG, tables: 12, rooms: 2, observationSeconds: 3 });
  const t = sim.tables[0], s = sim.servers[0];
  s.position = { ...t.approach };
  assert.ok(canObserve(sim.layout, s.position, t, 0, true));
  assert.ok(!canObserve(sim.layout, s.position, t, Math.PI, true));
  sim.layout.obstacles.push({ id: "test-screen", kind: "screen", x: t.x, y: t.y - 1, width: 2, height: 0.2, occludes: true });
  assert.ok(!canObserve(sim.layout, s.position, t, 0, false));
  sim.layout.obstacles.pop();
  sim.step();
  assert.equal(s.memory.size, 1);
  const firstAt = [...s.memory.values()][0].at;
  for (let i = 0; i < 4; i++) sim.step();
  assert.equal([...s.memory.values()][0].at, firstAt);
});

test("expired observations produce a recheck rather than an old service instruction", () => {
  const sim = new Simulation({ ...DEFAULT_CONFIG, servers: 1 });
  const t = sim.tables[0], s = sim.servers[0];
  t.stage = "greet"; t.party = sim.scenario[0];
  s.memory.set(t.id, sim.observe(t, "server"));
  sim.now = sim.config.memorySeconds + 1;
  const tasks = sim.candidates(s).filter((c) => c.table === t.id);
  assert.ok(tasks.some((c) => c.kind === "patrol"));
  assert.ok(tasks.every((c) => c.kind !== "greet"));
});

test("multi-stop planning takes useful nearby stops and respects projected dirty load", () => {
  const ctx: DecisionContext = {
    now: 0, server: { id: 1, position: { x: 0, y: 0 }, plates: 0, drinks: 0, dirty: 0, water: 4 }, observations: [],
    candidates: [
      { id: "a", kind: "clear", table: 1, destination: { x: 50, y: 0 }, priority: 140, reason: "", observedAt: 0, dirtyLoad: 3 },
      { id: "b", kind: "clear", table: 2, destination: { x: 2, y: 0 }, priority: 100, reason: "", observedAt: 0, dirtyLoad: 2 },
      { id: "c", kind: "greet", table: 3, destination: { x: 3, y: 0 }, priority: 100, reason: "", observedAt: 0 },
    ],
    travelSeconds: { start: { a: 50, b: 2, c: 3 }, a: { b: 48, c: 47 }, b: { a: 48, c: 1 }, c: { a: 47, b: 1 } },
  };
  const plan = new RouteController().plan(ctx);
  assert.deepEqual(plan, ["b", "c"]);
  assert.ok(!plan.includes("a"), "Two clearing stops would exceed carrying capacity");
});

test("queued plans are revalidated when a party changes and fabricated plans never execute", () => {
  const sim = new Simulation({ ...DEFAULT_CONFIG, servers: 1 });
  const s = sim.servers[0];
  s.itinerary = [{ id: "greet:1", kind: "greet", table: 1, party: 999, destination: sim.tables[0].approach, priority: 100, reason: "", observedAt: 0 }];
  sim.assign(s);
  assert.ok(sim.metrics.staleStops > 0);
  assert.notEqual(s.job?.party, 999);
  const invalid = new Simulation(DEFAULT_CONFIG, { id: "bad", choose: () => undefined, plan: () => ["greet:999"] });
  invalid.step();
  assert.ok(invalid.servers.every((s) => !s.job));
});

test("bar queues serialize per bartender and additional staffing reduces queue time", () => {
  const a = new Bar(1), b = new Bar(2);
  for (const bar of [a, b]) bar.submit(1, 1, ["old-fashioned", "old-fashioned", "old-fashioned"], 10);
  assert.deepEqual(a.tickets.map((t) => t.readyAt), [70, 130, 190]);
  assert.deepEqual(b.tickets.map((t) => t.readyAt), [70, 70, 130]);
  assert.equal(a.ready(69).length, 0);
  assert.equal(a.ready(70).length, 1);
});

test("aged ready tickets interrupt a planned tour and cannot be crowded out by table tasks", () => {
  const sim = new Simulation({ ...DEFAULT_CONFIG, servers: 1 });
  const s = sim.servers[0];
  sim.bar.submit(1, sim.scenario[0].id, ["spritz"], 0);
  sim.now = 100;
  s.itinerary = [{ id: "patrol:2", kind: "patrol", table: 2, destination: sim.tables[1].approach, priority: 100, reason: "", observedAt: 0 }];
  sim.assign(s);
  assert.equal(s.job?.kind, "bar_pickup");
  assert.ok(sim.metrics.staleStops > 0);
  const ctx = structuredClone(sim.lastDecision!);
  for (let i = 0; i < 20; i++) {
    const id = `extra:${i}`;
    ctx.candidates.push({ id, kind: "greet", destination: { x: 0, y: 0 }, priority: 150, reason: "", observedAt: 0 });
    ctx.travelSeconds.start[id] = 1;
  }
  assert.equal(new RouteController().plan(ctx)[0], "bar_pickup:0");
});

test("paired planner/evidence conditions keep guests fixed and complete cocktail service", () => {
  const base = { ...structuredClone(DEFAULT_CONFIG), duration: 5, arrivals: 20, cocktailRate: 100, layoutStyle: "courtyard" as const, stationPlacement: "split" as const };
  const scenario = createScenario(base);
  for (const condition of CONDITIONS) {
    assert.deepEqual(createScenario({ ...base, ...condition }), scenario);
    const run = compareRun({ ...base, ...condition });
    assert.ok(run.finished, `${condition.planner}/${condition.mode} stalled`);
    assert.equal(run.metrics.completed, run.metrics.cocktailsServed);
    assert.ok(run.metrics.drinkOrderWaits.every((n) => n >= 35));
    assert.equal(run.metrics.arrived, run.metrics.completed + run.metrics.turnedAway);
  }
});
