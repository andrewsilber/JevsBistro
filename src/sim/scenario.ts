import type { Config, Party } from "./types";
import { COCKTAILS } from "./bar";
export const DEFAULT_CONFIG: Config = {
  planner: "route",
  layoutStyle: "classic",
  stationPlacement: "front",
  aisleWidth: 1,
  observationSeconds: 2,
  memorySeconds: 90,
  cocktailRate: 35,
  bartenders: 1,
  name: "The Juniper Room",
  tables: 8,
  rooms: 1,
  servers: 2,
  seats: 4,
  arrivals: 18,
  duration: 30,
  seed: 42,
  snapshotSeconds: 1,
  mode: "patrol",
  interruptions: true,
  requestRate: 20,
  voiceHints: true,
  appetizerRate: 45,
  dessertRate: 40,
  phoneRate: 35,
  lingerRate: 30,
  bathroomRate: 20,
  menu: [
    {
      id: "salad",
      course: "appetizer",
      name: "Garden salad",
      seconds: 100,
      price: 14,
      color: "#679660",
    },
    {
      id: "pasta",
      course: "main",
      name: "Bistro pasta",
      seconds: 180,
      price: 22,
      color: "#e9b44b",
    },
    {
      id: "fish",
      course: "main",
      name: "Pan-seared fish",
      seconds: 240,
      price: 28,
      color: "#f2bd91",
    },
    { id: "soup", course: "appetizer", name: "Roasted tomato soup", seconds: 75, price: 9, color: "#bc6040" },
    { id: "bruschetta", course: "appetizer", name: "Tomato bruschetta", seconds: 90, price: 11, color: "#c88949" },
    { id: "steak", course: "main", name: "Steak frites", seconds: 300, price: 32, color: "#89583e" },
    { id: "cake", course: "dessert", name: "Chocolate cake", seconds: 60, price: 10, color: "#633e2e" },
    { id: "tart", course: "dessert", name: "Lemon tart", seconds: 45, price: 9, color: "#e8d46b" },
    { id: "icecream", course: "dessert", name: "Vanilla ice cream", seconds: 30, price: 7, color: "#f5e8bf" },
  ],
};
export function random(seed: number) {
  let n = seed >>> 0;
  return () => {
    n += 0x6d2b79f5;
    let t = n;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function validateConfig(c: Config): void {
  if (!Number.isFinite(c.requestRate ?? 20) || (c.requestRate ?? 20) < 0 || (c.requestRate ?? 20) > 100)
    throw Error("Extra guest request chance must be between 0 and 100 percent.");
  for (const [field, low, high] of [
    ["tables", 2, 24],
    ["rooms", 1, 3],
    ["servers", 1, 6],
    ["seats", 2, 4],
    ["arrivals", 4, 90],
    ["duration", 5, 120],
    ["snapshotSeconds", 0.5, 10],
    ["appetizerRate", 0, 100],
    ["dessertRate", 0, 100],
    ["phoneRate", 0, 100],
    ["lingerRate", 0, 100],
    ["bathroomRate", 0, 100],
    ["cocktailRate", 0, 100],
    ["bartenders", 1, 3],
    ["aisleWidth", 1, 3],
    ["observationSeconds", 1, 10],
    ["memorySeconds", 30, 300],
  ] as const) {
    if (!Number.isFinite(c[field]) || c[field] < low || c[field] > high)
      throw Error(`Invalid ${field}: expected ${low}–${high}.`);
  }
  for (const field of [
    "tables",
    "rooms",
    "servers",
    "seats",
    "arrivals",
    "duration",
    "seed",
    "aisleWidth", "bartenders",
  ] as const)
    if (!Number.isInteger(c[field]))
      throw Error(`${field} must be an integer.`);
  if (
    c.rooms > c.tables ||
    !["greedy", "route"].includes(c.planner) ||
    !["classic", "courtyard", "staggered"].includes(c.layoutStyle) ||
    !["front", "split"].includes(c.stationPlacement) ||
    !["patrol", "camera"].includes(c.mode) ||
    !c.name.trim() ||
    c.name.length > 60 ||
    c.seed < 0 ||
    c.seed > 2147483647
  )
    throw Error("Invalid restaurant configuration.");
  if (
    !c.menu.length ||
    !c.menu.some((i) => i.course === "main") ||
    new Set(c.menu.map((i) => i.id)).size !== c.menu.length ||
    c.menu.some(
      (i) =>
        !["appetizer", "main", "dessert"].includes(i.course) ||
        !i.name.trim() ||
        !Number.isFinite(i.seconds) ||
        i.seconds < 10 ||
        i.seconds > 1800 ||
        !Number.isFinite(i.price) ||
        i.price < 0,
    )
  )
    throw Error(
      "Include at least one main. Menu items need a course, unique IDs, names, valid prices, and preparation times of 10–1800 seconds.",
    );
}
/** All guest attributes are drawn up front, unaffected by controller decisions. */
/** Copy only restaurant configuration fields, never runtime state or provider credentials. */
export function copyConfig(value: Config): Config {
  const config = Object.fromEntries(Object.keys(DEFAULT_CONFIG).map((key) => [key, value[key as keyof Config] ?? DEFAULT_CONFIG[key as keyof Config]])) as unknown as Config;
  config.menu = value.menu.map(({ id, name, course, seconds, price, color }) => ({ id, name, course, seconds, price, color }));
  validateConfig(config);
  return structuredClone(config);
}
export function createScenario(c: Config): Party[] {
  const rng = random(c.seed),
    drinkRng = random(c.seed ^ 0x51a73b),
    requestRng = random(c.seed ^ 0x6b34f1),
    parties: Party[] = [];
  let at = 3;
  while (at < c.duration * 60) {
    const size = Math.min(c.seats, 1 + Math.floor(rng() * 4));
    const meals = Array.from({ length: size }, () => {
      const pace = 0.75 + rng() * 0.65;
      return (["appetizer", "main", "dessert"] as const).flatMap((course) => {
        const wants = course === "main" || rng() * 100 < (course === "appetizer" ? c.appetizerRate : c.dessertRate);
        const choices = c.menu.map((item, index) => ({ item, index })).filter(({ item }) => item.course === course);
        if (!wants || !choices.length) return [];
        return [{ menuIndex: choices[Math.floor(rng() * choices.length)].index,
          eatingSeconds: (course === "main" ? 160 + rng() * 140 : 65 + rng() * 75) * pace }];
      });
    });
    parties.push({
      id: parties.length + 1,
      size,
      cocktails: Array.from({ length: size }, () => {
        const wants = drinkRng() * 100 < c.cocktailRate;
        const item = COCKTAILS[Math.floor(drinkRng() * COCKTAILS.length)];
        return wants ? item.id : null;
      }),
      meals,
      behaviors: Array.from({ length: size }, () => ({ phonePeriod: 80 + rng() * 80,
        phoneSeconds: rng() * 100 < c.phoneRate ? 12 + rng() * 25 : 0, phase: rng() * 160 })),
      lingerSeconds: rng() * 100 < c.lingerRate ? 60 + rng() * 240 : 0,
      bathroomPlans: Array.from({ length: size }, () => {
        const wantsVisit = rng() * 100 < c.bathroomRate;
        const plan = { afterSeconds: 90 + rng() * 330, duration: 45 + rng() * 75 };
        return wantsVisit ? plan : null;
      }),
      arrivedAt: at,
      readingSeconds: 25 + rng() * 45,
      eatingSeconds: 120 + rng() * 180,
      departureSeconds: 8 + rng() * 6,
      menuIndices: meals.map((meal) => meal.find((dish) => c.menu[dish.menuIndex].course === "main")!.menuIndex),
      requestAt: at + 150 + rng() * 320,
      // Keep the same number of scenario draws; request frequency has its own
      // stream so tuning it cannot change arrivals, meals, or guest behavior.
      requestKind: (["fork", "spill", "question", "question", "question", "question", "question", "question", "question", "question"] as const)[Math.floor(rng() * 10)],
      requestPlanned: requestRng() * 100 < (c.requestRate ?? 20),
      billRequestDelay: 12 + requestRng() * 23,
      billReviewSeconds: 12 + requestRng() * 28,
      requested: false,
    });
    at += Math.max(12, (-Math.log(Math.max(0.001, rng())) * 3600) / c.arrivals);
  }
  return parties;
}
