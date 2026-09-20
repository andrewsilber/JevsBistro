import type { Config } from "../sim/types";
import type { ProxySettings, Provider } from "../llm/protocol";
import type { LlmActivity } from "../llm/activity";
import { PROXY_CONDITIONS, CONDITIONS, summarize, type ComparisonRun } from "../sim/comparison";
import { diagnosticReport } from "./diagnostic-report";

export class ComparisonPanel {
  private worker?: Worker;
  private runs: ComparisonRun[] = [];
  private config?: Config;
  private count = 1;
  private proxy = true;
  private settings?: ProxySettings;
  private generation = 0;
  private busy = false;
  private scope = "";
  private diagnostic = true;
  private stopping = false;
  private reportState = "Not started";
  constructor(readonly host: HTMLElement, readonly getConfig: () => Config, readonly getSettings: (provider?: Provider) => ProxySettings, readonly activity: LlmActivity, readonly showActivity: () => void) {
    host.innerHTML = `<p>Compare planning and information separately. Every condition receives the same guest scenario for each seed, with the same layout, staffing, and observation settings.</p>
      <p class="form-help">Real Jev uses TypeSafe; the legacy stand-in uses OpenAI. Both use camera observations and hold simulation time during requests; measured network latency is reported separately. Local and camera rules isolate the value of information. No condition is calibrated to real staff. Runs finish after tables clear, with a four-hour drain limit; unfinished runs are marked.</p>
      <div class="comparison-controls"><label>Comparison<select id="compare-kind"><option value="jev">Diagnose all three - real Jev</option><option value="diagnostic">Diagnose all three - OpenAI stand-in</option><option value="proxy">With / without Jev proxy</option><option value="rules">Four rules baselines (no API)</option></select></label><label>Paired seeds <input id="compare-count" type="number" min="1" max="10" value="1"></label><button class="btn primary" id="compare-start">Run comparison</button><button class="btn ghost" id="compare-stop" disabled>Stop</button><button class="btn ghost" id="compare-export" disabled>Export comparison</button></div>
      <p id="compare-status" role="status">Uses the current restaurant configuration. Your live service is not advanced. Diagnostic mode runs local rules, camera rules and your selected AI provider; the API call limit applies to each AI seed.</p><div id="compare-results"></div>
      <section id="diagnostic-output" hidden><h3>Diagnostic text to share</h3><p>Copy this report and paste it into our conversation. It includes configuration, matched-run checks, wait distributions, overdue greeting decisions, actual actions, and token usage. Export comparison retains more detailed traces.</p><button id="diagnostic-copy" class="btn primary" disabled>Copy diagnostic report</button><p id="diagnostic-copy-status" role="status"></p><label>Diagnostic report<textarea id="diagnostic-text" readonly rows="14" spellcheck="false" style="width:100%;box-sizing:border-box;font:12px/1.5 monospace"></textarea></label></section>`;
    this.el<HTMLButtonElement>("compare-start").onclick = () => this.start();
    const monitor = document.createElement("button"); monitor.className = "btn ghost"; monitor.id = "compare-activity"; monitor.textContent = "LLM activity"; monitor.onclick = showActivity;
    host.querySelector(".comparison-controls")!.append(monitor);
    this.el<HTMLButtonElement>("compare-stop").onclick = () => this.stop();
    this.el<HTMLButtonElement>("compare-export").onclick = () => {
      const report = { schemaVersion: 2, diagnostic: this.diagnostic, status: this.reportState, config: this.config, requestedSeeds: this.count, runs: this.runs, jevCalls: this.settings?.provider === "jev" ? this.runs.reduce((n, r) => n + (r.usage?.calls ?? 0), 0) : 0, proxySettings: this.proxy ? this.settings : undefined, simulatedInferenceLatencyMs: 0, notes: "Held-clock benchmark; real API latency measured separately. Provider is recorded in settings and interactions. Costs are estimates; failed or aborted requests may also be billed." };
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = `jevsbistro-comparison-${this.config!.seed}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    this.el<HTMLButtonElement>("diagnostic-copy").onclick = async () => {
      const field = this.el<HTMLTextAreaElement>("diagnostic-text");
      try { await navigator.clipboard.writeText(field.value); this.el("diagnostic-copy-status").textContent = "Copied. Paste the report into our conversation."; }
      catch { field.focus(); field.select(); this.el("diagnostic-copy-status").textContent = "Clipboard access unavailable. The report is selected; press Ctrl+C to copy."; }
    };
  }
  private refreshReport() {
    this.el("diagnostic-output").hidden = !this.diagnostic || !this.runs.length;
    this.el<HTMLButtonElement>("diagnostic-copy").disabled = !this.runs.length;
    if (this.diagnostic && this.config && this.settings) this.el<HTMLTextAreaElement>("diagnostic-text").value = diagnosticReport(this.config, this.runs, this.count, this.settings, this.reportState);
  }
  private el<T extends HTMLElement = HTMLElement>(id: string) { return this.host.querySelector<T>(`#${id}`)!; }
  private setBusy(busy: boolean) {
    this.busy = busy;
    this.el<HTMLButtonElement>("compare-start").disabled = busy;
    this.el<HTMLInputElement>("compare-count").disabled = busy;
    this.el<HTMLSelectElement>("compare-kind").disabled = busy;
    this.el<HTMLButtonElement>("compare-stop").disabled = !busy;
    this.el<HTMLButtonElement>("compare-export").disabled = !this.runs.length;
  }
  private start() {
    // Ignore events from a terminated worker when a fresh comparison starts.
    const count = Number(this.el<HTMLInputElement>("compare-count").value);
    if (!Number.isInteger(count) || count < 1 || count > 10) { this.el("compare-status").textContent = "Choose 1–10 seeds."; return; }
    this.diagnostic = ["jev", "diagnostic"].includes(this.el<HTMLSelectElement>("compare-kind").value);
    this.proxy = this.el<HTMLSelectElement>("compare-kind").value !== "rules";
    try { if (this.proxy) this.settings = this.getSettings(this.el<HTMLSelectElement>("compare-kind").value === "jev" ? "jev" : "openai"); } catch (e) { this.el("compare-status").textContent = (e as Error).message; return; }
    const generation = ++this.generation;
    this.scope = `Comparison ${generation} / seeds ${this.getConfig().seed}-${this.getConfig().seed + count - 1}`;
    this.count = count; this.config = structuredClone(this.getConfig()); this.runs = []; this.reportState = "Running; incomplete comparison"; this.stopping = false;
    this.el("diagnostic-copy-status").textContent = ""; this.refreshReport(); this.render(); this.setBusy(true);
    this.worker?.terminate();
    this.worker = new Worker(new URL("../sim/comparison.worker.ts", import.meta.url), { type: "module" });
    this.worker.onerror = (e) => { this.activity.cancelScope(this.scope); this.reportState = `Comparison failed: ${e.message}; active run may be missing`; this.el("compare-status").textContent = this.reportState; this.refreshReport(); this.setBusy(false); this.worker?.terminate(); };
    this.worker.onmessage = ({ data }) => {
      if (generation !== this.generation) return;
      if (data.type === "interaction") {
        this.activity.receive(data.entry);
        if (data.entry.status === "cooldown") this.el("compare-status").textContent = "Provider rate limit cooldown. Restaurant clock frozen; automatic retry pending. Open LLM activity for the countdown.";
      }
      if (data.type === "planning") this.el("compare-status").textContent = `${this.settings?.provider === "jev" ? "Real Jev" : "OpenAI proxy"} - restaurant time ${Math.floor(data.at / 60)}m ${Math.floor(data.at % 60)}s · planning with clock frozen · ${data.usage.calls} calls · ~$${data.usage.estimatedUsd.toFixed(4)}${data.usage.unknownPriceCalls ? " + unpriced calls" : ""}`;
      if (data.type === "run") { this.runs.push(data.run); this.render(); this.refreshReport(); this.el<HTMLButtonElement>("compare-export").disabled = false; }
      if (data.type === "starting") this.el("compare-status").textContent = `${this.runs.length}/${count * (this.proxy ? 3 : 4)} runs complete · seed ${data.seed} · ${data.proxy ? (this.settings?.provider === "jev" ? "Real Jev" : "OpenAI proxy") : data.planner + " rules"} / ${data.mode} observations`;
      if (data.type === "error") { this.reportState = data.message; this.el("compare-status").textContent = data.message; this.refreshReport(); this.setBusy(false); this.worker?.terminate(); }
      if (data.type === "done") { this.reportState = `${this.runs.length} runs complete · ${count} paired seeds · ${this.config!.layoutStyle} / ${this.config!.stationPlacement} stations. ${this.runs.every((r) => r.finished) ? "Every service finished." : "Some services hit the drain limit; inspect exports before comparing."}`; this.el("compare-status").textContent = this.reportState; this.refreshReport(); this.setBusy(false); this.worker?.terminate(); }
      if (data.type === "stopped") { this.reportState = "Stopped. Completed runs and the partial active run are retained; incomplete comparison."; this.el("compare-status").textContent = this.reportState; this.refreshReport(); this.setBusy(false); this.worker?.terminate(); }
    };
    this.worker.postMessage({ config: this.config, count, proxy: this.proxy, diagnostic: this.diagnostic, settings: this.settings, scope: this.scope });
  }
  stop() {
    if (!this.busy || this.stopping) return;
    this.stopping = true;
    this.activity.cancelScope(this.scope);
    this.worker?.postMessage({ type: "stop" });
    this.el<HTMLButtonElement>("compare-stop").disabled = true;
    this.el("compare-status").textContent = "Stopping and saving partial diagnostics. An in-flight request may still be billed.";
  }
  private render() {
    const conditions = this.proxy ? PROXY_CONDITIONS : CONDITIONS;
    const rows = conditions.map((condition) => {
      const runs = this.runs.filter((r) => r.mode === condition.mode && r.planner === condition.planner && !!r.proxy === ("proxy" in condition && condition.proxy));
      const s = summarize(runs), label = "proxy" in condition && condition.proxy ? (this.settings?.provider === "jev" ? "Real Jev / camera" : "Jev proxy / camera") : `${condition.planner === "route" ? "Multi-stop" : "Next-task"} / ${condition.mode === "patrol" ? "local" : "camera"}`;
      return `<tr><th>${label}</th><td>${runs.length}/${this.count}</td>${runs.length ? `<td>${s.completed}</td><td>${s.leftQueue}</td><td>${s.metersPerGuest.toFixed(1)} m</td><td>${s.greeting.toFixed(0)} s</td><td>${s.food.toFixed(0)} / ${s.foodP90.toFixed(0)} s</td><td>${s.cocktails ? `${s.drinks.toFixed(0)} s` : "—"}</td><td>${s.emptyWater.toFixed(1)}%</td><td>${s.requestsRaised ? `${s.requestResponse.toFixed(0)} / ${s.requestResolution.toFixed(0)} s` : "—"}</td><td>${s.requestsResolved}/${s.requestsRaised}</td><td>${s.allFinished ? "Complete" : runs.some((r) => r.error) ? "Partial / error" : "Capped"}</td><td>${runs.reduce((n, r) => n + (r.usage?.calls ?? 0), 0)}</td><td>$${runs.reduce((n, r) => n + (r.usage?.estimatedUsd ?? 0), 0).toFixed(4)}${runs.some((r) => r.usage?.unknownPriceCalls) ? " + unpriced" : ""}</td>` : '<td colspan="12">Pending</td>'}</tr>`;
    }).join("");
    this.el("compare-results").innerHTML = `<div class="comparison-scroll"><table class="comparison-table"><thead><tr><th>Planner / evidence</th><th>Seeds</th><th>Paid guests</th><th>Left queue</th><th>Walk / guest</th><th>Greeting mean</th><th>Food mean / p90</th><th>Drinks order → table</th><th>Empty water</th><th>Request response / resolution</th><th>Requests resolved</th><th>Service</th><th>AI calls</th><th>Est. API cost</th></tr></thead><tbody>${rows}</tbody></table></div><p class="form-help">Waits pool completed stages across the listed seeds. Food time is ready-to-table. Requests include bills; response is signal-to-contact, resolution is signal-to-completed-help. Only answered/resolved requests enter those means; compare resolved counts too. Guest totals and queue losses matter alongside waits: faster averages can hide poorer throughput. Export retains each seed's raw metrics. Partial or unmatched runs are not comparable. Costs exclude unknown charges for failed or cancelled requests and models without a known price; unknown-price call counts are retained in exports. Results describe this configuration, not a general performance advantage or real-world deployment performance.</p>`;
  }
}
