// AirMix's start screens: a saved set is cleaned (no repeats, known songs only, at most 5, and Play
// needs 2 distinct songs); a set with nothing judged shows no grade; hiding the tab during the first
// 3-2-1 goes back to the pick screen and the set doesn't start.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const flush = () => new Promise((resolve) => setImmediate(resolve));

let wall = 0, id = 0;
const timers = new Map();
const later = (fn, ms) => { timers.set(++id, { fn, at: wall + ms }); return id; };
function advance(ms) {
  const until = wall + ms;
  for (;;) {
    const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    timers.delete(due[0]); wall = due[1].at; due[1].fn();
  }
  wall = until;
}
const elapse = async (ms) => { for (let i = 0; i < ms / 50; i++) { advance(50); await flush(); } };

// A small DOM: each element keeps one child per selector, and innerHTML is a plain string.
function element() {
  const children = {};
  return {
    isConnected: true, innerHTML: '', textContent: '', disabled: false, dataset: {},
    classList: { toggle() {} }, append() {}, setAttribute() {}, addEventListener() {},
    remove() { this.isConnected = false; },
    querySelector(selector) { return (children[selector] ??= element()); },
    querySelectorAll() { return []; },
  };
}
const songs = Array.from({ length: 7 }, (_, i) => ({ id: `s${i + 1}`, title: `Title ${i + 1}`, artist: 'Artist', bpm: 90, genre: 'pop', available: true }));
const source = fs.readFileSync(__dirname + '/../djStart.js', 'utf8').replace(/^export /mg, '');

function startScreen({ saved = null, hidden = false, begin = () => {} } = {}) {
  let stageRoot = null, libraryCalls = 0;
  const box = {
    console, performance: { now: () => wall }, setTimeout: later, clearTimeout: (key) => timers.delete(key),
    setInterval: () => 0, clearInterval() {}, requestAnimationFrame: (fn) => later(fn, 16),
    localStorage: { getItem: () => saved, setItem() {} },
    document: { hidden, head: element(), createElement: element, getElementById: () => null },
  };
  vm.createContext(box);
  vm.runInContext(source, box);
  const stage = { append(node) { stageRoot = node; } };
  const screens = vm.runInContext('createStartScreen', box)(stage, {
    library: async () => { libraryCalls++; return songs; },
    startCamera: async () => true, handSeen: () => false,
    prepare() {}, begin,
  });
  return { box, screens, root: () => stageRoot, libraryCalls: () => libraryCalls };
}

const check = [];
const test = (name, fn) => check.push([name, fn]);

test('a saved set keeps distinct known songs, at most five, in their order', async () => {
  const { root } = startScreen({ saved: JSON.stringify(['s2', 's2', 'nope', 's1', 's3', 's4', 's5', 's6']) });
  await flush();
  const flow = root().querySelector('.djStart-flow').innerHTML;
  assert.equal((flow.match(/<span>Title \d<\/span>/g) || []).length, 5);
  assert.deepEqual([...flow.matchAll(/Title (\d)/g)].map((m) => m[1]), ['2', '1', '3', '4', '5']);
  assert.equal(root().querySelector('[data-play]').disabled, false);
});

test('one song (even saved twice) is not enough to Play', async () => {
  const { root } = startScreen({ saved: JSON.stringify(['s1', 's1', 42, null]) });
  await flush();
  assert.equal((root().querySelector('.djStart-flow').innerHTML.match(/<span>Title/g) || []).length, 1);
  assert.equal(root().querySelector('[data-play]').disabled, true);
});

test('two distinct saved songs can be played', async () => {
  const { root } = startScreen({ saved: JSON.stringify(['s1', 's3']) });
  await flush();
  assert.equal(root().querySelector('[data-play]').disabled, false);
});

test('results with nothing judged show a neutral grade and "No hits judged"', async () => {
  const { screens, root } = startScreen();
  await flush();
  screens.results({ score: 0, perfect: 0, good: 0, miss: 0, best: 0, accuracy: 0, judged: 0 });
  const html = root().innerHTML;
  assert.match(html, /grade-none">–</);
  assert.match(html, /No hits judged/);
  assert.match(html, /<dd>–<\/dd>/);
  assert.doesNotMatch(html, /grade-D/);
  screens.results({ score: 500, perfect: 2, good: 1, miss: 1, best: 2, accuracy: 0.5, judged: 4 });
  assert.match(root().innerHTML, /grade-C">C</);
  assert.doesNotMatch(root().innerHTML, /No hits judged/);
});

test('a finished set with no judged hits reaches the results as judged 0', async () => {
  const onEnd = [];
  const element2 = () => ({ append() {}, appendChild(node) { return node; }, setAttribute() {}, getContext: () => ({}), classList: { toggle() {} } });
  const gameSource = fs.readFileSync(__dirname + '/../djGame.js', 'utf8').replace(/\r\n/g, '\n').replace(/^import .*$/mg, '').replace(/^export /mg, '').replace('  return {\n    update,', '  return {\n    finishSet,\n    update,');
  const box = { console, performance, requestAnimationFrame() {}, document: { createElement: element2, getElementById: () => ({}) } };
  vm.createContext(box);
  vm.runInContext(gameSource + '\nglobalThis.createDjGame = createDjGame;', box);
  const queue = { holdControls() {}, endSet: async () => true };
  const game = box.createDjGame(queue, { stage: element2(), camera: {}, rail: element2(), deck: {}, onSetEnd: (results) => onEnd.push(results) });
  game.finishSet();
  await flush();
  assert.equal(onEnd.length, 1);
  assert.equal(onEnd[0].judged, 0);
  assert.equal(onEnd[0].accuracy, 0);
});

test('hiding the tab during the first 3-2-1 returns to the pick screen; the set does not start', async () => {
  let began = 0;
  const { screens, box, root, libraryCalls } = startScreen({ begin: () => began++ });
  await flush();
  const before = libraryCalls();
  screens.replay();
  await elapse(10);
  box.document.hidden = true;
  await elapse(5000);
  assert.equal(began, 0, 'nothing starts while hidden');
  assert.ok(libraryCalls() > before, 'back on the pick screen');
  assert.match(root().innerHTML, /djStart-songs/);
});

test('a 3-2-1 with the tab visible still starts the set', async () => {
  let began = 0;
  const { screens } = startScreen({ begin: () => began++ });
  await flush();
  screens.replay();
  await elapse(4000);
  assert.equal(began, 1);
});

(async () => {
  for (const [name, fn] of check) {
    await fn();
    console.log(`PASS: ${name}`);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
