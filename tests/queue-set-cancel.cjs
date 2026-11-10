// Run: node tests/queue-set-cancel.cjs. Leaving an AirMix set before it starts (queue.cancelSet):
// pending downloads stop polling, their results are ignored, nothing fails or shows an error, and
// a new set right after works.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const code = fs.readFileSync(path.join(__dirname, '..', 'queue.js'), 'utf8')
  .replace(/^import .*$/mg, '').replace(/^export /mg, '');
function setup() {
  const youtube = []; // pending POST /api/youtube calls: { id, resolve, reject }
  const intervals = new Map(); let nextInterval = 1;
  const progress = [];
  const songs = [{id:'a', title:'A', artist:'X', bpm:96}, {id:'b', title:'B', artist:'X', bpm:93}];
  const deck = {playing:false, buffer:null, offset:0, setVolume(){}, setFrequency(){},
    ensureContext(){}, stopSource(){this.playing=false}, position(){return 0}};
  const box = {console, Date, Math, performance, Promise, setTimeout, clearTimeout,
    setInterval(fn){const id = nextInterval++; intervals.set(id, fn); return id;},
    clearInterval(id){intervals.delete(id);},
    createTransitions:()=>({prepare(){}, cancel(){}}),
    OfflineAudioContext:class {async decodeAudioData(){return {duration:10};}},
    fetch:async(url, options={})=>{
      if(url==='library.json')return {ok:true, json:async()=>({songs})};
      if(options.method==='HEAD')return {ok:false};
      if(url==='/api/youtube') {
        const id = new URL(JSON.parse(options.body).url).searchParams.get('v');
        return new Promise((resolve, reject) => youtube.push({id,
          resolve:()=>resolve({ok:true,json:async()=>({file:`downloads/${id}.m4a`})}),
          reject}));
      }
      if(url.startsWith('/api/progress')) { progress.push(url); return {ok:true, json:async()=>({stage:'downloading', percent:40})}; }
      return {ok:true, arrayBuffer:async()=>new ArrayBuffer(8)};
    }};
  vm.createContext(box); vm.runInContext(code+'\nglobalThis.createQueue=createQueue;', box);
  return {queue:box.createQueue(deck), youtube, intervals, progress};
}
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
(async()=>{
  // 1. New set while the first song downloads.
  {
    const {queue, youtube, intervals} = setup();
    await queue.playSet(['a', 'b']);
    const base = intervals.size;
    const ready = queue.readyToStart();
    const settled = ready.then(() => 'ok', (error) => error);
    await tick(20);
    assert.equal(youtube.length, 1, 'the first song is downloading');
    assert.equal(queue.getState().downloads.length, 1);
    assert.equal(intervals.size, base + 1, 'progress is being polled');
    assert.equal(queue.cancelSet(), true);
    assert.equal(intervals.size, base, 'polling stopped');
    assert.equal(queue.getState().downloads.length, 0, 'the download row is gone');
    const error = await settled;
    assert(error && error.cancelled, 'the wait for the set ends as cancelled, not as a failure');
    youtube[0].resolve(); // the server finishes anyway
    await tick(20);
    const state = queue.getState();
    assert.equal(state.items.length, 0, 'the cancelled set is gone');
    assert.equal(state.status, null);
    assert.equal(state.downloads.length, 0);
    assert.equal(state.dj.on, false);
    assert.equal(state.currentId, null);
    assert.equal(queue.cancelSet(), false, 'nothing left to cancel');
  }
  // 2. The download fails after the cancel: still no error anywhere.
  {
    const {queue, youtube} = setup();
    await queue.playSet(['a', 'b']);
    const settled = queue.readyToStart().then(() => 'ok', (error) => error);
    await tick(20);
    queue.cancelSet();
    youtube[0].reject(new Error('network down'));
    const error = await settled;
    assert(error.cancelled);
    await tick(20);
    assert.equal(queue.getState().downloads.length, 0, 'no failed row either');
    assert.equal(queue.getState().status, null);
  }
  // 3. A new set right after a cancel works, and the old download finishing late changes nothing.
  {
    const {queue, youtube} = setup();
    await queue.playSet(['a', 'b']);
    const first = queue.readyToStart().then(() => 'ok', (error) => error);
    await tick(20);
    queue.cancelSet();
    await queue.playSet(['b', 'a']);
    const second = queue.readyToStart();
    await tick(20);
    assert.deepEqual(youtube.map((call) => call.id), ['a', 'b'], 'the new set downloads its own first song');
    youtube[0].resolve(); // the old one finishing late
    await tick(20);
    assert.equal(queue.getState().downloads.length, 1, 'only the new set is downloading');
    youtube[1].resolve();
    await second;
    const state = queue.getState();
    assert.deepEqual(Array.from(state.items, (item) => item.libraryId), ['b', 'a']);
    assert(queue.isReady(state.items[0].id));
    assert.equal(queue.loadFailed(state.items[0].id), false);
    assert((await first).cancelled);
    assert.equal(state.status, null);
  }
  // 4. Cancelling while playSet still waits for the library, and a set replaced by a newer one.
  {
    const {queue, youtube} = setup();
    const playing = queue.playSet(['a']);
    queue.cancelSet();
    await playing;
    assert.equal(queue.getState().items.length, 0, 'a cancelled playSet never fills the queue');
    await queue.playSet(['a']);
    const stale = queue.readyToStart().then(() => 'ok', (error) => error);
    await tick(20);
    await queue.playSet(['b']); // replaces the first set without a cancelSet
    assert((await stale).cancelled);
    const rows = queue.getState().downloads;
    assert.deepEqual(Array.from(rows, (row) => row.title), ['X - B'], 'only the new set\'s download row is left');
    assert.deepEqual(youtube.map((call) => call.id), ['a', 'b']);
  }
  console.log('queue-set-cancel: ok');
})().catch((error) => { console.error(error); process.exit(1); });
