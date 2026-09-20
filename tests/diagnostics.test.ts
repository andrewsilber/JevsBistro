import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulation } from "../src/sim/engine";
import { DiagnosticRecorder } from "../src/sim/diagnostics";
import { DEFAULT_CONFIG } from "../src/sim/scenario";
import { compactState } from "../src/llm/compact-state";
import { responseBody } from "../src/llm/protocol";
import { diagnosticReport } from "../src/view/diagnostic-report";
import type { DecisionContext } from "../src/sim/types";

function context(): DecisionContext {
  const sim = new Simulation({ ...DEFAULT_CONFIG, tables: 24, servers: 2, mode: "camera" });
  sim.now = 800;
  const t = sim.tables[0], s = sim.servers[0];
  t.stage = "greet"; t.since = 100; t.party = structuredClone(sim.scenario[0]);
  t.request = { kind: "bill", visible: false, since: 790, phase: "signalling" };
  t.diners = [{ id: 1, item: sim.config.menu[0], water: .1, finished: false }];
  for (const table of sim.tables) s.memory.set(table.id, sim.observe(table, "camera"));
  s.memory.get(t.id)!.at = 795;
  sim.assign(s);
  return sim.lastDecision!;
}

test("compact rows preserve actions, opaque evidence, inventory and every routed action pair", () => {
  const ctx = context(), before = structuredClone(ctx), compact = compactState(ctx);
  assert.deepEqual(ctx, before);
  assert.deepEqual(compact.actions.map((r) => r[0]), ctx.candidates.map((c) => c.id));
  assert.equal(compact.tables[0][4], 5, "observation age");
  assert.equal(compact.tables[0][6], 700, "greeting wait is explicit and separate from freshness");
  assert.equal(compact.tables[0][8], "unknown");
  assert.equal(compact.tables[0][9], "signalling");
  assert.equal(compact.server[5], ctx.server.dirty);
  for (let i = 0; i < ctx.candidates.length; i++) {
    const c = ctx.candidates[i], destination = compact.actions[i][2] as number;
    assert.equal(compact.actions[i][9], compact.reasons.indexOf(c.reason));
    assert.ok(Math.abs(compact.travel[0][destination]! - ctx.travelSeconds.start[c.id]) <= .051);
    for (let j = 0; j < ctx.candidates.length; j++) {
      const other = ctx.candidates[j], to = compact.actions[j][2] as number;
      assert.ok(Math.abs(compact.travel[destination + 1][to]! - ctx.travelSeconds[c.id][other.id]) <= .051);
    }
  }
  assert.ok(compact.destinations.length < ctx.candidates.length, "duplicate destinations share travel rows");
  const request = responseBody(ctx, "gpt-5.4-nano");
  assert.equal(JSON.parse(request.input).v, "bistro-rows-v1");
  assert.match(request.instructions, /stageAge.*NOT evidenceAge/);
  assert.deepEqual(request.text.format.schema.properties.ids.items.enum, ctx.candidates.map((c) => c.id));
  assert.ok(request.input.length < JSON.stringify(ctx).length * .65);
});

test("diagnostics do not change a run, identify completed and outstanding greeting episodes", () => {
  const config = { ...DEFAULT_CONFIG, duration: 5, arrivals: 35, mode: "camera" as const };
  const recorder = new DiagnosticRecorder();
  const measured = new Simulation(config, undefined, undefined, { recordHistory: false, observer: recorder });
  const reference = new Simulation(config, undefined, undefined, { recordHistory: false });
  while (!measured.finished && measured.now < 7200) { measured.step(); recorder.sample(measured); }
  while (!reference.finished && reference.now < 7200) reference.step();
  assert.ok(measured.finished);
  assert.equal(measured.now, reference.now);
  assert.deepEqual(measured.metrics, reference.metrics);
  const d = recorder.finish(measured);
  assert.equal(d.waits.greetingWaits.n, measured.metrics.greetingWaits.length);
  assert.deepEqual(d.greetingEpisodes.map((e) => e.wait).sort((a, b) => a - b), [...measured.metrics.greetingWaits].sort((a, b) => a - b));
  assert.ok(d.actionCounts.greet.complete >= measured.metrics.greetingWaits.length, "completed service attempts can be stale; stage transitions determine served guests");
  assert.equal(d.plans.total, measured.metrics.decisions);
  assert.equal(d.pending.length, 0);
  assert.ok(d.traces.actions.length > 0);
  const text = diagnosticReport(config, [{ seed: config.seed, planner: config.planner, mode: config.mode, finished: true, simulatedSeconds: measured.now, metrics: measured.metrics, diagnostics: d }], 1, { model: "gpt-5.4-nano", maxCalls: 500 }, "incomplete comparison");
  assert.match(text, /1\/3 recorded; all finished=false/);
  assert.match(text, /Greeting = seated/);
  assert.match(text, /END JEVSBISTRO/);
});

test("starved greetings and failed inference survive partial diagnostic reports", () => {
  const recorder = new DiagnosticRecorder(), ctx = context();
  const greet = ctx.candidates.find((c) => c.kind === "greet")!;
  const other = ctx.candidates.find((c) => c.kind !== "greet")!;
  recorder.plan(ctx, [other.id], true);
  recorder.transition({ at: 100, table: 1, party: 1, from: "arriving", to: "greet", since: 90 });
  const sim = new Simulation(DEFAULT_CONFIG); sim.now = 800;
  const failure = { id: "failed", scope: "test", context: ctx, model: "gpt-5.4-nano", status: "error" as const, startedAt: 1, endedAt: 1001, error: "call limit", attempt: 1 };
  recorder.interaction(failure); recorder.interaction(failure);
  const d = recorder.finish(sim);
  assert.equal(d.plans.greetOmitted, 1);
  assert.equal(d.plans.worstDeferrals[0].greets[0].id, greet.id);
  assert.equal(d.greetingEpisodes[0].pending, true);
  assert.equal(d.greetingEpisodes[0].wait, 700);
  assert.equal(d.llm.interactions, 1);
  assert.equal(d.llm.inputTokens.n, 0, "unknown token usage is not zero-token success");
  assert.equal(d.traces.interactions[0].error, "call limit");
});
