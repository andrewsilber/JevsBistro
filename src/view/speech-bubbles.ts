import * as THREE from "three";
import { observeDiner } from "../sim/observations";
import type { ActionKind, Diner, Server, TableState } from "../sim/types";
import { DialogueBook, type DialogueKey } from "./dialogue-lines";
import { BubbleMotion } from "./bubble-motion";
import { BubbleBudget, MAX_BUBBLES } from "./bubble-budget";

export interface Utterance { text: string; style: "speech" | "thought"; cue?: string }

// These lines are character flavor, not extra observations for a controller.
export function dinerDialogue(table: TableState, diner: Diner, now: number, book: DialogueBook, service?: ActionKind): Utterance {
  const speaker = `guest-${table.party?.id}-${diner.id}`;
  const episode = String(Math.floor((now + diner.id * 11 + (table.party?.id ?? 0) * 7) / 27));
  const line = (key: DialogueKey, style: Utterance["style"] = "thought", event = episode) =>
    ({ text: book.pick(key, speaker, event, { dish: diner.item.name }), style, cue: key });
  if (table.stage === "arriving") return line("arrival", "speech", String(table.since));
  if (table.stage === "leaving") return line("departure", "speech", String(table.since));
  if (diner.restroomTrip) {
    const trip = diner.restroomTrip;
    return line(now - trip.startedAt >= trip.walkSeconds + trip.insideSeconds ? "return" : "bathroom", "thought", String(trip.startedAt));
  }
  if (table.request && diner.id === (table.request.diner ?? 1)) {
    const request = table.request;
    if (request.phase === "awaiting_help" && request.conversationServer && service === "request")
      return line("thanks", "speech", String(request.since));
    if (request.phase === "discussing" && request.conversationServer && service === "request")
      return line(({ fork: "fork", spill: "spill", dessert: "dessertRequest", question: "question", bill: "billRequest" } as const)[request.kind], "speech", String(request.since));
    return line(request.phase === "awaiting_help" ? "waitingHelp" : "signal", "thought", `${request.since}:${request.phase}`);
  }
  if (diner.id === 1 && service) {
    const replies: Partial<Record<ActionKind, DialogueKey>> = { greet: "greetReply", order: "orderReply", bill: "thanks", pay: "payReply", check: "checkReply", deliver: "thanks", drink_deliver: "thanks", refill: "thanks" };
    if (replies[service]) return line(replies[service]!, "speech", `${table.since}:${service}`);
  }
  if (table.stage === "pay" && table.bill) return line(table.bill === "presented" ? "readBill" : "readyPayment");
  if (diner.water < .15) return line("water");
  if (diner.id === 1 && ["order", "dessert_order", "pay"].includes(table.stage))
    return line(table.stage === "pay" ? "waitPay" : table.stage === "dessert_order" ? "dessertReady" : "ready");
  if (diner.finished && !diner.cleared && diner.deliveredAt !== undefined) return line("finished");
  if (diner.id === 1 && ["greet", "between", "dessert_offer"].includes(table.stage))
    return line(table.stage === "greet" ? "waitMenu" : table.stage === "between" ? "between" : "wantDessert");
  const observed = observeDiner(table, diner, now);
  if (observed.activity === "using phone") return line("phone");
  if (observed.activity === "talking") return line("chat", "speech");
  if (observed.activity === "eating") return line("eating");
  if (table.stage === "lingering") return line("linger", "speech");
  if (observed.activity === "finished eating") return line("finished");
  if (observed.activity === "reading menu") return line(table.stage.startsWith("dessert") ? "dessertMenu" : "menu");
  if (diner.water < 0.15) return line("water");
  if (diner.active === false && table.stage === "eating") return line("skip");
  const thoughts: Partial<Record<TableState["stage"], DialogueKey>> = {
    greet: "waitMenu", reading: "menu", order: "ready", cooking: "waitFood", eating: "waitPlate",
    between: "between", dessert_offer: "wantDessert", dessert_reading: "dessertMenu", dessert_order: "dessertReady", pay: "waitPay",
  };
  return line(thoughts[table.stage] ?? "content");
}

export function serverDialogue(server: Server, now: number, planning: boolean, book: DialogueBook): Utterance {
  const job = server.job, speaker = `server-${server.id}`;
  const episode = job ? `${server.completed}:${job.id}` : String(Math.floor((now + server.id * 7) / 29));
  const line = (key: DialogueKey, style: Utterance["style"] = "thought", event = episode) =>
    ({ text: book.pick(key, speaker, event, { table: job?.table ? `table ${job.table}` : "my tables" }), style, cue: key });
  if (planning) return line("planning", "thought", String(server.completed));
  if (server.interruptUntil > now) return line(server.supplies ? "returnHelp" : "interrupt", "speech", String(server.interruptUntil));
  if (!job) return line("idle");
  if (job.path.length || !job.startedService) {
    const thoughts: Record<ActionKind, DialogueKey> = {
      greet: "walkGreet", order: "walkOrder", pickup: "walkPickup", deliver: "walkDeliver",
      bar_pickup: "walkBar", drink_deliver: "walkDrinks", refill: "walkWater", check: "walkCheck",
      bill: "walkPay", pay: "walkPay", bus: "walkBus", clear: "walkClear", dessert: "walkDessert", supplies: "walkSupplies",
      request: "walkRequest", pitcher: "walkPitcher", drop: "walkDrop", patrol: "patrol",
    };
    return line(thoughts[job.kind]);
  }
  const spoken: Partial<Record<ActionKind, DialogueKey>> = {
    greet: "greet", order: "order", deliver: "deliver", drink_deliver: "drinks", refill: "refill",
    check: "check", bill: "presentBill", pay: "pay", clear: "clear", dessert: "dessert", request: "request", pickup: "pickup", bar_pickup: "barPickup",
  };
  return spoken[job.kind] ? line(spoken[job.kind]!, "speech") : line(job.kind === "patrol" ? "patrol" : "tidy");
}

export interface BubbleAnchor {
  id: string;
  kind: "server" | "customer";
  label: string;
  utterance: Utterance | (() => Utterance);
  person: THREE.Object3D | (() => THREE.Object3D | undefined);
  group?: string;
  priority?: number;
}
const BUBBLE_WIDTH = 3.8;

interface Bubble {
  sprite: THREE.Sprite;
  caption: HTMLSpanElement;
  signature: string;
  motion: BubbleMotion;
  height: number;
  acceptedAt: number;
  follow: BubbleAnchor["person"];
}

/** Depth-tested, camera-facing sprites measured in restaurant metres.
 * Text changes fold the old balloon away before opening the latest line.
 */
export class SpeechBubbles {
  enabled = false;
  readonly dialogue = new DialogueBook();
  private group = new THREE.Group();
  private budget = new BubbleBudget();
  private nextSelection = 0;
  private selected: BubbleAnchor[] = [];
  private paints = 0;
  private nextPaintAt = 0;
  private bubbles = new Map<string, Bubble>();
  constructor(private host: HTMLElement, scene: THREE.Scene) { scene.add(this.group); }
  private remove(bubble: Bubble) {
    bubble.sprite.material.map?.dispose(); bubble.sprite.material.dispose();
    this.group.remove(bubble.sprite); bubble.caption.remove();
  }
  clear() {
    this.bubbles.forEach((bubble) => this.remove(bubble)); this.bubbles.clear(); this.dialogue.clear();
    this.budget.clear(); this.selected = []; this.nextSelection = 0; this.paints = 0; this.nextPaintAt = 0;
  }
  isVisible(id: string) { return this.bubbles.get(id)?.sprite.visible === true; }

  private paint(bubble: Bubble, anchor: BubbleAnchor & { utterance: Utterance }, signature: string, now: number) {
    this.host.dataset.bubblePaints = String(++this.paints);
    this.nextPaintAt = now + 250;
    const canvas = paintBubble(anchor), texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    bubble.sprite.material.map?.dispose(); bubble.sprite.material.map = texture; bubble.sprite.material.needsUpdate = true;
    bubble.height = BUBBLE_WIDTH * canvas.height / canvas.width;
    // UV origin is bottom-left. Align the actual speech tip / last thought dot,
    // not the transparent bottom padding, with the speaker's head anchor.
    bubble.sprite.center.set(0.5, (anchor.utterance.style === "speech" ? 20 : 8) / canvas.height);
    bubble.caption.textContent = `${anchor.label} ${anchor.utterance.style === "speech" ? "says" : "thinks"}: ${anchor.utterance.text}`;
    bubble.caption.dataset.style = anchor.utterance.style;
    bubble.caption.dataset.cue = anchor.utterance.cue ?? "";
    bubble.signature = signature; bubble.acceptedAt = now;
  }

  draw(source: BubbleAnchor[] | (() => BubbleAnchor[]), camera: THREE.Camera, now = performance.now()) {
    if (!this.enabled) {
      this.selected = []; this.nextSelection = 0; this.budget.clear();
    } else if (now >= this.nextSelection) {
      const candidates = typeof source === "function" ? source() : source;
      // Evaluate dialogue only for the few chosen speakers, four times/second.
      this.selected = this.budget.choose(candidates, now).map((anchor) => ({ ...anchor,
        utterance: typeof anchor.utterance === "function" ? anchor.utterance() : anchor.utterance }));
      this.nextSelection = now + 250;
    }
    const active = new Set<string>();
    const width = this.host.clientWidth;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    // No rectangle-overlap or minimum-size culling. The z-buffer handles
    // occlusion, so moving people and camera zoom cannot toggle entire balloons.
    for (const pending of this.selected) {
      const anchor = pending as BubbleAnchor & { utterance: Utterance };
      active.add(anchor.id);
      let bubble = this.bubbles.get(anchor.id);
      if (!bubble) {
        // Outgoing balloons count against the cap until their exit completes.
        if (this.bubbles.size >= MAX_BUBBLES || now < this.nextPaintAt) continue;
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
          transparent: true, depthTest: true, depthWrite: true, alphaTest: 0.08, toneMapped: false,
        }));
        // Standard transparent depth sorting, with alpha-tested empty pixels
        // discarded before depth writes. No invisible rectangular occluders.
        const caption = document.createElement("span");
        caption.className = `bubble-caption ${anchor.kind}`; caption.dataset.person = anchor.id;
        this.host.append(caption); this.group.add(sprite);
        bubble = { sprite, caption, signature: "", motion: new BubbleMotion(), height: 1, acceptedAt: now, follow: anchor.person };
        this.bubbles.set(anchor.id, bubble);
      }
      bubble.follow = anchor.person;
      const { sprite, motion } = bubble;
      motion.sample(now);
      const signature = `${anchor.kind}:${anchor.label}:${anchor.utterance.style}:${anchor.utterance.text}`;
      if (!bubble.signature || (motion.value === 0 && signature !== bubble.signature)) {
        if (now < this.nextPaintAt) continue;
        this.paint(bubble, anchor, signature, now);
        motion.setVisible(true, now);
      } else if (signature === bubble.signature) {
        motion.setVisible(true, now);
      } else if (now - bubble.acceptedAt >= 1000) {
        // Coalesce fast simulation changes into the latest line, rather than
        // queuing stale dialogue or changing texture on every simulation tick.
        motion.setVisible(false, now);
      }
    }
    for (const [id, bubble] of this.bubbles) {
      const { sprite, caption, motion } = bubble;
      if (!active.has(id)) motion.setVisible(false, now);
      const person = typeof bubble.follow === "function" ? bubble.follow() : bubble.follow;
      if (person?.visible) {
        const head = person.getObjectByName("head");
        (head ?? person).getWorldPosition(sprite.position);
        sprite.position.y += head ? .25 : 1.65;
      } else motion.setVisible(false, now);
      const size = motion.sample(now);
      sprite.scale.set(BUBBLE_WIDTH * size, bubble.height * size, 1);
      sprite.visible = size > 0.001;
      if (caption.hidden === sprite.visible) caption.hidden = !sprite.visible;
      setData(caption, "visible", String(sprite.visible));
      setData(caption, "phase", motion.target ? size === 1 ? "shown" : "appearing" : size === 0 ? "hidden" : "disappearing");
      setData(caption, "scale", size.toFixed(4));
      setData(caption, "worldWidth", String(BUBBLE_WIDTH));
      setData(caption, "depthTest", String(sprite.material.depthTest));
      setData(caption, "depthWrite", String(sprite.material.depthWrite));
      setData(caption, "alphaTest", String(sprite.material.alphaTest));
      setData(caption, "pivot", `${sprite.center.x},${sprite.center.y}`);
      const p = sprite.position.clone().project(camera);
      const edge = sprite.position.clone().addScaledVector(right, sprite.scale.x).project(camera);
      setData(caption, "screenWidth", (Math.abs(edge.x - p.x) * width / 2).toFixed(2));
      if (!active.has(id) && size === 0) { this.remove(bubble); this.bubbles.delete(id); }
    }
  }
}

function setData(element: HTMLElement, key: string, value: string) {
  if (element.dataset[key] !== value) element.dataset[key] = value;
}

function paintBubble(anchor: BubbleAnchor & { utterance: Utterance }): HTMLCanvasElement {
  const canvas = document.createElement("canvas"); canvas.width = 640;
  const ctx = canvas.getContext("2d")!;
  const font = 'bold 42px "Comic Sans MS", "Segoe Print", cursive';
  ctx.font = font;
  const lines: string[] = []; let line = "";
  for (const word of anchor.utterance.text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > 510 && line) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  const bodyHeight = 104 + lines.length * 54; canvas.height = bodyHeight + 90;
  const thought = anchor.utterance.style === "thought";
  ctx.fillStyle = thought ? "#fff4d3" : anchor.kind === "server" ? "#edfff4" : "#fffdf6";
  ctx.strokeStyle = "#38423e"; ctx.lineWidth = 5; ctx.lineJoin = "round";
  ctx.shadowColor = "#172d3e35"; ctx.shadowBlur = 8; ctx.shadowOffsetY = 5;
  ctx.beginPath();
  if (thought) {
    ctx.moveTo(66, 28);
    ctx.bezierCurveTo(26, 1, 10, 57, 30, 82);
    ctx.bezierCurveTo(3, 115, 15, bodyHeight - 12, 62, bodyHeight - 16);
    ctx.bezierCurveTo(105, bodyHeight + 8, 166, bodyHeight + 1, 187, bodyHeight - 14);
    ctx.bezierCurveTo(254, bodyHeight + 8, 324, bodyHeight + 9, 368, bodyHeight - 10);
    ctx.bezierCurveTo(437, bodyHeight + 13, 494, bodyHeight + 2, 520, bodyHeight - 18);
    ctx.bezierCurveTo(597, bodyHeight + 4, 627, bodyHeight - 48, 610, bodyHeight - 79);
    ctx.bezierCurveTo(646, 71, 618, 26, 580, 32);
    ctx.bezierCurveTo(554, 2, 486, 4, 460, 24);
    ctx.bezierCurveTo(407, 0, 349, 0, 316, 22);
    ctx.bezierCurveTo(258, 0, 204, 1, 176, 25);
    ctx.bezierCurveTo(129, 1, 84, 4, 66, 28);
  } else {
    ctx.moveTo(74, 16); ctx.bezierCurveTo(19, 16, 18, 42, 20, 80);
    ctx.lineTo(24, bodyHeight - 49); ctx.quadraticCurveTo(26, bodyHeight - 10, 76, bodyHeight - 10);
    ctx.lineTo(280, bodyHeight - 10); ctx.quadraticCurveTo(307, bodyHeight + 12, 320, bodyHeight + 70);
    ctx.quadraticCurveTo(355, bodyHeight + 33, 365, bodyHeight - 10);
    ctx.lineTo(564, bodyHeight - 10); ctx.quadraticCurveTo(617, bodyHeight - 12, 618, bodyHeight - 59);
    ctx.lineTo(620, 70); ctx.quadraticCurveTo(617, 17, 565, 15); ctx.quadraticCurveTo(315, 6, 74, 16);
  }
  ctx.closePath(); ctx.fill(); ctx.stroke();
  if (thought) for (const [x, y, radius] of [[349, bodyHeight + 28, 16], [331, bodyHeight + 54, 10], [320, bodyHeight + 77, 5]]) {
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; ctx.textAlign = "center";
  ctx.fillStyle = thought ? "#967443" : "#527d6d"; ctx.font = 'bold 23px "Segoe UI", sans-serif';
  ctx.fillText(anchor.label, 320, 59);
  ctx.fillStyle = "#283c35"; ctx.font = font;
  lines.forEach((text, i) => ctx.fillText(text, 320, 110 + i * 54));
  return canvas;
}
