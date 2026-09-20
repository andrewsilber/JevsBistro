import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import { RouteController } from "../src/sim/controllers";
import { jevTours } from "../src/jev/protocol";

test("real Jev settings, live decisions and three-way diagnostics use only the TypeSafe adapter", async ({ page, context }) => {
  test.setTimeout(90000);
  let calls = 0, openaiCalls = 0;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/api/llm/plan", async (route) => { openaiCalls++; await route.abort(); });
  await context.route("**/api/jev/key", async (route) => {
    expect(route.request().postDataJSON().key).toBe("ts-browser-test-only");
    await route.fulfill({ json: { configured: true } });
  });
  await context.route("**/api/jev/models", async (route) => route.fulfill({ json: { models: [{ name: "jev-latest" }] } }));
  await context.route("**/api/jev/plan", async (route) => {
    calls++;
    const data = route.request().postDataJSON();
    expect(data.model).toBe("jev-1.13.0");
    const tours = jevTours(data.context);
    const [choice, tour] = Object.entries(tours).sort(([, a], [, b]) => b.reward / (20 + b.elapsed) - a.reward / (20 + a.elapsed))[0];
    await route.fulfill({ json: { ids: tour.ids, provider: "jev", model: "jev-1.13.0", inputTokens: 1000, outputTokens: 0, cachedTokens: 0, wallMs: 25,
      diagnostics: { choice, confidence: .8, probabilities: Object.fromEntries(Object.keys(tours).map((k) => [k, k === choice ? 1 : 0])) } } });
  });
  await page.goto("/");
  await page.locator("#ai-settings-button").click();
  await expect(page.locator("#ai-provider")).toHaveValue("jev");
  await page.locator("#ai-key").fill("ts-browser-test-only");
  await page.locator("#ai-save").click();
  await expect(page.locator("#ai-key")).toHaveValue("");
  await page.locator("#ai-check").click();
  await expect(page.locator("#ai-key-status")).toContainText("access confirmed");
  await page.locator("#ai-dialog .close-dialog").click();
  await page.locator("#new-button").click();
  await page.locator('[name="tables"]').fill("2");
  await page.locator('[name="servers"]').fill("1");
  await page.locator('[name="arrivals"]').fill("24");
  await page.locator('[name="duration"]').fill("5");
  await page.getByRole("button", { name: "Create restaurant" }).click();
  await page.locator("#controller-select").selectOption("jev");
  await page.locator("#speed").selectOption("60");
  await page.locator("#run-button").click();
  await expect.poll(() => calls, { timeout: 15000 }).toBeGreaterThan(0);
  await page.locator("#ai-settings-button").click();
  await page.locator("#ai-dialog .close-dialog").click();
  await page.locator("#llm-activity-button").click();
  await expect(page.locator("#llm-request")).toContainText('"service_tour"');
  await expect(page.locator("#llm-request")).not.toContainText('"store"');
  await expect(page.locator("#llm-response")).toContainText('"confidence"');
  await page.locator("#llm-dialog .close-dialog").click();
  await page.locator("#comparison-button").click();
  await expect(page.locator("#compare-kind")).toHaveValue("jev");
  await page.locator("#compare-start").click();
  await expect(page.locator("#compare-status")).toHaveText(/^3 runs complete/, { timeout: 65000 });
  const report = await page.locator("#diagnostic-text").inputValue();
  expect(report).toContain("REAL JEV / CAMERA"); expect(report).toContain("matched scenario/layout=true");
  expect(report).toContain('"confidence"'); expect(report).not.toContain("ts-browser-test-only");
  const downloading = page.waitForEvent("download"); await page.locator("#compare-export").click();
  const exported = JSON.parse(await fs.readFile((await (await downloading).path())!, "utf8"));
  expect(exported.jevCalls).toBeGreaterThan(0); expect(exported.proxySettings.provider).toBe("jev");
  expect(exported.runs[2].provider).toBe("jev");
  expect(exported.runs[2].diagnostics.traces.requestSamples[0].request.questions.service_tour.type).toBe("choice");
  expect(openaiCalls).toBe(0); expect(errors).toEqual([]);
  await page.screenshot({ path: "work/jev-comparison.png" });
});

test("busy floor keeps bubbles and texture uploads bounded at accelerated speed", async ({ page }) => {
  await page.goto("/");
  await page.locator("#new-button").click();
  await page.locator('[name="tables"]').fill("24");
  await page.locator('[name="rooms"]').selectOption("3");
  await page.locator('[name="servers"]').fill("6");
  await page.locator('[name="arrivals"]').fill("90");
  await page.getByRole("button", { name: "Create restaurant", exact: false }).click();
  await page.locator("#speed").selectOption("60");
  await page.locator("#run-button").click();
  await page.waitForFunction(() => document.querySelector("#clock")!.textContent! >= "18:06:00");
  await page.getByLabel("Speech bubbles", { exact: true }).check();
  const samples = await page.evaluate(async () => {
    const start = performance.now();
    let maxCount = 0;
    const initial = Number((document.querySelector("#scene") as HTMLElement).dataset.bubblePaints ?? 0);
    while (performance.now() - start < 3000) {
      maxCount = Math.max(maxCount, document.querySelectorAll(".bubble-caption").length);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    const paints = Number((document.querySelector("#scene") as HTMLElement).dataset.bubblePaints ?? 0) - initial;
    return { maxCount, paints, elapsed: performance.now() - start };
  });
  expect(samples.maxCount).toBeGreaterThan(0);
  expect(samples.maxCount).toBeLessThanOrEqual(4);
  expect(samples.paints).toBeLessThanOrEqual(Math.ceil(samples.elapsed / 250) + 1);
  await page.locator("#run-button").click();
  await page.screenshot({ path: "work/bubbles-sparse-busy.png" });
  await page.getByLabel("Speech bubbles", { exact: true }).uncheck();
  await expect(page.locator(".bubble-caption")).toHaveCount(0);
});

test("saved restaurant setups restore edited menus and settings after reload without changing a run", async ({ page }) => {
  await page.goto("/");
  await page.locator("#labels").uncheck();
  await expect(page.locator("#quick-labels")).not.toBeChecked();
  await expect(page.locator(".table-label:visible")).toHaveCount(0);
  await page.locator("#new-button").click();
  await page.locator('[name="name"]').fill("Friday's Courtyard");
  await page.locator('[name="tables"]').fill("12");
  await page.locator('[name="servers"]').fill("4");
  await page.locator('[name="rooms"]').selectOption("2");
  await page.locator('[name="layoutStyle"]').selectOption("courtyard");
  await page.locator('[name="stationPlacement"]').selectOption("split");
  await page.locator('[name="seed"]').fill("1234");
  await page.locator('[name="dessertRate"]').fill("80");
  await page.locator('[name="phoneRate"]').fill("15");
  await page.locator('[name="requestRate"]').fill("8");
  await page.locator('[name="interruptions"]').uncheck();
  await page.locator('[name="dish0"]').fill("Friday garden salad");
  await page.locator('[name="prep0"]').fill("150");
  await page.locator("#preset-name").fill("Busy Friday");
  await page.locator("#preset-save").click();
  await expect(page.locator("#preset-status")).toContainText("Saved “Busy Friday”");
  await expect(page.locator("#restaurant-name")).toHaveText("The Juniper Room");
  const saved = await page.locator("#preset-list").inputValue();
  await page.reload();
  await expect(page.locator("#labels")).not.toBeChecked();
  await expect(page.locator(".table-label:visible")).toHaveCount(0);
  await page.locator("#quick-labels").check();
  await expect(page.locator("#labels")).toBeChecked();
  await expect(page.locator(".table-label:visible")).toHaveCount(8);
  await page.locator("#new-button").click();
  await page.locator("#preset-list").selectOption(saved);
  await page.locator("#preset-load").click();
  await expect(page.locator('[name="name"]')).toHaveValue("Friday's Courtyard");
  for (const [name, value] of Object.entries({ tables: "12", servers: "4", rooms: "2", layoutStyle: "courtyard", stationPlacement: "split", seed: "1234", dessertRate: "80", phoneRate: "15", requestRate: "8", dish0: "Friday garden salad", prep0: "150" }))
    await expect(page.locator(`[name="${name}"]`)).toHaveValue(value);
  await expect(page.locator('[name="interruptions"]')).not.toBeChecked();
  await expect(page.locator("#restaurant-name")).toHaveText("The Juniper Room");
  await page.locator('[name="servers"]').fill("3");
  await expect(page.locator("#preset-save")).toHaveText("Update saved setup");
  await page.locator("#preset-save").click();
  await expect(page.locator("#preset-status")).toContainText("Updated");
  await expect(page.locator("#preset-list option")).toHaveCount(2);
  await page.screenshot({ path: "work/saved-restaurants.png" });
  await page.getByRole("button", { name: "Create restaurant", exact: false }).click();
  await expect(page.locator("#restaurant-name")).toHaveText("Friday's Courtyard");
  await expect(page.locator(".table-label")).toHaveCount(12);
  await page.locator("#new-button").click();
  await page.locator("#preset-list").selectOption(saved);
  await page.locator("#preset-load").click();
  await expect(page.locator('[name="servers"]')).toHaveValue("3");
  await page.locator("#preset-delete").click();
  await expect(page.locator("#preset-status")).toContainText("Deleted");
  await expect(page.locator("#preset-list option")).toHaveCount(1);
  await expect(page.locator("#restaurant-name")).toHaveText("Friday's Courtyard");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("preset storage failure is visible and does not report a successful save", async ({ page }) => {
  await page.goto("/");
  await page.locator("#new-button").click();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === "jevsbistro-restaurants-v1") throw new DOMException("Full", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await page.locator("#preset-save").click();
  await expect(page.locator("#preset-status")).toContainText("not saved");
  await expect(page.locator("#preset-list option")).toHaveCount(1);
});

test("bubble GPU depth, transparent corners, and tip-anchored entry and exit", async ({ page }) => {
  await page.goto("/tests/bubble-fixture.html");
  await page.waitForFunction(() => "bubbleHarness" in window);
  const result = await page.evaluate(() => {
    const h = (window as any).bubbleHarness;
    h.draw(80); const entering = h.snapshot();
    h.draw(300); const full = h.snapshot(), bubblePixel = h.pixel(0, 1.2);
    h.wall(1); h.draw(310); const covered = h.pixel(0, 1.2);
    h.wall(-1); h.draw(320); const behind = h.pixel(0, 1.2), clearCorner = h.pixel(1.885, 1.2);
    h.enable(false); h.draw(400); h.draw(490); const exiting = h.snapshot();
    h.draw(600); const removed = h.snapshot();
    return { entering, full, bubblePixel, covered, behind, clearCorner, exiting, removed };
  });
  expect(result.entering.scale).toBeGreaterThan(0);
  expect(result.entering.scale).toBeLessThan(result.full.scale);
  expect(result.exiting.scale).toBeGreaterThan(0);
  expect(result.exiting.scale).toBeLessThan(result.full.scale);
  expect(result.entering.position).toEqual(result.full.position);
  expect(result.exiting.position).toEqual(result.full.position);
  expect(result.entering.pivot).toEqual(result.full.pivot);
  expect(result.full.pivot[0]).toBe(.5);
  expect(result.full.pivot[1]).toBeGreaterThan(0); // tip, not empty canvas padding
  expect(result.removed).toBeNull();
  expect(result.covered).toEqual([193, 36, 112, 255]); // opaque wall in front wins
  expect(result.bubblePixel).not.toEqual(result.covered);
  expect(result.behind).toEqual(result.bubblePixel); // balloon in front wins
  expect(result.clearCorner).toEqual(result.covered); // no invisible rectangle
});

test("world-space speech and thoughts scale with zoom and survive pause and reset", async ({ page }) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator(".bubble-caption")).toHaveCount(0);
  await page.getByLabel("Speech bubbles", { exact: true }).check();
  await expect(page.locator('.bubble-caption.server[data-visible="true"]').first()).toContainText("thinks:");
  await page.locator("#speed").selectOption("5");
  await page.locator("#run-button").click();
  const greeting = page.locator('.bubble-caption.server[data-cue="greet"]').first();
  await expect(greeting).toHaveAttribute("data-visible", "true", { timeout: 40000 });
  await page.locator("#run-button").click();
  await expect(greeting).toHaveAttribute("data-phase", "shown");
  await expect(greeting).toContainText("says:");
  const clock = await page.locator("#clock").innerText();
  const text = await greeting.innerText();
  const before = Number(await greeting.getAttribute("data-screen-width"));
  const worldWidth = await greeting.getAttribute("data-world-width");
  await page.screenshot({ path: "work/dialogue-world.png" });
  await page.locator("#zoom-in").click();
  await expect.poll(async () => Number(await greeting.getAttribute("data-screen-width")) / before).toBeCloseTo(1.3, 1);
  await expect(greeting).toHaveAttribute("data-world-width", worldWidth!);
  await expect(greeting).toHaveText(text);
  await expect(page.locator("#clock")).toHaveText(clock);
  await page.screenshot({ path: "work/dialogue-zoom.png" });
  await page.locator("#fit-view").click();
  await page.locator("#top").click();
  await page.locator("#theme-button").click();
  await expect(page.locator('.bubble-caption[data-visible="true"]').first()).toHaveAttribute("data-visible", "true");
  await page.screenshot({ path: "work/dialogue-dark-top.png" });
  await page.getByLabel("Speech bubbles", { exact: true }).uncheck();
  await expect(page.locator(".bubble-caption")).toHaveCount(0);
  await expect(page.locator("#clock")).toHaveText(clock);
  await page.getByLabel("Speech bubbles", { exact: true }).check();
  // Inspecting a table does not switch balloons on or off.
  await page.getByRole("button", { name: "Inspect table 1", exact: true }).click();
  expect(await page.locator(".bubble-caption").count()).toBeLessThanOrEqual(4);
  await page.screenshot({ path: "work/dialogue-diner.png" });
  await page.locator("#reset-button").click();
  await page.locator("#confirm-reset").click();
  await expect(page.locator(".bubble-caption.customer")).toHaveCount(0);
  await expect(page.locator('.bubble-caption.server[data-visible="true"]').first()).toContainText("thinks:");
  expect(errors).toEqual([]);
});

test("temporary rate limit shows cooldown and retries without advancing the restaurant", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/llm/plan", async (route) => {
    calls++;
    if (calls === 1) { await route.fulfill({ status: 502, json: { error: "OpenAI temporarily throttled requests or tokens.", diagnostics: { code: "rate_limit_exceeded", retryable: true, retryAfterMs: 3000, rateLimits: { "x-ratelimit-remaining-tokens": "0" } } } }); return; }
    const data = route.request().postDataJSON();
    await route.fulfill({ json: { ids: new RouteController().plan(data.context), model: data.model, inputTokens: 500, outputTokens: 30, cachedTokens: 0, wallMs: 100 } });
  });
  await page.goto("/");
  await page.locator("#ai-settings-button").click();
  await page.locator("#ai-limit").fill("2");
  await page.locator("#ai-dialog .close-dialog").click();
  await page.locator("#controller-select").selectOption("proxy");
  await page.locator("#speed").selectOption("60");
  await page.locator("#run-button").click();
  await expect(page.locator("#proxy-status")).toContainText("Rate limit cooldown", { timeout: 15000 });
  const clock = await page.locator("#clock").innerText();
  await page.locator("#llm-activity-button").click();
  await expect(page.locator("#llm-summary")).toContainText("retry automatically");
  await expect(page.locator("#llm-timing")).toContainText("Auto-retry in");
  await expect(page.locator("#llm-response")).toContainText("rate_limit_exceeded");
  await page.locator("#llm-follow").uncheck();
  await page.waitForTimeout(300);
  await expect(page.locator("#clock")).toHaveText(clock);
  expect(calls).toBe(1);
  await page.screenshot({ path: "work/llm-cooldown.png" });
  await expect(page.locator("#llm-summary")).toContainText("Response received", { timeout: 10000 });
  await expect(page.locator("#llm-timing")).toContainText("Attempt 2/4");
  expect(calls).toBe(2);
  await expect(page.locator("#llm-response")).toContainText('"retries"');
});

test("API settings and proxy freeze time, enforce call limit, and exclude keys from exports", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  await page.route("**/api/llm/plan", async (route) => {
    calls++;
    const data = route.request().postDataJSON();
    expect(data.model).toBe("gpt-5.4-mini");
    await held;
    await route.fulfill({ json: { ids: new RouteController().plan(data.context), model: data.model, inputTokens: 500, outputTokens: 30, cachedTokens: 0, wallMs: 900 } });
  });
  await page.goto("/");
  await page.locator("#ai-settings-button").click();
  await page.locator("#ai-provider").selectOption("openai");
  await page.locator("#ai-key").fill("sk-test-only-not-real");
  await page.locator("#ai-save").click();
  await expect(page.locator("#ai-key-status")).toContainText("Key stored locally");
  await expect(page.locator("#ai-key")).toHaveValue("");
  await page.locator("#ai-model").selectOption("gpt-5.4-mini");
  await page.locator("#ai-limit").fill("1");
  await page.locator("#ai-dialog .close-dialog").click();
  await page.locator("#controller-select").selectOption("proxy");
  await page.locator("#speed").selectOption("60");
  await page.locator("#run-button").click();
  await expect(page.locator("#proxy-status")).toContainText("Planning", { timeout: 15000 });
  const clock = await page.locator("#clock").innerText();
  const stats = await page.locator(".stats").innerText();
  const marker = await page.locator(".server-marker").first().getAttribute("style");
  await page.waitForTimeout(600);
  await expect(page.locator("#clock")).toHaveText(clock);
  await expect(page.locator(".stats")).toHaveText(stats, { useInnerText: true });
  await expect(page.locator(".server-marker").first()).toHaveAttribute("style", marker!);
  await expect(page.locator("#controller-select")).toBeDisabled();
  await page.locator("#llm-activity-button").click();
  await expect(page.locator("#llm-summary")).toContainText("Waiting for the local adapter / inference provider");
  await expect(page.locator("#llm-title")).toContainText("gpt-5.4-mini");
  const elapsed = await page.locator("#llm-timing").innerText();
  await page.waitForTimeout(350);
  await expect(page.locator("#llm-timing")).not.toHaveText(elapsed);
  await expect(page.locator("#clock")).toHaveText(clock);
  await page.getByText("Instructions sent to the model", { exact: true }).click();
  await expect(page.locator("#llm-instructions")).toContainText("You dispatch a restaurant server");
  await page.getByText("Restaurant observations & feasible actions", { exact: true }).click();
  await expect(page.locator("#llm-context")).toContainText('"candidates"');
  await page.locator("#llm-follow").uncheck();
  release();
  await expect(page.locator("#proxy-status")).toContainText("call limit", { timeout: 15000 });
  await expect(page.locator("#llm-summary")).toContainText("Response received");
  await expect(page.locator("#llm-outcome")).toContainText("500 in / 30 out");
  const activityDownload = page.waitForEvent("download");
  await page.locator("#llm-export").click();
  const activityText = await fs.readFile((await (await activityDownload).path())!, "utf8");
  expect(activityText).not.toContain("sk-test");
  const activity = JSON.parse(activityText);
  expect(activity.entries[0].response.ids.length).toBeGreaterThan(0);
  expect(activity.entries[0].request.instructions).toContain("dispatch");
  await page.screenshot({ path: "work/llm-activity.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#llm-dialog .close-dialog").click();
  expect(calls).toBe(1);
  await page.locator("#report-button").click();
  const downloading = page.waitForEvent("download");
  await page.locator("#export-button").click();
  const content = await fs.readFile((await (await downloading).path())!, "utf8");
  expect(content).not.toContain("sk-test");
  const report = JSON.parse(content);
  expect(report.proxy.usage.calls).toBe(1);
  expect(report.proxy.settings.model).toBe("gpt-5.4-mini");
  expect(report.proxy.simulatedLatencyMs).toBe(0);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("sk-test");
  await page.locator("#report-dialog .close-dialog").click();
  await page.locator("#ai-settings-button").click();
  await page.locator("#ai-forget").click();
  await expect(page.locator("#ai-key-status")).toHaveText("Key removed.");
});

test("proxy comparison exports three complete paired conditions with visible usage", async ({ page, context }) => {
  test.setTimeout(90000);
  let calls = 0;
  await context.route("**/api/llm/plan", async (route) => {
    calls++;
    const data = route.request().postDataJSON();
    await route.fulfill({ json: { ids: new RouteController().plan(data.context), model: data.model, inputTokens: 500, outputTokens: 30, cachedTokens: 0, wallMs: 100 } });
  });
  await page.goto("/");
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as any).copiedDiagnostic = text; } } }));
  await page.locator("#new-button").click();
  await page.locator('[name="tables"]').fill("2");
  await page.locator('[name="servers"]').fill("1");
  await page.locator('[name="arrivals"]').fill("24");
  await page.locator('[name="duration"]').fill("5");
  await page.getByRole("button", { name: "Create restaurant" }).click();
  await page.locator("#comparison-button").click();
  await page.locator("#compare-kind").selectOption("diagnostic");
  await page.locator("#compare-start").click();
  await expect(page.locator("#compare-status")).toHaveText(/^3 runs complete/, { timeout: 65000 });
  await expect(page.locator("#compare-results tbody tr")).toHaveCount(3);
  const diagnostic = await page.locator("#diagnostic-text").inputValue();
  expect(diagnostic).toContain("JEVSBISTRO DIAGNOSTIC REPORT v1");
  expect(diagnostic).toContain("all finished=true");
  expect(diagnostic).toContain("matched scenario/layout=true");
  expect(diagnostic).toContain("bistro-rows-v1");
  expect(diagnostic).toContain("Actual actions");
  await page.locator("#diagnostic-copy").click();
  await expect(page.locator("#diagnostic-copy-status")).toContainText("Copied");
  expect(await page.evaluate(() => (window as any).copiedDiagnostic)).toBe(diagnostic);
  expect(calls).toBeGreaterThan(0);
  await expect(page.locator("#clock")).toHaveText("18:00:00");
  await page.screenshot({ path: "work/proxy-comparison.png" });
  const downloading = page.waitForEvent("download");
  await page.locator("#compare-export").click();
  const report = JSON.parse(await fs.readFile((await (await downloading).path())!, "utf8"));
  expect(report.runs).toHaveLength(3);
  expect(report.runs.every((run: any) => run.finished && run.seed === 42)).toBe(true);
  expect(report.runs[2].usage.calls).toBe(calls);
  expect(report.runs[2].metrics).toEqual(report.runs[1].metrics);
  expect(report.diagnostic).toBe(true);
  expect(report.runs.every((run: any) => run.diagnostics.scenarioFingerprint === report.runs[0].diagnostics.scenarioFingerprint)).toBe(true);
  expect(report.runs[2].diagnostics.traces.requestSamples[0].request.input).toContain("bistro-rows-v1");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("proxy failure pauses visibly and reset discards an in-flight response", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  await page.route("**/api/llm/plan", async (route) => {
    calls++;
    if (calls === 1) { await route.fulfill({ status: 502, json: { error: "OpenAI rate limit reached." } }); return; }
    await held;
    await route.fulfill({ json: { ids: new RouteController().plan(route.request().postDataJSON().context), model: "gpt-5.4-nano", inputTokens: 500, outputTokens: 30, cachedTokens: 0, wallMs: 100 } }).catch(() => {});
  });
  await page.goto("/");
  await page.locator("#controller-select").selectOption("proxy");
  await page.locator("#speed").selectOption("60");
  await page.locator("#run-button").click();
  await expect(page.locator("#proxy-status")).toContainText("rate limit", { timeout: 15000 });
  const clock = await page.locator("#clock").innerText();
  await page.waitForTimeout(300);
  await expect(page.locator("#clock")).toHaveText(clock);
  await page.locator("#run-button").click();
  await expect(page.locator("#proxy-status")).toContainText("Planning");
  await page.locator("#reset-button").click();
  await page.locator("#confirm-reset").click();
  release();
  await page.waitForTimeout(300);
  await expect(page.locator("#clock")).toHaveText("18:00:00");
  await expect(page.locator("#proxy-status")).toContainText("0/500 calls");
  await expect(page.locator("#controller-select")).toBeEnabled();
});

test("closing a proxy comparison stops requests and keeps completed baselines", async ({ page, context }) => {
  let calls = 0, release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await context.route("**/api/llm/plan", async (route) => {
    calls++;
    await held;
    await route.fulfill({ json: { ids: new RouteController().plan(route.request().postDataJSON().context), model: "gpt-5.4-nano", inputTokens: 100, outputTokens: 10, cachedTokens: 0, wallMs: 100 } }).catch(() => {});
  });
  await page.goto("/");
  await page.locator("#new-button").click();
  await page.locator('[name="duration"]').fill("5");
  await page.getByRole("button", { name: "Create restaurant" }).click();
  await page.locator("#comparison-button").click();
  await page.locator("#compare-kind").selectOption("diagnostic");
  await page.locator("#compare-start").click();
  await expect(page.locator("#compare-status")).toContainText("clock frozen", { timeout: 15000 });
  await page.locator("#compare-activity").click();
  await expect(page.locator("#llm-list")).toContainText("Comparison");
  await expect(page.locator("#llm-summary")).toContainText("Waiting for the local adapter / inference provider");
  await page.locator("#llm-dialog .close-dialog").click();
  await page.locator("#comparison-dialog .close-dialog").click();
  release();
  await page.waitForTimeout(300);
  await page.locator("#comparison-button").click();
  await expect(page.locator("#compare-status")).toContainText("Stopped");
  expect(calls).toBe(1);
  await page.locator("#compare-activity").click();
  await expect(page.locator("#llm-summary")).toContainText("CANCELLED");
  await page.locator("#llm-dialog .close-dialog").click();
  await expect(page.locator("#compare-start")).toBeEnabled();
  await expect(page.locator("#compare-results tbody tr").first()).toContainText("Complete");
  const diagnostic = await page.locator("#diagnostic-text").inputValue();
  expect(diagnostic).toContain("Stopped by user; unfinished run.");
  expect(diagnostic).toContain("all finished=false");
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw Error("denied"); } } }));
  await page.locator("#diagnostic-copy").click();
  await expect(page.locator("#diagnostic-copy-status")).toContainText("Ctrl+C");
});

test("courtyard, split bar and paired comparison run through the UI", async ({ page }) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.locator("#new-button").click();
  await page.locator('[name="layoutStyle"]').selectOption("courtyard");
  await page.locator('[name="stationPlacement"]').selectOption("split");
  await page.locator('[name="planner"]').selectOption("route");
  await page.locator('[name="duration"]').fill("5");
  await page.locator('[name="arrivals"]').fill("35");
  await page.locator('[name="cocktailRate"]').fill("100");
  await page.getByRole("button", { name: "Create restaurant" }).click();
  await expect(page.locator("#service-subtitle")).toContainText("courtyard");
  await page.locator("#paths").check();
  await page.getByLabel("Simulation speed").selectOption("60");
  await page.locator("#run-button").click();
  await page.waitForFunction(() => document.querySelector("#clock")!.textContent! >= "18:04:00", {}, { timeout: 20000 });
  await page.locator("#run-button").click();
  await page.locator("#activity-toggle").click();
  await page.screenshot({ path: "work/courtyard-bar-planning.png" });
  const clock = await page.locator("#clock").innerText();
  await page.locator("#comparison-button").click();
  await page.locator("#compare-kind").selectOption("rules");
  await page.locator("#compare-count").fill("1");
  await page.locator("#compare-start").click();
  await expect(page.locator("#compare-status")).toHaveText(/^4 runs complete/, { timeout: 30000 });
  await expect(page.locator("#compare-start")).toBeEnabled();
  await expect(page.locator("#compare-results tbody tr")).toHaveCount(4);
  await expect(page.locator("#clock")).toHaveText(clock);
  await page.screenshot({ path: "work/comparison-results.png" });
  const downloading = page.waitForEvent("download");
  await page.locator("#compare-export").click();
  const report = JSON.parse(await fs.readFile((await (await downloading).path())!, "utf8"));
  expect(report.jevCalls).toBe(0);
  expect(report.config.layoutStyle).toBe("courtyard");
  expect(report.runs).toHaveLength(4);
  expect(report.runs.every((r: any) => r.seed === 42 && r.finished && r.metrics.cocktailsServed > 0)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("camera history shows absent diners and preserves their table observations", async ({ page }) => {
  await page.goto("/");
  await page.locator("#new-button").click();
  await page.locator('[name="bathroomRate"]').fill("100");
  await page.locator('[name="duration"]').fill("5");
  await page.locator('[name="interruptions"]').uncheck();
  await page.getByRole("button", { name: "Create restaurant" }).click();
  await page.getByLabel("Simulation speed").selectOption("60");
  await page.locator("#run-button").click();
  await page.waitForFunction(() => document.querySelector("#clock")!.textContent! >= "18:08:00", {}, { timeout: 20000 });
  await page.locator("#run-button").click();
  await page.screenshot({ path: "work/guests-and-staff.png" });
  await page.locator("#report-button").click();
  const downloading = page.waitForEvent("download");
  await page.locator("#export-button").click();
  const download = await downloading;
  const report = JSON.parse(await fs.readFile((await download.path())!, "utf8"));
  const absent = report.cameraSnapshots.findIndex((frame: any) => frame.tables.some((table: any) =>
    ["reading", "cooking", "eating"].includes(table.stage) && table.diners.some((d: any) => !d.present)));
  expect(absent).toBeGreaterThan(0);
  await page.locator("#report-dialog .close-dialog").click();
  await page.locator("#scene-feed").click();
  await page.locator("#feed-scrubber").fill(String(absent));
  await expect(page.locator("#feed-tables")).toContainText("Away from table");
  await expect(page.locator("#observation-text")).toContainText("PRESENT = false");
  await page.screenshot({ path: "work/restroom-observations.png" });
});

test("one-times playback interpolates staff movement between ticks and freezes on pause", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator(".server-marker")).toHaveCount(2);
  await page.getByLabel("Simulation speed").selectOption("1");
  await page.locator("#run-button").click();
  await page.waitForTimeout(350);
  const samples = await page.evaluate(() => new Promise<{ x: number; y: number; at: number }[]>((resolve) => {
    const samples: { x: number; y: number; at: number }[] = [];
    let start = 0;
    const sample = (at: number) => {
      start ||= at;
      const marker = document.querySelector<HTMLElement>(".server-marker")!;
      samples.push({ x: parseFloat(marker.style.left), y: parseFloat(marker.style.top), at });
      if (at - start < 1600) requestAnimationFrame(sample); else resolve(samples);
    };
    requestAnimationFrame(sample);
  }));
  // A raw 4 Hz scene produces only ~7 positions in this interval.
  expect(new Set(samples.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`)).size).toBeGreaterThan(12);
  await page.locator("#run-button").click();
  await page.waitForTimeout(100);
  const markerStyle = await page.locator(".server-marker").first().getAttribute("style");
  await page.waitForTimeout(350);
  await expect(page.locator(".server-marker").first()).toHaveAttribute("style", markerStyle!);
  await page.locator("#theme-button").click();
  await page.screenshot({ path: "work/staff-dark.png" });
  await expect(page.locator(".server-marker").first()).toHaveText("S1");
  expect(errors).toEqual([]);
});

test("course menu and guest habits persist into a new seeded run", async ({ page }) => {
  await page.goto("/");
  await page.locator("#new-button").click();
  await expect(page.locator("#menu-fields .menu-row")).toHaveCount(9);
  await page.locator('[name="appetizerRate"]').fill("100");
  await page.locator('[name="dessertRate"]').fill("100");
  await page.locator('[name="phoneRate"]').fill("100");
  await page.locator('[name="lingerRate"]').fill("100");
  await page.locator('[name="bathroomRate"]').fill("100");
  await page.locator('[name="dish0"]').fill("House starter");
  await page.locator("#add-dish").click();
  await expect(page.locator('[name="dish0"]')).toHaveValue("House starter");
  await page.getByLabel("Dish 10 name", { exact: true }).fill("Strawberry sundae");
  await page.getByLabel("Dish 10 course", { exact: true }).selectOption("dessert");
  await page.getByLabel("Remove dish 9", { exact: true }).click();
  await expect(page.getByLabel("Dish 9 name", { exact: true })).toHaveValue("Strawberry sundae");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "work/menu-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(".guest-editor").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "work/menu-expanded.png" });
  await page.getByRole("button", { name: "Create restaurant" }).click();
  await page.locator("#report-button").click();
  await expect(page.locator("#report-metrics")).toContainText("Avg. ready-to-table time");
  const downloading = page.waitForEvent("download");
  await page.locator("#export-button").click();
  const download = await downloading;
  const report = JSON.parse(await fs.readFile((await download.path())!, "utf8"));
  expect(report.schemaVersion).toBe(6);
  expect(report.config.menu).toHaveLength(9);
  expect(report.config.menu[8].name).toBe("Strawberry sundae");
  expect(report.config.phoneRate).toBe(100);
  expect(report.config.bathroomRate).toBe(100);
  expect(report.scenario.every((p: any) => p.bathroomPlans.every((plan: any) => plan && plan.duration > 0))).toBe(true);
  expect(report.scenario.every((p: any) => p.meals.every((meal: any[]) => meal.length === 3))).toBe(true);
  expect(report.scenario.every((p: any) => p.lingerSeconds >= 60 && p.behaviors.every((b: any) => b.phoneSeconds > 0))).toBe(true);
});
test("service controls, table inspection, report export, and replay", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("canvas")).toBeVisible();
  await page.getByLabel("Simulation speed").selectOption("60");
  await page.getByRole("button", { name: "Run service", exact: true }).click();
  await expect(page.locator("#guests")).not.toHaveText("0", { timeout: 10000 });
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const time = await page.locator("#clock").innerText();
  await page.waitForTimeout(500);
  await expect(page.locator("#clock")).toHaveText(time);
  await page
    .getByRole("button", { name: "Inspect table 1", exact: true })
    .click();
  await expect(page.locator("#inspector")).toBeVisible();
  await page.getByLabel("Close table details").click();
  await page.getByRole("button", { name: "Top-down" }).click();
  await expect(page.locator("#top")).toHaveClass("active");
  await page
    .getByRole("button", { name: "Service report", exact: true })
    .click();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export run as JSON" }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toContain("seed-42-patrol.json");
  await page.locator("#report-dialog .close-dialog").click();
  await page
    .getByRole("button", { name: "Reset", exact: false })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Reset service", exact: true })
    .click();
  await expect(page.locator("#clock")).toHaveText("18:00:00");
  await expect(page.locator("#guests")).toHaveText("0");
  expect(errors).toEqual([]);
});
test("new restaurant applies configuration and narrow screens do not overflow", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "New restaurant", exact: true })
    .click();
  await page.locator("[name=name]").fill("A three-room experiment");
  await page.locator("[name=rooms]").selectOption("3");
  await page.locator("[name=tables]").fill("12");
  await page.locator("[name=mode]").selectOption("camera");
  await page.getByRole("button", { name: "Create restaurant" }).click();
  await expect(page.locator("#restaurant-name")).toHaveText(
    "A three-room experiment",
  );
  await expect(page.locator(".table-label")).toHaveCount(12);
  await expect(page.locator("#camera-card")).toHaveClass(/active/);
  await page.getByRole("button", { name: "Inspect camera feed" }).click();
  await expect(page.locator("#observation-text")).toContainText("ROOM 3");
  await page.locator("#observations-dialog .close-dialog").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("larger workspace, bounded markers, visible routes, and persistent dark theme", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const before = (await page.locator("#scene").boundingBox())!;
  await page.locator("#expand-view").click();
  await expect(page.locator("#expand-view")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect
    .poll(async () => (await page.locator("#scene").boundingBox())!.height)
    .toBeGreaterThan(before.height);
  await page.locator("#zoom-in").click();
  await page.locator("#zoom-in").click();
  const marker = page.locator(".table-label:visible").first();
  await expect(marker).toHaveAttribute("aria-description", "Available");
  expect((await marker.boundingBox())!.width).toBeLessThan(45);
  await page.locator("#fit-view").click();
  await page.locator("#expand-view").click();
  await page.locator("#paths").check();
  await expect(page.locator("#path-status")).toContainText("Run service");
  await page.getByRole("button", { name: "Run service", exact: true }).click();
  await expect
    .poll(async () =>
      Number(await page.locator("#scene").getAttribute("data-route-segments")),
    )
    .toBeGreaterThan(0);
  await expect(page.locator("#path-status")).toContainText("active routes");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const clock = await page.locator("#clock").innerText();
  await page.locator("#theme-button").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("#clock")).toHaveText(clock);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
test("camera history scrubs, steps, plays and resumes live without changing simulation time", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Simulation speed").selectOption("60");
  await page.getByRole("button", { name: "Run service", exact: true }).click();
  await page.waitForFunction(
    () => document.getElementById("clock")!.textContent! >= "18:06:00",
    {},
    { timeout: 25000 },
  );
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const liveTime = await page.locator("#clock").innerText();
  await page.locator("#scene-feed").click();
  await expect(page.locator("#feed-mode")).toHaveText("LIVE");
  await page.locator("#feed-scrubber").fill("0");
  await expect(page.locator("#feed-time")).toHaveText("18:00:00");
  await expect(page.locator("#feed-mode")).toHaveText("HISTORY");
  await page.getByRole("button", { name: "Next camera frame" }).click();
  await expect(page.locator("#feed-time")).toHaveText("18:00:01");
  await page.getByRole("button", { name: "Play camera history" }).click();
  await expect(page.locator("#feed-time")).not.toHaveText("18:00:01");
  await page.getByRole("button", { name: "Pause camera history" }).click();
  await expect(page.locator("#clock")).toHaveText(liveTime);
  await page.locator("#feed-live").click();
  await expect(page.locator("#feed-mode")).toHaveText("LIVE");
  await expect(page.locator("#feed-tables")).toContainText("% complete");
  await expect(page.locator("#feed-tables .activity").first()).toBeVisible();
  await page.locator("#feed-scrubber").fill("0");
  const old = await page.locator("#feed-tables").innerText();
  await page.locator("#observations-dialog .close-dialog").click();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.waitForTimeout(300);
  await page.locator("#scene-feed").click();
  await expect(page.locator("#feed-time")).toHaveText("18:00:00");
  await expect(page.locator("#feed-tables")).toHaveText(old, {
    useInnerText: true,
  });
});

test("run history records completed and partial services, sorts, reuses setups, deletes rows and clears", async ({ page }) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.locator("#history-button").click();
  await expect(page.locator("#history-table")).toContainText("No runs saved yet");
  await expect(page.locator("#history-count")).toHaveText("0 saved runs");
  await page.locator("#history-dialog .close-dialog").click();
  await page.locator("#new-button").click();
  await page.locator('[name="name"]').fill("History bistro");
  for (const [name, value] of Object.entries({ tables: "2", servers: "1", arrivals: "4", duration: "5", seed: "7", cocktailRate: "0", appetizerRate: "0", dessertRate: "0", phoneRate: "0", bathroomRate: "0", lingerRate: "0" }))
    await page.locator(`[name="${name}"]`).fill(value);
  await page.locator('[name="interruptions"]').uncheck();
  await page.getByRole("button", { name: "Create restaurant", exact: false }).click();
  await expect(page.locator("#restaurant-name")).toHaveText("History bistro");
  await page.getByLabel("Simulation speed").selectOption("60");
  await page.getByRole("button", { name: "Run service", exact: true }).click();
  await expect(page.locator("#complete-banner")).toBeVisible({ timeout: 90000 });
  await page.locator("#complete-report").click();
  await expect(page.locator("#history-save-status")).toHaveText("Saved to run history automatically.");
  await page.locator("#report-dialog .close-dialog").click();
  await page.locator("#history-button").click();
  const rows = page.locator("#history-table tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("History bistro");
  await expect(rows.first()).toContainText("Complete");
  await expect(rows.first()).toContainText("Rules");
  await expect(rows.first()).toContainText("Local scans");
  await page.locator("#history-dialog .close-dialog").click();
  // A paused partial run can be saved by hand and is labelled as such.
  await page.getByRole("button", { name: "Reset", exact: false }).first().click();
  await page.getByRole("button", { name: "Reset service", exact: true }).click();
  await page.getByRole("button", { name: "Run service", exact: true }).click();
  await expect(page.locator("#guests")).not.toHaveText("0", { timeout: 20000 });
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Service report", exact: true }).click();
  await expect(page.locator("#history-save-status")).toHaveText("Not yet in run history.");
  await page.locator("#history-save").click();
  await expect(page.locator("#history-save-status")).toHaveText("Saved this partial run to run history.");
  await page.locator("#report-dialog .close-dialog").click();
  await page.reload();
  await page.locator("#history-button").click();
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Partial");
  await expect(page.locator("#history-count")).toHaveText("2 saved runs");
  const allHeaders = await page.locator("#history-table thead tr:nth-child(2) th").count();
  await page.locator("#history-setup").uncheck();
  expect(await page.locator("#history-table thead tr:nth-child(2) th").count()).toBeLessThan(allHeaders);
  await expect(page.locator("#history-table")).not.toContainText("Floor plan");
  await page.locator("#history-setup").check();
  await page.locator('[data-sort="status"]').click();
  await expect(page.locator('th[aria-sort="descending"]')).toContainText("Status");
  await expect(rows.first()).toContainText("Partial");
  await page.locator('[data-sort="status"]').click();
  await expect(page.locator('th[aria-sort="ascending"]')).toContainText("Status");
  await expect(rows.first()).toContainText("Complete");
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#history-export").click();
  expect((await downloadEvent).suggestedFilename()).toBe("jevsbistro-run-history.csv");
  await page.screenshot({ path: "work/run-history.png" });
  await page.locator('[data-action="use"]').first().click();
  await expect(page.locator("#create-dialog")).toBeVisible();
  await expect(page.locator('[name="name"]')).toHaveValue("History bistro");
  await expect(page.locator('[name="seed"]')).toHaveValue("7");
  await page.locator("#create-dialog .close-dialog").click();
  await page.locator("#history-button").click();
  await page.locator('[data-action="delete"]').first().click();
  await expect(rows).toHaveCount(1);
  await expect(page.locator("#history-status")).toContainText("Deleted “History bistro”");
  await page.locator("#history-clear").click();
  await expect(page.locator("#history-clear")).toContainText("Confirm");
  await expect(rows).toHaveCount(1);
  await page.locator("#history-clear").click();
  await expect(page.locator("#history-table")).toContainText("No runs saved yet");
  await expect(page.locator("#history-clear")).toHaveText("Clear history");
  await page.reload();
  await page.locator("#history-button").click();
  await expect(page.locator("#history-table")).toContainText("No runs saved yet");
  expect(errors).toEqual([]);
});
