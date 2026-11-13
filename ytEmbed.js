// YouTube songs on the hosted site, played by YouTube's own embedded player (the official IFrame
// Player API). Nothing is downloaded, proxied or decoded here, and no API key is involved: the
// video plays inside YouTube's iframe, in a visible card in the DJ Deck sidebar. queue.js drives
// it through the small interface below, and tests hand queue.js a stub with the same interface.
//
//   const yt = createYtEmbed({ mount: someElement });   // nothing loads yet
//   await yt.load("dQw4w9WgXcQ");                      // loads YouTube's script on first use, then plays
//   yt.pause(); yt.play(); yt.seekTo(30); yt.setVolume(0.5); yt.setRate(1);
//   yt.getTime(); yt.getDuration(); yt.isPlaying();
//   yt.onEnded(() => ...); yt.onError((message, code) => ...);   // each returns an "unsubscribe"
//   await yt.second.prime(someId);   // inside a click: creates the player and plays a muted video once, so later blends may autoplay
//   yt.stop();      // stop the video and hide its frame (the player stays for the next video)
//   yt.destroy();
//
// Two players, so a YouTube song can blend into another. The object above drives the "current" player;
// yt.second has the same methods for the "incoming" one (its frame only shows while it holds a video),
// and yt.swap() makes the incoming player the current one (and the old current one the spare):
//   await yt.second.load(nextId, { volume: 0, rate: 1 });   // load(id, { volume, rate }) sets both before it plays
//   yt.second.setVolume(0.3); yt.setVolume(0.7);            // the crossfade is just two volumes
//   yt.stop(); yt.swap();                                    // done: the incoming player is now `yt`
// yt.onEnded / yt.onError belong to the current player's role (they follow a swap); yt.second.onEnded / onError
// to the incoming one's. createYtEmbedPair is the same function under a second name.
//
// The player only takes volume and speed: no filter, effects, waveform or beat matching.

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
const API_URL = "https://www.youtube.com/iframe_api";
const API_TIMEOUT_MS = 15000;
const DEFAULT_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export const EMBED_NOTE = "YouTube songs: volume, speed and blends only, no effects.";
export const BAD_LINK_MESSAGE = "That isn't a YouTube link. Paste a youtube.com/watch?v=…, youtu.be/…, /shorts/… or /embed/… link.";

// The 11-character video id of a YouTube link (youtube.com/watch?v=, youtu.be/, /shorts/, /embed/),
// or null for anything else. Strict: the id must be exactly [A-Za-z0-9_-]{11}.
export function parseYouTubeId(text) {
  const raw = String(text ?? "").trim();
  if (!raw || raw.length > 300 || /\s/.test(raw)) return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  let id = null;
  if (host === "youtu.be") {
    if (parts.length === 1) id = parts[0];
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else if (parts.length === 2 && (parts[0] === "shorts" || parts[0] === "embed")) id = parts[1];
  }
  return id !== null && VIDEO_ID.test(id) ? id : null;
}

// The playback rate YouTube offers that is closest to `rate`.
export function nearestRate(rate, available = DEFAULT_RATES) {
  const rates = Array.isArray(available) && available.length ? available : DEFAULT_RATES;
  if (!Number.isFinite(rate)) return 1;
  return rates.reduce((best, candidate) => (Math.abs(candidate - rate) < Math.abs(best - rate) ? candidate : best), rates[0]);
}

const ERROR_MESSAGES = {
  2: "the video link isn't valid",
  5: "YouTube's player had a problem with this video",
  100: "the video was removed or is private",
  101: "the video's owner doesn't allow it to play in other sites",
  150: "the video's owner doesn't allow it to play in other sites",
};
export const errorMessage = (code) => ERROR_MESSAGES[code] ?? "YouTube couldn't play this video";

// Loads YouTube's player script once (and only when asked). A failure can be retried by asking again.
let apiPromise = null;
export function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  apiPromise ??= new Promise((resolve, reject) => {
    const fail = () => {
      apiPromise = null;
      clearTimeout(timer);
      reject(new Error("YouTube's player couldn't be loaded"));
    };
    const timer = setTimeout(fail, API_TIMEOUT_MS);
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timer);
      if (typeof previous === "function") previous();
      resolve(window.YT);
    };
    const script = document.createElement("script");
    script.src = API_URL;
    script.async = true;
    script.onerror = fail;
    document.head.append(script);
  });
  return apiPromise;
}

const cardStyles = `
.ytCard { display: flex; flex-direction: column; gap: 8px; padding: 12px 16px; }
.ytCard[hidden] { display: none; }
.ytCard-title { margin: 0; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: #8a4510; }
.ytCard-frame { position: relative; width: 100%; min-width: 200px; height: 200px; border-radius: 10px; overflow: hidden; background: #000; }
.ytCard-frame[hidden] { display: none; }
.ytCard-frame iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
.ytCard-note { margin: 0; font-size: 12px; color: #8a4510; }
`;

// Two players (see the header): each slot is one IFrame player in its own 200px frame. The returned object
// drives whichever slot is "current"; `.second` drives the other; `.swap()` trades the roles.
export function createYtEmbed({ mount, loadApi = loadYouTubeApi, doc = typeof document === "undefined" ? null : document } = {}) {
  const make = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const frames = [null, null];
  if (mount && doc) {
    if (doc.head && !doc.getElementById?.("ytCard-styles")) {
      const style = make("style", "", cardStyles);
      style.id = "ytCard-styles";
      doc.head.append(style);
    }
    mount.classList?.add("ytCard");
    frames[0] = make("div", "ytCard-frame");
    frames[1] = make("div", "ytCard-frame");
    frames[1].hidden = true;
    mount.append(make("h2", "ytCard-title", "YouTube"), frames[0], frames[1], make("p", "ytCard-note", EMBED_NOTE));
    mount.hidden = true;
  }
  let current = 0; // which slot plays the current song
  const listeners = { main: { ended: new Set(), error: new Set() }, second: { ended: new Set(), error: new Set() } };
  const emit = (set, ...args) => [...set].forEach((listener) => listener(...args));
  const slots = [0, 1].map((index) => makeSlot(index));
  const showMount = () => {
    if (mount) mount.hidden = !slots.some((slot) => slot.visible);
  };
  const roleOf = (index) => (index === current ? "main" : "second");

  function makeSlot(index) {
    let player = null;
    let ready = null; // Promise of the player once YouTube says it is ready
    let playing = false;
    let hasVideo = false;
    let lastVolume = null;
    let lastRate = null;
    let priming = false; // a muted video is playing only to unlock autoplay (see prime)
    let primeTimer = null;
    const endPriming = () => {
      priming = false;
      clearTimeout(primeTimer);
    };
    const slot = {
      visible: false,
      show(on) {
        slot.visible = on;
        if (frames[index]) frames[index].hidden = !on;
        showMount();
      },
    };

    // Creates the player the first time (loading YouTube's script), then reuses it.
    function ensure() {
      ready ??= (async () => {
        const YT = await loadApi();
        return new Promise((resolve, reject) => {
          const holder = doc ? make("div") : null;
          frames[index]?.replaceChildren(holder);
          try {
            player = new YT.Player(holder, {
              width: "100%",
              height: "100%",
              playerVars: { playsinline: 1, rel: 0, origin: typeof location === "undefined" ? undefined : location.origin },
              events: {
                onReady: () => resolve(player),
                onStateChange: (event) => {
                  const state = event?.data;
                  if (priming) {
                    // The muted priming video started: autoplay is unlocked for this player; put it away again.
                    if (state === 1) {
                      endPriming();
                      try {
                        player.stopVideo?.();
                      } catch {
                        // already gone
                      }
                      playing = false;
                      slot.show(false);
                    }
                    return;
                  }
                  playing = state === 1 || state === 3;
                  if (state === 0 && hasVideo) emit(listeners[roleOf(index)].ended);
                },
                onError: (event) => {
                  playing = false;
                  if (hasVideo) emit(listeners[roleOf(index)].error, errorMessage(event?.data), event?.data);
                },
              },
            });
          } catch (error) {
            reject(error);
          }
        });
      })().catch((error) => {
        // Not kept: asking again (a click) tries again; nothing retries by itself.
        player = null;
        ready = null;
        throw error;
      });
      return ready;
    }

    Object.assign(slot, {
      // Shows the frame, loads the player if needed and starts the video. Rejects if YouTube's script or
      // player can't start. volume (0-1) and rate are applied before the video starts, so a song that
      // comes in under a crossfade never blasts at full volume first.
      async load(videoId, { volume, rate, start } = {}) {
        if (!VIDEO_ID.test(String(videoId))) throw new Error("not a YouTube video id");
        endPriming();
        slot.show(true);
        try {
          await ensure();
        } catch (error) {
          slot.show(false);
          throw error;
        }
        hasVideo = true;
        lastVolume = null;
        lastRate = null;
        if (Number.isFinite(volume)) slot.setVolume(volume);
        if (Number.isFinite(rate)) slot.setRate(rate);
        if (Number.isFinite(start) && start > 0) player.loadVideoById({ videoId, startSeconds: start });
        else player.loadVideoById(videoId);
      },
      // Call inside a click: creates the player and plays a muted video for a moment, which lets this
      // player autoplay later (a blend starts its incoming video without any click). Does nothing
      // while the player holds a video. Never rejects.
      async prime(videoId) {
        if (hasVideo || priming || !VIDEO_ID.test(String(videoId))) return;
        try {
          await ensure();
        } catch {
          return;
        }
        if (hasVideo || priming) return;
        priming = true;
        slot.show(true); // YouTube needs a visible player to play
        player.setVolume(0);
        lastVolume = null;
        player.loadVideoById(videoId);
        primeTimer = setTimeout(() => {
          if (!priming) return;
          endPriming();
          try {
            player.stopVideo?.();
          } catch {
            // already gone
          }
          if (!hasVideo) slot.show(false);
        }, 4000);
      },
      play() {
        if (hasVideo) player?.playVideo();
      },
      pause() {
        if (hasVideo) player?.pauseVideo();
      },
      seekTo(seconds) {
        if (hasVideo && Number.isFinite(seconds)) player?.seekTo(Math.max(0, seconds), true);
      },
      // 0-1 (YouTube takes 0-100). Repeated values are not sent again: the hands set it every frame.
      setVolume(volume) {
        if (!hasVideo || !Number.isFinite(volume)) return;
        const percent = Math.round(Math.max(0, Math.min(1, volume)) * 100);
        if (percent === lastVolume) return;
        lastVolume = percent;
        player?.setVolume(percent);
      },
      // The nearest speed YouTube allows for the video.
      setRate(rate) {
        if (!hasVideo || !Number.isFinite(rate)) return;
        const best = nearestRate(rate, player?.getAvailablePlaybackRates?.());
        if (best === lastRate) return;
        lastRate = best;
        player?.setPlaybackRate(best);
      },
      getTime() {
        const seconds = hasVideo ? player?.getCurrentTime?.() : 0;
        return Number.isFinite(seconds) ? seconds : 0;
      },
      getDuration() {
        const seconds = hasVideo ? player?.getDuration?.() : 0;
        return Number.isFinite(seconds) ? seconds : 0;
      },
      isPlaying: () => hasVideo && playing,
      // Stops the video and hides the frame (the player stays, ready for the next video). A playing
      // player is never hidden any other way: YouTube needs a playing player to be visible.
      stop() {
        if (hasVideo) player?.stopVideo?.();
        hasVideo = false;
        playing = false;
        slot.show(false);
      },
      destroy() {
        endPriming();
        hasVideo = false;
        playing = false;
        try {
          player?.destroy?.();
        } catch {
          // already gone
        }
        player = null;
        ready = null;
        frames[index]?.replaceChildren();
        slot.show(false);
      },
    });
    return slot;
  }

  // The public face of a slot role: the same methods, always aimed at whichever slot holds the role now.
  const face = (role, pick) => {
    const call = (name) => (...args) => pick()[name](...args);
    return {
      load: call("load"), prime: call("prime"), play: call("play"), pause: call("pause"), seekTo: call("seekTo"), setVolume: call("setVolume"),
      setRate: call("setRate"), getTime: call("getTime"), getDuration: call("getDuration"), isPlaying: call("isPlaying"),
      stop: call("stop"),
      onEnded(listener) {
        listeners[role].ended.add(listener);
        return () => listeners[role].ended.delete(listener);
      },
      onError(listener) {
        listeners[role].error.add(listener);
        return () => listeners[role].error.delete(listener);
      },
    };
  };
  const api = face("main", () => slots[current]);
  api.second = face("second", () => slots[1 - current]);
  // The incoming player becomes the current one (and the old current one, the spare). Stop the old one first.
  api.swap = () => {
    current = 1 - current;
  };
  api.destroy = () => {
    listeners.main.ended.clear();
    listeners.main.error.clear();
    listeners.second.ended.clear();
    listeners.second.error.clear();
    slots.forEach((slot) => slot.destroy());
  };
  return api;
}

export const createYtEmbedPair = createYtEmbed;
