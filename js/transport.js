// Loop transport: metronome, track playback scheduling and recording takes.
import { state, emit, uid, mod, TRACK_COLORS } from './state.js';
import { engine, getSound, isPitched, startVoice, releaseVoice, killVoice, click } from './engine.js';

const LOOKAHEAD = 0.12;   // seconds scheduled ahead
const EARLY = 0.3;        // beats: notes hit just before the take starts count as on the downbeat

export const tp = {
  playing: false,
  startTime: 0,        // ctx time of beat 0
  scheduledBeat: 0,
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

export function play(countIn = false) {
  if (tp.playing) return;
  const ctx = engine.ctx;
  if (ctx.state !== 'running') ctx.resume();
  tp.startTime = ctx.currentTime + 0.06 + (countIn ? 4 * beatDur() : 0);
  tp.scheduledBeat = countIn ? -4 : 0;
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
  emit('bpm');
  emit('change');
}

function tick() {
  if (!tp.playing) return;
  const ctx = engine.ctx;
  const endBeat = currentBeat(ctx.currentTime + LOOKAHEAD);
  const rec = tp.rec;
  // Turn the take into a track just before its first repeat is scheduled.
  if (rec && !rec.track && rec.endBeat <= endBeat) commitTake(rec, rec.endBeat);
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
    if (b < 0 || state.metronome) click(ctx, engine.clickBus, timeOf(b), mod(b, 4) === 0);
  }
  if (b1 <= 0) return;
  const s0 = Math.max(0, b0);
  for (const tr of state.tracks) {
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
        const v = startVoice(ctx, node, s, e.n, e.v, when, { gain: e.g, pitched: !!e.p });
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

function trackNode(tr) {
  let n = tp.trackNodes.get(tr.id);
  if (!n) {
    n = engine.ctx.createGain();
    n.gain.value = trackAudible(tr) ? trackGain(tr) : 0;
    n.connect(engine.tracksBus);
    tp.trackNodes.set(tr.id, n);
  }
  return n;
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
}

export function resetTrackNodes() {
  for (const n of tp.trackNodes.values()) n.disconnect();
  tp.trackNodes.clear();
}

// ---------------------------------------------------------------- recording

const LATE_GRACE = 0.25; // beats: pressing record just after a loop starts still catches that loop

export function toggleRecord() {
  if (tp.rec) {
    // Still waiting for the take to start: just cancel. Otherwise end the take now.
    if (!recStarted()) cancelRecording(); else finishRecording();
    return;
  }
  const L = loopBeats();
  if (!tp.playing) {
    tp.rec = newRec(0, L);
    play(state.countIn);
  } else {
    // Wait for the next time the loop comes round, so takes always line up with the loop.
    const b = Math.max(0, currentBeat());
    const loopStart = Math.floor(b / L) * L;
    const start = b - loopStart <= LATE_GRACE ? loopStart : loopStart + L;
    tp.rec = newRec(start, start + L);
  }
  emit('rec');
}

/** Has the armed take actually begun (past its count-in / wait)? */
export const recStarted = () => !!tp.rec && tp.playing && currentBeat() >= tp.rec.startBeat;

function cancelRecording() {
  tp.rec = null;
  emit('rec');
}

function newRec(startBeat, endBeat) {
  return { startBeat, endBeat, L: endBeat - startBeat, events: [], held: new Map(), track: null };
}

// What she hears is delayed by the output latency, so shift recorded hits back by it.
const latency = () => engine.ctx.outputLatency || engine.ctx.baseLatency || 0;

export function recordOn(key, ev) {
  const rec = tp.rec;
  if (!rec || !tp.playing) return;
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

function commitTake(rec, fromBeat) {
  const track = {
    id: uid(),
    name: '',
    color: TRACK_COLORS[state.tracks.length % TRACK_COLORS.length],
    volume: 0.8,
    mute: false,
    solo: false,
    lengthBeats: rec.L,
    events: rec.events,
    _from: fromBeat,
  };
  rec.track = track;
  track.name = nameForTake(track);
  state.tracks.push(track);
  emit('tracks');
}

function finishRecording() {
  const rec = tp.rec;
  if (!rec) return;
  tp.rec = null;
  if (!rec.track) commitTake(rec, tp.scheduledBeat);
  const tr = rec.track;
  for (const e of tr.events) delete e._abs;
  if (tr.events.length === 0) {
    state.tracks.splice(state.tracks.indexOf(tr), 1);
    removeTrackNode(tr.id);
    emit('toast', 'Nothing was played, so no track was added.');
  } else {
    tr.name = nameForTake(tr);
  }
  emit('rec');
  emit('tracks');
  emit('change');
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
  return `Take ${state.tracks.indexOf(tr) + 1 || state.tracks.length + 1}`;
}
