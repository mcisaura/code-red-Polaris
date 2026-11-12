// AirMix QA2: one in-flight camera start and one frame loop; modifier keys don't trigger set shortcuts.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const page = fs.readFileSync(__dirname + '/../ai-dj.html', 'utf8');
const cam = page.slice(page.indexOf('// One camera request at a time'), page.indexOf('// What a failed camera request means'));
const keysrc = page.slice(page.indexOf('let lastCameraFrame'), page.indexOf('// Keep the song card'));
const flush = () => new Promise((r) => setImmediate(r));

(async () => {
  let opened = 0, scheduled = 0;
  const btn = { textContent: '', disabled: false };
  const box = {
    console, startBtn: btn, calibBtn: {}, statusEl: {}, $: () => null, cameraStopped() {}, cameraError: String,
    video: { videoWidth: 1, videoHeight: 1, play: async () => {}, srcObject: null },
    canvas: {}, scheduleFrame() { scheduled++; },
    navigator: { mediaDevices: { getUserMedia: async () => { opened++; await flush(); return { getVideoTracks: () => [], getTracks: () => [] }; } } },
  };
  vm.createContext(box); vm.runInContext(cam, box);
  const [a, b] = [vm.runInContext('startCamera()', box), vm.runInContext('startCamera()', box)];
  await Promise.all([a, b]);
  assert.equal(opened, 1, 'concurrent starts share one stream');
  await vm.runInContext('startCamera()', box);
  assert.equal(opened, 2);
  assert.equal(scheduled, 1, 'only one frame loop ever');

  let paused = 0, restarted = 0, handlers = {};
  const k = {
    console, performance, $: () => ({ textContent: '', disabled: false, addEventListener() {} }),
    djGame: { paused: false, finishing: false, pause() { paused++; return true; }, async resume() {}, setEnabled() {}, reset() {} },
    screens: { countIn() {}, paused() {}, cancel() {}, replay() { restarted++; }, newSet() {} },
    queue: { endSet: async () => {} }, video: { srcObject: null }, startCamera: async () => true,
    document: { hidden: false, addEventListener(t, f) { handlers[t] = f; } },
  };
  vm.createContext(k); vm.runInContext(keysrc, k);
  vm.runInContext('inSet = true; phase = "playing";', k);
  const ev = (code, extra) => handlers.keydown({ code, repeat: false, target: { closest: () => null }, preventDefault() {}, ...extra });
  for (const m of ['metaKey', 'ctrlKey', 'altKey']) { ev('KeyP', { [m]: true }); ev('KeyR', { [m]: true }); }
  await flush();
  assert.equal(paused, 0, 'Cmd/Ctrl/Alt+P must not pause');
  assert.equal(restarted, 0, 'Cmd/Ctrl/Alt+R must not restart');
  ev('KeyP', {});
  assert.equal(paused, 1);
  console.log('PASS: AirMix qa2 camera single-flight and modifier keys');
})().catch((e) => { console.error(e); process.exitCode = 1; });
