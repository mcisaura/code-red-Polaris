// AirMix pause section: the finale's fade can't be paused or restarted, and a camera that stops
// mid-set (track ended, or no frames for a few seconds) pauses the set with its own message and
// a way to try the camera again. Runs the page's own pause section.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const page = fs.readFileSync(__dirname + '/../ai-dj.html', 'utf8');
const section = page.slice(page.indexOf('let lastCameraFrame'), page.indexOf('// Keep the song card'));
const flush = () => new Promise((resolve) => setImmediate(resolve));

const nodes = {};
const $ = (id) => nodes[id] ?? (nodes[id] = { textContent: '', disabled: false, addEventListener() {} });
const docListeners = {};
const game = {
  paused: false, finishing: false,
  pause() { if (this.paused) return false; this.paused = true; return true; },
  async resume() { this.paused = false; },
  setEnabled() {}, reset() { this.paused = false; this.finishing = false; },
};
let panels = [], cameraResults = [];
const screens = {
  countIn() {}, paused(options) { panels.push(options); }, cancel() {}, replay() {}, newSet() {},
};
let stops = 0;
const box = {
  console, performance,
  djGame: game, screens, queue: { endSet: async () => {} }, $,
  video: { srcObject: { getTracks: () => [{ stop() { stops++; } }] } },
  startCamera: async () => cameraResults.shift() ?? true,
  document: { hidden: false, addEventListener(type, fn) { docListeners[type] = fn; } },
};
vm.createContext(box);
vm.runInContext(section, box);
const run = (code) => vm.runInContext(code, box);
const start = () => {
  game.paused = false; game.finishing = false; panels = []; cameraResults = [];
  run('inSet = true; phase = "playing"; cameraLost = false; updateSetButtons();');
};
const key = (code) => docListeners.keydown({ code, repeat: false, target: { closest: () => null }, preventDefault() {} });
const check = [];
const test = (name, fn) => check.push([name, fn]);

test('pause, restart and Esc/Space/P do nothing during the finale fade', async () => {
  start();
  game.finishing = true;
  run('pauseSet()');
  key('Space'); key('KeyP'); key('Escape'); key('KeyR');
  assert.equal(game.paused, false);
  assert.equal(panels.length, 0, 'no Paused panel under the results');
  assert.equal(run('phase'), 'playing');
  run('document.hidden = true'); docListeners.visibilitychange?.();
  assert.equal(game.paused, false);
});

test('a camera that ends mid-set pauses with a clear message', async () => {
  start();
  run('cameraStopped()');
  assert.equal(game.paused, true);
  assert.equal(run('phase'), 'paused');
  assert.equal(panels.length, 1);
  assert.equal(panels[0].title, 'Camera stopped');
  assert.match(panels[0].text, /camera/i);
  assert.equal(typeof panels[0].resume, 'function');
  assert.equal(typeof panels[0].newSet, 'function');
});

test('a camera that stops sending frames pauses the set after a few seconds, not before', async () => {
  start();
  const t0 = performance.now();
  run(`lastCameraFrame = ${t0}`);
  run(`checkCameraStall(${t0 + 2000})`);
  assert.equal(game.paused, false);
  run(`checkCameraStall(${t0 + 4500})`);
  assert.equal(game.paused, true);
  assert.equal(panels[0].title, 'Camera stopped');
});

test('time spent paused or counting in does not count as a stall; nor does the finale', async () => {
  start();
  run('phase = "paused"');
  run(`lastCameraFrame = 0; checkCameraStall(100000)`);
  assert.equal(game.paused, false);
  run('phase = "playing"');
  assert.ok(run('lastCameraFrame') >= 100000, 'the clock restarted while paused');
  game.finishing = true;
  run(`lastCameraFrame = 0; checkCameraStall(100000)`);
  assert.equal(game.paused, false);
});

test('Try camera restarts the camera and resumes; a failure shows its reason and stays paused', async () => {
  start();
  run('cameraStopped()');
  cameraResults = ['No camera found. Plug one in, then try again.'];
  panels[0].resume();
  await flush();
  assert.equal(stops, 1, 'the dead stream is released');
  assert.equal(panels.length, 2, 'the panel is shown again');
  assert.equal(panels[1].text, 'No camera found. Plug one in, then try again.');
  assert.equal(run('phase'), 'paused');
  cameraResults = [true];
  panels[1].resume();
  await flush();
  assert.equal(run('cameraLost'), false);
  assert.equal(run('phase') === 'counting' || run('phase') === 'playing' || run('phase') === 'resuming', true);
});

test('New set from the camera panel leaves the set', async () => {
  start();
  run('cameraStopped()');
  await panels[0].newSet();
  assert.equal(run('inSet'), false);
  assert.equal(run('cameraLost'), false);
});

(async () => {
  for (const [name, fn] of check) {
    await fn();
    console.log(`PASS: ${name}`);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
