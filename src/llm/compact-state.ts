import type { DecisionContext, Point } from "../sim/types";

export const COMPACT_STATE_VERSION = "bistro-rows-v1";
export const COMPACT_STATE_LEGEND = `Input is bistro-rows-v1, positional rows with these columns:
server=[id,x,y,plates,drinks,dirty,water].
tables=[table,room,party,source,evidenceAge,stage,stageAge,checked,request,requestPhase,bill,x,y,waters,finished,diners].
diners=[id,present,activity,waterPercent,plate,course,cocktail,position]; course=[number,kind,name,completionPercent]; cocktail=[name,percent]; position=[x,y].
actions=[id,table,destinationIndex,party,priority,evidenceAge,serviceSeconds,dirtyLoad,waterNeeded,reasonIndex]. reasons is a shared string dictionary.
destinations=[x,y] rows. travel[0] contains server-to-destination seconds; travel[d+1] contains destination d to each destination's seconds. Distances are already routed around obstacles; do not substitute straight-line distances.
Times/ages are seconds; numbers rounded to 0.1. null means absent/unknown, not zero. Unknown requests remain unknown. stageAge is time in the observed stage, NOT evidenceAge. Keep the supplied action IDs exactly.`;
const number = (value: number | undefined) => value !== undefined && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
const point = (p?: Point) => p ? [number(p.x), number(p.y)] : null;

/** Only repack observed context. No candidate pruning or access to the world. */
export function compactState(context: DecisionContext) {
  const destinations: Point[] = [], representatives: string[] = [], reasons: string[] = [];
  const actions = context.candidates.map((c) => {
    let destination = destinations.findIndex((p) => p.x === c.destination.x && p.y === c.destination.y);
    if (destination < 0) { destination = destinations.length; destinations.push(c.destination); representatives.push(c.id); }
    let reason = reasons.indexOf(c.reason);
    if (reason < 0) { reason = reasons.length; reasons.push(c.reason); }
    return [c.id, c.table ?? null, destination, c.party ?? null, number(c.priority), number(context.now - c.observedAt),
      number(c.duration), c.dirtyLoad ?? 0, number(c.waterNeeded ?? 0), reason];
  });
  const s = context.server;
  return {
    v: COMPACT_STATE_VERSION,
    now: number(context.now),
    server: [s.id, number(s.position.x), number(s.position.y), s.plates, s.drinks, s.dirty, number(s.water)],
    tables: context.observations.map((o) => [o.table, o.room, o.party ?? null, o.source, number(context.now - o.at), o.stage, number(context.now - o.since),
      o.checked, o.request ?? null, o.requestPhase ?? null, o.bill ?? null, number(o.position.x), number(o.position.y), o.waters, o.finished,
      o.diners.map((d) => [d.diner, d.present, d.activity, d.waterPercent, d.plate,
        d.course ? [d.course.number, d.course.kind, d.course.name, d.course.completionPercent] : null,
        d.cocktail ? [d.cocktail.name, d.cocktail.percent] : null, point(d.position)])]),
    actions, reasons, destinations: destinations.map((p) => point(p)),
    travel: ["start", ...representatives].map((from) => representatives.map((to) => number(context.travelSeconds[from]?.[to]))),
  };
}

export function payloadSizes(context: DecisionContext) {
  const original = JSON.stringify(context).length, compact = JSON.stringify(compactState(context)).length;
  return { format: COMPACT_STATE_VERSION, originalStateCharacters: original, compactStateCharacters: compact,
    reductionPercent: Math.round((1 - compact / Math.max(1, original)) * 1000) / 10 };
}
