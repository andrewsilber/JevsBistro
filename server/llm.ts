import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { MODELS, responseBody } from "../src/llm/protocol";
import type { DecisionContext } from "../src/sim/types";
import { jevRequest, readJevAnswer } from "../src/jev/protocol";
import { providerError } from "./provider-error";

/** Per-browser credentials, memory only. Never logged or sent back to the client. */
export function createLlmMiddleware(providerFetch: typeof fetch = fetch, provider: "openai" | "jev" = "openai") {
  const prefix = provider === "jev" ? "/api/jev" : "/api/llm";
  const cookieName = provider === "jev" ? "jb_jev_session" : "jb_session";
  const label = provider === "jev" ? "Jev" : "OpenAI";
  const sessions = new Map<string, { key: string; expires: number }>();
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith(`${prefix}/`)) return next();
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(data));
    };
    const host = req.headers.host ?? "";
    if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host) || (req.headers.origin && req.headers.origin !== `http://${host}`))
      return send(403, { error: "This API accepts same-origin local requests only." });
    for (const [id, session] of sessions) if (session.expires < Date.now()) sessions.delete(id);
    const id = req.headers.cookie?.match(new RegExp(`(?:^|; )${cookieName}=([a-f0-9]+)`))?.[1];
    const session = id ? sessions.get(id) : undefined;
    if (req.url === `${prefix}/status` && req.method === "GET") return send(200, { configured: !!session });
    if (req.method !== "POST" || req.headers["content-type"] !== "application/json") return send(400, { error: "Expected a JSON POST request." });
    try {
      let raw = "";
      for await (const chunk of req) { raw += chunk; if (raw.length > 250000) return send(413, { error: "Request too large." }); }
      const data = JSON.parse(raw);
      if (req.url === `${prefix}/key`) {
        if (typeof data.key !== "string" || !(provider === "jev" ? /^[\x21-\x7e]{8,4096}$/.test(data.key.trim()) : /^sk-[\w-]{10,}$/.test(data.key.trim()))) return send(400, { error: provider === "jev" ? "Enter your TypeSafe API key." : "Enter an OpenAI API key beginning with sk-." });
        const token = id && session ? id : randomBytes(32).toString("hex");
        sessions.set(token, { key: data.key.trim(), expires: Date.now() + 24 * 60 * 60 * 1000 });
        res.setHeader("Set-Cookie", `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=${prefix}; Max-Age=86400`);
        return send(200, { configured: true });
      }
      if (req.url === `${prefix}/forget`) {
        if (id) sessions.delete(id);
        res.setHeader("Set-Cookie", `${cookieName}=; HttpOnly; SameSite=Strict; Path=${prefix}; Max-Age=0`);
        return send(200, { configured: false });
      }
      if (req.url !== `${prefix}/plan` && !(provider === "jev" && req.url === `${prefix}/models`)) return send(404, { error: "Unknown endpoint." });
      if (!session) return send(401, { error: `Add your ${label} API key in AI settings first. Keys expire after 24 hours or a server restart.` });
      const modelsOnly = provider === "jev" && req.url === `${prefix}/models`;
      if (!modelsOnly && !(provider === "jev" ? typeof data.model === "string" && /^jev-[\w.-]{1,80}$/.test(data.model) : MODELS.includes(data.model))) return send(400, { error: "Unsupported model selection." });
      const context = data.context as DecisionContext;
      if (!modelsOnly && (!context || !Array.isArray(context.candidates) || !context.candidates.length || context.candidates.length > 100 || !context.server || !Array.isArray(context.observations)))
        return send(400, { error: "Invalid decision context." });
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 60000);
      const disconnect = () => { if (!res.writableEnded) abort.abort(); };
      res.on("close", disconnect);
      const started = performance.now();
      try {
        const response = await providerFetch(provider === "jev" ? `https://api.typesafe.ai/v1/${modelsOnly ? "models" : "systemone"}` : "https://api.openai.com/v1/responses", {
          method: modelsOnly ? "GET" : "POST", headers: { Authorization: `Bearer ${session.key}`, "Content-Type": "application/json" },
          body: modelsOnly ? undefined : JSON.stringify(provider === "jev" ? jevRequest(context, data.model) : responseBody(context, data.model)), signal: abort.signal,
        });
        const requestId = response.headers.get("x-request-id");
        const redact = (value: unknown) => typeof value === "string" ? value.replaceAll(session.key, "[redacted]").replaceAll(JSON.stringify(session.key).slice(1, -1), "[redacted]").replace(/sk-[\w-]+/g, "[redacted]").slice(0, 12000) : undefined;
        if (!response.ok) {
          const detail = await response.json().catch(() => ({})) as any;
          if (provider === "jev") {
            const retryAfter = Number(response.headers.get("retry-after"));
            const retryDate = Date.parse(response.headers.get("retry-after") ?? "");
            return send(502, { error: `Jev ${response.status === 401 ? "rejected the API key" : response.status === 429 ? "rate limit reached" : response.status === 529 ? "is temporarily overloaded" : "request failed"} (HTTP ${response.status}).`, diagnostics: {
              requestId, httpStatus: response.status, message: redact(JSON.stringify(detail)), retryable: [429, 529].includes(response.status),
              retryAfterMs: Number.isFinite(retryAfter) ? Math.max(0, retryAfter * 1000) : Number.isFinite(retryDate) ? Math.max(0, retryDate - Date.now()) : undefined } });
          }
          const classified = providerError(response.status, detail.error, response.headers);
          return send(502, { error: classified.message, diagnostics: { requestId, httpStatus: response.status, code: redact(detail.error?.code), type: redact(detail.error?.type), message: redact(detail.error?.message), retryable: classified.retryable, retryAfterMs: classified.retryAfterMs, rateLimits: classified.rateLimits } });
        }
        const result = await response.json() as any;
        if (provider === "jev") {
          if (modelsOnly) {
            if (!Array.isArray(result.models)) return send(502, { error: "Jev returned an invalid model list." });
            return send(200, { models: result.models.filter((m: any) => typeof m.name === "string" && /^jev-[\w.-]{1,80}$/.test(m.name)).map((m: any) => ({ name: m.name })) });
          }
          try {
            const parsed = readJevAnswer(context, result);
            return send(200, { ...parsed, wallMs: performance.now() - started, diagnostics: { ...parsed.diagnostics, requestId, request: jevRequest(context, data.model) } });
          } catch (error) { return send(502, { error: (error as Error).message, diagnostics: { requestId, response: redact(JSON.stringify(result)) } }); }
        }
        const output = result.output?.flatMap((item: any) => item.content ?? []).filter((item: any) => item.type === "output_text").map((item: any) => item.text).join("");
        const diagnostics = { requestId, responseId: result.id, status: result.status, incompleteReason: result.incomplete_details?.reason, outputText: redact(output),
          refusals: result.output?.flatMap((item: any) => item.content ?? []).filter((item: any) => item.type === "refusal").map((item: any) => redact(item.refusal)), usage: result.usage };
        if (result.status !== "completed") return send(502, { error: "OpenAI did not complete the itinerary. See LLM activity for details; try a different model or retry.", diagnostics });
        let ids: unknown;
        try { ids = JSON.parse(output).ids; } catch { return send(502, { error: "OpenAI returned no usable itinerary (possibly a refusal).", diagnostics }); }
        if (!Array.isArray(ids) || ids.length < 1 || ids.length > 3 || new Set(ids).size !== ids.length || ids.some((id) => !context.candidates.some((c) => c.id === id)))
          return send(502, { error: "OpenAI returned an invalid itinerary. The restaurant remains paused.", diagnostics });
        return send(200, { ids, model: data.model, inputTokens: result.usage?.input_tokens ?? 0, outputTokens: result.usage?.output_tokens ?? 0,
          cachedTokens: result.usage?.input_tokens_details?.cached_tokens ?? 0, wallMs: performance.now() - started, diagnostics });
      } finally { clearTimeout(timer); res.off("close", disconnect); }
    } catch { if (!res.writableEnded && !res.destroyed) send(502, { error: "Inference failed or timed out. The restaurant remains paused; retry or reset." }); }
  };
}
