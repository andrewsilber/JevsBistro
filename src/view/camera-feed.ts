import type { Simulation } from "../sim/engine";
import { stageLabel } from "./restaurant";
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const time = (s: number) =>
  new Date((18 * 3600 + s) * 1000).toISOString().slice(11, 19);

/** Reviewing recorded observations never seeks or mutates the live world. */
export class CameraFeed {
  index = 0;
  live = true;
  playing = false;
  private lastPlay = 0;
  private lastRender = "";
  constructor(
    private host: HTMLElement,
    private getSimulation: () => Simulation,
  ) {
    host.innerHTML = `<div class="feed-heading"><div><span class="eyebrow">OBSERVATION TIMELINE</span><strong id="feed-time">18:00:00</strong></div><span id="feed-mode" class="feed-badge">LIVE</span></div>
      <div class="timeline-controls"><button class="btn small" id="feed-prev" aria-label="Previous camera frame">‹</button><button class="btn small" id="feed-play" aria-label="Play camera history">Play history</button><button class="btn small" id="feed-next" aria-label="Next camera frame">›</button><input type="range" id="feed-scrubber" aria-label="Camera timeline" min="0" max="0" value="0" step="1"><button class="btn small primary" id="feed-live">Back to live</button></div>
      <div class="timeline-meta"><span id="feed-start">18:00:00</span><span id="feed-position"></span><span id="feed-end">18:00:00</span></div>
      <p class="form-help">Scrubbing reviews recorded observations; the restaurant keeps its current time. Activity is simulated classifier output. Course completion tracks active eating; conversation and phone use pause progress.</p>
      <div id="feed-tables" class="feed-tables"></div><div id="feed-servers" class="feed-servers"></div>
      <details class="raw-feed"><summary>Raw classified state</summary><pre id="observation-text" class="observation-list"></pre></details>`;
    this.el("feed-scrubber").addEventListener("input", () =>
      this.seek(Number(this.el<HTMLInputElement>("feed-scrubber").value)),
    );
    this.el("feed-prev").onclick = () => this.seek(this.index - 1);
    this.el("feed-next").onclick = () => this.seek(this.index + 1);
    this.el("feed-live").onclick = () => {
      this.live = true;
      this.playing = false;
      this.update();
    };
    this.el("feed-play").onclick = () => {
      if (this.playing) this.playing = false;
      else {
        if (
          this.live ||
          this.index >= this.getSimulation().snapshots.length - 1
        )
          this.index = 0;
        this.live = false;
        this.playing = true;
        this.lastPlay = performance.now();
      }
      this.update();
    };
  }
  private el<T extends HTMLElement = HTMLElement>(id: string) {
    return this.host.querySelector<T>(`#${id}`)!;
  }
  seek(index: number) {
    this.live = false;
    this.playing = false;
    this.index = Math.max(
      0,
      Math.min(index, this.getSimulation().snapshots.length - 1),
    );
    this.update();
  }
  reset() {
    this.index = 0;
    this.live = true;
    this.playing = false;
    this.lastRender = "";
  }
  stopPlayback() {
    this.playing = false;
  }
  update() {
    const sim = this.getSimulation(),
      frames = sim.snapshots,
      last = frames.length - 1;
    if (this.live) this.index = last;
    else if (this.playing && performance.now() - this.lastPlay >= 500) {
      this.index = Math.min(last, this.index + 1);
      this.lastPlay = performance.now();
      if (this.index === last) this.playing = false;
    }
    const snap = frames[this.index];
    if (!snap) return;
    const slider = this.el<HTMLInputElement>("feed-scrubber");
    slider.max = String(last);
    slider.value = String(this.index);
    slider.setAttribute(
      "aria-valuetext",
      `${time(snap.at)}, frame ${this.index + 1} of ${frames.length}`,
    );
    this.el("feed-time").textContent = time(snap.at);
    this.el("feed-mode").textContent = this.live
      ? "LIVE"
      : this.playing
        ? "PLAYBACK · 2 FRAMES/S"
        : "HISTORY";
    this.el("feed-mode").classList.toggle("history", !this.live);
    this.el("feed-play").textContent = this.playing
      ? "Pause history"
      : "Play history";
    this.el("feed-play").setAttribute(
      "aria-label",
      this.playing ? "Pause camera history" : "Play camera history",
    );
    this.el<HTMLButtonElement>("feed-prev").disabled = this.index === 0;
    this.el<HTMLButtonElement>("feed-next").disabled = this.index === last;
    this.el<HTMLButtonElement>("feed-play").disabled = last === 0;
    this.el("feed-start").textContent = time(frames[0].at);
    this.el("feed-end").textContent = time(frames[last].at);
    this.el("feed-position").textContent =
      `Frame ${this.index + 1} / ${frames.length} · ${sim.config.snapshotSeconds}s interval`;
    const renderKey = `${sim.config.seed}:${this.index}:${snap.at}`;
    if (renderKey === this.lastRender) return;
    this.lastRender = renderKey;
    this.el("feed-tables").innerHTML = snap.tables
      .map(
        (t) =>
          `<section class="feed-table"><div class="feed-table-heading"><h3>Table ${t.table} <small>Room ${t.room + 1}</small></h3><span>${stageLabel(t.stage)}${t.bill ? ` · bill ${t.bill}` : ""}</span></div>${t.request ? `<p class="feed-request">Request: ${esc(t.request)} · ${esc(t.requestPhase ?? "signalling")}</p>` : ""}${
            t.diners.length && !["empty", "dirty"].includes(t.stage)
              ? t.diners
                  .filter(() => !["empty", "dirty"].includes(t.stage))
                  .map(
                    (d) =>
                      `<div class="feed-diner"><div class="feed-diner-title"><b>Diner ${d.diner}</b><span class="activity ${d.activity.replaceAll(" ", "-")}">${d.present ? d.activity : `Away from table${d.position ? " · walking" : ""}`}</span></div><div class="feed-measures"><span>Water <b>${d.waterPercent}%</b></span><span>${d.course ? `${d.course.kind} · Course ${d.course.number} · <b>${d.course.completionPercent}% complete</b>` : esc(d.plate)}</span></div><div class="feed-bars"><div class="water-bar"><span style="width:${d.waterPercent}%"></span></div>${d.course ? `<div class="course-bar"><span style="width:${d.course.completionPercent}%"></span></div>` : "<div></div>"}</div>${d.course ? `<small>${esc(d.course.name)}</small>` : ""}${d.cocktail ? `<small class="cocktail-note">${esc(d.cocktail.name)} · ${d.cocktail.percent}% remaining</small>` : ""}</div>`,
                  )
                  .join("")
              : '<p class="feed-empty">No diners present</p>'
          }</section>`,
      )
      .join("");
    this.el("feed-servers").innerHTML =
      `<h3>Staff observations</h3>${snap.servers.map((s) => `<p><b>Server ${s.id}</b> <span>(${s.position.x.toFixed(1)}, ${s.position.y.toFixed(1)}) · ${esc(s.interrupted ? "Unexpected stop" : s.status)}</span></p>`).join("")}`;
    this.el("observation-text").textContent = [
      `SNAPSHOT ${time(snap.at)}`,
      ...snap.tables.flatMap((t) => [
        `ROOM ${t.room + 1} / TABLE ${t.table} = ${t.stage.toUpperCase()}${t.bill ? ` / BILL = ${t.bill.toUpperCase()}` : ""}${t.request ? ` / REQUEST = ${t.request.toUpperCase()} / PHASE = ${(t.requestPhase ?? "signalling").toUpperCase()}` : ""}`,
        ...t.diners
          .filter(() => !["empty", "dirty"].includes(t.stage))
          .map(
            (d) =>
              `  DINER ${d.diner} AT TABLE ${t.table}: PRESENT = ${d.present}; ACTIVITY = ${d.activity.toUpperCase()}${d.position ? `; GRID = (${d.position.x.toFixed(1)}, ${d.position.y.toFixed(1)})` : ""}; WATER GLASS = ${d.waterPercent}%; ${d.course ? `COURSE ${d.course.number} = ${d.course.completionPercent}% COMPLETE` : `PLATE = ${d.plate.toUpperCase()}`}`,
          ),
      ]),
      ...snap.servers.map(
        (s) =>
          `SERVER ${s.id} AT GRID (${s.position.x.toFixed(1)}, ${s.position.y.toFixed(1)}) = ${s.interrupted ? "UNEXPECTED STOP" : s.status.toUpperCase()}`,
      ),
    ].join("\n");
  }
}
