"""AirDeck dev server: serves the static site, downloads YouTube audio, and runs the AI DJ.

Run:  python3 server.py   (then open http://localhost:8000)
POST /api/youtube  {"url": "https://www.youtube.com/watch?v=..."}
  -> {"file": "downloads/<id>.m4a", "title": "..."}
"url" can also be plain words ("clarity zedd") or a YouTube search link: both
download the top search result.
POST /api/dj/pick  {"vibe": "...", "nowPlaying": "...", "queued": [...], "played": [...], "count": 3}
  -> {"picks": [{"artist", "title", "reason", "intro"}]}   (Gemini; needs GEMINI_API_KEY)
POST /api/dj/voice {"text": "..."}
  -> {"file": "downloads/voice/<hash>.mp3"}   (ElevenLabs; needs ELEVENLABS_API_KEY)
Requires yt-dlp (pip install -U "yt-dlp[default]" or brew install yt-dlp).
API keys are read from environment variables and never sent to the browser.
"""

import contextlib
import errno
import hashlib
import http.client
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request
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
VOICES = DOWNLOADS / "voice"
# Searches and links already downloaded, so asking again (e.g. in a rehearsed demo) skips yt-dlp.
DOWNLOAD_INDEX = DOWNLOADS / "index.json"
index_lock = threading.Lock()
ALLOWED_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
PORT = 8000  # python server.py 8001 for another port; set from the command line in __main__
# Only this computer can reach the server (and spend the API keys' credits) unless you
# opt in with this machine's LAN IP, e.g. AIRDECK_HOST=192.168.1.20. The API only accepts
# that name in the Host header, so with 0.0.0.0 other computers get pages but API calls 403.
HOST = os.environ.get("AIRDECK_HOST", "").strip() or "127.0.0.1"
AI_TIMEOUT = 15  # seconds before a Gemini or ElevenLabs request gives up (songs are short)
# The yt-dlp command, or Python's module when pip's per-user install folder isn't on PATH.
YTDLP = ["yt-dlp"] if shutil.which("yt-dlp") else [sys.executable, "-m", "yt_dlp"]
# One video only: watch, shorts and live links, or youtu.be short links.
SINGLE_VIDEO = re.compile(
    r"^https?://((www\.|m\.|music\.)?youtube\.com/(watch\?(\S*&)?v=|shorts/|live/)|youtu\.be/)[\w-]{11}\S*$"
)

# AI DJ settings (environment variables override the defaults).
# Flash-Lite: the free tier allows 500 requests a day (3.8 Flash only 20), plenty for picking songs.
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
ELEVENLABS_VOICE = os.environ.get("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb")
ELEVENLABS_MODEL = "eleven_flash_v2_5"  # ElevenLabs' low-latency voice model


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

class DjError(Exception):
    """A DJ request failed in a way worth showing to the user."""


class DjNotConfigured(DjError):
    """A DJ service's API key isn't set on the server (a 503, not a bad answer)."""


DJ_INSTRUCTIONS = """You are the AI DJ in AirDeck, a hand-gesture DJ app, picking the next songs for a live set.
Pick real, well-known songs that are easy to find on YouTube, matching the requested vibe and flowing
naturally from what's playing now (similar energy, tempo and genre, or a smooth step toward the vibe).
Never pick a song that's already queued or played. Vary the artists.
For each pick give:
- reason: why it fits, under 12 words.
- intro: what you'd say on the mic as it comes in, like a radio DJ. You only get on the mic when the
  set switches genre (and at the very start), so make it about the switch: one or two short, upbeat
  sentences that name the song and artist. No emojis, hashtags or stage directions."""

PICK_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "picks": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "artist": {"type": "STRING"},
                    "title": {"type": "STRING"},
                    "reason": {"type": "STRING"},
                    "intro": {"type": "STRING"},
                },
                "required": ["artist", "title", "reason", "intro"],
            },
        }
    },
    "required": ["picks"],
}


def post_json(url, body, headers, timeout=60):
    """POST JSON and return the raw response bytes. Raises DjError with the API's own message."""
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        try:
            detail = error.read().decode(errors="replace")
        except (OSError, ValueError, http.client.HTTPException):
            detail = ""
        try:
            parsed = json.loads(detail)
            detail = parsed.get("error", {}).get("message") or parsed.get("detail", {}).get("message") or detail
        except (ValueError, AttributeError):
            pass
        raise DjError(f"{error.code}: {str(detail)[:200]}") from None
    except (OSError, ValueError, http.client.HTTPException) as error:
        # OSError covers URLError, timeouts and RemoteDisconnected; HTTPException covers IncompleteRead.
        raise DjError(f"couldn't reach the service ({error})") from None


def clean(text, limit):
    # Lone surrogates (possible in JSON input) can't be printed or encoded: replace them.
    text = str(text).encode("utf-8", "replace").decode("utf-8")
    return " ".join(text.split())[:limit]


LIBRARY_PICK_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "picks": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "id": {"type": "STRING"},
                    "reason": {"type": "STRING"},
                    "intro": {"type": "STRING"},
                },
                "required": ["id", "reason", "intro"],
            },
        }
    },
    "required": ["picks"],
}


def ask_gemini_for_picks(prompt, schema):
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise DjNotConfigured("set GEMINI_API_KEY before starting server.py to use the AI DJ")
    body = {
        "systemInstruction": {"parts": [{"text": DJ_INSTRUCTIONS}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": schema},
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    unexpected = DjError("Gemini returned an unexpected answer")
    try:
        data = json.loads(post_json(url, body, {"x-goog-api-key": key}, timeout=AI_TIMEOUT))
    except ValueError:
        raise unexpected from None
    try:
        parts = data["candidates"][0]["content"]["parts"]
        picks = json.loads("".join(part.get("text", "") for part in parts))["picks"]
    except (KeyError, IndexError, ValueError, TypeError, AttributeError):
        raise unexpected from None
    if not isinstance(picks, list) or not all(isinstance(pick, dict) for pick in picks):
        raise unexpected
    return picks


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


def crowd_line(level):
    """How the player is doing (0-1, from the game on the AI DJ page), as a hint for the DJ."""
    try:
        level = float(level)
    except (TypeError, ValueError):
        return ""
    if level >= 0.7:
        return "The crowd is hyped (the player is nailing the moves): you can push the energy up.\n"
    if level <= 0.35:
        return "The crowd is cooling off (the player is missing moves): pick something familiar and easy to groove to.\n"
    return "The crowd is steady.\n"


def dj_pick(request):
    """Ask Gemini for the next songs. Returns (picks, offline): picks is a list of
    {artist, title, reason, intro}; offline is why Gemini couldn't be used, or None.

    With a "library" ([{id, artist, title, bpm, genre}]) in the request, Gemini may only pick
    from it and each pick also has its "id". If Gemini fails (no key, no internet, rate
    limit, overload), the closest library songs are picked instead, so the music keeps
    going. Without a library Gemini can pick any song (beta), and has to work.
    """
    offline = None
    count = max(1, min(int(request.get("count") or 3), 5))
    listing = lambda name: "\n".join(f"- {clean(t, 120)}" for t in request.get(name, [])[-25:]) or "(none)"
    situation = (
        f"Vibe: {clean(request.get('vibe') or 'keep the current energy going', 200)}\n"
        f"Now playing: {clean(request.get('nowPlaying') or 'nothing yet', 120)}\n"
        f"Already queued:\n{listing('queued')}\n"
        f"Already played:\n{listing('played')}\n"
        f"{crowd_line(request.get('crowd'))}"
    )

    library = {
        clean(song.get("id", ""), 20): song
        for song in request.get("library") or []
        if isinstance(song, dict) and song.get("id")
    }
    if library:
        def facts(s):
            known = [f"~{bpm(s)} BPM" if bpm(s) else "", clean(s.get("genre", ""), 40)]
            return f" ({', '.join(k for k in known if k)})" if any(known) else ""

        menu = "\n".join(
            f"- {song_id}: {clean(s.get('artist', ''), 80)} - {clean(s.get('title', ''), 120)}{facts(s)}"
            for song_id, s in library.items()
        )
        prompt = (
            f"{situation}"
            f"You may only pick from this library (id: artist - title (tempo, genre)), listed in a set "
            f"order where neighbors flow into each other:\n{menu}\n"
            "Answer with library ids, in the order they should play. Prefer songs that haven't been played "
            "or queued; only repeat a song once every song has played, starting with the one played longest ago.\n"
            "Make it flow like a real DJ set: each song in the same or a neighboring genre as the one before "
            "(e.g. hip-hop to R&B, house to disco), never a drastic jump like trap straight into disco or "
            "EDM. Change genre one small step at a time, keep tempos close (or half/double time), and build "
            "energy gradually. Only make a big jump when the vibe asks for one.\n"
            f"Pick {count} songs."
        )
        # Songs already queued or played, by the "artist - title" label the page uses.
        label = lambda s: f"{clean(s.get('artist', ''), 80)} - {clean(s.get('title', ''), 120)}".lower()
        used = {clean(t, 200).lower() for t in [*request.get("queued", []), *request.get("played", [])]}
        unused = [s for s in library.values() if label(s) not in used]
        playing = next((s for s in library.values() if label(s) == clean(request.get("nowPlaying") or "", 200).lower()), None)
        order = {song_id: number for number, song_id in enumerate(library)}
        genre = lambda s: clean(s.get("genre", ""), 40).lower()

        def closest(after, choices):
            """The song that follows `after` best: same genre, then nearest tempo, then nearest in the set order."""
            if not after:
                return choices[0]
            here = order.get(clean(after.get("id", ""), 20), 0)
            return min(choices, key=lambda s: (
                genre(s) != genre(after),
                tempo_gap(bpm(after), bpm(s)),
                abs(order[clean(s.get("id", ""), 20)] - here),
            ))

        def entry(song, reason, intro):
            return {
                "id": song["id"],
                "artist": clean(song.get("artist", ""), 80),
                "title": clean(song.get("title", ""), 120),
                "reason": clean(reason, 160),
                "intro": clean(intro, 300),
            }

        try:
            gemini_picks = ask_gemini_for_picks(prompt, LIBRARY_PICK_SCHEMA)
        except DjError as error:
            print(f"[dj] Gemini unavailable ({error}): picking from the library", flush=True)
            gemini_picks, offline = [], str(error)
        # Every song played already: repeats are fine, the ones played longest ago first.
        fresh_left = bool(unused)
        if not fresh_left:
            played_order = {clean(t, 200).lower(): n for n, t in enumerate(request.get("played", []))}
            queued = {clean(t, 200).lower() for t in request.get("queued", [])}
            unused = sorted(
                (s for s in library.values() if label(s) not in queued),
                key=lambda s: played_order.get(label(s), -1),
            )[: max(count, len(library) // 2)]

        cleaned = []
        for pick in gemini_picks:
            song = library.get(clean(pick.get("id", ""), 20))
            if not song or any(p["id"] == song["id"] for p in cleaned):
                continue  # made-up or repeated id
            if label(song) in used and fresh_left:
                continue  # Gemini picked a repeat while fresh songs remain
            cleaned.append(entry(song, pick.get("reason", ""), pick.get("intro", "")))
            if len(cleaned) == count:
                break
        # Gemini came up short (repeats, bad ids): fill in with unused songs, each one
        # the closest match to the song before it.
        while len(cleaned) < count:
            choices = [s for s in unused if all(p["id"] != s["id"] for p in cleaned)]
            if not choices:
                break
            song = closest(library.get(cleaned[-1]["id"]) if cleaned else playing, choices)
            reason = "closest match (AI offline)" if offline else "keeps the set going"
            cleaned.append(entry(song, reason, f"Here's {song.get('title', '')} by {song.get('artist', '')}."))
    else:
        cleaned = []
        for pick in ask_gemini_for_picks(f"{situation}Pick {count} songs.", PICK_SCHEMA)[:count]:
            artist, title = clean(pick.get("artist", ""), 80), clean(pick.get("title", ""), 120)
            if artist and title:
                cleaned.append({
                    "artist": artist,
                    "title": title,
                    "reason": clean(pick.get("reason", ""), 160),
                    "intro": clean(pick.get("intro", ""), 300),
                })
    if not cleaned:
        raise DjError(offline or "Gemini didn't pick any songs")
    return cleaned, offline


def dj_voice(text):
    """Speak a DJ line with ElevenLabs. Returns the MP3's path, cached by voice and text."""
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        raise DjNotConfigured("set ELEVENLABS_API_KEY to use the ElevenLabs voice")
    text = clean(text, 300)
    if not text:
        raise DjError("nothing to say")
    path = VOICES / f"{hashlib.sha1(f'{ELEVENLABS_VOICE}|{text}'.encode()).hexdigest()[:16]}.mp3"
    # A cached file counts only if it really is audio (an older run may have cached an error page).
    if path.exists():
        with path.open("rb") as cached:
            if looks_like_mp3(cached.read(4)):
                return path
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE}?output_format=mp3_44100_128"
    audio = post_json(url, {"text": text, "model_id": ELEVENLABS_MODEL}, {"xi-api-key": key}, timeout=AI_TIMEOUT)
    if not looks_like_mp3(audio):
        raise DjError("ElevenLabs didn't return audio")
    write_atomic(path, audio)
    return path


def looks_like_mp3(data):
    """True when the bytes start like an MP3: an ID3 tag or an MPEG frame sync."""
    return data[:3] == b"ID3" or (len(data) >= 2 and data[0] == 0xFF and data[1] & 0xE0 == 0xE0)


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
        # Only our own pages may call the API (blocks other websites from using it, and
        # the keys, through your browser).
        if not self.api_allowed():
            return self.send_json(403, {"error": "forbidden origin"})
        routes = {"/api/youtube": self.youtube, "/api/dj/pick": self.pick, "/api/dj/voice": self.voice}
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
            picks, offline = dj_pick(body)
        except DjError as error:
            print(f"[dj] pick failed: {error}", flush=True)
            return self.send_json(503 if isinstance(error, DjNotConfigured) else 502, {"error": str(error)})
        print(f"[dj] picked: {'; '.join(p['artist'] + ' - ' + p['title'] for p in picks)}", flush=True)
        self.send_json(200, {"picks": picks, "offline": offline})

    def voice(self, body):
        text = body.get("text")
        if not isinstance(text, str) or not clean(text, 300):
            return self.send_json(400, {"error": "nothing to say"})
        try:
            path = dj_voice(text)
        except DjError as error:
            print(f"[dj] voice failed: {error}", flush=True)
            return self.send_json(503 if isinstance(error, DjNotConfigured) else 502, {"error": str(error)})
        self.send_json(200, {"file": path.relative_to(ROOT).as_posix()})

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
              "and the API keys' credits. Unset AIRDECK_HOST to keep it on this computer.", flush=True)
    try:
        server = Server((HOST, PORT), Handler)
    except OSError as error:
        if error.errno in (errno.EADDRINUSE, getattr(errno, "WSAEADDRINUSE", None)):
            sys.exit(f"Port {PORT} is already in use (another server.py still running?)\n"
                     f"Stop it, or pick another port:  python server.py {PORT + 1}")
        sys.exit(f"Couldn't start the server on {HOST}:{PORT}: {error}")
    print(f"AirDeck running at http://localhost:{PORT} (yt-dlp: {' '.join(YTDLP + JS_RUNTIME)})")
    gemini = f"on ({GEMINI_MODEL})" if os.environ.get("GEMINI_API_KEY") else "library picks only (set GEMINI_API_KEY for Gemini)"
    voice = "ElevenLabs" if os.environ.get("ELEVENLABS_API_KEY") else "browser voice (set ELEVENLABS_API_KEY for ElevenLabs)"
    print(f"AI DJ: {gemini}, voice: {voice}")
    server.serve_forever()
