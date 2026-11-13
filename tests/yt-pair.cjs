// Run: node tests/yt-pair.cjs. ytEmbed.js's two players (current + incoming) with a stub of YouTube's IFrame API:
// a second player on demand, load options applied before the video starts, swap() trading roles, listeners that
// follow the role, frames of a fixed 200px that only show while they hold a video.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const source = fs.readFileSync(path.join(__dirname, '..', 'ytEmbed.js'), 'utf8').replace(/^import .*$/mg, '').replace(/^export /mg, '');

const made = [];
class Player {
  constructor(slot, options) {
    this.slot = slot; this.options = options; this.calls = []; made.push(this); this.time = 5; this.length = 100;
    setImmediate(() => options.events.onReady());
  }
  loadVideoById(id) { this.calls.push(['load', id]); }
  playVideo() { this.calls.push(['play']); }
  pauseVideo() { this.calls.push(['pause']); }
  stopVideo() { this.calls.push(['stop']); }
  seekTo(s) { this.calls.push(['seek', s]); }
  setVolume(v) { this.calls.push(['volume', v]); }
  setPlaybackRate(r) { this.calls.push(['rate', r]); }
  getAvailablePlaybackRates() { return [0.5, 1, 1.25, 1.5]; }
  getCurrentTime() { return this.time; }
  getDuration() { return this.length; }
  destroy() { this.calls.push(['destroy']); }
}
const node = () => ({className: '', textContent: '', hidden: false, children: [], classList: {add() {}}, append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; }});
const doc = {createElement: node, head: node(), getElementById: () => null};
const box = {console, URL, Promise, setTimeout, clearTimeout, location: {origin: 'https://airdeck.example'}};
vm.createContext(box);
vm.runInContext(source + '\nglobalThis.api = {createYtEmbed, createYtEmbedPair, EMBED_NOTE};', box);
const A = 'AAAAAAAAAAA', B = 'BBBBBBBBBBB';

(async () => {
  // The frame styles: a fixed 200px height that fits the sidebar (no aspect-ratio with a min-height).
  const mount = node();
  const yt = box.api.createYtEmbed({mount, doc, loadApi: async () => ({Player})});
  const style = doc.head.children[0].textContent;
  assert(/\.ytCard-frame \{[^}]*height: 200px/.test(style), 'each frame is a fixed 200px high');
  assert(!/aspect-ratio/.test(style), 'no aspect-ratio (it overflowed the sidebar)');
  assert(/\.ytCard-frame\[hidden\]/.test(style));
  assert.strictEqual(box.api.createYtEmbedPair, box.api.createYtEmbed);
  const frames = mount.children.filter((c) => c.className === 'ytCard-frame');
  assert.strictEqual(frames.length, 2);
  assert.strictEqual(frames[1].hidden, true, 'the incoming frame starts hidden');
  assert.strictEqual(mount.hidden, true);
  assert.strictEqual(typeof yt.swap, 'function');
  for (const method of ['load', 'play', 'pause', 'seekTo', 'setVolume', 'setRate', 'getTime', 'getDuration', 'isPlaying', 'onEnded', 'onError', 'stop']) {
    assert.strictEqual(typeof yt[method], 'function', method);
    assert.strictEqual(typeof yt.second[method], 'function', 'second.' + method);
  }

  await yt.load(A);
  assert.strictEqual(made.length, 1, 'the second player is only created when used');
  assert.strictEqual(mount.hidden, false);
  assert.strictEqual(frames[0].hidden, false);
  assert.strictEqual(frames[1].hidden, true);

  // The incoming player: its volume and speed are in place before the video starts.
  await yt.second.load(B, {volume: 0, rate: 1.1});
  assert.strictEqual(made.length, 2);
  const [first, second] = made;
  assert.deepStrictEqual(second.calls, [['volume', 0], ['rate', 1], ['load', B]], 'volume 0 and the nearest allowed rate go before loadVideoById');
  assert.strictEqual(frames[1].hidden, false, 'the incoming frame shows while it holds a video');
  assert.strictEqual(frames[0].hidden, false, 'the playing player is never hidden');
  yt.second.setVolume(0.25); yt.setVolume(0.75);
  assert.deepStrictEqual(second.calls.at(-1), ['volume', 25]);
  assert.deepStrictEqual(first.calls.at(-1), ['volume', 75]);
  yt.second.seekTo(9);
  assert.deepStrictEqual(second.calls.at(-1), ['seek', 9]);
  assert.strictEqual(yt.second.getDuration(), 100);

  // Listeners follow the role: the incoming player's events go to second's listeners only.
  const events = [];
  yt.onEnded(() => events.push('main ended')); yt.onError((m, c) => events.push('main error ' + c));
  yt.second.onEnded(() => events.push('second ended')); yt.second.onError((m, c) => events.push('second error ' + c));
  second.options.events.onStateChange({data: 0});
  second.options.events.onError({data: 101});
  first.options.events.onStateChange({data: 0});
  assert.deepStrictEqual(events, ['second ended', 'second error 101', 'main ended']);

  // Landing: stop the old current player (hides its frame), then swap.
  yt.stop();
  assert.strictEqual(frames[0].hidden, true);
  assert.strictEqual(mount.hidden, false, 'the card stays while the incoming player plays');
  yt.swap();
  events.length = 0;
  yt.setVolume(0.6);
  assert.deepStrictEqual(second.calls.at(-1), ['volume', 60], 'the incoming player is now `yt`');
  second.options.events.onStateChange({data: 0});
  first.options.events.onStateChange({data: 0}); // the spare player: nothing (it has no video)
  assert.deepStrictEqual(events, ['main ended'], 'listeners follow the roles');
  assert.strictEqual(yt.getTime(), 5);
  // The old current player is the spare now: it can load the next incoming song.
  await yt.second.load(A, {volume: 0});
  assert.strictEqual(made.length, 2, 'the two players are reused');
  assert.deepStrictEqual(first.calls.slice(-2), [['volume', 0], ['load', A]]);
  yt.second.stop();
  assert.strictEqual(frames[0].hidden, true);
  yt.stop();
  assert.strictEqual(mount.hidden, true);
  yt.destroy();
  assert(first.calls.some((c) => c[0] === 'destroy') && second.calls.some((c) => c[0] === 'destroy'));
  console.log('PASS: ytEmbed.js pair: two fixed 200px players, load options before play, role-following listeners, swap, frames shown only while loaded');
})().catch((error) => { console.error(error); process.exitCode = 1; });
