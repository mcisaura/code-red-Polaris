// Song queue for the Deck in audio.js. The main source is the song library
// (library.json, played from music/<id>.m4a, instant); YouTube links or song
// names (downloaded by server.py, slow) and files are a beta alternative.
// Reorder, remove, play, seek, and skip back and forth. An AI DJ can fill it for
// you: the server picks library songs that fit a vibe and what's playing (same
// genre, close tempo, no repeats until every song has played), and the browser's
// voice introduces them. Plus a floating panel and a player bar for all of that.
//
//   const queue = createQueue(deck);
//   const panel = createQueuePanel(queue, deck);
//   someElement.append(createTransport(queue, deck)); // progress bar + ⏮ ⏯ ⏭
//   queueButton.onclick = () => { deck.ensureContext(); panel.toggle(); };
//   const upNext = createUpNext(queue); stage.append(upNext.element); // what the DJ does next
//
// Call deck.ensureContext() inside clicks before queue actions: browsers only
// allow sound after one. The panel and player bar already do this for their buttons.

import { createTransitions } from "./transitions.js";
import { parseYouTubeId, BAD_LINK_MESSAGE, nearestRate } from "./ytEmbed.js";

const djSongsAhead = 3; // the DJ keeps this many songs queued after the current one (the choices)
const choiceCount = 3; // songs offered to choose from for the next mix
const blendTolerance = 0.08; // library tempos this close (or half/double) can be blended by hand
const djPicksPerRequest = 3;
const duckedVolume = 0.5; // the music's level while the DJ talks over a transition
const duckFadeMs = 600;
const voiceTimeoutMs = 15000; // never let a stuck voice line stall the set
const restartThreshold = 3; // ⏮ restarts the song if it's past this many seconds, else goes back one
const progressPollMs = 400;
const hoverDecodeMs = 250; // hovering a song this long starts decoding it
const embedLeadSeconds = 1; // the AI DJ starts a YouTube crossfade this long before the fade has to end with the video
const blendSeconds = 8; // a timed YouTube crossfade (as transitions.js's blends) lasts this long...
const shortBlendSeconds = 4; // ...and this long with short mixes
const maxNudge = 0.08; // the incoming song's speed is only matched to the outgoing one's within 8% (as transitions.js)
const seekStepSeconds = 5; // the arrow keys move the seek bar this far

// Python's dev server sometimes resets the first request on a connection that sat
// idle ("Failed to fetch"). A network error (not an HTTP error) gets one retry.
async function retryOnNetworkError(request) {
  try {
    return await request();
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 300));
    return request();
  }
}

// What the server behind this page can do: GET /api/config -> { youtube, youtubeEmbed, hosted }. Asked
// once and shared. The hosted Cloudflare site answers youtube: false (no downloads) and youtubeEmbed:
// true (YouTube links play in YouTube's own embedded player); the local Python server answers
// youtube: true, youtubeEmbed: false. Anything else (an old server, a failed request) counts as the local behaviour.
let configPromise = null;
export function loadConfig(apiBase = "/api") {
  configPromise ??= (async () => {
    try {
      const response = await fetch(`${apiBase}/config`);
      const config = response.ok ? await response.json() : null;
      return { youtube: config?.youtube !== false, youtubeEmbed: config?.youtubeEmbed === true, hosted: config?.hosted === true };
    } catch {
      return { youtube: true, youtubeEmbed: false, hosted: false };
    }
  })();
  return configPromise;
}

// Hosted site: which library videos YouTube still plays in an embed, checked once per page through the Worker's
// oEmbed proxy (GET /api/youtube/info?id=: 200 = fine, 404 = removed, private or not embeddable). Only a 404
// counts as gone; a network error or any other status proves nothing, so it is neither cached nor held against the song.
const availabilityCache = new Map(); // video id -> true | false
const availabilityChecks = 4; // requests in flight at once
async function checkVideoAvailable(apiBase, id) {
  if (availabilityCache.has(id)) return availabilityCache.get(id);
  try {
    const response = await fetch(`${apiBase}/youtube/info?id=${encodeURIComponent(id)}`);
    if (response.status === 404) {
      availabilityCache.set(id, false);
      return false;
    }
    if (response.ok) availabilityCache.set(id, true);
  } catch {
    // offline or the Worker is down: unknown, so the song stays
  }
  return true;
}

// A library song's beat info ({ bpm: precise, first: seconds of the first beat, duration: seconds }), when usable.
const validBeat = (beat) => Boolean(beat) && Number.isFinite(beat.bpm) && beat.bpm > 0 && Number.isFinite(beat.first) && beat.first >= 0;
const minBeatLeadSeconds = 0.4; // the incoming video needs this long (real time) to be put in place before the beat it joins on
const autoplayWatchMs = 3000; // a video that has not started this long after play() was blocked from autoplaying

// Where a beat-aligned crossfade between two embedded songs starts. `a` is the outgoing song's beat info, `b` the
// incoming one's; rateOut and rateIn are the playback rates (song seconds per real second) and tOut where the
// outgoing song is now (song seconds). The crossfade begins on the next outgoing beat at least minBeatLeadSeconds
// away (waitSeconds from now, real time); the incoming video is put (seek, song seconds) where it will sit exactly
// on one of its own beats at that moment, never before its first beat.
export function embedBeatPlan(a, b, rateOut, rateIn, tOut) {
  const periodOut = 60 / a.bpm;
  const periodIn = 60 / b.bpm;
  let beat = a.first + Math.max(0, Math.ceil((tOut - a.first) / periodOut - 1e-9)) * periodOut;
  let waitSeconds = (beat - tOut) / rateOut;
  while (waitSeconds < minBeatLeadSeconds) {
    beat += periodOut;
    waitSeconds = (beat - tOut) / rateOut;
  }
  const beats = Math.ceil((waitSeconds * rateIn) / periodIn - 1e-9);
  return { waitSeconds, seek: b.first + beats * periodIn - waitSeconds * rateIn };
}

export const EMPTY_LIBRARY_MESSAGE = "No songs in the library yet. Add an audio file.";

// Reordering math, shared by the panel's pointer drag and its keyboard moves (tested on its own).
// dropIndexAt: the insertion point 0..mids.length for a pointer at y, given each row's vertical middle.
export function dropIndexAt(mids, y) {
  const index = mids.findIndex((mid) => y < mid);
  return index === -1 ? mids.length : index;
}
// The position queue.move wants when the row at `from` is dropped at insertion point `drop`:
// taking the row out first shifts everything after it up by one.
export function moveTarget(from, drop) {
  return drop > from ? drop - 1 : drop;
}

// embed: a YouTube player (ytEmbed.js's createYtEmbed, or a stub with the same methods) for the hosted
// site's embed items; without one the queue can't take them. With a `second` player and a swap() (createYtEmbed
// has both) two embed items can blend: the hands' level blend, the AI DJ's timed crossfade and the mix buttons.
// On the hosted site (config hosted + youtubeEmbed) with a player, every library song is an embed item.
export function createQueue(deck, { apiBase = "/api", libraryUrl = "library.json", embed = null } = {}) {
  // Items: { id, title, detail, url } for YouTube, { id, title, detail, file } for files, and
  // { id, title, detail, embed: true, videoId } for a YouTube video played in the embedded player.
  // DJ picks also carry dj: { intro, reason }, and browserVoice: false for AirMix sets (which stay quiet).
  let items = [];
  let currentId = null;
  // The song the last play request asked for: loading, or failed. ⏭ and ⏮ step from it
  // (see stepIndex), so a second press while a song loads moves on, and a broken song is skipped.
  let requestedId = null;
  let status = null; // { message, isError } while adding or loading
  let nextId = 1;
  let played = []; // titles in the order they played, for the DJ to avoid repeats
  // YouTube downloads in progress: { key, title, detail, fromDj, stage, percent, error }.
  let downloads = [];
  // The song library: { id, artist, title, file: "music/<id>.m4a", available }.
  let library = [];
  let libraryLoaded = false; // the library file was read (it may still list no songs)
  // short: short mixes (each song plays about 20 s from where it gets going), so a
  // one-minute demo hears several transitions.
  const dj = { on: false, set: false, vibe: "", busy: false, talking: false, status: null, generation: 0, short: true, crowd: null };
  const listeners = new Set();

  const changed = () => {
    listeners.forEach((listener) => listener());
    prefetch(); // the songs around the current one may have changed
  };
  function setStatus(message, isError = false) {
    status = message ? { message, isError } : null;
    changed();
  }
  function setDjStatus(message, isError = false) {
    dj.status = message ? { message, isError } : null;
    changed();
  }

  async function postJson(path, body) {
    const response = await retryOnNetworkError(() =>
      fetch(`${apiBase}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    if (response.status === 501) throw new Error("start the app with `python server.py` to use this");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `request failed (${response.status})`);
    return data;
  }

  // Downloads a YouTube link or search through server.py, showing it in `downloads`
  // with live progress while it runs. Resolves with { file, title }.
  // cancellable: an AirMix set's download. cancelSet() stops its polling and drops its result
  // (the server may still finish the download, which only warms the cache).
  const setDownloadCancels = new Set(); // cancel hooks of the set's pending downloads
  const cancelError = () => Object.assign(new Error("cancelled"), { cancelled: true });
  async function downloadYouTube(text, { title = text, detail = "YouTube", fromDj = false, cancellable = false } = {}) {
    const job = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const entry = { key: job, title, detail, fromDj, stage: "searching", percent: null, error: null };
    downloads = [...downloads, entry];
    changed();
    let cancelled = false;
    let abort;
    const aborted = new Promise((resolve) => (abort = resolve));
    const hook = () => {
      if (cancelled) return;
      cancelled = true;
      clearInterval(poll);
      removeEntry();
      abort();
    };
    if (cancellable) setDownloadCancels.add(hook);
    const poll = setInterval(async () => {
      try {
        const state = await (await fetch(`${apiBase}/progress?job=${job}`)).json();
        if (!cancelled && state.stage !== "unknown" && entry.stage !== "failed") {
          Object.assign(entry, state);
          changed();
        }
      } catch {
        // Progress is a nicety; the download itself decides success.
      }
    }, progressPollMs);
    const removeEntry = () => {
      downloads = downloads.filter((download) => download !== entry);
      changed();
    };
    try {
      const result = await Promise.race([
        postJson("/youtube", { url: text, job }),
        aborted.then(() => { throw cancelError(); }),
      ]);
      if (cancelled) throw cancelError();
      clearInterval(poll);
      removeEntry();
      setDownloadCancels.delete(hook);
      return result;
    } catch (error) {
      setDownloadCancels.delete(hook);
      if (cancelled) throw cancelError();
      clearInterval(poll);
      Object.assign(entry, { stage: "failed", error: error.message });
      changed();
      setTimeout(removeEntry, 6000); // leave the failure visible for a moment
      throw error;
    }
  }

  // The first song added plays right away, like loading one did before (not every
  // song added while that first one is still loading).
  function add(item, { autoplay = true } = {}) {
    const entry = { id: nextId++, ...item };
    items = [...items, entry];
    changed();
    // Not while a song is playing (removing the playing song clears currentId but it keeps playing).
    if (autoplay && currentId === null && !playsPending && !deck.playing) queue.play(entry.id);
    return entry;
  }

  const currentIndex = () => items.findIndex((item) => item.id === currentId);
  const upcoming = () => items.slice(currentIndex() + 1);
  // The index ⏭ and ⏮ step from: the last song asked for, else the playing one (-1 for none).
  const stepIndex = () => {
    const index = items.findIndex((item) => item.id === requestedId);
    return index === -1 ? currentIndex() : index;
  };

  // How the DJ moves from song to song: beat-matched blends or echo-outs (transitions.js).
  const transitions = createTransitions(deck);

  // The DJ talks over a transition with the music turned down. The hand controls
  // set the volume every frame, so the duck level multiplies whatever they set.
  // While the hands perform a mix, moving them must not change the master volume
  // (it follows the distance between them) or the speed (the left pinch), so both are held.
  const setDeckVolume = deck.setVolume.bind(deck);
  const startingVolume = 0.8; // audio.js's starting volume
  let handVolume = startingVolume;
  let duckLevel = 1;
  let volumeHeld = false;
  let speedHeld = false;
  // The filter (right pinch) too: grabbing things on screen pinches.
  const setDeckFrequency = deck.setFrequency.bind(deck);
  let frequencyHeld = false;
  deck.setFrequency = (hz) => {
    if (!frequencyHeld) setDeckFrequency(hz);
  };
  deck.setVolume = (volume) => {
    if (volumeHeld || !Number.isFinite(volume)) return;
    handVolume = volume;
    setDeckVolume(volume * duckLevel);
    applyEmbedVolume();
  };
  // The speed too: an embed item takes the nearest rate YouTube allows.
  if (typeof deck.setSpeed === "function") {
    const setDeckSpeedChain = deck.setSpeed.bind(deck);
    deck.setSpeed = (speed) => {
      setDeckSpeedChain(speed);
      if (embedId !== null && !speedHeld && !embedMix && Number.isFinite(speed)) embed.setRate(speed);
    };
  }
  function duck(level) {
    duckLevel = level;
    setDeckVolume(handVolume * duckLevel);
    applyEmbedVolume();
  }
  async function fadeTo(level, ms, stillWanted = () => true) {
    const from = duckLevel;
    for (let step = 1; step <= 8; step += 1) {
      if (!stillWanted()) return;
      duck(from + ((level - from) * step) / 8);
      await new Promise((resolve) => setTimeout(resolve, ms / 8));
    }
  }

  // Decoding a song into raw audio takes about 3 s, so the songs around the current
  // one (previous, current, next) and the one under the mouse are kept decoded:
  // ⏮, ⏭ and ▶ start instantly. Not more, since a decoded song is about 100 MB.
  const decoded = new Map(); // item id -> Promise<AudioBuffer>
  const ready = new Map(); // item id -> AudioBuffer, once decoded
  let fallbackDecoder = null;
  let setToken = 0; // bumped whenever an AirMix set starts or is cancelled; its songs carry the one they belong to
  let setPending = false; // a set is prepared but not started (beginSet) yet
  let loadingId = null; // the song being loaded right now, kept even if it moves out of the window
  let hoveredId = null;
  // The embed item loaded in the YouTube player right now (null: the deck, or nothing, is playing).
  let embedId = null;
  // A blend between two embed items: { id (the incoming item), controls, inLevel, outLevel, timer }. While it
  // runs, embedId is still the outgoing item (the current player) and the incoming one plays in embed.second;
  // currentId is the incoming item, as with a deck blend. landEmbedMix() makes the incoming player current.
  let embedMix = null;
  const canPair = () => Boolean(embed?.second && typeof embed.swap === "function");
  // Set once the config is known: library songs not marked `hosted: true` are then YouTube embed items (the
  // hosted site). Songs with hosted: true have audio at music/<id>.m4a and are ordinary audio items.
  let hostedEmbed = false;
  const isEmbedSong = (song) => hostedEmbed && song.hosted !== true;
  // Hosted autoplay: browsers only let a video start after a click. `unlocked` once a click has started (and primed)
  // the players; `needsStart` asks the page to show "Start music" (state.needsStart) until then, or again when a
  // video did not start by itself.
  let unlocked = false;
  let needsStart = false;
  let libraryChecked = Promise.resolve(); // the library's availability checks (hosted)

  // Songs whose download or decoding failed: not retried in the background (asking to
  // play one tries again).
  const loadFailed = new Set();

  function decode(item) {
    if (!decoded.has(item.id)) {
      loadFailed.delete(item.id);
      const promise = retryOnNetworkError(async () => {
        let data;
        if (item.defaultLibrary && !item.url) {
          // Register this decode before download progress calls changed()/prefetch().
          await Promise.resolve();
          const song = library.find((song) => song.id === item.libraryId);
          if (!song) throw new Error("Default song is no longer in the library");
          const url = (await libraryEntry(song, "Default library", { cancellable: item.inSet })).url;
          if (item.inSet && item.setToken !== setToken) throw cancelError();
          item.url = url;
        }
        if (item.url) {
          const response = await fetch(item.url);
          if (!response.ok) throw new Error(`could not fetch audio (${response.status})`);
          data = await response.arrayBuffer();
        } else {
          data = await item.file.arrayBuffer();
        }
        // Before the first click there's no audio context yet; an offline one can still decode.
        fallbackDecoder ??= new OfflineAudioContext(2, 1, 48000);
        const buffer = await (deck.ctx ?? fallbackDecoder).decodeAudioData(data);
        transitions.prepare(buffer);
        if (item.inSet && item.setToken !== setToken) throw cancelError();
        if (decoded.get(item.id) === promise) ready.set(item.id, buffer);
        return buffer;
      });
      promise.catch((error) => {
        // A superseded decode failing late must not delete the newer one or mark the song failed.
        if (decoded.get(item.id) !== promise) return;
        if (error?.cancelled) return void decoded.delete(item.id); // a left set: not a failure
        decoded.delete(item.id);
        loadFailed.add(item.id);
      });
      decoded.set(item.id, promise);
    }
    return decoded.get(item.id);
  }

  // Decodes the songs around the current one ahead of time, and frees any others.
  function prefetch() {
    const index = currentIndex();
    const wanted = index === -1 ? items.slice(0, 1) : items.slice(Math.max(0, index - 1), index + 2);
    const hovered = items.find((item) => item.id === hoveredId);
    if (hovered) wanted.push(hovered);
    wanted.filter((item) => !item.embed && !loadFailed.has(item.id)).forEach(decode); // embed items have no audio to decode
    const keep = new Set(wanted.map((item) => item.id));
    for (const id of decoded.keys()) {
      if (!keep.has(id) && id !== loadingId) {
        decoded.delete(id);
        ready.delete(id);
      }
    }
  }

  // Song loads run one at a time and only the newest request plays: the Deck can't
  // cancel a load, so a slow older one finishing late would replace a newer song.
  let playRequest = 0;
  let endingRequest = null;
  // Stops whatever is loading without asking for another song (pause, seek, ending a set).
  // ⏭ and ⏮ then step from the song that's playing.
  function cancelRequest() {
    playRequest += 1;
    requestedId = currentId;
  }
  function cancelEnding() {
    if (endingRequest === null) return;
    endingRequest = null;
    duck(1);
    setDeckFrequency(20000);
  }
  let playsPending = 0;
  let defaultQueueStarting = null;
  let loadingRequest = 0; // the request that owns loadingId

  // mix: false, or { mixOutAt } to mix into the song (see transitions.mixInto).
  // entry: start where the song gets going (short mixes) instead of at 0.
  function playItem(id, { mix = false, entry = false } = {}) {
    cancelEnding();
    landEmbedMix();
    const request = ++playRequest;
    requestedId = id;
    playsPending += 1;
    // Not serialized: a superseded load (maybe a long download) must not hold up the newest
    // request. loadAndPlay drops anything superseded once its decode finishes.
    return loadAndPlay(id, { mix, entry, request }).finally(() => (playsPending -= 1));
  }

  // Resolves startHandMix()'s promise with the hand controls once the mix is scheduled.
  let handMixStarted = null;
  let handMix = null; // the hand mix's controls while it runs (until .done)

  // While the DJ is introducing a song or switching to it: the flag, and which song.
  let transitioning = false;
  let transitionId = null;
  let transitionRun = 0;
  let stopVoice = null;
  function cancelTransition() {
    transitionRun += 1;
    transitioning = false;
    transitionId = null;
    handMixStarted?.(null);
    stopVoice?.();
    dj.talking = false;
    landEmbedMix(); // a blend between two YouTube songs lands at once (the incoming one stays, as on the deck)
    duck(1);
  }

  // ---- library ---------------------------------------------------------------------

  async function loadLibrary() {
    try {
      // The hosted site plays every library song in YouTube's own player (the id is the video id).
      if (embed) {
        const config = await loadConfig(apiBase);
        hostedEmbed = config.hosted && config.youtubeEmbed;
      }
      const response = await fetch(libraryUrl);
      if (!response.ok) return;
      const data = await response.json();
      const songs = (Array.isArray(data) ? data : data?.songs) ?? [];
      libraryLoaded = true;
      library = songs.map((song) => ({ ...song, file: `music/${song.id}.m4a`, available: hostedEmbed || song.hosted === true ? true : null }));
      // The hosted site lists its own audio first: those songs have effects, so they lead the panel and the default queue.
      if (hostedEmbed) library = [...library.filter((song) => song.hosted === true), ...library.filter((song) => song.hosted !== true)];
      if (hostedEmbed) library.forEach((song) => (song.unavailable = isEmbedSong(song) && availabilityCache.get(song.id) === false));
      changed();
      if (hostedEmbed) {
        libraryChecked = checkLibrary(library.filter(isEmbedSong)); // YouTube availability: embed songs only
        return; // nothing to look for in music/
      }
      // Which songs are actually in music/ (prefetch.py fills it). Hosted audio is known to be there.
      await Promise.all(
        library.filter((song) => song.hosted !== true).map(async (song) => {
          try {
            song.available = (await fetch(song.file, { method: "HEAD" })).ok;
          } catch {
            song.available = false;
          }
        }),
      );
      changed();
    } catch (error) {
      console.warn("No song library:", error.message);
    }
  }

  // Checks each song of the hosted library once, a few at a time. A song YouTube no longer plays in an embed is
  // marked `unavailable` (greyed out in the Library, left out of Add all, the default queue and the AI DJ's picks).
  async function checkLibrary(songs) {
    let next = 0;
    const worker = async () => {
      while (next < songs.length) {
        const song = songs[next++];
        if (song.unavailable || (await checkVideoAvailable(apiBase, song.id))) continue;
        song.unavailable = true;
        changed();
      }
    };
    await Promise.all(Array.from({ length: availabilityChecks }, worker));
  }
  // Waits for the checks, but not for long: a slow network must not hold up the first song.
  async function checkedSoon(ms = 1500) {
    let timer;
    await Promise.race([libraryChecked, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
    clearTimeout(timer);
  }
  const playable = () => library.filter((song) => !song.unavailable);
  const notAvailableMessage = (song) => `"${song.title}" isn't available on YouTube`;

  // A queue item for a library song: straight from music/, or downloaded first
  // if it isn't there yet (run prefetch.py so that never happens on stage).
  async function libraryEntry(song, detail, { cancellable = false } = {}) {
    const title = `${song.artist} - ${song.title}`;
    const facts = { libraryId: song.id, bpm: song.bpm, genre: song.genre };
    if (isEmbedSong(song)) return { title, detail, embed: true, videoId: song.id, ...facts, beat: song.beat };
    if (song.hosted === true) return { title, detail, url: song.file, ...facts, hosted: true }; // real audio, no download step
    if (song.available !== false) return { title, detail, url: song.file, ...facts };
    // The hosted site can't download: a song that isn't in music/ simply isn't available.
    if (!(await loadConfig(apiBase)).youtube) throw new Error(`"${song.title}" isn't available`);
    const download = await downloadYouTube(`https://www.youtube.com/watch?v=${song.id}`, {
      title,
      detail: "Not in music/ yet (run prefetch.py), downloading",
      cancellable,
    });
    return { title, detail, url: download.file, ...facts };
  }

  function abortSetDownloads() {
    [...setDownloadCancels].forEach((hook) => hook());
    setDownloadCancels.clear();
  }

  // ---- AI DJ ----------------------------------------------------------------------

  // An AirMix set's DJ line for a song (kept with the song, but AirMix doesn't speak it).
  function setLine(song, previous) {
    const name = `${song.title} by ${song.artist}`;
    if (!previous) return `Welcome to AirMix! Hands up. First up: ${name}.`;
    const genre = (song.genre ?? "").split("/")[0].trim();
    return genre ? `Switching it up, ${genre} time: ${name}!` : `Next up: ${name}!`;
  }

  // The DJ only speaks up when the set changes direction: its first song, and genre
  // switches (hip-hop into trap, reggaeton into afrobeats). Close moves like hip-hop
  // into "R&B / hip-hop" share a genre and stay quiet, and so do songs without one.
  const genresOf = (item) => (item?.genre ?? "").toLowerCase().split("/").map((genre) => genre.trim()).filter(Boolean);
  function djSpeaksBefore(item, previous) {
    if (!item.dj?.intro) return false;
    if (!previous) return true;
    const before = genresOf(previous);
    const after = genresOf(item);
    return before.length > 0 && after.length > 0 && !after.some((genre) => before.includes(genre));
  }

  // Whether a line will actually be heard (the browser has a voice, and the item isn't
  // an AirMix set's, which stays quiet), so the music isn't ducked for nothing.
  function canSpeak(item) {
    return item.dj?.browserVoice !== false && "speechSynthesis" in window;
  }

  // Says a DJ line with the browser's voice and resolves when it's done (or after a timeout).
  async function speak(item, stillWanted = () => true) {
    const intro = item.dj?.intro;
    if (!intro || !canSpeak(item) || !stillWanted()) return;
    return new Promise((resolve) => {
      let line = null, finished = false;
      const cancel = () => {
        if (line) speechSynthesis.cancel();
        done();
      };
      stopVoice = cancel;
      const timer = setTimeout(cancel, voiceTimeoutMs);
      function done() {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (stopVoice === cancel) stopVoice = null;
        resolve();
      }
      line = new SpeechSynthesisUtterance(intro);
      line.onend = done;
      line.onerror = done;
      speechSynthesis.speak(line);
    });
  }

  // The DJ mixes into the next song (transitions.js) and introduces it over the mix,
  // with the music turned down. With nothing playing, it introduces the song first.
  // One at a time.
  async function transitionTo(item, { mixOutAt, startAt = null, style = null, hands = false } = {}) {
    // Two YouTube songs crossfade; any other move into an embed (from a file, say) is a plain cut.
    const embedMixing = embedMixable(item);
    if (item.embed && !embedMixing) return void (await queue.play(item.id));
    const mine = ++transitionRun;
    const ownsTransition = () => mine === transitionRun;
    transitioning = true;
    transitionId = item.id;
    try {
      const mixing = embedMixing || Boolean(!item.embed && deck.playing && deck.buffer);
      const talks = djSpeaksBefore(item, mixing ? items.find((entry) => entry.id === currentId) : null);
      // Mix in from the playing song, or (nothing playing) just start, at the song's
      // entry with short mixes. Either way the DJ talks over the music, not before it.
      await playItem(item.id, mixing ? { mix: { mixOutAt, startAt, style, hands } } : { entry: dj.short });
      if (!ownsTransition() || currentId !== item.id) return;
      if (talks && canSpeak(item)) {
        if (!ownsTransition() || currentId !== item.id) return;
        dj.talking = true;
        changed();
        await fadeTo(duckedVolume, duckFadeMs, ownsTransition);
        if (!ownsTransition()) return;
        await speak(item, ownsTransition);
        if (!ownsTransition()) return;
        dj.talking = false;
        changed();
        await fadeTo(1, duckFadeMs, ownsTransition);
      }
    } finally {
      if (ownsTransition()) {
        duck(1);
        dj.talking = false;
        transitioning = false;
        transitionId = null;
      }
    }
  }

  // Asks the DJ for more songs whenever fewer than djSongsAhead are queued.
  async function topUpDj() {
    if (!dj.on || dj.set || dj.busy || upcoming().length >= djSongsAhead) return;
    const generation = dj.generation;
    const stillValid = () => dj.on && dj.generation === generation;
    dj.busy = true;
    setDjStatus("Picking songs…");
    let added = 0;
    try {
      const current = items.find((item) => item.id === currentId);
      // The DJ only picks from the library (instant, nothing to download).
      if (!library.length) throw new Error(libraryLoaded ? EMPTY_LIBRARY_MESSAGE : "the song library isn't loaded");
      if (hostedEmbed) await checkedSoon();
      if (!playable().length) throw new Error("no library song is available");
      const { picks } = await postJson("/dj/pick", {
        vibe: dj.vibe,
        nowPlaying: current?.title ?? "",
        queued: items.slice(Math.max(0, currentIndex())).map((item) => item.title), // current and upcoming, not played ones
        crowd: dj.crowd,
        played,
        count: djPicksPerRequest,
        library: playable().map(({ id, artist, title, bpm, genre }) => ({ id, artist, title, bpm, genre })),
      });
      // Every pick gets ready at the same time; they join the queue in pick order.
      setDjStatus(`Getting ${picks.length} songs ready…`);
      const jobs = picks.map((pick) => {
        const label = `${pick.artist} - ${pick.title}`;
        const detail = `AI DJ · ${pick.reason}`;
        const librarySong = library.find((song) => song.id === pick.id && !song.unavailable);
        const song = librarySong ? libraryEntry(librarySong, detail) : Promise.reject(new Error("not in the library"));
        return song.then(
          (entryData) => ({ pick, label, entryData }),
          (error) => ({ label, error }),
        );
      });
      for (const job of jobs) {
        const { pick, label, entryData, error } = await job;
        if (!stillValid()) break;
        if (error) {
          console.warn(`DJ skipped ${label}:`, error.message);
          continue;
        }
        const entry = add(
          {
            ...entryData,
            dj: { intro: pick.intro, reason: pick.reason },
          },
          { autoplay: false },
        );
        added += 1;
        // Nothing playing yet: start the set (unless the page starts it, after a countdown).
        if (currentId === null && !transitioning && !dj.waitToStart) transitionTo(entry);
      }
      if (stillValid() && !added) throw new Error("none of the picks could be loaded");
      setDjStatus(null);
    } catch (error) {
      if (dj.generation === generation) dj.busy = false;
      setDjStatus(`AI DJ: ${error.message}`, true);
      return; // don't retry in a loop; the next song change tries again
    }
    // A newer request (after a vibe change) owns the busy flag now.
    if (dj.generation !== generation) return;
    dj.busy = false;
    changed();
    topUpDj(); // still short because some picks failed? ask again
  }

  // With the DJ on, the mix into the next song starts as the current one nears its end.
  // No next song yet: the current one loops (and gets mixed out next time around).
  // While a game (djGame.js) is running, it decides when to mix instead.
  let coachSeen = 0;
  const coached = () => performance.now() - coachSeen < 4000; // a hiccup (a song decoding) mustn't hand a mix to the AI
  setInterval(() => {
    if (!dj.on || transitioning || embedMix) return;
    if (embedActive()) {
      // A YouTube song: a timed volume crossfade into the next YouTube song as this video nears its end.
      // (Into anything else it just ends and the next item starts.)
      const following = upcoming().find((item) => !loadFailed.has(item.id));
      if (coached() || !following || !embedMixable(following) || !embed.isPlaying()) return;
      const current = items.find((entry) => entry.id === currentId);
      const beats = validBeat(current?.beat) && validBeat(following.beat);
      const duration = embed.getDuration() || (beats ? current.beat.duration : 0) || 0;
      // With beats the fade starts on a beat, up to one beat later than this moment: leave room for it, and
      // count in real time (the video may play faster or slower).
      const left = beats ? (duration - embed.getTime()) / nearestRate(deck.rate || 1) : duration - embed.getTime();
      const lead = embedLeadSeconds + (beats ? 60 / current.beat.bpm : 0);
      if (duration > 0 && left <= embedFadeSeconds() + lead) transitionTo(following);
      return;
    }
    if (!deck.playing || !deck.buffer) return;
    // A song that failed to load isn't retried here every tick; the next one that hasn't failed is used.
    const next = upcoming().find((item) => !loadFailed.has(item.id));
    if (!next) return;
    if (!coached() && position() >= transitions.mixPoint(deck.buffer, dj.short)) {
      transitionTo(next, { mixOutAt: transitions.mixOutPoint(deck.buffer, dj.short) });
    }
  }, 200);

  // mix: blend or echo into the song from the playing one (the DJ), instead of switching.
  async function loadAndPlay(id, { mix = false, entry = false, request } = {}) {
    const item = items.find((entry) => entry.id === id);
    if (!item) return;
    if (item.embed) return playEmbed(item, request, mix);
    loadingId = id;
    loadingRequest = request;
    changed();
    try {
      const buffer = await decode(item);
      // A newer selection may arrive while decoding. Never start a superseded song.
      if (request !== playRequest || !items.some((entry) => entry.id === id)) return;
      deck.ensureContext();
      if (mix && deck.playing) {
        if (loadingRequest === request) loadingId = null;
        changed();
        const from = items.find((entry) => entry.id === currentId);
        const mixed = await transitions.mixInto(buffer, {
          mixOutAt: mix.mixOutAt,
          startAt: mix.startAt ?? null,
          style: mix.style ?? null,
          hands: mix.hands,
          short: dj.short,
          fromBpm: from?.bpm,
          toBpm: item.bpm,
          stillWanted: () => request === playRequest && items.some((entry) => entry.id === id),
        });
        if (!mixed || request !== playRequest) return;
        console.info(`AI DJ ${mixed.hands ? "hand " : ""}${mixed.style}: ${from?.title} → ${item.title}`, mixed);
        handMixStarted?.(mixed.hands);
      } else {
        // Same steps as Deck.loadArrayBuffer in audio.js, with the decoding already done.
        stopEmbed(); // leaving a YouTube song is a plain cut
        transitions.cancel();
        deck.stopSource();
        deck.buffer = buffer;
        deck.offset = entry ? transitions.entryPoint(buffer, true) : 0;
        deck.play();
      }
      currentId = id;
      if (played.at(-1) !== item.title) played = [...played, item.title].slice(-50);
      status = null;
      topUpDj();
    } catch (error) {
      if (request === playRequest) status = { message: `Error: ${error.message}`, isError: true };
    } finally {
      if (loadingId === id && loadingRequest === request) loadingId = null;
      changed();
    }
  }

  // ---- YouTube embeds (hosted site) ---------------------------------------------------------
  // An embed item plays in YouTube's own player (ytEmbed.js): volume and speed follow the hands, but
  // there's no filter, effects, waveform or beat matching. Two embed items can blend (a level crossfade of the
  // two players' volumes, driven by the hands or timed); any other move to or from one is a plain cut.
  const embedActive = () => embedId !== null && (embedId === currentId || (embedMix !== null && embedMix.id === currentId));
  const embedFadeSeconds = () => (dj.short ? shortBlendSeconds : blendSeconds);
  // The player of the song that is current (during a blend, the incoming one).
  const livePlayer = () => (embedMix ? embed.second : embed);
  // Whether the item can come in under the playing YouTube song (both are embeds, a second player exists).
  const embedMixable = (item) =>
    Boolean(item?.embed && item.id !== currentId && !embedMix && embedActive() && canPair() && embed.isPlaying());
  // Whether a hand blend (or a timed mix) can start into the item right now, for either kind of song.
  const blendable = (item) => Boolean(item && item.id !== currentId && !transitioning && !embedMix && (
    embedActive() ? embedMixable(item) : !item.embed && deck.playing && deck.buffer
  ));

  // The volumes of both players: the hands' volume (and the DJ's duck) times each player's blend level.
  function applyEmbedVolume() {
    if (embedId === null) return;
    const base = handVolume * duckLevel;
    embed.setVolume(base * (embedMix ? embedMix.outLevel : 1));
    if (embedMix) embed.second.setVolume(base * embedMix.inLevel);
  }

  function stopEmbed() {
    if (embedMix) {
      clearTimeout(embedMix.timer);
      embedMix = null;
      embed.second.stop();
    }
    if (embedId === null) return;
    embedId = null;
    embed.stop();
  }

  // The blend lands: the outgoing player stops and the incoming one becomes the current player.
  function landEmbedMix() {
    const mix = embedMix;
    if (!mix) return;
    clearTimeout(mix.timer);
    embedMix = null;
    embed.stop(); // the old current player (it hides its frame)
    embed.swap();
    embedId = mix.id;
    applyEmbedVolume();
    changed();
  }

  // The incoming song is dropped (it failed, or was removed) and the outgoing one carries on alone.
  function abortEmbedMix() {
    const mix = embedMix;
    if (!mix) return;
    clearTimeout(mix.timer);
    embedMix = null;
    embed.second.stop();
    if (currentId === mix.id) currentId = embedId;
    requestedId = currentId;
    applyEmbedVolume();
    changed();
  }

  // Live controls with the same shape as transitions.mixInto's hands controls (index.html drives them
  // with the hand height): the levels of the two players. A manual blend has no beats, bass swap or echo.
  function embedMixControls(mix) {
    const live = () => embedMix === mix && !mix.closing;
    const level = (value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
    const controls = {
      style: "blend",
      barSeconds: 2,
      startsIn: 0,
      get done() {
        return embedMix !== mix;
      },
      setIncoming(value) {
        if (!live()) return;
        mix.inLevel = level(value);
        applyEmbedVolume();
      },
      setOutgoing(value) {
        if (!live()) return;
        mix.outLevel = level(value);
        applyEmbedVolume();
      },
      swapBass: () => null,
      thinOutgoing() {},
      echoOut: () => controls.finish(),
      // Eases the incoming song to full and the outgoing one out over `seconds`, then lands the blend.
      finish(seconds = 2) {
        if (embedMix !== mix || mix.closing) return;
        mix.closing = true;
        const started = Date.now();
        const from = { in: mix.inLevel, out: mix.outLevel };
        const ms = Math.max(0, seconds * 1000);
        const step = () => {
          if (embedMix !== mix) return;
          const share = ms === 0 ? 1 : Math.min(1, (Date.now() - started) / ms);
          mix.inLevel = from.in + (1 - from.in) * share;
          mix.outLevel = from.out * (1 - share);
          applyEmbedVolume();
          if (share >= 1) landEmbedMix();
          else mix.timer = setTimeout(step, Math.min(100, ms / 4 || 100));
        };
        step();
      },
    };
    return controls;
  }

  // The speed the incoming YouTube song starts at: the playing speed, matched to the outgoing song's tempo
  // from the library bpm only when that is within what the deck would nudge (8%; double and half time count as
  // the same tempo). The player then rounds to the nearest rate YouTube allows, so usually it stays at 1.
  function incomingRate(from, to) {
    const speed = deck.rate || 1;
    if (!from?.bpm || !to?.bpm) return speed;
    let ratio = from.bpm / to.bpm;
    while (ratio > Math.SQRT2) ratio /= 2;
    while (ratio < Math.SQRT1_2) ratio *= 2;
    return Math.abs(ratio - 1) <= maxNudge ? speed * ratio : speed;
  }

  // Marks an embed item as failed with the reason and moves on to the next item, once. Never retries:
  // asking to play it again is up to the user.
  function failEmbed(item, reason, { moveOn = true } = {}) {
    if (item.failed) return;
    item.failed = reason;
    loadFailed.add(item.id);
    if (embedId === item.id) stopEmbed();
    if (currentId === item.id) currentId = null;
    status = { message: `"${item.title}" can't be played: ${reason}`, isError: true };
    changed();
    const next = items[items.findIndex((entry) => entry.id === item.id) + 1];
    if (moveOn && next) queue.play(next.id);
  }

  // The incoming song of a blend can't be played: it's marked failed, the blend is dropped and the outgoing
  // song carries on.
  function failIncoming(item, reason) {
    if (item.failed) return;
    item.failed = reason;
    loadFailed.add(item.id);
    if (embedMix?.id === item.id) abortEmbedMix();
    status = { message: `"${item.title}" can't be played: ${reason}`, isError: true };
    changed();
  }

  // Hosted autoplay (see unlocked / needsStart). Called as a video is about to load: inside a click (the browser
  // says the page has user activation) the players unlock at once, the second one primed; otherwise (a hand
  // gesture, the AI DJ) the page is asked to show its "Start music" button. A browser that can't tell never gates.
  function gateAutoplay(item) {
    if (!hostedEmbed || unlocked) return;
    const activation = typeof navigator === "undefined" ? null : navigator.userActivation;
    if (!activation) unlocked = true;
    else if (activation.isActive) {
      unlocked = true;
      primeSecond(item);
    } else needsStart = true;
  }
  // Plays a muted video in the second player once (inside a click) so a later blend may start it by itself.
  function primeSecond(item) {
    if (!embed?.second || typeof embed.second.prime !== "function") return;
    const following = items.slice(items.findIndex((entry) => entry.id === item.id) + 1).find((entry) => entry.embed && !entry.failed);
    embed.second.prime((following ?? item).videoId);
  }
  // A video that has not started a few seconds after play() was refused autoplay: show "Start music" again.
  // One that did start without any click needs no button.
  function watchAutoplay(item) {
    if (!hostedEmbed) return;
    const timer = setTimeout(() => {
      const player = embedMix?.id === item.id ? embed.second : embedId === item.id ? embed : null;
      if (!player) return;
      if (player.isPlaying() || player.getTime() >= 0.5) {
        if (!unlocked && needsStart) {
          needsStart = false;
          changed();
        }
        return;
      }
      needsStart = true;
      changed();
    }, autoplayWatchMs);
    timer?.unref?.();
  }

  async function playEmbed(item, request, mix = false) {
    if (mix && embedActive() && canPair()) return playEmbedMix(item, request, mix);
    loadingId = item.id;
    loadingRequest = request;
    item.failed = null;
    loadFailed.delete(item.id);
    changed();
    try {
      if (!embed) throw new Error("YouTube videos can't be played here");
      gateAutoplay(item);
      await embed.load(item.videoId);
      if (request !== playRequest || !items.some((entry) => entry.id === item.id)) {
        // Superseded while YouTube's player loaded: don't let it play over the newer choice.
        const replaced = embedId; // the player's previous video, if an embed was playing, is gone now
        embed.stop();
        embedId = null;
        if (replaced !== null && currentId === replaced) currentId = null;
        return;
      }
      transitions.cancel();
      deck.stopSource();
      embedId = item.id;
      currentId = item.id;
      applyEmbedVolume();
      embed.setRate(deck.rate || 1);
      if (played.at(-1) !== item.title) played = [...played, item.title].slice(-50);
      status = null;
      watchAutoplay(item);
      topUpDj();
    } catch (error) {
      if (request === playRequest) failEmbed(item, error.message);
    } finally {
      if (loadingId === item.id && loadingRequest === request) loadingId = null;
      changed();
    }
  }

  // Blends into an embed item under the playing one: the incoming song loads silent in the second player,
  // then the hands (mix.hands) or a timed ramp move the two volumes. currentId is the incoming item from
  // here, as on the deck; embedId stays the outgoing one until the blend lands.
  async function playEmbedMix(item, request, mix) {
    loadingId = item.id;
    loadingRequest = request;
    item.failed = null;
    loadFailed.delete(item.id);
    changed();
    const outgoing = items.find((entry) => entry.id === currentId);
    const outgoingEmbedId = embedId;
    // Both songs know their beats (and the hands are not the ones mixing): the crossfade is beat-aligned.
    const aligned = !mix.hands && validBeat(outgoing?.beat) && validBeat(item.beat);
    const rateIn = incomingRate(outgoing, item);
    try {
      gateAutoplay(item);
      await embed.second.load(item.videoId, aligned ? { volume: 0, rate: rateIn, start: item.beat.first } : { volume: 0, rate: rateIn });
      if (request !== playRequest || !items.some((entry) => entry.id === item.id) || embedMix || embedId !== outgoingEmbedId || !embedActive()) {
        embed.second.stop(); // superseded (or the outgoing song went away) while YouTube's player loaded
        return;
      }
      const state = { id: item.id, inLevel: 0, outLevel: 1, timer: null, closing: false, controls: null };
      state.controls = embedMixControls(state);
      embedMix = state;
      currentId = item.id;
      if (played.at(-1) !== item.title) played = [...played, item.title].slice(-50);
      status = null;
      applyEmbedVolume();
      console.info(`AI DJ ${mix.hands ? "hand " : ""}YouTube blend: ${outgoing?.title} → ${item.title}`);
      handMixStarted?.(mix.hands ? state.controls : null);
      watchAutoplay(item);
      if (!mix.hands) {
        if (aligned) {
          // Put the incoming video where its beats meet the outgoing song's next beat, and begin the fade on it.
          const plan = embedBeatPlan(outgoing.beat, item.beat, nearestRate(deck.rate || 1), nearestRate(rateIn), embed.getTime());
          embed.second.seekTo(plan.seek);
          state.timer = setTimeout(() => state.controls.finish(embedFadeSeconds()), plan.waitSeconds * 1000);
        } else state.controls.finish(embedFadeSeconds());
      }
      topUpDj();
    } catch (error) {
      if (request === playRequest) {
        item.failed = error.message;
        loadFailed.add(item.id);
        status = { message: `"${item.title}" can't be played: ${error.message}`, isError: true };
      }
    } finally {
      if (loadingId === item.id && loadingRequest === request) loadingId = null;
      changed();
    }
  }

  if (embed) {
    // The video ended: on to the next item that hasn't failed (not wrapping: a lone video doesn't replay forever).
    // Mid-blend, the outgoing song ending just lands the blend.
    embed.onEnded(() => {
      if (embedMix) return void landEmbedMix();
      if (!embedActive()) return;
      const next = items.slice(currentIndex() + 1).find((item) => !item.failed);
      if (next) queue.play(next.id);
    });
    // Embedding turned off, video removed, etc.: failed, and on to the next item once. Mid-blend, the
    // outgoing song failing marks it failed and lets the incoming one carry on.
    embed.onError((message) => {
      const item = items.find((entry) => entry.id === embedId);
      if (embedMix) {
        if (item && !item.failed) {
          item.failed = message;
          loadFailed.add(item.id);
          status = { message: `"${item.title}" can't be played: ${message}`, isError: true };
        }
        return void landEmbedMix();
      }
      if (item) failEmbed(item, message);
    });
    // The incoming song of a blend.
    embed.second?.onError?.((message) => {
      const item = items.find((entry) => entry.id === embedMix?.id);
      if (item) failIncoming(item, message);
    });
    embed.second?.onEnded?.(() => {
      if (embedMix) landEmbedMix();
    });
  }

  // Where the current song is, in seconds (0 when nothing is loaded).
  function position() {
    if (embedActive()) return livePlayer().getTime();
    if (!deck.buffer) return 0;
    const seconds = deck.playing ? deck.position() : deck.offset;
    return Math.max(0, seconds % deck.buffer.duration);
  }

  // ---- public API -----------------------------------------------------------------

  const queue = {
    getState: () => ({
      items,
      currentId,
      loadingId,
      downloads,
      library,
      libraryLoaded,
      status,
      needsStart,
      dj: { on: dj.on, set: dj.set, vibe: dj.vibe, busy: dj.busy, talking: dj.talking, status: dj.status, short: dj.short },
    }),

    // Fast-changing playback state for progress bars; read it every frame.
    getPlayback: () => embedActive()
      ? { position: livePlayer().getTime(), duration: livePlayer().getDuration(), playing: livePlayer().isPlaying(), loaded: true, rate: 1, songId: currentId, embed: true }
      : {
      position: position(),
      duration: deck.buffer?.duration ?? 0,
      playing: Boolean(deck.playing),
      loaded: Boolean(deck.buffer),
      rate: deck.rate || 1, // song seconds per real second
      songId: currentId,
    },

    // The playing song's beat grid ({ bpm, first downbeat }, song seconds) around a point
    // in it, and how loud it is there (1 = its typical level). For djGame.js's charts.
    beatGridAt: (seconds) => (deck.buffer && !embedActive() ? transitions.beatGridAt(deck.buffer, seconds) : null),
    energyAt: (seconds) => (deck.buffer && !embedActive() ? transitions.energyAt(deck.buffer, seconds) : 1),

    // Where (song seconds) the DJ mixes the playing song out by, or null with the DJ off.
    mixOutAt: () => (dj.on && deck.buffer && !embedActive() ? transitions.mixOutPoint(deck.buffer, dj.short) : null),

    // How the crowd (the player) is doing, 0–1: the DJ hears about it with its next picks.
    setCrowd(level) {
      dj.crowd = Math.round(Math.max(0, Math.min(1, level)) * 100) / 100;
    },

    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    // A YouTube link, or plain words to grab the top search result.
    async addYouTube(linkOrSearch) {
      const text = linkOrSearch.trim();
      if (!text) return;
      try {
        const body = await downloadYouTube(text, { title: /^https?:\/\//i.test(text) ? "YouTube link" : text });
        add({ title: body.title, detail: "YouTube", url: body.file });
      } catch (error) {
        console.warn("YouTube add failed:", error.message);
      }
    },

    // Whether something is playing right now (a YouTube song counts as well as the deck).
    isPlaying: () => (embedActive() ? livePlayer().isPlaying() : Boolean(deck.playing)),
    // Whether the current song plays in YouTube's player (no filter or effects there).
    isEmbedActive: () => embedActive(),
    // Whether a hand blend into this item could start now (the same kind of song on both sides).
    canHandBlend: (item) => blendable(item),

    // Whether YouTube links can be added as embedded videos (the page gave the queue a player).
    supportsEmbed: Boolean(embed),

    // A YouTube link for the embedded player (the hosted site; nothing is downloaded). Returns the
    // item, or null with a status message for something that isn't a YouTube link. The title comes
    // from the Worker's /api/youtube/info (YouTube's public oEmbed) and falls back to "YouTube video".
    addYouTubeEmbed(link) {
      const videoId = parseYouTubeId(link);
      if (!videoId) {
        setStatus(BAD_LINK_MESSAGE, true);
        return null;
      }
      if (!embed) {
        setStatus("YouTube videos can't be played here", true);
        return null;
      }
      const entry = add({ embed: true, videoId, title: "YouTube video", detail: "YouTube" });
      (async () => {
        try {
          const response = await fetch(`${apiBase}/youtube/info?id=${videoId}`);
          const info = response.ok ? await response.json() : null;
          if (typeof info?.title === "string" && info.title) {
            entry.title = info.title;
            entry.detail = info.author ? `YouTube · ${info.author}` : "YouTube";
            changed();
          }
        } catch {
          // The title is a nicety: the video still plays.
        }
      })();
      return entry;
    },

    addFile(file) {
      if (!file) return;
      add({ title: file.name.replace(/\.[^.]+$/, ""), detail: "File", file });
    },

    // The hosted site's "Start music" button (call it inside the click): unlocks BOTH YouTube players for autoplay
    // (loads the current video, and plays a muted video in the second player once, so later blends can start by
    // themselves) and starts playback. Returns whether there was a video to start.
    startMusic() {
      unlocked = true;
      needsStart = false;
      if (!embed) return changed(), false;
      const wanted = (entry) => entry.embed && !entry.failed;
      const target =
        items.find((entry) => entry.id === currentId && wanted(entry)) ??
        items.find((entry) => entry.id === requestedId && wanted(entry)) ??
        items.find(wanted);
      if (!target) {
        changed();
        return false;
      }
      primeSecond(target);
      if (embedMix) embed.play?.();
      else if (embedActive() && embedId === target.id && !embed.isPlaying()) {
        embed.play(); // the video is loaded but never started
        watchAutoplay(target);
      } else if (!(embedActive() && embedId === target.id)) queue.play(target.id);
      changed();
      return true;
    },

    // Adds a library song (by its id), instantly from music/. playNow plays it right away.
    // autoplay: false only queues it (it still gets decoded ahead, if it's up next).
    async addFromLibrary(id, { playNow = false, autoplay = true } = {}) {
      const song = library.find((entry) => entry.id === id);
      if (!song) return;
      if (song.unavailable) return void setStatus(notAvailableMessage(song), true);
      try {
        const entry = add(await libraryEntry(song, "Library"), { autoplay: autoplay && !playNow });
        if (playNow) queue.play(entry.id);
      } catch (error) {
        setStatus(`Error: ${error.message}`, true);
      }
    },

    // An empty gesture queue boots the built-in library and plays its first track.
    // Only nearby songs resolve/download as they are decoded, so startup never waits
    // for all twenty downloads. Repeated gestures share one startup request.
    startDefaultQueue() {
      if (defaultQueueStarting) return defaultQueueStarting;
      defaultQueueStarting = (async () => {
        await libraryReady;
        if (hostedEmbed) await checkedSoon();
        if (!items.length) {
          if (!library.length) throw new Error(libraryLoaded ? EMPTY_LIBRARY_MESSAGE : "The default song library could not be loaded");
          if (hostedEmbed && !playable().length) throw new Error("No library song is available on YouTube right now");
          // Hosted: start with the site's own tracks (effects work, mixes beat-match) when there are any, else the YouTube songs.
          const starters = hostedEmbed ? (playable().some((song) => song.hosted === true) ? playable().filter((song) => song.hosted === true) : playable()) : library;
          for (const song of starters) add(isEmbedSong(song)
            ? { title: `${song.artist} - ${song.title}`, detail: "Default library", embed: true, videoId: song.id, libraryId: song.id, bpm: song.bpm, genre: song.genre, beat: song.beat }
            : {
              title: `${song.artist} - ${song.title}`, detail: "Default library",
              libraryId: song.id, bpm: song.bpm, genre: song.genre, defaultLibrary: true,
              url: song.available ? song.file : null,
            }, { autoplay: false });
        }
        const first = items[0];
        await queue.play(first.id);
        if (currentId !== first.id) throw new Error(status?.message || "Could not start the default queue");
      })().finally(() => { defaultQueueStarting = null; });
      return defaultQueueStarting;
    },

    // Adds the whole library in order.
    async addAllFromLibrary() {
      await libraryReady;
      if (hostedEmbed) await checkedSoon();
      // Added at once and lazily, like startDefaultQueue: uncached songs (url: null) download
      // only when decode() reaches them. The first one still autoplays, as before.
      // Hosted: the site's own tracks first (the library is already in that order), then the YouTube songs.
      for (const song of hostedEmbed ? playable() : library) add(isEmbedSong(song)
        ? { title: `${song.artist} - ${song.title}`, detail: "Library", embed: true, videoId: song.id, libraryId: song.id, bpm: song.bpm, genre: song.genre, beat: song.beat }
        : {
          title: `${song.artist} - ${song.title}`, detail: "Library",
          libraryId: song.id, bpm: song.bpm, genre: song.genre, defaultLibrary: true,
          url: song.available !== false ? song.file : null,
        });
    },

    // Moves an item to a new position (0 = top).
    move(id, position) {
      const item = items.find((entry) => entry.id === id);
      if (!item) return;
      const rest = items.filter((entry) => entry.id !== id);
      rest.splice(Math.max(0, Math.min(position, rest.length)), 0, item);
      items = rest;
      changed();
    },

    // Removing the playing song leaves it playing; it's just off the list.
    remove(id) {
      // Stepping from a removed request goes on from the song before it, so ⏭ still reaches the one after.
      if (requestedId === id) {
        const index = items.findIndex((entry) => entry.id === id);
        requestedId = items[index - 1]?.id ?? null;
      }
      items = items.filter((entry) => entry.id !== id);
      if (embedMix?.id === id) abortEmbedMix(); // the incoming song is gone: the outgoing one carries on
      else if (embedMix && embedId === id) landEmbedMix(); // the outgoing song is gone: the blend lands
      else if (embedId === id) stopEmbed(); // an embed can't keep playing unseen: it stops
      if (currentId === id) currentId = null;
      changed();
      topUpDj();
    },

    play(id) {
      cancelTransition();
      return playItem(id);
    },

    togglePlay() {
      if (embedActive()) {
        cancelRequest();
        cancelTransition();
        if (embed.isPlaying()) embed.pause();
        else embed.play();
        changed();
        return;
      }
      if (!deck.buffer) {
        if (items.length) queue.play(items[0].id);
        return;
      }
      cancelEnding();
      if (deck.playing) {
        cancelRequest(); // pause owns playback even if a selection is still decoding
        cancelTransition();
        transitions.cancel();
      }
      deck.toggle();
      changed();
    },

    // Plays the song after the current one, wrapping to the top.
    next() {
      if (!items.length) return;
      queue.play(items[(stepIndex() + 1) % items.length].id);
    },

    // Like most players: restarts the song if it's a few seconds in, otherwise goes back one.
    previous() {
      const index = stepIndex();
      if (position() > restartThreshold || index <= 0) return queue.seek(0);
      queue.play(items[index - 1].id);
    },

    // Jumps to a point in the current song (seconds).
    seek(seconds) {
      if (embedActive() && Number.isFinite(seconds)) {
        cancelRequest();
        cancelTransition();
        embed.seekTo(Math.max(0, seconds));
        changed();
        return;
      }
      if (!deck.buffer || !Number.isFinite(seconds)) return;
      cancelEnding();
      cancelTransition();
      cancelRequest();
      transitions.cancel();
      const wasPlaying = deck.playing;
      if (wasPlaying) deck.pause();
      deck.offset = Math.max(0, Math.min(seconds, deck.buffer.duration - 0.05));
      if (wasPlaying) deck.play();
      changed();
    },

    // The song under the mouse gets decoded early, so clicking ▶ on it is quick.
    hover(id) {
      if (hoveredId === id) return;
      hoveredId = id;
      prefetch();
    },

    // Turns the AI DJ on: it fills the queue to match the vibe and moves on at the end of each song.
    // wait: pick songs but don't start playing; the page calls beginSet() when it's ready.
    startDj(vibe = "", { wait = false } = {}) {
      dj.on = true;
      dj.set = false;
      dj.vibe = vibe.trim();
      dj.generation += 1;
      dj.waitToStart = wait;
      setDjStatus(null);
      topUpDj();
    },

    // Resolves once the library has loaded (and checked which songs are in music/).
    async libraryReady() {
      await libraryReady;
      if (!library.length) {
        libraryReady = loadLibrary();
        await libraryReady;
      }
      // empty: the library file loaded but lists no songs (djStart.js says so instead of showing a load error).
      if (!library.length) throw Object.assign(new Error("The song library could not load. Check the local server and try again."), { empty: libraryLoaded });
    },

    // Resolves once the DJ's first song is picked and decoded, so it can start instantly
    // (rejects if it couldn't be loaded, say its download failed).
    async readyToStart() {
      // A cancelled set (dj off, or a newer set) must not leave this waiting for songs that never come.
      const token = setToken;
      const gone = () => token !== setToken || !dj.on;
      while (!items.length) {
        if (gone()) throw cancelError();
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (gone()) throw cancelError();
      if (!items[0].embed) await decode(items[0]);
    },

    // Starts the set the DJ prepared with startDj(vibe, { wait: true }).
    beginSet() {
      setPending = false;
      dj.waitToStart = false;
      deck.ensureContext();
      if (currentId === null && !transitioning && items.length) transitionTo(items[0]);
    },


    // AirMix: a set of library songs (ids, in order) your hands play through. The queue
    // becomes exactly that set and the mixes work as with the DJ, but nothing gets picked:
    // the set's lines are not spoken (AirMix stays quiet). A song not in music/ yet
    // downloads when it's needed (the first one right away, each next one while the one
    // before plays), as in the DJ Deck's default queue. Call beginSet() to play it.
    async playSet(ids) {
      cancelEnding();
      cancelTransition();
      const request = ++playRequest; // invalidate old loads before waiting for the library
      const token = ++setToken; // ...and the old set's downloads
      abortSetDownloads();
      setPending = true;
      await queue.libraryReady();
      if (request !== playRequest) return;
      transitions.cancel();
      stopEmbed();
      deck.stopSource();
      currentId = null;
      requestedId = null;
      Object.assign(dj, { on: true, set: true, vibe: "", busy: false, waitToStart: true, status: null });
      dj.generation += 1;
      const songs = ids.map((id) => library.find((song) => song.id === id)).filter((song) => song && !song.unavailable);
      items = [];
      songs.forEach((song, index) => {
        add(
          {
            title: `${song.artist} - ${song.title}`,
            detail: "AirMix set",
            libraryId: song.id,
            bpm: song.bpm,
            genre: song.genre,
            defaultLibrary: true, // decode() downloads it if it isn't in music/
            inSet: true,
            setToken: token,
            url: song.available ? song.file : null,
            dj: { intro: setLine(song, songs[index - 1]), reason: null, browserVoice: false },
          },
          { autoplay: false },
        );
      });
      prefetch();
    },

    // Leaving a set before it starts (New set): its pending downloads stop polling and their
    // results are ignored, nothing gets marked failed or reported, and the set can't begin.
    // The server may finish the downloads (that warms the cache). Does nothing once it has begun.
    cancelSet() {
      if (!setPending) return false;
      setPending = false;
      setToken += 1;
      playRequest += 1;
      abortSetDownloads();
      cancelTransition();
      stopEmbed();
      deck.stopSource();
      Object.assign(dj, { on: false, set: false, busy: false, waitToStart: false, status: null });
      dj.generation += 1;
      items = [];
      currentId = null;
      requestedId = null;
      loadingId = null;
      decoded.clear();
      ready.clear();
      loadFailed.clear();
      status = null;
      changed();
      return true;
    },

    // Ends a set: the last song fades out, muffling as it goes, then stops (the queue
    // keeps the set). Resolves once it's quiet.
    async endSet(ms = 3000) {
      cancelTransition();
      cancelRequest();
      const request = playRequest;
      endingRequest = request;
      dj.generation += 1;
      dj.on = false;
      dj.set = false;
      if (deck.filter) deck.filter.frequency.setTargetAtTime(300, deck.ctx.currentTime, ms / 3000);
      await fadeTo(0, ms, () => request === playRequest);
      if (request !== playRequest) return false;
      endingRequest = null;
      transitions.cancel();
      stopEmbed();
      deck.stopSource();
      currentId = null;
      requestedId = null;
      duck(1);
      if (deck.filter) deck.filter.frequency.setTargetAtTime(20000, deck.ctx.currentTime, 0.05);
      changed();
      return true;
    },

    // Whether a queued song is downloaded and decoded, ready to play or mix into at once.
    isReady(id) {
      return ready.has(id);
    },
    // Whether a queued song's download or decoding failed.
    loadFailed(id) {
      return loadFailed.has(id);
    },

    stopDj() {
      dj.on = false;
      dj.set = false;
      dj.generation += 1;
      dj.busy = false;
      setDjStatus(null);
    },

    // Short mixes on or off (see dj.short).
    setShortMixes(on) {
      dj.short = Boolean(on);
      changed();
    },

    // Mixes into the next song right away, on the next downbeat (the coach uses it).
    // Returns whether there was a song to mix into.
    mixNow() {
      if (embedMix) {
        landEmbedMix(); // a second press lands the blend
        return true;
      }
      if (transitioning) return false;
      const next = upcoming()[0] ?? items[0];
      if (!next || next.id === currentId) return false;
      if (embedMixable(next)) {
        transitionTo(next); // a timed crossfade (8 s, or the short mixes' 4 s)
      } else if (!deck.playing || !deck.buffer || next.embed) {
        deck.ensureContext();
        queue.play(next.id);
      } else {
        transitionTo(next, { mixOutAt: 0 });
      }
      return true;
    },

    // A coach calls this every frame it runs: the DJ then leaves the timing of mixes to it.
    coachPing() {
      coachSeen = performance.now();
    },

    // Starts a mix the hands perform, and resolves with its live controls (see
    // transitions.mixInto's hands option), or with null when there's nothing to mix.
    // With no startAt or style (the DJ Deck): any next song comes in immediately.
    // startAt: the downbeat (song seconds) it starts on, beat-matched (AirMix);
    // style: "blend" or "cut" to insist on one.
    startHandMix({ startAt = null, style = null } = {}) {
      const next = upcoming()[0] ?? items[0];
      if (!blendable(next)) return Promise.resolve(null);
      return new Promise((resolve) => {
        const started = (controls) => {
          if (handMixStarted === started) handMixStarted = null;
          handMix = controls ?? null;
          resolve(controls ?? null);
        };
        handMixStarted = started;
        transitionTo(next, { mixOutAt: 0, startAt, style, hands: true }).finally(() => {
          if (handMixStarted === started) started(null);
        });
      });
    },

    // Holds the master volume and speed where they are (while the hands perform a mix), or lets go.
    // Which of the hands' controls hold still: { speed, volume, filter } (true = held).
    // Speed is held at 1.00×.
    holdControls(options = {}) {
      // DJ Deck holds the user's current speed; AirMix's object options reset it to 1×.
      const manual = typeof options === "boolean";
      const { speed = false, volume = false, filter = false } = manual ? { speed: options, volume: options } : options;
      if (speed && !speedHeld && !manual) transitions.resetSpeed();
      speedHeld = speed;
      volumeHeld = volume;
      frequencyHeld = filter;
      transitions.holdSpeed(speed);
    },

    // Normal sound: 80% volume, filter open, 1.00× (whatever the hands last set, say
    // hands together and a closed pinch while getting into position, is forgotten).
    resetSound() {
      handVolume = startingVolume;
      setDeckVolume(handVolume * duckLevel);
      setDeckFrequency(20000);
      transitions.resetSpeed();
    },

    // The songs to choose from for the next mix: the next few queued, each with the
    // DJ's reason and whether it can be blended by hand with what's playing (close
    // library tempos) rather than echoed out. The first is the DJ's own pick.
    getChoices() {
      const current = items.find((entry) => entry.id === currentId);
      return upcoming()
        .slice(0, choiceCount)
        .map((item) => {
          let blends = null;
          if (current?.bpm && item.bpm) {
            let ratio = current.bpm / item.bpm;
            while (ratio > Math.SQRT2) ratio /= 2;
            while (ratio < Math.SQRT1_2) ratio *= 2;
            blends = Math.abs(ratio - 1) <= blendTolerance;
          }
          return { item, reason: item.dj?.reason ?? null, blends };
        });
    },

    // Makes a queued song the next one (choosing it for the next mix).
    chooseNext(id) {
      const index = currentIndex();
      if (index === -1 || items[index + 1]?.id === id) return;
      queue.move(id, index + 1);
    },

    // What happens next, for an on-screen preview, or null when nothing's queued:
    // { item, mixing, talking, style ("blend" | "echo", once the next song is decoded),
    // and with the DJ on and playing: secondsToMix (until the AI would start the mix),
    // secondsToOut (until the current song should be mixed out by), secondsToDownbeat (the
    // next one on the beat grid the mix uses), beatSeconds, short }.
    getUpNext() {
      // While mixing (the AI's or the hands'), it's about the song coming in, and only that
      // song: if it was removed mid-mix, this is the normal state (the playing song is the one going out).
      // Once a hand mix has landed, the song coming in is the playing one.
      const incoming = embedMix
        ? items.find((entry) => entry.id === embedMix.id)
        : transitioning
        ? items.find((entry) => entry.id === transitionId)
        : handMix && !handMix.done
          ? items.find((entry) => entry.id === currentId)
          : undefined;
      const mixing = Boolean(incoming);
      const next = incoming ?? upcoming()[0];
      if (!next) return null;
      const current = items.find((entry) => entry.id === currentId);
      const preview = {
        item: next,
        mixing,
        talking: dj.talking,
        style: null,
        secondsToMix: null,
        secondsToOut: null,
        secondsToDownbeat: null,
        beatSeconds: null,
        short: dj.short,
      };
      if (embedActive()) {
        // A YouTube song: the AI DJ's crossfade starts as the video nears its end.
        const duration = embed.getDuration() || (validBeat(current?.beat) ? current.beat.duration : 0) || 0;
        const left = duration - embed.getTime();
        if (dj.on && !mixing && duration > 0) {
          preview.secondsToMix = Math.max(0, left - embedFadeSeconds() - embedLeadSeconds);
          preview.secondsToOut = Math.max(0, left);
        }
        return preview;
      }
      if (!deck.buffer || !deck.playing) return preview;
      const buffer = ready.get(next.id);
      if (buffer && !mixing) {
        preview.style = transitions.styleInto(buffer, {
          mixOutAt: transitions.mixOutPoint(deck.buffer, dj.short),
          fromBpm: current?.bpm,
          toBpm: next.bpm,
          short: dj.short,
        });
      }
      if (dj.on && !mixing) {
        const start = transitions.mixStartPoint(deck.buffer, dj.short, preview.style);
        preview.secondsToMix = Math.max(0, start - position()) / (deck.rate || 1);
        preview.secondsToOut = (transitions.mixOutPoint(deck.buffer, dj.short) - position()) / (deck.rate || 1);
        preview.beatSeconds = transitions.beatSeconds(deck.buffer, dj.short);
        const downbeat = transitions.nextDownbeat(deck.buffer, dj.short, position());
        preview.secondsToDownbeat = (downbeat - position()) / (deck.rate || 1);
      }
      return preview;
    },

    // New vibe: drops the DJ's not-yet-played picks and picks again.
    changeVibe(vibe) {
      dj.vibe = vibe.trim();
      dj.generation += 1;
      dj.busy = false;
      // Keeps the song the DJ is already introducing.
      const next = new Set(upcoming().filter((item) => item.dj && item.id !== transitionId).map((item) => item.id));
      items = items.filter((item) => !next.has(item.id));
      changed();
      topUpDj();
    },
  };
  let libraryReady = loadLibrary();
  return queue;
}

const styles = `
/* Matches the page's card style and uses its theme variables (--panel, --border,
   --text, --muted, --bg, --left, --between), so it follows any later restyle. */
.queuePanel {
  position: fixed; top: 64px; right: 16px; z-index: 50;
  display: flex; flex-direction: column; gap: 10px;
  width: min(440px, calc(100vw - 32px)); max-height: calc(100vh - 80px); overflow-y: auto;
  padding: 14px 16px; border-radius: 12px;
  background: var(--panel); color: var(--text);
  border: 1px solid var(--border); box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);
}
.queuePanel[hidden] { display: none; }
.queuePanel button { padding: 5px 12px; font-size: 13px; flex: none; white-space: nowrap; }
.queuePanel .queuePanel-close { width: 30px; height: 30px; padding: 0; }
.queuePanel-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.queuePanel-header h2 { margin: 0; font-size: 16px; font-weight: 600; }
.queuePanel-header p { margin: 2px 0 0; font-size: 12px; color: var(--muted); }
.queuePanel-add, .queuePanel-dj { display: flex; gap: 6px; align-items: center; }
.queuePanel-add input[type="text"], .queuePanel-dj input[type="text"] {
  flex: 1; min-width: 0; padding: 7px 10px; font: inherit; font-size: 13px;
  color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
}
.queuePanel-add input[type="file"] { display: none; }
.queuePanel-dj { padding: 8px; border-radius: 10px; border: 1px dashed var(--border); }
.queuePanel-dj.on { border: 1px solid var(--between); }
.upNext {
  position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 2;
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  width: min(560px, calc(100% - 24px)); pointer-events: none;
}
.upNext-strip, .upNext-toast {
  border-radius: 14px; background: var(--bg); color: var(--text); border: 1px solid var(--border);
  box-shadow: 0 6px 20px rgba(0, 0, 0, .18);
}
.upNext-strip { width: 100%; padding: 8px 14px; display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
.upNext-strip[hidden], .upNext-toast[hidden] { display: none; }
.upNext-line { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.upNext-line strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.upNext-label { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; color: #8a4510; white-space: nowrap; } /* text: a darker orange (AA); --between is for bars and borders */
.upNext-genre { font-size: 11px; padding: 1px 7px; border-radius: 9px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
.upNext-when { font-weight: 700; white-space: nowrap; }
.upNext-slot { width: 100%; }
.upNext-toast { padding: 8px 16px; font-size: 15px; font-weight: 800; }
.queuePanel-djOption { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--muted); cursor: pointer; }
.queuePanel-djLabel { font-size: 12px; font-weight: 700; color: #8a4510; white-space: nowrap; }
.queuePanel-status { margin: 0; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.queuePanel-status.error { color: #b00020; } /* 7:1 on the cream panel (WCAG AA needs 4.5:1) */
.queuePanel-list, .queuePanel-downloads {
  margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px;
}
.queuePanel-downloads:empty { display: none; }
.queuePanel-row {
  position: relative; display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 10px; cursor: grab; user-select: none; -webkit-user-select: none;
  background: var(--bg); border: 1px solid var(--border);
}
.queuePanel-row.fromDj::before {
  content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px; border-radius: 3px; background: var(--between);
}
.queuePanel-row.current { border-color: var(--between); }
.queuePanel-row.dragging { opacity: 0.55; }
.queuePanel-row:focus-visible { outline: 2px solid var(--between); outline-offset: 1px; }
.queuePanel-row.dropBefore { box-shadow: inset 0 3px 0 var(--between); }
.queuePanel-row.dropAfter { box-shadow: inset 0 -3px 0 var(--between); }
.queuePanel-row.download { cursor: default; flex-wrap: wrap; border-style: dashed; }
.queuePanel-row.download.failed { border-color: #ff7b7b; }
.queuePanel-row.download .queuePanel-bar { flex-basis: 100%; }
.queuePanel-handle {
  color: var(--muted); letter-spacing: -2px; user-select: none; cursor: grab;
  touch-action: none; /* a drag from the handle reorders; the rest of the row still scrolls the list */
  display: flex; align-items: center; justify-content: center; min-width: 28px; align-self: stretch; margin: -8px 0 -8px -4px;
}
.queuePanel-row.librarySong { cursor: default; }
.queuePanel-number { width: 18px; text-align: right; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.queuePanel-track { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.queuePanel-track strong { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.queuePanel-track small { font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.queuePanel-row.current small { color: #8a4510; font-weight: 600; }
.queuePanel-row.fromDj small::before { content: "✦ "; color: var(--between); }
.queuePanel-row.failed small { color: #b00020; }
.queuePanel-actions { display: flex; gap: 4px; }
.queuePanel-row .queuePanel-actions button { width: 30px; height: 30px; padding: 0; }
.queuePanel-empty { margin: 0; padding: 10px 0; font-size: 13px; text-align: center; color: var(--muted); }
.queuePanel-library { border: 1px solid var(--border); border-radius: 10px; padding: 6px 8px; }
.queuePanel-library summary {
  display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; font-weight: 600; list-style: none;
}
.queuePanel-library summary::-webkit-details-marker { display: none; }
.queuePanel-library summary::before { content: "▸"; color: var(--muted); }
.queuePanel-library[open] summary::before { content: "▾"; }
.queuePanel-library summary span { flex: 1; }
.queuePanel-library .queuePanel-list { margin-top: 6px; }
.queuePanel-group { list-style: none; margin: 6px 0 0; padding: 0 2px; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #8a4510; }
.queuePanel-credits { border-top: 1px solid var(--border); padding-top: 8px; font-size: 12px; }
.queuePanel-credits summary { cursor: pointer; font-weight: 600; }
.queuePanel-credits ul { margin: 6px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
.queuePanel-credits a { color: inherit; }
.queuePanel-row.librarySong { cursor: default; }
.queuePanel-row.unavailable { background: rgba(120,130,138,.14); }
.queuePanel-row.unavailable strong, .queuePanel-row.unavailable small { color: #4f5b63; text-decoration: none; } /* grey, still 4.5:1 on the glass */
.queuePanel-row.unavailable button { opacity: .5; cursor: not-allowed; }
.queuePanel-row.missing small { color: #7a3f08; } /* a dark orange: --between is about 2.5:1 on cream, and #94500f misses AA on the glass */
.queuePanel-embed { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--border); }
.queuePanel-embed[hidden] { display: none; }
.queuePanel-embed input[type="text"] {
  flex: 1; min-width: 0; padding: 7px 10px; font: inherit; font-size: 13px;
  color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
}
.queuePanel-embedLabel { font-size: 12px; font-weight: 600; color: var(--muted); }
.queuePanel-embed .queuePanel-add { flex-wrap: wrap; }
.queuePanel-embed a { font-size: 12px; color: #0a4f8a; text-decoration: underline; }
.queuePanel-beta { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--border); }
.queuePanel-betaLabel { font-size: 12px; font-weight: 600; color: var(--muted); }
.queuePanel-betaLabel b { color: #8a4510; }

/* Progress bars: downloads, loading, and the player's song position. */
.queuePanel-bar { position: relative; height: 5px; border-radius: 3px; overflow: hidden; background: var(--border); }
.queuePanel-bar > span {
  position: absolute; inset: 0 auto 0 0; width: 0; border-radius: 3px; background: var(--left); transition: width 0.3s;
}
.queuePanel-bar.fromDj > span { background: var(--between); }
.queuePanel-bar.busy > span { width: 35% !important; animation: queuePanel-sweep 1.1s ease-in-out infinite; transition: none; }
@keyframes queuePanel-sweep { from { left: -35%; } to { left: 100%; } }

/* Player: song title, progress bar, times, and ⏮ ⏯ ⏭ */
.queueTransport { display: flex; flex-direction: column; gap: 6px; }
.queueTransport-title { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.queueTransport-seek { position: relative; height: 16px; cursor: pointer; touch-action: none; }
.queueTransport-seek .queuePanel-bar { position: absolute; left: 0; right: 0; top: 5px; height: 6px; }
.queueTransport-seek .queuePanel-bar > span { transition: none; }
.queueTransport-thumb {
  position: absolute; top: 2px; width: 12px; height: 12px; margin-left: -6px; border-radius: 50%;
  background: var(--text); pointer-events: none;
}
.queueTransport-times { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.queueTransport-buttons { display: flex; justify-content: center; gap: 10px; }
.queueTransport-buttons button { width: 38px; height: 38px; padding: 0; font-size: 15px; flex: none; }
.queueTransport-buttons .queueTransport-play { width: 44px; height: 44px; font-size: 17px; }
`;

function element(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function addStyles() {
  if (!document.getElementById("queuePanel-styles")) {
    document.head.append(element("style", { id: "queuePanel-styles", text: styles }));
  }
}

const formatTime = (seconds) => {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

// A progress bar: percent 0–100, or null for "busy" (an animated sweep).
function progressBar(percent, { fromDj = false } = {}) {
  const fill = element("span");
  if (percent !== null) fill.style.width = `${percent}%`;
  return element("div", { className: ["queuePanel-bar", percent === null && "busy", fromDj && "fromDj"].filter(Boolean).join(" ") }, [fill]);
}

// Player bar: what's playing, a progress bar you can click or drag to seek, the
// times, and ⏮ (restart / previous) ⏯ ⏭. Returns the element to put on the page.
export function createTransport(queue, deck, { onNext = () => queue.next() } = {}) {
  addStyles();
  const title = element("div", { className: "queueTransport-title", text: "No song loaded" });
  const fill = element("span");
  const bar = element("div", { className: "queuePanel-bar" }, [fill]);
  const thumb = element("div", { className: "queueTransport-thumb" });
  const seek = element(
    "div",
    {
      className: "queueTransport-seek",
      role: "slider",
      tabindex: "0",
      "aria-label": "Song position",
      "aria-valuemin": "0",
      "aria-valuemax": "0",
      "aria-valuenow": "0",
      "aria-valuetext": "0:00",
    },
    [bar, thumb],
  );
  const elapsed = element("span", { text: "0:00" });
  const total = element("span", { text: "0:00" });
  const playButton = element("button", { type: "button", className: "queueTransport-play", "aria-label": "Play or pause", text: "▶" });
  const root = element("div", { className: "queueTransport" }, [
    title,
    seek,
    element("div", { className: "queueTransport-times" }, [elapsed, total]),
    element("div", { className: "queueTransport-buttons" }, [
      element("button", {
        type: "button",
        className: "secondary",
        "aria-label": "Restart or previous song",
        title: "Restart (or previous song if near the start)",
        text: "⏮",
        onClick: () => {
          deck.ensureContext();
          queue.previous();
        },
      }),
      playButton,
      element("button", {
        type: "button",
        className: "secondary",
        "aria-label": "Next song",
        title: "Next song",
        text: "⏭",
        onClick: () => {
          deck.ensureContext();
          onNext();
        },
      }),
    ]),
  ]);
  playButton.addEventListener("click", () => {
    deck.ensureContext();
    queue.togglePlay();
  });

  // Click or drag on the bar to seek; while dragging, the bar follows the pointer.
  let dragRatio = null;
  const ratioAt = (event) => {
    const rect = seek.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  };
  seek.addEventListener("pointerdown", (event) => {
    if (!queue.getPlayback().loaded) return;
    try {
      seek.setPointerCapture(event.pointerId); // keep getting moves while dragging outside the bar
    } catch {
      // Capture is a nicety; clicking still seeks without it.
    }
    dragRatio = ratioAt(event);
  });
  seek.addEventListener("pointermove", (event) => {
    if (dragRatio === null) return;
    // Only while dragging: pointer captured, or a button still held.
    let dragging = event.buttons !== 0;
    try {
      dragging = dragging || seek.hasPointerCapture(event.pointerId);
    } catch {
      // No capture support: fall back to buttons.
    }
    dragRatio = dragging ? ratioAt(event) : null;
  });
  const endDrag = () => { dragRatio = null; };
  seek.addEventListener("pointercancel", endDrag);
  seek.addEventListener("lostpointercapture", endDrag);
  seek.addEventListener("pointerup", (event) => {
    if (dragRatio === null) return;
    const ratio = ratioAt(event);
    dragRatio = null;
    queue.seek(ratio * queue.getPlayback().duration);
  });
  // Arrow keys seek by seekStepSeconds (the slider is focusable).
  seek.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const { loaded, position } = queue.getPlayback();
    if (!loaded) return;
    event.preventDefault();
    deck.ensureContext();
    queue.seek(position + (event.key === "ArrowRight" ? seekStepSeconds : -seekStepSeconds));
  });

  function update() {
    const { items, currentId, loadingId } = queue.getState();
    const playback = queue.getPlayback();
    const loading = items.find((item) => item.id === loadingId);
    const current = items.find((item) => item.id === currentId);
    title.textContent = loading ? `Loading ${loading.title}…` : current?.title ?? (playback.loaded ? "Now playing" : "No song loaded");
    bar.classList.toggle("busy", Boolean(loading));
    const ratio = dragRatio ?? (playback.duration ? playback.position / playback.duration : 0);
    fill.style.width = `${ratio * 100}%`;
    thumb.style.left = `${ratio * 100}%`;
    thumb.hidden = !playback.loaded || Boolean(loading);
    const seconds = ratio * playback.duration;
    elapsed.textContent = formatTime(seconds);
    total.textContent = formatTime(playback.duration);
    seek.setAttribute("aria-valuemax", String(Math.round(playback.duration)));
    seek.setAttribute("aria-valuenow", String(Math.round(seconds)));
    seek.setAttribute("aria-valuetext", `${formatTime(seconds)} of ${formatTime(playback.duration)}`);
    playButton.textContent = playback.playing ? "⏸" : "▶";
    // Stops once the bar is off the page (the embedded panel takes its own out at once).
    // Callers attach the bar as they create it.
    if (root.isConnected) requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
  return root;
}

// A strip for the camera view: the next song, when and how the DJ mixes into it
// (blend or echo out). flash(text) shows a message above it for a moment, and `slot`
// holds extras above it. Positioned absolutely: put it in a relative container.
export function createUpNext(queue) {
  addStyles();
  const title = element("strong");
  const genre = element("span", { className: "upNext-genre" });
  const when = element("span", { className: "upNext-when" });
  const toast = element("div", { className: "upNext-toast", hidden: "" });
  const strip = element("div", { className: "upNext-strip" }, [
    element("div", { className: "upNext-line" }, [element("span", { className: "upNext-label", text: "Up next" }), title, genre]),
    element("div", { className: "upNext-line" }, [when]),
  ]);
  const slot = element("div", { className: "upNext-slot" }); // for extras above the strip
  const root = element("div", { className: "upNext" }, [toast, slot, strip]);
  let toastTimer = null;
  let statusOverride = null; // setStatus(): something else says what's happening

  function update() {
    const next = queue.getUpNext();
    strip.hidden = !next;
    if (!next) return;
    title.textContent = next.item.title;
    genre.textContent = next.item.genre ?? "";
    genre.hidden = !next.item.genre;
    const style = { blend: "Blend", echo: "Echo out" }[next.style] ?? "Mix";
    when.textContent = statusOverride
      ? statusOverride
      : next.mixing
      ? "🎚 Mixing…"
      : next.talking
        ? "🎙 DJ on the mic"
        : next.secondsToMix !== null
          ? `${style} in ${formatTime(next.secondsToMix)}`
          : "Next in the queue";
  }
  setInterval(update, 250);
  update();

  return {
    element: root,
    slot,
    setStatus(text) {
      statusOverride = text || null;
    },
    flash(message) {
      toast.textContent = message;
      toast.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (toast.hidden = true), 2200);
    },
  };
}

// Floating panel for a queue: the player, add (YouTube link, song name or file),
// downloads with progress, drag to reorder, ✕ to remove, ▶ to play, and the AI DJ.
// Uses the page's CSS variables for colors.
export function createQueuePanel(queue, deck, { embedded = false } = {}) {
  addStyles();
  let draggedId = null;
  let dropIndex = null; // insertion point, 0..items.length
  let rowsKey = ""; // the rows are only rebuilt when this changes, not on every progress tick
  let hoverTimer = null;

  const input = element("input", { type: "text", placeholder: "YouTube link or song name", "aria-label": "YouTube link or song name" });
  const libraryList = element("ol", { className: "queuePanel-list", "aria-label": "Song library" });
  const libraryCount = element("span", { text: "Library" });
  let libraryKey = "";
  let hostedSite = false; // the hosted site: library songs may be YouTube embeds (no effects) or hosted audio
  const creditsList = element("ul", { "aria-label": "Music credits" });
  const credits = element("details", { className: "queuePanel-credits", hidden: "" }, [element("summary", { text: "Music credits" }), creditsList]);
  let youtube = true; // false on the hosted site (see loadConfig): no YouTube box, no downloads
  // The hosted site's YouTube links: played in YouTube's own embedded player (see ytEmbed.js).
  const embedInput = element("input", { type: "text", placeholder: "https://www.youtube.com/watch?v=…", "aria-label": "Paste a YouTube link" });
  const embedBlock = element("div", { className: "queuePanel-embed", hidden: "" }, [
    element("span", { className: "queuePanel-embedLabel", text: "Paste a YouTube link" }),
    element("div", { className: "queuePanel-add" }, [
      embedInput,
      element("button", { type: "button", text: "Add", onClick: addEmbedFromInput }),
    ]),
    element("a", { href: "https://www.youtube.com", target: "_blank", rel: "noopener", text: "Search on YouTube" }),
  ]);
  const fileInput = element("input", { type: "file", accept: "audio/*,video/mp4" });
  const addButton = element("button", { type: "button", text: "Add", onClick: addFromInput });
  const status = element("p", { className: "queuePanel-status", role: "status", "aria-live": "polite", hidden: "" });
  const vibeInput = element("input", { type: "text", placeholder: "DJ vibe, e.g. chill house into hype EDM", "aria-label": "DJ vibe" });
  const djButtons = element("span", { className: "queuePanel-actions" });
  const djRow = element("div", { className: "queuePanel-dj" }, [
    element("span", { className: "queuePanel-djLabel", text: "AI DJ" }),
    vibeInput,
    djButtons,
  ]);
  const djStatus = element("p", { className: "queuePanel-status", role: "status", "aria-live": "polite", hidden: "" });
  const shortToggle = element("input", {
    type: "checkbox",
    onChange: () => queue.setShortMixes(shortToggle.checked),
  });
  const djOptions = element("label", { className: "queuePanel-djOption" }, [
    shortToggle,
    "Short mixes (about 20 s a song, from its best part: for demos)",
  ]);
  const downloadsList = element("ol", { className: "queuePanel-downloads", "aria-label": "Downloading" });
  const list = element("ol", { className: "queuePanel-list" });
  const empty = element("p", { className: "queuePanel-empty", text: "The queue is empty. Add songs from the library, or start the AI DJ." });

  function addFromInput() {
    deck.ensureContext(); // inside the click, so the browser allows sound
    queue.addYouTube(input.value);
    input.value = "";
  }
  input.addEventListener("keydown", (event) => event.key === "Enter" && addFromInput());
  function addEmbedFromInput() {
    deck.ensureContext(); // inside the click, so YouTube's player may start with sound
    if (queue.addYouTubeEmbed(embedInput.value)) embedInput.value = "";
  }
  embedInput.addEventListener("keydown", (event) => event.key === "Enter" && addEmbedFromInput());

  // Start (or, with the DJ on, change the vibe). Inside the click so the DJ's first song can play.
  function startOrChangeVibe() {
    deck.ensureContext();
    if (queue.getState().dj.on) queue.changeVibe(vibeInput.value);
    else queue.startDj(vibeInput.value);
  }
  vibeInput.addEventListener("keydown", (event) => event.key === "Enter" && startOrChangeVibe());
  const startButton = element("button", { type: "button", text: "Start", onClick: startOrChangeVibe });
  const stopButton = element("button", { type: "button", className: "secondary", text: "Stop", onClick: () => queue.stopDj() });
  fileInput.addEventListener("change", () => {
    queue.addFile(fileInput.files[0]);
    fileInput.value = "";
  });
  list.addEventListener("pointerleave", () => {
    clearTimeout(hoverTimer);
    queue.hover(null);
  });

  const panel = element("section", { className: "queuePanel", role: "dialog", "aria-label": "Queue", hidden: "" }, [
    // A div, not <header>: pages often style every header element.
    element("div", { className: "queuePanel-header" }, [
      element("div", {}, [
        element("h2", { text: "Queue" }),
        element("p", { text: "Pick songs from the library or let the AI DJ choose. Drag to reorder." }),
      ]),
      element("button", {
        type: "button",
        className: "secondary queuePanel-close",
        "aria-label": "Close queue",
        text: "✕",
        onClick: () => controls.close(),
      }),
    ]),
    createTransport(queue, deck),
    djRow,
    djOptions,
    djStatus,
    element("details", { className: "queuePanel-library", open: "" }, [
      element("summary", {}, [
        libraryCount,
        element("button", {
          type: "button",
          className: "secondary",
          text: "Add all",
          onClick: (event) => {
            event.preventDefault(); // don't fold the section
            deck.ensureContext();
            queue.addAllFromLibrary();
          },
        }),
      ]),
      libraryList,
    ]),
    credits,
    list,
    empty,
    status,
    embedBlock,
    // The beta alternative: any song from YouTube (slow), or a file.
    element("div", { className: "queuePanel-beta" }, [
      element("span", { className: "queuePanel-betaLabel" }),
      element("div", { className: "queuePanel-add" }, [
        input,
        addButton,
        element("button", {
          type: "button",
          className: "secondary",
          text: "File",
          onClick: () => {
            deck.ensureContext();
            fileInput.click();
          },
        }),
        fileInput,
      ]),
    ]),
    downloadsList,
  ]);
  // "Beta" label with its warning (built here because it mixes bold and plain text).
  const betaLabel = panel.querySelector(".queuePanel-betaLabel");
  betaLabel.append(element("b", { text: "Beta: " }), "any song from YouTube. Downloads can take 10–30 seconds.");
  // Without YouTube (the hosted site) only "add a file" stays.
  loadConfig().then((config) => {
    youtube = config.youtube;
    embedBlock.hidden = !(config.youtubeEmbed && queue.supportsEmbed);
    hostedSite = config.hosted && config.youtubeEmbed;
    render(); // short mixes cut decoded audio: shown again once audio items exist (see render)
    if (youtube) return;
    input.hidden = true;
    addButton.hidden = true;
    betaLabel.textContent = "Add an audio file from your computer.";
    render();
  });
  if (embedded) {
    panel.classList.add("queuePanel-embedded");
    panel.setAttribute("role", "region");
    panel.hidden = false;
    panel.querySelector(".queuePanel-close").remove();
    panel.querySelector(".queueTransport").remove();
    panel.querySelector(".queuePanel-header p").textContent = "Your songs · drag to reorder";
    const library = panel.querySelector(".queuePanel-library");
    library.open = true;
    // Keep the playlist directly below its heading, with optional tools below it.
    panel.querySelector(".queuePanel-header").after(list, empty, status);
    const tools = element("details", { className: "queuePanel-tools" }, [
      element("summary", { text: "AI DJ & import" }),
      element("div", { className: "queuePanel-toolsBody" }, [djRow, djOptions, djStatus, panel.querySelector(".queuePanel-beta")]),
    ]);
    library.after(embedBlock, tools);
    tools.after(credits);
  }
  document.body.append(panel);

  function setDropIndex(index) {
    dropIndex = index;
    const rows = [...list.children];
    rows.forEach((row, position) => {
      row.classList.toggle("dropBefore", index === position);
      row.classList.toggle("dropAfter", index === rows.length && position === rows.length - 1);
    });
  }

  // Shows where the dragged row would land for the pointer's height.
  function updateDrag(event) {
    const mids = [...list.children].map((child) => {
      const rect = child.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
    setDropIndex(dropIndexAt(mids, event.clientY));
  }

  function drop() {
    const items = queue.getState().items; // live: the rendered list may be stale by drop time
    const movedId = draggedId;
    const target = dropIndex;
    // End the drag first, so the list redraws when the move fires a change.
    draggedId = null;
    setDropIndex(null);
    if (movedId === null || target === null) return;
    const from = items.findIndex((item) => item.id === movedId);
    if (from === -1) return; // removed meanwhile
    // Taking the row out first shifts everything after it up by one.
    queue.move(movedId, moveTarget(from, target));
  }

  function row(item, index, state) {
    const isCurrent = item.id === state.currentId;
    const isLoading = item.id === state.loadingId;
    const classes = ["queuePanel-row", isCurrent && "current", item.dj && "fromDj", item.failed && "failed"].filter(Boolean).join(" ");
    const handle = element("span", { className: "queuePanel-handle", title: "Drag to reorder", "aria-hidden": "true", text: "⋮⋮" });
    const entry = element("li", { className: classes, tabindex: "0", "aria-label": `${index + 1} of ${state.items.length}: ${item.title}`, "data-id": String(item.id), "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown" }, [
      handle,
      element("span", { className: "queuePanel-number", text: String(index + 1) }),
      element("div", { className: "queuePanel-track" }, [
        element("strong", { text: item.title }),
        element("small", { text: isLoading ? "Loading…" : item.failed ? `Can't play: ${item.failed}` : isCurrent ? "Now playing" : item.detail }),
        ...(isLoading ? [progressBar(null)] : []),
      ]),
      element("div", { className: "queuePanel-actions" }, [
        element("button", {
          type: "button",
          title: "Play this song",
          "aria-label": `Play ${item.title}`,
          text: "▶",
          onClick: () => {
            deck.ensureContext();
            queue.play(item.id);
          },
        }),
        element("button", {
          type: "button",
          className: "secondary",
          title: "Remove from the queue",
          "aria-label": `Remove ${item.title}`,
          text: "✕",
          onClick: () => queue.remove(item.id),
        }),
      ]),
    ]);
    // Hovering a song for a moment decodes it ahead of a click.
    entry.addEventListener("pointerenter", () => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => queue.hover(item.id), hoverDecodeMs);
    });
    // Reordering with pointer events, so touch works: drag the ⋮⋮ handle (it doesn't scroll the
    // list), or, with a mouse, anywhere on the row except its buttons. Alt+↑/↓ on a focused row
    // moves it too.
    let press = null; // { id, x, y } until the drag starts (mouse rows wait for a few pixels of movement)
    const startDrag = (event) => {
      draggedId = item.id;
      entry.classList.add("dragging");
      try { entry.setPointerCapture(event.pointerId); } catch { /* the synthetic or ended pointer */ }
      updateDrag(event);
    };
    const endDrag = (commit) => {
      press = null;
      entry.classList.remove("dragging");
      if (draggedId === null) return;
      if (commit) {
        drop();
      } else {
        draggedId = null;
        setDropIndex(null);
        rowsKey = ""; // redraw anything that changed meanwhile
        render();
      }
    };
    entry.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button")) return;
      const onHandle = event.target.closest(".queuePanel-handle");
      if (!onHandle && event.pointerType !== "mouse") return;
      press = { x: event.clientX, y: event.clientY };
      if (onHandle) startDrag(event);
    });
    entry.addEventListener("pointermove", (event) => {
      if (draggedId === item.id) return void updateDrag(event);
      if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) startDrag(event);
    });
    entry.addEventListener("pointerup", () => endDrag(true));
    entry.addEventListener("pointercancel", () => endDrag(false));
    entry.addEventListener("keydown", (event) => {
      if (!event.altKey || event.target !== entry || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      event.preventDefault();
      const position = state.items.findIndex((candidate) => candidate.id === item.id) + (event.key === "ArrowUp" ? -1 : 1);
      if (position < 0 || position >= state.items.length) return;
      queue.move(item.id, position);
      list.querySelector(`[data-id="${item.id}"]`)?.focus(); // the rows were rebuilt
    });
    return entry;
  }

  // A library song: name and artist, ▶ to play it now, + to add it to the queue.
  function libraryRow(song) {
    const missing = song.available === false;
    const gone = song.unavailable === true; // hosted: YouTube no longer plays this video in an embed
    return element("li", { className: `queuePanel-row librarySong ${missing ? "missing" : ""} ${gone ? "unavailable" : ""}`.trim(), ...(gone ? { "aria-disabled": "true" } : {}) }, [
      element("div", { className: "queuePanel-track" }, [
        element("strong", { text: song.title }),
        element("small", {
          text: [song.artist, song.bpm && `${song.bpm} BPM`, gone ? "Not available on YouTube" : missing && (youtube ? "not in music/ yet (run prefetch.py)" : "not available")]
            .filter(Boolean)
            .join(" · "),
        }),
      ]),
      element("div", { className: "queuePanel-actions" }, [
        element("button", {
          type: "button",
          title: "Play now",
          "aria-label": `Play ${song.title} now`,
          text: "▶",
          ...(gone ? { disabled: "" } : {}),
          onClick: () => {
            deck.ensureContext();
            queue.addFromLibrary(song.id, { playNow: true });
          },
        }),
        element("button", {
          type: "button",
          className: "secondary",
          title: "Add to the queue",
          "aria-label": `Add ${song.title} to the queue`,
          text: "+",
          ...(gone ? { disabled: "" } : {}),
          onClick: () => {
            deck.ensureContext();
            queue.addFromLibrary(song.id);
          },
        }),
      ]),
    ]);
  }

  // A song on its way: name, where it's at, and a progress bar.
  function downloadRow(download) {
    const stageText =
      download.stage === "failed"
        ? `Failed: ${download.error}`
        : download.stage === "downloading" && download.percent !== null
          ? `Downloading ${Math.round(download.percent)}%`
          : "Searching YouTube…";
    const classes = ["queuePanel-row", "download", download.fromDj && "fromDj", download.stage === "failed" && "failed"];
    return element("li", { className: classes.filter(Boolean).join(" ") }, [
      element("div", { className: "queuePanel-track" }, [
        element("strong", { text: download.title }),
        element("small", { text: download.fromDj ? `AI DJ · ${stageText}` : stageText }),
      ]),
      // A failed download has no bar: a full one would look like a success.
      ...(download.stage === "failed"
        ? []
        : [progressBar(download.stage === "downloading" ? (download.percent ?? 0) : null, { fromDj: download.fromDj })]),
    ]);
  }

  function render() {
    const state = queue.getState();
    // Song rows: only rebuilt when something about them changed, so buttons
    // don't get replaced mid-click while downloads tick.
    const key = JSON.stringify([state.items.map((item) => [item.id, item.title, item.detail, item.failed ?? null]), state.currentId, state.loadingId]);
    if (draggedId === null && key !== rowsKey) {
      rowsKey = key;
      list.replaceChildren(...state.items.map((item, index) => row(item, index, state)));
    }
    empty.hidden = state.items.length > 0 || state.downloads.length > 0;
    const newLibraryKey = JSON.stringify([youtube, state.libraryLoaded, state.library.map((song) => [song.id, song.available, song.unavailable === true, song.hosted === true, song.attribution ?? null])]);
    if (newLibraryKey !== libraryKey) {
      libraryKey = newLibraryKey;
      // Two kinds on the hosted site: tracks with audio (effects work) first, then the YouTube songs (no effects).
      const groups = state.library.some((song) => song.hosted === true);
      const rows = [];
      state.library.forEach((song, index) => {
        if (groups && (index === 0 || (song.hosted === true) !== (state.library[index - 1].hosted === true))) {
          rows.push(element("li", { className: "queuePanel-group", "aria-hidden": "true", text: song.hosted === true ? "Full effects" : "YouTube · no effects" }));
        }
        rows.push(libraryRow(song));
      });
      libraryList.replaceChildren(
        ...(state.library.length || !state.libraryLoaded
          ? rows
          : [element("li", { className: "queuePanel-empty", text: EMPTY_LIBRARY_MESSAGE })]),
      );
      // The licence (CC BY) asks for the credit: every library song that carries one.
      const credited = state.library.filter((song) => typeof song.attribution === "string" && song.attribution.trim());
      credits.hidden = credited.length === 0;
      creditsList.replaceChildren(...credited.map((song) => {
        const link = typeof song.licenseUrl === "string" && /^https?:\/\//.test(song.licenseUrl) && song.license;
        return element("li", {}, [
          song.attribution,
          ...(link ? [" · ", element("a", { href: song.licenseUrl, target: "_blank", rel: "noopener noreferrer", text: song.license })] : song.license ? [` · ${song.license}`] : []),
        ]);
      }));
      libraryCount.textContent = `Library · ${state.library.length} songs`;
    }
    downloadsList.replaceChildren(...state.downloads.map(downloadRow));
    status.hidden = !state.status;
    status.textContent = state.status?.message ?? "";
    status.classList.toggle("error", Boolean(state.status?.isError));

    // Short mixes cut decoded audio: hidden on the hosted site only while nothing there is audio.
    djOptions.style.display = hostedSite && !state.library.some((song) => song.hosted === true) && !state.items.some((item) => !item.embed) ? "none" : "";

    const { dj } = state;
    djRow.classList.toggle("on", dj.on);
    startButton.textContent = dj.on ? "Change vibe" : "Start";
    djButtons.replaceChildren(...(dj.on ? [startButton, stopButton] : [startButton]));
    const djDownloads = state.downloads.filter((download) => download.fromDj && download.stage !== "failed").length;
    const djMessage = dj.talking
      ? "🎙 The DJ is on the mic…"
      : djDownloads
        ? `The DJ is getting ${djDownloads} song${djDownloads > 1 ? "s" : ""} ready (below)…`
        : (dj.status?.message ??
          (dj.on
            ? dj.short
              ? "DJ on: about 20 s a song. With the camera on, follow the moves on screen to do the mixes."
              : "DJ on: it mixes as each song ends. With the camera on, follow the moves on screen to do the mixes."
            : ""));
    shortToggle.checked = dj.short;
    djStatus.hidden = !djMessage;
    djStatus.textContent = djMessage;
    djStatus.classList.toggle("error", Boolean(dj.status?.isError));
  }

  queue.on(render);
  render();
  window.addEventListener("keydown", (event) => {
    if (!embedded && event.key === "Escape" && !panel.hidden) controls.close();
  });

  const controls = {
    element: panel,
    get isOpen() {
      return !panel.hidden;
    },
    open() {
      panel.hidden = false;
    },
    close() {
      if (embedded) return;
      panel.hidden = true;
    },
    toggle() {
      if (embedded) { panel.scrollIntoView({ block: "nearest" }); return; }
      panel.hidden = !panel.hidden;
    },
    // Opens the panel with the AI DJ's vibe box ready to type in.
    openDj() {
      panel.hidden = false;
      if (embedded) panel.querySelector(".queuePanel-tools").open = true;
      djRow.scrollIntoView({ block: "nearest" });
      vibeInput.focus();
    },
  };
  // A click anywhere outside the panel closes it. The page's own Queue button toggles
  // it instead: mark that button with data-queue-toggle.
  document.addEventListener("pointerdown", (event) => {
    if (panel.hidden || panel.contains(event.target) || event.target.closest?.("[data-queue-toggle]")) return;
    controls.close();
  });
  return controls;
}
