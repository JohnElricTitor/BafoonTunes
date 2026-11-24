// On-screen replica of the MPK mini mk2. Mirrors the hardware in real time and
// accepts sounds dropped from the library.
import { state, emit, on, drag, KNOBS, noteName, clamp } from './state.js';
import { engine, getSound, isPitched, loadSound } from './engine.js';
import { noteOn, noteOff, setBend, keySoundId } from './instrument.js';
import { showMenu } from './menu.js';
import { startLearn, cancelLearn, startKeySync, midi } from './midi.js';

// Geometry taken from a product photo of the device (pixels); converted to %.
const X0 = 10, Y0 = 290, W = 1580, H = 880;
const PAD_POS = [[280, 510], [455, 510], [630, 510], [805, 510], [280, 335], [455, 335], [630, 335], [805, 335]];
const PAD_SIZE = 140;
const KNOB_POS = [[1035, 370], [1188, 370], [1340, 370], [1493, 370], [1035, 520], [1188, 520], [1340, 520], [1493, 520]];
const WHITE = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23, 24];
const BLACK = [[1, 0], [3, 1], [6, 3], [8, 4], [10, 5], [13, 7], [15, 8], [18, 10], [20, 11], [22, 12]];
const KIT_ORDER = ['kick', 'snare', 'hat-closed', 'hat-open', 'clap', 'tom', 'perc', 'cymbal'];

const ui = { pads: [], keys: new Array(25), knobs: [], keysEl: null, strip: null, bankBtn: null, joyBall: null };
const baseNote = () => 48 + state.octave * 12;

function el(tag, cls, parent, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
}
function place(e, x1, y1, x2, y2) {
  e.classList.add('abs');
  e.style.left = ((x1 - X0) / W * 100) + '%';
  e.style.top = ((y1 - Y0) / H * 100) + '%';
  e.style.width = ((x2 - x1) / W * 100) + '%';
  e.style.height = ((y2 - y1) / H * 100) + '%';
  return e;
}
function label(root, text, x, y, cls = '') {
  const l = el('div', 'lbl ' + cls, root, text);
  l.style.left = ((x - X0) / W * 100) + '%';
  l.style.top = ((y - Y0) / H * 100) + '%';
  return l;
}

export function buildController(root) {
  ui.root = root;
  root.innerHTML = '';
  root.oncontextmenu = e => e.preventDefault();

  // shared SVG gradient for knob caps
  root.insertAdjacentHTML('beforeend', `<svg width="0" height="0" style="position:absolute"><defs>
    <radialGradient id="knobGrad" cx="40%" cy="30%" r="80%"><stop offset="0" stop-color="#4a4a4e"/><stop offset=".6" stop-color="#1c1c1e"/><stop offset="1" stop-color="#0b0b0c"/></radialGradient>
  </defs></svg>`);

  buildLeft(root);
  buildPads(root);
  buildKnobs(root);
  buildPadControls(root);
  buildStrip(root);
  buildKeys(root);

  renderPads(); renderKeys(); renderKnobs(); renderStrip();

  on('hit', onHit);
  on('knob', i => { renderKnob(i); flashKnob(i); });
  on('project', () => { renderPads(); renderKeys(); renderKnobs(); renderStrip(); });
  on('assign', () => { renderPads(); renderKeys(); renderStrip(); });
  on('learn', k => ui.knobs.forEach((n, i) => n.el.classList.toggle('learning', i === k)));
  on('bend', b => moveJoy(b, null));
  on('modWheel', m => moveJoy(null, m));
  on('teach', showTeach);
  on('midiReset', () => setOctave(0));
  // The far-left key of the MPK sends 48 at normal octave, 60 one octave up, and so on.
  on('lowestKey', n => {
    setOctave(Math.round((n - 48) / 12));
    emit('toast', `Keys lined up${state.octave ? ` — your MPK is ${state.octave > 0 ? 'up' : 'down'} ${Math.abs(state.octave)} octave${Math.abs(state.octave) > 1 ? 's' : ''}` : ''}.`);
  });
  document.addEventListener('pointerup', releaseMouseNote);
}

// ---------------------------------------------------------------- left side

const joy = { x: 0, y: 0 };
function moveJoy(x, y) {
  if (x !== null) joy.x = x;
  if (y !== null) joy.y = y;
  ui.joyBall.style.transform = `translate(${joy.x * 42}%, ${-joy.y * 42}%)`;
}

function buildLeft(root) {
  const well = place(el('div', 'joy-well', root), 92, 312, 238, 458);
  ui.joyBall = el('div', 'joy-ball', well);
  well.title = 'Joystick: left/right bends pitch, up adds vibrato';
  well.addEventListener('pointerdown', e => {
    well.setPointerCapture(e.pointerId);
    well.classList.add('dragging');
    const r = well.getBoundingClientRect();
    const move = ev => {
      const x = clamp(((ev.clientX - r.left) / r.width - 0.5) * 2.4, -1, 1);
      const y = clamp(-((ev.clientY - r.top) / r.height - 0.5) * 2.4, 0, 1);
      setBend(x);
      emit('uiMod', y);
      moveJoy(x, y);
    };
    move(e);
    well.onpointermove = move;
    well.onpointerup = well.onpointercancel = () => {
      well.onpointermove = null;
      well.classList.remove('dragging');
      setBend(0);
      emit('uiMod', 0);
      moveJoy(0, 0);
    };
  });

  const arp = place(el('div', 'boxline', root), 45, 458, 242, 527);
  const t = el('span', '', arp, 'ARPEGGIATOR'); t.style.top = '-0.55cqw';
  const deco = 'This works on the device itself — whatever it plays shows up here.';
  const on1 = place(el('div', 'mbtn red-edge deco', root, 'ON/OFF'), 60, 477, 130, 514); on1.title = 'Arpeggiator: ' + deco;
  const tap = place(el('div', 'mbtn', root, 'TAP<br>TEMPO'), 160, 477, 230, 514);
  tap.title = 'Tap a few times to set the tempo';
  tap.addEventListener('pointerdown', () => { tap.classList.add('lit'); emit('tap'); setTimeout(() => tap.classList.remove('lit'), 90); });

  // Like the hardware: the button lights up while the keyboard is shifted that way.
  const od = place(el('div', 'mbtn', root, 'OCTAVE ▼'), 58, 541, 130, 583);
  const ou = place(el('div', 'mbtn', root, 'OCTAVE ▲'), 160, 541, 232, 583);
  od.title = ou.title = 'Lights up like on your MPK when the keys are shifted. Click to shift the on-screen keys (Z / X).';
  od.addEventListener('pointerdown', () => shiftOctave(-1));
  ou.addEventListener('pointerdown', () => shiftOctave(1));
  ui.octDown = od; ui.octUp = ou;

  const fl = place(el('div', 'mbtn red-edge', root, 'FULL<br>LEVEL'), 58, 607, 130, 650);
  fl.title = 'Full Level: mouse/computer-keyboard notes play at full volume';
  fl.addEventListener('pointerdown', () => { state.fullLevel = !state.fullLevel; fl.classList.toggle('lit', state.fullLevel); });
  const nr = place(el('div', 'mbtn white deco', root, 'NOTE<br>REPEAT'), 158, 607, 232, 650);
  nr.title = 'Note Repeat: ' + deco;

  const logo = place(el('div', 'logo', root), 55, 664, 400, 716);
  logo.innerHTML = '<div class="l1">MPK<i>mini</i></div><div class="l2">mk2 · BAFOONSTUNES</div>';
}

// The MPK keeps its octave while it stays plugged in, so remember ours between sessions.
const OCT_KEY = 'tunes.octave';
try { state.octave = Math.max(-4, Math.min(4, parseInt(localStorage.getItem(OCT_KEY), 10) || 0)); } catch { /* */ }

function setOctave(o) {
  o = Math.max(-4, Math.min(4, o));
  if (o !== state.octave) {
    state.octave = o;
    clearKeyDown();
    renderKeys(); renderStrip();
  }
  try { localStorage.setItem(OCT_KEY, String(o)); } catch { /* */ }
}

export function shiftOctave(d) {
  const o = Math.max(-4, Math.min(4, state.octave + d));
  if (o === state.octave) return;
  setOctave(o);
}

function renderOctaveButtons() {
  if (!ui.octDown) return;
  ui.octDown.classList.toggle('lit', state.octave < 0);
  ui.octUp.classList.toggle('lit', state.octave > 0);
  // brighter glow for each extra octave
  const n = Math.abs(state.octave);
  const btn = state.octave < 0 ? ui.octDown : ui.octUp;
  for (const b of [ui.octDown, ui.octUp]) b.style.removeProperty('--oct-glow');
  if (n) btn.style.setProperty('--oct-glow', String(0.6 + n * 0.4));
}

// ---------------------------------------------------------------- pads

function buildPads(root) {
  PAD_POS.forEach(([x, y], i) => {
    label(root, `PAD ${i + 1}`, x + 2, y - 18);
    if (i >= 4) label(root, `PROG ${i - 3}`, x + 95, y - 18, 'red');
    const pad = place(el('div', 'pad', root), x, y, x + PAD_SIZE, y + PAD_SIZE);
    const name = el('div', 'snd-name', pad);
    el('div', 'snd-bar', pad);
    const idx = () => state.bank * 8 + i;

    pad.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      pad.setPointerCapture(e.pointerId);
      const r = pad.getBoundingClientRect();
      // a little velocity from where you click: higher = harder
      const vel = clamp(1.1 - (e.clientY - r.top) / r.height * 0.6, 0.45, 1);
      const n = idx();
      noteOn('p', n, vel, 'ui');
      pad.onpointerup = pad.onpointercancel = () => { pad.onpointerup = null; noteOff('p', n, 'ui'); };
    });
    pad.addEventListener('contextmenu', e => {
      e.preventDefault();
      const n = idx();
      const s = getSound(state.pads[n]);
      if (!s) return;
      // The tick shows what the pad does: every pad plays while held unless set to play fully.
      const holds = state.padModes[n] !== 'full';
      const setMode = m => { state.padModes[n] = m; renderPads(); emit('change'); };
      showMenu(e.clientX, e.clientY, [
        { label: 'Play while held', checked: holds, run: () => setMode('hold') },
        { label: 'Play full sound', checked: !holds, run: () => setMode('full') },
        '-',
        { label: 'Clear pad', danger: true, run: () => { state.pads[n] = null; state.padModes[n] = null; emit('assign'); emit('change'); } },
      ]);
    });

    // drag a pad's sound to another pad
    pad.draggable = true;
    pad.addEventListener('dragstart', e => {
      const id = state.pads[idx()];
      if (!id) { e.preventDefault(); return; }
      startDrag(e, { type: 'sound', id });
    });
    pad.addEventListener('dragend', endDrag);
    pad.addEventListener('dragover', e => {
      const d = drag.current;
      if (!d || (d.type !== 'sound' && d.type !== 'kit')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      pad.classList.add('drop-hover');
    });
    pad.addEventListener('dragleave', () => pad.classList.remove('drop-hover'));
    pad.addEventListener('drop', e => {
      e.preventDefault();
      pad.classList.remove('drop-hover');
      const d = drag.current;
      if (d?.type === 'sound') assignPad(idx(), d.id);
      else if (d?.type === 'kit') assignKit(d.ids, d.name);
    });
    ui.pads.push({ el: pad, name });
  });
}

export function assignPad(i, id) {
  state.pads[i] = id;
  state.padModes[i] = null; // a new sound starts as "Play while held"
  loadSound(id);
  emit('assign'); emit('change');
}

/**
 * Fill the 8 pads of a bank from a group of sounds (a built-in kit, or a pack / folder of
 * your own). Kick, snare, hats… go to their usual pads; anything else fills the rest.
 */
export function assignKit(ids, name, bank = state.bank, silent = false) {
  const sounds = (ids || []).map(getSound).filter(Boolean);
  if (!sounds.length) return;
  const used = new Set();
  const slots = KIT_ORDER.map(role => {
    const s = sounds.find(x => x.role === role && !used.has(x.id));
    if (s) used.add(s.id);
    return s?.id || null;
  });
  for (let i = 0; i < 8; i++) {
    if (!slots[i]) {
      const s = sounds.find(x => !used.has(x.id));
      if (s) { used.add(s.id); slots[i] = s.id; }
    }
  }
  slots.forEach((id, i) => {
    state.pads[bank * 8 + i] = id;
    state.padModes[bank * 8 + i] = null;
    if (id) loadSound(id);
  });
  if (silent) return;
  emit('assign'); emit('change');
  emit('toast', `${name} loaded onto pad bank ${bank ? 'B' : 'A'}${sounds.length > 8 ? ' (first 8 sounds)' : ''}.`);
}

function renderPads() {
  ui.pads.forEach((p, i) => {
    const n = state.bank * 8 + i;
    const s = getSound(state.pads[n]);
    p.name.textContent = s ? s.name : 'Drop a sound';
    p.el.classList.toggle('empty', !s);
    p.el.style.setProperty('--snd', s ? s.color : 'transparent');
    // orange outline = "Play full sound"; otherwise the bank colour (red A / green B)
    const full = !!s && state.padModes[n] === 'full';
    p.el.classList.toggle('full', full);
    p.el.title = s
      ? `${s.name} — ${full ? 'plays the full sound' : 'plays while you hold the pad'}. Right-click to change or clear.`
      : 'Drag a sound here';
    p.el.classList.remove('lit');
  });
  ui.root?.classList.toggle('bank-b', state.bank === 1);
  if (ui.bankBtn) {
    // Like the MK2: red = bank A, green = bank B.
    ui.bankBtn.classList.toggle('lit', state.bank === 0);
    ui.bankBtn.classList.toggle('lit-green', state.bank === 1);
    ui.bankBtn.title = `Pad bank ${state.bank ? 'B (green)' : 'A (red)'} — click to switch`;
  }
}

// ---------------------------------------------------------------- knobs

function knobSvg() {
  let ticks = '';
  for (let i = 0; i <= 10; i++) {
    const a = (-135 + i * 27) * Math.PI / 180;
    const r = i === 0 || i === 10 ? 2.6 : 1.6;
    ticks += `<circle class="tick" cx="${50 + Math.sin(a) * 47}" cy="${50 - Math.cos(a) * 47}" r="${r}"/>`;
  }
  return `<svg viewBox="0 0 100 100">${ticks}
    <circle class="arc-bg" cx="50" cy="50" r="38" stroke-dasharray="179.07 999" transform="rotate(135 50 50)"/>
    <circle class="arc" cx="50" cy="50" r="38" stroke-dasharray="0 999" transform="rotate(135 50 50)"/>
    <circle class="cap" cx="50" cy="50" r="29"/>
    <line class="ptr" x1="50" y1="50" x2="50" y2="25"/></svg>`;
}

function buildKnobs(root) {
  KNOB_POS.forEach(([cx, cy], i) => {
    const k = place(el('div', 'knob', root, knobSvg()), cx - 52, cy - 52, cx + 52, cy + 52);
    const val = el('div', 'knob-val', k);
    const lbl = place(el('div', 'knob-lbl', root, `<b>K${i + 1}</b><em>${KNOBS[i].label.toUpperCase()}</em>`), cx - 70, cy + 50, cx + 70, cy + 84);
    lbl.style.pointerEvents = 'none';
    k.title = `${KNOBS[i].label} — drag up/down, double-click to reset, right-click to link to a hardware knob`;

    k.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      k.setPointerCapture(e.pointerId);
      const startY = e.clientY, startV = state.knobs[i];
      k.onpointermove = ev => emit('setKnob', { i, v: clamp(startV + (startY - ev.clientY) / 160) });
      k.onpointerup = k.onpointercancel = () => { k.onpointermove = null; };
    });
    k.addEventListener('dblclick', () => emit('setKnob', { i, v: KNOBS[i].def }));
    k.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (midi.learnKnob === i) { cancelLearn(); return; }
      startLearn(i);
      emit('toast', `Now turn the knob on your MPK you want for K${i + 1} (${KNOBS[i].label}).`);
    });
    ui.knobs.push({ el: k, arc: k.querySelector('.arc'), ptr: k.querySelector('.ptr'), val, timer: 0 });
  });
}

function renderKnob(i) {
  const v = state.knobs[i];
  const n = ui.knobs[i];
  n.arc.setAttribute('stroke-dasharray', `${(v * 179.07).toFixed(2)} 999`);
  n.ptr.setAttribute('transform', `rotate(${-135 + v * 270} 50 50)`);
  n.val.textContent = Math.round(v * 100);
}
function renderKnobs() { for (let i = 0; i < 8; i++) renderKnob(i); }
function flashKnob(i) {
  const n = ui.knobs[i];
  n.el.classList.add('show-val');
  clearTimeout(n.timer);
  n.timer = setTimeout(() => n.el.classList.remove('show-val'), 700);
}

// ---------------------------------------------------------------- pad controls

function buildPadControls(root) {
  const box = place(el('div', 'boxline', root), 988, 598, 1312, 670);
  const t = el('span', '', box, 'PAD CONTROLS'); t.style.bottom = '-0.6cqw';
  ui.bankBtn = place(el('div', 'mbtn', root, 'BANK<br>A/B'), 1000, 607, 1075, 652);
  ui.bankBtn.addEventListener('pointerdown', () => { state.bank = 1 - state.bank; renderPads(); });
  const cc = place(el('div', 'mbtn deco', root, 'CC'), 1115, 607, 1190, 652);
  cc.title = 'Leave this off so the pads play notes.';
  const pc = place(el('div', 'mbtn red-edge deco', root, 'PROG<br>CHANGE'), 1228, 607, 1303, 652);
  pc.title = 'Leave this off so the pads play notes.';
  const ps = place(el('div', 'mbtn white deco', root, 'PROG<br>SELECT'), 1380, 607, 1455, 652);
  ps.title = 'BafoonsTunes expects the MPK on PROG 1 (factory default).';
}

// ---------------------------------------------------------------- keyboard strip

function buildStrip(root) {
  const strip = place(el('div', 'strip', root), 420, 680, 1540, 735);
  strip.innerHTML = `<span class="strip-tag">KEYS</span>
    <span class="strip-snd"><i></i><span class="strip-name"></span></span>
    <span class="strip-help">drop any sound here to play it across the keys</span>
    <span class="strip-oct">OCTAVE <b></b></span>
    <button class="strip-sync" title="If the keys on screen don't match your MPK, click this and press the far-left key">Match keys</button>`;
  ui.strip = strip;
  strip.querySelector('.strip-sync').addEventListener('click', () => startKeySync());
  // Any sound can go here: instruments as they are, one-shot samples get pitched across the keys.
  strip.addEventListener('dragover', e => {
    if (!dragSound()) return;
    e.preventDefault();
    strip.classList.add('drop-hover');
  });
  strip.addEventListener('dragleave', () => strip.classList.remove('drop-hover'));
  strip.addEventListener('drop', e => {
    e.preventDefault();
    strip.classList.remove('drop-hover');
    const s = dragSound();
    if (s) assignKeyboard(s.id);
  });
}

function renderStrip() {
  renderOctaveButtons();
  const s = getSound(state.keyboardSound);
  ui.strip.querySelector('.strip-name').textContent = s ? s.name : 'No instrument';
  ui.strip.style.setProperty('--snd', s ? s.color : '#555');
  ui.strip.querySelector('.strip-oct b').textContent = (state.octave > 0 ? '+' : '') + state.octave;
}

export function assignKeyboard(id) {
  state.keyboardSound = id;
  loadSound(id);
  emit('assign'); emit('change');
}

// ---------------------------------------------------------------- keys

let mouseNote = null;

function buildKeys(root) {
  const keys = place(el('div', 'keys', root), 60, 744, 1540, 1158);
  ui.keysEl = keys;
  WHITE.forEach(semi => {
    const k = el('div', 'wkey', keys);
    el('div', 'key-tag hidden', k);
    el('div', 'key-note', k);
    ui.keys[semi] = k;
  });
  const whiteW = 100 / 15;
  BLACK.forEach(([semi, wi]) => {
    const k = el('div', 'bkey', keys);
    k.style.left = `calc(${(wi + 1) * whiteW}% - ${whiteW * 0.29}%)`;
    k.style.width = `${whiteW * 0.58}%`;
    el('div', 'key-tag hidden', k);
    ui.keys[semi] = k;
  });

  ui.keys.forEach((k, semi) => {
    const midiOf = () => baseNote() + semi;
    k.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const r = k.getBoundingClientRect();
      const vel = clamp(0.5 + (e.clientY - r.top) / r.height * 0.5, 0.5, 1);
      startMouseNote(midiOf(), vel);
    });
    k.addEventListener('pointerenter', e => {
      if (mouseNote !== null && e.buttons === 1) startMouseNote(midiOf(), 0.8);
    });
    k.addEventListener('contextmenu', e => {
      e.preventDefault();
      const m = midiOf();
      if (state.keyOverrides[m]) { delete state.keyOverrides[m]; emit('assign'); emit('change'); }
    });
    k.addEventListener('dragover', e => {
      const s = dragSound();
      if (!s) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (isPitched(s)) keys.classList.add('drop-hover');
      else k.classList.add('drop-hover');
    });
    k.addEventListener('dragleave', () => { k.classList.remove('drop-hover'); keys.classList.remove('drop-hover'); });
    k.addEventListener('drop', e => {
      e.preventDefault();
      k.classList.remove('drop-hover'); keys.classList.remove('drop-hover');
      const s = dragSound();
      if (!s) return;
      if (isPitched(s)) assignKeyboard(s.id);
      else { state.keyOverrides[midiOf()] = s.id; loadSound(s.id); emit('assign'); emit('change'); }
    });
  });
}

function startMouseNote(m, vel) {
  if (mouseNote === m) return;
  if (mouseNote !== null) noteOff('k', mouseNote, 'ui');
  mouseNote = m;
  noteOn('k', m, vel, 'ui');
}
function releaseMouseNote() {
  if (mouseNote !== null) { noteOff('k', mouseNote, 'ui'); mouseNote = null; }
}

function renderKeys() {
  const base = baseNote();
  ui.keys.forEach((k, semi) => {
    const m = base + semi;
    const note = k.querySelector('.key-note');
    if (note) note.textContent = semi % 12 === 0 ? noteName(m) : '';
    const tag = k.querySelector('.key-tag');
    const ov = getSound(state.keyOverrides[m]);
    tag.classList.toggle('hidden', !ov);
    if (ov) { tag.textContent = ov.name; tag.style.setProperty('--snd', ov.color); }
    const s = getSound(keySoundId(m));
    k.style.setProperty('--key-color', s ? s.color : '#ff3b4e');
    k.title = ov ? `${noteName(m)}: ${ov.name} — right-click to clear` : noteName(m);
  });
}

function clearKeyDown() { ui.keys.forEach(k => k.classList.remove('down')); }

// ---------------------------------------------------------------- live feedback

function onHit({ kind, id, on: isOn, vel, src }) {
  if (kind === 'p') {
    const bank = id >= 8 ? 1 : 0;
    if (isOn && bank !== state.bank) { state.bank = bank; renderPads(); }
    if (bank !== state.bank) return;
    const p = ui.pads[id % 8].el;
    if (isOn) { p.style.setProperty('--vel', (0.45 + vel * 0.55).toFixed(2)); p.classList.add('lit'); }
    else p.classList.remove('lit');
    return;
  }
  let semi = id - baseNote();
  if (semi < 0 || semi > 24) {
    if (!isOn || src !== 'midi') return;
    // The hardware octave buttons changed: follow along by the smallest shift that fits.
    setOctave(semi < 0 ? Math.floor((id - 48) / 12) : Math.ceil((id - 72) / 12));
    semi = id - baseNote();
    if (semi < 0 || semi > 24) return;
  }
  ui.keys[semi].classList.toggle('down', isOn);
}

// Pad setup: point at the pad to tap next, tick off the ones already learned.
function showTeach(t) {
  for (const p of ui.pads) p.el.classList.remove('teach-target', 'teach-done');
  ui.keys[0].classList.remove('teach-target');
  if (!t) return;
  if (t.phase === 'keys') { ui.keys[0].classList.add('teach-target'); return; }
  const bank = t.step >= 8 ? 1 : 0;
  if (bank !== state.bank) { state.bank = bank; renderPads(); }
  const learned = new Set(Object.values(t.map));
  ui.pads.forEach((p, i) => p.el.classList.toggle('teach-done', learned.has(bank * 8 + i)));
  ui.pads[t.step % 8].el.classList.add('teach-target');
}

// ---------------------------------------------------------------- drag helpers

function dragSound() {
  const d = drag.current;
  return d?.type === 'sound' ? getSound(d.id) : null;
}

export function startDrag(e, data) {
  drag.current = data;
  e.dataTransfer.effectAllowed = 'copy';
  e.dataTransfer.setData('text/plain', data.id || data.name || '');
  const s = data.type === 'sound' ? getSound(data.id) : null;
  if (data.type === 'kit') document.body.classList.add('dragging-kit');
  else if (s) document.body.classList.add(isPitched(s) ? 'dragging-pitched' : 'dragging-oneshot');
}
export function endDrag() {
  drag.current = null;
  document.body.classList.remove('dragging-kit', 'dragging-pitched', 'dragging-oneshot');
  document.querySelectorAll('.drop-hover').forEach(n => n.classList.remove('drop-hover'));
}
