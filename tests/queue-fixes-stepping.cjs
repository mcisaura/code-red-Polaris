// Run: node tests/queue-fixes-stepping.cjs. Next/previous step from the last requested song:
// a broken first song doesn't block the queue (item 1), and two quick presses advance two songs (item 2).
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const code = fs.readFileSync(path.join(__dirname, '..', 'queue.js'), 'utf8').replace(/^import .*$/mg, '').replace(/^export /mg, '');
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };

function makeQueue(decodeAudioData) {
  const started = [];
  const deck = {playing: false, buffer: null, offset: 0, setVolume() {}, setFrequency() {}, ensureContext() {}, stopSource() {this.playing = false;}, play() {this.playing = true; started.push(this.buffer.label);}, toggle() {this.playing = !this.playing;}, position: () => 0};
  const box = {console, Date, Math, performance, Promise, setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {},
    createTransitions: () => ({prepare() {}, cancel() {}}),
    OfflineAudioContext: class {decodeAudioData(label) {return decodeAudioData(label);}},
    fetch: async () => ({ok: true, json: async () => ({songs: []})})};
  vm.createContext(box);
  vm.runInContext(code + '\nglobalThis.createQueue = createQueue;', box);
  const queue = box.createQueue(deck);
  const add = label => queue.addFile({name: label + '.wav', arrayBuffer: async () => label});
  const titleOf = id => queue.getState().items.find(item => item.id === id)?.title ?? null;
  const currentTitle = () => titleOf(queue.getState().currentId);
  return {queue, deck, started, add, currentTitle};
}

async function brokenFirstSong() {
  const ok = label => Promise.resolve({duration: 10, label});
  const {queue, started, add, currentTitle} = makeQueue(label => (label === 'A' ? Promise.reject(new Error('A is broken')) : ok(label)));
  // The first song added autoplays, so it's the one that fails (queued before it settles).
  add('A'); add('B'); add('C'); await settle();
  assert.equal(queue.getState().currentId, null, 'the broken song never plays');
  assert(queue.getState().status?.isError, 'the failure is reported');
  assert(queue.loadFailed(queue.getState().items[0].id), 'the broken song is marked failed');

  queue.next(); await settle(); // ⏭ moves past it, to B
  assert.equal(currentTitle(), 'B', 'next moves past the failed song');
  queue.next(); await settle();
  assert.equal(currentTitle(), 'C', 'the next press keeps walking the queue');
  queue.previous(); await settle(); // position is 0 (under 3 s), so ⏮ goes back one song
  assert.equal(currentTitle(), 'B', 'previous goes back from the last song asked for');
  assert.deepEqual(started, ['B', 'C', 'B']);
  console.log('PASS: next steps past a song that failed to load, and previous goes back from there');
}

async function nothingPlayingStartsFirst() {
  // X fails on its first try (the autoplay) and loads on the next.
  let tries = 0;
  const {queue, started, add, currentTitle} = makeQueue(label => (++tries === 1 ? Promise.reject(new Error('flaky')) : Promise.resolve({duration: 10, label})));
  add('X'); add('Y'); await settle();
  assert.equal(queue.getState().currentId, null, 'nothing is playing after the first try fails');
  queue.togglePlay(); await settle();
  assert.equal(currentTitle(), 'X', 'togglePlay with nothing playing starts the first song');
  assert.deepEqual(started, ['X']);
  console.log('PASS: togglePlay with nothing playing still starts the first song');
}

async function quickNextAdvancesTwice() {
  let releaseB;
  const slowB = new Promise(resolve => releaseB = () => resolve({duration: 10, label: 'B'}));
  const {queue, started, add, currentTitle} = makeQueue(label => (label === 'B' ? slowB : Promise.resolve({duration: 10, label})));
  add('A'); await queue.play(queue.getState().items[0].id); await settle();
  add('B'); add('C');
  queue.next(); await settle(); // B is still decoding
  queue.next(); await settle(); // a second press moves on to C, not B again
  releaseB(); await settle();
  assert.equal(currentTitle(), 'C', 'two quick next presses advance two songs');
  assert.deepEqual(started, ['A', 'C'], 'the superseded B never starts');
  console.log('PASS: two next presses during a pending load advance two songs');
}

(async () => {
  await brokenFirstSong();
  await nothingPlayingStartsFirst();
  await quickNextAdvancesTwice();
})().catch(error => {console.error(error); process.exitCode = 1;});
