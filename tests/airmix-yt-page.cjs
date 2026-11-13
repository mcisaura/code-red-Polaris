// AirMix's hosted mode, the page side: which engine ai-dj.html picks, the visible 200 px YouTube card,
// the start screens on the hosted site (no download hints, no blend wording, a failed song -> Try again /
// New set), and no music credits left in the AirMix files. Run: node tests/airmix-yt-page.cjs
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const read = (name) => fs.readFileSync(__dirname + '/../' + name, 'utf8');
const page = read('ai-dj.html');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the engine is chosen per set at Play: hosted tracks use Deck + createQueue, YouTube sets use ytDeck; locally always the full engine', () => {
  assert.match(page, /const hostedSite = config\.hosted === true && config\.youtubeEmbed === true;/);
  assert.match(page, /const catalog = hostedSite \? createYtSession\(\{ embed: createYtEmbed\(\{ mount: null \}\)/, 'a player-less catalog lists the hosted library');
  assert.match(page, /engineDeck = new Deck\(\);\s*engineQueue = createQueue\(engineDeck\);/);
  assert.match(page, /const session = createYtSession\(\{ embed, loadApi: loadYouTubeApi \}\);/);
  assert.match(page, /if \(!hostedSite\) return "full";/);
  assert.match(page, /useEngine\(engineKindFor\(ids\)\)/);
  assert.match(page, /import \{ createYtSession \} from "\.\/ytDeck\.js";/);
  assert.match(page, /import \{ Deck \} from "\.\/aiDeck\.js";/);
  assert.match(page, /catalog\?\.warm\(\)/, 'YouTube\'s script loads before the Play click');
});

test('a slow /api/config falls back to the local engine instead of hanging the page', () => {
  assert.match(page, /Promise\.race\(\[loadConfig\(\), new Promise\(\(resolve\) => setTimeout\(resolve, \d+, \{ hosted: false, youtubeEmbed: false \}\)\)\]\)/);
});

test('the YouTube card is a visible 200 px player in the rail, above the song card, hidden until a song loads', () => {
  const aside = page.slice(page.indexOf('<aside>'), page.indexOf('</aside>'));
  assert(aside.indexOf('id="ytMount"') > -1 && aside.indexOf('id="ytMount"') < aside.indexOf('class="card glass song"'), 'first in the rail, so on narrow screens it is right under the camera');
  assert.match(aside, /<div id="ytMount" class="card glass" hidden><\/div>/);
  assert.match(page, /#ytMount \.ytCard-frame \{[^}]*height: 200px;[^}]*min-width: 200px/);
  assert.match(page, /#ytMount\[hidden\] \{ display: none; \}/);
  const css = page.slice(page.indexOf('#ytMount {'), page.indexOf('.help {'));
  assert.doesNotMatch(css, /opacity: 0|visibility: hidden|display: none;(?! \})/, 'the player is never hidden while it plays');
});

test('the card text meets 4.5:1 on the cream glass', () => {
  const lum = (hex) => {
    const channel = (value) => { const c = parseInt(value, 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * channel(hex.slice(1, 3)) + 0.7152 * channel(hex.slice(3, 5)) + 0.0722 * channel(hex.slice(5, 7));
  };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  for (const color of ['#8a4510', '#5a3519']) {
    assert(page.includes(color), color + ' is used for the card text');
    assert(ratio(color, '#fffaf3') >= 4.5, `${color} on the panel: ${ratio(color, '#fffaf3').toFixed(2)}`);
  }
});

test('a failed hosted load says "load", not "download"; a video that fails mid-set shows the retry screen', () => {
  assert.match(page, /const decoding = hostedSite \|\|/);
  assert.match(page, /engineQueue\.onFailure\(\(message\) => \{[\s\S]*?stopSet\(\)\.then\(\(\) => screens\.failed\(message\)\)/);
});

test('hosted page: one plain card note, meters follow the engine in use, songs YouTube cannot play are checked by the catalog', () => {
  assert.match(page, /const ytNote = "The video has to stay visible while the music plays\.";/);
  assert.doesNotMatch(page, /Mixes are cuts|the filter does nothing/);
  assert.match(page, /if \(queue\?\.hasEffects !== false\) \{[^\n]*\n\s*drawKnobMeter\("left"[^\n]*\n\s*drawKnobMeter\("right"/, 'the meters draw unless the engine in use has no effects');
  assert.match(page, /checkSong: catalog \? \(song\) => catalog\.queue\.isUnavailable\(song\.id\) : undefined/);
});

test('music credits: a hidden-by-default details with #8a4510 text, filled from the library songs that have an attribution', () => {
  assert.match(page, /<details id="credits" class="card glass credits" hidden>\s*<summary>Music credits<\/summary>/);
  assert.match(page, /\.credits \{[^}]*color: #8a4510/);
  assert.match(page, /\.credits\[hidden\] \{ display: none; \}/);
  assert.match(page, /showCredits\(songs\)/);
  for (const name of ['djStart.js', 'djGame.js', 'aiDeck.js']) assert.doesNotMatch(read(name), /Music credits|musicCredits/, name);
});

// ---- the start screens, hosted ----
function element() {
  let children = {}, html = '';
  return {
    isConnected: true, textContent: '', disabled: false, dataset: {},
    get innerHTML() { return html; }, set innerHTML(value) { html = value; children = {}; },
    classList: { toggle() {} }, append() {}, setAttribute() {}, remove() { this.isConnected = false; },
    listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, click() { this.listeners.click?.(); },
    querySelector(selector) { return (children[selector] ??= element()); },
    querySelectorAll() { return []; },
  };
}
const songs = [1, 2, 3].map((n) => ({ id: `s${n}`, title: `Title ${n}`, artist: 'A', bpm: 90, genre: 'pop' })); // no `available` flag: library.json has none
function screensFor({ youtube, prepare = () => {} }) {
  let stage = null;
  const box = {
    console, performance, setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: (fn) => setTimeout(fn, 16),
    localStorage: { getItem: () => JSON.stringify(['s1', 's2']), setItem() {} },
    document: { hidden: false, head: element(), createElement: element, getElementById: () => null },
  };
  vm.createContext(box);
  vm.runInContext(read('djStart.js').replace(/^export /mg, ''), box);
  const screens = vm.runInContext('createStartScreen', box)({ append(node) { stage = node; } }, {
    library: async () => songs, startCamera: async () => true, handSeen: () => false, prepare, begin() {},
    config: async () => ({ youtube }),
  });
  return { screens, root: () => stage };
}

test('hosted picker: no download badges or prefetch hint, and no blend/cut labels (a mix is just the next song)', async () => {
  const { root } = screensFor({ youtube: false });
  await flush();
  assert.doesNotMatch(root().innerHTML, /download|prefetch/i);
  const flow = root().querySelector('.djStart-flow').innerHTML;
  assert.match(flow, /djStart-then/);
  assert.doesNotMatch(flow, />blend<|>cut</);
});

test('local picker still labels close tempos as a blend', async () => {
  const { root } = screensFor({ youtube: true });
  await flush();
  assert.match(root().querySelector('.djStart-flow').innerHTML, />blend</);
});

test('screens.failed (a song that stopped working mid-set) shows the message with Try again and New set', async () => {
  let prepared = 0;
  const { screens, root } = screensFor({ youtube: false, prepare: () => { prepared += 1; } });
  await flush();
  root().querySelector('[data-play]').click(); // remembers the set
  await flush();
  screens.failed("Couldn't play Title 1: the video was removed or is private.");
  const html = root().innerHTML;
  assert.match(html, /Couldn&#39;t play Title 1: the video was removed or is private\./);
  assert.match(html, /data-retry/);
  assert.match(html, /data-new/);
  assert.doesNotMatch(html, /prefetch/);
  const before = prepared;
  root().querySelector('[data-retry]').click();
  await flush();
  assert.equal(prepared, before + 1, 'Try again loads the set again');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ok   ' + name); }
    catch (error) { console.error('FAIL ' + name); throw error; }
  }
  console.log(`PASS: ${tests.length} hosted AirMix page checks`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
