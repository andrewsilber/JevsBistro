/** Interpret provider codes before deciding whether another request can help. */
export function providerError(status: number, error: { code?: string; type?: string } = {}, headers: Headers) {
  const code = error.code ?? "", type = error.type ?? "";
  const billing = /quota|billing|spend_limit|usage_limit|credit_balance/.test(code) || type === "insufficient_quota";
  const retryable = !billing && status === 429 && (code === "rate_limit_exceeded" || code === "slow_down" || type === "rate_limit_error");
  const messages: Record<string, string> = {
    insufficient_quota: "OpenAI reports insufficient quota for this API key's project or organization. Check its billing and limits; this is not a temporary rate limit.",
    project_spend_limit_exceeded: "This OpenAI project's spending limit was reached, even if the account has remaining credits.",
    organization_usage_limit_exceeded: "This OpenAI organization reached its usage limit. Check the organization associated with this API key.",
  };
  const defaults: Record<number, string> = { 401: "OpenAI rejected the API key.", 403: "This API key cannot access the selected model.", 404: "The selected model is unavailable for this account." };
  const message = messages[code] ?? (retryable ? "OpenAI temporarily throttled requests or tokens. Remaining credits do not remove rate limits." : billing ? "OpenAI reports a billing or quota restriction for this API key. Check the project's billing and limits." : status === 429 ? "OpenAI returned HTTP 429 without a recognized retryable code. Inspect LLM activity for the provider's exact error." : defaults[status] ?? `OpenAI request failed (HTTP ${status}). Check LLM activity for details.`);
  const rateLimits = Object.fromEntries(["retry-after", "x-ratelimit-limit-requests", "x-ratelimit-limit-tokens", "x-ratelimit-remaining-requests", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"].flatMap((key) => headers.has(key) ? [[key, headers.get(key)!]] : []));
  return { message, retryable, retryAfterMs: retryable ? retryDelay(headers) : undefined, rateLimits };
}
export function retryDelay(headers: Headers, now = Date.now()): number | undefined {
  const after = headers.get("retry-after");
  if (after !== null) {
    const ms = /^\d+(\.\d+)?$/.test(after.trim()) ? Number(after) * 1000 : Date.parse(after) - now;
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }
  const resets = ["requests", "tokens"].map((kind) => {
    const text = headers.get(`x-ratelimit-reset-${kind}`) ?? "";
    if (!/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/.test(text)) return 0;
    return [...text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)].reduce((sum, m) => sum + Number(m[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2]]!), 0);
  });
  return Math.max(...resets) || undefined;
}
