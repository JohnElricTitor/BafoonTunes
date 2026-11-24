// BafoonsTunes desktop app (Electron main process).
//
// - Serves the app from a private app:// address, so it behaves like a website
//   (MIDI, module scripts and fetch all work) without needing a local server.
//     app://bundle/...            -> the app's own files
//     app://bundle/my-sounds/...  -> imported sounds in <userData>/My Sounds (same origin, so fetch works)
// - Allows Web MIDI so the MPK mini works.
// - Stores imported sound packs as real files: <userData>/My Sounds/<pack id>/...
//   with an index in library.json.
// - Native Save / Open / Export dialogs.
// - Auto-updates from GitHub Releases (JohnElricTitor/BafoonTunes).
const { app, BrowserWindow, protocol, session, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { autoUpdater } = require('electron-updater');

const SMOKE = process.argv.includes('--smoke-test');
const UPDATE_CHECK = process.argv.includes('--update-check'); // test: print what the updater sees, then quit
if (SMOKE) app.setPath('userData', path.join(app.getPath('temp'), 'bafoonstunes-smoke'));
else if (process.env.BAFOONS_TEST_PROFILE) app.setPath('userData', process.env.BAFOONS_TEST_PROFILE); // testing without touching your songs

const APP_DIR = path.join(__dirname, '..');
const soundsDir = () => path.join(app.getPath('userData'), 'My Sounds');
const libraryFile = () => path.join(soundsDir(), 'library.json');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.wav': 'audio/wav',
  '.wave': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
};

/** Resolve a path inside `base`, refusing anything that escapes it. */
function inside(base, rel) {
  const full = path.resolve(base, '.' + path.sep + rel);
  const root = path.resolve(base) + path.sep;
  return full.startsWith(root) ? full : null;
}

async function serve(request) {
  const url = new URL(request.url);
  if (url.host !== 'bundle') return new Response('Not found', { status: 404 });
  let rel = decodeURIComponent(url.pathname);
  let base = APP_DIR;
  if (rel.startsWith('/my-sounds/')) { base = soundsDir(); rel = rel.slice('/my-sounds'.length); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = inside(base, rel);
  if (!full) return new Response('Not found', { status: 404 });
  try {
    const data = await fs.readFile(full);
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    return new Response(data, { headers: { 'content-type': type, 'cache-control': 'no-cache' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

// ---------------------------------------------------------------- sound library (files on disk)

let libQueue = Promise.resolve(); // serialise library.json updates
const withLib = fn => (libQueue = libQueue.then(async () => {
  let lib = { packs: [], sounds: [] };
  try { lib = JSON.parse(await fs.readFile(libraryFile(), 'utf8')); } catch { /* first run */ }
  const out = await fn(lib);
  if (out?.save) {
    await fs.mkdir(soundsDir(), { recursive: true });
    await fs.writeFile(libraryFile() + '.tmp', JSON.stringify(lib));
    await fs.rename(libraryFile() + '.tmp', libraryFile());
  }
  return out?.result;
}));

const safeSegment = s => s.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^\.+$/, '_').replace(/[. ]+$/, '') || '_';

ipcMain.handle('lib:load', () => withLib(lib => ({ result: lib })));

ipcMain.handle('lib:writeFile', async (_e, packId, relPath, data) => {
  const rel = relPath.split(/[\\/]+/).filter(Boolean).map(safeSegment).join('/');
  const full = inside(path.join(soundsDir(), safeSegment(packId)), rel);
  if (!full) throw new Error('Bad file path');
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, Buffer.from(data));
  return rel; // path inside the pack folder, as stored
});

ipcMain.handle('lib:savePack', (_e, pack, sounds) => withLib(lib => {
  lib.packs = lib.packs.filter(p => p.id !== pack.id).concat(pack);
  lib.sounds = lib.sounds.filter(s => s.pack !== pack.id).concat(sounds);
  return { save: true };
}));

ipcMain.handle('lib:removePack', (_e, packId) => withLib(async lib => {
  const dir = inside(soundsDir(), safeSegment(packId));
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  lib.packs = lib.packs.filter(p => p.id !== packId);
  lib.sounds = lib.sounds.filter(s => s.pack !== packId);
  return { save: true };
}));

ipcMain.handle('lib:deleteFiles', async (_e, packId, relPaths) => {
  const dir = inside(soundsDir(), safeSegment(packId));
  if (!dir) return;
  for (const rel of relPaths) {
    const full = inside(dir, rel);
    if (!full) continue;
    await fs.rm(full, { force: true });
    // tidy up folders left empty (but never the pack folder itself)
    for (let d = path.dirname(full); d.startsWith(dir + path.sep); d = path.dirname(d)) {
      try { await fs.rmdir(d); } catch { break; } // fails (and stops) once a folder still has files
    }
  }
});

ipcMain.handle('lib:folder', () => soundsDir());
ipcMain.handle('lib:reveal', async () => {
  await fs.mkdir(soundsDir(), { recursive: true });
  return shell.openPath(soundsDir());
});

// ---------------------------------------------------------------- native file dialogs

ipcMain.handle('file:save', async (e, { defaultName, filters, data, path: known }) => {
  let target = known;
  if (!target) {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath('documents'), defaultName || 'Untitled'),
      filters,
    });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  await fs.writeFile(target, Buffer.from(data));
  return { path: target, name: path.basename(target) };
});

// Double-clicking a .tunes file starts the app with its path on the command line (or, if the
// app is already open, hands that command line to it via 'second-instance').
const tunesFileIn = argv => argv.slice(1).find(a => /\.tunes$/i.test(a) && !a.startsWith('-'));
async function readTunes(p) {
  try { return { path: p, name: path.basename(p), text: await fs.readFile(p, 'utf8') }; }
  catch (e) { console.warn('could not read', p, e.message); return null; }
}
let launchFile = tunesFileIn(process.argv);
ipcMain.handle('file:pending', async () => {
  const p = launchFile;
  launchFile = null;
  return p ? readTunes(p) : null;
});

ipcMain.handle('file:open', async (e, { filters }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters, defaultPath: app.getPath('documents') });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  return { path: p, name: path.basename(p), text: await fs.readFile(p, 'utf8') };
});

// ---------------------------------------------------------------- auto-updates

// Checks GitHub Releases on launch (and every few hours), downloads new versions in the
// background, and installs them when the app restarts. The page shows a "Restart to update" toast.
function setupUpdates(win) {
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall(true, true));
  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) return { state: 'dev' };
    const r = await autoUpdater.checkForUpdates();
    return { state: 'checked', latest: r?.updateInfo?.version };
  });
  if (!app.isPackaged || SMOKE) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  const send = (state, extra = {}) => { if (!win.isDestroyed()) win.webContents.send('update', { state, ...extra }); };
  autoUpdater.on('update-available', i => send('downloading', { version: i.version }));
  autoUpdater.on('download-progress', p => send('progress', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', i => send('ready', { version: i.version }));
  autoUpdater.on('update-not-available', () => send('latest'));
  autoUpdater.on('error', e => { console.warn('update check failed', e?.message || e); send('error', { message: String(e?.message || e) }); });

  const check = () => autoUpdater.checkForUpdates().catch(() => { /* offline etc. */ });
  win.webContents.once('did-finish-load', () => setTimeout(check, 3000));
  setInterval(check, 4 * 60 * 60 * 1000);
}

async function runUpdateCheck() {
  autoUpdater.autoDownload = false;
  try {
    const r = await autoUpdater.checkForUpdates();
    console.log('UPDATE CHECK ' + JSON.stringify({ current: app.getVersion(), latest: r?.updateInfo?.version, available: r?.isUpdateAvailable ?? null }));
    app.exit(0);
  } catch (e) {
    console.log('UPDATE CHECK FAILED ' + (e?.message || e));
    app.exit(1);
  }
}

// ---------------------------------------------------------------- window

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'BafoonsTunes',
    backgroundColor: '#0e0e12',
    icon: path.join(APP_DIR, 'build', 'icon.png'),
    show: !SMOKE,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.loadURL('app://bundle/index.html');

  // Links (sound credits) open in the normal browser; never navigate the app window away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (ev, url) => { if (!url.startsWith('app://')) ev.preventDefault(); });

  // No menu bar, but keep a few handy keys: F11 full screen, F12 developer tools.
  win.webContents.on('before-input-event', (ev, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); ev.preventDefault(); }
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      win.webContents.toggleDevTools(); ev.preventDefault();
    }
  });

  if (SMOKE) runSmokeTest(win);
  setupUpdates(win);
  return win;
}

if (UPDATE_CHECK) {
  app.whenReady().then(runUpdateCheck);
} else if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', async (_e, argv) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.focus();
    const p = tunesFileIn(argv);
    const file = p && await readTunes(p);
    if (file && !w.isDestroyed()) w.webContents.send('file:opened', file);
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    protocol.handle('app', serve);
    // The MPK mini needs Web MIDI; Mic layers need the microphone ('media', audio only).
    const allowed = new Set(['midi', 'midiSysex', 'clipboard-sanitized-write', 'fullscreen', 'media']);
    session.defaultSession.setPermissionRequestHandler((_wc, perm, cb, details) => {
      if (perm === 'media') return cb((details?.mediaTypes || ['audio']).every(t => t === 'audio')); // microphone only, never the camera
      cb(allowed.has(perm));
    });
    session.defaultSession.setPermissionCheckHandler((_wc, perm) => allowed.has(perm));
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}

// ---------------------------------------------------------------- smoke test (npm run smoke)

function runSmokeTest(win) {
  win.webContents.on('console-message', e => console.log('[page]', e.message));
  win.webContents.once('did-finish-load', async () => {
    try {
      const result = await win.webContents.executeJavaScript(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 100 && document.getElementById('btnStart').disabled; i++) await wait(100);
        document.getElementById('btnStart').click();
        await wait(500);
        const { engine, loadSound } = await import('./js/engine.js');
        const { midi } = await import('./js/midi.js');
        const { userLib, importSources, removePack, storageKind } = await import('./js/userlib.js');
        const r = { electron: !!window.bafoons, storage: storageKind(), sounds: engine.sounds.size,
          audio: engine.ctx.state, midiSupported: midi.supported, midiError: midi.error, midiInputs: midi.inputs };
        r.pianoLoads = !!(await loadSound('piano-salamander'));
        // import a generated WAV and read it back through app://library
        const sr = 44100, n = sr / 2, ab = new ArrayBuffer(44 + n * 2), v = new DataView(ab);
        const s = (o, x) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, x.charCodeAt(i)); };
        s(0,'RIFF'); v.setUint32(4,36+n*2,true); s(8,'WAVE'); s(12,'fmt '); v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
        v.setUint32(24,sr,true); v.setUint32(28,sr*2,true); v.setUint16(32,2,true); v.setUint16(34,16,true); s(36,'data'); v.setUint32(40,n*2,true);
        for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / 20) * 12000, true);
        // a .zip pack with two folders, like a downloaded sample pack
        await new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'vendor/fflate.min.js'; sc.onload = res; sc.onerror = rej; document.head.appendChild(sc); });
        const zip = fflate.zipSync({ 'Smoke Pack/Kicks/Kick 1.wav': new Uint8Array(ab), 'Smoke Pack/808s/808 F#.wav': new Uint8Array(ab), 'Smoke Pack/Presets/x.fst': new Uint8Array(4) });
        const sum = await importSources([{ kind: 'zip', name: 'Smoke Pack', blob: new Blob([zip]) }]);
        window.__smokeImport = sum.newPacks;
        r.imported = sum.added; r.skipped = sum.skipped;
        const user = [...engine.sounds.values()].filter(x => x.category === 'user');
        r.userSoundUrls = user.map(x => x.zones[0].file);
        r.userSoundsPlay = (await Promise.all(user.map(x => loadSound(x.id)))).every(Boolean);
        r.packId = userLib.packs[0]?.id;
        // MP3 export path (loads the encoder script under the content security policy)
        const ex = await import('./js/exporter.js');
        const mp3 = await ex.encodeMp3({ channels: [new Float32Array(44100), new Float32Array(44100)], sampleRate: 44100, length: 44100 });
        r.mp3Bytes = mp3.size;
        r.saveDialogBridge = typeof window.bafoons.files.save;
        return r;
      })()`, true);
      const lib = JSON.parse(await fs.readFile(libraryFile(), 'utf8'));
      result.onDisk = (await fs.readdir(path.join(soundsDir(), result.packId), { recursive: true })).map(f => f.replace(/\\/g, '/'));
      result.libraryJson = { packs: lib.packs.length, sounds: lib.sounds.length };
      // rename a sound, a folder and the pack, then delete one sound
      result.layout = await win.webContents.executeJavaScript(`(async () => {
        const { engine } = await import('./js/engine.js');
        const ul = await import('./js/userlib.js');
        const L = await import('./js/layout.js');
        // place the import in a new section, then organise and edit it
        const sec = L.newSection('Smoke Section');
        L.placeImport(window.__smokeImport || [], sec);
        const user = [...engine.sounds.values()].filter(x => x.category === 'user');
        const kick = user.find(x => x.name === 'Kick 1'), bass = user.find(x => x.name === '808 F#');
        const pack = L.find(sec).node.packs[0];
        L.renameSound(bass.id, 'Big 808');
        L.renameNode(pack.groups.find(g => g.name === '808s').id, 'Basses');
        L.renameNode(pack.id, 'Renamed Pack');
        const g = L.newGroup(pack.id, 'Faves');
        L.moveSound(bass.id, g);
        L.forgetSounds([kick.id]);
        await ul.deleteSounds([kick.id]);
        const p = L.find(sec).node.packs[0];
        return { section: L.find(sec).node.name, pack: p.name, groups: p.groups.map(x => x.name + ':' + x.sounds.map(id => engine.sounds.get(id)?.name).join(',')), saved: !!localStorage.getItem('tunes.layout') };
      })()`);
      const lib2 = JSON.parse(await fs.readFile(libraryFile(), 'utf8'));
      result.afterEdits = {
        sounds: lib2.sounds.map(s => `${s.name} -> ${s.file}`),
        onDisk: (await fs.readdir(path.join(soundsDir(), result.packId), { recursive: true })).map(f => f.replace(/\\/g, '/')),
      };
      const removed = await win.webContents.executeJavaScript(`(async () => {
        const { userLib, removePack } = await import('./js/userlib.js');
        await removePack(userLib.packs[0].id);
        return userLib.packs.length;
      })()`);
      result.packsAfterRemove = removed;
      result.folderGone = !(await fs.stat(path.join(soundsDir(), result.packId)).catch(() => null));
      console.log('SMOKE RESULT ' + JSON.stringify(result, null, 2));
      app.exit(0);
    } catch (err) {
      console.log('SMOKE FAILED ' + (err?.stack || err));
      app.exit(1);
    }
  });
}
