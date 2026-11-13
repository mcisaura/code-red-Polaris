// Shared by tests/yt-*.cjs (it runs no checks itself): a stub of ytEmbed.js's player pair and a queue.js harness.
// The stub's `e` is the "current" player and `e.second` the "incoming" one; e.swap() trades their roles by
// exchanging their state, exactly as the real object trades which IFrame player each role talks to.
const fs = require('fs'), path = require('path'), vm = require('vm');
const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8').replace(/^import .*$/mg, '').replace(/^export /mg, '');
const ytSource = read('ytEmbed.js'), queueSource = read('queue.js');
const STATE = ['log', 'loads', 'loadOptions', 'playing', 'time', 'duration', 'volume', 'volumes', 'rate', 'stops'];

function stubPlayer({failLoad = false} = {}) {
  const e = {
    log: [], primes: [], loads: [], loadOptions: [], playing: false, time: 0, duration: 200, volume: null, volumes: [], rate: null, stops: 0,
    ended: new Set(), errors: new Set(),
    async load(id, options = {}) {
      e.log.push('load'); e.loads.push(id); e.loadOptions.push(options);
      if (failLoad) throw new Error("YouTube's player couldn't be loaded");
      if (Number.isFinite(options.volume)) { e.volume = options.volume; e.volumes.push(options.volume); }
      if (Number.isFinite(options.rate)) e.rate = options.rate;
      e.playing = true;
    },
    async prime(id) { e.primes.push(id); },
    play() { e.log.push('play'); e.playing = true; },
    pause() { e.log.push('pause'); e.playing = false; },
    seekTo(seconds) { e.log.push('seek ' + seconds); e.time = seconds; },
    setVolume(v) { e.volume = v; e.volumes.push(v); },
    setRate(r) { e.rate = r; },
    getTime: () => e.time,
    getDuration: () => e.duration,
    isPlaying: () => e.playing,
    onEnded(cb) { e.ended.add(cb); return () => e.ended.delete(cb); },
    onError(cb) { e.errors.add(cb); return () => e.errors.delete(cb); },
    stop() { e.stops += 1; e.playing = false; },
    fireEnded() { e.playing = false; [...e.ended].forEach((cb) => cb()); },
    fireError(message = 'the video\'s owner doesn\'t allow it to play in other sites', code = 150) { [...e.errors].forEach((cb) => cb(message, code)); },
  };
  return e;
}

function stubEmbed({failLoad = false, pair = true} = {}) {
  const e = stubPlayer({failLoad});
  if (pair) {
    e.second = stubPlayer();
    e.swaps = 0;
    e.swap = () => {
      e.swaps += 1;
      for (const key of STATE) [e[key], e.second[key]] = [e.second[key], e[key]];
    };
  }
  return e;
}

const SONGS = [
  {id: 'glaG64Ao7sM', artist: 'Kendrick Lamar', title: 'ELEMENT.', bpm: 96, genre: 'hip-hop'},
  {id: 'mlmAWdh4qoY', artist: 'Drake', title: 'Nice For What', bpm: 93, genre: 'hip-hop'},
  {id: 'fHI8X4OXluQ', artist: 'The Weeknd', title: 'Blinding Lights', bpm: 171, genre: 'synth-pop / dance'},
];
const HOSTED = {youtube: false, youtubeEmbed: true, hosted: true};

// A queue.js (and ytEmbed.js) in a vm with a stub deck, stub transitions and a fake fetch.
function setup({embed = stubEmbed(), songs = [], config = {youtube: true, youtubeEmbed: false, hosted: false}, picks = [], clock = null, info = null, navigator = undefined} = {}) {
  const intervals = [], mixes = [], fetched = [];
  const deck = {
    playing: false, buffer: null, offset: 0, rate: 1, volume: null, speed: null,
    setVolume(v) { this.volume = v; }, setSpeed(s) { this.speed = s; }, setFrequency() {}, ensureContext() {},
    stopSource() { this.playing = false; }, play() { this.playing = true; }, pause() { this.playing = false; },
    toggle() { this.playing = !this.playing; }, position: () => 0,
  };
  const transitions = {
    prepare() {}, cancel() {}, holdSpeed() {}, resetSpeed() {},
    mixPoint: () => 0, mixOutPoint: () => 9, mixStartPoint: () => 0, entryPoint: () => 0,
    async mixInto(buffer) { mixes.push(buffer.label); return null; },
  };
  const box = {
    console: {log() {}, info() {}, warn() {}, error: console.error}, Date: clock ? {now: () => clock.t} : Date, Math, URL, Promise, setTimeout, clearTimeout, performance: {now: () => 1e7},
    setInterval: (fn) => { intervals.push(fn); return intervals.length; }, clearInterval() {},
    createTransitions: () => transitions, ...(navigator ? {navigator} : {}),
    OfflineAudioContext: class { async decodeAudioData(data) { return {duration: 10, label: String(data)}; } },
    fetch: async (url, options = {}) => {
      fetched.push(`${options.method ?? 'GET'} ${url}`);
      if (options.method === 'HEAD') return {ok: true};
      if (/^music\//.test(url)) return {ok: true, status: 200, arrayBuffer: async () => url};
      if (url === 'library.json') return {ok: true, json: async () => ({songs})};
      if (url === '/api/config') return {ok: true, json: async () => config};
      if (url.startsWith('/api/youtube/info')) {
        if (info) return info(url.split('id=')[1]);
        return {ok: true, status: 200, json: async () => ({title: 'Real Title', author: 'Chan'})};
      }
      if (url === '/api/dj/pick') return {ok: true, json: async () => ({picks})};
      return {ok: false, json: async () => ({})};
    },
  };
  vm.createContext(box);
  vm.runInContext(ytSource + '\n' + queueSource + '\nglobalThis.createQueue = createQueue; globalThis.api = {createQueue, createQueuePanel, loadConfig};', box);
  const queue = box.createQueue(deck, {embed});
  const addSong = (name) => queue.addFile({name: name + '.wav', arrayBuffer: async () => name});
  const ids = () => Array.from(queue.getState().items, (item) => item.id);
  const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  return {queue, deck, embed, intervals, mixes, fetched, box, addSong, ids, settle, sleep};
}

module.exports = {stubEmbed, stubPlayer, setup, SONGS, HOSTED, ytSource, queueSource};
