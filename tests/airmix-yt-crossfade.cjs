// Hosted AirMix with two players (ytDeck.js + ytEmbed.js's `second` / `swap`): the beat grid from library.json's
// `beat` (with a fallback), both players primed inside the Play click, the next song preloaded and cued at its
// first beat, a mix that crossfades with no quiet gap, and the cut when the second player is missing or fails.
// Run: node tests/airmix-yt-crossfade.cjs. Uses a stub pair of players with the same interface as ytEmbed.js.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const source = fs.readFileSync(__dirname + '/../ytDeck.js', 'utf8').replace(/^export /mg, '');
const box = { console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, performance, Promise, Math, Number, Array, Map, Set, Error, Object };
vm.createContext(box);
const api = vm.runInContext(source + '\n({ createYtSession, beatGrid })', box);
const flush = () => new Promise((resolve) => setImmediate(resolve));

// A fake world: a clock in ms, and two player slots that start 300 ms after a load.
function world({ failSecond = [], reportDuration = true, withSecond = true, duration = 200 } = {}) {
  let t = 1000;
  const log = [];
  const slots = [0, 1].map((index) => ({ index, video: null, playing: false, time: 0, startAt: null, errorAt: null, volume: null, shown: false }));
  let current = 0;
  const listeners = { main: { error: [], ended: [] }, second: { error: [], ended: [] } };
  const w = { log, slots, now: () => t, swaps: 0, samples: [] };
  const step = (dt) => {
    t += dt;
    for (const slot of slots) {
      if (slot.startAt !== null && t >= slot.startAt) { slot.playing = true; slot.startAt = null; }
      else if (slot.playing) slot.time += dt / 1000;
      if (slot.errorAt !== null && t >= slot.errorAt) {
        slot.errorAt = null; slot.playing = false;
        listeners[slot.index === current ? 'main' : 'second'].error.forEach((fn) => fn('the video\'s owner doesn\'t allow it to play in other sites', 101));
      }
    }
    w.samples.push({ t, audible: slots.some((slot) => slot.video && slot.playing && slot.volume > 0), playing: slots.filter((slot) => slot.playing).length });
  };
  w.advance = (ms) => { for (let left = ms; left > 0; left -= 50) step(Math.min(50, left)); };
  const face = (pick, role) => ({
    async load(id, options = {}) {
      const slot = pick();
      log.push([slot.index, 'load', id, options.volume]);
      slot.video = id; slot.shown = true; slot.playing = false; slot.time = 0; slot.volume = Number.isFinite(options.volume) ? options.volume * 100 : slot.volume;
      if (role === 'second' && failSecond.includes(id)) slot.errorAt = t + 100; else slot.startAt = t + 300;
    },
    play() { const slot = pick(); log.push([slot.index, 'play']); if (slot.video) { slot.playing = true; slot.startAt = null; } },
    pause() { const slot = pick(); log.push([slot.index, 'pause']); slot.playing = false; slot.startAt = null; },
    stop() { const slot = pick(); log.push([slot.index, 'stop']); slot.playing = false; slot.video = null; slot.startAt = null; slot.shown = false; },
    seekTo(seconds) { const slot = pick(); log.push([slot.index, 'seek', seconds]); slot.time = seconds; },
    setVolume(volume) { const slot = pick(); if (slot.video) slot.volume = volume * 100; },
    setRate() {},
    getTime: () => Math.floor(pick().time * 4) / 4,
    getDuration: () => (pick().video && reportDuration ? duration : 0),
    isPlaying: () => pick().playing,
    onEnded(fn) { listeners[role].ended.push(fn); },
    onError(fn) { listeners[role].error.push(fn); },
  });
  w.embed = face(() => slots[current], 'main');
  w.embed.destroy = () => {};
  if (withSecond) {
    w.embed.second = face(() => slots[1 - current], 'second');
    w.embed.swap = () => { current = 1 - current; w.swaps += 1; log.push(['swap']); };
  }
  w.current = () => slots[current];
  return w;
}

const library = [
  { id: 'aaaaaaaaaaa', artist: 'A', title: 'One', bpm: 120, genre: 'pop', beat: { bpm: 119.7, first: 0.52, duration: 180 } },
  { id: 'bbbbbbbbbbb', artist: 'B', title: 'Two', bpm: 96, genre: 'pop', beat: { bpm: 95.8, first: 1.25, duration: 150 } },
  { id: 'ccccccccccc', artist: 'C', title: 'Three', bpm: 128, genre: 'pop' }, // no beat: the synthesised grid
  { id: 'ddddddddddd', artist: 'D', title: 'Four', bpm: 100, genre: 'pop', beat: { bpm: 0, first: 2 } }, // unusable beat: ignored
];

function session(options = {}, { gone = [], networkError = [] } = {}) {
  const w = world(options);
  const fetchFn = async (url) => {
    if (url === 'library.json') return { ok: true, status: 200, json: async () => ({ songs: library }) };
    const id = new URL(url, 'http://x').searchParams.get('id');
    if (networkError.includes(id)) throw new Error('offline');
    return { ok: !gone.includes(id), status: gone.includes(id) ? 404 : 200, json: async () => ({ title: 't' }) };
  };
  const s = api.createYtSession({
    embed: w.embed, fetchFn, now: w.now, sleep: async (ms) => { w.advance(ms); },
    timers: { setInterval: () => 1, clearInterval() {} },
    deckOptions: { makeContext: () => ({ suspend() { return Promise.resolve(); }, resume() { return Promise.resolve(); } }) },
  });
  return { ...s, w };
}
const run = async (w, queue, ms, pollEvery = 100) => { for (let left = ms; left > 0; left -= pollEvery) { w.advance(pollEvery); queue.poll(); await flush(); } };

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the grid comes from library.json\'s beat (bpm and first); without a usable beat it is the integer bpm from 0:00', async () => {
  assert.deepEqual({ ...api.beatGrid({ bpm: 120, beat: { bpm: 119.7, first: 0.52 } }) }, { bpm: 119.7, first: 0.52 });
  assert.deepEqual({ ...api.beatGrid({ bpm: 120, beat: { bpm: 119.7 } }) }, { bpm: 119.7, first: 0 }, 'no first: the bars start at 0:00');
  assert.deepEqual({ ...api.beatGrid({ bpm: 128 }) }, { bpm: 128, first: 0 });
  assert.deepEqual({ ...api.beatGrid({ bpm: 100, beat: { bpm: 0, first: 2 } }) }, { bpm: 100, first: 0 }, 'an unusable beat is ignored');
  const { queue, w } = session();
  await queue.playSet(['aaaaaaaaaaa', 'ccccccccccc']);
  await queue.readyToStart();
  queue.beginSet();
  w.advance(1000);
  assert.deepEqual({ ...queue.beatGridAt(5) }, { bpm: 119.7, first: 0.52 });
  assert.equal(queue.hasEffects, false, 'the game is told there are no effects');
});

test('beat.duration stands in for the length (and mixOutAt) while the player reports 0', async () => {
  const { queue, w } = session({ reportDuration: false });
  await queue.playSet(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  await queue.readyToStart();
  queue.beginSet();
  w.advance(1500);
  assert.equal(queue.mixOutAt(), 172, '180 - 8');
  assert.equal(queue.getPlayback().duration, 180);
  const real = session({ duration: 200 });
  await real.queue.playSet(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  await real.queue.readyToStart();
  real.queue.beginSet();
  assert.equal(real.queue.mixOutAt(), 192, 'the player\'s own length wins when it has one');
});

test('both players are primed inside the Play click: the first song in the main one, the second song (muted) in the second', async () => {
  const { queue, w } = session();
  await queue.playSet(['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']);
  const ready = queue.readyToStart();
  await ready;
  await flush();
  const loads = w.log.filter((entry) => entry[1] === 'load');
  assert.deepEqual(loads.map((entry) => [entry[0], entry[2]]).sort(), [[0, 'aaaaaaaaaaa'], [1, 'bbbbbbbbbbb']]);
  assert.equal(loads.find((entry) => entry[2] === 'bbbbbbbbbbb')[3], 0, 'the second song loads muted');
  assert(w.log.some((entry) => entry[0] === 1 && entry[1] === 'seek' && entry[2] === 1.25), 'cued at its first beat');
  assert(w.log.some((entry) => entry[0] === 1 && entry[1] === 'pause'), 'then paused until the mix');
  assert.equal(w.slots[1].playing, false);
  assert.equal(queue.getState().currentId, null, 'the set has not begun');
});

test('a mix crossfades into the preloaded song with no quiet gap, then swaps; the next song preloads into the spare player', async () => {
  const { queue, w } = session();
  await queue.playSet(['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']);
  await queue.readyToStart();
  queue.beginSet();
  await run(w, queue, 3000);
  const loadsBefore = w.log.filter((entry) => entry[1] === 'load').length;
  const mark = w.log.length;
  const controls = await queue.startHandMix({ startAt: 20, style: 'cut' });
  assert.equal(controls.style, 'cut');
  assert.equal(controls.barSeconds, 240 / 119.7, 'a bar of the real grid');
  const startedAt = w.samples.length;
  for (let i = 0; i < 600 && !controls.done; i += 1) { w.advance(50); queue.poll(); await flush(); }
  assert.equal(controls.done, true);
  assert.equal(w.swaps, 1);
  assert.equal(w.log.filter((entry) => entry[1] === 'load' && entry[2] === 'bbbbbbbbbbb').length, 1, 'Two was loaded once (the preload), not again at the mix');
  const incoming = w.log.findIndex((entry) => entry[0] === 1 && entry[1] === 'play');
  assert(incoming > -1, 'the incoming player started');
  assert.deepEqual(w.log.slice(mark).filter((entry) => entry[1] === 'stop').map((entry) => entry[0]), [0], 'the old player stopped only after the crossfade, once');
  // No gap: from the moment the old song starts its fade until the swap, something is always audible.
  const during = w.samples.slice(startedAt).filter((sample) => sample.playing > 0);
  assert(during.every((sample) => sample.audible), 'never silent between the songs');
  assert(during.some((sample) => sample.playing === 2), 'both players sounded together during the crossfade');
  const playback = queue.getPlayback();
  assert.equal(playback.songId, queue.getState().items[1].id);
  assert(playback.position >= 1.25 && playback.position < 4, `the new song is near its first beat (${playback.position})`);
  assert.deepEqual({ ...queue.beatGridAt(0) }, { bpm: 95.8, first: 1.25 }, 'the grid follows the new song');
  assert.equal(w.current().video, 'bbbbbbbbbbb');
  assert.equal(w.current().volume, 80, 'at the hands\' volume');
  // The song after it is preloaded into the player that just stopped.
  await run(w, queue, 1500);
  assert(w.log.slice(loadsBefore).some((entry) => entry[0] === 0 && entry[1] === 'load' && entry[2] === 'ccccccccccc' && entry[3] === 0), 'Three loads (muted) in the spare player');
  assert.equal(queue.getUpNext().item.libraryId, 'ccccccccccc');
});

test('the incoming song starts at the cue (within the clock\'s coarse resolution)', async () => {
  const { queue, w } = session();
  await queue.playSet(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  await queue.readyToStart();
  queue.beginSet();
  await run(w, queue, 3000);
  const controls = await queue.startHandMix({ startAt: 20, style: 'cut' });
  let oldTimeAtPlay = null;
  for (let i = 0; i < 600 && !controls.done; i += 1) {
    const before = w.log.length;
    w.advance(50); queue.poll(); await flush();
    if (oldTimeAtPlay === null && w.log.slice(before).some((entry) => entry[0] === 1 && entry[1] === 'play')) oldTimeAtPlay = w.slots[0].time;
  }
  assert(oldTimeAtPlay !== null && oldTimeAtPlay > 19.5 && oldTimeAtPlay < 20.6, `the incoming player starts right at the cue (old song at ${oldTimeAtPlay})`);
});

test('mixNow with the next song preloaded also crossfades', async () => {
  const { queue, w } = session();
  await queue.playSet(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  await queue.readyToStart();
  queue.beginSet();
  await run(w, queue, 2000);
  assert.equal(queue.mixNow(), true);
  await run(w, queue, 3000);
  assert.equal(w.swaps, 1);
  assert.equal(queue.getState().items.find((item) => item.id === queue.getState().currentId).libraryId, 'bbbbbbbbbbb');
});

test('with no second player (an older stub) the mix is the cut: fade, load, play from 0:00', async () => {
  const { queue, w } = session({ withSecond: false });
  await queue.playSet(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  await queue.readyToStart();
  queue.beginSet();
  await run(w, queue, 2000);
  assert.equal(queue.mixNow(), true);
  await run(w, queue, 3000);
  assert.deepEqual(w.log.filter((entry) => entry[1] === 'load').map((entry) => entry[2]), ['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  assert.equal(w.swaps, 0);
  assert.equal(queue.getState().items.find((item) => item.id === queue.getState().currentId).libraryId, 'bbbbbbbbbbb');
  assert(queue.getPlayback().position < 5);
});

test('if the preloaded video fails in the second player, the mix falls back to a cut (and the next song is skipped if it fails too)', async () => {
  const { queue, w } = session({ failSecond: ['bbbbbbbbbbb'] });
  await queue.playSet(['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']);
  await queue.readyToStart();
  queue.beginSet();
  await run(w, queue, 2000);
  assert.equal(queue.mixNow(), true);
  await run(w, queue, 4000);
  assert.equal(w.swaps, 0, 'no swap: the main player loaded it itself');
  assert(w.log.some((entry) => entry[0] === 0 && entry[1] === 'load' && entry[2] === 'bbbbbbbbbbb'));
  assert.equal(queue.getState().items.find((item) => item.id === queue.getState().currentId).libraryId, 'bbbbbbbbbbb');
});

test('a set ending or a new set drops the preload: the spare player stops', async () => {
  const { queue, w } = session();
  await queue.playSet(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  await queue.readyToStart();
  queue.beginSet();
  await run(w, queue, 1500);
  assert(w.slots[1].video);
  assert.equal(await queue.endSet(400), true);
  assert.equal(w.slots[1].video, null);
  assert.equal(w.slots[0].video, null);
});

test('the preloaded song that is removed from the set is replaced by the new next song', async () => {
  const { queue, w } = session();
  await queue.playSet(['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']);
  await queue.readyToStart();
  queue.beginSet();
  await run(w, queue, 1500);
  queue.remove(queue.getState().items[1].id);
  await run(w, queue, 1500);
  assert.equal(w.slots[1].video, 'ccccccccccc');
});

test('isUnavailable: only a 404 says "gone"; a network error is not unavailable and is asked again; answers are cached', async () => {
  const asked = [];
  const w = world();
  const fetchFn = async (url) => {
    asked.push(url);
    const id = new URL(url, 'http://x').searchParams.get('id');
    if (id === 'ooooooooooo') throw new Error('offline');
    if (id === 'sssssssssss') return { ok: false, status: 500 };
    return { ok: id !== 'ggggggggggg', status: id === 'ggggggggggg' ? 404 : 200 };
  };
  const { queue } = api.createYtSession({ embed: w.embed, fetchFn, now: w.now });
  assert.equal(await queue.isUnavailable('ggggggggggg'), true);
  assert.equal(await queue.isUnavailable('ggggggggggg'), true);
  assert.equal(asked.length, 1, 'a definite answer is cached');
  assert.equal(await queue.isUnavailable('ooooooooooo'), false, 'offline is not "unavailable"');
  assert.equal(await queue.isUnavailable('sssssssssss'), false, 'a server error is not "unavailable"');
  assert.equal(await queue.isUnavailable('hhhhhhhhhhh'), false);
  await queue.isUnavailable('ooooooooooo');
  assert.equal(asked.filter((url) => url.includes('ooooooooooo')).length, 2, 'an unknown answer is not kept: it is asked again');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ok   ' + name); }
    catch (error) { console.error('FAIL ' + name); throw error; }
  }
  console.log(`PASS: ${tests.length} hosted AirMix two-player checks`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
