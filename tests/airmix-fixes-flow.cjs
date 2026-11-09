// AirMix start flow: camera problems and the loading screen are not dead ends (New set goes back to
// the picker; a load finishing after Cancel starts nothing), the load-failure screen shows the real
// error, and the game's finale: not pausable while fading, and its fade is 3 s.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const source = fs.readFileSync(__dirname + '/../djStart.js', 'utf8').replace(/^export /mg, '');
const songs = Array.from({ length: 4 }, (_, i) => ({ id: `s${i + 1}`, title: `Title ${i + 1}`, artist: 'A', bpm: 90, genre: 'pop', available: true }));

// A DOM where each innerHTML write makes fresh children, so listeners belong to the current screen.
function element() {
  let children = {}, html = '';
  return {
    isConnected: true, textContent: '', disabled: false, dataset: {},
    get innerHTML() { return html; }, set innerHTML(value) { html = value; children = {}; },
    classList: { toggle() {} }, append() {}, setAttribute() {}, remove() { this.isConnected = false; },
    listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, click() { this.listeners.click?.(); },
    querySelector(selector) { return (children[selector] ??= element()); },
    querySelectorAll() { return []; },
  };
}

function startScreen({ startCamera = async () => true, prepare = () => {}, begin = () => {} } = {}) {
  let stageRoot = null, libraryCalls = 0;
  const box = {
    console, performance, setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 16),
    localStorage: { getItem: () => JSON.stringify(['s1', 's2']), setItem() {} },
    document: { hidden: false, head: element(), createElement: element, getElementById: () => null },
  };
  vm.createContext(box);
  vm.runInContext(source, box);
  const screens = vm.runInContext('createStartScreen', box)({ append(node) { stageRoot = node; } }, {
    library: async () => { libraryCalls++; return songs; },
    startCamera, handSeen: () => false, prepare, begin,
  });
  return { screens, root: () => stageRoot, libraryCalls: () => libraryCalls };
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = [];
const test = (name, fn) => check.push([name, fn]);

for (const [label, result] of [['no camera', 'No camera found. Plug one in, then try again.'], ['hand tracking failed', 'Hand tracking failed to load.'], ['denied', false]]) {
  test(`camera problem (${label}): New set goes back to the picker`, async () => {
    const { root, libraryCalls } = startScreen({ startCamera: async () => result });
    await flush();
    root().querySelector('[data-play]').click();
    root().querySelector('button').click(); // the intro's Start
    await flush();
    assert.match(root().innerHTML, /data-retry/);
    assert.match(root().innerHTML, /data-new/);
    const before = libraryCalls();
    root().querySelector('[data-new]').click();
    await flush();
    assert.equal(libraryCalls(), before + 1, 'the set picker loads again');
    assert.match(root().innerHTML, /djStart-songs/);
  });
}

test('the loading screen can be cancelled; a load finishing later starts nothing', async () => {
  let release, began = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const { screens, root, libraryCalls } = startScreen({ prepare: () => gate, begin: () => began++ });
  await flush();
  screens.replay();
  await flush();
  assert.match(root().innerHTML, /Getting the music ready/);
  assert.match(root().innerHTML, /data-cancel/);
  const before = libraryCalls();
  root().querySelector('[data-cancel]').click();
  await flush();
  assert.equal(libraryCalls(), before + 1);
  assert.match(root().innerHTML, /djStart-songs/);
  release();
  await wait(300);
  assert.equal(began, 0, 'the abandoned set never starts');
  assert.match(root().innerHTML, /djStart-songs/, 'still on the picker');
});

test('the load-failure screen shows the real error, keeps Try again / New set', async () => {
  const error = Object.assign(new Error("Couldn't download Song."), { detail: "yt-dlp isn't installed" });
  const { screens, root } = startScreen({ prepare: () => { throw error; } });
  await flush();
  screens.replay();
  await flush();
  const html = root().innerHTML;
  assert.match(html, /Couldn&#39;t download Song\./);
  assert.match(html, /yt-dlp isn&#39;t installed\./);
  assert.doesNotMatch(html, /internet connection/);
  assert.match(html, /data-new/);
  assert.match(html, /data-retry/);
});

test('without a detail the old hint stays', async () => {
  const { screens, root } = startScreen({ prepare: () => { throw new Error('boom'); } });
  await flush();
  screens.replay();
  await flush();
  assert.match(root().innerHTML, /internet connection/);
});

test('the finale: finishing is set while it fades (3 s) and cleared by reset', async () => {
  const el = () => ({ append() {}, appendChild(node) { return node; }, setAttribute() {}, getContext: () => ({}), classList: { toggle() {} } });
  const gameSource = fs.readFileSync(__dirname + '/../djGame.js', 'utf8').replace(/\r\n/g, '\n').replace(/^import .*$/mg, '').replace(/^export /mg, '').replace('  return {\n    update,', '  return {\n    finishSet,\n    update,');
  const box = { console, performance, requestAnimationFrame() {}, document: { createElement: el, getElementById: () => ({}) } };
  vm.createContext(box);
  vm.runInContext(gameSource + '\nglobalThis.createDjGame = createDjGame;', box);
  let fadeMs = null, finish;
  const queue = { holdControls() {}, endSet: (ms) => { fadeMs = ms; return new Promise((resolve) => { finish = resolve; }); } };
  const ended = [];
  const game = box.createDjGame(queue, { stage: el(), camera: {}, rail: el(), deck: {}, onSetEnd: (r) => ended.push(r) });
  assert.equal(game.finishing, false);
  game.finishSet();
  assert.equal(game.finishing, true);
  assert.equal(fadeMs, 3000);
  finish(true);
  await flush();
  assert.equal(ended.length, 1);
  game.reset();
  assert.equal(game.finishing, false);
});

(async () => {
  for (const [name, fn] of check) {
    await fn();
    console.log(`PASS: ${name}`);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
