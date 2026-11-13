// Measures beat data for every song in library.json and writes it into the song as
//   "beat": { "bpm": <2 decimals>, "first": <seconds, 3 decimals>, "duration": <seconds, 1 decimal> }
// using the app's own analyzeTempo (mix-audio.js) on music/<id>.m4a decoded by ffmpeg.
// Run:  node scripts/analyze-library.mjs     (fill music/ first: python3 prefetch.py)
// Songs with no audio file are skipped with a warning. The display `bpm` is never changed
// here. When the measured tempo disagrees with `bpm` by more than 2 BPM (after allowing
// half/double time) the measurement is not trusted (swung/triplet feel, wrong octave): no
// `beat` is written for that song (any old one is removed) and it is listed instead.
// With --public the same analysis runs on library.public.json against public-music/<id>.m4a.
// There the listed `bpm` is the published or estimated tempo (the prior, not a trusted value); when the
// measurement is trusted and within 2 BPM of it, `bpm` is replaced by the rounded measured tempo.
// Not part of the hosted build.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { analyzeTempo } from "../mix-audio.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = process.argv.includes("--public");
const libraryPath = path.join(root, PUBLIC ? "library.public.json" : "library.json");
const audioDir = PUBLIC ? "public-music" : "music";
const SR = 44100;

function decode(file) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"],
    { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(String(r.stderr || r.error));
  const b = r.stdout;
  const data = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length - (b.length % 4)));
  return { sampleRate: SR, numberOfChannels: 1, length: data.length, duration: data.length / SR, getChannelData: () => data };
}

// ---- Prior-guided second pass ---------------------------------------------------------
// Onset envelope at 100 fps: log-energy rising edges of the full band plus of a <150 Hz band
// (kicks), each scaled to mean 1, minus a 1 s local average.
const HOP = 441, FPS = SR / HOP;
function envelope(x) {
  const n = Math.floor(x.length / HOP), a = 1 - Math.exp((-2 * Math.PI * 150) / SR);
  let l1 = 0, l2 = 0;
  const eL = new Float32Array(n), eF = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sl = 0, sf = 0;
    for (let j = i * HOP, e = j + HOP; j < e; j++) { const v = x[j]; l1 += a * (v - l1); l2 += a * (l1 - l2); sl += l2 * l2; sf += v * v; }
    eL[i] = Math.log(1e-7 + sl); eF[i] = Math.log(1e-7 + sf);
  }
  const flux = (e) => { const o = new Float32Array(n); let t = 0; for (let i = 1; i < n; i++) { o[i] = Math.max(0, e[i] - e[i - 1]); t += o[i]; } const m = t / n || 1; return o.map((v) => v / m); };
  const L = flux(eL), F = flux(eF), o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = L[i] + F[i];
  const w = Math.round(FPS * 0.5), out = new Float32Array(n);
  let run = 0;
  for (let i = 0; i < n; i++) { run += o[i] - (i >= 2 * w ? o[i - 2 * w] : 0); const c = i - w; if (c >= 0) out[c] = Math.max(0, o[c] - run / (2 * w)); }
  return out;
}
const at = (env, x) => { const i = x | 0, f = x - i; return i + 1 < env.length ? env[i] + (env[i + 1] - env[i]) * f : 0; };
// Comb: mean envelope value on a pulse train at `bpm`, best phase (0.5 frame steps) over the whole track.
function comb(env, bpm) {
  const p = (FPS * 60) / bpm;
  let best = -1, phase = 0;
  for (let q = 0; q < p; q += 0.5) {
    let s = 0, c = 0;
    for (let x = q; x < env.length - 1; x += p) { s += at(env, x); c++; }
    s /= c;
    if (s > best) { best = s; phase = q; }
  }
  return { score: best, phase };
}
// Scan center*(1 +/- 4%) in 0.01 BPM steps; evidence = best score / median score over the scan.
function scan(env, center) {
  const lo = center * 0.96, hi = center * 1.04, scores = [];
  let best = { score: -1, bpm: center };
  for (let b = lo; b <= hi; b += 0.01) { const c = comb(env, b); scores.push(c.score); if (c.score > best.score) best = { score: c.score, bpm: b }; }
  for (let b = best.bpm - 0.02; b <= best.bpm + 0.02; b += 0.002) { const c = comb(env, b); if (c.score > best.score) best = { score: c.score, bpm: b }; }
  scores.sort((u, v) => u - v);
  return { bpm: best.bpm, ratio: best.score / scores[scores.length >> 1] };
}
// Strongest of the 4 beat phases is the bar anchor; returned as the earliest one in the file.
function anchor(env, bpm) {
  const p = (FPS * 60) / bpm, ph = comb(env, bpm).phase;
  let best = -1, down = ph;
  for (let j = 0; j < 4; j++) {
    let s = 0;
    for (let x = ph + j * p; x < env.length - 1; x += 4 * p) s += at(env, x);
    if (s > best) { best = s; down = ph + j * p; }
  }
  const bar = (4 * 60) / bpm;
  let first = (down * HOP) / SR;
  return first - Math.floor(first / bar) * bar;
}
// Hand check on raw audio: share of beats in the middle half of the song where the 40 ms after
// the beat is louder than the 40 ms before it (x1.2).
function hitRate(x, bpm, first) {
  const beat = 60 / bpm, dur = x.length / SR, rms = (a, b) => { let s = 0; const i0 = Math.max(0, Math.round(a * SR)), i1 = Math.min(x.length, Math.round(b * SR)); for (let i = i0; i < i1; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, i1 - i0)); };
  let hit = 0, n = 0;
  for (let t = first + beat * Math.ceil((dur * 0.25 - first) / beat); t < dur * 0.75; t += beat) { n++; if (rms(t, t + 0.04) > 1.2 * rms(t - 0.04, t) + 1e-5) hit++; }
  return n ? hit / n : 0;
}
const MIN_RATIO = Number(process.env.MIN_RATIO || 1.5);
const MIN_HIT = Number(process.env.MIN_HIT || (PUBLIC ? 0.35 : 0.4));

const text = readFileSync(libraryPath, "utf8");
const library = JSON.parse(text);
const beats = new Map();
const TOLERANCE = 2;
const untrusted = new Set();
const newBpm = new Map(); // --public only: song id -> rounded measured tempo
// Extra tempi to scan when the listed bpm looks wrong, from public tempo pages (Beatport, SongBPM, Music Gateway...).
const HINTS = { "m77FDcKg96Q": 104, "421w1j87fEM": 88, "uzS3WG6__G4": 80, "ApNQX6fVWQ4": 100, "QpKkNIT84GY": 107, "MK9hxakQMN8": 112 };
const rows = [];
for (const song of library.songs) {
  const file = path.join(root, audioDir, `${song.id}.m4a`);
  if (!existsSync(file)) { console.warn(`WARN ${song.id} ${song.artist} - ${song.title}: no ${audioDir}/${song.id}.m4a, skipped`); continue; }
  const buf = decode(file), x = buf.getChannelData(0), env = envelope(x);
  const duration = Number(buf.duration.toFixed(1));
  const t = analyzeTempo(buf);
  const near = (b) => Math.min(...[1, 2, 0.5].map((m) => Math.abs(b - song.bpm * m)));
  const label = `${song.id} ${song.artist} - ${song.title}`;
  let beat = null, how = "", ratio = 0, hit = 0;
  if (near(t.bpm) <= TOLERANCE) {
    // Free result agrees with the listed tempo: keep it, and report the comb evidence for it.
    beat = { bpm: Number(t.bpm.toFixed(2)), first: Number(t.first.toFixed(3)), duration };
    const c = scan(env, t.bpm); ratio = c.ratio; hit = hitRate(x, beat.bpm, beat.first); how = "free";
  } else {
    // Prior-guided: scan listed bpm x {1, 0.5, 2} (and a hint) within +/-4%; 1x wins unless another is 1.25x stronger.
    const cands = [[1, song.bpm], [0.5, song.bpm / 2], [2, song.bpm * 2]];
    if (PUBLIC) cands.length = 1; // the published tempo is the grid: never settle for half or double time
    if (HINTS[song.id]) cands.unshift([1, HINTS[song.id]]);
    let pick = null;
    for (const [m, c] of cands) {
      const r = scan(env, c);
      if (process.env.EXPLORE) console.log(`   ${label} scan ${c} -> ${r.bpm.toFixed(3)} ratio ${r.ratio.toFixed(2)}`);
      // Half/double candidates must be 1.5x stronger: fewer pulses make a comb look peakier.
      if (!pick || r.ratio > pick.ratio * (m === 1 ? 1 : 1.5)) pick = { ...r, m };
    }
    const first = anchor(env, pick.bpm);
    ratio = pick.ratio; hit = hitRate(x, pick.bpm, first); how = "prior";
    const cand = { bpm: Number(pick.bpm.toFixed(2)), first: Number(first.toFixed(3)), duration };
    // Also the final tempo must agree with the listed bpm (fix a wrong listed bpm by hand, with a second source).
    if (ratio >= MIN_RATIO && hit >= MIN_HIT && near(cand.bpm) <= TOLERANCE) beat = cand;
    else console.log(`   rejected: ${cand.bpm} first ${cand.first}`);
  }
  if (beat) beats.set(song.id, beat); else untrusted.add(song.id);
  if (PUBLIC && beat && Math.abs(beat.bpm - song.bpm) <= TOLERANCE) newBpm.set(song.id, Math.round(beat.bpm));
  rows.push(`${label}: listed ${song.bpm} final ${beat ? beat.bpm : "-"} first ${beat ? beat.first : "-"} (${how}) comb ${ratio.toFixed(2)}x median, hits ${(hit * 100).toFixed(0)}% -> ${beat ? "written" : "NOT written"}`);
  console.log(rows[rows.length - 1]);
}

// Rewrite only the song lines so the file's formatting stays as it was.
const fmt = (b) => `"beat": { "bpm": ${b.bpm.toFixed(2)}, "first": ${b.first.toFixed(3)}, "duration": ${b.duration.toFixed(1)} }`;
const out = text.split("\n").map((line) => {
  const m = line.match(/"id": "([^"]+)"/);
  if (!m || !(beats.has(m[1]) || untrusted.has(m[1]))) return line;
  const beat = beats.get(m[1]);
  let clean = line.replace(/,\s*"beat": \{[^}]*\}/, "");
  if (newBpm.has(m[1])) clean = clean.replace(/"bpm": \d+/, `"bpm": ${newBpm.get(m[1])}`);
  if (!beat) return clean;
  return clean.replace(/\s*\},?\s*$/, (end) => `, ${fmt(beat)} }${end.includes(",") ? "," : ""}`);
}).join("\n");
JSON.parse(out); // never write a broken file
if (!process.env.DRY) writeFileSync(libraryPath, out);
console.log(`wrote beat data for ${beats.size} of ${library.songs.length} songs (${untrusted.size} untrusted, omitted)`);
