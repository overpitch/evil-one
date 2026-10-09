import { envelope, filter, musicOutput, noiseSource, tone } from './audio';

/**
 * Procedural soundtrack: a little step sequencer that schedules synthesized
 * instruments a fraction of a second ahead on the Web Audio clock, and
 * crossfades between themes as the game's situation changes.
 */
export type Theme = 'silence' | 'title' | 'explore' | 'battle' | 'boss' | 'victory';
export type Mood = 'camp' | 'zombie' | 'witch' | 'vampire' | 'fortress';

const FADE = 2.5;
const LOOKAHEAD = 0.25;

/** MIDI note number → frequency. */
const hz = (n: number) => 440 * 2 ** ((n - 69) / 12);

/** Four-chord loops per land (MIDI triads), each with its own flavor. */
const PROGRESSIONS: Record<Mood, number[][]> = {
  camp: [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]], // C Am F G: hopeful
  zombie: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]], // Am F C G: melancholy
  witch: [[50, 53, 57], [51, 55, 58], [50, 53, 57], [48, 52, 55]], // Dm Eb Dm C: strange
  vampire: [[52, 55, 59], [48, 52, 55], [47, 51, 54], [52, 55, 59]], // Em C B Em: gothic
  fortress: [[48, 51, 55], [49, 53, 56], [44, 48, 51], [43, 47, 50]], // Cm Db Ab G: dread
};

const TITLE_CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [52, 56, 59]]; // Am F C E
const TITLE_MELODY = [69, 0, 72, 0, 71, 0, 64, 0, 67, 0, 65, 0, 64, 0, 0, 0];
const VICTORY_CHORDS = [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]]; // C G Am F
const FANFARE = [60, 0, 64, 0, 67, 0, 0, 0, 72, 0, 0, 0, 67, 0, 72, 0];

interface Voice {
  ac: AudioContext;
  out: AudioNode;
}

// ---------- Instruments ----------

/** A gain node shaped attack → hold → release (for sustained notes). */
function shaped({ ac, out }: Voice, t: number, peak: number, attack: number, hold: number, release: number) {
  const g = ac.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.setValueAtTime(peak, t + attack + hold);
  g.gain.linearRampToValueAtTime(0, t + attack + hold + release);
  g.connect(out);
  return g;
}

function pad(v: Voice, notes: number[], t: number, dur: number, vol = 0.05, cutoff = 900) {
  const g = shaped(v, t, vol, 0.7, Math.max(0, dur - 0.7), 0.9);
  const f = filter(v.ac, 'lowpass', cutoff, 0.7);
  f.connect(g);
  for (const n of notes) {
    for (const detune of [-7, 7]) {
      const o = tone(v.ac, 'sawtooth', hz(n), hz(n), t, dur + 1.6);
      o.detune.value = detune;
      o.connect(f);
    }
  }
}

function pluck(v: Voice, n: number, t: number, vol = 0.09, type: OscillatorType = 'triangle') {
  const o = tone(v.ac, type, hz(n), hz(n), t, 0.6);
  const f = filter(v.ac, 'lowpass', type === 'triangle' ? 3000 : 1800);
  o.connect(f).connect(envelope(v.ac, t, vol, 0.005, 0.55, v.out));
}

function bass(v: Voice, n: number, t: number, dur: number, vol = 0.12) {
  const o = tone(v.ac, 'sawtooth', hz(n), hz(n), t, dur);
  o.connect(filter(v.ac, 'lowpass', 280, 2)).connect(envelope(v.ac, t, vol, 0.01, dur, v.out));
}

function bell(v: Voice, n: number, t: number, vol = 0.07) {
  tone(v.ac, 'sine', hz(n), hz(n), t, 2.2).connect(envelope(v.ac, t, vol, 0.005, 2.2, v.out));
  tone(v.ac, 'sine', hz(n) * 2.76, hz(n) * 2.76, t, 0.8).connect(envelope(v.ac, t, vol * 0.3, 0.005, 0.8, v.out));
}

function brass(v: Voice, notes: number[], t: number, dur: number, vol = 0.05) {
  const g = shaped(v, t, vol, 0.04, dur * 0.6, dur * 0.4);
  const f = filter(v.ac, 'lowpass', 500, 1.5);
  f.frequency.setValueAtTime(500, t);
  f.frequency.linearRampToValueAtTime(2200, t + 0.08);
  f.frequency.linearRampToValueAtTime(800, t + dur);
  f.connect(g);
  for (const n of notes) {
    for (const detune of [-5, 5]) {
      const o = tone(v.ac, 'sawtooth', hz(n), hz(n), t, dur + 0.1);
      o.detune.value = detune;
      o.connect(f);
    }
  }
}

/** A wordless choir: sawtooth voices with vibrato through an "ah" formant. */
function choir(v: Voice, notes: number[], t: number, dur: number, vol = 0.05) {
  const g = shaped(v, t, vol, 0.9, Math.max(0, dur - 0.9), 1.2);
  const formant = filter(v.ac, 'bandpass', 750, 3);
  formant.connect(g);
  for (const n of notes) {
    const o = tone(v.ac, 'sawtooth', hz(n), hz(n), t, dur + 2.2);
    const lfo = tone(v.ac, 'sine', 5 + Math.random(), 5, t, dur + 2.2);
    const depth = v.ac.createGain();
    depth.gain.value = hz(n) * 0.012;
    lfo.connect(depth).connect(o.frequency);
    o.connect(formant);
  }
}

function kick(v: Voice, t: number, vol = 0.5) {
  tone(v.ac, 'sine', 130, 42, t, 0.18).connect(envelope(v.ac, t, vol, 0.004, 0.2, v.out));
}

function snare(v: Voice, t: number, vol = 0.18) {
  noiseSource(v.ac, t, 0.18).connect(filter(v.ac, 'bandpass', 1800, 0.8)).connect(envelope(v.ac, t, vol, 0.002, 0.16, v.out));
  tone(v.ac, 'triangle', 220, 160, t, 0.08).connect(envelope(v.ac, t, vol * 0.6, 0.002, 0.08, v.out));
}

function hat(v: Voice, t: number, vol = 0.05) {
  noiseSource(v.ac, t, 0.05).connect(filter(v.ac, 'highpass', 7000)).connect(envelope(v.ac, t, vol, 0.001, 0.04, v.out));
}

function tom(v: Voice, t: number, pitch: number, vol = 0.3) {
  tone(v.ac, 'sine', pitch, pitch * 0.6, t, 0.25).connect(envelope(v.ac, t, vol, 0.004, 0.25, v.out));
}

// ---------- Themes ----------

interface ThemeDef {
  bpm: number;
  /** Plays one sixteenth-note step. */
  step(v: Voice, step: number, t: number, mood: Mood): void;
}

const THEMES: Record<Exclude<Theme, 'silence'>, ThemeDef> = {
  title: {
    bpm: 60,
    step(v, step, t) {
      const bar = Math.floor(step / 16);
      const s = step % 16;
      const beat = 60 / 60;
      const chord = TITLE_CHORDS[bar % 4];
      if (s === 0) {
        pad(v, chord, t, beat * 4, 0.045, 700);
        bass(v, chord[0] - 24, t, beat * 3.5, 0.1);
        if (bar % 2 === 0) choir(v, [chord[0] - 12, chord[2] - 12], t, beat * 8, 0.03);
      }
      const m = TITLE_MELODY[(bar % 2) * 8 + s / 2];
      if (s % 2 === 0 && m && bar >= 2) bell(v, m, t, 0.06);
    },
  },
  explore: {
    bpm: 76,
    step(v, step, t, mood) {
      const bar = Math.floor(step / 16);
      const s = step % 16;
      const barDur = (60 / 76) * 4;
      const chord = PROGRESSIONS[mood][bar % 4];
      const dark = mood === 'fortress' || mood === 'vampire';
      if (s === 0) {
        pad(v, chord, t, barDur, mood === 'camp' ? 0.04 : 0.05, dark ? 600 : 900);
        bass(v, chord[0] - 24, t, barDur * 0.45, 0.09);
        if (mood === 'fortress' && bar % 2 === 0) choir(v, [chord[0] - 12, chord[1] - 12], t, barDur * 2, 0.035);
      }
      if (s === 8) bass(v, chord[0] - 24 + (bar % 2 ? 7 : 0), t, barDur * 0.4, 0.07);
      // A sparse arpeggio over the chord.
      const pattern = [0, 3, 6, 8, 11, 14];
      const idx = pattern.indexOf(s);
      if (idx >= 0 && Math.random() < 0.75) {
        const type: OscillatorType = mood === 'vampire' ? 'sawtooth' : mood === 'witch' ? 'square' : 'triangle';
        const n = chord[idx % 3] + 12 + (Math.random() < 0.25 ? 12 : 0);
        pluck(v, n, t, type === 'triangle' ? 0.08 : 0.035, type);
      }
      if (s === 0 && bar % 4 === 3) bell(v, chord[2] + 12, t, 0.05);
    },
  },
  battle: {
    bpm: 126,
    step(v, step, t, mood) {
      const bar = Math.floor(step / 16);
      const s = step % 16;
      const chord = PROGRESSIONS[mood === 'camp' ? 'zombie' : mood][Math.floor(bar / 2) % 4];
      if (s === 0 || s === 8 || (s === 10 && bar % 2 === 1)) kick(v, t);
      if (s === 4 || s === 12) snare(v, t);
      if (s % 2 === 0) hat(v, t, s % 4 === 0 ? 0.05 : 0.03);
      if (s % 2 === 0) bass(v, chord[0] - 24 + (s % 8 === 6 ? 7 : 0), t, 0.2, 0.11);
      if (s === 0) {
        brass(v, chord, t, 0.35, 0.045);
        pad(v, chord, t, (60 / 126) * 4, 0.02, 700);
      }
      if (s === 6 || s === 10) brass(v, [chord[0] + 12], t, 0.18, 0.04);
    },
  },
  boss: {
    bpm: 138,
    step(v, step, t, mood) {
      const bar = Math.floor(step / 16);
      const s = step % 16;
      const prog = mood === 'camp' ? PROGRESSIONS.fortress : PROGRESSIONS[mood];
      const chord = prog[Math.floor(bar / 2) % 4];
      const barDur = (60 / 138) * 4;
      if (s === 0 || s === 3 || s === 8 || s === 11) kick(v, t, 0.55);
      if (s === 4 || s === 12) snare(v, t, 0.2);
      if (bar % 4 === 3 && s >= 13) snare(v, t, 0.12);
      if (bar % 4 === 3 && (s === 8 || s === 10)) tom(v, t, s === 8 ? 180 : 130);
      hat(v, t, s % 2 === 0 ? 0.04 : 0.02);
      if (s % 2 === 0) bass(v, chord[0] - 24, t, 0.18, 0.13);
      if (s === 0 && bar % 2 === 0) choir(v, [chord[0] - 12, chord[1] - 12, chord[2] - 12], t, barDur * 2, 0.04);
      if (s === 0) brass(v, [chord[0], chord[2]], t, 0.4, 0.04);
      if (bar % 2 === 1) {
        const motif: Record<number, number> = { 0: chord[0] + 12, 6: chord[1] + 12, 10: chord[2] + 12, 14: chord[1] + 12 };
        if (motif[s]) bell(v, motif[s], t, 0.05);
      }
    },
  },
  victory: {
    bpm: 92,
    step(v, step, t) {
      const bar = Math.floor(step / 16);
      const s = step % 16;
      const chord = VICTORY_CHORDS[bar % 4];
      const barDur = (60 / 92) * 4;
      if (bar < 2) {
        // Opening fanfare.
        const n = FANFARE[s];
        if (bar === 0 && n) brass(v, [n, n - 12], t, s === 8 ? 0.9 : 0.25, 0.06);
        if (bar === 1 && s === 0) brass(v, [72, 67, 64, 60], t, 1.8, 0.05);
        if (s === 0 || s === 8) kick(v, t, 0.35);
        if (s === 4 || s === 12) snare(v, t, 0.12);
        return;
      }
      if (s === 0) {
        pad(v, chord, t, barDur, 0.045, 1100);
        bass(v, chord[0] - 24, t, barDur * 0.5, 0.09);
      }
      if ([0, 3, 6, 8, 11, 14].includes(s)) pluck(v, chord[[0, 3, 6, 8, 11, 14].indexOf(s) % 3] + 12, t, 0.07);
      if (s === 0 && bar % 2 === 0) bell(v, chord[2] + 24, t, 0.05);
    },
  },
};

interface Track {
  key: string;
  theme: Exclude<Theme, 'silence'>;
  mood: Mood;
  gain: GainNode;
  step: number;
  next: number;
  stopAt: number | null;
}

export class Music {
  private theme: Theme = 'silence';
  private mood: Mood = 'camp';
  private readonly tracks: Track[] = [];

  constructor() {
    // Scheduled on a timer rather than animation frames so it keeps time steadily.
    setInterval(() => this.pump(), 50);
  }

  /** What should be playing. Changes crossfade over a couple of seconds. */
  set(theme: Theme, mood: Mood = this.mood) {
    this.theme = theme;
    this.mood = mood;
  }

  private pump() {
    const out = musicOutput();
    if (!out) return;
    const { ac, bus } = out;
    const now = ac.currentTime;
    // Mood only matters for the land-flavored themes.
    const key = this.theme === 'explore' || this.theme === 'battle' || this.theme === 'boss' ? `${this.theme}:${this.mood}` : this.theme;
    const playing = this.tracks.find((t) => t.stopAt === null);
    if (playing?.key !== key) {
      if (playing) {
        playing.stopAt = now + FADE;
        playing.gain.gain.cancelScheduledValues(now);
        playing.gain.gain.setValueAtTime(playing.gain.gain.value, now);
        playing.gain.gain.linearRampToValueAtTime(0, now + FADE);
      }
      if (this.theme !== 'silence') {
        const gain = ac.createGain();
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(1, now + FADE);
        gain.connect(bus);
        this.tracks.push({ key, theme: this.theme, mood: this.mood, gain, step: 0, next: now + 0.05, stopAt: null });
      }
    }
    for (let i = this.tracks.length - 1; i >= 0; i--) {
      const track = this.tracks[i];
      if (track.stopAt !== null && now > track.stopAt) {
        track.gain.disconnect();
        this.tracks.splice(i, 1);
        continue;
      }
      const def = THEMES[track.theme];
      const stepDur = 60 / def.bpm / 4;
      const voice = { ac, out: track.gain };
      while (track.next < now + LOOKAHEAD) {
        def.step(voice, track.step, track.next, track.mood);
        track.step++;
        track.next += stepDur;
      }
    }
  }
}
