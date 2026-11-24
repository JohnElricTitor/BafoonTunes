// Offline mixdown to WAV or MP3.
import { state } from './state.js';
import { buildFx, getSound, isPitched, loadSound, startVoice, releaseVoice } from './engine.js';
import { loopBeats, trackAudible, trackGain } from './transport.js';
import { buildChain } from './effects.js';

export async function renderMix(loops) {
  const sr = 44100;
  const bd = 60 / state.bpm;
  const totalBeats = loopBeats() * loops;
  const tail = 4;
  const oc = new OfflineAudioContext(2, Math.ceil((totalBeats * bd + tail) * sr), sr);
  const fx = buildFx(oc, oc.destination);
  fx.set(state.knobs, state.bpm, true);

  const ids = new Set(state.tracks.flatMap(t => t.events.map(e => e.s)));
  await Promise.all([...ids].map(loadSound));

  for (const tr of state.tracks) {
    if (!trackAudible(tr)) continue;
    const g = oc.createGain();
    g.gain.value = trackGain(tr);
    const chain = buildChain(oc, tr.effects || [], state.bpm); // the layer's own effects
    g.connect(chain.input);
    chain.output.connect(fx.input);
    for (let k = 0; k * tr.lengthBeats < totalBeats; k++) {
      for (const e of tr.events) {
        const b = k * tr.lengthBeats + e.t;
        if (b >= totalBeats) continue;
        const s = getSound(e.s);
        if (!s?.loaded) continue;
        const when = b * bd;
        const v = startVoice(oc, g, s, e.n, e.v, when, { gain: e.g, pitched: !!e.p, loop: !!e.lp });
        if (v?.pitched) releaseVoice(v, when + Math.max(0.05, e.d) * bd, e.r);
        else if (v && e.h) releaseVoice(v, when + Math.max(0.05, e.d) * bd, 0.06);
      }
    }
  }
  const buf = await oc.startRendering();
  return finish(buf, Math.round(totalBeats * bd * sr));
}

// Trim trailing silence after the song, fade the very end, and keep peaks below 0 dBFS.
function finish(buf, songLen) {
  const chans = [...Array(buf.numberOfChannels)].map((_, i) => buf.getChannelData(i));
  let end = songLen;
  for (let i = buf.length - 1; i > songLen; i--) {
    if (chans.some(c => Math.abs(c[i]) > 0.0008)) { end = i; break; }
  }
  end = Math.min(buf.length, end + Math.round(0.05 * buf.sampleRate));
  let peak = 0;
  for (const c of chans) for (let i = 0; i < end; i++) peak = Math.max(peak, Math.abs(c[i]));
  const gain = peak > 0.98 ? 0.98 / peak : 1;
  const fade = Math.round(0.03 * buf.sampleRate);
  const out = chans.map(c => {
    const o = c.slice(0, end);
    for (let i = 0; i < end; i++) o[i] *= gain;
    for (let i = 0; i < fade && i < end; i++) o[end - 1 - i] *= i / fade;
    return o;
  });
  return { channels: out, sampleRate: buf.sampleRate, length: end };
}

export function encodeWav(mix) {
  const { channels, sampleRate, length } = mix;
  const ch = channels.length;
  const dataLen = length * ch * 2;
  const ab = new ArrayBuffer(44 + dataLen);
  const v = new DataView(ab);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * ch * 2, true);
  v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}

export async function encodeMp3(mix, onProgress) {
  await loadScript('vendor/lame.min.js');
  const { channels, sampleRate, length } = mix;
  const toInt16 = f => {
    const o = new Int16Array(length);
    for (let i = 0; i < length; i++) { const s = Math.max(-1, Math.min(1, f[i])); o[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
    return o;
  };
  const L = toInt16(channels[0]);
  const R = channels[1] ? toInt16(channels[1]) : L;
  const enc = new window.lamejs.Mp3Encoder(2, sampleRate, 192);
  const parts = [];
  const block = 1152;
  for (let i = 0; i < length; i += block) {
    const mp3 = enc.encodeBuffer(L.subarray(i, i + block), R.subarray(i, i + block));
    if (mp3.length) parts.push(new Uint8Array(mp3));
    if ((i / block) % 300 === 0) {
      onProgress?.(i / length);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end));
  onProgress?.(1);
  return new Blob(parts, { type: 'audio/mpeg' });
}

export async function saveBlob(blob, filename, description, mime, ext) {
  // Desktop app: native Windows "Save as" dialog.
  if (window.bafoons) {
    const r = await window.bafoons.files.save({
      defaultName: filename,
      filters: [{ name: description, extensions: [ext.replace('.', '')] }],
      data: await blob.arrayBuffer(),
    });
    return !!r;
  }
  if (window.showSaveFilePicker) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description, accept: { [mime]: [ext] } }] });
      const w = await h.createWritable();
      await w.write(blob);
      await w.close();
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
      console.warn('save picker failed, falling back to download', e);
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return true;
}
