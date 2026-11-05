// AirMix pinch calibration: the margins are applied before the check, so an inverted or
// too-narrow range is never saved (or restored). Also the camera error wording.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const page = fs.readFileSync(__dirname + '/../ai-dj.html', 'utf8');
const between = (start, end) => {
  const from = page.indexOf(start), to = page.indexOf(end, from);
  assert.ok(from !== -1 && to !== -1, `marker missing: ${start}`);
  return page.slice(from, to);
};
const calibration = between('// ---- Calibration', '// ---- Drawing');
const cameraErrors = between('function cameraError(err)', '\n}\n') + '\n}\n';
const flush = () => new Promise((resolve) => setImmediate(resolve));
// Moves the fake clock in small steps, letting the page's awaits run between them.
const elapse = async (ms) => { for (let i = 0; i < ms / 50; i++) { advance(50); await flush(); } };

let wall = 0, id = 0;
const timers = new Map();
const later = (fn, ms) => { timers.set(++id, { fn, at: wall + ms }); return id; };
function advance(ms) {
  const until = wall + ms;
  for (;;) {
    const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    timers.delete(due[0]); wall = due[1].at; due[1].fn();
  }
  wall = until;
}
const saved = { value: null, writes: 0 };
const calibBtn = {}, calibMsg = {};
const box = {
  console, setImmediate, setTimeout: later, clearTimeout: (key) => timers.delete(key),
  localStorage: { getItem: () => saved.value, setItem: (key, value) => { saved.writes++; saved.value = value; } },
  calibBtn, calibMsg,
};
vm.createContext(box);
vm.runInContext('let PINCH_CLOSED = 0.05, PINCH_OPEN = 0.9;\n' + calibration + '\n' + cameraErrors, box);
const run = (code) => vm.runInContext(code, box);
const pinchRange = (closed, open) => run(`pinchRange(${JSON.stringify(closed)}, ${JSON.stringify(open)})`);
const samples = (value, n = 12) => Array.from({ length: n }, () => value);

const check = [];
const test = (name, fn) => check.push([name, fn]);

test('a usable pair gets its margins applied: closed + 0.03, open × 0.9', () => {
  const range = pinchRange(samples(0.1), samples(0.8));
  assert.ok(range, 'range found');
  assert.ok(Math.abs(range.closed - 0.13) < 1e-9, `closed ${range.closed}`);
  assert.ok(Math.abs(range.open - 0.72) < 1e-9, `open ${range.open}`);
});

test('an inverted pair is rejected even though the raw medians look ordered', () => {
  // Raw medians 0.70 < 0.80 would pass the old check, but with the margins closed (0.73) is above open (0.72).
  assert.equal(pinchRange(samples(0.7), samples(0.8)), null);
  assert.equal(pinchRange(samples(0.6), samples(0.5)), null);
});

test('a range narrower than the gap is rejected', () => {
  assert.equal(pinchRange(samples(0.3), samples(0.31)), null);
});

test('calibrate does not save an inverted range and says to try again', async () => {
  saved.writes = 0;
  const done = run('calibrate()');
  await elapse(2100); // the 3-2-1 before the pinch
  run('calib.samples.push(' + samples(0.7).join(',') + ')');
  await elapse(2000);
  await elapse(2100); // the 3-2-1 before the spread
  run('calib.samples.push(' + samples(0.8).join(',') + ')');
  await elapse(2000);
  await done;
  assert.equal(saved.writes, 0, 'nothing saved');
  assert.match(calibMsg.textContent, /too close\). Try again/);
  assert.equal(calibBtn.disabled, false);
  assert.equal(run('PINCH_CLOSED'), 0.05, 'the previous range stays');
});

test('calibrate saves a good range and reports it', async () => {
  const done = run('calibrate()');
  await elapse(2100);
  run('calib.samples.push(' + samples(0.1).join(',') + ')');
  await elapse(2000);
  await elapse(2100);
  run('calib.samples.push(' + samples(0.8).join(',') + ')');
  await elapse(2000);
  await done;
  assert.equal(saved.writes, 1);
  assert.match(calibMsg.textContent, /^Calibrated: closed 0\.13, open 0\.72/);
  assert.equal(run('PINCH_CLOSED'), 0.13);
});

test('a saved inverted range is not restored at startup', () => {
  saved.value = JSON.stringify({ closed: 0.8, open: 0.5 });
  run('PINCH_CLOSED = 0.05; PINCH_OPEN = 0.9;');
  // Re-run the restore block (the part after the pinch helpers) against the saved value.
  const restore = calibration.slice(calibration.indexOf('// Restore saved calibration'));
  vm.runInContext(restore, box);
  assert.equal(run('PINCH_CLOSED'), 0.05);
  assert.equal(run('PINCH_OPEN'), 0.9);
  saved.value = JSON.stringify({ closed: 0.13, open: 0.72 });
  vm.runInContext(restore, box);
  assert.equal(run('PINCH_CLOSED'), 0.13, 'a good saved range is restored');
});

test('the camera errors say what is wrong', () => {
  const message = (name, text = 'x') => run(`cameraError(${JSON.stringify({ name, message: text })})`);
  assert.match(message('NotFoundError', 'Requested device not found'), /^No camera found/);
  assert.match(message('OverconstrainedError'), /^No camera found/);
  assert.match(message('NotAllowedError', 'Permission denied'), /^Camera access is blocked/);
  assert.match(message('SecurityError'), /^Camera access is blocked/);
  assert.match(message('AbortError', 'boom'), /^The camera didn't start \(boom\)/);
});

(async () => {
  for (const [name, fn] of check) {
    await fn();
    console.log(`PASS: ${name}`);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
