// DJ transitions for the Deck in audio.js (queue.js uses them when the AI DJ moves on).
//
// - Blend: when the two tempos are close, the next song comes in beat-matched and on a
//   downbeat under the current one, they swap bass lines halfway (only one bass at a
//   time, like a DJ on a mixer), and afterwards the new song eases back to its own tempo.
// - Echo out: when the tempos are too far apart (a big genre jump), the current song
//   echoes out and the next one fades in under the echoes.
// Either way the mix starts before the current song's ending fades out, and the next
// song starts where its music starts (no silence). Tempo and downbeats come from
// analyzeTempo in mix-audio.js.
//
// audio.js isn't changed. Like queue.js, this uses the Deck's fields (ctx, buffer,
// source, rate, offset, anchorTime, playing, filter). The outgoing song keeps playing
// on its own source (the "tail") into the deck's filter, so the hand controls (filter,
// volume) still shape both songs.

import { analyzeTempo } from "./mix-audio.js";

const startShare = 0.1; // a song's music starts where its level first reaches this share of its median level
const endShare = 0.5; // its ending fades out where the level drops below this share for good
const blendSeconds = 8; // a blend lasts about this long (rounded to whole bars)
const shortBlendSeconds = 4; // ...and this long with short mixes
const maxNudge = 0.08; // the incoming song's speed may be nudged up to 8% to match tempos
const tempoTolerance = 0.06; // a detected tempo is trusted if it's within 6% of the library's
const bassCutHz = 300; // in a blend, the bass line of one song is cut below this
const openHz = 10; // a high-pass this low lets everything through
const thinHz = 2000; // the hands thin the old song out up to this as it leaves
const echoFeedback = 0.5;
const echoRingSeconds = 4; // how long an echo-out rings
const echoFadeInSeconds = 1.5; // the incoming song's fade-in under the echoes
const glideSeconds = 16; // after a blend the new song eases back to its own tempo over this long
const analysisSeconds = 45; // tempo is detected on this much audio around the point that matters
// Short mixes, for demos: each song comes in where it first gets going (its first
// stretch at full energy) and plays about shortSeconds, in whole phrases from there.
const shortSeconds = 20;
const phraseBars = 4;
const entryLevel = 0.9; // "full energy": the next 8 s average at least this share of the song's median level
const entrySpan = 16; // 8 s, in half-second levels
const scheduleAhead = 0.1; // seconds: a transition is scheduled this far ahead, for exact timing

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A tempo ratio folded into 0.71–1.41, so half and double time count as the same tempo.
function fold(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1; // no usable tempo: treat as the same
  while (ratio > Math.SQRT2) ratio /= 2;
  while (ratio < Math.SQRT1_2) ratio *= 2;
  return ratio;
}
const trusted = (detected, expected) => !expected || (
  Number.isFinite(detected) && detected > 0 && Math.abs(fold(detected / expected) - 1) <= tempoTolerance
);

// Where a song's music starts and where its ending fades out (seconds), from its level
// in half-second steps.
const boundsCache = new WeakMap();
function bounds(buffer) {
  let found = boundsCache.get(buffer);
  if (found) return found;
  const data = buffer.getChannelData(0);
  const window = Math.round(buffer.sampleRate / 2);
  const levels = [];
  for (let at = 0; at + window <= data.length; at += window) {
    let sum = 0;
    for (let i = at; i < at + window; i += 8) sum += data[i] * data[i];
    levels.push(Math.sqrt((sum * 8) / window));
  }
  const median = [...levels].sort((a, b) => a - b)[levels.length >> 1] ?? 0;
  const first = Math.max(0, levels.findIndex((level) => level >= median * startShare));
  let last = levels.length - 1;
  while (last > first && levels[last] < median * endShare) last -= 1;
  let end = (last + 1) / 2;
  if (end < buffer.duration / 2) end = buffer.duration; // an odd level curve: use the real end
  found = { start: first / 2, end: Math.min(end, buffer.duration), levels, median };
  boundsCache.set(buffer, found);
  return found;
}

// The beat grid around a point in a song: its tempo and one downbeat (seconds into the
// song), detected on the audio from `from` on. Songs like SICKO MODE change tempo, so
// each part of a song gets its own.
const gridCache = new WeakMap();
function grid(buffer, from) {
  const seconds = Math.min(analysisSeconds, buffer.duration);
  from = Math.round(Math.max(0, Math.min(from, buffer.duration - seconds)) * 2) / 2;
  const grids = gridCache.get(buffer) ?? new Map();
  if (!grids.has(from)) {
    const offset = Math.round(from * buffer.sampleRate);
    const length = Math.min(Math.round(seconds * buffer.sampleRate), buffer.length - offset);
    const part = new AudioBuffer({
      length,
      sampleRate: buffer.sampleRate,
      numberOfChannels: Math.min(2, buffer.numberOfChannels),
    });
    for (let channel = 0; channel < part.numberOfChannels; channel += 1) {
      part.copyToChannel(buffer.getChannelData(channel).subarray(offset, offset + length), channel);
    }
    const { bpm, first } = analyzeTempo(part);
    grids.set(from, { bpm, first: from + first });
    gridCache.set(buffer, grids);
  }
  return grids.get(from);
}
// Where a song's music starts, and the grid there.
const introGrid = (buffer) => grid(buffer, bounds(buffer).start);
// A grid already worked out whose stretch of audio covers a point (the one centered
// nearest it), else a new one from `from`. The analysis takes a few hundred ms, so a
// playing song asked about every frame mustn't redo it for each new half second.
function gridNear(buffer, seconds, from) {
  const span = Math.min(analysisSeconds, buffer.duration);
  let nearest = null;
  for (const [start, found] of gridCache.get(buffer) ?? []) {
    if (seconds < start || seconds > start + span) continue;
    const off = Math.abs(seconds - (start + span / 2));
    if (!nearest || off < nearest.off) nearest = { off, found };
  }
  return nearest ? nearest.found : grid(buffer, from);
}
// The grid leading up to a point in the song (for mixing out there).
const gridBefore = (buffer, seconds) => gridNear(buffer, seconds, seconds - analysisSeconds + 10);

const barOf = ({ bpm }) => 240 / bpm;

// Where a song comes in (seconds), and the beat grid there: where its music starts, or
// with short mixes, the downbeat where it first gets going (skipping a quiet intro).
const entryCache = new WeakMap();
function entry(buffer, short) {
  const { start, levels, median } = bounds(buffer);
  if (!short) return { at: start, beats: introGrid(buffer) };
  let found = entryCache.get(buffer);
  if (!found) {
    let loud = null;
    for (let i = Math.round(start * 2); i + entrySpan <= levels.length && i / 2 < buffer.duration * 0.6; i += 1) {
      if (levels[i] < median * entryLevel * 0.8) continue;
      let sum = 0;
      for (let j = i; j < i + entrySpan; j += 1) sum += levels[j];
      if (sum / entrySpan >= median * entryLevel) {
        loud = i / 2;
        break;
      }
    }
    if (loud === null || loud < start + 1) {
      found = { at: start, beats: introGrid(buffer) };
    } else {
      const beats = grid(buffer, loud - 10);
      const bar = barOf(beats);
      found = { at: Math.max(start, beats.first + Math.round((loud - beats.first) / bar) * bar), beats };
    }
    entryCache.set(buffer, found);
  }
  return found;
}
// The first downbeat of a grid at or after a point in the song.
function downbeatAfter(beats, seconds) {
  const bar = barOf(beats);
  return beats.first + Math.ceil((seconds - beats.first) / bar - 1e-6) * bar;
}
// A blend's length in song seconds: about blendSeconds (or shortBlendSeconds), in whole bars.
function blendLength(beats, short) {
  const bar = barOf(beats);
  return Math.max(short ? 1 : 2, Math.min(8, Math.round((short ? shortBlendSeconds : blendSeconds) / bar))) * bar;
}

// Where a song should be mixed out by (seconds into it): before its ending fades out,
// or with short mixes, after the whole phrases that make about shortSeconds from its entry.
function mixOutPoint(buffer, short) {
  const { end } = bounds(buffer);
  if (!short) return end;
  const { at, beats } = entry(buffer, true);
  const phrase = barOf(beats) * phraseBars;
  return Math.min(at + Math.max(1, Math.round(shortSeconds / phrase)) * phrase, end);
}

// Blend or echo out, for two songs at the current tempo nudge.
function styleFor(current, next, { mixOutAt, fromBpm, toBpm, nudge = 1, short = false }) {
  const beatsOut = gridBefore(current, mixOutAt);
  const beatsIn = entry(next, short).beats;
  const ratio = fold(beatsOut.bpm / beatsIn.bpm); // the next song's speed that matches beats
  const knownOut = trusted(beatsOut.bpm, fromBpm);
  const blend = knownOut && trusted(beatsIn.bpm, toBpm) && Math.abs(nudge * ratio - 1) <= maxNudge;
  return { blend, knownOut, beatsOut, beatsIn, ratio };
}

// An equal-power fade (no dip in loudness halfway) on a gain, between two times.
function fade(param, rising, start, end) {
  const curve = Float32Array.from({ length: 32 }, (_, i) => {
    const x = (i / 31) * (Math.PI / 2);
    return rising ? Math.sin(x) : Math.cos(x);
  });
  param.setValueCurveAtTime(curve, start, Math.max(0.01, end - start));
}

export function createTransitions(deck) {
  // The hand controls set the deck's speed every frame. A tempo nudge (to match the
  // song being mixed out) multiplies whatever they set, and the tail follows the hands too.
  const setDeckSpeed = deck.setSpeed.bind(deck);
  let handSpeed = deck.rate;
  let nudge = 1;
  let glide = null;
  let tail = null; // { source, nodes, incoming, nudge, timer, watch } while the outgoing song fades

  let speedHeld = false; // while the hands perform a mix, their pinch must not change the speed
  deck.setSpeed = (speed) => {
    if (speedHeld) return;
    handSpeed = speed;
    // A song scheduled to start on a downbeat hasn't started yet: the next frame applies it.
    if (deck.ctx && deck.anchorTime > deck.ctx.currentTime) return;
    setDeckSpeed(speed * nudge);
    if (tail) tail.source.playbackRate.setTargetAtTime(speed * tail.nudge, deck.ctx.currentTime, 0.03);
  };
  function setNudge(value) {
    nudge = value;
    setDeckSpeed(handSpeed * nudge);
  }
  function stopGlide() {
    clearInterval(glide);
    glide = null;
  }
  // Eases the nudge back to 1, slowly enough that nobody hears the tempo change.
  function glideHome() {
    stopGlide();
    const from = nudge;
    if (Math.abs(from - 1) < 0.001) return; // nothing to ease (manual hand blends never nudge)
    const started = deck.ctx.currentTime;
    glide = setInterval(() => {
      const done = Math.min(1, (deck.ctx.currentTime - started) / glideSeconds);
      setNudge(from + (1 - from) * done);
      if (done === 1) stopGlide();
    }, 250);
  }

  // Pausing mid-blend ends the outgoing tail at once, not at the next watch poll.
  if (typeof deck.pause === "function") {
    const pauseDeck = deck.pause.bind(deck);
    deck.pause = (...args) => {
      const result = pauseDeck(...args);
      if (tail && deck.source !== tail.incoming) finish();
      return result;
    };
  }

  // Ends a transition now: stops the tail and plugs the new song straight into the deck.
  function finish() {
    if (!tail) return;
    const { source, nodes, incoming, timer, watch } = tail;
    tail = null;
    clearInterval(timer);
    clearInterval(watch);
    try {
      source.stop();
    } catch {
      // already stopped
    }
    source.disconnect();
    nodes.forEach((node) => node.disconnect());
    if (deck.source === incoming) {
      incoming.disconnect();
      incoming.connect(deck.filter);
    }
  }

  // Audio time freezes when AirMix pauses. Wall timers only poll the deadline.
  function finishAt(audioTime, blend) {
    const active = tail;
    clearInterval(active.timer);
    active.timer = setInterval(() => {
      if (tail !== active || deck.ctx.currentTime < audioTime) return;
      finish();
      if (blend) glideHome();
    }, 50);
  }

  function filterNode(type, hz) {
    const node = deck.ctx.createBiquadFilter();
    node.type = type;
    node.frequency.value = hz;
    return node;
  }
  function gainNode(level) {
    const node = deck.ctx.createGain();
    node.gain.value = level;
    return node;
  }

  return {
    // Decodes are slow anyway; analyzing a song as soon as it's decoded keeps the
    // moment of the transition smooth.
    // One analysis per task, so the page (and the game's frames) never freezes for long.
    prepare(buffer) {
      const steps = [() => introGrid(buffer), () => gridBefore(buffer, mixOutPoint(buffer, true)), () => gridBefore(buffer, mixOutPoint(buffer, false))];
      steps.forEach((step, i) => setTimeout(step, i * 300));
    },

    // Where (seconds into the song) it should be mixed out by; short = short mixes.
    mixOutPoint,

    // Where (seconds into the song) a song comes in; short = short mixes.
    entryPoint: (buffer, short) => entry(buffer, short).at,

    // Where (seconds into the song) the queue should call mixInto: a little before the
    // blend has to start for it to end at mixOutPoint.
    mixPoint(buffer, short = false) {
      const end = mixOutPoint(buffer, short);
      const beats = gridBefore(buffer, end);
      return Math.max(0, end - blendLength(beats, short) - barOf(beats));
    },

    // Where (seconds into the song) the mix itself starts, for a style ("blend" or "echo").
    mixStartPoint(buffer, short, style) {
      const end = mixOutPoint(buffer, short);
      const beats = gridBefore(buffer, end);
      return Math.max(0, end - (style === "echo" ? barOf(beats) : blendLength(beats, short)));
    },

    // The next downbeat (seconds into the song) after `position`, on the beat grid the song
    // gets mixed out on.
    nextDownbeat(buffer, short, position) {
      return downbeatAfter(gridBefore(buffer, mixOutPoint(buffer, short)), position);
    },

    // The beat grid ({ bpm, first downbeat }, song seconds) of a song around a point in it.
    beatGridAt(buffer, seconds) {
      return gridNear(buffer, seconds, seconds - 10);
    },

    // How loud a song is around a point, relative to its median level (1 = typical).
    energyAt(buffer, seconds) {
      const { levels, median } = bounds(buffer);
      const index = Math.max(0, Math.min(levels.length - 1, Math.round(seconds * 2)));
      return median ? levels[index] / median : 1;
    },

    // Seconds per beat of the playing song where it gets mixed out (at the current speed).
    beatSeconds(buffer, short = false) {
      return 60 / gridBefore(buffer, mixOutPoint(buffer, short)).bpm / (handSpeed * nudge);
    },

    // How the playing song would mix into `next` (an AudioBuffer): "blend" or "echo".
    styleInto(next, { mixOutAt, fromBpm, toBpm, short = false } = {}) {
      if (!deck.buffer) return null;
      return styleFor(deck.buffer, next, { mixOutAt: mixOutAt ?? bounds(deck.buffer).end, fromBpm, toBpm, nudge, short })
        .blend
        ? "blend"
        : "echo";
    },

    // Holds the speed where it is (while the hands perform a mix), or lets go.
    holdSpeed(on) {
      speedHeld = Boolean(on);
    },

    // Back to normal speed (the hands' speed setting forgotten, a mix's tempo nudge kept).
    resetSpeed() {
      handSpeed = 1;
      setDeckSpeed(nudge);
    },

    // Manual song changes: no tail, no nudge.
    cancel() {
      finish();
      stopGlide();
      setNudge(1);
    },

    // Mixes from the playing song into `next` (an AudioBuffer), so the playing song is
    // gone by mixOutAt (seconds into it; its fading ending by default, 0 = right away,
    // on the next downbeat). fromBpm/toBpm are the library's tempos, to sanity-check
    // detection. short: short mixes (shorter blends, the next song comes in where it gets
    // going). hands: for a blend, schedule nothing and hand back live controls instead
    // (result.hands, see below), for the hands to perform it. Once the new song is on the
    // deck, resolves with what it did ({ style: "blend" | "echo", hands, ... }), or with
    // null if stillWanted() turned false (or the music stopped) while waiting for the right beat.
    // style: "blend" or "cut" to insist on one (the game decides it ahead, from the library).
    async mixInto(next, { mixOutAt, startAt = null, style: wanted = null, fromBpm, toBpm, short = false, hands = false, stillWanted = () => true } = {}) {
      finish();
      stopGlide();
      const { ctx } = deck;
      const current = deck.buffer;
      const now = () => Math.max(0, deck.position() % current.duration);
      const speed = () => handSpeed * nudge;
      const outBy = Math.min(mixOutAt ?? bounds(current).end, bounds(current).end);
      // A manual blend (the DJ Deck's hands, with no downbeat or style asked for) accepts
      // any pair: no tempo analysis, speed matching or beat wait. AirMix's mixes (startAt,
      // style) are beat-matched on the downbeat the game picked.
      const manual = hands && startAt === null && wanted === null;
      const style = manual
        ? { blend: true, knownOut: false, beatsOut: { bpm: null }, beatsIn: { bpm: null }, ratio: 1 }
        : styleFor(current, next, { mixOutAt: Math.max(outBy, now()), fromBpm, toBpm, nudge, short });
      const { knownOut, beatsOut, beatsIn } = style;
      let { blend, ratio } = style;
      if (wanted === "cut") blend = false;
      if (wanted === "blend" && !blend) {
        blend = true; // a plain crossfade: the tempos can't be matched, so no nudge
        ratio = 1 / nudge;
      }

      // Where in the current song the transition starts, and how long a blend gets.
      let at;
      let length;
      const plan = () => {
        const earliest = now() + scheduleAhead * 2;
        if (startAt !== null) {
          at = startAt; // the caller (djGame.js) picked the downbeat; a passed one starts late, in phase
          length = blendLength(beatsOut, short);
          return;
        }
        if (manual) {
          at = now() + scheduleAhead;
          length = short ? shortBlendSeconds : blendSeconds;
          return;
        }
        if (blend) {
          length = blendLength(beatsOut, short);
          // A move made just after the downbeat (hands) still counts for that downbeat.
          const from = hands ? now() - 60 / beatsOut.bpm : earliest;
          at = downbeatAfter(beatsOut, Math.max(from, outBy - length));
          // Late (e.g. a skip near the end)? A shorter blend, down to one bar, else echo out.
          const room = Math.floor((current.duration - 0.05 - at) / barOf(beatsOut)) * barOf(beatsOut);
          length = Math.min(length, room);
          if (length < barOf(beatsOut)) blend = false;
        }
        if (!blend) {
          const wanted = Math.max(earliest, outBy - barOf(beatsOut));
          at = knownOut ? downbeatAfter(beatsOut, wanted) : wanted;
          if (at > current.duration - 0.2) at = earliest;
        }
      };
      plan();
      const beat = (knownOut ? 60 / beatsOut.bpm : 0.5) / speed();
      // An echo-out sends the last beat into the echo, so it starts one beat early.
      const lead = () => scheduleAhead + (blend || hands ? 0 : beat);

      // Wait for that moment (re-checking: the hands can change the speed meanwhile).
      for (;;) {
        if (!stillWanted() || deck.buffer !== current || !deck.playing || !deck.source) return null;
        const wait = (at - now()) / speed() - lead();
        if (wait <= 0.02) break;
        await sleep(Math.min(wait * 1000, 250));
      }
      if ((at - now()) / speed() < scheduleAhead / 2) plan(); // woke up late (e.g. a background tab)

      // A downbeat that just passed (a move made a little late): start now, with the next
      // song jumped ahead by as much, so the beats still line up.
      const startsAt = Math.max(at, now() + scheduleAhead);
      const late = startsAt - at;
      const when = ctx.currentTime + (startsAt - now()) / speed();
      const outNudge = nudge;
      // The current song becomes the tail. It's the same source, so not a sample is skipped.
      const source = deck.source;
      source.loop = false;
      deck.source = null;
      const tailFilter = filterNode("highpass", openHz);
      const tailGain = gainNode(1);
      source.disconnect();
      source.connect(tailFilter).connect(tailGain).connect(deck.filter);
      const nodes = [tailFilter, tailGain];

      // The next song, scheduled on the downbeat: what Deck.play() does, with a start time.
      const comesIn = manual ? bounds(next).start : entry(next, short).at;
      nudge = manual ? 1 : blend ? outNudge * ratio : 1;
      const rate = handSpeed * nudge;
      const offset = blend && !manual
        ? (downbeatAfter(beatsIn, Math.max(0, comesIn - 0.05)) + (late / (handSpeed * outNudge)) * rate) % next.duration
        : comesIn;
      const incoming = ctx.createBufferSource();
      incoming.buffer = next;
      incoming.loop = true;
      incoming.playbackRate.value = rate;
      const inGain = gainNode(0);
      const inFilter = filterNode("highpass", blend && !manual ? bassCutHz : openHz);
      incoming.connect(inGain).connect(inFilter).connect(deck.filter);
      nodes.push(inGain, inFilter);
      incoming.start(when, offset);
      Object.assign(deck, { buffer: next, source: incoming, offset, anchorTime: when, rate, playing: true });

      let ends = null;
      let controls = null;
      if (hands) {
        // The hands perform it: live levels for both songs, the bass swap on a downbeat,
        // and finish() for when they're done (or the AI takes over). When the tempos are
        // too far apart to blend it's a cut: echoOut() throws the old song into an echo.
        const bar = 4 * beat;
        const live = () => tail?.incoming === incoming;
        const nextDownbeat = () => when + Math.max(0, Math.ceil((ctx.currentTime + scheduleAhead - when) / bar)) * bar;
        const setLevel = (param, value) =>
          param.setTargetAtTime(Math.max(0, Math.min(1, value)), Math.max(ctx.currentTime, when), 0.06);
        let swapAt = null;
        let closing = false;
        // The echo is always listening to the old song, so a throw catches its last beat
        // (AirMix's mixes; a manual blend only moves the two levels, so it has none).
        let echoGain = null;
        if (!manual) {
          const delay = ctx.createDelay(2);
          delay.delayTime.value = Math.min(1.9, beat * 0.75);
          const feedback = gainNode(echoFeedback);
          const echoTone = filterNode("highpass", 400);
          echoGain = gainNode(0);
          tailGain.connect(delay);
          delay.connect(feedback).connect(delay);
          delay.connect(echoTone).connect(echoGain).connect(deck.filter);
          nodes.push(delay, feedback, echoTone, echoGain);
        }
        controls = {
          style: blend ? "blend" : "cut",
          barSeconds: bar,
          get startsIn() {
            return when - ctx.currentTime; // seconds until the next song comes in (on a downbeat)
          },
          get done() {
            return !live();
          },
          setIncoming(level) {
            if (live() && !closing) setLevel(inGain.gain, level);
          },
          setOutgoing(level) {
            if (live() && !closing) setLevel(tailGain.gain, level);
          },
          // Only one bass line at a time: the old song's goes, the new one's comes in.
          swapBass() {
            // Manual blending leaves both songs' sound intact; only their levels change.
            if (manual) return null;
            if (!live() || swapAt !== null) return swapAt;
            swapAt = nextDownbeat();
            tailFilter.frequency.setValueAtTime(openHz, Math.max(ctx.currentTime, swapAt - beat));
            tailFilter.frequency.exponentialRampToValueAtTime(bassCutHz, swapAt);
            inFilter.frequency.setValueAtTime(bassCutHz, Math.max(ctx.currentTime, swapAt - beat));
            inFilter.frequency.exponentialRampToValueAtTime(openHz, swapAt);
            return swapAt;
          },
          // Thins the old song out once the bass lines have swapped: 0 keeps it as it is, 1
          // leaves only its highs (the high-pass sweeps up to thinHz).
          thinOutgoing(amount) {
            if (!live() || closing || swapAt === null || ctx.currentTime < swapAt) return;
            const hz = bassCutHz * (thinHz / bassCutHz) ** Math.max(0, Math.min(1, amount));
            tailFilter.frequency.setTargetAtTime(hz, ctx.currentTime, 0.08);
          },
          // Throws the old song into an echo (its dry sound cuts out) and lands the mix as it rings.
          echoOut() {
            if (!live() || closing) return;
            if (!echoGain) return controls.finish(); // a manual blend has no echo: just land it
            const from = Math.max(ctx.currentTime, when);
            echoGain.gain.setValueAtTime(1, from);
            echoGain.gain.linearRampToValueAtTime(0, from + echoRingSeconds);
            tailGain.gain.cancelScheduledValues(from);
            tailGain.gain.setValueAtTime(tailGain.gain.value, from);
            tailGain.gain.linearRampToValueAtTime(0, from + beat / 2);
            controls.finish(echoRingSeconds);
          },
          // Eases the new song to full and the old one out over `seconds`, then ends the mix.
          finish(seconds = bar) {
            if (!live() || closing) return;
            closing = true;
            controls.swapBass();
            const from = Math.max(ctx.currentTime, when);
            for (const [param, to] of [[inGain.gain, 1], [tailGain.gain, 0]]) {
              param.cancelScheduledValues(from);
              param.setValueAtTime(param.value, from);
              param.linearRampToValueAtTime(to, from + seconds);
            }
            finishAt(from + seconds, blend);
          },
        };
      } else if (blend) {
        // In over the first half, bass lines swap on the middle downbeat, out over the second half.
        const half = when + length / 2 / (handSpeed * outNudge);
        ends = when + length / (handSpeed * outNudge);
        fade(inGain.gain, true, when, half);
        fade(tailGain.gain, false, half, ends);
        tailFilter.frequency.setValueAtTime(openHz, half - beat);
        tailFilter.frequency.exponentialRampToValueAtTime(bassCutHz, half);
        inFilter.frequency.setValueAtTime(bassCutHz, half - beat);
        inFilter.frequency.exponentialRampToValueAtTime(openHz, half);
      } else {
        // The last beat repeats into the distance while the next song fades in.
        const delay = ctx.createDelay(2);
        delay.delayTime.value = Math.min(1.9, beat * 0.75);
        const feedback = gainNode(echoFeedback);
        const echoTone = filterNode("highpass", 400);
        const echoOut = gainNode(1);
        tailGain.connect(delay);
        delay.connect(feedback).connect(delay);
        delay.connect(echoTone).connect(echoOut).connect(deck.filter);
        nodes.push(delay, feedback, echoTone, echoOut);
        tailGain.gain.setValueAtTime(1, when);
        tailGain.gain.linearRampToValueAtTime(0, when + beat / 2);
        echoOut.gain.setValueAtTime(1, when);
        echoOut.gain.linearRampToValueAtTime(0, when + echoRingSeconds);
        inGain.gain.setValueAtTime(0, when);
        inGain.gain.linearRampToValueAtTime(1, when + echoFadeInSeconds);
        ends = when + echoRingSeconds;
      }

      tail = {
        source,
        nodes,
        incoming,
        nudge: outNudge,
        timer: null,
        // A skip, seek or pause replaces or stops the new song: drop the tail with it.
        watch: setInterval(() => {
          if (deck.source !== incoming) finish();
        }, 100),
      };
      if (ends !== null) finishAt(ends, blend);
      const round = (value) => Math.round(value * 100) / 100;
      return {
        style: hands ? controls.style : blend ? "blend" : "echo",
        hands: controls,
        seconds: ends === null ? null : round(ends - when),
        from: { bpm: beatsOut.bpm, trusted: knownOut, mixAt: round(at) },
        to: { bpm: beatsIn.bpm, trusted: manual ? false : trusted(beatsIn.bpm, toBpm), startsAt: round(offset), speed: round(nudge) },
      };
    },
  };
}
