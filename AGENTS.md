# AirDeck agent guide

## Workflow

- Inspect Git status/diffs before editing this shared checkout; preserve unrelated work.
- Use the user's current instructions to determine scope. Prefer focused changes and verify the result.
- The remote currently has only `main` (older notes about `merge-main` and `virtual-effects` are out of date). Work on the branch the session gives you; only publish to `main` (or open/merge a PR) when the user explicitly asks.
- Commit/push or create a PR when the user asks. Exclude the personal untracked `HANDOFF.md` from every commit.
- Give short, plain progress updates and describe actual verification limits.

## Current application

- `index.html` is DJ Deck; `mix.html` redirects there. `/` serves `landing.html`.
- Arcade is now integrated at `arcade-versus.html` (two-player games); `ai-dj.html` is AirMix, its single-player rhythm game. Preserve both routes and the homepage links.
- DJ Deck Song, Queue, Library and Up next belong in the sidebar, outside camera pixels, including fullscreen. Mobile may stack them below the camera.
- Other controls/help are hidden behind a toggle. Preserve the site's Aero styling.
- Manual hand blends accept all tempos without beat alignment, speed matching or automatic bass cuts. Keep automatic AI DJ behavior distinct.
- Comfortable hand ranges: blend palm Y .90→.55, effect palm Y .85→.40, volume distance .04→.42 of canvas width. Keep controls clear of the top lock zone (.32).
- Bubble Aero includes particles escaping the polygon. Clear them when switching visual; keep emission bounded.
- Do not restore the colorful startup test pattern. Synthetic preview is explicit (L or fake hands).

## Files and verification

- `index.html`: camera, gesture logic, canvas HUD, fullscreen/sidebar integration.
- `audio.js`: DJ Deck audio engine; `aiDeck.js`: AirMix's engine copy.
- `queue.js`: shared queue, playback requests, embedded/floating panels, announcements.
- `transitions.js`: manual level blends and automatic tempo/echo transitions.
- `frame.js`: polygon WebGL visuals; `bubble-particles.js`: screen-space particles.
- `djGame.js` / `djStart.js`: AirMix gameplay, set selection, onboarding and results.
- `arcade-versus.html`: two-player Arcade games.
- `server.py`: local serving/downloads, Gemini picks, ElevenLabs speech; loads a gitignored `.env` at startup.
- `FEATURES_PLAN.md` is historical, not the current product specification.

Run every suite before publishing: `for t in tests/*.cjs; do node $t; done` and `python3 -B tests/server-static.py`, `python3 -B tests/server-requests.py` (all pass on `main`); run `git diff --check`. Add a regression test with each fix. Several tests cut code out of the HTML pages by searching for marker strings (for example `tests/tracking.cjs` splits on `<script type="module">`), so renaming those markers silently changes what they exercise. Browser checks matter for rendering and fullscreen. Stub tests do not replace real webcam/listening validation.

AirMix may select uncached library songs; they download on Play. Loading failures must show retry/new-set controls. The server must never serve dotfiles (including `.env` and `.git`) or directory listings.

Run `python3 server.py 8001` after checking for an existing listener. Keys are server environment variables (`GEMINI_API_KEY`, `ELEVENLABS_API_KEY`); never reveal or commit secrets. Do not claim APIs are active just because integration exists. Check runtime configuration/logs.

## Behavior to keep (from the QA fixes)

- MediaPipe (and Club's three.js) load on demand inside `loadModel()` / a dynamic `import()`. Never add a static CDN import: the queue, library, keyboard play, fullscreen and the AirMix picker must still work when `cdn.jsdelivr.net` is unreachable, with a clear "failed to load" message and retry.
- DJ Deck fullscreen: `#songQueue` and the other sidebar cards keep `flex-shrink: 0`, and the sidebar scrolls; check with Show controls & help open at 1440x900, 1024x768 and 390x844.
- `analyzeTempo` returns the default `{ bpm: 120, first: 0 }` when it finds no beat (silence, a single hit); `fold()` and `trusted()` reject non-finite or non-positive tempos. Never reintroduce an unbounded loop there.
- Pinch calibration applies its margins first, then requires `open - closed >= 0.03`; never save a range that fails.
- Queue stepping uses the last requested song (`requestedId`), so a song that failed to load does not block next/previous.
- Server: API requests need a local `Host` (localhost, 127.0.0.1 or `AIRDECK_HOST`) on the server's port and a same-origin `http` `Origin`; malformed input returns 400/404, never an uncaught exception; the dotfile check also covers the resolved path (symlinks outside the site folder return 404); video ids and URLs stay case-sensitive in the download cache. Running with `AIRDECK_HOST=0.0.0.0` means other computers get 403 unless `AIRDECK_HOST` is that exact IP.
- Arcade keyboard input only counts while held; music respects pause; a hidden tab pauses the game.

## Known gaps

- `analyzeTempo` is several BPM off on some beats (for example 120 reads 118.7, 150 reads 157); fixing it changes automatic transition timing.
- Some sidebar labels ("Now playing", the DJ label, Up next) are still below WCAG AA contrast.
- Not yet tested on a real webcam or by listening: hand-tracking feel, mixes, the DJ voice, live Gemini/ElevenLabs and YouTube downloads. The container blocks `cdn.jsdelivr.net`, so browser checks there stub MediaPipe.
- The repo has no CI.
