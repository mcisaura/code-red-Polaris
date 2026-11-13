// Run: node tests/yt-library.cjs. The hosted site (config hosted + youtubeEmbed, with an embed player) offers every
// library.json song (none marked hosted) as a YouTube embed item, with no downloads or decoding; the local setup is unchanged; the "Music credits" block
// stays hidden without attributions; the paste-a-link box and "Search on YouTube" stay.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const {stubEmbed, setup, HOSTED, ytSource, queueSource} = require('./yt-stub.cjs');
const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'library.json'), 'utf8')).songs;

// A tiny DOM: enough of Element for createQueuePanel in its floating (not embedded) form.
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.className = ''; this.hidden = false; this.style = {}; this.listeners = {}; this._text = ''; }
  get textContent() { return this._text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  setAttribute(name, value) { this.attrs[name] = String(value); if (name === 'hidden') this.hidden = true; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; this._text = ''; }
  after() {}
  remove() {}
  contains() { return false; }
  closest() { return null; }
  get isConnected() { return false; }
  get classList() { const self = this; return { add: (c) => { self.className += ' ' + c; }, toggle() {} }; }
  all() { return this.children.flatMap((c) => (typeof c === 'string' ? [] : [c, ...c.all()])); }
  querySelector(selector) {
    const cls = selector.startsWith('.') ? selector.slice(1) : null;
    return this.all().find((n) => (cls ? n.className.split(/\s+/).includes(cls) : n.tag === selector)) ?? null;
  }
}

async function panelFor(songs, {embed = null, config = HOSTED} = {}) {
  const document = {createElement: (tag) => new El(tag), getElementById: () => null, head: new El('head'), body: new El('body'), addEventListener() {}};
  const box = {
    console, Date, Math, URL, Promise, setTimeout, clearTimeout, performance: {now: () => 1e7}, setInterval() {}, clearInterval() {},
    document, window: {addEventListener() {}}, requestAnimationFrame() {}, createTransitions: () => ({prepare() {}, cancel() {}}),
    fetch: async (url, options = {}) => {
      if (url === 'library.json') return {ok: true, json: async () => ({songs})};
      if (url === '/api/config') return {ok: true, json: async () => config};
      return {ok: options.method === 'HEAD', json: async () => ({})};
    },
  };
  vm.createContext(box);
  vm.runInContext(ytSource + '\n' + queueSource + '\nglobalThis.api = {createQueue, createQueuePanel};', box);
  const deck = {playing: false, buffer: null, setVolume() {}, setFrequency() {}, ensureContext() {}, stopSource() {}, position: () => 0};
  const queue = box.api.createQueue(deck, {embed});
  const panel = box.api.createQueuePanel(queue, deck);
  for (let i = 0; i < 25; i++) await new Promise(setImmediate);
  return {panel, queue, box};
}

(async () => {
  assert.strictEqual(real.length, 25, 'library.json has the 25 original songs');

  // Hosted + embed player: every song is an embed item (real title/artist/bpm/genre kept), nothing downloaded.
  {
    const t = setup({songs: real, config: HOSTED});
    await t.queue.libraryReady();
    const {library} = t.queue.getState();
    assert.strictEqual(library.length, 25);
    assert(library.every((song, i) => song.id === real[i].id && song.artist === real[i].artist && song.title === real[i].title && song.bpm === real[i].bpm && song.genre === real[i].genre));
    assert(library.every((song) => song.available === true), 'nothing is marked "not in music/"');
    assert(!t.fetched.some((f) => /music\//.test(f) || /HEAD/.test(f)), 'no music/ probing on the hosted site');
    await t.queue.addFromLibrary(real[1].id);
    await t.settle();
    const [item] = t.queue.getState().items;
    assert(item.embed && item.videoId === real[1].id, 'the library id is the YouTube video id');
    assert.strictEqual(item.title, 'Drake - Nice For What');
    assert.strictEqual(item.bpm, 93);
    assert.strictEqual(item.genre, 'hip-hop');
    assert(!item.url && !item.defaultLibrary, 'no download or decode fields');
    assert.deepStrictEqual(Array.from(t.embed.loads), [real[1].id], 'and it plays in the player');
    assert.strictEqual(t.queue.isEmbedActive(), true);
    assert(!t.fetched.some((f) => /\/youtube$|\/progress/.test(f)), 'no download request');
    assert.strictEqual(t.queue.getState().downloads.length, 0);

    // The default queue matches the local one: the whole library, in order, the first song plays.
    const all = setup({songs: real, config: HOSTED});
    await all.queue.startDefaultQueue();
    const items = all.queue.getState().items;
    assert.deepStrictEqual(Array.from(items.map((i) => i.videoId)), real.map((s) => s.id));
    assert(items.every((i) => i.embed && i.libraryId && i.bpm && i.genre));
    assert.strictEqual(all.queue.getState().currentId, items[0].id, 'the default queue starts with the first library song');
    assert.deepStrictEqual(Array.from(all.embed.loads), [real[0].id]);
    const more = setup({songs: real.slice(0, 3), config: HOSTED});
    await more.queue.addAllFromLibrary();
    await more.settle();
    assert.strictEqual(more.queue.getState().items.length, 3);
    assert(more.queue.getState().items.every((i) => i.embed));

    // The AI DJ's picks are embed items too.
    const dj = setup({songs: real, config: HOSTED, picks: [{id: real[2].id, artist: real[2].artist, title: real[2].title, intro: 'hi', reason: 'fits'}]});
    await dj.queue.libraryReady();
    dj.queue.startDj('chill');
    await dj.settle();
    assert(dj.queue.getState().items[0].embed && dj.queue.getState().items[0].dj, 'a DJ pick is an embed item');
  }

  // The local setup is unchanged (files from music/); without a player the hosted config makes no embed items.
  {
    const t = setup({songs: real, config: {youtube: true, youtubeEmbed: false, hosted: false}});
    await t.queue.libraryReady();
    assert(t.fetched.some((f) => /HEAD music\//.test(f)), 'local: music/ is probed');
    await t.queue.addFromLibrary(real[0].id, {autoplay: false});
    const [item] = t.queue.getState().items;
    assert(!item.embed && item.url === `music/${real[0].id}.m4a`);
    const noPlayer = setup({songs: real, config: HOSTED, embed: null});
    await noPlayer.queue.libraryReady();
    await noPlayer.queue.addFromLibrary(real[0].id, {autoplay: false});
    assert(!noPlayer.queue.getState().items.some((i) => i.embed), 'without a player nothing becomes an embed item');
  }

  // The panel: the library lists artist, title and bpm as locally; no credits block; the paste box and search link stay.
  {
    const {panel} = await panelFor(real, {embed: stubEmbed()});
    const library = panel.element.querySelector('.queuePanel-library');
    const rows = library.all().filter((n) => n.className.includes('librarySong'));
    assert.strictEqual(rows.length, 25);
    assert(rows[0].textContent.includes('ELEMENT.') && rows[0].textContent.includes('Kendrick Lamar') && rows[0].textContent.includes('96 BPM'));
    assert(!rows.some((r) => /not in music|not available|download/i.test(r.textContent)), 'no download or availability badges');
    assert.strictEqual(panel.element.querySelector('.queuePanel-credits').hidden, true, 'no attributions: the credits block stays hidden');
    assert.strictEqual(panel.element.querySelector('.queuePanel-group'), null, 'no heading when no song is hosted audio');
    const embedBlock = panel.element.querySelector('.queuePanel-embed');
    assert.strictEqual(embedBlock.hidden, false);
    const search = embedBlock.all().find((n) => n.tag === 'a');
    assert.strictEqual(search.attrs.href, 'https://www.youtube.com');
    assert.strictEqual(search.attrs.target, '_blank');
    assert.strictEqual(search.attrs.rel, 'noopener');
    assert.strictEqual(search.textContent, 'Search on YouTube');
    assert(embedBlock.textContent.includes('Paste a YouTube link'));
    const local = (await panelFor(real, {embed: stubEmbed(), config: {youtube: true, youtubeEmbed: false, hosted: false}})).panel.element.querySelector('.queuePanel-embed');
    assert.strictEqual(local.hidden, true, 'local server: nothing changes');
    const none = (await panelFor([], {embed: null})).panel.element.querySelector('.queuePanel-embed');
    assert.strictEqual(none.hidden, true, 'no player on this page');
  }

  console.log('PASS: hosted library songs are embed items (default queue, add all, DJ picks), local unchanged, credits block hidden, paste box and search link stay');
})().catch((error) => { console.error(error); process.exitCode = 1; });
