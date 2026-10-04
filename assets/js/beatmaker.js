// STUDIO365 beat maker. Generates an ORIGINAL beat in a chosen key, tempo and style: its own drums, bass,
// chords and melody, synthesized from scratch in the browser. It never copies notes from another recording.
import { SCALES, midiToFreq, dbToGain } from './dsp.js';

export const BEAT_STYLES = {
  trap: { label: 'Trap', about: 'Half-time drums, rolling hats, long 808s, dark bell melody.' },
  drill: { label: 'Drill', about: 'Sliding 808s, skippy triplet hats, cold piano.' },
  boombap: { label: 'Boom bap', about: 'Swung drums, round bass, warm keys.' },
  rnb: { label: 'R&B', about: 'Soft drums, lush chords, slow and smooth.' },
  melodic: { label: 'Melodic', about: 'Bright plucks over bouncy drums and a singing 808.' },
};

function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

// Chord progressions as scale degrees (0 = the key's home chord). One chord per bar, four bars.
const PROG_MINOR = [[0, 5, 2, 6], [0, 6, 5, 6], [0, 3, 5, 4], [0, 5, 3, 4], [0, 2, 5, 6], [0, 0, 5, 6], [0, 3, 6, 5]];
const PROG_MAJOR = [[0, 4, 5, 3], [0, 5, 3, 4], [5, 3, 0, 4], [0, 3, 5, 4], [0, 2, 3, 4], [3, 4, 5, 0]];

// 16 steps per bar. Patterns are lists of step numbers.
const DRUMS = {
  trap: { kick: [[0, 6, 10], [0, 7, 10, 14], [0, 3, 10], [0, 10, 13]], snare: [8], hat: 'eighths', roll: 0.35, swing: 0 },
  drill: { kick: [[0, 7, 10], [0, 5, 10, 13], [0, 3, 7, 10]], snare: [8, 15], snareAlt: [8, 14], hat: 'drill', roll: 0.25, swing: 0 },
  boombap: { kick: [[0, 7, 10], [0, 10], [0, 3, 10], [0, 6, 10, 11]], snare: [4, 12], hat: 'eighths', roll: 0, swing: 0.16 },
  rnb: { kick: [[0, 10], [0, 7, 10], [0, 11]], snare: [4, 12], hat: 'sixteenths-soft', roll: 0.1, swing: 0.08 },
  melodic: { kick: [[0, 6, 10], [0, 3, 10, 12], [0, 7, 10]], snare: [8], hat: 'eighths', roll: 0.3, swing: 0 },
};

// Build the scale as MIDI notes across octaves, and helpers to walk it.
function scaleNotes(root, scaleKey) {
  const sc = SCALES[scaleKey] && SCALES[scaleKey].length >= 5 && SCALES[scaleKey].length < 12 ? SCALES[scaleKey] : SCALES.minor;
  // pentatonic scales make thin chords, so harmony always uses the full seven-note parent scale
  const full = sc.length === 7 ? sc : (scaleKey === 'majorPentatonic' ? SCALES.major : SCALES.minor);
  return { degree: (d, octave) => { const n = full.length; const o = Math.floor(d / n); return 12 * (octave + 1 + o) + root + full[((d % n) + n) % n]; }, isMajor: full === SCALES.major };
}

// Returns Promise<[Float32Array L, Float32Array R]>
// opts: { sr, bpm, root (0-11), scale, style, seconds, seed }
export async function makeBeat({ sr = 48000, bpm = 140, root = 9, scale = 'minor', style = 'trap', seconds = 150, seed = 1, onProgress = null }) {
  const r = rng(seed * 7919 + 13);
  const S = DRUMS[style] || DRUMS.trap;
  const sn = scaleNotes(root, scale);
  // trap and drill are felt in half-time: below 100 BPM the grid runs at double speed so hats still roll
  const grid = (style === 'trap' || style === 'drill' || style === 'melodic') && bpm < 100 ? bpm * 2 : bpm;
  const step = 60 / grid / 4;                 // one 16th note
  const bar = step * 16;
  const bars = Math.max(8, Math.round(seconds / bar / 4) * 4);
  const TAIL = 3;                                  // seconds of ring-out kept after each block
  const noiseData = new Float32Array(sr);
  for (let i = 0; i < sr; i++) noiseData[i] = r() * 2 - 1;
  const sat = (() => { const n = 1024, c = new Float32Array(n); for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(2.2 * x) / Math.tanh(2.2); } return c; })();

  // The song is rendered four bars at a time, each block in its own small context, then laid end to end.
  // One long context would have to carry every future note from the first second, which gets very slow.
  async function renderBlock(blockIndex, plan, song) {
  const { prog, voiced, bassNote, motif, kickA, kickB } = song;
  const r = rng(seed * 104729 + blockIndex * 31 + 7);
  const ctx = new OfflineAudioContext(2, Math.ceil((4 * bar + TAIL) * sr), sr);

  // ---- buses
  const out = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.18; comp.knee.value = 8;
  out.connect(comp).connect(ctx.destination);
  const bus = (gain, pan = 0) => { const g = ctx.createGain(); g.gain.value = gain; const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p).connect(out); return g; };
  const drumBus = bus(0.9), bassBus = bus(0.95), musicBus = bus(0.5), leadBus = bus(0.42);

  // a little room for chords and melody: feedback delay, no samples needed
  const send = ctx.createGain(); send.gain.value = 0.28;
  const dl = ctx.createDelay(1), dr = ctx.createDelay(1), fb = ctx.createGain(), lp = ctx.createBiquadFilter();
  dl.delayTime.value = step * 3; dr.delayTime.value = step * 4; fb.gain.value = 0.33; lp.type = 'lowpass'; lp.frequency.value = 2600;
  const pl = ctx.createStereoPanner(), pr = ctx.createStereoPanner(); pl.pan.value = -0.7; pr.pan.value = 0.7;
  send.connect(lp); lp.connect(dl); lp.connect(dr); dl.connect(pl).connect(out); dr.connect(pr).connect(out); dr.connect(fb).connect(lp);
  musicBus.connect(send); leadBus.connect(send);

  const noise = ctx.createBuffer(1, sr, sr);
  noise.copyToChannel(noiseData, 0);

  // ---- voices
  const kick = (t, v = 1) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(165, t); o.frequency.exponentialRampToValueAtTime(46, t + 0.11);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + (style === 'boombap' ? 0.26 : 0.34));
    o.connect(g).connect(drumBus); o.start(t); o.stop(t + 0.4);
  };
  const burst = (t, dur, type, freq, q, v, dest = drumBus, pan = 0) => {
    const s = ctx.createBufferSource(); s.buffer = noise; s.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    s.connect(f).connect(g).connect(p).connect(dest); s.start(t, r() * 0.5); s.stop(t + dur + 0.02);
  };
  const snare = (t, v = 0.8) => {
    if (style === 'rnb') { burst(t, 0.09, 'bandpass', 2600, 2.5, v * 0.7); return; }                 // snap
    if (style === 'boombap') {                                                                      // snare with body
      const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'triangle';
      o.frequency.setValueAtTime(230, t); o.frequency.exponentialRampToValueAtTime(150, t + 0.08);
      g.gain.setValueAtTime(v * 0.5, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
      o.connect(g).connect(drumBus); o.start(t); o.stop(t + 0.15);
      burst(t, 0.2, 'highpass', 1400, 0.7, v * 0.75); return;
    }
    for (const d of [0, 0.011, 0.023]) burst(t + d, 0.05, 'bandpass', 1500, 1.1, v * 0.55);          // clap
    burst(t + 0.03, 0.22, 'bandpass', 1700, 0.9, v * 0.6);
  };
  const hat = (t, v = 0.3, open = false) => burst(t, open ? 0.28 : 0.04, 'highpass', open ? 6500 : 7600, 0.8, v * 1.7, drumBus, 0.18);
  const sub = (t, dur, midi, slideTo, v = 0.95) => {
    const o = ctx.createOscillator(), g = ctx.createGain(), w = ctx.createWaveShaper();
    const f = midiToFreq(midi);
    o.type = 'sine'; w.curve = sat;
    o.frequency.setValueAtTime(f * 1.6, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.035);
    if (slideTo != null) { o.frequency.setValueAtTime(f, t + dur * 0.55); o.frequency.exponentialRampToValueAtTime(midiToFreq(slideTo), t + dur * 0.92); }
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.008);
    g.gain.setValueAtTime(v, t + Math.max(0.03, dur - 0.06)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.05);
    o.connect(g).connect(w).connect(bassBus); o.start(t); o.stop(t + dur + 0.08);
  };
  const pad = (t, dur, notes, v = 0.11) => {
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 0.8;
    f.frequency.setValueAtTime(500, t); f.frequency.linearRampToValueAtTime(style === 'rnb' ? 1900 : 1300, t + dur * 0.5); f.frequency.linearRampToValueAtTime(600, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + 0.18); g.gain.setValueAtTime(v, t + dur - 0.2); g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.25);
    f.connect(g).connect(musicBus);
    notes.forEach((m, i) => [-7, 7].forEach((cents) => {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midiToFreq(m); o.detune.value = cents + i * 2;
      o.connect(f); o.start(t); o.stop(t + dur + 0.3);
    }));
  };
  const keys = (t, dur, notes, v = 0.2) => notes.forEach((m, i) => {
    const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle'; o2.type = 'sine'; o.frequency.value = midiToFreq(m); o2.frequency.value = midiToFreq(m) * 2;
    const tt = t + i * 0.012;
    g.gain.setValueAtTime(0.0001, tt); g.gain.exponentialRampToValueAtTime(v, tt + 0.006); g.gain.exponentialRampToValueAtTime(v * 0.25, tt + Math.min(dur, 0.5)); g.gain.exponentialRampToValueAtTime(0.0001, tt + dur + 0.15);
    const g2 = ctx.createGain(); g2.gain.value = 0.25;
    o.connect(g); o2.connect(g2).connect(g); g.connect(musicBus); o.start(tt); o2.start(tt); o.stop(tt + dur + 0.2); o2.stop(tt + dur + 0.2);
  });
  const bell = (t, dur, midi, v = 0.22, pan = 0) => {
    const c = ctx.createOscillator(), m = ctx.createOscillator(), mg = ctx.createGain(), g = ctx.createGain(), p = ctx.createStereoPanner();
    const f = midiToFreq(midi);
    c.frequency.value = f; m.frequency.value = f * 3.5; mg.gain.setValueAtTime(f * 1.4, t); mg.gain.exponentialRampToValueAtTime(f * 0.05, t + dur);
    m.connect(mg).connect(c.frequency);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    p.pan.value = pan;
    c.connect(g).connect(p).connect(leadBus); c.start(t); m.start(t); c.stop(t + dur + 0.05); m.stop(t + dur + 0.05);
  };
  const pluck = (t, dur, midi, v = 0.2, pan = 0) => {
    const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain(), p = ctx.createStereoPanner();
    o.type = 'sawtooth'; o.frequency.value = midiToFreq(midi);
    f.type = 'lowpass'; f.Q.value = 3; f.frequency.setValueAtTime(5200, t); f.frequency.exponentialRampToValueAtTime(500, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    p.pan.value = pan;
    o.connect(f).connect(g).connect(p).connect(leadBus); o.start(t); o.stop(t + dur + 0.05);
  };

  for (let b = blockIndex * 4; b < blockIndex * 4 + 4; b++) {
    const sec = plan[blockIndex];
    const t0 = (b - blockIndex * 4) * bar;
    const i4 = b % 4;
    const sw = (s) => t0 + s * step + (s % 2 ? S.swing * step : 0);
    const drums = sec === 'verse' || sec === 'hook';
    const lastOfBlock = i4 === 3;

    // chords
    const cdur = bar * (style === 'drill' ? 0.5 : 1);
    if (style === 'boombap' || style === 'drill') {
      keys(t0, cdur * 0.9, voiced[i4], sec === 'intro' ? 0.22 : 0.17);
      if (style === 'drill') keys(t0 + step * 6, step * 5, voiced[i4].slice(1), 0.12);
      else if (r() < 0.6) keys(sw(10), step * 5, voiced[i4], 0.11);
    } else pad(t0, bar, voiced[i4], sec === 'hook' ? 0.13 : 0.1);

    // melody: verses leave room for the vocal, hooks and the intro carry it
    if (sec !== 'verse' || i4 >= 2 || style === 'melodic') {
      const quiet = sec === 'verse' ? 0.55 : 1;
      for (const { s, d } of motif[i4]) {
        const m = sn.degree(d + (b % 8 >= 4 && s >= 12 ? 1 : 0), 4);
        const pan = ((s % 4) - 1.5) * 0.12;
        if (style === 'melodic') pluck(sw(s), step * 2.4, m, 0.2 * quiet, pan);
        else if (style === 'boombap' || style === 'rnb') bell(sw(s), step * 5, m, 0.13 * quiet, pan);
        else bell(sw(s), step * 4, m, 0.2 * quiet, pan);
        if (sec === 'hook' && style !== 'rnb') bell(sw(s), step * 3, m + 12, 0.06, -pan);
      }
    }

    // bass
    if (drums || sec === 'outro') {
      const kp = b % 2 ? kickB : kickA;
      if (style === 'boombap' || style === 'rnb') {
        const hits = style === 'rnb' ? [0, 10] : [0, 7, 10];
        hits.forEach((s, k) => sub(sw(s), step * (k === hits.length - 1 ? 5 : 3.2), bassNote[i4] + 12 + (k === 1 && r() < 0.4 ? 7 : 0), null, 0.55));
      } else {
        kp.forEach((s, k) => {
          const next = k + 1 < kp.length ? kp[k + 1] : 16;
          const len = Math.min(next - s, 8) * step * 0.96;
          const slide = style === 'drill' && k === kp.length - 1 && r() < 0.7 ? bassNote[(i4 + 1) % 4] + (r() < 0.5 ? 12 : 0) : null;
          sub(t0 + s * step, len, bassNote[i4] + (k > 0 && r() < 0.18 ? 12 : 0), slide);
        });
      }
    }

    // drums
    if (drums) {
      (b % 2 ? kickB : kickA).forEach((s) => kick(sw(s), s === 0 ? 1 : 0.85));
      (lastOfBlock && S.snareAlt && r() < 0.5 ? S.snareAlt : S.snare).forEach((s) => snare(sw(s)));
      const hv = sec === 'hook' ? 0.3 : 0.25;
      if (S.hat === 'eighths') {
        for (let s = 0; s < 16; s += 2) {
          // hat rolls: a burst of faster hits, mostly at the end of a bar
          if (S.roll && r() < S.roll * (s >= 12 ? 1.3 : 0.35)) { const n = pick(r, [3, 4, 6]); for (let k = 0; k < n; k++) hat(t0 + (s + (2 * k) / n) * step, hv * (0.6 + 0.4 * (k / n))); }
          else hat(sw(s), hv * (s % 4 ? 0.75 : 1));
        }
        if (r() < 0.3) hat(sw(14), 0.2, true);
      } else if (S.hat === 'drill') {
        [0, 3, 6, 8, 11, 14].forEach((s) => hat(t0 + s * step, hv));
        if (r() < S.roll + 0.2) for (let k = 0; k < 3; k++) hat(t0 + (12 + (k * 2) / 3) * step, hv * 0.8);
        if (r() < 0.35) hat(t0 + 10 * step, 0.2, true);
      } else {
        for (let s = 0; s < 16; s++) hat(sw(s), hv * (s % 4 === 0 ? 0.9 : s % 2 ? 0.4 : 0.65));
      }
      // fill into the next section
      if (lastOfBlock && plan[blockIndex + 1] && plan[blockIndex + 1] !== sec) for (let k = 0; k < 4; k++) snare(t0 + (14 + k * 0.5) * step, 0.3 + k * 0.12);
    } else if (sec === 'intro' && b % 4 === 3) {
      for (let k = 0; k < 4; k++) hat(t0 + (12 + k) * step, 0.2 + k * 0.04);
    }
  }

  const rendered = await ctx.startRendering();
  return [rendered.getChannelData(0), rendered.getChannelData(1)];
  }

  // ---- the song: written fresh from the seed
  const prog = pick(r, sn.isMajor ? PROG_MAJOR : PROG_MINOR);
  const sevenths = style === 'rnb' || style === 'boombap';
  const chord = (deg) => [0, 2, 4].concat(sevenths ? [6] : []).map((k) => sn.degree(deg + k, 3));
  // keep chords in a comfortable range
  const voiced = prog.map((d) => chord(d).map((m) => { while (m > 67) m -= 12; while (m < 52) m += 12; return m; }).sort((a, b) => a - b));
  const bassNote = prog.map((d) => { let m = sn.degree(d, 1); while (m > 43) m -= 12; while (m < 29) m += 12; return m; });

  // melody: a two-bar idea built from chord and scale tones, then answered with a small change
  const rhythms = {
    trap: [[0, 3, 6, 8, 12], [0, 4, 6, 10, 12, 14], [0, 2, 6, 8, 11, 14]],
    drill: [[0, 3, 6, 9, 12], [0, 2, 4, 8, 11, 14], [0, 6, 8, 10, 14]],
    boombap: [[0, 4, 7, 10], [2, 6, 10, 12], [0, 3, 8, 11]],
    rnb: [[0, 6, 12], [4, 10, 14], [0, 4, 8, 14]],
    melodic: [[0, 2, 4, 6, 8, 10, 12, 14], [0, 3, 6, 8, 11, 14], [0, 2, 6, 8, 10, 14]],
  }[style] || [[0, 4, 8, 12]];
  const motif = [];
  let deg = pick(r, [0, 2, 4]);
  for (let b = 0; b < 4; b++) {
    const rh = pick(r, rhythms);
    const steps = [];
    for (const s of rh) {
      const move = pick(r, [-2, -1, -1, 0, 1, 1, 2]);
      deg = Math.max(-2, Math.min(9, deg + move));
      // land on a chord tone at the top of each bar so the melody always agrees with the harmony
      const d = s === rh[0] ? prog[b] + pick(r, [0, 2, 4]) - (prog[b] > 3 ? 7 : 0) : deg;
      if (s === rh[0]) deg = d;
      steps.push({ s, d });
    }
    motif.push(steps);
  }
  const kickA = pick(r, S.kick), kickB = pick(r, S.kick);

  // sections, in four-bar blocks: intro, verse, hook, verse, hook... outro
  const blocks = bars / 4;
  const plan = [];
  for (let i = 0; i < blocks; i++) {
    if (i === 0) plan.push('intro');
    else if (i === blocks - 1 && blocks > 3) plan.push('outro');
    else plan.push((i - 1) % 6 >= 4 ? 'hook' : 'verse');
  }

  const song = { prog, voiced, bassNote, motif, kickA, kickB };
  const total = Math.ceil((bars * bar + TAIL) * sr);
  const L = new Float32Array(total), R = new Float32Array(total);
  const blockLen = Math.round(4 * bar * sr);
  // a few blocks at a time: the browser renders them side by side
  for (let k = 0; k < blocks; k += 4) {
    const batch = [];
    for (let j = k; j < Math.min(blocks, k + 4); j++) batch.push(renderBlock(j, plan, song).then((ch) => ({ j, ch })));
    for (const { j, ch } of await Promise.all(batch)) {
      const at = j * blockLen;
      for (let i = 0; i < ch[0].length && at + i < total; i++) { L[at + i] += ch[0][i]; R[at + i] += ch[1][i]; }
    }
    if (onProgress) onProgress(Math.min(1, (k + 4) / blocks));
  }
  // trim the tail to the last sound and level to -2 dB peak so it sits like any other beat file
  let end = L.length; const th = dbToGain(-66);
  while (end > sr && Math.abs(L[end - 1]) < th && Math.abs(R[end - 1]) < th) end--;
  end = Math.min(L.length, end + Math.round(sr * 0.2));
  let pk = 0; for (let i = 0; i < end; i++) { const a = Math.max(Math.abs(L[i]), Math.abs(R[i])); if (a > pk) pk = a; }
  const g = pk > 0 ? dbToGain(-2) / pk : 1;
  const l = new Float32Array(end), rr = new Float32Array(end);
  for (let i = 0; i < end; i++) { l[i] = L[i] * g; rr[i] = R[i] * g; }
  return [l, rr];
}
