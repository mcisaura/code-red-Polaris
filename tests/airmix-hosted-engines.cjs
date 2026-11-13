// AirMix on the hosted site, two kinds of sets: the picker's two groups and the one-kind rule (djStart.js), and the
// page's engine per set (ai-dj.html): a set of `hosted: true` tracks runs the real engine (Deck + createQueue, filter
// shapes charted), a YouTube set runs ytDeck, switching tears the old engine down, and a hosted track that fails to
// load shows "Couldn't load" and never asks /api/youtube. Run: node tests/airmix-hosted-engines.cjs
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const read = (name) => fs.readFileSync(__dirname + '/../' + name, 'utf8').replace(/\r\n/g, '\n');
const strip = (name) => read(name).replace(/^import .*$/mg, '').replace(/^export /mg, '');
const page = read('ai-dj.html');
const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- the picker (djStart.js) -------------------------------------------------------------------------------
function element() {
  let children = {}, html = '';
  const node = {
    isConnected: true, textContent: '', disabled: false, hidden: false, dataset: {}, attributes: {}, classes: new Set(),
    get innerHTML() { return html; }, set innerHTML(value) { html = value; children = {}; node.rows = null; node.heads = null; },
    classList: { toggle(name, on) { on ? node.classes.add(name) : node.classes.delete(name); } },
    append() {}, setAttribute(name, value) { node.attributes[name] = value; }, remove() { node.isConnected = false; },
    listeners: {}, addEventListener(type, fn) { node.listeners[type] = fn; }, click(event) { node.listeners.click?.(event); },
    querySelector(selector) { return (children[selector] ??= element()); },
    querySelectorAll(selector) {
      if (selector === '[data-id]') {
        node.rows ??= [...html.matchAll(/data-id="([^"]+)"/g)].map((match) => { const row = element(); row.dataset = { id: match[1] }; row.closest = () => row; return row; });
        return node.rows;
      }
      if (selector === '[data-group]') {
        node.heads ??= [...html.matchAll(/data-group="([^"]+)"/g)].map((match) => { const head = element(); head.dataset = { group: match[1] }; head.querySelector('.djStart-grouphint').hidden = true; return head; });
        return node.heads;
      }
      return [];
    },
  };
  return node;
}
const lib = [
  { id: 'y1', title: 'Yt One', artist: 'A', bpm: 90, genre: 'pop', available: true },
  { id: 'h1', title: 'Hosted One', artist: 'B', bpm: 100, genre: 'house', hosted: true, available: true },
  { id: 'y2', title: 'Yt Two', artist: 'A', bpm: 91, genre: 'pop', available: true },
  { id: 'h2', title: 'Hosted Two', artist: 'B', bpm: 101, genre: 'house', hosted: true, available: true },
  { id: 'h3', title: 'Hosted Three', artist: 'B', bpm: 140, genre: 'house', hosted: true, available: true },
];
function picker({ saved = [], config = { youtube: false, youtubeEmbed: true, hosted: true }, checkSong, prepare = () => {} } = {}) {
  let stage = null;
  const box = {
    console, performance, setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: (fn) => setTimeout(fn, 16),
    localStorage: { getItem: () => JSON.stringify(saved), setItem() {} },
    document: { hidden: false, head: element(), createElement: element, getElementById: () => null },
  };
  vm.createContext(box);
  vm.runInContext(strip('djStart.js'), box);
  const screens = vm.runInContext('createStartScreen', box)({ append(node) { stage = node; } }, {
    library: async () => lib, startCamera: async () => true, handSeen: () => false, prepare, begin() {}, config: async () => config, checkSong,
  });
  return { screens, root: () => stage };
}
const rowOf = (root, id) => root().querySelectorAll('[data-id]').find((row) => row.dataset.id === id);
const pick = (root, id) => { const row = rowOf(root, id); root().querySelector('.djStart-songs').click({ target: { closest: () => row } }); };
const hint = (root, group) => root().querySelectorAll('[data-group]').find((head) => head.dataset.group === group).querySelector('.djStart-grouphint');

test('hosted picker: two labelled groups, the full-game tracks first, YouTube songs after', async () => {
  const { root } = picker();
  await flush();
  const html = root().innerHTML;
  const full = html.indexOf('Full game · mixes and filter'), yt = html.indexOf('YouTube · beats only');
  assert(full > -1 && yt > full, 'the full game group comes first');
  const order = [...html.matchAll(/data-id="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(order, ['h1', 'h2', 'h3', 'y1', 'y2']);
  assert(html.indexOf('data-id="h3"') < yt && html.indexOf('data-id="y1"') > yt, 'rows sit under their own heading');
});

test('one kind per set: picking a hosted track disables the YouTube group with a hint; Clear re-enables it (and the reverse)', async () => {
  const { root } = picker();
  await flush();
  assert(!rowOf(root, 'y1').disabled && !rowOf(root, 'h1').disabled);
  pick(root, 'h1');
  assert.equal(rowOf(root, 'h1').attributes['aria-selected'], 'true');
  assert.equal(rowOf(root, 'y1').disabled, true);
  assert.equal(rowOf(root, 'y1').attributes['aria-disabled'], 'true');
  assert(rowOf(root, 'y1').classes.has('locked'));
  assert.equal(hint(root, 'yt').hidden, false, 'the locked group says why');
  assert.equal(hint(root, 'full').hidden, true);
  pick(root, 'y1');
  assert.equal(rowOf(root, 'y1').attributes['aria-selected'], 'false', 'clicking the other kind does nothing');
  pick(root, 'h2');
  assert.equal(rowOf(root, 'h2').attributes['aria-selected'], 'true', 'the same kind still picks');
  root().querySelector('[data-clear]').click();
  assert(!rowOf(root, 'y1').disabled && !rowOf(root, 'h1').disabled && hint(root, 'yt').hidden && hint(root, 'full').hidden);
  pick(root, 'y1');
  assert.equal(rowOf(root, 'h1').disabled, true, 'a YouTube first pick locks the full game group');
  assert.equal(hint(root, 'full').hidden, false);
  assert.equal(rowOf(root, 'y2').disabled, false);
});

test('a saved set of mixed kinds keeps only the first song\'s kind', async () => {
  const { root } = picker({ saved: ['y1', 'h1', 'y2'] });
  await flush();
  assert.equal(rowOf(root, 'y1').attributes['aria-selected'], 'true');
  assert.equal(rowOf(root, 'y2').attributes['aria-selected'], 'true');
  assert.equal(rowOf(root, 'h1').attributes['aria-selected'], 'false');
});

test('YouTube availability is only checked for YouTube songs; their greying is kept', async () => {
  const asked = [];
  const { root } = picker({ checkSong: async (song) => { asked.push(song.id); return song.id === 'y2'; } });
  await flush();
  assert.deepEqual(asked.sort(), ['y1', 'y2']);
  assert.equal(rowOf(root, 'y2').disabled, true);
  assert(rowOf(root, 'y2').classes.has('gone'));
  assert.equal(rowOf(root, 'h1').disabled, false);
});

test('a hosted-track set shows blend/cut labels and the three-move intro; a YouTube set on the hosted site keeps plain arrows', async () => {
  const full = picker({ saved: ['h1', 'h2'] });
  await flush();
  assert.match(full.root().querySelector('.djStart-flow').innerHTML, />blend</);
  full.root().querySelector('[data-play]').click();
  await flush();
  assert.match(full.root().innerHTML, /Slide along the track to mix the next song in/);
  assert.equal((full.root().innerHTML.match(/<li>/g) || []).length, 3);
  const yt = picker({ saved: ['y1', 'y2'] });
  await flush();
  assert.match(yt.root().querySelector('.djStart-flow').innerHTML, /djStart-then/);
  assert.doesNotMatch(yt.root().querySelector('.djStart-flow').innerHTML, />blend<|>cut</);
  yt.root().querySelector('[data-play]').click();
  await flush();
  assert.match(yt.root().innerHTML, /djStart-moves two/);
});

test('local picker: no groups, no locking, mixes of any songs', async () => {
  const { root } = picker({ config: { youtube: true, youtubeEmbed: false, hosted: false }, saved: ['y1', 'h1'] });
  await flush();
  assert.doesNotMatch(root().innerHTML, /Full game|beats only|data-group/);
  assert.equal(rowOf(root, 'y1').attributes['aria-selected'], 'true');
  assert.equal(rowOf(root, 'h1').attributes['aria-selected'], 'true');
  assert(!rowOf(root, 'y2').disabled);
});

// ---- the page's engine per set (ai-dj.html) ----------------------------------------------------------------
// The page's own code: the engine variables, buildEngine / teardownEngine / useEngine / engineKindFor / showCredits and
// the screens' options, cut out by markers and run with stubs for the engines.
function pageHarness({ hostedSite, songs = lib, failWith = null }) {
  const made = { decks: [], queues: [], sessions: [], embeds: [], games: [] };
  const log = [];
  const makeElement = () => {
    const node = {
      children: [], hidden: false, removed: false, classes: new Set(), textContent: '', className: '',
      append(...items) { node.children.push(...items); }, appendChild(item) { node.children.push(item); return item; },
      replaceChildren(...items) { node.children = items; node.replaced = (node.replaced ?? 0) + 1; },
      setAttribute() {}, remove() { node.removed = true; }, getContext: () => ({}),
      classList: { toggle() {}, add() {}, remove() {} }, clientWidth: 1000, clientHeight: 500,
      querySelector: () => noteNode,
    };
    return node;
  };
  const noteNode = makeElement();
  const nodes = {};
  const $ = (id) => (nodes[id] ??= makeElement());
  const stage = makeElement();
  const fetched = [];
  const fakeQueue = (kind) => {
    const state = { items: [], currentId: null, downloads: [], library: songs, dj: { on: true, short: false } };
    const listeners = new Set(), failures = new Set();
    const q = {
      kind, calls: [], listeners, failures, library: songs,
      getState: () => ({ ...state, library: songs }),
      getPlayback: () => ({ position: 14, duration: 200, rate: 1, playing: true, loaded: true, songId: 'song' }),
      beatGridAt: () => ({ bpm: 120, first: 0 }),
      energyAt: (time) => (time < 20 ? 0.8 : 1.5),
      mixOutAt: () => null, getUpNext: () => null, getChoices: () => [], holdControls() {}, coachPing() {}, resetSound() {}, setCrowd() {},
      on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      async libraryReady() {}, async playSet(ids) { q.calls.push(['playSet', ids]); state.items = ids.map((id) => ({ id, title: `Artist - ${id}` })); },
      async readyToStart() { q.calls.push(['readyToStart']); if (failWith && kind === 'full') throw failWith; },
      beginSet() { q.calls.push(['beginSet']); }, cancelSet() { q.calls.push(['cancelSet']); },
      async endSet(ms) { q.calls.push(['endSet', ms]); return true; },
    };
    if (kind === 'yt') {
      q.hasEffects = false;
      q.failures = failures;
      q.onFailure = (fn) => { failures.add(fn); return () => failures.delete(fn); };
      q.isUnavailable = async () => false;
    }
    made.queues.push(q);
    return q;
  };
  const stubDeck = (kind) => {
    const d = { kind, stopped: 0, ensured: 0, ctx: null, ensureContext() { d.ensured += 1; d.ctx ??= { closed: false, close() { this.closed = true; }, suspend() {}, resume: async () => {} }; }, stopSource() { d.stopped += 1; }, waveform: () => null, rate: 1, setSpeed() {}, setFrequency() {}, setVolume() {} };
    made.decks.push(d);
    return d;
  };
  const box = {
    console, performance, Promise, setTimeout, clearTimeout, requestAnimationFrame() {},
    window: {}, location: { origin: 'x' },
    fetch: async (url) => { fetched.push(String(url)); return { ok: false, status: 404 }; },
    document: { createElement: makeElement, getElementById: () => ({}), head: makeElement(), querySelector: () => stage },
    $, hostedSite, canvas: { width: 1000, height: 500 }, songStatus: { textContent: '', classList: { remove() {} } },
    PINCH_CLOSED: 0, PINCH_OPEN: 1, FREQ_MIN: 80, FREQ_MAX: 18000, BETWEEN_CLOSED: 0.1, BETWEEN_OPEN: 0.6,
    inSet: false, phase: 'playing', cameraLost: false, updateSetButtons() {}, updateSongCard() { log.push('card'); },
    stopSet: async () => { log.push('stopSet'); }, loadYouTubeApi: () => {}, loadConfig: async () => ({}),
    createStartScreen(_stage, options) { box.screenOptions = options; return { results() {}, failed: (message) => log.push(['failed', message]) }; },
    Deck: class { constructor() { return stubDeck('full'); } },
    createQueue: (deck) => { assert.equal(deck.kind, 'full'); return fakeQueue('full'); },
    createYtEmbed: ({ mount }) => {
      const embed = { mount, stops: 0, destroyed: 0, stop() { embed.stops += 1; }, destroy() { embed.destroyed += 1; } };
      made.embeds.push(embed);
      return embed;
    },
    createYtSession: ({ embed }) => {
      const session = { embed, deck: stubDeck('yt'), queue: fakeQueue('yt') };
      made.sessions.push(session);
      return session;
    },
    catalog: hostedSite ? { queue: { getState: () => ({ library: songs }), isUnavailable: async () => false, libraryReady: async () => {} } } : null,
  };
  vm.createContext(box);
  vm.runInContext(strip('djGame.js') + '\nglobalThis.createDjGame = createDjGame;', box);
  const declarations = page.slice(page.indexOf('let engine = null;'), page.indexOf('const controls = '));
  const engineCode = page.slice(page.indexOf('const stage = document.querySelector(".stage");'), page.indexOf('// ---- Pause and restart'));
  // `stage` is the page's own constant; the harness gives it the stub.
  vm.runInContext(declarations + '\n' + engineCode.replace('const stage = document.querySelector(".stage");', 'const stage = document.querySelector(".stage");'), box);
  const get = (code) => vm.runInContext(code, box);
  return { box, made, log, fetched, ytMount: $('ytMount'), get, prepare: (ids) => box.screenOptions.prepare(ids), stage, nodes };
}
const chart = (h) => { h.get('djGame.setEnabled(true); djGame.update({}, 1000)'); return h.get('djGame.peek(1000)').targets.map((target) => target.pins.right.pinch); };

test('engineKindFor: hosted tracks only -> full; any YouTube song -> yt; locally always full', () => {
  const hosted = pageHarness({ hostedSite: true });
  assert.equal(hosted.get('engineKindFor(["h1","h2"])'), 'full');
  assert.equal(hosted.get('engineKindFor(["y1","y2"])'), 'yt');
  assert.equal(hosted.get('engineKindFor(["h1","y1"])'), 'yt');
  assert.equal(hosted.get('engineKindFor([])'), 'yt');
  const local = pageHarness({ hostedSite: false });
  assert.equal(local.get('engineKindFor(["y1","h1"])'), 'full');
});

test('a hosted-track set runs the real engine (Deck + createQueue) with filter shapes; the YouTube card stays hidden', async () => {
  const h = pageHarness({ hostedSite: true });
  await h.prepare(['h1', 'h2']);
  assert.equal(h.made.sessions.length, 0, 'ytDeck is not used');
  assert.equal(h.made.embeds.length, 0, 'no YouTube players');
  assert.equal(h.made.queues.length, 1);
  assert.equal(h.made.queues[0].kind, 'full');
  assert.deepEqual(h.made.queues[0].calls.slice(0, 2), [['playSet', ['h1', 'h2']], ['readyToStart']]);
  assert.equal(h.made.decks[0].ensured >= 1, true, 'audio is unlocked inside the Play click');
  assert.equal(h.ytMount.hidden, false, 'the YouTube card was never built or shown (stub default)');
  assert.equal(h.ytMount.children.length, 0);
  assert.equal(h.get('queue.hasEffects'), undefined);
  const pinches = chart(h);
  assert(pinches.length > 0 && pinches.some((pinch) => pinch < 1.08), `filter shapes close the right pinch (${pinches})`);
});

test('a YouTube set runs ytDeck on the YouTube card, with no filter shapes', async () => {
  const h = pageHarness({ hostedSite: true });
  await h.prepare(['y1', 'y2']);
  assert.equal(h.made.sessions.length, 1);
  assert.equal(h.made.embeds.length, 1);
  assert.equal(h.made.embeds[0].mount, h.ytMount, 'the card is the YouTube player\'s mount');
  assert.equal(h.get('queue.hasEffects'), false);
  assert.equal(h.made.decks.every((deck) => deck.kind === 'yt'), true, 'no real Deck is built');
  const pinches = chart(h);
  assert(pinches.length > 0 && pinches.every((pinch) => pinch === 1.08), `no filter shapes (${pinches})`);
  assert.equal(h.made.queues[0].failures.size, 1, 'the failure screen is wired to this engine');
  h.made.queues[0].failures.forEach((fn) => { h.box.inSet = true; fn('Couldn\'t play Yt One: gone.'); });
  await flush();
  assert.deepEqual(h.log.filter((entry) => entry === 'stopSet' || entry[0] === 'failed'), ['stopSet', ['failed', 'Couldn\'t play Yt One: gone.']]);
});

test('another set of the same kind reuses the engine; the other kind tears the old one down completely', async () => {
  const h = pageHarness({ hostedSite: true });
  await h.prepare(['y1', 'y2']);
  const first = h.get('engine');
  await h.prepare(['y2', 'y1']);
  assert.equal(h.get('engine'), first, 'same kind: same engine');
  assert.equal(h.made.embeds.length, 1);
  // YouTube -> full
  const yt = { embed: h.made.embeds[0], queue: h.made.queues[0], deck: h.made.decks[0] };
  await h.prepare(['h1', 'h2']);
  assert.equal(h.get('engine.kind'), 'full');
  assert.equal(yt.embed.destroyed, 1, 'the YouTube players are destroyed');
  assert(yt.embed.stops >= 1, 'and stopped');
  assert.equal(h.ytMount.hidden, true, 'the card is hidden');
  assert(h.ytMount.replaced >= 1, 'and emptied for the next embed');
  assert.equal(yt.queue.listeners.size, 0, 'the page\'s listeners are detached');
  assert.equal(yt.queue.failures.size, 0);
  assert(yt.queue.calls.some((call) => call[0] === 'endSet'), 'the old queue is ended');
  assert.equal(yt.deck.ctx.closed, true, 'the old audio context is closed');
  assert(h.nodes.djSet.children.length >= 1);
  // full -> YouTube
  const full = { queue: h.made.queues.find((queue) => queue.kind === 'full'), deck: h.made.decks.find((deck) => deck.kind === 'full') };
  assert.equal(full.queue.listeners.size, 1);
  await h.prepare(['y1', 'y2']);
  assert.equal(h.get('engine.kind'), 'yt');
  assert.equal(full.queue.listeners.size, 0, 'the real engine\'s listeners are detached');
  assert(full.deck.stopped >= 1, 'its audio is stopped');
  assert.equal(full.deck.ctx.closed, true);
  assert(full.queue.calls.some((call) => call[0] === 'endSet'));
  assert.equal(h.made.embeds.length, 2, 'a fresh YouTube player pair for the new set');
  // Old games are gone from the page: only the current game's canvas stays.
  const canvases = h.stage.children.filter((node) => node.className === 'djGame');
  assert.equal(canvases.filter((node) => !node.removed).length, 1);
});

test('a hosted track that fails to load: "Couldn\'t load", never "download", and /api/youtube is never asked', async () => {
  for (const cause of [new Error('could not fetch audio (404)'), Object.assign(new Error('Unable to decode audio data'), { name: 'EncodingError' }), new Error('"Hosted One" isn\'t available')]) {
    const h = pageHarness({ hostedSite: true, failWith: cause });
    await assert.rejects(h.prepare(['h1', 'h2']), (error) => {
      assert.match(error.message, /^Couldn't load Hosted One\.$|^Couldn't load h1\.$/);
      assert.doesNotMatch(error.message, /download/i);
      assert.equal(error.detail, cause.message);
      return true;
    });
    assert.equal(h.fetched.filter((url) => /api\/youtube/.test(url)).length, 0);
  }
});

test('locally a failed fetch is still a download failure, and local sets always use the real engine', async () => {
  const h = pageHarness({ hostedSite: false, failWith: new Error('yt-dlp isn\'t installed.') });
  await assert.rejects(h.prepare(['y1', 'y2']), (error) => /^Couldn't download /.test(error.message));
  assert.equal(h.made.sessions.length, 0);
  assert.equal(h.made.queues[0].kind, 'full');
});

test('the library for the picker: hosted lists the catalog (both kinds); credits show attributions only, hidden when none', async () => {
  const withCredit = lib.map((song) => (song.id === 'h1' ? { ...song, attribution: '"Hosted One" by B, CC BY 4.0', license: 'CC BY 4.0' } : song.id === 'h2' ? { ...song, attribution: 'Hosted Two by B', license: 'CC BY 3.0' } : song));
  const h = pageHarness({ hostedSite: true, songs: withCredit });
  const songs = await h.box.screenOptions.library();
  assert.equal(songs.length, 5);
  const items = h.nodes.creditsList.children.map((node) => node.textContent);
  assert.deepEqual(items, ['"Hosted One" by B, CC BY 4.0', 'Hosted Two by B (CC BY 3.0)'], 'the license is added only when the attribution lacks it');
  assert.equal(h.nodes.credits.hidden, false);
  const none = pageHarness({ hostedSite: true });
  await none.box.screenOptions.library();
  assert.equal(none.nodes.credits.hidden, true);
  assert.equal(none.nodes.creditsList.children.length, 0);
});

test('locally a hosted-only song whose audio is not in music/ is not offered', async () => {
  const songs = [{ id: 'y1', title: 'Y', artist: 'A', available: true }, { id: 'h1', title: 'H', artist: 'B', hosted: true, available: false }, { id: 'h2', title: 'H2', artist: 'B', hosted: true, available: true }];
  const h = pageHarness({ hostedSite: false, songs });
  const shown = await h.box.screenOptions.library();
  assert.deepEqual(shown.map((song) => song.id), ['y1', 'h2']);
});

// ---- the real queue.js: a hosted track that 404s never reaches /api/youtube -----------------------------------
test('queue.js on the hosted site: a hosted track whose audio 404s (HEAD or GET) fails to load without any /api/youtube call', async () => {
  const { setup, HOSTED } = require('./yt-stub.cjs');
  for (const headOk of [true, false]) {
    const songs = [1, 2].map((n) => ({ id: `hosted${n}`, artist: 'B', title: `Hosted ${n}`, bpm: 100, genre: 'house', hosted: true }));
    const t = setup({ embed: null, songs, config: HOSTED });
    t.box.fetch = async (url, options = {}) => {
      t.fetched.push(`${options.method ?? 'GET'} ${url}`);
      if (url === 'library.json') return { ok: true, json: async () => ({ songs }) };
      if (url === '/api/config') return { ok: true, json: async () => HOSTED };
      if (options.method === 'HEAD') return { ok: headOk };
      return { ok: false, status: 404 };
    };
    await t.queue.libraryReady();
    await t.queue.playSet(['hosted1', 'hosted2']);
    await assert.rejects(t.queue.readyToStart());
    await t.settle();
    assert.equal(t.fetched.filter((entry) => /api\/youtube/.test(entry)).length, 0, `headOk=${headOk}: ${t.fetched}`);
  }
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ok   ' + name); }
    catch (error) { console.error('FAIL ' + name); throw error; }
  }
  console.log(`PASS: ${tests.length} hosted AirMix engine checks`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
