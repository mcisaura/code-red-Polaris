// Run: node tests/deck-qa2-blend-keys.cjs
// Regression checks for index.html (QA round 2):
//  1. an active hand blend finishes from a timer even when no frames/rAF run (hidden tab)
//  2. a second next press during a blend (or while it is starting) finishes it instead of being ignored
//  3. keys with Alt/Ctrl/Meta/defaultPrevented, or aimed at buttons/sliders, are not test keys
//  4. chips/status/canvas accessibility markup
const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function boot() {
  const code = html.split('<script type="module">')[1].split('</script>')[0].replace(/^import .*$/mg, '');
  const noop = () => {}, gradient = { addColorStop: noop };
  const ctx = new Proxy({ measureText: (t) => ({ width: String(t).length * 7 }), createLinearGradient: () => gradient }, { get: (o, k) => (k in o ? o[k] : noop) });
  const elements = new Map();
  const el = () => ({ width: 1280, height: 720, style: { setProperty: noop }, classList: { toggle: noop, contains: () => false, add: noop, remove: noop },
    addEventListener: noop, appendChild: noop, insertBefore: noop, append: noop, remove: noop, getContext: () => ctx,
    querySelector: () => ({ style: {} }), querySelectorAll: () => [], textContent: '', value: '', hidden: false, setAttribute: noop });
  const events = {}, timers = [];
  const calls = { finish: [], incoming: [], next: 0 };
  const controls = { done: false, startsIn: 0, finish: (s) => calls.finish.push(s), setIncoming: (v) => calls.incoming.push(v), setOutgoing: noop, swapBass: noop };
  const items = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }];
  const box = {
    console: { log: noop, warn: noop, error: noop }, performance, Math, Float32Array, Uint8Array, Number, JSON, Promise, Set, Map, Array, Object, Symbol, Error, String,
    setTimeout: (f) => timers.push(f), clearTimeout: noop,
    window: { addEventListener: (k, f) => (events[k] ??= []).push(f) },
    document: { addEventListener: noop, getElementById: (k) => { if (!elements.has(k)) elements.set(k, el()); return elements.get(k); },
      createElement: el, querySelector: el, querySelectorAll: () => [], body: el(), fullscreenElement: null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, requestAnimationFrame: noop,
    Audio: class { play() { return Promise.resolve(); } },
    Deck: class { constructor() { return new Proxy({ playing: true, effectState: () => ({}), slotState: () => [], waveform: () => new Float32Array(128), bass: () => 0 },
      { get: (o, k) => (k in o ? o[k] : noop) }); } },
    BubbleParticles: class { render() {} clear() {} },
    FrameFx: class { constructor() { this.canvas = el(); this.ok = true; } resize() {} clear() {} render() {} },
    createQueue: () => new Proxy({ getState: () => ({ items, currentId: 'a', downloads: [], status: null, dj: {} }), getUpNext: () => ({ item: items[1] }),
      startHandMix: async () => controls, next: () => { calls.next++; }, on: noop }, { get: (o, k) => (k in o ? o[k] : noop) }),
    createQueuePanel: () => ({ toggle: noop }), createTransport: () => el(), createUpNext: () => ({ element: el() }),
    location: { hash: '', replace: noop },
    FilesetResolver: { forVisionTasks: async () => ({}) }, HandLandmarker: { createFromOptions: async () => ({}) },
  };
  vm.createContext(box);
  vm.runInContext(code, box);
  return { api: box.window.airdeck, events, timers, calls, controls, run: (c) => vm.runInContext(c, box) };
}
const key = (e, k, extra = {}) => { const ev = { key: k, target: { tagName: 'BODY' }, preventDefault() {}, ...extra }; for (const f of e.events.keydown) f(ev); };

(async () => {
  // 1. timer fallback finishes an active blend with no frames
  {
    const e = boot();
    await e.run('nextSong()');
    assert.strictEqual(e.api.blend.active, true, 'blend should start');
    assert.ok(e.timers.length > 0, 'a watchdog timer must be scheduled while the blend is active');
    e.api.blend.last = e.api.blend.lastInput = performance.now() - 5000;   // no hand and no frames for 5 s
    e.timers.shift()();
    assert.deepStrictEqual(e.calls.finish, [5], 'watchdog must auto-finish an idle blend');
  }
  // 2. second next press finishes the blend; a press during startup finishes it right after start
  {
    const e = boot();
    await e.run('nextSong()');
    await e.run('nextSong()');
    assert.deepStrictEqual(e.calls.finish, [5], 'second next press must finish the blend');
  }
  {
    const e = boot();
    const first = e.run('nextSong()');
    await e.run('nextSong()');   // while starting
    await first;
    assert.strictEqual(e.calls.finish.length, 1, 'press while starting must finish once started');
  }
  // 3. modifier keys and interactive targets
  {
    const e = boot();
    await e.run('nextSong()');
    const p0 = e.api.blend.p, s0 = e.api.blend.sweep;
    key(e, 'ArrowUp', { altKey: true }); key(e, 'ArrowRight', { ctrlKey: true }); key(e, 'ArrowDown', { defaultPrevented: true });
    key(e, 'ArrowRight', { target: { tagName: 'BUTTON' } });
    key(e, 'ArrowRight', { target: { tagName: 'DIV', getAttribute: (a) => (a === 'role' ? 'slider' : null) } });
    key(e, 'Enter', { target: { tagName: 'BUTTON' } });
    assert.strictEqual(e.api.blend.p, p0); assert.strictEqual(e.api.blend.sweep, s0);
    assert.strictEqual(e.calls.finish.length, 0, 'Enter on a button must not finish the blend');
    key(e, 'ArrowRight');
    assert.ok(e.api.blend.p > p0, 'plain arrow still drives the blend');
    key(e, 's', { target: { tagName: 'BUTTON' } });
    assert.strictEqual(e.api.modes.current, 'song', 'letter test keys still work from a button');
  }
  // 4. markup
  assert.ok(/id="songStatus"[^>]*role="status"/.test(html) && /id="status"[^>]*role="status"/.test(html), 'status regions need role=status');
  assert.ok(/<canvas id="canvas"[^>]*aria-label=/.test(html), 'canvas needs aria-label');
  assert.ok(/data-vis="\$\{v\}" role="button" tabindex="0"/.test(html), 'visual chips must be keyboard buttons');
  assert.ok(!/AI DJ moved to its own page/.test(html), 'stale AI DJ wording');
  console.log('deck-qa2-blend-keys: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
