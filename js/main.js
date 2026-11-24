// App wiring: top bar, shortcuts, dialogs, MIDI hookup.
import { state, emit, on, mod, clamp, noteName } from './state.js';
import { engine, initAudio, loadManifest, applyKnobs } from './engine.js';
import { tp, play, stop, togglePlay, toggleRecord, setBpm, currentBeat, loopBeats, updateTrackGains } from './transport.js';
import { noteOn, noteOff, setBend, setSustain, allNotesOff } from './instrument.js';
import { initMidi, midi, cancelLearn, startPadSetup, startKeySync, cancelPadSetup, skipTeachStep, resetMidiSettings } from './midi.js';
import { buildController, assignKit, shiftOctave } from './controller.js';
import { buildLibrary } from './library.js';
import { loadUserLibrary, importSources, sourcesFromFileList, sourcesFromDrop, storageKind, soundsFolder, revealFolder, userLib } from './userlib.js';
import { loadLayout, placeImport, pathOf, restoreBuiltins, MINE } from './layout.js';
import { buildTracks } from './tracks.js';
import { renderMix, encodeWav, encodeMp3, saveBlob } from './exporter.js';
import { initAutosave, restoreAutosave, newProject, saveProject, openProject, preloadProjectSounds } from './project.js';

const $ = id => document.getElementById(id);

// ---------------------------------------------------------------- boot

async function boot() {
  initAudio();
  try {
    await loadManifest();
  } catch (e) {
    $('loadMsg').textContent = 'Could not load the sounds. Start BafoonsTunes with "Start BafoonsTunes.bat" rather than opening index.html directly.';
    return;
  }
  await loadUserLibrary(); // your imported packs, before the saved session refers to them
  loadLayout();            // how sounds are organised in the side panel
  buildController($('mpk'));
  buildLibrary();
  bindImport();
  buildTracks($('timeline'));
  bindTopbar();
  bindShortcuts();
  bindDialogs();
  initAutosave();

  if (!restoreAutosave()) newProject(starterSetup());
  syncTopbar();
  applyKnobs(true);

  await preloadProjectSounds();
  $('loadMsg').textContent = 'Sounds ready.';
  $('btnStart').disabled = false;
}

function starterSetup() {
  // Piano on the keys, acoustic kit on bank A, electronic kit on bank B.
  const saved = { pads: state.pads, bank: state.bank };
  state.pads = Array(16).fill(null);
  if (engine.kits[0]) assignKit(engine.kits[0].sounds, engine.kits[0].name, 0, true);
  if (engine.kits[1]) assignKit(engine.kits[1].sounds, engine.kits[1].name, 1, true);
  const pads = state.pads;
  state.pads = saved.pads;
  const piano = [...engine.sounds.values()].find(s => s.type === 'pitched');
  return { keyboardSound: engine.sounds.has('piano-salamander') ? 'piano-salamander' : piano?.id ?? null, pads };
}

$('btnStart').disabled = true;
$('btnStart').addEventListener('click', async () => {
  await engine.ctx.resume();
  $('welcome').classList.add('hidden');
  connectMidi();
});
// Clicking the status retries (e.g. after allowing MIDI in the address bar),
// or re-runs pad setup once a controller is connected.
$('midiStatus').addEventListener('click', () => {
  if (!midi.inputs.length) {
    connectMidi();
    if (midi.supported && !midi.error) {
      toast({
        text: "Can't see your MPK. Windows lets only one program use it at a time, so close anything else using it "
          + '(the browser version of BafoonsTunes in Chrome, FL Studio, Ableton…), then unplug the MPK and plug it back in.',
        ms: 15000,
      });
    }
  }
  else startPadSetup();
});

// ---------------------------------------------------------------- pad setup

let setupOffered = false;
on('midi', () => {
  // First time a controller shows up, learn its pads.
  if (setupOffered || !midi.inputs.length || midi.teach) return;
  setupOffered = true;
  if (!midi.padMap) startPadSetup();
  else if (!localStorage.getItem('tunes.octave')) startKeySync(); // set up before the key step existed
});

on('teach', t => {
  const bar = $('teachBar');
  bar.classList.toggle('hidden', !t);
  if (!t) return;
  if (t.phase === 'keys') {
    $('teachTitle').textContent = 'Press the far-left key on your MPK';
    $('teachSub').textContent = t.standalone
      ? 'So the keys on screen line up with your keyboard'
      : 'Last step · so the keys on screen line up with your keyboard';
    $('teachSkip').textContent = 'Skip';
    $('teachSkip').classList.remove('hidden');
    $('teachHeard').textContent = 'Waiting for a key…';
    return;
  }
  $('teachSkip').textContent = 'Skip bank B';
  const bankB = t.step >= 8;
  const n = (t.step % 8) + 1;
  $('teachTitle').textContent = bankB && n === 1
    ? 'Now press BANK A/B on your MPK, then tap PAD 1'
    : `Tap PAD ${n} on your MPK`;
  $('teachSub').textContent = bankB
    ? `Pad setup · bank B · ${t.step - 8} of 8 done`
    : `Pad setup · so BafoonsTunes can tell pads from keys · ${t.step} of 8 done`;
  $('teachSkip').classList.toggle('hidden', !bankB);
  if (t.step === 0) $('teachHeard').textContent = 'Waiting for a pad…';
});
on('midiNote', ({ ch, note }) => {
  if (midi.teach || !$('teachBar').classList.contains('hidden')) {
    $('teachHeard').textContent = `Heard ch ${ch + 1} · note ${note}`;
  }
});
on('padsLearned', s => {
  // Keys at the MPK's normal octave are notes 48-72. A pad sending one of those on the
  // keys' channel can't be told apart from that key, so say which keys are affected.
  const clash = (s?.notesOnKeyChannel || []).filter(n => n >= 48 && n <= 72);
  if (!clash.length) { toast('Pads are set up. Your MPK pads and keys are now told apart.'); return; }
  const range = clash.length > 1 ? `${noteName(clash[0])}–${noteName(clash[clash.length - 1])}` : noteName(clash[0]);
  toast({
    text: `Pads are set up, but some pads send the same notes as keys ${range} on channel ${s.keyChannel}, so those keys will play pads. Fix: set the MPK's pad channel to 10 in Akai's MPK mini mk2 Editor.`,
    ms: 14000,
  });
});
$('teachSkip').onclick = () => skipTeachStep();
$('teachCancel').onclick = () => cancelPadSetup();
function calibrate() {
  $('helpDlg').classList.add('hidden');
  if (!midi.inputs.length) {
    connectMidi();
    toast('Connect your MPK first, then press Calibrate again.');
    return;
  }
  startPadSetup();
}
$('btnCalibrate').onclick = calibrate;
$('btnRestoreBuiltins').onclick = () => {
  const n = restoreBuiltins();
  toast(n ? `Restored ${n} built-in sound${n === 1 ? '' : 's'}.` : 'All built-in sounds are already there.');
};
$('btnPadSetup').onclick = calibrate;
$('btnMidiReset').onclick = () => {
  if (!confirm('Forget everything BafoonsTunes has learned about your MPK (pads, octave and knob links) and calibrate again?')) return;
  resetMidiSettings();
  toast('MPK settings reset.');
  calibrate();
};
on('midiLog', log => {
  if (!$('helpDlg').classList.contains('hidden')) $('midiLog').textContent = log.join('\n');
});

function connectMidi() {
  initMidi({
    keyOn: (n, v) => noteOn('k', n, v, 'midi'),
    keyOff: n => noteOff('k', n, 'midi'),
    padOn: (i, v) => noteOn('p', i, v, 'midi'),
    padOff: i => noteOff('p', i, 'midi'),
    knob: (i, v) => setKnob(i, v),
    modWheel: v => emit('modWheel', v),
    bend: b => setBend(b),
    sustain: down => setSustain(down),
  });
}

// ---------------------------------------------------------------- importing your own sounds

const SKIP_NAMES = {
  fst: 'FL Studio presets', flp: 'FL Studio projects', zip: 'nested zips',
  adg: 'Ableton racks', adv: 'Ableton presets', alp: 'Ableton packs', als: 'Ableton sets', agr: 'Ableton grooves',
  nki: 'Kontakt files', nkm: 'Kontakt files', nkx: 'Kontakt files', ncw: 'Kontakt files', nkc: 'Kontakt files',
  fxp: 'plugin presets', fxb: 'plugin presets', vital: 'Vital presets', serumpreset: 'Serum presets',
  mid: 'MIDI files', midi: 'MIDI files', rpp: 'Reaper projects',
  txt: 'text files', pdf: 'PDFs', jpg: 'images', jpeg: 'images', png: 'images', gif: 'images', url: 'links', html: 'web pages',
};

// Where the next import goes: a section / pack / group id, or null for "My sounds".
let importTarget = null;
function setImportTarget(id) {
  importTarget = id && pathOf(id) ? id : null;
  $('impTarget').textContent = `Adding to: ${importTarget ? pathOf(importTarget) : pathOf(MINE) || 'My sounds'}`;
}

function bindImport() {
  const dlg = $('importDlg');
  const open = target => { setImportTarget(target); $('impStatus').textContent = ''; showStorage(); dlg.classList.remove('hidden'); };
  $('btnImport').onclick = () => open(null);
  on('importInto', ({ id }) => open(id));
  $('impFiles').onclick = () => $('impFilesInput').click();
  $('impFolder').onclick = () => $('impFolderInput').click();
  $('impReveal').onclick = () => revealFolder();
  for (const id of ['impFilesInput', 'impFolderInput']) {
    $(id).addEventListener('change', e => {
      const sources = sourcesFromFileList(e.target.files);
      e.target.value = '';
      runImport(sources);
    });
  }

  // Drop files from Explorer onto the dialog's drop zone or anywhere on the sound list.
  const isFileDrag = e => [...(e.dataTransfer?.types || [])].includes('Files');
  for (const zone of [$('importDrop'), document.querySelector('.library')]) {
    zone.addEventListener('dragover', e => { if (!isFileDrag(e)) return; e.preventDefault(); zone.classList.add('file-over'); });
    zone.addEventListener('dragleave', e => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('file-over'); });
    zone.addEventListener('drop', async e => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      zone.classList.remove('file-over');
      // dropped onto a section / pack / group title: import straight into it
      const onTitle = e.target.closest?.('.lib-group')?.querySelector(':scope > .lib-title-row')?.dataset.node;
      if (zone !== $('importDrop')) setImportTarget(onTitle || null);
      const sources = await sourcesFromDrop(e.dataTransfer);
      $('impStatus').textContent = '';
      dlg.classList.remove('hidden');
      runImport(sources);
    });
  }
  // Don't let a stray drop outside these zones open the file in the browser tab.
  window.addEventListener('dragover', e => { if (isFileDrag(e)) e.preventDefault(); });
  window.addEventListener('drop', e => { if (isFileDrag(e)) e.preventDefault(); });
}

let importing = false;
async function runImport(sources) {
  if (importing || !sources.length) return;
  importing = true;
  const bar = $('impProgress'), fill = bar.firstElementChild, status = $('impStatus');
  bar.classList.remove('hidden');
  fill.style.width = '3%';
  status.textContent = 'Reading files…';
  try {
    const s = await importSources(sources, p => {
      if (p.phase === 'unzip') status.textContent = `Unzipping “${p.name}”…`;
      else { status.textContent = `Adding “${p.name}”: ${p.done} of ${p.total} sounds`; fill.style.width = `${(p.done / p.total) * 100}%`; }
    });
    const where = importTarget ? pathOf(importTarget) : 'My sounds';
    if (s.newPacks.length) placeImport(s.newPacks, importTarget);
    const skipped = {};
    for (const [ext, n] of Object.entries(s.skipped)) {
      const label = SKIP_NAMES[ext] || `.${ext} files`;
      skipped[label] = (skipped[label] || 0) + n;
    }
    const skipText = Object.entries(skipped).map(([k, n]) => `${n} ${k}`).join(', ');
    status.textContent = s.added
      ? `Added ${s.added} sound${s.added === 1 ? '' : 's'} to ${where}.`
        + (skipText ? ` Skipped (not audio): ${skipText}.` : '')
        + (s.failed ? ` ${s.failed} file${s.failed === 1 ? '' : 's'} couldn't be read.` : '')
      : `No audio files found${skipText ? ` (skipped: ${skipText})` : ''}.`;
    if (s.added) toast(`Imported ${s.added} sound${s.added === 1 ? '' : 's'}.`);
  } catch (e) {
    console.error(e);
    status.textContent = 'Import failed: ' + (e.message || e) + (/quota/i.test(e.message || '') ? ' Your browser storage is full — remove a pack to make room.' : '');
  } finally {
    importing = false;
    bar.classList.add('hidden');
    showStorage();
  }
}

async function showStorage() {
  if (storageKind() === 'files') {
    const bytes = userLib.packs.reduce((n, p) => n + (p.bytes || 0), 0);
    const mb = bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
    $('impStorage').textContent = `Imported sounds are copied into ${await soundsFolder()} (${mb} so far). Your original files aren't changed.`;
    $('impReveal').classList.remove('hidden');
    return;
  }
  try {
    const { usage, quota } = await navigator.storage.estimate();
    const mb = b => (b / 1e6 >= 1000 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
    $('impStorage').textContent = `Your sounds use about ${mb(usage)} (room for ${mb(quota)}).`;
  } catch { /* */ }
}

// ---------------------------------------------------------------- desktop app updates

const updates = window.bafoons?.updates;
if (updates) {
  $('appVersionRow').classList.remove('hidden');
  updates.version().then(v => { $('appVersion').textContent = `You have version ${v}.`; });
  let announced = null;
  updates.onStatus(s => {
    if (s.state === 'downloading' && announced !== s.version) {
      announced = s.version;
      toast(`Downloading BafoonsTunes ${s.version} in the background…`);
    } else if (s.state === 'ready') {
      toast({ text: `BafoonsTunes ${s.version} is ready. It installs next time you close the app.`, action: 'Restart now', run: () => updates.install(), ms: 30000 });
      $('appVersion').textContent += ` Version ${s.version} is downloaded and ready.`;
    }
  });
  $('btnUpdate').onclick = async () => {
    $('btnUpdate').disabled = true;
    try {
      const r = await updates.check();
      const current = await updates.version();
      if (r.state === 'dev') toast('Updates only work in the installed app.');
      else if (r.latest && r.latest !== current) toast(`Version ${r.latest} found, downloading now…`);
      else toast(`You're up to date (version ${current}).`);
    } catch (e) {
      toast("Couldn't check for updates. Are you online?");
    } finally {
      $('btnUpdate').disabled = false;
    }
  };
}

// ---------------------------------------------------------------- knobs

function setKnob(i, v) {
  state.knobs[i] = clamp(v);
  applyKnobs();
  emit('knob', i);
  emit('change');
}
on('setKnob', ({ i, v }) => setKnob(i, v));
on('uiMod', y => setKnob(0, y));

// ---------------------------------------------------------------- top bar

function bindTopbar() {
  $('btnPlay').onclick = () => togglePlay();
  $('btnStop').onclick = () => { stop(); allNotesOff(); };
  $('btnRec').onclick = () => toggleRecord();

  $('bpm').addEventListener('change', () => setBpm(+$('bpm').value || state.bpm));
  $('bpm').addEventListener('keydown', e => { if (e.key === 'Enter') $('bpm').blur(); });
  $('bars').addEventListener('change', () => { state.bars = +$('bars').value; emit('bars'); emit('change'); });
  $('quant').addEventListener('change', () => { state.quantize = +$('quant').value; emit('change'); });
  $('btnMetro').onclick = () => { state.metronome = !state.metronome; syncTopbar(); emit('change'); };
  $('btnCount').onclick = () => { state.countIn = !state.countIn; syncTopbar(); emit('change'); };
  $('songName').addEventListener('change', () => { state.name = $('songName').value.trim() || 'My Song'; syncTopbar(); emit('change'); });
  $('songName').addEventListener('keydown', e => { if (e.key === 'Enter') $('songName').blur(); });

  $('btnNew').onclick = () => {
    if (state.tracks.length && !confirm('Start a new song? Your current tracks will be cleared (save first if you want to keep them).')) return;
    newProject(starterSetup());
  };
  $('btnOpen').onclick = () => openProject().catch(e => toast(e.message));
  $('btnSave').onclick = () => saveProject();
  $('btnExport').onclick = openExport;
  $('btnHelp').onclick = () => {
    if (midi.log?.length) $('midiLog').textContent = midi.log.join('\n');
    $('helpDlg').classList.remove('hidden');
  };

  on('project', () => { syncTopbar(); applyKnobs(true); updateTrackGains(); });
  on('bpm', () => { $('bpm').value = state.bpm; applyKnobs(); });
  on('transport', syncTransport);
  on('rec', syncTransport);
  on('tap', tapTempo);
  on('midi', syncMidi);
  let flashTimer = 0;
  on('midiActivity', () => {
    const el = $('midiStatus');
    el.classList.add('flash');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove('flash'), 60);
  });
  requestAnimationFrame(clockFrame);
}

function syncTopbar() {
  $('songName').value = state.name;
  $('bpm').value = state.bpm;
  $('bars').value = state.bars;
  $('quant').value = state.quantize;
  $('btnMetro').classList.toggle('on', state.metronome);
  $('btnCount').classList.toggle('on', state.countIn);
  document.title = `${state.name} · BafoonsTunes`;
}

function syncTransport() {
  $('btnPlay').classList.toggle('on', tp.playing);
}

function syncMidi() {
  const el = $('midiStatus');
  const label = el.querySelector('.label');
  const mpk = midi.inputs.find(n => /mpk/i.test(n));
  el.classList.toggle('ok', midi.inputs.length > 0);
  if (!midi.supported) label.textContent = 'Use Chrome or Edge for MIDI';
  else if (midi.error) label.textContent = midi.error;
  else if (mpk) label.textContent = 'MPK mini connected';
  else if (midi.inputs.length) label.textContent = midi.inputs[0];
  else label.textContent = 'MPK not found — click for help';
  el.title = midi.inputs.length
    ? `Connected: ${midi.inputs.join(', ')}. Click to set up the pads again.`
    : 'No MIDI controller detected. Click to try again.';
}

function clockFrame() {
  const clock = $('clock');
  const rec = tp.rec;
  if (tp.playing) {
    const b = currentBeat();
    const waiting = rec && b < rec.startBeat;
    if (b < 0) {
      clock.textContent = `${Math.ceil(-b)}…`;
    } else if (waiting && rec.startBeat - b <= 4) {
      // last bar before a take starts: count it down like the count-in
      clock.textContent = `${Math.ceil(rec.startBeat - b)}…`;
    } else {
      const p = mod(b, loopBeats());
      clock.textContent = `${Math.floor(p / 4) + 1}.${Math.floor(p % 4) + 1}`;
    }
    clock.classList.toggle('count', b < 0 || (waiting && rec.startBeat - b <= 4));
    const recording = rec && b >= rec.startBeat;
    clock.classList.toggle('rec', !!recording);
    $('btnRec').classList.toggle('on', !!recording);
    $('btnRec').classList.toggle('armed', !!rec && !recording);
  } else {
    clock.textContent = '1.1';
    clock.classList.remove('count', 'rec');
    $('btnRec').classList.remove('on', 'armed');
  }
  requestAnimationFrame(clockFrame);
}

const taps = [];
function tapTempo() {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
  taps.push(now);
  if (taps.length > 5) taps.shift();
  if (taps.length >= 3) {
    const gaps = taps.slice(1).map((t, i) => t - taps[i]);
    setBpm(60000 / (gaps.reduce((a, b) => a + b) / gaps.length));
    toast(`Tempo ${state.bpm} BPM`);
  }
}

// ---------------------------------------------------------------- computer keyboard

const QWERTY = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9,
  KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17,
};
const held = new Map();

function bindShortcuts() {
  window.addEventListener('keydown', e => {
    const t = e.target;
    if (t.matches?.('input[type=text], input[type=number], input[type=search], input:not([type]), select, textarea')) return;
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') { e.preventDefault(); saveProject(e.shiftKey); return; }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyO') { e.preventDefault(); openProject(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Escape') { cancelLearn(); if (midi.teach) cancelPadSetup(); document.querySelectorAll('.overlay:not(#welcome)').forEach(o => o.classList.add('hidden')); return; }
    if (!$('welcome').classList.contains('hidden')) return;
    if (e.repeat) { if (QWERTY[e.code] !== undefined || /^Digit[1-8]$/.test(e.code)) e.preventDefault(); return; }

    if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
    if (e.code === 'KeyR') { toggleRecord(); return; }
    if (e.code === 'KeyM') { $('btnMetro').click(); return; }
    if (e.code === 'KeyZ') { shiftOctave(-1); return; }
    if (e.code === 'KeyX') { shiftOctave(1); return; }

    if (QWERTY[e.code] !== undefined) {
      e.preventDefault();
      const n = 48 + state.octave * 12 + QWERTY[e.code];
      held.set(e.code, ['k', n]);
      noteOn('k', n, 0.85, 'ui');
      return;
    }
    const d = /^Digit([1-8])$/.exec(e.code);
    if (d) {
      const i = state.bank * 8 + (+d[1] - 1);
      held.set(e.code, ['p', i]);
      noteOn('p', i, 0.9, 'ui');
    }
  });
  window.addEventListener('keyup', e => {
    const h = held.get(e.code);
    if (h) { held.delete(e.code); noteOff(h[0], h[1], 'ui'); }
  });
  window.addEventListener('blur', () => {
    for (const [, h] of held) noteOff(h[0], h[1], 'ui');
    held.clear();
  });
}

// ---------------------------------------------------------------- dialogs & toast

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  const m = typeof msg === 'string' ? { text: msg } : msg;
  el.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = m.text;
  el.appendChild(span);
  if (m.action) {
    const b = document.createElement('button');
    b.textContent = m.action;
    b.onclick = () => { m.run(); el.classList.add('hidden'); };
    el.appendChild(b);
  }
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), m.ms || (m.action ? 6000 : 3200));
}
on('toast', toast);

function bindDialogs() {
  document.querySelectorAll('.overlay [data-close]').forEach(b => {
    b.onclick = () => b.closest('.overlay').classList.add('hidden');
  });
  document.querySelectorAll('.seg').forEach(seg => {
    seg.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      updateExportInfo();
    });
  });
  $('expGo').onclick = runExport;

  const credits = $('credits');
  for (const c of engine.credits) {
    const p = document.createElement('p');
    const b = document.createElement('b');
    b.textContent = c.title + ': ';
    p.appendChild(b);
    p.appendChild(document.createTextNode(c.text + ' '));
    if (c.url) {
      const a = document.createElement('a');
      a.href = c.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = c.url;
      p.appendChild(a);
    }
    credits.appendChild(p);
  }
}

const segVal = id => $(id).querySelector('button.on').dataset.v;

function openExport() {
  if (!state.tracks.length) { toast('Record a track first, then you can export it.'); return; }
  $('expName').value = state.name;
  $('expProgress').classList.add('hidden');
  $('expGo').disabled = false;
  updateExportInfo();
  $('exportDlg').classList.remove('hidden');
}

function updateExportInfo() {
  const loops = +segVal('expLoops');
  const secs = loops * loopBeats() * 60 / state.bpm;
  const m = Math.floor(secs / 60), s = Math.round(secs % 60);
  $('expInfo').textContent = `Plays your ${state.bars}-bar loop ${loops} time${loops > 1 ? 's' : ''} at ${state.bpm} BPM: about ${m ? m + ' min ' : ''}${s} s. Muted tracks are left out.`;
}

async function runExport() {
  const fmt = segVal('expFormat');
  const loops = +segVal('expLoops');
  const name = ($('expName').value.trim() || state.name).replace(/[\\/:*?"<>|]+/g, '');
  const bar = $('expProgress');
  const fill = bar.firstElementChild;
  bar.classList.remove('hidden');
  fill.style.width = '10%';
  $('expGo').disabled = true;
  try {
    const mix = await renderMix(loops);
    fill.style.width = '40%';
    const blob = fmt === 'wav'
      ? encodeWav(mix)
      : await encodeMp3(mix, p => { fill.style.width = `${40 + p * 55}%`; });
    fill.style.width = '100%';
    const ok = await saveBlob(blob, `${name}.${fmt}`, fmt === 'wav' ? 'WAV audio' : 'MP3 audio',
      fmt === 'wav' ? 'audio/wav' : 'audio/mpeg', '.' + fmt);
    if (ok) {
      $('exportDlg').classList.add('hidden');
      toast(`Exported “${name}.${fmt}”.`);
    }
  } catch (e) {
    console.error(e);
    toast('Export failed: ' + e.message);
  } finally {
    $('expGo').disabled = false;
    bar.classList.add('hidden');
  }
}

boot();
