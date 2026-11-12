// Camera lifecycle: model retry, play() failure releases the stream, 'ended' drops hands, stale frames drop hands, modifier keys ignored.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const html = fs.readFileSync(__dirname + '/../arcade-versus.html', 'utf8');
const take = (from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
const els = new Map(), handlers = {};
const mk = () => ({style: {}, disabled: false, textContent: '', classList: {replace() {}, add() {}, remove() {}}, setAttribute() {}});
let loads = 0, failLoad = true, stopped = 0, ended = null;
const track = {addEventListener: (t, f) => { if (t === 'ended') ended = f; }, stop() {stopped++;}};
const stream = {getTracks: () => [track], getVideoTracks: () => [track]};
const box = {
  console, $: id => { if (!els.has(id)) els.set(id, mk()); return els.get(id); },
  document: {body: {classList: {add() {}, remove() {}}}},
  navigator: {mediaDevices: {getUserMedia: async () => stream}},
  addEventListener: (t, f) => { handlers[t] = f; }, overlayAction() {},
  loadModel: async () => { loads++; if (failLoad) throw new Error('x'); vm.runInContext('landmarker = {}', box); },
};
vm.createContext(box);
vm.runInContext(`let landmarker = null, camOn = false, lastVideoTime = -1;
const video = {readyState: 2, currentTime: 0, srcObject: null, play: async () => { if (globalThis.playFail) throw new Error('play'); }};
const input = {1: {}, 2: {}};
const isHeld = () => false;
${take('let modelLoading', 'const dist')}
${take('function dropHand', '// ---- Keyboard fallback')}
const KEYS = {w: [1, 'u']}; const clearHeld = () => {};
${take('addEventListener("keydown"', 'addEventListener("keyup"')}`.replace("globalThis.playFail", 'globalThis.playFail'), box);
box.playFail = true;
const run = s => vm.runInContext(s, box);
(async () => {
  await new Promise(r => setTimeout(r, 0));
  assert.equal(loads, 1);
  assert.equal(els.get('camBtn').disabled, false, 'failed model leaves the button usable');
  assert(/retry/i.test(els.get('camBtn').textContent), 'retry label');
  failLoad = false;
  await els.get('camBtn').onclick();   // retry
  await new Promise(r => setTimeout(r, 0));
  assert.equal(loads, 2, 'next click reloads the model');
  assert.equal(els.get('camBtn').textContent, 'Start camera');
  await els.get('camBtn').onclick();   // play() rejects
  assert.equal(stopped, 1, 'play() failure stops the stream tracks');
  assert.equal(run('camOn'), false);
  box.playFail = false;
  await els.get('camBtn').onclick();
  assert.equal(run('camOn'), true);
  run('input[1].present = true; input[2].present = true');
  ended();
  assert.equal(run('camOn'), false, 'ended clears camOn');
  assert.equal(run('input[1].present || input[2].present'), false, 'ended drops hands');
  assert.equal(els.get('camBtn').disabled, false, 'ended re-enables the button');
  // frames stop arriving
  run('camOn = true; landmarker = {detectForVideo: () => ({landmarks: []})}; input[1].present = true; lastVideoTime = 5; video.currentTime = 5; track(100)');
  assert.equal(run('input[1].present'), true, 'fresh enough');
  run('track(2000)');
  assert.equal(run('input[1].present'), false, 'stale frames drop hands');
  // modifier keys
  let prevented = 0;
  handlers.keydown({key: 's', metaKey: true, preventDefault() {prevented++;}});
  handlers.keydown({key: ' ', ctrlKey: true, preventDefault() {prevented++;}});
  assert.equal(prevented, 0, 'Cmd/Ctrl combos are not swallowed');
  handlers.keydown({key: ' ', preventDefault() {prevented++;}});
  assert.equal(prevented, 1);
  console.log('PASS: Arcade camera lifecycle and modifier keys');
})().catch(e => { console.error(e); process.exit(1); });
