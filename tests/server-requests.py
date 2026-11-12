"""Exercise real HTTP handlers in memory; no sockets or downloads."""
import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
from pathlib import Path
from email.message import Message

spec = importlib.util.spec_from_file_location('server', Path(__file__).resolve().parents[1] / 'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
PORT = server.PORT
LOCAL = f'localhost:{PORT}'


def request(raw, length=None, origin=None, host=LOCAL, path='/api/dj/pick'):
    handler = object.__new__(server.Handler)
    handler.path = path
    handler.headers = Message()
    handler.headers['Host'] = host
    handler.headers['Content-Length'] = str(len(raw) if length is None else length)
    if origin:
        handler.headers['Origin'] = origin
    handler.rfile = io.BytesIO(raw)
    handler.close_connection = False
    result = []
    handler.send_json = lambda status, body: result.append((status, body))
    handler.do_POST()
    return result, handler.close_connection


def status_of(raw, **options):
    result, _ = request(raw, **options)
    return result[0][0]


@contextlib.contextmanager
def env(**values):
    """Set environment variables for a block (None unsets one), then restore them."""
    saved = {key: os.environ.get(key) for key in values}
    for key, value in values.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value
    try:
        yield
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


@contextlib.contextmanager
def temp_site():
    """Point the server's files (downloads, index) at a temporary folder."""
    names = ('ROOT', 'DOWNLOADS', 'DOWNLOAD_INDEX')
    saved = {name: getattr(server, name) for name in names}
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        server.ROOT = root
        server.DOWNLOADS = root / 'downloads'
        server.DOWNLOAD_INDEX = server.DOWNLOADS / 'index.json'
        try:
            yield root
        finally:
            for name, value in saved.items():
                setattr(server, name, value)


LIBRARY = [
    {'id': 'abc123DEF45', 'artist': 'A', 'title': 'T', 'bpm': 120, 'genre': 'house'},
    {'id': 'xyz987QRS65', 'artist': 'B', 'title': 'U', 'bpm': 122, 'genre': 'house'},
    {'id': 'hhh111HHH11', 'artist': 'C', 'title': 'V', 'bpm': 90, 'genre': 'hip-hop'},
]


def pick(body, **options):
    result, _ = request(json.dumps(body).encode(), **options)
    return result[0]


failures = []
for raw, length in [(b'{"count":"oops"}', None), (b'{"queued":null}', None),
                    (b'{"library":42}', None), (b'{"played":{}}', None),
                    (b'\xff', None), (b'{}', -1), (b'{}', 2**30)]:
    try:
        result, closed = request(raw, length)
        assert result and result[0][0] in (400, 413), result
        if length is not None:
            assert closed
    except Exception as error:
        failures.append(f'{raw!r}, length={length}: {type(error).__name__}: {error}')
assert not failures, '\n'.join(failures)

# Origin and Host: only this server's own names on its own port (DNS rebinding is refused).
ok_body = json.dumps({'library': LIBRARY, 'count': 1}).encode()
assert status_of(b'{}', origin='https://example.com') == 403
assert status_of(ok_body, origin=f'http://localhost:{PORT}') == 200  # our own page
assert status_of(ok_body, origin=f'http://127.0.0.1:{PORT}', host=f'127.0.0.1:{PORT}') == 200
assert status_of(ok_body) == 200  # no Origin header (a script or curl) on our own Host
assert status_of(b'{}', origin=f'http://evil.example:{PORT}', host=f'evil.example:{PORT}') == 403  # rebinding
assert status_of(b'{}', host=f'evil.example:{PORT}') == 403
assert status_of(b'{}', origin=f'https://localhost:{PORT}') == 403  # wrong scheme
assert status_of(b'{}', origin=f'http://localhost:{PORT + 1}') == 403  # wrong port in Origin
assert status_of(b'{}', host=f'localhost:{PORT + 1}') == 403  # wrong port in Host
assert status_of(b'{}', origin='null') == 403
assert status_of(b'{}', host=f'evil.example@localhost:{PORT}') == 403  # userinfo trick
handler = object.__new__(server.Handler)
handler.path = f'/api/progress?job=x'
handler.headers = Message()
handler.headers['Host'] = f'evil.example:{PORT}'
answers = []
handler.send_json = lambda status, body: answers.append(status)
handler.do_GET()
assert answers == [403], answers

# Picks are always local: no keys, no network, the closest library songs.
with env(GEMINI_API_KEY=None, ELEVENLABS_API_KEY=None):
    status, body = pick({'library': LIBRARY, 'count': 3, 'nowPlaying': 'A - T', 'queued': [], 'played': ['A - T']})
    assert status == 200 and set(body) == {'picks'}, (status, body)
    ids = [p['id'] for p in body['picks']]
    assert ids == ['xyz987QRS65', 'hhh111HHH11'], ids  # same genre first, no repeat of the playing song
    assert all(p['reason'] and p['intro'] and 'offline' not in p['reason'].lower() for p in body['picks']), body
    # The vibe picks the opening song when nothing is playing.
    status, body = pick({'library': LIBRARY, 'count': 1, 'vibe': 'some hip-hop'})
    assert status == 200 and body['picks'][0]['id'] == 'hhh111HHH11', body
    # Energy words open with the tempo extremes of the library (LIBRARY: 90, 120, 122 BPM).
    def opener(vibe, **extra):
        status, body = pick({'library': LIBRARY, 'count': 1, 'vibe': vibe, **extra})
        assert status == 200, (status, body)
        return body['picks'][0]
    calm = opener('chill')
    assert calm['id'] == 'hhh111HHH11' and calm['reason'] == 'calm opener', calm  # lowest BPM
    fast = opener('hype')
    assert fast['id'] == 'xyz987QRS65' and fast['reason'] == 'high-energy opener', fast  # highest BPM
    assert opener('turn up')['id'] == 'xyz987QRS65' and opener('lo-fi')['id'] == 'hhh111HHH11'
    assert opener('chill into hype')['id'] == 'hhh111HHH11'  # the earliest mood word sets the opener
    # Mood words match names only as whole words: "hard" isn't "Richard", so it's still an energy word.
    richard = [dict(LIBRARY[0], artist='Richard'), *LIBRARY[1:]]
    hard = pick({'library': richard, 'count': 1, 'vibe': 'hard'})[1]['picks'][0]
    assert hard['id'] == 'xyz987QRS65' and hard['reason'] == 'high-energy opener', hard
    # A genre, artist or title match still wins over an energy word.
    won = opener('party hip-hop')
    assert won['id'] == 'hhh111HHH11' and won['reason'] == 'matches your vibe', won
    assert opener('rap')['id'] == 'hhh111HHH11'  # "rap" is an alias for hip-hop
    # An empty vibe opens with the first song in the library.
    first = opener('')
    assert first['id'] == 'abc123DEF45' and first['reason'] == 'starts the set', first
    # Energy openers skip songs already played or queued.
    assert opener('chill', played=['C - V'])['id'] == 'abc123DEF45'
    assert opener('hype', queued=['B - U'])['id'] == 'abc123DEF45'
    # Every song played: repeats are allowed, the one played longest ago first.
    status, body = pick({'library': LIBRARY, 'count': 1, 'played': ['A - T', 'B - U', 'C - V'], 'queued': []})
    assert status == 200 and body['picks'][0]['id'] == 'abc123DEF45', body
    # No library: a clear 400, never a call to an outside service.
    for raw in [{'count': 1}, {'library': []}, {'library': [{'artist': 'no id'}]}]:
        status, body = pick(raw)
        assert status == 400 and 'library' in body['error'], (raw, status, body)

# The retired voice route is gone; the Host check still comes first for every route.
assert status_of(b'{"text":"hi"}', path='/api/dj/voice') == 404
assert status_of(b'{}', path='/api/dj/nothing') == 404
assert status_of(ok_body, host=f'evil.example:{PORT}', path='/api/dj/pick') == 403
assert status_of(ok_body, origin='https://example.com', path='/api/dj/pick') == 403
assert status_of(b'{"text":"hi"}', host=f'evil.example:{PORT}', path='/api/dj/voice') == 403
assert not hasattr(server, 'dj_voice') and not hasattr(server, 'ask_gemini_for_picks')

# Malformed YouTube input: a clean 400 before any download starts.
saved_get_song = server.get_song


def no_download(*args, **kwargs):
    raise AssertionError('a bad request must not start a download')


server.get_song = no_download
try:
    for raw in [b'{}', b'{"url": null}', b'{"url": ["https://www.youtube.com/watch?v=abcdefghijk"]}',
                b'{"url": 42}', json.dumps({'url': 'https://www.youtube.com/watch?v=abcdefghijk\x00'}).encode(),
                b'{"url": "clarity \\ud800"}']:
        assert status_of(raw, path='/api/youtube') == 400, raw
    # Deeply nested JSON is a 400 too (it used to raise RecursionError).
    assert status_of(b'[' * 100000 + b']' * 100000) == 400
finally:
    server.get_song = saved_get_song

# log_message must not crash on a request that has no path yet.
handler = object.__new__(server.Handler)
handler.client_address = ('127.0.0.1', 0)
with contextlib.redirect_stderr(io.StringIO()):
    server.Handler.log_message(handler, '%s', 'no path yet')

# Download cache: search terms ignore case; video ids and links keep it.
assert server.cache_key('ytsearch1:Clarity Zedd') == 'ytsearch1:clarity zedd'
assert server.cache_key('https://www.youtube.com/watch?v=AbCdEfGhIjK') == 'https://www.youtube.com/watch?v=AbCdEfGhIjK'
with temp_site() as site:
    (site / 'downloads').mkdir()
    (site / 'downloads' / 'one.m4a').write_bytes(b'a')
    (site / 'downloads' / 'two.m4a').write_bytes(b'b')
    server.remember('ytsearch1:Clarity Zedd', {'file': 'downloads/one.m4a', 'title': 'One'})
    server.remember('https://www.youtube.com/watch?v=AbCdEfGhIjK', {'file': 'downloads/two.m4a', 'title': 'Two'})
    assert server.remembered('ytsearch1:CLARITY zedd')['title'] == 'One'
    assert server.remembered('https://www.youtube.com/watch?v=AbCdEfGhIjK')['title'] == 'Two'
    assert server.remembered('https://www.youtube.com/watch?v=abcdefghijk') is None
    assert json.loads(server.DOWNLOAD_INDEX.read_text(encoding='utf-8'))
    assert not list((site / 'downloads').glob('*.part')), 'index writes must leave no temp files'

# yt-dlp missing: say so (503), instead of a generic download failure.
MISSING_SCRIPT = "import sys; sys.stderr.write('/usr/bin/python3: No module named yt_dlp\\n'); sys.exit(1)"
saved_ytdlp = server.YTDLP
try:
    for command in ([sys.executable, '-c', MISSING_SCRIPT], ['/nonexistent/yt-dlp-not-installed']):
        server.YTDLP = command
        with temp_site():
            entry, error = server.get_song('ytsearch1:clarity')
        assert entry is None and error == server.YTDLP_MISSING, (command, error)
    server.YTDLP = [sys.executable, '-c', MISSING_SCRIPT]
    with temp_site():
        result, _ = request(b'{"url": "clarity"}', path='/api/youtube')
    assert result[0][0] == 503 and "isn't installed" in result[0][1]['error'], result
finally:
    server.YTDLP = saved_ytdlp

# Repeat branch: every real library song queued AND played still picks, never the playing song.
real = json.loads((Path(__file__).resolve().parents[1] / 'library.json').read_text(encoding='utf-8'))['songs']
assert len(real) == 25
labels = [f"{song['artist']} - {song['title']}" for song in real]
status, body = pick({'library': real, 'count': 3, 'nowPlaying': labels[4], 'queued': labels, 'played': labels})
assert status == 200 and len(body['picks']) == 3, (status, body)
assert all(p['id'] != real[4]['id'] for p in body['picks']), body
# Played longest ago comes first when everything is queued too.
status, body = pick({'library': LIBRARY, 'count': 1, 'queued': ['A - T', 'B - U', 'C - V'], 'played': ['C - V', 'A - T', 'B - U']})
assert status == 200 and body['picks'][0]['id'] == 'hhh111HHH11', body
# A small library never repeats the song now playing.
status, body = pick({'library': LIBRARY[:2], 'count': 3, 'nowPlaying': 'A - T', 'queued': [], 'played': ['A - T']})
assert status == 200 and [p['id'] for p in body['picks']] == ['xyz987QRS65'], body
status, body = pick({'library': LIBRARY[:2], 'count': 2, 'nowPlaying': 'A - T', 'queued': ['A - T', 'B - U'], 'played': ['A - T', 'B - U']})
assert status == 200 and [p['id'] for p in body['picks']] == ['xyz987QRS65'], body
# A one-song library falls back to that song instead of failing.
assert pick({'library': LIBRARY[:1], 'count': 1, 'nowPlaying': 'A - T', 'played': ['A - T']})[0] == 200

# Filler words don't substring-match names: "something for the party" is an energy opener, not "Nice For What".
nice = [dict(LIBRARY[0], artist='Drake', title='Nice For What', bpm=90), dict(LIBRARY[1], bpm=130), LIBRARY[2]]
status, body = pick({'library': nice, 'count': 1, 'vibe': 'something for the party'})
assert status == 200 and body['picks'][0]['id'] == 'xyz987QRS65' and body['picks'][0]['reason'] == 'high-energy opener', body
# A whole word still matches ("nice" is a real title word), a partial one does not.
assert pick({'library': nice, 'count': 1, 'vibe': 'nice'})[1]['picks'][0]['id'] == 'abc123DEF45'
partial = pick({'library': nice, 'count': 1, 'vibe': 'wha'})[1]['picks'][0]
assert partial['reason'] == 'starts the set', partial

# Library ids must be strings (400, not a dropped connection); long ids still resolve consistently.
for bad in ([['x']], 12345, {'a': 1}, None):
    status, _ = pick({'library': [dict(LIBRARY[0], id=bad)], 'count': 1})
    assert status == 400, bad
long_id = 'L' * 40
long_library = [dict(LIBRARY[0], id=long_id), LIBRARY[1]]
status, body = pick({'library': long_library, 'count': 2, 'vibe': 'house'})
assert status == 200 and len(body['picks']) == 2 and body['picks'][0]['id'] == 'L' * 20, body

# /api/progressZZZ is not the progress route (it goes on to static serving).
served = []
saved_get = server.SimpleHTTPRequestHandler.do_GET
server.SimpleHTTPRequestHandler.do_GET = lambda self: served.append(self.path)
try:
    for path, expected in (('/api/progress?job=x', []), ('/api/progress', []), ('/api/progressZZZ', ['/api/progressZZZ']),
                           ('/api/progressZZZ?job=x', ['/api/progressZZZ?job=x'])):
        served.clear()
        handler = object.__new__(server.Handler)
        handler.path = path
        handler.headers = Message()
        handler.headers['Host'] = LOCAL
        answers = []
        handler.send_json = lambda status, body: answers.append(status)
        handler.do_GET()
        assert served == expected and answers == ([200] if not expected else []), (path, served, answers)
finally:
    server.SimpleHTTPRequestHandler.do_GET = saved_get

# Valid shape still reaches the picker; replace only the external service boundary.
assert status_of(ok_body) == 200
print('PASS: origin/Host checks, offline AI DJ picks, the removed voice route, malformed input, the download cache and yt-dlp-missing errors all return clean responses')
