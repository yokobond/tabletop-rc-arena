import type { PlayerId } from '../game/types';

interface EngineVoice {
  osc: OscillatorNode;
  sub: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
}

/** Every sound is synthesized; there are no audio files to load. */
class AudioSynth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private engines: Partial<Record<PlayerId, EngineVoice>> = {};
  private muted = false;

  /** Must be called from a user gesture for browsers to allow playback. */
  unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.55;
      const compressor = this.ctx.createDynamicsCompressor();
      this.master.connect(compressor).connect(this.ctx.destination);
      const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this.noise = buffer;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(muted ? 0 : 0.55, this.ctx.currentTime, 0.02);
  }

  private tone(type: OscillatorType, from: number, to: number, duration: number, volume: number, delay = 0) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + duration);
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  private burst(frequency: number, q: number, duration: number, volume: number, delay = 0) {
    if (!this.ctx || !this.master || !this.noise) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t, Math.random() * 0.8);
    src.stop(t + duration + 0.02);
  }

  private engineVoice(player: PlayerId) {
    if (!this.ctx || !this.master) return null;
    const existing = this.engines[player];
    if (existing) return existing;
    const osc = this.ctx.createOscillator();
    const sub = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    sub.type = 'square';
    filter.type = 'lowpass';
    filter.frequency.value = 500;
    gain.gain.value = 0;
    osc.connect(filter);
    sub.connect(filter);
    filter.connect(gain).connect(this.master);
    osc.start();
    sub.start();
    const voice = { osc, sub, filter, gain };
    this.engines[player] = voice;
    return voice;
  }

  /** `speed` is 0..1 of the top speed; `active` is false when the car is out of play. */
  updateEngine(player: PlayerId, speed: number, boosting: boolean, active: boolean) {
    const voice = this.engineVoice(player);
    if (!voice || !this.ctx) return;
    const t = this.ctx.currentTime;
    // A slight offset keeps the two motors audibly separate.
    const base = (player === 'p1' ? 92 : 104) + speed * 300 + (boosting ? 95 : 0);
    voice.osc.frequency.setTargetAtTime(base, t, 0.04);
    voice.sub.frequency.setTargetAtTime(base * 0.5, t, 0.04);
    voice.filter.frequency.setTargetAtTime(420 + speed * 1500 + (boosting ? 900 : 0), t, 0.06);
    const level = active ? 0.012 + speed * 0.045 + (boosting ? 0.025 : 0) : 0;
    voice.gain.gain.setTargetAtTime(level, t, 0.08);
  }

  silenceEngines() {
    for (const id of ['p1', 'p2'] as PlayerId[]) this.updateEngine(id, 0, false, false);
  }

  crash(strength: number, boosted: boolean) {
    const v = Math.min(1, 0.3 + strength * 0.16);
    this.burst(1500, 0.7, 0.13, v * 0.8);
    this.tone('square', 170, 55, 0.16, v * 0.5);
    if (boosted) this.burst(3400, 2, 0.24, v * 0.4, 0.02);
  }

  bump(surface: 'mug' | 'books' | 'prop', strength: number) {
    const v = Math.min(0.6, 0.12 + strength * 0.11);
    if (surface === 'mug') {
      // Ceramic: a bright "tink" with a little ring.
      this.tone('sine', 1850, 1720, 0.22, v * 0.7);
      this.tone('sine', 3120, 2950, 0.12, v * 0.28);
    } else if (surface === 'books') {
      this.tone('triangle', 130, 62, 0.12, v);
      this.burst(420, 1.1, 0.08, v * 0.7);
    } else {
      this.burst(2200, 3, 0.05, v * 0.8);
    }
  }

  jump() {
    this.tone('triangle', 320, 720, 0.17, 0.2);
  }

  land(strength: number) {
    this.burst(600, 0.8, 0.09, Math.min(0.5, 0.12 + strength * 0.08));
  }

  boost() {
    this.burst(900, 0.6, 0.32, 0.3);
    this.tone('sawtooth', 200, 620, 0.26, 0.09);
  }

  fall() {
    this.tone('sine', 880, 120, 0.8, 0.28);
    this.tone('triangle', 620, 90, 0.8, 0.1);
  }

  floor() {
    this.tone('square', 210, 70, 0.08, 0.28);
    this.burst(2600, 1.4, 0.1, 0.28);
    this.burst(1300, 1.4, 0.08, 0.16, 0.09);
  }

  respawn() {
    this.tone('sine', 420, 900, 0.22, 0.17);
    this.tone('sine', 640, 1320, 0.22, 0.09, 0.07);
  }

  countdown() {
    this.tone('square', 620, 620, 0.13, 0.13);
  }

  go() {
    this.tone('square', 1040, 1040, 0.42, 0.15);
  }

  score() {
    [660, 880].forEach((f, i) => this.tone('triangle', f, f, 0.17, 0.2, i * 0.1));
  }

  win() {
    [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone('triangle', f, f, 0.32, 0.2, i * 0.11));
  }
}

export const audio = new AudioSynth();
