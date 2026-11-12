// The thumb must not change a 1-4 finger pick, and a bent or folded-in thumb is not "out".
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const grab = (start, end) => { const i = html.indexOf(start); assert(i >= 0, 'missing ' + start); return html.slice(i, html.indexOf(end, i) + end.length); };
const code = [
  'const THUMB_TIP = 4, INDEX_MCP = 5;',
  grab('const THUMB_MAX_BEND_DEG', ';'), grab('const THUMB_AWAY_RATIO', ';'),
  grab('const dist3', '\n'), grab('const sub3', '\n'), grab('function angleDeg', '\n}'),
  grab('function thumbExtension', '\n}'), grab('const fingerCount', '};'),
  '({ thumbExtension, fingerCount })',
].join('\n');
const { thumbExtension, fingerCount } = vm.runInNewContext(code);

const count = (t, i, m, r, p) => fingerCount({ ext: [t, i, m, r, p] });
assert.equal(count(true, true, false, false, false), 1, 'point with the thumb out is 1');
assert.equal(count(true, true, true, false, false), 2, 'peace sign with the thumb out is 2');
assert.equal(count(true, true, true, true, false), 3, 'three fingers with the thumb out is 3');
assert.equal(count(false, true, true, true, true), 4, 'four fingers, thumb in, is 4');
assert.equal(count(true, true, true, true, true), 5, 'open hand is 5');
assert.equal(count(true, false, false, false, false), 0, 'a fist with a loose thumb picks nothing');

// A flat right hand in palm units: wrist at the origin, knuckles along y = 1.
const P = (x, y, z = 0) => ({ x, y, z });
const base = () => { const w = Array.from({ length: 21 }, () => P(0, 0)); w[5] = P(0.3, 1); w[17] = P(-0.4, 0.9); w[2] = P(0.5, 0.4); return w; };
const out = base(); out[3] = P(0.8, 0.6); out[4] = P(1.1, 0.8);             // straight, pointing away from the palm
assert(thumbExtension(out, 1) > 0.55, 'a straight thumb held out counts as extended');
const folded = base(); folded[3] = P(0.3, 0.5); folded[4] = P(0, 0.6);      // straight but lying across the palm
assert.equal(thumbExtension(folded, 1), 0, 'a thumb folded across the palm is not extended');
const bent = base(); bent[3] = P(0.8, 0.6); bent[4] = P(0.7, 0.9);          // out, but hooked at the last joint
assert.equal(thumbExtension(bent, 1), 0, 'a thumb bent at its last joint is not extended');
console.log('PASS: the thumb never changes a 1-4 pick; bent or folded thumbs are not extended');
