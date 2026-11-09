// Run: node tests/tempo-silence.cjs. Real mix-audio.js and transitions.js code.
// Silent or single-hit audio must return quickly with finite results (it used to freeze
// the tab), and a steady beat must still be detected within about 1 BPM.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const R = __dirname + '/../';
const tempo = fs.readFileSync(R + 'mix-audio.js', 'utf8').replace(/^export /mg, '').replace(/import\.meta\.url/g, '"file:///x/"');
const trans = fs.readFileSync(R + 'transitions.js', 'utf8').replace(/^import .*$/mg, '').replace(/^export /mg, '');
class AudioBuffer {
  constructor({length, sampleRate, numberOfChannels}) {
    Object.assign(this, {length, sampleRate, numberOfChannels, duration: length / sampleRate});
    this.ch = [...Array(numberOfChannels)].map(() => new Float32Array(length));
  }
  getChannelData(c) { return this.ch[c]; }
  copyToChannel(src, c) { this.ch[c].set(src); }
}
const box = {Math, Float32Array, Uint8Array, Number, Array, console, AudioBuffer, Promise,
  setTimeout() {}, setInterval() {}, clearInterval() {}, clearTimeout() {}};
vm.createContext(box);
vm.runInContext(tempo + '\n' + trans + '\nglobalThis.analyzeTempo = analyzeTempo; globalThis.createTransitions = createTransitions; globalThis.fold = fold; globalThis.trusted = trusted;', box);

const sr = 8000;
const make = (seconds, fill) => {
  const b = new AudioBuffer({length: seconds * sr, sampleRate: sr, numberOfChannels: 1});
  fill(b.ch[0]);
  return b;
};
// A decaying 200-sample tone at each beat time (seconds): a clean, steady pulse train.
const beats = (bpm, seconds) => make(seconds, d => {
  for (let t = 0; t < seconds; t += 60 / bpm) {
    const at = Math.round(t * sr);
    for (let i = 0; i < 200 && at + i < d.length; i++) d[at + i] = 0.8 * Math.sin(i * 0.3) * Math.exp(-i / 40);
  }
});
const analyze = (buffer, ms = 3000) => vm.runInContext('analyzeTempo(b)', Object.assign(box, {b: buffer}), {timeout: ms});

let passed = 0;
const check = (name, fn) => { fn(); passed += 1; console.log('PASS: ' + name); };

// 1. Silence and a single hit return within the time limit with finite results.
const silent = make(20, () => {});
const oneHit = make(20, d => { for (let i = sr; i < sr + 300; i++) d[i] = Math.sin(i) * 0.9; });
for (const [name, buffer] of [['silence', silent], ['single hit', oneHit]]) {
  check(name + ' analyzes in under 3 s with a finite tempo', () => {
    const r = analyze(buffer);
    assert(Number.isFinite(r.bpm) && r.bpm > 0, name + ' bpm is finite: ' + r.bpm);
    assert(Number.isFinite(r.first), name + ' first is finite: ' + r.first);
    assert.deepEqual(r, {bpm: 120, first: 0}, 'safe default for ' + name);
  });
}

// 2. A steady beat still detects its tempo within about 1 BPM (tests/tempo-accuracy.cjs covers
// the wider range of tempos and patterns).
for (const bpm of [105, 115]) {
  check(`${bpm} BPM pulse train detected within 1 BPM`, () => {
    const r = analyze(beats(bpm, 20));
    assert(Math.abs(r.bpm - bpm) <= 1, `expected about ${bpm}, got ${r.bpm}`);
    assert(Number.isFinite(r.first));
  });
}

// 3. transitions.js: a silent or one-hit song must not freeze the analysis it runs on decode.
const deck = {ctx: {currentTime: 0}, rate: 1, setSpeed() {}};
for (const [name, buffer] of [['silent song', silent], ['single-hit song', oneHit]]) {
  check(name + ' mixPoint returns without hanging', () => {
    vm.runInContext('createTransitions(deck).mixPoint(b, false)', Object.assign(box, {deck, b: buffer}), {timeout: 4000});
  });
}

// 4. fold() and trusted() with unusable ratios.
check('fold returns 1 for zero, negative, infinite and NaN input', () => {
  for (const v of [0, -2, Infinity, -Infinity, NaN]) {
    const r = vm.runInContext('fold(v)', Object.assign(box, {v}), {timeout: 1000});
    assert.equal(r, 1, 'fold(' + v + ')');
  }
});
check('fold keeps finite positive ratios within 0.71-1.41', () => {
  for (const v of [5e-324, 0.001, 0.3, 1, 1.9, 3, 1000, 1e300]) {
    const r = vm.runInContext('fold(v)', Object.assign(box, {v}), {timeout: 1000});
    assert(r >= Math.SQRT1_2 - 1e-12 && r <= Math.SQRT2 + 1e-12, 'fold(' + v + ')=' + r);
  }
  assert(Math.abs(vm.runInContext('fold(2)', box) - 1) < 1e-12, 'double time folds to 1');
});
check('trusted rejects a zero, NaN or infinite detection against a library tempo', () => {
  for (const detected of [0, NaN, Infinity]) {
    assert.equal(vm.runInContext('trusted(d, 90)', Object.assign(box, {d: detected})), false, 'detected ' + detected);
  }
  assert.equal(vm.runInContext('trusted(90.5, 90)', box), true, 'a close detection is still trusted');
});

console.log(`${passed} checks passed`);
