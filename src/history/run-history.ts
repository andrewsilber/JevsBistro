import type { Config, Metrics } from "../sim/types";
import type { ProxyUsage } from "../llm/protocol";
import { copyConfig } from "../sim/scenario";

export const HISTORY_KEY = "jevsbistro-run-history-v1";
/** Oldest rows are dropped past this count so browser storage is not exhausted. */
export const HISTORY_LIMIT = 400;
export type RunController = "rules" | "jev" | "openai";

/** Service report figures, reduced to the means and counts the report itself shows. Raw wait arrays stay in JSON exports. */
export interface RunResults {
  completed: number; arrived: number; seated: number; turnedAway: number; revenue: number;
  dishes: number; cocktails: number;
  seatingWait: number | null; greetingWait: number | null; orderWait: number | null;
  foodWait: number | null; foodP90: number | null; paymentWait: number | null;
  drinkOrderWait: number | null; drinkWait: number | null;
  emptyGlassPercent: number; requestsRaised: number; requestConversations: number;
  requestResponse: number | null; requestResolution: number | null;
  walking: number; walkingPerGuest: number | null;
  decisions: number; multiStopPlans: number; staleStops: number; observationAge: number | null;
  aiCalls: number; inputTokens: number; outputTokens: number; estimatedUsd: number; unknownPriceCalls: number; inferenceSeconds: number;
}
export interface RunRecord {
  id: string;
  savedAt: string;
  controller: RunController;
  model?: string;
  finished: boolean;
  simulatedSeconds: number;
  config: Config;
  results: RunResults;
}
export interface RunSummaryInput {
  id?: string; savedAt?: string;
  config: Config; metrics: Metrics; simulatedSeconds: number; finished: boolean;
  controller: RunController; model?: string; usage?: ProxyUsage;
}

const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const percentile = (values: number[], p: number) =>
  values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.max(0, Math.ceil(p * values.length) - 1))] : null;

/** Build a history row from a run's configuration, metrics and adapter usage. No simulation object is retained. */
export function summarizeRun(input: RunSummaryInput): RunRecord {
  const m = input.metrics, usage = input.usage;
  return {
    id: input.id ?? crypto.randomUUID(),
    savedAt: input.savedAt ?? new Date().toISOString(),
    controller: input.controller,
    model: input.controller === "rules" ? undefined : input.model,
    finished: input.finished,
    simulatedSeconds: input.simulatedSeconds,
    config: copyConfig(input.config),
    results: {
      completed: m.completed, arrived: m.arrived, seated: m.seated, turnedAway: m.turnedAway, revenue: m.revenue,
      dishes: m.foodWaits.length, cocktails: m.cocktailsServed,
      seatingWait: mean(m.seatingWaits), greetingWait: mean(m.greetingWaits), orderWait: mean(m.orderWaits),
      foodWait: mean(m.foodWaits), foodP90: percentile(m.foodWaits, 0.9), paymentWait: mean(m.paymentWaits),
      drinkOrderWait: mean(m.drinkOrderWaits), drinkWait: mean(m.drinkWaits),
      emptyGlassPercent: m.occupiedDinerSeconds ? (100 * m.emptyGlassSeconds) / m.occupiedDinerSeconds : 0,
      requestsRaised: m.requestsRaised, requestConversations: m.interruptions,
      requestResponse: mean(m.requestResponseWaits), requestResolution: mean(m.requestResolutionWaits),
      walking: m.walking, walkingPerGuest: m.completed ? m.walking / m.completed : null,
      decisions: m.decisions, multiStopPlans: m.multiStopPlans, staleStops: m.staleStops, observationAge: mean(m.observationAges),
      aiCalls: usage?.calls ?? 0, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0,
      estimatedUsd: usage?.estimatedUsd ?? 0, unknownPriceCalls: usage?.unknownPriceCalls ?? 0, inferenceSeconds: (usage?.wallMs ?? 0) / 1000,
    },
  };
}

export type ColumnGroup = "run" | "setup" | "results";
export type ColumnKind = "text" | "count" | "decimal" | "seconds" | "minutes" | "percent" | "money" | "cost" | "meters" | "flag" | "date";
export type CellValue = string | number | boolean | null;
export interface HistoryColumn { key: string; group: ColumnGroup; label: string; kind: ColumnKind; value: (record: RunRecord) => CellValue }

const controllerLabel = (r: RunRecord) => r.controller === "rules" ? "Rules" : r.controller === "jev" ? "Real Jev" : "OpenAI proxy";
const setup = (key: keyof Config, label: string, kind: ColumnKind, value?: (r: RunRecord) => CellValue): HistoryColumn =>
  ({ key, group: "setup", label, kind, value: value ?? ((r) => r.config[key] as CellValue) });
const result = (key: keyof RunResults, label: string, kind: ColumnKind): HistoryColumn =>
  ({ key, group: "results", label, kind, value: (r) => r.results[key] ?? null });

/** Column order for the history table and CSV export. Setup keys match Config field names. */
export const HISTORY_COLUMNS: HistoryColumn[] = [
  { key: "name", group: "run", label: "Restaurant", kind: "text", value: (r) => r.config.name },
  { key: "savedAt", group: "run", label: "Saved", kind: "date", value: (r) => r.savedAt },
  { key: "seed", group: "run", label: "Seed", kind: "count", value: (r) => r.config.seed },
  { key: "controller", group: "run", label: "Controller", kind: "text", value: (r) => r.model ? `${controllerLabel(r)} · ${r.model}` : controllerLabel(r) },
  { key: "status", group: "run", label: "Status", kind: "text", value: (r) => r.finished ? "Complete" : "Partial" },
  { key: "simulatedSeconds", group: "run", label: "Service time", kind: "seconds", value: (r) => r.simulatedSeconds },
  setup("mode", "Observation", "text", (r) => r.config.mode === "camera" ? "Camera" : "Local scans"),
  setup("planner", "Planner", "text", (r) => r.config.planner === "route" ? "Multi-stop" : "Next task"),
  setup("layoutStyle", "Floor plan", "text"),
  setup("stationPlacement", "Stations", "text"),
  setup("aisleWidth", "Aisle", "meters"),
  setup("tables", "Tables", "count"),
  setup("rooms", "Rooms", "count"),
  setup("servers", "Servers", "count"),
  setup("seats", "Seats / table", "count"),
  setup("arrivals", "Parties / h", "count"),
  setup("duration", "Arrival window", "minutes"),
  setup("snapshotSeconds", "Camera interval", "seconds"),
  setup("observationSeconds", "Scan interval", "seconds"),
  setup("memorySeconds", "Recheck after", "seconds"),
  setup("bartenders", "Bartenders", "count"),
  setup("cocktailRate", "Cocktail %", "percent"),
  setup("appetizerRate", "Appetizer %", "percent"),
  setup("dessertRate", "Dessert %", "percent"),
  setup("phoneRate", "Phone %", "percent"),
  setup("bathroomRate", "Restroom %", "percent"),
  setup("lingerRate", "Linger %", "percent"),
  setup("interruptions", "Extra requests", "flag"),
  setup("requestRate", "Request chance", "percent", (r) => r.config.requestRate ?? 20),
  setup("voiceHints", "Voice hints", "flag"),
  setup("menu", "Dishes on menu", "count", (r) => r.config.menu.length),
  result("completed", "Guests paid", "count"),
  result("arrived", "Guests arrived", "count"),
  result("seated", "Guests seated", "count"),
  result("turnedAway", "Left queue", "count"),
  result("revenue", "Revenue", "money"),
  result("dishes", "Dishes served", "count"),
  result("cocktails", "Cocktails served", "count"),
  result("seatingWait", "Seating wait", "seconds"),
  result("greetingWait", "Greeting wait", "seconds"),
  result("orderWait", "Order wait", "seconds"),
  result("foodWait", "Ready-to-table", "seconds"),
  result("foodP90", "Ready-to-table p90", "seconds"),
  result("paymentWait", "Payment wait", "seconds"),
  result("drinkOrderWait", "Cocktail order-to-table", "seconds"),
  result("drinkWait", "Bar ready-to-table", "seconds"),
  result("emptyGlassPercent", "Empty-glass time", "percent"),
  result("requestsRaised", "Requests raised", "count"),
  result("requestConversations", "Request conversations", "count"),
  result("requestResponse", "Request response", "seconds"),
  result("requestResolution", "Request resolution", "seconds"),
  result("walking", "Distance walked", "meters"),
  result("walkingPerGuest", "Walk / paid guest", "meters"),
  result("decisions", "Decisions", "count"),
  result("multiStopPlans", "Multi-stop plans", "count"),
  result("staleStops", "Reconsidered stops", "count"),
  result("observationAge", "Evidence age at dispatch", "seconds"),
  result("aiCalls", "AI calls", "count"),
  result("inputTokens", "Input tokens", "count"),
  result("outputTokens", "Output tokens", "count"),
  result("estimatedUsd", "Est. API cost", "cost"),
  result("unknownPriceCalls", "Unpriced calls", "count"),
  result("inferenceSeconds", "Real inference time", "seconds"),
];

export const formatSeconds = (n: number) => n < 60 ? `${Math.round(n)}s` : `${Math.floor(n / 60)}m ${Math.round(n % 60)}s`;

export function formatCell(column: HistoryColumn, value: CellValue): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  switch (column.kind) {
    case "date": return new Date(String(value)).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    case "seconds": return formatSeconds(n);
    case "minutes": return `${n} min`;
    case "percent": return `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
    case "money": return `$${n.toFixed(2)}`;
    case "cost": return `$${n.toFixed(4)}`;
    case "meters": return `${n >= 100 || Number.isInteger(n) ? Math.round(n) : n.toFixed(1)} m`;
    case "decimal": return n.toFixed(1);
    case "flag": return value ? "Yes" : "No";
    default: return String(value);
  }
}

/** Stable sort; empty values always sort last regardless of direction. */
export function sortRecords(records: RunRecord[], key: string, descending: boolean): RunRecord[] {
  const column = HISTORY_COLUMNS.find((c) => c.key === key);
  if (!column) return [...records];
  const rank = (v: CellValue) => typeof v === "boolean" ? Number(v) : v;
  return records.map((record, index) => ({ record, index, value: rank(column.value(record)) }))
    .sort((a, b) => {
      if (a.value === null && b.value === null) return a.index - b.index;
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      const order = typeof a.value === "number" && typeof b.value === "number" ? a.value - b.value : String(a.value).localeCompare(String(b.value));
      return (descending ? -order : order) || a.index - b.index;
    })
    .map((item) => item.record);
}

/** Raw values, not display strings, so spreadsheets keep numbers numeric. */
export function historyCsv(records: RunRecord[], columns: HistoryColumn[] = HISTORY_COLUMNS): string {
  const cell = (value: CellValue) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [columns.map((c) => cell(c.label)).join(","), ...records.map((r) => columns.map((c) => cell(c.value(r))).join(","))].join("\r\n");
}

export interface HistoryStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

/** Newest-first run history in browser storage. Configuration and summarized metrics only; never credentials. */
export class RunHistoryStore {
  constructor(private readonly storage: () => HistoryStorage, private readonly limit = HISTORY_LIMIT) {}
  list(): RunRecord[] {
    const text = this.storage().getItem(HISTORY_KEY);
    if (!text) return [];
    const saved = JSON.parse(text);
    if (saved?.version !== 1 || !Array.isArray(saved.runs)) throw Error("Run history has an unsupported format. Clear history to start again.");
    return saved.runs.map((run: RunRecord) => {
      if (typeof run?.id !== "string" || typeof run.savedAt !== "string" || !run.results || typeof run.results !== "object") throw Error("A saved run is invalid. Clear history to start again.");
      return { ...run, config: copyConfig(run.config) };
    });
  }
  /** Insert or replace by id, moving the row to the top. */
  save(record: RunRecord) {
    const runs = this.list().filter((r) => r.id !== record.id);
    runs.unshift(record);
    this.write(runs.slice(0, this.limit));
  }
  remove(id: string) { this.write(this.list().filter((r) => r.id !== id)); }
  clear() { this.storage().removeItem(HISTORY_KEY); }
  private write(runs: RunRecord[]) {
    try { this.storage().setItem(HISTORY_KEY, JSON.stringify({ version: 1, runs })); }
    catch { throw Error("Browser storage is unavailable or full. The run was not saved to history."); }
  }
}
