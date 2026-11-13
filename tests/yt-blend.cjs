// Run: node tests/yt-blend.cjs. Blends between two YouTube embed items (queue.js with the stub player pair):
// the hands' level blend (both players' volumes, swap on completion, cancel), the AI DJ's timed crossfade near the end
// of a video and the mix button, the incoming speed rule, errors mid-blend, and kinds that can't blend.
const assert = require('assert');
const {stubEmbed, setup} = require('./yt-stub.cjs');
setTimeout(() => { console.error('timed out'); process.exit(1); }, 30000).unref();
const A = 'AAAAAAAAAAA', B = 'BBBBBBBBBBB', C = 'CCCCCCCCCCC';
const link = (id) => `https://youtu.be/${id}`;
const near = (actual, expected, message) => assert(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} vs ${expected}`);

// Two embeds queued, the first playing (hand volume 0.8, the starting volume).
async function twoEmbeds(options = {}) {
  const t = setup(options);
  for (const id of options.videos ?? [A, B]) t.queue.addYouTubeEmbed(link(id));
  await t.settle();
  return t;
}

(async () => {
  // ---- manual hand blend: levels drive both players' volumes ----
  {
    const {queue, embed, ids, settle, deck} = await twoEmbeds({videos: [A, B, C]});
    assert.deepStrictEqual(Array.from(embed.loads), [A]);
    assert.strictEqual(queue.canHandBlend(queue.getState().items[1]), true, 'embed into embed can be hand blended');
    deck.setVolume(0.8);
    const controls = await queue.startHandMix();
    assert(controls, 'the hand mix starts');
    assert.deepStrictEqual(Array.from(embed.second.loads), [B], 'the incoming song loads in the second player');
    assert.strictEqual(embed.second.loadOptions[0].volume, 0, 'and starts silent');
    assert.strictEqual(embed.second.playing, true);
    assert.strictEqual(controls.done, false);
    assert.strictEqual(controls.startsIn, 0);
    queue.holdControls(true); // what index.html does: volume and speed stay put
    controls.setIncoming(0); controls.setOutgoing(1);
    near(embed.second.volume, 0, 'incoming silent'); near(embed.volume, 0.8, 'outgoing at the hand volume');
    controls.setIncoming(0.25); controls.setOutgoing(0.75);
    near(embed.second.volume, 0.8 * 0.25, 'incoming follows the level'); near(embed.volume, 0.8 * 0.75, 'outgoing follows the level');
    deck.setVolume(0.2); // the hands' volume is held while they mix
    near(embed.volume, 0.8 * 0.75, 'held volume ignores the hands');
    controls.setIncoming(0.5); controls.setOutgoing(0.5 * 0.5); // right hand sweeps the old song out faster
    near(embed.second.volume, 0.4, 'mid blend incoming'); near(embed.volume, 0.2, 'sweep outgoing');
    assert.strictEqual(queue.getState().currentId, ids()[1], 'the incoming song is the current one, as on the deck');
    assert.strictEqual(queue.getUpNext().mixing, true, 'a mix is in progress');
    assert.strictEqual(queue.getUpNext().item.id, ids()[1]);
    embed.second.time = 7;
    assert.strictEqual(queue.getPlayback().position, 7, 'the transport follows the incoming song');
    assert.strictEqual(queue.getPlayback().songId, ids()[1]);
    assert.strictEqual(queue.canHandBlend(queue.getState().items[2]), false, 'no second blend on top of a blend');
    assert.strictEqual(await queue.startHandMix(), null);
    controls.swapBass(); controls.thinOutgoing(1); // exist, and do nothing
    // Finishing: the incoming song ends up full, the outgoing one is stopped and the incoming player becomes current.
    controls.finish(0.05);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.strictEqual(controls.done, true);
    assert.strictEqual(embed.swaps, 1, 'the players swapped');
    assert.deepStrictEqual(Array.from(embed.loads), [B], 'the current player now plays B');
    assert.strictEqual(embed.playing, true);
    assert.strictEqual(embed.second.playing, false, 'the old player is stopped');
    assert(embed.second.stops >= 1);
    near(embed.volume, 0.8, 'the landed song plays at the (held) hand volume');
    queue.holdControls(false);
    deck.setVolume(0.6);
    near(embed.volume, 0.6, 'the hands control the landed song');
    assert.strictEqual(queue.getState().currentId, ids()[1]);
    assert.strictEqual(queue.getUpNext().mixing, false);
    assert.strictEqual(queue.getUpNext().item.id, ids()[2]);
    // And the next blend works the same way (the roles swapped, so the spare player is the incoming one).
    const again = await queue.startHandMix();
    assert(again && embed.second.loads.at(-1) === C);
    again.setIncoming(1); again.setOutgoing(0);
    again.finish(0);
    assert.strictEqual(again.done, true, 'finish(0) lands at once');
    assert.strictEqual(embed.swaps, 2);
    assert.strictEqual(embed.loads.at(-1), C);
  }

  // Cancelling: pick another song, pause or seek mid-blend lands it (the incoming song stays, as on the deck).
  {
    const {queue, embed, ids, settle} = await twoEmbeds({videos: [A, B, C]});
    const controls = await queue.startHandMix();
    controls.setIncoming(0.3); controls.setOutgoing(0.7);
    queue.seek(30);
    assert.strictEqual(controls.done, true);
    assert.strictEqual(embed.swaps, 1);
    assert(embed.log.includes('seek 30') && embed.loads.at(-1) === B, 'the seek goes to the incoming song, now current');
    const second = await queue.startHandMix();
    queue.togglePlay();
    assert.strictEqual(second.done, true);
    assert.strictEqual(embed.playing, false, 'paused');
    // Playing another song mid-blend replaces both players' roles cleanly.
    queue.togglePlay();
    const third = await queue.startHandMix().catch(() => null);
    queue.play(ids()[0]);
    await settle();
    assert.strictEqual(queue.getState().currentId, ids()[0]);
    assert.strictEqual(embed.second.playing, false);
    assert.strictEqual(embed.loads.at(-1), A);
    // Removing the incoming song mid-blend drops the blend; the outgoing one carries on.
    await queue.startHandMix();
    const incomingId = queue.getState().currentId;
    queue.remove(incomingId);
    assert.strictEqual(queue.getUpNext()?.mixing ?? false, false);
    assert.strictEqual(embed.playing, true);
    assert.strictEqual(embed.second.playing, false);
    assert.strictEqual(queue.getState().currentId, ids()[0]);
    near(embed.volume, 0.8, 'the outgoing song is back at full');
  }

  // ---- AI DJ: a timed crossfade near the end of the video ----
  {
    const clock = {t: 1e6};
    const t = setup({clock});
    for (const id of [A, B, C]) t.queue.addYouTubeEmbed(link(id));
    await t.settle();
    const {queue, embed, intervals, ids, settle} = t;
    queue.startDj('x');
    await settle();
    embed.time = 20; embed.duration = 200;
    intervals.forEach((fn) => fn());
    await settle();
    assert.deepStrictEqual(Array.from(embed.second.loads), [], 'not near the end: no crossfade yet');
    embed.time = 194; // 6 s left: more than the 4 s short crossfade plus its 1 s lead
    intervals.forEach((fn) => fn());
    await settle();
    assert.deepStrictEqual(Array.from(embed.second.loads), [], 'still too early');
    embed.time = 196; // 4 s left
    intervals.forEach((fn) => fn());
    await settle();
    assert.deepStrictEqual(Array.from(embed.second.loads), [B], 'the next song comes in under it in the second player');
    assert.strictEqual(queue.getState().currentId, ids()[1]);
    assert.strictEqual(queue.getUpNext().mixing, true);
    // The interval leaves a running crossfade alone.
    intervals.forEach((fn) => fn());
    await settle();
    assert.deepStrictEqual(Array.from(embed.second.loads), [B]);
    clock.t += 2000; // half of the 4 s fade
    await new Promise((resolve) => setTimeout(resolve, 150));
    near(embed.volume, 0.8 * 0.5, 'outgoing at half'); near(embed.second.volume, 0.8 * 0.5, 'incoming at half');
    clock.t += 2500;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.strictEqual(embed.swaps, 1, 'landed: the incoming player is current');
    assert.deepStrictEqual(Array.from(embed.loads), [B]);
    near(embed.volume, 0.8, 'at the hand volume');
    assert.strictEqual(queue.getUpNext().mixing, false);
    // Long mixes: 8 s.
    queue.setShortMixes(false);
    embed.time = 192; embed.duration = 200;
    intervals.forEach((fn) => fn());
    await settle();
    assert.deepStrictEqual(Array.from(embed.second.loads), [A, C], '8 s + 1 s lead before the end with long mixes (the spare player had played A)');
    clock.t += 4000;
    await new Promise((resolve) => setTimeout(resolve, 150));
    near(embed.volume, 0.4, 'half way through the long fade');
    clock.t += 4500;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.strictEqual(embed.swaps, 2);
    assert.strictEqual(embed.loads.at(-1), C);
    // The last item has nothing to mix into.
    embed.time = 199;
    intervals.forEach((fn) => fn());
    await settle();
    assert.strictEqual(embed.swaps, 2);
  }

  // The mix button (mixNow) crossfades two embeds right away; a second press lands it.
  {
    const clock = {t: 1e6};
    const {queue, embed, settle} = await twoEmbeds({clock});
    embed.time = 10;
    assert.strictEqual(queue.mixNow(), true);
    await settle();
    assert.deepStrictEqual(Array.from(embed.second.loads), [B], 'a crossfade, not a skip');
    assert.strictEqual(embed.swaps, 0);
    assert.strictEqual(queue.mixNow(), true);
    assert.strictEqual(embed.swaps, 1, 'pressing again lands the crossfade');
  }

  // Speed: matched to the outgoing tempo only within the deck's 8% nudge; otherwise unchanged.
  {
    const mk = async (bpmA, bpmB) => {
      const t = setup({clock: {t: 1e6}, songs: [{id: A, artist: 'a', title: 'A', bpm: bpmA, genre: 'x'}, {id: B, artist: 'b', title: 'B', bpm: bpmB, genre: 'x'}], config: {youtube: false, youtubeEmbed: true, hosted: true}});
      await t.queue.libraryReady();
      await t.queue.addFromLibrary(A); await t.queue.addFromLibrary(B, {autoplay: false});
      await t.settle();
      assert(await t.queue.startHandMix());
      return t.embed.second.loadOptions[0].rate;
    };
    near(await mk(100, 104), 100 / 104, 'close tempos: the incoming speed matches (the player rounds to a rate YouTube allows)');
    near(await mk(100, 130), 1, 'far apart: speed left at 1');
    near(await mk(80, 160), 1, 'double time counts as the same tempo, no change needed');
  }

  // ---- errors mid-blend ----
  {
    const {queue, embed, ids, settle} = await twoEmbeds({videos: [A, B, C]});
    const controls = await queue.startHandMix();
    controls.setIncoming(0.4); controls.setOutgoing(0.6);
    embed.second.fireError("the video was removed or is private", 100);
    await settle();
    const [, b] = queue.getState().items;
    assert(/removed or is private/.test(b.failed), 'the incoming item fails with the reason');
    assert(queue.loadFailed(b.id));
    assert.strictEqual(controls.done, true, 'the blend is over');
    assert.strictEqual(queue.getState().currentId, ids()[0], 'the first song is still the current one');
    assert.strictEqual(embed.playing, true, 'and keeps playing');
    assert.strictEqual(embed.swaps, 0);
    assert.strictEqual(embed.second.playing, false, 'the failed player is stopped');
    near(embed.volume, 0.8, 'the outgoing song is back at the hand volume');
    assert(queue.getState().status.isError && queue.getState().status.message.includes("can't be played"));
    assert.deepStrictEqual(Array.from(embed.loads), [A], 'nothing was retried');
    embed.fireEnded(); // the first song ends: on to the next that has not failed
    await settle();
    assert.strictEqual(queue.getState().currentId, ids()[2]);
    assert.deepStrictEqual(Array.from(embed.loads), [A, C]);
  }

  // The outgoing player failing mid-blend lets the incoming song carry on.
  {
    const {queue, embed, ids, settle} = await twoEmbeds({videos: [A, B]});
    const controls = await queue.startHandMix();
    controls.setIncoming(0.4); controls.setOutgoing(0.6);
    embed.fireError('x', 5);
    await settle();
    assert(queue.getState().items[0].failed);
    assert.strictEqual(controls.done, true);
    assert.strictEqual(embed.swaps, 1);
    assert.strictEqual(queue.getState().currentId, ids()[1]);
    assert.deepStrictEqual(Array.from(embed.loads), [B]);
    assert.strictEqual(embed.playing, true);
  }

  // A second player that can't load: the incoming item fails, the first song plays on.
  {
    const embed = stubEmbed();
    embed.second.load = async () => { throw new Error("YouTube's player couldn't be loaded"); };
    const {queue, ids, settle} = await twoEmbeds({embed});
    assert.strictEqual(await queue.startHandMix(), null);
    await settle();
    assert(queue.getState().items[1].failed);
    assert.strictEqual(queue.getState().currentId, ids()[0]);
    assert.strictEqual(embed.playing, true);
  }

  // ---- kinds that can't blend ----
  {
    // A single-player embed (no second player): a plain cut, as before.
    const single = stubEmbed({pair: false});
    const {queue, embed, ids, settle} = await twoEmbeds({embed: single});
    assert.strictEqual(queue.canHandBlend(queue.getState().items[1]), false);
    assert.strictEqual(await queue.startHandMix(), null);
    assert.strictEqual(queue.mixNow(), true);
    await settle();
    assert.strictEqual(queue.getState().currentId, ids()[1]);
    assert.deepStrictEqual(Array.from(embed.loads), [A, B]);
  }
  {
    // Embed and file: a plain cut either way, and the paused embed is not blended into.
    const {queue, embed, deck, addSong, ids, settle} = await twoEmbeds({videos: [A]});
    addSong('file');
    await settle();
    assert.strictEqual(queue.canHandBlend(queue.getState().items[1]), false);
    assert.strictEqual(await queue.startHandMix(), null);
    queue.mixNow();
    await settle();
    assert.strictEqual(queue.getState().currentId, ids()[1]);
    assert(deck.playing && embed.playing === false);
    queue.addYouTubeEmbed(link(B));
    assert.strictEqual(queue.canHandBlend(queue.getState().items[2]), false, 'a file into an embed is a cut');
    queue.next();
    await settle();
    assert.strictEqual(deck.playing, false);
    assert.strictEqual(queue.getState().currentId, ids()[2]);
  }

  console.log('PASS: embed blends: hand levels drive both players, swap on completion, cancel lands, AI DJ and mix button crossfade near the end, speed rule, errors mid-blend, mixed kinds cut');
})().catch((error) => { console.error(error); process.exitCode = 1; });
