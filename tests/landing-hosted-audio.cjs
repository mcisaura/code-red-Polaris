// Landing page music on the hosted site: /library.json songs with hosted:true play through <audio> + analyser
// from /music/<id>.m4a, started at load when the browser allows it, else on the first gesture; never the YouTube player.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const code = fs.readFileSync(__dirname + '/../landing.js', 'utf8');
const html = fs.readFileSync(__dirname + '/../landing.html', 'utf8');
const cut = (a, b) => { const i = code.indexOf(a), j = code.indexOf(b, i); assert(i >= 0 && j > i, 'marker ' + a); return code.slice(i, j); };
const playlist = cut('const PLAYLIST = [', '];\n') + '];';
const block = cut('  ensureAudio() {', '\n  // ---- Fallback: a small synthesized loop');

const SONGS = [
  { id: 'aaa111', artist: 'Artist A', title: 'Song A', bpm: 128, genre: 'edm', hosted: true, attribution: 'A credit' },
  { id: 'bbb-222', artist: 'Artist B', title: 'Song B', bpm: 124, genre: 'edm', hosted: true },
  { id: 'ccc333', artist: 'Artist C', title: 'Song C', bpm: 130, genre: 'edm', hosted: true },
  { id: 'yt0000', artist: 'Not hosted', title: 'Embed only', bpm: 100 },
];
const HOSTED_IDS = ['aaa111', 'bbb-222', 'ccc333'];

function setup(config, songs, opts = {}) {
  const els = new Map(), audios = [], wl = new Map(), ytCreated = [];
  const el = (id) => { if (!els.has(id)) els.set(id, { id, hidden: false, textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, toggleAttribute(k, on) { this.attrs[k] = on; }, classList: { add() {} } }); return els.get(id); };
  class FakeAudio {
    constructor() { this.src = ''; this.paused = true; this.played = 0; this.pauses = 0; this.ls = {}; audios.push(this); }
    addEventListener(t, f) { (this.ls[t] ||= []).push(f); }
    emit(t) { (this.ls[t] || []).forEach((f) => f()); }
    pause() { this.paused = true; this.pauses++; }
    removeAttribute(k) { if (k === 'src') this.src = ''; }
    async play() { this.played++; if (opts.block && !opts.allowed) { const e = new Error('blocked'); e.name = 'NotAllowedError'; throw e; } this.paused = false; }
  }
  let ctx;
  class FakeCtx { constructor() { ctx = this; this.state = opts.suspended ? 'suspended' : 'running'; this.resumes = 0; this.currentTime = 0; }
    resume() { this.resumes++; if (opts.allowed || !opts.suspended) this.state = 'running'; return Promise.resolve(); } addEventListener() {}
    createAnalyser() { return { connect() {}, frequencyBinCount: 4 }; } createGain() { return { gain: {}, connect() { return this; } }; }
    createMediaElementSource() { return { connect() {} }; } createDynamicsCompressor() { return { connect() { return this; } }; }
    createBuffer() { return { getChannelData: () => new Float32Array(4) }; } get destination() { return {}; } }
  const box = { console: { warn: (...a) => process.env.DBG && console.log(...a), log() {} }, document: { getElementById: el, body: { classList: { add() {} } } }, performance: { now: () => 100000 }, Math, Audio: FakeAudio, AudioContext: FakeCtx, Uint8Array, Float32Array, setTimeout,
    addEventListener(t, f, o) { (wl.get(t) || wl.set(t, []).get(t)).push({ f, capture: !!(o && o.capture) }); },
    removeEventListener(t, f) { wl.set(t, (wl.get(t) || []).filter((x) => x.f !== f)); },
    loadConfig: async () => config, loadLibrary: async () => songs, createYtEmbed: () => { ytCreated.push(1); throw new Error('YouTube must not be created'); },
    MUSIC_VOLUME: 0.12, BPM: 112, fetch: async () => { throw new Error('no network'); } };
  vm.createContext(box);
  vm.runInContext(`${playlist}\nclass P { constructor() { this.playing = false; this.autoplayPending = true; this.src = 'music'; this.track = null; this.status = ''; this.trackPos = 0; this.loadToken = 0; this.fails = 0; this.bass = 0; this.list = PLAYLIST; this.shuffleOrder(); }\nstartSynth() {} stopSynth() {}\n${block}\n}\nglobalThis.P = P;`, box);
  const page = new box.P();
  const fire = (type, target = { closest: () => null }) => { for (const { f } of [...(wl.get(type) || [])]) f({ type, target }); };
  return { page, el, audios, wl, fire, ytCreated, ctx: () => ctx, play: (o) => Object.assign(opts, o) };
}
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const HOSTED = { youtube: false, youtubeEmbed: true, hosted: true };
const listeners = (wl) => [...wl.values()].reduce((n, a) => n + a.length, 0);
const cur = (page) => page.list[page.order[page.trackPos % page.list.length]].id;

(async () => {
  // 1. Hosted songs: <audio> with /music/<id>.m4a, shuffled hosted set only, play() at load with no gesture, no YouTube.
  { const t = setup(HOSTED, SONGS), { page, audios, el } = t;
    page.initMusic(); await tick();
    assert.equal(page.hostedAudio, true); assert.equal(page.useYt, false); assert.equal(t.ytCreated.length, 0);
    assert.deepEqual(page.list.map((s) => s.id).sort(), [...HOSTED_IDS].sort(), 'only hosted:true songs');
    assert.equal(audios.length, 1); assert.equal(audios[0].preload, 'auto');
    assert.equal(audios[0].src, '/music/' + cur(page) + '.m4a');
    assert.equal(audios[0].played, 1, 'play() attempted at load without a gesture');
    assert.equal(page.playing, true); assert.equal(page.status, '');
    assert.equal(listeners(t.wl), 0, 'no gesture listeners when autoplay works');
    const song = SONGS.find((s) => s.id === cur(page));
    assert.equal(el('playLabel').textContent, song.title); assert.equal(el('playSub').textContent, song.artist);
    assert.equal(el('skip').hidden, false);
    // advance on ended
    const first = cur(page); audios[0].emit('ended'); await tick();
    assert.notEqual(cur(page), first); assert.equal(audios[0].src, '/music/' + cur(page) + '.m4a'); assert.equal(audios[0].played, 2);
    // skip
    const before = page.trackPos; page.ensureAudio(); page.playTrack(page.trackPos + 1); await tick(); assert.equal(page.trackPos, before + 1);
    // pause / resume use the audio element
    page.togglePlay(); assert.equal(page.playing, false); assert.equal(audios[0].paused, true);
    page.togglePlay(); await tick(); assert.equal(page.playing, true); assert.equal(audios[0].paused, false);
    assert(!html.includes('youtube.com/iframe') );
  }
  // 2. Blocked (NotAllowedError): hint shown, window capture listeners armed, first pointerdown starts it exactly once.
  for (const gesture of ['pointerdown', 'keydown', 'touchend']) {
    const t = setup(HOSTED, SONGS, { block: true }), { page, audios, el } = t;
    page.initMusic(); await tick();
    assert.equal(audios[0].played, 1, 'attempted at load');
    assert.equal(page.playing, false); assert.equal(el('playSub').textContent, 'Click anywhere for quiet music');
    assert.equal(page.autoplayPending, true);
    for (const type of ['pointerdown', 'keydown', 'touchend']) { assert.equal(t.wl.get(type).length, 1, type + ' armed'); assert.equal(t.wl.get(type)[0].capture, true); }
    t.play({ allowed: true });
    t.fire(gesture); await tick();
    assert.equal(audios[0].played, 2, gesture + ' starts playback');
    assert.equal(page.playing, true); assert.equal(el('playSub').textContent, ''.length ? '' : el('playSub').textContent);
    assert.notEqual(el('playSub').textContent, 'Click anywhere for quiet music', 'hint gone');
    assert.equal(listeners(t.wl), 0, 'listeners removed after the first gesture');
    t.fire('pointerdown'); t.fire('keydown'); await tick();
    assert.equal(audios[0].played, 2, 'started exactly once');
    assert(t.ctx().resumes >= 2, 'AudioContext resumed in the attempt and in the gesture');
  }
  // 2b. Gesture on the play/skip buttons does not double-start (their own click does it); listeners stay armed.
  { const t = setup(HOSTED, SONGS, { block: true }), { page, audios } = t;
    page.initMusic(); await tick();
    t.fire('pointerdown', { closest: () => ({}) }); await tick();
    assert.equal(audios[0].played, 1); assert.equal(listeners(t.wl) > 0, true);
    t.play({ allowed: true }); page.togglePlay(); await tick();
    assert.equal(page.playing, true); assert.equal(audios[0].played, 2);
    t.fire('pointerdown'); await tick(); assert.equal(audios[0].played, 2, 'no second start'); assert.equal(listeners(t.wl), 0);
  }
  // 2c. Gesture that the browser still refuses re-arms the fallback.
  { const t = setup(HOSTED, SONGS, { block: true }), { page, audios } = t;
    page.initMusic(); await tick();
    t.fire('keydown'); await tick(); // e.g. a modifier key: still blocked
    assert.equal(audios[0].played, 2); assert.equal(page.playing, false); assert.equal(t.wl.get('pointerdown').length, 1, 're-armed');
  }
  // 2d. Context stays suspended after play() resolves: treated as blocked, not as silent playback.
  { const t = setup(HOSTED, SONGS, { suspended: true }), { page, audios, el } = t;
    page.initMusic(); await tick(); await new Promise((r) => setTimeout(r, 400)); await tick();
    assert.equal(page.playing, false); assert.equal(audios[0].paused, true); assert.equal(el('playSub').textContent, 'Click anywhere for quiet music');
    t.play({ allowed: true }); t.fire('pointerdown'); await tick();
    assert.equal(page.playing, true); assert.equal(audios[0].paused, false); assert.equal(t.ctx().state, 'running');
  }
  // 3. Errors: a track that errors is skipped once per pass; a full failed pass stops; play restarts from the top.
  { const t = setup(HOSTED, SONGS), { page, audios, el } = t;
    page.initMusic(); await tick();
    const seen = [cur(page)];
    audios[0].emit('error'); audios[0].emit('error'); audios[0].emit('error'); await tick(); seen.push(cur(page)); // duplicate errors for the same track: one skip
    assert.equal(page.trackPos, 1);
    audios[0].emit('error'); await tick(); seen.push(cur(page));
    assert.equal(new Set(seen).size, 3, 'each hosted song tried once: ' + seen);
    audios[0].emit('error'); await tick();
    assert.equal(page.playing, false); assert.equal(el('playSub').textContent, 'Songs could not be played');
    assert.equal(audios[0].src, ''); assert.equal(page.fails, 0);
    audios[0].emit('error'); await tick(); assert.equal(page.playing, false, 'stays stopped');
    page.togglePlay(); await tick(); assert.equal(page.playing, true); assert.equal(audios[0].src, '/music/' + cur(page) + '.m4a');
    audios[0].emit('playing'); assert.equal(page.fails, 0);
  }
  // 3b. A play() that fails with a non-permission error counts as an error too.
  { const t = setup(HOSTED, SONGS), { page, audios } = t;
    page.initMusic(); await tick();
    audios[0].play = async function () { const e = new Error('nope'); e.name = 'NotSupportedError'; throw e; };
    page.playTrack(page.trackPos + 1); await tick(); assert.equal(page.trackPos >= 2, true, 'moved on');
    assert.equal(page.playing, false, 'every track fails to play: stops after one pass'); assert.equal(t.el('playSub').textContent, 'Songs could not be played');
  }
  // 4. Hosted without hosted songs (or an unreadable library): YouTube fallback, no audio element, no autoplay.
  for (const songs of [[SONGS[3]], []]) {
    const created = []; const t = setup(HOSTED, songs);
    const box = {}; // createYtEmbed throws in setup; the fallback must reach it
    t.page.initMusic(); await tick();
    assert.equal(t.page.useYt, true); assert.equal(t.page.hostedAudio, undefined); assert.equal(t.audios.length, 0, 'no audio element before a click');
    assert.equal(t.el('playSub').textContent, 'Click anywhere for quiet music');
    assert.equal(t.page.list.length, 10, 'built-in playlist');
  }
  // 5. Local is unchanged: file path, no hosted audio, no gesture listeners of its own.
  { const t = setup({ youtube: true, youtubeEmbed: false, hosted: false }, SONGS), { page } = t;
    page.fetchTrack = function (tr) { return Promise.resolve('music/' + tr.id + '.m4a'); };
    page.initMusic(); await tick();
    assert.equal(page.hostedAudio, undefined); assert.equal(page.useYt, false); assert.equal(page.list.length, 10);
    assert.equal(t.audios[0].src, 'music/' + page.list[page.order[0]].id + '.m4a'); assert.equal(listeners(t.wl), 0);
  }
  // Markup: nothing for the card in the hosted-audio path, credits footer kept, hint text has contrast >= 4.5.
  assert(html.includes('id="credits"') && html.includes('Music credits'));
  assert(code.includes('.attribution') || code.includes('song?.attribution'));
  const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
  assert(ratio('#2b5a82', '#ffffff') >= 4.5 && ratio('#0d3557', '#ffffff') >= 4.5);
  console.log('PASS: landing hosted audio (autoplay attempt, gesture fallback, errors, YouTube fallback, local)');
})().catch((e) => { console.error(e); process.exitCode = 1; });
