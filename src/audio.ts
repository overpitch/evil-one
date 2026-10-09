/**
 * Sound effects synthesized with the Web Audio API, so there are no audio
 * files to download. The context starts on the first click (browsers block
 * audio before a user gesture).
 *
 * Routing: effects → sfx bus ┐
 *          music   → music bus ┴→ compressor → master → speakers
 */
let ac: AudioContext | null = null;
let sfxBus: GainNode | null = null;
let musicBus: GainNode | null = null;
let noise: AudioBuffer | null = null;
const volumes = { music: 0.6, sfx: 0.8 };

export function initAudio() {
  if (!ac) {
    ac = new AudioContext();
    const master = ac.createGain();
    master.gain.value = 0.7;
    const limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.ratio.value = 6;
    limiter.connect(master).connect(ac.destination);
    sfxBus = ac.createGain();
    musicBus = ac.createGain();
    sfxBus.connect(limiter);
    musicBus.connect(limiter);
    applyVolumes();
    noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  if (ac.state === 'suspended') void ac.resume();
}

/** Music and effects volume, 0..1 each (from Options). */
export function setVolumes(music: number, effects: number) {
  volumes.music = music;
  volumes.sfx = effects;
  applyVolumes();
}

function applyVolumes() {
  if (!ac || !sfxBus || !musicBus) return;
  // Squared for a more natural-feeling slider.
  sfxBus.gain.setTargetAtTime(0.8 * volumes.sfx ** 2, ac.currentTime, 0.05);
  musicBus.gain.setTargetAtTime(0.55 * volumes.music ** 2, ac.currentTime, 0.05);
}

function ready() {
  return ac && ac.state === 'running' ? ac : null;
}

/** For the music player: the running context and its bus, once audio has started. */
export function musicOutput() {
  const a = ready();
  return a && musicBus ? { ac: a, bus: musicBus } : null;
}

/** A gain node with a quick attack and exponential decay, wired to `dest` (the effects bus by default). */
export function envelope(a: AudioContext, t: number, peak: number, attack: number, decay: number, dest: AudioNode = sfxBus!) {
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(dest);
  return g;
}

export function noiseSource(a: AudioContext, t: number, dur: number) {
  const src = a.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur);
  return src;
}

export function tone(a: AudioContext, type: OscillatorType, from: number, to: number, t: number, dur: number) {
  const o = a.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(from, t);
  if (to !== from) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  o.start(t);
  o.stop(t + dur + 0.05);
  return o;
}

export function filter(a: AudioContext, type: BiquadFilterType, freq: number, q = 1) {
  const f = a.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

function groanVoice(vol: number, base: number, end: number, dur: number) {
  const a = ready();
  if (!a || vol < 0.03) return;
  const t = a.currentTime;
  const voice = tone(a, 'sawtooth', base, end, t, dur);
  const wobble = tone(a, 'sine', 5 + Math.random() * 3, 5, t, dur);
  const depth = a.createGain();
  depth.gain.value = base * 0.08;
  wobble.connect(depth).connect(voice.frequency);
  const formant = filter(a, 'bandpass', 350, 5);
  formant.frequency.setValueAtTime(320, t);
  formant.frequency.linearRampToValueAtTime(650, t + dur * 0.4);
  formant.frequency.linearRampToValueAtTime(300, t + dur);
  voice.connect(formant).connect(envelope(a, t, 0.45 * vol, 0.2, dur));
}

export const sfx = {
  swing(heavy = false, vol = 1) {
    const a = ready();
    if (!a || vol < 0.03) return;
    const t = a.currentTime;
    const dur = heavy ? 0.3 : 0.18;
    const f = filter(a, 'bandpass', 700, 1.4);
    f.frequency.setValueAtTime(heavy ? 400 : 700, t);
    f.frequency.exponentialRampToValueAtTime(heavy ? 1800 : 3200, t + dur * 0.6);
    f.frequency.exponentialRampToValueAtTime(heavy ? 500 : 900, t + dur);
    noiseSource(a, t, dur).connect(f).connect(envelope(a, t, (heavy ? 0.5 : 0.35) * vol, dur * 0.35, dur * 0.65));
  },

  hit(heavy = false, vol = 1) {
    const a = ready();
    if (!a || vol < 0.03) return;
    const t = a.currentTime;
    tone(a, 'sine', heavy ? 140 : 170, 45, t, 0.16).connect(envelope(a, t, (heavy ? 1 : 0.8) * vol, 0.005, 0.2));
    noiseSource(a, t, 0.12).connect(filter(a, 'lowpass', 1500)).connect(envelope(a, t, 0.55 * vol, 0.003, 0.1));
  },

  block(vol = 1) {
    const a = ready();
    if (!a || vol < 0.03) return;
    const t = a.currentTime;
    [880, 1318, 2093, 2794].forEach((f, i) => {
      tone(a, 'triangle', f, f * 0.99, t, 0.5).connect(envelope(a, t, (0.2 / (i + 1)) * vol, 0.002, 0.5 - i * 0.08));
    });
    noiseSource(a, t, 0.06).connect(filter(a, 'highpass', 3000)).connect(envelope(a, t, 0.3 * vol, 0.002, 0.05));
  },

  hurt(vol = 1) {
    const a = ready();
    if (!a || vol < 0.03) return;
    const t = a.currentTime;
    tone(a, 'sawtooth', 260, 110, t, 0.25).connect(filter(a, 'lowpass', 900)).connect(envelope(a, t, 0.35 * vol, 0.01, 0.25));
    tone(a, 'sine', 120, 50, t, 0.15).connect(envelope(a, t, 0.6 * vol, 0.005, 0.15));
  },

  roll() {
    const a = ready();
    if (!a) return;
    const t = a.currentTime;
    const f = filter(a, 'lowpass', 300);
    f.frequency.setValueAtTime(300, t);
    f.frequency.linearRampToValueAtTime(900, t + 0.15);
    f.frequency.linearRampToValueAtTime(250, t + 0.35);
    noiseSource(a, t, 0.4).connect(f).connect(envelope(a, t, 0.3, 0.05, 0.3));
  },

  levelUp() {
    const a = ready();
    if (!a) return;
    const t = a.currentTime;
    // Rising major arpeggio with a shimmering top note.
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      const start = t + i * 0.09;
      tone(a, 'triangle', f, f, start, 0.6).connect(envelope(a, start, 0.28, 0.01, i === 3 ? 0.9 : 0.4));
      tone(a, 'sine', f * 2, f * 2, start, 0.4).connect(envelope(a, start, 0.06, 0.01, 0.35));
    });
  },

  checkpoint() {
    const a = ready();
    if (!a) return;
    const t = a.currentTime;
    [392, 523.25, 659.25].forEach((f) => {
      tone(a, 'triangle', f, f, t, 1.2).connect(envelope(a, t, 0.16, 0.02, 1.1));
    });
  },

  roar() {
    groanVoice(1, 55, 38, 1.8);
    groanVoice(0.7, 82, 50, 1.6);
  },

  /** A witch's cackle: a high voice chopped into "ha-ha-ha". */
  cackle(vol = 1) {
    const a = ready();
    if (!a || vol < 0.03) return;
    const t = a.currentTime;
    const dur = 0.9;
    const voice = tone(a, 'sawtooth', 720 + Math.random() * 120, 460, t, dur);
    const formant = filter(a, 'bandpass', 1400, 4);
    const chop = a.createGain();
    chop.gain.value = 0;
    const lfo = tone(a, 'square', 7.5, 7.5, t, dur);
    const depth = a.createGain();
    depth.gain.value = 0.5;
    lfo.connect(depth).connect(chop.gain);
    voice.connect(formant).connect(chop).connect(envelope(a, t, 0.32 * vol, 0.03, dur));
  },

  /** Vampire hiss. */
  hiss(vol = 1) {
    const a = ready();
    if (!a || vol < 0.03) return;
    const t = a.currentTime;
    noiseSource(a, t, 0.6).connect(filter(a, 'highpass', 2600)).connect(envelope(a, t, 0.3 * vol, 0.06, 0.5));
  },

  /** A witch's dying shriek, also the broom-witch dive warning. */
  screech(vol = 1) {
    const a = ready();
    if (!a || vol < 0.03) return;
    const t = a.currentTime;
    tone(a, 'sawtooth', 1300, 700, t, 0.6).connect(filter(a, 'bandpass', 1800, 3)).connect(envelope(a, t, 0.25 * vol, 0.02, 0.6));
  },

  /** Spell launch: a rising shimmer. */
  cast(vol = 1) {
    const a = ready();
    if (!a || vol < 0.03) return;
    const t = a.currentTime;
    tone(a, 'sine', 300, 1100, t, 0.3).connect(envelope(a, t, 0.18 * vol, 0.02, 0.3));
    noiseSource(a, t, 0.3).connect(filter(a, 'bandpass', 3000, 2)).connect(envelope(a, t, 0.12 * vol, 0.02, 0.25));
  },

  /** Meteor impact. */
  explode(vol = 1) {
    const a = ready();
    if (!a || vol < 0.03) return;
    const t = a.currentTime;
    tone(a, 'sine', 90, 30, t, 0.5).connect(envelope(a, t, 0.9 * vol, 0.005, 0.5));
    noiseSource(a, t, 0.6).connect(filter(a, 'lowpass', 600)).connect(envelope(a, t, 0.6 * vol, 0.005, 0.55));
  },

  /** A flurry of wings. */
  bats(vol = 1) {
    const a = ready();
    if (!a || vol < 0.03) return;
    const t = a.currentTime;
    const flutter = a.createGain();
    flutter.gain.value = 0;
    const lfo = tone(a, 'square', 22, 22, t, 1.4);
    const depth = a.createGain();
    depth.gain.value = 0.5;
    lfo.connect(depth).connect(flutter.gain);
    noiseSource(a, t, 1.4).connect(filter(a, 'bandpass', 900, 1.5)).connect(flutter).connect(envelope(a, t, 0.35 * vol, 0.1, 1.2));
  },

  /** A soft footfall. */
  step(vol = 1) {
    const a = ready();
    if (!a || vol < 0.03) return;
    const t = a.currentTime;
    noiseSource(a, t, 0.08).connect(filter(a, 'lowpass', 500 + Math.random() * 300)).connect(envelope(a, t, 0.18 * vol, 0.004, 0.07));
  },

  /** Menu button click. */
  click() {
    const a = ready();
    if (!a) return;
    const t = a.currentTime;
    tone(a, 'triangle', 900, 600, t, 0.06).connect(envelope(a, t, 0.12, 0.002, 0.06));
  },

  /** A war horn: the enemy counterattacks. */
  warHorn() {
    const a = ready();
    if (!a) return;
    const t = a.currentTime;
    for (const detune of [0, 4]) {
      const o = tone(a, 'sawtooth', 98 + detune, 98 + detune, t, 1.6);
      o.frequency.setValueAtTime(82 + detune, t);
      o.frequency.linearRampToValueAtTime(98 + detune, t + 0.25);
      o.frequency.setValueAtTime(98 + detune, t + 1.2);
      o.frequency.linearRampToValueAtTime(92 + detune, t + 1.6);
      o.connect(filter(a, 'lowpass', 700, 2)).connect(envelope(a, t, 0.28, 0.2, 1.4));
    }
  },

  /** A rising horn call: an outpost is ours. */
  victoryHorn() {
    const a = ready();
    if (!a) return;
    const t = a.currentTime;
    [261.6, 329.6, 392, 523.3].forEach((f, i) => {
      const start = t + i * 0.16;
      tone(a, 'sawtooth', f, f, start, i === 3 ? 0.9 : 0.2).connect(filter(a, 'lowpass', 1400, 1)).connect(envelope(a, start, 0.14, 0.03, i === 3 ? 0.9 : 0.2));
    });
  },

  /** Heartbeat when badly hurt. */
  heartbeat() {
    const a = ready();
    if (!a) return;
    const t = a.currentTime;
    for (const [dt, peak] of [[0, 0.5], [0.22, 0.35]]) {
      tone(a, 'sine', 70, 45, t + dt, 0.14).connect(envelope(a, t + dt, peak, 0.01, 0.15));
    }
  },

  /** vol is 0..1, usually from distance to the listener. */
  groan(vol = 1) {
    const base = 70 + Math.random() * 30;
    groanVoice(vol, base, base * 0.8, 1 + Math.random() * 0.5);
  },

  zombieDie(vol = 1) {
    groanVoice(vol, 75, 32, 1.4);
  },
};

/** Volume for a sound at a distance (meters) from the player. */
export const volumeAt = (dist: number) => Math.max(0, 1 - dist / 30);
