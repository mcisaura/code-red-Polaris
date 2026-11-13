// AirDeck landing page: the 3D cabinet, the sky and the preview beat.
//
// The cabinet is ~470 pieces that morph between three forms, one per mode:
//   arcade cabinet (voxel cubes) → turntable (glass bubbles) → headphones (bubbles)
// Each 120° of rotation moves to the next form. You turn it by dragging, with the
// automatic cycling, or by hovering/focusing a launch button.
// Everything is drawn with Canvas 2D; the clouds are generated from fBm noise.

import { loadConfig } from "./queue.js";
import { createYtEmbed } from "./ytEmbed.js";

const TAU = Math.PI * 2;
const AUTO_TURN_SPEED = TAU / 24; // all three forms every 24 seconds
const MUSIC_VOLUME = 0.12;
const STEP = TAU / 3;          // rotation between forms
const PITCH = 0.3;             // camera looks slightly down so top faces show
const BPM = 112;
const VC = { x: -2.1, z: 0 };  // vinyl center in turntable model space
const MODES = ["arcade", "dj", "ai"];
const LIGHT = (() => { const l = [-0.35, 0.75, 0.55], m = Math.hypot(...l); return l.map((v) => v / m); })();
const FACES = [
  { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] }, { n: [-1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] }, { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, { n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0] },
];

// Hand tracking (loaded only when "Use your hand" is clicked)
const TASKS_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const WASM_URL = TASKS_URL + "/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const HAND_GAIN = 7;           // radians of turn per full frame width of hand travel

// Landing page music, shuffled on every page load. Each song plays from
// music/<id>.m4a when that file exists (fast, works on any static host);
// otherwise server.py's /api/youtube downloads it once into downloads/. The hosted site has no audio
// files unless /library.json lists songs with hosted: true: those play from /music/<id>.m4a through the
// same <audio> + analyser as local, starting at page load when the browser allows sound, else on the first
// gesture. Without hosted songs it plays the same ids through YouTube's own embedded player in the "Now playing" card.
// An entry may carry beat: { bpm, first } (or bpm) for the hosted pulse; the default is BPM.
const PLAYLIST = [
  { title: "New Look (Wii U Mii Maker Lofi Mix)", artist: "Secret Potion", id: "NoWJIeNtFds" },
  { title: "Butterflies", artist: "Tsundere Twintails", id: "11dAGSfNvMI" },
  { title: "LEASE", artist: "Takeshi Abo", id: "tjlvmb8SGEs" },
  { title: "three", artist: "Cult Member", id: "R_IHpuTu7ww" },
  { title: "bubble fountain", artist: "frutiger pm", id: "YCMg8zEVWHs" },
  { title: "aquatic ambience", artist: "scizzie", id: "DP3rDP02lE0" },
  { title: "U Weren't Here I Really Miss You", artist: "Cult Member", id: "N6IaHiLN34c" },
  { title: "Dire Dire Docks (Trap Remix)", artist: "OSRSBeatz", id: "WYToS6e4Zm4" },
  { title: "Wii Party Main Menu Theme (Lofi Mix)", artist: "Nostalgiacore", id: "-olyU4FxIqY" },
  { title: "reflection pond", artist: "frutiger pm", id: "K2NQ8tnSzBY" },
];

const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
function shadeStr(c, s) {
  let r, g, b;
  if (s <= 1) { r = c[0] * s; g = c[1] * s; b = c[2] * s; }
  else { const k = Math.min(1, s - 1); r = c[0] + (255 - c[0]) * k; g = c[1] + (255 - c[1]) * k; b = c[2] + (255 - c[2]) * k; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}
// Model space → world space for one form: scale, own yaw, tilt toward the camera,
// then undo the view rotation at the form's face angle so it faces front there.
function makeXf(K, cyo, tilt, yawOwn, lift, face) {
  const ct = Math.cos(tilt), st = Math.sin(tilt), cw = Math.cos(yawOwn), sw = Math.sin(yawOwn), cf = Math.cos(face), sf = Math.sin(face);
  return (x, y, z, o) => {
    x *= K; y = (y + cyo) * K; z *= K;
    const x1 = x * cw + z * sw, z1 = -x * sw + z * cw;
    const y2 = y * ct - z1 * st + lift, z2 = y * st + z1 * ct;
    o.x = x1 * cf - z2 * sf; o.y = y2; o.z = x1 * sf + z2 * cf;
  };
}

class Landing {
  constructor() {
    this.cv = document.getElementById("sky");
    this.fcv = document.getElementById("front");
    this.stage = document.getElementById("stage");
    this.mode = "arcade"; this.playing = false;
    // rotation
    this.dragYaw = 0; this.vel = 0; this.target = null; this.grab = null;
    this.preview = null; this.autoplayPending = true;
    this.spin = 0; this.spinV = 0; this.swayA = 1;
    // audio-driven
    this.kick = 0; this.bass = 0; this.beats = [];
    // music: a fresh random order every time the page opens
    this.list = PLAYLIST;
    this.shuffleOrder();
    this.src = "music"; this.track = null; this.status = ""; this.trackPos = 0; this.loadToken = 0; this.fails = 0;
    this.eHist = []; this.prevE = 0; this.lastBeat = 0;
    this.ripples = []; this.bubs = []; this.bubT = 0;
    this.mx = -9999; this.my = -9999;
    this.rm = matchMedia("(prefers-reduced-motion: reduce)").matches;

    this.build(); this.makeSprites(); this.initClouds(); this.bindUI();
    new ResizeObserver(() => this.resize()).observe(this.cv);
    this.resize();
    requestAnimationFrame(this.frame);
    this.initMusic();
  }

  // ---- UI wiring -------------------------------------------------------------
  bindUI() {
    const s = this.stage;
    s.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button, a")) return;
      this.startGrab(e.clientX / this.W, e.pointerId);
      s.setPointerCapture(e.pointerId);
    });
    s.addEventListener("pointermove", (e) => { if (this.grab && this.grab.id === e.pointerId) this.moveGrab(e.clientX / this.W, 0.009 * this.W); });
    const up = (e) => { if (this.grab && this.grab.id === e.pointerId) this.endGrab(); };
    s.addEventListener("pointerup", up);
    s.addEventListener("pointercancel", up);
    addEventListener("pointermove", (e) => {
      const r = this.cv.getBoundingClientRect();
      this.mx = e.clientX - r.left; this.my = e.clientY - r.top;
    }, { passive: true });

    this.segs = [...document.querySelectorAll(".seg")];
    this.segs.forEach((b) => b.addEventListener("click", () => this.goTo(MODES.indexOf(b.dataset.mode) * STEP)));
    document.getElementById("play").addEventListener("click", () => this.togglePlay());
    document.getElementById("skip").addEventListener("click", () => this.skipMusic());
    this.bindCard();
    const previews = [...document.querySelectorAll("[data-preview]")];
    const updatePreview = () => {
      const active = previews.find((b) => b.matches(":hover") || b === document.activeElement);
      this.preview = active?.dataset.preview || null;
      if (this.preview) this.goTo(MODES.indexOf(this.preview) * STEP);
    };
    previews.forEach((b) => ["pointerenter", "pointerleave", "focus", "blur"].forEach((event) => b.addEventListener(event, updatePreview)));
    const unlock = (e) => {
      if (this.hostedAudio || !this.autoplayPending || e.target.closest("#play, #skip")) return;  // hosted audio has its own earliest-gesture listeners
      this.startBackgroundMusic(true);
    };
    document.addEventListener("pointerdown", unlock);
    document.addEventListener("keydown", unlock);
  }

  setMode(m) {
    if (m === this.mode) return;
    this.mode = m;
    this.segs.forEach((b) => { const on = b.dataset.mode === m; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
  }

  // ---- Rotation: one "grab" at a time, from the mouse or from a hand -------------
  // x is in frame-width units; gain turns that into radians.
  startGrab(x, id) { this.grab = { id, x, t: performance.now() }; this.vel = 0; this.target = null; }
  moveGrab(x, gain) {
    const g = this.grab, now = performance.now(), dyaw = (x - g.x) * gain;
    this.dragYaw += dyaw;
    this.vel = dyaw / Math.max(0.008, (now - g.t) / 1000);
    g.x = x; g.t = now;
  }
  endGrab() {
    if (performance.now() - this.grab.t > 90) this.vel = 0;
    this.vel = Math.max(-9, Math.min(9, this.vel));
    this.grab = null;
    if (Math.abs(this.vel) < 0.8) this.snap();
  }
  snap() { this.target = Math.round(this.dragYaw / STEP) * STEP; this.vel = 0; }
  goTo(face) { const k = Math.round((this.dragYaw - face) / TAU); this.target = face + k * TAU; this.vel = 0; }

  // ---- Hand control: sweep an open hand left/right to turn the cabinet ----------
  async toggleHand() {
    const run = this.handRun = (this.handRun || 0) + 1;
    const btn = document.getElementById("handBtn"), note = document.getElementById("handNote");
    const status = document.getElementById("handStatus"), cam = document.getElementById("handCam");
    if (this.handOn) {
      this.handOn = false;
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null; cam.srcObject = null;
      if (this.grab && this.grab.id === "hand") this.endGrab();
      btn.setAttribute("aria-pressed", "false"); document.getElementById("handLabel").textContent = "Use your hand";
      note.hidden = true;
      return;
    }
    this.handOn = true;
    btn.setAttribute("aria-pressed", "true"); document.getElementById("handLabel").textContent = "Hand control on";
    note.hidden = false; status.textContent = "Loading hand tracking…";
    try {
      if (!this.landmarker) {
        const { HandLandmarker, FilesetResolver } = await import(TASKS_URL);
        const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
        const opts = (delegate) => ({ baseOptions: { modelAssetPath: MODEL_URL, delegate }, runningMode: "VIDEO", numHands: 1 });
        try { this.landmarker = await HandLandmarker.createFromOptions(fileset, opts("GPU")); }
        catch { this.landmarker = await HandLandmarker.createFromOptions(fileset, opts("CPU")); }
      }
      if (run !== this.handRun || !this.handOn) return;
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" }, audio: false });
      if (run !== this.handRun || !this.handOn) { stream.getTracks().forEach(t => t.stop()); return; }
      this.stream = stream;
      cam.srcObject = stream; await cam.play();
      if (run !== this.handRun || !this.handOn) return;
      status.textContent = "Show an open hand and sweep it left or right";
      let lastTime = -1;
      const tick = () => {
        if (run !== this.handRun || !this.handOn) return;
        if (cam.currentTime !== lastTime) {
          lastTime = cam.currentTime;
          const res = this.landmarker.detectForVideo(cam, performance.now());
          this.onHand(res.landmarks[0] || null, cam);
        }
        cam.requestVideoFrameCallback ? cam.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
      };
      tick();
    } catch (err) {
      if (run !== this.handRun) return;
      this.stream?.getTracks().forEach(t => t.stop());
      this.stream = null; cam.srcObject = null; this.handOn = false;
      btn.setAttribute("aria-pressed", "false"); document.getElementById("handLabel").textContent = "Use your hand";
      status.textContent = "Camera unavailable: " + err.message;
    }
  }

  onHand(lms, cam) {
    // Open hand = at least 3 of the 4 fingertips farther from the wrist than their middle joints.
    let open = false, x = 0;
    if (lms) {
      const w = lms[0], d = (a) => Math.hypot(a.x - w.x, a.y - w.y);
      open = [[8, 6], [12, 10], [16, 14], [20, 18]].filter(([tip, pip]) => d(lms[tip]) > d(lms[pip]) * 1.15).length >= 3;
      x = 1 - [0, 5, 9, 13, 17].reduce((s, i) => s + lms[i].x, 0) / 5;  // mirrored palm center
    }
    cam.classList.toggle("tracking", open);
    const holding = this.grab && this.grab.id === "hand";
    if (open) {
      this.handX = this.handX == null || !holding ? x : this.handX + (x - this.handX) * 0.5;
      if (!holding) { if (!this.grab) this.startGrab(this.handX, "hand"); }
      else if (Math.abs(this.handX - this.grab.x) > 0.002) this.moveGrab(this.handX, HAND_GAIN);
    } else if (holding) this.endGrab();
  }

  // ---- Geometry ----------------------------------------------------------------
  build() {
    const A = [], B = [], Hp = [], Wd = 7, o = {};
    // Arcade cabinet, voxel by voxel (only surface voxels are kept)
    const C = { side: "#1f9fe6", front: "#f3f9fd", trim: "#c4e5f8", screen: "#0d4b70", pix: "#8ff5ff", ball: "#ffffff", marquee: "#86cf45", top: "#ffffff", p1: "#ff8a3d", p2: "#86cf45", stem: "#dce8f1", door: "#cfe7f6", slot: "#ff8a3d" };
    const cell = (x, y, z) => {
      if (x < 0 || x >= Wd || y < 0 || z < 0) return null;
      const side = x === 0 || x === Wd - 1;
      if (y <= 6) { if (z > 4) return null; if (side) return C.side; if (z === 4 && y >= 2 && y <= 4 && x >= 2 && x <= 4) return x === 3 && y === 3 ? C.slot : C.door; return C.front; }
      if (y <= 8) { if (z > 6) return null; if (side) return C.side; if (y === 8 && z === 4 && (x === 2 || x === 4)) return x === 2 ? C.p1 : C.p2; return y === 8 ? C.trim : C.front; }
      if (y <= 14) {
        if (side) return z <= 3 ? C.side : null;
        if (z <= 1) return C.front;
        if (z === 2) {  // screen with a little Pong rally
          if ((x === 1 && (y === 11 || y === 12)) || (x === 5 && (y === 10 || y === 11))) return C.pix;
          if (x === 3 && y === 12) return C.ball;
          return C.screen;
        }
        return null;
      }
      if (y <= 17) { if (z > 4) return null; if (side) return C.side; if (y === 17) return C.top; if (z === 4) return C.marquee; return C.front; }
      return null;
    };
    for (let x = 0; x < Wd; x++) for (let y = 0; y <= 17; y++) for (let z = 0; z <= 6; z++) {
      const c = cell(x, y, z); if (!c) continue;
      if (cell(x + 1, y, z) && cell(x - 1, y, z) && cell(x, y + 1, z) && cell(x, y - 1, z) && cell(x, y, z + 1) && cell(x, y, z - 1)) continue;
      A.push({ x: x - 3, y: y - 8.5, z: z - 3, c, r: 0.5 });
    }
    for (const [x, y, z, c] of [[1, 9, 5, C.stem], [1, 10, 5, C.p1], [5, 9, 5, C.stem], [5, 10, 5, C.p2]]) A.push({ x: x - 3, y: y - 8.5, z: z - 3, c, r: 0.5 });

    // Turntable: plinth, vinyl (spins only while dragged), tonearm, knobs, crossfader
    const D = { plinth: "#bfe3fb", edge: "#7cc4ee", vinyl: "#1f3d63", groove: "#3f7fb8", label: "#86cf45", label2: "#ffffff", arm: "#e8f1f7", k1: "#1f9fe6", k2: "#ff8a3d", k3: "#86cf45", slot: "#1f3d63", cap: "#ff8a3d" };
    const S = 0.85;
    for (let i = 0; i < 15; i++) for (let j = 0; j < 11; j++) {
      const x = (i - 7) * S, z = (j - 5) * S;
      B.push({ x, y: 0, z, c: D.plinth, r: 0.56 });
      if (j === 10 || i === 0 || i === 14) B.push({ x, y: -S, z, c: D.edge, r: 0.56 });
    }
    for (let ring = 0; ring <= 6; ring++) {
      const rr = ring * 0.55, n = ring === 0 ? 1 : Math.round(TAU * rr / 0.55);
      for (let k = 0; k < n; k++) {
        const a = k / n * TAU;
        const c = ring <= 1 ? D.label : ring === 2 ? (a < Math.PI ? D.label : D.label2) : (k % 7 === 0 ? D.groove : D.vinyl);
        B.push({ x: VC.x + Math.cos(a) * rr, y: 0.75, z: VC.z + Math.sin(a) * rr, c, r: 0.36, spin: { r: rr, a } });
      }
    }
    B.push({ x: 1.6, y: 0.95, z: -3.4, c: D.arm, r: 0.62 });
    for (let k = 1; k <= 7; k++) { const t = k / 7; B.push({ x: 1.6 - 1.2 * t, y: 1.3, z: -3.4 + 4.4 * t, c: D.arm, r: 0.28 }); }
    for (const [x, z, c] of [[3.2, -3.2, D.k1], [4.8, -3.2, D.k2], [3.2, -1.8, D.k3], [4.8, -1.8, D.k1], [3.2, -0.4, D.k2], [4.8, -0.4, D.k3]]) B.push({ x, y: 0.8, z, c, r: 0.5 });
    for (let k = 0; k < 7; k++) B.push({ x: 2.8 + k * 0.4, y: 0.45, z: 2.4, c: D.slot, r: 0.24 });
    B.push({ x: 3.6, y: 0.95, z: 2.4, c: D.cap, r: 0.5 });
    B.push({ x: -5.2, y: 0.7, z: 3.3, c: D.k3, r: 0.45 });
    B.push({ x: -4.2, y: 0.7, z: 3.3, c: D.k2, r: 0.45 });

    // Headphones: two-layer headband, yokes, ear cups with cushions
    const Hc = { band: "#f4f9fd", bandIn: "#bfe3fb", cup: "#1f9fe6", rim: "#ffffff", cushion: "#e8f1f7", accent: "#86cf45", yoke: "#dce8f1" };
    for (let layer = 0; layer < 2; layer++) {
      const R = layer ? 5.3 : 6.0, nb = Math.round(R * (Math.PI - 0.42) / 0.75);
      for (let k = 0; k <= nb; k++) {
        const ang = 0.21 + (Math.PI - 0.42) * k / nb;
        for (const z of [-0.4, 0.4]) Hp.push({ x: Math.cos(ang) * R, y: 2 + Math.sin(ang) * R, z, c: layer ? Hc.bandIn : Hc.band, r: 0.48 });
      }
    }
    for (const sd of [-1, 1]) {
      Hp.push({ x: sd * 5.95, y: 2.5, z: 0, c: Hc.yoke, r: 0.42 });
      Hp.push({ x: sd * 6.05, y: 1.95, z: 0, c: Hc.yoke, r: 0.42 });
      const disc = (x, rings, colFn, r) => rings.forEach((r0, ri) => {
        const nn = r0 === 0 ? 1 : Math.round(TAU * r0 / 0.6);
        for (let m = 0; m < nn; m++) { const a = m / nn * TAU; Hp.push({ x, y: -0.6 + Math.sin(a) * r0 * 1.1, z: Math.cos(a) * r0 * 0.9, c: colFn(ri), r }); }
      });
      disc(sd * 6.6, [0, 0.6, 1.2, 1.8, 2.4], (ri) => (ri <= 1 ? Hc.accent : ri === 4 ? Hc.rim : Hc.cup), 0.4);
      disc(sd * 6.15, [2.4], () => Hc.cup, 0.42);
      disc(sd * 5.7, [1.5, 2.1], () => Hc.cushion, 0.42);
    }

    this.xf = [null, makeXf(1.25, -0.2, 0.8, 0, 0.6, STEP), makeXf(1.1, -2.4, 0.12, 0.55, 0.2, 2 * STEP)];
    this.opaque = new Set(["#1f3d63", "#3f7fb8", "#86cf45", "#ffffff", "#e8f1f7", "#1f9fe6", "#ff8a3d", "#f4f9fd", "#dce8f1"]);
    const forms = [A, B, Hp], scaleK = [1, 1.25, 1.1];
    forms.forEach((F, fi) => {
      for (const p of F) {
        if (fi === 0) { p.tx = p.x; p.ty = p.y; p.tz = p.z; }
        else { this.xf[fi](p.x, p.y, p.z, o); p.tx = o.x; p.ty = o.y; p.tz = o.z; }
        p.tr = p.r * scaleK[fi];
        p.key = p.ty + Math.random() * 0.8;
      }
      F.sort((p, q) => p.key - q.key);  // pair pieces roughly bottom-to-bottom across forms
    });

    this.cols = []; const cidx = {};
    for (const p of A) if (!(p.c in cidx)) { cidx[p.c] = this.cols.length; this.cols.push(hexRgb(p.c)); }
    // Every piece has a slot in all three forms. Forms with fewer slots reuse one;
    // the extra copies ("ghosts", g = 0) shrink away in that form.
    const N = Math.max(A.length, B.length, Hp.length), last = [-1, -1, -1];
    this.pieces = [];
    for (let i = 0; i < N; i++) {
      const u = Math.random() * TAU, v = Math.acos(Math.random() * 2 - 1);
      const pc = { x: [], y: [], z: [], c: [], r: [], g: [], spin: null, d: 0.25 * (1 - i / N) + 0.1 * Math.random(),
        dx: Math.sin(v) * Math.cos(u), dy: Math.cos(v), dz: Math.sin(v) * Math.sin(u),
        R: 3 + Math.random() * 5, sw: (Math.random() - 0.5) * 2.4, vx: 0, vy: 0, vz: 0, s: 0, aI: 0, aJ: 0 };
      for (let fi = 0; fi < 3; fi++) {
        const L = forms[fi], idx = Math.floor(i * L.length / N), p = L[idx];
        pc.x[fi] = p.tx; pc.y[fi] = p.ty; pc.z[fi] = p.tz; pc.r[fi] = p.tr;
        pc.c[fi] = fi === 0 ? cidx[p.c] : p.c;
        pc.g[fi] = idx !== last[fi] ? 1 : 0;
        if (fi === 1 && p.spin) pc.spin = p.spin;
        last[fi] = idx;
      }
      this.pieces.push(pc);
    }
    this.ord = this.pieces.map((_, q) => q);
  }

  // ---- Sprites -----------------------------------------------------------------
  bubbleSprite(hex, opaque) {
    const S = 96, c = document.createElement("canvas"); c.width = c.height = S;
    const g = c.getContext("2d"), rgb = hexRgb(hex), dk = rgb.map((q) => Math.round(q * 0.72));
    const [a0, a1, a2] = opaque ? [0.86, 0.94, 1] : [0.22, 0.42, 0.88];
    const body = g.createRadialGradient(S * 0.42, S * 0.38, S * 0.04, S / 2, S / 2, S * 0.48);
    body.addColorStop(0, `rgba(${rgb},${a0})`); body.addColorStop(0.7, `rgba(${rgb},${a1})`); body.addColorStop(1, `rgba(${dk},${a2})`);
    g.fillStyle = body; g.beginPath(); g.arc(S / 2, S / 2, S * 0.47, 0, TAU); g.fill();
    g.lineWidth = 1.5; g.strokeStyle = "rgba(255,255,255,0.75)"; g.stroke();
    const sp = g.createRadialGradient(S * 0.36, S * 0.3, 0, S * 0.36, S * 0.3, S * 0.2);
    sp.addColorStop(0, "rgba(255,255,255,0.95)"); sp.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = sp; g.beginPath(); g.ellipse(S * 0.36, S * 0.3, S * 0.2, S * 0.13, -0.6, 0, TAU); g.fill();
    g.strokeStyle = "rgba(255,255,255,0.5)"; g.lineWidth = 2.5; g.beginPath(); g.arc(S / 2, S / 2, S * 0.37, 0.15 * Math.PI, 0.6 * Math.PI); g.stroke();
    return c;
  }

  // Value noise + fBm for the clouds
  noiseInit() {
    const v = new Float32Array(256), p = new Uint8Array(512);
    for (let i = 0; i < 256; i++) { v[i] = Math.random(); p[i] = i; }
    for (let i = 255; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
    for (let i = 0; i < 256; i++) p[i + 256] = p[i];
    this.nv = v; this.perm = p;
  }
  noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, P = this.perm, V = this.nv, X = xi & 255, Y = yi & 255;
    const a = V[P[P[X] + Y]], b = V[P[P[X + 1] + Y]], c = V[P[P[X] + Y + 1]], d = V[P[P[X + 1] + Y + 1]];
    const u = xf * xf * (3 - 2 * xf), w = yf * yf * (3 - 2 * yf);
    return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
  }
  fbm(x, y) { let s = 0, amp = 0.5, f = 1; for (let o = 0; o < 5; o++) { s += amp * this.noise(x * f, y * f); f *= 2.03; amp *= 0.5; } return s; }

  // A cumulus (flat base, billowy top) or a thin wisp, lit from the sun at the upper right.
  cloudSprite(wisp) {
    const Wc = 320, Hc = wisp ? 110 : 170, R = Math.random;
    const c = document.createElement("canvas"); c.width = Wc; c.height = Hc;
    const g = c.getContext("2d"), img = g.createImageData(Wc, Hc), D = img.data;
    const blobs = [], n = wisp ? 5 : 4 + Math.floor(R() * 3);
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      if (wisp) blobs.push({ cx: 0.12 + 0.76 * u + (R() - 0.5) * 0.05, cy: 0.5 + (R() - 0.5) * 0.15, rx: 0.17 + R() * 0.06, ry: 0.22 + R() * 0.08 });
      else blobs.push({ cx: 0.2 + 0.6 * u + (R() - 0.5) * 0.06, cy: 0.66 - Math.sin(u * Math.PI) * (0.14 + R() * 0.1), rx: 0.15 + R() * 0.07, ry: 0.24 + Math.sin(u * Math.PI) * (0.14 + R() * 0.1) });
    }
    const ox = R() * 100, oy = R() * 100, aspect = Wc / Hc;
    const dens = (px, py) => {
      const nx = px / Wc, ny = py / Hc; let m = -1;
      for (const q of blobs) { const dx = (nx - q.cx) / q.rx, dy = (ny - q.cy) / q.ry, vv = 1 - dx * dx - dy * dy; if (vv > m) m = vv; }
      if (!wisp) m *= smooth(0.88, 0.72, ny);
      if (m <= -0.35) return -1;
      const f = wisp ? this.fbm(nx * aspect * 1.6 + ox, ny * 6 + oy) : this.fbm(nx * aspect * 3.2 + ox, ny * 3.2 + oy);
      return m * 1.1 + (f - 0.5) * 1.3 - 0.08;
    };
    for (let py = 0; py < Hc; py++) for (let px = 0; px < Wc; px++) {
      const d = dens(px, py), k = (py * Wc + px) * 4;
      if (d <= 0) { D[k + 3] = 0; continue; }
      const dl = dens(px + 6, py - 6);  // density toward the sun: thinner there = brighter edge
      const lit = Math.min(1, Math.max(0.5, 0.78 + (d - Math.max(0, dl)) * 1.6 + (1 - py / Hc) * 0.18));
      D[k] = 163 + 92 * lit; D[k + 1] = 184 + 71 * lit; D[k + 2] = 212 + 43 * lit;
      D[k + 3] = 255 * smooth(0, 0.28, d) * (wisp ? 0.8 : 1);
    }
    g.putImageData(img, 0, 0);
    return c;
  }
  makeSprites() {
    this.spr = {};
    for (const p of this.pieces) for (const fi of [1, 2]) { const h = p.c[fi]; if (!this.spr[h]) this.spr[h] = this.bubbleSprite(h, this.opaque.has(h)); }
    this.bgBub = this.bubbleSprite("#9fdcff", false);
    this.noiseInit();
    this.cum = Array.from({ length: 6 }, () => this.cloudSprite(false));
    this.wisps = Array.from({ length: 3 }, () => this.cloudSprite(true));
  }
  initClouds() {
    const R = Math.random;
    const mk = (layer, spr, yf, size, vx, a, xf = R()) => ({ layer, spr, xf, yf, size, vx, a, ox: 0, oy: 0, vxo: 0, vyo: 0, fade: 1, ph: R() * TAU });
    this.clouds = [];
    for (let i = 0; i < 4; i++) this.clouds.push(mk(0, this.cum[i % 6], 0.04 + R() * 0.26, 0.16 + R() * 0.08, 0.005 * (0.7 + R() * 0.6), 0.85));
    for (let i = 0; i < 4; i++) this.clouds.push(mk(1, this.cum[(i + 2) % 6], 0.2 + R() * 0.36, 0.26 + R() * 0.1, 0.01 * (0.7 + R() * 0.6), 1));
    // In front of the text and the figure: thin, and the cursor pushes them aside.
    this.front = [
      mk(2, this.wisps[0], 0.32, 0.46, 0.008, 0.5, 0.15),
      mk(2, this.wisps[1], 0.58, 0.4, 0.006, 0.45, 0.55),
      mk(2, this.wisps[2], 0.8, 0.5, 0.009, 0.4, 0.85),
    ];
  }

  // ---- Layout ------------------------------------------------------------------
  resize() {
    const cv = this.cv, dpr = Math.min(devicePixelRatio || 1, 1.5);
    this.W = cv.clientWidth; this.H = cv.clientHeight;
    for (const c of [cv, this.fcv]) { c.width = Math.round(this.W * dpr); c.height = Math.round(this.H * dpr); }
    this.ctx = cv.getContext("2d"); this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.fctx = this.fcv.getContext("2d"); this.fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const r = cv.getBoundingClientRect(), s = this.stage.getBoundingClientRect();
    this.fcx = s.left - r.left + s.width / 2; this.fcy = s.top - r.top + s.height * 0.43;
    this.sc = Math.min(s.width / 18, s.height / 27);
  }

  // ---- Music: the shuffled playlist, streamed through the analyser ----------------
  // Graph: <audio> → analyser → speakers, and the fallback synth → compressor → analyser.
  ensureAudio() {
    if (this.actx) return;
    const A = new AudioContext();
    this.actx = A;
    A.addEventListener("statechange", () => {
      if (A.state === "running" && this.autoplayPending && !this.playing) this.startBackgroundMusic();
    });
    this.an = A.createAnalyser(); this.an.fftSize = 1024; this.an.smoothingTimeConstant = 0.5;
    this.fbuf = new Uint8Array(this.an.frequencyBinCount);
    this.output = A.createGain(); this.output.gain.value = MUSIC_VOLUME;
    this.an.connect(this.output); this.output.connect(A.destination);
    this.audio = new Audio(); this.audio.preload = "auto";
    this.audio.addEventListener("ended", () => this.playTrack(this.trackPos + 1));
    this.audio.addEventListener("error", () => { if (this.hostedAudio && !this.loadingTrack) this.audioFailed("could not load " + this.track?.title); });  // not while a new src is pending: that error belongs to the old track
    this.audio.addEventListener("playing", () => { if (this.hostedAudio) this.fails = 0; });
    A.createMediaElementSource(this.audio).connect(this.an);
    this.master = A.createGain(); this.master.gain.value = 0.5;
    this.master.connect(A.createDynamicsCompressor()).connect(this.an);
    const nb = A.createBuffer(1, A.sampleRate, A.sampleRate), d = nb.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = nb;
  }
  shuffleOrder() {
    this.order = this.list.map((_, i) => i);
    for (let i = this.order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [this.order[i], this.order[j]] = [this.order[j], this.order[i]]; }
  }
  // Which player to use comes from /api/config and /library.json. Hosted site with hosted songs: their own
  // audio files, through the same <audio> + analyser as local. Hosted without any: YouTube's embed.
  initMusic() {
    loadConfig().then(async (cfg) => {
      if (cfg.hosted === true) {
        const songs = (await loadLibrary()).filter((song) => song && song.hosted === true && typeof song.id === "string" && /^[\w-]+$/.test(song.id));
        if (songs.length) {
          this.hostedAudio = true;
          this.list = songs.map((song) => ({ title: String(song.title || song.id), artist: String(song.artist || ""), id: song.id, file: "/music/" + song.id + ".m4a" }));
          this.shuffleOrder();
        }
      }
      this.useYt = !this.hostedAudio && cfg.hosted === true && cfg.youtubeEmbed === true;
      this.cfgReady = true;
      this.startBackgroundMusic();
    });
  }
  startBackgroundMusic(gesture = false) {
    if (!this.cfgReady) { this.gesture ||= gesture; return; }  // config still loading; initMusic starts afterwards
    if (this.useYt) { this.startYt(gesture || this.gesture); return; }
    this.ensureAudio();
    this.actx.resume().catch(() => {});
    this.playing = true;
    if (this.src === "synth") {
      if (this.actx.state === "running") { this.autoplayPending = false; this.startSynth(); }
      else this.waitForMusicGesture();
    } else if (this.audio.src) this.tryPlayMusic();
    else if (!this.loadingTrack) this.playTrack(0);
    this.renderPlayer();
  }
  waitForMusicGesture() {
    this.playing = false; this.audio.pause(); this.autoplayPending = true;
    this.status = "Click anywhere for quiet music"; this.renderPlayer();
    if (this.hostedAudio) this.armGesture();
  }
  // Hosted audio: the browser alone decides whether sound may start without a click. When it says no, the
  // first real activation gesture anywhere (not a specific button) starts the music, exactly once.
  armGesture() {
    if (this.gestureArmed) return;
    this.gestureArmed = true;
    this.gestureHandler = (e) => {
      if (!this.autoplayPending) { this.disarmGesture(); return; }
      if (e.target?.closest?.("#play, #skip, #hostCard button")) return;  // the buttons start playback themselves
      this.disarmGesture();
      this.startBackgroundMusic(true);
    };
    for (const type of ["pointerdown", "keydown", "touchend"]) addEventListener(type, this.gestureHandler, { capture: true });
  }
  disarmGesture() {
    if (!this.gestureArmed) return;
    this.gestureArmed = false;
    for (const type of ["pointerdown", "keydown", "touchend"]) removeEventListener(type, this.gestureHandler, { capture: true });
  }
  // play() is called straight away (inside the gesture when there is one); the sound only counts as started
  // once the AudioContext runs too, otherwise the track would play silently into a suspended graph.
  async tryPlayHosted() {
    const A = this.actx;
    A.resume().catch(() => {});
    try {
      await this.audio.play();
      if (A.state !== "running") await Promise.race([A.resume().catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
    } catch (err) {
      if (err.name === "AbortError") return;  // a newer track replaced this one
      if (err.name !== "NotAllowedError") { this.audioFailed(err.message); return; }
    }
    if (A.state === "running" && !this.audio.paused) {
      this.autoplayPending = false; this.disarmGesture(); this.status = "";
    } else this.waitForMusicGesture();
    this.renderPlayer();
  }
  // A track that errors is skipped once per pass; after a full pass with nothing playing, stop.
  audioFailed(message) {
    if (this.failedToken === this.loadToken || !this.track) return;
    this.failedToken = this.loadToken;
    console.warn("[music]", this.track.title, message);
    if (++this.fails < this.list.length) { this.playTrack(this.trackPos + 1); return; }
    this.loadToken++; this.loadingTrack = false;
    this.playing = false; this.fails = 0; this.track = null; this.status = "Songs could not be played";
    this.audio.pause(); this.audio.removeAttribute("src");  // play tries again from the top
    this.renderPlayer();
  }
  async tryPlayMusic() {
    if (this.hostedAudio) return this.tryPlayHosted();
    if (this.actx.state !== "running") { this.waitForMusicGesture(); return; }
    try {
      await this.audio.play(); this.autoplayPending = false; this.status = "";
    } catch (err) {
      if (err.name === "NotAllowedError") this.waitForMusicGesture();
      else throw err;
    }
    this.renderPlayer();
  }
  togglePlay() {
    this.autoplayPending = false;
    if (this.useYt) { this.toggleYt(); return; }
    this.ensureAudio(); this.actx.resume();
    this.playing = !this.playing;
    if (this.src === "synth") this.playing ? this.startSynth() : this.stopSynth();
    else if (!this.playing) this.audio.pause();
    else if (this.audio.src) this.tryPlayMusic().catch(() => { this.playing = false; this.status = "Could not play music"; this.renderPlayer(); });
    else this.playTrack(0);
    this.renderPlayer();
  }
  // Ask the server for the song file (it downloads it the first time), then stream it.
  // A song that fails is skipped; with no server at all, fall back to the built-in beat.
  async playTrack(k) {
    const n = this.list.length, tr = this.list[this.order[((k % n) + n) % n]], token = ++this.loadToken;
    this.loadingTrack = true;
    this.trackPos = k; this.track = tr; this.status = "Loading…"; this.renderPlayer();
    try {
      const file = await this.fetchTrack(tr);
      if (token !== this.loadToken) return;  // skipped while loading
      this.audio.src = file;
      this.loadingTrack = false; this.status = "";
      if (this.playing) await this.tryPlayMusic();
      if (!this.hostedAudio) this.fails = 0;  // hosted: reset when the audio really plays
      this.renderPlayer();
      this.fetchTrack(this.list[this.order[(k + 1) % n]]).catch(() => {});  // get the next one ready
    } catch (err) {
      if (token !== this.loadToken) return;
      this.loadingTrack = false;
      console.warn("[music]", tr.title, err.message);
      if (this.hostedAudio) return this.audioFailed(err.message);
      if (err.noServer || ++this.fails >= 3) return this.fallbackSynth();
      this.playTrack(k + 1);
    }
  }
  fetchTrack(tr) {
    if (tr.file) return Promise.resolve(tr.file);  // hosted songs carry their /music/<id>.m4a
    const local = "music/" + tr.id + ".m4a";
    const p = fetch(local, { method: "HEAD" }).then((res) => res.ok ? local : this.downloadTrack(tr));
    p.catch(() => { if (tr.file === p) tr.file = null; });  // let a failed song be retried later
    tr.file = p;
    return p;
  }
  downloadTrack(tr) {
    return fetch("/api/youtube", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://www.youtube.com/watch?v=" + tr.id }),
    }).then(async (res) => {
      const body = await res.json().catch(() => null);
      if (!body) throw Object.assign(new Error("no song server (status " + res.status + ")"), { noServer: true });
      if (!res.ok) throw new Error(body.error || "download failed");
      return body.file;
    });
  }
  fallbackSynth() {
    this.src = "synth"; this.track = null;
    this.status = "Songs not found · playing a built-in beat";
    if (this.playing) {
      if (this.actx.state === "running") { this.autoplayPending = false; this.startSynth(); }
      else this.waitForMusicGesture();
    }
    this.renderPlayer();
  }
  renderPlayer() {
    const btn = document.getElementById("play"), tr = this.track, label = this.playing ? "Pause music" : "Play music";
    btn.setAttribute("aria-label", label); btn.setAttribute("aria-pressed", this.playing);
    document.getElementById("iconPlay").toggleAttribute("hidden", this.playing);  // SVGs have no .hidden property
    document.getElementById("iconPause").toggleAttribute("hidden", !this.playing);
    document.getElementById("playLabel").textContent = tr ? tr.title : this.src === "synth" ? "Built-in beat" : "Play music";
    document.getElementById("playSub").textContent = this.status || (tr ? tr.artist + (this.playing ? "" : " · paused") : "");
    document.getElementById("skip").hidden = !(this.src === "music" && tr);
    this.renderCard();
    if (this.useYt) {
      const np = document.getElementById("npTrack");
      if (np) np.textContent = tr ? tr.title + " · " + tr.artist : "";
    }
  }

  // ---- Hosted audio: the "Now playing" card (#hostCard, bottom right) ----------------
  // Visible whenever the hosted-audio mode is on (playing, paused, blocked or failed), never with #ytCard.
  // Its canvas draws the page's own analyser, only while music plays and the tab is visible.
  skipMusic() {
    if (this.useYt) { this.skipYt(); return; }
    this.ensureAudio(); this.actx.resume().catch(() => {}); this.autoplayPending = false; this.playing = true; this.playTrack(this.trackPos + 1);
  }
  bindCard() {
    const on = (id, fn) => document.getElementById(id)?.addEventListener?.("click", fn);
    on("hostPlay", () => this.togglePlay());
    on("hostSkip", () => this.skipMusic());
    on("hostStart", () => { if (!this.playing) this.startBackgroundMusic(true); });
    document.addEventListener?.("visibilitychange", () => this.syncCardLoop());
  }
  renderCard() {
    const $ = (id) => document.getElementById(id), card = $("hostCard");
    if (!card) return;
    const show = this.hostedAudio === true && !this.useYt;
    card.hidden = !show;
    document.body.classList.toggle?.("host-on", show);
    if (!show) { this.syncCardLoop(); return; }
    const tr = this.track, blocked = this.status === "Click anywhere for quiet music", failed = !tr && this.status === "Songs could not be played";
    const state = failed ? "error" : blocked ? "blocked" : !tr ? "loading" : this.playing ? "playing" : "paused";
    const wasBlocked = card.attrs?.["data-state"] === "blocked" || card.getAttribute?.("data-state") === "blocked";
    card.setAttribute("data-state", state);
    $("hostTrack").textContent = failed ? "Songs could not be played" : tr ? tr.title : "Loading…";
    $("hostArtist").textContent = tr ? tr.artist : "";
    $("hostStart").hidden = !blocked; $("hostNote").hidden = !blocked;
    $("hostProg").hidden = blocked || !tr; $("hostControls").hidden = blocked;
    $("hostSkip").hidden = !tr;
    const pl = $("hostPlay");
    pl.setAttribute("aria-label", failed ? "Retry playing music" : this.playing ? "Pause music" : "Play music");
    pl.setAttribute("aria-pressed", this.playing);
    $("hostIconPlay").toggleAttribute("hidden", this.playing);
    $("hostIconPause").toggleAttribute("hidden", !this.playing);
    if (wasBlocked && !blocked && document.activeElement?.id === "hostStart") pl.focus?.();
    this.syncCardLoop();
  }
  cardAnimating() { return this.hostedAudio === true && !this.useYt && this.playing && !document.hidden; }
  // One loop at most: requestAnimationFrame normally, a slow timer for progress only under reduced motion.
  syncCardLoop() {
    if (!this.cardAnimating()) {
      if (this.cardH != null) { this.rm ? (typeof clearTimeout === "function" && clearTimeout(this.cardH)) : (typeof cancelAnimationFrame === "function" && cancelAnimationFrame(this.cardH)); this.cardH = null; }
      this.drawCard(false);
      return;
    }
    if (this.cardH != null) return;
    const next = this.rm ? (f) => setTimeout(f, 1000) : typeof requestAnimationFrame === "function" ? requestAnimationFrame : null;
    if (!next) { this.drawCard(false); return; }
    const step = () => { this.cardH = null; this.drawCard(!this.rm); if (this.cardAnimating()) this.cardH = next(step); };
    step();
  }
  drawCard(live) {
    const $ = (id) => document.getElementById(id), a = this.audio;
    const cur = a && isFinite(a.currentTime) ? a.currentTime : 0, dur = a && isFinite(a.duration) && a.duration > 0 ? a.duration : 0;
    const fmt = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
    const time = $("hostTime"); if (time) time.textContent = fmt(cur) + " / " + (dur ? fmt(dur) : "--:--");
    const fill = $("hostFill"); if (fill?.style) fill.style.width = (dur ? Math.min(100, cur / dur * 100) : 0) + "%";
    const g = $("hostViz")?.getContext?.("2d"); if (!g) return;
    const w = g.canvas.width, h = g.canvas.height, n = 24, gap = 3, bw = (w - gap * (n + 1)) / n;
    const sky = g.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, "#e4f5ff"); sky.addColorStop(1, "#8fd0f5");
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    const bars = g.createLinearGradient(0, 0, 0, h); bars.addColorStop(0, "#b7ec7a"); bars.addColorStop(0.5, "#4fc3f7"); bars.addColorStop(1, "#1e95e3");
    const data = live && this.an && this.fbuf ? (this.an.getByteFrequencyData(this.fbuf), this.fbuf) : null;
    for (let i = 0; i < n; i++) {
      let v;
      if (data) { const k = 1 + Math.floor(Math.pow(i / n, 1.6) * data.length * 0.6); v = Math.min(1, (data[k] || 0) / 255 * 1.15); }
      else v = 0.2 + 0.45 * Math.abs(Math.sin(i * 0.7 + 1));  // static bars: paused, blocked or reduced motion
      const bh = Math.max(4, v * (h - 14)), x = gap + i * (bw + gap), y = h - bh - 6;
      g.fillStyle = bars; g.fillRect(x, y, bw, bh);
      g.fillStyle = "rgba(255,255,255,.55)"; g.fillRect(x, y, bw, 2);
    }
  }

  // ---- Hosted: the same playlist through YouTube's embedded player ---------------
  // No audio files exist on the hosted site. The player lives in the visible "Now playing" card
  // (#ytCard), which only appears once music starts and is never hidden while it plays.
  ensureYt() {
    if (this.yt) return this.yt;
    const yt = this.yt = createYtEmbed({ mount: document.getElementById("ytCard") });
    yt.onEnded(() => { if (this.playing) this.playTrackYt(this.trackPos + 1); });
    yt.onError((message) => { if (this.ytReady) this.ytFailed(message); });  // errors of the previous video are stale
    return yt;
  }
  // Browsers block sound without a click: wait for the first one (or the play button).
  startYt(gesture) {
    if (!gesture) {
      this.playing = false; this.status = "Click anywhere for quiet music"; this.renderPlayer();
      return;
    }
    this.autoplayPending = false; this.playing = true;
    if (this.track) { this.yt?.play(); this.renderPlayer(); } else this.playTrackYt(0);
  }
  toggleYt() {
    this.playing = !this.playing;
    if (!this.playing) this.yt?.pause();
    else if (this.track) { this.ensureYt().play(); this.status = ""; }
    else this.playTrackYt(0);
    this.renderPlayer();
  }
  skipYt() { this.autoplayPending = false; this.playing = true; this.playTrackYt(this.trackPos + 1); }
  async playTrackYt(k) {
    const n = this.list.length, tr = this.list[this.order[((k % n) + n) % n]], token = ++this.loadToken;
    this.trackPos = k; this.track = tr; this.status = "Loading…"; this.ytSince = performance.now(); this.beatIdx = null; this.ytReady = false;
    document.body.classList.add("yt-on");
    this.renderPlayer();
    try {
      await this.ensureYt().load(tr.id, { volume: MUSIC_VOLUME, rate: 1 });
      if (token === this.loadToken) this.ytReady = true;
    } catch (err) {
      if (token === this.loadToken) this.ytFailed(err.message);
    }
  }
  // A video that cannot play (removed, embedding off, YouTube blocked) is skipped. Every song gets
  // one try per pass: after a full pass with nothing playing, stop instead of looping.
  ytFailed(message) {
    if (!this.playing || this.failedToken === this.loadToken) return;
    this.failedToken = this.loadToken;
    console.warn("[music]", this.track?.title, message);
    if (++this.fails < this.list.length) { this.playTrackYt(this.trackPos + 1); return; }
    this.playing = false; this.fails = 0; this.track = null; this.status = "Songs could not be played";  // play tries again from the top
    this.yt?.stop();
    this.renderPlayer();
  }
  // Runs every frame: notices that YouTube really started (a success) or is waiting for a click.
  ytTick(now) {
    if (!this.playing || !this.yt) return false;
    if (this.yt.isPlaying()) {
      if (this.fails || this.status) { this.fails = 0; this.status = ""; this.renderPlayer(); }
      return true;
    }
    if (this.track && !this.status.startsWith("Press") && now - this.ytSince > 4000 && this.failedToken !== this.loadToken) {
      this.status = "Press play in the player"; this.renderPlayer();
    }
    return false;
  }
  // YouTube's audio cannot be analysed, so the visuals follow a gentle pulse at the song's tempo.
  // Returns true on the frame a beat lands; this.bass is the smooth bass level the visuals read.
  ytPulse(now, dt) {
    if (!this.ytTick(now)) { this.beatIdx = null; this.bass *= Math.exp(-dt * 3); return false; }
    const tr = this.track, bpm = tr?.beat?.bpm || tr?.bpm || BPM, period = 60 / bpm;
    const pos = Math.max(0, this.yt.getTime() - (tr?.beat?.first || 0)), idx = Math.floor(pos / period);
    const target = 0.04 + 0.16 * Math.exp(-(pos - idx * period) * 5);
    this.bass += (target - this.bass) * Math.min(1, dt * 14);
    const beat = this.beatIdx !== null && idx > this.beatIdx;
    this.beatIdx = idx;
    return beat;
  }

  // ---- Fallback: a small synthesized loop (no files) -----------------------------
  startSynth() {
    this.step = 0; this.nextT = this.actx.currentTime + 0.08; this.beats = [];
    clearInterval(this.timer); this.timer = setInterval(() => this.sched(), 25);
  }
  stopSynth() { clearInterval(this.timer); this.beats = []; }
  // Look-ahead scheduler: queue every 16th note that falls in the next 120 ms.
  sched() {
    const st = 60 / BPM / 4;
    while (this.nextT < this.actx.currentTime + 0.12) { this.playStep(this.step, this.nextT, st); this.nextT += st; this.step = (this.step + 1) % 64; }
  }
  playStep(s, t, st) {
    const bar = Math.floor(s / 16), q = s % 16;
    const roots = [41, 43, 40, 45], chords = [[65, 69, 72, 76], [67, 71, 74, 79], [64, 67, 71, 74], [69, 72, 76, 79]];  // Fmaj7 G Em7 Am
    if (q % 4 === 0) { this.kickAt(t); this.beats.push(t); }
    if (q === 4 || q === 12) this.noiseHit(t, "bandpass", 1800, 0.2, 0.32);
    if (q % 4 === 2) this.noiseHit(t, "highpass", 7000, 0.05, 0.2);
    else if (q % 2 === 1) this.noiseHit(t, "highpass", 9000, 0.025, 0.07);
    if (q % 4 === 2 || q === 7 || q === 15) this.bassAt(t, roots[bar], st * 1.6);
    if (q === 0) this.padAt(t, chords[bar], st * 16);
    if (q === 3 || q === 11) this.pluckAt(t, chords[bar][q === 3 ? 3 : 2] + 12);
  }
  env(t, peak, attack, end) { const g = this.actx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, end); g.connect(this.master); return g; }
  kickAt(t) { const o = this.actx.createOscillator(); o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12); o.connect(this.env(t, 1, 0.004, t + 0.4)); o.start(t); o.stop(t + 0.45); }
  noiseHit(t, type, f, dur, vol) { const A = this.actx, s = A.createBufferSource(), fl = A.createBiquadFilter(); s.buffer = this.noiseBuf; fl.type = type; fl.frequency.value = f; s.connect(fl).connect(this.env(t, vol, 0.002, t + dur)); s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02); }
  bassAt(t, m, dur) { const A = this.actx, o = A.createOscillator(), fl = A.createBiquadFilter(); o.type = "sawtooth"; o.frequency.value = midiHz(m); fl.type = "lowpass"; fl.frequency.value = 520; fl.Q.value = 4; o.connect(fl).connect(this.env(t, 0.32, 0.006, t + dur)); o.start(t); o.stop(t + dur + 0.02); }
  padAt(t, notes, len) {
    const A = this.actx, fl = A.createBiquadFilter(), g = A.createGain(); fl.type = "lowpass"; fl.frequency.value = 1800;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.055, t + 0.3); g.gain.linearRampToValueAtTime(0, t + len);
    fl.connect(g).connect(this.master);
    notes.forEach((m, i) => { const o = A.createOscillator(); o.type = "triangle"; o.frequency.value = midiHz(m); o.detune.value = (i - 1.5) * 6; o.connect(fl); o.start(t); o.stop(t + len + 0.05); });
  }
  pluckAt(t, m) { const o = this.actx.createOscillator(); o.frequency.value = midiHz(m); o.connect(this.env(t, 0.1, 0.004, t + 0.35)); o.start(t); o.stop(t + 0.4); }

  cloudBox(c) {
    const w = Math.max(c.layer === 2 ? 320 : 200, c.size * this.W), h = w * c.spr.height / c.spr.width;
    return { w, h, x: c.xf * (this.W + w) - w / 2 + c.ox, y: c.yf * this.H + c.oy };
  }
  onBeat() {
    this.kick = 1;
    if (!this.rm) this.ripples.push({ age: 0 });
    const imp = this.rm ? 0.3 : 1;
    for (const c of [...this.clouds, ...this.front]) {  // push clouds away from the cabinet
      const b = this.cloudBox(c), dx = b.x - this.fcx, dy = b.y - this.fcy, dist = Math.hypot(dx, dy) || 1;
      const f = [130, 240, 200][c.layer] / (1 + dist / 500) * imp;
      c.vxo += dx / dist * f; c.vyo += dy / dist * f * 0.6;
    }
    this.spawnBub(3);
  }
  spawnBub(n) { for (let i = 0; i < n && this.bubs.length < 50; i++) this.bubs.push({ x: Math.random() * this.W, y: this.H + 20, r: 4 + Math.random() * 12, vy: 30 + Math.random() * 50, ph: Math.random() * TAU }); }

  // ---- Frame -------------------------------------------------------------------
  frame = (now) => {
    requestAnimationFrame(this.frame);
    const ctx = this.ctx; if (!ctx || !this.W) return;
    const dt = Math.min(0.05, Math.max(0, (now - (this.last || now)) / 1000)); this.last = now;
    const t = now / 1000, W = this.W, H = this.H, rm = this.rm, playing = this.playing;

    // Bass level and beats from the analyser
    let beat = false;
    if (this.useYt) beat = this.ytPulse(now, dt);
    else if (this.actx && playing) {
      this.an.getByteFrequencyData(this.fbuf);
      const e = (this.fbuf[1] + this.fbuf[2] + this.fbuf[3] + this.fbuf[4]) / 1020;  // ~40–200 Hz
      this.bass += (e - this.bass) * Math.min(1, dt * 14);
      if (this.src === "synth") {
        // The synth's kicks are scheduled ahead, so fire them when the audio clock reaches them
        const act = this.actx.currentTime;
        while (this.beats.length && this.beats[0] <= act) { this.beats.shift(); beat = true; }
      } else {
        // Onset detection: a beat is a rising bass level well above its last ~0.7 s,
        // with at least 0.3 s between beats.
        const hist = this.eHist; hist.push(e); if (hist.length > 43) hist.shift();
        const mean = hist.reduce((s, v) => s + v, 0) / hist.length;
        const sd = Math.sqrt(hist.reduce((s, v) => s + (v - mean) * (v - mean), 0) / hist.length);
        if (hist.length > 10 && e > mean + Math.max(0.05, 1.4 * sd) && e > this.prevE && t - this.lastBeat > 0.3) { beat = true; this.lastBeat = t; }
        this.prevE = e;
      }
    } else this.bass *= Math.exp(-dt * 3);
    if (beat) this.onBeat(); else this.kick *= Math.exp(-dt * 6);

    // Rotate continuously through every form; hover/focus holds its matching model.
    if (!this.grab) {
      if (this.target !== null) {
        this.dragYaw += (this.target - this.dragYaw) * (1 - Math.exp(-dt * 5));
        if (Math.abs(this.target - this.dragYaw) < 0.001) { this.dragYaw = this.target; this.target = null; }
      } else if (this.vel) {
        this.dragYaw += this.vel * dt; this.vel *= Math.exp(-dt * 3);
        if (Math.abs(this.vel) < 0.8) this.snap();
      } else if (!this.preview) this.dragYaw += AUTO_TURN_SPEED * dt * (rm ? 0.25 : 1);
    } else if (now - this.grab.t > 60) this.vel *= Math.exp(-dt * 12);
    // The vinyl only turns while you turn the cabinet, like scratching, then coasts to a stop.
    if (this.grab) this.spinV = this.vel * 3.5; else this.spinV *= Math.exp(-dt * 1.4);
    this.spin += this.spinV * dt;

    const total = this.dragYaw;
    this.swayA += ((this.grab || rm ? 0 : 1) - this.swayA) * Math.min(1, dt * 2);
    const yaw = total + Math.sin(t * 0.55) * 0.16 * this.swayA;
    const uu = total / STEP, seg = Math.floor(uu), frac = uu - seg;
    const fI = ((seg % 3) + 3) % 3, fJ = (fI + 1) % 3;
    const p = smooth(0.17, 0.83, frac);  // morph only in the middle of each turn
    this.setMode(MODES[p > 0.5 ? fJ : fI]);

    // Sky and sun
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#1f7fd4"); g.addColorStop(0.42, "#6cbcf0"); g.addColorStop(0.78, "#cdeeff"); g.addColorStop(1, "#eaf6ff");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const sx = W * 0.86, sy = H * 0.07, sr = Math.max(W, H) * 0.5 * (1 + 0.06 * this.bass);
    const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr);
    sg.addColorStop(0, "rgba(255,255,245,0.95)"); sg.addColorStop(0.08, "rgba(255,255,240,0.75)"); sg.addColorStop(0.35, "rgba(255,255,255,0.18)"); sg.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = sg; ctx.fillRect(0, 0, W, H);

    // Clouds: drift, spring back after beat pushes, swell with the bass
    const swell = 0.12 * this.bass + 0.06 * this.kick;
    const drawCloud = (c, cx) => {
      c.xf += c.vx * dt * (rm ? 0.4 : 1) * (playing ? 1.6 : 1); if (c.xf > 1) c.xf -= 1;
      c.vxo += (-14 * c.ox - 4.5 * c.vxo) * dt; c.vyo += (-14 * c.oy - 4.5 * c.vyo) * dt;
      const b = this.cloudBox(c), s = 1 + swell * (c.layer === 0 ? 0.6 : 1);
      if (c.layer === 2) {  // front clouds part around the cursor and fade near it
        const ddx = b.x - this.mx, ddy = b.y - this.my, dd = Math.hypot(ddx, ddy) || 1, rad = b.w * 0.55;
        if (dd < rad) { const push = (1 - dd / rad) * 900 * dt; c.vxo += ddx / dd * push; c.vyo += ddy / dd * push * 0.5; }
        c.fade += (0.35 + 0.65 * Math.min(1, dd / rad) - c.fade) * Math.min(1, dt * 4);
      }
      c.ox += c.vxo * dt; c.oy += c.vyo * dt;
      const w = b.w * s, h = b.h * s, y = b.y + Math.sin(t * 0.3 + c.ph) * 4;
      cx.globalAlpha = c.a * c.fade;
      cx.drawImage(c.spr, b.x - w / 2, y - h / 2, w, h);
      cx.globalAlpha = 1;
    };
    for (const c of this.clouds) if (c.layer === 0) drawCloud(c, ctx);

    // Aurora ribbons
    const xmax = Math.ceil(W / 24) * 24 + 24;
    for (let rb = 0; rb < 2; rb++) {
      const base = H * (0.6 + rb * 0.07), amp = H * 0.06, th = H * (0.035 + rb * 0.015);
      const top = (x) => base + Math.sin(x * 0.0035 + t * 0.35 + rb * 2) * amp;
      ctx.beginPath();
      for (let x = 0; x <= xmax; x += 24) x ? ctx.lineTo(x, top(x)) : ctx.moveTo(x, top(x));
      for (let x = xmax; x >= 0; x -= 24) ctx.lineTo(x, top(x) + th * (1 + 0.6 * Math.sin(x * 0.006 - t * 0.5 + rb)) * (1 + 0.5 * this.bass));
      ctx.closePath();
      const lg = ctx.createLinearGradient(0, 0, W, 0), col = rb ? "200,245,160" : "255,255,255";
      lg.addColorStop(0, `rgba(${col},0)`); lg.addColorStop(0.5, `rgba(${col},${rb ? 0.28 : 0.42})`); lg.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = lg; ctx.fill();
    }
    for (const c of this.clouds) if (c.layer === 1) drawCloud(c, ctx);

    // Rising bubbles
    this.bubT -= dt; if (this.bubT <= 0) { this.spawnBub(1); this.bubT = 0.9; }
    ctx.globalAlpha = 0.75;
    this.bubs = this.bubs.filter((b) => {
      b.y -= b.vy * dt; b.x += Math.sin(t * 1.5 + b.ph) * 12 * dt;
      ctx.drawImage(this.bgBub, b.x - b.r, b.y - b.r, 2 * b.r, 2 * b.r);
      return b.y > -30;
    });
    ctx.globalAlpha = 1;

    // Lens flare and beat flash
    const fx = W * 0.5 - sx, fy = H * 0.62 - sy;
    for (const [k, r, c, a] of [[0.3, 14, "255,255,255", 0.22], [0.5, 44, "190,240,170", 0.12], [0.66, 10, "255,255,255", 0.3], [0.95, 80, "150,215,255", 0.1]]) {
      ctx.fillStyle = `rgba(${c},${a})`; ctx.beginPath(); ctx.arc(sx + fx * k, sy + fy * k, r, 0, TAU); ctx.fill();
    }
    if (this.kick > 0.01) { ctx.fillStyle = `rgba(255,255,255,${0.07 * this.kick})`; ctx.fillRect(0, 0, W, H); }

    // Figure: view transform (yaw around Y, then pitch), simple perspective
    const cy = Math.cos(yaw), sny = Math.sin(yaw), cp = Math.cos(PITCH), sp = Math.sin(PITCH);
    const Dc = 46, F = this.sc * Dc, X0 = this.fcx, Y0 = this.fcy, o = {};
    const view = (x, y, z, out) => { const x1 = x * cy + z * sny, z1 = -x * sny + z * cy; out.x = x1; out.y = y * cp - z1 * sp; out.z = y * sp + z1 * cp; };

    // Glass platform, shadow and beat ripples
    view(0, -9.4, 0, o);
    const kc = F / (Dc - o.z), rx = 8.5 * kc, ry = rx * 0.34;
    ctx.save(); ctx.translate(X0 + o.x * kc, Y0 - o.y * kc); ctx.scale(1, ry / rx);
    const pg = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    pg.addColorStop(0, "rgba(255,255,255,0.62)"); pg.addColorStop(0.7, "rgba(205,236,255,0.38)"); pg.addColorStop(1, "rgba(150,210,245,0)");
    ctx.fillStyle = pg; ctx.beginPath(); ctx.arc(0, 0, rx, 0, TAU); ctx.fill();
    const shg = ctx.createRadialGradient(0, 0, 0, 0, 0, rx * 0.5);
    shg.addColorStop(0, "rgba(15,80,140,0.2)"); shg.addColorStop(1, "rgba(15,80,140,0)");
    ctx.fillStyle = shg; ctx.beginPath(); ctx.arc(0, 0, rx * 0.5, 0, TAU); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.beginPath(); ctx.arc(0, 0, rx * 0.9, 0, TAU); ctx.stroke();
    this.ripples = this.ripples.filter((r) => {
      r.age += dt / 1.2;
      ctx.strokeStyle = `rgba(255,255,255,${(1 - r.age) * 0.75})`;
      ctx.beginPath(); ctx.arc(0, 0, rx * (0.35 + r.age * 0.9), 0, TAU); ctx.stroke();
      return r.age < 1;
    });
    ctx.restore();

    // Cube faces that face the camera this frame (same for every cube)
    const h = 0.45 * (1 + 0.06 * this.kick), faces = [];
    for (const FC of FACES) {
      const nv = {}; view(...FC.n, nv);
      if (nv.z <= 0.02) continue;
      const shade = 0.6 + 0.5 * Math.max(0, nv.x * LIGHT[0] + nv.y * LIGHT[1] + nv.z * LIGHT[2]);
      const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
        const out = {};
        view((FC.n[0] + a * FC.u[0] + b * FC.v[0]) * h, (FC.n[1] + a * FC.u[1] + b * FC.v[1]) * h, (FC.n[2] + a * FC.u[2] + b * FC.v[2]) * h, out);
        return out;
      });
      faces.push({ c, fill: this.cols.map((rgb) => shadeStr(rgb, shade)) });
    }

    // Place every piece between form fI and form fJ: morph + scatter + swirl
    const P = this.pieces, n = P.length, scat = rm ? 0.3 : 1, xf1 = this.xf[1], spin = this.spin;
    const pos = (pc, f, out) => {
      if (f === 1 && pc.spin) { const an = pc.spin.a + spin; xf1(VC.x + Math.cos(an) * pc.spin.r, 0.75, VC.z + Math.sin(an) * pc.spin.r, out); }
      else { out.x = pc.x[f]; out.y = pc.y[f]; out.z = pc.z[f]; }
    };
    const pi = {}, pj = {};
    for (let i = 0; i < n; i++) {
      const pc = P[i];
      let e = (p - pc.d) / 0.65; e = e < 0 ? 0 : e > 1 ? 1 : e;
      const ee = e < 0.5 ? 4 * e * e * e : 1 - Math.pow(-2 * e + 2, 3) / 2;
      pos(pc, fI, pi); pos(pc, fJ, pj);
      const s = Math.sin(Math.PI * ee) * scat;
      let px = pi.x + (pj.x - pi.x) * ee + pc.dx * pc.R * s;
      const py = pi.y + (pj.y - pi.y) * ee + pc.dy * pc.R * s;
      let pz = pi.z + (pj.z - pi.z) * ee + pc.dz * pc.R * s;
      if (s > 0.001) { const sa = pc.sw * s, ca = Math.cos(sa), sn = Math.sin(sa), nx = px * ca + pz * sn; pz = -px * sn + pz * ca; px = nx; }
      view(px, py, pz, o);
      pc.vx = o.x; pc.vy = o.y; pc.vz = o.z;
      const fb = ee <= 0.3 ? 0 : ee >= 0.62 ? 1 : (ee - 0.3) / 0.32;  // cube/bubble crossfade mid-flight
      pc.aI = 1 - fb; pc.aJ = fb;
      pc.s = (pc.r[fI] + (pc.r[fJ] - pc.r[fI]) * ee) * (pc.g[fI] ? 1 : ee) * (pc.g[fJ] ? 1 : 1 - ee);
    }
    this.ord.sort((a, b) => P[a].vz - P[b].vz);  // painter's algorithm, far to near

    ctx.lineWidth = 1; ctx.lineJoin = "round"; ctx.strokeStyle = "rgba(255,255,255,0.45)";
    const bob = 1 + 0.14 * this.bass;
    const drawAs = (q, f, alpha, k) => {
      if (alpha <= 0.01 || q.s <= 0.02) return;
      ctx.globalAlpha = alpha;
      if (f === 0) {
        const sf = q.s / 0.5;
        for (const face of faces) {
          ctx.beginPath();
          face.c.forEach((cn, m) => {
            const kk = F / (Dc - q.vz - cn.z * sf), X = X0 + (q.vx + cn.x * sf) * kk, Y = Y0 - (q.vy + cn.y * sf) * kk;
            m ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
          });
          ctx.closePath(); ctx.fillStyle = face.fill[q.c[0]]; ctx.fill(); ctx.stroke();
        }
      } else {
        const r = q.s * k * bob;
        ctx.drawImage(this.spr[q.c[f]], X0 + q.vx * k - r, Y0 - q.vy * k - r, 2 * r, 2 * r);
      }
    };
    for (const i of this.ord) {
      const q = P[i], k = F / (Dc - q.vz);
      drawAs(q, fI, q.aI, k);
      drawAs(q, fJ, q.aJ, k);
    }
    ctx.globalAlpha = 1;

    // Front clouds go on their own canvas above the text
    this.fctx.clearRect(0, 0, W, H);
    for (const c of this.front) drawCloud(c, this.fctx);
  };
}

// /library.json songs, fetched once; [] when it cannot be read.
let libraryPromise;
function loadLibrary() {
  libraryPromise ??= (async () => {
    try {
      const res = await fetch("/library.json");
      if (!res.ok) return [];
      const data = await res.json();
      const songs = Array.isArray(data) ? data : data?.songs;
      return Array.isArray(songs) ? songs : [];
    } catch { return []; }
  })();
  return libraryPromise;
}

// Music credits (CC BY needs them): the attribution of every hosted song that has one. Hidden when there are none.
(async () => {
  try {
    const credits = (await loadLibrary()).map((song) => song?.attribution).filter((text) => typeof text === "string" && text.trim());
    if (!credits.length) return;
    const list = document.getElementById("creditList"), box = document.getElementById("credits");
    if (!list || !box) return;
    for (const text of credits) { const li = document.createElement("li"); li.textContent = text; list.appendChild(li); }
    box.hidden = false;
  } catch {}
})();

window.airdeck = new Landing();  // exposed for debugging in the console
