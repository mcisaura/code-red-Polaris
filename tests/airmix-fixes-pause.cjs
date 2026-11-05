// AirMix pause and resume: the Pause button's label follows the real state (also after an
// asynchronous resume), Esc / Space / the button work during the resume count-in, and hiding
// the tab during a count-in or a resume holds the set. Runs the page's own pause section.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const page = fs.readFileSync(__dirname + '/../ai-dj.html', 'utf8');
const section = page.slice(page.indexOf('let inSet = false;'), page.indexOf('// Keep the song card'));
const flush = () => new Promise((resolve) => setImmediate(resolve));

const listeners = {};
const nodes = {};
const $ = (id) => nodes[id] ?? (nodes[id] = {
  textContent: '', disabled: false,
  addEventListener(type, fn) { (listeners[id] ??= {})[type] = fn; },
});
const docListeners = {};
let pendingGo = null, panels = 0, resolveResume = null;
const game = {
  paused: false,
  pause() { if (this.paused) return false; this.paused = true; return true; },
  // Like djGame.resume(): the audio resumes asynchronously, and only then is the game unpaused.
  resume() { return new Promise((resolve) => { resolveResume = () => { this.paused = false; resolve(); }; }); },
  setEnabled() {}, reset() {},
};
const screens = {
  countIn(onGo) { pendingGo = onGo; },
  paused() { panels++; pendingGo = null; }, // the real screen stops a count-in
  cancel() { pendingGo = null; }, replay() {}, newSet() {},
};
const box = {
  console, setImmediate,
  djGame: game, screens,
  queue: { endSet: async () => {} },
  $,
  document: { hidden: false, addEventListener(type, fn) { docListeners[type] = fn; } },
};
vm.createContext(box);
vm.runInContext(section, box);
const run = (code) => vm.runInContext(code, box);
const label = () => $('pauseBtn').textContent;
const key = (code) => docListeners.keydown({ code, repeat: false, target: { closest: () => null }, preventDefault() {} });
const start = () => run('inSet = true; phase = "playing"; updateSetButtons();');
const go = () => { const f = pendingGo; pendingGo = null; f?.(); };
const check = [];
const test = (name, fn) => check.push([name, fn]);

test('the label follows pause, count-in and resume (including the async resume)', async () => {
  start();
  assert.equal(label(), '⏸ Pause');
  listeners.pauseBtn.click();
  assert.equal(label(), '▶ Resume');
  assert.equal(panels, 1);
  listeners.pauseBtn.click();
  assert.equal(label(), '⏸ Pause', 'resume count-in: the button offers Pause');
  go();
  assert.equal(label(), '⏸ Pause', 'resuming: not "Resume" while the audio is still waking up');
  assert.equal(game.paused, true);
  resolveResume();
  await flush();
  assert.equal(game.paused, false);
  assert.equal(label(), '⏸ Pause', 'after resume resolves the label says Pause');
  listeners.pauseBtn.click();
  assert.equal(label(), '▶ Resume');
});

test('Esc during the resume count-in returns to the Paused panel and the count does not start', async () => {
  start();
  key('Escape');
  listeners.pauseBtn.click();
  assert.equal(pendingGo !== null, true, 'count-in running');
  key('Escape');
  assert.equal(panels, 2, 'back on the Paused panel');
  assert.equal(pendingGo, null, 'the count-in is stopped');
  assert.equal(label(), '▶ Resume');
  assert.equal(game.paused, true);
});

test('Space during the resume count-in goes to the Paused panel, not a second count-in', async () => {
  start();
  key('Escape');
  listeners.pauseBtn.click();
  key('Space');
  assert.equal(panels, 2);
  assert.equal(label(), '▶ Resume');
});

test('hiding the tab during the resume count-in holds the set on the Paused panel', async () => {
  start();
  key('Escape');
  listeners.pauseBtn.click();
  box.document.hidden = true;
  docListeners.visibilitychange();
  assert.equal(panels, 2);
  assert.equal(pendingGo, null, 'nothing counts down while hidden');
  assert.equal(label(), '▶ Resume');
  box.document.hidden = false;
});

test('hiding the tab while the audio resumes pauses again as soon as it is going', async () => {
  start();
  key('Escape');
  listeners.pauseBtn.click();
  go();
  box.document.hidden = true;
  docListeners.visibilitychange();
  resolveResume();
  await flush();
  assert.equal(game.paused, true, 'the set is paused again');
  assert.equal(panels, 2, 'one Paused panel for the first pause, one after the resume');
  assert.equal(label(), '▶ Resume');
  box.document.hidden = false;
});

(async () => {
  for (const [name, fn] of check) {
    vm.runInContext('inSet = false; phase = "playing"; pauseAfterResume = false;', box);
    game.paused = false; panels = 0; pendingGo = null;
    await fn();
    console.log(`PASS: ${name}`);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
