// Run: node tests/worker-routes.cjs. The Worker's routes (worker/worker.js) with stub ASSETS and MUSIC (R2) bindings.
const assert = require('assert'), path = require('path');

const calls = {assets: [], r2: []};
const AUDIO = Buffer.from(Array.from({length: 100}, (_, i) => i));
// Minimal R2 bucket stub: one object, funkorama.m4a (100 bytes).
const MUSIC = {
  head: async (key) => { calls.r2.push('head ' + key); return key === 'funkorama.m4a' ? {size: AUDIO.length, httpEtag: '"abc123"', etag: 'abc123'} : null; },
  get: async (key, opts) => {
    calls.r2.push('get ' + key + ' ' + JSON.stringify(opts || {}));
    if (key !== 'funkorama.m4a') return null;
    const {offset = 0, length = AUDIO.length - offset} = (opts && opts.range) || {};
    return {body: AUDIO.subarray(offset, offset + length)};
  },
};
const env = {
  MUSIC,
  ASSETS: {
    fetch: async (request) => {
      const url = new URL(request.url);
      calls.assets.push(url.pathname);
      if (url.pathname === '/landing.html') return new Response('<html>landing</html>', {headers: {'Content-Type': 'text/html; charset=utf-8'}});
      if (url.pathname === '/index.html') return new Response('<html>deck</html>', {headers: {'Content-Type': 'text/html; charset=utf-8'}});
      if (url.pathname === '/queue.js') return new Response('export {}', {headers: {'Content-Type': 'text/javascript'}});
      return new Response('not found', {status: 404});
    },
  },
};
const ORIGIN = 'https://airdeck.example.workers.dev';

(async () => {
  const {default: worker} = await import(path.join(__dirname, '..', 'worker', 'worker.js'));
  const call = (pathAndQuery, init = {}) => worker.fetch(new Request(ORIGIN + pathAndQuery, init), env);
  const postPick = (body, headers = {}) => call('/api/dj/pick', {method: 'POST', headers: {'Content-Type': 'application/json', ...headers}, body: typeof body === 'string' ? body : JSON.stringify(body)});

  // Pages
  let res = await call('/?x=1');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await res.text(), '<html>landing</html>', '/ serves landing.html');
  assert.strictEqual(calls.assets.at(-1), '/landing.html');
  assert.strictEqual(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert(res.headers.get('Referrer-Policy'));
  assert.match(res.headers.get('Permissions-Policy'), /camera=\(self\)/);
  res = await call('/index.html');
  assert.strictEqual(await res.text(), '<html>deck</html>', 'other pages come from ASSETS untouched');
  res = await call('/queue.js');
  assert.strictEqual(res.headers.get('Permissions-Policy'), null, 'the policy is for HTML only');
  assert.strictEqual(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.strictEqual((await call('/nope.html')).status, 404);
  assert.strictEqual((await call('/', {method: 'POST', body: 'x'})).status, 405);

  // /api/config
  res = await call('/api/config');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), {youtube: false, youtubeEmbed: true, hosted: true});

  // /api/youtube/info: YouTube's public oEmbed, asked by the Worker (global fetch stubbed)
  const realFetch = globalThis.fetch, asked = [];
  let upstream = () => new Response(JSON.stringify({title: 'Some Song', author_name: 'Some Channel', html: '<iframe>'}), {status: 200});
  globalThis.fetch = async (input, init) => { asked.push(String(input)); return upstream(); };
  try {
    res = await call('/api/youtube/info?id=dQw4w9WgXcQ');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), {title: 'Some Song', author: 'Some Channel'});
    assert.match(res.headers.get('Cache-Control'), /max-age=86400/);
    assert.strictEqual(asked.length, 1);
    assert.strictEqual(asked[0], 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json');
    for (const bad of ['', '?id=', '?id=short', '?id=dQw4w9WgXcQx', '?id=dQw4w9WgXc%2F', '?id=dQw4w9WgXc.', '?id=../../etc/pw']) {
      res = await call('/api/youtube/info' + bad);
      assert.strictEqual(res.status, 400, 'bad id ' + bad);
    }
    assert.strictEqual(asked.length, 1, 'a bad id never reaches YouTube');
    upstream = () => new Response('nope', {status: 404});
    assert.strictEqual((await call('/api/youtube/info?id=dQw4w9WgXcQ')).status, 404, 'upstream 404');
    upstream = () => new Response('nope', {status: 401});
    assert.strictEqual((await call('/api/youtube/info?id=dQw4w9WgXcQ')).status, 404, 'embedding off / private');
    upstream = () => new Response('oops', {status: 500});
    assert.strictEqual((await call('/api/youtube/info?id=dQw4w9WgXcQ')).status, 502, 'upstream 500');
    upstream = () => { throw new TypeError('network down'); };
    res = await call('/api/youtube/info?id=dQw4w9WgXcQ');
    assert.strictEqual(res.status, 502, 'upstream unreachable');
    assert(typeof (await res.json()).error === 'string');
    upstream = () => new Response('not json', {status: 200});
    assert.strictEqual((await call('/api/youtube/info?id=dQw4w9WgXcQ')).status, 502, 'upstream not JSON');
    upstream = () => new Response('{"x":1}', {status: 200});
    assert.strictEqual((await call('/api/youtube/info?id=dQw4w9WgXcQ')).status, 502, 'no title');
    assert.strictEqual((await call('/api/youtube/info?id=dQw4w9WgXcQ', {method: 'POST', body: 'x'})).status, 405);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.strictEqual(res.headers.get('Content-Security-Policy'), null, 'no CSP is set, so the YouTube iframe and script are not blocked');

  // YouTube routes and unknown API routes
  for (const [p, init] of [['/api/youtube', {method: 'POST', body: '{"url":"x"}'}], ['/api/progress?job=1', {}], ['/api/progress', {}]]) {
    res = await call(p, init);
    assert.strictEqual(res.status, 501, p);
    assert.deepStrictEqual(await res.json(), {error: "YouTube import isn't available on the hosted site"});
  }
  res = await call('/api/dj/voice', {method: 'POST', body: '{}'});
  assert.strictEqual(res.status, 404);
  assert.deepStrictEqual(await res.json(), {error: 'not found'});
  assert.strictEqual((await call('/api/other')).status, 404);
  assert.strictEqual((await call('/api/dj/pick')).status, 405);

  // /api/dj/pick
  const lib = [{id: 'a', artist: 'A', title: 'T', bpm: 120, genre: 'house'}, {id: 'b', artist: 'B', title: 'U', bpm: 122, genre: 'house'}];
  res = await postPick({library: lib, count: 1, nowPlaying: 'A - T', played: ['A - T']});
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).picks[0].id, 'b');
  assert.strictEqual((await postPick({library: lib}, {Origin: ORIGIN})).status, 200, 'own origin');
  assert.strictEqual((await postPick({library: lib}, {Origin: 'https://example.com'})).status, 403, 'other origin');
  assert.strictEqual((await postPick({library: lib}, {Origin: 'null'})).status, 403);
  assert.strictEqual((await postPick({library: lib}, {Origin: 'http://airdeck.example.workers.dev'})).status, 403, 'wrong scheme');
  assert.strictEqual((await call('/api/youtube', {method: 'POST', headers: {Origin: 'https://example.com'}, body: '{}'})).status, 403);
  for (const bad of ['{nope', '[]', 'null', '"x"', '\u0000']) assert.strictEqual((await postPick(bad)).status, 400, bad);
  res = await call('/api/dj/pick', {method: 'POST', body: new Uint8Array([0xff, 0xfe])});
  assert.strictEqual(res.status, 400, 'not UTF-8');
  assert.strictEqual((await postPick('')).status, 400, 'empty body = {} = no library');
  assert.strictEqual((await postPick({count: 'oops'})).status, 400);
  const big = JSON.stringify({library: lib, pad: 'x'.repeat(1024 * 1024)});
  res = await postPick(big);
  assert.strictEqual(res.status, 413, 'body over 1 MB');
  assert.deepStrictEqual(await res.json(), {error: 'request body too large'});
  // Over the cap without a Content-Length header (a stream).
  res = await call('/api/dj/pick', {method: 'POST', duplex: 'half', body: new Blob([big]).stream()});
  assert.strictEqual(res.status, 413, 'streamed body over 1 MB');

  // Hosted audio: /music/<id>.m4a from R2 (MUSIC), never from ASSETS.
  const before = calls.assets.length;
  const bytes = async (r) => Buffer.from(await r.arrayBuffer());
  res = await call('/music/funkorama.m4a');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('Content-Type'), 'audio/mp4');
  assert.strictEqual(res.headers.get('Accept-Ranges'), 'bytes');
  assert.strictEqual(res.headers.get('Content-Length'), '100');
  assert.strictEqual(res.headers.get('ETag'), '"abc123"');
  assert.match(res.headers.get('Cache-Control'), /max-age=31536000/);
  assert.strictEqual(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert(AUDIO.equals(await bytes(res)), 'whole object');
  res = await call('/music/funkorama.m4a', {method: 'HEAD'});
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('Content-Length'), '100');
  assert.strictEqual((await bytes(res)).length, 0, 'HEAD has no body');
  const rangeOf = async (range) => call('/music/funkorama.m4a', {headers: {Range: range}});
  res = await rangeOf('bytes=10-19');
  assert.strictEqual(res.status, 206);
  assert.strictEqual(res.headers.get('Content-Range'), 'bytes 10-19/100');
  assert.strictEqual(res.headers.get('Content-Length'), '10');
  assert(AUDIO.subarray(10, 20).equals(await bytes(res)), 'range body');
  res = await rangeOf('bytes=90-');
  assert.strictEqual(res.status, 206);
  assert.strictEqual(res.headers.get('Content-Range'), 'bytes 90-99/100');
  res = await rangeOf('bytes=-5');
  assert.strictEqual(res.status, 206);
  assert.strictEqual(res.headers.get('Content-Range'), 'bytes 95-99/100');
  res = await rangeOf('bytes=50-500');
  assert.strictEqual(res.headers.get('Content-Range'), 'bytes 50-99/100', 'end is clamped');
  assert.strictEqual(res.status, 206);
  res = await rangeOf('bytes=0-0');
  assert.strictEqual(res.headers.get('Content-Length'), '1');
  for (const bad of ['bytes=100-', 'bytes=200-300', 'bytes=20-10', 'bytes=-0', 'bytes=abc']) {
    res = await rangeOf(bad);
    assert.strictEqual(res.status, 416, bad);
    assert.strictEqual(res.headers.get('Content-Range'), 'bytes */100', bad);
  }
  res = await call('/music/funkorama.m4a', {method: 'HEAD', headers: {Range: 'bytes=0-9'}});
  assert.strictEqual(res.status, 206);
  assert.strictEqual(res.headers.get('Content-Range'), 'bytes 0-9/100');
  // Missing objects and invalid ids: 404, and an invalid id never reaches R2.
  assert.strictEqual((await call('/music/missing.m4a')).status, 404, 'missing object');
  const r2Before = calls.r2.length;
  for (const bad of ['/music/Funkorama.m4a', '/music/good_ID-1.m4a', '/music/' + 'a'.repeat(21) + '.m4a', '/music/.m4a', '/music/a.mp3', '/music/a/b.m4a', '/music/..%2Ffunkorama.m4a', '/music/funkorama.m4a/']) {
    res = await call(bad);
    assert.strictEqual(res.status, 404, bad);
    assert.strictEqual(res.status === 404 && (await res.text()).includes('not found'), true, bad + ' comes from ASSETS (not found) or the Worker');
  }
  assert.strictEqual(calls.r2.length, r2Before, 'invalid ids never reach R2');
  assert.strictEqual((await call('/music/funkorama.m4a', {method: 'POST', body: 'x'})).status, 405);
  assert.strictEqual(calls.assets.length, before + 8, 'valid /music requests never touch ASSETS; bad ids fall through to it');
  // Without the bucket bound the audio comes from the static assets.
  const beforeAssets = calls.assets.length;
  await worker.fetch(new Request(ORIGIN + '/music/funkorama.m4a'), {ASSETS: env.ASSETS});
  assert.strictEqual(calls.assets.length, beforeAssets + 1, 'no bucket: /music falls through to ASSETS');
  console.log('PASS: Worker routes: pages, /api/config, picker with origin/body checks, 501/404 API routes, hosted audio from R2 (ranges, 416, 404, id validation)');
})().catch((error) => { console.error(error); process.exitCode = 1; });
