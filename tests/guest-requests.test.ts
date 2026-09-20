import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulation } from "../src/sim/engine";
import { DEFAULT_CONFIG, createScenario } from "../src/sim/scenario";
import { canObserve, distance } from "../src/sim/layout";
import { observeDiner } from "../src/sim/observations";
import { dinerDialogue, serverDialogue } from "../src/view/speech-bubbles";
import { DialogueBook } from "../src/view/dialogue-lines";
import type { Config } from "../src/sim/types";

function seated(overrides: Partial<Config> = {}, idle = false) {
  const sim = new Simulation({ ...structuredClone(DEFAULT_CONFIG), tables: 2, servers: 1, duration: 5, interruptions: false, ...overrides },
    idle ? { id: "idle", choose: () => undefined } : undefined);
  sim.arrivalIndex = sim.scenario.length;
  sim.now = 100;
  const table = sim.tables[0], server = sim.servers[0];
  table.party = { ...structuredClone(sim.scenario[0]), requested: true, lingerSeconds: 0 };
  table.stage = "reading"; table.since = 100; table.deadline = 10000;
  table.diners = [{ id: 1, item: sim.config.menu.find((i) => i.course === "main")!, water: 1, finished: false, seatedAt: 90 }];
  return { sim, table, server, diner: table.diners[0] };
}

test("extra request frequency is optional, rare accidents dominate neither schedule nor guest RNG", () => {
  const config = { ...DEFAULT_CONFIG, duration: 120, arrivals: 90 };
  const off = createScenario({ ...config, requestRate: 0 }), on = createScenario({ ...config, requestRate: 100 });
  assert.ok(off.every((p) => !p.requestPlanned));
  assert.ok(on.every((p) => p.requestPlanned));
  assert.deepEqual(off.map(({ requestPlanned, ...p }) => p), on.map(({ requestPlanned, ...p }) => p));
  const parties = Array.from({ length: 30 }, (_, seed) => createScenario({ ...config, seed })).flat();
  const extra = parties.filter((p) => p.requestPlanned);
  assert.ok(extra.length / parties.length > .17 && extra.length / parties.length < .23);
  for (const kind of ["fork", "spill"]) {
    const fraction = extra.filter((p) => p.requestKind === kind).length / parties.length;
    assert.ok(fraction > .012 && fraction < .03, `${kind}: ${fraction}`);
  }
  assert.ok(!extra.some((p) => p.requestKind === "dessert"));
  assert.throws(() => new Simulation({ ...DEFAULT_CONFIG, requestRate: 101 }));
});

test("a nearby wave requires approach and a completed conversation before an opaque request is known", () => {
  for (const voiceHints of [false, true]) {
    const { sim, table, server } = seated({ mode: "camera", voiceHints }, true);
    sim.raiseRequest(table, "dessert", false);
    server.position = { x: table.approach.x, y: table.approach.y - 2 };
    sim.now += 2;
    sim.step();
    assert.equal(server.job?.kind, "request");
    assert.ok(distance(server.position, table.approach) > .1);
    assert.equal(String(table.request?.phase), "approaching");
    assert.equal(sim.observe(table, "camera").request, "unknown");
    let contacted = false;
    for (let i = 0; i < 200 && !server.knownRequests.has(table.id); i++) {
      if (table.request?.phase === "discussing") {
        contacted = true;
        assert.ok(distance(server.position, table.approach) < .1);
        assert.equal(sim.observe(table, "camera").request, "unknown");
      }
      sim.step();
    }
    assert.ok(contacted);
    assert.equal(server.knownRequests.get(table.id), "dessert");
    assert.equal(sim.observe(table, "camera").request, voiceHints ? "dessert" : "unknown");
    assert.equal(table.request?.visible, false, "a voice report is not visual evidence");
    assert.equal(table.request?.phase, "awaiting_help");
    assert.equal(sim.metrics.requestResponseWaits.length, 1);
    assert.equal(sim.metrics.requestResolutionWaits.length, 0);
  }
});

test("an occluded local server cannot hear a private request; camera candidates reveal only the wave", () => {
  const { sim, table, server } = seated({}, true);
  sim.raiseRequest(table, "question", false);
  server.position = { ...table.approach };
  sim.layout.obstacles.push({ id: "screen", kind: "screen", x: table.x, y: table.y - 1, width: 2, height: .2, occludes: true });
  assert.equal(canObserve(sim.layout, server.position, table, server.heading, false), false);
  for (let i = 0; i < 40; i++) sim.step();
  assert.equal(server.job, undefined);
  assert.equal(server.knownRequests.size, 0);
  assert.equal(table.request?.phase, "signalling");
  assert.ok(!sim.candidates(server).some((c) => c.kind === "request"));
  server.memory.set(table.id, sim.observe(table, "camera"));
  const investigate = sim.candidates(server).find((c) => c.kind === "request");
  assert.ok(investigate);
  assert.equal(investigate.reason, "Investigate guest request");
  assert.ok(!JSON.stringify([...server.memory.values()]).includes('"question"'));
});

test("accidents require an item, and a diner cannot keep eating with a dropped fork", () => {
  const { sim, table, diner } = seated({}, true);
  sim.raiseRequest(table, "fork", true);
  assert.equal(table.request, undefined);
  table.stage = "eating";
  diner.deliveredAt = sim.now; diner.eatingTarget = 100; diner.eatenSeconds = 5;
  sim.raiseRequest(table, "fork", true);
  for (let i = 0; i < 40; i++) { sim.now += .25; sim.updateTable(table, .25); }
  assert.equal(diner.eatenSeconds, 5);
  assert.equal(sim.observe(table, "camera").request, "fork");
  table.request = undefined;
  diner.water = 0;
  sim.raiseRequest(table, "spill", true);
  assert.equal(table.request, undefined);
  diner.water = .8;
  sim.raiseRequest(table, "spill", true);
  assert.equal(diner.water, 0);
  assert.equal(sim.metrics.requestsRaised, 2);
});

test("routine bills require request, discussion, presentation and review before payment, even with incidents disabled", () => {
  for (const mode of ["patrol", "camera"] as const) {
    const { sim, table, server } = seated({ mode });
    table.stage = "pay"; table.party!.billRequestDelay = 0; table.party!.billReviewSeconds = 20;
    server.position = { ...table.approach };
    let reviewed = false, ready = false, discussed = false;
    for (let i = 0; i < 2000 && sim.metrics.completed === 0; i++) {
      sim.step();
      if (table.request?.phase === "discussing") discussed = true;
      if (!table.bill || table.bill === "presented") assert.equal(sim.metrics.completed, 0);
      if (table.bill === "presented") {
        reviewed = true;
        assert.equal(observeDiner(table, table.diners[0], sim.now).activity, "reading bill");
        assert.ok(!sim.candidates(server).some((c) => c.kind === "pay"));
      }
      if (table.bill === "ready") {
        ready = true;
        assert.ok(sim.now >= table.billReadyAt!);
      }
    }
    assert.ok(discussed && reviewed && ready);
    assert.equal(sim.metrics.completed, 1);
    assert.equal(sim.metrics.requestsRaised, 1);
    assert.equal(sim.metrics.requestResponseWaits.length, 1);
    assert.equal(sim.metrics.requestResolutionWaits.length, 1);
    assert.ok(sim.metrics.requestResolutionWaits[0] > sim.metrics.requestResponseWaits[0]);
    for (let i = 0; i < 200; i++) sim.step();
    assert.equal(sim.metrics.completed, 1);
  }
});

test("specific requests are spoken only during contact, with thanks rather than a repeated demand on return", () => {
  const { sim, table, diner, server } = seated();
  const book = new DialogueBook();
  for (const kind of ["dessert", "bill", "question", "fork", "spill"] as const) {
    table.request = { kind, since: sim.now, visible: false, phase: "signalling" };
    assert.equal(dinerDialogue(table, diner, sim.now, book).style, "thought");
    table.request.phase = "discussing";
    table.request.conversationServer = server.id;
    assert.equal(dinerDialogue(table, diner, sim.now, book).style, "thought");
    assert.equal(dinerDialogue(table, diner, sim.now, book, "request").style, "speech");
    table.request.phase = "awaiting_help";
    server.supplies = { table: table.id, kind };
    server.interruptUntil = sim.now + 9;
    assert.equal(dinerDialogue(table, diner, sim.now, book, "request").cue, "thanks");
    assert.equal(serverDialogue(server, sim.now, false, book).cue, "returnHelp");
    table.request.conversationServer = undefined;
    assert.equal(dinerDialogue(table, diner, sim.now, book, "request").style, "thought");
  }
});
