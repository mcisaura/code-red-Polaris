"""AirDeck dev server: serves the static site, downloads YouTube audio, and picks the AI DJ's songs.

Run:  python3 server.py   (then open http://localhost:8000)
POST /api/youtube  {"url": "https://www.youtube.com/watch?v=..."}
  -> {"file": "downloads/<id>.m4a", "title": "..."}
"url" can also be plain words ("clarity zedd") or a YouTube search link: both
download the top search result.
POST /api/dj/pick  {"vibe": "...", "nowPlaying": "...", "queued": [...], "played": [...], "count": 3}
  -> {"picks": [{"id", "artist", "title", "reason", "intro"}]}
Also "library": [{"id", "artist", "title", "bpm", "genre"}], required: the closest songs
by genre and tempo are picked from it, offline (no outside service, no API keys).
Requires yt-dlp (pip install -U "yt-dlp[default]" or brew install yt-dlp).
"""

import contextlib
import errno
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse, urlsplit, unquote

ROOT = Path(__file__).parent


def load_env_file(path):
    """Settings from a local .env file (KEY=value per line, # for comments), so the API
    keys survive restarts and new windows. Anything already set in the environment wins.
    The file is gitignored: keys never get committed. Warnings never show its contents."""
    if not path.exists():
        return
    if not path.is_file():
        print(f"[env] skipping {path.name}: it isn't a regular file", flush=True)
        return
    try:
        # utf-8-sig drops a byte-order mark (Windows Notepad adds one), so the first key still counts.
        with path.open(encoding="utf-8-sig") as file:
            text = file.read()
    except (OSError, UnicodeDecodeError):
        print(f"[env] skipping {path.name}: it couldn't be read as UTF-8 text", flush=True)
        return
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().removeprefix("export ").strip()
        value = value.strip().strip('"').strip("'")
        if key and value and key not in os.environ:
            os.environ[key] = value


def write_atomic(path, data):
    """Replace path with data in one step, so a crash or a parallel reader never sees half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=path.stem + "-", suffix=".part")
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(data)
        os.replace(temp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temp)
        raise


load_env_file(ROOT / ".env")
DOWNLOADS = ROOT / "downloads"
# Searches and links already downloaded, so asking again (e.g. in a rehearsed demo) skips yt-dlp.
DOWNLOAD_INDEX = DOWNLOADS / "index.json"
index_lock = threading.Lock()
ALLOWED_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
PORT = 8000  # python server.py 8001 for another port; set from the command line in __main__
# Only this computer can reach the server unless you
# opt in with this machine's LAN IP, e.g. AIRDECK_HOST=192.168.1.20. The API only accepts
# that name in the Host header, so with 0.0.0.0 other computers get pages but API calls 403.
HOST = os.environ.get("AIRDECK_HOST", "").strip() or "127.0.0.1"
# The yt-dlp command, or Python's module when pip's per-user install folder isn't on PATH.
YTDLP = ["yt-dlp"] if shutil.which("yt-dlp") else [sys.executable, "-m", "yt_dlp"]
# One video only: watch, shorts and live links, or youtu.be short links.
SINGLE_VIDEO = re.compile(
    r"^https?://((www\.|m\.|music\.)?youtube\.com/(watch\?(\S*&)?v=|shorts/|live/)|youtu\.be/)[\w-]{11}\S*$"
)




def to_target(text):
    """What to hand yt-dlp, or None if it isn't allowed.

    A single video link is used as-is. A YouTube search link or plain words become
    a search for the top result. Playlists, channels and other sites are refused:
    yt-dlp would download every video in them.
    """
    text = text.strip()
    if not text or len(text) > 300:
        return None
    # NUL can't go in a command line, and a lone surrogate can't be encoded: refuse both.
    if "\x00" in text or any("\ud800" <= char <= "\udfff" for char in text):
        return None
    if SINGLE_VIDEO.match(text):
        return text
    if re.match(r"^https?://", text, re.IGNORECASE):
        parsed = urlparse(text)
        if parsed.hostname in ALLOWED_HOSTS and parsed.path == "/results":
            query = parse_qs(parsed.query).get("search_query", [""])[0].strip()
            return f"ytsearch1:{query}" if query else None
        return None
    return f"ytsearch1:{text}"


# yt-dlp needs a JavaScript runtime to see all of YouTube's formats, and only
# looks for Deno by default. Without one, downloads fail with "Requested format
# is not available". Use Node when Deno isn't installed.
JS_RUNTIME = [] if shutil.which("deno") or not shutil.which("node") else ["--js-runtimes", "node"]

# YouTube often answers 403 Forbidden for one download method but not another,
# so try several in order. The first three keep the original audio file (m4a/webm
# decode natively in the browser), or at worst a small mp4. The last gets a video file and extracts the
# audio with ffmpeg, so it's only tried when ffmpeg is installed.
AUDIO_ONLY = ["-f", "bestaudio[ext=m4a]/bestaudio"]
STRATEGIES = [
    ("default", AUDIO_ONLY),
    ("alt clients", [*AUDIO_ONLY, "--extractor-args", "youtube:player_client=tv,web_safari,mweb"]),
    # Some music videos 403 on every client above. These clients often still work, and
    # "best" (a small mp4 with audio) is a last resort the browser can still decode.
    ("more clients", ["-f", "bestaudio/best", "--extractor-args", "youtube:player_client=android_vr,web_embedded,ios"]),
]
if shutil.which("ffmpeg"):
    STRATEGIES.append(("convert", ["-f", "best", "-x", "--audio-format", "m4a"]))


# Download progress the page polls (GET /api/progress?job=...), keyed by a job id it sends.
progress = {}  # job -> {"stage": "searching" | "downloading", "percent": number or None}
progress_lock = threading.Lock()
PROGRESS_MARK = "AIRDECK-PROGRESS"
YTDLP_MISSING = 'yt-dlp isn\'t installed on the server (pip install -U "yt-dlp[default]")'


def set_progress(job, **values):
    if job:
        with progress_lock:
            progress[job] = {**progress.get(job, {}), **values}


def download(url, extra, job=None):
    """Run yt-dlp once, reporting progress for job. Returns ((title, path), None) or (None, error message)."""
    cmd = [
        *YTDLP, *JS_RUNTIME, *extra,
        "--no-playlist",
        # Never more than one file, even if the target turns out to be a list.
        "--max-downloads", "1",
        "--max-filesize", "50M",
        "--retries", "3",
        "-o", str(DOWNLOADS / "%(id)s.%(ext)s"),
        "--no-simulate",
        "--print", "title",
        "--print", "after_move:filepath",
        # One machine-readable progress line per update (shown even though --print makes it quiet).
        "--progress", "--newline",
        "--progress-template",
        f"download:{PROGRESS_MARK} %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s",
        "--", url,
    ]
    # UTF-8 so titles with accents or emoji come through intact on Windows.
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", env=env
        )
    except FileNotFoundError:
        return None, YTDLP_MISSING
    timed_out = threading.Event()

    def stop():
        timed_out.set()
        proc.kill()

    timer = threading.Timer(180, stop)
    timer.start()
    printed, errors = [], []
    missing = False
    try:
        for line in proc.stdout:
            line = line.strip()
            if "No module named" in line and "yt_dlp" in line:  # python -m yt_dlp isn't installed
                missing = True
            elif line.startswith(PROGRESS_MARK):
                numbers = []
                for value in line.split()[1:4]:
                    try:
                        numbers.append(float(value))
                    except ValueError:  # "NA" when yt-dlp doesn't know yet
                        numbers.append(None)
                done, total, estimate = (numbers + [None, None, None])[:3]
                if done is not None and (total or estimate):
                    set_progress(job, stage="downloading", percent=min(100.0, done * 100 / (total or estimate)))
            elif line.startswith("ERROR:"):
                errors.append(line)
            elif line and not line.startswith(("WARNING:", "[")):
                printed.append(line)  # what --print asked for: the title, then the file path
        proc.wait()
    finally:
        timer.cancel()
    if missing:
        return None, YTDLP_MISSING
    if timed_out.is_set():
        return None, "download timed out"
    # 101 means "stopped at --max-downloads", which is fine.
    if proc.returncode not in (0, 101) or len(printed) < 2:
        return None, (errors or ["download failed"])[-1]
    return (printed[0], Path(printed[-1])), None


def load_index():
    """The saved index. Callers hold index_lock so they never read a half-written file."""
    try:
        index = json.loads(DOWNLOAD_INDEX.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return index if isinstance(index, dict) else {}


def cache_key(target):
    """Search terms are case-insensitive ("Clarity" and "clarity" are one search). Video ids and
    links are case-sensitive, so they keep their case."""
    return target.lower() if target.startswith("ytsearch1:") else target


def remembered(target):
    """The earlier download for this search or link, if its file is still there."""
    with index_lock:
        entry = load_index().get(cache_key(target))
    return entry if isinstance(entry, dict) and "file" in entry and (ROOT / entry["file"]).exists() else None


def remember(target, entry):
    with index_lock:
        index = load_index()
        index[cache_key(target)] = entry
        try:
            write_atomic(DOWNLOAD_INDEX, json.dumps(index, indent=1).encode("utf-8"))
        except OSError as error:
            # The song is downloaded either way; only the cache is lost.
            print(f"[youtube] couldn't save the download index: {error}", flush=True)


def get_song(target, job=None):
    """The song's {"file", "title"}, downloading it unless it was downloaded before.
    Returns (entry, None) or (None, error message)."""
    hit = remembered(target)
    if hit:
        print(f"[youtube] already downloaded: {hit['title']}", flush=True)
        return hit, None

    DOWNLOADS.mkdir(exist_ok=True)
    errors = []
    for name, extra in STRATEGIES:
        print(f"[youtube] trying {name}: {target}", flush=True)
        result, err = download(target, extra, job)
        if result:
            title, filepath = result
            print(f"[youtube] ok via {name}: {title}", flush=True)
            entry = {"file": filepath.relative_to(ROOT).as_posix(), "title": title}
            remember(target, entry)
            return entry, None
        print(f"[youtube] {name} failed: {err}", flush=True)
        errors.append(err)
        if err == YTDLP_MISSING:
            break  # every other method would fail the same way
    # The first method's error is the real one; later fallbacks fail for their own reasons.
    return None, errors[0] if errors else "download failed"


# ---- AI DJ -------------------------------------------------------------------------
# Picks the next songs from the library the page sends. Nothing leaves this computer.

class DjError(Exception):
    """A DJ request failed in a way worth showing to the user."""


def clean(text, limit):
    # Lone surrogates (possible in JSON input) can't be printed or encoded: replace them.
    text = str(text).encode("utf-8", "replace").decode("utf-8")
    return " ".join(text.split())[:limit]


def bpm(song):
    """A library song's BPM as a whole number, or None."""
    try:
        return round(float(song.get("bpm"))) if song and song.get("bpm") else None
    except (TypeError, ValueError, OverflowError):
        return None


def tempo_gap(a, b):
    """How far apart two tempos are, counting half and double time as close (80 ~ 160)."""
    if not a or not b:
        return 0
    return min(abs(a - b), abs(a - 2 * b), abs(2 * a - b))


# Vibe words that set the opener's energy when no genre, artist or title matches the vibe.
CALM_WORDS = ("chill", "slow", "relax", "calm", "mellow", "soft", "smooth", "lofi", "lo fi", "easy", "sad")
ENERGY_WORDS = ("hype", "party", "energy", "fast", "banger", "turn up", "lit", "dance", "club", "workout", "gym", "hard")
# Vibe words that name a library genre by another name.
GENRE_ALIASES = {"rap": "hip-hop", "rnb": "r&b"}


def dj_pick(request):
    """Pick the next songs from the request's "library" ([{id, artist, title, bpm, genre}]).
    Returns a list of {id, artist, title, reason, intro}.

    Each song is the closest match to the one before it: same genre first, then nearest
    tempo (half and double time count as close), then nearest in the library's own order.
    Songs already queued or played are skipped until every song has played; then the ones
    played longest ago come first. With nothing playing, a song matching a word of the
    vibe (genre, artist or title) starts the set.
    """
    count = max(1, min(int(request.get("count") or 3), 5))
    library = {
        clean(song.get("id", ""), 20): song
        for song in request.get("library") or []
        if isinstance(song, dict) and song.get("id")
    }
    if not library:
        raise DjError("send the song library to pick from")

    # Songs already queued or played, by the "artist - title" label the page uses.
    label = lambda s: f"{clean(s.get('artist', ''), 80)} - {clean(s.get('title', ''), 120)}".lower()
    used = {clean(t, 200).lower() for t in [*request.get("queued", []), *request.get("played", [])]}
    unused = [s for s in library.values() if label(s) not in used]
    playing = next((s for s in library.values() if label(s) == clean(request.get("nowPlaying") or "", 200).lower()), None)
    order = {song_id: number for number, song_id in enumerate(library)}
    genre = lambda s: clean(s.get("genre", ""), 40).lower()
    first_genre = lambda s: genre(s).split("/")[0].strip()
    # Every song played already: repeats are fine, the ones played longest ago first.
    if not unused:
        played_order = {clean(t, 200).lower(): n for n, t in enumerate(request.get("played", []))}
        queued = {clean(t, 200).lower() for t in request.get("queued", [])}
        unused = sorted(
            (s for s in library.values() if label(s) not in queued),
            key=lambda s: played_order.get(label(s), -1),
        )[: max(count, len(library) // 2)]

    def closest(after, choices):
        """The song that follows `after` best: same genre, then nearest tempo, then nearest in the set order."""
        here = order.get(clean(after.get("id", ""), 20), 0)
        return min(choices, key=lambda s: (
            genre(s) != genre(after),
            tempo_gap(bpm(after), bpm(s)),
            abs(order[clean(s.get("id", ""), 20)] - here),
        ))

    def opener(choices):
        """The first song of a set and why. A vibe word matching a song's genre, artist or title wins;
        else a calm word opens with the slowest song and an energy word with the fastest; else the first
        song in the library. Tempo is the raw BPM: folding half and double time would make a 155 BPM trap
        (felt at about 78) count as slower than an 80 BPM ballad, the opposite of how they sound."""
        vibe = clean(request.get("vibe") or "", 200).lower()
        tokens = re.findall(r"[a-z0-9&]+", vibe)
        words = [GENRE_ALIASES.get(w, w) for w in tokens if len(w) >= 3]
        # Mood words only count as whole words here ("dance" matches "edm / dance", but "hard"
        # mustn't match "Richard" or "sad" match "Sade"); other words match any part of a name.
        mood = set(CALM_WORDS + ENERGY_WORDS)
        hits = lambda word, text: re.search(rf"\b{re.escape(word)}\b", text) if word in mood else word in text
        for song in choices:
            text = f"{genre(song)} {label(song)}"
            if any(hits(word, text) for word in words):
                return song, "matches your vibe"
        # The earliest calm or energy word sets the mood, so "chill into hype" opens calm.
        phrase = f" {' '.join(tokens)} "
        found = [(phrase.index(f" {w} "), w) for w in CALM_WORDS + ENERGY_WORDS if f" {w} " in phrase]
        rated = [s for s in choices if bpm(s)]
        if found and rated:
            if min(found)[1] in CALM_WORDS:
                return min(rated, key=bpm), "calm opener"
            return max(rated, key=bpm), "high-energy opener"
        return choices[0], "starts the set"

    picks = []
    while len(picks) < count:
        choices = [s for s in unused if all(p["id"] != s["id"] for p in picks)]
        if not choices:
            break
        before = library.get(picks[-1]["id"]) if picks else playing
        if before:
            song = closest(before, choices)
        else:
            song, opening = opener(choices)
        artist, title = clean(song.get("artist", ""), 80), clean(song.get("title", ""), 120)
        if not before:
            reason = opening
            intro = f"Let's get it started with {title} by {artist}."
        elif genre(song) == genre(before):
            reason = "same genre, close tempo" if tempo_gap(bpm(before), bpm(song)) <= 8 else "same genre"
            intro = f"Here's {title} by {artist}."
        else:
            reason = "a smooth step to a new genre"
            name = first_genre(song)
            intro = f"Switching it up, {name} time: {title} by {artist}!" if name else f"Next up: {title} by {artist}!"
        picks.append({"id": song["id"], "artist": artist, "title": title, "reason": reason, "intro": intro})
    if not picks:
        raise DjError("no songs to pick from")
    return picks


# ---- HTTP --------------------------------------------------------------------------

LOCAL_NAMES = {"localhost", "127.0.0.1"}


def is_this_server(url):
    """True when url (a Host header value or an Origin) is http://<this server>:<PORT>.
    Only localhost, 127.0.0.1 and AIRDECK_HOST count as this server's names."""
    try:
        parts = urlsplit(url)
        port = parts.port or 80
    except ValueError:
        return False
    return (
        parts.scheme == "http"
        and parts.hostname in LOCAL_NAMES | {HOST.lower()}
        and port == PORT
        and not parts.path
        and "@" not in parts.netloc
    )


class Handler(SimpleHTTPRequestHandler):
    # Keep connections open between requests. With Python's default (HTTP/1.0, close
    # after every response), Windows often cut off the last ~32 KB of a song file and
    # hung for ~19 s before resetting: about half of all song loads failed.
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def home_is_landing(self):
        # The landing page is the home page (index.html is the hand tracker, ai-dj.html the AI DJ).
        try:
            parts = urlparse(self.path)
        except ValueError:  # a malformed URL such as "//[": not the home page; send_head refuses it
            return
        if parts.path == "/":
            self.path = "/landing.html" + (f"?{parts.query}" if parts.query else "")

    def is_hidden(self, path):
        """True for dotfiles and dot folders. Checks the URL and the file it resolves to inside the
        site folder, so a symlink or a drive-style name (c:.env on Windows) can't reach one.
        Anything that resolves outside the site folder is hidden too."""
        if any(part.startswith(".") for part in path.split("/") if part):
            return True
        try:
            site = Path(self.directory).resolve()
            target = Path(self.translate_path(self.path)).resolve()
            parts = target.relative_to(site).parts
        except (ValueError, OSError, RuntimeError):
            return True
        return any(part.startswith(".") for part in parts)

    def send_head(self):
        # Local configuration and Git metadata are never browser assets. Decode
        # before checking so an encoded dot cannot bypass the restriction.
        try:
            path = unquote(urlparse(self.path).path)
            if "\x00" not in path and not self.is_hidden(path):
                return super().send_head()
        except ValueError:  # a malformed URL, a NUL byte, or a name the system can't open
            pass
        self.send_error(404, "File not found")
        return None

    def list_directory(self, path):
        self.send_error(404, "File not found")
        return None

    def end_headers(self):
        # Always revalidate files, so edits show up on a normal reload (no stale cached scripts)
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def api_allowed(self):
        """Only our own pages may call the API. Checks the Host header (a DNS-rebinding site can
        send its own name in Host) as well as the Origin, when the browser sends one."""
        host = self.headers.get("Host")
        origin = self.headers.get("Origin")
        return bool(host) and is_this_server(f"http://{host}") and (origin is None or is_this_server(origin))

    def do_HEAD(self):
        self.home_is_landing()
        super().do_HEAD()

    def do_GET(self):
        self.home_is_landing()
        if self.path.startswith("/api/progress"):
            if not self.api_allowed():
                return self.send_json(403, {"error": "forbidden origin"})
            job = parse_qs(urlparse(self.path).query).get("job", [""])[0]
            with progress_lock:
                state = progress.get(job)
            return self.send_json(200, state or {"stage": "unknown"})
        super().do_GET()

    def log_message(self, format, *args):
        # The page polls progress several times a second; keep that out of the log.
        # getattr: a request that failed early may have no path yet.
        if not getattr(self, "path", "").startswith("/api/progress"):
            super().log_message(format, *args)

    def do_POST(self):
        # Read the whole body first: on a kept-open connection, unread bytes would be
        # taken for the start of the next request.
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length < 0 or self.headers.get("Transfer-Encoding"):
                raise ValueError
            if length > 1024 * 1024:
                self.close_connection = True
                return self.send_json(413, {"error": "request body too large"})
            raw = self.rfile.read(length)
        except ValueError:
            self.close_connection = True
            return self.send_json(400, {"error": "invalid request body"})
        # Only our own pages may call the API (blocks other websites from using it through your browser).
        if not self.api_allowed():
            return self.send_json(403, {"error": "forbidden origin"})
        routes = {"/api/youtube": self.youtube, "/api/dj/pick": self.pick}
        route = routes.get(self.path)
        if not route:
            return self.send_json(404, {"error": "not found"})
        try:
            body = json.loads(raw or b"{}")
            if not isinstance(body, dict):
                raise ValueError
        except (ValueError, RecursionError):  # RecursionError: JSON nested too deeply
            return self.send_json(400, {"error": "invalid request body"})
        route(body)

    def youtube(self, body):
        url = body.get("url")
        target = to_target(url) if isinstance(url, str) else None
        if not target:
            return self.send_json(400, {"error": "paste a single YouTube video link, or type a song name"})
        job = re.sub(r"[^\w-]", "", str(body.get("job", "")))[:40]
        set_progress(job, stage="searching", percent=None)
        try:
            self.download_song(target, job)
        finally:
            with progress_lock:
                progress.pop(job, None)

    def download_song(self, target, job):
        entry, error = get_song(target, job)
        if entry:
            return self.send_json(200, entry)
        return self.send_json(503 if error == YTDLP_MISSING else 502, {"error": error})

    def pick(self, body):
        # JSON syntax alone does not validate the list/numeric fields the picker uses.
        try:
            count = body.get("count")
            if count is not None:
                body["count"] = int(count)
            for field in ("queued", "played"):
                if field in body and (not isinstance(body[field], list) or
                                      any(not isinstance(value, str) for value in body[field])):
                    raise ValueError
            if "library" in body and not isinstance(body["library"], list):
                raise ValueError
        except (ValueError, TypeError, OverflowError):
            return self.send_json(400, {"error": "invalid DJ request fields"})
        try:
            picks = dj_pick(body)
        except DjError as error:
            print(f"[dj] pick failed: {error}", flush=True)
            return self.send_json(400, {"error": str(error)})
        print(f"[dj] picked: {'; '.join(p['artist'] + ' - ' + p['title'] for p in picks)}", flush=True)
        self.send_json(200, {"picks": picks})

    def send_json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Server(ThreadingHTTPServer):
    # On Windows, SO_REUSEADDR lets a second server silently share a port that's
    # already taken, so requests go to whichever copy started first (wrong files, 404s).
    # Refuse the port instead, so the clash is obvious.
    allow_reuse_address = sys.platform != "win32"


def port_from_args(args):
    """The port from `python server.py [port]`: 8000 by default, or None if the argument isn't a port."""
    if len(args) < 2:
        return 8000
    try:
        port = int(args[1])
    except ValueError:
        return None
    return port if 1 <= port <= 65535 else None


if __name__ == "__main__":
    port = port_from_args(sys.argv)
    if port is None:
        print("Usage: python server.py [port]   (the port is a number from 1 to 65535)", file=sys.stderr)
        sys.exit(2)
    PORT = port
    if HOST != "127.0.0.1":
        print(f"Warning: AIRDECK_HOST is {HOST}, so other computers that can reach it can use the server "
              "and the API. Unset AIRDECK_HOST to keep it on this computer.", flush=True)
    try:
        server = Server((HOST, PORT), Handler)
    except OSError as error:
        if error.errno in (errno.EADDRINUSE, getattr(errno, "WSAEADDRINUSE", None)):
            sys.exit(f"Port {PORT} is already in use (another server.py still running?)\n"
                     f"Stop it, or pick another port:  python server.py {PORT + 1}")
        sys.exit(f"Couldn't start the server on {HOST}:{PORT}: {error}")
    print(f"AirDeck running at http://localhost:{PORT} (yt-dlp: {' '.join(YTDLP + JS_RUNTIME)})")
    server.serve_forever()
