// Run: node tests/library-beat.cjs. library.json: every song has a valid unique id and an
// integer bpm; an optional beat {bpm, first, duration} must be well formed and agree with bpm
// (within 2 BPM, half/double time allowed), with 0 <= first < 8 beats.
const fs = require('fs'), assert = require('assert');
const lib = JSON.parse(fs.readFileSync(__dirname + '/../library.json', 'utf8'));
assert(Array.isArray(lib.songs) && lib.songs.length > 0, 'songs');
const ids = new Set();
for (const s of lib.songs) {
  const n = `${s.artist} - ${s.title}`;
  assert(/^[A-Za-z0-9_-]{1,20}$/.test(s.id), `${n}: id`);
  assert(!ids.has(s.id), `${n}: duplicate id`); ids.add(s.id);
  assert(Number.isInteger(s.bpm) && s.bpm > 0, `${n}: integer bpm`);
  if (s.beat === undefined) continue;
  const b = s.beat;
  assert(b && typeof b === 'object' && !Array.isArray(b), `${n}: beat object`);
  assert.deepStrictEqual(Object.keys(b).sort(), ['bpm', 'duration', 'first'], `${n}: beat keys`);
  for (const k of ['bpm', 'first', 'duration']) assert(Number.isFinite(b[k]), `${n}: beat.${k} number`);
  assert(b.bpm > 0 && b.duration > 0, `${n}: beat positive`);
  const off = Math.min(...[1, 2, 0.5].map((m) => Math.abs(b.bpm - s.bpm * m)));
  assert(off <= 2, `${n}: beat.bpm ${b.bpm} vs bpm ${s.bpm}`);
  assert(b.first >= 0 && b.first < (60 / b.bpm) * 8, `${n}: beat.first ${b.first}`);
}
console.log(`library-beat ok (${lib.songs.length} songs, ${lib.songs.filter((s) => s.beat).length} with beat)`);
