// The Settings panel (gear button): the microphone choice and permission, and Factory reset.
// The other buttons there (calibrate, updates, restore sounds) are wired up in main.js.
import { emit, on } from './state.js';
import {
  micState, micChoice, setMicChoice, listInputs, micPermission, requestMic, openMic, restoreMic,
  micLevel, openWindowsMicSettings, MIC_PROBLEM_TEXT,
} from './mic.js';

const $ = id => document.getElementById(id);
const dlg = $('helpDlg');
const desktop = !!window.bafoons?.system;

/** Open the Settings panel (gear button), optionally scrolled to a section ('mic'). */
export function openSettings(section) {
  dlg.classList.remove('hidden');
  if (section === 'mic') $('micSection').scrollIntoView({ block: 'start' });
}
on('openSettings', openSettings);

// ---------------------------------------------------------------- microphone

let meterRaf = 0;

function setStatus(text, kind = '') {
  const el = $('micStatus');
  el.textContent = text;
  el.className = 'muted small ' + kind;
}

async function fillMicList() {
  const sel = $('micSelect');
  const list = await listInputs();
  const chosen = micChoice();
  sel.innerHTML = '';
  sel.add(new Option('Default mic (set in Windows)', ''));
  for (const d of list) sel.add(new Option(d.label, d.id));
  if (chosen && !list.some(d => d.id === chosen)) sel.add(new Option('Chosen mic (not plugged in)', chosen));
  sel.value = chosen;
}

/** Show whether the mic can be used, and start the level meter if it can. */
async function refreshMic() {
  const p = await micPermission();
  const allowBtn = $('btnMicAllow'), winBtn = $('btnMicWindows'), sel = $('micSelect');
  allowBtn.classList.toggle('hidden', p === 'granted');
  allowBtn.textContent = p === 'prompt' || p === 'unknown' ? 'Allow microphone' : 'Try again';
  winBtn.classList.toggle('hidden', p !== 'system');
  sel.disabled = p !== 'granted';
  await fillMicList();

  if (p === 'granted') {
    setStatus('Microphone allowed. Choose which one to use; Mic layers and pad recordings all use it. Speak to test the level.', 'ok');
    startMeter();
  } else if (p === 'prompt' || p === 'unknown') {
    setStatus('BafoonsTunes needs your permission to use a microphone (for Mic layers and recording onto pads).');
  } else {
    showProblem(p);
  }
}

function showProblem(problem) {
  stopMeter();
  $('btnMicAllow').classList.remove('hidden');
  $('btnMicAllow').textContent = 'Try again';
  $('btnMicWindows').classList.toggle('hidden', problem !== 'system' || !desktop);
  setStatus(problem !== 'system' ? MIC_PROBLEM_TEXT[problem] || MIC_PROBLEM_TEXT.other
    : desktop ? 'Windows is blocking the microphone. Click "Open Windows microphone settings", turn on "Microphone access" (or "Allow apps to access your microphone") and "Allow desktop apps to access your microphone", then come back and click Try again.'
    : 'Windows is blocking the microphone. Open Windows Settings › Privacy › Microphone, turn on microphone access for apps and desktop apps, then reload this page.', 'bad');
}

/** Keep the mic open while the panel is showing, so the level meter moves. */
async function startMeter() {
  if (!micState.node && !micState.capturing) {
    const ok = await openMic({ id: 'settings', monitor: false });
    if (!ok) return; // micProblem event explains why
    fillMicList(); // device names are known now
  }
  cancelAnimationFrame(meterRaf);
  const bar = $('micMeter').querySelector('i');
  const tick = () => {
    if (dlg.classList.contains('hidden')) return;
    bar.style.width = `${Math.min(100, micLevel() * 140)}%`;
    meterRaf = requestAnimationFrame(tick);
  };
  tick();
}

function stopMeter() {
  cancelAnimationFrame(meterRaf);
  $('micMeter').querySelector('i').style.width = '0';
  if (micState.layerId === 'settings') restoreMic();
}

on('micProblem', p => { if (!dlg.classList.contains('hidden')) showProblem(p); });

$('btnMicAllow').onclick = async () => {
  $('btnMicAllow').disabled = true;
  setStatus('Asking for the microphone… (if a box pops up, click Allow)');
  const r = await requestMic();
  $('btnMicAllow').disabled = false;
  if (r === 'granted') refreshMic(); else showProblem(r);
};
$('btnMicWindows').onclick = () => openWindowsMicSettings();
$('micSelect').onchange = () => {
  setMicChoice($('micSelect').value);
  emit('toast', `Using ${$('micSelect').selectedOptions[0]?.textContent || 'the default mic'}.`);
};
navigator.mediaDevices?.addEventListener?.('devicechange', () => { if (!dlg.classList.contains('hidden')) fillMicList(); });
// coming back from Windows' settings: check again
window.addEventListener('focus', () => { if (!dlg.classList.contains('hidden')) refreshMic(); });

// opening / closing the panel (however it's closed)
new MutationObserver(() => {
  if (dlg.classList.contains('hidden')) stopMeter(); else refreshMic();
}).observe(dlg, { attributes: true, attributeFilter: ['class'] });

// ---------------------------------------------------------------- factory reset

$('btnFactoryReset').onclick = () => $('resetDlg').classList.remove('hidden');
$('resetGo').onclick = async () => {
  const go = $('resetGo');
  go.disabled = true;
  go.textContent = 'Deleting…';
  try {
    emit('stopAll');
    const { removeAllPacks } = await import('./userlib.js');
    await removeAllPacks();
    // forget the song, the panel layout and the mic choice; keep the MPK calibration
    for (const k of ['tunes.autosave', 'tunes.layout', 'tunes.libCollapsed', 'tunes.mic']) {
      try { localStorage.removeItem(k); } catch { /* */ }
    }
    window.__tunesResetting = true; // don't autosave the old song on the way out
    location.reload();
  } catch (e) {
    console.error(e);
    go.disabled = false;
    go.textContent = 'Delete everything and reset';
    emit('toast', 'Factory reset failed: ' + (e.message || e));
  }
};
