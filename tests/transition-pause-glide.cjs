// Run: node tests/transition-pause-glide.cjs
// (1) A manual hand blend starts no speed-glide timer. (2) Pausing mid-blend ends the outgoing tail at once.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const code = fs.readFileSync(__dirname + '/../transitions.js', 'utf8').replace(/^import .*$/mg, '').replace(/^export /mg, '');
let wall = 0, nextTimer = 0;
const timers = new Map(), nodes = [];
const schedule = (fn, ms, repeat) => { const id = ++nextTimer; timers.set(id, {fn, ms, repeat, at: wall + ms}); return id; };
function advance(ms) {
  const until = wall + ms;
  for (;;) {
    const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    const [id, t] = due; wall = t.at;
    if (t.repeat) t.at += t.ms; else timers.delete(id);
    t.fn();
  }
  wall = until;
}
const param = value => ({value, setTargetAtTime(v) {this.value = v;}, setValueAtTime(v) {this.value = v;}, cancelScheduledValues() {}, linearRampToValueAtTime(v) {this.value = v;}, exponentialRampToValueAtTime(v) {this.value = v;}});
const node = () => { const n = {disconnected: false, connect() {return this;}, disconnect() {this.disconnected = true;}, stop() {this.stopped = true;}}; nodes.push(n); return n; };
const ctx = {currentTime: 10, createGain: () => Object.assign(node(), {gain: param(1)}), createBiquadFilter: () => Object.assign(node(), {frequency: param(0)}), createBufferSource: () => Object.assign(node(), {playbackRate: param(1), start() {}})};
const buffer = () => ({duration: 30, sampleRate: 8, getChannelData: () => new Float32Array(240).fill(.5)});
const old = node();
let speedCalls = 0;
const deck = {ctx, buffer: buffer(), source: old, rate: 1, playing: true, filter: node(), position: () => 12,
  setSpeed(v) {speedCalls++; this.rate = v;},
  pause() { this.playing = false; if (this.source) { this.source.stop(); this.source = null; } }};
const box = {console, Float32Array, Math, performance: {now: () => wall}, setTimeout: (f, ms) => schedule(f, ms, false), setInterval: (f, ms) => schedule(f, ms, true), clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id)};
vm.createContext(box); vm.runInContext(code + '\nglobalThis.createTransitions = createTransitions;', box);
(async () => {
  const transitions = box.createTransitions(deck);
  // (1) manual blend runs to the end: no 250 ms glide interval afterwards
  const {hands} = await transitions.mixInto(buffer(), {hands: true, mixOutAt: 0});
  hands.finish(1);
  ctx.currentTime += 2; advance(100);
  assert.equal(hands.done, true);
  const before = speedCalls;
  advance(20000); ctx.currentTime += 20; advance(20000);
  assert.equal(speedCalls, before, 'no setSpeed calls after a manual blend');
  assert.equal([...timers.values()].filter(t => t.ms === 250).length, 0, 'no glide timer');
  // (2) pause mid-blend stops the tail synchronously
  const second = await transitions.mixInto(buffer(), {hands: true, mixOutAt: 0});
  const tailSource = nodes.filter(n => n.playbackRate).slice(-2)[0];
  deck.source = nodes.filter(n => n.playbackRate).slice(-1)[0]; // incoming
  const sources = nodes.filter(n => n.playbackRate);
  deck.pause();
  assert(sources.every(s => s.stopped), 'pause stops outgoing tail and incoming source immediately, before any watch poll');
  advance(300);
  console.log('PASS: no useless glide after manual blends; pause ends the tail at once');
})().catch(error => {console.error(error); process.exitCode = 1;});
