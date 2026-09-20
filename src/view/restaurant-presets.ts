import { copyConfig } from "../sim/scenario";
import type { Config } from "../sim/types";

const KEY = "jevsbistro-restaurants-v1";
interface Preset { id: string; name: string; config: Config }

export class RestaurantPresets {
  private root: HTMLElement;
  constructor(host: HTMLElement, private readDraft: () => Config, private loadDraft: (config: Config) => void) {
    this.root = document.createElement("section");
    this.root.className = "restaurant-presets";
    this.root.innerHTML = `<h3>Saved restaurants</h3>
      <p class="form-help">Keep your layout, menu, staffing, guest habits and scenario settings in this browser.</p>
      <div class="preset-load"><label>Saved setup<select id="preset-list"><option value="">Choose a saved restaurant…</option></select></label>
        <button type="button" class="btn ghost small" id="preset-load" disabled>Load setup</button>
        <button type="button" class="btn ghost small" id="preset-delete" disabled>Delete saved setup</button></div>
      <div class="preset-save"><label>Save setup as<input id="preset-name" maxlength="80" placeholder="e.g. Busy Friday courtyard"></label>
        <button type="button" class="btn ghost small" id="preset-save">Save setup</button></div>
      <p class="form-help" id="preset-status" role="status">Loading fills in the form below. Create restaurant starts a new run.</p>`;
    host.prepend(this.root);
    this.el<HTMLSelectElement>("preset-list").onchange = () => this.safely(() => this.updateButtons());
    this.el<HTMLInputElement>("preset-name").oninput = () => this.safely(() => this.updateButtons());
    this.el("preset-save").onclick = () => this.safely(() => {
      const name = this.el<HTMLInputElement>("preset-name").value.trim();
      if (!name) throw Error("Give this saved setup a name first.");
      const form = this.root.closest("form")!;
      if (!form.reportValidity()) return;
      const config = copyConfig(this.readDraft()), presets = this.read();
      const existing = presets.find((preset) => preset.name.toLowerCase() === name.toLowerCase());
      const preset = { id: existing?.id ?? crypto.randomUUID(), name, config };
      if (existing) presets[presets.indexOf(existing)] = preset;
      else presets.push(preset);
      this.write(presets); this.refresh(preset.id);
      this.status(`${existing ? "Updated" : "Saved"} “${name}”. Available after you close or reload this browser.`);
    });
    this.el("preset-load").onclick = () => this.safely(() => {
      const preset = this.selected();
      if (!preset) return;
      this.loadDraft(copyConfig(preset.config));
      this.el<HTMLInputElement>("preset-name").value = preset.name;
      this.updateButtons();
      this.status(`Loaded “${preset.name}” into the form. Review it, then click Create restaurant.`);
    });
    this.el("preset-delete").onclick = () => this.safely(() => {
      const preset = this.selected();
      if (!preset) return;
      this.write(this.read().filter((item) => item.id !== preset.id));
      this.refresh();
      this.status(`Deleted “${preset.name}”. The current restaurant and form have not changed.`);
    });
  }
  private el<T extends HTMLElement = HTMLElement>(id: string) { return this.root.querySelector<T>(`#${id}`)!; }
  private status(message: string) { this.el("preset-status").textContent = message; }
  private safely(action: () => void) {
    try { action(); } catch (error) { this.status(`Could not complete that action: ${(error as Error).message}`); }
  }
  private read(): Preset[] {
    const text = localStorage.getItem(KEY);
    if (!text) return [];
    const saved = JSON.parse(text);
    if (saved.version !== 1 || !Array.isArray(saved.presets)) throw Error("Saved restaurant data has an unsupported format.");
    return saved.presets.map((preset: Preset) => {
      if (typeof preset.id !== "string" || typeof preset.name !== "string" || !preset.name.trim()) throw Error("A saved restaurant is invalid.");
      return { id: preset.id, name: preset.name, config: copyConfig(preset.config) };
    });
  }
  private write(presets: Preset[]) {
    try { localStorage.setItem(KEY, JSON.stringify({ version: 1, presets })); }
    catch { throw Error("Browser storage is unavailable or full. Your setup was not saved."); }
  }
  private selected() { return this.read().find((preset) => preset.id === this.el<HTMLSelectElement>("preset-list").value); }
  private updateButtons() {
    const selected = !!this.el<HTMLSelectElement>("preset-list").value;
    this.el<HTMLButtonElement>("preset-load").disabled = !selected;
    this.el<HTMLButtonElement>("preset-delete").disabled = !selected;
    const name = this.el<HTMLInputElement>("preset-name").value.trim().toLowerCase();
    this.el("preset-save").textContent = this.read().some((preset) => preset.name.toLowerCase() === name) ? "Update saved setup" : "Save setup";
  }
  private refresh(selected = "") {
    const select = this.el<HTMLSelectElement>("preset-list");
    select.replaceChildren(new Option("Choose a saved restaurant…", ""));
    for (const preset of this.read().sort((a, b) => a.name.localeCompare(b.name))) select.add(new Option(preset.name, preset.id));
    select.value = selected;
    this.updateButtons();
  }
  open(name: string) {
    this.el<HTMLInputElement>("preset-name").value = name;
    this.status("Loading fills in the form below. Create restaurant starts a new run.");
    this.safely(() => this.refresh());
  }
}
