import * as THREE from "three";
import { SpeechBubbles, type BubbleAnchor } from "../src/view/speech-bubbles";

// Deterministic GPU fixture: a movable opaque wall and one stationary speaker.
const host = document.querySelector<HTMLElement>("#floor")!;
const scene = new THREE.Scene(); scene.background = new THREE.Color("#102030");
const camera = new THREE.OrthographicCamera(-6, 6, 6, -6, .1, 100);
camera.position.set(0, 0, 10); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setSize(600, 600); host.append(renderer.domElement);
const person = new THREE.Group(); scene.add(person);
const head = new THREE.Object3D(); head.name = "head"; person.add(head);
const wall = new THREE.Mesh(new THREE.PlaneGeometry(6, 5), new THREE.MeshBasicMaterial({ color: "#c12470" }));
wall.position.set(0, 1.8, 1); wall.visible = false; scene.add(wall);
const bubbles = new SpeechBubbles(host, scene); bubbles.enabled = true;
const anchor: BubbleAnchor = { id: "guest", kind: "customer", label: "Guest", person,
  utterance: { text: "Hello, lovely evening!", style: "speech" } };
function draw(now: number) { bubbles.draw([anchor], camera, now); renderer.render(scene, camera); }
function pixel(x: number, y: number) {
  const values = new Uint8Array(4), gl = renderer.getContext();
  gl.readPixels(Math.round((x + 6) * 50), Math.round((y + 6) * 50), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, values);
  return [...values];
}
const harness = {
  draw, pixel,
  wall(z: number | null) { wall.visible = z !== null; if (z !== null) wall.position.z = z; },
  enable(value: boolean) { bubbles.enabled = value; },
  text(value: string) { anchor.utterance = { text: value, style: "speech" }; },
  snapshot() {
    const sprite = scene.children.flatMap((child) => child.children).find((child) => child instanceof THREE.Sprite) as THREE.Sprite | undefined;
    if (!sprite) return null;
    return { scale: sprite.scale.x, pivot: sprite.center.toArray(), position: sprite.position.toArray() };
  },
};
Object.assign(window, { bubbleHarness: harness });
draw(0);
