// Web MIDI input for the MPK mini mk2.
//
// MPK units don't all send the same messages: depending on the program, the pads can
// share a MIDI channel with the keys. So instead of guessing, the app learns each pad
// once ("pad setup": tap pads 1-8, then bank B) and remembers its channel + note.
//   Knobs -> CC 1..8 by default (re-linkable: right-click a knob on screen)
//   Joystick X -> pitch bend, Y -> CC 1 (modulation)
//   Sustain pedal -> CC 64
import { emit, mod } from './state.js';

const CC_KEY = 'tunes.ccMap';
const PAD_KEY = 'tunes.padMap';

export const midi = {
  supported: !!navigator.requestMIDIAccess,
  inputs: [],
  error: null,
  learnKnob: null,
  teach: null,        // pad setup in progress: { step, map }
  padMap: loadJson(PAD_KEY),   // { 'channel:note': padIndex } once set up
  lastKeyChannel: null,
  last: null,          // last note heard: { ch, note }
};

let ccMap = loadJson(CC_KEY) || { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7 };
let handlers = null;

function loadJson(key) {
  try {
    const m = JSON.parse(localStorage.getItem(key));
    if (m && typeof m === 'object') return m;
  } catch { /* */ }
  return null;
}
function saveJson(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* */ }
}

// ---------------------------------------------------------------- knob learn

export function startLearn(knob) {
  midi.learnKnob = knob;
  emit('learn', knob);
}
export function cancelLearn() {
  midi.learnKnob = null;
  emit('learn', null);
}

// ---------------------------------------------------------------- pad setup

// Setup has two phases: 'pads' (tap pads 1-16) then 'keys' (press the far-left key once,
// which tells us the MPK's octave). Match keys runs just the 'keys' phase.
export function startPadSetup() {
  midi.teach = { phase: 'pads', step: 0, map: {} };
  emit('teach', midi.teach);
}

/** Forget everything learned about the MPK (pads, octave, knob links). */
export function resetMidiSettings() {
  midi.teach = null;
  midi.padMap = null;
  midi.learnKnob = null;
  ccMap = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7 };
  for (const k of [PAD_KEY, CC_KEY, 'tunes.octave']) { try { localStorage.removeItem(k); } catch { /* */ } }
  emit('teach', null);
  emit('midiReset');
}

export function startKeySync() {
  midi.teach = { phase: 'keys', standalone: true };
  emit('teach', midi.teach);
}

export function cancelPadSetup() {
  midi.teach = null;
  emit('teach', null);
}

/** "Skip" in the setup bar: skip bank B, or skip the key step. */
export function skipTeachStep() {
  if (midi.teach?.phase === 'keys') cancelPadSetup();
  else skipBankB();
}

/** Finish after bank A only: guess bank B if bank A's notes run in order. */
export function skipBankB() {
  const t = midi.teach;
  if (!t || t.phase !== 'pads') return;
  const a = Object.entries(t.map).filter(([, i]) => i < 8).sort((x, y) => x[1] - y[1]);
  const parsed = a.map(([k]) => k.split(':').map(Number));
  const sequential = parsed.length === 8 && parsed.every(([c, n], i) => c === parsed[0][0] && n === parsed[0][1] + i);
  if (sequential) {
    const [ch, base] = parsed[0];
    for (let i = 0; i < 8; i++) {
      const k = `${ch}:${base + 8 + i}`;
      if (t.map[k] === undefined) t.map[k] = 8 + i;
    }
  }
  finishPadSetup();
}

function finishPadSetup() {
  midi.padMap = midi.teach.map;
  saveJson(PAD_KEY, midi.padMap);
  emit('padsLearned', padSetupSummary());
  midi.teach = { phase: 'keys' };
  emit('teach', midi.teach);
}

function keySyncHit(ch, note) {
  // Ignore bank A pads (always really tapped during setup). Bank B may only be a guess
  // that overlaps the lowest keys, so those notes still count as the key press.
  const pad = padIndexFor(ch, note);
  if (pad >= 0 && pad < 8) return;
  midi.lastKeyChannel = ch;
  midi.teach = null;
  emit('teach', null);
  emit('lowestKey', note);
}

function teachHit(ch, note) {
  const t = midi.teach;
  const k = `${ch}:${note}`;
  if (t.map[k] !== undefined) return;   // same pad tapped twice
  t.map[k] = t.step;
  t.step++;
  if (t.step >= 16) finishPadSetup();
  else emit('teach', t);
}

/** Pad notes that arrive on the keys' channel (keys assumed on channel 1 until heard). */
export function padSetupSummary() {
  const map = midi.padMap;
  if (!map) return null;
  const keyCh = midi.lastKeyChannel ?? 0;
  const pads = Object.keys(map).map(k => k.split(':').map(Number));
  return {
    keyChannel: keyCh + 1,
    padChannels: [...new Set(pads.map(([c]) => c + 1))],
    notesOnKeyChannel: pads.filter(([c]) => c === keyCh).map(([, n]) => n).sort((a, b) => a - b),
  };
}

/** Which pad (0-15) a note belongs to, or -1 if it's a key. */
function padIndexFor(ch, note) {
  if (midi.padMap) {
    const i = midi.padMap[`${ch}:${note}`];
    return i === undefined ? -1 : i;
  }
  return ch === 9 ? mod(note - 36, 16) : -1; // until set up: channel 10 = pads
}

// ---------------------------------------------------------------- monitor

// Last few raw messages, shown in the Help dialog so you can see exactly what the
// MPK sends (e.g. whether a button sends anything at all).
midi.log = [];
function describe(data) {
  const [st, d1 = 0, d2 = 0] = data;
  const ch = (st & 0x0f) + 1;
  switch (st & 0xf0) {
    case 0x90: return d2 ? `Note on    ch ${ch}  note ${d1}  vel ${d2}` : `Note off   ch ${ch}  note ${d1}`;
    case 0x80: return `Note off   ch ${ch}  note ${d1}`;
    case 0xb0: return `Control    ch ${ch}  CC ${d1} = ${d2}`;
    case 0xe0: return `Pitch bend ch ${ch}  ${((d2 << 7) | d1) - 8192}`;
    case 0xc0: return `Program    ch ${ch}  ${d1}`;
    case 0xd0: return `Pressure   ch ${ch}  ${d1}`;
    case 0xa0: return `Key press. ch ${ch}  note ${d1} ${d2}`;
    default: return `System     ${[...data].map(b => b.toString(16).padStart(2, '0')).join(' ')}`;
  }
}
function logMessage(data) {
  if (data[0] === 0xf8 || data[0] === 0xfe) return; // clock ticks / keep-alive
  midi.log.unshift(describe(data));
  midi.log.length = Math.min(midi.log.length, 14);
  emit('midiLog', midi.log);
}

// ---------------------------------------------------------------- connection

export async function initMidi(h) {
  handlers = h;
  if (!midi.supported) { emit('midi', midi); return; }
  let access;
  try {
    access = await navigator.requestMIDIAccess({ sysex: false });
    midi.error = null;
  } catch (e) {
    midi.error = /NotAllowed|Security/.test(e.name) ? 'MIDI blocked — click to retry' : e.message;
    emit('midi', midi);
    return;
  }
  const bind = () => {
    midi.inputs = [];
    for (const input of access.inputs.values()) {
      input.onmidimessage = onMessage;
      if (input.state === 'connected') midi.inputs.push(input.name);
    }
    emit('midi', midi);
  };
  access.onstatechange = bind;
  bind();
}

// Exported so raw messages can be fed in for testing without hardware.
export function onMessage(msg) {
  if (!handlers) return;
  const [st, d1 = 0, d2 = 0] = msg.data;
  logMessage(msg.data);
  if (st >= 0xf0) return; // clock / system messages
  const cmd = st & 0xf0;
  const ch = st & 0x0f;
  const h = handlers;
  emit('midiActivity');

  const isOn = cmd === 0x90 && d2 > 0;
  const isOff = cmd === 0x80 || (cmd === 0x90 && d2 === 0);
  if (isOn || isOff) {
    if (isOn) { midi.last = { ch, note: d1 }; emit('midiNote', midi.last); }
    if (midi.teach) {
      if (isOn) midi.teach.phase === 'keys' ? keySyncHit(ch, d1) : teachHit(ch, d1);
      return;
    }
    const pad = padIndexFor(ch, d1);
    if (pad >= 0) {
      if (isOn) h.padOn(pad, d2 / 127); else h.padOff(pad);
    } else {
      if (isOn) midi.lastKeyChannel = ch;
      if (isOn) h.keyOn(d1, d2 / 127); else h.keyOff(d1);
    }
  } else if (cmd === 0xb0) {
    if (d1 === 64) { h.sustain(d2 >= 64); return; }
    if (midi.learnKnob !== null) {
      for (const cc of Object.keys(ccMap)) if (ccMap[cc] === midi.learnKnob) delete ccMap[cc];
      ccMap[d1] = midi.learnKnob;
      saveJson(CC_KEY, ccMap);
      emit('toast', `K${midi.learnKnob + 1} is now linked to that knob.`);
      cancelLearn();
    }
    if (d1 === 1) h.modWheel(d2 / 127);
    const k = ccMap[d1];
    if (k !== undefined) h.knob(k, d2 / 127);
  } else if (cmd === 0xe0) {
    const v = ((d2 << 7) | d1) - 8192;
    h.bend(v / (v < 0 ? 8192 : 8191));
  }
}
