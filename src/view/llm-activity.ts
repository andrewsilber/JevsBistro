import { LlmActivity, type LlmInteraction } from "../llm/activity";
import { inferenceBody, inferenceInstructions, inferenceState } from "../llm/protocol";
import { payloadSizes } from "../llm/compact-state";

const time = (s: number) => `${Math.floor(s / 60)}m ${(s % 60).toFixed(2)}s`;
export class LlmActivityPanel {
  private selected?: string;
  private revision = -1;
  private rendered = "";
  constructor(readonly dialog: HTMLDialogElement, readonly activity: LlmActivity) {
    dialog.innerHTML = `<div class="modal-head"><h2>LLM activity</h2><button class="close-dialog" aria-label="Close LLM activity">×</button></div><div class="modal-body">
      <p>Watch real Jev and OpenAI requests. Restaurant time holds while the model responds; elapsed time below is real time. Opening this monitor does not pause or resume a run.</p>
      <div class="comparison-controls"><label class="switch-row"><input id="llm-follow" type="checkbox" checked> Follow latest</label><button id="llm-export" class="btn ghost">Export interactions</button><span id="llm-count"></span></div>
      <div class="llm-layout"><nav id="llm-list" aria-label="LLM requests"></nav><section id="llm-detail"><h3 id="llm-title">No LLM requests yet</h3>
      <p id="llm-summary" role="status">Start an AI service or comparison. Steps with only one feasible action do not call the LLM.</p>
      <p id="llm-timing"></p><p id="llm-outcome"></p><p id="llm-payload"></p>
      <details open><summary>Returned itinerary &amp; response</summary><pre id="llm-response">No response yet.</pre></details>
      <details><summary>Instructions sent to the model</summary><pre id="llm-instructions"></pre></details>
      <details><summary>Restaurant observations &amp; feasible actions</summary><pre id="llm-context"></pre></details>
      <details><summary>Full request body (no authentication headers)</summary><pre id="llm-request"></pre></details>
      </section></div><p class="form-help">Latest 200 interactions, retained across resets until this page reloads. Export before reloading to keep them. Only prompts, model output, and diagnostics are shown; internal model reasoning is not exposed.</p></div>`;
    this.el<HTMLButtonElement>("llm-export").onclick = () => {
      const entries = activity.entries.map((entry) => ({ ...entry, request: inferenceBody(entry.context, entry.model, entry.provider) }));
      const url = URL.createObjectURL(new Blob([JSON.stringify({ entries, omittedOlderInteractions: activity.dropped }, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = "jevsbistro-llm-interactions.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    this.el<HTMLInputElement>("llm-follow").onchange = () => { this.revision = -1; this.update(); };
    dialog.querySelector<HTMLButtonElement>(".close-dialog")!.onclick = () => dialog.close();
  }
  private el<T extends HTMLElement = HTMLElement>(id: string) { return this.dialog.querySelector<T>(`#${id}`)!; }
  open() { if (!this.dialog.open) this.dialog.showModal(); this.revision = -1; this.update(); }
  update() {
    if (!this.dialog.open) return;
    const entries = this.activity.entries;
    if (this.revision !== this.activity.revision) {
      if (this.el<HTMLInputElement>("llm-follow").checked || !entries.some((e) => e.id === this.selected)) this.selected = entries.at(-1)?.id;
      this.el("llm-count").textContent = `${entries.length} retained · ${entries.filter((e) => ["waiting", "cooldown"].includes(e.status)).length} pending${this.activity.dropped ? ` · ${this.activity.dropped} older omitted` : ""}`;
      const list = this.el("llm-list");
      list.replaceChildren(...[...entries].reverse().map((entry) => {
        const button = document.createElement("button"); button.type = "button";
        button.className = `llm-item ${entry.status}`; button.setAttribute("aria-pressed", String(entry.id === this.selected));
        button.textContent = `${entry.status.toUpperCase()} · Server ${entry.context.server.id}\n${entry.scope}\n${time(entry.context.now)} · ${entry.model}`;
        button.onclick = () => { this.selected = entry.id; this.el<HTMLInputElement>("llm-follow").checked = false; this.revision = -1; this.update(); };
        return button;
      }));
      this.revision = this.activity.revision;
    }
    const entry = entries.find((e) => e.id === this.selected);
    if (!entry) return;
    const version = `${entry.id}:${entry.status}:${entry.attempt}`;
    if (version !== this.rendered) { this.rendered = version; this.show(entry); }
    const elapsed = ((entry.endedAt ?? Date.now()) - entry.startedAt) / 1000;
    this.el("llm-timing").textContent = `Real elapsed: ${elapsed.toFixed(1)}s · Simulation at request: ${time(entry.context.now)} · Attempt ${entry.attempt ?? 1}/4${entry.status === "cooldown" ? ` · Auto-retry in ${Math.max(0, ((entry.retryAt ?? Date.now()) - Date.now()) / 1000).toFixed(1)}s · Clock held` : entry.status === "waiting" ? " · Clock held · 65s deadline per attempt" : ""}`;
  }
  private show(entry: LlmInteraction) {
    const request = inferenceBody(entry.context, entry.model, entry.provider);
    const sizes = payloadSizes(entry.context);
    this.el("llm-payload").textContent = entry.provider === "jev" ? `Jev typed Choice  -  ${JSON.stringify(request).length.toLocaleString()} request characters. Named observed tasks and feasible tours; no generated text. Actual billed tokens are returned by TypeSafe.` : `${sizes.format}: ${sizes.compactStateCharacters.toLocaleString()} state characters vs ${sizes.originalStateCharacters.toLocaleString()} originally (${sizes.reductionPercent}% smaller). Character counts exclude instructions/schema and are not token counts. Actual tokens appear with the response.`;
    this.el("llm-title").textContent = `Server ${entry.context.server.id} · ${entry.model}`;
    this.el("llm-summary").textContent = entry.status === "cooldown" ? "Rate limit cooldown. The same decision will retry automatically; restaurant time stays frozen." : entry.status === "waiting" ? "Waiting for the local adapter / inference provider. No response text has arrived yet." : entry.status === "received" ? "Response received. The simulator validates the itinerary before execution." : `${entry.status.toUpperCase()}: ${entry.error}`;
    this.el("llm-detail").dataset.status = entry.status;
    this.el("llm-outcome").textContent = entry.response ? `${entry.response.ids.map((id) => {
      const action = entry.context.candidates.find((c) => c.id === id);
      return action ? `${action.kind.replaceAll("_", " ")}${action.table ? ` at table ${action.table}` : ""}` : id;
    }).join(" → ")} · Tokens: ${entry.response.inputTokens} in / ${entry.response.outputTokens} out · Resolved model: ${entry.response.model}  -  Provider wait: ${(entry.response.wallMs / 1000).toFixed(2)}s` : "";
    this.el("llm-response").textContent = entry.response ? JSON.stringify({ ...entry.response, retries: entry.retries }, null, 2) : entry.error || entry.retries?.length ? JSON.stringify({ error: entry.error, diagnostics: entry.diagnostics, retries: entry.retries }, null, 2) : "Waiting for the complete response. This request does not stream tokens.";
    this.el("llm-instructions").textContent = inferenceInstructions(request);
    this.el("llm-context").textContent = JSON.stringify(entry.context, null, 2);
    this.el("llm-request").textContent = JSON.stringify(request, null, 2);
  }
}
