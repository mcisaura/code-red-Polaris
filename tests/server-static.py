"""Run: python3 tests/server-static.py. Private files stay inaccessible over HTTP."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import threading
import urllib.request
import urllib.error

spec = importlib.util.spec_from_file_location("airdeck_server", Path(__file__).resolve().parents[1] / "server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

with tempfile.TemporaryDirectory() as temporary, tempfile.TemporaryDirectory() as outside:
    server.ROOT = Path(temporary)
    (server.ROOT / ".env").write_text("TEST_SETTING=private-fixture")
    (server.ROOT / ".git").mkdir()
    (server.ROOT / ".git" / "config").write_text("private-fixture")
    (server.ROOT / "landing.html").write_text("public-home")
    (server.ROOT / "asset.js").write_text("public-asset")
    (server.ROOT / "assets").mkdir()
    # Links to private files, inside the site and outside it.
    (Path(outside) / "secret.txt").write_text("private-fixture")
    (server.ROOT / "link-env.js").symlink_to(server.ROOT / ".env")
    (server.ROOT / "link-git").symlink_to(server.ROOT / ".git", target_is_directory=True)
    (server.ROOT / "link-outside.txt").symlink_to(Path(outside) / "secret.txt")
    handler = type("QuietHandler", (server.Handler,), {"log_message": lambda *args: None})
    http = server.Server(("127.0.0.1", 0), handler)
    worker = threading.Thread(target=http.serve_forever, daemon=True)
    worker.start()
    base = f"http://127.0.0.1:{http.server_port}"
    try:
        blocked = ["/.env", "/%2eenv", "/.env?cache=1", "/.git/config", "/%2egit/config", "/assets/",
                   "/c://.env", "/c:/.env", "/c:.env", "/%00", "/asset.js%00", "//[x",
                   "/link-env.js", "/link-git/config", "/link-outside.txt"]
        for method in ("GET", "HEAD"):
            for path in blocked:
                try:
                    urllib.request.urlopen(urllib.request.Request(base + path, method=method)).close()
                    raise AssertionError(f"{method} {path} should be blocked")
                except urllib.error.HTTPError as error:
                    assert error.code == 404, (path, error.code)
            for path in ("/", "/asset.js"):
                with urllib.request.urlopen(urllib.request.Request(base + path, method=method)) as response:
                    assert response.status == 200
        print("PASS: GET/HEAD hide configuration, Git metadata, symlinks to them, NUL and malformed paths and directory listings; public assets still serve")
    finally:
        http.shutdown()
        http.server_close()
        worker.join()

# .env loading: a byte-order mark doesn't hide the first key; unreadable or odd files are skipped quietly.
with tempfile.TemporaryDirectory() as folder:
    folder = Path(folder)
    (folder / "bom.env").write_bytes("\ufeffAIRDECK_TEST_BOM=first\nAIRDECK_TEST_OTHER=second\n".encode("utf-8"))
    (folder / "latin.env").write_bytes(b"AIRDECK_TEST_LATIN=private-fixture\xff\xfe")
    (folder / "folder.env").mkdir()
    try:
        report = io.StringIO()
        with contextlib.redirect_stdout(report):
            server.load_env_file(folder / "bom.env")
            server.load_env_file(folder / "latin.env")
            server.load_env_file(folder / "folder.env")
            server.load_env_file(folder / "missing.env")
        assert os.environ.get("AIRDECK_TEST_BOM") == "first", "BOM hid the first key"
        assert os.environ.get("AIRDECK_TEST_OTHER") == "second"
        assert "AIRDECK_TEST_LATIN" not in os.environ
        assert "latin.env" in report.getvalue() and "folder.env" in report.getvalue(), report.getvalue()
        assert "private-fixture" not in report.getvalue(), "warnings must not show file contents"
    finally:
        os.environ.pop("AIRDECK_TEST_BOM", None)
        os.environ.pop("AIRDECK_TEST_OTHER", None)
print("PASS: .env loads with a byte-order mark; non-UTF-8 files and folders are skipped with a warning")
