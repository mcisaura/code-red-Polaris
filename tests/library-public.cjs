// Run: node tests/library-public.cjs. library.public.json: the tracks the hosted site may serve from R2.
// Slug ids (not colliding with library.json), licence fields, attribution text, integer bpm, beat shape.
const fs = require('fs'), assert = require('assert');
const lib = JSON.parse(fs.readFileSync(__dirname + '/../library.public.json', 'utf8'));
const yt = JSON.parse(fs.readFileSync(__dirname + '/../library.json', 'utf8'));
assert(typeof lib.about === 'string' && lib.about, 'about');
assert(Array.isArray(lib.songs) && lib.songs.length > 0, 'songs');
const taken = new Set(yt.songs.map((s) => s.id)), ids = new Set();
for (const s of lib.songs) {
  const n = `${s.artist} - ${s.title}`;
  assert(/^[a-z0-9-]{1,20}$/.test(s.id), `${n}: id`);
  assert(!taken.has(s.id), `${n}: id collides with library.json`);
  assert(!ids.has(s.id), `${n}: duplicate id`); ids.add(s.id);
  assert(s.artist && s.title && s.genre, `${n}: artist/title/genre`);
  assert(Number.isInteger(s.bpm) && s.bpm > 0, `${n}: integer bpm`);
  assert(s.license && /^CC |^Public/.test(s.license), `${n}: license`);
  assert(/^https:\/\/creativecommons\.org\//.test(s.licenseUrl), `${n}: licenseUrl`);
  assert(typeof s.attribution === 'string' && s.attribution.includes(s.title) && s.attribution.includes(s.artist), `${n}: attribution names title and artist`);
  if (s.license === 'CC BY 4.0') assert(/By Attribution 4\.0/.test(s.attribution) && s.attribution.includes('incompetech.com'), `${n}: CC BY attribution text`);
  assert(s.hosted === undefined, `${n}: hosted is added by the build, not stored`);
  assert(s.beat, `${n}: beat (run node scripts/analyze-library.mjs --public)`);
  const b = s.beat;
  assert.deepStrictEqual(Object.keys(b).sort(), ['bpm', 'duration', 'first'], `${n}: beat keys`);
  for (const k of ['bpm', 'first', 'duration']) assert(Number.isFinite(b[k]), `${n}: beat.${k} number`);
  assert(Math.abs(b.bpm - s.bpm) <= 1, `${n}: beat.bpm ${b.bpm} vs bpm ${s.bpm}`);
  assert(b.first >= 0 && b.first < (60 / b.bpm) * 8 && b.duration > 30, `${n}: beat.first/duration`);
}
console.log(`library-public ok (${lib.songs.length} songs)`);
