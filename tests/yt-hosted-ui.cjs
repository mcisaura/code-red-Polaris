// Run: node tests/yt-hosted-ui.cjs. Effects are per song: while the current song is a YouTube embed item the DJ Deck
// offers no effects (UI and help hidden, the fist zone, the F key and the picks do nothing, no "not available"
// message) and it switches live when the song changes to an audio item (hosted track or file) and back. The tutorial
// skips its effects step for a YouTube first song. Locally everything stays. index.html's
// inline module runs in a vm like tests/deck-fixes-modes.cjs.
const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path');
const root = path.join(__dirname, '..');

function bootDeck(config, q = { items: [], currentId: null, embedActive: false }) {
  const code = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    .split('<script type="module">')[1].split('</script>')[0].replace(/^import .*$/mg, '');
  const noop = () => {}, gradient = { addColorStop: noop };
  const ctx = new Proxy({ measureText: (t) => ({ width: String(t).length * 7 }), createLinearGradient: () => gradient },
    { get: (o, k) => (k in o ? o[k] : noop) });
  const elements = new Map();
  const el = () => ({ width: 1280, height: 720, style: { setProperty: noop }, classList: { toggle: noop, contains: () => false, add: noop, remove: noop },
    addEventListener: noop, appendChild: noop, insertBefore: noop, append: noop, remove: noop, getContext: () => ctx,
    querySelector: () => ({ style: {} }), querySelectorAll: () => [], textContent: '', value: '', hidden: false, setAttribute: noop });
  const fxNodes = [el(), el(), el()]; // what the page marks class="fxOnly"
  const events = {};
  const listeners = [];
  const box = {
    console: { log: noop, warn: noop, error: noop },
    performance, Math, Float32Array, Uint8Array, Number, JSON, Promise, Set, Map, Array, Object, Symbol, Error,
    setTimeout: () => 0, clearTimeout: noop,
    window: { addEventListener: (k, f) => (events[k] ??= []).push(f) },
    document: { addEventListener: noop, getElementById: (k) => { if (!elements.has(k)) elements.set(k, el()); return elements.get(k); },
      createElement: el, querySelector: el, querySelectorAll: (s) => (s === '.fxOnly' ? fxNodes : []), body: el(), fullscreenElement: null },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    requestAnimationFrame: noop,
    Audio: class { play() { return Promise.resolve(); } },
    Deck: class {
      constructor() { return new Proxy({ playing: false, currentSlot: null, blendState: () => null, effectState: () => ({}), slotState: () => [],
        waveform: () => new Float32Array(128), bass: () => 0 }, { get: (o, k) => (k in o ? o[k] : noop) }); }
    },
    BubbleParticles: class { render() {} clear() {} },
    FrameFx: class { constructor() { this.canvas = el(); this.ok = true; } resize() {} clear() {} render() {} },
    createQueue: () => new Proxy({ getState: () => ({ items: q.items, currentId: q.currentId, downloads: [], status: null, dj: {} }),
      startDefaultQueue: () => new Promise(() => {}), getUpNext: () => null, on: (f) => listeners.push(f), isEmbedActive: () => q.embedActive }, { get: (o, k) => (k in o ? o[k] : noop) }),
    createQueuePanel: () => ({ toggle: noop }), createTransport: () => el(), createUpNext: () => ({ element: el() }),
    loadConfig: async () => config,
    location: { hash: '', replace: noop },
    FilesetResolver: { forVisionTasks: async () => ({}) }, HandLandmarker: { createFromOptions: async () => ({}) },
  };
  vm.createContext(box);
  vm.runInContext(code, box);
  return { api: box.window.airdeck, events, q, notify: () => listeners.forEach((f) => f()), fxNodes, elements, run: (c) => vm.runInContext(c, box) };
}
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };

// A hand fixture from tests/deck-fixes-modes.cjs (n = extended fingers, 0 = fist).
function hand(x, y, n, label) {
  const h = { l: [], w: Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 })), label };
  h.w[1] = { x: -.018, y: -.014, z: 0 }; h.w[2] = { x: -.03, y: -.028, z: 0 }; h.w[3] = { x: -.052, y: -.028, z: 0 }; h.w[4] = { x: -.08, y: -.028, z: 0 };
  for (let j = 0; j < 4; j++) {
    const m = 5 + j * 4, b = j < n ? 0 : 150;
    h.w[m] = { x: -.018 + j * .014, y: -.05, z: 0 }; h.w[m + 1] = { x: h.w[m].x, y: -.078, z: 0 };
    h.w[m + 2] = { x: h.w[m].x + .024 * Math.sin(b * Math.PI / 180), y: -.078 - .024 * Math.cos(b * Math.PI / 180), z: 0 };
    h.w[m + 3] = { x: h.w[m + 2].x, y: h.w[m + 2].y - .018, z: 0 };
  }
  if (n < 5) h.w[4] = { ...h.w[5] };
  h.l = h.w.map((p) => ({ x: 1 - x + p.x * 1.8, y: y + p.y * 3.2, z: 0 }));
  return h;
}
const feed = (e, hands, t) => { e.api.fake = { landmarks: hands.map((h) => h.l), worldLandmarks: hands.map((h) => h.w),
  handedness: hands.map((h) => [{ categoryName: h.label, score: .99 }]) }; e.api.update(e.api.fake, t); };
const press = (e, key) => { for (const f of e.events.keydown) f({ key, target: { tagName: 'BODY' }, preventDefault() {} }); };

(async () => {
  const HOSTED = { youtube: false, youtubeEmbed: true, hosted: true };
  const LOCAL = { youtube: true, youtubeEmbed: false, hosted: false };

  // Hosted: the effects UI is hidden once the config is known.
  const YT = { items: [{ id: 1, embed: true, videoId: 'x' }], currentId: 1, embedActive: true };
  const h = bootDeck(HOSTED, YT);
  h.notify();
  await settle();
  assert.strictEqual(h.run('fxOff'), true);
  assert(h.fxNodes.every((node) => node.hidden === true), 'every .fxOnly block (effect chips, effect help, filter help) is hidden');
  assert.strictEqual(h.elements.get('rightControl').hidden, true, 'the filter readout is hidden');
  assert.strictEqual(h.elements.get('rightCtlName').hidden, true, 'and the card does not say "filter"');

  // Inert: the F key, the left-fist zone and a pick do nothing, and nothing is flashed.
  press(h, 'f');
  assert.strictEqual(h.api.modes.current, 'normal', 'F does not open the effects mode');
  let t = 1000;
  for (let i = 0; i < 40; i++) feed(h, [hand(.1, .5, 0, 'Left')], t += 34);
  assert.strictEqual(h.api.modes.current, 'normal', 'a left fist in the left zone does not enter the effects mode');
  assert.strictEqual(h.api.modes.fistSide, null);
  h.run('enterMode("fx", true); pick(1); pick(5)');
  assert.strictEqual(h.api.modes.current, 'normal', 'the mode cannot be entered by code either');
  assert.strictEqual(h.run('toast.text'), '', 'no "not available" message is flashed');
  assert.strictEqual(h.run('lastFx'), null);
  // The right pinch no longer drives a filter.
  assert.strictEqual(h.run('knobs.right'), 1);
  // Songs and visuals still work.
  press(h, 's');
  assert.strictEqual(h.api.modes.current, 'song', 'the song mode still opens');
  press(h, 'v');
  assert.strictEqual(h.api.modes.current, 'vis', 'the visuals mode still opens');

  // Live switch: the next song is a hosted audio item -> the effects UI is back and the gestures work.
  h.q.items = [{ id: 1, embed: true, videoId: 'x' }, { id: 2, url: 'music/a.m4a', hosted: true }]; h.q.currentId = 2; h.q.embedActive = false;
  h.notify();
  assert.strictEqual(h.run('fxOff'), false, 'an audio item has effects');
  assert(h.fxNodes.every((node) => node.hidden === false), 'effects UI shown for the audio item');
  assert.strictEqual(h.elements.get('rightControl').hidden, false);
  press(h, 'f');
  assert.strictEqual(h.api.modes.current, 'fx', 'F opens the effects mode on an audio item');
  // ...and back to a YouTube item: hidden again, the mode is left, the filter is reset.
  h.q.currentId = 1; h.q.embedActive = true;
  h.notify();
  assert.strictEqual(h.run('fxOff'), true);
  assert.strictEqual(h.api.modes.current, 'normal', 'the effects mode closes when a YouTube song takes over');
  assert(h.fxNodes.every((node) => node.hidden === true));
  // Nothing current yet: follows isEmbedActive().
  h.q.items = []; h.q.currentId = null; h.q.embedActive = false;
  h.notify();
  assert.strictEqual(h.run('fxOff'), false, 'no current song and no embed playing: effects stay available');
  h.q.embedActive = true; h.notify();
  assert.strictEqual(h.run('fxOff'), true, 'an embed playing with no current item still hides effects');

  // Local: nothing changes.
  const l = bootDeck(LOCAL);
  await settle();
  assert.strictEqual(l.run('fxOff'), false);
  assert(l.fxNodes.every((node) => node.hidden === false), 'locally the effects UI shows');
  press(l, 'f');
  assert.strictEqual(l.api.modes.current, 'fx', 'locally F opens the effects mode');
  const l2 = bootDeck(LOCAL);
  await settle();
  t = 1000;
  for (let i = 0; i < 40; i++) feed(l2, [hand(.1, .5, 0, 'Left')], t += 34);
  assert.strictEqual(l2.api.modes.current, 'fx', 'locally the left fist zone enters the effects mode');

  // The page text: effect help sits in .fxOnly blocks.
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const needle of ['id="fxChips"', 'effects mode', 'picks an effect', 'sets the filter']) {
    const at = html.indexOf(needle);
    assert(at > 0, needle);
    assert(/class="[^"]*fxOnly/.test(html.slice(Math.max(0, at - 120), at + needle.length)), `"${needle}" is inside an fxOnly element`);
  }

  // The tutorial skips the effects step on hosted and does not mention the filter.
  const src = fs.readFileSync(path.join(root, 'deckTour.js'), 'utf8').replace(/^export /mg, '');
  const { TOUR_STEPS, tourStepsFor } = new Function(src + '\nreturn { TOUR_STEPS, tourStepsFor };')();
  assert.strictEqual(tourStepsFor(false), TOUR_STEPS, 'locally the tutorial is unchanged');
  const hosted = tourStepsFor(true); // what a YouTube first song gets
  assert(TOUR_STEPS.some((s) => s.id === 'fx') && !hosted.some((s) => s.id === 'fx'), 'hosted: no effects step');
  assert.strictEqual(hosted.length, TOUR_STEPS.length - 1);
  assert(!hosted.some((s) => /filter|effect/i.test(s.text)), 'hosted: no step text mentions the filter or effects');
  assert(hosted.some((s) => s.id === 'song') && hosted.some((s) => s.id === 'lock'), 'the other steps stay');

  // The card note is one plain line in the readable orange.
  const yt = fs.readFileSync(path.join(root, 'ytEmbed.js'), 'utf8');
  assert(/\.ytCard-note \{[^}]*color: #8a4510/.test(yt));
  assert(!/\n/.test(yt.match(/EMBED_NOTE = "([^"]*)"/)[1]));
  console.log('yt-hosted-ui: all checks passed');
})().catch((error) => { console.error(error); process.exit(1); });
