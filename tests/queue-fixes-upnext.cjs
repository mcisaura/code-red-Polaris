// Run: node tests/queue-fixes-upnext.cjs. Removing the song coming in during a mix must not
// leave Up next showing it as mixing, or the playing song as the next one (item 4).
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const code = fs.readFileSync(path.join(__dirname, '..', 'queue.js'), 'utf8').replace(/^import .*$/mg, '').replace(/^export /mg, '');
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };

(async () => {
  const deck = {playing: false, buffer: null, offset: 0, setVolume() {}, setFrequency() {}, ensureContext() {}, stopSource() {this.playing = false;}, play() {this.playing = true;}, toggle() {this.playing = !this.playing;}, position: () => 0};
  const transitions = {
    prepare() {}, cancel() {}, holdSpeed() {}, resetSpeed() {},
    entryPoint: () => 0, mixPoint: () => 9e9, mixOutPoint: () => 5, mixStartPoint: () => 0, beatSeconds: () => 0.5,
    nextDownbeat: () => 0, styleInto: () => 'blend', beatGridAt: () => null, energyAt: () => 1,
    // The mix never finishes here: the incoming song stays "mixing in" until it is removed.
    mixInto: () => new Promise(() => {}),
  };
  const box = {console, Date, Math, performance, Promise, setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {},
    createTransitions: () => transitions,
    OfflineAudioContext: class {decodeAudioData(label) {return Promise.resolve({duration: 10, label});}},
    fetch: async () => ({ok: true, json: async () => ({songs: []})})};
  vm.createContext(box);
  vm.runInContext(code + '\nglobalThis.createQueue = createQueue;', box);
  const queue = box.createQueue(deck);
  const add = label => queue.addFile({name: label + '.wav', arrayBuffer: async () => label});
  add('A'); add('B'); add('C');
  await queue.play(queue.getState().items[0].id); await settle();

  queue.mixNow(); await settle(); // B comes in over A
  let next = queue.getUpNext();
  assert.equal(next.item.title, 'B');
  assert.equal(next.mixing, true, 'while B comes in, Up next says mixing');

  const bId = queue.getState().items[1].id;
  queue.remove(bId); await settle(); // B is taken off the queue mid-mix
  next = queue.getUpNext();
  assert.equal(next.mixing, false, 'with the incoming song removed, Up next is not mixing');
  assert.equal(next.item.title, 'C', 'Up next is the song queued after the one removed, not the playing one');
  console.log('PASS: removing the incoming song mid-mix does not label the playing song as mixing');
})().catch(error => {console.error(error); process.exitCode = 1;});
