"""Exercise real HTTP handlers in memory; no sockets, downloads, or paid API calls."""
import contextlib
import http.client
import importlib.util
import io
import json
import os
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from email.message import Message

spec = importlib.util.spec_from_file_location('server', Path(__file__).resolve().parents[1] / 'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
REAL_ASK = server.ask_gemini_for_picks
server.ask_gemini_for_picks = lambda *args: [{"artist": "Test", "title": "Fixture", "reason": "", "intro": ""}]
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
def real_gemini():
    """Use the real Gemini picker; its HTTP call is replaced by fake_http."""
    fixture = server.ask_gemini_for_picks
    server.ask_gemini_for_picks = REAL_ASK
    try:
        yield
    finally:
        server.ask_gemini_for_picks = fixture


class FakeResponse:
    def __init__(self, data):
        self.data = data

    def read(self):
        return self.data

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@contextlib.contextmanager
def fake_http(answer):
    """The server's one outgoing HTTP call returns `answer` (bytes), or raises it if it is an exception."""
    saved = urllib.request.urlopen

    def urlopen(request, timeout=None):
        if isinstance(answer, BaseException):
            raise answer
        return FakeResponse(answer)

    urllib.request.urlopen = urlopen
    try:
        yield
    finally:
        urllib.request.urlopen = saved


@contextlib.contextmanager
def temp_site():
    """Point the server's files (downloads, voice cache, index) at a temporary folder."""
    names = ('ROOT', 'DOWNLOADS', 'VOICES', 'DOWNLOAD_INDEX')
    saved = {name: getattr(server, name) for name in names}
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        server.ROOT = root
        server.DOWNLOADS = root / 'downloads'
        server.VOICES = server.DOWNLOADS / 'voice'
        server.DOWNLOAD_INDEX = server.DOWNLOADS / 'index.json'
        try:
            yield root
        finally:
            for name, value in saved.items():
                setattr(server, name, value)


def gemini_answer(text):
    """A Gemini generateContent response whose only text is `text`."""
    return json.dumps({'candidates': [{'content': {'parts': [{'text': text}]}}]}).encode()


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
ok_body = b'{"count":1}'
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

# Gemini failures become DjError (a clean 502, or the library's offline fallback). Never a crash.
PROMPT = 'Vibe: test\nPick 1 songs.'
with env(GEMINI_API_KEY='test-key'):
    bad_answers = [
        b'<html>Bad Gateway</html>',
        b'{"candidates": []}',
        gemini_answer('not json'),
        gemini_answer('{"picks": "oops"}'),
        gemini_answer('{"picks": [1, 2]}'),
        gemini_answer('[1]'),
        b'{"candidates": [{"content": {"parts": ["x"]}}]}',
        http.client.RemoteDisconnected('closed'),
        http.client.IncompleteRead(b'part'),
        OSError('connection reset'),
        ValueError('bad response'),
        urllib.error.HTTPError('https://example.com', 503, 'busy', {}, io.BytesIO(b'{"error": {"message": "overloaded"}}')),
    ]
    for answer in bad_answers:
        with fake_http(answer):
            try:
                REAL_ASK(PROMPT, server.PICK_SCHEMA)
            except server.DjError:
                continue
        raise AssertionError(f'{answer!r} should be a DjError')
    good = json.dumps({'picks': [{'artist': 'A', 'title': 'T', 'reason': 'r', 'intro': 'i'}]})
    with fake_http(gemini_answer(good)):
        assert REAL_ASK(PROMPT, server.PICK_SCHEMA) == [{'artist': 'A', 'title': 'T', 'reason': 'r', 'intro': 'i'}]
    library = [{'id': 'abc123DEF45', 'artist': 'A', 'title': 'T', 'bpm': 120, 'genre': 'house'},
               {'id': 'xyz987QRS65', 'artist': 'B', 'title': 'U', 'bpm': 122, 'genre': 'house'}]
    library_body = json.dumps({'library': library, 'count': 1}).encode()
    with real_gemini(), fake_http(urllib.error.URLError('no route to host')):
        result, _ = request(library_body)
    assert result[0][0] == 200 and result[0][1]['offline'] and result[0][1]['picks'][0]['id'] in {'abc123DEF45', 'xyz987QRS65'}, result
    with real_gemini(), fake_http(gemini_answer('{"picks": "oops"}')):
        result, _ = request(library_body)
    assert result[0][0] == 200 and result[0][1]['offline'], result
    with real_gemini(), fake_http(gemini_answer('{"picks": 5}')):
        result, _ = request(b'{"count":1}')
    assert result[0][0] == 502 and 'error' in result[0][1], result

# A missing API key is a 503 (library mode still falls back to the offline picks).
with env(GEMINI_API_KEY=None), real_gemini():
    assert status_of(b'{"count":1}') == 503
    assert status_of(library_body) == 200

# Voice: 503 without a key, 400 for empty text, only real audio is cached.
with temp_site(), env(ELEVENLABS_API_KEY=None):
    assert status_of(b'{"text":"hi"}', path='/api/dj/voice') == 503
with temp_site() as site, env(ELEVENLABS_API_KEY='test-key'):
    for raw in [b'{"text":"   "}', b'{"text":null}', b'{"text":5}', b'{}']:
        assert status_of(raw, path='/api/dj/voice') == 400, raw
    with fake_http(b'<!doctype html><p>quota exceeded</p>'):
        result, _ = request(b'{"text":"hi"}', path='/api/dj/voice')
    assert result[0][0] == 502, result
    assert not list(server.VOICES.glob('*.mp3')), 'an HTML error page must not be cached'
    with fake_http(b'ID3\x03\x00fake-audio'):
        result, _ = request(b'{"text":"hi"}', path='/api/dj/voice')
    assert result[0][0] == 200 and (site / result[0][1]['file']).read_bytes().startswith(b'ID3'), result
    with fake_http(OSError('should be served from the cache')):
        assert status_of(b'{"text":"hi"}', path='/api/dj/voice') == 200

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

# Valid shape still reaches the picker; replace only the external service boundary.
assert status_of(ok_body) == 200
print('PASS: origin/Host checks, Gemini and ElevenLabs failures, malformed input, the download cache and yt-dlp-missing errors all return clean responses')
