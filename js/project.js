// Save / open / autosave of the session.
import { state, emit, on, defaultProject, KNOBS, TRACK_COLORS, uid } from './state.js';
import { engine, loadSound } from './engine.js';
import { stop, resetTrackNodes } from './transport.js';
import { saveBlob } from './exporter.js';

const AUTOSAVE = 'tunes.autosave';
let fileHandle = null;
let saveTimer = 0;

export function serialize() {
  return {
    app: 'tunes',
    version: 1,
    name: state.name,
    bpm: state.bpm,
    bars: state.bars,
    metronome: state.metronome,
    countIn: state.countIn,
    quantize: state.quantize,
    keyboardSound: state.keyboardSound,
    keyOverrides: state.keyOverrides,
    pads: state.pads,
    knobs: state.knobs,
    tracks: state.tracks.map(t => ({
      id: t.id, name: t.name, color: t.color, volume: t.volume, mute: t.mute, solo: t.solo,
      lengthBeats: t.lengthBeats,
      events: t.events.map(({ s, n, v, g, r, t: time, d, p }) => (p ? { s, n, v, g, r, t: time, d, p } : { s, n, v, g, r, t: time, d })),
    })),
  };
}

export function applyProject(p) {
  if (!p || p.app !== 'tunes') throw new Error('That file is not a BafoonsTunes project.');
  stop();
  resetTrackNodes();
  const d = defaultProject();
  const num = (v, def, lo, hi) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : def);
  state.name = String(p.name || d.name).slice(0, 60);
  state.bpm = num(p.bpm, d.bpm, 40, 240);
  state.bars = [1, 2, 4, 8].includes(+p.bars) ? +p.bars : d.bars;
  state.metronome = p.metronome ?? d.metronome;
  state.countIn = p.countIn ?? d.countIn;
  state.quantize = [0, 8, 16].includes(+p.quantize) ? +p.quantize : d.quantize;
  state.keyboardSound = engine.sounds.has(p.keyboardSound) ? p.keyboardSound : d.keyboardSound;
  state.keyOverrides = {};
  for (const [k, v] of Object.entries(p.keyOverrides || {})) if (engine.sounds.has(v)) state.keyOverrides[k] = v;
  state.pads = Array.from({ length: 16 }, (_, i) => (engine.sounds.has(p.pads?.[i]) ? p.pads[i] : null));
  state.knobs = KNOBS.map((k, i) => num(p.knobs?.[i], k.def, 0, 1));
  state.tracks = (p.tracks || []).map((t, i) => ({
    id: t.id || uid(),
    name: String(t.name || `Take ${i + 1}`),
    color: t.color || TRACK_COLORS[i % TRACK_COLORS.length],
    volume: num(t.volume, 0.8, 0, 1),
    mute: !!t.mute,
    solo: !!t.solo,
    lengthBeats: [4, 8, 16, 32].includes(+t.lengthBeats) ? +t.lengthBeats : 16,
    events: (t.events || []).filter(e => e && typeof e.s === 'string' && Number.isFinite(e.t)),
  }));
  preloadProjectSounds();
  emit('project');
  emit('bpm');
}

export function preloadProjectSounds() {
  const ids = new Set([state.keyboardSound, ...state.pads, ...Object.values(state.keyOverrides),
    ...state.tracks.flatMap(t => t.events.map(e => e.s))]);
  return Promise.all([...ids].filter(Boolean).map(loadSound));
}

// ---------------------------------------------------------------- autosave

export function initAutosave() {
  on('change', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(autosaveNow, 800);
  });
  window.addEventListener('beforeunload', autosaveNow);
}

function autosaveNow() {
  try { localStorage.setItem(AUTOSAVE, JSON.stringify(serialize())); } catch (e) { console.warn('autosave failed', e); }
}

export function restoreAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE);
    if (!raw) return false;
    applyProject(JSON.parse(raw));
    return true;
  } catch (e) {
    console.warn('could not restore autosave', e);
    return false;
  }
}

// ---------------------------------------------------------------- files

const safeName = () => (state.name || 'My Song').replace(/[\\/:*?"<>|]+/g, '').trim() || 'My Song';

const PROJECT_FILTERS = [{ name: 'BafoonsTunes project', extensions: ['tunes'] }];
let filePath = null; // desktop: where this project was last saved/opened

export async function saveProject(saveAs = false) {
  const json = JSON.stringify(serialize(), null, 1);
  if (window.bafoons) {
    const r = await window.bafoons.files.save({
      defaultName: safeName() + '.tunes',
      filters: PROJECT_FILTERS,
      data: new TextEncoder().encode(json).buffer,
      path: saveAs ? null : filePath,
    });
    if (r) { filePath = r.path; emit('toast', `Saved “${r.name}”.`); }
    return;
  }
  if (window.showSaveFilePicker) {
    try {
      if (!fileHandle || saveAs) {
        fileHandle = await window.showSaveFilePicker({
          suggestedName: safeName() + '.tunes',
          types: [{ description: 'BafoonsTunes project', accept: { 'application/json': ['.tunes'] } }],
        });
      }
      const w = await fileHandle.createWritable();
      await w.write(json);
      await w.close();
      emit('toast', `Saved “${fileHandle.name}”.`);
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.warn('save failed, falling back to download', e);
      fileHandle = null;
    }
  }
  await saveBlob(new Blob([json], { type: 'application/json' }), safeName() + '.tunes', 'BafoonsTunes project', 'application/json', '.tunes');
  emit('toast', 'Project downloaded.');
}

export async function openProject() {
  let text, handle = null, openedPath = null;
  if (window.bafoons) {
    const r = await window.bafoons.files.open({ filters: [...PROJECT_FILTERS, { name: 'All files', extensions: ['*'] }] });
    if (!r) return;
    text = r.text;
    openedPath = r.path;
  } else if (window.showOpenFilePicker) {
    try {
      [handle] = await window.showOpenFilePicker({
        types: [{ description: 'BafoonsTunes project', accept: { 'application/json': ['.tunes', '.json'] } }],
      });
      text = await (await handle.getFile()).text();
    } catch (e) {
      if (e.name === 'AbortError') return;
      throw e;
    }
  } else {
    text = await new Promise(resolve => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.tunes,.json';
      inp.onchange = async () => resolve(inp.files[0] ? await inp.files[0].text() : null);
      inp.click();
    });
    if (!text) return;
  }
  try {
    applyProject(JSON.parse(text));
    fileHandle = handle;
    filePath = openedPath;
    autosaveNow();
    emit('toast', `Opened “${state.name}”.`);
  } catch (e) {
    emit('toast', e.message || 'Could not open that file.');
  }
}

export function newProject(defaults) {
  fileHandle = null;
  filePath = null;
  applyProject({ app: 'tunes', ...defaultProject(), ...defaults });
  autosaveNow();
}
