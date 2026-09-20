import { test } from "node:test";
import assert from "node:assert/strict";
import { GUEST_SPEED, guestRoute, pathLength, samplePath } from "../src/sim/movement";
import { generateLayout, distance, key } from "../src/sim/layout";
import { DEFAULT_CONFIG } from "../src/sim/scenario";
import { Simulation } from "../src/sim/engine";
import { observeDiner } from "../src/sim/observations";

test("distance-based motion keeps speed uniform and follows corners", () => {
  const path = [{ x: 0, y: 0 }, { x: 0, y: 2 }, { x: 3, y: 2 }];
  assert.equal(pathLength(path), 5);
  assert.deepEqual(samplePath(path, 1.5).position, { x: 0, y: 1.5 });
  assert.deepEqual(samplePath(path, 2.5).position, { x: 0.5, y: 2 });
  assert.deepEqual(samplePath(path, 10).position, path[2]);
  for (let t = 0; t < 1; t += 1 / 60) {
    const a = samplePath(path, t * GUEST_SPEED), b = samplePath(path, (t + 1 / 60) * GUEST_SPEED);
    assert.ok(Math.abs(distance(a.position, b.position) - GUEST_SPEED / 60) < 1e-8);
  }
});

test("restroom routes connect every seat to an accessible doorway without crossing the table", () => {
  for (const rooms of [1, 2, 3]) for (const seats of [2, 3, 4]) {
    const layout = generateLayout({ ...DEFAULT_CONFIG, tables: 12, rooms, seats });
    assert.ok(!layout.blocked.has(key(layout.restroom)));
    for (const table of layout.tables) for (let diner = 1; diner <= seats; diner++) {
      const path = guestRoute(layout, table, diner, layout.restroom);
      assert.deepEqual(path.at(-1), layout.restroom);
      const aisle = path.findIndex((p) => distance(p, table.approach) < 1e-8);
      for (const p of path.slice(aisle)) assert.ok(!layout.blocked.has(key(p)));
      for (let d = 0; d < pathLength(path); d += 0.1)
        assert.ok(distance(samplePath(path, d).position, table) >= 1.19);
    }
  }
});

test("a restroom visit pauses eating and drinking, preserves the plate, and returns before departure", () => {
  const sim = new Simulation({ ...structuredClone(DEFAULT_CONFIG), bathroomRate: 100, interruptions: false });
  sim.arrivalIndex = sim.scenario.length;
  const table = sim.tables[0], party = structuredClone(sim.scenario[0]);
  party.size = 1;
  party.lingerSeconds = 0;
  table.party = party;
  table.course = "dessert";
  table.stage = "eating";
  const diner = {
    id: 1, water: 1, item: sim.config.menu.find((i) => i.course === "dessert")!,
    finished: false, deliveredAt: 0, eatenSeconds: 0, eatingTarget: 2,
    seatedAt: 0, bathroomPlan: { afterSeconds: 0, duration: 10 },
    bathroomVisited: false, restroomTrip: undefined as typeof table.diners[number]["restroomTrip"],
  };
  table.diners = [diner];
  sim.step();
  assert.ok(diner.restroomTrip);
  const trip = structuredClone(diner.restroomTrip!);
  const observed = observeDiner(table, diner, sim.now);
  assert.equal(observed.present, false);
  assert.equal(observed.activity, "walking");
  assert.ok(observed.position);
  assert.equal(observed.plate, "food present");
  const inside = observeDiner(table, diner, trip.startedAt + trip.walkSeconds + 1);
  assert.equal(inside.position, undefined);
  assert.equal(inside.activity, "absent");
  assert.ok(!JSON.stringify(inside).includes("insideSeconds"));
  while (sim.now < trip.startedAt + trip.walkSeconds * 2 + trip.insideSeconds - 0.25) {
    sim.step();
    assert.equal(diner.eatenSeconds, 0);
    assert.equal(diner.water, 1);
    assert.equal(table.stage, "eating");
  }
  for (let i = 0; i < 120 && diner.restroomTrip; i++) sim.step();
  assert.equal(diner.restroomTrip, undefined);
  assert.equal(observeDiner(table, diner, sim.now).present, true);
  for (let i = 0; i < 120 && !diner.finished; i++) sim.step();
  assert.ok(diner.finished);
  assert.ok(diner.bathroomVisited);
  assert.ok(diner.water < 1);
});

test("paid parties keep their table until an absent guest returns", () => {
  const sim = new Simulation({ ...structuredClone(DEFAULT_CONFIG), interruptions: false });
  sim.arrivalIndex = sim.scenario.length;
  const table = sim.tables[0];
  table.party = structuredClone(sim.scenario[0]);
  table.stage = "lingering";
  table.deadline = 1;
  table.diners = [{ id: 1, water: 1, item: sim.config.menu[0], finished: true, bathroomVisited: true,
    restroomTrip: { startedAt: 0, path: [table.approach, sim.layout.restroom], walkSeconds: 5, insideSeconds: 10 } }];
  for (let i = 0; i < 40; i++) sim.step();
  assert.equal(table.stage, "lingering");
  assert.ok(table.party);
  for (let i = 0; i < 40; i++) sim.step();
  assert.equal(table.stage, "leaving");
});
