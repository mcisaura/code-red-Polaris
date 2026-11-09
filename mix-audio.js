// AirDeck two-deck mixer: audio graph, tempo detection, demo loops.
//
// engine (AudioWorklet: playback, sync, scratch — see mix-worklet.js)
//   → per deck: high-pass → low-pass → fader → level meter → bus → limiter → analyser → speakers

const RAMP = 0.03;               // seconds; smooths parameter changes so they never click
const LPF_MIN = 200;             // filter knob fully left (Hz)
const HPF_MAX = 4000;            // filter knob fully right (Hz)
const FILTER_Q = 1.4;            // a little resonance, like a DJ mixer filter

export class Mixer {
  constructor() {
    this.ctx = null;
    this.decks = [0, 1].map((k) => ({
      name: "", bpm: 0, loaded: false, playing: false,
      fader: k === 0 ? 0.85 : 0, filter: 0, pos: 0, rate: 0, level: 0,
    }));
    this.masterBpm = 0;
    this.clock = { beat: 0, time: 0 };
  }

  // Must be called from a click handler the first time (browser autoplay rules).
  async init() {
    if (this.ready) return this.ready;
    const ctx = (this.ctx = new AudioContext({ latencyHint: "interactive" }));
    this.ready = (async () => {
      await ctx.audioWorklet.addModule(new URL("./mix-worklet.js", import.meta.url));
      this.engine = new AudioWorkletNode(ctx, "mix-engine", {
        numberOfInputs: 0, numberOfOutputs: 2, outputChannelCount: [2, 2],
      });
      this.engine.port.onmessage = (e) => this.onEngine(e.data);

      this.bus = ctx.createGain();
      this.limiter = ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -6;
      this.limiter.knee.value = 6;
      this.limiter.ratio.value = 12;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.15;
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.5;
      this.bus.connect(this.limiter).connect(this.analyser).connect(ctx.destination);
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);

      this.decks.forEach((d, k) => {
        d.hpf = biquad(ctx, "highpass", 20, FILTER_Q);
        d.lpf = biquad(ctx, "lowpass", 20000, FILTER_Q);
        d.gain = ctx.createGain();
        d.gain.gain.value = faderGain(d.fader);
        d.meter = ctx.createAnalyser();
        d.meter.fftSize = 512;
        d.meterData = new Float32Array(512);
        this.engine.connect(d.hpf, k);
        d.hpf.connect(d.lpf).connect(d.gain).connect(this.bus);
        d.gain.connect(d.meter);
      });
    })();
    return this.ready;
  }

  onEngine(m) {
    this.clock = { beat: m.beat, time: m.time };
    m.decks.forEach((s, k) => { this.decks[k].pos = s.pos; this.decks[k].rate = s.rate; });
  }

  // ---- Beat clock ----------------------------------------------------------
  beatAt(t) {
    if (!this.masterBpm) return 0;
    return this.clock.beat + ((t - this.clock.time) * this.masterBpm) / 60;
  }
  timeOfBeat(b) { return this.clock.time + ((b - this.clock.beat) * 60) / this.masterBpm; }
  now() { return this.ctx ? this.ctx.currentTime : 0; }
  // The beat you are hearing right now (what's playing lags the render clock).
  heardBeat() {
    if (!this.ctx) return 0;
    return this.beatAt(this.ctx.currentTime - (this.ctx.outputLatency || 0) - this.ctx.baseLatency);
  }
  anyPlaying() { return this.decks.some((d) => d.playing); }

  // ---- Decks -----------------------------------------------------------------
  async loadArrayBuffer(k, data, name) {
    await this.init();
    return this.loadBuffer(k, await this.ctx.decodeAudioData(data), name);
  }

  loadBuffer(k, buffer, name, tempo = analyzeTempo(buffer)) {
    const d = this.decks[k];
    const L = buffer.getChannelData(0).slice();
    const R = (buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : buffer.getChannelData(0)).slice();
    this.engine.port.postMessage({ type: "load", deck: k, L, R, bpm: tempo.bpm, first: tempo.first }, [L.buffer, R.buffer]);
    Object.assign(d, { name, bpm: tempo.bpm, loaded: true, playing: false });
    // Deck A sets the master tempo; deck B follows it (until A is loaded)
    this.masterBpm = this.decks[0].loaded ? this.decks[0].bpm : this.decks[1].bpm;
    this.engine.port.postMessage({ type: "master", bpm: this.masterBpm });
    return tempo;
  }

  play(k) {
    const d = this.decks[k];
    if (!d.loaded) return;
    this.ctx.resume();
    this.engine.port.postMessage({ type: "play", deck: k });
    d.playing = true;
  }
  pause(k) {
    this.engine.port.postMessage({ type: "pause", deck: k });
    this.decks[k].playing = false;
  }
  toggle(k) { this.decks[k].playing ? this.pause(k) : this.play(k); }

  // Channel fader, 0–1
  setFader(k, v) {
    const d = this.decks[k];
    d.fader = v;
    if (this.ctx) d.gain.gain.setTargetAtTime(faderGain(v), this.ctx.currentTime, RAMP);
  }

  // DJ filter knob, -1…1: left = low-pass (muffled), centre = off, right = high-pass (thin)
  setFilter(k, v) {
    const d = this.decks[k];
    d.filter = v;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const lp = v < 0 ? 20000 * Math.pow(LPF_MIN / 20000, -v) : 20000;
    const hp = v > 0 ? 20 * Math.pow(HPF_MAX / 20, v) : 20;
    d.lpf.frequency.setTargetAtTime(lp, t, RAMP);
    d.hpf.frequency.setTargetAtTime(hp, t, RAMP);
  }

  // Hand on the record. rate = playback speed (negative = backwards, 0 = held still).
  scratch(k, active, rate = 0) {
    if (!this.engine) return;
    this.engine.port.postMessage({ type: "scratch", deck: k, active, rate });
  }

  // ---- Levels (for visuals) ------------------------------------------------------
  // Bass energy 0–1 of the master output (roughly 20–150 Hz)
  bass() {
    if (!this.analyser) return 0;
    this.analyser.getByteFrequencyData(this.freq);
    const hz = this.ctx.sampleRate / this.analyser.fftSize;
    const lo = Math.max(1, Math.floor(20 / hz)), hi = Math.ceil(150 / hz);
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += this.freq[i];
    return sum / ((hi - lo + 1) * 255);
  }
  // RMS level of each deck after its fader, 0–~1
  levels() {
    return this.decks.map((d) => {
      if (!d.meter) return 0;
      d.meter.getFloatTimeDomainData(d.meterData);
      let s = 0;
      for (const x of d.meterData) s += x * x;
      return Math.min(1, Math.sqrt(s / d.meterData.length) * 5);
    });
  }
}

// ---- Helpers -----------------------------------------------------------------------
function biquad(ctx, type, freq, q) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

// Fader position → gain. Squared, so the top of the fader travel is where it gets loud,
// like a real channel fader.
const faderGain = (v) => v * v;

function noiseBuffer(ctx, seconds) {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

// Simple envelope: attack to `peak` then exponential decay
function env(param, t, peak, decay, attack = 0.002) {
  param.setValueAtTime(0.0001, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function kick(ctx, dest, t, vel = 1) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.setValueAtTime(150, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
  env(g.gain, t, vel, 0.35);
  o.connect(g).connect(dest);
  o.start(t); o.stop(t + 0.45);
}

function noiseHit(ctx, dest, t, noise, { type, freq, q = 1, vel, decay }) {
  const s = ctx.createBufferSource(), f = biquad(ctx, type, freq, q), g = ctx.createGain();
  s.buffer = noise;
  env(g.gain, t, vel, decay, 0.001);
  s.connect(f).connect(g).connect(dest);
  s.start(t, Math.random() * (noise.duration - 1)); s.stop(t + decay + 0.05);
}

const hat = (ctx, dest, t, noise, vel = 0.25) => noiseHit(ctx, dest, t, noise, { type: "highpass", freq: 8000, vel, decay: 0.04 });
function clap(ctx, dest, t, noise, vel = 0.5) {
  for (let i = 0; i < 3; i++) noiseHit(ctx, dest, t + i * 0.011, noise, { type: "bandpass", freq: 1400, q: 1.5, vel: vel * (i === 2 ? 1 : 0.6), decay: i === 2 ? 0.16 : 0.02 });
}

function tone(ctx, dest, t, freq, dur, { type = "sawtooth", cutoff = 1200, vel = 0.15, attack = 0.005 } = {}) {
  const o = ctx.createOscillator(), f = biquad(ctx, "lowpass", cutoff, 2), g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  env(g.gain, t, vel, dur, attack);
  o.connect(f).connect(g).connect(dest);
  o.start(t); o.stop(t + dur + attack + 0.05);
}

// ---- Tempo detection ------------------------------------------------------------------
// 1. Onset envelope: frame energy (512-sample hops) → log → rising edges only,
//    minus a local average so steady loudness doesn't count.
// 2. Autocorrelation over 70–180 BPM (fractional lags, plus the 2-beat lag; a doubled tempo wins if clearly stronger),
//    weighted toward ~120 BPM, gives a rough tempo (good to ~1 BPM).
// 3. Fine search (±2 BPM in 0.02 steps, then 0.002): fold the onset envelope onto a pulse train
//    at each candidate tempo and phase, keep the best. Accuracy matters: 0.1 BPM of
//    error drifts a whole beat in about 10 minutes.
// 4. Of the four beat phases, the one with the strongest onsets is taken as the downbeat.
export function analyzeTempo(buffer) {
  const sr = buffer.sampleRate, hop = 512;
  const a = buffer.getChannelData(0);
  const b = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : a;
  const total = a.length;
  const start = buffer.duration > 90 ? Math.floor(total * 0.15) : 0;
  const end = Math.min(total, start + sr * 60);
  const frames = Math.floor((end - start) / hop);
  if (frames < 64) return { bpm: 120, first: 0 };

  const energy = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let j = start + i * hop, e = j + hop; j < e; j++) { const x = a[j] + b[j]; s += x * x; }
    energy[i] = Math.log(1e-6 + s);
  }
  const flux = new Float32Array(frames);
  for (let i = 1; i < frames; i++) flux[i] = Math.max(0, energy[i] - energy[i - 1]);
  const fps = sr / hop, avgWin = Math.round(fps * 0.25);
  const onset = new Float32Array(frames);
  let run = 0;
  for (let i = 0; i < frames; i++) {
    run += flux[i] - (i >= 2 * avgWin ? flux[i - 2 * avgWin] : 0);
    const c = i - avgWin;
    if (c >= 0) onset[c] = Math.max(0, flux[c] - run / (2 * avgWin));
  }

  // 2. Coarse tempo. Onset autocorrelation at fractional lags (0.1 BPM apart), summed with
  //    its multiples (1, 2 and 4 beats) so the real beat beats a sub-beat or 1.5-beat
  //    period that only matches some of the hits. Whole-frame lags were up to ~3 BPM
  //    apart at 150+ BPM, wider than the fine search window, which then clipped.
  const at = (x) => { const i = x | 0, f = x - i; return i + 1 < frames ? onset[i] + (onset[i + 1] - onset[i]) * f : 0; };
  const corr = (lag) => {
    let s = 0, n = 0;
    for (let i = 0; i + lag < frames - 1; i++) { s += onset[i] * at(i + lag); n++; }
    return n > 16 ? s / n : 0;
  };
  let best = 0, rough = 0;
  for (let bpm = 70; bpm <= 180; bpm += 0.1) {
    const lag = (fps * 60) / bpm;
    const w = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.6) ** 2);
    const s = (corr(lag) + 0.5 * corr(2 * lag)) * w;
    if (s > best) { best = s; rough = bpm; }
  }
  // The tempo prior is for choosing between peaks; across one peak its slope would drag the
  // estimate toward 120 (about 1 BPM at 124), so re-center on the unweighted peak.
  if (best > 0) {
    let top = -1, center = rough;
    for (let bpm = rough - 1.5; bpm <= rough + 1.5; bpm += 0.1) {
      const lag = (fps * 60) / bpm, s = corr(lag) + 0.5 * corr(2 * lag);
      if (s > top) { top = s; center = bpm; }
    }
    rough = center;
    // Octave check: a fast tempo (drum & bass) scores like its half, since every other beat
    // repeats just as well. Prefer the double only when its own one-beat lag is clearly stronger (1.25x)
    // as the half's; a real slow song has nothing at the half-beat lag, so it stays put.
    if (rough * 2 <= 180) {
      let dbl = -1, dblBpm = rough * 2;
      for (let bpm = rough * 2 - 2; bpm <= rough * 2 + 2; bpm += 0.1) {
        const c = corr((fps * 60) / bpm);
        if (c > dbl) { dbl = c; dblBpm = bpm; }
      }
      if (dbl >= 1.25 * corr((fps * 60) / rough)) rough = dblBpm;
    }
  }
  // No lag repeats any onset (silence, a single hit): there is no tempo to find.
  if (!(best > 0) || !Number.isFinite(rough) || rough <= 0) return { bpm: 120, first: 0 };

  // 3. Fine tempo + phase. Onsets sit on whole frames, so the autocorrelation above is only
  //    good to about a BPM (its peak snaps toward whole-frame lags); this pass folds the whole
  //    envelope onto a pulse train at each candidate, which is sharp, over a window wide
  //    enough to hold the true tempo. Coarse pass (±2 BPM, 0.02 steps), then ±0.02 at 0.002.
  let fine = { score: -1, bpm: rough, phase: 0 };
  const search = (center, half, step) => {
    const steps = Math.round((2 * half) / step); // a fixed count always ends
    for (let k = 0; k <= steps; k += 1) {
      const bpm = center - half + k * step;
      const period = (fps * 60) / bpm;
      for (let ph = 0; ph < period; ph += 0.25) {
        let s = 0;
        for (let x = ph; x < frames; x += period) s += at(x);
        if (s > fine.score) fine = { score: s, bpm, phase: ph };
      }
    }
  };
  search(rough, 2, 0.02);
  search(fine.bpm, 0.02, 0.002);
  let bpm = fine.bpm;
  const period = (fps * 60) / bpm;

  // 4. Downbeat
  let down = { score: -1, phase: fine.phase };
  for (let j = 0; j < 4; j++) {
    let s = 0;
    for (let x = fine.phase + j * period; x < frames; x += 4 * period) s += at(x);
    if (s > down.score) down = { score: s, phase: fine.phase + j * period };
  }
  const bar = (4 * 60) / bpm;
  let first = (start + down.phase * hop) / sr;
  first -= Math.floor(first / bar) * bar; // earliest downbeat on this grid
  return { bpm: Math.round(bpm * 100) / 100, first };
}

// ---- Demo loops ---------------------------------------------------------------------------
// Two 16-bar loops, both in A minor so they mix well, at different tempos (124 and
// 128 BPM) so beat sync has something to do. Offline rendering cost grows with the
// number of scheduled nodes × length, so we render a 4-bar intro and a 4-bar main
// section separately and tile them: intro, main, main, main.
const N = { A1: 55, C2: 65.41, F1: 43.65, G1: 49, A3: 220, B3: 246.94, C4: 261.63, D4: 293.66, E4: 329.63, F3: 174.61, G3: 196, G4: 392 };
const CHORDS = {
  Am: { root: N.A1, notes: [N.A3, N.C4, N.E4] },
  F: { root: N.F1 * 2, notes: [N.F3, N.A3, N.C4] },
  C: { root: N.C2, notes: [N.C4, N.E4, N.G4] },
  G: { root: N.G1 * 2, notes: [N.G3, N.B3, N.D4] },
};
const TAIL = 1; // seconds rendered past each section so note decays carry over

async function renderSection(sampleRate, which, beat, melody) {
  const ctx = new OfflineAudioContext(2, Math.ceil((16 * beat + TAIL) * sampleRate), sampleRate);
  const noise = noiseBuffer(ctx, 2);
  const out = ctx.createGain();
  out.gain.value = 0.8;
  out.connect(ctx.destination);
  const prog = which === 0 ? ["Am", "F", "C", "G"] : ["Am", "G", "F", "G"];

  for (let bar = 0; bar < 4; bar++) {
    const chord = CHORDS[prog[bar]];
    const t0 = bar * 4 * beat;
    for (let q = 0; q < 4; q++) kick(ctx, out, t0 + q * beat, 0.9);
    if (which === 0) {
      // Deep house: offbeat hats, octave-bouncing bass, soft pad
      for (let q = 0; q < 4; q++) hat(ctx, out, t0 + (q + 0.5) * beat, noise, 0.22);
      [1, 1, 2, 1].forEach((m, q) => tone(ctx, out, t0 + (q + 0.5) * beat, chord.root * m, beat * 0.4, { cutoff: 500, vel: 0.35 }));
      if (melody) chord.notes.forEach((f) => tone(ctx, out, t0, f, beat * 3.8, { type: "triangle", cutoff: 1500, vel: 0.06, attack: 0.3 }));
    } else {
      // Tech house: claps on 2 and 4, sixteenth hats, chord stabs, arp
      clap(ctx, out, t0 + beat, noise); clap(ctx, out, t0 + 3 * beat, noise);
      for (let s = 0; s < 16; s++) hat(ctx, out, t0 + s * beat / 4, noise, s % 2 ? 0.08 : 0.16);
      for (let s = 0; s < 8; s++) tone(ctx, out, t0 + s * beat / 2, chord.root, beat * 0.3, { cutoff: 350, vel: 0.3 });
      for (const at of [1.5, 3.5]) chord.notes.forEach((f) => tone(ctx, out, t0 + at * beat, f * 2, 0.18, { cutoff: 2500, vel: 0.07 }));
      if (melody) for (let s = 0; s < 16; s++) tone(ctx, out, t0 + s * beat / 4, chord.notes[s % 3] * 2, 0.1, { type: "square", cutoff: 3000, vel: 0.035 });
    }
  }
  return ctx.startRendering();
}

export async function renderDemo(sampleRate, which) {
  const bpm = which === 0 ? 124 : 128, beat = 60 / bpm;
  const [intro, main] = await Promise.all([false, true].map((m) => renderSection(sampleRate, which, beat, m)));
  const section = Math.round(16 * beat * sampleRate);
  const total = section * 4;
  const buffer = new AudioBuffer({ numberOfChannels: 2, length: total, sampleRate });
  for (let ch = 0; ch < 2; ch++) {
    const dst = buffer.getChannelData(ch);
    [intro, main, main, main].forEach((src, i) => {
      const data = src.getChannelData(ch);
      // Add each section (with its tail) in place; the last tail wraps to the start for a seamless loop
      for (let j = 0; j < data.length; j++) dst[(i * section + j) % total] += data[j];
    });
  }
  return { buffer, tempo: { bpm, first: 0 } };
}
