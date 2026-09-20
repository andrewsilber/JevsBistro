import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulation } from "../src/sim/engine";
import { DEFAULT_CONFIG, createScenario } from "../src/sim/scenario";
import { findPath, generateLayout, key } from "../src/sim/layout";
import { observeDiner } from "../src/sim/observations";
import type { Config, Diner } from "../src/sim/types";
const config = (overrides: Partial<Config> = {}): Config => ({
  ...structuredClone(DEFAULT_CONFIG),
  duration: 10,
  ...overrides,
});
function finish(s: Simulation) {
  for (let i = 0; i < 20000 && !s.finished; i++) s.step();
  return s;
}
test("same seed produces identical exogenous guests across controllers", () => {
  assert.deepEqual(
    createScenario(config({ mode: "patrol" })),
    createScenario(config({ mode: "camera" })),
  );
  assert.notDeepEqual(
    createScenario(config({ seed: 1 })),
    createScenario(config({ seed: 2 })),
  );
});
test("all generated layouts have reachable furniture-free service paths", () => {
  for (const rooms of [1, 2, 3])
    for (const tables of [3, 8, 24]) {
      const l = generateLayout(config({ rooms, tables }));
      for (const t of l.tables) {
        const path = findPath(l, l.entrance, t.approach);
        assert.ok(path.length);
        assert.deepEqual(path.at(-1), t.approach);
        for (const p of path) assert.ok(!l.blocked.has(key(p)));
      }
    }
});
test("both controllers complete the entire service lifecycle and reconcile guests", () => {
  for (const mode of ["patrol", "camera"] as const) {
    const s = finish(new Simulation(config({ mode, arrivals: 35 })));
    assert.ok(
      s.finished,
      `${mode}: stalled at ${s.now}: ${s.tables.map((t) => t.stage).join(",")}`,
    );
    assert.ok(s.metrics.completed > 0);
    assert.ok(s.metrics.revenue > 0);
    assert.equal(s.metrics.arrived, s.metrics.completed + s.metrics.turnedAway);
    assert.ok(s.tables.every((t) => t.stage === "empty"));
    assert.equal(s.metrics.foodWaits.length, s.kitchen.dishes.length);
    assert.equal(s.metrics.revenue, s.kitchen.dishes.reduce((sum, dish) => sum + dish.item.price, 0) + s.bar.tickets.reduce((sum, drink) => sum + drink.item.price, 0));
    assert.ok(s.bar.tickets.every((drink) => drink.deliveredAt! >= drink.readyAt));
    assert.ok(s.kitchen.dishes.every((d) => d.deliveredAt! >= d.readyAt));
    assert.ok(s.servers.every((s) => s.plates.length + s.drinks.length <= 4));
    assert.ok(s.servers.every((s) => !s.dirty || s.plates.length + s.drinks.length === 0));
    assert.ok(s.servers.every((s) => s.dirty === 0 && s.plates.length === 0));
  }
});
test("simulation is repeatable including interruptions and metrics", () => {
  const a = finish(new Simulation(config({ arrivals: 40, seed: 17 }))),
    b = finish(new Simulation(config({ arrivals: 40, seed: 17 })));
  assert.deepEqual(a.export(), b.export());
});
test("patrol memory excludes distant tables while cameras see the room", () => {
  const s = new Simulation(config({ tables: 24, rooms: 3, servers: 1 }));
  s.step();
  assert.equal(s.latestSnapshot!.tables.length, 24);
  assert.ok(s.servers[0].memory.size < 24);
  assert.ok(s.lastDecision!.observations.length < 24);
});
test("camera timestamps obey the configured cadence and snapshots are detached", () => {
  const s = new Simulation(config({ snapshotSeconds: 2 }));
  const snap = structuredClone(s.latestSnapshot);
  for (let i = 0; i < 7; i++) s.step();
  assert.equal(s.latestSnapshot!.at, 0);
  assert.deepEqual(s.snapshots[0], snap);
  s.step();
  assert.equal(s.latestSnapshot!.at, 2);
});
test("unknown or malicious controller actions never execute", () => {
  const s = new Simulation(config(), {
    id: "invalid",
    choose: (ctx) => {
      ctx.server.position.x = 9000;
      return "pay:999";
    },
  });
  s.step();
  assert.ok(s.servers.every((s) => !s.job && s.position.x < 20));
  assert.equal(s.metrics.revenue, 0);
});
test("configuration rejects invalid inputs before creating a run", () => {
  assert.throws(() => new Simulation(config({ servers: 0 })));
  assert.throws(() => new Simulation(config({ tables: 2.5 })));
  assert.throws(() => new Simulation(config({ seed: NaN })));
  assert.throws(() => new Simulation(config({ menu: [] })));
  assert.throws(() => new Simulation(config({ phoneRate: 101 })));
  assert.throws(() => new Simulation(config({ menu: DEFAULT_CONFIG.menu.filter((i) => i.course !== "main") })));
});

test("mixed course choices clear appetizers before mains, serve only requested desserts, and bill every dish", () => {
  for (const mode of ["patrol", "camera"] as const) {
    const s = new Simulation(config({ mode, servers: 2, tables: 2, interruptions: false, duration: 5 }));
    s.scenario.splice(1);
    const party = s.scenario[0];
    const pick = (course: string) => ({ menuIndex: s.config.menu.findIndex((i) => i.course === course), eatingSeconds: 20 });
    party.size = 3;
    party.meals = [[pick("appetizer"), pick("main"), pick("dessert")], [pick("main")], [pick("main"), pick("dessert")]];
    party.menuIndices = party.meals.map((meal) => meal.find((i) => s.config.menu[i.menuIndex].course === "main")!.menuIndex);
    party.behaviors = Array.from({ length: 3 }, () => ({ phoneSeconds: 0, phonePeriod: 100, phase: 0 }));
    party.lingerSeconds = 90;
    let mainFiredAt = 0, paidAt = 0, sawDessertOrder = false, sawClearedApp = false;
    for (let i = 0; i < 12000 && !s.finished; i++) {
      s.step();
      const t = s.tables[0];
      if (t.course === "appetizer" && t.diners.some((d) => d.cleared)) sawClearedApp = true;
      if (t.course === "main" && !mainFiredAt) {
        mainFiredAt = s.now;
        assert.ok(sawClearedApp, "Appetizer clearing must precede main preparation");
      }
      if (t.stage === "dessert_order") sawDessertOrder = true;
      if (t.stage === "lingering") {
        paidAt ||= s.now;
        assert.equal(s.metrics.completed, 3);
        assert.equal(t.diners.length, 3);
        assert.ok(t.party, "Paid guests still occupy the table");
      }
      if (paidAt && t.stage === "leaving") assert.ok(s.now >= paidAt + 90);
    }
    assert.ok(s.finished);
    assert.ok(mainFiredAt && paidAt && sawDessertOrder);
    assert.equal(s.kitchen.dishes.length, 6);
    assert.equal(new Set(s.kitchen.dishes.map((d) => d.id)).size, 6);
    assert.deepEqual(s.kitchen.dishes.filter((d) => d.item.course === "dessert").map((d) => d.diner), [1, 3]);
    assert.equal(s.metrics.revenue, s.kitchen.dishes.reduce((sum, d) => sum + d.item.price, 0));
    assert.ok(s.kitchen.dishes.every((d) => d.deliveredAt !== undefined));
  }
});

test("main-only parties skip optional food, and menu categories may be omitted", () => {
  const s = finish(new Simulation(config({ duration: 5, appetizerRate: 0, dessertRate: 0, lingerRate: 0,
    menu: DEFAULT_CONFIG.menu.filter((i) => i.course === "main") })));
  assert.ok(s.finished);
  assert.equal(s.kitchen.dishes.length, s.metrics.completed);
  assert.ok(s.kitchen.dishes.every((dish) => dish.item.course === "main"));
});

test("phone use and talking pause actual eating progress without leaking future choices", () => {
  const s = new Simulation(config({ interruptions: false }));
  s.arrivalIndex = s.scenario.length;
  const t = s.tables[0];
  t.stage = "eating";
  t.party = s.scenario[0];
  t.course = "main";
  const d: Diner = { id: 1, item: s.config.menu.find((i) => i.course === "main")!, water: 1, finished: false,
    deliveredAt: 0, active: true, eatenSeconds: 0, eatingTarget: 100,
    behavior: { phonePeriod: 100, phoneSeconds: 20, phase: 0 } };
  t.diners = [d];
  for (let i = 0; i < 40; i++) s.step();
  assert.equal(observeDiner(t, d, s.now).activity, "using phone");
  assert.equal(d.eatenSeconds, 0);
  assert.equal(observeDiner(t, d, s.now).course!.completionPercent, 0);
  for (let i = 0; i < 200; i++) s.step();
  assert.ok(d.eatenSeconds! > 0 && d.eatenSeconds! < 40, "Talking also pauses eating");
  assert.equal(s.observe(t, "camera").diners[0].course!.kind, "main");
  assert.ok(!JSON.stringify(s.observe(t, "camera")).includes('"meals"'));
});
test("camera history retains initial frames and independent diner observations", () => {
  const s = new Simulation(config());
  for (let i = 0; i < 600; i++) s.step();
  assert.equal(s.snapshots.length, 151);
  assert.equal(s.snapshots[0].at, 0);
  assert.equal(s.snapshots[0].tables[0].diners.length, 0);
  const frame = s.snapshots.find((f) =>
    f.tables.some((t) => t.diners.some((d) => d.present)),
  )!;
  const before = structuredClone(frame);
  s.step();
  assert.deepEqual(frame, before);
  assert.ok(s.export().cameraSnapshots.length > 120);
});
test("diner classifications report observable course progress without future menu choices", () => {
  const s = new Simulation(config()),
    t = s.tables[0];
  t.party = s.scenario[0];
  t.stage = "reading";
  const d = {
    id: 1,
    water: 0.15,
    item: s.config.menu[0],
    finished: false,
    deliveredAt: undefined as number | undefined,
    eatUntil: undefined as number | undefined,
  };
  assert.equal(observeDiner(t, d, 50).course, null);
  t.stage = "eating";
  d.deliveredAt = 100;
  d.eatUntil = 200;
  assert.equal(observeDiner(t, d, 100).course!.completionPercent, 0);
  assert.equal(observeDiner(t, d, 150).course!.completionPercent, 50);
  assert.equal(observeDiner(t, d, 150).waterPercent, 15);
  const activities = new Set(
    Array.from({ length: 36 }, (_, i) => observeDiner(t, d, 120 + i).activity),
  );
  assert.ok(activities.has("eating"));
  assert.ok(activities.has("talking"));
  d.finished = true;
  assert.equal(observeDiner(t, d, 200).course!.completionPercent, 100);
  t.stage = "dirty";
  assert.equal(observeDiner(t, d, 201).activity, "absent");
});
test("busy multiroom floor preserves carrying, seating and ownership invariants", () => {
  const s = new Simulation(
    config({
      rooms: 3,
      tables: 12,
      servers: 4,
      arrivals: 90,
      mode: "camera",
      seed: 8,
    }),
  );
  for (let i = 0; i < 20000 && !s.finished; i++) {
    s.step();
    assert.ok(
      s.tables.every(
        (t) =>
          t.diners.length <= t.seats &&
          t.diners.every((d) => d.water >= 0 && d.water <= 1.00001),
      ),
    );
    assert.ok(s.servers.every((s) => s.plates.length <= 4));
    const carried = s.servers.flatMap((s) => s.plates);
    assert.equal(new Set(carried).size, carried.length);
  }
  assert.ok(s.finished);
});
test("a dropped fork interrupts once and requires a supplies trip before resolution", () => {
  const s = new Simulation(config({ servers: 1, tables: 2 }));
  s.arrivalIndex = s.scenario.length;
  const t = s.tables[0],
    server = s.servers[0];
  t.stage = "reading";
  t.deadline = 10000;
  t.party = { ...s.scenario[0], requested: true };
  t.diners = [{ id: 1, item: s.config.menu[0], water: 1, finished: false }];
  t.request = { kind: "fork", visible: true, since: 0 };
  server.position = { ...t.approach };
  let collectedSupplies = false;
  for (let i = 0; i < 1200 && t.request; i++) {
    s.step();
    if (server.supplies?.kind === "fork") collectedSupplies = true;
  }
  assert.ok(collectedSupplies);
  assert.equal(t.request, undefined);
  assert.equal(s.metrics.interruptions, 1);
});
test("opaque requests stay unknown to cameras without voice hints", () => {
  const s = new Simulation(
    config({ servers: 1, tables: 2, voiceHints: false }),
  );
  s.arrivalIndex = s.scenario.length;
  const t = s.tables[0];
  t.stage = "reading";
  t.deadline = 10000;
  t.party = { ...s.scenario[0], requested: true };
  t.diners = [{ id: 1, item: s.config.menu[0], water: 1, finished: false }];
  t.request = { kind: "dessert", visible: false, since: 0 };
  s.servers[0].position = { ...t.approach };
  let learnedLocally = false;
  for (let i = 0; i < 600 && t.request; i++) {
    s.step();
    if (s.servers[0].knownRequests.get(t.id) === "dessert")
      learnedLocally = true;
    if (s.latestSnapshot!.tables[0].request)
      assert.equal(s.latestSnapshot!.tables[0].request, "unknown");
  }
  assert.ok(learnedLocally);
  assert.equal(t.request, undefined);
});
