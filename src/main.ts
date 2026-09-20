import "./style.css";
import "./view-refinements.css";
import { Simulation, average } from "./sim/engine";
import { DEFAULT_CONFIG } from "./sim/scenario";
import { RestaurantView, stageLabel } from "./view/restaurant";
import type { Config, MenuItem } from "./sim/types";
import { LlmActivity } from "./llm/activity";
import { LlmActivityPanel } from "./view/llm-activity";
import { AiSettings } from "./view/ai-settings";
import { requestPlan } from "./llm/client";
import { emptyUsage, type ProxySettings } from "./llm/protocol";
import { ComparisonPanel } from "./view/comparison-panel";
import { CameraFeed } from "./view/camera-feed";
import { RestaurantPresets } from "./view/restaurant-presets";
import { observeDiner } from "./sim/observations";
import { RunHistoryStore, summarizeRun } from "./history/run-history";
import { RunHistoryPanel } from "./view/run-history";
const $ =<T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const icons = {
  play: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M5 3l12 7-12 7z"/></svg>',
  pause:
    '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M4 3h4v14H4zM12 3h4v14h-4z"/></svg>',
  plus: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10 3v14M3 10h14"/></svg>',
};
let aiProvider: "openai" | "jev" = "jev";
let proxyMode = false, proxyUsage = emptyUsage(), proxySettings: ProxySettings = { model: "gpt-5.4-nano", maxCalls: 500 };
let inference: AbortController | undefined, inferenceError = "", inferenceStartedAt = 0;
let liveScope = "Live service 1", liveSerial = 1;
let historyNotice = "";
const llmActivity = new LlmActivity();
let sim = new Simulation(DEFAULT_CONFIG),
  running = false,
  speed = 1,
  selected: number | undefined,
  accumulator = 0;
document.querySelector("#app")!.innerHTML = `
<header><div class="brand"><div class="brand-mark">J.</div><div><h1>JevsBistro</h1><small>The service lab</small></div></div><div class="header-actions"><button class="btn ghost" id="theme-button" aria-pressed="false">☾ Dark view</button><button class="btn ghost" id="llm-activity-button">LLM activity</button><button class="btn ghost" id="ai-settings-button">AI settings</button><button class="btn ghost" id="comparison-button">Compare servers</button><button class="btn ghost" id="history-button">Run history</button><button class="btn ghost" id="report-button">Service report</button><button class="btn primary" id="new-button">${icons.plus} New restaurant</button></div></header>
<div class="app-layout"><aside class="sidebar"><section><p class="eyebrow">Your restaurant</p><h2 class="restaurant-name" id="restaurant-name"></h2><div class="small-meta" id="restaurant-meta"></div></section><hr class="sidebar-separator"><section><p class="eyebrow">Service intelligence</p><div class="mode-card active" id="patrol-card"><span class="tag">BASELINE</span><b>Patrol & observe</b><p>Servers scan visible tables one at a time and revisit aging information.</p></div><div class="mode-card" id="camera-card"><b>Camera-assisted rules</b><p>The selected planner, with full-room snapshots at the camera cadence.</p></div><div class="mode-card" id="proxy-card"><span class="tag" id="provider-tag">REAL JEV</span><b>Camera-informed earpiece</b><p>Real Jev decisions or the OpenAI stand-in. Inspect requests in LLM activity.</p></div><label>Run controller<select id="controller-select"><option value="rules">Without Jev · rules</option><option value="jev">With real Jev - TypeSafe</option><option value="proxy">With Jev proxy - OpenAI</option></select></label><p id="proxy-status" class="form-help" role="status"></p></section><hr class="sidebar-separator"><section><p class="eyebrow">On the floor</p><label class="switch-row">Table numbers<input id="labels" type="checkbox" checked></label><label class="switch-row">Server paths<input id="paths" type="checkbox"></label><label class="switch-row" title="Varied speech and thoughts. Bubbles grow from the speaker, scale with the restaurant, and use normal 3D depth.">Speech bubbles<input id="speech-bubbles" type="checkbox"></label><label class="switch-row">Camera coverage<input id="cameras" type="checkbox"></label><button class="btn ghost small" id="observations-button" style="width:100%;margin-top:6px">Inspect camera feed</button></section><div class="sidebar-note"><b>One restaurant. Different decisions.</b>Replay a seed to keep arrivals and guest attributes identical. Real Jev and the OpenAI stand-in hold the clock during inference. Measured API latency is reported separately.</div><footer>Built for the moments between orders.</footer></aside>
<main class="workspace"><div class="summary-banner" id="complete-banner" hidden><span>Service complete. The floor is ready for a fresh start.</span><button class="btn small" id="complete-report">View report</button></div><div class="toolbar"><div><h2>The dining room</h2><p id="service-subtitle">A little choreography. A lot of moving parts.</p></div><div class="toolbar-actions"><div class="time-display"><span id="clock">18:00:00</span><small id="elapsed">Doors open in a moment</small></div><select id="speed" aria-label="Simulation speed" style="width:76px"><option value="1">1×</option><option value="5">5×</option><option value="15" selected>15×</option><option value="60">60×</option></select><button class="btn ghost" id="reset-button" title="Reset this seeded scenario">↺ Reset</button><button class="btn primary" id="run-button">${icons.play} Run service</button></div></div>
<section class="stats" aria-label="Live service metrics"><div class="stat"><label>Guests on floor</label><strong id="guests">0</strong><small id="capacity">/ 32</small></div><div class="stat"><label>Waiting to sit</label><strong id="queue">0</strong><small>guests</small></div><div class="stat"><label>Served & paid</label><strong id="served">0</strong><small>guests</small></div><div class="stat"><label>Avg. greeting wait</label><strong class="accent" id="wait">—</strong></div><div class="stat"><label>Server distance</label><strong id="distance">0</strong><small>m</small></div></section>
<div class="scene-wrap"><div class="scene" id="scene"></div><div class="scene-top"><div class="scene-chip"><i class="status-dot" id="live-dot"></i><span id="live-label">READY FOR SERVICE</span><span style="color:#9aa58e"> / </span><span id="seed-label">SEED 42</span></div><div class="view-buttons"><button id="iso" class="active">◈ Isometric</button><button id="top">▦ Top-down</button></div></div><aside class="inspector" id="inspector" hidden></aside><div class="scene-tools"><button id="zoom-in" aria-label="Zoom in" title="Zoom in">+</button><button id="zoom-out" aria-label="Zoom out" title="Zoom out">−</button><button id="fit-view" aria-label="Fit restaurant" title="Fit restaurant">Fit</button><button id="expand-view" aria-pressed="false" title="Expand restaurant workspace">⛶ Expand view</button><button id="scene-feed">Camera feed</button></div><div id="path-status" class="path-status" hidden></div><div class="scene-bottom"><div class="legend"><span><b class="staff-key">S1</b>Server</span><span><i></i>Available / dining</span><span><i class="gold"></i>Waiting</span><span><i class="orange"></i>Needs attention</span><span>Hover or click a table for its state</span></div><span class="hint">Drag to orbit · Right-drag to pan · Scroll to zoom</span></div></div>
<div class="activity-toggle"><button class="btn ghost small" id="activity-toggle" aria-expanded="false">Show staff & journal</button><span id="activity-summary"></span><div class="quick-overlays"><label><input type="checkbox" id="quick-paths"> Paths</label><label><input type="checkbox" id="quick-labels" checked> Table numbers</label></div></div><div class="bottom-grid" hidden><section class="panel"><div class="panel-header"><h3>On shift</h3><span id="server-count">2 servers</span></div><div id="servers" class="server-list"></div></section><section class="panel"><div class="panel-header"><h3>Service journal</h3><span>SIMULATION TIME</span></div><div id="events" class="event-list" aria-live="off"></div></section></div></main></div>
<dialog id="create-dialog"><form id="create-form"><div class="modal-head"><h2>A new place at the table.</h2><button type="button" class="close-dialog" aria-label="Close">×</button></div><div class="modal-body"><div class="form-grid"><label class="full">Restaurant name<input name="name" maxlength="60" required></label><label>Tables<input name="tables" type="number" min="2" max="24" required></label><label>Logical rooms<select name="rooms"><option>1</option><option>2</option><option>3</option></select></label><label>Servers<input name="servers" type="number" min="1" max="6" required></label><label>Seats per table<select name="seats"><option>2</option><option>3</option><option>4</option></select></label><label>Parties per hour<input name="arrivals" type="number" min="4" max="90" required></label><label>Arrival window (minutes)<input name="duration" type="number" min="5" max="120" required></label><label>Scenario seed<input name="seed" type="number" min="0" max="2147483647" required></label><label>Camera interval (seconds)<input name="snapshotSeconds" type="number" min="0.5" max="10" step="0.5" required></label><label>Floor plan<select name="layoutStyle"><option value="classic">Classic rows</option><option value="courtyard">Fountain courtyard</option><option value="staggered">Staggered rooms</option></select></label><label>Station placement<select name="stationPlacement"><option value="front">Together at front</option><option value="split">Bar at rear / side station on edge</option></select></label><label>Aisle width<select name="aisleWidth"><option value="1">Compact · 1 m</option><option value="2">Open · 2 m</option><option value="3">Spacious · 3 m</option></select></label><label>Planner<select name="planner"><option value="route">Multi-stop routes</option><option value="greedy">Next task only</option></select></label><label>Local scan interval (seconds)<input name="observationSeconds" type="number" min="1" max="10" step="0.5" required></label><label>Recheck observations after (seconds)<input name="memorySeconds" type="number" min="30" max="300" step="5" required></label><label>Bartenders<input name="bartenders" type="number" min="1" max="3" required></label><label class="full">Observation source<select name="mode"><option value="patrol">Local scans — limited attention</option><option value="camera">Camera observations — full room snapshots</option></select></label></div><section class="guest-editor"><h3>Guest habits</h3><p class="form-help">Chances per diner, except lingering, which applies to the party. Choices and individual eating speeds repeat with the seed.</p><div class="form-grid"><label>Order an appetizer (%)<input name="appetizerRate" type="number" min="0" max="100" required></label><label>Order dessert (%)<input name="dessertRate" type="number" min="0" max="100" required></label><label>Order a cocktail (%)<input name="cocktailRate" type="number" min="0" max="100" required></label><label>Use a phone (%)<input name="phoneRate" type="number" min="0" max="100" required></label><label>Visit the restroom (%)<input name="bathroomRate" type="number" min="0" max="100" required></label><label>Linger after paying (%)<input name="lingerRate" type="number" min="0" max="100" required></label></div></section><div class="menu-editor"><h3>The menu</h3><p class="form-help">Appetizers are optional; everyone orders a main. Dessert menus come after mains. Parties share course timing, but diners can skip optional courses.</p><div class="menu-row labels"><span>Dish</span><span>Course</span><span>Prep · sec</span><span>Price · $</span><span></span></div><div id="menu-fields"></div><button class="btn ghost small" type="button" id="add-dish">+ Add dish</button></div><label class="switch-row">Extra guest requests and incidents<input name="interruptions" type="checkbox"></label><label>Extra request chance per party (%)<input name="requestRate" type="number" min="0" max="100" required></label><p class="form-help">Default: 20% of parties have one extra request opportunity; 80% are questions, 10% dropped forks, 10% spills. These are adjustable assumptions, not measured rates. Accidents require a relevant item in use. Routine dessert offers and bill requests happen separately. A wave reveals a need for attention; private requests become known through a conversation.</p><label class="switch-row">Server voice hints to camera feed<input name="voiceHints" type="checkbox"></label><p class="form-help">Cocktails: citrus spritz ($12, 35s), house martini ($15, 50s), old fashioned ($14, 60s). Each bartender prepares one ticket at a time. Food preparation uses independent timers. Each logical room has one full-coverage camera. Layout and menu stay fixed during service. After arrivals close, seated guests finish their meals.</p><p id="form-error" class="error" role="alert"></p></div><div class="modal-foot"><span class="form-help">A new restaurant replaces the current run.</span><button class="btn primary" type="submit">Create restaurant ${icons.plus}</button></div></form></dialog>
<dialog id="observations-dialog" class="wide-dialog"><div class="modal-head"><h2>The camera feed</h2><button class="close-dialog" aria-label="Close">×</button></div><div class="modal-body" id="camera-feed"></div></dialog>
<dialog id="report-dialog" class="wide-dialog"><div class="modal-head"><h2>Service, by the numbers.</h2><button class="close-dialog" aria-label="Close">×</button></div><div class="modal-body"><p class="form-help" id="report-description"></p><div class="report-grid" id="report-metrics"></div><p class="form-help">Wait averages include completed stages only. Running reports are partial. This is a simulation, not evidence of Jev performance. Export includes configuration, generated guest scenario, metrics, full camera history, and the last decision context.</p><div class="report-actions"><button class="btn primary" id="export-button">↓ Export run as JSON</button><button class="btn ghost" id="history-save">Save to run history</button><span class="form-help" id="history-save-status" role="status"></span></div></div></dialog>
<dialog id="history-dialog" class="wide-dialog"><div class="modal-head"><h2>Run history</h2><button class="close-dialog" aria-label="Close">×</button></div><div class="modal-body" id="history-panel"></div></dialog>
<dialog id="comparison-dialog" class="wide-dialog"><div class="modal-head"><h2>Compare server performance</h2><button class="close-dialog" aria-label="Close">×</button></div><div class="modal-body" id="comparison-panel"></div></dialog><dialog id="ai-dialog"></dialog><dialog id="llm-dialog"></dialog><dialog id="reset-dialog"><div class="modal-head"><h2>Replay this service?</h2><button class="close-dialog" aria-label="Close">×</button></div><div class="modal-body"><p>Reset the clock, guests, and metrics using the same seed. Export the report first if you want to keep this run.</p><button class="btn primary" id="confirm-reset">Reset service</button></div></dialog>`;
speed = 15;
const aiSettings = new AiSettings($("ai-dialog") as HTMLDialogElement);
const llmPanel = new LlmActivityPanel($("llm-dialog") as HTMLDialogElement, llmActivity);
const comparisonPanel = new ComparisonPanel($("comparison-panel"), () => sim.config, (provider) => aiSettings.settings(provider), llmActivity, () => llmPanel.open());
$("llm-activity-button").onclick = () => llmPanel.open();
$("comparison-dialog").addEventListener("close", () => comparisonPanel.stop());
$("comparison-dialog").addEventListener("cancel", () => comparisonPanel.stop());
$("comparison-dialog").querySelector(".close-dialog")!.addEventListener("click", () => comparisonPanel.stop());
const cameraFeed = new CameraFeed($("camera-feed"), () => sim);
let view: RestaurantView;
try {
  view = new RestaurantView($("scene"), sim, (id) => {
    selected = selected === id ? undefined : id;
    view.selected = selected;
    updateInspector();
  });
} catch (error) {
  $("scene").innerHTML =
    '<p style="padding:50px">The 3D view needs WebGL 2. Enable hardware acceleration in your browser and reload.</p>';
  console.error(error);
}
function clock(seconds: number) {
  const total = Math.floor(seconds) + 18 * 3600;
  return `${String(Math.floor(total / 3600) % 24).padStart(2, "0")}:${String(Math.floor(total / 60) % 60).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
const seconds = (n: number) =>
  n < 60
    ? `${Math.round(n)}s`
    : `${Math.floor(n / 60)}m ${Math.round(n % 60)}s`;
function setRunning(value: boolean) {
  running = value && !sim.finished;
  if (running) {
    inferenceError = "";
    if (proxyMode && sim.now === 0) {
      try { proxySettings = aiSettings.settings(aiProvider); } catch (error) { running = false; inferenceError = (error as Error).message; }
    }
  }
  $("run-button").innerHTML = running
    ? `${icons.pause} Pause`
    : `${icons.play} ${sim.now ? "Resume" : "Run service"}`;
  $("live-label").textContent = sim.finished
    ? "SERVICE COMPLETE"
    : running
      ? "SERVICE IN MOTION"
      : sim.now
        ? "SERVICE PAUSED"
        : "READY FOR SERVICE";
  $("live-dot").classList.toggle("live", running);
  // Flush the displayed clock on pause, rather than waiting for the UI throttle.
  updateUI();
}
function setSimulation(config: Config) {
  liveScope = `Live service ${++liveSerial}`;
  historyNotice = "";
  inference?.abort(); inference = undefined; inferenceError = ""; proxyUsage = emptyUsage();
  if (proxyMode) proxySettings = aiSettings.settings(aiProvider);
  sim = new Simulation(proxyMode ? { ...config, mode: "camera", planner: "route" } : config, undefined, undefined, { externalDecisions: proxyMode });
  selected = undefined;
  cameraFeed.reset();
  accumulator = 0;
  view?.build(sim);
  if (view) {
    view.selected = undefined;
    view.resize();
  }
  $("iso").classList.add("active");
  $("top").classList.remove("active");
  setRunning(false);
  updateUI();
}
function updateInspector() {
  const el = $("inspector");
  if (!selected) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const t = sim.tables[selected - 1],
    observation = sim.latestSnapshot?.tables.find((o) => o.table === t.id);
  const dinerDetails = t.diners
    .map((d) => {
      const o = observeDiner(t, d, sim.now);
      return `<div class="diner-row"><b>Diner ${d.id}</b> · ${o.waterPercent}% water<div class="water-bar"><span style="width:${o.waterPercent}%"></span></div><span class="activity">${d.restroomTrip ? "Away from table" : o.activity}</span>${o.cocktail ? `<p>${esc(o.cocktail.name)} · ${o.cocktail.percent}% remaining</p>` : ""}${o.course ? `<p>${esc(o.course.name)} · ${o.course.completionPercent}% complete</p><div class="course-bar"><span style="width:${o.course.completionPercent}%"></span></div>` : `<p>${o.plate}</p>`}</div>`;
    })
    .join("");
  el.innerHTML = `<button class="close" id="close-inspector" aria-label="Close table details">×</button><p class="eyebrow" style="margin:0 0 7px">Room ${t.room + 1}</p><h3>Table ${String(t.id).padStart(2, "0")} · ${stageLabel(t.stage)}</h3><p>${t.party ? `Party ${t.party.id} · ${t.diners.length} guests · ${seconds(sim.now - t.since)} in this stage` : `${t.seats} seats, ready for guests`}</p>${dinerDetails}${t.stage === "pay" ? `<p>Bill: ${t.bill === "ready" ? "payment ready" : t.bill === "presented" ? "guests reviewing" : "not yet presented"}</p>` : ""}${t.request ? `<p style="color:#aa6b39">Guest request: ${(t.request.visible || t.request.reported) ? t.request.kind : "unknown to camera"} · ${t.request.phase ?? "signalling"}</p>` : ""}<p>Last camera observation: ${observation ? `${seconds(sim.now - observation.at)} ago` : "none"}<br>${t.reservedBy ? `Assigned to ${sim.servers[t.reservedBy - 1].name}` : "No server assigned"}</p>`;
  $("close-inspector").onclick = () => {
    selected = undefined;
    view.selected = undefined;
    updateInspector();
  };
}
function updateUI() {
  $("restaurant-name").textContent = sim.config.name;
  $("restaurant-meta").innerHTML =
    `${sim.config.tables} tables · ${sim.config.tables * sim.config.seats} seats<br>${sim.config.rooms} ${sim.config.rooms === 1 ? "room" : "rooms"} · ${sim.config.arrivals} parties / hour`;
  $("controller-select").toggleAttribute("disabled", sim.now > 0);
  $("provider-tag").textContent = aiProvider === "jev" ? "REAL JEV" : "OPENAI PROXY";
  $("proxy-card").classList.toggle("active", proxyMode);
  $("proxy-status").textContent = proxyMode ? (inferenceError || (inference ? `Planning... ${((performance.now() - inferenceStartedAt) / 1000).toFixed(1)}s elapsed. Clock frozen. Open LLM activity for details.` : `${proxySettings.model} · ${proxyUsage.calls}/${proxySettings.maxCalls} calls · ~$${proxyUsage.estimatedUsd.toFixed(4)}${proxyUsage.unknownPriceCalls ? " + unpriced calls" : ""}`)) : "Select an AI controller before starting, or reset to change controllers.";
  $("live-label").textContent = inference ? "PLANNING · CLOCK FROZEN" : sim.finished ? "SERVICE COMPLETE" : running ? "SERVICE IN MOTION" : sim.now ? "SERVICE PAUSED" : "READY FOR SERVICE";
  const cooldown = inference && [...llmActivity.entries].reverse().find((e) => e.scope.startsWith(`${liveScope} /`) && e.status === "cooldown");
  if (cooldown) {
    $("proxy-status").textContent = `Rate limit cooldown. Retrying in ${Math.max(0, ((cooldown.retryAt ?? Date.now()) - Date.now()) / 1000).toFixed(1)}s. Restaurant time is frozen.`;
    $("live-label").textContent = "RATE LIMIT COOLDOWN";
  }
  $("patrol-card").classList.toggle("active", !proxyMode && sim.config.mode === "patrol");
  $("camera-card").classList.toggle("active", !proxyMode && sim.config.mode === "camera");
  $("service-subtitle").textContent =
    `${proxyMode ? (aiProvider === "jev" ? "Real Jev / held-clock benchmark" : "OpenAI Jev proxy") : sim.config.mode === "patrol" ? "Patrol & observe" : "Camera-assisted rules"} · ${sim.config.planner === "route" ? "Multi-stop planning" : "Next-task planning"} · ${sim.config.layoutStyle} · ${sim.config.duration}-minute arrival window`;
  $("clock").textContent = clock(sim.now);
  $("elapsed").textContent = sim.now
    ? `${seconds(sim.now)} elapsed${sim.now >= sim.config.duration * 60 ? " · arrivals closed" : ""}`
    : "Doors open in a moment";
  $("guests").textContent = String(
    sim.tables
      .filter((t) => !["empty", "dirty"].includes(t.stage))
      .reduce((n, t) => n + t.diners.length, 0),
  );
  $("capacity").textContent = `/ ${sim.config.tables * sim.config.seats}`;
  $("queue").textContent = String(sim.queue.reduce((n, p) => n + p.size, 0));
  $("served").textContent = String(sim.metrics.completed);
  $("wait").textContent = sim.metrics.greetingWaits.length
    ? seconds(average(sim.metrics.greetingWaits))
    : "—";
  $("distance").textContent = String(Math.round(sim.metrics.walking));
  $("seed-label").textContent = `SEED ${sim.config.seed}`;
  $("server-count").textContent =
    `${sim.servers.length} ${sim.servers.length === 1 ? "server" : "servers"}`;
  $("servers").innerHTML = sim.servers
    .map(
      (s) =>
        `<div class="server-row"><div class="avatar" style="background:${s.color}">${s.name.slice(0, 1)}</div><div class="server-detail"><b>${s.name}</b><span>${esc(s.status)}${s.itinerary.length ? `<small class="itinerary">Then: ${s.itinerary.map((stop) => esc(sim.label(stop))).join(" → ")}</small>` : ""}</span></div><div class="server-load">${s.drinks.length ? `${s.drinks.length}/4 cocktails` : s.plates.length ? `${s.plates.length}/4 plates` : s.dirty ? `${s.dirty} used plates` : `${Math.round(s.water * 250)} ml pitcher`}<br>${Math.round(s.walking)} m walked</div></div>`,
    )
    .join("");
  $("events").innerHTML = sim.events.length
    ? sim.events
        .slice(0, 20)
        .map(
          (e) =>
            `<div class="event"><time>${clock(e.at)}</time><span class="event-mark">${e.type === "interrupt" ? "!" : "·"}</span><span>${esc(e.text)}</span></div>`,
        )
        .join("")
    : '<div class="empty-note">The tables are set. The team is ready.<br>Run service to welcome your first guests.</div>';
  $("complete-banner").hidden = !sim.finished;
  ($("run-button") as HTMLButtonElement).disabled = sim.finished;
  updateInspector();
  view?.updateRoutes();
  const pathStatus = $("path-status");
  pathStatus.hidden = !view?.paths;
  pathStatus.textContent = view?.routeCount
    ? view.routeCount +
      " active routes · solid: current · dashed: planned stops"
    : sim.now
      ? "No moving routes · servers are stopped or serving"
      : "Run service to see server routes";
  $("activity-summary").textContent =
    sim.servers.length +
    " servers · " +
    (sim.events[0]?.text ?? "Ready for the first guests");
  if (($("observations-dialog") as HTMLDialogElement).open)
    updateObservations();
}
function updateObservations() {
  cameraFeed.update();
}
function showReport() {
  const m = sim.metrics;
  $("report-description").textContent =
    `${sim.config.name} · Seed ${sim.config.seed} · ${proxyMode ? (aiProvider === "jev" ? "Real Jev / held-clock benchmark" : "OpenAI Jev proxy") : sim.config.mode === "patrol" ? "Patrol baseline" : "Camera-assisted rules"} · ${seconds(sim.now)} ${sim.finished ? "(complete)" : "(partial run)"}`;
  const cells: [string, string][] = [
    ["Guests completed", String(m.completed)],
    ["Revenue", `${m.revenue.toFixed(2)}`],
    ["Dishes served", String(m.foodWaits.length)],
    ["Cocktails served", String(m.cocktailsServed)],
    ["Avg. cocktail order-to-table", seconds(average(m.drinkOrderWaits))],
    ["Avg. bar ready-to-table", seconds(average(m.drinkWaits))],
    ["Multi-stop plans", String(m.multiStopPlans)],
    ["Reconsidered planned stops", String(m.staleStops)],
    ["Avg. evidence age at dispatch", seconds(average(m.observationAges))],
    ["Distance walked", `${Math.round(m.walking)} m`],
    ["Avg. seating wait", seconds(average(m.seatingWaits))],
    ["Avg. greeting wait", seconds(average(m.greetingWaits))],
    ["Avg. order wait", seconds(average(m.orderWaits))],
    ["Avg. ready-to-table time", seconds(average(m.foodWaits))],
    ["Avg. payment wait", seconds(average(m.paymentWaits))],
    [
      "Empty-glass time",
      `${m.occupiedDinerSeconds ? ((100 * m.emptyGlassSeconds) / m.occupiedDinerSeconds).toFixed(1) : "0"}%`,
    ],
    ["Requests raised", String(m.requestsRaised)],
    ["Guest request conversations", String(m.interruptions)],
    ["Avg. request response", seconds(average(m.requestResponseWaits))],
    ["Avg. request resolution", seconds(average(m.requestResolutionWaits))],
    ["Guests left queue", String(m.turnedAway)],
    ["Jev API calls", String(aiProvider === "jev" ? proxyUsage.calls : 0)],
    ["OpenAI proxy calls", String(aiProvider === "openai" ? proxyUsage.calls : 0)],
    ["AI input / output tokens", `${proxyUsage.inputTokens} / ${proxyUsage.outputTokens}`],
    ["Estimated API cost", `$${proxyUsage.estimatedUsd.toFixed(4)}${proxyUsage.unknownPriceCalls ? " + unpriced calls" : ""}`],
    ["Real inference time (excluded from simulation)", seconds(proxyUsage.wallMs / 1000)],
  ];
  $("report-metrics").innerHTML = cells
    .map(
      ([label, value]) =>
        `<div class="report-cell"><b>${value}</b><span>${label}</span></div>`,
    )
    .join("");
  ($("history-save") as HTMLButtonElement).disabled = !sim.now;
  $("history-save-status").textContent = historyNotice || (sim.now ? "Not yet in run history." : "Run service before saving to history.");
  ($("report-dialog") as HTMLDialogElement).showModal();
}
$("ai-settings-button").onclick = () => { setRunning(false); void aiSettings.open(); };
$("controller-select").onchange = () => {
  if (sim.now) return;
  const selectedController = ($("controller-select") as HTMLSelectElement).value;
  proxyMode = selectedController !== "rules"; aiProvider = selectedController === "jev" ? "jev" : "openai";
  setSimulation({ ...sim.config, mode: proxyMode ? "camera" : "patrol" });
};
$("run-button").onclick = () => setRunning(!running);
$("speed").onchange = () => {
  speed = Number(($("speed") as HTMLSelectElement).value);
};
$("reset-button").onclick = () => {
  if (!sim.now) return;
  setRunning(false);
  ($("reset-dialog") as HTMLDialogElement).showModal();
};
$("confirm-reset").onclick = () => {
  setSimulation(sim.config);
  ($("reset-dialog") as HTMLDialogElement).close();
};
$("iso").onclick = () => {
  view.home(false);
  $("iso").classList.add("active");
  $("top").classList.remove("active");
};
$("top").onclick = () => {
  view.home(true);
  $("top").classList.add("active");
  $("iso").classList.remove("active");
};
function setLabels(value: boolean) {
  if (view) view.overlays = value;
  ($("labels") as HTMLInputElement).checked = value;
  ($("quick-labels") as HTMLInputElement).checked = value;
  try { localStorage.setItem("jevsbistro-table-numbers", String(value)); } catch { /* Toggle still works without storage. */ }
}
try { setLabels(localStorage.getItem("jevsbistro-table-numbers") !== "false"); } catch { /* Default to visible. */ }
$("labels").onchange = () =>
  setLabels(($("labels") as HTMLInputElement).checked);
$("quick-labels").onchange = () =>
  setLabels(($("quick-labels") as HTMLInputElement).checked);
function setPaths(value: boolean) {
  if (view) view.paths = value;
  ($("paths") as HTMLInputElement).checked = value;
  ($("quick-paths") as HTMLInputElement).checked = value;
  updateUI();
}
$("paths").onchange = () => setPaths(($("paths") as HTMLInputElement).checked);
$("quick-paths").onchange = () =>
  setPaths(($("quick-paths") as HTMLInputElement).checked);
$("speech-bubbles").onchange = () => {
  view.bubbles.enabled = ($("speech-bubbles") as HTMLInputElement).checked;
};
$("cameras").onchange = () => {
  view.cameras = ($("cameras") as HTMLInputElement).checked;
};
$("observations-button").onclick = () => {
  updateObservations();
  ($("observations-dialog") as HTMLDialogElement).showModal();
};
$("scene-feed").onclick = () => {
  cameraFeed.update();
  ($("observations-dialog") as HTMLDialogElement).showModal();
};
$("observations-dialog").addEventListener("close", () =>
  cameraFeed.stopPlayback(),
);
$("zoom-in").onclick = () => view?.zoomBy(1.3);
$("zoom-out").onclick = () => view?.zoomBy(1 / 1.3);
$("fit-view").onclick = () => view?.home(view.topDown);
function setExpanded(value: boolean) {
  document.body.classList.toggle("focus-view", value);
  $("expand-view").textContent = value
    ? "⛶ Exit expanded view"
    : "⛶ Expand view";
  $("expand-view").setAttribute("aria-pressed", String(value));
  view?.resize();
}
$("expand-view").onclick = () =>
  setExpanded(!document.body.classList.contains("focus-view"));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.querySelector("dialog[open]"))
    setExpanded(false);
});
$("activity-toggle").onclick = () => {
  const panel = document.querySelector<HTMLElement>(".bottom-grid")!;
  panel.hidden = !panel.hidden;
  $("activity-toggle").textContent = panel.hidden
    ? "Show staff & journal"
    : "Hide staff & journal";
  $("activity-toggle").setAttribute("aria-expanded", String(!panel.hidden));
};
function applyTheme(dark: boolean) {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $("theme-button").textContent = dark ? "☀ Light view" : "☾ Dark view";
  $("theme-button").setAttribute("aria-pressed", String(dark));
  view?.setDark(dark);
  try {
    localStorage.setItem("jevsbistro-theme", dark ? "dark" : "light");
  } catch {
    /* Storage is optional. */
  }
}
let dark = false;
try {
  dark = localStorage.getItem("jevsbistro-theme") === "dark";
} catch {
  /* Use the default. */
}
applyTheme(dark);
$("theme-button").onclick = () =>
  applyTheme(document.documentElement.dataset.theme !== "dark");
$("comparison-button").onclick = () => { setRunning(false); ($("comparison-dialog") as HTMLDialogElement).showModal(); };
$("report-button").onclick = showReport;
$("complete-report").onclick = showReport;
document
  .querySelectorAll(".close-dialog")
  .forEach((b) =>
    b.addEventListener("click", () => b.closest("dialog")!.close()),
  );
let draftMenu: MenuItem[] = [];
function readMenu() {
  const data = new FormData($("create-form") as HTMLFormElement);
  return draftMenu.map((m, i) => ({ ...m, name: String(data.get(`dish${i}`)).trim(),
    course: data.get(`course${i}`) as MenuItem["course"], seconds: Number(data.get(`prep${i}`)), price: Number(data.get(`price${i}`)) }));
}
function renderMenu() {
  $("menu-fields").innerHTML = draftMenu.map((item, i) => `<div class="menu-row"><input name="dish${i}" value="${esc(item.name)}" required maxlength="45" aria-label="Dish ${i + 1} name"><select name="course${i}" aria-label="Dish ${i + 1} course">${["appetizer","main","dessert"].map(course => `<option value="${course}" ${course === item.course ? "selected" : ""}>${course}</option>`).join("")}</select><label class="menu-number"><span>Prep · seconds</span><input name="prep${i}" type="number" value="${item.seconds}" min="10" max="1800" required aria-label="Dish ${i + 1} preparation seconds"></label><label class="menu-number"><span>Price · $</span><input name="price${i}" type="number" value="${item.price}" min="0" max="500" step="0.5" required aria-label="Dish ${i + 1} price"></label><button type="button" class="remove-dish" data-index="${i}" aria-label="Remove dish ${i + 1}">×</button></div>`).join("");
}
$("menu-fields").onclick = (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".remove-dish");
  if (!button) return;
  draftMenu = readMenu();
  draftMenu.splice(Number(button.dataset.index), 1);
  renderMenu();
};
$("add-dish").onclick = () => {
  draftMenu = readMenu();
  draftMenu.push({ id: crypto.randomUUID(), course: "main", name: "New dish", seconds: 120, price: 15, color: "#c99658" });
  renderMenu();
};
function fillRestaurantForm(config: Config) {
  const form = $("create-form") as HTMLFormElement;
  for (const [key, value] of Object.entries(config)) {
    const input = form.elements.namedItem(key) as HTMLInputElement | null;
    if (!input) continue;
    if (input.type === "checkbox") input.checked = Boolean(value);
    else input.value = String(value);
  }
  draftMenu = structuredClone(config.menu);
  renderMenu();
  $("form-error").textContent = "";
}
const restaurantPresets = new RestaurantPresets($("create-dialog").querySelector<HTMLElement>(".modal-body")!, readRestaurantForm, fillRestaurantForm);
// Run history: configuration plus summarized service report per run, in browser storage. Never credentials.
const runHistory = new RunHistoryStore(() => localStorage);
const historyIds = new WeakMap<Simulation, string>();
const historyPanel = new RunHistoryPanel($("history-panel"), runHistory, (config) => {
  ($("history-dialog") as HTMLDialogElement).close();
  setRunning(false);
  fillRestaurantForm(config);
  restaurantPresets.open(config.name);
  ($("create-dialog") as HTMLDialogElement).showModal();
});
/** Save the live run to history, replacing an earlier save of the same run (for example a partial save that later completed). */
function recordRun(automatic: boolean) {
  try {
    const record = summarizeRun({ id: historyIds.get(sim), config: sim.config, metrics: sim.metrics, simulatedSeconds: sim.now, finished: sim.finished,
      controller: proxyMode ? aiProvider : "rules", model: proxyMode ? proxySettings.model : undefined, usage: proxyMode ? proxyUsage : undefined });
    runHistory.save(record);
    historyIds.set(sim, record.id);
    historyNotice = automatic ? "Saved to run history automatically." : `Saved ${sim.finished ? "this run" : "this partial run"} to run history.`;
  } catch (error) {
    historyNotice = `Not saved to run history: ${(error as Error).message}`;
    if (automatic) console.warn(error);
  }
  if (($("history-dialog") as HTMLDialogElement).open) historyPanel.refresh();
}
$("history-button").onclick = () => { historyPanel.refresh(); ($("history-dialog") as HTMLDialogElement).showModal(); };
$("history-save").onclick = () => { if (!sim.now) return; recordRun(false); $("history-save-status").textContent = historyNotice; };
$("new-button").onclick = () => {
  setRunning(false);
  fillRestaurantForm(sim.config);
  restaurantPresets.open(sim.config.name);
  ($("create-dialog") as HTMLDialogElement).showModal();
};
function readRestaurantForm(): Config {
  const data = new FormData($("create-form") as HTMLFormElement),
    config = structuredClone(sim.config);
  for (const key of [
    "tables",
    "rooms",
    "servers",
    "seats",
    "arrivals",
    "duration",
    "seed",
    "snapshotSeconds",
    "appetizerRate", "dessertRate", "phoneRate", "lingerRate", "bathroomRate", "requestRate", "cocktailRate", "bartenders", "aisleWidth", "observationSeconds", "memorySeconds",
  ] as const)
    config[key] = Number(data.get(key));
  config.name = String(data.get("name")).trim();
  config.mode = data.get("mode") as Config["mode"];
  config.planner = data.get("planner") as Config["planner"];
  config.layoutStyle = data.get("layoutStyle") as Config["layoutStyle"];
  config.stationPlacement = data.get("stationPlacement") as Config["stationPlacement"];
  config.interruptions = data.has("interruptions");
  config.voiceHints = data.has("voiceHints");
  config.menu = readMenu();
  return config;
}
$("create-form").onsubmit = (e) => {
  e.preventDefault();
  try {
    setSimulation(readRestaurantForm());
    ($("create-dialog") as HTMLDialogElement).close();
  } catch (error) {
    $("form-error").textContent = (error as Error).message;
  }
};
$("export-button").onclick = () => {
  const blob = new Blob([JSON.stringify({ ...sim.export(), jevCalls: aiProvider === "jev" ? proxyUsage.calls : 0, inferenceTiming: "Held-clock benchmark; provider latency measured separately, not simulated", decisionSource: proxyMode ? aiProvider : "rules", proxy: proxyMode ? { settings: proxySettings, usage: proxyUsage, simulatedLatencyMs: 0 } : undefined }, null, 2)], {
      type: "application/json",
    }),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = `jevsbistro-seed-${sim.config.seed}-${sim.config.mode}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
document.addEventListener("keydown", (e) => {
  if (
    e.code === "Space" &&
    !document.querySelector("dialog[open]") &&
    !["INPUT", "BUTTON", "SELECT"].includes((e.target as HTMLElement).tagName)
  ) {
    e.preventDefault();
    setRunning(!running);
  }
});
updateUI();
let last = performance.now(),
  lastUI = 0;
async function planLive() {
  if (inference || !sim.pendingDecision) return;
  const target = sim, pending = sim.pendingDecision, abort = new AbortController();
  inference = abort; inferenceStartedAt = performance.now();
  updateUI();
  try {
    const response = await requestPlan(pending.context, proxySettings, proxyUsage, abort.signal, { scope: `${liveScope} / seed ${target.config.seed}`, emit: llmActivity.receive });
    if (target === sim && !abort.signal.aborted) { target.resolveDecision(pending.id, response.ids); view?.captureMotion(); }
  } catch (error) {
    if (target === sim && !abort.signal.aborted) { inferenceError = (error as Error).message; setRunning(false); }
  } finally {
    if (inference === abort) { inference = undefined; accumulator = 0; last = performance.now(); updateUI(); }
  }
}
function frame(now: number) {
  const delta = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (running && sim.pendingDecision && !inference && !inferenceError) void planLive();
  if (running && !document.hidden && !sim.pendingDecision && !inference) {
    accumulator += delta * speed;
    while (accumulator >= 0.25) {
      view?.captureMotion();
      sim.step();
      accumulator -= 0.25;
      if (sim.pendingDecision) { accumulator = 0; void planLive(); break; }
      if (sim.finished) {
        setRunning(false);
        recordRun(true);
        break;
      }
    }
  }
  if (now - lastUI > 180) {
    updateUI();
    llmPanel.update();
    lastUI = now;
  }
  view?.draw(sim.pendingDecision || inference ? 1 : accumulator / 0.25);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
// Optional WebMCP surface uses the same actions as the controls.
const modelContext = (
  document as Document & {
    modelContext?: { registerTool: (tool: unknown) => Promise<void> | void };
  }
).modelContext;
if (modelContext?.registerTool)
  for (const tool of [
    {
      name: "read_restaurant_run",
      description:
        "Read configuration and metrics for the current restaurant simulation.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: () => ({
        config: sim.config,
        seconds: sim.now,
        running,
        metrics: sim.metrics,
      }),
    },
    {
      name: "set_service_running",
      description: "Start, resume, or pause the current restaurant service.",
      inputSchema: {
        type: "object",
        properties: { running: { type: "boolean" } },
        required: ["running"],
        additionalProperties: false,
      },
      execute: (input: { running: boolean }) => {
        if (typeof input?.running !== "boolean")
          throw Error("running must be boolean");
        setRunning(input.running);
        updateUI();
        return { running, seconds: sim.now };
      },
    },
  ]) {
    try {
      Promise.resolve(modelContext.registerTool(tool)).catch(console.warn);
    } catch (error) {
      console.warn(error);
    }
  }
