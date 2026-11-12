// Pause on the idle / round-over overlay must not freeze the next countdown; page has a viewport meta.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const html = fs.readFileSync(__dirname + '/../arcade-versus.html', 'utf8');
const take = (from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
assert(/<meta name="viewport" content="width=device-width, initial-scale=1">/.test(html), 'viewport meta');
assert(html.includes('@media (max-width: 1100px)'), 'one-column breakpoint at 1100px');
let labels = 0;
const box = {console, beep() {}, musicSync() {}, showOverlay() {}, pauseLabel() {labels++;}};
vm.createContext(box);
vm.runInContext(`let paused = true;
const state = {phase: 'idle', game: {init() {}, roundTime: 0}};
${take('function startRound()', 'function endRound()')}
startRound();`, box);
assert.equal(vm.runInContext('paused', box), false, 'startRound clears pause');
assert.equal(vm.runInContext('state.phase', box), 'countdown');
assert(labels > 0, 'pause button label refreshed');
console.log('PASS: Arcade startRound clears pause; viewport meta and breakpoint present');
