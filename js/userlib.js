// "My sounds": importing your own samples and sample packs.
//
// Accepts audio files, whole folders and .zip packs (the usual format for packs sold for
// FL Studio, Ableton, Reaper and friends). Each import becomes a "pack", and the audio is
// copied so it keeps working even if the original files move:
//   - desktop app (Electron): real files in <app data>/My Sounds/<pack>/..., indexed in library.json
//   - plain browser: the browser's IndexedDB storage
import { emit } from './state.js';
import { engine } from './engine.js';

const native = window.bafoons?.library || null;
/** 'files' in the desktop app, 'browser' otherwise. */
export const storageKind = () => (native ? 'files' : 'browser');
export const revealFolder = () => native?.reveal();
export const soundsFolder = () => native?.folder();

const DB_NAME = 'bafoonstunes';
const AUDIO_EXT = new Set(['wav', 'wave', 'mp3', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'aif', 'aiff', 'aifc']);
const PACK_COLORS = ['#ffa8a8', '#ffd8a8', '#ffec99', '#c0eb75', '#8ce99a', '#96f2d7', '#99e9f2', '#a5d8ff', '#bac8ff', '#d0bfff', '#eebefa', '#fcc2d7'];
const ROLE_COLORS = {
  kick: '#ff5a5f', snare: '#ffa94d', clap: '#ffd43b', 'hat-closed': '#a9e34b', 'hat-open': '#69db7c',
  tom: '#4dabf7', cymbal: '#b197fc', perc: '#f783ac',
};

export const userLib = { packs: [] };

// ---------------------------------------------------------------- IndexedDB

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('packs', { keyPath: 'id' });
        d.createObjectStore('sounds', { keyPath: 'id' }).createIndex('pack', 'pack');
        d.createObjectStore('blobs'); // sound id -> Blob
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = tx => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = tx.onabort = () => rej(tx.error); });

async function getBlob(id) {
  const tx = (await db()).transaction('blobs');
  const b = await req(tx.objectStore('blobs').get(id));
  if (!b) throw new Error('Missing audio for ' + id);
  return b;
}

// ---------------------------------------------------------------- loading

/** Read pack + sound metadata from storage and add the sounds to the engine. */
export async function loadUserLibrary() {
  if (native) {
    try {
      const lib = await native.load();
      userLib.packs = (lib.packs || []).sort((a, b) => a.created - b.created);
      for (const s of lib.sounds || []) register(s);
    } catch (e) {
      console.warn('Could not read the My Sounds folder', e);
    }
    return;
  }
  if (!window.indexedDB) return;
  try {
    const d = await db();
    const tx = d.transaction(['packs', 'sounds']);
    const [packs, sounds] = await Promise.all([req(tx.objectStore('packs').getAll()), req(tx.objectStore('sounds').getAll())]);
    userLib.packs = packs.sort((a, b) => a.created - b.created);
    for (const s of sounds) register(s);
  } catch (e) {
    console.warn('Could not open My sounds storage', e);
  }
}

function register(meta) {
  const pack = userLib.packs.find(p => p.id === meta.pack);
  engine.sounds.set(meta.id, {
    ...meta,
    category: 'user',
    type: 'oneshot',
    color: ROLE_COLORS[meta.role] || pack?.color || '#adb5bd',
    zones: [native
      ? { midi: meta.root ?? 60, file: fileUrl(meta), buffer: null }
      : { midi: meta.root ?? 60, load: () => getBlob(meta.id).then(b => b.arrayBuffer()), buffer: null }],
    norm: 1,
    loaded: false,
  });
}

// Desktop: the app serves <app data>/My Sounds at /my-sounds/ (same origin as the app)
const fileUrl = meta => `my-sounds/${encodeURIComponent(meta.pack)}/${meta.file.split('/').map(encodeURIComponent).join('/')}`;

export const packSounds = packId => [...engine.sounds.values()].filter(s => s.pack === packId);

// ---------------------------------------------------------------- name smarts

const clean = s => s.replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Guess what kind of drum a sample is from its folder + file name. */
export function guessRole(text) {
  const t = ' ' + clean(text).toLowerCase() + ' ';
  if (/\b(loop|loops)\b/.test(t)) return null;
  if (/\b(open ?hat|open ?hh|ohh?|hat ?open|hh ?open)\b/.test(t)) return 'hat-open';
  if (/\b(kick|kik|kck|bd|bass ?drum)s?\b/.test(t)) return 'kick';
  if (/\b(snare|snr|sd)s?\b/.test(t)) return 'snare';
  if (/\b(clap|clp|snap)s?\b/.test(t)) return 'clap';
  if (/\b(hi ?hat|hihat|hats?|hh|chh?|closed ?hat)s?\b/.test(t)) return 'hat-closed';
  if (/\b(tom|toms)\b/.test(t)) return 'tom';
  if (/\b(crash|ride|cymbal|cym|splash|china)s?\b/.test(t)) return 'cymbal';
  if (/\b(perc|percussion|shaker|conga|bongo|cowbell|tamb|tambourine|clave|rim|block|bell|click)s?\b/.test(t)) return 'perc';
  return null;
}

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/**
 * Find a musical note in a file name ("808 F#.wav", "Bass_C2.wav", "Pad - Am.wav").
 * Returns the MIDI note in the octave above middle C where it plays at its own pitch.
 * Only the note letter is trusted: DAWs disagree on octave numbers.
 */
export function guessRoot(name) {
  const re = /(?:^|[\s_\-([])([A-G])(#|b|♯|♭|sharp|flat)?(?:maj|min|m)?(?:-?\d)?(?=$|[\s_\-)\].])/g;
  let m, last = null;
  while ((m = re.exec(name))) last = m;
  if (!last) return 60;
  let pc = PC[last[1]];
  const acc = last[2];
  if (acc === '#' || acc === '♯' || acc === 'sharp') pc += 1;
  if (acc === 'b' || acc === '♭' || acc === 'flat') pc -= 1;
  return 60 + ((pc + 12) % 12);
}

// ---------------------------------------------------------------- AIFF -> WAV

// Chrome can't decode AIFF (common in Mac-made packs), so convert it to WAV on import.
function aiffToWav(ab) {
  const v = new DataView(ab);
  const tag = o => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'FORM') throw new Error('not AIFF');
  const aifc = tag(8) === 'AIFC';
  let ch = 0, bits = 0, rate = 0, comp = 'NONE', data = null;
  for (let o = 12; o + 8 <= v.byteLength;) {
    const id = tag(o), size = v.getUint32(o + 4);
    const body = o + 8;
    if (id === 'COMM') {
      ch = v.getUint16(body);
      bits = v.getUint16(body + 6);
      // 80-bit extended float sample rate
      const exp = (v.getUint16(body + 8) & 0x7fff) - 16383;
      const hi = v.getUint32(body + 10), lo = v.getUint32(body + 14);
      rate = Math.round((hi * 2 ** 32 + lo) * 2 ** (exp - 63));
      if (aifc) comp = tag(body + 18);
    } else if (id === 'SSND') {
      const offset = v.getUint32(body);
      data = new Uint8Array(ab, body + 8 + offset, Math.max(0, Math.min(size - 8 - offset, v.byteLength - body - 8 - offset)));
    }
    o = body + size + (size & 1);
  }
  if (!ch || !data) throw new Error('AIFF has no audio');
  const float = comp === 'fl32' || comp === 'FL32';
  const little = comp === 'sowt';
  if (!['NONE', 'sowt', 'fl32', 'FL32', 'twos'].includes(comp)) throw new Error('compressed AIFF not supported');
  const bytes = Math.ceil(bits / 8);
  const out = new Uint8Array(44 + data.length);
  const w = new DataView(out.buffer);
  const str = (o, s) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); w.setUint32(4, 36 + data.length, true); str(8, 'WAVE');
  str(12, 'fmt '); w.setUint32(16, 16, true); w.setUint16(20, float ? 3 : 1, true); w.setUint16(22, ch, true);
  w.setUint32(24, rate, true); w.setUint32(28, rate * ch * bytes, true); w.setUint16(32, ch * bytes, true); w.setUint16(34, bytes * 8, true);
  str(36, 'data'); w.setUint32(40, data.length, true);
  for (let i = 0; i + bytes <= data.length; i += bytes) {
    for (let b = 0; b < bytes; b++) out[44 + i + b] = little ? data[i + b] : data[i + bytes - 1 - b];
    if (bytes === 1) out[44 + i] ^= 0x80; // AIFF 8-bit is signed, WAV 8-bit is unsigned
  }
  return out.buffer;
}

// ---------------------------------------------------------------- importing

const extOf = p => (p.split('.').pop() || '').toLowerCase();
const junk = p => /(^|\/)(__MACOSX|\.)/.test(p);
const baseName = p => p.split('/').pop().replace(/\.[^.]+$/, '');

/**
 * Import a set of sources. A source is { kind: 'zip', name, blob } or
 * { kind: 'files', name, files: [{ path, blob }] }. Each source becomes one pack.
 */
export async function importSources(sources, onProgress = () => {}) {
  const summary = { packs: 0, added: 0, skipped: {}, failed: 0 };
  const skip = ext => { summary.skipped[ext || 'other'] = (summary.skipped[ext || 'other'] || 0) + 1; };
  if (!native) { try { await navigator.storage?.persist?.(); } catch { /* */ } }

  for (const src of sources) {
    let files;
    if (src.kind === 'zip') {
      onProgress({ phase: 'unzip', name: src.name });
      files = await unzipAudio(src.blob, skip);
    } else {
      files = [];
      for (const f of src.files) {
        if (junk(f.path) || !f.blob.size) continue;
        if (AUDIO_EXT.has(extOf(f.path))) files.push(f); else skip(extOf(f.path));
      }
    }
    if (!files.length) continue;
    await addPack(src.name, stripCommonRoot(files), summary, onProgress);
  }
  emit('library');
  return summary;
}

function stripCommonRoot(files) {
  const firstDirs = new Set(files.map(f => (f.path.includes('/') ? f.path.split('/')[0] : '')));
  if (firstDirs.size === 1 && !firstDirs.has('')) {
    const root = [...firstDirs][0] + '/';
    return files.map(f => ({ ...f, path: f.path.slice(root.length) }));
  }
  return files;
}

async function unzipAudio(blob, skip) {
  await loadScript('vendor/fflate.min.js');
  const u8 = new Uint8Array(await blob.arrayBuffer());
  const entries = await new Promise((resolve, reject) => {
    window.fflate.unzip(u8, {
      filter: f => {
        if (f.name.endsWith('/') || junk(f.name)) return false;
        const ok = AUDIO_EXT.has(extOf(f.name));
        if (!ok) skip(extOf(f.name));
        return ok;
      },
    }, (err, out) => (err ? reject(err) : resolve(out)));
  });
  return Object.entries(entries).map(([path, data]) => ({ path, blob: new Blob([data]) }));
}

async function addPack(name, files, summary, onProgress) {
  let packName = name || 'My Sounds';
  for (let n = 2; userLib.packs.some(p => p.name === packName); n++) packName = `${name || 'My Sounds'} ${n}`;
  const pack = {
    id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: packName,
    created: Date.now(),
    color: PACK_COLORS[userLib.packs.length % PACK_COLORS.length],
    count: 0,
    bytes: 0,
  };
  const d = native ? null : await db();
  const metas = [];
  const BATCH = 40;
  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  for (let i = 0; i < files.length; i += BATCH) {
    const chunk = [];
    for (const f of files.slice(i, i + BATCH)) {
      let blob = f.blob;
      let storedPath = f.path;
      if (['aif', 'aiff', 'aifc'].includes(extOf(f.path))) {
        try { blob = new Blob([aiffToWav(await blob.arrayBuffer())], { type: 'audio/wav' }); }
        catch { summary.failed++; continue; }
        storedPath = f.path.replace(/\.[^.\/]+$/, '.wav');
      }
      const parts = f.path.split('/');
      const group = parts.slice(0, -1).map(clean).join(' / ');
      const nm = baseName(f.path);
      const meta = {
        id: 'u:' + pack.id + ':' + (metas.length + chunk.length),
        pack: pack.id,
        name: clean(nm) || nm,
        group,
        role: guessRole(group + ' ' + nm),
        isLoop: /\bloops?\b/i.test(clean(f.path)),
        root: guessRoot(nm),
        size: blob.size,
      };
      if (native) {
        // desktop: write the file into the pack's folder right away
        try { meta.file = await native.writeFile(pack.id, storedPath, await blob.arrayBuffer()); }
        catch (e) { console.warn('Could not save', f.path, e); summary.failed++; continue; }
      }
      chunk.push({ meta, blob });
      pack.bytes += meta.size;
    }
    if (!native) {
      const tx = d.transaction(['sounds', 'blobs'], 'readwrite');
      for (const { meta, blob } of chunk) {
        tx.objectStore('sounds').put(meta);
        tx.objectStore('blobs').put(blob, meta.id);
      }
      await txDone(tx);
    }
    metas.push(...chunk.map(c => c.meta));
    onProgress({ phase: 'save', name: pack.name, done: Math.min(i + BATCH, files.length), total: files.length });
  }
  if (!metas.length) return;
  pack.count = metas.length;
  if (native) {
    await native.savePack(pack, metas);
  } else {
    const tx = d.transaction('packs', 'readwrite');
    tx.objectStore('packs').put(pack);
    await txDone(tx);
  }
  userLib.packs.push(pack);
  for (const m of metas) register(m);
  summary.packs++;
  summary.added += metas.length;
}

export async function removePack(packId) {
  const ids = packSounds(packId).map(s => s.id);
  if (native) {
    await native.removePack(packId); // deletes the pack's copied files from the app folder
  } else {
    const d = await db();
    const tx = d.transaction(['packs', 'sounds', 'blobs'], 'readwrite');
    tx.objectStore('packs').delete(packId);
    for (const id of ids) { tx.objectStore('sounds').delete(id); tx.objectStore('blobs').delete(id); }
    await txDone(tx);
  }
  for (const id of ids) engine.sounds.delete(id);
  userLib.packs = userLib.packs.filter(p => p.id !== packId);
  emit('library');
  return ids;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}

// ---------------------------------------------------------------- reading what was picked / dropped

/** Files from <input type=file> (plain files, zips, or a folder via webkitdirectory). */
export function sourcesFromFileList(list) {
  const files = [...list];
  const sources = [];
  const loose = [];
  const folders = new Map();
  for (const f of files) {
    const rel = f.webkitRelativePath || '';
    if (extOf(f.name) === 'zip') sources.push({ kind: 'zip', name: baseName(f.name), blob: f });
    else if (rel.includes('/')) {
      const top = rel.split('/')[0];
      if (!folders.has(top)) folders.set(top, []);
      folders.get(top).push({ path: rel, blob: f });
    } else loose.push({ path: f.name, blob: f });
  }
  for (const [name, fs] of folders) sources.push({ kind: 'files', name, files: fs });
  if (loose.length) sources.push({ kind: 'files', name: 'My Sounds', files: loose });
  return sources;
}

/** Files and folders dragged in from Explorer / Finder. */
export async function sourcesFromDrop(dt) {
  const entries = [...dt.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  const sources = [];
  const loose = [];
  for (const entry of entries) {
    if (entry.isDirectory) {
      const files = await readDir(entry, entry.name);
      sources.push({ kind: 'files', name: entry.name, files });
    } else {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      if (extOf(file.name) === 'zip') sources.push({ kind: 'zip', name: baseName(file.name), blob: file });
      else loose.push({ path: file.name, blob: file });
    }
  }
  if (loose.length) sources.push({ kind: 'files', name: 'My Sounds', files: loose });
  return sources;
}

async function readDir(dirEntry, path) {
  const reader = dirEntry.createReader();
  const all = [];
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    all.push(...batch);
  }
  const out = [];
  for (const e of all) {
    const p = path + '/' + e.name;
    if (e.isDirectory) out.push(...await readDir(e, p));
    else out.push({ path: p, blob: await new Promise((res, rej) => e.file(res, rej)) });
  }
  return out;
}
