import type { Diner, DinerObservation, TableState } from "./types";
import { GUEST_SPEED, samplePath } from "./movement";

/** Deterministic proxy for a vision classifier, not live image recognition.
 * The same apparent activity drives the scene and recorded observations.
 * It consumes no scenario RNG. Eating progresses only during eating activity.
 */
export function observeDiner(
  table: TableState,
  diner: Diner,
  now: number,
): DinerObservation {
  let activity: DinerObservation["activity"] = "waiting";
  let courseCompletion: number | null = null;
  const present = !["empty", "dirty"].includes(table.stage) && !diner.restroomTrip;
  const hasPlate = diner.deliveredAt !== undefined && !diner.cleared;
  const speaking =
    (Math.floor(now) + (table.party?.id ?? 0) * 13 + diner.id * 7) % 36 < 9;
  const onPhone = diner.behavior &&
    (now + diner.behavior.phase) % diner.behavior.phonePeriod < diner.behavior.phoneSeconds;
  if (present) {
    if (["arriving", "leaving"].includes(table.stage)) activity = "walking";
    else if (table.request && diner.id === (table.request.diner ?? 1))
      activity = table.request.phase === "discussing" ? "speaking to server" : table.request.phase === "awaiting_help" ? "waiting" : "signalling for service";
    else if (table.stage === "pay" && table.bill === "presented") activity = "reading bill";
    else if (table.stage === "pay" && table.bill === "ready") activity = "offering payment";
    else if (onPhone) activity = "using phone";
    else if (["reading", "dessert_reading", "dessert_order"].includes(table.stage))
      activity = speaking ? "talking" : "reading menu";
    else if (diner.finished && diner.active !== false)
      activity = speaking ? "talking" : "finished eating";
    else if (hasPlate) activity = speaking ? "talking" : "eating";
    else activity = speaking ? "talking" : "waiting";
  }
  if (hasPlate)
    courseCompletion = diner.finished
      ? 100
      : Math.max(
          0,
          Math.min(
            99,
            Math.round(
              diner.eatingTarget !== undefined
                ? 100 * (diner.eatenSeconds ?? 0) / diner.eatingTarget
                : (100 * (now - diner.deliveredAt!)) / Math.max(1, diner.eatUntil! - diner.deliveredAt!),
            ),
          ),
        );
  let position;
  if (diner.restroomTrip) {
    const trip = diner.restroomTrip, elapsed = now - trip.startedAt;
    if (elapsed < trip.walkSeconds)
      position = samplePath(trip.path, elapsed * GUEST_SPEED).position;
    else if (elapsed >= trip.walkSeconds + trip.insideSeconds)
      position = samplePath([...trip.path].reverse(), (elapsed - trip.walkSeconds - trip.insideSeconds) * GUEST_SPEED).position;
  }
  return {
    cocktail: diner.cocktail ? { name: diner.cocktail.name, percent: Math.round(diner.cocktail.percent) } : undefined,
    position,
    diner: diner.id,
    present,
    activity: present ? activity : position ? "walking" : "absent",
    waterPercent: Math.round(diner.water * 100),
    plate: diner.cleared
      ? "cleared"
      : hasPlate
        ? diner.finished
          ? "empty"
          : "food present"
        : "not served",
    // Cameras cannot know a guest's menu selection before a dish is visible.
    course: hasPlate
      ? {
          number: diner.courseNumber ?? 1,
          kind: diner.item.course,
          name: diner.item.name,
          completionPercent: courseCompletion!,
        }
      : null,
  };
}
