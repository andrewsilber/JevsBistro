import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Simulation } from "../sim/engine";
import type { Point, Server, TableState } from "../sim/types";
import { GUEST_SPEED, guestRoute, pathLength, samplePath } from "../sim/movement";
import { findPath } from "../sim/layout";
import { observeDiner } from "../sim/observations";
import { dinerBubblePriority, serverBubblePriority } from "./bubble-budget";
import { SpeechBubbles, dinerDialogue, serverDialogue, type BubbleAnchor } from "./speech-bubbles";
const colors = {
  wood: "#b7794d",
  green: "#214c40",
  brass: "#d6ab65",
  cream: "#eee9d9",
  wall: "#c8d6c1",
  dark: "#24423c",
};
export class RestaurantView {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.OrthographicCamera;
  controls: OrbitControls;
  root = new THREE.Group();
  people = new THREE.Group();
  tables = new Map<number, THREE.Group>();
  serverMeshes = new Map<number, THREE.Group>();
  serverMarkers = new Map<number, HTMLSpanElement>();
  previousServers = new Map<number, { position: Point; path: Point[]; walking: number }>();
  previousTime = 0;
  renderTime = 0;
  labels: {
    element: HTMLButtonElement;
    point: THREE.Vector3;
    table: number;
  }[] = [];
  sim: Simulation;
  overlays = true;
  paths = false;
  cameras = false;
  routeGroup = new THREE.Group();
  cameraGroup = new THREE.Group();
  selected?: number;
  resizeObserver: ResizeObserver;
  transit = new THREE.Group();
  guestGroups = new Map<string, THREE.Group>();
  pass = new THREE.Group();
  passSignature = "";
  barDisplay = new THREE.Group();
  barSignature = "";
  ambient: THREE.HemisphereLight;
  sun: THREE.DirectionalLight;
  topDown = false;
  routeCount = 0;
  bubbles: SpeechBubbles;
  constructor(
    readonly host: HTMLElement,
    sim: Simulation,
    readonly onSelect: (id: number) => void,
  ) {
    this.sim = sim;
    this.bubbles = new SpeechBubbles(host, this.scene);
    this.scene.background = new THREE.Color("#e6e7df");
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.35;
    host.append(this.renderer.domElement);
    this.renderer.domElement.setAttribute(
      "aria-label",
      "Interactive 3D restaurant. Drag to orbit, scroll to zoom. Use table buttons to inspect.",
    );
    this.camera = new THREE.OrthographicCamera(-15, 15, 12, -12, 0.1, 300);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI / 2.15;
    this.controls.minZoom = 0.5;
    this.controls.maxZoom = 8;
    const ambient = new THREE.HemisphereLight("#fff7e6", "#677c72", 2.3);
    this.ambient = ambient;
    this.scene.add(ambient);
    const sun = new THREE.DirectionalLight("#fff0cf", 3.8);
    this.sun = sun;
    sun.position.set(10, 25, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -50;
    sun.shadow.camera.right = 50;
    sun.shadow.camera.top = 50;
    sun.shadow.camera.bottom = -50;
    sun.shadow.normalBias = 0.025;
    this.scene.add(sun);
    this.scene.add(
      this.root,
      this.people,
      this.routeGroup,
      this.cameraGroup,
      this.transit,
      this.pass,
      this.barDisplay,
    );
    this.build(sim);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
  }
  mat(color: string, roughness = 0.75) {
    return new THREE.MeshStandardMaterial({ color, roughness });
  }
  box(
    parent: THREE.Object3D,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    color: string,
  ) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      this.mat(color),
    );
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }
  cylinder(
    parent: THREE.Object3D,
    x: number,
    y: number,
    z: number,
    r: number,
    h: number,
    color: string,
    r2 = r,
  ) {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r2, h, 20),
      this.mat(color),
    );
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }
  sphere(
    parent: THREE.Object3D,
    x: number,
    y: number,
    z: number,
    r: number,
    color: string,
  ) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(r, 16, 12),
      this.mat(color),
    );
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  }
  clear(group: THREE.Group) {
    group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
        o.geometry.dispose();
        const materials = Array.isArray(o.material) ? o.material : [o.material];
        materials.forEach((m) => {
          if ("map" in m && m.map instanceof THREE.Texture) m.map.dispose();
          m.dispose();
        });
      }
    });
    group.clear();
  }
  sign(
    parent: THREE.Object3D,
    text: string,
    x: number,
    y: number,
    z: number,
    size = 2,
    color = "#e9c88e",
  ) {
    const c = document.createElement("canvas");
    c.width = text.trim().length <= 3 ? 192 : 768;
    c.height = 128;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = color;
    ctx.font = "600 64px Georgia";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, c.width / 2, 64);
    const texture = new THREE.CanvasTexture(c);
    texture.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size * c.height / c.width),
      new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        side: THREE.DoubleSide,
      }),
    );
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }
  plant(parent: THREE.Object3D, x: number, z: number, scale = 1) {
    this.cylinder(
      parent,
      x,
      0.28,
      z,
      0.3 * scale,
      0.55,
      "#ae6d4b",
      0.23 * scale,
    );
    this.cylinder(parent, x, 0.8, z, 0.035, 0.9, "#695138");
    for (let i = 0; i < 7; i++) {
      const a = i * 2.4;
      const leaf = this.sphere(
        parent,
        x + Math.cos(a) * 0.2 * scale,
        1 + (i % 3) * 0.2,
        z + Math.sin(a) * 0.2 * scale,
        0.28 * scale,
        i % 2 ? "#3d6e46" : "#658348",
      );
      leaf.scale.set(0.65, 1.35, 0.7);
    }
  }
  person(color: string, skin: string, seated = false, staff = false) {
    const g = new THREE.Group();
    this.cylinder(g, 0, seated ? 0.77 : 0.92, 0, 0.2, 0.52, staff ? "#fff7e6" : color, 0.25);
    this.sphere(g, 0, seated ? 1.23 : 1.4, 0, 0.2, skin).name = "head";
    const hair = this.sphere(
      g,
      0,
      seated ? 1.31 : 1.48,
      -0.035,
      0.2,
      "#49382c",
    );
    hair.scale.y = 0.7;
    for (const side of [-1, 1]) {
      const leg = this.box(
        g,
        side * 0.11,
        seated ? 0.37 : 0.31,
        seated ? 0.16 : 0,
        0.14,
        0.56,
        0.16,
        "#293c3c",
      );
      leg.name = `leg${side}`;
      this.box(
        g,
        side * 0.28,
        seated ? 0.78 : 0.88,
        0.03,
        0.1,
        0.39,
        0.12,
        skin,
      ).name = `arm${side}`;
    }
    if (staff) {
      this.box(g, 0, 0.79, 0.215, 0.35, 0.60, 0.04, "#172d3e");
      this.box(g, 0, 0.87, 0.245, 0.36, 0.10, 0.025, color);
      this.box(g, 0, 1.11, 0.24, 0.10, 0.055, 0.04, "#172d3e");
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.37, 0.46, 32), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.04;
      g.add(ring);
      const tray = this.cylinder(g, 0.36, 1, 0.3, 0.29, 0.035, "#394541");
      tray.name = "tray";
      const plate = this.cylinder(g, 0.36, 1.05, 0.3, 0.22, 0.04, "#fff6df");
      plate.name = "food";
      this.cylinder(g, 0.36, 1.09, 0.3, 0.085, 0.18, "#eea65f").name = "cocktail";
      this.cylinder(g, -0.32, 0.82, 0.15, 0.09, 0.27, "#8cbdba").name =
        "pitcher";
    }
    return g;
  }
  build(sim: Simulation) {
    this.sim = sim;
    this.bubbles.clear();
    this.previousServers.clear();
    this.previousTime = sim.now;
    this.renderTime = sim.now;
    this.serverMarkers.forEach((marker) => marker.remove());
    this.serverMarkers.clear();
    for (const group of [
      this.root,
      this.people,
      this.routeGroup,
      this.cameraGroup,
      this.transit,
      this.pass,
      this.barDisplay,
    ])
      this.clear(group);
    this.passSignature = "";
    this.barSignature = "";
    this.guestGroups.clear();
    this.tables.clear();
    this.serverMeshes.clear();
    this.labels.forEach((l) => l.element.remove());
    this.labels = [];
    const { width: w, height: h } = sim.layout;
    this.box(
      this.root,
      w / 2 - 0.5,
      -0.35,
      h / 2 - 0.5,
      w + 0.7,
      0.7,
      h + 0.7,
      "#253e36",
    );
    const tileGeometry = new THREE.BoxGeometry(0.97, 0.07, 0.97),
      floor = new THREE.InstancedMesh(tileGeometry, this.mat("#c4a57f"), w * h),
      dummy = new THREE.Object3D();
    for (let x = 0; x < w; x++)
      for (let y = 0; y < h; y++) {
        const i = x * h + y;
        dummy.position.set(x, 0.01, y);
        dummy.updateMatrix();
        floor.setMatrixAt(i, dummy.matrix);
        floor.setColorAt(
          i,
          new THREE.Color(
            y < 3
              ? (x + y) % 2
                ? "#e5e0ce"
                : "#617565"
              : ["#be9469", "#c29d73", "#bd956e", "#c7a279"][
                  (x * 7 + y * 3) % 4
                ],
          ),
        );
      }
    floor.receiveShadow = true;
    this.root.add(floor);
    this.box(
      this.root,
      w / 2 - 0.5,
      1.35,
      -0.65,
      w + 0.8,
      2.7,
      0.22,
      colors.green,
    );
    this.box(
      this.root,
      -0.65,
      0.85,
      h / 2 - 0.5,
      0.22,
      1.7,
      h + 0.7,
      colors.wall,
    );
    this.box(
      this.root,
      -0.65,
      1.76,
      h / 2 - 0.5,
      0.3,
      0.1,
      h + 0.7,
      colors.brass,
    );
    this.sign(
      this.root,
      "J E V S B I S T R O",
      w / 2,
      2.1,
      -0.51,
      Math.min(7, w * 0.6),
    );
    // Kitchen pass and side station leave the service aisle open.
    this.box(this.root, 2.1, 0.52, -0.03, 3.4, 1.04, 0.65, "#53645b");
    this.box(this.root, 2.1, 1.09, -0.03, 3.6, 0.12, 0.8, "#e7dfc8");
    for (let i = 0; i < 4; i++)
      this.cylinder(this.root, 0.6, 1.17 + i * 0.05, 0, 0.22, 0.04, "#f8f0df");
    this.sign(this.root, "KITCHEN  /  PASS", 2.3, 0.68, 0.32, 3.3);
    const station = new THREE.Group();
    station.position.set(sim.config.stationPlacement === "split" ? w - 0.55 : sim.layout.station.x, 0, sim.config.stationPlacement === "split" ? sim.layout.station.y : 0);
    if (sim.config.stationPlacement === "split") station.rotation.y = -Math.PI / 2;
    this.root.add(station);
    this.box(station, 0, 0.52, 0, 1.7, 1.04, 0.65, "#ac784f");
    this.box(station, 0, 1.1, 0, 1.9, 0.12, 0.8, "#eadfc5");
    this.sign(station, "SIDE STATION", 0, 0.65, 0.34, 1.7);
    for (let i = 0; i < 3; i++) this.cylinder(station, -0.45 + i * 0.45, 1.31, 0, 0.12, 0.35, "#96c9c6");
    const bar = new THREE.Group();
    bar.position.set(sim.layout.bar.x, 0, sim.config.stationPlacement === "split" ? h - 1 : 0);
    if (sim.config.stationPlacement === "split") bar.rotation.y = Math.PI;
    this.root.add(bar);
    this.box(bar, 0, 0.55, 0, 2.5, 1.1, 0.7, "#493c58");
    this.box(bar, 0, 1.15, 0, 2.7, 0.14, 0.85, "#dcc59d");
    this.sign(bar, "COCKTAIL BAR", 0, 0.65, 0.36, 2.4, "#fff0cb");
    for (let i = 0; i < sim.config.bartenders; i++) {
      const bartender = this.person("#ae87c6", "#c49b7a", false, true);
      bartender.position.set((i - (sim.config.bartenders - 1) / 2) * 0.65, 0.1, -0.35);
      for (const name of ["tray", "food", "cocktail", "pitcher"]) bartender.getObjectByName(name)!.visible = false;
      bar.add(bartender);
    }
    for (const o of sim.layout.obstacles) {
      if (o.kind === "fountain") {
        this.cylinder(this.root, o.x, 0.36, o.y, 1.4, 0.65, "#b9b4a4");
        this.cylinder(this.root, o.x, 0.70, o.y, 1.22, 0.06, "#63bcc7");
        this.cylinder(this.root, o.x, 1.02, o.y, 0.24, 0.6, "#ded4ba");
        this.cylinder(this.root, o.x, 1.32, o.y, 0.55, 0.10, "#72ced8");
        this.sphere(this.root, o.x, 1.55, o.y, 0.13, "#bdebef");
      } else this.box(this.root, o.x, 1.05, o.y, o.width * 0.5, 2.1, o.height, "#617668");
    }
    for (const b of sim.layout.roomBounds) {
      this.plant(this.root, b.x + b.width - 1, h - 1, 1.1);
      if (b.x > 0)
        for (let z = 3; z < h; z++)
          this.box(this.root, b.x - 0.5, 0.07, z, 0.1, 0.025, 1, "#e9d2a5");
      const camera = new THREE.Group();
      this.box(
        camera,
        b.x + b.width / 2,
        2.7,
        -0.1,
        0.42,
        0.22,
        0.3,
        "#253b37",
      );
      this.sphere(camera, b.x + b.width / 2, 2.65, 0.07, 0.09, "#63dac2");
      const coverage = new THREE.Mesh(
        new THREE.PlaneGeometry(b.width - 0.2, h - 2),
        new THREE.MeshBasicMaterial({
          color: "#53b7a7",
          transparent: true,
          opacity: 0.13,
          depthWrite: false,
        }),
      );
      coverage.rotation.x = -Math.PI / 2;
      coverage.position.set(b.x + b.width / 2 - 0.5, 0.11, h / 2 + 0.5);
      camera.add(coverage);
      this.cameraGroup.add(camera);
    }
    this.plant(this.root, 0, 2.6);
    this.plant(this.root, 0, h - 3);
    const welcome = this.sign(
      this.root,
      "WELCOME",
      0.8,
      0.12,
      h - 1,
      2.4,
      "#23493d",
    );
    welcome.rotation.x = -Math.PI / 2;
    const restroom = sim.layout.restroom;
    this.box(this.root, restroom.x + 0.5, 1.05, restroom.y, 0.12, 2.1, 1.7, "#234658");
    this.box(this.root, restroom.x + 0.41, 0.98, restroom.y, 0.05, 1.8, 1.25, "#4b706f");
    const restroomSign = this.sign(this.root, "WC", restroom.x + 0.36, 1.7, restroom.y, 1.05, "#fff7e6");
    restroomSign.rotation.y = -Math.PI / 2;
    const outerRestroomSign = this.sign(this.root, "WC", restroom.x + 0.58, 1.7, restroom.y, 1.05, "#fff7e6");
    outerRestroomSign.rotation.y = Math.PI / 2;
    const floorSign = this.sign(this.root, "RESTROOM", restroom.x - 0.3, 0.12, restroom.y + 1, 1.9, "#213d42");
    floorSign.rotation.x = -Math.PI / 2;
    for (const t of sim.tables) {
      const g = new THREE.Group();
      g.position.set(t.x, 0, t.y);
      this.root.add(g);
      this.cylinder(
        g,
        0,
        0.09,
        0,
        1.4,
        0.035,
        t.room % 2 ? "#718475" : "#8f9e85",
      );
      this.cylinder(g, 0, 0.56, 0, 0.1, 1.05, "#384e40");
      this.cylinder(g, 0, 0.13, 0, 0.38, 0.07, "#384e40");
      this.cylinder(g, 0, 1.12, 0, 0.91, 0.13, colors.wood);
      this.cylinder(g, 0, 1.195, 0, 0.84, 0.025, "#dec3a0");
      this.cylinder(g, 0, 1.31, 0, 0.085, 0.22, "#e9e0c7");
      this.sphere(g, 0, 1.47, 0, 0.1, "#71905b");
      for (let i = 0; i < t.seats; i++) {
        const a = (i / t.seats) * Math.PI * 2;
        const chair = new THREE.Group();
        chair.position.set(Math.sin(a) * 1.2, 0, Math.cos(a) * 1.2);
        chair.rotation.y = a;
        g.add(chair);
        this.box(chair, 0, 0.47, 0, 0.55, 0.14, 0.52, colors.green);
        this.box(chair, 0, 0.84, 0.24, 0.56, 0.63, 0.1, colors.green);
        for (const x of [-0.21, 0.21])
          for (const z of [-0.19, 0.19])
            this.box(chair, x, 0.22, z, 0.065, 0.45, 0.065, "#9c713e");
      }
      const dynamic = new THREE.Group();
      g.add(dynamic);
      this.tables.set(t.id, dynamic);
      const label = document.createElement("button");
      label.className = "table-label";
      label.onclick = () => this.onSelect(t.id);
      label.setAttribute("aria-label", `Inspect table ${t.id}`);
      this.host.append(label);
      this.labels.push({
        element: label,
        point: new THREE.Vector3(t.x, 1.3, t.y - 1.06),
        table: t.id,
      });
    }
    for (const s of sim.servers) {
      const person = this.person(s.color, "#d8ac87", false, true);
      this.people.add(person);
      this.serverMeshes.set(s.id, person);
      const marker = document.createElement("span");
      marker.className = "server-marker";
      marker.textContent = `S${s.id}`;
      marker.style.setProperty("--server-color", s.color);
      marker.setAttribute("aria-label", `Server ${s.id}: ${s.name}`);
      marker.dataset.serverId = String(s.id);
      this.host.append(marker);
      this.serverMarkers.set(s.id, marker);
    }
    this.home(false);
  }
  resize() {
    const w = this.host.clientWidth,
      h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    // Fit the projected floor bounds, including depth in an isometric view.
    // A width-only fit crops long/multi-room restaurants on narrow screens.
    this.camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(
      this.camera.matrixWorld,
      0,
    );
    const up = new THREE.Vector3().setFromMatrixColumn(
      this.camera.matrixWorld,
      1,
    );
    const center = new THREE.Vector3(
      this.sim.layout.width / 2 - 0.5,
      0,
      this.sim.layout.height / 2 - 0.5,
    );
    let halfWidth = 0,
      halfHeight = 0;
    for (const x of [-1, this.sim.layout.width])
      for (const y of [-0.7, 2.8])
        for (const z of [-1, this.sim.layout.height]) {
          const offset = new THREE.Vector3(x, y, z).sub(center);
          halfWidth = Math.max(halfWidth, Math.abs(offset.dot(right)));
          halfHeight = Math.max(halfHeight, Math.abs(offset.dot(up)));
        }
    const span = Math.max(halfHeight / 0.86, halfWidth / ((w / h) * 0.88));
    this.camera.left = (-span * w) / h;
    this.camera.right = (span * w) / h;
    this.camera.top = span;
    this.camera.bottom = -span;
    this.camera.updateProjectionMatrix();
  }
  home(top: boolean) {
    this.topDown = top;
    const { width: w, height: h } = this.sim.layout,
      center = new THREE.Vector3(w / 2 - 0.5, 0, h / 2 - 0.5);
    this.controls.target.copy(center);
    this.camera.position
      .copy(center)
      .add(new THREE.Vector3(top ? 0 : 21, top ? 45 : 24, top ? 0.01 : 28));
    this.camera.zoom = 1;
    this.controls.enableRotate = !top;
    this.camera.lookAt(center);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.resize();
  }
  zoomBy(factor: number) {
    this.camera.zoom = THREE.MathUtils.clamp(
      this.camera.zoom * factor,
      this.controls.minZoom,
      this.controls.maxZoom,
    );
    this.camera.updateProjectionMatrix();
  }
  setDark(dark: boolean) {
    this.scene.background = new THREE.Color(dark ? "#14242b" : "#e6e7df");
    this.ambient.intensity = dark ? 1.6 : 2.3;
    this.sun.intensity = dark ? 2.6 : 3.8;
  }
  updateTable(t: TableState) {
    const g = this.tables.get(t.id)!;
    const signature = `${t.stage}:${t.party?.id}:${t.course}:${t.diners.map((d) => `${d.cocktail?.id}:${Math.floor((d.cocktail?.percent ?? 0) / 10)}:${!!d.restroomTrip}:${d.item.id}:${d.deliveredAt !== undefined}:${d.finished}:${d.cleared}:${Math.floor(d.water * 10)}`).join(",")}`;
    if (g.userData.signature === signature) return;
    this.clear(g);
    g.userData.signature = signature;
    if (t.stage === "empty") return;
    const skin = ["#d9ac88", "#9e7052", "#e5bd9a", "#bc8765"],
      clothes = ["#b9604d", "#71939c", "#d2ac58", "#6e7893", "#b48399"];
    for (let i = 0; i < t.diners.length; i++) {
      const d = t.diners[i],
        a = (i / t.seats) * Math.PI * 2,
        sx = Math.sin(a),
        sz = Math.cos(a);
      if (!["dirty", "arriving", "leaving"].includes(t.stage) && !d.restroomTrip) {
        const p = this.person(
          clothes[(t.party!.id + i) % clothes.length],
          skin[(t.party!.id + i) % skin.length],
          true,
        );
        p.position.set(sx * 1.2, 0.1, sz * 1.2);
        p.rotation.y = a + Math.PI;
        p.name = `diner-${d.id}`;
        const phone = this.box(p, 0.18, 1.22, 0.35, 0.13, 0.025, 0.23, "#25364d");
        phone.name = "phone";
        const screen = this.box(phone, 0, 0.015, 0, 0.10, 0.005, 0.18, "#8dd6ed");
        screen.castShadow = false;
        phone.visible = false;
        g.add(p);
      }
      if (["reading", "order", "dessert_reading", "dessert_order"].includes(t.stage)) {
        const menu = this.box(
          g,
          sx * 0.6,
          1.24,
          sz * 0.6,
          0.3,
          0.025,
          0.4,
          "#25493c",
        );
        menu.rotation.y = a;
      }
      if (d.cocktail) {
        const cx = sx * 0.68 - Math.cos(a) * 0.24, cz = sz * 0.68 + Math.sin(a) * 0.24;
        this.cylinder(g, cx, 1.30, cz, 0.09, 0.18, "#e0dcca");
        if (d.cocktail.percent > 0) this.cylinder(g, cx, 1.34, cz, 0.075, 0.10 * d.cocktail.percent / 100, d.cocktail.color);
      }
      if (d.deliveredAt !== undefined && !d.cleared) {
        this.cylinder(g, sx * 0.56, 1.25, sz * 0.56, 0.24, 0.04, "#fff5e0");
        if (!d.finished) {
          const meal = this.sphere(
            g,
            sx * 0.56,
            1.29,
            sz * 0.56,
            0.15,
            d.item.color,
          );
          meal.scale.y = 0.35;
          meal.name = `meal-${d.id}`;
        } else
          this.cylinder(g, sx * 0.56, 1.28, sz * 0.56, 0.065, 0.01, "#b8a380");
      }
      if (!["arriving", "leaving"].includes(t.stage)) {
        const x = sx * 0.6 + Math.cos(a) * 0.26,
          z = sz * 0.6 - Math.sin(a) * 0.26;
        this.cylinder(g, x, 1.31, z, 0.065, 0.19, "#cee2d8");
        if (d.water > 0.05)
          this.cylinder(
            g,
            x,
            1.225 + d.water * 0.09,
            z,
            0.057,
            d.water * 0.17,
            "#6baeb5",
          );
      }
    }
  }
  captureMotion() {
    this.previousTime = this.sim.now;
    for (const s of this.sim.servers)
      this.previousServers.set(s.id, { position: { ...s.position }, path: s.job?.path.map((p) => ({ ...p })) ?? [], walking: s.walking });
  }
  draw(alpha = 1) {
    alpha = THREE.MathUtils.clamp(alpha, 0, 1);
    this.renderTime = this.previousTime + (this.sim.now - this.previousTime) * alpha;
    for (const t of this.sim.tables) this.updateTable(t);
    for (const t of this.sim.tables)
      for (const d of t.diners) {
        const observation = observeDiner(t, d, this.sim.now),
          group = this.tables.get(t.id)!;
        const person = group.getObjectByName(`diner-${d.id}`);
        if (person) {
          person.getObjectByName("phone")!.visible = observation.activity === "using phone";
          const phase = this.renderTime * 2 + d.id;
          person.rotation.z =
            observation.activity === "talking" ? Math.sin(phase) * 0.04 : 0;
          const arm = person.getObjectByName("arm1");
          if (arm)
            arm.rotation.x =
              observation.activity === "eating"
                ? -0.45 - Math.sin(phase) * 0.4
                : observation.activity === "using phone" ? -0.9
                : observation.activity === "signalling for service" ? -2.3 + Math.sin(phase) * .15
                : ["talking", "speaking to server"].includes(observation.activity)
                  ? Math.sin(phase) * 0.22
                  : 0;
        }
        const meal = group.getObjectByName(`meal-${d.id}`);
        if (meal && observation.course) {
          const amount = Math.max(
            0.15,
            Math.sqrt(1 - observation.course.completionPercent / 100),
          );
          meal.scale.set(amount, 0.35, amount);
        }
      }
    for (const s of this.sim.servers) this.updateServer(s, alpha);
    this.drawGuests();
    const ready = this.sim.kitchen.ready(this.sim.now),
      signature = ready.map((d) => d.id).join(",");
    if (signature !== this.passSignature) {
      this.clear(this.pass);
      this.passSignature = signature;
      ready.slice(0, 10).forEach((d, i) => {
        const x = 1.25 + (i % 5) * 0.58,
          y = 1.19 + Math.floor(i / 5) * 0.13;
        this.cylinder(this.pass, x, y, 0, 0.23, 0.04, "#f8f0df");
        const food = this.sphere(this.pass, x, y + 0.05, 0, 0.14, d.item.color);
        food.scale.y = 0.35;
      });
    }
    const drinks = this.sim.bar.ready(this.sim.now), barSignature = drinks.map((d) => d.id).join(",");
    if (barSignature !== this.barSignature) {
      this.clear(this.barDisplay); this.barSignature = barSignature;
      drinks.slice(0, 8).forEach((drink, i) => {
        const x = this.sim.layout.bar.x - 0.8 + i % 4 * 0.45;
        const z = this.sim.config.stationPlacement === "split" ? this.sim.layout.height - 1 : 0;
        this.cylinder(this.barDisplay, x, 1.34 + Math.floor(i / 4) * 0.18, z, 0.075, 0.18, drink.item.color);
      });
    }
    this.cameraGroup.visible = this.cameras;
    this.controls.update();
    this.drawSpeechBubbles();
    this.renderer.render(this.scene, this.camera);
    const w = this.host.clientWidth,
      h = this.host.clientHeight;
    for (const s of this.sim.servers) {
      const marker = this.serverMarkers.get(s.id)!;
      const pos = this.serverMeshes.get(s.id)!.position.clone().add(new THREE.Vector3(0, 1.9, 0)).project(this.camera);
      marker.hidden = pos.z >= 1 || Math.abs(pos.x) > 1 || Math.abs(pos.y) > 1 || this.bubbles.isVisible(`server-${s.id}`);
      marker.style.left = `${(pos.x + 1) * w / 2}px`;
      marker.style.top = `${(1 - pos.y) * h / 2}px`;
    }
    for (const label of this.labels) {
      const t = this.sim.tables[label.table - 1],
        pos = label.point.clone().project(this.camera);
      label.element.style.display =
        this.overlays &&
        pos.z < 1 &&
        Math.abs(pos.x) < 1.1 &&
        Math.abs(pos.y) < 1.1
          ? ""
          : "none";
      label.element.style.left = `${((pos.x + 1) * w) / 2}px`;
      label.element.style.top = `${((1 - pos.y) * h) / 2}px`;
      label.element.className = `table-label ${t.request ? "request" : t.stage} ${this.selected === t.id ? "selected" : ""}`;
      const state = t.request ? "Guest needs help" : stageLabel(t.stage);
      const html = `<b>${String(t.id).padStart(2, "0")}</b><span class="marker-status" aria-hidden="true">${t.request ? "!" : stageGlyph[t.stage]}</span>`;
      if (label.element.innerHTML !== html) label.element.innerHTML = html;
      label.element.dataset.state = `Table ${t.id} · ${state}`;
      label.element.setAttribute("aria-description", state);
      label.element.title = `Table ${t.id}: ${state}. Click for details.`;
      // Shrink with the projected table when zooming out; never grow into a banner.
      const edge = new THREE.Vector3(t.x + 1.8, 1.3, t.y - 1.06).project(
        this.camera,
      );
      const pixels = Math.hypot(
        ((edge.x - pos.x) * w) / 2,
        ((edge.y - pos.y) * h) / 2,
      );
      label.element.style.setProperty(
        "--marker-scale",
        String(THREE.MathUtils.clamp(pixels / 48, 0.55, 1)),
      );
    }
  }
  drawSpeechBubbles() {
    this.bubbles.draw(() => {
      const anchors: BubbleAnchor[] = [];
      for (const s of this.sim.servers) anchors.push({
        id: `server-${s.id}`, kind: "server", label: `S${s.id} · ${s.name}`,
        utterance: () => serverDialogue(s, this.sim.now, this.sim.pendingDecision?.context.server.id === s.id, this.bubbles.dialogue),
        person: () => this.serverMeshes.get(s.id),
        group: s.interruptUntil > this.sim.now && s.interruptTable ? `table-${s.interruptTable}` : s.job?.table ? `table-${s.job.table}` : `server-${s.id}`,
        priority: serverBubblePriority(s, this.sim.now, this.sim.pendingDecision?.context.server.id === s.id),
      });
      for (const t of this.sim.tables) {
        if (!t.party || ["empty", "dirty"].includes(t.stage)) continue;
        const partyId = t.party.id;
        const serving = this.sim.servers.find((s) => s.job?.table === t.id && s.job.startedService && !s.job.path.length && !["supplies", "patrol"].includes(s.job.kind));
        for (const [i, d] of t.diners.entries()) {
          const person = () => {
            if (t.party?.id !== partyId) return undefined;
            return d.restroomTrip ? this.guestGroups.get(`restroom:${partyId}:${d.id}`)
              : ["arriving", "leaving"].includes(t.stage) ? this.guestGroups.get(`${partyId}:${t.stage}`)?.children[i]
              : this.tables.get(t.id)?.getObjectByName(`diner-${d.id}`);
          };
          if (!person()?.visible) continue;
          anchors.push({ id: `guest-${partyId}-${d.id}`, kind: "customer", label: `T${t.id} · Diner ${d.id}`,
            utterance: () => dinerDialogue(t, d, this.sim.now, this.bubbles.dialogue, serving?.job?.kind), person,
            group: `table-${t.id}`, priority: dinerBubblePriority(t, d) });
        }
      }
      for (const party of this.sim.queue.slice(0, 4)) anchors.push({
        id: `queue-${party.id}`, kind: "customer", label: `Party ${party.id}`,
        person: () => this.guestGroups.get(`queue:${party.id}`)?.children[0], group: "queue", priority: 1,
        utterance: () => ({ text: this.bubbles.dialogue.pick("queue", `queue-${party.id}`, String(Math.floor(this.sim.now / 27))), style: "thought", cue: "queue" }),
      });
      return anchors;
    }, this.camera);
  }
  updateServer(s: Server, alpha: number) {
    const g = this.serverMeshes.get(s.id)!;
    const previous = this.previousServers.get(s.id);
    const travelled = previous ? s.walking - previous.walking : 0;
    const route = previous ? [previous.position, ...(previous.path.length ? previous.path : [s.position])] : [s.position];
    const pose = samplePath(route, travelled * alpha);
    g.position.set(pose.position.x, 0.08, pose.position.y);
    if (travelled > 0) g.rotation.y = pose.heading;
    for (const side of [-1, 1])
      g.getObjectByName(`leg${side}`)!.rotation.x =
        travelled > 0
          ? Math.sin(this.renderTime * 9) * 0.35 * side
          : 0;
    g.getObjectByName("food")!.visible = s.plates.length > 0;
    g.getObjectByName("tray")!.visible = s.plates.length + s.drinks.length + s.dirty > 0;
    g.getObjectByName("cocktail")!.visible = s.drinks.length > 0;
    g.getObjectByName("pitcher")!.visible = s.pitcher && s.water > 0;
  }
  updateRoutes() {
    this.clear(this.routeGroup);
    this.routeCount = 0;
    this.host.dataset.routeSegments = "0";
    if (!this.paths) return;
    let segments = 0;
    for (const s of this.sim.servers)
      if (s.job) {
        const points = [s.position, ...s.job.path];
        if (points.length > 1) this.routeCount++;
        const material = new THREE.MeshBasicMaterial({
          color: s.color,
          depthTest: false,
          depthWrite: false,
        });
        const border = new THREE.MeshBasicMaterial({
          color: "#172b32",
          depthTest: false,
          depthWrite: false,
        });
        for (let i = 1; i < points.length; i++) {
          const a = points[i - 1],
            b = points[i],
            dx = b.x - a.x,
            dz = b.y - a.y,
            length = Math.hypot(dx, dz);
          if (length < 0.005) continue;
          for (const [width, mat, order] of [
            [0.19, border, 20],
            [0.105, material, 21],
          ] as const) {
            const line = new THREE.Mesh(
              new THREE.BoxGeometry(length + 0.03, 0.025, width),
              mat,
            );
            line.position.set((a.x + b.x) / 2, 0.2, (a.y + b.y) / 2);
            line.rotation.y = -Math.atan2(dz, dx);
            line.renderOrder = order;
            this.routeGroup.add(line);
          }
          if (i % 3 === 0) {
            const arrow = new THREE.Mesh(
              new THREE.ConeGeometry(0.16, 0.35, 3),
              material,
            );
            arrow.position.set(b.x, 0.21, b.y);
            arrow.quaternion.setFromUnitVectors(
              new THREE.Vector3(0, 1, 0),
              new THREE.Vector3(dx / length, 0, dz / length),
            );
            arrow.renderOrder = 22;
            this.routeGroup.add(arrow);
          }
          segments++;
        }
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(0.22, 0.32, 24),
          new THREE.MeshBasicMaterial({
            color: s.color,
            side: THREE.DoubleSide,
            depthTest: false,
            depthWrite: false,
          }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(s.job.destination.x, 0.22, s.job.destination.y);
        ring.renderOrder = 22;
        this.routeGroup.add(ring);
      }
    for (const server of this.sim.servers) {
      let from = server.job?.destination ?? server.position;
      for (const stop of server.itinerary) {
        const path = [from, ...findPath(this.sim.layout, from, stop.destination)];
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(path.map((p) => new THREE.Vector3(p.x, 0.22, p.y))),
          new THREE.LineDashedMaterial({ color: server.color, dashSize: 0.32, gapSize: 0.22, depthTest: false, transparent: true, opacity: 0.8 }));
        line.computeLineDistances(); line.renderOrder = 23; this.routeGroup.add(line);
        from = stop.destination;
      }
    }
    this.host.dataset.routeSegments = String(segments);
  }
  drawGuests() {
    const active = new Set<string>();
    const moving = this.sim.tables.filter((t) =>
      ["arriving", "leaving"].includes(t.stage),
    );
    for (const t of moving) {
      const groupKey = `${t.party!.id}:${t.stage}`;
      active.add(groupKey);
      let g = this.guestGroups.get(groupKey);
      if (!g) {
        g = new THREE.Group();
        for (const d of t.diners) {
          const person = this.walkingGuest(t, d.id);
          const path = guestRoute(this.sim.layout, t, d.id, this.sim.layout.entrance);
          person.userData.path = t.stage === "arriving" ? path.reverse() : path;
          person.userData.length = pathLength(path);
          g.add(person);
        }
        this.transit.add(g);
        this.guestGroups.set(groupKey, g);
      }
      g.children.forEach((person, i) => {
        const elapsed = Math.max(0, this.renderTime - t.since - i * 0.4);
        const pose = samplePath(person.userData.path, elapsed * GUEST_SPEED);
        person.position.set(pose.position.x, 0.08, pose.position.y);
        person.rotation.y = pose.heading;
        this.walkCycle(person, elapsed > 0 && elapsed * GUEST_SPEED < person.userData.length, i);
      });
    }
    for (const t of this.sim.tables) for (const d of t.diners) {
      if (!d.restroomTrip) continue;
      const trip = d.restroomTrip, k = `restroom:${t.party!.id}:${d.id}`;
      active.add(k);
      let person = this.guestGroups.get(k);
      if (!person) {
        person = this.walkingGuest(t, d.id);
        this.transit.add(person);
        this.guestGroups.set(k, person);
      }
      const elapsed = Math.max(0, this.renderTime - trip.startedAt);
      const returning = elapsed >= trip.walkSeconds + trip.insideSeconds;
      person.visible = elapsed < trip.walkSeconds || returning;
      if (person.visible) {
        const pose = samplePath(returning ? [...trip.path].reverse() : trip.path,
          (returning ? elapsed - trip.walkSeconds - trip.insideSeconds : elapsed) * GUEST_SPEED);
        person.position.set(pose.position.x, 0.08, pose.position.y);
        person.rotation.y = pose.heading;
        this.walkCycle(person, true, d.id);
      }
    }
    for (const p of this.sim.queue.slice(0, 4)) {
      const k = `queue:${p.id}`;
      active.add(k);
      let g = this.guestGroups.get(k);
      const index = this.sim.queue.indexOf(p);
      if (!g) {
        g = new THREE.Group();
        for (let i = 0; i < p.size; i++) {
          const person = this.person(
            ["#b9604d", "#71939c", "#d2ac58", "#6e7893"][i],
            "#d9ac88",
          );
          person.position.set(i * 0.45, 0, 0);
          g.add(person);
        }
        this.transit.add(g);
        this.guestGroups.set(k, g);
      }
      g.position.set(0.2, 0.08, this.sim.layout.entrance.y + 0.3 - index * 0.7);
    }
    for (const [k, g] of this.guestGroups)
      if (!active.has(k)) {
        this.clear(g);
        this.transit.remove(g);
        this.guestGroups.delete(k);
      }
  }
  walkingGuest(t: TableState, dinerId: number) {
    const i = t.party!.id + dinerId - 1;
    return this.person(["#b9604d", "#71939c", "#d2ac58", "#6e7893", "#b48399"][i % 5],
      ["#d9ac88", "#9e7052", "#e5bd9a", "#bc8765"][i % 4]);
  }
  walkCycle(person: THREE.Object3D, moving: boolean, phase: number) {
    for (const side of [-1, 1]) {
      const swing = moving ? Math.sin(this.renderTime * 8 + phase) * 0.32 * side : 0;
      person.getObjectByName(`leg${side}`)!.rotation.x = swing;
      person.getObjectByName(`arm${side}`)!.rotation.x = -swing * 0.65;
    }
  }
}
export const stageLabel = (stage: TableState["stage"]) =>
  ({
    empty: "Available",
    arriving: "Seating",
    greet: "Waiting for menus",
    reading: "Reading menus",
    order: "Ready to order",
    cooking: "Waiting for food",
      eating: "Eating / conversation",
      between: "Clear plates for mains",
      dessert_offer: "Clear plates / offer dessert",
      dessert_reading: "Reading dessert menus",
      dessert_order: "Ready to order dessert",
      lingering: "Paid · lingering",
    pay: "Waiting to pay",
    leaving: "Leaving",
    dirty: "Needs clearing",
  })[stage];
const stageGlyph: Record<TableState["stage"], string> = {
  empty: "·",
  arriving: "↘",
  greet: "M",
  reading: "≡",
  order: "O",
  cooking: "F",
  eating: "●",
  between: "C",
  dessert_offer: "D",
  dessert_reading: "≡",
  dessert_order: "O",
  lingering: "…",
  pay: "$",
  leaving: "↗",
  dirty: "C",
};
