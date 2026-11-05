// Run: node tests/deck-fixes-state.cjs
// State checks for DJ Deck fixes in index.html, using the real inline module like tests/tracking.cjs.
// DOM, audio, WebGL and MediaPipe are stubbed. Covers: MediaPipe load failure keeps the page alive,
// pinch calibration ranges, idle reset after synthetic hands, Bubble Aero emission without WebGL and
// after the hands leave, and Next during an AI DJ mix.
const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path');

function boot({ webgl = true, storage = {}, timeout = null } = {}) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
    .split('<script type="module">')[1].split('</script>')[0].replace(/^import .*$/mg, '');
  const noop = () => {}, gradient = { addColorStop: noop };
  const ctx = new Proxy({ measureText: (t) => ({ width: String(t).length * 7 }), createLinearGradient: () => gradient },
    { get: (o, k) => (k in o ? o[k] : noop) });
  const elements = new Map();
  const el = () => ({ width: 1280, height: 720, style: { setProperty: noop }, classList: { toggle: noop, contains: () => false, add: noop, remove: noop },
    addEventListener: noop, appendChild: noop, insertBefore: noop, append: noop, remove: noop, getContext: () => ctx,
    querySelector: () => ({ style: {} }), querySelectorAll: () => [], textContent: '', value: '', hidden: false, setAttribute: noop });
  const raf = [];
  const state = { mixing: false, playingNext: 0, nexts: [] };
  const queueCalls = [];
  const box = {
    console: { log: noop, warn: noop, error: noop },
    performance, Math, Float32Array, Uint8Array, Number, JSON, Promise, Set, Map, Array, Object, Symbol, Error,
    setTimeout: timeout || ((fn) => { fn(); return 0; }), clearTimeout: noop,
    window: { addEventListener: noop },
    document: { addEventListener: noop, getElementById: (k) => { if (!elements.has(k)) elements.set(k, el()); return elements.get(k); },
      createElement: el, querySelector: el, querySelectorAll: () => [], body: el(), fullscreenElement: null },
    localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); }, removeItem: noop },
    requestAnimationFrame: (cb) => { raf.push(cb); return raf.length; },
    Audio: class { play() { return Promise.resolve(); } },
    Deck: class {
      constructor() { return new Proxy({ playing: false, buffer: null, effectState: () => ({}), waveform: () => new Float32Array(128), bass: () => 0 },
        { get: (o, k) => (k in o ? o[k] : noop) }); }
    },
    BubbleParticles: undefined,
    FrameFx: class { constructor() { this.canvas = el(); this.ok = webgl; } resize() {} clear() {} render() {} },
    createQueue: () => ({
      on: noop,
      next() { queueCalls.push('next'); },
      play(id) { queueCalls.push('play:' + id); },
      getUpNext: () => (state.mixing ? { item: { id: 'b' }, mixing: true, talking: false } : null),
      mixNow: () => false,
      holdControls: noop, coachPing: noop,
      startHandMix: async () => null,
      startDefaultQueue() { return new Promise(noop); },
      getState: () => ({ items: [{ id: 'a' }, { id: 'b' }], currentId: 'a', downloads: [], status: null, dj: {} }),
    }),
    createQueuePanel: () => ({ element: el() }),
    createTransport: () => el(),
    createUpNext: () => ({ element: el() }),
    location: { hash: '', replace: noop },
    // MediaPipe is not provided: the page's dynamic import rejects, like an unreachable CDN.
  };
  box.BubbleParticles = class { constructor(c) { this.canvas = c; this.particles = []; this.credit = 0; this.last = null; }
    clear() { this.particles.length = 0; this.credit = 0; this.last = null; }
    render(quad, bass, now) { // minimal stand-in: one emitted bubble per call while a quad is given, aged out after 1 s
      if (this.last === null) this.last = now;
      const dt = now - this.last; this.last = now;
      this.particles = this.particles.filter((p) => (p.life -= dt) > 0);
      if (quad) this.particles.push({ life: 1000 });
    } };
  vm.createContext(box);
  const exposed = `
window.dbg = {
  get calib() { return calib; }, calibrate, nextSong, deck, frame, bubbleParticles, setVisual,
  get visualFx() { return visualFx; }, get toast() { return toast.text; },
  getPinch: () => ({ closed: PINCH_CLOSED, open: PINCH_OPEN }),
  set mixing(v) { state.mixing = v; }, step: (t) => { const q = raf.splice(0); q.forEach((cb) => cb(t)); },
};`;
  vm.runInContext(code + '\n' + exposed, box);
  box.dbg = box.window.dbg;
  // Hand the page's private state to the test through the box.
  box.state = state;
  box.queueCalls = queueCalls;
  box.raf = raf;
  box.elementById = (k) => box.document.getElementById(k);
  return box;
}

const flush = () => new Promise((r) => setImmediate(r));

// Real hand fixtures (same geometry as tests/tracking.cjs), so the tracker sees two hands.
function hand(x = 0.3, y = 0.65, label = 'Left') {
  const w = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  w[0] = { x: 0, y: 0, z: 0 }; w[1] = { x: -0.018, y: -0.014, z: 0 }; w[2] = { x: -0.03, y: -0.028, z: 0 };
  w[3] = { x: -0.052, y: -0.028, z: 0 }; w[4] = { x: -0.08, y: -0.028, z: 0 };
  for (let j = 0; j < 4; j++) {
    const m = 5 + j * 4, b = j === 0 ? 0 : 150;
    w[m] = { x: -0.018 + j * 0.014, y: -0.05, z: 0 }; w[m + 1] = { x: w[m].x, y: -0.078, z: 0 };
    w[m + 2] = { x: w[m].x + 0.024 * Math.sin(b * Math.PI / 180), y: -0.078 - 0.024 * Math.cos(b * Math.PI / 180), z: 0 };
    w[m + 3] = { x: w[m + 2].x, y: w[m + 2].y - 0.018, z: 0 };
  }
  const l = w.map((p) => ({ x: 1 - x + p.x * 1.8, y: y + p.y * 3.2, z: 0 }));
  return { l, w, label };
}
const handsResult = (hands) => ({ landmarks: hands.map((h) => h.l), worldLandmarks: hands.map((h) => h.w),
  handedness: hands.map((h) => [{ categoryName: h.label, score: 0.99 }]) });
const twoHands = () => handsResult([hand(0.25, 0.65, 'Left'), hand(0.75, 0.7, 'Right')]);

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; console.log('PASS: ' + msg); };

async function main() {
  // 1. MediaPipe cannot load: the page still boots and the queue/transport/help stay alive.
  {
    const box = boot();
    await flush(); await flush();
    const start = box.elementById('start'), status = box.elementById('status');
    ok(start.textContent === 'Retry hand tracking', 'missing MediaPipe shows a Retry button');
    ok(status.textContent === 'Hand tracking failed to load (check your connection).', 'missing MediaPipe shows the connection message');
    ok(box.elementById('placeholderHint').textContent.includes('queue and library still work'), 'placeholder explains the queue still works');
    ok(box.window.airdeck && box.window.airdeck.queue, 'window.airdeck and the queue exist without MediaPipe');
    ok(start.disabled === false, 'Retry is enabled after the failure');
  }

  // 2. Calibration: margins are applied before the range is checked; an inverted or too-tight range is refused.
  const samples = (v) => Array.from({ length: 12 }, () => v);
  function calibrateWith(closedRaw, openRaw) {
    const storage = {};
    let phase = 0;
    const box = boot({ storage, timeout: (fn, ms) => {
      if (ms === 2000) { box.dbg.calib.samples.push(...samples(phase++ === 0 ? closedRaw : openRaw)); }
      fn(); return 0;
    } });
    return { box, storage, run: () => box.dbg.calibrate() };
  }
  {
    const c = calibrateWith(0.9, 0.5);   // closed raw above open raw: inverted
    await c.run();
    ok(c.box.elementById('calibMsg').textContent.includes('Try again'), 'inverted calibration shows the try-again message');
    ok(!('airdeck-pinch-v2' in c.storage), 'inverted calibration is not saved');
  }
  {
    const c = calibrateWith(0.1, 0.14);  // margins make closed 0.13 and open 0.126: too close
    await c.run();
    ok(c.box.elementById('calibMsg').textContent.includes('Try again'), 'calibration with less than 0.03 between the margins is refused');
    ok(!('airdeck-pinch-v2' in c.storage), 'too-tight calibration is not saved');
  }
  {
    const c = calibrateWith(0.1, 1.0);   // closed 0.13, open 0.9
    await c.run();
    const saved = JSON.parse(c.storage['airdeck-pinch-v2']);
    ok(Math.abs(saved.closed - 0.13) < 1e-9 && Math.abs(saved.open - 0.9) < 1e-9, 'a valid calibration saves the margined range');
    ok(Math.abs(c.box.dbg.getPinch().open - 0.9) < 1e-9, 'a valid calibration applies the range');
  }
  {
    const box = boot({ storage: { 'airdeck-pinch-v2': JSON.stringify({ closed: 0.9, open: 0.5 }) } });
    ok(box.dbg.getPinch().closed === 0.05 && box.dbg.getPinch().open === 0.9, 'an inverted saved range is ignored at load');
    const good = boot({ storage: { 'airdeck-pinch-v2': JSON.stringify({ closed: 0.2, open: 0.8 }) } });
    ok(good.dbg.getPinch().closed === 0.2 && good.dbg.getPinch().open === 0.8, 'a usable saved range is restored at load');
  }

  // 3. Idle reset: when the synthetic hands are removed, the shape and bubbles are cleared.
  {
    const box = boot();
    box.window.airdeck.fake = twoHands();
    box.dbg.setVisual('bubbles');
    let t = 1000;
    for (let i = 0; i < 40; i++) { box.dbg.step(t); t += 33; }
    ok(box.dbg.frame.active === true, 'synthetic hands activate the shape');
    ok(box.dbg.bubbleParticles.particles.length > 0, 'bubbles emit while the synthetic shape is up');
    box.window.airdeck.fake = null;
    box.dbg.step(t); t += 33;
    ok(box.dbg.frame.active === false && box.dbg.frame.live === false, 'removing the synthetic hands clears frame.active');
    ok(box.dbg.bubbleParticles.particles.length === 0, 'removing the synthetic hands clears Bubble Aero particles');
    for (let i = 0; i < 10; i++) { box.dbg.step(t); t += 33; }
    ok(box.dbg.bubbleParticles.particles.length === 0, 'the idle screen stays clear afterwards');
  }

  // 4. Bubble Aero: emits without WebGL, and stops emitting once the hands leave.
  {
    const box = boot({ webgl: false });
    box.window.airdeck.fake = twoHands();
    box.dbg.setVisual('bubbles');
    let t = 1000;
    for (let i = 0; i < 20; i++) { box.dbg.step(t); t += 33; }
    ok(box.dbg.bubbleParticles.particles.length > 0, 'Bubble Aero emits without WebGL');
    box.window.airdeck.fake = { landmarks: [], worldLandmarks: [] };   // hands gone, still in test mode
    box.dbg.step(t); t += 33;   // one frame of lag: the emitter runs before the tracker sees the hands are gone
    let before = box.dbg.bubbleParticles.particles.length, grew = false;
    for (let i = 0; i < 30; i++) {
      box.dbg.step(t); t += 33;
      if (box.dbg.bubbleParticles.particles.length > before) grew = true;
      before = box.dbg.bubbleParticles.particles.length;
    }
    ok(!grew, 'Bubble Aero stops emitting once both hands are gone');
  }

  // 5. Next during an AI DJ mix: no hard cut, and an accurate message.
  {
    const box = boot();
    box.dbg.deck.playing = true;
    box.dbg.mixing = true;
    await box.dbg.nextSong();
    ok(!box.queueCalls.includes('next') && !box.queueCalls.some((c) => c.startsWith('play:')), 'Next during a mix does not hard-cut');
    ok(box.dbg.toast === 'A mix is already in progress', 'Next during a mix explains that a mix is already in progress');
  }

  console.log(`\n${checks} checks passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
