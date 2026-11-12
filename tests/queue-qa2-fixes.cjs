// Run: node tests/queue-qa2-fixes.cjs
// (1) the DJ interval skips a failed next song instead of retrying it every tick;
// (2) adding a song after removing the playing one doesn't cut the music;
// (3) /dj/pick's `queued` lists only the current and upcoming songs;
// (5) non-finite seek and hand volume are ignored.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const code = fs.readFileSync(path.join(__dirname, '..', 'queue.js'), 'utf8').replace(/^import .*$/mg, '').replace(/^export /mg, '');
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(resolve => setImmediate(resolve)); };

function make({decode, transitions, fetchImpl}) {
  const started = [], intervals = [], volumes = [];
  const deck = {playing: false, buffer: null, offset: 0, rate: 1, setVolume(v) {volumes.push(v);}, setFrequency() {}, ensureContext() {}, stopSource() {this.playing = false;},
    play() {this.playing = true; started.push(this.buffer.label);}, pause() {this.playing = false;}, toggle() {this.playing = !this.playing;}, position: () => 100};
  const box = {console, Date, Math, performance: {now: () => 1e6}, Promise, window: {}, setInterval(f, ms) {intervals.push({f, ms}); return intervals.length;}, clearInterval() {}, setTimeout() {}, clearTimeout() {},
    createTransitions: () => transitions || {prepare() {}, cancel() {}},
    OfflineAudioContext: class {decodeAudioData(label) {return decode(label);}},
    fetch: fetchImpl || (async () => ({ok: true, json: async () => ({songs: []})}))};
  vm.createContext(box);
  vm.runInContext(code + '\nglobalThis.createQueue = createQueue;', box);
  const queue = box.createQueue(deck);
  return {queue, deck, started, intervals, volumes, add: l => queue.addFile({name: l + '.wav', arrayBuffer: async () => l})};
}
const ok = label => Promise.resolve({duration: 200, label});

(async () => {
  { // (2)
    const {queue, started, add} = make({decode: ok});
    add('A'); await settle(); add('B'); await settle();
    queue.remove(queue.getState().items[0].id); await settle();
    add('C'); await settle();
    assert.deepEqual(started, ['A'], 'adding C must not cut the still-playing song');
    console.log('PASS: add after removing the playing song keeps it playing');
  }
  { // (1) + (3)
    let decodes = 0, mixes = [], picks = [];
    const transitions = {prepare() {}, cancel() {}, mixPoint: () => 50, mixOutPoint: () => 60, entryPoint: () => 0, mixInto: async () => { mixes.push(1); return null; }};
    const fetchImpl = async (url, opts) => {
      if (String(url).includes('dj/pick')) { picks.push(JSON.parse(opts.body)); return {ok: true, status: 200, json: async () => ({picks: []})}; }
      return {ok: true, json: async () => ({songs: [{id: 'x', artist: 'a', title: 't', bpm: 100}]})};
    };
    const {queue, started, add, intervals} = make({transitions, fetchImpl, decode: l => { if (l === 'BAD') decodes++; return l === 'BAD' ? Promise.reject(new Error('EncodingError')) : ok(l); }});
    add('P'); await settle(); add('A'); add('BAD'); add('GOOD'); await settle();
    await queue.play(queue.getState().items[1].id); await settle(); // P was already played
    queue.startDj('x'); await settle();
    const tick = intervals.find(i => i.ms === 200).f;
    const base = decodes;
    for (let i = 0; i < 10; i++) { tick(); await settle(); }
    // BAD fails once (one decode), after that the DJ moves on to GOOD and doesn't retry BAD.
    const badTries = decodes - base;
    assert(badTries <= 3, `a failed song is not retried every tick (decodes: ${badTries})`);
    assert(queue.loadFailed(queue.getState().items[2].id), 'BAD marked failed');
    // (3) queued excludes the already played song A
    assert(picks.length, 'the DJ asked for picks');
    assert(!picks.at(-1).queued.includes('P'), 'queued has only current and upcoming');
    assert(picks.at(-1).queued.includes('A'), 'the current song is included');
    assert(picks.at(-1).queued.includes('GOOD') || picks.at(-1).queued.includes('BAD'));
    console.log('PASS: DJ skips failed songs; queued excludes played songs');
  }
  { // (1b) only failed songs ahead: no retries at all
    let decodes = 0;
    const transitions = {prepare() {}, cancel() {}, mixPoint: () => 50, mixOutPoint: () => 60, entryPoint: () => 0, mixInto: async () => null};
    const {queue, add, intervals} = make({transitions, decode: l => { if (l === 'BAD') decodes++; return l === 'BAD' ? Promise.reject(new Error('x')) : ok(l); }});
    add('A'); await settle(); add('BAD'); await settle();
    queue.startDj('x'); await settle();
    const tick = intervals.find(i => i.ms === 200).f;
    for (let i = 0; i < 3; i++) { tick(); await settle(); }
    const base = decodes;
    for (let i = 0; i < 20; i++) { tick(); await settle(); }
    assert.equal(decodes, base, 'no further decodes of the failed song');
    console.log('PASS: no retry loop when the only next song failed');
  }
  { // (5)
    const {queue, deck, add, volumes, started} = make({decode: ok});
    add('A'); await settle();
    deck.offset = 7; queue.seek(NaN); assert.equal(deck.offset, 7, 'NaN seek ignored');
    deck.setVolume(0.5); deck.setVolume(NaN);
    assert(volumes.every(Number.isFinite), 'NaN volume never reaches the deck');
    console.log('PASS: non-finite seek/volume ignored');
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
