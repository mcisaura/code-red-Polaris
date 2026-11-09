// Run: node tests/queue-seek-cancel.cjs. The seek bar's drag state clears on pointercancel and
// lostpointercapture, and pointermove only drags while captured or a button is held.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const code = fs.readFileSync(path.join(__dirname, '..', 'queue.js'), 'utf8').replace(/^import .*$/mg, '').replace(/^export /mg, '');

function el() {
  const listeners = {};
  const node = new Proxy({style: {}, classList: {add() {}, remove() {}, toggle() {}}, listeners, captured: false,
    addEventListener(type, fn) {(listeners[type] ||= []).push(fn);},
    fire(type, event = {}) {(listeners[type] || []).forEach(fn => fn({clientX: 0, pointerId: 1, buttons: 0, ...event}));},
    getBoundingClientRect: () => ({left: 0, width: 100}),
    setPointerCapture() {node.captured = true;}, hasPointerCapture: () => node.captured,
    setAttribute() {}, append() {}, appendChild() {}, querySelector: () => null}, {
    get: (target, key) => (key in target ? target[key] : () => {}),
    set: (target, key, value) => { target[key] = value; return true; }});
  return node;
}

const seeks = [];
const queue = {getPlayback: () => ({loaded: true, duration: 100, position: 0, playing: true}), getState: () => ({items: [], currentId: null, loadingId: null, downloads: []}), seek: s => seeks.push(s), on: () => () => {}, next() {}, previous() {}, togglePlay() {}};
const document = {createElement: el, getElementById: () => ({}), head: el(), body: el()};
const box = {console, Date, Math, performance, Promise, setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {}, document, requestAnimationFrame() {}, window: {}};
vm.createContext(box);
vm.runInContext(code + '\nglobalThis.createTransport = createTransport;', box);

// Find the seek element: the one with a pointerdown listener.
const made = [];
document.createElement = tag => { const node = el(); made.push(node); return node; };
box.createTransport(queue, {ensureContext() {}, setVolume() {}}, {});
const seek = made.find(node => node.listeners.pointerdown);
assert(seek, 'found the seek bar');

// Drag state is observable through the next pointerup: with no drag, pointerup does not seek.
function upSeeks(clientX) { seeks.length = 0; seek.fire('pointerup', {clientX}); return seeks.length > 0; }

seek.fire('pointerdown', {clientX: 20});
seek.fire('pointercancel');
assert.equal(upSeeks(50), false, 'pointercancel ends the drag');

seek.captured = false;
seek.fire('pointerdown', {clientX: 20});
seek.fire('lostpointercapture');
assert.equal(upSeeks(50), false, 'lostpointercapture ends the drag');

seek.captured = false;
seek.fire('pointerdown', {clientX: 20});
seek.captured = false; // capture silently gone, no buttons held
seek.fire('pointermove', {clientX: 70, buttons: 0});
assert.equal(upSeeks(70), false, 'a move with no capture and no button ends the drag');

seek.captured = false;
seek.fire('pointerdown', {clientX: 20});
seek.fire('pointermove', {clientX: 40, buttons: 1});
assert.equal(upSeeks(60), true, 'a normal drag still seeks on pointerup');
assert.equal(seeks[0], 60);
console.log('PASS: seek drag ends on pointercancel / lostpointercapture and only follows a held pointer');
