// Sound library side panel.
//
//   Section            right-click: New pack · Import into here · Rename · Delete
//     Pack             right-click: New group · Import into here · Rename · Delete
//       Group          right-click: Import into here · Rename · Delete
//         sound        right-click: Play · Rename · Delete
//
// Click a title to fold it. Drag a sound onto a section / pack / group title to move it there,
// a group onto a pack, a pack onto a section, a section onto another section to reorder.
// Pack and group titles can also be dragged onto the pads to load their sounds.
// The organisation itself lives in layout.js; the audio in engine.js / userlib.js.
import { state, on, emit, drag } from './state.js';
import { engine, previewSound } from './engine.js';
import { startDrag, endDrag } from './controller.js';
import { deleteSounds } from './userlib.js';
import * as L from './layout.js';
import { showMenu, closeMenu } from './menu.js';
import { EFFECTS } from './effects.js';

let listEl, searchEl;
const COLLAPSE_KEY = 'tunes.libCollapsed';
const collapsed = new Set(loadCollapsed());
const KIND_LABEL = { section: 'section', pack: 'pack', group: 'group' };

function loadCollapsed() {
  try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]'); } catch { return []; }
}
function saveCollapsed() {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed])); } catch { /* */ }
}

export function buildLibrary() {
  listEl = document.getElementById('libList');
  searchEl = document.getElementById('search');
  searchEl.addEventListener('input', render);
  on('assign', markUsed);
  on('project', markUsed);
  on('library', render);
  on('revealSound', id => {
    // unfold where it lives, scroll to it and flash it
    for (const n of L.ancestorsOf(id)) collapsed.delete('n:' + n);
    saveCollapsed();
    searchEl.value = '';
    render();
    const row = listEl.querySelector(`.snd[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'center' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1600);
  });
  document.getElementById('btnNewSection').onclick = () => createAndRename(L.newSection());
  // clear the drop highlight when a drag leaves the list or ends anywhere
  listEl.addEventListener('dragleave', e => { if (!listEl.contains(e.relatedTarget)) highlight(null); });
  document.addEventListener('dragend', () => highlight(null));
  document.addEventListener('drop', () => highlight(null));
  render();
}

// ---------------------------------------------------------------- render

function render() {
  closeMenu();
  const q = searchEl.value.trim().toLowerCase();
  const searching = !!q;
  const soundMatches = id => {
    const s = engine.sounds.get(id);
    return !!s && (!q || [s.name, s.role].some(v => v && v.toLowerCase().includes(q)));
  };
  const nameMatches = node => !!q && node.name.toLowerCase().includes(q);
  listEl.innerHTML = '';
  let shown = 0;

  for (const sec of L.layout.sections) {
    const secHit = nameMatches(sec);
    const secEl = container('section', sec, 0, searching);
    let any = false;

    for (const pack of sec.packs) {
      const packHit = secHit || nameMatches(pack);
      const packEl = container('pack', pack, 1, searching);
      let packAny = false;
      for (const g of pack.groups) {
        const hit = packHit || nameMatches(g);
        const ids = g.sounds.filter(id => hit || soundMatches(id));
        if (searching && !ids.length && !hit) continue;
        const gEl = container('group', g, 2, searching);
        for (const id of ids) gEl.body.appendChild(soundRow(id));
        if (!g.sounds.length && !searching) gEl.body.appendChild(emptyRow('Empty. Drag sounds here or right-click to import.'));
        packEl.body.appendChild(gEl.wrap);
        shown += ids.length;
        packAny = true;
      }
      const loose = pack.sounds.filter(id => packHit || soundMatches(id));
      for (const id of loose) packEl.body.appendChild(soundRow(id));
      shown += loose.length;
      if (!pack.groups.length && !pack.sounds.length && !searching) packEl.body.appendChild(emptyRow('Empty. Right-click to add a group or import sounds.'));
      if (searching && !packAny && !loose.length && !packHit) continue;
      secEl.body.appendChild(packEl.wrap);
      any = true;
    }
    const loose = sec.sounds.filter(id => secHit || soundMatches(id));
    for (const id of loose) secEl.body.appendChild(soundRow(id));
    shown += loose.length;
    if (!sec.packs.length && !sec.sounds.length && !searching) secEl.body.appendChild(emptyRow('Empty. Right-click to add a pack or import sounds.'));
    if (searching && !any && !loose.length && !secHit) continue;
    listEl.appendChild(secEl.wrap);
  }

  if (searching && !shown) listEl.innerHTML = '<div class="lib-empty">No sounds match that search.</div>';
  if (!L.layout.sections.length) listEl.innerHTML = '<div class="lib-empty">No sections yet. Click “+ New section” below.</div>';
  listEl.appendChild(audioEffects(q));
  markUsed();
}

/** "Audio effects": drag one onto a layer to change how it sounds. */
function audioEffects(q) {
  const key = 'audio-effects';
  const wrap = document.createElement('div');
  wrap.className = 'lib-group lvl0 lib-fx' + (!q && collapsed.has(key) ? ' folded' : '');
  const t = document.createElement('div');
  t.className = 'lib-title-row lvl0';
  t.innerHTML = '<span class="chev">▸</span><span class="ttl">Audio effects</span>';
  t.title = 'Drag an effect onto a layer to change how it sounds';
  t.onclick = () => {
    wrap.classList.toggle('folded');
    if (wrap.classList.contains('folded')) collapsed.add(key); else collapsed.delete(key);
    saveCollapsed();
  };
  const body = document.createElement('div');
  body.className = 'lib-group-body';
  for (const fx of EFFECTS) {
    if (q && !fx.name.toLowerCase().includes(q) && !fx.hint.toLowerCase().includes(q)) continue;
    const row = document.createElement('div');
    row.className = 'snd fx-item';
    row.draggable = true;
    row.title = `${fx.name}: ${fx.hint}. Drag onto a layer.`;
    row.innerHTML = '<span class="dot fx"></span><span class="nm"></span><span class="tag">drag to layer</span>';
    row.querySelector('.dot').style.background = fx.color;
    row.querySelector('.nm').textContent = fx.name;
    row.addEventListener('dragstart', e => startDrag(e, { type: 'effect', fx: fx.type, name: fx.name }));
    row.addEventListener('dragend', endDrag);
    body.appendChild(row);
  }
  if (q && !body.children.length) wrap.style.display = 'none';
  wrap.append(t, body);
  return wrap;
}

function emptyRow(text) {
  const d = document.createElement('div');
  d.className = 'lib-empty-row';
  d.textContent = text;
  return d;
}

/** A foldable section / pack / group with its title row. */
function container(kind, node, level, forceOpen) {
  const key = 'n:' + node.id;
  const wrap = document.createElement('div');
  wrap.className = `lib-group lvl${level}` + (!forceOpen && collapsed.has(key) ? ' folded' : '');
  const t = document.createElement('div');
  t.className = `lib-title-row lvl${level}`;
  t.dataset.node = node.id;
  t.dataset.kind = kind;
  t.innerHTML = '<span class="chev">▸</span><span class="ttl"></span><span class="count"></span>';
  t.querySelector('.ttl').textContent = node.name;
  const ids = L.idsIn(node);
  t.querySelector('.count').textContent = ids.length;
  t.title = `${node.name} — click to fold · right-click for options · drag to move`
    + (kind !== 'section' && ids.length > 1 ? ' · drag onto the pads to load these sounds' : '');

  t.addEventListener('click', e => {
    if (e.target.closest('input')) return;
    wrap.classList.toggle('folded');
    if (wrap.classList.contains('folded')) collapsed.add(key); else collapsed.delete(key);
    saveCollapsed();
  });
  t.addEventListener('contextmenu', e => { e.preventDefault(); showMenu(e.clientX, e.clientY, menuFor(kind, node, t)); });

  // dragging this title: move it in the panel, or (packs/groups) drop it on the pads
  t.draggable = true;
  t.addEventListener('dragstart', e => {
    if (kind === 'section') startDrag(e, { type: 'section', id: node.id, name: node.name });
    else startDrag(e, { type: 'kit', name: node.name, ids: L.idsIn(node), node: { kind, id: node.id } });
  });
  t.addEventListener('dragend', endDrag);

  // Dropping things anywhere on this section / pack / group (its title or its sounds).
  // The innermost place that accepts the item wins; otherwise it falls through to the parent,
  // e.g. a group dragged over another group's sounds lands in that group's pack.
  wrap.addEventListener('dragover', e => {
    if (!canDrop(drag.current, kind, node.id)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    highlight(t);
  });
  wrap.addEventListener('drop', e => {
    const d = drag.current;
    if (!canDrop(d, kind, node.id)) return;
    e.preventDefault();
    e.stopPropagation();
    highlight(null);
    if (d.type === 'sound') L.moveSound(d.id, node.id);
    else if (d.type === 'section') L.moveSection(d.id, node.id);
    else if (d.node?.kind === 'group') L.moveGroup(d.node.id, node.id);
    else if (d.node?.kind === 'pack') L.movePack(d.node.id, node.id);
    // open the place it landed so the moved item is visible
    collapsed.delete('n:' + node.id);
    saveCollapsed();
    render();
  });

  const body = document.createElement('div');
  body.className = 'lib-group-body';
  wrap.append(t, body);
  return { wrap, body, title: t };
}

// Light up the title of the place a dragged item would land (one at a time).
let lit = null;
function highlight(el) {
  if (lit === el) return;
  lit?.classList.remove('lib-drop');
  lit = el;
  el?.classList.add('lib-drop');
}

/** What may be dropped where: sounds anywhere, groups on packs, packs on sections, sections on sections. */
function canDrop(d, kind, id) {
  if (!d) return false;
  if (d.type === 'sound') return true;
  if (d.type === 'section') return kind === 'section' && d.id !== id;
  if (d.type === 'kit' && d.node && d.node.id !== id) {
    if (d.node.kind === 'group') return kind === 'pack';
    if (d.node.kind === 'pack') return kind === 'section';
  }
  return false;
}

function soundRow(id) {
  const s = engine.sounds.get(id);
  const row = document.createElement('div');
  row.className = 'snd';
  row.dataset.id = s.id;
  row.draggable = true;
  row.title = s.type === 'pitched'
    ? `${s.name} — drag onto the keys (or a pad). Click to hear it. Right-click for options.`
    : `${s.name} — drag onto a pad, a key or the KEYS strip, or onto a title here to move it. Click to hear it. Right-click for options.`;
  row.innerHTML = `<span class="dot"></span><span class="nm"></span><span class="tag"></span>`;
  row.querySelector('.dot').style.background = s.color;
  row.querySelector('.nm').textContent = s.name;
  row.querySelector('.tag').textContent = s.type === 'pitched' ? 'keys' : s.isLoop ? 'loop' : '';
  row.addEventListener('click', e => {
    if (e.target.closest('input')) return;
    previewSound(s.id);
    row.classList.add('playing');
    setTimeout(() => row.classList.remove('playing'), 300);
  });
  row.addEventListener('dragstart', e => startDrag(e, { type: 'sound', id: s.id }));
  row.addEventListener('dragend', endDrag);
  row.addEventListener('contextmenu', e => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      { label: 'Play', run: () => previewSound(s.id) },
      { label: 'Rename', run: () => inlineRename(row.querySelector('.nm'), s.name, name => L.renameSound(s.id, name)) },
      '-',
      { label: 'Delete', danger: true, run: () => deleteSoundFlow(s) },
    ]);
  });
  return row;
}

function markUsed() {
  const used = new Set([state.keyboardSound, ...state.pads, ...Object.values(state.keyOverrides)]);
  listEl.querySelectorAll('.snd').forEach(r => r.classList.toggle('used', used.has(r.dataset.id)));
}

// ---------------------------------------------------------------- menus

function menuFor(kind, node, title) {
  const rename = { label: `Rename ${KIND_LABEL[kind]}`, run: () => inlineRename(title.querySelector('.ttl'), node.name, name => L.renameNode(node.id, name)) };
  const importHere = { label: 'Import into here…', run: () => emit('importInto', { id: node.id, label: L.pathOf(node.id) }) };
  const del = { label: `Delete ${KIND_LABEL[kind]}`, danger: true, run: () => deleteNodeFlow(kind, node) };
  if (kind === 'section') return [{ label: 'New pack', run: () => createAndRename(L.newPack(node.id), node.id) }, importHere, rename, '-', del];
  if (kind === 'pack') return [{ label: 'New group', run: () => createAndRename(L.newGroup(node.id), node.id) }, importHere, rename, '-', del];
  return [importHere, rename, '-', del];
}

/** After creating a section / pack / group, make sure it's visible and start naming it. */
function createAndRename(id, parentId) {
  if (!id) return;
  if (parentId) { collapsed.delete('n:' + parentId); saveCollapsed(); }
  searchEl.value = '';
  render();
  const t = listEl.querySelector(`.lib-title-row[data-node="${id}"]`);
  if (!t) return;
  t.scrollIntoView({ block: 'nearest' });
  inlineRename(t.querySelector('.ttl'), t.querySelector('.ttl').textContent, name => L.renameNode(id, name));
}

// ---------------------------------------------------------------- rename in place

/** Swap a name for a text box. Enter or clicking away saves, Escape cancels. */
function inlineRename(span, current, save) {
  const row = span.closest('[draggable]');
  const wasDraggable = row?.draggable;
  if (row) row.draggable = false;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'lib-rename';
  input.value = current;
  input.maxLength = 80;
  span.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = commit => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    input.replaceWith(span);
    if (row) row.draggable = wasDraggable;
    if (commit && value && value !== current) {
      span.textContent = value;
      try { save(value); } catch (e) { console.error(e); emit('toast', 'Could not rename that.'); render(); }
    }
  };
  input.addEventListener('keydown', e => {
    e.stopPropagation(); // don't trigger note keys / shortcuts while typing
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', e => e.stopPropagation());
}

// ---------------------------------------------------------------- deleting

/** Clear pads / keys that use sounds which are going away. */
function forgetOnDevice(ids) {
  state.pads = state.pads.map(id => (ids.has(id) ? null : id));
  for (const [k, id] of Object.entries(state.keyOverrides)) if (ids.has(id)) delete state.keyOverrides[k];
  if (ids.has(state.keyboardSound)) {
    state.keyboardSound = engine.sounds.has('piano-salamander') && !ids.has('piano-salamander') ? 'piano-salamander' : null;
  }
  emit('assign'); emit('change');
}

const usedInTracks = ids => state.tracks.some(t => t.events.some(e => ids.has(e.s)));

function deleteMessage(what, idList) {
  const ids = new Set(idList);
  const mine = idList.filter(id => engine.sounds.get(id)?.category === 'user').length;
  const builtin = idList.length - mine;
  return `Delete ${what}?\n\n`
    + (idList.length ? 'Pads and keys using these sounds will be cleared.' : 'It is empty.')
    + (usedInTracks(ids) ? ' Tracks that use them will go silent for those notes.' : '')
    + (mine ? "\n\nYour imported sounds' copies are deleted from BafoonsTunes. Your original files are not touched." : '')
    + (builtin ? '\n\nBuilt-in sounds are only hidden. Bring them back with "Restore built-in sounds" in the ? menu.' : '');
}

async function finishDelete(idList, label) {
  const ids = new Set(idList);
  forgetOnDevice(ids);
  const mine = idList.filter(id => engine.sounds.get(id)?.category === 'user');
  if (mine.length) {
    try { await deleteSounds(mine); } catch (e) { console.error(e); emit('toast', 'Some files could not be deleted.'); }
  }
  emit('toast', `Deleted ${label}.`);
}

async function deleteSoundFlow(s) {
  if (!confirm(deleteMessage(`“${s.name}”`, [s.id]))) return;
  L.forgetSounds([s.id]);
  await finishDelete([s.id], `“${s.name}”`);
}

async function deleteNodeFlow(kind, node) {
  const ids = L.idsIn(node);
  const what = `the ${KIND_LABEL[kind]} “${node.name}”` + (ids.length ? ` and its ${ids.length} sound${ids.length === 1 ? '' : 's'}` : '');
  if (!confirm(deleteMessage(what, ids))) return;
  L.removeNode(node.id);
  await finishDelete(ids, `the ${KIND_LABEL[kind]} “${node.name}”`);
}
