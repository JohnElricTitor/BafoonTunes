// Track lanes with waveforms, ruler and playhead.
import { state, emit, on, mod } from './state.js';
import { getSound, isPitched, loadSound, startVoice, releaseVoice } from './engine.js';
import { tp, currentBeat, loopBeats, updateTrackGains, removeTrackNode } from './transport.js';

let root, lanesEl, rulerCanvas;
const lanes = new Map(); // track id -> { el, canvas, cache }
let recLane = null;
let lastDeleted = null;

export function buildTracks(el) {
  root = el;
  root.innerHTML = `
    <div class="ruler-row"><div class="ruler-head">Tracks</div><div class="ruler"><canvas></canvas></div></div>
    <div class="lanes"></div>`;
  lanesEl = root.querySelector('.lanes');
  rulerCanvas = root.querySelector('.ruler canvas');

  on('tracks', syncLanes);
  on('project', () => { for (const id of [...lanes.keys()]) dropLane(id); syncLanes(); state.tracks.forEach(queueRender); });
  on('bpm', () => { clearTimeout(bpmTimer); bpmTimer = setTimeout(() => state.tracks.forEach(queueRender), 350); });
  on('bars', () => lanes.forEach(l => (l.dirty = true)));
  on('rec', () => {
    syncLanes();
    // a finished take: draw its waveform now that all its notes are in
    if (!tp.rec) for (const l of lanes.values()) if (!l.peaks) queueRender(l.track);
  });

  new ResizeObserver(() => {
    root.style.setProperty('--sbw', (lanesEl.offsetWidth - lanesEl.clientWidth) + 'px');
    lanes.forEach(l => (l.dirty = true));
  }).observe(lanesEl);

  syncLanes();
  requestAnimationFrame(frame);
}
let bpmTimer = 0;

// ---------------------------------------------------------------- lanes DOM

function syncLanes() {
  for (const id of [...lanes.keys()]) if (!state.tracks.find(t => t.id === id)) dropLane(id);
  for (const tr of state.tracks) if (!lanes.has(tr.id)) makeLane(tr);
  // order
  for (const tr of state.tracks) lanesEl.appendChild(lanes.get(tr.id).el);

  const recording = !!tp.rec && !tp.rec.track;
  if (recording && !recLane) recLane = makeRecLane();
  if (!recording && recLane) { recLane.el.remove(); recLane = null; }
  if (recLane) lanesEl.appendChild(recLane.el);

  let empty = lanesEl.querySelector('.tracks-empty');
  if (!state.tracks.length && !recLane) {
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'tracks-empty';
      empty.innerHTML = '<div>Press <span class="big-dot"></span><b>Record</b> (or <kbd>R</kbd>) and play something.<br>Each take becomes a looping track here, so you can layer drums, bass and melody.</div>';
      lanesEl.appendChild(empty);
    }
  } else if (empty) empty.remove();
}

function dropLane(id) {
  const l = lanes.get(id);
  if (l) { l.el.remove(); lanes.delete(id); }
}

function makeLane(tr) {
  const el = document.createElement('div');
  el.className = 'lane';
  el.style.setProperty('--lane-color', tr.color);
  el.innerHTML = `
    <div class="lane-head">
      <div class="lane-color" style="background:${tr.color}"></div>
      <div class="lane-main">
        <div class="lane-top">
          <input class="lane-name" spellcheck="false" maxlength="40">
          <button class="lane-btn mute" title="Mute">M</button>
          <button class="lane-btn solo" title="Solo (only hear this track)">S</button>
          <button class="lane-btn del" title="Delete track">✕</button>
        </div>
        <div class="lane-bottom">
          <input type="range" min="0" max="1" step="0.01" title="Track volume">
          <span class="lane-len"></span>
        </div>
      </div>
    </div>
    <div class="lane-body"><canvas></canvas></div>`;
  const name = el.querySelector('.lane-name');
  const mute = el.querySelector('.mute');
  const solo = el.querySelector('.solo');
  const vol = el.querySelector('input[type=range]');
  name.value = tr.name;
  vol.value = tr.volume;
  const bars = tr.lengthBeats / 4;
  el.querySelector('.lane-len').textContent = `${bars} bar${bars === 1 ? '' : 's'}`;

  const refresh = () => {
    mute.classList.toggle('on', tr.mute);
    solo.classList.toggle('on', tr.solo);
    for (const l of lanes.values()) l.el.classList.toggle('muted', !audibleUi(l.track));
  };
  name.addEventListener('change', () => { tr.name = name.value.trim() || tr.name; emit('change'); });
  name.addEventListener('keydown', e => { if (e.key === 'Enter') name.blur(); e.stopPropagation(); });
  mute.onclick = () => { tr.mute = !tr.mute; updateTrackGains(); refreshAll(); emit('change'); };
  solo.onclick = () => { tr.solo = !tr.solo; updateTrackGains(); refreshAll(); emit('change'); };
  vol.oninput = () => { tr.volume = +vol.value; updateTrackGains(); };
  vol.onchange = () => emit('change');
  el.querySelector('.del').onclick = () => deleteTrack(tr);

  const lane = { el, track: tr, canvas: el.querySelector('canvas'), peaks: null, cache: null, dirty: true, refresh };
  lanes.set(tr.id, lane);
  lanesEl.appendChild(el);
  refreshAll();
  if (tr !== tp.rec?.track) queueRender(tr);
  return lane;
}

function audibleUi(tr) {
  const anySolo = state.tracks.some(t => t.solo);
  return anySolo ? tr.solo : !tr.mute;
}
function refreshAll() { for (const l of lanes.values()) l.refresh(); }

function deleteTrack(tr) {
  const i = state.tracks.indexOf(tr);
  if (i < 0) return;
  state.tracks.splice(i, 1);
  removeTrackNode(tr.id);
  lastDeleted = { tr, i };
  syncLanes(); updateTrackGains(); refreshAll();
  emit('change');
  emit('toast', { text: `Deleted “${tr.name}”.`, action: 'Undo', run: undoDelete });
}

function undoDelete() {
  if (!lastDeleted) return;
  const { tr, i } = lastDeleted;
  lastDeleted = null;
  state.tracks.splice(Math.min(i, state.tracks.length), 0, tr);
  syncLanes(); updateTrackGains(); refreshAll();
  emit('change');
}

function makeRecLane() {
  const el = document.createElement('div');
  el.className = 'lane recording';
  el.innerHTML = `
    <div class="lane-head">
      <div class="lane-color" style="background:var(--accent)"></div>
      <div class="lane-main"><div class="lane-top"><input class="lane-name" value="● Recording…" disabled></div>
      <div class="lane-bottom"><span class="lane-len">Play anything — it all goes in this take</span></div></div>
    </div>
    <div class="lane-body"><canvas></canvas></div>`;
  return { el, canvas: el.querySelector('canvas'), name: el.querySelector('.lane-name'), hint: el.querySelector('.lane-len') };
}

// Label the lane by phase: waiting for the loop to come round, or recording.
function labelRecLane(waiting) {
  if (recLane.waiting === waiting) return;
  recLane.waiting = waiting;
  recLane.el.classList.toggle('waiting', waiting);
  recLane.name.value = waiting ? '● Get ready…' : '● Recording…';
  recLane.hint.textContent = waiting
    ? 'Recording starts when the loop comes round'
    : 'Play anything — it all goes in this take';
}

// ---------------------------------------------------------------- waveform rendering

const queue = [];
let rendering = false;

export function queueRender(tr) {
  if (!queue.includes(tr)) queue.push(tr);
  if (!rendering) runQueue();
}

async function runQueue() {
  rendering = true;
  while (queue.length) {
    const tr = queue.shift();
    if (!state.tracks.includes(tr)) continue;
    try {
      const data = await renderTrack(tr);
      const lane = lanes.get(tr.id);
      if (lane) { lane.peaks = peaks(data, Math.max(200, tr.lengthBeats * 60)); lane.dirty = true; }
    } catch (e) { console.warn('waveform render failed', e); }
  }
  rendering = false;
}

/** Render one loop of a track (mono) with the ring-out folded back to the start. */
export async function renderTrack(tr, sr = 22050) {
  const bd = 60 / state.bpm;
  const loopSec = tr.lengthBeats * bd;
  await Promise.all([...new Set(tr.events.map(e => e.s))].map(loadSound));
  const oc = new OfflineAudioContext(1, Math.ceil((loopSec + 2) * sr), sr);
  for (const e of tr.events) {
    const s = getSound(e.s);
    if (!s?.loaded) continue;
    const when = e.t * bd;
    const v = startVoice(oc, oc.destination, s, e.n, e.v, when, { gain: e.g, pitched: !!e.p });
    if (v?.pitched) releaseVoice(v, when + Math.max(0.05, e.d) * bd, e.r);
  }
  const buf = await oc.startRendering();
  const d = buf.getChannelData(0);
  const n = Math.round(loopSec * sr);
  const out = new Float32Array(n);
  out.set(d.subarray(0, n));
  for (let i = n; i < d.length; i++) out[i % n] += d[i];
  return out;
}

function peaks(data, buckets) {
  const min = new Float32Array(buckets), max = new Float32Array(buckets);
  const step = data.length / buckets;
  let top = 0.0001;
  for (let b = 0; b < buckets; b++) {
    let lo = 0, hi = 0;
    const end = Math.min(data.length, Math.floor((b + 1) * step));
    for (let i = Math.floor(b * step); i < end; i++) { const v = data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    min[b] = lo; max[b] = hi;
    top = Math.max(top, -lo, hi);
  }
  return { min, max, scale: 0.92 / top };
}

// ---------------------------------------------------------------- drawing

function sizeCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; return true; }
  return false;
}

function drawGrid(g, w, h, L) {
  for (let b = 0; b < L; b++) {
    const x = Math.round(b / L * w) + 0.5;
    g.fillStyle = b % 4 === 0 ? '#2a2a35' : '#1b1b22';
    g.fillRect(x, 0, 1, h);
  }
}

function drawLaneCache(lane) {
  const c = lane.canvas;
  sizeCanvas(c);
  const w = c.width, h = c.height;
  const cache = lane.cache && lane.cache.width === w && lane.cache.height === h ? lane.cache : new OffscreenCanvas(w, h);
  const g = cache.getContext('2d');
  g.clearRect(0, 0, w, h);
  const L = loopBeats();
  drawGrid(g, w, h, L);
  const tr = lane.track;
  const color = tr.color;
  // shade each repeat of a shorter track
  const reps = Math.ceil(L / tr.lengthBeats);
  for (let r = 0; r < reps; r++) {
    const x0 = r * tr.lengthBeats / L * w;
    const x1 = Math.min(w, (r + 1) * tr.lengthBeats / L * w);
    g.fillStyle = r === 0 ? color + '26' : color + '14';
    g.fillRect(x0 + 1, 3, x1 - x0 - 2, h - 6);
  }
  const p = lane.peaks;
  if (p) {
    const mid = h / 2, amp = (h / 2 - 6) * p.scale;
    g.fillStyle = color;
    const n = p.min.length;
    for (let x = 0; x < w; x++) {
      const beat = x / w * L;
      const pos = mod(beat, tr.lengthBeats) / tr.lengthBeats;
      const b = Math.min(n - 1, Math.floor(pos * n));
      const y1 = mid - p.max[b] * amp, y2 = mid - p.min[b] * amp;
      g.globalAlpha = beat >= tr.lengthBeats ? 0.55 : 1;
      g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
    g.globalAlpha = 1;
  }
  lane.cache = cache;
  lane.dirty = false;
}

function playheadPos() {
  if (!tp.playing) return null;
  const b = currentBeat();
  if (b < 0) return null;
  return mod(b, loopBeats()) / loopBeats();
}

function drawPlayhead(g, w, h, pos) {
  if (pos === null) return;
  const x = Math.round(pos * w);
  g.fillStyle = '#ffffff';
  g.fillRect(x, 0, Math.max(1, Math.round(devicePixelRatio)), h);
}

function drawRuler(pos) {
  const c = rulerCanvas;
  sizeCanvas(c);
  const g = c.getContext('2d');
  const w = c.width, h = c.height, dpr = devicePixelRatio || 1;
  g.clearRect(0, 0, w, h);
  const L = loopBeats();
  g.font = `${11 * dpr}px Segoe UI, sans-serif`;
  g.textBaseline = 'middle';
  for (let b = 0; b < L; b++) {
    const x = Math.round(b / L * w);
    if (b % 4 === 0) {
      g.fillStyle = '#3a3a48'; g.fillRect(x, 0, 1, h);
      g.fillStyle = '#a0a0b0'; g.fillText(String(b / 4 + 1), x + 5 * dpr, h / 2);
    } else {
      g.fillStyle = '#2a2a35'; g.fillRect(x, h * 0.6, 1, h * 0.4);
    }
  }
  if (pos !== null) {
    const x = pos * w;
    g.fillStyle = '#fff';
    g.beginPath(); g.moveTo(x - 6 * dpr, 0); g.lineTo(x + 6 * dpr, 0); g.lineTo(x, 9 * dpr); g.fill();
  }
}

function drawRecLane(pos) {
  const c = recLane.canvas;
  sizeCanvas(c);
  const g = c.getContext('2d');
  const w = c.width, h = c.height;
  g.clearRect(0, 0, w, h);
  const L = loopBeats();
  const rec = tp.rec;
  g.fillStyle = '#ff3b4e14';
  g.fillRect(0, 0, w, h);
  drawGrid(g, w, h, L);
  if (rec) {
    const b = currentBeat();
    labelRecLane(b < rec.startBeat);
    if (b >= rec.startBeat) {
      const done = Math.min(1, (b - rec.startBeat) / rec.L);
      const startX = mod(rec.startBeat, L) / L * w;
      g.fillStyle = '#ff3b4e30';
      const len = done * rec.L / L * w;
      g.fillRect(startX, 0, Math.min(len, w - startX), h);
      if (startX + len > w) g.fillRect(0, 0, startX + len - w, h);
    }
    for (const e of rec.events) {
      const s = getSound(e.s);
      const x = (e.t / L) * w;
      const pitched = isPitched(s) || e.p;
      const y = pitched ? h - 8 - ((e.n % 36) / 36) * (h - 16) : h / 2;
      g.fillStyle = s?.color || '#fff';
      const dw = pitched ? Math.max(3, e.d / L * w) : 4;
      g.fillRect(x, y - 3, dw, 6);
    }
  }
  drawPlayhead(g, w, h, pos);
}

function frame() {
  const pos = playheadPos();
  drawRuler(pos);
  for (const lane of lanes.values()) {
    const c = lane.canvas;
    if (sizeCanvas(c)) lane.dirty = true;
    if (lane.dirty || !lane.cache) drawLaneCache(lane);
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(lane.cache, 0, 0);
    drawPlayhead(g, c.width, c.height, pos);
  }
  if (recLane) drawRecLane(pos);
  requestAnimationFrame(frame);
}
