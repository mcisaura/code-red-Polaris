// Run: node tests/yt-start.cjs. Hosted autoplay: playback that starts without a click (a hand gesture, the AI DJ)
// asks for the "Start music" button (state.needsStart); its click (queue.startMusic) loads/starts the current video and
// primes the SECOND player; after that the button never returns, unless a video fails to start (~3 s after play()).
const assert = require('assert');
const {stubEmbed, setup, SONGS, HOSTED} = require('./yt-stub.cjs');
setTimeout(() => { console.error('timed out'); process.exit(1); }, 30000).unref();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  // Without a click: the button is wanted, whatever the page does next.
  {
    const activation = {isActive: false, hasBeenActive: true};
    const t = setup({songs: SONGS, config: HOSTED, navigator: {userActivation: activation}});
    await t.queue.libraryReady();
    assert.strictEqual(t.queue.getState().needsStart, false, 'nothing wants to start yet');
    await t.queue.addAllFromLibrary(); // what a gesture or the AI DJ does: the first song wants to play
    await t.settle();
    assert.strictEqual(t.queue.getState().needsStart, true, 'playback began without a click: show "Start music"');
    assert.strictEqual(t.embed.second.primes.length, 0, 'the second player is not primed behind the browser\'s back');
    // The click: both players are unlocked inside the handler (it runs synchronously).
    t.embed.playing = false; // the browser blocked the first video
    activation.isActive = true;
    const before = t.embed.log.length;
    assert.strictEqual(t.queue.startMusic(), true);
    assert.strictEqual(t.queue.getState().needsStart, false, 'the button goes away at once');
    assert(t.embed.loads.length >= 2 || t.embed.log.slice(before).includes('play'), 'the current video is loaded or started inside the click');
    assert.deepStrictEqual(Array.from(t.embed.second.primes), [SONGS[1].id], 'the second player is primed (muted, with the next video)');
    await t.settle();
    assert.strictEqual(t.embed.isPlaying(), true, 'and music plays');
    // It never shows again once unlocked, whatever follows.
    activation.isActive = false;
    t.queue.next();
    await t.settle();
    t.queue.next();
    await t.settle();
    assert.strictEqual(t.queue.getState().needsStart, false, 'unlocked: never again');
  }

  // A click that plays a song unlocks both players by itself (the ▶ button): no Start button.
  {
    const t = setup({songs: SONGS, config: HOSTED, navigator: {userActivation: {isActive: true}}});
    await t.queue.libraryReady();
    await t.queue.addFromLibrary(SONGS[0].id);
    await t.settle();
    assert.strictEqual(t.queue.getState().needsStart, false);
    assert.strictEqual(t.embed.loads[0], SONGS[0].id);
  }

  // A video that does not start ~3 s after play() brings the button back, even once unlocked.
  {
    const activation = {isActive: true};
    const embed = stubEmbed();
    const load = embed.load;
    embed.load = async (id, options) => { await load(id, options); embed.playing = false; embed.time = 0; }; // blocked: stays unstarted
    const t = setup({embed, songs: SONGS, config: HOSTED, navigator: {userActivation: activation}});
    await t.queue.libraryReady();
    await t.queue.addFromLibrary(SONGS[0].id);
    await t.settle();
    assert.strictEqual(t.queue.getState().needsStart, false, 'right after the click there is no button yet');
    await sleep(2500);
    assert.strictEqual(t.queue.getState().needsStart, false, 'not before about 3 s');
    await sleep(900);
    assert.strictEqual(t.queue.getState().needsStart, true, 'unstarted after ~3 s: the button returns');
    embed.load = load;
    t.queue.startMusic();
    await t.settle();
    assert.strictEqual(t.queue.getState().needsStart, false);
    assert.strictEqual(embed.isPlaying(), true);
  }

  // A video that started by itself needs no button.
  {
    const t = setup({songs: SONGS, config: HOSTED, navigator: {userActivation: {isActive: false}}});
    await t.queue.libraryReady();
    await t.queue.addFromLibrary(SONGS[0].id);
    await t.settle();
    assert.strictEqual(t.queue.getState().needsStart, true);
    await sleep(3200);
    assert.strictEqual(t.queue.getState().needsStart, false, 'it plays: the button goes');
  }

  // Not hosted, or a browser that cannot tell: never a button.
  {
    const t = setup({songs: SONGS, config: {youtube: true, youtubeEmbed: false, hosted: false}, navigator: {userActivation: {isActive: false}}});
    t.queue.addYouTubeEmbed('https://youtu.be/AAAAAAAAAAA');
    await t.settle();
    assert.strictEqual(t.queue.getState().needsStart, false);
    const u = setup({songs: SONGS, config: HOSTED});
    await u.queue.libraryReady();
    await u.queue.addFromLibrary(SONGS[0].id);
    await u.settle();
    assert.strictEqual(u.queue.getState().needsStart, false, 'no userActivation API: no gating');
  }
  console.log('yt-start: all checks passed');
})().catch((error) => { console.error(error); process.exit(1); });
