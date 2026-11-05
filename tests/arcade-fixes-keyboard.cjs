// Arcade keyboard input must not outlive the key: no steering after release, no stale
// fingertip without a camera, and Hand Duel throws are cleared after each throw.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const html = fs.readFileSync(__dirname + '/../arcade-versus.html', 'utf8');
const take = (from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
const handlers = {};
const box = {
  console, Math: Object.create(Math),
  $: () => ({ style: {}, setAttribute() {} }),
  addEventListener: (type, fn) => { handlers[type] = fn; },
  beep() {}, burst() {}, endMatch() {}, overlayAction() {}, handPhoto: () => null,
  PCOL: {}, rand: (a, b) => (a + b) / 2,
};
vm.createContext(box);
vm.runInContext(`let clock = 0, camOn = false, lastVideoTime = -1, landmarker = null, W = 1600, H = 1000;
const video = {readyState: 0, currentTime: 0};
const state = {phase: 'playing', score: {1: 0, 2: 0}, rounds: {1: 0, 2: 0}, totals: {1: 0, 2: 0}, round: 1};
${take('const input = {', '// ---- Hand tracking')}
${take('const dist', '// Camera data is dropped')}
${take('function dropHand', '// ---- Little sounds')}
${take('const aspect', 'function advance(')}
${take('const duel = {', 'function handPhoto')}`, box);

const run = (src) => vm.runInContext(src, box);
const press = (key) => handlers.keydown({ key, preventDefault() {} });
const release = (key) => handlers.keyup({ key, preventDefault() {} });
const tick = (secs) => { run(`clock += ${secs}`); run(`track(${Date.now()})`); };
const snake = () => ({ x: 0.5, y: 0.5, a: Math.PI / 2, pts: [] });

// 1. An arrow key steers only while it is held.
run('var h = null');
box.snakeHead = snake();
run('h = snakeHead');
press('d');
for (let i = 0; i < 10; i++) run('steer(h, 1, 0.05, 4.2)');
const turned = run('h.a');
assert(Math.abs(turned) < Math.PI / 2 - 0.1, 'held arrow key must turn the snake toward it');
release('d');
run('steer(h, 1, 0.05, 4.2)');
const afterRelease = run('h.a');
for (let i = 0; i < 60; i++) { tick(0.05); run('steer(h, 1, 0.05, 4.2)'); }
assert.equal(run('h.a'), afterRelease, 'a released key must not keep steering');
console.log('PASS: held arrow key steers, released key stops steering');

// 2. No camera: no fingertip is kept, and nothing steers toward a stale one.
assert.equal(run('input[1].tip'), null, 'no camera means no fingertip');
press('d');
release('d');
assert.equal(run('isHeld(1)'), false, 'released key is no longer held');
assert.equal(run('tipOf(1)'), null, 'a keyboard cursor must not stay as a fingertip after release');
run('input[2].tip = {x: .9, y: .9}');   // leftover camera data from an earlier session
tick(3);
assert.equal(run('input[2].tip'), null, 'track() without a camera must clear camera data');
assert.equal(run('input[2].present'), false);
const headA = run('(h = {x: .5, y: .5, a: 0, pts: []}).a');
for (let i = 0; i < 60; i++) { tick(0.05); run('steer(h, 1, 0.05, 4.2)'); run('steer(h, 2, 0.05, 4.2)'); }
assert.equal(run('h.a'), headA, 'with no key and no camera the snake must go straight');
console.log('PASS: keyboard leaves no fingertip and no steering target without a camera');

// 3. Blur releases every held key.
press('w');
handlers.blur();
assert.equal(run('isHeld(1)'), false, 'window blur must release held keys');
console.log('PASS: blur releases held keys');

// 4. Hand Duel: a typed gesture is one throw only.
run('duel.init()');
press('1');                                   // P1 types rock
assert.equal(run('gestureOf(1)'), 'rock');
run('duel.update(2.7)');                      // read the throw on beat 4
assert.equal(run('state.score[1]'), 1, 'P1 rock beats P2 with no hand');
run('duel.update(2.0)');                      // throw display ends: duel.init() clears the gestures
assert.equal(run('gestureOf(1)'), null, 'the throw must clear P1 gesture');
run('duel.update(2.7)');                      // next throw, no key pressed
assert.equal(run('state.score[1]'), 1, 'a stale rock must not win the next throw');
assert(run('duel.result').startsWith('No hands') || run('duel.result').startsWith('Draw'), 'second throw is empty');
console.log('PASS: Hand Duel gesture from the keyboard is cleared after each throw');

// 5. A gesture typed during the throw display is discarded at the next throw.
run('duel.init()');
run('duel.update(2.7)');
run('duel.update(0.5)');
press('2');                                   // typed while the result is shown
run('duel.update(1.6)');                      // display ends, next throw starts
assert.equal(run('gestureOf(2)'), null, 'a gesture typed between throws must not carry over');
console.log('PASS: gestures typed between throws do not carry over');
