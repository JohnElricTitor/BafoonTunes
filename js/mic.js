// Microphone input for Mic layers: pick an input, show its level, optionally hear yourself
// (Monitor, for headphones), and capture takes lined up with the loop.
import { emit } from './state.js';
import { engine, loadSound } from './engine.js';

const mic = {
  stream: null, source: null, node: null, analyser: null, monitorGain: null,
  layerId: null, deviceId: null, opening: null,
  chunks: [], capturing: false,
};
let workletLoaded = null;

export const micState = mic;
export const micReady = layerId => !!mic.node && mic.layerId === layerId;

/** Audio inputs (mics, audio interfaces). Labels appear once mic access is allowed. */
export async function listInputs() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
  } catch { return []; }
}

/** Open the mic for a layer (closes any other). Resolves true when it's ready. */
export function openMic(layer) {
  if (mic.layerId === layer.id && mic.deviceId === (layer.input || '') && mic.node) return Promise.resolve(true);
  if (mic.opening) return mic.opening.then(() => openMic(layer));
  closeMic();
  mic.opening = (async () => {
    const ctx = engine.ctx;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no microphone support.');
      if (!workletLoaded) workletLoaded = ctx.audioWorklet.addModule('js/mic-worklet.js');
      await workletLoaded;
      const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      if (layer.input) audio.deviceId = { exact: layer.input };
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio }); }
      catch (e) {
        if (!layer.input || e.name !== 'OverconstrainedError') throw e;
        delete audio.deviceId; // that input is gone: fall back to the default mic
        stream = await navigator.mediaDevices.getUserMedia({ audio });
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
      mic.monitorGain.gain.value = layer.monitor ? 1 : 0;
      mic.source.connect(mic.monitorGain).connect(ctx.destination);
      mic.layerId = layer.id;
      mic.deviceId = layer.input || '';
      emit('micOpen', layer.id);
      return true;
    } catch (e) {
      console.warn('mic failed', e);
      closeMic();
      const blocked = /NotAllowed|Security/.test(e.name);
      emit('toast', blocked
        ? 'Microphone access was blocked. Allow the microphone for BafoonsTunes, then select the Mic layer again.'
        : e.name === 'NotFoundError' ? 'No microphone found. Plug one in, then select the Mic layer again.'
        : 'Could not open the microphone: ' + (e.message || e.name));
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
  Object.assign(mic, { stream: null, source: null, node: null, analyser: null, monitorGain: null, layerId: null, deviceId: null });
  emit('micOpen', null);
}

export function setMonitor(on) {
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
