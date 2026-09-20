import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulation } from "../src/sim/engine";
import { DEFAULT_CONFIG } from "../src/sim/scenario";
import { HISTORY_COLUMNS, HISTORY_KEY, RunHistoryStore, formatCell, historyCsv, sortRecords, summarizeRun, type HistoryStorage, type RunRecord } from "../src/history/run-history";

function memoryStorage(): HistoryStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: (k) => { data.delete(k); } };
}
function finishedRun() {
  const sim = new Simulation({ ...DEFAULT_CONFIG, tables: 3, servers: 1, arrivals: 12, duration: 5, seed: 11 });
  for (let i = 0; i < 4 * 3600 * 4 && !sim.finished; i++) sim.step();
  assert.ok(sim.finished, "short service finishes");
  return sim;
}

test("a completed run is summarized with its full setup and the service report figures", () => {
  const sim = finishedRun();
  const record = summarizeRun({ config: sim.config, metrics: sim.metrics, simulatedSeconds: sim.now, finished: sim.finished, controller: "rules", model: "ignored-for-rules" });
  assert.equal(record.finished, true);
  assert.equal(record.model, undefined, "rules runs record no model");
  assert.equal(record.results.completed, sim.metrics.completed);
  assert.ok(record.results.completed > 0);
  assert.equal(record.results.dishes, sim.metrics.foodWaits.length);
  assert.ok(record.results.greetingWait! > 0);
  assert.ok(record.results.foodP90! >= record.results.foodWait!, "p90 is at least the mean");
  assert.deepEqual(record.config.menu, sim.config.menu);
  assert.equal(record.results.aiCalls, 0);
  const ai = summarizeRun({ config: sim.config, metrics: sim.metrics, simulatedSeconds: sim.now, finished: true, controller: "jev", model: "jev-1.13.0",
    usage: { calls: 7, inputTokens: 700, outputTokens: 70, cachedTokens: 0, wallMs: 4200, failures: 0, estimatedUsd: 0.0003 } });
  assert.equal(ai.model, "jev-1.13.0");
  assert.equal(ai.promptVersion, undefined);
  const promptColumn = HISTORY_COLUMNS.find((c) => c.key === "promptVersion")!;
  assert.equal(promptColumn.value(ai), "tours-v1", "older AI rows without a recorded prompt are labelled as the original wording");
  assert.equal(promptColumn.value(record), null);
  assert.equal(promptColumn.value({ ...ai, promptVersion: "tours-v2" }), "tours-v2");
  assert.equal(ai.results.aiCalls, 7);
  assert.equal(ai.results.inferenceSeconds, 4.2);
  // Every configuration field except the raw menu appears as a setup column, so new settings cannot silently vanish from comparisons.
  const keys = new Set(HISTORY_COLUMNS.map((c) => c.key));
  for (const key of Object.keys(DEFAULT_CONFIG)) assert.ok(keys.has(key), `column for ${key}`);
  for (const key of Object.keys(record.results)) assert.ok(keys.has(key), `column for result ${key}`);
});

test("empty samples show as dashes and formats stay readable", () => {
  const sim = new Simulation({ ...DEFAULT_CONFIG, tables: 2 });
  const record = summarizeRun({ config: sim.config, metrics: sim.metrics, simulatedSeconds: 0, finished: false, controller: "openai", model: "gpt-5.4-nano" });
  assert.equal(record.results.greetingWait, null);
  assert.equal(record.results.walkingPerGuest, null);
  const column = (key: string) => HISTORY_COLUMNS.find((c) => c.key === key)!;
  assert.equal(formatCell(column("greetingWait"), record.results.greetingWait), "—");
  assert.equal(formatCell(column("simulatedSeconds"), 95), "1m 35s");
  assert.equal(formatCell(column("cocktailRate"), 35), "35%");
  assert.equal(formatCell(column("emptyGlassPercent"), 12.345), "12.3%");
  assert.equal(formatCell(column("estimatedUsd"), 0.00042), "$0.0004");
  assert.equal(formatCell(column("interruptions"), true), "Yes");
  assert.equal(column("controller").value(record), "OpenAI proxy · gpt-5.4-nano");
  assert.equal(column("status").value(record), "Partial");
});

test("history store upserts newest first, deletes rows, clears, caps size and rejects corrupt data", () => {
  const storage = memoryStorage(), store = new RunHistoryStore(() => storage, 3);
  const sim = finishedRun();
  const make = (seed: number, id?: string) => summarizeRun({ id, savedAt: `2026-09-20T10:00:0${seed}.000Z`, config: { ...sim.config, seed }, metrics: sim.metrics, simulatedSeconds: sim.now, finished: true, controller: "rules" });
  assert.deepEqual(store.list(), []);
  const first = make(1); store.save(first); store.save(make(2));
  assert.deepEqual(store.list().map((r) => r.config.seed), [2, 1]);
  store.save({ ...make(1, first.id), finished: false });
  assert.deepEqual(store.list().map((r) => [r.config.seed, r.finished]), [[1, false], [2, true]], "re-saving the same run replaces it and moves it up");
  store.save(make(3)); store.save(make(4));
  assert.deepEqual(store.list().map((r) => r.config.seed), [4, 3, 1], "oldest rows drop past the limit");
  store.remove(store.list()[1].id);
  assert.deepEqual(store.list().map((r) => r.config.seed), [4, 1]);
  assert.ok(!JSON.stringify(store.list()).includes("sk-"), "nothing credential-like is stored");
  store.clear();
  assert.deepEqual(store.list(), []);
  assert.equal(storage.getItem(HISTORY_KEY), null);
  storage.setItem(HISTORY_KEY, JSON.stringify({ version: 9, runs: [] }));
  assert.throws(() => store.list(), /unsupported format/);
  storage.setItem(HISTORY_KEY, JSON.stringify({ version: 1, runs: [{ id: 1 }] }));
  assert.throws(() => store.list(), /invalid/);
  store.clear();
  const failing = new RunHistoryStore(() => ({ ...storage, setItem: () => { throw new DOMException("Full", "QuotaExceededError"); } }));
  assert.throws(() => failing.save(make(5)), /not saved to history/);
});

test("sorting keeps empty values last in both directions and CSV exports raw values", () => {
  const sim = finishedRun();
  const base = summarizeRun({ config: sim.config, metrics: sim.metrics, simulatedSeconds: sim.now, finished: true, controller: "rules" });
  const records: RunRecord[] = [
    { ...base, id: "a", config: { ...base.config, name: "Bravo, \"quoted\"" }, results: { ...base.results, greetingWait: 30 } },
    { ...base, id: "b", config: { ...base.config, name: "Alpha" }, results: { ...base.results, greetingWait: null } },
    { ...base, id: "c", config: { ...base.config, name: "Charlie" }, results: { ...base.results, greetingWait: 10 } },
  ];
  assert.deepEqual(sortRecords(records, "greetingWait", false).map((r) => r.id), ["c", "a", "b"]);
  assert.deepEqual(sortRecords(records, "greetingWait", true).map((r) => r.id), ["a", "c", "b"]);
  assert.deepEqual(sortRecords(records, "name", false).map((r) => r.id), ["b", "a", "c"]);
  assert.deepEqual(sortRecords(records, "unknown", true).map((r) => r.id), ["a", "b", "c"]);
  const csv = historyCsv(records).split("\r\n");
  assert.equal(csv.length, 4);
  assert.equal(csv[0].split(",").length, HISTORY_COLUMNS.length);
  assert.ok(csv[0].startsWith("Restaurant,Saved,Seed,Controller,Prompt,Status"));
  assert.ok(csv[1].startsWith('"Bravo, ""quoted""",'), "commas and quotes are escaped");
  assert.ok(csv[2].includes(",Rules,,Complete,"), "raw values not display strings; rules rows have no prompt version");
  assert.ok(!csv[2].includes("—"), "empty values export as blanks");
});
