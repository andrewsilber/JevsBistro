import type { Config } from "../sim/types";
import { HISTORY_COLUMNS, formatCell, historyCsv, sortRecords, type ColumnGroup, type RunHistoryStore, type RunRecord } from "../history/run-history";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const GROUPS: { group: ColumnGroup; label: string }[] = [{ group: "run", label: "Run" }, { group: "setup", label: "Setup" }, { group: "results", label: "Service report" }];

/** Read-only comparison table over saved runs, with row deletion and clear-all. Never touches the live simulation. */
export class RunHistoryPanel {
  private sortKey = "savedAt";
  private descending = true;
  private hidden = new Set<ColumnGroup>();
  private clearTimer?: ReturnType<typeof setTimeout>;
  constructor(readonly host: HTMLElement, readonly store: RunHistoryStore, readonly useSetup: (config: Config) => void) {
    host.innerHTML = `<p>Every completed service is added here automatically, with its setup and service report side by side. Add a partial run from the service report. Rows live in this browser's storage; nothing is uploaded.</p>
      <div class="comparison-controls history-controls">
        <label class="switch-row">Setup columns<input type="checkbox" id="history-setup" checked></label>
        <label class="switch-row">Report columns<input type="checkbox" id="history-results" checked></label>
        <button class="btn ghost" id="history-export" type="button">Export CSV</button>
        <button class="btn ghost" id="history-clear" type="button">Clear history</button>
        <span id="history-count" class="form-help"></span>
      </div>
      <p id="history-status" role="status" class="form-help"></p>
      <div id="history-table"></div>
      <p class="form-help">Click a column heading to sort. Wait columns are means of completed stages only, as in the service report; the p90 column is the 90th percentile of ready-to-table time. Use setup opens New restaurant with that run's configuration and menu. Deleting rows does not affect the current service. These are simulation results for comparing settings, not real-world performance.</p>`;
    this.el<HTMLInputElement>("history-setup").onchange = () => this.toggleGroup("setup", this.el<HTMLInputElement>("history-setup").checked);
    this.el<HTMLInputElement>("history-results").onchange = () => this.toggleGroup("results", this.el<HTMLInputElement>("history-results").checked);
    this.el("history-export").onclick = () => this.safely(() => {
      const records = this.sorted();
      if (!records.length) { this.status("No runs to export yet."); return; }
      const url = URL.createObjectURL(new Blob([historyCsv(records)], { type: "text/csv" }));
      const link = document.createElement("a"); link.href = url; link.download = "jevsbistro-run-history.csv"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.status(`Exported ${records.length} ${records.length === 1 ? "run" : "runs"} as CSV.`);
    });
    this.el("history-clear").onclick = () => this.safely(() => {
      const button = this.el<HTMLButtonElement>("history-clear");
      if (button.dataset.confirm) {
        this.resetClear();
        const count = this.store.list().length;
        this.store.clear();
        this.render();
        this.status(`Cleared ${count} ${count === 1 ? "run" : "runs"} from history.`);
        return;
      }
      const count = this.store.list().length;
      if (!count) { this.status("History is already empty."); return; }
      button.dataset.confirm = "1"; button.classList.add("danger");
      button.textContent = `Confirm: delete all ${count} ${count === 1 ? "run" : "runs"}`;
      this.status("Click again to clear the whole history. This cannot be undone.");
      this.clearTimer = setTimeout(() => { this.resetClear(); this.status(""); }, 6000);
    });
    this.el("history-table").addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const sort = target.closest<HTMLElement>("[data-sort]");
      if (sort) {
        const key = sort.dataset.sort!;
        this.descending = this.sortKey === key ? !this.descending : key !== "name";
        this.sortKey = key;
        this.safely(() => this.render());
        return;
      }
      const action = target.closest<HTMLElement>("[data-action]");
      if (!action) return;
      const id = action.closest<HTMLElement>("tr")!.dataset.id!;
      this.safely(() => {
        const record = this.store.list().find((r) => r.id === id);
        if (!record) { this.render(); throw Error("That run is no longer in history."); }
        if (action.dataset.action === "delete") {
          this.store.remove(id);
          this.render();
          this.status(`Deleted “${record.config.name}” (seed ${record.config.seed}) from history.`);
        } else if (action.dataset.action === "use") {
          this.useSetup(record.config);
        }
      });
    });
  }
  /** Re-read storage and redraw. Safe to call while the dialog is closed. */
  refresh() { this.resetClear(); this.status(""); this.safely(() => this.render()); }
  private el<T extends HTMLElement = HTMLElement>(id: string) { return this.host.querySelector<T>(`#${id}`)!; }
  private status(message: string) { this.el("history-status").textContent = message; }
  private safely(action: () => void) {
    try { action(); } catch (error) { this.status(`Could not complete that action: ${(error as Error).message}`); }
  }
  private resetClear() {
    clearTimeout(this.clearTimer);
    const button = this.el<HTMLButtonElement>("history-clear");
    delete button.dataset.confirm; button.classList.remove("danger"); button.textContent = "Clear history";
  }
  private toggleGroup(group: ColumnGroup, visible: boolean) {
    if (visible) this.hidden.delete(group); else this.hidden.add(group);
    this.safely(() => this.render());
  }
  private sorted() { return sortRecords(this.store.list(), this.sortKey, this.descending); }
  private render() {
    const records = this.sorted();
    this.el("history-count").textContent = `${records.length} saved ${records.length === 1 ? "run" : "runs"}`;
    if (!records.length) {
      this.el("history-table").innerHTML = '<div class="empty-note">No runs saved yet.<br>Completed services appear here automatically; use “Save to run history” in the service report to keep a partial run.</div>';
      return;
    }
    const columns = HISTORY_COLUMNS.filter((c) => !this.hidden.has(c.group));
    const groups = GROUPS.filter((g) => columns.some((c) => c.group === g.group))
      .map((g) => `<th colspan="${columns.filter((c) => c.group === g.group).length}" class="history-group">${g.label}</th>`).join("");
    const headers = columns.map((c, i) => {
      const active = c.key === this.sortKey;
      return `<th class="${i === 0 ? "history-sticky" : ""}" aria-sort="${active ? (this.descending ? "descending" : "ascending") : "none"}"><button type="button" class="history-sort" data-sort="${c.key}">${esc(c.label)}${active ? `<span aria-hidden="true"> ${this.descending ? "▼" : "▲"}</span>` : ""}</button></th>`;
    }).join("");
    const rows = records.map((r) => `<tr data-id="${esc(r.id)}">${columns.map((c, i) => `<td class="${i === 0 ? "history-sticky" : ""} kind-${c.kind}">${esc(formatCell(c, c.value(r)))}</td>`).join("")}<td class="history-actions"><button type="button" class="btn ghost small" data-action="use">Use setup</button><button type="button" class="btn ghost small" data-action="delete" aria-label="Delete run ${esc(r.config.name)} seed ${r.config.seed}">Delete</button></td></tr>`).join("");
    this.el("history-table").innerHTML = `<div class="history-scroll"><table class="comparison-table history-table"><thead><tr>${groups}<th></th></tr><tr>${headers}<th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
}
