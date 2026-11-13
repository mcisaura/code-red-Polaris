// Hosted-audio "Now playing" card (#hostCard): shown with title/artist, blocked-autoplay Start button, same play/skip
// paths as the nav, hidden locally and in the YouTube fallback, error state, animation only while playing and visible.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const code = fs.readFileSync(__dirname + '/../landing.js', 'utf8');
const html = fs.readFileSync(__dirname + '/../landing.html', 'utf8');
const cut = (a, b) => { const i = code.indexOf(a), j = code.indexOf(b, i); assert(i >= 0 && j > i, 'marker ' + a); return code.slice(i, j); };
const playlist = cut('const PLAYLIST = [', '];\n') + '];';
const block = cut('  ensureAudio() {', '\n  // ---- Fallback: a small synthesized loop');

const SONGS = [
  { id: 'aaa111', artist: 'Artist A', title: 'Song A', hosted: true },
  { id: 'bbb-222', artist: 'Artist B', title: 'Song B', hosted: true },
  { id: 'yt0000', artist: 'Not hosted', title: 'Embed only' },
];
const HOSTED = { youtube: false, youtubeEmbed: true, hosted: true };

function setup(config, songs, opts = {}) {
  const els = new Map(), audios = [], rafs = new Map(), docLs = {}; let rafId = 0, draws = 0, getBytes = 0;
  const el = (id) => { if (!els.has(id)) els.set(id, { id, hidden: false, textContent: '', attrs: {}, ls: {}, style: {},
    setAttribute(k, v) { this.attrs[k] = v; }, toggleAttribute(k, on) { this.attrs[k] = on; }, classList: { add() {} },
    addEventListener(t, f) { (this.ls[t] ||= []).push(f); }, click() { (this.ls.click || []).forEach((f) => f()); },
    getContext: id === 'hostViz' ? () => ({ canvas: { width: 200, height: 120 }, createLinearGradient: () => ({ addColorStop() {} }), fillRect() { draws++; } }) : undefined }); return els.get(id); };
  class FakeAudio {
    constructor() { this.src = ''; this.paused = true; this.played = 0; this.currentTime = 65; this.duration = 200; this.ls = {}; audios.push(this); }
    addEventListener(t, f) { (this.ls[t] ||= []).push(f); } emit(t) { (this.ls[t] || []).forEach((f) => f()); }
    pause() { this.paused = true; } removeAttribute(k) { if (k === 'src') this.src = ''; }
    async play() { this.played++; if (opts.block && !opts.allowed) { const e = new Error('blocked'); e.name = 'NotAllowedError'; throw e; } this.paused = false; }
  }
  class FakeCtx { constructor() { this.state = 'running'; this.currentTime = 0; } resume() { return Promise.resolve(); } addEventListener() {}
    createAnalyser() { return { connect() {}, frequencyBinCount: 64, getByteFrequencyData(a) { getBytes++; a.fill(128); } }; } createGain() { return { gain: {}, connect() { return this; } }; }
    createMediaElementSource() { return { connect() {} }; } createDynamicsCompressor() { return { connect() { return this; } }; }
    createBuffer() { return { getChannelData: () => new Float32Array(4) }; } get destination() { return {}; } }
  const document = { getElementById: el, hidden: false, body: { classList: { add() {}, toggle(c, on) { this.last = [c, on]; } } },
    addEventListener(t, f) { (docLs[t] ||= []).push(f); } };
  const wl = new Map();
  const box = { console: { warn() {}, log() {} }, document, performance: { now: () => 100000 }, Math, Audio: FakeAudio, AudioContext: FakeCtx, Uint8Array, Float32Array, setTimeout, isFinite, String,
    requestAnimationFrame: (f) => { rafs.set(++rafId, f); return rafId; }, cancelAnimationFrame: (id) => rafs.delete(id),
    addEventListener(t, f, o) { (wl.get(t) || wl.set(t, []).get(t)).push({ f, capture: !!(o && o.capture) }); },
    removeEventListener(t, f) { wl.set(t, (wl.get(t) || []).filter((x) => x.f !== f)); },
    loadConfig: async () => config, loadLibrary: async () => songs, createYtEmbed: () => { throw new Error('no yt'); },
    MUSIC_VOLUME: 0.12, BPM: 112, fetch: async () => { throw new Error('no network'); } };
  vm.createContext(box);
  vm.runInContext(`${playlist}\nclass P { constructor() { this.playing = false; this.autoplayPending = true; this.src = 'music'; this.track = null; this.status = ''; this.trackPos = 0; this.loadToken = 0; this.fails = 0; this.bass = 0; this.rm = false; this.list = PLAYLIST; this.shuffleOrder(); }\nstartSynth() {} stopSynth() {} skipYt() { this.ytSkipped = (this.ytSkipped || 0) + 1; }\n${block}\n}\nglobalThis.P = P;`, box);
  const page = new box.P();
  const fire = (type, target = { closest: () => null }) => { for (const { f } of [...(wl.get(type) || [])]) f({ type, target }); };
  const raf = () => { const fs2 = [...rafs.values()]; rafs.clear(); fs2.forEach((f) => f()); };
  return { page, el, audios, fire, wl, document, docLs, rafs, raf, stats: () => ({ draws, getBytes }), play: (o) => Object.assign(opts, o) };
}
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const cur = (page) => page.list[page.order[page.trackPos % page.list.length]];

(async () => {
  // 1. Hosted audio playing: card shown, title/artist, play shows "Pause", skip visible, time, state.
  { const t = setup(HOSTED, SONGS), { page, el } = t;
    page.bindCard(); page.initMusic(); await tick();
    const song = cur(page);
    assert.equal(el('hostCard').hidden, false); assert.equal(el('hostCard').attrs['data-state'], 'playing');
    assert.equal(el('hostTrack').textContent, song.title); assert.equal(el('hostArtist').textContent, song.artist);
    assert.equal(el('hostStart').hidden, true); assert.equal(el('hostNote').hidden, true);
    assert.equal(el('hostPlay').attrs['aria-label'], 'Pause music'); assert.equal(el('hostSkip').hidden, false);
    assert.equal(el('hostTime').textContent, '1:05 / 3:20'); assert.equal(el('hostFill').style.width, '32.5%');
    // 2. Card buttons use the same paths as the nav: pause/resume (togglePlay), skip (skipMusic -> next track).
    el('hostPlay').click(); assert.equal(page.playing, false); assert.equal(el('hostCard').attrs['data-state'], 'paused'); assert.equal(el('hostPlay').attrs['aria-label'], 'Play music');
    el('hostPlay').click(); await tick(); assert.equal(page.playing, true); assert.equal(t.audios[0].paused, false);
    const before = page.trackPos; el('hostSkip').click(); await tick();
    assert.equal(page.trackPos, before + 1); assert.equal(el('hostTrack').textContent, cur(page).title); assert.equal(page.playing, true);
    // the nav skip handler and the card share skipMusic
    assert(/getElementById\("skip"\)\.addEventListener\("click", \(\) => this\.skipMusic\(\)\)/.test(code) && /on\("hostSkip", \(\) => this\.skipMusic\(\)\)/.test(code) && /on\("hostPlay", \(\) => this\.togglePlay\(\)\)/.test(code));
  }
  // 3. Blocked autoplay: card shown at once with the Start button and the one-line note; clicking Start plays once.
  { const t = setup(HOSTED, SONGS, { block: true }), { page, el, audios } = t;
    page.bindCard(); page.initMusic(); await tick();
    assert.equal(audios[0].played, 1, 'attempted at load'); assert.equal(page.playing, false);
    assert.equal(el('hostCard').hidden, false); assert.equal(el('hostCard').attrs['data-state'], 'blocked');
    assert.equal(el('hostStart').hidden, false); assert.equal(el('hostStart').attrs['aria-label'], undefined);
    assert.equal(el('hostNote').hidden, false);
    assert.equal(el('hostTrack').textContent, cur(page).title);
    assert.equal(el('hostControls').hidden, true);
    // pressing the card's buttons is not a "click anywhere" gesture: the button's own click does the start
    t.fire('pointerdown', { closest: (s) => (s.includes('#hostCard button') ? {} : null) }); await tick(); assert.equal(audios[0].played, 1);
    t.play({ allowed: true }); el('hostStart').click(); await tick();
    assert.equal(audios[0].played, 2, 'started once'); assert.equal(page.playing, true);
    assert.equal(el('hostCard').attrs['data-state'], 'playing'); assert.equal(el('hostStart').hidden, true); assert.equal(el('hostNote').hidden, true);
    el('hostStart').click(); t.fire('pointerdown'); t.fire('keydown'); await tick(); assert.equal(audios[0].played, 2, 'no second start');
    // clicking anywhere else also starts it and switches the card
    const u = setup(HOSTED, SONGS, { block: true }); u.page.bindCard(); u.page.initMusic(); await tick();
    u.play({ allowed: true }); u.fire('pointerdown'); await tick();
    assert.equal(u.audios[0].played, 2); assert.equal(u.el('hostCard').attrs['data-state'], 'playing'); assert.equal(u.el('hostStart').hidden, true);
  }
  // 4. Hidden locally and in the YouTube fallback (which keeps #ytCard); never both.
  { const t = setup({ youtube: true, youtubeEmbed: false, hosted: false }, SONGS), { page, el } = t;
    page.fetchTrack = (tr) => Promise.resolve('music/' + tr.id + '.m4a');
    page.bindCard(); page.initMusic(); await tick();
    assert.equal(el('hostCard').hidden, true, 'hidden locally');
  }
  for (const songs of [[SONGS[2]], []]) {
    const t = setup(HOSTED, songs), { page, el } = t;
    page.bindCard(); page.initMusic(); await tick();
    assert.equal(page.useYt, true); page.renderPlayer(); assert.equal(el('hostCard').hidden, true, 'hidden in the YouTube fallback');
  }
  assert(!/hostCard/.test(code.slice(code.indexOf('  ensureYt() {'), code.indexOf('  ytFailed(message)'))), 'YouTube code never touches the host card');
  // 5. Error state: "Songs could not be played", the play button is the retry.
  { const t = setup(HOSTED, SONGS), { page, el, audios } = t;
    page.bindCard(); page.initMusic(); await tick();
    for (let i = 0; i < 6; i++) { audios[0].emit('error'); await tick(); }
    assert.equal(page.playing, false);
    assert.equal(el('hostCard').hidden, false); assert.equal(el('hostCard').attrs['data-state'], 'error');
    assert.equal(el('hostTrack').textContent, 'Songs could not be played'); assert.equal(el('hostPlay').attrs['aria-label'], 'Retry playing music');
    assert.equal(el('hostStart').hidden, true); assert.equal(el('hostSkip').hidden, true); assert.equal(el('hostControls').hidden, false);
    el('hostPlay').click(); await tick();
    assert.equal(page.playing, true); assert.equal(el('hostCard').attrs['data-state'], 'playing'); assert.equal(audios[0].src, '/music/' + cur(page).id + '.m4a');
  }
  // 6. Animation: rAF loop only while playing and visible; stops on pause and when the tab is hidden; static under reduced motion.
  { const t = setup(HOSTED, SONGS), { page, el, document } = t;
    page.bindCard(); page.initMusic(); await tick();
    assert.equal(t.rafs.size, 1, 'one loop while playing'); const g0 = t.stats().getBytes; t.raf(); assert(t.stats().getBytes > g0, 'reads the analyser'); assert.equal(t.rafs.size, 1);
    page.togglePlay(); assert.equal(t.rafs.size, 0, 'loop stopped on pause');
    page.togglePlay(); await tick(); assert.equal(t.rafs.size, 1);
    document.hidden = true; t.raf(); assert.equal(t.rafs.size, 0, 'loop stops when the tab is hidden');
    document.hidden = false; t.docLs.visibilitychange.forEach((f) => f()); assert.equal(t.rafs.size, 1, 'resumes when visible');
    page.togglePlay(); const bytes = t.stats().getBytes; page.rm = true; page.togglePlay(); await tick();
    assert.equal(t.rafs.size, 0, 'no rAF loop under reduced motion'); assert.equal(t.stats().getBytes, bytes, 'static bars: analyser not read');
    assert(t.page.cardH != null, 'slow progress timer runs'); page.togglePlay(); assert.equal(page.cardH, null, 'timer stopped on pause');
  }
  // Markup and CSS: same spot and size as #ytCard, phone layout, accessible controls, contrast >= 4.5.
  assert(/#hostCard \{ position: fixed; right: 16px; bottom: 16px;[^}]*width: 224px/.test(html));
  assert(/@media \(max-width: 600px\) \{\s*#hostCard \{ right: 12px; left: 12px; bottom: 12px; margin: 0 auto; \}/.test(html));
  assert(/id="hostCard"[^>]*\bhidden\b/.test(html) && /id="hostStart"[^>]*aria-label="Start music"/.test(html) && /id="hostSkip"[^>]*aria-label="Next song"/.test(html) && /id="hostPlay"[^>]*aria-label="Play music"/.test(html));
  assert(/<canvas id="hostViz" width="200" height="120"/.test(html));
  const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
  for (const c of ['#8a4510', '#0b2f52', '#0d3557']) assert(ratio(c, '#ffffff') >= 4.5, c);
  console.log('PASS: landing hosted card (shown, blocked Start, play/skip, hidden local/YouTube, error, animation)');
})().catch((e) => { console.error(e); process.exitCode = 1; });
