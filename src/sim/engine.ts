import type {
  ActionKind,
  CameraSnapshot,
  Candidate,
  Config,
  CourseKind,
  DecisionContext,
  DecisionEngine,
  Job,
  KitchenPort,
  Metrics,
  Party,
  Server,
  SimEvent,
  TableObservation,
  TableState,
  SimulationObserver,
} from "./types";
import { canObserve, distance, findPath, generateLayout, routeDistance } from "./layout";
import { createScenario, validateConfig } from "./scenario";
import { TimerKitchen } from "./kitchen";
import { RouteController, ServiceController } from "./controllers";
import { Bar } from "./bar";
import { observeDiner } from "./observations";
import { GUEST_SPEED, guestRoute, guestTravelSeconds, pathLength } from "./movement";
const durations: Record<ActionKind, number> = {
  bar_pickup: 5,
  drink_deliver: 5,
  dessert: 8,
  greet: 8,
  order: 12,
  pickup: 5,
  deliver: 5,
  refill: 5,
  check: 6,
  bill: 6,
  pay: 10,
  bus: 12,
  clear: 5,
  request: 9,
  supplies: 4,
  pitcher: 4,
  drop: 4,
  patrol: 1,
};
export class Simulation {
  readonly config: Config;
  readonly layout;
  readonly scenario: Party[];
  readonly tables: TableState[];
  readonly servers: Server[];
  readonly kitchen: KitchenPort;
  readonly bar: Bar;
  readonly controller: DecisionEngine;
  now = 0;
  finished = false;
  arrivalIndex = 0;
  queue: Party[] = [];
  events: SimEvent[] = [];
  snapshots: CameraSnapshot[] = [];
  latestSnapshot?: CameraSnapshot;
  lastSnapshot = -Infinity;
  lastDecision?: DecisionContext;
  pendingDecision?: { id: number; context: DecisionContext };
  private decisionSerial = 0;
  private activeStep?: Generator<void>;
  metrics: Metrics = {
    drinkWaits: [], drinkOrderWaits: [], cocktailsServed: 0,
    plans: 0, multiStopPlans: 0, staleStops: 0, observationAges: [],
    arrived: 0,
    seated: 0,
    completed: 0,
    turnedAway: 0,
    revenue: 0,
    walking: 0,
    emptyGlassSeconds: 0,
    occupiedDinerSeconds: 0,
    greetingWaits: [],
    orderWaits: [],
    foodWaits: [],
    paymentWaits: [],
    seatingWaits: [],
    interruptions: 0,
    requestsRaised: 0, requestResponseWaits: [], requestResolutionWaits: [],
    decisions: 0,
  };
  constructor(
    config: Config,
    controller?: DecisionEngine,
    kitchen?: KitchenPort,
    readonly options: { recordHistory?: boolean; externalDecisions?: boolean; observer?: SimulationObserver } = {},
  ) {
    validateConfig(config);
    this.config = { ...structuredClone(config), requestRate: config.requestRate ?? 20 };
    this.layout = generateLayout(config);
    this.scenario = createScenario(config);
    this.controller = controller ?? (config.planner === "route" ? new RouteController() : new ServiceController());
    this.kitchen = kitchen ?? new TimerKitchen();
    this.bar = new Bar(config.bartenders);
    this.tables = this.layout.tables.map((t) => ({
      ...t,
      stage: "empty",
      since: 0,
      diners: [],
      deadline: 0,
      checked: false,
    }));
    this.servers = Array.from({ length: config.servers }, (_, i) => ({
      id: i + 1,
      name: ["Alex", "Sam", "Jules", "Noor", "Charlie", "Robin"][i],
      color: ["#ecad62", "#5dafb1", "#b596d7", "#ed887b", "#90b966", "#7b9ee0"][
        i
      ],
      position: { x: 2 + i, y: 2 },
      memory: new Map(),
      knownRequests: new Map(),
      plates: [],
      drinks: [], itinerary: [], nextObservationAt: 0, heading: Math.PI,
      dirty: 0,
      pitcher: true,
      water: 4,
      walking: 0,
      completed: 0,
      interruptUntil: 0,
      lastPatrol: i,
      status: "Ready for service",
    }));
    this.capture();
  }
  log(text: string, type: SimEvent["type"] = "service") {
    this.events.unshift({ at: this.now, text, type });
    this.events.length = Math.min(300, this.events.length);
  }
  transition(t: TableState, stage: TableState["stage"]) {
    this.options.observer?.transition?.({ at: this.now, table: t.id, party: t.party?.id, from: t.stage, to: stage, since: t.since });
    t.stage = stage;
    t.since = this.now;
  }
  observe(t: TableState, source: TableObservation["source"]): TableObservation {
    return {
      table: t.id,
      room: t.room,
      at: this.now,
      source,
      stage: t.stage,
      party: t.party?.id,
      waters: t.diners.map((d) => Math.round(d.water * 10) * 10),
      finished: t.diners.map((d) => d.deliveredAt !== undefined && d.finished && !d.cleared),
      diners: t.diners.map((d) => observeDiner(t, d, this.now)),
      checked: t.checked,
      request: t.request
        ? t.request.visible || t.request.reported
          ? t.request.kind
          : "unknown"
        : undefined,
      requestPhase: t.request?.phase ?? (t.request ? "signalling" : undefined),
      bill: t.bill,
      since: t.since,
      position: { x: t.x, y: t.y },
    };
  }
  capture() {
    const snapshot: CameraSnapshot = {
      at: this.now,
      tables: this.tables.map((t) => this.observe(t, "camera")),
      servers: this.servers.map((s) => ({
        id: s.id,
        position: { ...s.position },
        status: s.status,
        interrupted: s.interruptUntil > this.now,
      })),
    };
    this.latestSnapshot = snapshot;
    if (this.options.recordHistory !== false) this.snapshots.push(snapshot);
    // Keep the complete observation timeline for this run; resetting releases it.
    this.lastSnapshot = this.now;
  }
  step(dt = 0.25) {
    if (this.pendingDecision || this.finished) return;
    this.activeStep ??= this.advance(dt);
    if (this.activeStep.next().done) this.activeStep = undefined;
  }
  /** Suspend within a tick: resuming never repeats arrivals, cooking or movement. */
  private *advance(dt: number): Generator<void> {
    if (this.finished) return;
    if (dt <= 0 || dt > 1)
      throw Error("Simulation steps must be > 0 and <= 1 second.");
    this.now += dt;
    while (
      this.arrivalIndex < this.scenario.length &&
      this.scenario[this.arrivalIndex].arrivedAt <= this.now
    ) {
      const p = structuredClone(this.scenario[this.arrivalIndex++]);
      this.queue.push(p);
      this.metrics.arrived += p.size;
      this.log(`Party ${p.id} arrives · ${p.size} guests`, "arrival");
    }
    this.seatGuests();
    for (const t of this.tables) this.updateTable(t, dt);
    if (this.now - this.lastSnapshot >= this.config.snapshotSeconds - 1e-9)
      this.capture();
    for (const s of this.servers) {
      if (this.config.mode === "camera" && this.latestSnapshot)
        for (const o of this.latestSnapshot.tables)
          s.memory.set(o.table, structuredClone(o));
      if (this.now >= s.nextObservationAt && s.interruptUntil <= this.now) {
        const visible = this.tables.filter((t) => canObserve(this.layout, s.position, t, s.heading, !!s.job?.path.length))
          .sort((a, b) => (s.memory.get(a.id)?.at ?? -1000) - (s.memory.get(b.id)?.at ?? -1000) || distance(s.position, a) - distance(s.position, b));
        if (visible[0]) s.memory.set(visible[0].id, this.observe(visible[0], "server"));
        s.nextObservationAt = this.now + this.config.observationSeconds;
      }
      for (const [id, kind] of s.knownRequests) {
        const o = s.memory.get(id);
        if (o?.request) o.request = kind;
        else s.knownRequests.delete(id);
      }
      this.noticeGuestSignal(s);
      if (!s.job && this.now >= (s.nextDecisionAt ?? 0)) this.assign(s);
      if (this.pendingDecision) yield;
      if (s.job) this.execute(s, dt);
    }
    if (
      this.now >= this.config.duration * 60 &&
      this.queue.length === 0 &&
      this.tables.every((t) => t.stage === "empty") &&
      this.servers.every((s) => s.dirty === 0 && s.plates.length === 0 && s.drinks.length === 0)
    ) {
      this.finished = true;
      this.log("Service complete. Every table is ready for tomorrow.");
    }
    // Guests may leave the entrance after 12 minutes; never abandon a seated party.
    for (let i = this.queue.length - 1; i >= 0; i--)
      if (this.now - this.queue[i].arrivedAt > 720) {
        this.metrics.turnedAway += this.queue[i].size;
        this.log(`Party ${this.queue[i].id} leaves the queue`, "departure");
        this.queue.splice(i, 1);
      }
  }
  seatGuests() {
    for (const t of this.tables) {
      if (t.stage !== "empty") continue;
      const index = this.queue.findIndex((p) => p.size <= t.seats);
      if (index < 0) continue;
      const [p] = this.queue.splice(index, 1);
      t.party = p;
      t.checked = false;
      t.request = undefined;
      t.bill = undefined; t.billReadyAt = undefined;
      t.course = undefined;
      t.drinksOrdered = false;
      t.diners = Array.from({ length: p.size }, (_, i) => ({
        id: i + 1,
        water: 0.75,
        item: this.config.menu[p.menuIndices[i]],
        behavior: p.behaviors[i],
        bathroomPlan: p.bathroomPlans[i],
        finished: false,
      }));
      t.deadline = this.now + guestTravelSeconds(this.layout, t);
      this.transition(t, "arriving");
      this.metrics.seated += p.size;
      this.metrics.seatingWaits.push(this.now - p.arrivedAt);
    }
  }
  startCourse(t: TableState, course: CourseKind) {
    t.course = course;
    t.checked = false;
    for (const d of t.diners) {
      const meal = t.party!.meals[d.id - 1];
      const index = meal.findIndex((choice) => this.config.menu[choice.menuIndex].course === course);
      const choice = meal[index];
      d.active = !!choice;
      d.finished = !choice;
      d.cleared = false;
      d.deliveredAt = undefined;
      d.eatUntil = undefined;
      d.eatenSeconds = 0;
      d.eatingTarget = choice?.eatingSeconds;
      d.courseNumber = index + 1;
      if (choice) d.item = this.config.menu[choice.menuIndex];
    }
    this.kitchen.submit(t, this.now);
    this.transition(t, "cooking");
    this.log(`Table ${t.id} · ${course} sent to kitchen: ${t.diners.filter((d) => d.active).map((d) => d.item.name).join(", ")}`, "kitchen");
  }
  updateTable(t: TableState, dt: number) {
    if (t.stage === "arriving" && this.now >= t.deadline) {
      for (const d of t.diners) d.seatedAt = this.now;
      this.transition(t, "greet");
      this.log(`Party ${t.party!.id} seated at table ${t.id}`, "arrival");
    }
    if (t.stage === "reading" && this.now >= t.deadline)
      this.transition(t, "order");
    if (t.stage === "dessert_reading" && this.now >= t.deadline)
      this.transition(t, "dessert_order");
    for (const d of t.diners) {
      const trip = d.restroomTrip;
      if (trip && this.now >= trip.startedAt + trip.walkSeconds * 2 + trip.insideSeconds) {
        d.restroomTrip = undefined;
        this.log(`Diner ${d.id} returns to table ${t.id}`);
      }
      if (!d.bathroomVisited && d.bathroomPlan && d.seatedAt !== undefined &&
          this.now >= d.seatedAt + d.bathroomPlan.afterSeconds &&
          ["reading", "cooking", "eating", "lingering"].includes(t.stage)) {
        const path = guestRoute(this.layout, t, d.id, this.layout.restroom);
        d.restroomTrip = { startedAt: this.now, path, walkSeconds: pathLength(path) / GUEST_SPEED, insideSeconds: d.bathroomPlan.duration };
        d.bathroomVisited = true;
        this.log(`Diner ${d.id} leaves table ${t.id} for the restroom`);
      }
    }
    if (["reading", "order", "cooking", "eating", "between", "dessert_offer", "dessert_reading", "dessert_order", "pay", "lingering"].includes(t.stage))
      for (const d of t.diners) {
        if (d.restroomTrip) continue;
        if (d.cocktail) d.cocktail.percent = Math.max(0, d.cocktail.percent - dt / 5);
        d.water = Math.max(0, d.water - dt / (240 + d.id * 35));
        this.metrics.occupiedDinerSeconds += dt;
        if (d.water < 0.01) this.metrics.emptyGlassSeconds += dt;
      }
    for (const d of t.diners) {
      if (d.deliveredAt !== undefined && !d.finished && d.eatingTarget !== undefined) {
        if (observeDiner(t, d, this.now).activity === "eating")
          d.eatenSeconds = Math.min(d.eatingTarget, (d.eatenSeconds ?? 0) + dt);
        d.finished = (d.eatenSeconds ?? 0) >= d.eatingTarget;
      } else if (d.eatUntil !== undefined && this.now >= d.eatUntil) d.finished = true;
    }
    if (t.stage === "eating" && t.diners.every((d) => d.finished && !d.restroomTrip) && !this.bar.tickets.some((d) => d.party === t.party?.id && d.deliveredAt === undefined)) {
      this.transition(t, t.course === "appetizer" ? "between" :
        t.course === "main" && this.config.menu.some((i) => i.course === "dessert") ? "dessert_offer" : "pay");
    }
    if (t.stage === "between" && t.diners.every((d) => d.deliveredAt === undefined || d.cleared))
      this.startCourse(t, "main");
    if (t.stage === "lingering" && this.now >= t.deadline && t.diners.every((d) => !d.restroomTrip)) {
      this.transition(t, "leaving");
      t.deadline = this.now + Math.max(t.party!.departureSeconds, guestTravelSeconds(this.layout, t));
      this.log(`Table ${t.id} finishes lingering and heads home`, "departure");
    }
    if (t.stage === "leaving" && this.now >= t.deadline) {
      this.transition(t, "dirty");
      t.request = undefined;
    }
    const p = t.party;
    if (t.bill === "presented" && this.now >= (t.billReadyAt ?? Infinity)) t.bill = "ready";
    if (p && t.stage === "pay" && !t.bill && !t.request &&
        this.now - t.since >= (p.billRequestDelay ?? 20) && t.diners.some((d) => !d.restroomTrip)) {
      this.raiseRequest(t, "bill", false);
    }
    if (this.config.interruptions && p && p.requestPlanned !== false && !p.requested && !t.request &&
        this.now >= (t.diners[0]?.seatedAt ?? p.arrivedAt) + (p.requestAt - p.arrivedAt) &&
        t.diners.some((d) => !d.restroomTrip) && ["reading", "order", "cooking", "eating"].includes(t.stage)) {
      // An accident needs the relevant item in use. Waiting guests cannot drop
      // a fork they have not started using or spill an empty glass.
      const possible = p.requestKind === "fork" ? t.diners.some((d) => !d.restroomTrip && d.deliveredAt !== undefined && !d.finished)
        : p.requestKind === "spill" ? t.diners.some((d) => !d.restroomTrip && d.water > .1) : true;
      if (possible) { p.requested = true; this.raiseRequest(t, p.requestKind, ["fork", "spill"].includes(p.requestKind)); }
    }
  }
  raiseRequest(t: TableState, kind: NonNullable<TableState["request"]>["kind"], visible: boolean) {
    const diner = t.diners.find((d) => !d.restroomTrip && (kind !== "fork" || (d.deliveredAt !== undefined && !d.finished)) && (kind !== "spill" || d.water > .1));
    if (!diner || t.request) return;
    t.request = { kind, visible, since: this.now, diner: diner.id, phase: "signalling" };
    if (kind === "spill") diner.water = 0;
    this.metrics.requestsRaised++;
    this.log(`Table ${t.id} ${kind === "fork" ? "drops a fork and signals for help" : kind === "spill" ? "spills water and signals for help" : "signals for a server"}`, "interrupt");
  }
  private noticeGuestSignal(s: Server) {
    if (s.job && ["request", "supplies", "bill"].includes(s.job.kind)) return;
    if (s.interruptUntil > this.now || s.plates.length || s.drinks.length || (s.job?.startedService && !s.job.path.length)) return;
    const t = this.tables.find((table) => table.request && !table.request.flagged &&
      (!table.reservedBy || table.reservedBy === s.id) &&
      this.now - table.request.since > 1 &&
      table.diners.some((d) => d.id === (table.request!.diner ?? 1) && !d.restroomTrip) &&
      canObserve(this.layout, s.position, table, s.heading, !!s.job?.path.length));
    if (!t || (s.job?.table === t.id && ["request", "supplies"].includes(s.job.kind))) return;
    // Both modes allow a human to notice a nearby gesture. Knowing that a
    // guest wants attention does not reveal why. They must walk to the table.
    s.memory.set(t.id, this.observe(t, "server"));
    this.release(s); s.itinerary = [];
    this.startJob(s, { id: `request:${t.id}`, kind: "request", table: t.id, party: t.party?.id,
      destination: t.approach, priority: 115, observedAt: this.now, reason: "Guest signals for attention", duration: durations.request });
    this.log(`${s.name} acknowledges table ${t.id} and approaches`, "interrupt");
  }
  private learnRequest(s: Server, t: TableState) {
    if (!t.request) return;
    t.request.phase = "awaiting_help";
    t.request.conversationServer = undefined;
    s.knownRequests.set(t.id, t.request.kind);
    if (this.config.voiceHints) t.request.reported = true;
    this.log(`${s.name} hears table ${t.id}'s request: ${t.request.kind}`, "interrupt");
  }
  private resolveRequest(s: Server, t: TableState) {
    if (!t.request) return;
    this.metrics.requestResolutionWaits.push(this.now - t.request.since);
    this.log(`${s.name} resolves ${t.request.kind} at table ${t.id}`);
    t.request = undefined;
    s.knownRequests.delete(t.id);
  }
  candidates(s: Server): Candidate[] {
    const tasks: Candidate[] = [];
    const add = (
      kind: ActionKind,
      destination: Candidate["destination"],
      priority: number,
      reason: string,
      table?: number,
      observedAt = this.now,
    ) =>
      tasks.push({
        id: `${kind}:${table ?? 0}`,
        kind,
        destination,
        priority,
        reason,
        table,
        observedAt,
        party: table ? s.memory.get(table)?.party : undefined,
        duration: durations[kind],
        dirtyLoad: table && ["bus", "clear"].includes(kind) ? Math.min(4 - s.dirty, kind === "bus" ? (s.memory.get(table)?.diners.length ?? 0) : (s.memory.get(table)?.finished.filter(Boolean).length ?? 0)) : 0,
        waterNeeded: table ? (s.memory.get(table)?.waters ?? []).filter((w) => w < 40).reduce((sum, w) => sum + (100 - w) / 100, 0) : 0,
      });
    if (s.plates.length) {
      const ids = [
        ...new Set(
          s.plates.map(
            (id) => this.kitchen.dishes.find((d) => d.id === id)!.table,
          ),
        ),
      ];
      for (const id of ids)
        add(
          "deliver",
          this.tables[id - 1].approach,
          155,
          "Hot food on tray",
          id,
        );
      return tasks;
    }
    if (s.drinks.length) {
      for (const id of new Set(s.drinks.map((id) => this.bar.tickets.find((d) => d.id === id)!.table)))
        add("drink_deliver", this.tables[id - 1].approach, 150, "Cocktails on tray", id);
      return tasks;
    }
    if (s.dirty) {
      add("drop", this.layout.kitchen, s.dirty >= 4 ? 140 : 40, "Return used dishes");
      if (s.dirty >= 4) return tasks;
    }
    if (s.supplies) {
      const t = this.tables[s.supplies.table - 1];
      add(
        "request",
        t.approach,
        140,
        `Bring ${s.supplies.kind} supplies`,
        t.id,
      );
      return tasks;
    }
    const ready = this.kitchen
      .ready(this.now)
      .filter(
        (d) =>
          !this.tables[d.table - 1].reservedBy ||
          this.tables[d.table - 1].reservedBy === s.id,
      );
    // Kitchen-ready tickets are shared notifications available to both controllers.
    if (ready.length && !s.dirty)
      add(
        "pickup",
        this.layout.kitchen,
        115 +
          Math.min(
            55,
            (this.now - Math.min(...ready.map((d) => d.readyAt))) * 0.3,
          ),
        "Kitchen ticket: food ready",
      );
    const drinks = this.bar.ready(this.now).filter((d) => !this.tables[d.table - 1].reservedBy || this.tables[d.table - 1].reservedBy === s.id);
    if (drinks.length && !s.dirty)
      add("bar_pickup", this.layout.bar, 110 + Math.min(55, (this.now - drinks[0].readyAt) * 0.3), "Bar ticket: cocktails ready");
    if (!s.pitcher || s.water < 0.5)
      add(
        "pitcher",
        this.layout.station,
        20 +
          ([...s.memory.values()].some((o) => o.waters.some((w) => w < 25))
            ? 65 + Math.max(0, 25 - Math.min(...[...s.memory.values()].flatMap((o) => o.waters))) * 2
            : 0),
        "Refill pitcher",
      );
    for (const o of s.memory.values()) {
      const t = this.tables[o.table - 1];
      // Reservations are operational coordination, not hidden customer evidence.
      if (t.reservedBy && t.reservedBy !== s.id) continue;
      const age = Math.min(65, (this.now - o.since) * 0.14),
        at = t.approach;
      if (this.now - o.at > this.config.memorySeconds) {
        add("patrol", at, 50 + Math.min(30, (this.now - o.at) * 0.03), "Refresh old table observations", t.id, o.at);
        continue;
      }
      if (o.stage === "greet")
        add("greet", at, 85 + age, "Guests waiting for menus", t.id, o.at);
      if (["order", "dessert_order"].includes(o.stage) && o.diners.some((d) => d.present))
        add("order", at, 85 + age, "Guests ready to order", t.id, o.at);
      if (o.stage === "dessert_offer" && !o.finished.some(Boolean))
        add("dessert", at, 80 + age, "Offer dessert menus", t.id, o.at);
      if (o.stage === "pay" && o.bill === "ready")
        add("pay", at, 85 + age, "Guest offers payment after reviewing bill", t.id, o.at);
      if (o.stage === "dirty" && o.diners.length <= 4 - s.dirty)
        add(
          "bus",
          at,
          65 + (this.queue.length ? 30 : 0) + age,
          "Reset table for next party",
          t.id,
          o.at,
        );
      if (
        ["reading", "order", "cooking", "eating", "between", "dessert_offer", "dessert_reading", "dessert_order", "pay", "lingering"].includes(o.stage) &&
        o.waters.some((w) => w < 25) &&
        s.water >= 0.5
      )
        add(
          "refill",
          at,
          Math.min(...o.waters) <= 5 ? 125 : 65 + (25 - Math.min(...o.waters)),
          "Water below 25%",
          t.id,
          o.at,
        );
      if (o.stage === "eating" && !o.checked && this.now - o.since > 25)
        add("check", at, 55 + age, "Check on the meal", t.id, o.at);
      if (["eating", "between", "dessert_offer", "lingering"].includes(o.stage) && o.finished.some(Boolean))
        add("clear", at, 70, "Some diners have finished", t.id, o.at);
      if (o.request && !["dirty", "empty", "leaving"].includes(o.stage) &&
          (!t.request?.acknowledgedBy || t.request.acknowledgedBy === s.id)) {
        const supplies = ["fork", "spill", "dessert"].includes(o.request);
        add(
          o.request === "bill" ? "bill" : supplies ? "supplies" : "request",
          supplies ? this.layout.station : at,
          105,
          o.request === "unknown"
            ? "Investigate guest request"
            : `Guest needs help: ${o.request}`,
          t.id,
          o.at,
        );
      }
    }
    for (const t of this.tables) if (!s.memory.has(t.id) && !t.reservedBy)
      add("patrol", t.approach, 25 + Math.min(45, this.now * 0.025), "Unobserved table", t.id);
    if (!tasks.length) {
      // Visit least recently observed tables; rotate ties to distribute patrol coverage.
      const sorted = [...this.tables]
        .filter((t) => !t.reservedBy)
        .sort(
          (a, b) =>
            (s.memory.get(a.id)?.at ?? -1000) -
              (s.memory.get(b.id)?.at ?? -1000) ||
            ((a.id + s.id) % this.tables.length) -
              ((b.id + s.id) % this.tables.length),
        );
      const target = sorted[0];
      if (target)
        add("patrol", target.approach, 0, "Check the dining room", target.id);
    }
    return tasks;
  }
  assign(s: Server) {
    const candidates = this.candidates(s);
    // Itineraries are intentions, not reservations or permission to execute stale actions.
    const planned = s.itinerary[0];
    let chosen = planned && candidates.find((c) => c.id === planned.id && c.party === planned.party);
    if (planned && (!chosen || candidates.some((c) => c.priority > chosen!.priority + 35 || (["pickup", "bar_pickup"].includes(c.kind) && c.priority >= 128)))) {
      this.metrics.staleStops += s.itinerary.length;
      s.itinerary = [];
      chosen = undefined;
    }
    if (chosen) {
      s.itinerary.shift();
      this.startJob(s, chosen);
      return;
    }
    const travelSeconds: DecisionContext["travelSeconds"] = { start: {} };
    for (const c of candidates) {
      travelSeconds.start[c.id] = routeDistance(this.layout, s.position, c.destination) / 1.25;
      travelSeconds[c.id] = {};
      if (this.controller.plan || this.options.externalDecisions) for (const other of candidates)
        travelSeconds[c.id][other.id] = routeDistance(this.layout, c.destination, other.destination) / 1.25;
    }
    const ctx: DecisionContext = {
      now: this.now,
      server: {
        id: s.id,
        position: { ...s.position },
        plates: s.plates.length,
        drinks: s.drinks.length,
        dirty: s.dirty,
        water: s.water,
      },
      observations: structuredClone([...s.memory.values()]),
      candidates,
      travelSeconds,
    };
    this.lastDecision = structuredClone(ctx);
    this.metrics.decisions++;
    if (this.options.externalDecisions && candidates.length > 1) {
      this.pendingDecision = { id: ++this.decisionSerial, context: structuredClone(ctx) };
      return;
    }
    const ids = this.options.externalDecisions ? candidates.map((c) => c.id) : this.controller.plan ? this.controller.plan(structuredClone(ctx)) : [this.controller.choose(structuredClone(ctx))];
    this.applyPlan(s, candidates, ids);
  }
  resolveDecision(id: number, ids: string[]) {
    const pending = this.pendingDecision;
    if (!pending || pending.id !== id) throw Error("Expired decision response.");
    if (!ids.length || ids.length > 3 || new Set(ids).size !== ids.length || ids.some((id) => !pending.context.candidates.some((c) => c.id === id)))
      throw Error("The model returned an invalid itinerary. Simulation remains paused.");
    this.applyPlan(this.servers[pending.context.server.id - 1], pending.context.candidates, ids);
    this.pendingDecision = undefined;
  }
  private applyPlan(s: Server, candidates: Candidate[], ids: (string | undefined)[]) {
    const validPlan = ids.map((id) => candidates.find((c) => c.id === id));
    // Reject the whole plan if any step was invented or repeated.
    if (validPlan.some((c) => !c) || new Set(ids).size !== ids.length || ids.length > 3) validPlan.length = 0;
    const chosen = validPlan[0];
    this.options.observer?.plan?.(structuredClone(this.lastDecision!), [...ids], !!chosen);
    if (!chosen) {
      s.status = "Waiting for a feasible task";
      s.nextDecisionAt = this.now + 2;
      return;
    }
    s.itinerary = validPlan.slice(1) as Candidate[];
    this.metrics.plans++;
    if (s.itinerary.length) this.metrics.multiStopPlans++;
    this.startJob(s, chosen);
  }
  startJob(s: Server, chosen: Candidate) {
    if (chosen.table && chosen.kind !== "patrol") this.metrics.observationAges.push(this.now - chosen.observedAt);
    if (chosen.table) this.tables[chosen.table - 1].reservedBy = s.id;
    if (chosen.table && ["request", "supplies", "bill"].includes(chosen.kind)) {
      const request = this.tables[chosen.table - 1].request;
      if (request) { if (chosen.kind === "request") request.phase = "approaching"; request.acknowledgedBy = s.id; }
    }
    s.job = {
      ...chosen,
      path: findPath(this.layout, s.position, chosen.destination),
      serviceLeft: durations[chosen.kind],
      startedService: false,
    };
    s.status = this.label(chosen);
    this.options.observer?.action?.({ at: this.now, server: s.id, event: "start", action: structuredClone(chosen) });
  }
  label(job: Candidate) {
    return (
      {
        bar_pickup: "Collect cocktails",
        drink_deliver: "Serve cocktails",
        dessert: "Offer dessert menus",
        greet: "Bring menus",
        order: "Take order",
        pickup: "Collect hot food",
        deliver: "Serve food",
        refill: "Top up water",
        check: "How is everything?",
        bill: "Present bill",
        pay: "Take payment",
        bus: "Clear & reset",
        clear: "Collect finished plates",
        supplies: "Collect guest supplies",
        request: "Help guest",
        pitcher: "Refill pitcher",
        drop: "Drop used dishes",
        patrol: "Patrol",
      }[job.kind] + (job.table ? ` · T${job.table}` : "")
    );
  }
  execute(s: Server, dt: number) {
    const j = s.job!;
    if (j.path.length) {
      let remaining = dt * 1.25;
      while (remaining > 0 && j.path.length) {
        const next = j.path[0],
          d = distance(s.position, next),
          travel = Math.min(d, remaining);
        if (d > 0) {
          s.heading = Math.atan2(next.x - s.position.x, next.y - s.position.y);
          s.position.x += ((next.x - s.position.x) / d) * travel;
          s.position.y += ((next.y - s.position.y) / d) * travel;
        }
        s.walking += travel;
        this.metrics.walking += travel;
        remaining -= travel;
        if (d <= travel + 1e-9) {
          s.position = { ...next };
          j.path.shift();
        } else break;
      }
      return;
    }
    if (distance(s.position, j.destination) > 0.1) {
      this.release(s);
      s.status = "Route unavailable";
      return;
    }
    const target = j.table ? this.tables[j.table - 1] : undefined;
    if (!j.startedService && j.kind === "request" && target?.request) {
      const request = target.request;
      if (!target.diners.some((d) => d.id === (request.diner ?? 1) && !d.restroomTrip)) {
        request.phase = "signalling"; request.acknowledgedBy = undefined;
        this.release(s); return;
      }
      const fulfilling = s.supplies?.table === target.id && s.supplies.kind === request.kind;
      request.phase = fulfilling ? "awaiting_help" : "discussing"; request.conversationServer = s.id;
      if (!request.flagged) {
        request.flagged = true;
        this.metrics.requestResponseWaits.push(this.now - request.since);
        this.metrics.interruptions++;
      }
      s.interruptTable = target.id; s.interruptUntil = this.now + j.serviceLeft;
      s.status = `${fulfilling ? "Helping" : "Speaking with"} guests · T${target.id}`;
      this.log(`${s.name} reaches table ${target.id} ${fulfilling ? "with the requested supplies" : "and asks what they need"}`, "interrupt");
    }
    j.startedService = true;
    j.serviceLeft -= dt;
    if (j.serviceLeft <= 0) {
      this.complete(s, j);
      s.completed++;
      this.release(s, true);
      if (j.kind === "patrol") {
        s.nextDecisionAt = this.now + (s.itinerary.length ? 0 : 3);
        s.status = "Observing the floor";
      }
    }
  }
  release(s: Server, completed = false) {
    if (s.job && this.options.observer?.action) {
      const { path, serviceLeft, startedService, ...action } = s.job;
      this.options.observer.action({ at: this.now, server: s.id, event: completed ? "complete" : "cancel", action: structuredClone(action) });
    }
    for (const t of this.tables)
      if (t.reservedBy === s.id) t.reservedBy = undefined;
    s.job = undefined;
  }
  complete(s: Server, j: Job) {
    const t = j.table ? this.tables[j.table - 1] : undefined;
    if (j.kind === "pickup") {
      const ready = this.kitchen
        .ready(this.now)
        .filter(
          (d) =>
            !this.tables[d.table - 1].reservedBy ||
            this.tables[d.table - 1].reservedBy === s.id,
        )
        .sort((a, b) => a.readyAt - b.readyAt);
      for (const d of ready.slice(0, 4 - s.plates.length - s.drinks.length)) {
        d.pickedAt = this.now;
        d.carriedBy = s.id;
        s.plates.push(d.id);
      }
      if (s.plates.length)
        this.log(`${s.name} picks up ${s.plates.length} dishes`, "kitchen");
    } else if (j.kind === "bar_pickup") {
      const ready = this.bar.ready(this.now).filter((d) => !this.tables[d.table - 1].reservedBy || this.tables[d.table - 1].reservedBy === s.id);
      for (const drink of ready.slice(0, 4 - s.plates.length - s.drinks.length)) {
        drink.pickedAt = this.now;
        drink.carriedBy = s.id;
        s.drinks.push(drink.id);
      }
      if (s.drinks.length) this.log(`${s.name} collects ${s.drinks.length} cocktails from the bar`);
    } else if (j.kind === "pitcher") {
      s.pitcher = true;
      s.water = 4;
    } else if (j.kind === "drop") {
      s.dirty = 0;
    }
    if (!t) return;
    if (j.kind === "supplies") {
      const kind = s.memory.get(t.id)?.request;
      if (kind && kind !== "unknown") s.supplies = { table: t.id, kind };
      return;
    }
    // Validate against current state: stale observations cannot force an invalid transition.
    if (j.kind === "greet" && t.stage === "greet") {
      this.metrics.greetingWaits.push(this.now - t.since);
      this.transition(t, "reading");
      t.deadline = this.now + t.party!.readingSeconds;
      this.log(`${s.name} welcomes table ${t.id} with menus`);
      if (!t.drinksOrdered) {
        this.bar.submit(t.id, t.party!.id, t.party!.cocktails, this.now);
        t.drinksOrdered = true;
        const count = t.party!.cocktails.filter(Boolean).length;
        if (count) this.log(`Table ${t.id} orders ${count} cocktails`);
      }
    }
    if (j.kind === "drink_deliver" && !["empty", "dirty", "leaving"].includes(t.stage)) {
      for (const id of [...s.drinks]) {
        const drink = this.bar.tickets.find((d) => d.id === id)!;
        if (drink.table !== t.id || drink.party !== t.party?.id) continue;
        drink.deliveredAt = this.now;
        drink.carriedBy = undefined;
        t.diners[drink.diner - 1].cocktail = { ...drink.item, percent: 100 };
        s.drinks.splice(s.drinks.indexOf(id), 1);
        this.metrics.drinkWaits.push(this.now - drink.readyAt);
        this.metrics.drinkOrderWaits.push(this.now - drink.orderedAt);
        this.metrics.cocktailsServed++;
      }
      this.log(`${s.name} serves cocktails at table ${t.id}`);
    }
    if (j.kind === "dessert" && t.stage === "dessert_offer" && t.diners.every((d) => d.deliveredAt === undefined || d.cleared)) {
      const wantsDessert = t.party!.meals.some((meal) => meal.some((choice) => this.config.menu[choice.menuIndex].course === "dessert"));
      this.transition(t, wantsDessert ? "dessert_reading" : "pay");
      t.deadline = this.now + t.party!.readingSeconds * 0.6;
      this.log(`Table ${t.id} ${wantsDessert ? "looks at dessert menus" : "declines dessert"}`);
    }
    if (j.kind === "order" && ["order", "dessert_order"].includes(t.stage) && t.diners.some((d) => !d.restroomTrip)) {
      this.metrics.orderWaits.push(this.now - t.since);
      const course = t.stage === "dessert_order" ? "dessert" :
        t.party!.meals.some((meal) => meal.some((choice) => this.config.menu[choice.menuIndex].course === "appetizer")) ? "appetizer" : "main";
      this.startCourse(t, course);
    }
    if (j.kind === "deliver" && ["cooking", "eating"].includes(t.stage)) {
      for (const id of [...s.plates]) {
        const dish = this.kitchen.dishes.find((d) => d.id === id)!;
        if (dish.table !== t.id || dish.party !== t.party?.id || dish.item.course !== t.course) continue;
        const d = t.diners[dish.diner - 1];
        d.deliveredAt = this.now;
        dish.deliveredAt = this.now;
        dish.carriedBy = undefined;
        s.plates.splice(s.plates.indexOf(id), 1);
        this.metrics.foodWaits.push(this.now - dish.readyAt);
      }
      if (t.stage === "cooking") this.transition(t, "eating");
      this.log(`${s.name} serves food at table ${t.id}`);
    }
    if (j.kind === "check" && t.stage === "eating") {
      t.checked = true;
      this.log(`${s.name} checks on table ${t.id}`);
    }
    if (j.kind === "request") {
      if (t.request) {
        this.learnRequest(s, t);
        if (t.request.kind === "question" || s.supplies?.kind === t.request.kind) this.resolveRequest(s, t);
      }
      s.supplies = undefined;
      s.interruptTable = undefined; s.interruptUntil = 0;
      s.itinerary = [];
    }
    if (j.kind === "bill" && t.stage === "pay" && !t.bill && t.request?.kind === "bill") {
      this.resolveRequest(s, t);
      t.bill = "presented";
      t.billReadyAt = this.now + (t.party?.billReviewSeconds ?? 20);
      this.log(`${s.name} presents the bill at table ${t.id}; guests review it`);
    }
    if (j.kind === "clear")
      for (const d of t.diners)
        if (d.deliveredAt !== undefined && d.finished && !d.cleared && s.dirty < 4) {
          d.cleared = true;
          s.dirty++;
        }
    if (j.kind === "pay" && t.stage === "pay" && t.bill === "ready") {
      this.metrics.paymentWaits.push(this.now - t.since);
      this.metrics.completed += t.diners.length;
      this.metrics.revenue += this.kitchen.dishes.filter((d) => d.party === t.party!.id && d.deliveredAt !== undefined).reduce((sum, d) => sum + d.item.price, 0);
      this.metrics.revenue += this.bar.tickets.filter((d) => d.party === t.party!.id && d.deliveredAt !== undefined).reduce((sum, d) => sum + d.item.price, 0);
      this.transition(t, t.party!.lingerSeconds ? "lingering" : "leaving");
      t.deadline = this.now + (t.party!.lingerSeconds || Math.max(t.party!.departureSeconds, guestTravelSeconds(this.layout, t)));
      t.request = undefined;
      this.log(`Table ${t.id} pays${t.party!.lingerSeconds ? " and lingers over conversation" : " and heads home"}`, "departure");
    }
    if (j.kind === "bus" && t.stage === "dirty" && s.dirty + t.diners.length <= 4) {
      s.dirty += t.diners.length;
      t.diners = [];
      t.party = undefined;
      this.transition(t, "empty");
      this.log(`${s.name} resets table ${t.id}`);
    }
    // Combine a water top-up with another table visit when carrying a pitcher.
    if (
      s.pitcher &&
      s.water > 0 &&
      !["dirty", "empty", "leaving"].includes(t.stage)
    )
      for (const d of t.diners)
        if (d.water < 0.4) {
          const amount = Math.min(1 - d.water, s.water);
          d.water += amount;
          s.water -= amount;
        }
    const observation = this.observe(t, "server");
    if (t.request && s.knownRequests.has(t.id)) observation.request = s.knownRequests.get(t.id);
    s.memory.set(t.id, observation);
  }
  export() {
    return {
      schemaVersion: 6,
      decisionSource: this.options.externalDecisions ? "external AI adapter (held-clock benchmark; see adapter metadata for provider)" : "rules",
      config: this.config,
      layout: { ...this.layout, blocked: [...this.layout.blocked] },
      barTickets: this.bar.tickets,
      simulatedSeconds: this.now,
      finished: this.finished,
      metrics: this.metrics,
      scenario: this.scenario,
      recentEvents: this.events,
      cameraSnapshots: this.snapshots,
      lastDecision: this.lastDecision,
      notes: [
        this.options.externalDecisions ? "External inference usage is recorded by the adapter, outside the simulation engine." : "Rules-only run; no external inference.",
        "Guest requests use signalling, approach, conversation and follow-up. Cameras cannot infer opaque intent before a server report; visible accidents can be identified directly.",
        "Extra request opportunities default to 20% per party (10% fork, 10% spill, 80% question conditional on an opportunity). These are uncalibrated assumptions. Routine bill requests are separate.",
        "Bills are requested in person, presented at the table using an abstract mobile POS, reviewed, then paid. Printing, split checks, tips and payment failures are not modeled.",
        "Kitchen capacity is unlimited; per-item preparation timers.",
        "Planner and evidence source are independent settings. No baseline is empirically calibrated to experienced staff.",
        "Local scans inspect one visible table per configured interval; observations older than the memory horizon trigger a revisit.",
        "Three-stop plans use routed travel times and inventory limits, with validation at each stop. Bar production is FIFO per bartender; cocktails are ordered at greeting.",
        "Camera snapshot history covers this run in memory, at the configured cadence.",
        "Seeded optional appetizers and desserts; mains fire after appetizer plates are cleared. Dessert is offered after mains.",
        "Simulated classifier outputs: course completion tracks active eating; talking and phone use pause eating. Some paid parties linger.",
        "Seeded restroom visits pause eating and drinking; table observations report absence and visible walking positions, never private restroom activity. Restroom capacity is abstracted.",
      ],
    };
  }
}
export const average = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
