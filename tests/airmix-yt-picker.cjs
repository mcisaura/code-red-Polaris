// AirMix's hosted picker and intro (djStart.js): songs YouTube can't play are checked up front (four at a time),
// greyed with "Not available on YouTube" and unselectable; a failed check (network error) leaves a song pickable;
// the hosted intro and the set line describe what really happens (no slide, blend or filter wording).
// Run: node tests/airmix-yt-picker.cjs
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const source = fs.readFileSync(__dirname + '/../djStart.js', 'utf8').replace(/^export /mg, '');
const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const songs = Array.from({ length: 8 }, (_, i) => ({ id: `s${i + 1}`, title: `Title ${i + 1}`, artist: 'A', bpm: 90, genre: 'pop' }));

// A DOM where each innerHTML write makes fresh children; the picker's song rows are real objects.
function element() {
  let children = {}, html = '';
  const node = {
    isConnected: true, textContent: '', disabled: false, hidden: false, dataset: {}, attributes: {}, classes: new Set(),
    get innerHTML() { return html; }, set innerHTML(value) { html = value; children = {}; node.rows = null; },
    classList: { toggle(name, on) { on ? node.classes.add(name) : node.classes.delete(name); } },
    append() {}, setAttribute(name, value) { node.attributes[name] = value; }, remove() { node.isConnected = false; },
    listeners: {}, addEventListener(type, fn) { node.listeners[type] = fn; }, click(event) { node.listeners.click?.(event); },
    querySelector(selector) { return (children[selector] ??= element()); },
    querySelectorAll(selector) {
      if (selector !== '[data-id]') return [];
      node.rows ??= [...html.matchAll(/data-id="([^"]+)"/g)].map((match) => {
        const row = element();
        row.dataset = { id: match[1] };
        row.closest = () => row;
        return row;
      });
      return node.rows;
    },
  };
  return node;
}

function picker({ checkSong, youtube = false, prepare = () => {}, saved = ['s1', 's2'] }) {
  let stage = null;
  const box = {
    console, performance, setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: (fn) => setTimeout(fn, 16),
    localStorage: { getItem: () => JSON.stringify(saved), setItem() {} },
    document: { hidden: false, head: element(), createElement: element, getElementById: () => null },
  };
  vm.createContext(box);
  vm.runInContext(source, box);
  const screens = vm.runInContext('createStartScreen', box)({ append(node) { stage = node; } }, {
    library: async () => songs, startCamera: async () => true, handSeen: () => false, prepare, begin() {},
    config: async () => ({ youtube }), checkSong,
  });
  return { screens, root: () => stage };
}
const rowOf = (root, id) => root().querySelectorAll('[data-id]').find((row) => row.dataset.id === id);
const pick = (root, id) => { const row = rowOf(root, id); root().querySelector('.djStart-songs').click({ target: { closest: () => row } }); };

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('songs are checked up front, four at a time; a gone song is greyed, marked and unselectable', async () => {
  let inFlight = 0, peak = 0;
  const waiting = [];
  const checkSong = (song) => new Promise((resolve) => {
    inFlight += 1; peak = Math.max(peak, inFlight);
    waiting.push(() => { inFlight -= 1; resolve(song.id === 's2'); });
  });
  const { root } = picker({ checkSong });
  await flush();
  assert.equal(waiting.length, 4, 'four checks start at once, the rest wait');
  while (waiting.length) { waiting.shift()(); await flush(); }
  assert.equal(peak, 4, 'never more than four in flight');
  const gone = rowOf(root, 's2');
  assert.equal(gone.disabled, true);
  assert.equal(gone.attributes['aria-disabled'], 'true');
  assert(gone.classes.has('gone'));
  assert.equal(gone.querySelector('.djStart-na').hidden, false, 'its "Not available on YouTube" note shows');
  assert.match(root().innerHTML, /Not available on YouTube/);
  assert.equal(rowOf(root, 's3').disabled, false);
  assert.equal(rowOf(root, 's3').querySelector('.djStart-na').hidden, true, 'the others carry no note');
});

test('an unavailable song cannot be picked, and one picked earlier (a saved set) is dropped', async () => {
  const { root } = picker({ checkSong: async (song) => song.id === 's2' || song.id === 's3' });
  await flush();
  assert.equal(rowOf(root, 's2').attributes['aria-selected'], 'false', 'the saved set\'s s2 was dropped');
  assert.equal(rowOf(root, 's1').attributes['aria-selected'], 'true', 's1 stays');
  pick(root, 's3');
  assert.equal(rowOf(root, 's3').attributes['aria-selected'], 'false', 'clicking a greyed song does nothing');
  pick(root, 's4');
  assert.equal(rowOf(root, 's4').attributes['aria-selected'], 'true', 'others pick as usual');
});

test('a failed check (network error, a thrown error) does not mark a song unavailable', async () => {
  const { root } = picker({ checkSong: async (song) => { if (song.id === 's1') throw new Error('offline'); return false; } });
  await flush();
  assert.equal(rowOf(root, 's1').disabled, false);
  assert.equal(rowOf(root, 's1').attributes['aria-selected'], 'true');
  assert.equal(root().querySelector('[data-play]').disabled, false);
});

test('without a checkSong (local) nothing is checked or greyed', async () => {
  const { root } = picker({ youtube: true });
  await flush();
  assert(rowOf(root, 's1') && !rowOf(root, 's1').classes.has('gone'));
});

test('the checks stop when the set is on its way: a late "gone" answer does not touch the next screen', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { root } = picker({ checkSong: async () => { await gate; return true; } });
  await flush();
  root().querySelector('[data-play]').click();
  await flush();
  release(); await flush();
  assert.doesNotMatch(root().innerHTML, /djStart-songs/);
});

test('hosted intro: no slide/blend/filter wording and two moves; local intro keeps the slide', async () => {
  const hosted = picker({ youtube: false });
  await flush();
  hosted.root().querySelector('[data-play]').click();
  await flush();
  const html = hosted.root().innerHTML;
  assert.match(html, /Hit the orange shape: the next song comes in/);
  assert.match(html, /djStart-moves two/);
  assert.doesNotMatch(html, /slide|blend|filter|slams/i);
  assert.equal((html.match(/<li>/g) || []).length, 2);
  const local = picker({ youtube: true });
  await flush();
  local.root().querySelector('[data-play]').click();
  await flush();
  assert.match(local.root().innerHTML, /Slide along the track to mix the next song in/);
  assert.equal((local.root().innerHTML.match(/<li>/g) || []).length, 3);
});

test('hosted set line: songs in order with a plain arrow between them, no blend/cut labels', async () => {
  const { root } = picker({ youtube: false });
  await flush();
  const flow = root().querySelector('.djStart-flow').innerHTML;
  assert.match(flow, /Title 1<\/span><span class="djStart-then"[^>]*>›<\/span><span>Title 2/);
  assert.doesNotMatch(flow, /blend|cut|slide|filter/i);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ok   ' + name); }
    catch (error) { console.error('FAIL ' + name); throw error; }
  }
  console.log(`PASS: ${tests.length} hosted AirMix picker checks`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
