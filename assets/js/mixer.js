// The STUDIO365 console. One signal path, built two ways: live in the browser's audio engine while you
// listen (faders, mutes and EQ answer instantly, meters move), and offline when a mix is bounced or exported.
import { dbToGain } from './dsp.js';

// ---------------------------------------------------------------- settings
export const DELAY_NOTES = {
  '1/4': { label: 'Quarter note', beats: 1 },
  '1/8d': { label: 'Dotted eighth', beats: 0.75 },
  '1/4t': { label: 'Quarter triplet', beats: 2 / 3 },
  '1/8': { label: 'Eighth note', beats: 0.5 },
  '1/8t': { label: 'Eighth triplet', beats: 1 / 3 },
  '1/16': { label: 'Sixteenth note', beats: 0.25 },
};

export const DEFAULT_MIX = {
  // vocal channel
  vocalDb: 0, pan: 0, vocalOffsetMs: 0, gate: 0,
  hpf: 90, lpf: 20000,
  body: 0, bodyHz: 240, bodyQ: 1,
  mud: -1.5, mudHz: 450, mudQ: 1.4,
  presence: 2, presHz: 3200, presQ: 0.9,
  air: 2, airHz: 10000,
  sibilance: 3, deessHz: 6800,
  compOn: true, compThr: -21.5, compRatio: 4.2, compAtk: 4, compRel: 120, compMakeup: 9, comp: 45,
  warmth: 15, reverb: 18, delay: 8,
  // stack bus (doubles, harmony, stacked takes)
  stackDb: 0,
  // beat channel
  beatDb: -3, beatPan: 0, beatLow: 0, beatMid: 0, beatHigh: 0,
  // reverb unit
  revDb: 0, revDecay: 2.2, revPre: 20, revTone: 9000, revLowCut: 220,
  // echo unit
  delayDb: 0, delayNote: '1/8', delayFb: 32, delayTone: 3800, delayWide: 0,
  // mix bus
  glue: 35, masterDb: 0,
  // mute and solo. Mutes are part of the mix and export; solos are for listening and are never saved.
  mute: { vocal: false, stack: false, beat: false, rev: false, delay: false },
  solo: { vocal: false, stack: false, beat: false },
};

// The old one-knob compression amount, turned into real compressor settings.
export function compFromMacro(c) {
  const k = Math.max(0, Math.min(100, c)) / 100;
  const thr = -8 - k * 30, ratio = 1.5 + k * 6;
  return {
    compThr: Math.round(thr * 2) / 2, compRatio: Math.round(ratio * 10) / 10, compAtk: 4, compRel: 120,
    compMakeup: Math.round(-thr * (1 - 1 / ratio) * 0.55 * 2) / 2, compOn: k > 0,
  };
}

// Bring a mix saved by an older version (or a preset) up to the full console.
export function migrateMix(mix = {}) {
  const m = { ...DEFAULT_MIX, ...mix };
  if (mix.compThr == null && mix.comp != null) Object.assign(m, compFromMacro(mix.comp));
  m.mute = { ...DEFAULT_MIX.mute, ...(mix.mute || {}) };
  m.solo = { ...DEFAULT_MIX.solo };
  return m;
}

// Is this channel audible given the mutes and solos?
export function audible(m, ch) {
  if (m.mute && m.mute[ch]) return false;
  const s = m.solo || {};
  if (ch in DEFAULT_MIX.solo && (s.vocal || s.stack || s.beat)) return !!s[ch];
  return true;
}

// ---------------------------------------------------------------- shared pieces
const irCache = new Map();
function reverbIR(ctx, seconds = 2.2) {
  const secs = Math.round(Math.max(0.3, Math.min(8, seconds)) * 10) / 10;
  const key = `${ctx.sampleRate}-${secs}`;
  let data = irCache.get(key);
  if (!data) {
    const sr = ctx.sampleRate;
    const len = Math.round(sr * secs);
    data = [new Float32Array(len), new Float32Array(len)];
    let seed = 1337;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
    // keep the tail's loudness steady as it gets longer or shorter
    const norm = 0.5 * Math.sqrt(2.2 / secs);
    for (let c = 0; c < 2; c++) {
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const decay = Math.exp(-6.9 * t / secs);          // -60 dB at `secs`
        const damp = 0.25 + 0.7 * Math.min(1, t / secs);  // darker tail
        lp += (rnd() - lp) * (1 - damp);
        data[c][i] = lp * decay * norm;
      }
    }
    if (irCache.size > 12) irCache.delete(irCache.keys().next().value);
    irCache.set(key, data);
  }
  const buf = ctx.createBuffer(2, data[0].length, ctx.sampleRate);
  buf.copyToChannel(data[0], 0); buf.copyToChannel(data[1], 1);
  return buf;
}

const curveCache = new Map();
function saturationCurve(drive) {
  const key = Math.round(drive * 100);
  if (curveCache.has(key)) return curveCache.get(key);
  const n = 2048, curve = new Float32Array(n);
  const k = 1 + drive * 6;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(k * x) / norm; }
  curveCache.set(key, curve);
  return curve;
}

const WORKLET_URL = new URL('./strip-worklet.js', import.meta.url);
const workletReady = new WeakMap();
async function loadWorklet(ctx) {
  if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return false;
  if (!workletReady.has(ctx)) workletReady.set(ctx, ctx.audioWorklet.addModule(WORKLET_URL).then(() => true, (e) => { console.warn('Console processors unavailable, using built-in ones.', e); return false; }));
  return workletReady.get(ctx);
}

// A compressor with honest numbers. Falls back to the browser's own if the worklet can't load.
function makeComp(ctx, wk, channels) {
  if (wk) {
    const node = new AudioWorkletNode(ctx, 'studio365-comp', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [channels], channelCount: channels, channelCountMode: 'explicit' });
    const P = node.parameters;
    const c = { input: node, output: node, gr: 0, set(s, put) {
      put(P.get('threshold'), s.on ? s.thr : 0); put(P.get('ratio'), s.on ? s.ratio : 1);
      put(P.get('attack'), s.atk / 1000); put(P.get('release'), s.rel / 1000); put(P.get('knee'), s.knee ?? 6); put(P.get('makeup'), s.on ? s.makeup : 0);
    } };
    node.port.onmessage = (e) => { c.gr = e.data; };
    return c;
  }
  const node = ctx.createDynamicsCompressor(), post = ctx.createGain();
  node.connect(post);
  return { input: node, output: post, get gr() { return node.reduction || 0; }, set(s, put) {
    const thr = s.on ? s.thr : 0, ratio = s.on ? s.ratio : 1;
    put(node.threshold, thr); put(node.ratio, ratio); put(node.attack, s.atk / 1000); put(node.release, s.rel / 1000); put(node.knee, s.knee ?? 6);
    // the built-in compressor adds its own make-up gain; take it back out so the knob stays honest
    put(post.gain, dbToGain((s.on ? s.makeup : 0) + 0.6 * thr * (1 - 1 / ratio)));
  } };
}

// ---------------------------------------------------------------- the console
// Returns a graph with inputs for the lead vocal, the beat and any number of stacked voices.
export async function createGraph(ctx, { live = false } = {}) {
  const wk = await loadWorklet(ctx);
  const put = live
    ? (param, v) => { param.cancelScheduledValues(ctx.currentTime); param.setTargetAtTime(v, ctx.currentTime, 0.012); }
    : (param, v) => { param.value = v; };
  const gain = (v = 1) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const biq = (type, f, q = 0.707, g = 0) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = g; return b; };

  // ---- mix bus
  const bus = gain();
  const glue = makeComp(ctx, wk, 2);
  const masterTrim = gain();
  bus.connect(glue.input); glue.output.connect(masterTrim);
  let out = masterTrim, limiter = null;
  if (live) {
    if (wk) {
      limiter = new AudioWorkletNode(ctx, 'studio365-limiter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
      limiter.gr = 0; limiter.port.onmessage = (e) => { limiter.gr = e.data; };
      masterTrim.connect(limiter); out = limiter;
    } else {
      const lg = gain(), lc = ctx.createDynamicsCompressor();
      lc.threshold.value = -1.5; lc.ratio.value = 20; lc.knee.value = 0; lc.attack.value = 0.001; lc.release.value = 0.09;
      masterTrim.connect(lg).connect(lc);
      limiter = { fallback: lg, comp: lc, get gr() { return lc.reduction || 0; } }; out = lc;
    }
  }
  out.connect(ctx.destination);

  // ---- reverb unit (one room shared by the lead and every stacked voice)
  const revIn = gain();
  const revHp = biq('highpass', 220);
  const revPre = ctx.createDelay(0.5);
  const conv = ctx.createConvolver();
  const revTone = biq('lowpass', 9000, 0.5);
  const revRet = gain();
  revIn.connect(revHp).connect(revPre).connect(conv).connect(revTone).connect(revRet).connect(bus);
  let irSecs = null;

  // ---- echo unit: two taps that can bounce side to side
  const dlyIn = gain();
  const dlyHp = biq('highpass', 300);
  const d1 = ctx.createDelay(4), d2 = ctx.createDelay(4);
  const lp1 = biq('lowpass', 3800, 0.5), lp2 = biq('lowpass', 3800, 0.5);
  const fb1 = gain(0.32), fb2 = gain(0.32);
  const pA = ctx.createStereoPanner(), pB = ctx.createStereoPanner();
  const dlyRet = gain();
  dlyIn.connect(dlyHp).connect(d1).connect(lp1);
  lp1.connect(pA).connect(dlyRet); lp1.connect(fb1).connect(d2).connect(lp2);
  lp2.connect(pB).connect(dlyRet); lp2.connect(fb2).connect(d1);
  dlyRet.connect(bus);

  // ---- lead vocal channel
  const lead = gain();
  const hp = biq('highpass', 90);
  const eqBody = biq('peaking', 240, 1), eqMud = biq('peaking', 450, 1.4), eqPres = biq('peaking', 3200, 0.9), eqAir = biq('highshelf', 10000);
  const lp = biq('lowpass', 20000);
  let deess, deessSet;
  if (wk) {
    deess = new AudioWorkletNode(ctx, 'studio365-deess', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
    deess.gr = 0; deess.port.onmessage = (e) => { deess.gr = e.data; };
    deessSet = (m) => { put(deess.parameters.get('freq'), m.deessHz); put(deess.parameters.get('amount'), m.sibilance * 1.6); };
  } else {
    deess = biq('peaking', 6800, 3); deess.gr = 0;
    deessSet = (m) => { put(deess.frequency, m.deessHz); put(deess.gain, -m.sibilance); };
  }
  const comp = makeComp(ctx, wk, 1);
  const shaper = ctx.createWaveShaper(); shaper.oversample = '4x';
  const dry = gain(), wet = gain(), post = gain();
  const fader = gain(), vGate = gain();
  const vPan = ctx.createStereoPanner();
  const vOut = gain();
  lead.connect(hp).connect(eqMud).connect(eqBody).connect(eqPres).connect(eqAir).connect(lp).connect(deess).connect(comp.input);
  comp.output.connect(dry).connect(post);
  comp.output.connect(shaper).connect(wet).connect(post);
  post.connect(fader).connect(vGate).connect(vPan).connect(vOut).connect(bus);
  const vRev = gain(0), vDly = gain(0);
  vGate.connect(vRev).connect(revIn);
  vGate.connect(vDly).connect(dlyIn);
  let warmth = null;

  // ---- stack bus
  const stackBus = gain(), stackOut = gain();
  stackBus.connect(stackOut).connect(bus);
  const stackRev = gain();
  stackBus.connect(stackRev).connect(revIn);
  const layerNodes = [];
  let layerHp = 140, layerAir = 0;

  // ---- beat channel
  const beat = gain();
  const bLow = biq('lowshelf', 110), bMid = biq('peaking', 2800, 0.8), bHigh = biq('highshelf', 8000);
  const bFader = gain(), bPan = ctx.createStereoPanner(), bOut = gain();
  beat.connect(bLow).connect(bMid).connect(bHigh).connect(bFader).connect(bPan).connect(bOut).connect(bus);

  // ---- meters (live only)
  const meters = {};
  const fx = {};
  if (live) {
    const tap = (node, size = 1024) => { const a = ctx.createAnalyser(); a.fftSize = size; a.smoothingTimeConstant = 0.7; node.connect(a); return a; };
    meters.vocal = tap(vOut, 2048); meters.stack = tap(stackOut); meters.beat = tap(bOut); meters.rev = tap(revRet); meters.delay = tap(dlyRet);
    const split = ctx.createChannelSplitter(2);
    out.connect(split);
    const l = ctx.createAnalyser(), r = ctx.createAnalyser(); l.fftSize = r.fftSize = 1024;
    split.connect(l, 0); split.connect(r, 1);
    meters.masterL = l; meters.masterR = r;
    fx.eq = tap(post, 2048); // spectrum under the EQ curve
  }

  const G = {
    ctx, live, worklet: wk, meters, fx,
    inputs: { lead, beat },
    reduction: () => ({ comp: comp.gr || 0, deess: deess.gr || 0, glue: glue.gr || 0, limiter: limiter ? limiter.gr || 0 : 0 }),

    // A stacked voice gets a light chain of its own and feeds the stack bus.
    addLayer({ db = -8, pan = 0 } = {}) {
      const input = gain();
      const h = biq('highpass', layerHp);
      const dip = biq('peaking', 3000, 0.8, -2.5);
      const air = biq('highshelf', 9000, 0.707, layerAir);
      const c = ctx.createDynamicsCompressor();
      c.threshold.value = -26; c.ratio.value = 5; c.attack.value = 0.005; c.release.value = 0.14; c.knee.value = 8;
      const level = gain(dbToGain(db));
      const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan / 100));
      input.connect(h).connect(dip).connect(air).connect(c).connect(level).connect(p).connect(stackBus);
      layerNodes.push({ input, h, air, p });
      return input;
    },
    clearLayers() { for (const l of layerNodes) { try { l.p.disconnect(); } catch { /* gone */ } } layerNodes.length = 0; },

    // Push every setting onto the graph. Safe to call on every fader move.
    update(mix, bpm = 90) {
      const m = mix;
      const on = (ch) => (audible(m, ch) ? 1 : 0);
      // vocal
      put(hp.frequency, m.hpf);
      put(eqBody.frequency, m.bodyHz); put(eqBody.Q, m.bodyQ); put(eqBody.gain, m.body);
      put(eqMud.frequency, m.mudHz); put(eqMud.Q, m.mudQ); put(eqMud.gain, m.mud);
      put(eqPres.frequency, m.presHz); put(eqPres.Q, m.presQ); put(eqPres.gain, m.presence);
      put(eqAir.frequency, m.airHz); put(eqAir.gain, m.air);
      put(lp.frequency, Math.min(m.lpf, ctx.sampleRate / 2 - 200));
      deessSet(m);
      comp.set({ on: m.compOn, thr: m.compThr, ratio: m.compRatio, atk: m.compAtk, rel: m.compRel, makeup: m.compMakeup, knee: 8 }, put);
      const w = m.warmth / 100;
      if (warmth !== m.warmth) { shaper.curve = saturationCurve(w); warmth = m.warmth; }
      put(dry.gain, 1 - w * 0.6); put(wet.gain, w * 0.6);
      put(fader.gain, dbToGain(m.vocalDb)); put(vGate.gain, on('vocal')); put(vPan.pan, m.pan / 100);
      put(vRev.gain, m.reverb > 0 ? Math.pow(m.reverb / 100, 1.5) * 0.9 : 0);
      put(vDly.gain, m.delay > 0 ? Math.pow(m.delay / 100, 1.3) * 0.7 : 0);
      // stack rides with the lead fader, then its own trim
      put(stackBus.gain, dbToGain(m.vocalDb + 4 + m.stackDb) * on('stack'));
      put(stackRev.gain, Math.pow(Math.max(m.reverb, 14) / 100, 1.5) * 1.1);
      layerHp = Math.max(140, m.hpf); layerAir = Math.max(0, m.air);
      for (const l of layerNodes) { put(l.h.frequency, layerHp); put(l.air.gain, layerAir); }
      // beat
      put(bLow.gain, m.beatLow); put(bMid.gain, m.beatMid); put(bHigh.gain, m.beatHigh);
      put(bFader.gain, dbToGain(m.beatDb) * on('beat')); put(bPan.pan, m.beatPan / 100);
      // reverb
      put(revHp.frequency, m.revLowCut); put(revPre.delayTime, m.revPre / 1000); put(revTone.frequency, m.revTone);
      put(revRet.gain, dbToGain(m.revDb) * on('rev'));
      const secs = Math.round(m.revDecay * 10) / 10;
      if (irSecs !== secs) { conv.buffer = reverbIR(ctx, secs); irSecs = secs; }
      // echo
      const beats = (DELAY_NOTES[m.delayNote] || DELAY_NOTES['1/8']).beats;
      const t = Math.min(3.9, Math.max(0.02, (60 / Math.max(40, bpm)) * beats));
      put(d1.delayTime, t); put(d2.delayTime, t);
      const f = Math.min(0.9, m.delayFb / 100);
      put(fb1.gain, f); put(fb2.gain, f);
      put(lp1.frequency, m.delayTone); put(lp2.frequency, m.delayTone);
      put(pA.pan, -m.delayWide / 100); put(pB.pan, m.delayWide / 100);
      put(dlyRet.gain, dbToGain(m.delayDb) * on('delay'));
      // bus
      const g = m.glue / 100;
      const thr = -8 - g * 14;
      glue.set({ on: g > 0, thr, ratio: 2, atk: 20, rel: 200, knee: 10, makeup: -thr * 0.5 * 0.4 }, put);
      put(masterTrim.gain, dbToGain(m.masterDb));
    },

    // Live monitor level: the gain the last mastering pass asked for, then a limiter at the ceiling.
    setMaster({ on = true, gainDb = 0, ceiling = -1 } = {}) {
      if (!limiter) return;
      const g = on ? gainDb : 0, c = on ? ceiling : -0.3;
      if (limiter.parameters) { limiter.parameters.get('gain').value = g; limiter.parameters.get('ceiling').value = c; }
      else limiter.fallback.gain.setTargetAtTime(dbToGain(g - 0.6), ctx.currentTime, 0.2);
    },
  };
  return G;
}

// ---------------------------------------------------------------- offline bounce
// beat: stereo Float32Array[] | null, vocal: Float32Array | null (the lead)
// layers: extra voices stacked behind the lead: [{ audio: Float32Array, offsetMs, db, pan (-100..100) }]
export async function renderMix({ sr, beat, vocal, mix, bpm = 90, vocalOnly = false, layers = [] }) {
  const m = migrateMix(mix);
  if (vocalOnly) { m.solo = { ...DEFAULT_MIX.solo }; m.mute = { ...m.mute, vocal: false, stack: false }; }
  const offset = (m.vocalOffsetMs || 0) / 1000;
  const beatLen = beat && !vocalOnly ? beat[0].length : 0;
  let vocLen = vocal ? vocal.length + Math.max(0, Math.round(offset * sr)) : 0;
  for (const l of layers) vocLen = Math.max(vocLen, l.audio.length + Math.max(0, Math.round((l.offsetMs || 0) / 1000 * sr)));
  const tail = vocal || layers.length ? Math.round(sr * Math.max(2.5, m.revDecay + 0.5)) : 0;
  const length = Math.max(beatLen, vocLen + tail, sr);
  const ctx = new OfflineAudioContext(2, length, sr);
  const G = await createGraph(ctx);
  G.update(m, bpm);
  const startAt = (src, len, off) => { if (off >= 0) src.start(off); else src.start(0, Math.min(-off, len / sr)); };

  if (beat && !vocalOnly) {
    const b = ctx.createBuffer(beat.length, beat[0].length, sr);
    beat.forEach((ch, i) => b.copyToChannel(ch, i));
    const src = ctx.createBufferSource(); src.buffer = b;
    src.connect(G.inputs.beat); src.start(0);
  }
  for (const l of layers) {
    const lb = ctx.createBuffer(1, l.audio.length, sr);
    lb.copyToChannel(l.audio, 0);
    const src = ctx.createBufferSource(); src.buffer = lb;
    src.connect(G.addLayer({ db: l.db ?? -8, pan: l.pan || 0 }));
    startAt(src, l.audio.length, (l.offsetMs || 0) / 1000);
  }
  G.update(m, bpm);
  if (vocal) {
    const vb = ctx.createBuffer(1, vocal.length, sr);
    vb.copyToChannel(vocal, 0);
    const src = ctx.createBufferSource(); src.buffer = vb;
    src.connect(G.inputs.lead);
    startAt(src, vocal.length, offset);
  }
  const rendered = await ctx.startRendering();
  return [rendered.getChannelData(0).slice(), rendered.getChannelData(1).slice()];
}
