// Offline mix renderer. Builds the full vocal chain + beat in an OfflineAudioContext and returns stereo channels.
import { dbToGain } from './dsp.js';

const irCache = new Map();
function reverbIR(ctx, seconds = 2.2, predelay = 0.02) {
  const key = `${ctx.sampleRate}-${seconds}`;
  let data = irCache.get(key);
  if (!data) {
    const sr = ctx.sampleRate;
    const len = Math.round(sr * (seconds + predelay));
    const pd = Math.round(sr * predelay);
    data = [new Float32Array(len), new Float32Array(len)];
    let seed = 1337;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
    for (let c = 0; c < 2; c++) {
      let lp = 0;
      for (let i = pd; i < len; i++) {
        const t = (i - pd) / sr;
        const decay = Math.exp(-6.9 * t / seconds);        // -60 dB at `seconds`
        const damp = 0.25 + 0.7 * Math.min(1, t / seconds); // darker tail
        lp += (rnd() - lp) * (1 - damp);
        data[c][i] = lp * decay * 0.5;
      }
    }
    irCache.set(key, data);
  }
  const buf = ctx.createBuffer(2, data[0].length, ctx.sampleRate);
  buf.copyToChannel(data[0], 0); buf.copyToChannel(data[1], 1);
  return buf;
}

function saturationCurve(drive) {
  const n = 2048, curve = new Float32Array(n);
  const k = 1 + drive * 6;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(k * x) / norm; }
  return curve;
}

export const DEFAULT_MIX = {
  vocalDb: 0, pan: 0, hpf: 90, body: 0, presence: 2, air: 2, sibilance: 3, comp: 45,
  warmth: 15, reverb: 18, delay: 8, beatDb: -3, vocalOffsetMs: 0,
};

// channels: beat stereo Float32Array[] | null, vocal: Float32Array | null
export async function renderMix({ sr, beat, vocal, mix, bpm = 90, vocalOnly = false }) {
  const m = { ...DEFAULT_MIX, ...mix };
  const offset = (m.vocalOffsetMs || 0) / 1000;
  const beatLen = beat && !vocalOnly ? beat[0].length : 0;
  const vocLen = vocal ? vocal.length + Math.max(0, Math.round(offset * sr)) : 0;
  const tail = vocal ? Math.round(sr * 2.5) : 0;
  const length = Math.max(beatLen, vocLen + tail, sr);
  const ctx = new OfflineAudioContext(2, length, sr);
  const bus = ctx.createGain();

  // gentle glue compression on the two-bus
  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -16; glue.ratio.value = 2; glue.attack.value = 0.02; glue.release.value = 0.2; glue.knee.value = 10;
  bus.connect(glue).connect(ctx.destination);

  if (beat && !vocalOnly) {
    const b = ctx.createBuffer(beat.length, beat[0].length, sr);
    beat.forEach((ch, i) => b.copyToChannel(ch, i));
    const src = ctx.createBufferSource(); src.buffer = b;
    const g = ctx.createGain(); g.gain.value = dbToGain(m.beatDb);
    src.connect(g).connect(bus);
    src.start(0);
  }

  if (vocal) {
    const vb = ctx.createBuffer(1, vocal.length, sr);
    vb.copyToChannel(vocal, 0);
    const src = ctx.createBufferSource(); src.buffer = vb;

    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = m.hpf; hp.Q.value = 0.707;
    const body = ctx.createBiquadFilter(); body.type = 'peaking'; body.frequency.value = 240; body.Q.value = 1; body.gain.value = m.body;
    const mud = ctx.createBiquadFilter(); mud.type = 'peaking'; mud.frequency.value = 450; mud.Q.value = 1.4; mud.gain.value = -1.5;
    const pres = ctx.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 3200; pres.Q.value = 0.9; pres.gain.value = m.presence;
    const sib = ctx.createBiquadFilter(); sib.type = 'peaking'; sib.frequency.value = 6800; sib.Q.value = 3; sib.gain.value = -m.sibilance;
    const air = ctx.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 10000; air.gain.value = m.air;

    const comp = ctx.createDynamicsCompressor();
    const c = m.comp / 100;
    comp.threshold.value = -8 - c * 30; comp.ratio.value = 1.5 + c * 6; comp.attack.value = 0.004; comp.release.value = 0.12; comp.knee.value = 8;
    const makeup = ctx.createGain(); makeup.gain.value = dbToGain(c * 9);

    const w = m.warmth / 100;
    const shaper = ctx.createWaveShaper(); shaper.curve = saturationCurve(w); shaper.oversample = '4x';
    const dry = ctx.createGain(); dry.gain.value = 1 - w * 0.6;
    const wet = ctx.createGain(); wet.gain.value = w * 0.6;
    const post = ctx.createGain();

    const level = ctx.createGain(); level.gain.value = dbToGain(m.vocalDb);
    const pan = ctx.createStereoPanner(); pan.pan.value = m.pan / 100;

    src.connect(hp).connect(mud).connect(body).connect(pres).connect(sib).connect(air).connect(comp).connect(makeup);
    makeup.connect(dry).connect(post);
    makeup.connect(shaper).connect(wet).connect(post);
    post.connect(level).connect(pan).connect(bus);

    // reverb send
    if (m.reverb > 0) {
      const send = ctx.createGain(); send.gain.value = Math.pow(m.reverb / 100, 1.5) * 0.9;
      const rhp = ctx.createBiquadFilter(); rhp.type = 'highpass'; rhp.frequency.value = 220;
      const conv = ctx.createConvolver(); conv.buffer = reverbIR(ctx);
      level.connect(send).connect(rhp).connect(conv).connect(bus);
    }
    // eighth-note delay send, darkening repeats
    if (m.delay > 0) {
      const send = ctx.createGain(); send.gain.value = Math.pow(m.delay / 100, 1.3) * 0.7;
      const d = ctx.createDelay(4); d.delayTime.value = Math.min(3.9, 60 / Math.max(40, bpm) / 2);
      const fb = ctx.createGain(); fb.gain.value = 0.32;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3800;
      const dhp = ctx.createBiquadFilter(); dhp.type = 'highpass'; dhp.frequency.value = 300;
      level.connect(send).connect(dhp).connect(d).connect(lp).connect(fb).connect(d);
      lp.connect(bus);
    }

    if (offset >= 0) src.start(offset);
    else src.start(0, Math.min(-offset, vocal.length / sr));
  }

  const rendered = await ctx.startRendering();
  return [rendered.getChannelData(0).slice(), rendered.getChannelData(1).slice()];
}

// Suggest a vocal level that sits the vocal ~1.5 dB above the beat's midrange energy.
export function balanceVocal(beat, vocal, sr) {
  if (!beat || !vocal) return 0;
  const band = (x) => {
    // crude 300 Hz – 4 kHz band energy via difference of one-pole filters
    let lp1 = 0, lp2 = 0, acc = 0, n = 0;
    const a1 = 1 - Math.exp(-2 * Math.PI * 4000 / sr), a2 = 1 - Math.exp(-2 * Math.PI * 300 / sr);
    for (let i = 0; i < x.length; i += 1) {
      lp1 += (x[i] - lp1) * a1; lp2 += (x[i] - lp2) * a2;
      const v = lp1 - lp2;
      if (Math.abs(x[i]) > 0.01) { acc += v * v; n++; }
    }
    return Math.sqrt(acc / Math.max(1, n));
  };
  const beatMono = new Float32Array(beat[0].length);
  for (const ch of beat) for (let i = 0; i < ch.length; i++) beatMono[i] += ch[i] / beat.length;
  const vb = band(vocal), bb = band(beatMono);
  if (!vb || !bb) return 0;
  const db = 20 * Math.log10(bb / vb) + 1.5;
  return Math.max(-18, Math.min(18, Math.round(db * 2) / 2));
}
