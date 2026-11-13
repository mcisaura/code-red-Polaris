// AirMix on the hosted site: the audio comes from YouTube's own embedded player (ytEmbed.js), not from
// Web Audio. Nothing is downloaded, proxied or decoded, and no API key is involved. This file gives
// the game (djGame.js) and the page (ai-dj.html) the same interface they get locally from
// queue.js + aiDeck.js, backed by ONE visible YouTube player:
//
//   const { deck, queue, warm } = createYtSession({ embed: createYtEmbed({ mount }) });
//
// What the embedded player cannot do, and what AirMix does instead:
//   - No samples, so no tempo or downbeat detection. The beat grid comes from library.json's optional
//     `beat: { bpm, first, duration }` (measured offline): a beat every 60/bpm seconds from `first`, and
//     `first` is where the bars start. Without it, the grid is the integer bpm from 0:00. Energy is
//     constant.
//   - No blends, but two players (ytEmbed.js's `second` and `swap`): the next video is loaded muted in
//     the second player ahead of the mix and cued at its `beat.first`; at the mix it starts, a short
//     volume crossfade runs and the players swap, so there is no quiet gap. If the second player is
//     missing (an older stub) or fails, the mix is a cut: the old song fades out, the next video loads.
//   - No filter, effects or waveform (`queue.hasEffects` is false: the game charts no filter shapes and
//     does not judge the pinch's openness).
//   - Volume works (the hands' volume and the quick fades); speed is held at 1.00x during a set.
//   - The song clock is YouTube's getCurrentTime, which updates a few times a second, so it is
//     smoothed between polls with performance.now() (createClock).
//   - Browsers block playback without a user gesture: the first video AND the second song's (in the
//     second player) are loaded muted inside the Play click, then paused; begin() only un-pauses the first.

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const DEFAULT_BPM = 100;
const FADE_MS = 200; // the old song's quick fade before a cut
const START_VOLUME = 0.8; // the deck's starting volume (aiDeck.js)
const STALL_MS = 700; // the song time has not moved this long: the player is buffering
const BLOCKED_MS = 3000; // the set began but nothing plays this long: probably blocked autoplay
const PRIME_TICKS = 100; // x100 ms: how long the first video may take to load
const PLAY_TICKS = 100; // x100 ms: how long a next video may take to start
const XFADE_STEPS = 4; // the crossfade into a preloaded song: 4 steps ...
const XFADE_MS = 400; // ... over 0.4 s
const START_TICKS = 40; // x50 ms: how long the preloaded video may take to start moving at the mix
const BLOCKED_HINT = "Press play in the YouTube card to start the music.";

// A beat every 60/bpm seconds from 0:00 (no downbeat detection is possible on an embed).
export function syntheticGrid(bpm) {
  return { bpm: Number.isFinite(bpm) && bpm > 0 ? bpm : DEFAULT_BPM, first: 0 };
}

// library.json's `beat` field, cleaned: { bpm, first, duration } with only valid numbers, or undefined.
export function cleanBeat(beat) {
  if (!beat || !(Number.isFinite(beat.bpm) && beat.bpm > 0)) return undefined;
  return {
    bpm: beat.bpm,
    first: Number.isFinite(beat.first) && beat.first >= 0 ? beat.first : 0,
    duration: Number.isFinite(beat.duration) && beat.duration > 0 ? beat.duration : undefined,
  };
}

// The game's grid for a song item: the measured beat when the library has one, else the synthesised one.
export function beatGrid(item) {
  const beat = cleanBeat(item?.beat);
  return beat ? { bpm: beat.bpm, first: beat.first } : syntheticGrid(item?.bpm);
}

// Smooths YouTube's song time between its updates. embed.getTime() steps a few times a second; the
// clock keeps its own time with `now` (performance.now) and nudges it toward each new sample, so the
// notes (which are placed from this time) glide instead of stutter. A big jump (a seek, a new video)
// snaps. While the player is not playing, or the time has not moved for a moment (buffering), it
// returns the raw time and reports moving = false.
export function createClock(embed, now = () => performance.now()) {
  let anchor = { t: 0, at: 0 };
  let lastRaw = null;
  let changedAt = 0;
  let last = 0;
  let moving = false;
  const clock = {
    get moving() {
      return moving;
    },
    reset() {
      lastRaw = null;
      moving = false;
      last = 0;
    },
    read() {
      const at = now();
      const raw = embed.getTime();
      if (!embed.isPlaying()) {
        moving = false;
        lastRaw = raw;
        anchor = { t: raw, at };
        last = raw;
        return raw;
      }
      if (raw !== lastRaw) {
        const first = lastRaw === null || !moving;
        lastRaw = raw;
        changedAt = at;
        const predicted = anchor.t + (at - anchor.at) / 1000;
        const error = raw - predicted;
        if (first || Math.abs(error) > 0.3) {
          anchor = { t: raw, at };
          last = raw;
        } else {
          anchor = { t: predicted + error * 0.25, at };
        }
        moving = true;
      } else if (moving && at - changedAt > STALL_MS) {
        moving = false;
      }
      if (!moving) {
        anchor = { t: raw, at };
        last = raw;
        return raw;
      }
      last = Math.max(last, anchor.t + (at - anchor.at) / 1000);
      return last;
    },
  };
  return clock;
}

// The page's `deck`: what ai-dj.html and djGame.js touch, without Web Audio playback. It still has a
// real AudioContext (the game's tick/hit sounds are synthesised on it); pausing or resuming that
// context (the game's Pause) also pauses or resumes the video through onSuspend / onResume.
export function createYtDeck({ makeContext = () => new AudioContext() } = {}) {
  const deck = {
    ctx: null,
    rate: 1, // song seconds per second: the embed's speed stays at 1 during a set
    buffer: null,
    playing: false,
    onSuspend: null,
    onResume: null,
    ensureContext() {
      if (deck.ctx) return;
      const ctx = makeContext();
      const suspend = ctx.suspend?.bind(ctx);
      const resume = ctx.resume?.bind(ctx);
      ctx.suspend = () => {
        deck.onSuspend?.();
        return suspend?.();
      };
      ctx.resume = async () => {
        await resume?.();
        deck.onResume?.();
      };
      deck.ctx = ctx;
    },
    // The queue replaces setVolume; the rest have no effect on an embedded video.
    setVolume() {},
    setSpeed() {},
    setFrequency() {},
    stopSource() {},
    waveform: () => null,
  };
  return deck;
}

const cancelError = () => Object.assign(new Error("Set cancelled"), { cancelled: true });

// The queue the game plays through, for the hosted site. Same methods as queue.js's AirMix subset.
export function createYtQueue({
  embed,
  deck,
  apiBase = "/api",
  libraryUrl = "library.json",
  fetchFn = (...args) => fetch(...args),
  now = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timers = { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (id) => clearInterval(id) },
} = {}) {
  const clock = createClock(embed, now);
  const listeners = new Set();
  const failureListeners = new Set();
  let library = [];
  let libraryLoaded = false;
  let libraryPromise = null;
  let items = [];
  let currentId = null;
  let status = null;
  let dj = { on: false, set: false, short: false };
  let setRun = 0; // bumped when a set starts, is cancelled or ends
  let cutRun = 0; // bumped when a transition starts or is dropped
  let setPending = false;
  let started = false; // beginSet ran: the music is meant to play
  let startedAt = 0;
  let primed = false; // the first video is loaded and paused, ready for begin()
  let paused = false; // the game paused the audio context
  let transitioning = false;
  let transitionId = null;
  let scheduled = null; // { startAt, controls }: a cut the game asked for, at that song time
  let loadMs = 900; // how long the last video took to start: the next cut begins that much earlier
  let playMs = 300; // how long the preloaded video takes to start moving: a crossfade begins that much earlier
  let pre = null; // the next song in the second player: { itemId, ready, failed, promise }
  let preRun = 0; // bumped when the preload is dropped
  let crossing = false; // a crossfade is running (both players sound)
  let inLevel = 0; // how far the incoming song's volume has come up
  let playError = null;
  let hintShown = false;
  let pollTimer = null;
  let lastPosition = 0;
  let lastDuration = 0;
  let counter = 0;
  const checked = new Set(); // item ids YouTube's public oEmbed said are playable (or could not tell)
  const failed = new Set();

  // The hands' volume, and how far the quick fades have taken it down (the same split queue.js has).
  let handVolume = START_VOLUME;
  let duckLevel = 1;
  let volumeHeld = false;
  const secondOf = () => {
    const second = embed.second;
    return second && typeof second.load === "function" && typeof embed.swap === "function" ? second : null;
  };
  const applyVolume = () => {
    embed.setVolume(handVolume * duckLevel);
    if (crossing) secondOf()?.setVolume(handVolume * inLevel);
  };
  deck.setVolume = (volume) => {
    if (volumeHeld || !Number.isFinite(volume)) return;
    handVolume = volume;
    applyVolume();
  };
  deck.onSuspend = () => {
    if (!started) return;
    paused = true;
    embed.pause();
    if (crossing) secondOf()?.pause();
  };
  deck.onResume = () => {
    if (!paused) return;
    paused = false;
    if (started) embed.play();
    if (started && crossing) secondOf()?.play();
  };

  const changed = () => listeners.forEach((listener) => listener());
  const setStatus = (message, isError = false) => {
    status = message ? { message, isError } : null;
    changed();
  };
  const nameOf = (item) => (item ? item.title.split(" - ").slice(1).join(" - ") || item.title : "the song");
  const itemIndex = () => items.findIndex((item) => item.id === currentId);
  const upcoming = () => (currentId === null ? items.slice() : items.slice(itemIndex() + 1)).filter((item) => !failed.has(item.id));
  const current = () => items.find((item) => item.id === currentId) ?? null;

  const fail = (message) => {
    setStatus(message, true);
    failureListeners.forEach((listener) => listener(message));
  };

  embed.onError((message) => {
    playError = message;
    // The playing song itself can't be played: on to the next one, or the set is over.
    if (started && !transitioning && currentId !== null) {
      const item = current();
      if (item) failed.add(item.id);
      goNext(`Couldn't play ${nameOf(item)}: ${message}.`);
    }
  });
  // The preloaded song can't play: the mix falls back to a cut (which has its own failure handling).
  embed.second?.onError?.(() => {
    if (pre) pre.failed = true;
  });
  embed.onEnded(() => {
    // A video ended before the game's own mix-out: carry on with the next song, or end the set.
    if (started && !transitioning && currentId !== null) goNext("The song ended early.");
  });
  function goNext(reason) {
    if (upcoming().length) cutToNext(null);
    else fail(reason);
  }

  // YouTube's public oEmbed (through the Worker) says right away whether a video is gone, private or
  // not embeddable: that way such songs drop out of the set before they are needed. Anything else
  // (offline, a slow answer) counts as playable: the player itself has the last word.
  // One answer per video, kept for the page's life (the picker asks too): true = gone, false = fine,
  // null = could not tell (offline, a server error: not kept, and never counted as unavailable).
  const answers = new Map();
  function lookUp(videoId) {
    if (!answers.has(videoId)) {
      const answer = (async () => {
        try {
          const controller = typeof AbortController === "undefined" ? null : new AbortController();
          const timer = controller ? setTimeout(() => controller.abort(), 5000) : null;
          const response = await fetchFn(`${apiBase}/youtube/info?id=${encodeURIComponent(videoId)}`, controller ? { signal: controller.signal } : undefined);
          if (timer) clearTimeout(timer);
          if (response?.status === 404) return true;
          return response?.ok ? false : null;
        } catch {
          return null;
        }
      })();
      answers.set(videoId, answer);
      answer.then((value) => value === null && answers.get(videoId) === answer && answers.delete(videoId));
    }
    return answers.get(videoId);
  }
  const checks = new Map(); // item id -> its check (one request per song)
  const check = (item) => {
    if (!checks.has(item.id)) checks.set(item.id, runCheck(item));
    return checks.get(item.id);
  };
  async function runCheck(item) {
    // unknown (null): assume it plays; the player itself has the last word
    const reason = (await lookUp(item.videoId)) === true ? "the video was removed, is private, or can't be played in other sites" : null;
    if (reason) failed.add(item.id);
    checked.add(item.id);
    changed();
    return reason;
  }

  async function loadLibrary() {
    const response = await fetchFn(libraryUrl);
    if (!response?.ok) throw new Error("The song library could not load. Check your connection and try again.");
    const data = await response.json();
    const list = Array.isArray(data) ? data : data?.songs;
    if (!Array.isArray(list)) throw new Error("The song library could not load. Check your connection and try again.");
    library = list
      // A `hosted: true` song is real audio at music/<id>.m4a, not a video: it is listed (the picker groups it,
      // and the page plays it on the full engine) but this queue never plays or checks it.
      .filter((song) => song && typeof song.id === "string" && (song.hosted === true || VIDEO_ID.test(song.id)))
      .map((song) => ({
        id: song.id, artist: song.artist ?? "", title: song.title ?? song.id, bpm: song.bpm, genre: song.genre, beat: cleanBeat(song.beat), available: true,
        license: song.license, attribution: song.attribution, ...(song.hosted === true ? { hosted: true } : { videoId: song.id }),
      }));
    libraryLoaded = true;
  }

  // The playing song's length: the player's, or (while it reports 0) library.json's beat.duration.
  const durationOf = () => {
    const seconds = embed.getDuration();
    if (seconds > 0) return seconds;
    const fallback = current()?.beat?.duration;
    return fallback > 0 ? fallback : 0;
  };
  // Where a song starts when it comes in under a mix: its first beat anchor.
  const startOf = (item) => item?.beat?.first ?? 0;
  const nextItem = () => (currentId === null ? items.slice(1).filter((item) => !failed.has(item.id))[0] : upcoming()[0]);

  // Drops the preloaded song: the second player stops (and hides) and any crossfade is over.
  function dropPreload() {
    preRun += 1;
    pre = null;
    crossing = false;
    inLevel = 0;
    try {
      secondOf()?.stop();
    } catch {
      // the spare player is already gone
    }
  }

  // Loads the next song muted in the second player, then pauses it cued at its first beat. `early`: the
  // Play click (nothing has begun and the song has not been checked yet), where the second player must
  // be primed so later swaps may autoplay.
  function preloadNext(early = false) {
    const second = secondOf();
    if (!second || (!started && !early)) return;
    const next = nextItem();
    if (!next) {
      if (pre) dropPreload();
      return;
    }
    if (pre) {
      if (pre.itemId === next.id) return;
      dropPreload();
    }
    if (!early && !checked.has(next.id)) return;
    const info = { itemId: next.id, ready: false, failed: false, promise: null };
    pre = info;
    const mine = preRun;
    const dead = () => mine !== preRun;
    info.promise = (async () => {
      try {
        await second.load(next.videoId, { volume: 0, rate: 1 });
        for (let i = 0; i < PRIME_TICKS; i += 1) {
          if (dead() || info.failed) return;
          if (second.isPlaying() || (i > 40 && second.getDuration() > 0)) break;
          await sleep(100);
          if (i === PRIME_TICKS - 1) throw new Error("YouTube took too long to start this video");
        }
        if (dead()) return;
        second.pause();
        second.seekTo(startOf(next));
        info.ready = true;
      } catch {
        if (!dead()) info.failed = true;
      }
    })();
  }

  // The mix into the preloaded song: it starts at its first beat (silent), the volumes cross over a
  // moment, the old player stops and the players swap. "done", "cancelled", or "fallback" (a cut instead).
  async function crossfadeTo(next, run) {
    const second = secondOf();
    const info = pre;
    if (!second || !info || info.itemId !== next.id) return "fallback";
    await info.promise;
    if (run()) return "cancelled";
    if (!info.ready || info.failed) {
      dropPreload();
      return "fallback";
    }
    crossing = true;
    inLevel = 0;
    second.setVolume(0);
    const from = startOf(next);
    second.seekTo(from);
    const began = now();
    second.play();
    let moving = false;
    for (let i = 0; i < START_TICKS; i += 1) {
      if (run()) return "cancelled";
      if (info.failed) break;
      if (second.isPlaying() && second.getTime() > from + 0.03) {
        moving = true;
        break;
      }
      await sleep(50);
    }
    if (!moving) {
      dropPreload();
      return "fallback";
    }
    playMs = Math.max(100, Math.min(2000, (playMs + (now() - began)) / 2));
    for (let step = 1; step <= XFADE_STEPS; step += 1) {
      inLevel = step / XFADE_STEPS;
      duckLevel = 1 - inLevel;
      applyVolume();
      await sleep(XFADE_MS / XFADE_STEPS);
      if (run()) return "cancelled";
    }
    embed.stop(); // the old song's player stops and hides ...
    embed.swap(); // ... and the incoming one is the current player
    preRun += 1;
    pre = null;
    crossing = false;
    inLevel = 0;
    duckLevel = 1;
    applyVolume();
    return "done";
  }

  // Waits (polling) until the video that was just loaded is playing from its start, or fails.
  async function waitStarted(run, ticks) {
    for (let i = 0; i < ticks; i += 1) {
      if (run()) throw cancelError();
      if (playError) throw new Error(playError);
      if (embed.isPlaying() && embed.getDuration() > 0 && embed.getTime() < 5) return;
      await sleep(100);
    }
    throw new Error("YouTube took too long to start this video");
  }

  function startPolling() {
    if (pollTimer === null) pollTimer = timers.setInterval(poll, 200);
  }
  function stopPolling() {
    if (pollTimer !== null) timers.clearInterval(pollTimer);
    pollTimer = null;
  }

  // Runs on a timer and on every frame's playback read: starts a scheduled cut a little ahead of its
  // song time (the fade and the video's loading time), and notices a blocked first play.
  function poll() {
    if (!started || paused) return;
    if (!hintShown && currentId !== null && !embed.isPlaying() && !transitioning && now() - startedAt > BLOCKED_MS) {
      hintShown = true;
      setStatus(BLOCKED_HINT, true);
    }
    if (hintShown && embed.isPlaying() && status?.message === BLOCKED_HINT) {
      hintShown = false;
      setStatus(null);
    }
    if (!transitioning && embed.isPlaying()) preloadNext();
    if (scheduled && !transitioning && embed.isPlaying()) {
      const preloaded = pre && pre.ready && !pre.failed && pre.itemId === nextItem()?.id;
      const lead = preloaded ? playMs / 1000 : FADE_MS / 1000 + loadMs / 1000;
      if (clock.read() >= scheduled.startAt - lead) cutToNext(scheduled.controls);
    }
  }

  // The cut: the playing song fades out quickly, the next video loads and starts at 0:00.
  async function cutToNext(controls) {
    const mine = ++cutRun;
    const run = () => mine !== cutRun;
    transitioning = true;
    scheduled = null;
    lastPosition = clock.read();
    lastDuration = durationOf();
    try {
      const soon = upcoming()[0];
      if (soon && secondOf()) {
        transitionId = soon.id;
        const outcome = await crossfadeTo(soon, run);
        if (outcome === "cancelled") return;
        if (outcome === "done") {
          currentId = soon.id;
          clock.reset();
          transitioning = false;
          transitionId = null;
          status = null;
          if (controls) controls.done = true;
          changed();
          return;
        }
      }
      if (embed.isPlaying()) {
        for (let step = 1; step <= 4; step += 1) {
          duckLevel = 1 - step / 4;
          applyVolume();
          await sleep(FADE_MS / 4);
          if (run()) return;
        }
      }
      for (;;) {
        const next = upcoming()[0];
        if (!next) {
          transitioning = false;
          transitionId = null;
          embed.stop();
          fail("There are no more songs that can play.");
          return;
        }
        transitionId = next.id;
        const began = now();
        try {
          playError = null;
          await embed.load(next.videoId);
          if (run()) return;
          duckLevel = 1;
          applyVolume();
          await waitStarted(run, PLAY_TICKS);
        } catch (error) {
          if (run() || error?.cancelled) return;
          failed.add(next.id);
          items = items.filter((item) => item.id !== next.id);
          setStatus(`Couldn't play ${nameOf(next)}: ${error.message}.`, true);
          continue;
        }
        loadMs = Math.max(300, Math.min(3000, (loadMs + (now() - began)) / 2));
        currentId = next.id;
        clock.reset();
        transitioning = false;
        transitionId = null;
        status = null;
        if (controls) controls.done = true;
        changed();
        return;
      }
    } finally {
      if (!run() && controls && transitioning === false) controls.done = true;
    }
  }

  const queue = {
    getState: () => ({
      items,
      currentId,
      loadingId: null,
      downloads: [],
      library,
      libraryLoaded,
      status,
      dj: { on: dj.on, set: dj.set, vibe: "", busy: transitioning, talking: false, status: null, short: dj.short },
    }),

    // The playing song's time, smoothed; read every frame. Not "playing" while the player buffers.
    getPlayback() {
      if (currentId === null) return { position: 0, duration: 0, playing: false, loaded: false, rate: 1, songId: null };
      if (transitioning) return { position: lastPosition, duration: lastDuration, playing: false, loaded: true, rate: 1, songId: currentId };
      poll();
      const position = clock.read();
      const duration = durationOf();
      lastPosition = position;
      lastDuration = duration;
      return { position, duration, playing: embed.isPlaying() && clock.moving && duration > 0, loaded: duration > 0, rate: 1, songId: currentId };
    },

    // From library.json's `beat` (else the integer bpm from 0:00); null with nothing playing. Energy is constant.
    beatGridAt: () => (current() ? beatGrid(current()) : null),
    // The player has no filter or effects: the game charts no filter shapes and does not judge the pinch.
    hasEffects: false,
    energyAt: () => 1,
    // Where the DJ mixes the playing song out by: shortly before its end.
    mixOutAt() {
      const duration = durationOf();
      return dj.on && current() && duration > 0 ? Math.max(0, duration - 8) : null;
    },
    setCrowd() {},
    coachPing() {},
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Called with a message when the set can't go on (the playing song fails and nothing is left).
    onFailure(listener) {
      failureListeners.add(listener);
      return () => failureListeners.delete(listener);
    },

    async libraryReady() {
      libraryPromise ??= loadLibrary().catch((error) => {
        libraryPromise = null;
        throw error;
      });
      await libraryPromise;
      if (!library.length) throw Object.assign(new Error("The song library could not load. Check your connection and try again."), { empty: libraryLoaded });
    },

    async playSet(ids) {
      const run = ++setRun;
      cutRun += 1;
      setPending = true;
      started = false;
      primed = false;
      await queue.libraryReady();
      if (run !== setRun) return;
      embed.stop();
      dropPreload();
      stopPolling();
      scheduled = null;
      transitioning = false;
      currentId = null;
      playError = null;
      hintShown = false;
      paused = false;
      failed.clear();
      checked.clear();
      checks.clear();
      duckLevel = 1;
      dj = { on: true, set: true, short: false };
      items = ids
        .map((id) => library.find((song) => song.id === id))
        .filter(Boolean)
        .map((song, index) => ({
          id: `${song.id}:${index}`,
          title: `${song.artist} - ${song.title}`,
          detail: "AirMix set",
          libraryId: song.id,
          videoId: song.videoId,
          bpm: song.bpm,
          beat: song.beat,
          genre: song.genre,
          inSet: true,
        }));
      status = null;
      changed();
      // The songs after the first are checked in the background, one at a time.
      (async () => {
        for (const item of items.slice()) {
          if (run !== setRun) return;
          await check(item);
        }
      })();
    },

    // Resolves once the first video is ready to start; rejects (with a message) if YouTube won't play it.
    // This is called from the Play click, so the first video starts here (muted) while the browser
    // still counts a user gesture, and is paused again until begin().
    async readyToStart() {
      const run = setRun;
      const gone = () => run !== setRun || !dj.on;
      if (gone()) throw cancelError();
      const first = items[0];
      if (!first) throw new Error("There are no songs to play.");
      // The second song loads (muted) in the second player now, still inside the Play click, so the
      // browser lets that player autoplay at the mixes later.
      preloadNext(true);
      const reason = await check(first);
      if (gone()) throw cancelError();
      if (reason) throw new Error(`${nameOf(first)}: ${reason}`);
      playError = null;
      try {
        await embed.load(first.videoId);
        if (gone()) throw cancelError();
        embed.setVolume(0);
        for (let i = 0; i < PRIME_TICKS; i += 1) {
          if (gone()) throw cancelError();
          if (playError) throw new Error(playError);
          // Started (so the browser allowed it), or at least known: its length has loaded.
          if (embed.isPlaying() || (i > 40 && embed.getDuration() > 0)) break;
          await sleep(100);
          if (i === PRIME_TICKS - 1) throw new Error("YouTube took too long to start this video");
        }
        embed.pause();
        embed.seekTo(0);
      } catch (error) {
        if (error?.cancelled) throw error;
        embed.stop();
        dropPreload();
        throw error;
      }
      primed = true;
    },

    // The set starts: the primed video plays from 0:00.
    beginSet() {
      setPending = false;
      if (!items.length || started) return;
      started = true;
      startedAt = now();
      hintShown = false;
      currentId = items[0].id;
      clock.reset();
      transitioning = false;
      duckLevel = 1;
      startPolling();
      if (primed) {
        embed.seekTo(0);
        applyVolume();
        embed.play();
      } else {
        // The first video was not primed (it was dropped meanwhile): load it now.
        const run = setRun;
        embed.load(items[0].videoId).then(
          () => run === setRun && (applyVolume(), embed.play()),
          (error) => run === setRun && fail(error.message),
        );
      }
      changed();
    },

    cancelSet() {
      if (!setPending) return false;
      setPending = false;
      setRun += 1;
      cutRun += 1;
      embed.stop();
      dropPreload();
      stopPolling();
      dj = { on: false, set: false, short: false };
      items = [];
      currentId = null;
      scheduled = null;
      transitioning = false;
      started = false;
      primed = false;
      failed.clear();
      checked.clear();
      checks.clear();
      status = null;
      changed();
      return true;
    },

    // The last song fades out, then stops (and the YouTube card hides). false: a newer set started meanwhile.
    async endSet(ms = 3000) {
      const run = setRun;
      cutRun += 1;
      scheduled = null;
      transitioning = false;
      dj = { ...dj, on: false, set: false };
      dropPreload();
      const from = duckLevel;
      for (let step = 1; step <= 8; step += 1) {
        if (run !== setRun) return false;
        duckLevel = from + ((0 - from) * step) / 8;
        applyVolume();
        await sleep(ms / 8);
      }
      if (run !== setRun) return false;
      stopPolling();
      embed.stop();
      started = false;
      primed = false;
      paused = false;
      currentId = null;
      duckLevel = 1;
      changed();
      return true;
    },

    // For the picker: is this library song gone (removed, private, not embeddable)? Only a definite 404 says
    // yes; a network or server error does not. Answers are kept, one request per video.
    isUnavailable: async (videoId) => (await lookUp(videoId)) === true,
    isReady: (id) => checked.has(id) && !failed.has(id),
    loadFailed: (id) => failed.has(id),
    remove(id) {
      if (id === currentId) return;
      items = items.filter((item) => item.id !== id);
      changed();
    },

    // Cuts to the next song right away (the game uses it when a song has no room left for a mix).
    mixNow() {
      if (transitioning || !upcoming().length) return false;
      cutToNext(null);
      return true;
    },

    // Every mix is a cut for the game (no slides): the video player can't blend two songs, and the
    // second player only makes the cut a short crossfade.
    getChoices: () => upcoming().slice(0, 3).map((item) => ({ item, reason: null, blends: false })),
    getUpNext() {
      const next = transitioning ? items.find((item) => item.id === transitionId) : upcoming()[0];
      return next ? { item: next, mixing: transitioning, talking: false, style: "cut" } : null;
    },

    // The game asks for a cut at a song time; the controls it gets back are no-ops (nothing to blend or echo).
    startHandMix({ startAt = null } = {}) {
      if (transitioning || !started || !upcoming().length || !embed.isPlaying()) return Promise.resolve(null);
      const position = clock.read();
      const target = startAt ?? position;
      const grid = beatGrid(current());
      const controls = {
        style: "cut",
        startsIn: Math.max(0, target - position),
        barSeconds: 240 / grid.bpm,
        done: false,
        setIncoming() {},
        setOutgoing() {},
        swapBass() {},
        thinOutgoing() {},
        echoOut() {},
      };
      scheduled = { startAt: target, controls };
      return Promise.resolve(controls);
    },

    // The game holds the volume while a mix is performed (the hands slide); speed and filter do nothing here.
    holdControls(options = {}) {
      volumeHeld = typeof options === "boolean" ? options : Boolean(options.volume);
    },
    resetSound() {
      handVolume = START_VOLUME;
      applyVolume();
    },

    // For tests: run the scheduled-cut check now.
    poll,
  };
  return queue;
}

// Everything the page needs on the hosted site.
export function createYtSession({ embed, loadApi = null, ...options }) {
  const deck = createYtDeck(options.deckOptions);
  const queue = createYtQueue({ embed, deck, ...options });
  return {
    deck,
    queue,
    // Loads YouTube's player script ahead of the Play click, so the click only has to start a video.
    warm() {
      return Promise.resolve(loadApi?.()).catch(() => {});
    },
  };
}
