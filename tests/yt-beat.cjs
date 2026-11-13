// Run: node tests/yt-beat.cjs. Beat-aware AI DJ crossfades between hosted embed songs: with `beat` on both songs the
// fade begins on an outgoing beat (rate adjusted) and the incoming video starts at its first beat and is placed so its
// beats land on that one; without it (or for hand blends) nothing changes.
const assert = require('assert');
const {setup, HOSTED} = require('./yt-stub.cjs');
setTimeout(() => { console.error('timed out'); process.exit(1); }, 30000).unref();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const near = (actual, expected, message) => assert(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} vs ${expected}`);
const A = 'AAAAAAAAAAA', B = 'BBBBBBBBBBB', C = 'CCCCCCCCCCC';
const song = (id, extra = {}) => ({id, artist: 'X', title: 'Song ' + id[0], bpm: 120, genre: 'pop', ...extra});

async function twoSongs(songs, {rate = 1} = {}) {
  const t = setup({songs, config: HOSTED});
  await t.queue.libraryReady();
  t.deck.rate = rate;
  await t.queue.addFromLibrary(songs[0].id);
  await t.queue.addFromLibrary(songs[1].id);
  await t.settle();
  assert.strictEqual(t.queue.isEmbedActive(), true);
  return t;
}

(async () => {
  // The plan itself (queue.js's embedBeatPlan).
  {
    const t = setup({config: HOSTED});
    const plan = t.box.embedBeatPlan;
    let p = plan({bpm: 120, first: 0.25}, {bpm: 120, first: 1}, 1, 1, 10.1);
    near(p.waitSeconds, 0.65, 'the beat at 10.25 is only 0.15 s away, too close: the next one (10.75)');
    near(p.seek, 1.35, 'the incoming video sits 0.65 s before its second beat (2.0)');
    p = plan({bpm: 120, first: 0.25}, {bpm: 120, first: 1}, 1.25, 1.25, 10.1);
    near(p.waitSeconds, 0.65 / 1.25, 'a faster outgoing video reaches its beat sooner (real time)');
    near(p.seek, 1 + Math.ceil(0.52 * 1.25 / 0.5) * 0.5 - 0.52 * 1.25, 'and the incoming one moves at its own rate');
    p = plan({bpm: 100, first: 3}, {bpm: 100, first: 0.5}, 1, 1, 0);
    near(p.waitSeconds, 3, 'before its first beat the outgoing song waits for it');
    near(p.seek, 0.5 + 5 * 0.6 - 3, 'the incoming start is never before its first beat');
    assert(p.seek >= 0.5 - 1e-9);
  }

  // With beats: load at beat.first, seek onto the grid, the fade begins on the beat.
  {
    const t = await twoSongs([song(A, {beat: {bpm: 120, first: 0.25, duration: 200}}), song(B, {beat: {bpm: 120, first: 1, duration: 180}})]);
    t.embed.time = 10.1;
    t.queue.mixNow();
    await t.settle();
    assert.deepStrictEqual(Array.from(t.embed.second.loads), [B]);
    assert.strictEqual(t.embed.second.loadOptions[0].start, 1, 'the incoming video starts at its first beat');
    assert.strictEqual(t.embed.second.loadOptions[0].volume, 0);
    const seek = t.embed.second.log.find((entry) => entry.startsWith('seek '));
    assert(seek, 'the incoming video is placed on the grid');
    near(Number(seek.slice(5)), 1.35, 'so its beats meet the outgoing next beat');
    await sleep(450);
    near(t.embed.second.volume, 0, 'the fade has not begun before the beat');
    near(t.embed.volume, 0.8, 'the outgoing song is still full');
    await sleep(750);
    assert(t.embed.second.volume > 0, 'the fade started (on the beat, 0.65 s in)');
  }

  // The outgoing rate moves the beat in real time.
  {
    const t = await twoSongs([song(A, {beat: {bpm: 120, first: 0.25, duration: 200}}), song(B, {beat: {bpm: 120, first: 1, duration: 180}})], {rate: 1.25});
    t.embed.time = 10.1;
    t.queue.mixNow();
    await t.settle();
    assert.strictEqual(t.embed.second.loadOptions[0].start, 1);
    assert.strictEqual(t.embed.second.loadOptions[0].rate, 1.25, 'the existing speed rule still applies');
  }

  // Without beat info on either side: the old behaviour (no start, no seek, the fade begins at once).
  for (const songs of [[song(A), song(B)], [song(A, {beat: {bpm: 120, first: 0.25, duration: 200}}), song(B)], [song(A), song(B, {beat: {bpm: 120, first: 1, duration: 180}})]]) {
    const t = await twoSongs(songs);
    t.embed.time = 10.1;
    t.queue.mixNow();
    await t.settle();
    assert.deepStrictEqual(Array.from(t.embed.second.loads), [B]);
    assert(!('start' in t.embed.second.loadOptions[0]), 'no start position');
    assert(!t.embed.second.log.some((entry) => entry.startsWith('seek')), 'no seek');
    await sleep(300);
    assert(t.embed.second.volume > 0 || t.embed.volume < 0.8, 'the fade is running');
  }

  // A manual hand blend is not aligned, beats or not.
  {
    const t = await twoSongs([song(A, {beat: {bpm: 120, first: 0.25, duration: 200}}), song(B, {beat: {bpm: 120, first: 1, duration: 180}})]);
    t.embed.time = 10.1;
    const controls = await t.queue.startHandMix();
    assert(controls);
    assert(!('start' in t.embed.second.loadOptions[0]) && !t.embed.second.log.some((entry) => entry.startsWith('seek')), 'hand blends stay un-aligned');
  }

  // The AI DJ's trigger: beat.duration stands in for getDuration() === 0, and the lead leaves room for one beat.
  {
    const songs = [song(A, {beat: {bpm: 120, first: 0.25, duration: 100}}), song(B, {beat: {bpm: 120, first: 1, duration: 180}}), song(C)];
    const t = await twoSongs(songs);
    t.embed.duration = 0; // YouTube has not reported it
    t.queue.startDj('');
    await t.settle();
    t.embed.time = 50;
    t.intervals.forEach((tick) => tick());
    await t.settle();
    assert.strictEqual(t.embed.second.loads.length, 0, 'plenty of the song left: no mix yet');
    t.embed.time = 100 - 4 - 1 - 0.5 + 0.2; // inside fade (4 s) + lead (1 s) + one beat (0.5 s)
    t.intervals.forEach((tick) => tick());
    await t.settle();
    assert.deepStrictEqual(Array.from(t.embed.second.loads), [B], 'the crossfade is triggered from beat.duration');
  }
  console.log('yt-beat: all checks passed');
})().catch((error) => { console.error(error); process.exit(1); });
