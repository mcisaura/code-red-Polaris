// Run: node tests/deck-tour.cjs
// Checks for deckTour.js (step logic only, no DOM) and its hooks in index.html.
const fs = require('fs'), assert = require('assert'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'deckTour.js'), 'utf8').replace(/^export /mg, '');
const { createDeckTour, TOUR_STEPS } = new Function(src + '\nreturn { createDeckTour, TOUR_STEPS };')();

function make(opts = {}) {
  let t = 0; const timers = [];
  const data = opts.data || {};
  const storage = opts.storage || { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = v; } };
  const state = { bothHands: false, playing: false, locked: false, speed: 1, freq: 20000, volume: 0.8, picks: { fx: 0, song: 0, vis: 0 } };
  const shown = [], acted = [];
  const tour = createDeckTour({
    getState: () => state, storage, now: () => t, setTimer: (f, ms) => timers.push({ f, ms }),
    render: (v) => shown.push(v),
    actions: { fx: () => acted.push('fx'), song: () => acted.push('song'), vis: () => acted.push('vis'), lock: () => acted.push('lock') },
  });
  const nice = () => { assert.strictEqual(tour.phase, 'nice'); const x = timers.shift(); assert.strictEqual(x.ms, 900); x.f(); };
  return { tour, state, data, shown, acted, timers, nice, tick: (ms = 150) => { t += ms; tour.tick(); } };
}

// first visit only
{
  const a = make(); assert.strictEqual(a.tour.init(), true); assert.ok(a.tour.active);
  const b = make({ data: { 'airdeck-tour-done': '1' } }); assert.strictEqual(b.tour.init(), false); assert.ok(!b.tour.active);
  b.tour.replay(); assert.ok(b.tour.active); assert.strictEqual(b.tour.stepIndex, 0);
}
// steps advance only when their condition is true, with a Nice pause
{
  const e = make(); e.tour.init();
  e.tick(); assert.strictEqual(e.tour.stepIndex, 0);
  e.state.bothHands = true; e.tick(); e.nice(); assert.strictEqual(e.tour.stepIndex, 1);
  e.tick(); assert.strictEqual(e.tour.stepIndex, 1);
  e.state.playing = true; e.tick(); e.nice(); assert.strictEqual(e.tour.stepIndex, 2);
  // step 3: held hands for 4 s
  e.tick(1000); e.tick(2000); assert.strictEqual(e.tour.stepIndex, 2);
  e.tick(2000); e.nice(); assert.strictEqual(e.tour.stepIndex, 3);
  e.state.picks.song++; e.state.picks.vis++; e.tick(); assert.strictEqual(e.tour.stepIndex, 3, 'other modes do not count');
  e.state.picks.fx++; e.tick(); e.nice(); assert.strictEqual(e.tour.stepIndex, 4);
  e.state.picks.song++; e.tick(); e.nice(); assert.strictEqual(e.tour.stepIndex, 5);
  e.state.picks.vis++; e.tick(); e.nice(); assert.strictEqual(e.tour.stepIndex, 6);
  e.tick(); assert.strictEqual(e.tour.stepIndex, 6);
  e.state.locked = true; e.tick(); e.nice();
  assert.strictEqual(e.tour.phase, 'final'); assert.ok(!e.data['airdeck-tour-done']);
  e.tour.finish(); assert.strictEqual(e.data['airdeck-tour-done'], '1'); assert.ok(!e.tour.active);
}
// step 3 also finishes when a value moves
{
  const e = make(); e.tour.init(); e.state.bothHands = true; e.tick(); e.nice(); e.state.playing = true; e.tick(); e.nice();
  e.state.volume = 0.85; e.tick(); assert.strictEqual(e.tour.phase, 'step');
  e.state.volume = 0.5; e.tick(); e.nice(); assert.strictEqual(e.tour.stepIndex, 3);
}
// Show me, Skip step, End tutorial, stale timers
{
  const e = make(); e.tour.init();
  assert.strictEqual(e.shown.at(-1).showMe, false);
  e.tour.skipStep(); e.tour.skipStep(); e.tour.skipStep(); assert.strictEqual(e.tour.stepIndex, 3);
  assert.strictEqual(e.shown.at(-1).showMe, true); assert.strictEqual(e.shown.at(-1).total, 7);
  e.tour.showMe(); assert.deepStrictEqual(e.acted, ['fx']);
  e.state.picks.fx++; e.tick(); e.tour.skipStep();   // skip during Nice: the old timer must not advance again
  assert.strictEqual(e.tour.stepIndex, 4); e.timers.shift().f(); assert.strictEqual(e.tour.stepIndex, 4);
  e.tour.end(); assert.ok(!e.tour.active); assert.strictEqual(e.data['airdeck-tour-done'], '1');
  assert.strictEqual(e.shown.at(-1).visible, false);
  e.tour.replay(); assert.strictEqual(e.tour.stepIndex, 0);
  for (let i = 0; i < 7; i++) e.tour.skipStep();
  assert.strictEqual(e.tour.phase, 'final');
}
// storage that throws, or a getState that throws
{
  const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const e = make({ storage: bad });
  assert.strictEqual(e.tour.init(), true); e.tour.end(); e.tour.replay();
  const tour = createDeckTour({ getState: () => { throw new Error('x'); }, render() {}, storage: bad });
  tour.init(); tour.tick(); assert.strictEqual(tour.stepIndex, 0);
}
// page hooks
{
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(html.includes('import { createDeckTour } from "./deckTour.js";'));
  assert.ok(html.includes('id="tourBtn"') && html.includes('id="tourMount"'));
  assert.ok(html.indexOf('id="tourMount"') < html.indexOf('id="songQueue"'));
}
console.log('deck-tour: ok');
