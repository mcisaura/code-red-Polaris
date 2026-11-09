// Song queue for the Deck in audio.js. The main source is the song library
// (library.json, played from music/<id>.m4a, instant); YouTube links or song
// names (downloaded by server.py, slow) and files are a beta alternative.
// Reorder, remove, play, seek, and skip back and forth. An AI DJ can fill it for
// you: Gemini picks library songs that fit a vibe and what's playing, and a voice
// (ElevenLabs, or the browser's) introduces each one. Plus a floating panel and a
// player bar for all of that.
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

const djSongsAhead = 3; // the DJ keeps this many songs queued after the current one (the choices)
const choiceCount = 3; // songs offered to choose from for the next mix
const blendTolerance = 0.08; // library tempos this close (or half/double) can be blended by hand
const djPicksPerRequest = 3;
const duckedVolume = 0.5; // the music's level while the DJ talks over a transition
const duckFadeMs = 600;
const voiceTimeoutMs = 15000; // never let a stuck voice line stall the set
const voiceWaitMs = 4000; // longest wait for the ElevenLabs clip before using the browser's voice
const restartThreshold = 3; // ⏮ restarts the song if it's past this many seconds, else goes back one
const progressPollMs = 400;
const hoverDecodeMs = 250; // hovering a song this long starts decoding it
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

export function createQueue(deck, { apiBase = "/api", libraryUrl = "library.json" } = {}) {
  // Items: { id, title, detail, url } for YouTube, { id, title, detail, file } for files.
  // DJ picks also carry dj: { intro, voice }, voice being the ElevenLabs clip once it's asked for.
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
  async function downloadYouTube(text, { title = text, detail = "YouTube", fromDj = false } = {}) {
    const job = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const entry = { key: job, title, detail, fromDj, stage: "searching", percent: null, error: null };
    downloads = [...downloads, entry];
    changed();
    const poll = setInterval(async () => {
      try {
        const state = await (await fetch(`${apiBase}/progress?job=${job}`)).json();
        if (state.stage !== "unknown" && entry.stage !== "failed") {
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
      const result = await postJson("/youtube", { url: text, job });
      clearInterval(poll);
      removeEntry();
      return result;
    } catch (error) {
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
    if (autoplay && currentId === null && !playsPending) queue.play(entry.id);
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
    if (volumeHeld) return;
    handVolume = volume;
    setDeckVolume(volume * duckLevel);
  };
  function duck(level) {
    duckLevel = level;
    setDeckVolume(handVolume * duckLevel);
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
  let loadingId = null; // the song being loaded right now, kept even if it moves out of the window
  let hoveredId = null;

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
          item.url = (await libraryEntry(song, "Default library")).url;
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
        if (decoded.get(item.id) === promise) ready.set(item.id, buffer);
        return buffer;
      });
      promise.catch(() => {
        // A superseded decode failing late must not delete the newer one or mark the song failed.
        if (decoded.get(item.id) !== promise) return;
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
    wanted.filter((item) => !loadFailed.has(item.id)).forEach(decode);
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
  let playChain = Promise.resolve();

  // mix: false, or { mixOutAt } to mix into the song (see transitions.mixInto).
  // entry: start where the song gets going (short mixes) instead of at 0.
  function playItem(id, { mix = false, entry = false } = {}) {
    cancelEnding();
    const request = ++playRequest;
    requestedId = id;
    playsPending += 1;
    playChain = playChain
      .then(() => (request === playRequest ? loadAndPlay(id, { mix, entry, request }) : undefined))
      .finally(() => (playsPending -= 1));
    return playChain;
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
    duck(1);
  }

  // ---- library ---------------------------------------------------------------------

  async function loadLibrary() {
    try {
      const response = await fetch(libraryUrl);
      if (!response.ok) return;
      const { songs = [] } = await response.json();
      library = songs.map((song) => ({ ...song, file: `music/${song.id}.m4a`, available: null }));
      changed();
      // Which songs are actually in music/ (prefetch.py fills it).
      await Promise.all(
        library.map(async (song) => {
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

  // A queue item for a library song: straight from music/, or downloaded first
  // if it isn't there yet (run prefetch.py so that never happens on stage).
  async function libraryEntry(song, detail) {
    const title = `${song.artist} - ${song.title}`;
    const facts = { libraryId: song.id, bpm: song.bpm, genre: song.genre };
    if (song.available !== false) return { title, detail, url: song.file, ...facts };
    const download = await downloadYouTube(`https://www.youtube.com/watch?v=${song.id}`, {
      title,
      detail: "Not in music/ yet (run prefetch.py), downloading",
    });
    return { title, detail, url: download.file, ...facts };
  }

  // ---- AI DJ ----------------------------------------------------------------------

  // An AirMix set's DJ line for a song (spoken as it comes in, if the genre changed).
  function setLine(song, previous) {
    const name = `${song.title} by ${song.artist}`;
    if (!previous) return `Welcome to AirMix! Hands up. First up: ${name}.`;
    const genre = (song.genre ?? "").split("/")[0].trim();
    return genre ? `Switching it up, ${genre} time: ${name}!` : `Next up: ${name}!`;
  }

  // The ElevenLabs clip's URL for a DJ line, or null to fall back to the browser's voice.
  async function prepareVoice(text) {
    try {
      return (await postJson("/dj/voice", { text })).file;
    } catch (error) {
      console.warn("DJ voice unavailable, using the browser voice:", error.message);
      return null;
    }
  }

  // Only asked for once the line will be spoken (it costs ElevenLabs credits).
  function voiceFor(item) {
    item.dj.voice ??= prepareVoice(item.dj.intro);
    return item.dj.voice;
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

  // Whether a line will actually be heard: lines without the browser voice to fall back
  // on (an AirMix set's) need their ElevenLabs clip, so the music isn't ducked for nothing.
  async function canSpeak(item) {
    if (item.dj?.browserVoice !== false) return true;
    const late = new Promise((resolve) => setTimeout(() => resolve(null), voiceWaitMs));
    return Boolean(await Promise.race([voiceFor(item), late]));
  }

  // Plays a DJ line and resolves when it's done (or after a timeout).
  async function speak(item, stillWanted = () => true) {
    const intro = item.dj?.intro;
    if (!intro) return;
    // The clip is normally ready (asked for while the song before played); never wait long for it.
    const late = new Promise((resolve) => setTimeout(() => resolve(null), voiceWaitMs));
    const voiceUrl = await Promise.race([voiceFor(item), late]);
    if (!stillWanted()) return;
    return new Promise((resolve) => {
      let audio = null, line = null, finished = false;
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
        audio?.pause();
        if (stopVoice === cancel) stopVoice = null;
        resolve();
      }
      if (voiceUrl) {
        audio = new Audio(voiceUrl);
        audio.onended = done;
        audio.onerror = done;
        audio.play().catch(done);
      } else if (item.dj.browserVoice !== false && "speechSynthesis" in window) {
        line = new SpeechSynthesisUtterance(intro);
        line.onend = done;
        line.onerror = done;
        speechSynthesis.speak(line);
      } else {
        done();
      }
    });
  }

  // The DJ mixes into the next song (transitions.js) and introduces it over the mix,
  // with the music turned down. With nothing playing, it introduces the song first.
  // One at a time.
  async function transitionTo(item, { mixOutAt, startAt = null, style = null, hands = false } = {}) {
    const mine = ++transitionRun;
    const ownsTransition = () => mine === transitionRun;
    transitioning = true;
    transitionId = item.id;
    try {
      const mixing = deck.playing && deck.buffer;
      const talks = djSpeaksBefore(item, mixing ? items.find((entry) => entry.id === currentId) : null);
      // Mix in from the playing song, or (nothing playing) just start, at the song's
      // entry with short mixes. Either way the DJ talks over the music, not before it.
      await playItem(item.id, mixing ? { mix: { mixOutAt, startAt, style, hands } } : { entry: dj.short });
      if (!ownsTransition() || currentId !== item.id) return;
      if (talks && (await canSpeak(item))) {
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
      // With a library, the DJ only picks from it (instant, nothing to download).
      // Without one it can pick any song, downloaded from YouTube (the slow beta path).
      const useLibrary = library.length > 0;
      const { picks, offline } = await postJson("/dj/pick", {
        vibe: dj.vibe,
        nowPlaying: current?.title ?? "",
        queued: items.map((item) => item.title),
        crowd: dj.crowd,
        played,
        count: djPicksPerRequest,
        ...(useLibrary && { library: library.map(({ id, artist, title, bpm, genre }) => ({ id, artist, title, bpm, genre })) }),
      });
      // Every pick gets ready (and gets its voice line) at the same time; they join
      // the queue in pick order.
      setDjStatus(`Getting ${picks.length} songs ready…`);
      const jobs = picks.map((pick) => {
        const label = `${pick.artist} - ${pick.title}`;
        const detail = `AI DJ · ${pick.reason}`;
        const librarySong = useLibrary && library.find((song) => song.id === pick.id);
        const song = librarySong
          ? libraryEntry(librarySong, detail)
          : downloadYouTube(label, { title: label, detail, fromDj: true }).then((download) => ({ title: label, detail, url: download.file }));
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
            dj: { intro: pick.intro, voice: null, reason: pick.reason },
          },
          { autoplay: false },
        );
        added += 1;
        // Nothing playing yet: start the set (unless the page starts it, after a countdown).
        if (currentId === null && !transitioning && !dj.waitToStart) transitionTo(entry);
      }
      if (stillValid() && !added) throw new Error("none of the picks could be loaded");
      // Gemini was unreachable: the server picked the closest library songs instead.
      const why = offline?.includes("GEMINI_API_KEY") ? "no Gemini key" : offline;
      setDjStatus(offline ? `AI offline (${why}): picking from the library by genre and tempo.` : null);
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
    if (!dj.on || transitioning || !deck.playing || !deck.buffer) return;
    const next = upcoming()[0];
    if (!next) return;
    if (djSpeaksBefore(next, items.find((entry) => entry.id === currentId))) voiceFor(next);
    if (!coached() && position() >= transitions.mixPoint(deck.buffer, dj.short)) {
      transitionTo(next, { mixOutAt: transitions.mixOutPoint(deck.buffer, dj.short) });
    }
  }, 200);

  // mix: blend or echo into the song from the playing one (the DJ), instead of switching.
  async function loadAndPlay(id, { mix = false, entry = false, request } = {}) {
    const item = items.find((entry) => entry.id === id);
    if (!item) return;
    loadingId = id;
    changed();
    try {
      const buffer = await decode(item);
      // A newer selection may arrive while decoding. Never start a superseded song.
      if (request !== playRequest || !items.some((entry) => entry.id === id)) return;
      deck.ensureContext();
      if (mix && deck.playing) {
        loadingId = null;
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
      if (loadingId === id) loadingId = null;
      changed();
    }
  }

  // Where the current song is, in seconds (0 when nothing is loaded).
  function position() {
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
      status,
      dj: { on: dj.on, set: dj.set, vibe: dj.vibe, busy: dj.busy, talking: dj.talking, status: dj.status, short: dj.short },
    }),

    // Fast-changing playback state for progress bars; read it every frame.
    getPlayback: () => ({
      position: position(),
      duration: deck.buffer?.duration ?? 0,
      playing: Boolean(deck.playing),
      loaded: Boolean(deck.buffer),
      rate: deck.rate || 1, // song seconds per real second
      songId: currentId,
    }),

    // The playing song's beat grid ({ bpm, first downbeat }, song seconds) around a point
    // in it, and how loud it is there (1 = its typical level). For djGame.js's charts.
    beatGridAt: (seconds) => (deck.buffer ? transitions.beatGridAt(deck.buffer, seconds) : null),
    energyAt: (seconds) => (deck.buffer ? transitions.energyAt(deck.buffer, seconds) : 1),

    // Where (song seconds) the DJ mixes the playing song out by, or null with the DJ off.
    mixOutAt: () => (dj.on && deck.buffer ? transitions.mixOutPoint(deck.buffer, dj.short) : null),

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

    addFile(file) {
      if (!file) return;
      add({ title: file.name.replace(/\.[^.]+$/, ""), detail: "File", file });
    },

    // Adds a library song (by its id), instantly from music/. playNow plays it right away.
    // autoplay: false only queues it (it still gets decoded ahead, if it's up next).
    async addFromLibrary(id, { playNow = false, autoplay = true } = {}) {
      const song = library.find((entry) => entry.id === id);
      if (!song) return;
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
        if (!items.length) {
          if (!library.length) throw new Error("The default song library could not be loaded");
          for (const song of library) add({
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
      for (const song of library) await queue.addFromLibrary(song.id);
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
      if (currentId === id) currentId = null;
      changed();
      topUpDj();
    },

    play(id) {
      cancelTransition();
      return playItem(id);
    },

    togglePlay() {
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
      if (!deck.buffer) return;
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
      if (!library.length) throw new Error("The song library could not load. Check the local server and try again.");
    },

    // Resolves once the DJ's first song is picked and decoded, so it can start instantly
    // (rejects if it couldn't be loaded, say its download failed).
    async readyToStart() {
      while (!items.length) await new Promise((resolve) => setTimeout(resolve, 200));
      await decode(items[0]);
    },

    // Starts the set the DJ prepared with startDj(vibe, { wait: true }).
    beginSet() {
      dj.waitToStart = false;
      deck.ensureContext();
      if (currentId === null && !transitioning && items.length) transitionTo(items[0]);
    },


    // AirMix: a set of library songs (ids, in order) your hands play through. The queue
    // becomes exactly that set and the mixes work as with the DJ, but nothing gets picked:
    // the AI only talks (ElevenLabs, if there's a key; otherwise it stays quiet) as the set
    // starts and when the genre changes. A song not in music/ yet downloads when it's
    // needed (the first one right away, each next one while the one before plays), as in
    // the DJ Deck's default queue. Call beginSet() to play it.
    async playSet(ids) {
      cancelEnding();
      cancelTransition();
      const request = ++playRequest; // invalidate old loads before waiting for the library
      await queue.libraryReady();
      if (request !== playRequest) return;
      transitions.cancel();
      deck.stopSource();
      currentId = null;
      requestedId = null;
      Object.assign(dj, { on: true, set: true, vibe: "", busy: false, waitToStart: true, status: null });
      dj.generation += 1;
      const songs = ids.map((id) => library.find((song) => song.id === id)).filter(Boolean);
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
            url: song.available ? song.file : null,
            dj: { intro: setLine(song, songs[index - 1]), voice: null, reason: null, browserVoice: false },
          },
          { autoplay: false },
        );
      });
      prefetch();
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

    // Says a line in the DJ's voice (ElevenLabs only; quiet without a key).
    say(text) {
      return speak({ dj: { intro: text, voice: null, browserVoice: false } });
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
      if (transitioning) return false;
      const next = upcoming()[0] ?? items[0];
      if (!next || next.id === currentId) return false;
      if (!deck.playing || !deck.buffer) {
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
      if (transitioning || !next || next.id === currentId || !deck.playing || !deck.buffer) return Promise.resolve(null);
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
      const incoming = transitioning
        ? items.find((entry) => entry.id === transitionId)
        : handMix && !handMix.done
          ? items.find((entry) => entry.id === currentId)
          : undefined;
      const mixing = Boolean(incoming);
      const next = incoming ?? upcoming()[0];
      if (!next) return null;
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
      if (!deck.buffer || !deck.playing) return preview;
      const current = items.find((entry) => entry.id === currentId);
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
  position: relative; display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 10px; cursor: grab;
  background: var(--bg); border: 1px solid var(--border);
}
.queuePanel-row.fromDj::before {
  content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px; border-radius: 3px; background: var(--between);
}
.queuePanel-row.current { border-color: var(--between); }
.queuePanel-row.dragging { opacity: 0.35; }
.queuePanel-row.dropBefore { box-shadow: inset 0 3px 0 var(--between); }
.queuePanel-row.dropAfter { box-shadow: inset 0 -3px 0 var(--between); }
.queuePanel-row.download { cursor: default; flex-wrap: wrap; border-style: dashed; }
.queuePanel-row.download.failed { border-color: #ff7b7b; }
.queuePanel-row.download .queuePanel-bar { flex-basis: 100%; }
.queuePanel-handle { color: var(--muted); letter-spacing: -2px; user-select: none; }
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
.queuePanel-row.librarySong { cursor: default; }
.queuePanel-row.missing small { color: #7a3f08; } /* a dark orange: --between is about 2.5:1 on cream, and #94500f misses AA on the glass */
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
    if (dragRatio !== null) dragRatio = ratioAt(event);
  });
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
  const fileInput = element("input", { type: "file", accept: "audio/*,video/mp4" });
  const status = element("p", { className: "queuePanel-status", hidden: "" });
  const vibeInput = element("input", { type: "text", placeholder: "DJ vibe, e.g. chill house into hype EDM", "aria-label": "DJ vibe" });
  const djButtons = element("span", { className: "queuePanel-actions" });
  const djRow = element("div", { className: "queuePanel-dj" }, [
    element("span", { className: "queuePanel-djLabel", text: "AI DJ" }),
    vibeInput,
    djButtons,
  ]);
  const djStatus = element("p", { className: "queuePanel-status", hidden: "" });
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
  list.addEventListener("dragleave", (event) => {
    if (!list.contains(event.relatedTarget)) setDropIndex(null);
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
    list,
    empty,
    status,
    // The beta alternative: any song from YouTube (slow), or a file.
    element("div", { className: "queuePanel-beta" }, [
      element("span", { className: "queuePanel-betaLabel" }),
      element("div", { className: "queuePanel-add" }, [
        input,
        element("button", { type: "button", text: "Add", onClick: addFromInput }),
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
    library.after(tools);
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

  function drop(items) {
    const movedId = draggedId;
    const target = dropIndex;
    // End the drag first, so the list redraws when the move fires a change.
    draggedId = null;
    setDropIndex(null);
    if (movedId === null || target === null) return;
    const from = items.findIndex((item) => item.id === movedId);
    // Taking the row out first shifts everything after it up by one.
    queue.move(movedId, target > from ? target - 1 : target);
  }

  function row(item, index, state) {
    const isCurrent = item.id === state.currentId;
    const isLoading = item.id === state.loadingId;
    const classes = ["queuePanel-row", isCurrent && "current", item.dj && "fromDj"].filter(Boolean).join(" ");
    const entry = element("li", { className: classes, draggable: "true" }, [
      element("span", { className: "queuePanel-handle", "aria-hidden": "true", text: "⋮⋮" }),
      element("span", { className: "queuePanel-number", text: String(index + 1) }),
      element("div", { className: "queuePanel-track" }, [
        element("strong", { text: item.title }),
        element("small", { text: isLoading ? "Loading…" : isCurrent ? "Now playing" : item.detail }),
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
    entry.addEventListener("dragstart", (event) => {
      draggedId = item.id;
      entry.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(item.id));
    });
    entry.addEventListener("dragover", (event) => {
      event.preventDefault();
      const rect = entry.getBoundingClientRect();
      setDropIndex(event.clientY < rect.top + rect.height / 2 ? index : index + 1);
    });
    entry.addEventListener("drop", (event) => {
      event.preventDefault();
      drop(state.items);
    });
    entry.addEventListener("dragend", () => {
      entry.classList.remove("dragging");
      // Dropped outside the list (or cancelled): redraw anything that changed meanwhile.
      if (draggedId !== null) {
        draggedId = null;
        setDropIndex(null);
        rowsKey = "";
        render();
      }
    });
    return entry;
  }

  // A library song: name and artist, ▶ to play it now, + to add it to the queue.
  function libraryRow(song) {
    const missing = song.available === false;
    return element("li", { className: `queuePanel-row librarySong ${missing ? "missing" : ""}` }, [
      element("div", { className: "queuePanel-track" }, [
        element("strong", { text: song.title }),
        element("small", {
          text: [song.artist, song.bpm && `${song.bpm} BPM`, missing && "not in music/ yet (run prefetch.py)"]
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
    const key = JSON.stringify([state.items.map((item) => item.id), state.currentId, state.loadingId]);
    if (draggedId === null && key !== rowsKey) {
      rowsKey = key;
      list.replaceChildren(...state.items.map((item, index) => row(item, index, state)));
    }
    empty.hidden = state.items.length > 0 || state.downloads.length > 0;
    const newLibraryKey = JSON.stringify(state.library.map((song) => [song.id, song.available]));
    if (newLibraryKey !== libraryKey) {
      libraryKey = newLibraryKey;
      libraryList.replaceChildren(...state.library.map(libraryRow));
      libraryCount.textContent = `Library · ${state.library.length} songs`;
    }
    downloadsList.replaceChildren(...state.downloads.map(downloadRow));
    status.hidden = !state.status;
    status.textContent = state.status?.message ?? "";
    status.classList.toggle("error", Boolean(state.status?.isError));

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
