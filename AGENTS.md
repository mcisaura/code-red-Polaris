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
- `ytEmbed.js`: the hosted site's YouTube embed (`parseYouTubeId`, `createYtEmbed`: load/play/pause/seekTo/setVolume/setRate/getTime/getDuration/onEnded/onError/stop/destroy around YouTube's IFrame Player API, loaded on demand). `queue.js` takes it as `createQueue(deck, { embed })` and handles `{ embed: true, videoId, title }` items with thin hooks; `tests/yt-embed-queue.cjs` uses a stub player. Rule: the hosted site never downloads or proxies YouTube audio; it only embeds YouTube's own player, with no API key (titles come from the public oEmbed endpoint via `/api/youtube/info`). On the hosted site every `library.json` song is an embed item (`videoId` = song id). There are two players (`yt.second`, `yt.swap()`), so hand blends and AI DJ mixes between embed items are volume crossfades; effects, beat detection and energy are not available, and moves between embed items and file items are plain cuts. `ytDeck.js` is the YouTube-backed engine AirMix uses on the hosted site (beat grid from the song's `beat` data, falling back to the listed bpm; mixes are short crossfades on the second player; no filter shapes). `library.json` songs carry an optional `beat: {bpm, first, duration}` measured from the local audio by `node scripts/analyze-library.mjs` (run `python3 prefetch.py` first; rerun after changing a song id). On the hosted site effects UI is hidden, unavailable videos are greyed out via `/api/youtube/info`, and the landing page streams its playlist through a visible embedded player. YouTube's player must stay visible while it plays: never hide it. Optional modules are guarded in `index.html` (`typeof createYtEmbed === "function"`) because tests strip its imports.
- `deckTour.js`: DJ Deck first-visit tutorial (`createDeckTour` step logic plus a small card renderer); `tests/deck-tour.cjs`.
- `frame.js`: polygon WebGL visuals; `bubble-particles.js`: screen-space particles.
- `djGame.js` / `djStart.js`: AirMix gameplay, set selection, onboarding and results.
- `arcade-versus.html`: two-player Arcade games.
- `landing.html` / `landing.js`: the homepage; `club.html` / `club.js`: the preserved 3D Club demo; `aero.css`: shared Aero styling.
- `server.py`: local serving/downloads and the offline AI DJ song picker (`/api/dj/pick`); Gemini and ElevenLabs were removed (restore from git history); loads a gitignored `.env` at startup.
- Cloudflare hosting: `wrangler.jsonc` (no R2 binding by default; the `MUSIC` R2 binding is commented out as an option), `worker/worker.js` (routes: `/`, `/api/config`, `/api/youtube/info`, `/api/dj/pick`, 501 for `/api/youtube` and `/api/progress`, and `GET|HEAD /music/<id>.m4a` from the `MUSIC` R2 binding when bound, otherwise the static assets: `audio/mp4`, `Accept-Ranges`, single-range 206/416, ETag, long Cache-Control, id `[a-z0-9-]{1,20}`, 404 if missing), `worker/picker.js` (JavaScript port of `dj_pick` in `server.py`: change one, change both; `tests/worker-picker.cjs` cross-checks them), `scripts/build-site.mjs` (builds `dist/` from an allowlist; copies only the audio of the `library.public.json` tracks, `public-music/<id>.m4a` to `dist/music/<id>.m4a`, warning about missing files; never server code, tests, docs, `.env*`, `music/`), `scripts/upload-music.mjs` (optional R2 route: `npm run upload-music`, `--dry-run`, `--local`), `package.json`. Two libraries hosted: `library.json` (YouTube ids, embed only, no effects) and `library.public.json` (15 CC BY 4.0 Kevin MacLeod tracks, slug ids, real audio in `public-music/`). Contract: `dist/library.json` = `library.json` songs unchanged, then `library.public.json` songs with `"hosted": true`; a song with `hosted: true` has audio at `/music/<id>.m4a`, others are YouTube ids. CC BY credits are required: the landing footer's "Music credits" lists every `attribution`. Rule: only audio the owner has the right to publish (CC BY, CC0, own, permission) goes in `library.public.json` (and `public-music/`), never downloads of the YouTube library. Local audio: gitignored `public-music/<id>.m4a`; beats via `node scripts/analyze-library.mjs --public`. Deploy (free plan, no R2 or payment card): `npm install`, `npx wrangler login`, `npm run deploy`. Live site: https://airdeck.sankarpete.workers.dev. Fresh clones must re-download `public-music/` before building (missing files warn and 404 on the site; CI builds without them). Hosted and local share one branch: any difference goes through `GET /api/config` (`loadConfig()` in `queue.js`; `server.py` answers `youtube: true, youtubeEmbed: false`) or the build script, never a separate branch. A new public file type must be added to the allowlist in `scripts/build-site.mjs`.
- `FEATURES_PLAN.md` is historical, not the current product specification.
- The server only serves site assets: `.md`, `.py`, `.cjs`, `.example`, anything under `tests/` and `downloads/index.json` return 404, as do dotfiles and directory listings. CI runs `bash tests/run.sh` (`.github/workflows/tests.yml`).

Run the regression suites (all are fast): `bash tests/run.sh` (every `tests/*.cjs` with node, then every `tests/server-*.py` with python3), or by hand: `for t in tests/*.cjs; do node "$t" || echo "FAIL $t"; done`, then `python3 tests/server-static.py` and `python3 tests/server-requests.py`; run `git diff --check`. Changes to `analyzeTempo` must keep `tests/tempo-accuracy.cjs` (35 synthetic tempos, ±1 BPM) and `tests/tempo-silence.cjs` passing. Browser checks matter for rendering and fullscreen. Stub tests do not replace real webcam/listening validation.

AirMix may select uncached library songs; they download on Play. Loading failures must show retry/new-set controls. The server must never serve dotfiles (including `.env` and `.git`) or directory listings.

Run `python3 server.py 8001` after checking for an existing listener. No external AI service or API key is used; never add one without the owner asking, and never commit secrets. The API only answers requests whose `Host` is localhost, 127.0.0.1 or `AIRDECK_HOST`; to use it from another computer, set `AIRDECK_HOST` to this machine's LAN IP (with 0.0.0.0 other computers get 403).
