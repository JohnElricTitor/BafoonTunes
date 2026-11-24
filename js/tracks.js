// Layers (track lanes) with waveforms, the ruler and the playhead.
// Click a layer to select it: Record goes into the selected layer. "+ New layer" adds an
// MPK layer (notes) or a Mic layer (audio from a microphone).
import { state, emit, on, mod, drag } from './state.js';
import { buildChain, effectInfo } from './effects.js';
import { getSound, isPitched, loadSound, startVoice, releaseVoice } from './engine.js';
import { tp, currentBeat, loopBeats, updateTrackGains, removeTrackNode, seek, trackGain, newLayer, selectLayer, setLayerEffects, setEffectAmount } from './transport.js';
import { openMic, closeMic, setMonitor, micLevel, listInputs, micState } from './mic.js';
import { encodeWav } from './exporter.js';
import { importSources } from './userlib.js';
import { layout, placeImport, renameNode, MINE } from './layout.js';

let root, lanesEl, rulerCanvas, newCard;
const lanes = new Map(); // track id -> { el, canvas, cache, ... }
let lastDeleted = null;

export function buildTracks(el) {
  root = el;
  root.innerHTML = `
    <div class="ruler-row"><div class="ruler-head">Layers</div><div class="ruler"><canvas></canvas></div></div>
    <div class="lanes"></div>`;
  lanesEl = root.querySelector('.lanes');
  rulerCanvas = root.querySelector('.ruler canvas');
  const ruler = root.querySelector('.ruler');
  ruler.title = 'Click or drag to move the playhead. Play starts from here.';
  ruler.addEventListener('pointerdown', e => startScrub(e, ruler));
  on('bars', () => { if (tp.cursor >= loopBeats()) seek(0); });

  newCard = makeNewCard();

  on('tracks', syncLanes);
  on('project', () => {
    state.selectedLayer = null;
    closeMic();
    for (const id of [...lanes.keys()]) dropLane(id);
    syncLanes(); state.tracks.forEach(queueRender); showSelection();
  });
  on('bpm', () => { clearTimeout(bpmTimer); bpmTimer = setTimeout(() => state.tracks.forEach(queueRender), 350); });
  on('bars', () => lanes.forEach(l => (l.dirty = true)));
  on('select', showSelection);
  on('rec', () => { for (const l of lanes.values()) l.el.classList.toggle('recording', tp.rec?.layer === l.track); });
  on('layerUpdated', tr => {
    const l = lanes.get(tr.id);
    if (!l) return;
    l.name.value = tr.name;
    l.el.classList.toggle('saving', !!tr._saving);
    if (!tr._saving) queueRender(tr);
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
  for (const tr of state.tracks) lanesEl.appendChild(lanes.get(tr.id).el); // keep the order
  lanesEl.appendChild(newCard); // "+ New layer" always sits under the last layer
  newCard.classList.toggle('first', !state.tracks.length);
  if (state.selectedLayer && !state.tracks.some(t => t.id === state.selectedLayer)) { state.selectedLayer = null; showSelection(); }
}

/** The card under the last layer: add an MPK layer (notes) or a Mic layer (audio). */
function makeNewCard() {
  const card = document.createElement('div');
  card.className = 'lane-new';
  card.innerHTML = `
    <div class="lane-new-text"><b>New layer</b><span>Add a layer, click it to select it, then press <span class="big-dot"></span> Record. Recording replaces what's in the selected layer.</span></div>
    <button class="btn small" data-kind="mpk" title="A layer for notes from your MPK, pads and keys">+ MPK layer</button>
    <button class="btn small" data-kind="mic" title="A layer for audio from a microphone">+ Mic layer</button>`;
  card.querySelectorAll('button').forEach(b => { b.onclick = () => newLayer(b.dataset.kind); });
  return card;
}

function dropLane(id) {
  const l = lanes.get(id);
  if (l) { l.el.remove(); lanes.delete(id); }
}

function makeLane(tr) {
  const isMic = tr.kind === 'mic';
  const el = document.createElement('div');
  el.className = 'lane' + (isMic ? ' mic' : '');
  el.style.setProperty('--lane-color', tr.color);
  el.innerHTML = `
    <div class="lane-head" title="Click to select this layer: Record goes into it">
      <div class="lane-color" style="background:${tr.color}"></div>
      <div class="lane-main">
        <div class="lane-top">
          <span class="lane-kind" title="${isMic ? 'Mic layer: records audio from a microphone' : 'MPK layer: records notes from your MPK, pads and keys'}">${isMic ? '🎙' : '🎹'}</span>
          <input class="lane-name" spellcheck="false" maxlength="40">
          <button class="lane-btn mute" title="Mute">M</button>
          <button class="lane-btn solo" title="Solo (only hear this layer)">S</button>
          <button class="lane-btn save" title="Save this layer as a sound, to use on a pad or key">⤓</button>
          <button class="lane-btn del" title="Delete layer">✕</button>
        </div>
        <div class="lane-bottom">
          <input type="range" class="lane-vol" min="0" max="1" step="0.01" title="Layer volume">
          <span class="lane-len"></span>
        </div>
        ${isMic ? `<div class="lane-mic">
          <select class="lane-input" title="Which microphone to record from"><option value="">Default mic</option></select>
          <button class="lane-btn monitor" title="Monitor: hear the mic while recording. Use headphones, or the speakers will feed back into the mic.">🎧</button>
          <div class="lane-meter" title="Mic level (select the layer to see it)"><i></i></div>
        </div>` : ''}
      </div>
    </div>
    <div class="lane-body"><canvas></canvas><div class="lane-fx"></div></div>`;
  const name = el.querySelector('.lane-name');
  const mute = el.querySelector('.mute');
  const solo = el.querySelector('.solo');
  const vol = el.querySelector('.lane-vol');
  name.value = tr.name;
  vol.value = tr.volume;
  const bars = tr.lengthBeats / 4;
  el.querySelector('.lane-len').textContent = `${bars} bar${bars === 1 ? '' : 's'}`;

  const refresh = () => {
    mute.classList.toggle('on', tr.mute);
    solo.classList.toggle('on', tr.solo);
    for (const l of lanes.values()) l.el.classList.toggle('muted', !audibleUi(l.track));
  };
  name.addEventListener('change', () => { tr.name = name.value.trim() || tr.name; tr.autoName = false; emit('change'); });
  name.addEventListener('keydown', e => { if (e.key === 'Enter') name.blur(); e.stopPropagation(); });
  mute.onclick = () => { tr.mute = !tr.mute; updateTrackGains(); refreshAll(); emit('change'); };
  solo.onclick = () => { tr.solo = !tr.solo; updateTrackGains(); refreshAll(); emit('change'); };
  vol.oninput = () => { tr.volume = +vol.value; updateTrackGains(); };
  vol.onchange = () => emit('change');
  el.querySelector('.del').onclick = () => deleteTrack(tr);
  const save = el.querySelector('.save');
  save.onclick = async () => {
    save.disabled = true;
    try { await saveTrackAsSound(tr); } finally { save.disabled = false; }
  };

  // click the layer's header (anywhere that isn't a control) to select it
  el.querySelector('.lane-head').addEventListener('click', e => {
    if (e.target.closest('input, button, select')) return;
    selectLayer(tr.id);
  });

  let meter = null;
  if (isMic) {
    const input = el.querySelector('.lane-input');
    const monitor = el.querySelector('.monitor');
    meter = el.querySelector('.lane-meter i');
    const fillInputs = async () => {
      const list = await listInputs();
      input.innerHTML = '<option value="">Default mic</option>';
      for (const d of list) input.add(new Option(d.label, d.id));
      input.value = list.some(d => d.id === tr.input) ? tr.input : '';
    };
    fillInputs();
    on('micOpen', id => { if (id === tr.id) fillInputs(); }); // names appear once the mic is allowed
    input.onchange = () => {
      tr.input = input.value;
      emit('change');
      if (state.selectedLayer === tr.id) openMic(tr);
    };
    monitor.classList.toggle('on', !!tr.monitor);
    monitor.onclick = () => {
      tr.monitor = !tr.monitor;
      monitor.classList.toggle('on', tr.monitor);
      if (micState.layerId === tr.id) setMonitor(tr.monitor);
      emit('change');
    };
  }

  const body = el.querySelector('.lane-body');
  body.title = 'Click or drag to move the playhead';
  body.addEventListener('pointerdown', e => startScrub(e, body));

  const lane = { el, track: tr, name, meter, fx: el.querySelector('.lane-fx'), canvas: el.querySelector('canvas'), peaks: null, cache: null, dirty: true, refresh };
  lanes.set(tr.id, lane);
  renderFx(lane);

  // drop an audio effect from the side panel anywhere on the layer
  el.addEventListener('dragover', e => {
    if (drag.current?.type !== 'effect') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('fx-drop');
  });
  el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) el.classList.remove('fx-drop'); });
  el.addEventListener('drop', e => {
    el.classList.remove('fx-drop');
    if (drag.current?.type !== 'effect') return;
    e.preventDefault();
    addEffect(tr, drag.current.fx);
  });
  lanesEl.appendChild(el);
  refreshAll();
  queueRender(tr);
  return lane;
}

// ---------------------------------------------------------------- audio effects on a layer

function addEffect(tr, type) {
  const info = effectInfo(type);
  if (!info) return;
  tr.effects = tr.effects || [];
  tr.effects.push({ id: Math.random().toString(36).slice(2, 9), type, amount: info.def });
  setLayerEffects(tr);
  renderFx(lanes.get(tr.id));
  emit('change');
  emit('toast', `Added ${info.name} to “${tr.name}”. Click it on the layer to adjust or remove it.`);
}

/** The effect chips over a layer's waveform. */
function renderFx(lane) {
  if (!lane) return;
  const tr = lane.track;
  lane.fx.innerHTML = '';
  (tr.effects || []).forEach((fx, i) => {
    const info = effectInfo(fx.type);
    const chip = document.createElement('button');
    chip.className = 'fx-chip';
    chip.style.setProperty('--fx', info?.color || '#aaa');
    chip.title = `${info?.name}: ${Math.round(fx.amount * 100)}% — click to adjust or remove`;
    chip.innerHTML = '<i></i><span></span>';
    chip.querySelector('span').textContent = `${info?.name || fx.type} ${Math.round(fx.amount * 100)}`;
    chip.addEventListener('pointerdown', e => e.stopPropagation()); // don't move the playhead
    chip.addEventListener('click', e => { e.stopPropagation(); openFxPopover(chip, tr, i); });
    lane.fx.appendChild(chip);
  });
}

let fxPop = null;
function closeFxPopover() {
  fxPop?.remove();
  fxPop = null;
  document.removeEventListener('pointerdown', fxOutside, true);
}
function fxOutside(e) { if (fxPop && !fxPop.contains(e.target) && !e.target.closest('.fx-chip')) closeFxPopover(); }

function openFxPopover(chip, tr, i) {
  closeFxPopover();
  const fx = tr.effects[i];
  const info = effectInfo(fx.type);
  fxPop = document.createElement('div');
  fxPop.className = 'fx-pop';
  fxPop.innerHTML = `<b></b><span class="muted small"></span>
    <label class="fx-amount">Amount <input type="range" min="0" max="100" step="1"><output></output></label>
    <button class="btn small fx-remove">Remove</button>`;
  fxPop.querySelector('b').textContent = info?.name || fx.type;
  fxPop.querySelector('.muted').textContent = info?.hint || '';
  const range = fxPop.querySelector('input'), out = fxPop.querySelector('output');
  range.value = Math.round(fx.amount * 100);
  out.textContent = range.value + '%';
  range.oninput = () => {
    fx.amount = range.value / 100;
    out.textContent = range.value + '%';
    setEffectAmount(tr, i, fx.amount);
    const span = chip.querySelector('span');
    if (span) span.textContent = `${info?.name || fx.type} ${range.value}`;
  };
  range.onchange = () => emit('change');
  range.addEventListener('keydown', e => e.stopPropagation()); // arrow keys adjust, not play notes
  fxPop.querySelector('.fx-remove').onclick = () => {
    tr.effects.splice(i, 1);
    setLayerEffects(tr);
    renderFx(lanes.get(tr.id));
    closeFxPopover();
    emit('change');
  };
  document.body.appendChild(fxPop);
  const r = chip.getBoundingClientRect();
  const pr = fxPop.getBoundingClientRect();
  fxPop.style.left = Math.min(r.left, innerWidth - pr.width - 8) + 'px';
  fxPop.style.top = Math.min(r.bottom + 6, innerHeight - pr.height - 8) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', fxOutside, true));
}

/** Highlight the selected layer and open the mic if it's a Mic layer. */
function showSelection() {
  for (const l of lanes.values()) l.el.classList.toggle('selected', l.track.id === state.selectedLayer);
  const tr = state.tracks.find(t => t.id === state.selectedLayer);
  if (tr?.kind === 'mic') openMic(tr);
  else if (micState.layerId !== 'pad-rec') closeMic(); // a pad armed to record keeps the mic
}

function audibleUi(tr) {
  const anySolo = state.tracks.some(t => t.solo);
  return anySolo ? tr.solo : !tr.mute;
}
function refreshAll() { for (const l of lanes.values()) l.refresh(); }

function deleteTrack(tr) {
  if (tp.rec?.layer === tr) { emit('toast', 'Stop recording before deleting this layer.'); return; }
  const i = state.tracks.indexOf(tr);
  if (i < 0) return;
  state.tracks.splice(i, 1);
  removeTrackNode(tr.id);
  lastDeleted = { tr, i };
  if (state.selectedLayer === tr.id) { state.selectedLayer = null; showSelection(); }
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
    const v = startVoice(oc, oc.destination, s, e.n, e.v, when, { gain: e.g, pitched: !!e.p, loop: !!e.lp });
    if (v?.pitched) releaseVoice(v, when + Math.max(0.05, e.d) * bd, e.r);
    else if (v && e.h) releaseVoice(v, when + Math.max(0.05, e.d) * bd, 0.06);
  }
  const buf = await oc.startRendering();
  const d = buf.getChannelData(0);
  const n = Math.round(loopSec * sr);
  const out = new Float32Array(n);
  out.set(d.subarray(0, n));
  for (let i = n; i < d.length; i++) out[i % n] += d[i];
  return out;
}

// ---------------------------------------------------------------- save a track as a sound

const RECORDINGS = 'Recordings';

/**
 * Turn a track into an audio sample in "My sounds › Recordings" so it can go on a pad or key.
 * One pass of the loop at the track's volume, starting at its first note, with the last
 * notes left to ring out.
 * Effects dropped on the layer are kept. The knob effects (reverb, echo, tone…) aren't baked
 * in: they apply again wherever it's played.
 */
export async function saveTrackAsSound(tr) {
  if (!tr.events.length) { emit('toast', 'This track is empty.'); return; }
  emit('toast', `Saving “${tr.name}” as a sound…`);
  const sr = 44100, bd = 60 / state.bpm, loopSec = tr.lengthBeats * bd;
  await Promise.all([...new Set(tr.events.map(e => e.s))].map(loadSound));
  const oc = new OfflineAudioContext(2, Math.ceil((loopSec + 4) * sr), sr);
  const out = oc.createGain();
  out.gain.value = trackGain(tr);
  const chain = buildChain(oc, tr.effects || [], state.bpm); // the layer's own effects are kept
  out.connect(chain.input);
  chain.output.connect(oc.destination);
  for (const e of tr.events) {
    const s = getSound(e.s);
    if (!s?.loaded) continue;
    const when = e.t * bd;
    const v = startVoice(oc, out, s, e.n, e.v, when, { gain: e.g, pitched: !!e.p, loop: !!e.lp });
    if (v?.pitched) releaseVoice(v, when + Math.max(0.05, e.d) * bd, e.r);
    else if (v && e.h) releaseVoice(v, when + Math.max(0.05, e.d) * bd, 0.06);
  }
  const buf = await oc.startRendering();
  const chans = [buf.getChannelData(0), buf.getChannelData(1)];
  // keep the full loop, plus any ring-out after it until it goes quiet
  let end = Math.round(loopSec * sr);
  for (let i = buf.length - 1; i > end; i--) if (Math.abs(chans[0][i]) > 0.0008 || Math.abs(chans[1][i]) > 0.0008) { end = i; break; }
  end = Math.min(buf.length, end + Math.round(0.02 * sr));
  // skip silence before the first note, so a pad plays it the moment it's pressed
  let start = 0;
  while (start < end && Math.abs(chans[0][start]) <= 0.0008 && Math.abs(chans[1][start]) <= 0.0008) start++;
  start = Math.max(0, start - Math.round(0.003 * sr));
  if (start >= end) start = 0;
  let peak = 0;
  for (const c of chans) for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(c[i]));
  const k = peak > 0.98 ? 0.98 / peak : 1;
  const fade = Math.round(0.01 * sr);
  const len = end - start;
  const channels = chans.map(c => {
    const o = c.slice(start, end);
    for (let i = 0; i < len; i++) o[i] *= k;
    for (let i = 0; i < fade && i < len; i++) o[len - 1 - i] *= i / fade;
    return o;
  });
  const wav = encodeWav({ channels, sampleRate: sr, length: len });

  const name = (tr.name || 'Track').replace(/[\\/:*?"<>|]+/g, '').trim() || 'Track';
  const summary = await importSources([{ kind: 'files', name: RECORDINGS, files: [{ path: `${name}.wav`, blob: wav }] }]);
  if (!summary.added) { emit('toast', "Couldn't save that track as a sound."); return; }
  // put it in the "Recordings" pack in My sounds (made the first time)
  const mine = layout.sections.find(s => s.id === MINE);
  const existing = mine?.packs.find(p => p.name === RECORDINGS);
  placeImport(summary.newPacks, existing ? existing.id : MINE);
  if (!existing) {
    const made = layout.sections.find(s => s.id === MINE)?.packs.at(-1);
    if (made && made.name !== RECORDINGS) renameNode(made.id, RECORDINGS);
  }
  const id = summary.newPacks[0].metas[0].id;
  emit('revealSound', id);
  emit('toast', `Saved “${name}” to My sounds › ${RECORDINGS}. Drag it onto a pad or key.`);
  return id;
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

// ---------------------------------------------------------------- playhead / scrubbing

let scrub = null; // beat the playhead is being dragged to

/** Where to draw the playhead (0..1 across the loop). Shown at its resting place when stopped. */
function playheadPos() {
  const L = loopBeats();
  if (scrub !== null) return scrub / L;
  if (tp.playing) {
    const b = currentBeat();
    if (b >= 0 && b >= tp.countInUntil) return mod(b, L) / L;
  }
  return Math.min(tp.cursor, L) / L;
}

/** Click or drag on the ruler / a waveform to place the playhead. */
function startScrub(e, el) {
  if (e.button !== 0 || e.target.closest('input, button')) return;
  if (tp.rec) { emit('toast', "The playhead can't be moved while recording."); return; }
  e.preventDefault();
  el.setPointerCapture(e.pointerId);
  const at = ev => {
    const r = el.getBoundingClientRect();
    const b = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * loopBeats();
    return Math.round(b * 4) / 4; // snap to 16th notes
  };
  const move = ev => {
    scrub = at(ev);
    if (!tp.playing) seek(scrub); // stopped: move it straight away
  };
  move(e);
  el.onpointermove = move;
  el.onpointerup = el.onpointercancel = () => {
    el.onpointermove = el.onpointerup = el.onpointercancel = null;
    if (scrub !== null) seek(scrub); // playing: jump when let go
    scrub = null;
  };
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

/** Drawn on the layer being recorded: its old part faded out, the take filling in over it. */
function drawRecOverlay(lane, g, w, h) {
  const L = loopBeats();
  const rec = tp.rec;
  const dpr = devicePixelRatio || 1;
  g.globalAlpha = 0.25; // what's about to be replaced
  if (lane.cache) g.drawImage(lane.cache, 0, 0);
  g.globalAlpha = 1;
  g.fillStyle = '#ff3b4e14';
  g.fillRect(0, 0, w, h);
  if (rec) {
    const b = currentBeat();
    const waiting = b < rec.startBeat;
    g.font = `600 ${12 * dpr}px Segoe UI, sans-serif`;
    g.textBaseline = 'top';
    g.fillStyle = waiting ? '#ffb84d' : '#ff6b78';
    g.fillText(waiting ? '● Get ready…' : rec.layer.kind === 'mic' ? '● Recording the mic…' : '● Recording…', 8 * dpr, 6 * dpr);
    if (b >= rec.startBeat) {
      const done = Math.min(1, (b - rec.startBeat) / rec.L);
      const startX = mod(rec.startBeat, L) / L * w;
      g.fillStyle = '#ff3b4e30';
      const len = done * rec.L / L * w;
      g.fillRect(startX, 0, Math.min(len, w - startX), h);
      if (startX + len > w) g.fillRect(0, 0, startX + len - w, h);
    }
    const held = new Set(rec.held.values());
    for (const e of rec.events) {
      const s = getSound(e.s);
      const x = (e.t / L) * w;
      const pitched = isPitched(s) || e.p;
      const y = pitched ? h - 8 - ((e.n % 36) / 36) * (h - 16) : h / 2;
      g.fillStyle = s?.color || '#fff';
      // a key still held grows from where it started to "now"; once let go it shows its real length
      const beats = held.has(e) ? Math.min(rec.L, Math.max(0, b - e._abs)) : e.d;
      const dw = pitched ? Math.max(3, beats / L * w) : 4;
      g.fillRect(x, y - 3, Math.min(dw, w - x), 6);
      if (x + dw > w) g.fillRect(0, y - 3, x + dw - w, 6); // wraps round the end of the loop
    }
  }
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
    if (tp.rec?.layer === lane.track) drawRecOverlay(lane, g, c.width, c.height);
    else g.drawImage(lane.cache, 0, 0);
    if (lane.track._saving) {
      const dpr = devicePixelRatio || 1;
      g.font = `600 ${12 * dpr}px Segoe UI, sans-serif`;
      g.textBaseline = 'top';
      g.fillStyle = '#ffb84d';
      g.fillText('Saving the mic take…', 8 * dpr, 6 * dpr);
    }
    drawPlayhead(g, c.width, c.height, pos);
    // live mic level on the selected Mic layer
    if (lane.meter) {
      const level = micState.layerId === lane.track.id ? Math.min(1, micLevel() * 1.4) : 0;
      lane.meter.style.width = `${Math.round(level * 100)}%`;
      lane.meter.classList.toggle('hot', level > 0.9);
    }
  }
  requestAnimationFrame(frame);
}
