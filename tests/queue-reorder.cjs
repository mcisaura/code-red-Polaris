// Run: node tests/queue-reorder.cjs. The queue panel's reorder math (pointer drag and Alt+arrow).
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const code = fs.readFileSync(path.join(__dirname, '..', 'queue.js'), 'utf8')
  .replace(/^import .*$/mg, '').replace(/^export /mg, '');
const box = {console, Date, Math, performance, Promise, setTimeout, clearTimeout, setInterval(){}, clearInterval(){},
  createTransitions: () => ({prepare(){}, cancel(){}}),
  fetch: async () => ({ok: false, json: async () => ({})})};
vm.createContext(box);
vm.runInContext(code + '\nglobalThis.api={dropIndexAt,moveTarget,createQueue};', box);
const {dropIndexAt, moveTarget, createQueue} = box.api;

// Rows 40px tall with 4px gaps: middles at 20, 64, 108.
const mids = [20, 64, 108];
assert.equal(dropIndexAt(mids, -50), 0);
assert.equal(dropIndexAt(mids, 19), 0);
assert.equal(dropIndexAt(mids, 21), 1);
assert.equal(dropIndexAt(mids, 70), 2);
assert.equal(dropIndexAt(mids, 109), 3, 'below the last row is the end');
assert.equal(dropIndexAt([], 10), 0);

assert.equal(moveTarget(2, 0), 0, 'third row to the top');
assert.equal(moveTarget(0, 3), 2, 'first row to the end');

// Dropping row `from` at every insertion point gives the array splice result, through the real queue.move.
(async () => {
  const songs = Array.from({length: 5}, (_, i) => ({id: 's' + i, title: 'T' + i, artist: 'A'}));
  const deck = {playing: false, buffer: null, setVolume(){}, setFrequency(){}, ensureContext(){}, stopSource(){}, position(){return 0}};
  box.fetch = async (url, options = {}) => url === 'library.json' ? {ok: true, json: async () => ({songs})} : {ok: false, json: async () => ({})};
  for (const length of [1, 2, 3, 5]) {
    for (let from = 0; from < length; from++) {
      for (let drop = 0; drop <= length; drop++) {
        const queue = createQueue(deck);
        await queue.playSet(songs.slice(0, length).map((song) => song.id));
        const ids = Array.from(queue.getState().items, (item) => item.id);
        const expected = ids.slice();
        const [moved] = expected.splice(from, 1);
        expected.splice(drop > from ? drop - 1 : drop, 0, moved);
        queue.move(ids[from], moveTarget(from, drop));
        assert.deepEqual(Array.from(queue.getState().items, (item) => item.id), expected, `${length} rows, ${from} -> ${drop}`);
        if (drop === from || drop === from + 1) assert.deepEqual(Array.from(queue.getState().items, (item) => item.id), ids, 'dropping in place changes nothing');
      }
    }
  }
  console.log('queue-reorder: ok');
})().catch((error) => { console.error(error); process.exit(1); });
