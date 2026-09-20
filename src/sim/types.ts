export type Point = { x: number; y: number };
export type Mode = "patrol" | "camera";
export type CourseKind = "appetizer" | "main" | "dessert";
export type Stage =
  | "empty"
  | "arriving"
  | "greet"
  | "reading"
  | "order"
  | "cooking"
  | "eating"
  | "between"
  | "dessert_offer"
  | "dessert_reading"
  | "dessert_order"
  | "lingering"
  | "pay"
  | "leaving"
  | "dirty";
export type RequestKind = "fork" | "spill" | "dessert" | "question" | "bill";
export interface MenuItem {
  course: CourseKind;
  id: string;
  name: string;
  seconds: number;
  price: number;
  color: string;
}
export interface Config {
  planner: "greedy" | "route";
  layoutStyle: "classic" | "courtyard" | "staggered";
  stationPlacement: "front" | "split";
  aisleWidth: number;
  observationSeconds: number;
  memorySeconds: number;
  cocktailRate: number;
  bartenders: number;
  name: string;
  tables: number;
  rooms: number;
  servers: number;
  seats: number;
  arrivals: number;
  duration: number;
  seed: number;
  snapshotSeconds: number;
  mode: Mode;
  interruptions: boolean;
  requestRate?: number;
  voiceHints: boolean;
  appetizerRate: number;
  dessertRate: number;
  phoneRate: number;
  lingerRate: number;
  bathroomRate: number;
  menu: MenuItem[];
}
export interface TableDef extends Point {
  id: number;
  room: number;
  seats: number;
  approach: Point;
}
export interface Layout {
  bar: Point;
  obstacles: { id: string; kind: "fountain" | "screen"; x: number; y: number; width: number; height: number; occludes: boolean }[];
  width: number;
  height: number;
  tables: TableDef[];
  kitchen: Point;
  station: Point;
  entrance: Point;
  restroom: Point;
  blocked: Set<string>;
  roomBounds: { x: number; width: number }[];
}
export interface Diner {
  cocktail?: { id: string; name: string; color: string; percent: number };
  seatedAt?: number;
  bathroomPlan?: { afterSeconds: number; duration: number } | null;
  bathroomVisited?: boolean;
  restroomTrip?: { startedAt: number; path: Point[]; walkSeconds: number; insideSeconds: number };
  active?: boolean;
  courseNumber?: number;
  eatenSeconds?: number;
  eatingTarget?: number;
  behavior?: { phonePeriod: number; phoneSeconds: number; phase: number };
  id: number;
  water: number;
  item: MenuItem;
  deliveredAt?: number;
  eatUntil?: number;
  finished: boolean;
  cleared?: boolean;
}
export interface Party {
  cocktails: (string | null)[];
  bathroomPlans: ({ afterSeconds: number; duration: number } | null)[];
  meals: { menuIndex: number; eatingSeconds: number }[][];
  behaviors: { phonePeriod: number; phoneSeconds: number; phase: number }[];
  lingerSeconds: number;
  id: number;
  size: number;
  arrivedAt: number;
  readingSeconds: number;
  eatingSeconds: number;
  departureSeconds: number;
  menuIndices: number[];
  requestAt: number;
  requestKind: RequestKind;
  requested: boolean;
  requestPlanned?: boolean;
  billRequestDelay?: number;
  billReviewSeconds?: number;
}
export interface TableState extends TableDef {
  drinksOrdered?: boolean;
  course?: CourseKind;
  stage: Stage;
  since: number;
  party?: Party;
  diners: Diner[];
  deadline: number;
  checked: boolean;
  request?: {
    kind: RequestKind;
    visible: boolean;
    since: number;
    flagged?: boolean;
    diner?: number;
    phase?: "signalling" | "approaching" | "discussing" | "awaiting_help";
    acknowledgedBy?: number;
    conversationServer?: number;
    reported?: boolean;
  };
  bill?: "presented" | "ready";
  billReadyAt?: number;
  reservedBy?: number;
}
export interface Dish {
  id: string;
  table: number;
  party: number;
  diner: number;
  item: MenuItem;
  readyAt: number;
  pickedAt?: number;
  deliveredAt?: number;
  carriedBy?: number;
}
export interface KitchenPort {
  submit(table: TableState, now: number): void;
  ready(now: number): Dish[];
  dishes: Dish[];
}
export interface TableObservation {
  table: number;
  room: number;
  at: number;
  source: "camera" | "server";
  stage: Stage;
  party?: number;
  waters: number[];
  finished: boolean[];
  diners: DinerObservation[];
  checked: boolean;
  request?: RequestKind | "unknown";
  requestPhase?: "signalling" | "approaching" | "discussing" | "awaiting_help";
  bill?: "presented" | "ready";
  since: number;
  position: Point;
}
export interface DinerObservation {
  cocktail?: { name: string; percent: number };
  position?: Point;
  diner: number;
  present: boolean;
  activity:
    | "walking"
    | "reading menu"
    | "talking"
    | "using phone"
    | "eating"
    | "waiting"
    | "finished eating"
    | "absent"
    | "signalling for service"
    | "speaking to server"
    | "reading bill"
    | "offering payment";
  waterPercent: number;
  plate: "not served" | "food present" | "empty" | "cleared";
  course: { number: number; kind: CourseKind; name: string; completionPercent: number } | null;
}
export type ActionKind =
  | "bill"
  | "bar_pickup"
  | "drink_deliver"
  | "dessert"
  | "greet"
  | "order"
  | "pickup"
  | "deliver"
  | "refill"
  | "check"
  | "pay"
  | "bus"
  | "clear"
  | "request"
  | "supplies"
  | "pitcher"
  | "drop"
  | "patrol";
export interface Candidate {
  /** Tables whose ready food or cocktails a station pickup would collect; shared kitchen/bar facts, not guest evidence. */
  serves?: number[];
  /** Summed per-table age of those ready tickets, in seconds. */
  waitingSeconds?: number;
  party?: number;
  duration?: number;
  dirtyLoad?: number;
  waterNeeded?: number;
  id: string;
  kind: ActionKind;
  table?: number;
  destination: Point;
  priority: number;
  reason: string;
  observedAt: number;
}
export interface Job extends Candidate {
  path: Point[];
  serviceLeft: number;
  startedService: boolean;
}
export interface Server {
  drinks: string[];
  itinerary: Candidate[];
  nextObservationAt: number;
  heading: number;
  id: number;
  name: string;
  color: string;
  position: Point;
  job?: Job;
  memory: Map<number, TableObservation>;
  knownRequests: Map<number, RequestKind>;
  supplies?: { table: number; kind: RequestKind };
  plates: string[];
  dirty: number;
  pitcher: boolean;
  water: number;
  walking: number;
  completed: number;
  interruptUntil: number;
  interruptTable?: number;
  lastPatrol: number;
  nextDecisionAt?: number;
  status: string;
}
export interface DecisionContext {
  now: number;
  server: {
    id: number;
    position: Point;
    plates: number;
    drinks: number;
    dirty: number;
    water: number;
  };
  observations: TableObservation[];
  candidates: Candidate[];
  travelSeconds: Record<string, Record<string, number>>;
}
/** A controller sees observed evidence and feasible candidates only, never World. */
export interface DecisionEngine {
  readonly id: string;
  choose(context: DecisionContext): string | undefined;
  plan?(context: DecisionContext): string[];
}
/** Diagnostic observers receive detached records and never influence controllers. */
export interface SimulationObserver {
  plan?(context: DecisionContext, ids: (string | undefined)[], accepted: boolean): void;
  action?(event: { at: number; server: number; event: "start" | "complete" | "cancel"; action: Candidate }): void;
  transition?(event: { at: number; table: number; party?: number; from: Stage; to: Stage; since: number }): void;
}
export interface CameraSnapshot {
  at: number;
  tables: TableObservation[];
  servers: {
    id: number;
    position: Point;
    status: string;
    interrupted: boolean;
  }[];
}
export interface SimEvent {
  at: number;
  text: string;
  type: "arrival" | "service" | "kitchen" | "interrupt" | "departure";
}
export interface Metrics {
  drinkWaits: number[];
  drinkOrderWaits: number[];
  cocktailsServed: number;
  plans: number;
  multiStopPlans: number;
  staleStops: number;
  observationAges: number[];
  arrived: number;
  seated: number;
  completed: number;
  turnedAway: number;
  revenue: number;
  walking: number;
  emptyGlassSeconds: number;
  occupiedDinerSeconds: number;
  greetingWaits: number[];
  orderWaits: number[];
  foodWaits: number[];
  paymentWaits: number[];
  seatingWaits: number[];
  interruptions: number;
  requestsRaised: number;
  requestResponseWaits: number[];
  requestResolutionWaits: number[];
  decisions: number;
}
