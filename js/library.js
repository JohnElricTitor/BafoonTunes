// Sound library side panel: built-in kits/instruments/effects plus "My sounds" (imports).
import { state, on, emit } from './state.js';
import { engine, getSound, previewSound } from './engine.js';
import { startDrag, endDrag } from './controller.js';
import { userLib, packSounds, removePack } from './userlib.js';

let listEl, searchEl;
const collapsed = new Set(JSON.parse(localStorage.getItem('tunes.libCollapsed') || '[]'));

export function buildLibrary() {
  listEl = document.getElementById('libList');
  searchEl = document.getElementById('search');
  searchEl.addEventListener('input', render);
  on('assign', markUsed);
  on('project', markUsed);
  on('library', render);
  render();
}

// ---------------------------------------------------------------- pieces

function soundRow(s) {
  const row = document.createElement('div');
  row.className = 'snd';
  row.dataset.id = s.id;
  row.draggable = true;
  row.title = s.type === 'pitched'
    ? `${s.name} — drag onto the keys (or a pad). Click to hear it.`
    : `${s.name} — drag onto a pad or a key, or onto the KEYS strip to play it across the keyboard. Click to hear it.`;
  row.innerHTML = `<span class="dot"></span><span class="nm"></span><span class="tag"></span>`;
  row.querySelector('.dot').style.background = s.color;
  row.querySelector('.nm').textContent = s.name;
  row.querySelector('.tag').textContent = s.type === 'pitched' ? 'keys' : s.isLoop ? 'loop' : '';
  row.addEventListener('click', () => {
    previewSound(s.id);
    row.classList.add('playing');
    setTimeout(() => row.classList.remove('playing'), 300);
  });
  row.addEventListener('dragstart', e => startDrag(e, { type: 'sound', id: s.id }));
  row.addEventListener('dragend', endDrag);
  return row;
}

/** A section title ("Drum kits", "My sounds") that folds its contents. */
function section(key, title, extra) {
  const wrap = document.createElement('section');
  wrap.className = 'lib-section' + (collapsed.has(key) ? ' folded' : '');
  const head = document.createElement('button');
  head.className = 'lib-section-head';
  head.innerHTML = '<span class="chev">▸</span><span></span>';
  head.lastChild.textContent = title;
  if (extra) head.appendChild(extra);
  head.onclick = e => {
    if (e.target.closest('.lib-x')) return;
    wrap.classList.toggle('folded');
    if (wrap.classList.contains('folded')) collapsed.add(key); else collapsed.delete(key);
    try { localStorage.setItem('tunes.libCollapsed', JSON.stringify([...collapsed])); } catch { /* */ }
  };
  const body = document.createElement('div');
  body.className = 'lib-section-body';
  wrap.append(head, body);
  return { wrap, body };
}

/** A kit / folder title. Drag it onto the pads to fill them with its sounds. */
function groupTitle(name, ids, level = 1) {
  const t = document.createElement('div');
  t.className = `lib-title-row lvl${level}`;
  const fillable = ids.length > 1;
  t.draggable = fillable;
  t.innerHTML = '<span class="ttl"></span>';
  t.firstChild.textContent = name;
  if (fillable) {
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'drag to pads';
    t.appendChild(hint);
    t.title = `Drag onto the pads to load ${name} onto them`;
    t.addEventListener('dragstart', e => startDrag(e, { type: 'kit', name, ids }));
    t.addEventListener('dragend', endDrag);
  }
  return t;
}

// ---------------------------------------------------------------- render

function render() {
  const q = searchEl.value.trim().toLowerCase();
  const match = s => !q || [s.name, s.role, s.group, s.kit && engine.kits.find(k => k.id === s.kit)?.name,
    userLib.packs.find(p => p.id === s.pack)?.name].some(v => v && v.toLowerCase().includes(q));
  listEl.innerHTML = '';
  let total = 0;

  // My sounds (imported packs) first: that's what she'll reach for most.
  if (userLib.packs.length) {
    const { wrap, body } = section('mine', 'My sounds');
    for (const pack of userLib.packs) {
      const sounds = packSounds(pack.id).filter(match);
      if (!sounds.length && q) continue;
      const head = groupTitle(pack.name, sounds.map(s => s.id), 1);
      head.classList.add('pack');
      const x = document.createElement('button');
      x.className = 'lib-x';
      x.title = `Remove “${pack.name}” from BafoonsTunes`;
      x.textContent = '✕';
      x.onclick = () => confirmRemove(pack);
      head.appendChild(x);
      body.appendChild(head);
      // folders inside the pack become sub-titles
      const groups = new Map();
      for (const s of sounds) {
        if (!groups.has(s.group)) groups.set(s.group, []);
        groups.get(s.group).push(s);
      }
      for (const [g, list] of groups) {
        if (g) body.appendChild(groupTitle(g, list.map(s => s.id), 2));
        for (const s of list) body.appendChild(soundRow(s));
      }
      total += sounds.length;
    }
    listEl.appendChild(wrap);
  }

  const builtin = [...engine.sounds.values()].filter(s => s.category !== 'user');

  const kits = section('kits', 'Drum kits');
  let n = 0;
  for (const kit of engine.kits) {
    const sounds = kit.sounds.map(getSound).filter(s => s && match(s));
    if (!sounds.length) continue;
    kits.body.appendChild(groupTitle(kit.name, kit.sounds, 1));
    for (const s of sounds) kits.body.appendChild(soundRow(s));
    n += sounds.length;
  }
  if (n) listEl.appendChild(kits.wrap);
  total += n;

  for (const [cat, title] of [['instruments', 'Instruments'], ['fx', 'Effects']]) {
    const sounds = builtin.filter(s => s.category === cat && match(s));
    if (!sounds.length) continue;
    const sec = section(cat, title);
    for (const s of sounds) sec.body.appendChild(soundRow(s));
    listEl.appendChild(sec.wrap);
    total += sounds.length;
  }

  if (!total) listEl.innerHTML = '<div class="lib-empty">No sounds match that search.</div>';
  markUsed();
}

function markUsed() {
  const used = new Set([state.keyboardSound, ...state.pads, ...Object.values(state.keyOverrides)]);
  listEl.querySelectorAll('.snd').forEach(r => r.classList.toggle('used', used.has(r.dataset.id)));
}

async function confirmRemove(pack) {
  const ids = new Set(packSounds(pack.id).map(s => s.id));
  const inTracks = state.tracks.some(t => t.events.some(e => ids.has(e.s)));
  const msg = `Remove “${pack.name}” (${pack.count} sounds) from BafoonsTunes?\n\n`
    + 'Pads and keys using these sounds will be cleared.'
    + (inTracks ? ' Tracks that use them will go silent.' : '')
    + '\n\nThe original files on your computer are not touched.';
  if (!confirm(msg)) return;
  await removePack(pack.id);
  state.pads = state.pads.map(id => (ids.has(id) ? null : id));
  for (const [k, id] of Object.entries(state.keyOverrides)) if (ids.has(id)) delete state.keyOverrides[k];
  if (ids.has(state.keyboardSound)) state.keyboardSound = engine.sounds.has('piano-salamander') ? 'piano-salamander' : null;
  emit('assign'); emit('change');
  emit('toast', `Removed “${pack.name}”.`);
}
