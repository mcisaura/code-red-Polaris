"""Run: python3 tests/server-downloads.py. Downloads with a stub yt-dlp, the per-target lock and prefetch's atomic copy."""
import importlib.util
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
import server  # noqa: E402
import prefetch  # noqa: E402

STUB = r'''
import sys, time
time.sleep(float(sys.argv[1]))
print("[youtube] Extracting URL: x")
print("WARNING: something odd")
print("AIRDECK-TITLE " + sys.argv[2])
print("[download] Destination: " + sys.argv[3])
open(sys.argv[3], "wb").write(b"audio")
print("AIRDECK-FILE " + sys.argv[3])
'''
saved = {name: getattr(server, name) for name in ('ROOT', 'DOWNLOADS', 'DOWNLOAD_INDEX', 'YTDLP', 'STRATEGIES')}
with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    server.ROOT = root
    server.DOWNLOADS = root / 'downloads'
    server.DOWNLOAD_INDEX = server.DOWNLOADS / 'index.json'
    server.STRATEGIES = [('default', [])]
    (root / 'stub.py').write_text(STUB)
    server.DOWNLOADS.mkdir()
    try:
        # A title that starts with "[" (or "ERROR:") is a valid title, not yt-dlp chatter.
        for title in ('[MV] Song', 'WARNING: loud', 'ERROR: not really'):
            out = str(server.DOWNLOADS / 'a.m4a')
            server.YTDLP = [sys.executable, str(root / 'stub.py'), '0', title, out]
            result, error = server.download('ytsearch1:x', [])
            assert error is None and result == (title, Path(out)), (title, result, error)

        # Two simultaneous requests for one target run yt-dlp once.
        runs = root / 'runs'
        runs.write_text('')
        counting = STUB.replace('time.sleep(', 'open(%r, "a").write("x"); time.sleep(' % str(runs))
        (root / 'stub.py').write_text(counting)
        out = str(server.DOWNLOADS / 'b.m4a')
        server.YTDLP = [sys.executable, str(root / 'stub.py'), '0.5', 'Title', out]
        results = []
        threads = [threading.Thread(target=lambda: results.append(server.get_song('ytsearch1:same'))) for _ in range(3)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert len(results) == 3 and all(r[0] and r[0]['title'] == 'Title' for r in results), results
        assert runs.read_text() == 'x', f'yt-dlp ran {len(runs.read_text())} times for one target'
    finally:
        for name, value in saved.items():
            setattr(server, name, value)

# prefetch: an interrupted copy leaves no truncated music/<id>.m4a behind.
with tempfile.TemporaryDirectory() as temporary:
    folder = Path(temporary)
    source, target = folder / 'src.m4a', folder / 'id.m4a'
    source.write_bytes(b'complete audio')
    real_copy = prefetch.shutil.copyfile

    def broken(src, dst):
        Path(dst).write_bytes(b'trunc')
        raise OSError('disk full')

    prefetch.shutil.copyfile = broken
    try:
        try:
            prefetch.install(source, target)
            raise AssertionError('the copy should have failed')
        except OSError:
            pass
    finally:
        prefetch.shutil.copyfile = real_copy
    assert not target.exists() and not list(folder.glob('*.part')), sorted(os.listdir(folder))
    prefetch.install(source, target)
    assert target.read_bytes() == b'complete audio' and not list(folder.glob('*.part'))
print('PASS: stub yt-dlp titles that look like log lines, one download per target, and atomic prefetch copies')
