// AirMix's screens, over the camera view: pick your set (songs from the library, in
// order), then the first time how to play (three small pictures), the camera and a check
// that both hands show up; then the set loads, 3, 2, 1 and it starts on "Go". When the
// set's over, the results, with Play again and New set.
//
//   const screens = createStartScreen(stage, {
//     library: async () => songs,             // library.json's songs ({ id, artist, title, bpm, genre, available })
//     startCamera: async () => true,          // false if the camera didn't start
//     handSeen: (side) => bool,               // "left" / "right" in view right now
//     prepare: async (ids) => {},             // load that set (called on Play, so it loads meanwhile)
//     cancel: () => {},                       // the set being prepared was dropped (New set): stop loading it
//     loadingText: () => "Downloading …",     // what's loading right now, for the loading screen (optional)
//     begin: () => {},                        // start the set, on "Go"
//   });
//   screens.results({ score, perfect, good, miss, best, accuracy });
//   screens.paused({ resume, restart, newSet });   // the pause panel (the page pauses the set)
//   screens.countIn(onGo);                         // a quick 3-2-1, then onGo (after a pause)
//   screens.replay();                              // the same set again: loads, 3-2-1, Go
//   screens.newSet();                              // back to picking a set

const handCheckMs = 800; // both hands in view this long counts as checked
const setSize = { min: 2, max: 5 };
const secondsPerSong = 30; // about how long each song plays in a set
const blendTolerance = 0.08; // tempos this close (halved or doubled) blend; further apart, a cut (as queue.js)
const savedSetKey = "airmix-set";

// Tiny pictures for the three moves, in the page's colors.
const pictures = {
  hit: `<svg viewBox="0 0 64 48" aria-hidden="true">
    <path d="M14 30 18 14 46 14 50 30Z" fill="rgba(255,255,255,.6)" stroke="#8a96a3" stroke-dasharray="3 2"/>
    <path d="M14 30 18 14" stroke="#1e95e3" stroke-width="2.5"/><path d="M50 30 46 14" stroke="#5cb82c" stroke-width="2.5"/>
    <circle cx="14" cy="30" r="4.5" fill="#fff" stroke="#1e95e3" stroke-width="2.5"/>
    <circle cx="18" cy="14" r="4.5" fill="#1e95e3" stroke="#1e95e3" stroke-width="2.5"/>
    <circle cx="50" cy="30" r="4.5" fill="#fff" stroke="#5cb82c" stroke-width="2.5"/>
    <circle cx="46" cy="14" r="4.5" fill="#5cb82c" stroke="#5cb82c" stroke-width="2.5"/>
  </svg>`,
  slide: `<svg viewBox="0 0 64 48" aria-hidden="true">
    <path d="M12 34 52 14" stroke="rgba(92,184,44,.35)" stroke-width="12" stroke-linecap="round"/>
    <path d="M12 34 52 14" stroke="#5cb82c" stroke-width="2" stroke-dasharray="4 3"/>
    <circle cx="32" cy="24" r="7" fill="#fff" stroke="#5cb82c" stroke-width="3"/>
    <path d="M42 30l6-3m-2 6 4-6" stroke="#3a2412" stroke-width="1.8" stroke-linecap="round"/>
  </svg>`,
  cut: `<svg viewBox="0 0 64 48" aria-hidden="true">
    <path d="M20 32 23 16 41 16 44 32Z" fill="rgba(255,255,255,.6)" stroke="#f5861f" stroke-width="2" stroke-dasharray="4 3"/>
    <circle cx="20" cy="32" r="4.5" fill="#fff" stroke="#1e95e3" stroke-width="2.5"/>
    <circle cx="23" cy="16" r="4.5" fill="#1e95e3" stroke="#1e95e3" stroke-width="2.5"/>
    <circle cx="44" cy="32" r="4.5" fill="#fff" stroke="#5cb82c" stroke-width="2.5"/>
    <circle cx="41" cy="16" r="4.5" fill="#5cb82c" stroke="#5cb82c" stroke-width="2.5"/>
    <path d="M32 4v5M32 39v5M6 24h5M53 24h5M12 8l3 3M52 8l-3 3" stroke="#f5861f" stroke-width="2.2" stroke-linecap="round"/>
  </svg>`,
};

const escape = (text) => String(text ?? "").replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

// Whether two library tempos blend (as queue.js decides it), or are a cut.
function blends(a, b) {
  if (!a?.bpm || !b?.bpm) return true;
  let ratio = a.bpm / b.bpm;
  while (ratio > Math.SQRT2) ratio /= 2;
  while (ratio < Math.SQRT1_2) ratio *= 2;
  return Math.abs(ratio - 1) <= blendTolerance;
}

// The picked ids that are songs in the library: no repeats (the first pick counts), at most setSize.max.
function cleanSet(ids, known) {
  const picked = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (picked.length === setSize.max) break;
    if (typeof id === "string" && known.has(id) && !picked.includes(id)) picked.push(id);
  }
  return picked;
}

function savedSet() {
  try {
    const ids = JSON.parse(localStorage.getItem(savedSetKey) ?? "[]");
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}
function saveSet(ids) {
  try {
    localStorage.setItem(savedSetKey, JSON.stringify(ids));
  } catch {
    // Remembering the set is a nicety.
  }
}

export function createStartScreen(stage, { library, startCamera, handSeen, prepare, begin, loadingText = () => null, cancel = () => {} }) {
  addStyles();
  let root = null;
  let cameraReady = false; // the camera's on and the hands have been checked once
  let loading = null; // the set being prepared
  let lastSet = [];
  let run = 0; // the current countdown; a newer one (or a restart) cancels the older

  const show = (html) => {
    if (!root?.isConnected) {
      root = document.createElement("div");
      root.className = "djStart";
      stage.append(root);
    }
    root.innerHTML = html;
    return root;
  };

  // ---- pick your set
  async function setSelect() {
    const mine = ++run;
    cancel(); // a set that was still loading stops (downloads, and starting)
    show(`<div class="djStart-panel"><p class="djStart-status">Loading the songs…</p></div>`);
    let songs;
    try {
      songs = await library();
    } catch (error) {
      if (mine === run) showLoadError(error, setSelect);
      return;
    }
    if (mine !== run) return; // another screen came up meanwhile
    const known = new Set(songs.map((song) => song.id));
    const missing = songs.filter((song) => song.available === false).length;
    let picked = cleanSet(lastSet.length ? lastSet : savedSet(), known);

    show(`
      <div class="djStart-panel djStart-wide">
        <h1>AirMix</h1>
        <p>Pick ${setSize.min}–${setSize.max} songs for your set, in the order you want to play them.</p>
        <ul class="djStart-songs" role="listbox" aria-multiselectable="true" aria-label="Songs">
          ${songs
            .map(
              (song) => `
            <li><button type="button" role="option" data-id="${escape(song.id)}" aria-label="${escape(`${song.title} by ${song.artist}${song.bpm ? `, ${Math.round(song.bpm)} BPM` : ""}${song.available === false ? ", downloads first" : ""}`)}">
              <span class="djStart-order"></span>
              <span class="djStart-song"><b>${escape(song.title)}</b><small>${escape(song.artist)}${song.genre ? ` · ${escape(song.genre)}` : ""}</small></span>
              <span class="djStart-bpm">${song.bpm ? `${Math.round(song.bpm)} BPM` : ""}${song.available === false ? `<span class="djStart-dl" title="Not on this computer yet: it downloads the first time you play it">↓ download</span>` : ""}</span>
            </button></li>`,
            )
            .join("")}
        </ul>
        ${missing ? `<p class="djStart-hint">Songs marked ↓ download the first time you play them (about 20 s each). To get them all now, run <code>python prefetch.py</code>.</p>` : ""}
        <p class="djStart-flow" aria-live="polite"></p>
        <div class="djStart-row">
          <button class="secondary" type="button" data-clear>Clear</button>
          <button class="lime" type="button" data-play>Play ▶</button>
        </div>
      </div>`);

    const flow = root.querySelector(".djStart-flow");
    const play = root.querySelector("[data-play]");
    const byId = new Map(songs.map((song) => [song.id, song]));
    const render = () => {
      for (const button of root.querySelectorAll("[data-id]")) {
        const index = picked.indexOf(button.dataset.id);
        button.setAttribute("aria-selected", String(index !== -1));
        button.querySelector(".djStart-order").textContent = index === -1 ? "" : String(index + 1);
      }
      const set = picked.map((id) => byId.get(id));
      flow.innerHTML = set.length
        ? `${set
            .map((song, i) => `${i ? `<span class="djStart-mix ${blends(set[i - 1], song) ? "" : "cut"}">${blends(set[i - 1], song) ? "blend" : "cut"}</span>` : ""}<span>${escape(song.title)}</span>`)
            .join("")} <em>· about ${Math.max(1, Math.round((set.length * secondsPerSong) / 60))} min</em>`
        : "Nothing picked yet.";
      play.disabled = picked.length < setSize.min;
    };
    root.querySelector(".djStart-songs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-id]");
      if (!button || button.disabled) return;
      const id = button.dataset.id;
      if (picked.includes(id)) picked = picked.filter((other) => other !== id);
      else if (picked.length < setSize.max) picked = [...picked, id];
      render();
    });
    root.querySelector("[data-clear]").addEventListener("click", () => {
      picked = [];
      render();
    });
    play.addEventListener(
      "click",
      () => {
        lastSet = picked;
        saveSet(picked);
        prepareSet(picked); // the songs load while you read and get the camera going
        if (cameraReady) ready();
        else intro();
      },
      { once: true },
    );
    render();
  }

  // ---- how to play (first time), the camera, the hands
  function intro() {
    show(`
      <div class="djStart-panel">
        <h1>AirMix</h1>
        <p>Your hands are the DJ controls: hit the dots on the beat and you play the set.</p>
        <ol class="djStart-moves">
          <li>${pictures.hit}<span>Thumbs and index fingers on the dots</span></li>
          <li>${pictures.slide}<span>Slide along the track to mix the next song in</span></li>
          <li>${pictures.cut}<span>Hit the orange shape: the next song slams in</span></li>
        </ol>
        <button class="lime" type="button">Start</button>
      </div>`);
    root.querySelector("button").addEventListener("click", cameraStep, { once: true });
  }

  async function cameraStep() {
    const mine = ++run;
    show(`<div class="djStart-panel"><p class="djStart-status">Starting the camera…</p></div>`);
    // true when it's on; otherwise a message saying why (the page's startCamera gives one)
    let started = false;
    try { started = await startCamera(); } catch (error) { started = error?.message || false; }
    if (mine !== run) return;
    if (started !== true) {
      const reason = typeof started === "string" && started ? started : "The camera didn't start. Allow camera access for this page, then try again.";
      show(`
        <div class="djStart-panel">
          <p class="djStart-status">${escape(reason)}</p>
          <div class="djStart-row"><button class="secondary" type="button" data-new>New set</button>
          <button class="lime" type="button" data-retry>Try again</button></div>
        </div>`);
      root.querySelector("[data-new]").addEventListener("click", setSelect, { once: true });
      root.querySelector("[data-retry]").addEventListener("click", cameraStep, { once: true });
      return;
    }
    handCheck();
  }

  // Both hands in view for a moment, each lighting up as it's seen.
  function handCheck() {
    const mine = ++run;
    show(`
      <div class="djStart-panel">
        <p class="djStart-status">Hold both hands up so the camera can see them</p>
        <div class="djStart-hands"><span data-side="left">Left</span><span data-side="right">Right</span></div>
        <button class="secondary djStart-skip" type="button">Skip</button>
      </div>`);
    let bothSince = 0;
    let done = false;
    const finish = () => {
      if (done || mine !== run) return;
      done = true;
      cameraReady = true;
      ready();
    };
    root.querySelector(".djStart-skip").addEventListener("click", finish, { once: true });
    const check = () => {
      if (done || mine !== run) return;
      const now = performance.now();
      let both = true;
      for (const side of ["left", "right"]) {
        const seen = handSeen(side);
        both &&= seen;
        root.querySelector(`[data-side="${side}"]`)?.classList.toggle("seen", seen);
      }
      bothSince = both ? bothSince || now : 0;
      if (bothSince && now - bothSince >= handCheckMs) finish();
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }

  // ---- the set loads, 3, 2, 1
  function prepareSet(ids) {
    // Handle rejection immediately, even while the player reads the intro.
    try {
      loading = Promise.resolve(prepare(ids)).then(
        () => null,
        (error) => error || new Error("The songs could not load."),
      );
    } catch (error) {
      loading = Promise.resolve(error || new Error("The songs could not load."));
    }
  }

  function showLoadError(error, retry) {
    show(`<div class="djStart-panel"><h1>Music couldn't load</h1>
      <p>${escape(error?.message || "Try another set or check the local server.")}</p>
      <p class="djStart-hint">${error?.detail ? `${escape(error.detail)}${/[.!?]$/.test(error.detail) ? "" : "."} ` : "Check your internet connection, or pick other songs. "}To get every song onto this computer at once, run <code>python prefetch.py</code>.</p>
      <div class="djStart-row"><button type="button" class="secondary" data-new>New set</button>
      <button type="button" class="lime" data-retry>Try again</button></div></div>`);
    root.querySelector("[data-new]").addEventListener("click", setSelect, { once: true });
    root.querySelector("[data-retry]").addEventListener("click", retry, { once: true });
  }

  async function ready() {
    const mine = ++run;
    show(`<div class="djStart-panel"><p class="djStart-status">Getting the music ready…</p><p class="djStart-loading" aria-live="polite"></p>
      <button class="secondary" type="button" data-cancel>New set</button></div>`);
    // Back to the picker: setSelect starts a newer run, so this load finishing later starts nothing.
    root.querySelector("[data-cancel]").addEventListener("click", setSelect, { once: true });
    const line = root.querySelector(".djStart-loading");
    const timer = setInterval(() => {
      line.textContent = loadingText() ?? "";
    }, 250);
    const error = await loading;
    clearInterval(timer);
    if (mine !== run) return;
    if (error) {
      showLoadError(error, replay);
      return;
    }
    countdown(begin, 1000, () => setSelect()); // hidden meanwhile: back to the pick screen, the set not started
  }

  // onHidden: the tab was hidden during the count (nothing may start while hidden); without it, the
  // count just stops (the page then shows its Paused panel).
  function countdown(onGo = begin, stepMs = 1000, onHidden = null) {
    const mine = ++run;
    let count = 3;
    const tick = () => {
      if (mine !== run) return;
      if (document.hidden) {
        run += 1;
        onHidden?.();
        return;
      }
      show(`<div class="djStart-count">${count > 0 ? count : "Go!"}</div>`);
      if (count === 0) {
        onGo();
        const shown = root;
        setTimeout(() => mine === run && shown.remove(), 700);
        return;
      }
      count -= 1;
      setTimeout(tick, stepMs);
    };
    tick();
  }

  // ---- paused (Space / P on the page, or its Pause button)
  function paused({ resume, restart, newSet, title = "Paused", text = null, resumeLabel = "Resume ▶" }) {
    run += 1; // a countdown still going (say, resuming) stops
    show(`
      <div class="djStart-panel">
        <h1>${escape(title)}</h1>
        <p>${text ? escape(text) : "<kbd>Space</kbd> to resume · <kbd>R</kbd> to restart the set"}</p>
        <div class="djStart-row">
          <button class="secondary" type="button" data-new>New set</button>
          <button class="secondary" type="button" data-restart>Restart</button>
          <button class="lime" type="button" data-resume>${escape(resumeLabel)}</button>
        </div>
      </div>`);
    root.querySelector("[data-resume]").addEventListener("click", resume, { once: true });
    root.querySelector("[data-restart]").addEventListener("click", restart, { once: true });
    root.querySelector("[data-new]").addEventListener("click", newSet, { once: true });
  }

  function replay() {
    run += 1;
    prepareSet(lastSet);
    ready();
  }

  // ---- results
  function results({ score, perfect, good, miss, best, accuracy, judged }) {
    run += 1;
    // Nothing judged (nobody in frame, say): no grade to give.
    const none = judged === 0;
    const grade = none ? "–" : accuracy >= 0.95 ? "S" : accuracy >= 0.85 ? "A" : accuracy >= 0.7 ? "B" : accuracy >= 0.5 ? "C" : "D";
    show(`
      <div class="djStart-panel">
        <p class="djStart-status">Set complete!</p>
        <div class="djStart-grade grade-${none ? "none" : grade}">${grade}</div>
        ${none ? `<p class="djStart-hint">No hits judged</p>` : ""}
        <p class="djStart-score">${score.toLocaleString()}</p>
        <dl class="djStart-stats">
          <div><dt>Accuracy</dt><dd>${none ? "–" : `${Math.round(accuracy * 100)}%`}</dd></div>
          <div><dt>Best combo</dt><dd>${best}×</dd></div>
          <div><dt>Perfect</dt><dd>${perfect}</dd></div>
          <div><dt>Good</dt><dd>${good}</dd></div>
          <div><dt>Miss</dt><dd>${miss}</dd></div>
        </dl>
        <div class="djStart-row">
          <button class="secondary" type="button" data-new>New set</button>
          <button class="lime" type="button" data-again>Play again</button>
        </div>
      </div>`);
    root.querySelector("[data-new]").addEventListener("click", setSelect, { once: true });
    root.querySelector("[data-again]").addEventListener("click", replay, { once: true });
  }

  setSelect();
  return {
    cancel() { run += 1; root?.remove(); },
    results,
    paused,
    countIn: (onGo) => countdown(onGo, 700),
    replay,
    newSet: setSelect,
  };
}

function addStyles() {
  if (document.getElementById("djStart-styles")) return;
  const style = document.createElement("style");
  style.id = "djStart-styles";
  style.textContent = `
.djStart {
  position: absolute; inset: 0; z-index: 3; display: grid; place-items: center; padding: 16px;
  background: rgba(255, 246, 236, 0.55); backdrop-filter: blur(3px);
}
.djStart-panel {
  width: min(560px, 100%); max-height: 100%; overflow: auto; padding: 22px 26px 24px; border-radius: 18px; text-align: center;
  background: rgba(255, 255, 255, 0.93); border: 2px solid #fff;
  box-shadow: 0 14px 40px rgba(150, 70, 20, 0.22);
}
.djStart-wide { width: min(680px, 100%); display: flex; flex-direction: column; }
.djStart h1 {
  margin: 0 0 4px; font: italic bold 46px/1 "Trebuchet MS", "Segoe UI", sans-serif; color: #2b6fb8;
  text-shadow: 0 2px 0 #fff, 0 3px 6px rgba(30, 80, 140, 0.25);
}
.djStart p { margin: 0 auto 14px; max-width: 46ch; font-size: 15px; line-height: 1.45; color: var(--text); }
.djStart-moves { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 0 0 18px; padding: 0; list-style: none; }
.djStart-moves li { display: flex; flex-direction: column; align-items: center; gap: 6px; font-size: 12.5px; line-height: 1.3; color: var(--muted); }
.djStart-moves svg { width: 92px; height: 69px; padding: 4px; border-radius: 10px; background: #f3f8fd; border: 1px solid #c9dbee; }
.djStart button { min-width: 150px; font-size: 17px; }
.djStart-status { font-weight: 700; }
.djStart-row { display: flex; justify-content: center; gap: 10px; flex-wrap: wrap; }
.djStart-row button.secondary { min-width: 110px; }

.djStart-songs {
  list-style: none; margin: 0 0 10px; padding: 4px; min-height: 120px; max-height: min(44vh, 360px); overflow-y: auto;
  border: 1px solid #b7c9dc; border-radius: 6px; background: #fff; text-align: left;
  box-shadow: inset 0 1px 3px rgba(0, 40, 90, 0.12);
}
/* List rows, not aero.css's glossy pills (the selectors out-rank its button rules). */
.djStart .djStart-songs button {
  display: grid; grid-template-columns: 28px 1fr auto; gap: 10px; align-items: center; width: 100%; min-width: 0; min-height: 0;
  margin: 0; padding: 6px 8px; border: 1px solid transparent; border-radius: 4px; background: none; box-shadow: none;
  font: 13px Tahoma, "Segoe UI", sans-serif; color: var(--text); text-shadow: none; text-align: left; cursor: pointer; filter: none;
}
.djStart .djStart-songs button::before { display: none; }
.djStart .djStart-songs button:hover:not(:disabled) { color: var(--text); background: #eef5fc; border-color: #c9dbee; filter: none; }
.djStart .djStart-songs button[aria-selected="true"], .djStart .djStart-songs button[aria-selected="true"]:hover:not(:disabled) {
  background: linear-gradient(#e3f1fd, #cfe6fb); border-color: #7fb4e6;
}
.djStart .djStart-songs button:disabled { opacity: 0.5; cursor: default; }
.djStart-order {
  width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center;
  border: 1.5px solid #9fb6cc; font: bold 12px Tahoma, sans-serif; color: #fff; background: #fff;
}
.djStart-songs button[aria-selected="true"] .djStart-order { background: #2b8be0; border-color: #1b6bb8; }
.djStart-song { display: flex; flex-direction: column; min-width: 0; }
.djStart-song b, .djStart-song small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.djStart-song small { color: var(--muted); font-size: 11.5px; }
.djStart-bpm { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.djStart-dl { padding: 1px 6px; border-radius: 9px; border: 1px solid #9fb6cc; background: #f3f8fd; font-size: 10.5px; color: #2b6fb8; }
.djStart-hint { font-size: 12px !important; color: var(--muted) !important; margin-bottom: 8px !important; }
.djStart-hint code, .djStart-panel p code { font: 12px Consolas, monospace; padding: 0 4px; border-radius: 3px; background: #f1f3f5; }
.djStart-loading { min-height: 1.4em; font-size: 13px !important; color: var(--muted) !important; }
.djStart-flow { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 4px 6px; font-size: 13px !important; }
.djStart-flow em { color: var(--muted); font-style: normal; }
.djStart-mix { padding: 1px 7px; border-radius: 9px; font-size: 11px; color: #fff; background: #5cb82c; }
.djStart-mix.cut { background: #f5861f; }

.djStart-hands { display: flex; justify-content: center; gap: 14px; margin: 0 0 16px; }
.djStart-hands span {
  width: 92px; padding: 14px 0; border-radius: 12px; font: bold 15px Tahoma, "Segoe UI", sans-serif;
  color: #8a96a3; background: #f1f3f5; border: 2px dashed #c3ccd5; transition: background 0.15s, color 0.15s;
}
.djStart-hands span.seen[data-side="left"] { color: #fff; background: #1e95e3; border: 2px solid #1e95e3; }
.djStart-hands span.seen[data-side="right"] { color: #fff; background: #5cb82c; border: 2px solid #5cb82c; }
.djStart-skip { min-width: 0; font-size: 13px; }
.djStart kbd {
  padding: 1px 6px; border-radius: 3px; border: 1px solid #9fb6cc; border-bottom-width: 2px;
  background: #fff; font: bold 12px Tahoma, "Segoe UI", sans-serif;
}
.djStart-count {
  font: italic bold min(30vh, 220px)/1 "Trebuchet MS", "Segoe UI", sans-serif; color: #fff;
  -webkit-text-stroke: 6px rgba(20, 30, 45, 0.85); paint-order: stroke fill;
  animation: djStart-pop 1s ease-out both;
}

.djStart-grade {
  font: italic bold 96px/1 "Trebuchet MS", "Segoe UI", sans-serif; color: #fff; margin: 4px 0;
  -webkit-text-stroke: 4px rgba(20, 30, 45, 0.85); paint-order: stroke fill;
  animation: djStart-pop 0.6s ease-out both;
}
.djStart-grade.grade-S { color: #f5c518; }
.djStart-grade.grade-A { color: #5cb82c; }
.djStart-grade.grade-B { color: #1e95e3; }
.djStart-grade.grade-C { color: #f5861f; }
.djStart-grade.grade-D { color: #c9cfd6; }
.djStart-grade.grade-none { color: #9aa5b1; }
.djStart-score { font: 900 30px var(--font, Tahoma), "Segoe UI", sans-serif !important; font-variant-numeric: tabular-nums; margin-bottom: 10px !important; }
.djStart-stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin: 0 0 18px; }
.djStart-stats div { padding: 6px 4px; border-radius: 8px; background: #f3f8fd; border: 1px solid #c9dbee; }
.djStart-stats dt { font-size: 11px; color: var(--muted); }
.djStart-stats dd { margin: 2px 0 0; font: bold 16px Tahoma, "Segoe UI", sans-serif; font-variant-numeric: tabular-nums; }

@keyframes djStart-pop { from { transform: scale(1.35); opacity: 0; } 25% { transform: scale(1); opacity: 1; } to { opacity: 0.85; } }
@media (prefers-reduced-motion: reduce) { .djStart-count, .djStart-grade { animation: none; } }
@media (max-width: 560px) {
  /* Phones: the panels get the whole screen (the 16:9 camera stage is too short for them). */
  .djStart { position: fixed; inset: 0; z-index: 50; }
  .djStart-row button, .djStart-row button.secondary { min-width: 0; }
  .djStart-moves { grid-template-columns: repeat(2, 1fr); }
  .djStart-stats { grid-template-columns: repeat(3, 1fr); }
}`;
  document.head.append(style);
}
