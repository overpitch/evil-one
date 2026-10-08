/**
 * Sound effects synthesized with the Web Audio API, so there are no audio
 * files to download. The context starts on the first click (browsers block
 * audio before a user gesture).
 */
let ac: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;

export function initAudio() {
  if (!ac) {
    ac = new AudioContext();
    master = ac.createGain();
    master.gain.value = 0.55;
    master.connect(ac.destination);
    noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  if (ac.state === 'suspended') void ac.resume();
}

function ready() {
  return ac && ac.state === 'running' ? ac : null;
}

/** A gain node with a quick attack and exponential decay, wired to the master bus. */
function envelope(a: AudioContext, t: number, peak: number, attack: number, decay: number) {
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(master!);
  return g;
}

function noiseSource(a: AudioContext, t: number, dur: number) {
  const src = a.createBufferSource();
  src.buffer = noise;
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur);
  return src;
}

function tone(a: AudioContext, type: OscillatorType, from: number, to: number, t: number, dur: number) {
  const o = a.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(from, t);
  if (to !== from) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  o.start(t);
  o.stop(t + dur + 0.05);
  return o;
}

function filter(a: AudioContext, type: BiquadFilterType, freq: number, q = 1) {
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
  swing(heavy = false) {
    const a = ready();
    if (!a) return;
    const t = a.currentTime;
    const dur = heavy ? 0.3 : 0.18;
    const f = filter(a, 'bandpass', 700, 1.4);
    f.frequency.setValueAtTime(heavy ? 400 : 700, t);
    f.frequency.exponentialRampToValueAtTime(heavy ? 1800 : 3200, t + dur * 0.6);
    f.frequency.exponentialRampToValueAtTime(heavy ? 500 : 900, t + dur);
    noiseSource(a, t, dur).connect(f).connect(envelope(a, t, heavy ? 0.5 : 0.35, dur * 0.35, dur * 0.65));
  },

  hit(heavy = false) {
    const a = ready();
    if (!a) return;
    const t = a.currentTime;
    tone(a, 'sine', heavy ? 140 : 170, 45, t, 0.16).connect(envelope(a, t, heavy ? 1 : 0.8, 0.005, 0.2));
    noiseSource(a, t, 0.12).connect(filter(a, 'lowpass', 1500)).connect(envelope(a, t, 0.55, 0.003, 0.1));
  },

  block() {
    const a = ready();
    if (!a) return;
    const t = a.currentTime;
    [880, 1318, 2093, 2794].forEach((f, i) => {
      tone(a, 'triangle', f, f * 0.99, t, 0.5).connect(envelope(a, t, 0.2 / (i + 1), 0.002, 0.5 - i * 0.08));
    });
    noiseSource(a, t, 0.06).connect(filter(a, 'highpass', 3000)).connect(envelope(a, t, 0.3, 0.002, 0.05));
  },

  hurt() {
    const a = ready();
    if (!a) return;
    const t = a.currentTime;
    tone(a, 'sawtooth', 260, 110, t, 0.25).connect(filter(a, 'lowpass', 900)).connect(envelope(a, t, 0.35, 0.01, 0.25));
    tone(a, 'sine', 120, 50, t, 0.15).connect(envelope(a, t, 0.6, 0.005, 0.15));
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
