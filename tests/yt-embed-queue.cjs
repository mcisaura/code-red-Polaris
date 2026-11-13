// Run: node tests/yt-embed-queue.cjs. YouTube embed items in the queue (hosted site): link parsing,
// playback through a stub player (deck stopped), ended -> next, transport routing, player errors
// (marked failed, moves on once, no retry loop), the AI DJ never mixing an embed, and ytEmbed.js itself
// with a stub of YouTube's IFrame API.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8').replace(/^import .*$/mg, '').replace(/^export /mg, '');
const ytSource = read('ytEmbed.js');

// ---- link parsing ----------------------------------------------------------------------
const parseBox = {URL, console};
vm.createContext(parseBox);
vm.runInContext(ytSource + '\nglobalThis.api = {parseYouTubeId, nearestRate, errorMessage};', parseBox);
const {parseYouTubeId, nearestRate, errorMessage} = parseBox.api;
const ID = 'dQw4w9WgXcQ';
for (const ok of [
  `https://www.youtube.com/watch?v=${ID}`, `http://youtube.com/watch?v=${ID}&t=42s`, `https://youtube.com/watch?feature=share&v=${ID}`,
  `https://m.youtube.com/watch?v=${ID}`, `https://music.youtube.com/watch?v=${ID}&list=abc`, `https://youtu.be/${ID}`, `https://youtu.be/${ID}?si=xyz`,
  `https://www.youtube.com/shorts/${ID}`, `https://www.youtube.com/embed/${ID}?start=3`, `  youtu.be/${ID}  `, `www.youtube.com/watch?v=${ID}`,
  'https://youtu.be/a-b_c-d_e-f', 'HTTPS://WWW.YOUTUBE.COM/watch?v=' + ID,
]) assert.strictEqual(parseYouTubeId(ok), ok.includes('a-b_c') ? 'a-b_c-d_e-f' : ID, 'accepts ' + ok);
for (const bad of [
  '', '   ', null, undefined, ID, 'hello world', 'https://example.com/watch?v=' + ID, `https://www.youtube.com.evil.com/watch?v=${ID}`,
  `https://evil.com/?u=https://youtu.be/${ID}`, `https://notyoutube.com/watch?v=${ID}`, `https://www.youtube.com/watch?v=${ID}x`,
  'https://www.youtube.com/watch?v=short', `https://www.youtube.com/watch?v=${ID.slice(0, 10)}!`, 'https://www.youtube.com/watch',
  `https://www.youtube.com/playlist?list=${ID}`, `https://www.youtube.com/channel/${ID}`, `https://www.youtube.com/shorts/${ID}/extra`,
  `https://youtu.be/${ID}/extra`, `https://youtu.be/${ID}x`, `javascript:alert(1)//youtu.be/${ID}`, `ftp://youtu.be/${ID}`,
  `https://user:pw@youtu.be/${ID}`, `https://youtu.be:8080/${ID}`, `https://www.youtube.com/watch?v=${ID}\nhttps://evil.example`, 'x'.repeat(400),
]) assert.strictEqual(parseYouTubeId(bad), null, 'rejects ' + JSON.stringify(bad));

assert.strictEqual(nearestRate(0.9), 1);
assert.strictEqual(nearestRate(1.1), 1);
assert.strictEqual(nearestRate(1.2), 1.25);
assert.strictEqual(nearestRate(0.8), 0.75);
assert.strictEqual(nearestRate(1.05, [1, 1.5]), 1);
assert.strictEqual(nearestRate(NaN), 1);
assert.match(errorMessage(150), /doesn't allow/);
assert.match(errorMessage(999), /couldn't play/);

// ---- the queue with a stub player (tests/yt-stub.cjs) ------------------------------------
const {stubEmbed, setup} = require('./yt-stub.cjs');

(async () => {
  const A = 'AAAAAAAAAAA', B = 'BBBBBBBBBBB', C = 'CCCCCCCCCCC';

  // Adding: a bad link is rejected with a message and adds nothing; no player means no embeds.
  {
    const {queue, embed} = setup();
    assert.strictEqual(queue.supportsEmbed, true);
    assert.strictEqual(queue.addYouTubeEmbed('https://example.com/x'), null);
    assert.strictEqual(queue.getState().items.length, 0);
    assert(queue.getState().status.isError && /YouTube link/.test(queue.getState().status.message));
    const entry = queue.addYouTubeEmbed(`https://youtu.be/${A}`);
    assert(entry.embed && entry.videoId === A && entry.title === 'YouTube video');
    await new Promise(setImmediate); await new Promise(setImmediate);
    assert.strictEqual(queue.getState().items[0].title, 'Real Title', 'the title arrives from /api/youtube/info');
    assert.strictEqual(embed.loads[0], A, 'the first item added plays right away');
    const none = setup({embed: null}).queue;
    assert.strictEqual(none.supportsEmbed, false);
    assert.strictEqual(none.addYouTubeEmbed(`https://youtu.be/${A}`), null);
  }

  // An embed plays through the stub and the deck is stopped; hand volume and speed follow.
  {
    const {queue, deck, embed, addSong, ids, settle} = setup();
    addSong('one');
    await settle();
    assert(deck.playing && queue.getState().currentId === ids()[0], 'a library/file song plays through the deck');
    deck.setVolume(0.4);
    queue.addYouTubeEmbed(`https://youtu.be/${A}`, {});
    const embedId = ids()[1];
    await queue.play(embedId);
    assert.strictEqual(deck.playing, false, 'the deck is stopped while an embed plays');
    assert.strictEqual(queue.getState().currentId, embedId);
    assert.deepStrictEqual(embed.loads, [A]);
    assert.strictEqual(embed.volume, 0.4, 'the hand volume carries over');
    deck.setVolume(0.7);
    assert.strictEqual(embed.volume, 0.7, 'hand volume maps to the player volume');
    deck.setSpeed(1.1);
    assert.strictEqual(embed.rate, 1.1, 'hand speed is forwarded (ytEmbed picks the nearest rate YouTube allows)');
    const playback = queue.getPlayback();
    assert(playback.loaded && playback.playing && playback.duration === 200 && playback.songId === embedId);
    embed.time = 42;
    assert.strictEqual(queue.getPlayback().position, 42);
    assert.strictEqual(queue.beatGridAt(1), null, 'no beat grid for an embed');
    assert.strictEqual(queue.mixOutAt(), null);
  }

  // Ended advances to the next item; a library song after it plays through the deck again; the
  // last item ending does nothing (no replay loop).
  {
    const {queue, deck, embed, addSong, ids, settle} = setup();
    queue.addYouTubeEmbed(`https://youtu.be/${A}`);
    addSong('after');
    queue.addYouTubeEmbed(`https://youtu.be/${B}`);
    await settle();
    assert.strictEqual(queue.getState().currentId, ids()[0]);
    embed.fireEnded();
    await settle();
    assert.strictEqual(queue.getState().currentId, ids()[1], 'moved on to the next item');
    assert(deck.playing, 'the deck plays the library song again');
    assert(embed.stops >= 1, 'the player was stopped for the cut');
    assert.strictEqual(queue.getPlayback().loaded, true);
    assert.strictEqual(queue.getPlayback().duration, 10, 'transport shows the deck again');
    await queue.play(ids()[2]);
    assert.deepStrictEqual(embed.loads, [A, B]);
    assert.strictEqual(deck.playing, false, 'plain cut from the deck to an embed');
    embed.fireEnded();
    await settle();
    assert.strictEqual(queue.getState().currentId, ids()[2], 'the last item ending stays put');
    assert.deepStrictEqual(embed.loads, [A, B]);
  }

  // Transport: pause/play, seek, previous (restart or back one) and next route to the player.
  {
    const {queue, embed, ids, settle} = setup();
    for (const id of [A, B, C]) queue.addYouTubeEmbed(`https://youtu.be/${id}`);
    await settle();
    assert.deepStrictEqual(embed.loads, [A]);
    queue.togglePlay();
    assert.strictEqual(embed.playing, false);
    assert.strictEqual(queue.getPlayback().playing, false);
    queue.togglePlay();
    assert.strictEqual(embed.playing, true);
    queue.seek(30);
    assert(embed.log.includes('seek 30'));
    embed.time = 40;
    queue.previous();
    assert(embed.log.includes('seek 0'), 'previous restarts a song that is past the first seconds');
    embed.time = 1;
    queue.next();
    await settle();
    assert.strictEqual(queue.getState().currentId, ids()[1]);
    assert.deepStrictEqual(embed.loads, [A, B]);
    embed.time = 1;
    queue.previous();
    await settle();
    assert.strictEqual(queue.getState().currentId, ids()[0], 'previous near the start goes back one');
    assert.deepStrictEqual(embed.loads, [A, B, A]);
    // Removing the current embed stops it.
    const stops = embed.stops;
    queue.remove(ids()[0]);
    assert(embed.stops > stops && queue.getState().currentId === null);
    assert.strictEqual(queue.getPlayback().loaded, false);
  }

  // A player error (embedding off, error 101/150) marks the item failed and moves on, once.
  {
    const {queue, embed, deck, addSong, ids, settle} = setup();
    queue.addYouTubeEmbed(`https://youtu.be/${A}`);
    queue.addYouTubeEmbed(`https://youtu.be/${B}`);
    addSong('last');
    await settle();
    embed.fireError();
    await settle();
    const [first] = queue.getState().items;
    assert(/doesn't allow/.test(first.failed), 'the item says why');
    assert(queue.loadFailed(first.id));
    assert.strictEqual(queue.getState().currentId, ids()[1], 'moved on to the next item');
    assert.deepStrictEqual(embed.loads, [A, B]);
    embed.fireError('x', 5); // the second video fails too: it moves on once more, to the file
    embed.fireError('x', 5); // a repeat for the same failure is ignored
    await settle();
    assert.strictEqual(queue.getState().currentId, ids()[2]);
    assert(deck.playing);
    assert.deepStrictEqual(embed.loads, [A, B], 'nothing was retried');
  }

  // A lone failing video stays marked, with the reason in the status line.
  {
    const {queue, embed, settle} = setup();
    queue.addYouTubeEmbed(`https://youtu.be/${A}`);
    await settle();
    embed.fireError();
    await settle();
    assert(queue.getState().status.isError && queue.getState().status.message.includes("can't be played"));
    assert.strictEqual(queue.getState().currentId, null);
    assert.deepStrictEqual(embed.loads, [A]);
  }

  // The player script failing to load: failed, on to the next item, never a retry loop.
  {
    const {queue, embed, deck, addSong, ids, settle} = setup({embed: stubEmbed({failLoad: true})});
    queue.addYouTubeEmbed(`https://youtu.be/${A}`);
    queue.addYouTubeEmbed(`https://youtu.be/${B}`);
    addSong('tail');
    await settle();
    assert.deepStrictEqual(embed.loads, [A, B], 'each item tried once');
    const items = queue.getState().items;
    assert(items[0].failed && items[1].failed && !items[2].failed);
    assert.strictEqual(queue.getState().currentId, ids()[2]);
    assert(deck.playing, 'the file after the failed items plays');
    assert.strictEqual(queue.getPlayback().duration, 10);
  }

  // AI DJ: into an embed from a file there is no mix (a plain cut at the mix point); a file into a file mixes (control).
  {
    const withFile = setup();
    withFile.addSong('now'); withFile.addSong('then');
    await withFile.settle();
    withFile.queue.startDj('x');
    await withFile.settle();
    withFile.intervals.forEach((fn) => fn());
    await withFile.settle();
    assert.deepStrictEqual(withFile.mixes, ['then'], 'control: the interval mixes into the next file');

    const {queue, deck, embed, intervals, mixes, addSong, ids, settle} = setup();
    addSong('now');
    queue.addYouTubeEmbed(`https://youtu.be/${A}`);
    addSong('after');
    await settle();
    queue.startDj('x');
    await settle();
    intervals.forEach((fn) => fn());
    await settle();
    assert.deepStrictEqual(mixes, [], 'no Web Audio mix is attempted into an embed');
    assert.deepStrictEqual(embed.loads, [A], 'the AI DJ cuts to it at the mix point');
    assert.strictEqual(queue.getState().currentId, ids()[1]);
    assert.strictEqual(deck.playing, false, 'a cut from a file to an embed');
    // With the embed playing and a file next, the interval does nothing (the video ending moves on).
    intervals.forEach((fn) => fn());
    await settle();
    assert.deepStrictEqual(mixes, []);
    assert.deepStrictEqual(embed.loads, [A]);
    // A hand mix between kinds does not start; mixNow is a plain cut.
    assert.strictEqual(await queue.startHandMix(), null);
    assert.strictEqual(queue.mixNow(), true);
    await settle();
    assert.strictEqual(queue.getState().currentId, ids()[2], 'mixNow cuts to the file');
    assert(deck.playing);
    assert.strictEqual(queue.isPlaying(), true);
    queue.togglePlay();
    assert.strictEqual(queue.isPlaying(), false);
    assert.strictEqual(queue.isEmbedActive(), false);
  }

  // An embed that ends skips items that failed.
  {
    const {queue, embed, ids, settle} = setup();
    for (const id of [A, B, C]) queue.addYouTubeEmbed(`https://youtu.be/${id}`);
    await settle();
    queue.getState().items[1].failed = 'removed';
    embed.fireEnded();
    await settle();
    assert.strictEqual(queue.getState().currentId, ids()[2], 'the failed item is skipped');
  }

  // ---- ytEmbed.js with a stub of YouTube's IFrame API ----
  {
    const made = [];
    class Player {
      constructor(slot, options) {
        this.options = options; this.calls = []; this.state = -1; made.push(this);
        this.time = 12; this.length = 180;
        setImmediate(() => options.events.onReady());
      }
      loadVideoById(id) { this.calls.push(['load', id]); }
      playVideo() { this.calls.push(['play']); }
      pauseVideo() { this.calls.push(['pause']); }
      stopVideo() { this.calls.push(['stop']); }
      seekTo(s) { this.calls.push(['seek', s]); }
      setVolume(v) { this.calls.push(['volume', v]); }
      setPlaybackRate(r) { this.calls.push(['rate', r]); }
      getAvailablePlaybackRates() { return [0.75, 1, 1.25]; }
      getCurrentTime() { return this.time; }
      getDuration() { return this.length; }
      destroy() { this.calls.push(['destroy']); }
    }
    const node = () => ({className: '', textContent: '', hidden: false, children: [], classList: {add() {}}, append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; }});
    const doc = {createElement: node, head: node(), getElementById: () => null};
    let apiLoads = 0;
    const box = {console, URL, Promise, setTimeout, clearTimeout, location: {origin: 'https://airdeck.example'}};
    vm.createContext(box);
    vm.runInContext(ytSource + '\nglobalThis.createYtEmbed = createYtEmbed;', box);
    const mount = node();
    const yt = box.createYtEmbed({mount, doc, loadApi: async () => { apiLoads += 1; return {Player}; }});
    assert.strictEqual(apiLoads, 0, 'the API loads on demand, not when the embed is created');
    assert.strictEqual(mount.hidden, true);
    assert(mount.children.some((c) => c.textContent === 'YouTube songs: volume, speed and blends only, no effects.'), 'the card says plainly, in one line, that there are no effects');
    assert.strictEqual(mount.children.filter((c) => c.className === 'ytCard-frame').length, 2, 'two 200px frames: current and incoming');
    assert.strictEqual(mount.children.filter((c) => c.className === 'ytCard-frame')[1].hidden, true, 'the incoming frame is hidden until it holds a video');
    await assert.rejects(yt.load('short'), /video id/);
    await yt.load(A);
    assert.strictEqual(apiLoads, 1);
    assert.strictEqual(mount.hidden, false);
    const p = made[0];
    assert.deepStrictEqual(p.calls, [['load', A]]);
    assert.strictEqual(p.options.width, '100%');
    yt.setVolume(0.5); yt.setVolume(0.5); yt.setVolume(0.501);
    assert.deepStrictEqual(p.calls.filter((c) => c[0] === 'volume'), [['volume', 50]], 'repeated volumes are not re-sent');
    yt.setRate(1.1); yt.setRate(0.95);
    assert.deepStrictEqual(p.calls.filter((c) => c[0] === 'rate'), [['rate', 1]], 'nearest rate YouTube allows, sent once');
    yt.setRate(1.3);
    assert.deepStrictEqual(p.calls.filter((c) => c[0] === 'rate').at(-1), ['rate', 1.25]);
    assert.strictEqual(yt.getTime(), 12);
    assert.strictEqual(yt.getDuration(), 180);
    // State changes: playing / ended / error.
    const events = [];
    yt.onEnded(() => events.push('ended'));
    yt.onError((message, code) => events.push(['error', code, message]));
    p.options.events.onStateChange({data: 1});
    assert.strictEqual(yt.isPlaying(), true);
    p.options.events.onStateChange({data: 2});
    assert.strictEqual(yt.isPlaying(), false);
    p.options.events.onStateChange({data: 0});
    p.options.events.onError({data: 101});
    assert.deepStrictEqual(events[0], 'ended');
    assert.strictEqual(events[1][1], 101);
    assert.match(events[1][2], /doesn't allow/);
    // A second video reuses the player; stop hides the card.
    await yt.load(B);
    assert.strictEqual(made.length, 1);
    assert.deepStrictEqual(p.calls.at(-1), ['load', B]);
    yt.stop();
    assert.strictEqual(mount.hidden, true);
    assert.strictEqual(yt.isPlaying(), false);
    yt.destroy();
    assert(p.calls.some((c) => c[0] === 'destroy'));

    // The script failing to load rejects (and hides the card); asking again tries again.
    let attempts = 0;
    const failing = box.createYtEmbed({mount: node(), doc, loadApi: async () => { attempts += 1; throw new Error("YouTube's player couldn't be loaded"); }});
    await assert.rejects(failing.load(A), /couldn't be loaded/);
    await assert.rejects(failing.load(A), /couldn't be loaded/);
    assert.strictEqual(attempts, 2, 'only retried when asked again');
  }

  console.log('PASS: YouTube embed items: link parsing, stub-player playback with the deck stopped, ended/next/previous/seek/pause routing, error -> failed and move on once, AI DJ cuts between kinds, failed items skipped, ytEmbed.js');
})().catch((error) => { console.error(error); process.exitCode = 1; });
