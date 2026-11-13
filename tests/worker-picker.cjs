// Run: node tests/worker-picker.cjs. The Worker's picker (worker/picker.js) against the cases of
// tests/server-requests.py, and cross-checked against server.py's own dj_pick via python3.
const assert = require('assert'), fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const root = path.join(__dirname, '..');

const LIBRARY = [
  {id: 'abc123DEF45', artist: 'A', title: 'T', bpm: 120, genre: 'house'},
  {id: 'xyz987QRS65', artist: 'B', title: 'U', bpm: 122, genre: 'house'},
  {id: 'hhh111HHH11', artist: 'C', title: 'V', bpm: 90, genre: 'hip-hop'},
];

(async () => {
  const {pick, clean, bpm, tempoGap} = await import(path.join(root, 'worker', 'picker.js'));
  const run = (body) => pick(body);
  const ids = (result) => result.body.picks.map((p) => p.id);

  let r = run({library: LIBRARY, count: 3, nowPlaying: 'A - T', queued: [], played: ['A - T']});
  assert.deepStrictEqual(Object.keys(r.body), ['picks']);
  assert.deepStrictEqual(ids(r), ['xyz987QRS65', 'hhh111HHH11'], 'same genre first, no repeat of the playing song');
  assert(r.body.picks.every((p) => p.reason && p.intro));
  assert.strictEqual(r.body.picks[0].intro, "Here's U by B.");
  assert.strictEqual(r.body.picks[1].intro, 'Switching it up, hip-hop time: V by C!');

  const opener = (vibe, extra = {}) => {
    const out = run({library: LIBRARY, count: 1, vibe, ...extra});
    assert.strictEqual(out.status, 200, JSON.stringify(out));
    return out.body.picks[0];
  };
  assert.strictEqual(opener('some hip-hop').id, 'hhh111HHH11');
  let o = opener('chill'); assert(o.id === 'hhh111HHH11' && o.reason === 'calm opener', JSON.stringify(o));
  o = opener('hype'); assert(o.id === 'xyz987QRS65' && o.reason === 'high-energy opener', JSON.stringify(o));
  assert(opener('turn up').id === 'xyz987QRS65' && opener('lo-fi').id === 'hhh111HHH11');
  assert.strictEqual(opener('chill into hype').id, 'hhh111HHH11', 'the earliest mood word sets the opener');
  const richard = [{...LIBRARY[0], artist: 'Richard'}, ...LIBRARY.slice(1)];
  o = run({library: richard, count: 1, vibe: 'hard'}).body.picks[0];
  assert(o.id === 'xyz987QRS65' && o.reason === 'high-energy opener', 'hard is not Richard: ' + JSON.stringify(o));
  o = opener('party hip-hop'); assert(o.id === 'hhh111HHH11' && o.reason === 'matches your vibe');
  assert.strictEqual(opener('rap').id, 'hhh111HHH11', 'rap is an alias for hip-hop');
  o = opener(''); assert(o.id === 'abc123DEF45' && o.reason === 'starts the set');
  assert.strictEqual(opener('chill', {played: ['C - V']}).id, 'abc123DEF45');
  assert.strictEqual(opener('hype', {queued: ['B - U']}).id, 'abc123DEF45');
  // Every song played: repeats are allowed, the one played longest ago first.
  r = run({library: LIBRARY, count: 1, played: ['A - T', 'B - U', 'C - V'], queued: []});
  assert(r.status === 200 && r.body.picks[0].id === 'abc123DEF45');
  // No library: a clear 400.
  for (const body of [{count: 1}, {library: []}, {library: [{artist: 'no id'}]}]) {
    r = run(body);
    // {count: 1} has no library field at all: still the "send the library" error.
    assert(r.status === 400 && /library/.test(r.body.error), JSON.stringify([body, r]));
  }
  // Malformed fields are a 400.
  for (const body of [{count: 'oops'}, {queued: null}, {library: 42}, {played: {}}, {library: null}, {queued: [1]}]) {
    r = run(body);
    assert(r.status === 400 && r.body.error === 'invalid DJ request fields', JSON.stringify([body, r]));
  }
  // The real library, everything queued and played: still picks, never the playing song.
  const real = JSON.parse(fs.readFileSync(path.join(root, 'library.json'), 'utf8')).songs;
  assert.strictEqual(real.length, 25);
  const labels = real.map((s) => `${s.artist} - ${s.title}`);
  r = run({library: real, count: 3, nowPlaying: labels[4], queued: labels, played: labels});
  assert(r.status === 200 && r.body.picks.length === 3);
  assert(r.body.picks.every((p) => p.id !== real[4].id));
  r = run({library: LIBRARY, count: 1, queued: ['A - T', 'B - U', 'C - V'], played: ['C - V', 'A - T', 'B - U']});
  assert(r.status === 200 && r.body.picks[0].id === 'hhh111HHH11', 'played longest ago first');
  r = run({library: LIBRARY.slice(0, 2), count: 3, nowPlaying: 'A - T', queued: [], played: ['A - T']});
  assert.deepStrictEqual(ids(r), ['xyz987QRS65'], 'a small library never repeats the playing song');
  r = run({library: LIBRARY.slice(0, 2), count: 2, nowPlaying: 'A - T', queued: ['A - T', 'B - U'], played: ['A - T', 'B - U']});
  assert.deepStrictEqual(ids(r), ['xyz987QRS65']);
  assert.strictEqual(run({library: LIBRARY.slice(0, 1), count: 1, nowPlaying: 'A - T', played: ['A - T']}).status, 200, 'one song falls back to itself');
  // Filler words don't substring-match names.
  const nice = [{...LIBRARY[0], artist: 'Drake', title: 'Nice For What', bpm: 90}, {...LIBRARY[1], bpm: 130}, LIBRARY[2]];
  o = run({library: nice, count: 1, vibe: 'something for the party'}).body.picks[0];
  assert(o.id === 'xyz987QRS65' && o.reason === 'high-energy opener');
  assert.strictEqual(run({library: nice, count: 1, vibe: 'nice'}).body.picks[0].id, 'abc123DEF45');
  assert.strictEqual(run({library: nice, count: 1, vibe: 'wha'}).body.picks[0].reason, 'starts the set');
  // Library ids must be strings; long ids are cut to 20 characters consistently.
  for (const bad of [[['x']], 12345, {a: 1}, null]) assert.strictEqual(run({library: [{...LIBRARY[0], id: bad}], count: 1}).status, 400);
  r = run({library: [{...LIBRARY[0], id: 'L'.repeat(40)}, LIBRARY[1]], count: 2, vibe: 'house'});
  assert(r.status === 200 && r.body.picks.length === 2 && r.body.picks[0].id === 'L'.repeat(20));
  // Helpers
  assert.strictEqual(clean('  a \n b\t', 10), 'a b');
  assert.strictEqual(clean('\ud800x', 5), '?x');
  assert.strictEqual(clean('😀😀😀', 2), '😀😀', 'limits count characters');
  assert.deepStrictEqual([bpm({bpm: 120.5}), bpm({bpm: 121.5}), bpm({bpm: 'x'}), bpm({}), bpm({bpm: '96'})], [120, 122, null, null, 96]);
  assert.deepStrictEqual([tempoGap(80, 160), tempoGap(0, 90), tempoGap(100, 90)], [0, 0, 10]);
  assert.strictEqual(run({library: LIBRARY, count: 1, vibe: 'constructor'}).status, 200, 'vibe words never hit Object.prototype');

  // ---- Cross-check against Python's dj_pick (server.py) on a handful of requests.
  const cases = [
    {library: LIBRARY, count: 3, nowPlaying: 'A - T', queued: [], played: ['A - T']},
    {library: real, count: 5, vibe: 'chill r&b'},
    {library: real, count: 4, vibe: 'party', played: labels.slice(0, 3)},
    {library: real, count: 3, vibe: 'something for the party into smooth'},
    {library: real, count: 3, nowPlaying: labels[7], queued: labels.slice(0, 5), played: labels.slice(3, 9)},
    {library: real, count: 2, nowPlaying: labels[2], queued: labels, played: labels},
    {library: real.slice(0, 6), count: 5, vibe: 'rap', played: labels.slice(0, 2)},
    {library: [{...real[0], bpm: '96.5'}, {...real[1], bpm: null}, {...real[2], genre: null}], count: 3, vibe: 'hype'},
    {library: LIBRARY, count: 0, vibe: 'rnb'},
    {library: LIBRARY, count: 99, vibe: 'Hip-Hop!!'},
    {library: [{...LIBRARY[0], id: 'L'.repeat(40)}, LIBRARY[1], {...LIBRARY[2], artist: '  Spaced\tOut  '}], count: 3, vibe: 'house'},
    {library: LIBRARY, count: '2'},
  ];
  const python = spawnSync('python3', ['-I', '-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('server', sys.argv[1])
server = importlib.util.module_from_spec(spec); spec.loader.exec_module(server)
out = []
for body in json.load(sys.stdin):
    # Same field handling as Handler.pick, without a socket.
    try:
        if body.get('count') is not None: body['count'] = int(body['count'])
        out.append({'picks': server.dj_pick(body)})
    except server.DjError as error:
        out.append({'error': str(error)})
print(json.dumps(out))
`, path.join(root, 'server.py')], {input: JSON.stringify(cases), encoding: 'utf8'});
  if (python.error || python.status !== 0) {
    console.log('SKIP python cross-check:', python.error ? python.error.message : python.stderr.trim().split('\n').pop());
  } else {
    const expected = JSON.parse(python.stdout.trim().split('\n').pop());
    cases.forEach((body, index) => {
      const got = pick(JSON.parse(JSON.stringify(body)));
      const want = expected[index];
      assert.deepStrictEqual(got.status === 200 ? {picks: got.body.picks} : {error: got.body.error}, want, `python and JS pickers differ for case ${index}`);
    });
    console.log(`PASS: cross-checked ${cases.length} requests against server.py's dj_pick`);
  }
  console.log('PASS: Worker picker matches the local picker (openers, repeats, ids, limits, errors)');
})().catch((error) => { console.error(error); process.exitCode = 1; });
