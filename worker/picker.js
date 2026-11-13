// The offline AI DJ song picker: a port of dj_pick() (and the request checks of Handler.pick) from
// server.py, so the hosted site picks exactly like the local one. Pure functions, no I/O.
// Keep the two in step: tests/worker-picker.cjs cross-checks them against Python.

export class DjError extends Error {}

// Python's str.split() whitespace (which differs a little from JavaScript's \s).
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const SPACE_RUN = new RegExp(`[${PY_SPACE}]+`);
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

// dict.get(key, ""): only a missing key gives "" (a JSON null is still "None" once cleaned).
const field = (song, key) => (song[key] === undefined ? "" : song[key]);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Python's str() for the JSON values that can reach clean().
function pyStr(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

// Python truthiness of a JSON value.
function truthy(value) {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return !Number.isNaN(value);
}

// Python round(): halves go to the even number.
function roundHalfEven(number) {
  const floor = Math.floor(number);
  const diff = number - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

// Python's float() on a JSON value, or throws.
function pyFloat(value) {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const text = value.replace(/_/g, "").split(SPACE_RUN).join("");
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return Number(text);
    if (/^[+-]?(inf|infinity|nan)$/i.test(text)) return NaN;
  }
  throw new TypeError("not a number");
}

// Python's int() on a JSON value, or throws (the server answers 400 for any of those).
function pyInt(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("not finite");
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const text = value.split(SPACE_RUN).join("");
    if (/^[+-]?\d+(_\d+)*$/.test(text)) return Number(text.replace(/_/g, ""));
  }
  throw new TypeError("not an integer");
}

export function clean(text, limit) {
  // Lone surrogates (possible in JSON input) can't be encoded: Python turns them into "?".
  text = pyStr(text).replace(LONE_SURROGATE, "?");
  const joined = text.split(SPACE_RUN).filter(Boolean).join(" ");
  return Array.from(joined).slice(0, limit).join(""); // limits count characters, not UTF-16 units
}

// A library song's BPM as a whole number, or null.
export function bpm(song) {
  try {
    const value = song?.bpm;
    if (!song || !truthy(value)) return null;
    const number = pyFloat(value);
    return Number.isFinite(number) ? roundHalfEven(number) : null;
  } catch {
    return null;
  }
}

// How far apart two tempos are, counting half and double time as close (80 ~ 160).
export function tempoGap(a, b) {
  if (!a || !b) return 0;
  return Math.min(Math.abs(a - b), Math.abs(a - 2 * b), Math.abs(2 * a - b));
}

// Vibe words that set the opener's energy when no genre, artist or title matches the vibe.
export const CALM_WORDS = ["chill", "slow", "relax", "calm", "mellow", "soft", "smooth", "lofi", "lo fi", "easy", "sad"];
export const ENERGY_WORDS = ["hype", "party", "energy", "fast", "banger", "turn up", "lit", "dance", "club", "workout", "gym", "hard"];
// Vibe words that name a library genre by another name.
const GENRE_ALIASES = { rap: "hip-hop", rnb: "r&b" };
// Filler words of a vibe ("something for the party") that mustn't match a song's name.
export const STOP_WORDS = new Set([
  "the", "for", "and", "some", "something", "music", "song", "songs", "play", "with", "get", "into", "that",
  "this", "have", "just", "like", "want", "give", "make", "feel", "feeling", "vibe", "vibes", "mix", "set",
  "start", "put", "bit", "all", "any", "you", "your", "can", "now", "then", "from", "very", "really", "more",
]);

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Pick the next songs from the request's "library" ([{id, artist, title, bpm, genre}]).
 * Returns a list of {id, artist, title, reason, intro}; throws DjError when it can't.
 * See dj_pick() in server.py for the rules.
 */
export function djPick(request) {
  const count = Math.max(1, Math.min(pyInt(truthy(request.count) ? request.count : 3), 5));
  // Keyed by the cleaned id, and the songs carry it too, so every lookup below agrees.
  const library = new Map();
  for (const song of truthy(request.library) ? request.library : []) {
    if (isObject(song) && typeof song.id === "string" && clean(song.id, 20)) {
      library.set(clean(song.id, 20), { ...song, id: clean(song.id, 20) });
    }
  }
  if (!library.size) throw new DjError("send the song library to pick from");
  const songs = [...library.values()];

  const label = (s) => `${clean(field(s, "artist"), 80)} - ${clean(field(s, "title"), 120)}`.toLowerCase();
  const queuedList = request.queued ?? [];
  const playedList = request.played ?? [];
  const used = new Set([...queuedList, ...playedList].map((t) => clean(t, 200).toLowerCase()));
  const nowPlaying = clean(truthy(request.nowPlaying) ? request.nowPlaying : "", 200).toLowerCase();
  const playing = songs.find((s) => label(s) === nowPlaying) ?? null;
  // The song now playing is never picked again right away.
  let unused = songs.filter((s) => !used.has(label(s)) && s !== playing);
  const order = new Map([...library.keys()].map((id, number) => [id, number]));
  const genre = (s) => clean(field(s, "genre"), 40).toLowerCase();
  const firstGenre = (s) => genre(s).split("/")[0].trim();
  // Every song played already: repeats are fine, the ones played longest ago first.
  if (!unused.length) {
    const playedOrder = new Map(playedList.map((t, n) => [clean(t, 200).toLowerCase(), n]));
    const queued = new Set(queuedList.map((t) => clean(t, 200).toLowerCase()));
    const others = songs.filter((s) => s !== playing);
    const pool = others.length ? others : songs;
    const fresh = pool.filter((s) => !queued.has(label(s)));
    unused = (fresh.length ? fresh : pool)
      .map((s, index) => ({ s, index, rank: playedOrder.get(label(s)) ?? -1 }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map(({ s }) => s)
      .slice(0, Math.max(count, Math.floor(songs.length / 2)));
  }

  // The song that follows `after` best: same genre, then nearest tempo, then nearest in the set order.
  function closest(after, choices) {
    const here = order.get(after.id) ?? 0;
    const key = (s) => [genre(s) !== genre(after) ? 1 : 0, tempoGap(bpm(after), bpm(s)), Math.abs(order.get(s.id) - here)];
    let best = null;
    let bestKey = null;
    for (const s of choices) {
      const k = key(s);
      if (!bestKey || k[0] < bestKey[0] || (k[0] === bestKey[0] && (k[1] < bestKey[1] || (k[1] === bestKey[1] && k[2] < bestKey[2])))) {
        best = s;
        bestKey = k;
      }
    }
    return best;
  }

  // The first song of a set and why. A vibe word matching a song's genre, artist or title wins;
  // else a calm word opens with the slowest song and an energy word with the fastest; else the first
  // song in the library. Tempo is the raw BPM (no half/double folding), as in server.py.
  function opener(choices) {
    const vibe = clean(truthy(request.vibe) ? request.vibe : "", 200).toLowerCase();
    const tokens = vibe.match(/[a-z0-9&]+/g) ?? [];
    const words = tokens.filter((w) => w.length >= 3 && !STOP_WORDS.has(w)).map((w) => (Object.hasOwn(GENRE_ALIASES, w) ? GENRE_ALIASES[w] : w));
    // Words only match whole words ("hard" mustn't match "Richard", "sad" "Sade", "for" "Nice For What").
    const hits = (word, text) => new RegExp(`(?<![a-z0-9])${escapeRegExp(word)}(?![a-z0-9])`).test(text);
    for (const song of choices) {
      const text = `${genre(song)} ${label(song)}`;
      if (words.some((word) => hits(word, text))) return [song, "matches your vibe"];
    }
    // The earliest calm or energy word sets the mood, so "chill into hype" opens calm.
    const phrase = ` ${tokens.join(" ")} `;
    const found = [...CALM_WORDS, ...ENERGY_WORDS]
      .filter((w) => phrase.includes(` ${w} `))
      .map((w) => [phrase.indexOf(` ${w} `), w])
      .sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    const rated = choices.filter((s) => bpm(s));
    if (found.length && rated.length) {
      let pickSong = rated[0];
      if (CALM_WORDS.includes(found[0][1])) {
        for (const s of rated) if (bpm(s) < bpm(pickSong)) pickSong = s;
        return [pickSong, "calm opener"];
      }
      for (const s of rated) if (bpm(s) > bpm(pickSong)) pickSong = s;
      return [pickSong, "high-energy opener"];
    }
    return [choices[0], "starts the set"];
  }

  const picks = [];
  while (picks.length < count) {
    const choices = unused.filter((s) => picks.every((p) => p.id !== s.id));
    if (!choices.length) break;
    const before = picks.length ? library.get(picks[picks.length - 1].id) : playing;
    let song;
    let opening;
    if (before) song = closest(before, choices);
    else [song, opening] = opener(choices);
    const artist = clean(field(song, "artist"), 80);
    const title = clean(field(song, "title"), 120);
    let reason;
    let intro;
    if (!before) {
      reason = opening;
      intro = `Let's get it started with ${title} by ${artist}.`;
    } else if (genre(song) === genre(before)) {
      reason = tempoGap(bpm(before), bpm(song)) <= 8 ? "same genre, close tempo" : "same genre";
      intro = `Here's ${title} by ${artist}.`;
    } else {
      reason = "a smooth step to a new genre";
      const name = firstGenre(song);
      intro = name ? `Switching it up, ${name} time: ${title} by ${artist}!` : `Next up: ${title} by ${artist}!`;
    }
    picks.push({ id: song.id, artist, title, reason, intro });
  }
  if (!picks.length) throw new DjError("no songs to pick from");
  return picks;
}

/**
 * Handler.pick() from server.py: checks the fields JSON syntax alone doesn't validate, then picks.
 * `body` is the parsed JSON object. Returns { status, body } (200 {picks} or 400 {error}).
 */
export function pick(body) {
  // Work on a copy: the caller's object stays as it was.
  const request = { ...body };
  try {
    if (request.count !== undefined && request.count !== null) request.count = pyInt(request.count);
    for (const field of ["queued", "played"]) {
      if (field in request && (!Array.isArray(request[field]) || request[field].some((value) => typeof value !== "string"))) {
        throw new TypeError("bad list");
      }
    }
    if ("library" in request && (!Array.isArray(request.library) || request.library.some(
      (song) => isObject(song) && "id" in song && typeof song.id !== "string"))) {
      throw new TypeError("bad library");
    }
  } catch {
    return { status: 400, body: { error: "invalid DJ request fields" } };
  }
  try {
    return { status: 200, body: { picks: djPick(request) } };
  } catch (error) {
    if (error instanceof DjError) return { status: 400, body: { error: error.message } };
    throw error;
  }
}
