// Run: node tests/tempo-accuracy.cjs. Real mix-audio.js code on synthetic audio.
// analyzeTempo must land within 1 BPM of the true tempo (and its first-beat offset within
// 20 ms) on kick patterns, kick+offbeat-hat patterns with noise, and a signal that starts
// with silence. Set TEMPO_REPORT=1 to print every error. A 2x/0.5x octave answer is accepted
// only for 70 BPM with hats (it reads 140: the kick/hat alternation is a genuine 140 pulse,
// and 70 is the bottom of the search range). 87 and 174 BPM must read exactly as given, since
// half-density beats would change echo/beat timing in transitions.js even though fold() hides
// it for speed ratios. 87 with offbeat hats and 174 are nearly the same sound; the 1.25x
// threshold in analyzeTempo keeps both right on these synthetic patterns.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const R = __dirname + '/../';
const tempo = fs.readFileSync(R + 'mix-audio.js', 'utf8').replace(/^export /mg, '').replace(/import\.meta\.url/g, '"file:///x/"');
class AudioBuffer {
  constructor({length, sampleRate, numberOfChannels}) {
    Object.assign(this, {length, sampleRate, numberOfChannels, duration: length / sampleRate});
    this.ch = [...Array(numberOfChannels)].map(() => new Float32Array(length));
  }
  getChannelData(c) { return this.ch[c]; }
}
const box = {Math, Float32Array, Uint8Array, Number, Array, console, AudioBuffer, Promise,
  setTimeout() {}, setInterval() {}, clearInterval() {}, clearTimeout() {}};
vm.createContext(box);
vm.runInContext(tempo + '\nglobalThis.analyzeTempo = analyzeTempo;', box);
const analyze = (b) => vm.runInContext('analyzeTempo(b)', Object.assign(box, {b}), {timeout: 20000});

const sr = 44100;
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
// pattern 'kick': kick on every beat. 'hats': kick on every beat plus an offbeat hat
// (and a quieter 16th hat) over noise. Kicks are 60 Hz-ish decaying sines with a pitch drop.
function make(bpm, seconds, {pattern = 'kick', lead = 0, noise = 0} = {}) {
  const b = new AudioBuffer({length: Math.round(seconds * sr), sampleRate: sr, numberOfChannels: 1});
  const d = b.ch[0], beat = 60 / bpm;
  for (let n = 0; ; n++) {
    const t = lead + n * beat;
    if (t >= seconds) break;
    const at = Math.round(t * sr);
    for (let i = 0; i < 0.18 * sr && at + i < d.length; i++) {
      const s = i / sr;
      d[at + i] += 0.8 * Math.sin(2 * Math.PI * (50 * s + 40 * (1 - Math.exp(-30 * s)) / 30)) * Math.exp(-s / 0.07);
    }
    if (pattern === 'hats') {
      for (const [off, vel] of [[0.5, 0.35], [0.25, 0.12], [0.75, 0.12]]) {
        const h = Math.round((t + off * beat) * sr);
        for (let i = 0; i < 0.04 * sr && h + i < d.length; i++) d[h + i] += vel * rnd() * Math.exp(-i / (0.008 * sr));
      }
    }
  }
  if (noise) for (let i = 0; i < d.length; i++) d[i] += noise * rnd();
  return b;
}
// Distance from detected first-beat to the nearest true beat, in seconds. Which beat of the
// bar is the downbeat is not knowable from identical kicks, so only beat phase is checked.
const firstErr = (r, bpm, lead) => {
  const beat = 60 / bpm, raw = (r.first - lead) / beat;
  return Math.abs(raw - Math.round(raw)) * beat;
};

const report = !!process.env.TEMPO_REPORT;
let passed = 0, worst = 0, worstFirst = 0;
const cases = [], fails = [];
for (const bpm of [70, 85, 87, 92, 100, 110, 120, 124, 128, 135, 140, 150, 174, 123.5, 97.3, 131.7]) {
  cases.push([bpm, 'kick', 0, 0], [bpm, 'hats', 0, 0.02]);
}
cases.push([128, 'hats', 1.5, 0.02], [100, 'kick', 1.5, 0], [140, 'hats', 1.5, 0.02]);
for (const [bpm, pattern, lead, noise] of cases) {
  const name = `${bpm} BPM ${pattern}${lead ? ' after ' + lead + ' s silence' : ''}`;
  const r = analyze(make(bpm, 30, {pattern, lead, noise}));
  const octave = bpm === 70 && pattern === 'hats' && [0.5, 2].some(m => Math.abs(r.bpm - bpm * m) <= 1);
  const e = octave ? 0 : r.bpm - bpm, f = firstErr(r, bpm, lead);
  worst = Math.max(worst, Math.abs(e)); worstFirst = Math.max(worstFirst, octave ? 0 : f);
  if (report) console.log(`${name}: got ${r.bpm} (err ${e.toFixed(2)}), first err ${(f * 1000).toFixed(0)} ms`);
  if (Math.abs(e) > 1) fails.push(`${name}: expected ${bpm}, got ${r.bpm}`);
  const fo = octave ? firstErr(r, r.bpm, lead) : f;
  if (fo > 0.02) fails.push(`${name}: first-beat offset off by ${(f * 1000).toFixed(0)} ms`);
  passed++;
}
assert.deepEqual(fails, [], fails.join('\n'));
console.log(`PASS: ${passed} synthetic tempos within 1 BPM / 20 ms (worst ${worst.toFixed(2)} BPM, ${(worstFirst * 1000).toFixed(0)} ms)`);

// Runtime stays bounded: 30 s and 4 min buffers.
for (const secs of [30, 240]) {
  const buf = make(124, secs, {pattern: 'hats', noise: 0.02});
  const t0 = process.hrtime.bigint();
  analyze(buf);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (report) console.log(`${secs} s buffer: ${ms.toFixed(0)} ms`);
  assert(ms < 3000, `${secs} s buffer took ${ms.toFixed(0)} ms`);
}
console.log('PASS: runtime bounded');
