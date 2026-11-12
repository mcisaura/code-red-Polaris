// AirMix's deck (ai-dj.html): a frozen copy of audio.js, the hand tracker's
// one-song deck, so changes to audio.js can't break AirMix's mixing
// (transitions.js and queue.js use this class's fields).
//
// AirDeck audio engine: one looping track with speed, filter frequency and volume.
// Graph: source → low-pass filter → gain → analyser → speakers
// The analyser sits after the gain so the waveform reflects what you hear.

const RAMP = 0.05; // seconds; smooths parameter changes so they never click

export class Deck {
  constructor() {
    this.ctx = null;
    this.buffer = null;
    this.source = null;
    this.rate = 1;
    this.offset = 0;        // position in the track (seconds) when paused
    this.anchorTime = 0;    // ctx.currentTime when offset was last updated
    this.playing = false;
  }

  // AudioContext must be created after a user click (browser autoplay rules).
  ensureContext() {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 20000;
    this.filter.Q.value = 1;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0.8;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.filter.connect(this.gain).connect(this.analyser).connect(this.ctx.destination);
    this.waveData = new Float32Array(this.analyser.fftSize);
  }

  async loadUrl(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`could not fetch audio (${res.status})`);
    await this.loadArrayBuffer(await res.arrayBuffer());
  }

  async loadFile(file) {
    await this.loadArrayBuffer(await file.arrayBuffer());
  }

  async loadArrayBuffer(data) {
    this.ensureContext();
    const buffer = await this.ctx.decodeAudioData(data);
    const wasPlaying = this.playing;
    this.stopSource();
    this.buffer = buffer;
    this.offset = 0;
    if (wasPlaying) this.play();
  }

  // Current position in the track, accounting for speed changes.
  position() {
    if (!this.playing) return this.offset;
    return this.offset + Math.max(0, this.ctx.currentTime - this.anchorTime) * this.rate;
  }

  play() {
    if (!this.buffer || this.playing) return;
    this.ctx.resume();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = true;
    src.playbackRate.value = this.rate;
    src.connect(this.filter);
    src.start(0, this.offset % this.buffer.duration);
    this.source = src;
    this.anchorTime = this.ctx.currentTime;
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.position() % this.buffer.duration;
    this.stopSource();
  }

  stopSource() {
    if (this.source) {
      this.source.stop();
      this.source.disconnect();
      this.source = null;
    }
    this.playing = false;
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  // Playback speed (also shifts pitch, like a turntable). 1 = normal.
  setSpeed(rate) {
    if (this.playing && this.ctx.currentTime >= this.anchorTime) {
      this.offset = this.position();
      this.anchorTime = this.ctx.currentTime;
    }
    this.rate = rate;
    if (this.source) this.source.playbackRate.setTargetAtTime(rate, this.ctx.currentTime, RAMP);
  }

  // Low-pass cutoff in Hz: low = muffled, 20000 = full sound.
  setFrequency(hz) {
    if (this.ctx) this.filter.frequency.setTargetAtTime(hz, this.ctx.currentTime, RAMP);
  }

  // Volume 0–1.
  setVolume(v) {
    if (this.ctx) this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, RAMP);
  }

  // Latest audio samples (-1..1), or null before audio starts.
  waveform() {
    if (!this.ctx) return null;
    this.analyser.getFloatTimeDomainData(this.waveData);
    return this.waveData;
  }
}
