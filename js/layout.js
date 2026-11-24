// How sounds are organised in the side panel:
//
//   Section  ("My sounds", "Drum kits", or anything she makes)
//     Pack    ("Acoustic Kit", an imported sample pack, …)
//       Group ("Kicks", "808s", …)
//         sounds
//
// Sounds can also sit directly in a section or a pack. Every level can be created, renamed,
// folded, moved (by dragging) and deleted. This is only the organisation: the audio itself
// lives in the built-in sounds folder or in "My sounds" storage (see userlib.js).
//
// Saved in localStorage (works in both the browser and the desktop app).
import { emit } from './state.js';
import { engine } from './engine.js';
import { userLib } from './userlib.js';

const KEY = 'tunes.layout';
export const MINE = 'sec-mine';

export const layout = {
  sections: [],          // [{ id, name, packs: [{ id, name, src?, groups: [{ id, name, sounds }], sounds }], sounds }]
  removedBuiltins: [],   // built-in sounds she deleted (hidden; "Restore built-in sounds" brings them back)
  names: {},             // renamed sounds: { soundId: name }
};

const nid = p => `${p}-${Math.random().toString(36).slice(2, 9)}`;
const tidy = s => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);

// ---------------------------------------------------------------- load / save

export function loadLayout() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY)); } catch { /* */ }
  if (saved && Array.isArray(saved.sections)) {
    layout.sections = saved.sections;
    layout.removedBuiltins = saved.removedBuiltins || [];
    layout.names = saved.names || {};
  } else {
    layout.sections = defaultSections();
  }
  reconcile();
  applyNames();
  save();
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(layout)); } catch (e) { console.warn('could not save the sound layout', e); }
}
function changed() { save(); emit('library'); }

function defaultSections() {
  const byCat = cat => [...engine.sounds.values()].filter(s => s.category === cat).map(s => s.id);
  return [
    { id: MINE, name: 'My sounds', packs: [], sounds: [] },
    { id: 'sec-kits', name: 'Drum kits', packs: engine.kits.map(k => ({ id: 'pk-' + k.id, name: k.name, groups: [], sounds: [...k.sounds] })), sounds: [] },
    { id: 'sec-inst', name: 'Instruments', packs: [], sounds: byCat('instruments') },
    { id: 'sec-fx', name: 'Effects', packs: [], sounds: byCat('fx') },
  ];
}

function applyNames() {
  for (const [id, name] of Object.entries(layout.names)) {
    const s = engine.sounds.get(id);
    if (s) s.name = name;
  }
}

// ---------------------------------------------------------------- walking the tree

/** Every section, pack and group, with its parent. */
function* nodes() {
  for (const s of layout.sections) {
    yield { kind: 'section', node: s, parent: null };
    for (const p of s.packs) {
      yield { kind: 'pack', node: p, parent: s };
      for (const g of p.groups) yield { kind: 'group', node: g, parent: p };
    }
  }
}

export function find(id) {
  for (const n of nodes()) if (n.node.id === id) return n;
  return null;
}

/** All sound ids inside a section / pack / group (including nested ones). */
export function idsIn(node) {
  const out = [...node.sounds];
  for (const p of node.packs || []) out.push(...idsIn(p));
  for (const g of node.groups || []) out.push(...g.sounds);
  return out;
}

/** "Section › Pack › Group" label for a node (used by the import window). */
export function pathOf(id) {
  const n = find(id);
  if (!n) return '';
  if (n.kind === 'section') return n.node.name;
  if (n.kind === 'pack') return `${n.parent.name} › ${n.node.name}`;
  const sec = layout.sections.find(s => s.packs.includes(n.parent));
  return `${sec?.name} › ${n.parent.name} › ${n.node.name}`;
}

function detach(soundId) {
  for (const { node } of nodes()) {
    const i = node.sounds.indexOf(soundId);
    if (i >= 0) { node.sounds.splice(i, 1); return; }
  }
}

function ensureSection(id, name, index) {
  let s = layout.sections.find(x => x.id === id);
  if (!s) {
    s = { id, name, packs: [], sounds: [] };
    if (index == null) layout.sections.push(s); else layout.sections.splice(index, 0, s);
  }
  return s;
}

function addToPack(pack, soundId, groupName) {
  if (!groupName) { pack.sounds.push(soundId); return; }
  let g = pack.groups.find(x => x.name === groupName);
  if (!g) { g = { id: nid('g'), name: groupName, sounds: [] }; pack.groups.push(g); }
  g.sounds.push(soundId);
}

// ---------------------------------------------------------------- keeping it in sync

/**
 * Make the layout match the sounds that exist: drop missing ones, and place any sound the
 * layout doesn't know (new built-ins from an update, restored built-ins, imports from before
 * this layout existed).
 */
export function reconcile() {
  const seen = new Set();
  for (const { node } of nodes()) {
    node.sounds = node.sounds.filter(id => engine.sounds.has(id) && !seen.has(id) && seen.add(id));
  }
  const removed = new Set(layout.removedBuiltins);
  for (const s of engine.sounds.values()) {
    if (seen.has(s.id)) continue;
    if (s.category === 'user') placeUserSound(s);
    else if (!removed.has(s.id)) placeBuiltin(s);
    seen.add(s.id);
  }
}

function placeBuiltin(s) {
  if (s.category === 'drums') {
    let pack = find('pk-' + s.kit)?.node;
    if (!pack) {
      const kit = engine.kits.find(k => k.id === s.kit);
      pack = { id: 'pk-' + s.kit, name: kit?.name || 'Drums', groups: [], sounds: [] };
      ensureSection('sec-kits', 'Drum kits').packs.push(pack);
    }
    pack.sounds.push(s.id);
  } else if (s.category === 'instruments') {
    ensureSection('sec-inst', 'Instruments').sounds.push(s.id);
  } else {
    ensureSection('sec-fx', 'Effects').sounds.push(s.id);
  }
}

function placeUserSound(s) {
  // keep sounds from the same import together
  let pack = null;
  for (const n of nodes()) if (n.kind === 'pack' && n.node.src === s.pack) { pack = n.node; break; }
  if (!pack) {
    const store = userLib.packs.find(p => p.id === s.pack);
    pack = { id: nid('pk'), name: store?.name || 'Imported', src: s.pack, groups: [], sounds: [] };
    ensureSection(MINE, 'My sounds', 0).packs.push(pack);
  }
  addToPack(pack, s.id, s.group);
}

/**
 * Put freshly imported sounds where she asked: into a section (each import becomes a pack),
 * a pack (folders become groups) or a group. No target = the "My sounds" section.
 */
export function placeImport(newPacks, targetId) {
  const t = targetId ? find(targetId) : null;
  for (const { pack, metas } of newPacks) {
    for (const m of metas) detach(m.id);
    if (t?.kind === 'group') {
      t.node.sounds.push(...metas.map(m => m.id));
    } else if (t?.kind === 'pack') {
      for (const m of metas) addToPack(t.node, m.id, m.group);
    } else {
      const section = t?.kind === 'section' ? t.node : ensureSection(MINE, 'My sounds', 0);
      const p = { id: nid('pk'), name: pack.name, src: pack.id, groups: [], sounds: [] };
      for (const m of metas) addToPack(p, m.id, m.group);
      section.packs.push(p);
    }
  }
  changed();
}

// ---------------------------------------------------------------- create / rename

export function newSection(name = 'New section') {
  const s = { id: nid('sec'), name, packs: [], sounds: [] };
  layout.sections.push(s);
  changed();
  return s.id;
}

export function newPack(sectionId, name = 'New pack') {
  const sec = find(sectionId);
  if (sec?.kind !== 'section') return null;
  const p = { id: nid('pk'), name, groups: [], sounds: [] };
  sec.node.packs.push(p);
  changed();
  return p.id;
}

export function newGroup(packId, name = 'New group') {
  const pk = find(packId);
  if (pk?.kind !== 'pack') return null;
  const g = { id: nid('g'), name, sounds: [] };
  pk.node.groups.push(g);
  changed();
  return g.id;
}

export function renameNode(id, name) {
  const n = find(id);
  if (!n || !tidy(name)) return;
  n.node.name = tidy(name);
  changed();
}

export function renameSound(id, name) {
  const s = engine.sounds.get(id);
  if (!s || !tidy(name)) return;
  s.name = tidy(name);
  layout.names[id] = s.name;
  changed();
  emit('assign'); // pads and keys show sound names
}

// ---------------------------------------------------------------- move (drag & drop)

export function moveSound(soundId, targetId) {
  const t = find(targetId);
  if (!t) return;
  detach(soundId);
  t.node.sounds.push(soundId);
  changed();
}

export function moveGroup(groupId, packId) {
  const g = find(groupId), p = find(packId);
  if (g?.kind !== 'group' || p?.kind !== 'pack' || g.parent === p.node) return;
  g.parent.groups.splice(g.parent.groups.indexOf(g.node), 1);
  p.node.groups.push(g.node);
  changed();
}

export function movePack(packId, sectionId) {
  const p = find(packId), s = find(sectionId);
  if (p?.kind !== 'pack' || s?.kind !== 'section' || p.parent === s.node) return;
  p.parent.packs.splice(p.parent.packs.indexOf(p.node), 1);
  s.node.packs.push(p.node);
  changed();
}

/** Put a section just before another one. */
export function moveSection(sectionId, beforeId) {
  const from = layout.sections.findIndex(s => s.id === sectionId);
  if (from < 0 || sectionId === beforeId) return;
  const [s] = layout.sections.splice(from, 1);
  const to = layout.sections.findIndex(x => x.id === beforeId);
  layout.sections.splice(to < 0 ? layout.sections.length : to, 0, s);
  changed();
}

// ---------------------------------------------------------------- delete

/** Take sounds out of the layout. Built-ins are remembered as removed (so they stay hidden). */
export function forgetSounds(ids) {
  for (const id of ids) {
    detach(id);
    const s = engine.sounds.get(id);
    if (s && s.category !== 'user' && !layout.removedBuiltins.includes(id)) layout.removedBuiltins.push(id);
  }
  changed();
}

/** Remove a section / pack / group and everything in it from the layout. Returns the sound ids. */
export function removeNode(id) {
  const n = find(id);
  if (!n) return [];
  const ids = idsIn(n.node);
  if (n.kind === 'section') layout.sections.splice(layout.sections.indexOf(n.node), 1);
  else if (n.kind === 'pack') n.parent.packs.splice(n.parent.packs.indexOf(n.node), 1);
  else n.parent.groups.splice(n.parent.groups.indexOf(n.node), 1);
  forgetSounds(ids);
  return ids;
}

export function restoreBuiltins() {
  const n = layout.removedBuiltins.length;
  layout.removedBuiltins = [];
  reconcile();
  changed();
  return n;
}
