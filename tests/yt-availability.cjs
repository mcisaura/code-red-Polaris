// Run: node tests/yt-availability.cjs. Hosted: each library song is checked once through /api/youtube/info (4 at a
// time). A 404 greys the song out ("Not available on YouTube") and keeps it out of Add all, the default queue and
// the AI DJ; a network error or a 5xx does not mark anything.
const vm = require('vm'), assert = require('assert');
const {stubEmbed, setup, HOSTED, ytSource, queueSource} = require('./yt-stub.cjs');
setTimeout(() => { console.error('timed out'); process.exit(1); }, 30000).unref();

const id = (n) => String(n).padStart(11, 'x');
const songs = Array.from({length: 10}, (_, n) => ({id: id(n), artist: 'Artist', title: 'Song ' + n, bpm: 100, genre: 'pop'}));
const respond = (status) => ({ok: status === 200, status, json: async () => ({title: 'T', author: 'A'})});

// Tiny DOM for the panel.
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.className = ''; this.hidden = false; this.style = {}; this.listeners = {}; this._text = ''; }
  get textContent() { return this._text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  setAttribute(name, value) { this.attrs[name] = String(value); if (name === 'hidden') this.hidden = true; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; this._text = ''; }
  after() {} remove() {} contains() { return false; } closest() { return null; }
  get isConnected() { return false; }
  get classList() { const self = this; return { add: (c) => { self.className += ' ' + c; }, toggle() {} }; }
  all() { return this.children.flatMap((c) => (typeof c === 'string' ? [] : [c, ...c.all()])); }
  querySelector(selector) {
    const cls = selector.startsWith('.') ? selector.slice(1) : null;
    return this.all().find((n) => (cls ? n.className.split(/\s+/).includes(cls) : n.tag === selector)) ?? null;
  }
}

(async () => {
  // Concurrency, once per song, 404 vs. errors.
  {
    let inFlight = 0, maxInFlight = 0;
    const calls = {};
    const info = async (videoId) => {
      calls[videoId] = (calls[videoId] ?? 0) + 1;
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      if (videoId === id(0) || videoId === id(3)) return respond(404);        // removed / private
      if (videoId === id(1)) throw new TypeError('network down');                // network error: not a verdict
      if (videoId === id(2)) return respond(503);                                // the Worker had a bad moment: not a verdict
      return respond(200);
    };
    const t = setup({songs, config: HOSTED, info});
    await t.queue.libraryReady();
    for (let i = 0; i < 40; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const state = () => t.queue.getState().library;
    assert.strictEqual(maxInFlight, 4, 'four checks at a time');
    assert(songs.every((song) => calls[song.id] === 1), 'each song is checked once');
    assert.deepStrictEqual(Array.from(state().filter((s) => s.unavailable).map((s) => s.id)), [id(0), id(3)], 'only 404s are marked unavailable');
    assert(!state()[1].unavailable && !state()[2].unavailable, 'a network error or a 5xx does not mark a song');

    // Cannot be added.
    await t.queue.addFromLibrary(id(0));
    assert.strictEqual(t.queue.getState().items.length, 0);
    assert(/isn't available on YouTube/.test(t.queue.getState().status.message) && t.queue.getState().status.isError);
    assert.strictEqual(t.embed.loads.length, 0, 'and is never played');
    // Add all leaves them out (the song with only a network error stays).
    await t.queue.addAllFromLibrary();
    await t.settle();
    assert.deepStrictEqual(Array.from(t.queue.getState().items.map((i) => i.videoId)), songs.filter((s) => s.id !== id(0) && s.id !== id(3)).map((s) => s.id));
    // Default queue: same, and the first playable song plays.
    const d = setup({songs, config: HOSTED, info: async (videoId) => respond(videoId === id(0) ? 404 : 200)});
    await d.queue.startDefaultQueue();
    await d.settle();
    assert.strictEqual(d.queue.getState().items.length, 9);
    assert.strictEqual(d.embed.loads[0], id(1), 'the default queue starts with the first song that is available');
  }

  // AI DJ: the unavailable song is not offered and a pick of it is dropped.
  {
    const bodies = [];
    const t = setup({songs, config: HOSTED, info: async (videoId) => respond(videoId === id(0) ? 404 : 200), picks: [
      {id: id(0), artist: 'Artist', title: 'Song 0', reason: 'r', intro: 'i'}, {id: id(4), artist: 'Artist', title: 'Song 4', reason: 'r', intro: 'i'}]});
    const realFetch = t.box.fetch;
    t.box.fetch = async (url, options = {}) => { if (url === '/api/dj/pick') bodies.push(JSON.parse(options.body)); return realFetch(url, options); };
    await t.queue.libraryReady();
    t.queue.startDj('');
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert(bodies.length >= 1);
    assert(!bodies[0].library.some((s) => s.id === id(0)) && bodies[0].library.length === 9, 'the picker is not offered it');
    const picked = Array.from(t.queue.getState().items.map((i) => i.videoId));
    assert(picked.length >= 1 && picked.every((v) => v === id(4)), 'a pick of it is dropped (the stub picker repeats its answer while the DJ tops up)');
  }

  // Panel: greyed out, labelled, buttons disabled; the others normal.
  {
    const document = {createElement: (tag) => new El(tag), getElementById: () => null, head: new El('head'), body: new El('body'), addEventListener() {}};
    const box = {
      console, Date, Math, URL, Promise, setTimeout, clearTimeout, performance: {now: () => 1e7}, setInterval() {}, clearInterval() {},
      document, window: {addEventListener() {}}, requestAnimationFrame() {}, createTransitions: () => ({prepare() {}, cancel() {}}),
      fetch: async (url) => {
        if (url === 'library.json') return {ok: true, json: async () => ({songs: songs.slice(0, 3)})};
        if (url === '/api/config') return {ok: true, json: async () => HOSTED};
        if (url.startsWith('/api/youtube/info')) return respond(url.endsWith(id(1)) ? 404 : 200);
        return {ok: false, json: async () => ({})};
      },
    };
    vm.createContext(box);
    vm.runInContext(ytSource + '\n' + queueSource + '\nglobalThis.api = {createQueue, createQueuePanel};', box);
    const deck = {playing: false, buffer: null, setVolume() {}, setFrequency() {}, ensureContext() {}, stopSource() {}, position: () => 0};
    const queue = box.api.createQueue(deck, {embed: stubEmbed()});
    const panel = box.api.createQueuePanel(queue, deck);
    for (let i = 0; i < 30; i++) await new Promise(setImmediate);
    const rows = panel.element.querySelector('.queuePanel-list') && panel.element.all().filter((n) => n.className.includes('librarySong'));
    assert.strictEqual(rows.length, 3);
    const [ok, gone] = [rows[0], rows[1]];
    assert(gone.className.split(/\s+/).includes('unavailable') && !ok.className.split(/\s+/).includes('unavailable'));
    assert(gone.textContent.includes('Not available on YouTube') && !ok.textContent.includes('Not available'));
    const buttons = (row) => row.all().filter((n) => n.tag === 'button');
    assert(buttons(gone).length === 2 && buttons(gone).every((b) => 'disabled' in b.attrs), 'play and add are disabled');
    assert(buttons(ok).every((b) => !('disabled' in b.attrs)));
  }
  console.log('yt-availability: all checks passed');
})().catch((error) => { console.error(error); process.exit(1); });
