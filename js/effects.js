// Audio effects that can be dropped onto a layer (each with one "amount" from 0 to 1).
// Built with plain Web Audio nodes, so they work the same live, in export and in
// "save as sound" (offline rendering).

export const EFFECTS = [
  { type: 'reverb', name: 'Reverb', def: 0.4, color: '#74c0fc', hint: 'Adds space, like a room or hall' },
  { type: 'echo', name: 'Echo', def: 0.35, color: '#9775fa', hint: 'Repeats in time with the beat' },
  { type: 'lowpass', name: 'Muffle', def: 0.5, color: '#ffa94d', hint: 'Low-pass filter: cuts the highs, sounds softer / underwater' },
  { type: 'highpass', name: 'Thin', def: 0.4, color: '#ffd43b', hint: 'High-pass filter: cuts the bass, sounds thinner / radio-like' },
  { type: 'distortion', name: 'Distortion', def: 0.4, color: '#ff6b6b', hint: 'Gritty, crunchy overdrive' },
  { type: 'lofi', name: 'Lo-fi', def: 0.5, color: '#a9e34b', hint: 'Bitcrusher: crunchy, old-video-game sound' },
  { type: 'chorus', name: 'Chorus', def: 0.5, color: '#63e6be', hint: 'Wide, shimmery doubling' },
];
export const effectInfo = type => EFFECTS.find(e => e.type === type);

function impulse(ctx, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  return buf;
}

function curve(fn, n = 2048) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = fn((i / (n - 1)) * 2 - 1);
  return c;
}

/** One effect: { input, output, set(amount) } */
function build(ctx, fx, bpm) {
  const input = ctx.createGain(), output = ctx.createGain();
  const at = () => ctx.currentTime;
  const put = (p, v) => p.setTargetAtTime(v, at(), 0.02);
  switch (fx.type) {
    case 'reverb': {
      const dry = ctx.createGain(), wet = ctx.createGain(), conv = ctx.createConvolver();
      conv.buffer = impulse(ctx, 2.6);
      input.connect(dry).connect(output);
      input.connect(conv).connect(wet).connect(output);
      return { input, output, set: a => { put(dry.gain, 1 - a * 0.35); put(wet.gain, a * 1.1); } };
    }
    case 'echo': {
      const wet = ctx.createGain(), delay = ctx.createDelay(3), fb = ctx.createGain(), tone = ctx.createBiquadFilter();
      tone.type = 'lowpass'; tone.frequency.value = 4000;
      delay.delayTime.value = Math.min(2.9, 0.75 * 60 / bpm); // dotted 8th: a classic dance-music echo
      input.connect(output);
      input.connect(delay); delay.connect(tone); tone.connect(fb); fb.connect(delay); tone.connect(wet); wet.connect(output);
      return { input, output, set: a => { put(wet.gain, a * 0.75); put(fb.gain, 0.2 + a * 0.5); } };
    }
    case 'lowpass': case 'highpass': {
      const f = ctx.createBiquadFilter();
      f.type = fx.type; f.Q.value = 0.8;
      input.connect(f).connect(output);
      return {
        input, output,
        set: a => put(f.frequency, fx.type === 'lowpass' ? 18000 * Math.pow(2, -a * 6.8) : 25 * Math.pow(2, a * 7.2)),
      };
    }
    case 'distortion': {
      const pre = ctx.createGain(), shaper = ctx.createWaveShaper(), post = ctx.createGain();
      shaper.oversample = '4x';
      input.connect(pre).connect(shaper).connect(post).connect(output);
      return {
        input, output,
        set: a => {
          const k = 2 + a * 60;
          shaper.curve = curve(x => ((1 + k) * x) / (1 + k * Math.abs(x)));
          put(pre.gain, 1 + a * 2); put(post.gain, 1 / (1 + a * 1.6));
        },
      };
    }
    case 'lofi': {
      const shaper = ctx.createWaveShaper(), tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      input.connect(shaper).connect(tone).connect(output);
      return {
        input, output,
        set: a => {
          const steps = Math.pow(2, 12 - a * 9); // 12 bits down to 3 bits
          shaper.curve = curve(x => Math.round(x * steps) / steps, 4096);
          put(tone.frequency, 20000 * Math.pow(2, -a * 2.5));
        },
      };
    }
    case 'chorus': {
      const wet = ctx.createGain();
      input.connect(output);
      const lfos = [[0.013, 0.55], [0.019, 0.8]].map(([base, rate]) => {
        const d = ctx.createDelay(0.05), lfo = ctx.createOscillator(), depth = ctx.createGain();
        d.delayTime.value = base; lfo.frequency.value = rate; depth.gain.value = 0.003;
        lfo.connect(depth).connect(d.delayTime); lfo.start();
        input.connect(d).connect(wet);
        return lfo;
      });
      wet.connect(output);
      return { input, output, set: a => put(wet.gain, a * 0.8), cleanup: () => lfos.forEach(l => { try { l.stop(); } catch { /* */ } }) };
    }
    default:
      input.connect(output);
      return { input, output, set: () => {} };
  }
}

/**
 * A layer's effects in order: input → effect 1 → effect 2 → … → output.
 * set(i, amount) changes one effect's amount live.
 */
export function buildChain(ctx, effects = [], bpm = 120) {
  const input = ctx.createGain(), output = ctx.createGain();
  const parts = effects.map(fx => {
    const p = build(ctx, fx, bpm);
    p.set(fx.amount ?? effectInfo(fx.type)?.def ?? 0.5);
    return p;
  });
  let last = input;
  for (const p of parts) { last.connect(p.input); last = p.output; }
  last.connect(output);
  return {
    input, output,
    set: (i, a) => parts[i]?.set(a),
    dispose: () => {
      for (const p of parts) p.cleanup?.();
      for (const n of [input, output, ...parts.flatMap(p => [p.input, p.output])]) { try { n.disconnect(); } catch { /* */ } }
    },
  };
}
