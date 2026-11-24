// Loop transport: metronome, track playback scheduling and recording takes.
import { state, emit, uid, mod, TRACK_COLORS } from './state.js';
import { buildChain } from './effects.js';
// (mic.js is loaded on demand when a Mic layer is used)
import { engine, getSound, isPitched, startVoice, releaseVoice, killVoice, click } from './engine.js';

const LOOKAHEAD = 0.12;   // seconds scheduled ahead
const EARLY = 0.3;        // beats: notes hit just before the take starts count as on the downbeat

export const tp = {
  playing: false,
  startTime: 0,        // ctx time of beat 0
  scheduledBeat: 0,
  cursor: 0,           // playhead position when stopped (beats into the loop); Play starts here
  countInUntil: 0,     // clicks always sound before this beat (the count-in)
  rec: null,
  voices: new Set(),
  trackNodes: new Map(),
};

// A worker-based timer keeps scheduling steady even when the tab is in the background.
const worker = new Worker(URL.createObjectURL(new Blob([
  `let id=null;onmessage=e=>{if(e.data==='start'){if(!id)id=setInterval(()=>postMessage(0),25)}else{clearInterval(id);id=null}}`,
], { type: 'text/javascript' })));
worker.onmessage = () => tick();

export const beatDur = () => 60 / state.bpm;
export const loopBeats = () => state.bars * 4;
export const currentBeat = (t = engine.ctx.currentTime) => (t - tp.startTime) / beatDur();
const timeOf = b => tp.startTime + b * beatDur();

// ---------------------------------------------------------------- transport

/** Start playing from the playhead (with an optional one-bar count-in before it). */
export function play(countIn = false) {
  if (tp.playing) return;
  const ctx = engine.ctx;
  if (ctx.state !== 'running') ctx.resume();
  const from = clampCursor(tp.cursor);
  const lead = countIn ? 4 : 0;
  tp.startTime = ctx.currentTime + 0.06 + (lead - from) * beatDur();
  tp.scheduledBeat = from - lead;
  tp.countInUntil = countIn ? from : -Infinity;
  for (const tr of state.tracks) delete tr._from;
  tp.playing = true;
  worker.postMessage('start');
  tick();
  emit('transport');
}

export function stop() {
  if (!tp.playing) return;
  if (tp.rec) {
    // Stopped during the count-in / wait with nothing played: drop it quietly.
    if (!recStarted() && !tp.rec.events.length) cancelRecording(); else finishRecording();
  }
  tp.playing = false;
  worker.postMessage('stop');
  const now = engine.ctx.currentTime;
  for (const v of tp.voices) killVoice(v, now);
  tp.voices.clear();
  emit('transport');
}

export function togglePlay() { tp.playing ? stop() : play(false); }

const clampCursor = b => Math.max(0, Math.min(loopBeats() - 0.25, b));

/**
 * Move the playhead (beats into the loop, snapped to 16th notes). While playing, playback
 * jumps there. Not while recording: the take is lined up with the loop.
 */
export function seek(beat) {
  const b = clampCursor(Math.round(beat * 4) / 4);
  tp.cursor = b;
  if (tp.playing && !tp.rec) {
    const now = engine.ctx.currentTime;
    for (const v of tp.voices) killVoice(v, now);
    tp.voices.clear();
    tp.startTime = now + 0.03 - b * beatDur();
    tp.scheduledBeat = b;
    tp.countInUntil = -Infinity;
    for (const tr of state.tracks) delete tr._from;
  }
  emit('seek', b);
  return b;
}

export function setBpm(bpm) {
  bpm = Math.max(40, Math.min(240, Math.round(bpm)));
  if (bpm === state.bpm) return;
  if (tp.playing) {
    const now = engine.ctx.currentTime;
    const b = currentBeat(now);
    state.bpm = bpm;
    tp.startTime = now - b * beatDur();
  } else {
    state.bpm = bpm;
  }
  rebuildAllEffects(); // echoes follow the new tempo
  emit('bpm');
  emit('change');
}

function tick() {
  if (!tp.playing) return;
  const ctx = engine.ctx;
  const endBeat = currentBeat(ctx.currentTime + LOOKAHEAD);
  const rec = tp.rec;
  // Hand the layer over to the new take just before its first repeat is scheduled.
  if (rec && !rec.committed && rec.endBeat <= endBeat) commitTake(rec, rec.endBeat);
  if (endBeat > tp.scheduledBeat) {
    scheduleRange(tp.scheduledBeat, endBeat);
    tp.scheduledBeat = endBeat;
  }
  if (rec && currentBeat() >= rec.endBeat) finishRecording();
}

function scheduleRange(b0, b1) {
  const ctx = engine.ctx;
  const bd = beatDur();
  for (let b = Math.ceil(b0); b < b1; b++) {
    if (b < tp.countInUntil || state.metronome) click(ctx, engine.clickBus, timeOf(b), mod(b, 4) === 0);
  }
  if (b1 <= 0) return;
  const s0 = Math.max(0, b0);
  for (const tr of state.tracks) {
    // the layer being re-recorded stays quiet until the new take replaces it
    if (tp.rec && tp.rec.layer === tr && !tp.rec.committed) continue;
    if (tr._saving) continue;
    const L = tr.lengthBeats;
    const from = Math.max(s0, tr._from ?? 0);
    if (from >= b1 || !L) continue;
    const node = trackNode(tr);
    for (let k = Math.floor(from / L); k * L < b1; k++) {
      for (const e of tr.events) {
        const b = k * L + e.t;
        if (b < from || b >= b1) continue;
        const s = getSound(e.s);
        if (!s || !s.loaded) continue;
        const when = timeOf(b);
        const v = startVoice(ctx, node, s, e.n, e.v, when, { gain: e.g, pitched: !!e.p, loop: !!e.lp });
        if (!v) continue;
        tp.voices.add(v);
        v.onended = () => tp.voices.delete(v);
        if (v.pitched) releaseVoice(v, when + Math.max(0.05, e.d) * bd, e.r);
        else if (e.h) releaseVoice(v, when + Math.max(0.05, e.d) * bd, 0.06); // pad held, then let go
      }
    }
  }
}

// ---------------------------------------------------------------- tracks

export const trackGain = tr => tr.volume * tr.volume * 1.5625;

export function trackAudible(tr) {
  const anySolo = state.tracks.some(t => t.solo);
  return anySolo ? tr.solo : !tr.mute;
}

// Each layer: its notes → volume (gain) → its effects chain → the mix.
const trackChains = new Map();

function trackNode(tr) {
  let n = tp.trackNodes.get(tr.id);
  if (!n) {
    n = engine.ctx.createGain();
    n.gain.value = trackAudible(tr) ? trackGain(tr) : 0;
    tp.trackNodes.set(tr.id, n);
    connectEffects(tr, n);
  }
  return n;
}

function connectEffects(tr, n) {
  trackChains.get(tr.id)?.dispose();
  try { n.disconnect(); } catch { /* */ }
  const chain = buildChain(engine.ctx, tr.effects || [], state.bpm);
  n.connect(chain.input);
  chain.output.connect(engine.tracksBus);
  trackChains.set(tr.id, chain);
}

/** Rebuild a layer's effects (after adding / removing / reordering one). */
export function setLayerEffects(tr) {
  const n = tp.trackNodes.get(tr.id);
  if (n) connectEffects(tr, n);
}

/** Change one effect's amount while it plays. */
export function setEffectAmount(tr, index, amount) {
  trackChains.get(tr.id)?.set(index, amount);
}

/** Fresh effects for every layer: cuts off echo / reverb tails (used by Stop and tempo changes). */
export function rebuildAllEffects() {
  for (const tr of state.tracks) setLayerEffects(tr);
}

export function updateTrackGains() {
  const now = engine.ctx.currentTime;
  for (const tr of state.tracks) {
    const n = trackNode(tr);
    n.gain.setTargetAtTime(trackAudible(tr) ? trackGain(tr) : 0, now, 0.015);
  }
}

export function removeTrackNode(id) {
  const n = tp.trackNodes.get(id);
  if (n) { n.disconnect(); tp.trackNodes.delete(id); }
  trackChains.get(id)?.dispose();
  trackChains.delete(id);
}

export function resetTrackNodes() {
  for (const n of tp.trackNodes.values()) n.disconnect();
  tp.trackNodes.clear();
  for (const c of trackChains.values()) c.dispose();
  trackChains.clear();
}

// ---------------------------------------------------------------- recording

const LATE_GRACE = 0.25; // beats: pressing record just after a loop starts still catches that loop

// ---------------------------------------------------------------- layers

/** Add an empty layer ('mpk' = notes from the MPK / pads / keys, 'mic' = microphone audio) and select it. */
export function newLayer(kind = 'mpk') {
  const sameKind = state.tracks.filter(t => (t.kind || 'mpk') === kind).length;
  const tr = {
    id: uid(),
    kind,
    name: kind === 'mic' ? `Mic ${sameKind + 1}` : `Layer ${state.tracks.length + 1}`,
    autoName: kind !== 'mic',
    color: TRACK_COLORS[state.tracks.length % TRACK_COLORS.length],
    volume: 0.8,
    mute: false,
    solo: false,
    lengthBeats: loopBeats(),
    events: [],
  };
  if (kind === 'mic') tr.monitor = false;
  state.tracks.push(tr);
  emit('tracks');
  selectLayer(tr.id, true);
  emit('change');
  return tr;
}

/** Choose the layer Record goes into (clicking the selected one again un-selects it). */
export function selectLayer(id, force = false) {
  if (tp.rec) { emit('toast', 'Finish or stop the recording first.'); return; }
  state.selectedLayer = !force && state.selectedLayer === id ? null : id;
  emit('select', state.selectedLayer);
}

// ---------------------------------------------------------------- recording

export async function toggleRecord() {
  if (tp.rec) {
    // Still waiting for the take to start: just cancel. Otherwise end the take now.
    if (!recStarted()) cancelRecording(); else finishRecording();
    return;
  }
  // Record into the selected layer, or a new one if none is selected.
  let layer = state.tracks.find(t => t.id === state.selectedLayer);
  if (!layer) layer = newLayer('mpk');
  if (layer.kind === 'mic') {
    const { openMic } = await import('./mic.js');
    if (!(await openMic(layer))) return; // no mic: it already said why
  }
  const L = layer.lengthBeats;
  let start;
  if (!tp.playing) {
    // from a stop: one pass of the layer starting at the playhead (after the count-in)
    start = clampCursor(tp.cursor);
  } else {
    // Wait for the next time the layer's loop comes round, so takes line up with it.
    const b = Math.max(0, currentBeat());
    const loopStart = Math.floor(b / L) * L;
    start = b - loopStart <= LATE_GRACE ? loopStart : loopStart + L;
  }
  tp.rec = newRec(start, start + L, layer);
  if (!tp.playing) play(state.countIn);
  if (layer.kind === 'mic') {
    const { startCapture } = await import('./mic.js');
    startCapture();
  }
  emit('rec');
}

/** Has the armed take actually begun (past its count-in / wait)? */
export const recStarted = () => !!tp.rec && tp.playing && currentBeat() >= tp.rec.startBeat;

function cancelRecording() {
  const rec = tp.rec;
  tp.rec = null;
  if (rec?.layer.kind === 'mic') import('./mic.js').then(m => m.cancelCapture());
  emit('rec');
}

function newRec(startBeat, endBeat, layer) {
  return { startBeat, endBeat, L: endBeat - startBeat, events: [], held: new Map(), layer, oldEvents: layer.events, committed: false };
}

// What she hears is delayed by the output latency, so shift recorded hits back by it.
const latency = () => engine.ctx.outputLatency || engine.ctx.baseLatency || 0;

export function recordOn(key, ev) {
  const rec = tp.rec;
  if (!rec || !tp.playing || rec.layer.kind === 'mic') return; // a mic layer records the mic, not notes
  let a = currentBeat(engine.ctx.currentTime - latency());
  if (a < rec.startBeat - EARLY || a >= rec.endBeat) return;
  a = Math.max(a, rec.startBeat);
  let t = mod(a, rec.L);
  if (state.quantize) {
    const g = 4 / state.quantize;
    t = mod(Math.round(t / g) * g, rec.L);
  }
  const e = { ...ev, t, d: rec.endBeat - a, _abs: a };
  rec.events.push(e);
  rec.held.set(key, e);
  emit('recEvent');
}

export function recordOff(key) {
  const rec = tp.rec;
  if (!rec) return;
  const e = rec.held.get(key);
  if (!e) return;
  rec.held.delete(key);
  const a = currentBeat(engine.ctx.currentTime - latency());
  e.d = Math.max(0.05, Math.min(rec.L, a - e._abs));
}

/** The new notes take over the layer (its old part stays silent while recording). */
function commitTake(rec, fromBeat) {
  if (rec.committed || rec.layer.kind === 'mic') return;
  rec.committed = true;
  rec.layer.events = rec.events; // same array, so notes in the last moments still land
  rec.layer._from = fromBeat;
}

function finishRecording() {
  const rec = tp.rec;
  if (!rec) return;
  tp.rec = null;
  const layer = rec.layer;
  if (layer.kind === 'mic') { finishMicTake(rec); emit('rec'); return; }
  if (!rec.committed) commitTake(rec, tp.scheduledBeat);
  for (const e of rec.events) delete e._abs;
  if (rec.events.length === 0) {
    layer.events = rec.oldEvents; // nothing played: keep what was there
    emit('toast', layer.events.length ? 'Nothing was played, so the layer was left as it was.' : 'Nothing was played.');
  } else if (layer.autoName) {
    layer.name = nameForTake(layer);
  }
  emit('rec');
  emit('layerUpdated', layer);
  emit('change');
}

/** A mic take: wait for the audio, save it, and make it the layer's contents. */
async function finishMicTake(rec) {
  const layer = rec.layer;
  const m = await import('./mic.js');
  const t0 = timeOf(rec.startBeat);
  const t1 = Math.min(timeOf(rec.endBeat), Math.max(t0, engine.ctx.currentTime));
  layer._saving = true;
  emit('layerUpdated', layer);
  try {
    const take = await m.finishCapture(t0, t1);
    const lenBeats = (t1 - t0) / beatDur();
    const id = lenBeats > 0.05 ? await m.storeTake(take, layer.name) : null;
    if (!id) {
      emit('toast', layer.events.length ? 'Nothing came in from the mic, so the layer was left as it was.' : 'Nothing came in from the mic. Check the level meter on the layer.');
    } else {
      layer.events = [{ s: id, n: 60, v: 1, g: 1, r: 0.05, t: mod(rec.startBeat, rec.L), d: lenBeats }];
      layer._from = tp.playing ? tp.scheduledBeat : 0;
    }
  } catch (e) {
    console.error(e);
    emit('toast', 'Could not save the mic take.');
  } finally {
    layer._saving = false;
    emit('layerUpdated', layer);
    emit('change');
  }
}

function nameForTake(tr) {
  const ids = [...new Set(tr.events.map(e => e.s))];
  const sounds = ids.map(getSound).filter(Boolean);
  if (sounds.length === 1) return sounds[0].name;
  if (sounds.length && sounds.every(s => s.category === 'drums')) {
    const kits = [...new Set(sounds.map(s => s.kit))];
    const kit = engine.kits.find(k => k.id === kits[0]);
    return kits.length === 1 && kit ? kit.name : 'Drums';
  }
  return `Layer ${state.tracks.indexOf(tr) + 1 || state.tracks.length + 1}`;
}
