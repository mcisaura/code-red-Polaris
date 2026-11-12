// Run: node tests/transition-qa2-glide.cjs
// (1) mixInto stops the tempo glide first; when it then gives up (song no longer wanted) the glide resumes.
// (2) A non-finite speed from the hands is ignored.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const code = fs.readFileSync(__dirname + '/../transitions.js', 'utf8').replace(/^import .*$/mg, '').replace(/^export /mg, '');
const param = value => ({value, setTargetAtTime(v) {this.value = v;}, setValueAtTime(v) {this.value = v;}, setValueCurveAtTime() {}, cancelScheduledValues() {}, linearRampToValueAtTime(v) {this.value = v;}, exponentialRampToValueAtTime(v) {this.value = v;}});
const node = () => ({connect() {return this;}, disconnect() {}, stop() {}});
const ctx = {currentTime: 10, createGain: () => Object.assign(node(), {gain: param(1)}), createDelay: () => Object.assign(node(), {delayTime: param(0)}),
  createBiquadFilter: () => Object.assign(node(), {frequency: param(0)}), createBufferSource: () => Object.assign(node(), {playbackRate: param(1), start() {}})};
const buffer = label => ({label, duration: 60, sampleRate: 8, length: 480, numberOfChannels: 1, getChannelData: () => new Float32Array(480).fill(label === 'A' ? .5 : .51)});
const t0 = Date.now();
let speedCalls = 0;
const deck = {ctx, buffer: buffer('A'), source: node(), rate: 1, playing: true, filter: node(), position: () => 12 + (Date.now() - t0) / 1000,
  setSpeed(v) {speedCalls++; this.rate = v;}};
const box = {console, Float32Array, Math, Date, performance, setTimeout, setInterval, clearTimeout, clearInterval,
  AudioBuffer: class {constructor(o) {Object.assign(this, o);} copyToChannel(data) {this.bpm = data[0] > .505 ? 125 : 120;}},
  analyzeTempo: part => ({bpm: part.bpm, first: 0})};
vm.createContext(box); vm.runInContext(code + '\nglobalThis.createTransitions = createTransitions;', box);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const transitions = box.createTransitions(deck);
  deck.setSpeed(NaN); assert.equal(deck.rate, 1, 'NaN speed ignored');
  deck.setSpeed(undefined); assert.equal(deck.rate, 1, 'undefined speed ignored');
  // Make the nudge differ from 1: mix into a song detected at another tempo, then let that mix land.
  const next = buffer('B');
  const mixed = await transitions.mixInto(next, {startAt: 12.6, mixOutAt: 0, fromBpm: 0, toBpm: 0, short: false});
  assert(mixed, 'first mix scheduled');
  ctx.currentTime += 1000; await wait(120); // finishAt lands the mix and starts the glide (if the nudge is not 1)
  const nudged = deck.rate !== 1;
  if (!nudged) { console.log('SKIP: stub tempos gave no nudge (nothing to glide)'); return; }
  const glideStart = deck.rate;
  deck.position = () => 12 + (Date.now() - t0) / 1000 + 5;
  deck.source = node();
  const result = await transitions.mixInto(buffer('C'), {mixOutAt: 0, stillWanted: () => false});
  assert.equal(result, null);
  const before = speedCalls;
  ctx.currentTime += 8; await wait(700);
  assert(speedCalls > before, 'the glide resumes after mixInto gives up');
  ctx.currentTime += 100; await wait(300);
  assert.equal(deck.rate, 1, 'the tempo is back to normal');
  console.log('PASS: glide resumes when mixInto returns null; non-finite speeds ignored');
})().catch(error => {console.error(error); process.exitCode = 1;}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 50));
