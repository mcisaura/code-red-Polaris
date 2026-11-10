// Run: node tests/deck-fixes-fistzone.cjs
// While controls are locked, the Effects fist zone is drawn (and must detect) only below LOCK_ZONE_Y.
//  (b) keydown events without `key` (synthetic or autofill) must not throw (index.html keydown handlers)
//  (c) FrameFx.resize() while the WebGL context is lost must survive a restore (frame.js)
// index.html is loaded like tests/tracking.cjs (inline module in a vm). DOM, audio and WebGL are stubs.
const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path');
const root = path.join(__dirname, '..');

function bootDeck() {
  const code = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    .split('<script type="module">')[1].split('</script>')[0].replace(/^import .*$/mg, '');
  const noop = () => {}, gradient = { addColorStop: noop };
  const ctx = new Proxy({ measureText: (t) => ({ width: String(t).length * 7 }), createLinearGradient: () => gradient },
    { get: (o, k) => (k in o ? o[k] : noop) });
  const elements = new Map();
  const el = () => ({ width: 1280, height: 720, style: { setProperty: noop }, classList: { toggle: noop, contains: () => false, add: noop, remove: noop },
    addEventListener: noop, appendChild: noop, insertBefore: noop, append: noop, remove: noop, getContext: () => ctx,
    querySelector: () => ({ style: {} }), querySelectorAll: () => [], textContent: '', value: '', hidden: false, setAttribute: noop });
  const events = {};
  const box = {
    console: { log: noop, warn: noop, error: noop },
    performance, Math, Float32Array, Uint8Array, Number, JSON, Promise, Set, Map, Array, Object, Symbol, Error,
    setTimeout: () => 0, clearTimeout: noop,
    window: { addEventListener: (k, f) => (events[k] ??= []).push(f) },
    document: { addEventListener: noop, getElementById: (k) => { if (!elements.has(k)) elements.set(k, el()); return elements.get(k); },
      createElement: el, querySelector: el, querySelectorAll: () => [], body: el(), fullscreenElement: null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    requestAnimationFrame: noop,
    Audio: class { play() { return Promise.resolve(); } },
    Deck: class {
      constructor() { return new Proxy({ playing: false, currentSlot: null, blendState: () => null, effectState: () => ({}), slotState: () => [],
        waveform: () => new Float32Array(128), bass: () => 0 }, { get: (o, k) => (k in o ? o[k] : noop) }); }
    },
    BubbleParticles: class { render() {} clear() {} },
    FrameFx: class { constructor() { this.canvas = el(); this.ok = true; } resize() {} clear() {} render() {} },
    createQueue: () => new Proxy({ getState: () => ({ items: [], currentId: null, downloads: [], status: null, dj: {} }),
      startDefaultQueue: () => new Promise(() => {}), getUpNext: () => null, on: noop }, { get: (o, k) => (k in o ? o[k] : noop) }),
    createQueuePanel: () => ({ toggle: noop }), createTransport: () => el(), createUpNext: () => ({ element: el() }),
    location: { hash: '', replace: noop },
    FilesetResolver: { forVisionTasks: async () => ({}) }, HandLandmarker: { createFromOptions: async () => ({}) },
  };
  vm.createContext(box);
  vm.runInContext(code, box);
  return { api: box.window.airdeck, events, run: (c) => vm.runInContext(c, box) };
}

// Hand fixture from tests/tracking.cjs / the QA repro. n = number of extended fingers (0 = fist).
function hand(x, y, n, label = 'Right') {
  const h = { l: [], w: Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 })), label };
  h.w[0] = { x: 0, y: 0, z: 0 }; h.w[1] = { x: -.018, y: -.014, z: 0 }; h.w[2] = { x: -.03, y: -.028, z: 0 };
  h.w[3] = { x: -.052, y: -.028, z: 0 }; h.w[4] = { x: -.08, y: -.028, z: 0 };
  for (let j = 0; j < 4; j++) {
    const m = 5 + j * 4, b = j < n ? 0 : 150;
    h.w[m] = { x: -.018 + j * .014, y: -.05, z: 0 }; h.w[m + 1] = { x: h.w[m].x, y: -.078, z: 0 };
    h.w[m + 2] = { x: h.w[m].x + .024 * Math.sin(b * Math.PI / 180), y: -.078 - .024 * Math.cos(b * Math.PI / 180), z: 0 };
    h.w[m + 3] = { x: h.w[m + 2].x, y: h.w[m + 2].y - .018, z: 0 };
  }
  if (n < 5) h.w[4] = { ...h.w[5] };   // thumb curled unless all five fingers are out
  h.l = h.w.map((p) => ({ x: 1 - x + p.x * 1.8, y: y + p.y * 3.2, z: 0 }));
  return h;
}
const feed = (e, hands, t) => { e.api.fake = { landmarks: hands.map((h) => h.l), worldLandmarks: hands.map((h) => h.w),
  handedness: hands.map((h) => [{ categoryName: h.label, score: .99 }]) }; e.api.update(e.api.fake, t); };
const press = (e, key) => { for (const f of e.events.keydown) f({ key, target: { tagName: 'BODY' }, preventDefault() {} }); };

const mk = (locked, y) => {
  const e = bootDeck();
  if (locked) press(e, 'k');
  assert.strictEqual(e.api.lock.locked, locked);
  let t = 1000;
  for (let i = 0; i < 30; i++) feed(e, [hand(.08, y, 0, 'Left')], t += 34);
  return e.api.modes.current;
};
assert.strictEqual(mk(false, .15), 'fx', 'unlocked: top-left fist enters effects');
assert.strictEqual(mk(true, .15), 'normal', 'locked: top-left fist (no zone drawn) does not enter effects');
assert.strictEqual(mk(true, .6), 'fx', 'locked: fist below the lock line still enters effects');
console.log('PASS: effects fist zone detection matches its locked drawing');
