// Run: node tests/build-site.cjs. scripts/build-site.mjs builds dist/ with the site's public files only.
const assert = require('assert'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');

(async () => {
  const {build, isPublicFile, readLibrary, readPublicLibrary, mergeLibraries} = await import(path.join(root, 'scripts', 'build-site.mjs'));
  const {copied} = build();
  const dist = path.join(root, 'dist');
  const all = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full); else all.push(path.relative(dist, full).split(path.sep).join('/'));
    }
  })(dist);

  for (const page of ['landing.html', 'index.html', 'ai-dj.html', 'arcade-versus.html', 'club.html', 'mix.html', 'aero.css',
    'queue.js', 'landing.js', 'djStart.js', 'audio.js', 'aiDeck.js', 'bitcrush-worklet.js', 'mix-worklet.js', 'easter/absolute-cinema.gif']) {
    assert(all.includes(page), `dist/ has ${page}`);
  }
  // The pages' own scripts and styles must all be there.
  for (const page of all.filter((name) => name.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(dist, page), 'utf8');
    for (const match of html.matchAll(/(?:src|href)="(?!https?:|\/\/|#|data:)([^"?#]+\.(?:js|css))/g)) {
      assert(all.includes(match[1]), `${page} loads ${match[1]}, which must be in dist/`);
    }
    for (const match of html.matchAll(/from "\.\/([^"?]+\.js)/g)) assert(all.includes(match[1]), `${page} imports ${match[1]}`);
  }
  // dist/library.json: library.json's songs unchanged, then library.public.json's songs with hosted: true.
  const src = JSON.parse(fs.readFileSync(path.join(root, 'library.json'), 'utf8'));
  const pub = JSON.parse(fs.readFileSync(path.join(root, 'library.public.json'), 'utf8'));
  const out = JSON.parse(fs.readFileSync(path.join(dist, 'library.json'), 'utf8'));
  assert.strictEqual(out.songs.length, src.songs.length + pub.songs.length);
  assert.deepStrictEqual(out.songs.slice(0, src.songs.length), src.songs, 'YouTube songs unchanged, no hosted flag');
  assert(out.songs.slice(0, src.songs.length).every((song) => song.hosted === undefined));
  assert.deepStrictEqual(out.songs.slice(src.songs.length), pub.songs.map((song) => ({...song, hosted: true})), 'public songs follow, hosted: true');
  assert.strictEqual(typeof out.about, 'string');
  assert.strictEqual(readLibrary().songs.length, src.songs.length);
  assert.strictEqual(new Set(out.songs.map((song) => song.id)).size, out.songs.length, 'ids unique across both');
  assert(!all.includes('library.public.json'), 'library.public.json itself is not copied');
  assert(!all.some((name) => name.startsWith('public-music') || name.endsWith('.m4a')), 'no audio in dist/');

  const forbidden = [/^server\.py$/, /^prefetch\.py$/, /^tests\//, /^\.env/, /(^|\/)\./, /\.md$/i, /^music\//, /^downloads\//, /^worker\//,
    /^scripts\//, /^node_modules\//, /^package(-lock)?\.json$/, /^wrangler\.jsonc$/, /\.py$/, /\.cjs$/, /\.mjs$/, /\.example$/, /\.m4a$/];
  for (const name of all) for (const pattern of forbidden) assert(!pattern.test(name), `dist/ must not contain ${name}`);
  assert.strictEqual(all.filter((name) => name.endsWith('.json')).join(), 'library.json');
  assert.strictEqual(copied.length, all.length, 'the build lists every file it copied');

  // The allowlist itself.
  for (const ok of ['index.html', 'queue.js', 'aero.css', 'easter/x.gif']) assert(isPublicFile(ok), ok);
  for (const no of ['server.py', 'tests/a.js', 'tests/a.html', 'music/a.js', 'worker/worker.js', 'scripts/x.js', '.env', '.hidden.js', '.github/a.js',
    'README.md', 'library.json', 'node_modules/a/b.js', 'easter/.secret.gif', 'notes.txt', 'downloads/a.m4a', 'public-music/a.m4a', 'public-music/a.js', 'library.public.json']) assert(!isPublicFile(no), no);

  // A bad hosted library stops the build instead of publishing a broken site.
  const tmp = path.join(root, 'dist', '.bad-library.json');
  fs.writeFileSync(tmp, JSON.stringify({songs: [{id: 'has space'}]}));
  assert.throws(() => readLibrary(tmp), /bad id/);
  fs.writeFileSync(tmp, JSON.stringify({songs: [{id: 'x'.repeat(21)}]}));
  assert.throws(() => readLibrary(tmp), /bad id/);
  fs.writeFileSync(tmp, JSON.stringify({songs: [{id: 'ok_1-A'}, {id: 'ok_1-A'}]}));
  assert.throws(() => readLibrary(tmp), /duplicate/);
  fs.writeFileSync(tmp, JSON.stringify({songs: [{id: 'Upper'}]}));
  assert.throws(() => readPublicLibrary(tmp), /bad id/, 'public ids are lowercase slugs');
  fs.writeFileSync(tmp, JSON.stringify({songs: [{id: 'a'}, {id: 'a'}]}));
  assert.throws(() => readPublicLibrary(tmp), /duplicate/);
  fs.writeFileSync(tmp, JSON.stringify({songs: [{id: 'abc'}]}));
  assert.throws(() => readPublicLibrary(tmp, new Set(['abc'])), /duplicate/, 'collision with library.json');
  assert.deepStrictEqual(mergeLibraries({about: 'x', songs: [{id: 'y'}]}, {about: 'z', songs: [{id: 'a'}]}).songs, [{id: 'y'}, {id: 'a', hosted: true}]);
  fs.rmSync(tmp);
  console.log(`PASS: dist/ holds ${all.length} public files and library.json, nothing private`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
