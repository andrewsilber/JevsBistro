import type { DecisionContext } from "../sim/types";
import type { PlanResponse, ProxySettings, ProxyUsage, Provider } from "./protocol";
import { addUsage } from "./protocol";
import type { ActivitySink, LlmInteraction } from "./activity";

export class LocalApiError extends Error {
  constructor(message: string, readonly diagnostics?: unknown) { super(message); }
}

export async function localApi(path: string, body?: unknown, signal?: AbortSignal, provider: Provider = "openai") {
  const response = await fetch(`/api/${provider === "jev" ? "jev" : "llm"}/${path}`, {
    method: body === undefined ? "GET" : "POST", credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal,
  });
  let data;
  try { data = await response.json(); } catch { throw Error("The local API returned an unreadable response. Check that the app server is running."); }
  if (!response.ok) throw new LocalApiError(data.error ?? "Local API unavailable.", data.diagnostics);
  return data;
}
function cooldown(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(Error("Request cancelled.")); return; }
    const cancel = () => { clearTimeout(timer); reject(Error("Request cancelled.")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, ms);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}
export async function requestPlan(context: DecisionContext, settings: ProxySettings, usage: ProxyUsage, signal?: AbortSignal, monitor?: { scope: string; emit: ActivitySink }): Promise<PlanResponse> {
  const entry: LlmInteraction = { id: globalThis.crypto.randomUUID(), scope: monitor?.scope ?? "Live service", model: settings.model, provider: settings.provider, startedAt: Date.now(), status: "waiting", context: structuredClone(context), retries: [] };
  const emit = () => monitor?.emit(structuredClone(entry));
  try {
    for (let attempt = 1; attempt <= 4; attempt++) {
      if (signal?.aborted) throw Error("Request cancelled.");
      if (usage.calls >= settings.maxCalls) throw Error(`The ${settings.maxCalls}-call limit was reached. No request sent. Export this partial run or reset with a higher limit.`);
      entry.attempt = attempt; entry.status = "waiting"; entry.retryAt = undefined; entry.error = undefined;
      usage.calls++; emit();
      const abort = new AbortController();
      const cancel = () => abort.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) abort.abort();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; abort.abort(); }, 65000);
      let retryMs: number | undefined;
      try {
        const result = await localApi("plan", { context, model: settings.model }, abort.signal, settings.provider) as PlanResponse;
        addUsage(usage, result);
        entry.status = "received"; entry.response = result; entry.endedAt = Date.now(); emit();
        return result;
      } catch (error) {
        usage.failures++;
        const diagnostics = error instanceof LocalApiError ? error.diagnostics as { retryable?: boolean; retryAfterMs?: number } | undefined : undefined;
        entry.diagnostics = diagnostics;
        if (timedOut) throw Error("No response within 65 seconds. Restaurant remains paused. Check the local server or retry with Resume.");
        if (signal?.aborted || !diagnostics?.retryable) throw error;
        if (attempt >= 4) throw Error(`${(error as Error).message} Stopped after four attempts. Resume later to retry.`);
        if (usage.calls >= settings.maxCalls) throw Error(`${(error as Error).message} The ${settings.maxCalls}-call limit has also been reached; no automatic retry was sent.`);
        const advised = diagnostics.retryAfterMs;
        retryMs = Math.max(2000 * 2 ** (attempt - 1), typeof advised === "number" && Number.isFinite(advised) ? advised : 0) + 250 + Math.random() * 500;
        if (retryMs > 120000) throw Error(`The inference provider requested a wait longer than two minutes. No early retry will be sent. See LLM activity for reset details and resume later.`);
        entry.status = "cooldown"; entry.error = (error as Error).message;
        entry.retryAt = Date.now() + retryMs;
        entry.retries!.push({ at: Date.now(), error: entry.error, diagnostics }); emit();
      } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
      // Real-time wait outside inference deadline; the caller still holds simulation time.
      await cooldown(retryMs!, signal);
    }
    throw Error("Retry limit reached. Resume later to try again.");
  } catch (error) {
    entry.status = signal?.aborted ? "cancelled" : "error";
    entry.error = signal?.aborted ? "Request cancelled. Restaurant time did not advance." : (error as Error).message;
    entry.endedAt = Date.now(); entry.retryAt = undefined; emit();
    throw Error(entry.error);
  }
}
