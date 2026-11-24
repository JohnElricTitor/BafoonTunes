// Downloads the verified samples into <app>/sounds and writes sounds/manifest.json.
// usage (from the Tunes folder): node tools/fetch_samples.mjs .
import fs from 'node:fs';
import path from 'node:path';

const app = process.argv[2];
const src = JSON.parse(fs.readFileSync(path.join(app, 'tools', 'samples-manifest.json'), 'utf8'));

const DROP = new Set(['epiano-rhodes']);
const dropKit = 'tr808';

// Swap the Rhodes for FluidR3 electric piano (MIT), same note layout as the other FluidR3 instruments.
const lead = src.find(s => s.id === 'lead-saw');
const epiano = {
  ...lead,
  id: 'epiano',
  name: 'Electric Piano',
  sourcePage: 'https://github.com/gleitz/midi-js-soundfonts',
  files: lead.files.map(f => ({ midi: f.midi, url: f.url.replace('lead_2_sawtooth-mp3', 'electric_piano_1-mp3') })),
};

const NAMES = {
  'piano-salamander': 'Grand Piano', 'bass-electric': 'Electric Bass', 'bass-synth': 'Synth Bass',
  'lead-saw': 'Saw Lead', 'pad-warm': 'Warm Pad', strings: 'Strings', 'organ-drawbar': 'Organ',
  'guitar-nylon': 'Nylon Guitar', marimba: 'Marimba', vibraphone: 'Vibraphone',
  'acoustic-rim': 'Rim Click', 'acoustic-clap': 'Clap', 'acoustic-crash': 'Crash', 'acoustic-ride': 'Ride',
  'acoustic-hat-closed': 'Closed Hat', 'acoustic-hat-pedal': 'Pedal Hat', 'acoustic-hat-open': 'Open Hat',
  'acoustic-kick-soft': 'Soft Kick', 'acoustic-snare-soft': 'Soft Snare',
  'acoustic-tom-low': 'Low Tom', 'acoustic-tom-mid': 'Mid Tom', 'acoustic-tom-high': 'High Tom',
  'electronic-kick': 'Tek Kick', 'electronic-kick-808': '808 Kick', 'electronic-kick-haus': 'House Kick',
  'electronic-snare': 'Snare', 'electronic-snare-elec': 'Electro Snare', 'electronic-clap': 'Finger Snap',
  'electronic-hat-closed': 'Closed Hat', 'electronic-hat-closed-2': 'Closed Hat 2', 'electronic-hat-open': 'Open Hat',
  'electronic-tom': 'Fuzz Tom', 'electronic-crash': 'Cymbal', 'electronic-rim': 'Tick',
  'electronic-wood': 'Woodblock', 'electronic-triangle': 'Triangle', 'electronic-perc-blip': 'Blip',
  'fx-vinyl-hiss': 'Vinyl Hiss', 'fx-impact-boom': 'Cinematic Boom', 'fx-riser-cymbal': 'Cymbal Riser',
};
// Sustained instruments get a seamless loop so held notes don't cut off.
const LOOPS = { 'pad-warm': [0.6, 2.9], strings: [0.6, 2.9], 'organ-drawbar': [0.4, 2.9], 'lead-saw': [0.4, 2.9] };

function role(id) {
  if (/kick/.test(id)) return 'kick';
  if (/snare/.test(id)) return 'snare';
  if (/clap/.test(id)) return 'clap';
  if (/hat-open/.test(id)) return 'hat-open';
  if (/hat/.test(id)) return 'hat-closed';
  if (/tom/.test(id)) return 'tom';
  if (/crash|splash|ride|cymbal/.test(id)) return 'cymbal';
  return 'perc';
}

const sounds = [];
for (const s of src) {
  if (DROP.has(s.id) || s.kit === dropKit) continue;
  sounds.push(s);
  if (s.id === 'piano-salamander') sounds.push(epiano);
}

const jobs = [];
const out = [];
for (const s of sounds) {
  const dir = path.join(app, 'sounds', s.id);
  fs.mkdirSync(dir, { recursive: true });
  const files = s.files.map((f, i) => {
    const ext = path.extname(new URL(f.url).pathname) || '.mp3';
    const name = (s.type === 'pitched' ? `${f.midi}` : `${i}`) + ext;
    jobs.push({ url: f.url, dest: path.join(dir, name) });
    return { midi: f.midi, file: `sounds/${s.id}/${name}` };
  });
  const entry = {
    id: s.id,
    name: NAMES[s.id] || s.name.replace(/\s*\(.*\)\s*$/, ''),
    category: s.category,
    type: s.type,
    files,
    license: s.license,
  };
  if (s.category === 'drums') { entry.kit = s.kit; entry.role = role(s.id); }
  if (LOOPS[s.id]) entry.loop = LOOPS[s.id];
  out.push(entry);
}

async function get(job) {
  if (fs.existsSync(job.dest) && fs.statSync(job.dest).size > 0) return 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(job.url);
      if (!r.ok) throw new Error(r.status + ' ' + job.url);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(job.dest, buf);
      return buf.length;
    } catch (e) {
      if (attempt === 2) throw e;
    }
  }
}

let bytes = 0, done = 0;
const queue = [...jobs];
await Promise.all(Array.from({ length: 6 }, async () => {
  while (queue.length) {
    const j = queue.shift();
    bytes += await get(j);
    done++;
  }
}));

const kits = [
  { id: 'acoustic', name: 'Acoustic Kit' },
  { id: 'electronic', name: 'Electronic Kit' },
].map(k => ({ ...k, sounds: out.filter(s => s.kit === k.id).map(s => s.id) }));

const credits = [
  { title: 'Salamander Grand Piano', text: 'Salamander Grand Piano V3 by Alexander Holm, licensed CC BY 3.0. MP3 conversion from Tone.js audio.', url: 'https://creativecommons.org/licenses/by/3.0/' },
  { title: 'FluidR3 GM SoundFont', text: 'Electric piano, synth bass, saw lead, warm pad, strings, organ and nylon guitar from the Fluid (R3) General MIDI SoundFont, © 2000-2002, 2008 Frank Wen, MIT license. Pre-rendered by Benjamin Gleitzman (midi-js-soundfonts, MIT, © 2012 Benjamin Gleitzman). Full license text in sounds/LICENSES.txt.', url: 'https://github.com/gleitz/midi-js-soundfonts' },
  { title: 'Sonic Pi samples', text: 'Drum and FX samples from Sonic Pi (sourced from Freesound contributors), CC0.', url: 'https://sonic-pi.net' },
  { title: 'Versilian Community Sample Library', text: 'Marimba, vibraphone, clap, rim, shaker and cymbal swell by Versilian Studios, CC0.', url: 'https://github.com/sgossner/VCSL' },
  { title: 'Growlybass', text: 'Electric bass by Karoryfer Samples, CC0.', url: 'https://karoryfer.com' },
  { title: 'Mirrors', text: 'VCSL and Growlybass files mirrored by danigb/samples.', url: 'https://github.com/danigb/samples' },
];

fs.writeFileSync(path.join(app, 'sounds', 'manifest.json'), JSON.stringify({ kits, sounds: out, credits }, null, 1));
fs.writeFileSync(path.join(app, 'sounds', 'LICENSES.txt'), `Sample credits for Tunes
========================

${credits.map(c => `${c.title}\n${c.text}\n${c.url}\n`).join('\n')}

MIT License (Fluid R3 GM SoundFont, Frank Wen; midi-js-soundfonts, Benjamin Gleitzman)
--------------------------------------------------------------------------------------
Copyright (c) 2000-2002, 2008 Frank Wen
Copyright (c) 2012 Benjamin Gleitzman

Permission is hereby granted, free of charge, to any person obtaining a copy of this
software and associated documentation files (the "Software"), to deal in the Software
without restriction, including without limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.

Creative Commons Attribution 3.0: https://creativecommons.org/licenses/by/3.0/
CC0 1.0: https://creativecommons.org/publicdomain/zero/1.0/
`);
console.log(`sounds: ${out.length}, files: ${jobs.length}, downloaded ${(bytes / 1e6).toFixed(1)} MB`);
