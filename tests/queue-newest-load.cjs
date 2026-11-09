// Run: node tests/queue-newest-load.cjs. A superseded slow load must not hold up the newest play
// request, and when it finishes late it must not take over; "Add all" is instant and lazy.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const code = fs.readFileSync(path.join(__dirname, '..', 'queue.js'), 'utf8').replace(/^import .*$/mg, '').replace(/^export /mg, '');
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };

function make(decodeAudioData, fetchImpl) {
  const started = [];
  const deck = {playing: false, buffer: null, offset: 0, setVolume() {}, setFrequency() {}, ensureContext() {}, stopSource() {this.playing = false;}, play() {this.playing = true; started.push(this.buffer.label);}, toggle() {this.playing = !this.playing;}, position: () => 0};
  const box = {console, Date, Math, performance, Promise, setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {},
    createTransitions: () => ({prepare() {}, cancel() {}}),
    OfflineAudioContext: class {decodeAudioData(label) {return decodeAudioData(label);}},
    fetch: fetchImpl || (async () => ({ok: true, json: async () => ({songs: []})}))};
  vm.createContext(box);
  vm.runInContext(code + '\nglobalThis.createQueue = createQueue;', box);
  const queue = box.createQueue(deck);
  const add = label => queue.addFile({name: label + '.wav', arrayBuffer: async () => label});
  return {queue, deck, started, add};
}

async function newestWins() {
  let releaseB;
  const slowB = new Promise(resolve => releaseB = () => resolve({duration: 10, label: 'B'}));
  const {queue, started, add} = make(label => (label === 'B' ? slowB : Promise.resolve({duration: 10, label})));
  add('A'); await settle();
  add('B'); add('C');
  const [, b, c] = queue.getState().items.map(item => item.id);
  queue.next(); await settle(); // B: its decode stays pending
  queue.next(); await settle(); // C is wanted now
  assert.deepEqual(started, ['A', 'C'], 'C starts while B is still decoding');
  assert.equal(queue.getState().currentId, c);
  assert.notEqual(queue.getState().loadingId, b, 'B is no longer shown as loading');
  releaseB(); await settle();
  assert.deepEqual(started, ['A', 'C'], 'a late B never starts');
  assert.equal(queue.getState().currentId, c, 'a late B does not take over');
  assert(queue.isReady(b), 'the late decode still warms the cache');
  queue.next(); await settle(); // stepping continues from C (wraps to A)
  assert.deepEqual(started, ['A', 'C', 'A']);
  console.log('PASS: the newest request starts while a stale one is pending; the stale one cannot take over');
}

async function throwingListener() {
  const {queue, started, add} = make(label => Promise.resolve({duration: 10, label}));
  add('A'); add('B'); await settle();
  let boom = true;
  queue.on(() => { if (boom) throw new Error('listener'); });
  await queue.play(queue.getState().items[1].id).catch(() => {});
  boom = false;
  await settle();
  await queue.play(queue.getState().items[0].id);
  assert.equal(started.at(-1), 'A', 'a throwing listener does not wedge later plays');
  console.log('PASS: a throwing listener cannot block later play requests');
}

async function addAllIsLazy() {
  const songs = Array.from({length: 4}, (_, i) => ({id: 'song' + i, title: 'Song ' + i, artist: 'Artist', bpm: 100, available: i < 2, file: 'music/s' + i + '.m4a'}));
  let downloads = 0;
  const fetchImpl = async (url, options = {}) => {
    if (url === 'library.json') return {ok: true, json: async () => ({songs})};
    if (options.method === 'HEAD') return {ok: /song[01]\.m4a/.test(url)};
    if (url === '/api/youtube') { downloads++; return new Promise(() => {}); } // never finishes
    return {ok: true, arrayBuffer: async () => new ArrayBuffer(8)};
  };
  const {queue, deck} = make(() => Promise.resolve({duration: 10, label: 'x'}), fetchImpl);
  await Promise.race([queue.addAllFromLibrary(), settle().then(() => { throw new Error('Add all waited for a download'); })]);
  const {items} = queue.getState();
  const urls = items.map(item => item.url);
  assert.equal(items.length, 4, 'every song is queued without waiting for downloads');
  assert(urls[0] && urls[1], 'cached songs keep their file url');
  assert(!urls[2] && items[2].defaultLibrary && !urls[3], 'uncached songs are lazy (url: null)');
  await settle();
  assert(downloads <= 2, 'only nearby songs download, not the whole library (got ' + downloads + ')');
  assert.equal(queue.getState().currentId, items[0].id, 'the first song still autoplays');
  assert(deck.playing);
  console.log('PASS: Add all queues every song immediately and lazily');
}

(async () => { await newestWins(); await throwingListener(); await addAllIsLazy(); })().catch(error => {console.error(error); process.exitCode = 1;});
