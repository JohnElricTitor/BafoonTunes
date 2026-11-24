// Live playing: keys and pads from the MPK, the mouse or the computer keyboard.
import { state, emit, K } from './state.js';
import { engine, getSound, isPitched, loadSound, startVoice, releaseVoice, killVoice } from './engine.js';
import { recordOn, recordOff } from './transport.js';

const live = new Map();       // 'k60' / 'p3' -> voice
const sustained = new Set();  // keys released while the sustain pedal is down
let sustain = false;
let bend = 0;

export const keySoundId = midi => state.keyOverrides[midi] || state.keyboardSound;
export const releaseTime = () => 0.05 + Math.pow(state.knobs[K.release], 2) * 4;

// Pad play modes (right-click a pad):
//   'hold'     Play while held (default)  - stops when you let go
//   'full'     Play full sound            - plays to the end            (orange outline)
//   'loop'     Loop while held            - repeats until you let go    (purple outline)
//   'loopfull' Loop full sound            - press to start, press again to stop (cyan outline)
// Single sounds on keys behave like "Play while held".
export const PAD_MODES = [
  { mode: 'hold', label: 'Play while held' },
  { mode: 'full', label: 'Play full sound' },
  { mode: 'loop', label: 'Loop while held' },
  { mode: 'loopfull', label: 'Loop full sound' },
];
export const padMode = i => state.padModes[i] || 'hold';
const HOLD_FADE = 0.06; // quick fade when let go, so it doesn't click
const FULL_RING = 1.5;  // instrument on a "Play full sound" pad: fade over this long after letting go

/** Does this sound stop when the pad/key is released? */
export function holdsWhilePressed(sound, mode) {
  if (!sound || isPitched(sound)) return false; // instruments already stop on release (their own way)
  return mode !== 'full' && mode !== 'loopfull';
}
const loops = (sound, mode) => !!sound && !isPitched(sound) && (mode === 'loop' || mode === 'loopfull');

// Recording straight onto a pad (padrec.js) takes over the pad while it's armed.
export const padHooks = { press: null, release: null };

/**
 * kind: 'k' = keyboard key (id = MIDI note), 'p' = pad (id = 0..15)
 * src: 'midi' | 'ui'
 */
export function noteOn(kind, id, vel, src = 'ui') {
  const ctx = engine.ctx;
  if (!ctx) return;
  if (ctx.state !== 'running') ctx.resume();
  if (src === 'ui' && state.fullLevel) vel = 1;
  const key = kind + id;
  if (kind === 'p' && padHooks.press?.(id)) { emit('hit', { kind, id, on: true, vel, src }); return; }

  const mode = kind === 'p' ? padMode(id) : null;
  // "Loop full sound": a second press stops the loop
  const running = live.get(key);
  if (running?.loopFull && !running.ended) {
    live.delete(key);
    releaseVoice(running, ctx.currentTime, HOLD_FADE);
    recordOff(key);
    emit('hit', { kind, id, on: false, src });
    return;
  }
  emit('hit', { kind, id, on: true, vel, src });

  const soundId = kind === 'k' ? keySoundId(id) : state.pads[id];
  const sound = getSound(soundId);
  if (!sound) return;
  if (!sound.loaded) { loadSound(soundId); return; }

  const note = kind === 'k' ? id : 60;
  const group = kind === 'k' ? state.knobs[K.keysVol] : state.knobs[K.padsVol];
  const bus = kind === 'k' ? engine.keysBus : engine.padsBus;

  if (running && (running.pitched || running.hold)) killVoice(running, ctx.currentTime);
  sustained.delete(key);

  // A one-shot sample set as the whole keyboard's sound plays pitched, like an instrument.
  const forcePitch = kind === 'k' && !state.keyOverrides[id] && !isPitched(sound);
  const hold = !forcePitch && holdsWhilePressed(sound, mode);
  const loop = !forcePitch && loops(sound, mode);
  const v = startVoice(ctx, bus, sound, note, vel, ctx.currentTime, {
    gain: group,
    detune: kind === 'k' ? bend * 200 : 0,
    pitched: forcePitch,
    loop,
  });
  if (!v) return;
  if (kind === 'k' && v.pitched) {
    engine.lfoDepth.connect(v.src.detune);
    v.onended = () => { try { engine.lfoDepth.disconnect(v.src.detune); } catch { /* */ } };
  }
  v.hold = hold;
  v.loopFull = loop && mode === 'loopfull';
  // An instrument on a pad set to "Play full sound" rings on after letting go.
  const ringOut = kind === 'p' && isPitched(sound) && mode === 'full';
  v.rel = ringOut ? FULL_RING : releaseTime();
  live.set(key, v);
  const ev = { s: soundId, n: note, v: round(vel), g: round(group), r: round(v.rel) };
  if (forcePitch) ev.p = 1;
  if (loop) ev.lp = 1;
  if (hold || loop) ev.h = 1; // recorded: stop at the same moment on playback
  recordOn(key, ev);
}

export function noteOff(kind, id, src = 'ui') {
  const key = kind + id;
  if (kind === 'p' && padHooks.release?.(id)) { emit('hit', { kind, id, on: false, src }); return; }
  if (live.get(key)?.loopFull) return; // keeps looping (and lit) until the pad is pressed again
  emit('hit', { kind, id, on: false, src });
  if (kind === 'k' && sustain) { sustained.add(key); return; }
  endNote(key);
}

function endNote(key) {
  const v = live.get(key);
  if (v) {
    live.delete(key);
    if (v.pitched) releaseVoice(v, engine.ctx.currentTime, v.rel ?? releaseTime());
    else if (v.hold) releaseVoice(v, engine.ctx.currentTime, HOLD_FADE);
  }
  recordOff(key);
}

export function setSustain(on) {
  sustain = on;
  if (!on) {
    for (const key of sustained) endNote(key);
    sustained.clear();
  }
}

export function setBend(b) {
  bend = b;
  const now = engine.ctx.currentTime;
  for (const [key, v] of live) {
    if (key[0] === 'k' && !v.ended) v.src.detune.setTargetAtTime(b * 200, now, 0.008);
  }
  emit('bend', b);
}

export function allNotesOff() {
  const now = engine.ctx.currentTime;
  for (const [key, v] of live) {
    killVoice(v, now);
    if (key[0] === 'p') emit('hit', { kind: 'p', id: +key.slice(1), on: false, src: 'ui' }); // unlight looping pads
  }
  live.clear();
  sustained.clear();
}

const round = x => Math.round(x * 1000) / 1000;
