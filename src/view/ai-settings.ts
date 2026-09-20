import { localApi } from "../llm/client";
import { MODELS, type ProxySettings, type Provider } from "../llm/protocol";

import { JEV_MODELS } from "../jev/protocol";

export class AiSettings {
  configured = false;
  private selectedModels: Record<Provider, string> = { jev: JEV_MODELS[0], openai: MODELS[0] };
  constructor(readonly dialog: HTMLDialogElement) {
    dialog.innerHTML = `<div class="modal-head"><h2>AI service settings</h2><button class="close-dialog" aria-label="Close AI settings">×</button></div>
      <div class="modal-body"><p>Connect real Jev (TypeSafe) or the optional OpenAI stand-in. Both hold restaurant time during requests for controlled comparisons; actual response latency is measured separately.</p><label>Provider<select id="ai-provider"><option value="jev">Real Jev - TypeSafe</option><option value="openai">OpenAI - legacy stand-in</option></select></label>
      <label><span id="ai-key-label">TypeSafe API key</span><input id="ai-key" type="password" autocomplete="off" placeholder="TypeSafe API key"></label>
      <p class="form-help">Stored only in this local server's memory for up to 24 hours, cleared on server restart. Never saved in browser storage or exports. Selected provider API billing applies.</p>
      <div class="comparison-controls"><button class="btn primary" id="ai-save">Save key</button><button class="btn ghost" id="ai-forget">Forget key</button><button class="btn ghost" id="ai-check">Check Jev access</button></div>
      <p id="ai-key-status" role="status"></p><div class="form-grid"><label>Model<select id="ai-model">${JEV_MODELS.map((model) => `<option>${model}</option>`).join("")}</select></label>
      <label>Maximum API calls per run<input id="ai-limit" type="number" min="1" max="10000" value="500"></label></div>
      <p class="form-help">Settings apply to the next service or comparison. This is a call limit, not a dollar budget; retries also count. Only one feasible action? It runs without an API call. Temporary rate limits retry up to three times with a visible cooldown. Billing errors stop the run; there is no silent rules fallback.</p></div>`;
    dialog.querySelector<HTMLSelectElement>("#ai-model")!.onchange = () => { this.selectedModels[this.provider()] = dialog.querySelector<HTMLSelectElement>("#ai-model")!.value; };
    dialog.querySelector<HTMLSelectElement>("#ai-provider")!.onchange = () => {
      const jev = this.provider() === "jev";
      const models = dialog.querySelector<HTMLSelectElement>("#ai-model")!;
      models.replaceChildren(...Array.from(new Set([...(jev ? JEV_MODELS : MODELS), this.selectedModels[this.provider()]]), (id) => new Option(id, id)));
      models.value = this.selectedModels[this.provider()];
      dialog.querySelector<HTMLInputElement>("#ai-key")!.value = "";
      dialog.querySelector("#ai-key-label")!.textContent = jev ? "TypeSafe API key" : "OpenAI API key";
      dialog.querySelector<HTMLInputElement>("#ai-key")!.placeholder = jev ? "TypeSafe API key" : "sk-...";
      dialog.querySelector<HTMLButtonElement>("#ai-check")!.hidden = !jev;
      void this.refreshStatus();
    };
    dialog.querySelector<HTMLButtonElement>("#ai-check")!.onclick = async () => {
      this.status("Checking TypeSafe access...");
      try {
        const data = await localApi("models", {}, undefined, "jev");
        const select = dialog.querySelector<HTMLSelectElement>("#ai-model")!;
        if (this.provider() === "jev") for (const { name } of data.models) if (![...select.options].some((o) => o.value === name)) select.add(new Option(name, name));
        this.status(`Jev access confirmed. ${data.models.length} model aliases available. No inference was run.`);
      } catch (error) { this.status((error as Error).message); }
    };
    dialog.querySelector<HTMLButtonElement>(".close-dialog")!.onclick = () => dialog.close();
    dialog.querySelector<HTMLButtonElement>("#ai-save")!.onclick = async () => {
      const input = dialog.querySelector<HTMLInputElement>("#ai-key")!, key = input.value.trim();
      input.value = "";
      try { await localApi("key", { key }, undefined, this.provider()); this.configured = true; this.status("Key stored locally. Use Check Jev access to verify TypeSafe credentials without inference."); }
      catch (error) { this.status((error as Error).message); }
    };
    dialog.querySelector<HTMLButtonElement>("#ai-forget")!.onclick = async () => {
      try { await localApi("forget", {}, undefined, this.provider()); this.configured = false; this.status("Key removed."); }
      catch (error) { this.status((error as Error).message); }
    };
  }
  private status(text: string) { this.dialog.querySelector("#ai-key-status")!.textContent = text; }
  private provider(): Provider { return this.dialog.querySelector<HTMLSelectElement>("#ai-provider")!.value as Provider; }
  async open() { this.dialog.showModal(); await this.refreshStatus(); }
  private async refreshStatus() {
    try { this.configured = (await localApi("status", undefined, undefined, this.provider())).configured; this.status(this.configured ? "A key is stored for this browser session." : "No key stored. Paste the selected provider's API key above."); }
    catch { this.status("Local API unavailable. Start the app with npm run dev or npm run preview."); }
  }
  settings(provider: Provider = this.provider()): ProxySettings {
    const maxCalls = Number(this.dialog.querySelector<HTMLInputElement>("#ai-limit")!.value);
    if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 10000) throw Error("Choose a call limit between 1 and 10,000 in AI settings.");
    return { provider, model: provider === this.provider() ? this.dialog.querySelector<HTMLSelectElement>("#ai-model")!.value : this.selectedModels[provider], maxCalls };
  }
}
