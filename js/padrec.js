// Recording straight onto a pad from the microphone, like a loop machine:
// click the pad's ● to arm it, then HOLD the pad (on screen or on the MPK) while singing /
// playing; letting go finishes. The recording goes onto the pad and into
// My sounds › Pad recordings. Right-click the pad to make it loop.
import { state, emit } from './state.js';
import { engine, loadSound } from './engine.js';
import { padHooks } from './instrument.js';
import { openMic, startCapture, finishCapture, cancelCapture, takeToWav, restoreMic } from './mic.js';

export const padRec = { armed: null, recording: null, t0: 0, busy: false };
const PACK = 'Pad recordings';

/** Click ● on a pad: arm it (or disarm it if it was armed). */
export async function togglePadRecord(n) {
  if (padRec.recording !== null || padRec.busy) return;
  if (padRec.armed === n) { disarm(); emit('toast', 'Pad recording cancelled.'); return; }
  const ok = await openMic({ id: 'pad-rec', monitor: false }); // the mic chosen in Settings › Microphone
  if (!ok) return;
  padRec.armed = n;
  emit('padRec');
  emit('toast', `Pad ${(n % 8) + 1} is ready: hold it and sing or play into the mic, let go to finish.`);
}

function disarm() {
  padRec.armed = null;
  emit('padRec');
  restoreMic();
}

// While armed, pressing the pad records instead of playing it.
padHooks.press = n => {
  if (padRec.armed !== n) return false;
  if (padRec.recording !== null || padRec.busy) return true;
  padRec.recording = n;
  padRec.t0 = engine.ctx.currentTime;
  startCapture();
  emit('padRec');
  return true;
};
padHooks.release = n => {
  if (padRec.recording !== n) return padRec.armed === n;
  finish(n);
  return true;
};

async function finish(n) {
  padRec.busy = true;
  const t0 = padRec.t0, t1 = engine.ctx.currentTime;
  padRec.recording = null;
  emit('padRec');
  try {
    if (t1 - t0 < 0.1) { cancelCapture(); emit('toast', 'That was too short. Hold the pad while you record.'); return; }
    const take = await finishCapture(t0, t1);
    const wav = await takeToWav(take);
    if (!wav) { emit('toast', 'Nothing came in from the mic. Check it is plugged in and not muted.'); return; }
    const { importSources } = await import('./userlib.js');
    const L = await import('./layout.js');
    // keep pad recordings together in My sounds › Pad recordings
    const mine = L.layout.sections.find(s => s.id === L.MINE);
    const existing = mine?.packs.find(p => p.name === PACK);
    const count = existing ? L.idsIn(existing).length : 0;
    const summary = await importSources([{ kind: 'files', name: PACK, files: [{ path: `Pad ${(n % 8) + 1} take ${count + 1}.wav`, blob: wav }] }], undefined, { raw: true });
    const id = summary.newPacks[0]?.metas[0]?.id;
    if (!id) throw new Error('not saved');
    L.placeImport(summary.newPacks, existing ? existing.id : L.MINE);
    if (!existing) {
      const made = L.layout.sections.find(s => s.id === L.MINE)?.packs.at(-1);
      if (made && made.name !== PACK) L.renameNode(made.id, PACK);
    }
    await loadSound(id);
    state.pads[n] = id;
    emit('assign');
    emit('change');
    emit('toast', `Recorded onto pad ${(n % 8) + 1}. Right-click the pad to make it loop.`);
  } catch (e) {
    console.error(e);
    emit('toast', 'Could not save the pad recording.');
  } finally {
    padRec.busy = false;
    padRec.armed = null;
    emit('padRec');
    restoreMic();
  }
}
