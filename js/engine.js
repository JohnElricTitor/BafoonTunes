// Audio engine: context, master effects, sample loading and voices.
import { state, K } from './state.js';

export const engine = {
  ctx: null,
  sounds: new Map(),   // id -> sound
  kits: [],            // [{ id, name, sounds: [id] }]
  credits: [],
  fx: null,
  keysBus: null, padsBus: null, tracksBus: null, clickBus: null,
  lfoDepth: null,
};

const ROLE_COLORS = {
  kick: '#ff5a5f', snare: '#ffa94d', clap: '#ffd43b', 'hat-closed': '#a9e34b', 'hat-open': '#69db7c',
  tom: '#4dabf7', cymbal: '#b197fc', perc: '#f783ac', fx: '#63e6be',
};
const INSTRUMENT_COLORS = ['#74c0fc', '#9775fa', '#e599f7', '#66d9e8', '#ffc078', '#8ce99a', '#ff8787', '#91a7ff', '#faa2c1', '#ffe066'];

// ---------------------------------------------------------------- setup

export function initAudio() {
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  engine.ctx = ctx;
  engine.fx = buildFx(ctx, ctx.destination);
  engine.keysBus = ctx.createGain();
  engine.padsBus = ctx.createGain();
  engine.tracksBus = ctx.createGain();
  for (const b of [engine.keysBus, engine.padsBus, engine.tracksBus]) b.connect(engine.fx.input);
  engine.clickBus = ctx.createGain();
  engine.clickBus.gain.value = 0.55;
  engine.clickBus.connect(ctx.destination);

  // Vibrato LFO, connected to the detune of live key voices.
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 5.5;
  engine.lfoDepth = ctx.createGain();
  engine.lfoDepth.gain.value = 0;
  lfo.connect(engine.lfoDepth);
  lfo.start();
  applyKnobs(true);
}

export function applyKnobs(instant = false) {
  if (!engine.ctx) return;
  engine.fx.set(state.knobs, state.bpm, instant);
  engine.lfoDepth.gain.setTargetAtTime(state.knobs[K.vibrato] * 45, engine.ctx.currentTime, 0.02);
}

// Master chain, shared by live playback and offline export.
export function buildFx(ctx, out) {
  const input = ctx.createGain();
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.Q.value = 0.6;
  input.connect(tone);

  const sum = ctx.createGain();
  tone.connect(sum);

  const revSend = ctx.createGain();
  const conv = ctx.createConvolver();
  conv.buffer = makeImpulse(ctx, 2.4);
  tone.connect(revSend); revSend.connect(conv); conv.connect(sum);

  const echoSend = ctx.createGain();
  const delay = ctx.createDelay(3);
  const fb = ctx.createGain();
  const echoTone = ctx.createBiquadFilter();
  echoTone.type = 'lowpass';
  echoTone.frequency.value = 3200;
  tone.connect(echoSend); echoSend.connect(delay); delay.connect(echoTone);
  echoTone.connect(fb); fb.connect(delay); echoTone.connect(sum);

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12; comp.knee.value = 8; comp.ratio.value = 4;
  comp.attack.value = 0.004; comp.release.value = 0.2;
  const vol = ctx.createGain();
  sum.connect(comp); comp.connect(vol); vol.connect(out);

  function set(k, bpm, instant) {
    const at = ctx.currentTime;
    const put = (p, v) => (instant ? p.setValueAtTime(v, at) : p.setTargetAtTime(v, at, 0.03));
    put(vol.gain, k[K.volume] * k[K.volume] * 1.5);
    put(tone.frequency, 160 * Math.pow(2, k[K.tone] * 7));
    put(revSend.gain, k[K.reverb] * 0.9);
    put(echoSend.gain, k[K.echo] * 0.6);
    put(fb.gain, 0.2 + k[K.echo] * 0.35);
    delay.delayTime.setValueAtTime(Math.min(2.9, 0.75 * 60 / bpm), at);
  }
  // dispose(): cut this chain off, echo and reverb tails included
  return { input, set, dispose: () => { try { vol.disconnect(); input.disconnect(); } catch { /* */ } } };
}

function makeImpulse(ctx, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
  }
  return buf;
}

// ---------------------------------------------------------------- sounds

export async function loadManifest() {
  const res = await fetch('sounds/manifest.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('Could not load sounds/manifest.json');
  const m = await res.json();
  let instIdx = 0;
  for (const s of m.sounds) {
    const color = s.category === 'drums' ? ROLE_COLORS[s.role] || '#f783ac'
      : s.category === 'fx' ? ROLE_COLORS.fx
      : INSTRUMENT_COLORS[instIdx++ % INSTRUMENT_COLORS.length];
    engine.sounds.set(s.id, {
      ...s,
      color: s.color || color,
      zones: s.files.map(f => ({ midi: f.midi ?? 60, file: f.file, buffer: null })),
      norm: 1,
      loaded: false,
    });
  }
  engine.kits = m.kits || [];
  engine.credits = m.credits || [];
  return m;
}

export const getSound = id => (id ? engine.sounds.get(id) : null);
export const isPitched = s => s?.type === 'pitched';

const bufferCache = new Map();
const soundLoads = new Map();

function fetchBuffer(url) {
  if (!bufferCache.has(url)) {
    const p = fetch(url)
      .then(r => { if (!r.ok) throw new Error(`${r.status} ${url}`); return r.arrayBuffer(); })
      .then(ab => engine.ctx.decodeAudioData(ab));
    p.catch(() => bufferCache.delete(url));
    bufferCache.set(url, p);
  }
  return bufferCache.get(url);
}

function peakOf(buf) {
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i += 3) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  }
  return peak;
}

export function loadSound(id) {
  const s = engine.sounds.get(id);
  if (!s) return Promise.resolve(null);
  if (s.loaded) return Promise.resolve(s);
  if (!soundLoads.has(id)) {
    const p = Promise.all(s.zones.map(async z => {
      // built-in sounds come from a URL; imported ones from browser storage
      z.buffer = z.load ? await engine.ctx.decodeAudioData(await z.load()) : await fetchBuffer(z.file);
    }))
      .then(() => {
        if (Array.isArray(s.loop)) for (const z of s.zones) makeLoop(z, s.loop);
        const peak = Math.max(...s.zones.map(z => peakOf(z.buffer)));
        s.norm = s.raw ? 1 : peak > 0 ? Math.min(8, 0.7 / peak) : 1; // raw: keep a mic take's real level
        s.loaded = true;
        return s;
      })
      .catch(err => { console.warn('Sound failed to load', id, err); soundLoads.delete(id); return null; });
    soundLoads.set(id, p);
  }
  return soundLoads.get(id);
}

// Bake an equal-power crossfade into the end of the loop region so it repeats seamlessly.
function makeLoop(zone, [startSec, endSec]) {
  const src = zone.buffer;
  const sr = src.sampleRate;
  const b = Math.min(Math.floor(endSec * sr), src.length - Math.floor(0.02 * sr));
  const a = Math.floor(startSec * sr);
  const x = Math.min(Math.floor(0.25 * sr), a, Math.floor((b - a) / 3));
  if (x < 64 || b <= a) return;
  const out = engine.ctx.createBuffer(src.numberOfChannels, src.length, sr);
  for (let c = 0; c < src.numberOfChannels; c++) {
    const d = src.getChannelData(c);
    const o = out.getChannelData(c);
    o.set(d);
    for (let i = 0; i < x; i++) {
      const t = i / x;
      o[b - x + i] = d[b - x + i] * Math.cos(t * Math.PI / 2) + d[a - x + i] * Math.sin(t * Math.PI / 2);
    }
  }
  zone.buffer = out;
  zone.loopStart = a / sr;
  zone.loopEnd = b / sr;
}

// ---------------------------------------------------------------- voices

const velCurve = v => 0.12 + 0.88 * Math.pow(Math.max(0, Math.min(1, v)), 1.5);

/**
 * Start a sample voice. Works with live and offline contexts.
 * opts.pitched plays a one-shot sample like an instrument (pitched from its root note).
 */
export function startVoice(ctx, dest, sound, midi, vel, when, opts = {}) {
  if (!sound || !sound.loaded) return null;
  const pitched = isPitched(sound) || !!opts.pitched;
  let zone = sound.zones[0];
  if (pitched) {
    let best = Infinity;
    for (const z of sound.zones) { const d = Math.abs(z.midi - midi); if (d < best) { best = d; zone = z; } }
  }
  const src = ctx.createBufferSource();
  src.buffer = zone.buffer;
  if (pitched) src.playbackRate.value = Math.pow(2, (midi - zone.midi) / 12);
  if (zone.loopEnd) { src.loop = true; src.loopStart = zone.loopStart; src.loopEnd = zone.loopEnd; }
  else if (opts.loop) src.loop = true; // pad set to loop: repeat the whole sound
  if (opts.detune) src.detune.value = opts.detune;
  const g = ctx.createGain();
  const peak = velCurve(vel) * sound.norm * (sound.gain ?? 1) * (opts.gain ?? 1);
  const t = Math.max(when, ctx.currentTime);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.004);
  src.connect(g);
  g.connect(dest);
  src.start(t);
  const voice = { src, g, sound, t, pitched, ended: false, released: false, onended: null };
  const live = ctx === engine.ctx;
  if (live) playing.add(voice); // so Stop can silence everything
  src.onended = () => {
    voice.ended = true;
    g.disconnect();
    if (live) playing.delete(voice);
    if (voice.onended) voice.onended();
  };
  return voice;
}

/** Natural release (note off). */
export function releaseVoice(voice, when, release = 0.3) {
  if (!voice || voice.released) return;
  voice.released = true;
  const t = Math.max(when, voice.t + 0.006);
  const p = voice.g.gain;
  if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t);
  else { p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); }
  const r = Math.max(0.02, release);
  p.setTargetAtTime(0, t, r / 4);
  try { voice.src.stop(t + r + 0.05); } catch { /* already stopped */ }
}

/** Hard stop (transport stop / retrigger). */
export function killVoice(voice, now) {
  if (!voice || voice.ended) return;
  voice.released = true;
  if (voice.t > now) { try { voice.src.stop(now); } catch { /* */ } return; }
  const p = voice.g.gain;
  if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(now);
  else { p.cancelScheduledValues(now); p.setValueAtTime(p.value, now); }
  p.setTargetAtTime(0, now, 0.012);
  try { voice.src.stop(now + 0.08); } catch { /* */ }
}

export function click(ctx, dest, when, accent) {
  const o = ctx.createOscillator();
  o.frequency.value = accent ? 1760 : 1100;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(accent ? 0.7 : 0.4, when + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.055);
  o.connect(g); g.connect(dest);
  o.start(when); o.stop(when + 0.07);
}

// Library preview
// Every voice sounding right now (pads, keys, loop playback, previews), for Stop.
const playing = new Set();

/**
 * Silence everything at once: every sounding note, previews, and the echo / reverb tails
 * (by swapping in a fresh effects chain, so nothing is left ringing).
 */
export function silenceAll() {
  const ctx = engine.ctx;
  if (!ctx) return;
  const now = ctx.currentTime;
  for (const v of playing) killVoice(v, now);
  playing.clear();
  previewVoice = null;
  const old = engine.fx;
  engine.fx = buildFx(ctx, ctx.destination);
  for (const b of [engine.keysBus, engine.padsBus, engine.tracksBus]) {
    try { b.disconnect(old.input); } catch { /* */ }
    b.connect(engine.fx.input);
  }
  old.dispose();
  applyKnobs(true);
}

let previewVoice = null;
export async function previewSound(id) {
  const ctx = engine.ctx;
  if (ctx.state !== 'running') await ctx.resume();
  const s = await loadSound(id);
  if (!s) return;
  if (previewVoice) killVoice(previewVoice, ctx.currentTime);
  const v = startVoice(ctx, engine.padsBus, s, 60, 0.85, ctx.currentTime);
  if (v && isPitched(s)) releaseVoice(v, ctx.currentTime + 0.9, 0.5);
  previewVoice = v;
}
