// DJ Deck first-visit tutorial. One coach card at a time; a step finishes when the page's
// state shows the user really did the action. createDeckTour() is pure (no DOM): the page
// polls tick() and the card is drawn by renderTourCard(), a separate small function below.

export const TOUR_KEY = "airdeck-tour-done";
export const NICE_MS = 900;
export const HOLD_BOTH_MS = 4000;

// getState() returns: { bothHands, playing, locked, speed, freq, volume, picks: { fx, song, vis } }
// (picks are counters that go up each time that mode makes a choice).
export const TOUR_STEPS = [
  { id: "hands", hint: "🖐️ 🖐️", highlight: "#start", action: null,
    text: "Start the camera and show both hands.",
    enter: () => ({}), check: (s) => !!s.bothHands },
  { id: "play", hint: "🎵", highlight: "#queueMount", action: null,
    text: "Play a song from the Library.",
    enter: () => ({}), check: (s) => !!s.playing },
  { id: "basic", hint: "🤏 ↔ 🤏", highlight: null, action: null,
    text: "Left pinch = speed, right pinch = filter, hands apart = volume. Try one.",
    enter: (s) => ({ speed: s.speed, freq: s.freq, volume: s.volume, holdSince: null }),
    check: (s, m, now) => {
      if (!s.bothHands) { m.holdSince = null; return false; }
      const moved = Math.abs(s.speed - m.speed) > 0.03 || Math.abs(s.volume - m.volume) > 0.1 ||
        (s.freq !== m.freq && Math.abs(Math.log((s.freq || 1) / (m.freq || 1))) > 0.2);
      if (moved) return true;
      // Fallback: both hands held in view while the music plays.
      if (!s.playing) { m.holdSince = null; return false; }
      m.holdSince ??= now;
      return now - m.holdSince >= HOLD_BOTH_MS;
    } },
  { id: "fx", hint: "✊ → ☝️✌️", highlight: null, action: "fx",
    text: "Make a left fist in the left zone, then hold up 1 to 4 fingers on your right hand to switch on an effect.",
    enter: (s) => ({ n: s.picks.fx }), check: (s, m) => s.picks.fx > m.n },
  { id: "song", hint: "✊ → ☝️", highlight: "#songCard", action: "song",
    text: "Make a right fist in the right zone, then hold up one finger on your left hand for the next song. Left palm height blends.",
    enter: (s) => ({ n: s.picks.song }), check: (s, m) => s.picks.song > m.n },
  { id: "vis", hint: "✊ → ✌️", highlight: null, action: "vis",
    text: "Make a right fist in the bottom-right corner, then hold up 1 to 4 fingers on your left hand to choose a visual.",
    enter: (s) => ({ n: s.picks.vis }), check: (s, m) => s.picks.vis > m.n },
  { id: "lock", hint: "🖐️ ⬆️", highlight: null, action: "lock",
    text: "Hold one hand in the top zone to lock your controls.",
    enter: () => ({}), check: (s) => !!s.locked },
];

export function createDeckTour({ getState, actions = {}, mount = null, storage = null, now = () => Date.now(),
  setTimer = (f, ms) => setTimeout(f, ms), render = null, steps = TOUR_STEPS, key = TOUR_KEY } = {}) {
  const total = steps.length;
  let active = false, index = 0, phase = "step", memo = {}, token = 0;

  const store = {
    get() { try { return storage ? storage.getItem(key) : null; } catch { return null; } },
    set() { try { storage?.setItem(key, "1"); } catch { /* private mode: the tour may show again */ } },
  };
  const safeState = () => { try { return getState(); } catch { return null; } };
  const draw = render || (mount ? (view) => renderTourCard(mount, view, api) : () => {});

  function view() {
    const step = steps[index];
    if (!active) return { visible: false };
    if (phase === "final") return { visible: true, phase, index, total, text: "You're set. Enjoy the deck!", hint: "🎉", showMe: false, highlight: null };
    return { visible: true, phase, index, total, hint: step.hint, highlight: step.highlight,
      text: phase === "nice" ? "Nice!" : step.text,
      showMe: phase === "step" && !!step.action && typeof actions[step.action] === "function" };
  }
  const update = () => draw(view());

  function enterStep(i) {
    token++;
    index = i;
    if (i >= total) { phase = "final"; update(); return; }
    phase = "step";
    const s = safeState();
    memo = steps[i].enter(s || { picks: { fx: 0, song: 0, vis: 0 } }, now());
    update();
  }
  function start() { active = true; enterStep(0); }
  function end() { token++; active = false; store.set(); update(); }
  const api = {
    // First visit only: starts unless the done flag is stored.
    init() { if (store.get()) return false; start(); return true; },
    replay: start,
    skipStep() { if (active && phase !== "final") enterStep(index + 1); },
    end,
    finish: end,
    showMe() {
      const step = steps[index];
      if (!active || phase !== "step" || !step.action) return;
      try { actions[step.action]?.(); } catch { /* a failed demo must not break the tour */ }
    },
    tick() {
      if (!active || phase !== "step") return;
      const s = safeState();
      if (!s) return;
      let ok = false;
      try { ok = steps[index].check(s, memo, now()); } catch { ok = false; }
      if (!ok) return;
      phase = "nice";
      const mine = ++token;
      update();
      setTimer(() => { if (active && token === mine) enterStep(index + 1); }, NICE_MS);
    },
    get active() { return active; },
    get stepIndex() { return index; },
    get phase() { return phase; },
  };
  return api;
}

// ---- DOM rendering (kept apart from the step logic) ----------------------------------
const HIGHLIGHT = "tour-highlight";
export function renderTourCard(mount, v, handlers) {
  const doc = mount.ownerDocument || document;
  doc.querySelectorAll("." + HIGHLIGHT).forEach((el) => el.classList.remove(HIGHLIGHT));
  if (!v.visible) { mount.hidden = true; mount.replaceChildren(); return; }
  mount.hidden = false;
  let card = mount.firstElementChild;
  if (!card) {
    card = doc.createElement("div");
    card.className = "card glass tourCard";
    card.setAttribute("role", "dialog");   // not modal: the page stays usable
    card.setAttribute("aria-label", "DJ Deck tutorial");
    const head = doc.createElement("div"); head.className = "tourHead";
    const count = doc.createElement("span"); count.className = "tourCount";
    const hint = doc.createElement("span"); hint.className = "tourHint"; hint.setAttribute("aria-hidden", "true");
    head.append(count, hint);
    const text = doc.createElement("p"); text.className = "tourText"; text.setAttribute("aria-live", "polite");
    const row = doc.createElement("div"); row.className = "tourButtons";
    const mk = (cls, label, fn) => {
      const b = doc.createElement("button"); b.type = "button"; b.className = "secondary " + cls; b.textContent = label;
      b.addEventListener("click", fn); return b;
    };
    row.append(mk("tourShow", "Show me", () => handlers.showMe()), mk("tourSkip", "Skip step", () => handlers.skipStep()),
      mk("tourEnd", "End tutorial", () => handlers.end()), mk("tourDone", "Done", () => handlers.finish()));
    card.append(head, text, row);
    mount.append(card);
  }
  const q = (c) => card.querySelector("." + c);
  const final = v.phase === "final";
  q("tourCount").textContent = final ? "All done" : `${v.index + 1} of ${v.total}`;
  q("tourHint").textContent = v.hint || "";
  q("tourText").textContent = v.text;
  card.classList.toggle("tourNice", v.phase === "nice");
  q("tourShow").hidden = !v.showMe;
  q("tourSkip").hidden = final;
  q("tourEnd").hidden = final;
  q("tourDone").hidden = !final;
  if (v.highlight) doc.querySelector(v.highlight)?.classList.add(HIGHLIGHT);
}
