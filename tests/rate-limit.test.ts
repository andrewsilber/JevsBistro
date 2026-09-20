import { test } from "node:test";
import assert from "node:assert/strict";
import { providerError, retryDelay } from "../server/provider-error";
import { requestPlan } from "../src/llm/client";
import { emptyUsage } from "../src/llm/protocol";
import { LlmActivity } from "../src/llm/activity";
const context = { now: 960, server: { id: 1 }, candidates: [{ id: "greet:1" }] } as any;
const settings = { model: "gpt-5.4-nano", maxCalls: 10 };
const limited = () => Response.json({ error: "Temporary rate limit", diagnostics: { retryable: true, retryAfterMs: 10000, code: "rate_limit_exceeded" } }, { status: 502 });
const settled = () => Response.json({ ids: ["greet:1"], model: settings.model, inputTokens: 50, outputTokens: 10, cachedTokens: 0, wallMs: 20 });
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

test("429 rate limits are distinct from credits, spending limits, and unknown errors", () => {
  const headers = new Headers({ "retry-after": "3", "x-ratelimit-remaining-tokens": "0" });
  const rate = providerError(429, { code: "rate_limit_exceeded", type: "tokens" }, headers);
  assert.equal(rate.retryable, true); assert.equal(rate.retryAfterMs, 3000);
  for (const code of ["insufficient_quota", "project_spend_limit_exceeded", "organization_usage_limit_exceeded", "billing_hard_limit_reached"]) {
    assert.equal(providerError(429, { code }, headers).retryable, false);
  }
  assert.equal(providerError(429, { type: "insufficient_quota" }, headers).retryable, false);
  assert.equal(providerError(429, {}, headers).retryable, false);
  assert.equal(providerError(401, { code: "rate_limit_exceeded" }, headers).retryable, false);
  assert.equal(retryDelay(new Headers({ "x-ratelimit-reset-tokens": "1m2.5s" })), 62500);
  assert.equal(retryDelay(new Headers({ "retry-after": new Date(20000).toUTCString() }), 10000), 10000);
});

test("rate limit retries honor cooldown and preserve the same decision and usage counts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0; const bodies: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => { bodies.push(JSON.parse(init.body as string)); return ++calls === 1 ? limited() : settled(); });
  const activity = new LlmActivity(), usage = emptyUsage();
  const result = requestPlan(context, settings, usage, undefined, { scope: "test", emit: activity.receive });
  await flush();
  assert.equal(activity.entries[0].status, "cooldown");
  t.mock.timers.tick(9999); await flush(); assert.equal(calls, 1);
  t.mock.timers.tick(1000); await flush();
  assert.deepEqual((await result).ids, ["greet:1"]);
  assert.deepEqual(bodies[0], bodies[1]); assert.equal(context.now, 960);
  assert.equal(usage.calls, 2); assert.equal(usage.failures, 1);
  assert.equal(activity.entries[0].status, "received");
  assert.equal(activity.entries[0].retries?.length, 1);
});

test("quota errors do not retry and cooldown cancellation cannot issue another request", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Project quota", diagnostics: { retryable: false } }, { status: 502 }));
  const usage = emptyUsage();
  await assert.rejects(requestPlan(context, settings, usage), /Project quota/);
  assert.equal(usage.calls, 1);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return limited(); });
  const abort = new AbortController(), activity = new LlmActivity();
  const result = requestPlan(context, settings, emptyUsage(), abort.signal, { scope: "test", emit: activity.receive });
  await flush(); assert.equal(activity.entries[0].status, "cooldown");
  abort.abort(); await assert.rejects(result, /cancelled/);
  t.mock.timers.tick(100000); await flush(); assert.equal(calls, 1);
  assert.equal(activity.entries[0].status, "cancelled");
});

test("retries are bounded and waits longer than the supported window never retry early", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", async () => limited());
  const usage = emptyUsage();
  const result = requestPlan(context, settings, usage);
  const rejected = assert.rejects(result, /Temporary rate limit/);
  for (let i = 0; i < 4; i++) { await flush(); t.mock.timers.tick(11000); }
  await rejected; assert.equal(usage.calls, 4);
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Rate limit", diagnostics: { retryable: true, retryAfterMs: 3600000 } }, { status: 502 }));
  const long = emptyUsage(); await assert.rejects(requestPlan(context, settings, long), /longer than two minutes/);
  assert.equal(long.calls, 1);
});
