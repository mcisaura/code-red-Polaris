// AirMix: a DJ set as a rhythm game, played with your fingertips on the camera view.
//
// Each target is a shape of four dots: your left thumb and index fingertip (blue) and
// your right thumb and index fingertip (green). Shapes fly in about 2 seconds before
// their beat, shrinking onto their place; have your fingertips on the dots as they land.
// Those four fingertips are the DJ controls, so the chart is choreography:
//   - the right thumb–index gap is the filter: wide = open, narrowing through a build-up
//     closes it, and it snaps open on the drop;
//   - the distance between your hands is the volume: wider on drops, closer in quiet parts;
//   - the left gap is the speed, which stays at 1.00× while you play (it's held);
//   - where the shape sits moves with the music (sways, bobs, circles, steps), one shape
//     every beat or two, each joined to the next so you see where you're going.
// Hitting the shapes is how a good DJ would move right then; your hands really set the
// filter and volume, so missing them sounds like it.
//
// You pick the set before you play (queue.playSet); the mixes are part of the chart:
//   - Blend (tempos close): your right thumb and index slide the new song in along a
//     track, then your left ones slide the old song out. Not following? The AI does it.
//   - Cut (tempos far apart): one shape on the downbeat; the new song slams in and the
//     old one is thrown into an echo.
//
// Shapes hit within ~160 ms of the beat are Perfect, within ~320 ms Good: both hands in
// place, and the right pinch about as open as the shape asks (that's the filter). Hits
// clap on their beat. Slides have a tick on every beat: each one your fingers are on
// clicks and keeps the combo going. How well you play is the crowd's hype. With nobody in frame, nothing
// counts as a miss. The last song fades out at its end and onSetEnd gets your results.
//
// The page calls update() every camera frame with its hands (ai-dj.html's hand objects:
// thumb and index = the fingertips in camera-canvas pixels, pose).

const approachBeats = 3; // shapes show up this many beats early,
const approachMinMs = 1600; // but never less than this
const approachMaxMs = 2400; // or more than this
const perfectMs = 160;
const goodMs = 320;
const dotSize = 0.05; // a target dot's radius, as a share of the stage height
const reach = 0.1; // your pinch point within this share of the stage height of a target's center counts
const pinchTolerance = 0.3; // and your right pinch this close to the target's (0 closed – 1 open, as calibrated)
// The mercy rule: with one hand on its dots, the other counts if it's close (about touching
// its pair) with a looser pinch. Such a shape is a Good at best, never a Perfect.
const mercyReach = 0.2;
const mercyPinchTolerance = 0.5;
const followReach = 0.18; // fingertips within this of a slider's dots are following it
const gapBars = { short: 2, full: 4 }; // the new song's slide
const outBars = 2; // the old song's slide
const leadBars = 4; // a mix (or the set's end) is planned at least this many bars ahead
const phraseBars = 4; // and moved on by whole phrases to get there
const idleMs = 2000; // no hands this long: shapes are skipped, not missed
const hypeWeight = 0.08; // how fast the crowd's hype follows your hits
const approachMs = (beatMs) => Math.max(approachMinMs, Math.min(approachMaxMs, approachBeats * beatMs));

// The choreography, in DJ-control terms. Shapes turn these into dot positions with your
// pinch calibration and your hand's size right now, so fingertips on the dots really set
// that sound (closer to the camera, bigger hands, wider gaps).
const moves = {
  volume: { quiet: 0.45, normal: 0.6, loud: 0.7, drop: 0.78 }, // the distance between your hands
  filterOpen: 1.08, // the right pinch a bit past fully open: the filter is off
  buildUpHz: 350, // the filter closes to this at the end of a build-up
  leftPinch: 0.5, // the left pinch half open (it's the speed, held at 1.00× anyway)
  tilt: 0.35, // radians: index fingertips lean in toward each other
};
// The page's control mapping, used until the page tells us its own (see controlMap).
const defaultControls = { pinchClosed: 0.05, pinchOpen: 0.9, freqMin: 150, freqMax: 10000, betweenClosed: 0.04, betweenOpen: 0.8 };
const defaultPalm = 0.11; // a hand's palm size (as the page measures it) before we've seen it, in shares of the stage height
// Targets stay inside this part of the camera view (stage shares): near the edges, hands
// drift partly out of frame and the tracking gets shaky.
const safe = { left: 0.18, right: 0.82, top: 0.28, bottom: 0.68 };
const inPath = [[0.78, 0.3], [0.56, 0.6]]; // the right hand slides the new song in
const outPath = [[0.44, 0.5], [0.22, 0.5]]; // the left hand slides the old song out
const cutShape = { cx: 0.5, cy: 0.46, volume: moves.volume.drop, rightPinch: moves.filterOpen };

const colors = { left: "#1e95e3", right: "#5cb82c", accent: "#f5861f" };
const gameFont = '"Trebuchet MS", "Segoe UI", sans-serif'; // Windows XP's title-bar face

const clamp01 = (value) => Math.max(0, Math.min(1, value));
// Small seeded random numbers, so a song's chart is the same every time it plays.
function seeded(text) {
  let seed = 2166136261;
  for (const char of text) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// controlMap: () => the page's pinch calibration and control ranges ({ pinchClosed,
// pinchOpen, freqMin, freqMax, betweenClosed, betweenOpen }), read live.
// onSetEnd(results): the set is over (its last song faded out): { score, perfect, good,
// miss, best, accuracy (0-1), judged (the hits judged; 0 when none) }.
export function createDjGame(queue, { stage, camera, rail, deck, startEnabled = true, controlMap = () => defaultControls, onSetEnd = () => {} }) {
  const canvas = document.createElement("canvas");
  canvas.className = "djGame";
  stage.append(canvas);
  const context = canvas.getContext("2d");
  const card = buildCard(queue, rail);
  const progress = buildProgress(stage);
  const songStarts = new Map(); // song id → where in it (seconds) it became the one playing
  const songShares = new Map(); // song id → how far through it the bar has got (never goes back)

  let enabled = startEnabled;
  let generation = 0; // pending set endings belong to the game that created them
  let wasActive = false;
  let lastFrame = 0;
  let lastHands = 0; // when a hand was last in frame
  let sounds = null;
  // Your fingertips, in stage pixels: { left: { thumb, index } | null, right: ... }.
  const tips = { left: null, right: null };
  const palms = { left: null, right: null }; // each hand's palm size (stage px), as last seen

  // The chart: shapes by key, generated a little ahead of the music.
  const shapes = new Map();
  let chartSong = null;
  let charted = -1; // the last bar charted
  let random = Math.random;
  let pattern = null; // the current phrase's movement
  let step = 0; // shapes so far in this song (the movement's position)
  // The shapes' numbers, like osu!: they count up, and start again at 1 after a moment
  // with nothing on screen (a break, a mix, a new song). lastTime: the last shape's beat.
  const numbering = { lastTime: -Infinity, number: 0 };
  let lastPlaced = null; // { time, cy, pins }: the last shape charted, to keep the next one clear of it

  let mix = null; // the next mix: planned on the playing song, then performed in real time
  let pausedAt = null; // performance.now() when paused (the audio clock is suspended too)
  let finishing = false; // the last song is fading out: the set can't be paused or restarted any more
  const finaleFadeSeconds = 3; // queue.endSet's fade; the last song's cue leaves room for it
  const freshScore = () => ({ combo: 0, best: 0, hits: 0, judged: 0, points: 0, hype: 0.5, perfect: 0, good: 0, miss: 0 });
  const score = freshScore();
  const effects = [];

  // ---- geometry -------------------------------------------------------------------

  const size = () => ({ width: canvas.clientWidth, height: canvas.clientHeight });
  const point = ([x, y]) => ({ x: x * size().width, y: y * size().height });
  const dot = () => size().height * dotSize;
  // Camera-canvas pixels → stage pixels.
  function stageScale() {
    const { width, height } = size();
    return Math.min(width / camera.width, height / camera.height);
  }
  function toStage(p) {
    const { width, height } = size();
    const scale = Math.min(width / camera.width, height / camera.height);
    return { x: p.x * scale + (width - camera.width * scale) / 2, y: p.y * scale + (height - camera.height * scale) / 2 };
  }
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const middle = (pair) => lerp(pair.thumb, pair.index, 0.5);
  function along(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return clamp01(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy));
  }

  // A shape as pinch targets ("pins"): where each hand's pinch sits (stage shares) and how
  // open it is (0 = fully closed, 1 = fully open, as calibrated). The hands sit as far
  // apart as the volume asks for.
  function makeShape({ cx, cy, volume, rightPinch }) {
    const map = controlMap();
    const spread = Math.min(safe.right - safe.left, map.betweenClosed + volume * (map.betweenOpen - map.betweenClosed));
    const x = Math.max(safe.left + spread / 2, Math.min(safe.right - spread / 2, cx));
    const y = Math.max(safe.top, Math.min(safe.bottom, cy));
    return {
      left: { at: [x - spread / 2, y], pinch: moves.leftPinch },
      right: { at: [x + spread / 2, y], pinch: rightPinch },
    };
  }
  // Whether two shapes' dots would overlap: a hand's pair is about a dot wide and two
  // dots plus the pinch gap tall (stage shares).
  const clearX = 0.11;
  const clearY = 0.24;
  function overlaps(a, b) {
    return ["left", "right"].some(
      (side) => a[side] && b[side] && Math.abs(a[side].at[0] - b[side].at[0]) < clearX && Math.abs(a[side].at[1] - b[side].at[1]) < clearY,
    );
  }
  // One hand's pinch target at a point (open: the filter off for the right hand).
  function pairAt(at, side, pinch = side === "right" ? moves.filterOpen : moves.leftPinch) {
    return { at, pinch };
  }
  // How open the right pinch has to be for a filter frequency.
  function pinchForHz(hz) {
    const map = controlMap();
    return Math.log(hz / map.freqMin) / Math.log(map.freqMax / map.freqMin);
  }
  // A pinch target's two dots (stage shares): the fingertip gap that gives that pinch for
  // this hand at its size right now (the page measures the pinch relative to the palm).
  function resolvePin(pin, side) {
    const map = controlMap();
    const { width, height } = size();
    const palm = palms[side] ?? palms[side === "left" ? "right" : "left"] ?? height * defaultPalm;
    const gap = (map.pinchClosed + pin.pinch * (map.pinchOpen - map.pinchClosed)) * palm; // px
    const inward = side === "left" ? 1 : -1;
    // Index fingertip above the thumb, leaning in toward the other hand.
    const dx = (inward * Math.sin(moves.tilt) * gap) / 2 / (width || 1);
    const dy = (Math.cos(moves.tilt) * gap) / 2 / (height || 1);
    const [x, y] = pin.at;
    return { thumb: [x - dx, y + dy], index: [x + dx, y - dy] };
  }
  function resolve(pins) {
    const dots = {};
    for (const side of ["left", "right"]) if (pins[side]) dots[side] = resolvePin(pins[side], side);
    return dots;
  }
  // A target: its pins, with dots worked out whenever they're needed.
  function target(pins, extra) {
    return {
      ...extra,
      pins,
      best: {},
      get dots() {
        return resolve(this.pins);
      },
    };
  }

  // ---- scoring --------------------------------------------------------------------

  // when: the shape's beat (performance.now() ms), so its clap lands on it.
  function judge(target, verdict, when = performance.now(), at = null) {
    target.verdict = verdict;
    if (verdict === "skip") return;
    score.judged += 1;
    score[verdict] += 1;
    if (verdict === "miss") {
      score.combo = 0;
    } else {
      score.hits += 1;
      score.combo += 1;
      score.best = Math.max(score.best, score.combo);
      score.points += verdict === "perfect" ? 1 : 0.6;
      sounds ??= deck?.ctx ? createSounds(deck.ctx) : null;
      const delay = Math.max(0, (when - performance.now()) / 1000);
      sounds?.clap(delay, verdict === "perfect" ? 1 : 0.6);
    }
    const value = verdict === "perfect" ? 1 : verdict === "good" ? 0.6 : 0;
    score.hype += (value - score.hype) * hypeWeight;
    queue.setCrowd(score.hype);
    effects.push({ text: verdict === "perfect" ? "Perfect" : verdict === "good" ? "Good" : "Miss", at: at ?? [0.5, 0.42], born: performance.now(), verdict });
  }

  // Where each hand is on its target: "on" (the pinch point, between thumb and index, on
  // its dots, and for the right hand the pinch about as open as asked: that's the filter;
  // the left pinch is the speed, held at 1.00×, so any will do), "near" (close enough for
  // the mercy rule), or false.
  function onTarget(pins) {
    const hit = {};
    for (const side of ["left", "right"]) {
      const pin = pins[side];
      const hand = tips[side];
      if (!pin || !hand) {
        hit[side] = false;
        continue;
      }
      const away = distance(middle(hand), point(pin.at)) / size().height;
      const pinchOff = side === "left" || hand.pinch === undefined ? 0 : Math.abs(hand.pinch - Math.min(1, pin.pinch));
      if (away <= reach && pinchOff <= pinchTolerance) hit[side] = "on";
      else if (away <= mercyReach && pinchOff <= mercyPinchTolerance) hit[side] = "near";
      else hit[side] = false;
    }
    return hit;
  }

  // Watches one shape: the best moment each hand was on its dots around the beat.
  function track(target, when, now, present) {
    if (target.verdict) return;
    const offset = now - when;
    if (Math.abs(offset) <= goodMs) {
      const hit = onTarget(target.pins);
      target.near ??= {};
      for (const side of ["left", "right"]) {
        if (target.pins[side] && hit[side] === "on") target.best[side] = Math.min(target.best[side] ?? Infinity, Math.abs(offset));
        if (target.pins[side] && hit[side]) target.near[side] = true; // on or near: enough for the mercy rule
      }
      const sides = ["left", "right"].filter((side) => target.pins[side]);
      if (sides.every((side) => target.best[side] <= perfectMs) && offset >= -perfectMs) judge(target, "perfect", when, target.center);
    }
    if (!target.verdict && offset > goodMs) {
      const sides = ["left", "right"].filter((side) => target.pins[side]);
      const landed = sides.filter((side) => target.best[side] !== undefined);
      // Both hands on it, pinch included (half a shape is a wrong filter or a wrong volume).
      if (landed.length === sides.length) judge(target, landed.every((side) => target.best[side] <= perfectMs) ? "perfect" : "good", when, target.center);
      // The mercy rule: one hand on it and the other close by is a Good.
      else if (landed.length && sides.every((side) => target.near?.[side])) judge(target, "good", when, target.center);
      else judge(target, present ? "miss" : "skip", when, target.center);
    }
  }

  // ---- the chart ------------------------------------------------------------------

  const patterns = ["sway", "bob", "circle", "step"];
  // Where the shape sits on a slot of a phrase's movement.
  function placement(name, slot) {
    switch (name) {
      case "sway":
        return [slot % 2 ? 0.6 : 0.4, slot % 2 ? 0.58 : 0.34];
      case "bob":
        return [0.5, slot % 2 ? 0.6 : 0.34];
      case "circle": {
        const angle = (slot / 4) * Math.PI * 2;
        return [0.5 + Math.cos(angle) * 0.1, 0.47 + Math.sin(angle) * 0.15];
      }
      default:
        return [[0.4, 0.5, 0.6, 0.5][slot % 4], [0.34, 0.47, 0.6, 0.47][slot % 4]];
    }
  }

  // Shapes for the bars coming up, from the beat grid and how loud the song gets.
  function chart(playback, beatsAhead) {
    if (chartSong !== playback.songId) {
      chartSong = playback.songId;
      Object.assign(numbering, { lastTime: -Infinity, number: 0 });
      lastPlaced = null;
      charted = -1;
      random = seeded(String(playback.songId));
      shapes.clear();
      step = 0;
    }
    const grid = queue.beatGridAt(playback.position);
    if (!grid) return;
    const bar = 240 / grid.bpm;
    const beatSeconds = 60 / grid.bpm / playback.rate;
    const horizon = playback.position + (beatsAhead * bar) / 4;
    let k = Math.max(charted + 1, Math.floor((playback.position - grid.first) / bar));
    for (; grid.first + k * bar <= horizon; k += 1) {
      charted = k;
      const downbeat = grid.first + k * bar;
      // A bar too close to show its first shape a whole approach early (the set's first
      // bars, say) stays empty.
      if (downbeat < playback.position + (approachMs(beatSeconds * 1000) / 1000) * playback.rate) continue;
      if (k % 4 === 0 || !pattern) pattern = patterns[Math.floor(random() * patterns.length)];
      const energy = queue.energyAt(downbeat + bar / 2);
      const before = queue.energyAt(downbeat - bar / 2);
      const ahead = queue.energyAt(downbeat + bar * 2.5);
      const drop = energy > 1 && energy > before * 1.3; // the bar where the energy jumps
      const quiet = energy < 0.6;
      const loud = energy > 1.15;
      // The two bars before a jump are a build-up: the filter closes over them.
      const buildUp = !drop && ahead > Math.max(1, energy * 1.3);
      const lastBarOfBuild = buildUp && queue.energyAt(downbeat + bar * 1.5) > Math.max(1, energy * 1.3);
      // Room to breathe: a shape a bar in normal parts (two every other bar), two in loud
      // ones, and one every other bar when it's quiet.
      const beats = quiet ? (k % 2 ? [] : [0]) : loud ? [0, 2] : k % 2 ? [0, 2] : [0];
      for (const beat of beats) {
        const time = downbeat + (beat * bar) / 4;
        if (quietAt(time)) continue; // the mix has its own targets (and the set's end, none)
        // Every shape gets its whole approach (a new song's first ones too, after a mix).
        if (((time - playback.position) / playback.rate) * 1000 < approachMs(beatSeconds * 1000)) continue;
        let [cx, cy] = placement(pattern, step);
        step += 1;
        let volume = quiet ? moves.volume.quiet : loud ? moves.volume.loud : moves.volume.normal;
        let rightPinch = moves.filterOpen;
        if (drop && beat === 0) volume = moves.volume.drop;
        if (buildUp) {
          const progress = (lastBarOfBuild ? 0.5 : 0) + (beat + 1) / 8; // closes over the build
          // The filter closes from open toward buildUpHz (exponentially, like it sounds).
          rightPinch = moves.filterOpen - (moves.filterOpen - pinchForHz(moves.buildUpHz)) * clamp01(progress);
          cy -= 0.08 * clamp01(progress); // and the shape rises with it
        }
        let pins = makeShape({ cx, cy, volume, rightPinch });
        // On screen together with the last shape and on top of it? Move it a whole pair's
        // height up or down (where there's room), so two shapes never pile up.
        const approachSongSeconds = (approachMs(beatSeconds * 1000) / 1000) * playback.rate;
        if (lastPlaced && time - lastPlaced.time < approachSongSeconds + (goodMs / 1000) * playback.rate && overlaps(pins, lastPlaced.pins)) {
          const up = lastPlaced.cy - clearY;
          const down = lastPlaced.cy + clearY;
          cy = up >= safe.top || safe.bottom - lastPlaced.cy < lastPlaced.cy - safe.top ? Math.max(safe.top, up) : Math.min(safe.bottom, down);
          pins = makeShape({ cx, cy, volume, rightPinch });
        }
        lastPlaced = { time, cy, pins };
        const key = `${playback.songId}:${k}:${beat}`;
        // A new number run if the last shape was gone before this one shows up.
        const shows = time - approachSongSeconds;
        const gone = numbering.lastTime + (goodMs / 1000) * playback.rate;
        numbering.number = gone < shows ? 1 : numbering.number + 1;
        numbering.lastTime = time;
        shapes.set(key, target(pins, { key, song: playback.songId, time, center: [cx, cy], drop: drop && beat === 0, number: numbering.number }));
      }
    }
  }

  // ---- the mix --------------------------------------------------------------------

  // Song times kept clear of shapes: from the mix on.
  function quietAt(time) {
    return Boolean(mix) && time >= mix.cue - mix.bar / 2;
  }
  // Plans the next mix on the playing song (song seconds), or drops a stale plan.
  function planMix(playback) {
    if (mix && mix.song !== playback.songId && mix.state === "planned") mix = null;
    if (mix) return;
    // Not while the DJ is busy (talking over the last mix, say): the mix couldn't start.
    const next = queue.getUpNext();
    if (next?.mixing) return;
    // A next song that couldn't be downloaded drops out of the set (the one after it, or
    // the set's end, is next).
    if (next && queue.loadFailed(next.item.id)) {
      queue.remove(next.item.id);
      return;
    }
    // Nor while the next song is still downloading: this one plays on (with its shapes)
    // until it's ready, so the mix's first targets still get their whole approach.
    if (next && !queue.isReady(next.item.id)) return;
    const mixOut = queue.mixOutAt();
    if (mixOut === null) return;
    const grid = queue.beatGridAt(mixOut);
    const bar = 240 / grid.bpm;
    const short = queue.getState().dj.short;
    const gap = short ? gapBars.short : gapBars.full;
    const onBar = (time) => grid.first + Math.round((time - grid.first) / bar) * bar;
    // The mix lands mixOut, but never sooner than leadBars from now (time to see its
    // first targets coming): a song that came in by your last mix has
    // already played those bars, so its mix moves on by whole phrases.
    // The set's last song: it ends where it would have been mixed out (a little later,
    // like a mix, if it came in late).
    if (!next) {
      let end = onBar(mixOut);
      while (end < playback.position + leadBars * bar) end += phraseBars * bar;
      // The deck loops its source, so the fade must finish before the buffer ends (short songs).
      const latest = Math.max(0, playback.duration - finaleFadeSeconds - 0.5);
      mix = { song: playback.songId, state: "finale", bar, cue: Math.min(end, latest) };
      return;
    }
    let cue = onBar(mixOut - (gap + outBars) * bar);
    while (cue < playback.position + leadBars * bar) cue += phraseBars * bar;
    if (cue + (gap + outBars + 1) * bar > playback.duration) {
      queue.mixNow(); // no room left in this one: the AI mixes it
      return;
    }
    mix = {
      song: playback.songId,
      state: "planned", // → starting → blend | cut → landing → done (or "finale": the set ends at cue)
      bar,
      gap,
      cue,
      // When the mix is set up (it then waits for the cue).
      startAt: Math.max(playback.position, cue - 2 * bar),
      // Blend or cut, from the songs' tempos in the library: known right away (before the
      // next song has loaded), so the mix's targets can show up on time; the mix obeys it.
      style: styleOf(queue.getUpNext()?.item),
    };
  }

  function styleOf(item) {
    const choice = item && queue.getChoices().find((option) => option.item.id === item.id);
    return choice?.blends === false ? "cut" : "blend";
  }

  function startMix() {
    mix.state = "starting";
    const planned = mix;
    planned.style = styleOf(queue.getUpNext()?.item);
    queue.startHandMix({ startAt: planned.cue, style: planned.style }).then((controls) => {
      if (mix !== planned) return;
      if (!controls) {
        mix = null; // the AI mixed it after all (or there was nothing to mix)
        return;
      }
      const now = performance.now();
      const comesIn = now + controls.startsIn * 1000;
      const bar = controls.barSeconds * 1000;
      Object.assign(planned, {
        state: controls.style,
        controls,
        comesIn,
        swapAt: comesIn + planned.gap * bar,
        endAt: comesIn + (planned.gap + outBars) * bar,
        barMs: bar,
        inTicks: { passed: 0, held: 0, judged: false },
        outTicks: { passed: 0, held: 0, judged: false },
      });
      if (controls.style === "cut") {
        // The new song slams in on the downbeat and the old one gets thrown into an echo.
        controls.setIncoming(1);
        controls.echoOut();
        planned.heads = [target(makeShape(cutShape), { real: comesIn, center: [cutShape.cx, cutShape.cy] })];
      } else {
        planned.heads = [
          target({ right: pairAt(inPath[0], "right") }, { real: comesIn, center: inPath[0] }),
          target({ left: pairAt(outPath[0], "left") }, { real: planned.swapAt, center: outPath[0] }),
        ];
      }
    });
  }

  // While a blend runs: each slide's dots move on the beat; following fingertips set the level.
  function performBlend(now) {
    const { controls } = mix;
    if (controls.done) return finishMix();
    const slide = (path, from, to, side) => {
      const ideal = clamp01((now - from) / (to - from));
      const hand = tips[side];
      const a = point(path[0]);
      const b = point(path[1]);
      const pinch = hand && middle(hand);
      const following = pinch && now >= from && distance(pinch, lerp(a, b, ideal)) <= size().height * followReach;
      return { ideal, level: following ? along(pinch, a, b) : ideal, following };
    };
    mix.in = slide(inPath, mix.comesIn, mix.swapAt, "right");
    controls.setIncoming(now < mix.swapAt ? mix.in.level : 1);
    ticks(mix.inTicks, mix.comesIn, mix.swapAt, mix.in.following, inPath[1], now);
    if (now >= mix.swapAt) {
      controls.swapBass();
      mix.out = slide(outPath, mix.swapAt, mix.endAt, "left");
      // As the old song slides out it thins (its high-pass sweeps up) and drops back, and
      // at the end of the slide its last beat gets thrown into the echo.
      controls.setOutgoing(1 - 0.6 * mix.out.level);
      controls.thinOutgoing(mix.out.level);
      ticks(mix.outTicks, mix.swapAt, mix.endAt, mix.out.following, outPath[1], now);
      if (now >= mix.endAt) {
        controls.echoOut();
        mix.state = "landing";
      }
    }
  }

  // A slide's ticks, one per beat: each one your fingers are on clicks and keeps the
  // combo going, a missed one breaks it. When the slide ends it's graded on how many held.
  function ticks(state, from, to, following, end, now) {
    const beat = mix.barMs / 4;
    const total = Math.round((to - from) / beat);
    const due = Math.min(total, Math.floor((now - from) / beat));
    const present = now - lastHands < idleMs;
    while (state.passed < due) {
      state.passed += 1;
      if (following) {
        state.held += 1;
        score.combo += 1;
        score.best = Math.max(score.best, score.combo);
        sounds ??= deck?.ctx ? createSounds(deck.ctx) : null;
        sounds?.tick();
      } else if (present) {
        score.combo = 0;
      }
    }
    if (!state.judged && now >= to) {
      state.judged = true;
      const share = total ? state.held / total : 0;
      const verdict = share >= 0.8 ? "perfect" : share >= 0.4 ? "good" : present ? "miss" : "skip";
      judge({}, verdict, now, end);
    }
  }

  function finishMix() {
    mix = null;
    shapes.clear();
    chartSong = null;
  }

  // The set's over: the last song fades out, then the results.
  function finishSet() {
    finishMix();
    enabled = false;
    finishing = true;
    queue.holdControls({});
    const results = {
      score: Math.round(score.points * 100),
      perfect: score.perfect,
      good: score.good,
      miss: score.miss,
      best: score.best,
      accuracy: score.judged ? score.points / score.judged : 0,
      judged: score.judged, // 0: nothing was judged (no one in frame, say), so there's no grade
    };
    const mine = generation;
    queue.endSet(finaleFadeSeconds * 1000).then((ended) => {
      if (mine === generation && ended !== false) onSetEnd(results);
    });
  }

  // ---- every camera frame ---------------------------------------------------------

  function update(input, now) {
    lastFrame = now;
    if (pausedAt !== null) {
      queue.coachPing(); // still the game's set: the DJ's timer mustn't mix meanwhile
      return;
    }
    for (const side of ["left", "right"]) {
      const hand = input[side];
      tips[side] = hand?.thumb && hand?.index ? { thumb: toStage(hand.thumb), index: toStage(hand.index), pinch: hand.pinch } : null;
      if (hand?.palmPx) palms[side] = hand.palmPx * stageScale();
    }
    if (tips.left || tips.right) lastHands = now;
    const present = now - lastHands < idleMs;
    const active = enabled && queue.getState().dj.on;
    const mixing = Boolean(mix?.controls);
    // Speed holds at 1.00× while you play; the volume holds while you're mixing (your hands
    // move for the slides); the filter is always yours.
    queue.holdControls({ speed: active, volume: active && mixing });
    if (active && !wasActive) queue.resetSound();
    wasActive = active;
    if (!active) return;
    queue.coachPing(); // the game decides when to mix, not the DJ's timer

    const playback = queue.getPlayback();
    if (!playback.playing) return;
    const realAt = (songTime) => now + ((songTime - playback.position) / playback.rate) * 1000;

    if (mix?.state === "landing") {
      if (mix.controls.done) finishMix();
    } else if (mix?.state === "blend") {
      performBlend(now);
    } else if (mix?.state === "cut" && mix.controls.done) {
      finishMix();
    }
    if (!mix) planMix(playback);
    if (mix?.state === "planned" && playback.position >= mix.startAt) startMix();
    if (mix?.state === "finale" && playback.position >= mix.cue) return finishSet();

    // Shapes of the song (not during a mix: those wait until it's landed).
    if (!mix || mix.state === "planned" || mix.state === "starting" || mix.state === "finale") chart(playback, 12);
    for (const shape of shapes.values()) if (shape.song === playback.songId) track(shape, realAt(shape.time), now, present);
    // The mix's own shapes (where the slides start, the cut).
    if (mix?.heads) for (const head of mix.heads) track(head, head.real, now, present);
  }

  // ---- drawing --------------------------------------------------------------------

  // The progress bar: each song of the set, how far through it the set is (from where it
  // came in to where it gets mixed out), and which songs are downloaded.
  function renderProgress() {
    const { items, currentId, dj } = queue.getState();
    if (!enabled || !dj.on || !items.length) return progress.render(null);
    const playback = queue.getPlayback();
    const playing = items.findIndex((item) => item.id === currentId);
    if (playing !== -1 && playback.loaded && !songStarts.has(currentId)) songStarts.set(currentId, playback.position);
    let share = 0;
    if (playing !== -1 && playback.loaded) {
      const start = songStarts.get(currentId);
      const end = mix && mix.song === currentId && typeof mix.cue === "number" ? mix.cue : Math.max(queue.mixOutAt() ?? 0, playback.position + 1);
      share = Math.max(songShares.get(currentId) ?? 0, clamp01((playback.position - start) / Math.max(1, end - start)));
      songShares.set(currentId, share);
    }
    progress.render(
      items.map((item, index) => ({
        done: index < playing ? 1 : index === playing ? share : 0,
        loaded: index <= playing || queue.isReady(item.id),
      })),
      { song: playing + 1, songs: items.length },
    );
  }

  // One hand's two dots: where its thumb (hollow) and index fingertip (filled) go, the
  // gap between them set by your pinch calibration and hand size (how open the pinch is).
  // A closed pinch shows them touching, never stacked. Each dot shows the shape's number.
  // With approach (0–1), one ring around the pair closes in on it, landing on the beat.
  function fingerDots(pin, side, alpha, approach = null, { solid = false, number = null } = {}) {
    const { thumb, index } = resolvePin(pin, side);
    const c = point(pin.at);
    let t = point(thumb);
    let i = point(index);
    const r = dot();
    const gap = distance(t, i);
    if (gap < r * 1.3) {
      const dir = gap > 1e-6 ? { x: (i.x - t.x) / gap, y: (i.y - t.y) / gap } : { x: 0, y: -1 };
      const half = (r * 1.3) / 2;
      t = { x: c.x - dir.x * half, y: c.y - dir.y * half };
      i = { x: c.x + dir.x * half, y: c.y + dir.y * half };
    }
    context.save();
    context.globalAlpha = alpha;
    // The pinch: a bar between the two.
    context.lineWidth = Math.max(3, r * 0.2);
    context.strokeStyle = colors[side];
    context.beginPath();
    context.moveTo(t.x, t.y);
    context.lineTo(i.x, i.y);
    context.stroke();
    for (const [p, filled] of [[t, false], [i, true]]) {
      context.fillStyle = filled ? colors[side] : solid ? "rgba(255, 255, 255, 0.85)" : "rgba(255, 255, 255, 0.6)";
      context.beginPath();
      context.arc(p.x, p.y, r, 0, Math.PI * 2);
      context.fill();
      context.lineWidth = r * 0.28;
      context.strokeStyle = colors[side];
      context.stroke();
      // Luna gloss: a thin white inner rim.
      context.lineWidth = 1.5;
      context.strokeStyle = "rgba(255, 255, 255, 0.95)";
      context.beginPath();
      context.arc(p.x, p.y, r * 0.84, 0, Math.PI * 2);
      context.stroke();
      if (number !== null) {
        context.font = `italic bold ${Math.round(r * 1.05)}px ${gameFont}`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.lineJoin = "round";
        context.lineWidth = Math.max(3, r * 0.2);
        context.strokeStyle = "rgba(20, 30, 45, 0.85)";
        context.strokeText(String(number), p.x, p.y + r * 0.05);
        context.fillStyle = "#ffffff";
        context.fillText(String(number), p.x, p.y + r * 0.05);
      }
    }
    context.restore();
    if (approach !== null) approachRing(lerp(t, i, 0.5), distance(t, i) / 2 + r * 1.15, colors[side], approach, alpha);
  }

  // A shape: each hand's two dots (where they'll be from the moment they show up), the
  // hands joined by a faint line (orange on a drop), all four showing the shape's number.
  // A ring closes in on each hand's pair.
  // dim: a shape after the next one, drawn faint until it's next.
  function drawShape(pins, when, now, beatMs, { emphasis = false, number = null, dim = false } = {}) {
    const leadMs = approachMs(beatMs);
    if (when - now > leadMs || now - when > goodMs) return;
    const progress = clamp01(1 - (when - now) / leadMs);
    const alpha = clamp01(progress * 5) * (dim ? 0.4 : 1);
    if (pins.left && pins.right) {
      const a = point(pins.left.at);
      const b = point(pins.right.at);
      context.save();
      context.globalAlpha = alpha * (emphasis ? 0.95 : 0.55);
      context.strokeStyle = emphasis ? colors.accent : "#ffffff";
      context.lineWidth = emphasis ? 3 : 1.5;
      context.setLineDash([6, 6]);
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
      context.restore();
    }
    for (const side of ["left", "right"]) {
      const pin = pins[side];
      if (!pin) continue;
      fingerDots(pin, side, alpha, now < when ? progress : null, { number });
    }
  }

  // An approach ring, in segments like the XP progress bar: it starts wide and closes onto
  // its target (radius r) exactly on the beat.
  function approachRing(p, r, color, progress, alpha) {
    const radius = r * (1 + 1.2 * (1 - progress));
    const segments = 14;
    context.save();
    context.globalAlpha = alpha * (0.45 + 0.55 * progress);
    context.strokeStyle = color;
    context.lineWidth = Math.max(2.5, dot() * 0.18);
    for (let i = 0; i < segments; i += 1) {
      const start = (i / segments) * Math.PI * 2 - Math.PI / 2;
      context.beginPath();
      context.arc(p.x, p.y, radius, start + 0.06, start + (Math.PI * 2) / segments - 0.06);
      context.stroke();
    }
    context.restore();
  }

  // Dotted trails from each hand's target on one shape to the same hand's on the next.
  function followPoints(from, to, when, now, beatMs) {
    const leadMs = approachMs(beatMs);
    if (when - now > leadMs) return;
    context.save();
    context.globalAlpha = clamp01((1 - (when - now) / leadMs) * 4) * 0.75;
    for (const side of ["left", "right"]) {
      if (!from[side] || !to[side]) continue;
      const a = point(from[side].at);
      const b = point(to[side].at);
      const gap = distance(a, b);
      const clear = dot() * 2;
      if (gap < clear * 2) continue;
      context.fillStyle = colors[side];
      const count = Math.floor((gap - clear * 2) / (dot() * 1.3));
      for (let i = 1; i < count; i += 1) {
        const p = lerp(a, b, (clear + ((gap - clear * 2) * i) / count) / gap);
        context.beginPath();
        context.arc(p.x, p.y, dot() * 0.2, 0, Math.PI * 2);
        context.fill();
      }
    }
    context.restore();
  }

  // A slide's track, with the hand's target riding it on the beat.
  function slide(path, side, ball, following, alpha, tickCount = 0, ticksPassed = 0) {
    const a = point(path[0]);
    const b = point(path[1]);
    context.save();
    context.globalAlpha = alpha;
    context.lineCap = "round";
    context.lineWidth = size().height * 0.13;
    context.strokeStyle = "rgba(255, 255, 255, 0.22)";
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
    context.restore();
    // The ticks still to come (one a beat), and the end: where the slide stops.
    context.save();
    context.globalAlpha = alpha;
    context.fillStyle = "#ffffff";
    context.strokeStyle = colors[side];
    context.lineWidth = 2;
    for (let i = Math.max(1, ticksPassed + 1); i < tickCount; i += 1) {
      const p = lerp(a, b, i / tickCount);
      context.beginPath();
      context.arc(p.x, p.y, dot() * 0.3, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
    context.strokeStyle = colors[side];
    context.globalAlpha = alpha * 0.6;
    context.lineWidth = 2.5;
    context.setLineDash([5, 4]);
    context.beginPath();
    context.arc(b.x, b.y, dot() * 1.25, 0, Math.PI * 2);
    context.stroke();
    context.restore();
    if (ball === null) return;
    // The target riding the slide, in the ring your pinch needs to stay in: it lights up
    // while it's in it.
    const at = lerp(a, b, ball);
    context.save();
    context.globalAlpha = alpha;
    context.strokeStyle = following ? colors[side] : "rgba(255, 255, 255, 0.85)";
    context.lineWidth = following ? 6 : 2;
    context.beginPath();
    context.arc(at.x, at.y, size().height * followReach * 0.8, 0, Math.PI * 2);
    context.stroke();
    context.restore();
    fingerDots(pairAt([at.x / size().width, at.y / size().height], side), side, alpha, null, { solid: true });
  }

  function outlinedText(text, x, y, sizePx, color, alpha, align = "center") {
    context.save();
    context.globalAlpha = alpha;
    context.font = `italic bold ${sizePx}px ${gameFont}`;
    context.textAlign = align;
    context.textBaseline = "middle";
    context.lineJoin = "round";
    context.lineWidth = Math.max(3, sizePx * 0.16);
    context.strokeStyle = "rgba(20, 30, 45, 0.85)";
    context.strokeText(text, x, y);
    context.fillStyle = color;
    context.fillText(text, x, y);
    context.restore();
  }

  function draw() {
    requestAnimationFrame(draw);
    const now = pausedAt ?? performance.now(); // paused: everything holds still
    const { width, height } = size();
    const scale = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * scale)) canvas.width = Math.round(width * scale);
    if (canvas.height !== Math.round(height * scale)) canvas.height = Math.round(height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, height);
    card.render(score, enabled);
    renderProgress();
    if ((pausedAt === null && now - lastFrame > 1000) || !enabled || !queue.getState().dj.on) return; // camera off, or not playing

    const playback = queue.getPlayback();
    const grid = playback.loaded ? queue.beatGridAt(playback.position) : null;
    const beatMs = grid ? (60 / grid.bpm / playback.rate) * 1000 : 500;
    const realAt = (songTime) => now + ((songTime - playback.position) / playback.rate) * 1000;

    const upcoming = [...shapes.values()].filter((shape) => shape.song === playback.songId && !shape.verdict).sort((a, b) => a.time - b.time);
    for (let i = 1; i < upcoming.length; i += 1) followPoints(upcoming[i - 1].pins, upcoming[i].pins, realAt(upcoming[i].time), now, beatMs);
    for (const shape of [...upcoming].reverse()) {
      drawShape(shape.pins, realAt(shape.time), now, beatMs, { emphasis: shape.drop, number: shape.number, dim: shape !== upcoming[0] });
    }

    if (mix && (mix.state === "planned" || mix.state === "starting")) {
      // The mix's first targets, drawn from the plan with their whole approach (the mix
      // itself is only set up just before its downbeat).
      const when = realAt(mix.cue);
      if (mix.style === "cut") {
        drawShape(makeShape(cutShape), when, now, beatMs, { emphasis: true, number: 1 });
      } else if (when - now <= approachMs(beatMs)) {
        slide(inPath, "right", null, false, clamp01((1 - (when - now) / approachMs(beatMs)) * 4) * 0.8, Math.round(mix.gap * 4), 0);
        drawShape({ right: pairAt(inPath[0], "right") }, when, now, beatMs, { number: 1 });
      }
    }
    if (mix?.heads) {
      if (mix.state === "blend" || mix.state === "landing") {
        // Each track shows from its approach until its slide is over, then fades away.
        const fadeOut = (end) => clamp01(1 - (now - end) / 300);
        const beatsIn = Math.round(mix.gap * 4);
        const beatsOut = outBars * 4;
        if (now < mix.swapAt + 300) {
          const ball = now >= mix.comesIn && now <= mix.swapAt ? mix.in?.ideal ?? 0 : null;
          slide(inPath, "right", ball, mix.in?.following, fadeOut(mix.swapAt), beatsIn, mix.inTicks?.passed ?? 0);
        }
        if (now >= mix.swapAt - approachMs(beatMs) && now < mix.endAt + 300) {
          const ball = now >= mix.swapAt && now <= mix.endAt ? mix.out?.ideal ?? 0 : null;
          slide(outPath, "left", ball, mix.out?.following, fadeOut(mix.endAt), beatsOut, mix.outTicks?.passed ?? 0);
        }
      }
      for (const head of mix.heads) if (!head.verdict) drawShape(head.pins, head.real, now, beatMs, { emphasis: mix.state === "cut", number: 1 });
    }

    for (let i = effects.length - 1; i >= 0; i -= 1) {
      const effect = effects[i];
      const age = now - effect.born;
      if (age > 650) {
        effects.splice(i, 1);
        continue;
      }
      const p = point(effect.at);
      const color = effect.verdict === "perfect" ? colors.accent : effect.verdict === "good" ? "#ffffff" : "#c9cfd6";
      outlinedText(effect.text, p.x, p.y - dot() * 4 - age * 0.04, dot() * 1.5, color, 1 - age / 650);
    }
    if (pausedAt === null && playback.loaded && !playback.playing) outlinedText("Paused", width / 2, height / 2, dot() * 3.8, "#ffffff", 0.95);
    if (score.combo > 1) outlinedText(`${score.combo}×`, dot() * 2, height - dot() * 3, dot() * 4, "#ffffff", 0.95, "left");
    // Your fingertips.
    for (const side of ["left", "right"]) {
      const hand = tips[side];
      if (!hand) continue;
      for (const tip of [hand.thumb, hand.index]) {
        context.save();
        context.fillStyle = colors[side];
        context.strokeStyle = "#ffffff";
        context.lineWidth = 2;
        context.beginPath();
        context.arc(tip.x, tip.y, dot() * 0.45, 0, Math.PI * 2);
        context.fill();
        context.stroke();
        context.restore();
      }
    }
  }
  requestAnimationFrame(draw);

  return {
    update,
    // Turns the game on or off (the start screen turns it on at "Go").
    setEnabled(on) {
      enabled = on;
      if (!on) queue.holdControls({});
    },
    // Pauses the set: the music (the whole audio clock, so a mix holds mid-slide) and the game.
    pause() {
      if (pausedAt !== null || !deck?.ctx) return false;
      pausedAt = performance.now();
      deck.ctx.suspend();
      return true;
    },
    // Picks up where it paused: the mix's moments (real time) move on by the pause.
    async resume() {
      if (pausedAt === null) return;
      const mine = generation, started = pausedAt;
      await deck.ctx.resume();
      if (mine !== generation || pausedAt !== started) return;
      const paused = performance.now() - started;
      if (mix) {
        for (const key of ["comesIn", "swapAt", "endAt"]) if (typeof mix[key] === "number") mix[key] += paused;
        for (const head of mix.heads ?? []) head.real += paused;
      }
      lastHands += paused;
      pausedAt = null;
    },
    get paused() {
      return pausedAt !== null;
    },
    // The last song is fading out and the results are about to show.
    get finishing() {
      return finishing;
    },
    // A fresh start for a new set (or the same one again): score, chart and mix cleared.
    reset() {
      generation += 1;
      finishing = false;
      songStarts.clear();
      songShares.clear();
      if (pausedAt !== null) deck?.ctx?.resume();
      pausedAt = null;
      Object.assign(score, freshScore());
      finishMix();
      effects.length = 0;
      wasActive = false;
    },
    // For debugging and tests: the score, the mix, and the next targets: their dots (stage
    // shares) and when (performance.now() ms).
    peek(now = performance.now()) {
      const playback = queue.getPlayback();
      const realAt = (songTime) => now + ((songTime - playback.position) / playback.rate) * 1000;
      const targets = [...shapes.values()]
        .filter((shape) => shape.song === playback.songId && !shape.verdict)
        .map((shape) => ({ pins: shape.pins, dots: shape.dots, at: realAt(shape.time), number: shape.number }));
      for (const head of mix?.heads ?? []) if (!head.verdict) targets.push({ pins: head.pins, dots: head.dots, at: head.real });
      const slides = mix?.state === "blend" ? { right: [inPath, mix.comesIn, mix.swapAt], left: [outPath, mix.swapAt, mix.endAt] } : null;
      return { score: { ...score }, mix: mix && { state: mix.state, style: mix.style, cueAt: realAt(mix.cue), comesIn: mix.comesIn ?? null }, targets: targets.sort((a, b) => a.at - b.at), slides };
    },
  };
}

// The set card in the side rail: your set (played, playing, to come), the crowd, the score.
function buildCard(queue, rail) {
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const list = element("ol", "djSet-list");
  const empty = element("p", "djSet-label", "Pick your songs to start.");
  const hype = element("div", "djSet-hype");
  const chunks = Array.from({ length: 12 }, () => hype.appendChild(element("span")));
  const combo = element("span");
  const accuracy = element("span");
  const stats = element("p", "djSet-stats");
  stats.append(combo, accuracy);
  const card = element("div", "card glass djSet");
  card.append(element("h2", null, "Your set"), list, empty, element("p", "djSet-label", "Crowd"), hype, stats);
  rail.append(card);
  addStyles();

  let last = "";
  return {
    render(score, enabled) {
      const { items, currentId } = queue.getState();
      const playing = items.findIndex((item) => item.id === currentId);
      const lit = Math.round(score.hype * chunks.length);
      const accuracyText = score.judged ? `${Math.round((score.points / score.judged) * 100)}% accuracy` : "No hits yet";
      const key = [items.map((item) => item.id).join(","), playing, lit, score.combo, accuracyText, enabled].join("|");
      if (key === last) return;
      last = key;
      list.replaceChildren(
        ...items.map((item, index) => element("li", index < playing ? "done" : index === playing ? "now" : "", item.title)),
      );
      list.hidden = !items.length;
      empty.hidden = Boolean(items.length);
      chunks.forEach((chunk, index) => chunk.classList.toggle("on", index < lit));
      combo.textContent = `Combo ${score.combo}`;
      accuracy.textContent = accuracyText;
      card.classList.toggle("off", !enabled);
    },
  };
}

// The set's progress bar, along the top edge of the camera view, after YouTube's old
// player: a dark track, a lighter "loaded" layer (songs that are downloaded), and the red
// progress, one segment per song with a notch between them. Not seekable: it's a game.
function buildProgress(stage) {
  const bar = document.createElement("div");
  bar.className = "djProgress";
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-label", "Set progress");
  bar.hidden = true;
  stage.append(bar);
  let segments = [];
  return {
    render(songs, { song = 0, songs: count = 0 } = {}) {
      bar.hidden = !songs;
      if (!songs) return;
      if (segments.length !== songs.length) {
        bar.replaceChildren();
        segments = songs.map(() => {
          const segment = document.createElement("span");
          const loaded = document.createElement("i");
          const done = document.createElement("b");
          segment.append(loaded, done);
          bar.append(segment);
          return { loaded, done };
        });
      }
      songs.forEach((state, index) => {
        segments[index].loaded.style.width = state.loaded ? "100%" : "0";
        segments[index].done.style.width = `${(state.done * 100).toFixed(2)}%`;
      });
      const total = songs.reduce((sum, state) => sum + state.done, 0) / songs.length;
      bar.setAttribute("aria-valuenow", String(Math.round(total * 100)));
      bar.setAttribute("aria-valuetext", `Song ${song} of ${count}`);
    },
  };
}

// The sounds your hits make, on top of the music: a clap, and a slide's tick.
function createSounds(context) {
  const out = context.createGain();
  out.gain.value = 0.55;
  out.connect(context.destination);
  const noise = context.createBuffer(1, context.sampleRate * 0.4, context.sampleRate);
  const samples = noise.getChannelData(0);
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.random() * 2 - 1;

  // A hand clap: three quick bursts of filtered noise and a short tail.
  function clap(delay, loudness) {
    const start = context.currentTime + delay;
    const source = context.createBufferSource();
    source.buffer = noise;
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 1300;
    band.Q.value = 0.9;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, start);
    for (const [offset, level] of [[0, 1], [0.011, 0.8], [0.022, 1]]) {
      gain.gain.setValueAtTime(level * loudness, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.05 * loudness, start + offset + 0.009);
    }
    gain.gain.setValueAtTime(0.7 * loudness, start + 0.033);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.2);
    source.connect(band).connect(gain).connect(out);
    source.start(start);
    source.stop(start + 0.25);
  }

  // A slide tick: a short, bright click.
  function tick() {
    const start = context.currentTime;
    const source = context.createBufferSource();
    source.buffer = noise;
    const high = context.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = 6000;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.5, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.05);
    source.connect(high).connect(gain).connect(out);
    source.start(start);
    source.stop(start + 0.06);
  }

  return { clap, tick };
}

function addStyles() {
  if (document.getElementById("djGame-styles")) return;
  const style = document.createElement("style");
  style.id = "djGame-styles";
  style.textContent = `
.djGame { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 1; pointer-events: none; }
.djProgress {
  position: absolute; top: 0; left: 0; right: 0; z-index: 2; height: 5px; display: flex; gap: 2px;
  background: rgba(16, 16, 16, 0.5); pointer-events: none;
}
.djProgress[hidden] { display: none; }
.djProgress span { position: relative; flex: 1; overflow: hidden; }
.djProgress i, .djProgress b { position: absolute; top: 0; bottom: 0; left: 0; width: 0; }
.djProgress i { background: rgba(255, 255, 255, 0.3); }
.djProgress b { background: linear-gradient(#ff5a4f, #e62117 45%, #b8150f); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35); }
.djSet .djSet-list { margin: 0; padding: 0 0 0 20px; font-size: 13px; line-height: 1.5; }
.djSet .djSet-list li.done { color: var(--muted); text-decoration: line-through; }
.djSet .djSet-list li.now { font-weight: bold; color: #2b6fb8; }
.djSet .djSet-label { margin: 10px 0 4px; font-size: 12px; color: var(--muted); }
/* The crowd meter: chunks, like the Windows XP progress bar. */
.djSet .djSet-hype {
  display: grid; grid-template-columns: repeat(12, 1fr); gap: 2px; padding: 2px;
  border: 1px solid #8d9db4; border-radius: 3px; background: #fff;
}
.djSet .djSet-hype span { height: 10px; border-radius: 1px; background: transparent; }
.djSet .djSet-hype span.on { background: linear-gradient(#a6e98c, #37b029 45%, #2d9a22 55%, #6fd35a); }
.djSet .djSet-stats { display: flex; justify-content: space-between; margin: 8px 0 0; font-size: 12px; font-variant-numeric: tabular-nums; }
.djSet.off .djSet-hype, .djSet.off .djSet-stats { opacity: 0.45; }`;
  document.head.append(style);
}
