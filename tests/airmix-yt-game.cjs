// AirMix's game on the hosted site (djGame.js with a queue that has `hasEffects: false`): no filter shapes are
// charted (the right pinch never closes over a build-up) and the right pinch's openness is not judged, while a
// local queue (no `hasEffects`) keeps both. Run: node tests/airmix-yt-game.cjs
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const source = fs.readFileSync(__dirname + '/../djGame.js', 'utf8').replace(/\r\n/g, '\n').replace(/^import .*$/mg, '').replace(/^export /mg, '');
const element = () => ({ append() {}, appendChild(node) { return node; }, setAttribute() {}, getContext: () => ({}), classList: { toggle() {} }, clientWidth: 1000, clientHeight: 500 });
const box = { console, performance, requestAnimationFrame() {}, window: {}, document: { createElement: element, getElementById: () => ({}) } };
vm.createContext(box);
vm.runInContext(source + '\nglobalThis.createDjGame = createDjGame;', box);

// A song at 120 bpm (a bar is 2 s) whose energy jumps at 0:20: the bars before it are a build-up.
function game(extra = {}) {
  const state = { position: 14 };
  const queue = {
    ...extra,
    getPlayback: () => ({ position: state.position, duration: 200, rate: 1, playing: true, loaded: true, songId: 'song' }),
    getState: () => ({ dj: { on: true, short: false }, items: [], currentId: 'song', library: [] }),
    beatGridAt: () => ({ bpm: 120, first: 0 }),
    energyAt: (time) => (time < 20 ? 0.8 : 1.5),
    mixOutAt: () => null, getUpNext: () => null, getChoices: () => [],
    holdControls() {}, coachPing() {}, resetSound() {}, setCrowd() {}, endSet: async () => true,
  };
  const g = box.createDjGame(queue, { stage: element(), camera: { width: 1000, height: 500 }, rail: element(), deck: {} });
  return { g, state };
}
const hand = (pin) => ({ thumb: { x: pin[0] * 1000, y: pin[1] * 500 }, index: { x: pin[0] * 1000, y: pin[1] * 500 }, pinch: 0 }); // fully closed pinch, on the dots' middle

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('locally a build-up closes the right pinch (the filter shapes); hosted never does', () => {
  const local = game();
  local.g.update({}, 1000);
  const hosted = game({ hasEffects: false });
  hosted.g.update({}, 1000);
  const pinches = (g) => g.g.peek(1000).targets.map((target) => target.pins.right.pinch);
  assert(pinches(local).length > 0 && pinches(hosted).length > 0, 'both chart shapes');
  assert(pinches(local).some((pinch) => pinch < 1.08), `local: some shape closes the pinch (${pinches(local)})`);
  assert(pinches(hosted).every((pinch) => pinch === 1.08), `hosted: every right pinch stays open (${pinches(hosted)})`);
});

test('hosted does not judge the right pinch: hands on the dots with a closed pinch are a hit; locally they are not', () => {
  for (const [label, extra, perfect] of [['hosted', { hasEffects: false }, 1], ['local', {}, 0]]) {
    const { g, state } = game(extra);
    g.update({}, 1000);
    const target = g.peek(1000).targets[0];
    const shapeTime = state.position + (target.at - 1000) / 1000;
    state.position = shapeTime;
    g.update({ left: hand(target.pins.left.at), right: hand(target.pins.right.at) }, 1000);
    assert.equal(g.peek(1000).score.perfect, perfect, label);
  }
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ok   ' + name); }
    catch (error) { console.error('FAIL ' + name); throw error; }
  }
  console.log(`PASS: ${tests.length} hosted AirMix game checks`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
