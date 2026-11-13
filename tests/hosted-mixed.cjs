// Run: node tests/hosted-mixed.cjs. A hosted library with both kinds (YouTube songs, then songs with hosted: true):
// hosted tracks are ordinary audio items (music/<id>.m4a, no /api/youtube, no /api/youtube/info, no download), the
// others stay embed items; hosted tracks lead the library, the default queue and Add all; the panel has the two
// headings and a "Music credits" block with every attribution; locally nothing changes.
const vm = require('vm'), assert = require('assert');
const {stubEmbed, setup, HOSTED, ytSource, queueSource, SONGS} = require('./yt-stub.cjs');

const MIXED = [
  ...SONGS,
  {id: 'tone-a', artist: 'Ann', title: 'Alpha', bpm: 120, genre: 'house', hosted: true, license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', attribution: 'Alpha by Ann (CC BY 4.0)', beat: {bpm: 120, first: .1, duration: 100}},
  {id: 'tone-b', artist: 'Bo', title: 'Beta', bpm: 124, genre: 'house', hosted: true, license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', attribution: 'Beta by Bo (CC BY 4.0)'},
];

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.className = ''; this.hidden = false; this.style = {}; this._text = ''; }
  get textContent() { return this._text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  setAttribute(n, v) { this.attrs[n] = String(v); if (n === 'hidden') this.hidden = true; }
  getAttribute(n) { return this.attrs[n] ?? null; }
  addEventListener() {}
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; this._text = ''; }
  after() {} remove() {} contains() { return false; } closest() { return null; }
  get classList() { const self = this; return { add: (c) => { self.className += ' ' + c; }, toggle() {} }; }
  all() { return this.children.flatMap((c) => (typeof c === 'string' ? [] : [c, ...c.all()])); }
  querySelector(sel) { const cls = sel.startsWith('.') ? sel.slice(1) : null; return this.all().find((n) => (cls ? n.className.split(/\s+/).includes(cls) : n.tag === sel)) ?? null; }
}
async function panelFor(songs, config) {
  const document = {createElement: (t) => new El(t), getElementById: () => null, head: new El('head'), body: new El('body'), addEventListener() {}};
  const box = {
    console, Date, Math, URL, Promise, setTimeout, clearTimeout, performance: {now: () => 1e7}, setInterval() {}, clearInterval() {},
    document, window: {addEventListener() {}}, requestAnimationFrame() {}, createTransitions: () => ({prepare() {}, cancel() {}}),
    fetch: async (url, options = {}) => {
      if (url === 'library.json') return {ok: true, json: async () => ({songs})};
      if (url === '/api/config') return {ok: true, json: async () => config};
      return {ok: options.method === 'HEAD', status: 200, json: async () => ({})};
    },
  };
  vm.createContext(box);
  vm.runInContext(ytSource + '\n' + queueSource + '\nglobalThis.api = {createQueue, createQueuePanel};', box);
  const deck = {playing: false, buffer: null, setVolume() {}, setFrequency() {}, ensureContext() {}, stopSource() {}, position: () => 0};
  const queue = box.api.createQueue(deck, {embed: stubEmbed()});
  const panel = box.api.createQueuePanel(queue, deck);
  for (let i = 0; i < 25; i++) await new Promise(setImmediate);
  return {panel, queue};
}

(async () => {
  // Library: hosted tracks first; availability never probes or greys them.
  const t = setup({songs: MIXED, config: HOSTED});
  await t.queue.libraryReady();
  await t.settle();
  const {library} = t.queue.getState();
  assert.deepStrictEqual(Array.from(library.map((s) => s.id)), ['tone-a', 'tone-b', ...SONGS.map((s) => s.id)], 'hosted tracks lead the library');
  assert(library.every((s) => s.available === true && !s.unavailable));
  assert(!t.fetched.some((f) => /HEAD|music\//.test(f)), 'no probing of music/ on the hosted site');
  const infoCalls = t.fetched.filter((f) => /youtube\/info/.test(f));
  assert.strictEqual(infoCalls.length, SONGS.length, 'the YouTube check runs once per embed song');
  assert(!infoCalls.some((f) => /tone-/.test(f)), 'never for a hosted track');

  // Items: hosted -> audio item; other -> embed item.
  await t.queue.addFromLibrary('tone-a', {autoplay: false});
  await t.queue.addFromLibrary(SONGS[0].id, {autoplay: false});
  const [audio, embed] = t.queue.getState().items;
  assert(!audio.embed && audio.url === 'music/tone-a.m4a' && audio.title === 'Ann - Alpha' && audio.bpm === 120, 'hosted track is a plain audio item');
  assert(embed.embed && embed.videoId === SONGS[0].id);
  assert(!t.fetched.some((f) => /\/api\/youtube(\/|$)/.test(f) && /tone-/.test(f)) && !t.fetched.some((f) => /POST \/api\/youtube$/.test(f)), 'no /api/youtube call');
  assert.strictEqual(t.queue.getState().downloads.length, 0, 'no download badge');

  // Playing it goes down the audio path (decoded, deck), not the embed player.
  const p = setup({songs: MIXED, config: HOSTED});
  await p.queue.libraryReady();
  await p.queue.addFromLibrary('tone-b');
  await p.settle();
  assert.strictEqual(p.queue.isEmbedActive(), false);
  assert.strictEqual(p.embed.loads.length, 0, 'the YouTube player is not used');
  assert(p.fetched.includes('GET music/tone-b.m4a'), 'its audio is fetched from music/');
  assert(!p.fetched.some((f) => /youtube/.test(f) && f.includes('tone-b')));

  // The default queue starts with the hosted tracks only; Add all adds hosted first, then YouTube.
  const d = setup({songs: MIXED, config: HOSTED});
  await d.queue.startDefaultQueue();
  const di = d.queue.getState().items;
  assert.deepStrictEqual(Array.from(di.map((i) => i.libraryId)), ['tone-a', 'tone-b'], 'default queue = hosted tracks');
  assert(di.every((i) => !i.embed && i.url));
  assert.strictEqual(d.embed.loads.length, 0);
  const all = setup({songs: MIXED, config: HOSTED});
  await all.queue.addAllFromLibrary();
  assert.deepStrictEqual(Array.from(all.queue.getState().items.map((i) => !!i.embed)), [false, false, true, true, true]);
  // Without hosted tracks the default queue is the YouTube songs (as before).
  const y = setup({songs: SONGS, config: HOSTED});
  await y.queue.startDefaultQueue();
  assert(y.queue.getState().items.every((i) => i.embed));

  // A YouTube song that is gone stays greyed, but never a hosted track.
  const g = setup({songs: MIXED, config: HOSTED, info: (id) => ({ok: id !== SONGS[1].id, status: id === SONGS[1].id ? 404 : 200, json: async () => ({})})});
  await g.queue.libraryReady();
  await g.settle();
  assert.deepStrictEqual(Array.from(g.queue.getState().library.filter((s) => s.unavailable).map((s) => s.id)), [SONGS[1].id]);

  // Local: nothing marked hosted -> music/ is probed, items are files.
  const l = setup({songs: SONGS, config: {youtube: true, youtubeEmbed: false, hosted: false}});
  await l.queue.libraryReady();
  assert(l.fetched.some((f) => /HEAD music\//.test(f)));
  await l.queue.addFromLibrary(SONGS[0].id, {autoplay: false});
  assert(!l.queue.getState().items[0].embed);

  // Panel: two headings, credits.
  const {panel} = await panelFor(MIXED, HOSTED);
  const groups = panel.element.all().filter((n) => n.className.includes('queuePanel-group'));
  assert.deepStrictEqual(groups.map((n) => n.textContent), ['Full effects', 'YouTube · no effects']);
  const list = panel.element.querySelector('.queuePanel-library').all().find((n) => n.tag === 'ol');
  const order = list.children.map((n) => n.className.includes('queuePanel-group') ? 'H' : 'S').join('');
  assert.strictEqual(order, 'HSSHSSS', 'heading, hosted rows, heading, YouTube rows');
  const credits = panel.element.querySelector('.queuePanel-credits');
  assert.strictEqual(credits.hidden, false);
  assert(credits.textContent.startsWith('Music credits'));
  assert(credits.textContent.includes('Alpha by Ann (CC BY 4.0)') && credits.textContent.includes('Beta by Bo (CC BY 4.0)'));
  assert.strictEqual(credits.all().filter((n) => n.tag === 'li').length, 2, 'only songs with an attribution');
  assert(credits.all().some((n) => n.tag === 'a' && n.attrs.href === 'https://creativecommons.org/licenses/by/4.0/'));
  const djOption = panel.element.querySelector('.queuePanel-djOption');
  assert.notStrictEqual(djOption.style.display, 'none', 'short mixes are visible when hosted audio exists');
  const yt = await panelFor(SONGS, HOSTED);
  assert.strictEqual(yt.panel.element.querySelector('.queuePanel-djOption').style.display, 'none', 'YouTube-only hosted library: no short mixes');
  assert.strictEqual(yt.panel.element.querySelector('.queuePanel-credits').hidden, true);
  const loc = await panelFor(SONGS, {youtube: true, youtubeEmbed: false, hosted: false});
  assert.notStrictEqual(loc.panel.element.querySelector('.queuePanel-djOption').style.display, 'none');
  assert.strictEqual(loc.panel.element.querySelector('.queuePanel-credits').hidden, true, 'local: credits hidden');

  console.log('PASS: mixed hosted library (audio + embed items, no YouTube calls for hosted, headings, credits, DJ option)');
})().catch((e) => { console.error(e); process.exit(1); });
