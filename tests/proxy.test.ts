import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Simulation } from "../src/sim/engine";
import { DEFAULT_CONFIG } from "../src/sim/scenario";
import { RouteController } from "../src/sim/controllers";
import { createLlmMiddleware } from "../server/llm";
import { requestPlan } from "../src/llm/client";
import { emptyUsage } from "../src/llm/protocol";
import { LlmActivity } from "../src/llm/activity";

const config = { ...DEFAULT_CONFIG, duration: 5, arrivals: 35, mode: "camera" as const, planner: "route" as const };
test("external inference holds the entire world and resumes the exact tick deterministically", () => {
  const reference = new Simulation(config, undefined, undefined, { recordHistory: false });
  const proxy = new Simulation(config, undefined, undefined, { recordHistory: false, externalDecisions: true });
  const controller = new RouteController();
  let calls = 0;
  while (!proxy.finished && proxy.now < 10000) {
    proxy.step();
    if (proxy.pendingDecision) {
      calls++;
      const pending = proxy.pendingDecision;
      if (calls === 1) {
        const snapshot = JSON.stringify(proxy.export());
        for (let i = 0; i < 50; i++) proxy.step();
        assert.equal(JSON.stringify(proxy.export()), snapshot);
        assert.throws(() => proxy.resolveDecision(pending.id + 1, [pending.context.candidates[0].id]), /Expired/);
        assert.throws(() => proxy.resolveDecision(pending.id, ["invented"]), /invalid/);
        assert.equal(JSON.stringify(proxy.export()), snapshot);
      }
      const now = proxy.now;
      proxy.resolveDecision(pending.id, controller.plan(pending.context));
      assert.equal(proxy.now, now);
    }
  }
  while (!reference.finished && reference.now < 10000) reference.step();
  assert.ok(calls > 5);
  assert.equal(proxy.finished, true);
  assert.equal(proxy.now, reference.now);
  assert.deepEqual(proxy.metrics, reference.metrics);
  assert.deepEqual(proxy.scenario, reference.scenario);
});

test("local adapter isolates keys, uses Responses structured output, and sanitizes provider errors", async () => {
  let providerCalls = 0, fail = false;
  const middleware = createLlmMiddleware(async (url, init) => {
    providerCalls++;
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal((init!.headers as any).Authorization, "Bearer sk-test-only-not-real");
    const body = JSON.parse(init!.body as string);
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.reasoning.effort, "none");
    assert.equal(JSON.parse(body.input).v, "bistro-rows-v1");
    assert.match(body.instructions, /tables=\[/);
    if (fail) return Response.json({ error: { code: "invalid_api_key", message: "Rejected sk-test-only-not-real" } }, { status: 401 });
    return Response.json({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify({ ids: [body.text.format.schema.properties.ids.items.enum[0]] }) }] }], usage: { input_tokens: 100, output_tokens: 20 } });
  });
  const server = createServer((req, res) => { void middleware(req, res, () => { res.statusCode = 404; res.end(); }); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const key = await fetch(`${base}/api/llm/key`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ key: "sk-test-only-not-real" }) });
    assert.equal(key.status, 200);
    assert.equal(providerCalls, 0);
    const cookie = key.headers.get("set-cookie")!.split(";")[0];
    assert.match(key.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
    const sim = new Simulation(config, undefined, undefined, { externalDecisions: true });
    while (!sim.pendingDecision) sim.step();
    const body = JSON.stringify({ context: sim.pendingDecision.context, model: "gpt-5.4-nano" });
    const post = (cookieHeader: string, origin = base) => fetch(`${base}/api/llm/plan`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookieHeader, Origin: origin }, body });
    assert.equal((await post("")).status, 401);
    assert.equal((await post(cookie, "https://other.example")).status, 403);
    const result = await (await post(cookie)).json();
    assert.equal(result.inputTokens, 100);
    assert.equal(result.ids.length, 1);
    assert.ok(!JSON.stringify(result).includes("sk-test"));
    fail = true;
    const error = await post(cookie);
    assert.equal(error.status, 502);
    const failure = await error.json();
    assert.equal(failure.error, "OpenAI rejected the API key.");
    assert.equal(failure.diagnostics.code, "invalid_api_key");
    assert.equal(failure.diagnostics.message, "Rejected [redacted]");
    await fetch(`${base}/api/llm/forget`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: "{}" });
    assert.equal((await post(cookie)).status, 401);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("call limit prevents another provider request", async () => {
  const usage = emptyUsage(); usage.calls = 1;
  await assert.rejects(requestPlan({} as any, { model: "gpt-5.4-nano", maxCalls: 1 }, usage), /call limit/);
  assert.equal(usage.calls, 1);
});

test("activity records hanging request timeout without advancing or silently retrying", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  t.mock.method(globalThis, "fetch", (_url: unknown, options: RequestInit) => {
    calls++;
    return new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(Error("aborted"))));
  });
  const activity = new LlmActivity(), sim = new Simulation(config, undefined, undefined, { externalDecisions: true });
  while (!sim.pendingDecision) sim.step();
  const before = sim.now, usage = emptyUsage();
  const pending = requestPlan(sim.pendingDecision.context, { model: "gpt-5.4-nano", maxCalls: 5 }, usage, undefined, { scope: "test", emit: activity.receive });
  assert.equal(activity.entries[0].status, "waiting");
  t.mock.timers.tick(65000);
  await assert.rejects(pending, /65 seconds/);
  assert.equal(activity.entries[0].status, "error");
  assert.equal(calls, 1);
  sim.step();
  assert.equal(sim.now, before);
});

test("activity is bounded and comparison cancellation preserves other pending requests", () => {
  const activity = new LlmActivity(), context = {} as any;
  for (let i = 0; i < 202; i++) activity.receive({ id: String(i), scope: i === 201 ? "live" : "comparison", model: "test", context, status: "waiting", startedAt: 0 });
  assert.equal(activity.entries.length, 200);
  assert.equal(activity.dropped, 2);
  activity.cancelScope("comparison");
  assert.equal(activity.entries.filter((e) => e.status === "waiting").length, 1);
  assert.equal(activity.entries.at(-1)!.scope, "live");
});
