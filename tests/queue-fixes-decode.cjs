// Run: node tests/queue-fixes-decode.cjs. A superseded decode that fails late must not
// delete the newer decode of the same song or mark the song as failed (item 3).
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const code = fs.readFileSync(path.join(__dirname, '..', 'queue.js'), 'utf8').replace(/^import .*$/mg, '').replace(/^export /mg, '');
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };

(async () => {
  let failFirstB;
  const firstB = new Promise((resolve, reject) => failFirstB = () => reject(new Error('stale decode failed')));
  let bDecodes = 0;
  const started = [];
  const deck = {playing: false, buffer: null, offset: 0, setVolume() {}, setFrequency() {}, ensureContext() {}, stopSource() {this.playing = false;}, play() {this.playing = true; started.push(this.buffer.label);}, toggle() {this.playing = !this.playing;}, position: () => 0};
  const box = {console, Date, Math, performance, Promise, setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {},
    createTransitions: () => ({prepare() {}, cancel() {}}),
    // B's first decode is slow and fails late; its later decodes succeed.
    OfflineAudioContext: class {decodeAudioData(label) {
      if (label === 'B' && ++bDecodes === 1) return firstB;
      return Promise.resolve({duration: 10, label});
    }},
    fetch: async () => ({ok: true, json: async () => ({songs: []})})};
  vm.createContext(box);
  vm.runInContext(code + '\nglobalThis.createQueue = createQueue;', box);
  const queue = box.createQueue(deck);
  const add = label => queue.addFile({name: label + '.wav', arrayBuffer: async () => label});
  const idOf = index => queue.getState().items[index].id;

  add('A'); add('B'); add('C'); add('D'); add('E');
  await queue.play(idOf(0)); await settle(); // B starts decoding as the song after A (its first, slow decode)
  assert.equal(bDecodes, 1, 'B is being decoded in the background');

  await queue.play(idOf(3)); await settle(); // D: the window moves on, so B's decode is dropped from the cache
  await queue.play(idOf(1)); await settle(); // B again: a new decode, which succeeds
  assert.deepEqual(started.at(-1), 'B', 'B plays from its new decode');
  assert.equal(bDecodes, 2, 'the second decode of B is a separate request');

  failFirstB(); await settle(); // the old decode finally fails
  assert.equal(queue.loadFailed(idOf(1)), false, 'a superseded failure does not mark B as failed');
  assert.equal(queue.isReady(idOf(1)), true, 'the newer decode of B is still kept ready');
  console.log('PASS: a late failure of a superseded decode leaves the newer decode and the song intact');
})().catch(error => {console.error(error); process.exitCode = 1;});
