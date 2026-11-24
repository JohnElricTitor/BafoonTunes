// Shared app state + a tiny event bus.

export const KNOBS = [
  { id: 'vibrato', label: 'Vibrato', def: 0 },
  { id: 'keysVol', label: 'Keys Vol', def: 0.8 },
  { id: 'padsVol', label: 'Pads Vol', def: 0.8 },
  { id: 'volume', label: 'Master', def: 0.8 },
  { id: 'tone', label: 'Tone', def: 1 },
  { id: 'reverb', label: 'Reverb', def: 0.15 },
  { id: 'echo', label: 'Echo', def: 0 },
  { id: 'release', label: 'Release', def: 0.3 },
];
export const K = { vibrato: 0, keysVol: 1, padsVol: 2, volume: 3, tone: 4, reverb: 5, echo: 6, release: 7 };

export const TRACK_COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#4dabf7', '#9775fa', '#f783ac'];

export function defaultProject() {
  return {
    name: 'My Song',
    bpm: 90,
    bars: 4,
    metronome: true,
    countIn: true,
    quantize: 16,
    keyboardSound: null,
    keyOverrides: {},          // { midiNote: soundId }
    pads: Array(16).fill(null), // bank A = 0..7, bank B = 8..15
    knobs: KNOBS.map(k => k.def),
    tracks: [],
  };
}

export const state = {
  ...defaultProject(),
  // runtime only (not saved)
  bank: 0,
  octave: 0,
  fullLevel: false,
};

// What is currently being dragged from the library / a pad.
export const drag = { current: null };

const handlers = {};
export function on(evt, fn) { (handlers[evt] ||= []).push(fn); }
export function emit(evt, data) { for (const fn of handlers[evt] || []) fn(data); }

export const uid = () => Math.random().toString(36).slice(2, 10);
export const mod = (a, n) => ((a % n) + n) % n;
export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// Akai convention: MIDI 48 = C3 (lowest key at default octave)
export const noteName = m => NOTE_NAMES[mod(m, 12)] + (Math.floor(m / 12) - 1);
