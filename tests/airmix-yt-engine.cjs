// AirMix on the hosted site (ytDeck.js): the game's queue/deck interface backed by one YouTube player.
// Synthesised beat grid, smoothed song time, first play primed inside the click, cuts between songs,
// and the failure paths (unavailable video, player error) that lead to the retry / new-set screens.
// Run: node tests/airmix-yt-engine.cjs. Uses a stub player with the same interface as ytEmbed.js.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const source = fs.readFileSync(__dirname + '/../ytDeck.js', 'utf8').replace(/^export /mg, '');
const box = { console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, performance, Promise, Math, Number, Array, Map, Set, Error, Object };
vm.createContext(box);
const api = vm.runInContext(source + '\n({ createClock, createYtDeck, createYtQueue, createYtSession, syntheticGrid, beatGrid, cleanBeat })', box);
const flush = () => new Promise((resolve) => setImmediate(resolve));

// A fake world: a clock in ms, and a player that starts 300 ms after a load and reports its time in 250 ms steps.
function world({ failIds = [], duration = 200 } = {}) {
  let t = 1000;
  const w = { calls: [], volumes: [], time: 0, playing: false, video: null, startAt: null, errorAt: null, errors: [], ended: [], duration, rate: 1 };
  const step = (dt) => {
    t += dt;
    if (w.startAt !== null && t >= w.startAt) { w.playing = true; w.time = 0; w.startAt = null; }
    else if (w.playing) w.time += dt / 1000;
    if (w.errorAt !== null && t >= w.errorAt) { w.errorAt = null; w.playing = false; w.errors.forEach((fn) => fn("the video's owner doesn't allow it to play in other sites", 101)); }
  };
  w.now = () => t;
  w.advance = (ms) => { for (let left = ms; left > 0; left -= 50) step(Math.min(50, left)); };
  w.embed = {
    async load(id) {
      w.calls.push(['load', id]);
      w.video = id; w.playing = false; w.time = 0;
      if (failIds.includes(id)) w.errorAt = t + 100; else w.startAt = t + 300;
    },
    play() { w.calls.push(['play']); if (w.video) w.playing = true; },
    pause() { w.calls.push(['pause']); w.playing = false; w.startAt = null; },
    stop() { w.calls.push(['stop']); w.playing = false; w.video = null; w.startAt = null; },
    seekTo(s) { w.calls.push(['seek', s]); w.time = s; },
    setVolume(v) { w.volumes.push(v); },
    setRate() {},
    getTime: () => Math.floor(w.time * 4) / 4,
    getDuration: () => (w.video ? w.duration : 0),
    isPlaying: () => w.playing,
    onEnded(fn) { w.ended.push(fn); },
    onError(fn) { w.errors.push(fn); },
    destroy() {},
  };
  return w;
}

const library = [
  { id: 'aaaaaaaaaaa', artist: 'A', title: 'One', bpm: 120, genre: 'pop' },
  { id: 'bbbbbbbbbbb', artist: 'B', title: 'Two', bpm: 96, genre: 'pop' },
  { id: 'ccccccccccc', artist: 'C', title: 'Three', bpm: 128, genre: 'pop' },
  { id: 'bad', artist: 'X', title: 'Not a video id', bpm: 100 },
];

function session({ gone = [], failIds = [], duration } = {}) {
  const w = world({ failIds, duration });
  const asked = [];
  const fetchFn = async (url) => {
    asked.push(url);
    if (url === 'library.json') return { ok: true, status: 200, json: async () => ({ songs: library }) };
    const id = new URL(url, 'http://x').searchParams.get('id');
    return { ok: !gone.includes(id), status: gone.includes(id) ? 404 : 200, json: async () => ({ title: 't' }) };
  };
  let ctxCalls = [];
  const s = api.createYtSession({
    embed: w.embed, fetchFn, now: w.now, sleep: async (ms) => { w.advance(ms); },
    timers: { setInterval: () => 1, clearInterval() {} },
    deckOptions: { makeContext: () => ({ suspend() { ctxCalls.push('suspend'); return Promise.resolve(); }, resume() { ctxCalls.push('resume'); return Promise.resolve(); } }) },
  });
  return { ...s, w, asked, ctxCalls };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the beat grid is synthesised from the library bpm: a beat every 60/bpm from 0:00; energy is constant', async () => {
  assert.deepEqual({ ...api.syntheticGrid(120) }, { bpm: 120, first: 0 });
  assert.equal(api.syntheticGrid(undefined).bpm, 100, 'a song with no bpm gets a default');
  const { queue, w } = session();
  await queue.playSet(['bbbbbbbbbbb', 'aaaaaaaaaaa']);
  await queue.readyToStart();
  queue.beginSet();
  w.advance(2000);
  assert.deepEqual({ ...queue.beatGridAt(37.2) }, { bpm: 96, first: 0 }, 'the playing song\'s bpm');
  assert.equal(queue.energyAt(10), 1);
  assert.equal(queue.energyAt(100), 1);
  assert.equal(queue.getChoices()[0].blends, false, 'one player: every mix is a cut');
  assert.equal(queue.getUpNext().style, 'cut');
  assert.equal(queue.mixOutAt(), 192, 'mix out shortly before the end');
});

test('the library drops ids that are not YouTube video ids', async () => {
  const { queue } = session();
  await queue.libraryReady();
  assert.deepEqual(queue.getState().library.map((song) => song.id), ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']);
});

test('song time is smoothed between the player\'s coarse updates and never goes backwards', () => {
  let now = 0, time = 0, playing = true;
  const embed = { getTime: () => time, isPlaying: () => playing };
  const clock = api.createClock(embed, () => now);
  const reads = [];
  for (let ms = 0; ms <= 3000; ms += 16) {
    now = ms;
    time = Math.floor(ms / 250) * 0.25; // YouTube: a new value every 250 ms
    reads.push(clock.read());
  }
  const steps = reads.slice(1).map((value, i) => value - reads[i]);
  assert(steps.every((step) => step >= 0), 'monotonic');
  assert(Math.max(...steps) < 0.05, `no stutter: the biggest frame step is ${Math.max(...steps).toFixed(3)} s (a raw read steps 0.25 s)`);
  assert(Math.abs(reads.at(-1) - 3) < 0.35, `it keeps up with the player (${reads.at(-1).toFixed(2)} vs 3)`);
  // A seek snaps to the new time.
  now += 16; time = 90;
  assert.equal(clock.read(), 90);
  // Paused: the raw time, not moving.
  playing = false; now += 500;
  assert.equal(clock.read(), 90);
  assert.equal(clock.moving, false);
  // Buffering: the time stops changing while "playing": not moving after a moment.
  playing = true; now += 16; time = 91; clock.read();
  assert.equal(clock.moving, true);
  now += 1000;
  clock.read();
  assert.equal(clock.moving, false, 'a stalled player is not "playing" for the game');
});

test('the first video loads (muted, then paused) in the Play click; beginSet only un-pauses it', async () => {
  const { queue, w, deck } = session();
  deck.ensureContext();
  await queue.playSet(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  await queue.readyToStart();
  assert.deepEqual(w.calls.filter((call) => call[0] === 'load'), [['load', 'aaaaaaaaaaa']], 'loaded during the click');
  assert.equal(w.volumes[0], 0, 'muted while priming');
  assert(w.calls.some((call) => call[0] === 'pause'), 'paused again until Go');
  assert.equal(w.playing, false);
  assert.equal(queue.getState().currentId, null, 'the set has not begun');
  const before = w.calls.length;
  queue.beginSet();
  assert.deepEqual(w.calls.slice(before).map((call) => call[0]), ['seek', 'play']);
  assert.equal(w.volumes.at(-1), 0.8, 'at the deck\'s normal volume');
  w.advance(700);
  const playback = queue.getPlayback();
  assert.equal(playback.playing, true);
  assert.equal(playback.songId, queue.getState().currentId);
  assert.equal(playback.duration, 200);
});

test('the game\'s Pause (suspending the audio context) pauses the video; resume plays it', async () => {
  const { queue, w, deck, ctxCalls } = session();
  deck.ensureContext();
  await queue.playSet(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  await queue.readyToStart();
  queue.beginSet();
  w.advance(800);
  await deck.ctx.suspend();
  assert.equal(w.playing, false);
  await deck.ctx.resume();
  assert.equal(w.playing, true);
  assert.deepEqual(ctxCalls, ['suspend', 'resume']);
});

test('hand volume and the quick fades both reach the player; speed and filter do nothing', async () => {
  const { queue, w, deck } = session();
  await queue.playSet(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  await queue.readyToStart();
  queue.beginSet();
  deck.setVolume(0.5);
  assert.equal(w.volumes.at(-1), 0.5);
  queue.holdControls({ speed: true, volume: true });
  deck.setVolume(0.1);
  assert.equal(w.volumes.at(-1), 0.5, 'held during a mix');
  queue.holdControls({});
  queue.resetSound();
  assert.equal(w.volumes.at(-1), 0.8);
  deck.setSpeed(1.5); deck.setFrequency(300);
  assert.equal(deck.rate, 1);
  assert.equal(deck.waveform(), null);
});

test('a mix is a cut: the old song fades, the next video loads and plays from 0:00, and the mix reports done', async () => {
  const { queue, w } = session();
  await queue.playSet(['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']);
  await queue.readyToStart();
  queue.beginSet();
  w.advance(10000);
  const first = queue.getState().currentId;
  const controls = await queue.startHandMix({ startAt: 20, style: 'cut' });
  assert.equal(controls.style, 'cut');
  assert(Math.abs(controls.startsIn - (20 - queue.getPlayback().position)) < 0.5, 'startsIn counts down to the cue');
  assert.equal(controls.barSeconds, 2, '4 beats at 120 bpm');
  assert.doesNotThrow(() => { controls.setIncoming(1); controls.echoOut(); controls.swapBass(); controls.setOutgoing(0.5); controls.thinOutgoing(0.5); });
  const loadsBefore = w.calls.filter((call) => call[0] === 'load').length;
  // Nothing happens before the cue minus the fade and the load time.
  w.advance(5000); queue.poll();
  assert.equal(w.calls.filter((call) => call[0] === 'load').length, loadsBefore);
  assert.equal(controls.done, false);
  for (let i = 0; i < 100 && !controls.done; i += 1) { w.advance(100); queue.poll(); await flush(); }
  assert.equal(controls.done, true);
  assert.deepEqual(w.calls.filter((call) => call[0] === 'load').map((call) => call[1]), ['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  assert(w.volumes.includes(0), 'the old song faded out');
  assert.equal(w.volumes.at(-1), 0.8, 'the new song plays at the hands\' volume');
  const playback = queue.getPlayback();
  assert.notEqual(playback.songId, first);
  assert(playback.position < 5, 'the next song starts from the beginning');
  assert.deepEqual({ ...queue.beatGridAt(0) }, { bpm: 96, first: 0 }, 'the grid follows the new song');
  assert.equal(queue.getUpNext().item.libraryId, 'ccccccccccc');
});

test('mixNow cuts at once; with no song left it does nothing', async () => {
  const { queue, w } = session();
  await queue.playSet(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  await queue.readyToStart();
  queue.beginSet();
  w.advance(1500);
  assert.equal(queue.mixNow(), true);
  for (let i = 0; i < 100; i += 1) { w.advance(100); await flush(); }
  assert.equal(queue.getState().items.find((item) => item.id === queue.getState().currentId).libraryId, 'bbbbbbbbbbb');
  assert.equal(queue.mixNow(), false);
});

test('unavailable video -> the first song fails to load with a reason (the retry / new-set screen), nothing hangs', async () => {
  const { queue, w } = session({ gone: ['aaaaaaaaaaa'] });
  await queue.playSet(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  await assert.rejects(queue.readyToStart(), /One: the video was removed, is private/);
  assert.equal(w.calls.filter((call) => call[0] === 'load').length, 0, 'the player was never asked for it');
});

test('a player error on the first song (embedding disabled) rejects readyToStart', async () => {
  const { queue } = session({ failIds: ['aaaaaaaaaaa'] });
  await queue.playSet(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  await assert.rejects(queue.readyToStart(), /owner doesn't allow/);
});

test('a later song that is removed or private drops out of the set before it is needed (the game sees loadFailed)', async () => {
  const { queue } = session({ gone: ['bbbbbbbbbbb'] });
  await queue.playSet(['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']);
  await queue.readyToStart();
  await flush(); await flush();
  queue.beginSet();
  const second = queue.getState().items[1];
  assert.equal(queue.loadFailed(second.id), true);
  assert.equal(queue.isReady(second.id), false);
  assert.equal(queue.getUpNext().item.libraryId, 'ccccccccccc', 'the failed song is skipped');
  queue.remove(second.id);
  assert.equal(queue.getState().items.length, 2);
});

test('a next video the player refuses is skipped; if none is left the failure listener fires (and the game is not left hanging)', async () => {
  const { queue, w } = session({ failIds: ['bbbbbbbbbbb', 'ccccccccccc'] });
  const messages = [];
  queue.onFailure((message) => messages.push(message));
  await queue.playSet(['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']);
  await queue.readyToStart();
  queue.beginSet();
  w.advance(1000);
  const controls = await queue.startHandMix({ startAt: 5 });
  for (let i = 0; i < 100 && !messages.length; i += 1) { w.advance(100); queue.poll(); await flush(); }
  assert.equal(messages.length, 1);
  assert.match(messages[0], /no more songs/i);
  assert.equal(controls.done, true, 'the mix is over, so the game is not waiting on it');
  assert.equal(queue.getState().status.isError, true);
  assert.deepEqual(queue.getState().items.map((item) => item.libraryId), ['aaaaaaaaaaa'], 'the unplayable songs left the set');
});

test('the playing song erroring with nothing after it reports a failure', async () => {
  const { queue, w } = session();
  const messages = [];
  queue.onFailure((message) => messages.push(message));
  await queue.playSet(['aaaaaaaaaaa']);
  await queue.readyToStart();
  queue.beginSet();
  w.advance(1000);
  w.errors.forEach((fn) => fn("the video was removed or is private", 100));
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Couldn't play One/);
});

test('if the browser blocks the first play, the song card says how to start it', async () => {
  const { queue, w } = session();
  await queue.playSet(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  await queue.readyToStart();
  w.embed.play = () => {}; // autoplay blocked: play() does nothing
  queue.beginSet();
  w.advance(4000);
  queue.poll();
  assert.match(queue.getState().status.message, /Press play in the YouTube card/);
});

test('endSet fades out, stops the player and resolves true; a newer set makes it resolve false', async () => {
  const { queue, w } = session();
  await queue.playSet(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  await queue.readyToStart();
  queue.beginSet();
  w.advance(1000);
  assert.equal(await queue.endSet(400), true);
  assert(w.calls.some((call) => call[0] === 'stop'));
  assert.equal(queue.getState().currentId, null);
  assert.equal(queue.getState().dj.on, false);
  const other = session();
  await other.queue.playSet(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  await other.queue.readyToStart();
  other.queue.beginSet();
  const ending = other.queue.endSet(400);
  await other.queue.playSet(['bbbbbbbbbbb', 'ccccccccccc']);
  assert.equal(await ending, false);
});

test('cancelSet (New set while loading) stops the player and a late readyToStart is cancelled', async () => {
  const { queue, w } = session();
  await queue.playSet(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  const ready = queue.readyToStart();
  assert.equal(queue.cancelSet(), true);
  await assert.rejects(ready, (error) => error.cancelled === true);
  assert(w.calls.some((call) => call[0] === 'stop'));
  assert.deepEqual(queue.getState().items, []);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ok   ' + name); }
    catch (error) { console.error('FAIL ' + name); throw error; }
  }
  console.log(`PASS: ${tests.length} hosted AirMix engine checks`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
