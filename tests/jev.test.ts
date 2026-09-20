import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Simulation } from "../src/sim/engine";
import { DEFAULT_CONFIG } from "../src/sim/scenario";
import { jevRequest, jevTours, readJevAnswer } from "../src/jev/protocol";
import { createLlmMiddleware } from "../server/llm";
import { addUsage, emptyUsage } from "../src/llm/protocol";
import type { DecisionContext } from "../src/sim/types";

const config = { ...DEFAULT_CONFIG, tables: 8, servers: 2, duration: 5, arrivals: 55, mode: "camera" as const, planner: "route" as const };
function context() {
  const sim = new Simulation(config, undefined, undefined, { externalDecisions: true });
  while (!sim.pendingDecision) sim.step();
  return sim.pendingDecision.context;
}
function result(ctx: DecisionContext) {
  const keys = Object.keys(jevTours(ctx));
  return { model: "jev-1.13.0", answers: { service_tour: { type: "choice", choice: keys[0], confidence: .7,
    probabilities: Object.fromEntries(keys.map((key, i) => [key, i === 0 ? 1 : 0])) } }, usage: { input_tokens: 1000, output_tokens: 0 } };
}
test("Jev tours preserve first choices, obey inventory and route constraints, and use only observed evidence", () => {
  const sim = new Simulation(config, undefined, undefined, { externalDecisions: true, recordHistory: false });
  let decisions = 0, multi = 0, pickupsSeen = 0;
  while (!sim.finished && sim.now < 4000) {
    sim.step();
    const p = sim.pendingDecision;
    if (!p) continue;
    const offered = jevTours(p.context), tours = Object.values(offered);
    assert.ok(tours.length <= p.context.candidates.length * 2);
    assert.deepEqual(new Set(tours.map((t) => t.ids[0])), new Set(p.context.candidates.map((c) => c.id)));
    for (const tour of tours) {
      let dirty: number = p.context.server.dirty, water = p.context.server.water, at = "start", elapsed = 0;
      const tables = new Set<number>();
      assert.ok(tour.ids.length >= 1 && tour.ids.length <= 3);
      for (const [i, id] of tour.ids.entries()) {
        const c = p.context.candidates.find((c) => c.id === id)!;
        if (c.table) { assert.ok(!tables.has(c.table)); tables.add(c.table); }
        if (["pickup", "bar_pickup", "supplies", "pitcher", "drop"].includes(c.kind)) assert.equal(i, tour.ids.length - 1);
        if (["pickup", "bar_pickup"].includes(c.kind)) assert.equal(dirty, 0);
        if (c.kind === "refill") assert.ok(water >= .5);
        dirty += c.dirtyLoad ?? 0; assert.ok(dirty <= 4);
        water = Math.max(0, water - (c.waterNeeded ?? 0));
        elapsed += p.context.travelSeconds[at][id] + (c.duration ?? 5); at = id;
      }
      assert.ok(Math.abs(tour.elapsed - elapsed) < 1e-8);
    }
    const request = jevRequest(p.context, "jev-1.13.0");
    assert.equal(request.questions.service_tour.type, "choice");
    assert.deepEqual(request.state.tasks.map((t) => t.action), p.context.candidates.map((c) => c.id));
    assert.equal("scenario" in request.state, false);
    for (const [id, tour] of Object.entries(offered)) {
      const first = p.context.candidates.find((c) => c.id === tour.ids[0])!, text = request.questions.service_tour.criteria[id];
      if (!["pickup", "bar_pickup"].includes(first.kind)) continue;
      pickupsSeen++;
      // Ready tickets are credited with the tables they feed and their waiting time, never described as serving nobody.
      assert.match(text, /for tables? \d/); assert.match(text, /waiting \d+s in total/); assert.doesNotMatch(text, /no table served/);
      assert.ok(first.serves!.length >= 1 && first.waitingSeconds! >= 0);
      assert.match(text, new RegExp(`Serves ${first.serves!.length}`));
    }
    const chosen = tours.reduce((a, b) => a.reward / (20 + a.elapsed) > b.reward / (20 + b.elapsed) ? a : b);
    multi += Number(chosen.ids.length > 1);
    sim.resolveDecision(p.id, chosen.ids); decisions++;
  }
  assert.ok(decisions > 10); assert.ok(multi > 0); assert.ok(pickupsSeen > 0);
});

test("typed Jev answers reject invented plans, invalid probabilities/usage and accept ambiguous preferences", () => {
  const ctx = context(), good = result(ctx);
  assert.deepEqual(readJevAnswer(ctx, good).ids, Object.values(jevTours(ctx))[0].ids);
  for (const mutate of [
    (r: any) => r.answers.service_tour.choice = "invented",
    (r: any) => r.answers.service_tour.choice = "__proto__",
    (r: any) => r.answers.service_tour.probabilities = {},
    (r: any) => r.answers.service_tour.probabilities[r.answers.service_tour.choice] = -0.1,
    (r: any) => r.answers.service_tour.probabilities[r.answers.service_tour.choice] = Infinity,
    (r: any) => { const p = r.answers.service_tour.probabilities; p.invented = p[r.answers.service_tour.choice]; delete p[r.answers.service_tour.choice]; },
    (r: any) => r.answers.service_tour.confidence = NaN,
    (r: any) => r.usage.input_tokens = -1,
    (r: any) => r.answers.service_tour.type = "score",
  ]) { const bad = structuredClone(good); mutate(bad); assert.throws(() => readJevAnswer(ctx, bad), /invalid/); }
  const ambiguous = structuredClone(good), keys = Object.keys(ambiguous.answers.service_tour.probabilities);
  ambiguous.answers.service_tour.confidence = 0;
  ambiguous.answers.service_tour.probabilities = Object.fromEntries(keys.map((key) => [key, 1 / keys.length]));
  assert.ok(readJevAnswer(ctx, ambiguous).ids.length);
  const usage = emptyUsage(); addUsage(usage, { ...readJevAnswer(ctx, good), wallMs: 20 });
  assert.equal(usage.estimatedUsd, .000042);
  addUsage(usage, { ...readJevAnswer(ctx, good), model: "jev-future", wallMs: 20 });
  assert.equal(usage.unknownPriceCalls, 1);
});

test("reported live Jev response follows tour_12 despite tour_1 having a higher probability", () => {
  // 25 terminal actions create exactly 25 deterministic offered tours. The
  // provider response below reproduces the user's failure without credentials.
  const ctx = context();
  ctx.candidates = Array.from({ length: 25 }, (_, i) => ({ ...ctx.candidates[0], id: `pickup:${i + 1}`, kind: "pickup" as const }));
  ctx.travelSeconds = { start: Object.fromEntries(ctx.candidates.map((c) => [c.id, 5])) };
  ctx.server.dirty = 0;
  const response = { model: "jev-1.13.0", answers: { service_tour: { type: "choice", choice: "tour_12", confidence: .14,
    probabilities: { tour_9: .04, tour_6: .01, tour_17: .02, tour_1: .17, tour_24: .01, tour_3: .06, tour_20: .01, tour_14: .04,
      tour_11: .01, tour_10: .01, tour_16: .02, tour_23: .05, tour_4: .02, tour_25: .01, tour_18: 0, tour_5: .03, tour_2: .02,
      tour_22: .13, tour_12: .16, tour_21: .01, tour_7: .02, tour_19: .02, tour_15: .03, tour_13: .09, tour_8: .01 } } },
    usage: { input_tokens: 3363, output_tokens: 263 } };
  const parsed = readJevAnswer(ctx, response);
  assert.deepEqual(parsed.ids, ["pickup:12"]);
  assert.equal(parsed.inputTokens, 3363); assert.equal(parsed.outputTokens, 263);
  assert.equal(parsed.diagnostics.confidence, .14);
  assert.deepEqual(parsed.diagnostics.probabilities, response.answers.service_tour.probabilities);
  assert.equal(parsed.diagnostics.warnings.length, 1);
  assert.match(parsed.diagnostics.warnings[0], /explicit choice/);
  const rounded = structuredClone(response);
  rounded.answers.service_tour.probabilities.tour_1 = .20;
  assert.equal(readJevAnswer(ctx, rounded).diagnostics.warnings.length, 2);
  const usage = emptyUsage(); addUsage(usage, { ...parsed, wallMs: 20 });
  assert.equal(usage.inputTokens, 3363);
});

test("TypeSafe adapter uses isolated memory credentials, access check, typed endpoint and safe retries", async () => {
  const ctx = context(); let status = 200, calls = 0;
  const key = "ts-test-only-not-real";
  const middleware = createLlmMiddleware(async (url, init) => {
    calls++; assert.equal((init!.headers as any).Authorization, `Bearer ${key}`);
    if (String(url).endsWith("/models")) {
      assert.equal(init!.method, "GET"); assert.equal(init!.body, undefined);
      return Response.json({ models: [{ name: "jev-latest" }] });
    }
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.deepEqual(JSON.parse(init!.body as string), JSON.parse(JSON.stringify(jevRequest(ctx, "jev-1.13.0"))));
    if (status !== 200) return Response.json({ detail: `Error ${key}` }, { status, headers: { "retry-after": "3" } });
    const response = result(ctx);
    response.answers.service_tour.choice = Object.keys(jevTours(ctx))[1];
    return Response.json(response);
  }, "jev");
  const server = createServer((req, res) => void middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  let cookie = "";
  const post = (path: string, body: unknown, origin = base) => fetch(`${base}/api/jev/${path}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, Origin: origin }, body: JSON.stringify(body) });
  try {
    assert.equal((await post("models", {})).status, 401);
    const saved = await post("key", { key }); assert.equal(saved.status, 200); assert.equal(calls, 0);
    cookie = saved.headers.get("set-cookie")!.split(";")[0];
    assert.match(cookie, /^jb_jev_session=/); assert.match(saved.headers.get("set-cookie")!, /Path=\/api\/jev/);
    assert.equal((await post("models", {}, "https://other.example")).status, 403);
    assert.deepEqual((await (await post("models", {})).json()).models, [{ name: "jev-latest" }]);
    const planned = await (await post("plan", { context: ctx, model: "jev-1.13.0" })).json();
    assert.equal(planned.provider, "jev"); assert.equal(planned.model, "jev-1.13.0");
    assert.deepEqual(planned.ids, Object.values(jevTours(ctx))[1].ids);
    assert.match(planned.diagnostics.warnings[0], /explicit choice/);
    assert.ok(planned.diagnostics.probabilities); assert.ok(!JSON.stringify(planned).includes(key));
    for (const code of [401, 422, 429, 529]) {
      status = code;
      const response = await post("plan", { context: ctx, model: "jev-1.13.0" });
      assert.equal(response.status, 502);
      const failure = await response.json(); assert.ok(!JSON.stringify(failure).includes(key));
      assert.equal(failure.diagnostics.retryable, [429, 529].includes(code));
      assert.equal(failure.diagnostics.retryAfterMs, 3000);
    }
    await post("forget", {}); assert.equal((await post("models", {})).status, 401);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
