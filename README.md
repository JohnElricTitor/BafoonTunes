# BafoonsTunes

A simple music maker built around the Akai MPK mini mk2. Drag sounds onto the pads and keys, record loops one take at a time, then save the project or export an MP3/WAV.

## Install (Windows)

Download **BafoonsTunes-Setup-x.y.z.exe** from the [latest release](https://github.com/JohnElricTitor/BafoonTunes/releases/latest) and run it.

The app isn't code-signed, so Windows may say "Windows protected your PC". Click **More info**, then **Run anyway**.

**Updates are automatic.** When BafoonsTunes opens, it checks for a new version and downloads it in the background. It installs when you close the app, or straight away with **Restart now**. The **?** menu shows your version and has **Check for updates**.

## Desktop app (Windows)

**Try a local build without installing:** run `dist\win-unpacked\BafoonsTunes.exe`.

Plug in the MPK mini and click **Start making music**. MIDI is allowed automatically; there's no browser prompt.

Where things are kept:
- **Imported sounds:** copied into `%APPDATA%\BafoonsTunes\My Sounds`, one folder per pack. The import window has an **Open sounds folder** button.
- **Projects:** saved wherever you choose (`.tunes` files) with the normal Windows Save dialog. The current session is also autosaved by the app.
- **Exports:** MP3/WAV, saved with the Save dialog.

Keys: **F11** full screen, **F12** developer tools.

### Building it (for you, the developer)

Needs Node.js. From this folder:

```
npm install        # once
npm start          # run the desktop app from source
npm run smoke      # automated check: starts the app hidden, imports and removes a test pack, exits
npm run icon       # rebuild build/icon.png from logo.jpg
npm run dist       # build the installer into dist/ for local testing (not published)
npm run release    # bump the version, commit, and push; GitHub builds and publishes it
```

### Releasing an update

Releases are built by GitHub itself (`.github/workflows/release.yml`). Whenever `main` is pushed with a version number in `package.json` that hasn't been released yet, GitHub builds the installer and publishes it under [Releases](https://github.com/JohnElricTitor/BafoonTunes/releases). This takes a few minutes; watch it under [Actions](https://github.com/JohnElricTitor/BafoonTunes/actions). Every installed copy picks up the new release the next time it's opened.

- **Easiest:** `npm run release` bumps 1.0.0 → 1.0.1, commits and pushes. Use `-- minor` for 1.1.0 or `-- major` for 2.0.0.
- **By hand:** change `"version"` in `package.json`, commit, and push to main.
- Pushes that don't change the version just save the code; no release is made.

## Browser version (still works)

Double-click **Start BafoonsTunes.bat**. It starts a small local server and opens Chrome (or Edge) at http://localhost:8642/. In the browser, imported sounds are kept in the browser's own storage instead of a folder. Opening `index.html` directly won't work: the browser blocks MIDI and sample loading for plain files.

## The MPK mini

The first time the MPK connects, a short setup asks you to tap each pad and then press the far-left key. That's how BafoonsTunes tells pads from keys and lines up the on-screen keyboard. To run it again, click the MPK status at the top, or use **Match keys** for just the keyboard. Keep CC and PROG CHANGE off so the pads play notes.

If a knob doesn't respond, right-click the matching knob on screen, then turn the hardware knob to link them.

Everything you press, turn or move on the device shows on screen. The arpeggiator, note repeat, full level and octave buttons work on the device itself. BafoonsTunes follows the notes they produce.

## Your own sounds

Click **+ Import** in the Sounds panel, or drop files onto it. It takes audio files (WAV, MP3, AIFF, FLAC, OGG, M4A), whole folders, and .zip sample packs. Packs made for FL Studio, Ableton, Reaper and other DAWs work when they contain audio files. Presets, racks, MIDI and project files are skipped.

- Each import becomes a pack under **My sounds**, with its folders shown as titles.
- Sounds are copied (see above), so they keep working if the originals move.
- Drag a pack or folder title onto the pads to fill them. Kicks, snares and hats are recognised by name.
- Drop a sample on the KEYS strip to play it across the keyboard. A note in the file name (like "808 F#") sets its pitch.
- The ✕ next to a pack removes it and its copied files from BafoonsTunes. Your original files are not touched.

## Files

- `index.html`, `css/`, `js/`: the app (plain JavaScript, no build step)
- `electron/`: the desktop wrapper (`main.js` window, file storage and dialogs; `preload.js` bridge)
- `logo.jpg`, `build/icon.png`: the logo and the app icon made from it
- `sounds/`: the built-in samples, plus `manifest.json` (the list of sounds) and `LICENSES.txt` (credits)
- `vendor/lame.min.js`: MP3 encoder (lamejs, LGPL-3.0)
- `vendor/fflate.min.js`: reads .zip sample packs (fflate, MIT)
- `serve.ps1` / `Start BafoonsTunes.bat`: the local web server for the browser version
- `tools/`: helper scripts (sample download, icon)
