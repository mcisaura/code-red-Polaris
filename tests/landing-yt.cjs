// Landing page music: hosted WITHOUT hosted songs plays the playlist through the YouTube embed (never music/*.m4a); local is unchanged.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const code = fs.readFileSync(__dirname + '/../landing.js', 'utf8');
const html = fs.readFileSync(__dirname + '/../landing.html', 'utf8');
const cut = (a, b) => { const i = code.indexOf(a), j = code.indexOf(b, i); assert(i >= 0 && j > i, 'marker ' + a); return code.slice(i, j); };
const playlist = cut('const PLAYLIST = [', '];\n') + '];';
const block = cut('  ensureAudio() {', '\n  // ---- Fallback: a small synthesized loop');
const IDS = [...playlist.matchAll(/id: "([^"]+)"/g)].map((m) => m[1]);
assert.equal(IDS.length, 10);

function stubEmbed() {
  const e = { loads: [], opts: [], playing: false, time: 0, stops: 0, plays: 0, pauses: 0, ended: new Set(), errors: new Set(), mountHidden: true,
    async load(id, o) { e.loads.push(id); e.opts.push(o); e.mountHidden = false; e.playing = true; },
    play() { e.plays++; e.playing = true; }, pause() { e.pauses++; e.playing = false; },
    stop() { e.stops++; e.playing = false; e.mountHidden = true; },
    isPlaying: () => e.playing, getTime: () => e.time, getDuration: () => 200,
    onEnded(cb) { e.ended.add(cb); }, onError(cb) { e.errors.add(cb); },
    end() { e.playing = false; e.ended.forEach((cb) => cb()); }, fail() { e.playing = false; e.errors.forEach((cb) => cb('blocked', 101)); } };
  return e;
}

function setup(config) {
  const els = new Map(), fetched = [], embed = stubEmbed(), audios = [];
  const el = (id) => { if (!els.has(id)) els.set(id, { id, hidden: false, textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, toggleAttribute(k, on) { this.attrs[k] = on; }, classList: { add() {} } }); return els.get(id); };
  class FakeAudio { constructor() { this.src = ''; audios.push(this); this.played = 0; } addEventListener() {} pause() {} async play() { this.played++; } }
  class FakeCtx { constructor() { this.state = 'running'; this.currentTime = 0; } resume() { return Promise.resolve(); } addEventListener() {}
    createAnalyser() { return { connect() {}, frequencyBinCount: 4 }; } createGain() { return { gain: {}, connect() { return this; } }; }
    createMediaElementSource() { return { connect() {} }; } createDynamicsCompressor() { return { connect() { return this; } }; }
    createBuffer() { return { getChannelData: () => new Float32Array(4) }; } get destination() { return {}; } }
  const box = { console: { warn() {}, log() {} }, document: { getElementById: el, body: { classList: { add() {} } } }, performance: { now: () => 100000 }, Math, Audio: FakeAudio, AudioContext: FakeCtx, Uint8Array, Float32Array,
    loadConfig: async () => config, loadLibrary: async () => [], addEventListener() {}, removeEventListener() {}, setTimeout, createYtEmbed: () => embed, MUSIC_VOLUME: 0.12, BPM: 112,
    fetch: async (url, opts) => { fetched.push(String(url)); return { ok: false, status: 404, json: async () => null }; } };
  vm.createContext(box);
  vm.runInContext(`${playlist}\nclass P { constructor() { this.playing = false; this.autoplayPending = true; this.src = 'music'; this.track = null; this.status = ''; this.trackPos = 0; this.loadToken = 0; this.fails = 0; this.bass = 0; this.list = PLAYLIST; this.order = PLAYLIST.map((_, i) => i); }\nstartSynth() {} stopSynth() {}\n${block}\n}\nglobalThis.P = P;`, box);
  const page = new box.P();
  page.rm = false;
  return { page, embed, fetched, els, audios, el };
}
const tick = () => new Promise((r) => setImmediate(r));
const HOSTED = { youtube: false, youtubeEmbed: true, hosted: true };

(async () => {
  // Hosted: nothing plays or loads before a click; the click starts track 1 through the embed; no m4a request.
  { const { page, embed, fetched, el } = setup(HOSTED);
    page.initMusic(); await tick();
    assert.equal(page.useYt, true);
    assert.equal(embed.loads.length, 0, 'no autoplay without a gesture');
    assert.equal(el('playSub').textContent, 'Click anywhere for quiet music');
    page.startBackgroundMusic(true); await tick();
    assert.deepEqual(embed.loads, [IDS[0]]);
    assert.equal(embed.opts[0].volume, 0.12);
    assert.equal(page.playing, true);
    assert.equal(el('playLabel').textContent, 'New Look (Wii U Mii Maker Lofi Mix)');
    assert.equal(el('npTrack').textContent, 'New Look (Wii U Mii Maker Lofi Mix) · Secret Potion');
    assert.equal(el('skip').hidden, false);
    // advance on ended, skip button, prev wraps through the playlist order
    embed.end(); await tick(); assert.equal(embed.loads[1], IDS[1]);
    page.skipYt(); await tick(); assert.equal(embed.loads[2], IDS[2]);
    // pause / play use the embed
    page.togglePlay(); assert.equal(embed.pauses, 1); assert.equal(page.playing, false);
    assert.equal(embed.mountHidden, false, 'card stays visible while paused');
    page.togglePlay(); assert.equal(embed.plays, 1); assert.equal(page.playing, true);
    // a click that races config loading still starts the music
    assert(!fetched.some((u) => /music\/|\.m4a|\/api\/youtube$/.test(u)), 'hosted never requests audio files: ' + fetched);
  }
  // A click before the config arrives is remembered
  { const { page, embed } = setup(HOSTED);
    page.startBackgroundMusic(true); assert.equal(embed.loads.length, 0);
    page.initMusic(); await tick(); assert.equal(embed.loads.length, 1);
  }
  // A failed video is skipped once; a full failed pass stops
  { const { page, embed, el } = setup(HOSTED);
    page.initMusic(); await tick(); page.startBackgroundMusic(true); await tick();
    embed.fail(); await tick(); assert.deepEqual(embed.loads, [IDS[0], IDS[1]], 'skips to the next song');
    embed.fail(); embed.fail(); await tick();  // a duplicate error for the same video must not skip twice
    assert.deepEqual(embed.loads, [IDS[0], IDS[1], IDS[2]]);
    for (let i = 0; i < 20; i++) { embed.fail(); await tick(); }
    assert.equal(embed.loads.length, 10, 'each song tried once, then stop');
    assert.equal(page.playing, false); assert.equal(embed.stops, 1);
    assert.equal(el('playSub').textContent, 'Songs could not be played');
    // after real playback the failure count resets
    page.togglePlay(); await tick(); assert.equal(embed.loads.length, 11);
    page.ytTick(100000); assert.equal(page.fails, 0);
  }
  // A load that rejects (YouTube script blocked) counts as an error too
  { const { page, embed } = setup(HOSTED);
    let n = 0; embed.load = async (id) => { embed.loads.push(id); n++; throw new Error('blocked'); };
    page.initMusic(); await tick(); page.startBackgroundMusic(true);
    for (let i = 0; i < 30; i++) await tick();
    assert.equal(n, 10); assert.equal(page.playing, false);
  }
  // Blocked autoplay: the card's own play button is the fallback, and the status says so
  { const { page, embed, el } = setup(HOSTED);
    page.initMusic(); await tick(); page.startBackgroundMusic(true); await tick();
    embed.playing = false; page.ytTick(100000 + 5000);
    assert.equal(el('playSub').textContent, 'Press play in the player');
    assert.equal(embed.mountHidden, false);
  }
  // Pulse: gentle, at the song's bpm, only while the embed plays
  { const { page, embed } = setup(HOSTED);
    page.initMusic(); await tick(); page.startBackgroundMusic(true); await tick();
    let beats = 0; const period = 60 / 112;
    for (let t = 0; t < 10; t += 1 / 60) { embed.time = t; if (page.ytPulse(100000, 1 / 60)) beats++; assert(page.bass <= 0.25); }
    assert(Math.abs(beats - Math.floor(10 / period)) <= 1, 'beats ' + beats);
    embed.playing = false; page.ytPulse(100000, 1); assert(page.bass < 0.2);
  }
  // The card is never hidden while playing: ytEmbed's only hide is stop(); the landing page never touches visibility
  assert(!/ytCard[^{]*\{[^}]*(opacity|visibility|clip|left:\s*-|top:\s*-|display:\s*none)/.test(html.replace(/#ytCard \.ytCard-(title|note)[^}]*\}/, '')), 'card css hides the player');
  assert(!/ytCard"\)\.(hidden|style)/.test(code) && !/#ytCard[^{]*\{[^}]*z-index:\s*-/.test(html));
  assert(/width: 204px/.test(html) && /min-width: 0/.test(html), 'frame >= 200 wide');
  // Local: file path, no embed, no config-driven change
  { const { page, embed, fetched, audios } = setup({ youtube: true, youtubeEmbed: false, hosted: false });
    page.initMusic(); await tick(); await tick();
    assert.equal(page.useYt, false); assert.equal(embed.loads.length, 0);
    assert(fetched.some((u) => u === 'music/' + IDS[0] + '.m4a'), 'local asks for music/<id>.m4a: ' + fetched);
    assert(!code.includes('err.unavailable'));
  }
  { const fetched = [], { page } = setup({ youtube: true, youtubeEmbed: false, hosted: false });
    page.fetchTrack = function (tr) { return Promise.resolve('music/' + tr.id + '.m4a'); };
    page.initMusic(); await tick(); await tick(); await tick();
    assert.equal(page.audio.src, 'music/' + IDS[0] + '.m4a'); assert.equal(page.audio.played, 1);
  }
  console.log('PASS: landing music (hosted YouTube embed, local files)');
})().catch((e) => { console.error(e); process.exitCode = 1; });
