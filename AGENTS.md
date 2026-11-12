# AirDeck agent guide

## Workflow

- Inspect Git status/diffs before editing this shared checkout; preserve unrelated work.
- Use the user's current instructions to determine scope. Prefer focused changes and verify the result.
- `main` is the published branch. Work on a feature branch and only push to `main` when the user explicitly asks.
- Commit/push or create a PR when the user asks. Exclude the personal untracked `HANDOFF.md` from every commit.
- Give short, plain progress updates and describe actual verification limits.

## Current application

- `index.html` is DJ Deck; `mix.html` redirects there. `/` serves `landing.html`.
- Arcade is now integrated at `arcade-versus.html` (two-player games); `ai-dj.html` is AirMix, its single-player rhythm game. Preserve both routes and the homepage links.
- DJ Deck Song, Queue, Library and Up next belong in the sidebar, outside camera pixels, including fullscreen. Mobile may stack them below the camera.
- Other controls/help are hidden behind a toggle. Preserve the site's Aero styling.
- Manual hand blends accept all tempos without beat alignment, speed matching or automatic bass cuts. Keep automatic AI DJ behavior distinct.
- Comfortable hand ranges: blend palm Y .90→.55, effect palm Y .85→.40, volume distance .04→.42 of canvas width. Keep controls clear of the top lock zone (.32).
- Finger picks (`fingerCount`) use the four fingers for 1-4; the thumb only turns four fingers into 5. Keep it that way: a resting thumb reads as extended too often to count on its own.
- Bubble Aero includes particles escaping the polygon. Clear them when switching visual; keep emission bounded.
- Do not restore the colorful startup test pattern. Synthetic preview is explicit (L or fake hands).
- Text on the cream/glass panels needs at least 4.5:1 contrast. `--between` (#f5861f) is for bars and borders; orange text uses #8a4510.

## Files and verification

- `index.html`: camera, gesture logic, canvas HUD, fullscreen/sidebar integration.
- `audio.js`: DJ Deck audio engine; `aiDeck.js`: AirMix's engine copy.
- `queue.js`: shared queue, playback requests, embedded/floating panels, announcements.
- `transitions.js`: manual level blends and automatic tempo/echo transitions.
- `mix-audio.js`: `analyzeTempo` (tempo and downbeat detection used by `transitions.js`); otherwise the archived two-deck engine.
- `frame.js`: polygon WebGL visuals; `bubble-particles.js`: screen-space particles.
- `djGame.js` / `djStart.js`: AirMix gameplay, set selection, onboarding and results.
- `arcade-versus.html`: two-player Arcade games.
- `landing.html` / `landing.js`: the homepage; `club.html` / `club.js`: the preserved 3D Club demo; `aero.css`: shared Aero styling.
- `server.py`: local serving/downloads and the offline AI DJ song picker (`/api/dj/pick`); Gemini and ElevenLabs were removed (restore from git history); loads a gitignored `.env` at startup.
- `FEATURES_PLAN.md` is historical, not the current product specification.
- The server only serves site assets: `.md`, `.py`, `.cjs`, `.example`, anything under `tests/` and `downloads/index.json` return 404, as do dotfiles and directory listings. CI runs `bash tests/run.sh` (`.github/workflows/tests.yml`).

Run the regression suites (all are fast): `bash tests/run.sh` (every `tests/*.cjs` with node, then every `tests/server-*.py` with python3), or by hand: `for t in tests/*.cjs; do node "$t" || echo "FAIL $t"; done`, then `python3 tests/server-static.py` and `python3 tests/server-requests.py`; run `git diff --check`. Changes to `analyzeTempo` must keep `tests/tempo-accuracy.cjs` (35 synthetic tempos, ±1 BPM) and `tests/tempo-silence.cjs` passing. Browser checks matter for rendering and fullscreen. Stub tests do not replace real webcam/listening validation.

AirMix may select uncached library songs; they download on Play. Loading failures must show retry/new-set controls. The server must never serve dotfiles (including `.env` and `.git`) or directory listings.

Run `python3 server.py 8001` after checking for an existing listener. No external AI service or API key is used; never add one without the owner asking, and never commit secrets. The API only answers requests whose `Host` is localhost, 127.0.0.1 or `AIRDECK_HOST`; to use it from another computer, set `AIRDECK_HOST` to this machine's LAN IP (with 0.0.0.0 other computers get 403).
