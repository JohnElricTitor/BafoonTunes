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
  emit('hit', { kind, id, on: true, vel, src });

  const soundId = kind === 'k' ? keySoundId(id) : state.pads[id];
  const sound = getSound(soundId);
  if (!sound) return;
  if (!sound.loaded) { loadSound(soundId); return; }

  const note = kind === 'k' ? id : 60;
  const group = kind === 'k' ? state.knobs[K.keysVol] : state.knobs[K.padsVol];
  const bus = kind === 'k' ? engine.keysBus : engine.padsBus;

  const prev = live.get(key);
  if (prev && prev.pitched) killVoice(prev, ctx.currentTime);
  sustained.delete(key);

  // A one-shot sample set as the whole keyboard's sound plays pitched, like an instrument.
  const forcePitch = kind === 'k' && !state.keyOverrides[id] && !isPitched(sound);
  const v = startVoice(ctx, bus, sound, note, vel, ctx.currentTime, {
    gain: group,
    detune: kind === 'k' ? bend * 200 : 0,
    pitched: forcePitch,
  });
  if (!v) return;
  if (kind === 'k' && v.pitched) {
    engine.lfoDepth.connect(v.src.detune);
    v.onended = () => { try { engine.lfoDepth.disconnect(v.src.detune); } catch { /* */ } };
  }
  live.set(key, v);
  const ev = { s: soundId, n: note, v: round(vel), g: round(group), r: round(releaseTime()) };
  if (forcePitch) ev.p = 1;
  recordOn(key, ev);
}

export function noteOff(kind, id, src = 'ui') {
  const key = kind + id;
  emit('hit', { kind, id, on: false, src });
  if (kind === 'k' && sustain) { sustained.add(key); return; }
  endNote(key);
}

function endNote(key) {
  const v = live.get(key);
  if (v) {
    live.delete(key);
    if (v.pitched) releaseVoice(v, engine.ctx.currentTime, releaseTime());
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
  for (const v of live.values()) killVoice(v, now);
  live.clear();
  sustained.clear();
}

const round = x => Math.round(x * 1000) / 1000;
