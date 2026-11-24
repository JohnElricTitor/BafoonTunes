// The microphone: which one to use (one choice for the whole app, set in Settings › Microphone),
// asking permission, the input level, hearing yourself (Monitor, for headphones), and
// capturing takes lined up with the loop. One thing at a time owns the open mic: the
// selected Mic layer, a pad armed to record, or the settings panel's level meter.
import { state, emit } from './state.js';
import { engine, loadSound } from './engine.js';

const mic = {
  stream: null, source: null, node: null, analyser: null, monitorGain: null,
  layerId: null, deviceId: null, opening: null, owner: null,
  chunks: [], capturing: false,
};
let workletLoaded = null;

export const micState = mic;
export const micReady = layerId => !!mic.node && mic.layerId === layerId;

// ---------------------------------------------------------------- which mic

const CHOICE_KEY = 'tunes.mic';
let choice = '';
try { choice = localStorage.getItem(CHOICE_KEY) || ''; } catch { /* */ }

/** The chosen mic's device id ('' = the computer's default mic). */
export const micChoice = () => choice;

/** Use a different mic from now on (reopens it if it's in use). */
export function setMicChoice(id) {
  choice = id || '';
  try { localStorage.setItem(CHOICE_KEY, choice); } catch { /* */ }
  emit('micChoice', choice);
  if (mic.node && !mic.capturing && mic.owner) {
    const owner = mic.owner;
    closeMic();
    openMic(owner);
  }
}

/** Audio inputs (mics, audio interfaces). Names appear once the mic is allowed. */
export async function listInputs() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
  } catch { return []; }
}

/** The chosen mic's name, for showing on Mic layers. */
export async function micName() {
  if (!choice) return 'Default mic';
  return (await listInputs()).find(d => d.id === choice)?.label || 'Default mic';
}

// ---------------------------------------------------------------- permission

const desktop = window.bafoons?.system;

/**
 * Can BafoonsTunes use a microphone? 'granted' | 'prompt' (not asked yet) |
 * 'denied' (blocked for this page) | 'system' (Windows is blocking it) | 'unknown'
 */
export async function micPermission() {
  if (desktop?.micAccess) {
    const s = await desktop.micAccess().catch(() => 'unknown');
    if (s === 'denied' || s === 'restricted') return 'system';
  }
  try {
    const p = await navigator.permissions.query({ name: 'microphone' });
    return p.state; // granted | prompt | denied
  } catch { return 'unknown'; }
}

/** Why a mic couldn't be opened, as one of: system | denied | none | busy | other. */
export function micProblem(e) {
  if (/system/i.test(e?.message || '')) return 'system';
  if (/NotAllowed|Security/.test(e?.name)) return desktop ? 'system' : 'denied';
  if (/NotFound|Overconstrained/.test(e?.name)) return 'none';
  if (/NotReadable|Abort/.test(e?.name)) return 'busy';
  return 'other';
}

export const MIC_PROBLEM_TEXT = {
  system: 'Windows is blocking the microphone. Open Microphone settings to see how to allow it.',
  denied: 'The microphone is blocked for this page. Click the icon at the left of the address bar, set Microphone to Allow, then reload the page.',
  none: 'No microphone found. Plug one in, then try again.',
  busy: 'The microphone is being used by another program, or Windows could not start it. Close other apps using it and try again.',
  other: 'Could not open the microphone.',
};

/** Ask for the microphone (shows the browser's / Windows' prompt). Resolves to 'granted' or a problem. */
export async function requestMic() {
  try {
    if (!navigator.mediaDevices?.getUserMedia) return 'other';
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of s.getTracks()) t.stop();
    emit('micChoice', choice); // device names are now known
    return 'granted';
  } catch (e) {
    console.warn('mic request failed', e);
    return micProblem(e);
  }
}

export const openWindowsMicSettings = () => desktop?.openMicSettings?.();

// ---------------------------------------------------------------- open / close

/** Give the mic to whatever should have it now: the selected Mic layer, or nothing. */
export function restoreMic() {
  const sel = state.tracks.find(t => t.id === state.selectedLayer);
  if (sel?.kind === 'mic') openMic(sel);
  else if (mic.layerId) closeMic();
}

/** Open the mic for an owner {id, monitor} (closes it for anyone else). Resolves true when it's ready. */
export function openMic(owner) {
  if (mic.layerId === owner.id && mic.deviceId === choice && mic.node) { mic.owner = owner; return Promise.resolve(true); }
  if (mic.opening) return mic.opening.then(() => openMic(owner));
  closeMic();
  mic.opening = (async () => {
    const ctx = engine.ctx;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no microphone support.');
      if (!workletLoaded) workletLoaded = ctx.audioWorklet.addModule('js/mic-worklet.js');
      await workletLoaded;
      const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      if (choice) audio.deviceId = { exact: choice };
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio }); }
      catch (e) {
        if (!choice || !/Overconstrained|NotFound/.test(e.name)) throw e;
        delete audio.deviceId; // the chosen mic is unplugged: use the default one
        stream = await navigator.mediaDevices.getUserMedia({ audio });
        emit('toast', 'Your chosen microphone isn\'t plugged in, so the default one is being used.');
      }
      mic.stream = stream;
      mic.source = ctx.createMediaStreamSource(stream);
      mic.node = new AudioWorkletNode(ctx, 'mic-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      mic.node.port.onmessage = e => { if (mic.capturing) mic.chunks.push(e.data); };
      const silent = ctx.createGain();
      silent.gain.value = 0;
      mic.source.connect(mic.node).connect(silent).connect(ctx.destination); // keeps the worklet running
      mic.analyser = ctx.createAnalyser();
      mic.analyser.fftSize = 1024;
      mic.source.connect(mic.analyser);
      mic.monitorGain = ctx.createGain();
      mic.monitorGain.gain.value = owner.monitor ? 1 : 0;
      mic.source.connect(mic.monitorGain).connect(ctx.destination);
      mic.layerId = owner.id;
      mic.owner = owner;
      mic.deviceId = choice;
      emit('micOpen', owner.id);
      return true;
    } catch (e) {
      console.warn('mic failed', e);
      closeMic();
      const problem = micProblem(e);
      emit('micProblem', problem);
      if (owner.id !== 'settings') { // the settings panel shows its own message
        emit('toast', {
          text: problem === 'other' ? `${MIC_PROBLEM_TEXT.other} (${e.message || e.name})` : MIC_PROBLEM_TEXT[problem],
          action: 'Microphone settings', run: () => emit('openSettings', 'mic'), ms: 12000,
        });
      }
      return false;
    } finally {
      mic.opening = null;
    }
  })();
  return mic.opening;
}

export function closeMic() {
  if (mic.capturing) return; // never cut off a take in progress
  for (const t of mic.stream?.getTracks() || []) t.stop();
  for (const n of [mic.source, mic.node, mic.analyser, mic.monitorGain]) { try { n?.disconnect(); } catch { /* */ } }
  Object.assign(mic, { stream: null, source: null, node: null, analyser: null, monitorGain: null, layerId: null, deviceId: null, owner: null });
  emit('micOpen', null);
}

export function setMonitor(on) {
  if (mic.owner) mic.owner.monitor = on;
  mic.monitorGain?.gain.setTargetAtTime(on ? 1 : 0, engine.ctx.currentTime, 0.02);
}

/** Input level 0..1 for the meter. */
const levelBuf = new Float32Array(1024);
export function micLevel() {
  if (!mic.analyser) return 0;
  mic.analyser.getFloatTimeDomainData(levelBuf);
  let peak = 0;
  for (let i = 0; i < levelBuf.length; i++) peak = Math.max(peak, Math.abs(levelBuf[i]));
  return peak;
}

// ---------------------------------------------------------------- takes

/** Start collecting mic audio for a take (from now until finishCapture). */
export function startCapture() {
  if (!mic.node) return false;
  mic.chunks = [];
  mic.capturing = true;
  mic.node.port.postMessage('start');
  return true;
}

/**
 * Stop and return the audio between ctx times t0 and t1, shifted by the round-trip delay
 * (she sings along to what she hears, which is already late by the output delay, and the
 * mic adds its own). Waits until enough audio has come in.
 */
export async function finishCapture(t0, t1) {
  const ctx = engine.ctx;
  const delay = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
  const until = t1 + delay + 0.08;
  while (ctx.currentTime < until) await new Promise(r => setTimeout(r, 30));
  mic.node?.port.postMessage('stop');
  mic.capturing = false;
  const sr = ctx.sampleRate;
  const startFrame = Math.round((t0 + delay) * sr);
  const length = Math.max(0, Math.round((t1 - t0) * sr));
  const out = new Float32Array(length);
  for (const { frame, data } of mic.chunks) {
    for (let i = 0; i < data.length; i++) {
      const j = frame + i - startFrame;
      if (j >= 0 && j < length) out[j] = data[i];
    }
  }
  mic.chunks = [];
  return { data: out, sampleRate: sr };
}

export function cancelCapture() {
  mic.node?.port.postMessage('stop');
  mic.capturing = false;
  mic.chunks = [];
}

/** A captured take as a WAV file, or null if nothing came in (silence). */
export async function takeToWav(take) {
  let peak = 0;
  for (let i = 0; i < take.data.length; i += 4) peak = Math.max(peak, Math.abs(take.data[i]));
  if (peak < 0.002) return null; // nothing came in
  // tiny fades so the loop doesn't click where it wraps
  const f = Math.min(Math.round(0.004 * take.sampleRate), take.data.length >> 1);
  for (let i = 0; i < f; i++) { take.data[i] *= i / f; take.data[take.data.length - 1 - i] *= i / f; }
  const { encodeWav } = await import('./exporter.js');
  return encodeWav({ channels: [take.data], sampleRate: take.sampleRate, length: take.data.length });
}

/** Save captured audio as a (hidden) sound and return its id, or null if it was silent. */
export async function storeTake(take, name) {
  const wav = await takeToWav(take);
  if (!wav) return null;
  const { importSources } = await import('./userlib.js');
  const summary = await importSources(
    [{ kind: 'files', name: 'Mic takes', files: [{ path: `${(name || 'Mic').replace(/[\\/:*?"<>|]+/g, '')}.wav`, blob: wav }] }],
    undefined,
    { hidden: true, raw: true },
  );
  const id = summary.newPacks[0]?.metas[0]?.id;
  if (id) await loadSound(id);
  return id || null;
}
