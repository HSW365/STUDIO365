// STUDIO365 DSP core — pure functions, no DOM. Runs in the browser and in Node (tests).
// Pitch detection (YIN), scale-aware pitch correction (WSOLA-aligned granular shifter),
// key detection (chroma + Krumhansl profiles), ITU-R BS.1770 loudness, lookahead limiter, WAV encoding.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  minorPentatonic: [0, 3, 5, 7, 10],
  majorPentatonic: [0, 2, 4, 7, 9],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

export const SCALE_LABELS = {
  major: 'Major',
  minor: 'Minor',
  harmonicMinor: 'Harmonic minor',
  minorPentatonic: 'Minor pentatonic',
  majorPentatonic: 'Major pentatonic',
  chromatic: 'Chromatic',
};

export const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);
export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const midiName = (m) => NOTE_NAMES[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);
export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(g, 1e-12));

// ---------------------------------------------------------------- mono / mix helpers
export function toMono(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (let c = 0; c < channels.length; c++) {
    const ch = channels[c];
    for (let i = 0; i < n; i++) out[i] += ch[i];
  }
  const k = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

export function peak(channels) {
  let p = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > p) p = a; }
  return p;
}

export function rms(x, start = 0, end = x.length) {
  let s = 0;
  for (let i = start; i < end; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, end - start));
}

// ---------------------------------------------------------------- YIN pitch detection
// Returns { hop, times: Float32Array (s), f0: Float32Array (Hz, 0 = unvoiced), conf: Float32Array }
export function detectPitch(x0, sr0, opts = {}) {
  // Analyse at ~16 kHz: vocal fundamentals sit far below 8 kHz and it cuts the cost ~9x.
  const q = sr0 > 24000 ? Math.floor(sr0 / 16000) : 1;
  if (q > 1 && !opts._decimated) {
    const lp = biquadCoeffs('lowpass', (sr0 / q) * 0.42, sr0, 0.7071);
    const f = biquad(biquad(x0, lp), lp);
    const y = new Float32Array(Math.floor(x0.length / q));
    for (let i = 0; i < y.length; i++) y[i] = f[i * q];
    const hopOrig = opts.hop ?? Math.round(sr0 * 0.005);
    const r = detectPitch(y, sr0 / q, { ...opts, hop: Math.max(1, Math.round(hopOrig / q)), _decimated: true });
    return { ...r, hop: r.hop * q, win: r.win * q, sr: sr0 };
  }
  const x = x0, sr = sr0;
  const fmin = opts.fmin ?? 70;
  const fmax = opts.fmax ?? 1000;
  const hop = opts.hop ?? Math.round(sr * 0.005);            // 5 ms
  const win = opts.win ?? nextPow2(Math.round(sr / fmin) * 2); // ≥ 2 periods of lowest note
  const threshold = opts.threshold ?? 0.15;
  const minLag = Math.max(2, Math.floor(sr / fmax));
  const maxLag = Math.min(Math.floor(win / 2), Math.ceil(sr / fmin));
  const frames = Math.max(0, Math.floor((x.length - win) / hop) + 1);
  const f0 = new Float32Array(frames);
  const conf = new Float32Array(frames);
  const times = new Float32Array(frames);
  const d = new Float32Array(maxLag + 1);
  const W = win - maxLag;

  // Energy gate relative to the loudest region of the take.
  let gmax = 0;
  const e = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const s = f * hop;
    let acc = 0;
    for (let i = 0; i < win; i += 2) acc += x[s + i] * x[s + i];
    e[f] = Math.sqrt(acc / (win / 2));
    if (e[f] > gmax) gmax = e[f];
  }
  const gate = Math.max(gmax * 0.03, 1e-4);

  for (let f = 0; f < frames; f++) {
    const s = f * hop;
    times[f] = (s + win / 2) / sr;
    if (e[f] < gate) continue;
    // difference function (stride-2 inner loop keeps this fast for long takes)
    for (let tau = minLag; tau <= maxLag; tau++) {
      let acc = 0;
      for (let i = 0; i < W; i += 2) { const v = x[s + i] - x[s + i + tau]; acc += v * v; }
      d[tau] = acc;
    }
    // cumulative mean normalised difference
    let run = 0;
    for (let tau = 1; tau < minLag; tau++) {
      let acc = 0;
      for (let i = 0; i < W; i += 2) { const v = x[s + i] - x[s + i + tau]; acc += v * v; }
      run += acc;
    }
    let best = -1;
    let bestVal = 1;
    for (let tau = minLag; tau <= maxLag; tau++) {
      run += d[tau];
      const cm = run > 0 ? (d[tau] * tau) / run : 1;
      d[tau] = cm;
    }
    // Every dip under the threshold is a candidate period. Take the earliest one that is nearly as deep as
    // the deepest: a strong second harmonic makes a shallow dip at half the period, and jumping to it
    // would throw the note up an octave.
    let deep = threshold;
    for (let tau = minLag + 1; tau < maxLag; tau++) if (d[tau] < deep && d[tau] <= d[tau - 1] && d[tau] <= d[tau + 1]) deep = d[tau];
    if (deep < threshold) {
      const ok = deep + 0.035;
      for (let tau = minLag + 1; tau < maxLag; tau++) {
        if (d[tau] <= ok && d[tau] <= d[tau - 1] && d[tau] <= d[tau + 1]) { best = tau; bestVal = d[tau]; break; }
      }
    }
    if (best < 0) continue;
    // parabolic interpolation
    const a = d[best - 1], b = d[best], c = d[best + 1];
    const den = a - 2 * b + c;
    const shift = den !== 0 ? 0.5 * (a - c) / den : 0;
    const period = best + Math.max(-1, Math.min(1, shift));
    f0[f] = sr / period;
    conf[f] = 1 - bestVal;
  }
  cleanPitchTrack(f0);
  return { hop, win, sr, times, f0, conf };
}

// Median filter + octave-jump repair + drop isolated blips.
function cleanPitchTrack(f0) {
  const n = f0.length;
  const m = new Float32Array(n);
  for (let i = 0; i < n; i++) m[i] = f0[i] > 0 ? freqToMidi(f0[i]) : 0;
  // octave repair against local median
  const out = new Float32Array(n);
  const buf = [];
  for (let i = 0; i < n; i++) {
    if (!m[i]) continue;
    buf.length = 0;
    for (let k = i - 7; k <= i + 7; k++) if (k >= 0 && k < n && m[k]) buf.push(m[k]);
    buf.sort((p, q) => p - q);
    const med = buf[buf.length >> 1];
    let v = m[i];
    while (v - med > 7) v -= 12;
    while (med - v > 7) v += 12;
    out[i] = v;
  }
  // 5-point median smoothing of voiced runs
  for (let i = 0; i < n; i++) {
    if (!out[i]) { f0[i] = 0; continue; }
    buf.length = 0;
    for (let k = i - 2; k <= i + 2; k++) if (k >= 0 && k < n && out[k]) buf.push(out[k]);
    buf.sort((p, q) => p - q);
    f0[i] = midiToFreq(buf[buf.length >> 1]);
  }
  // remove voiced runs shorter than 30 ms (6 frames)
  let i = 0;
  while (i < n) {
    if (!f0[i]) { i++; continue; }
    let j = i;
    while (j < n && f0[j]) j++;
    if (j - i < 6) for (let k = i; k < j; k++) f0[k] = 0;
    i = j;
  }
}

// ---------------------------------------------------------------- scale snapping
// mask: optional array of 12 booleans (pitch classes C..B that are allowed). Overrides the scale when given.
export function snapToScale(midi, root, scaleKey, mask = null) {
  const scale = SCALES[scaleKey] || SCALES.chromatic;
  const ok = mask && mask.some(Boolean)
    ? (n) => mask[((n % 12) + 12) % 12]
    : (n) => scale.includes((((n - root) % 12) + 12) % 12);
  let best = Math.round(midi), bestDist = Infinity;
  const base = Math.floor(midi) - 12;
  for (let n = base; n <= base + 24; n++) {
    if (!ok(n)) continue;
    const dist = Math.abs(n - midi);
    if (dist < bestDist) { bestDist = dist; best = n; }
  }
  return best;
}

// Build the per-frame correction curve (in semitones) from a pitch track.
//   speedMs      0 = hard/robotic, higher = more natural glide into the note
//   amount       0..1 how much of the correction is applied
//   keepVibrato  0..1 how much of the singer's own vibrato survives
//   humanize     0..1 held notes get a slower retune so they keep their life; short notes stay tight
//   flex         0..1 leave bends and slides alone when the singer is far from a note
//   glideMs      how long the target takes to slide from one note to the next
//   transpose    whole-take shift in semitones, detune in cents (reference pitch)
//   mask         12 allowed pitch classes, overrides the scale
//   edits        [{ a, b, note | off }] in seconds from the start of the take: hand-placed notes
export function correctionCurve(track, {
  root = 0, scale = 'minor', speedMs = 20, amount = 1, keepVibrato = 0.3,
  humanize = 0, flex = 0, glideMs = 0, transpose = 0, detune = 0, mask = null, edits = null,
} = {}) {
  const { f0, hop, sr, win = 0 } = track;
  const n = f0.length;
  const detected = new Float32Array(n);
  const target = new Float32Array(n);
  const shift = new Float32Array(n);
  const frameSec = hop / sr;
  const det = detune / 100;
  const flexZone = 1 - 0.7 * flex;
  const glideA = glideMs > 0 ? 1 - Math.exp(-frameSec / (glideMs / 1000)) : 1;
  const ed = edits && edits.length ? [...edits].sort((p, q) => p.a - q.a) : null;
  let ei = 0;
  // slow-moving centre used to preserve vibrato around the target note
  let centre = 0, smoothShift = 0, wasVoiced = false, note = 0, tgt = 0, held = 0;
  for (let i = 0; i < n; i++) {
    if (!f0[i]) { wasVoiced = false; shift[i] = 0; continue; }
    const m = freqToMidi(f0[i]);
    detected[i] = m;
    if (!wasVoiced) centre = m;
    centre += (m - centre) * (1 - Math.exp(-frameSec / 0.12));

    // nearest allowed note, with a little stickiness so a wobble between two notes doesn't flutter
    const near = snapToScale(centre - det, root, scale, mask) + det;
    const prev = note;
    if (!wasVoiced || Math.abs(centre - note) > Math.abs(centre - near) + 0.3) note = near;

    // hand-placed notes win over the scale
    let off = false, forced = false;
    if (ed) {
      const t = (i * hop + win / 2) / sr;
      while (ei < ed.length && ed[ei].b <= t) ei++;
      const e = ei < ed.length && ed[ei].a <= t ? ed[ei] : null;
      if (e) { if (e.off) off = true; else { note = e.note; forced = true; } }
    }
    if (!wasVoiced || note !== prev) held = 0; else held += frameSec;
    if (!wasVoiced) tgt = note; else tgt += (note - tgt) * glideA;
    target[i] = off ? m : note;

    const vibrato = (m - centre) * keepVibrato;
    let want = off ? 0 : (tgt + vibrato - m) * amount;
    if (flex > 0 && !forced && !off) {
      const d = Math.abs(centre - tgt);
      if (d > flexZone) want *= Math.max(0, 1 - (d - flexZone) / 0.25);
    }
    want += transpose;
    const speed = speedMs + humanize * 140 * Math.min(1, held / 0.25);
    const alpha = speed <= 0 ? 1 : 1 - Math.exp(-frameSec / (speed / 1000));
    smoothShift = wasVoiced ? smoothShift + (want - smoothShift) * alpha : want;
    shift[i] = smoothShift;
    wasVoiced = true;
  }
  return { detected, target, shift };
}

// Group a target curve into notes for the pitch editor: [{ i0, i1, note, sung }] (frame indexes, i1 exclusive).
export function noteSegments(f0, target, minFrames = 8) {
  const segs = [];
  const n = f0.length;
  let i = 0;
  while (i < n) {
    if (!f0[i]) { i++; continue; }
    const note = Math.round(target[i]);
    let j = i, gap = 0, last = i, sum = 0, cnt = 0;
    while (j < n) {
      if (!f0[j]) { if (++gap > 4) break; j++; continue; }
      if (Math.round(target[j]) !== note) break;
      gap = 0; last = j; sum += freqToMidi(f0[j]); cnt++; j++;
    }
    segs.push({ i0: i, i1: last + 1, note, sung: cnt ? sum / cnt : note });
    i = last + 1;
  }
  // fold blips into their neighbour so the editor shows notes, not flicker
  const out = [];
  for (const s of segs) {
    const p = out[out.length - 1];
    if (s.i1 - s.i0 < minFrames && p && s.i0 - p.i1 <= 4) { p.i1 = s.i1; continue; }
    out.push(s);
  }
  return out.filter((s) => s.i1 - s.i0 >= 3);
}

// ---------------------------------------------------------------- pitch shifter
// Time-varying pitch shift of a mono signal. shiftSemis is sampled every `hop` input samples.
// Granular overlap-add with WSOLA-style alignment to keep grains phase-coherent.
export function pitchShiftVarying(x, sr, shiftSemis, hop, opts = {}) {
  const N = opts.grain ?? nextPow2(Math.round(sr * 0.04)); // ~40 ms grains
  const Ha = N >> 2;                                         // 75% overlap
  const search = opts.search ?? Math.round(sr * 0.006);     // ±6 ms alignment search
  const len = x.length;
  const out = new Float32Array(len + N);
  const norm = new Float32Array(len + N);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const cand = new Float32Array(N);
  const read = (pos) => {
    if (pos < 0 || pos >= len - 1) return 0;
    const i = pos | 0; const fr = pos - i;
    return x[i] + (x[i + 1] - x[i]) * fr;
  };
  const shiftAt = (t) => {
    const f = t / hop;
    const i = Math.floor(f);
    if (i < 0) return shiftSemis[0] || 0;
    if (i >= shiftSemis.length - 1) return shiftSemis[shiftSemis.length - 1] || 0;
    return shiftSemis[i] + (shiftSemis[i + 1] - shiftSemis[i]) * (f - i);
  };
  const ov = N - Ha;
  for (let t = 0; t < len; t += Ha) {
    const semis = shiftAt(t);
    const r = Math.pow(2, semis / 12);
    const outStart = t - (N >> 1);
    if (Math.abs(semis) < 0.005) {
      for (let i = 0; i < N; i++) {
        const o = outStart + i; if (o < 0 || o >= out.length) continue;
        const s = t - (N >> 1) + i; const v = s >= 0 && s < len ? x[s] : 0;
        out[o] += v * win[i]; norm[o] += win[i];
      }
      continue;
    }
    // choose an input offset whose resampled grain best continues the output so far
    let bestOff = 0;
    if (t > 0) {
      let bestScore = -Infinity;
      for (let off = -search; off <= search; off += 3) {
        let score = 0, energy = 1e-9;
        const base = t + off - (N >> 1) * r;
        for (let i = 0; i < ov; i += 8) {
          const o = outStart + i;
          if (o < 0 || norm[o] < 1e-6) continue;
          const v = read(base + i * r);
          score += v * (out[o] / norm[o]);
          energy += v * v;
        }
        score /= Math.sqrt(energy);
        if (score > bestScore) { bestScore = score; bestOff = off; }
      }
    }
    const base = t + bestOff - (N >> 1) * r;
    for (let i = 0; i < N; i++) cand[i] = read(base + i * r);
    for (let i = 0; i < N; i++) {
      const o = outStart + i; if (o < 0 || o >= out.length) continue;
      out[o] += cand[i] * win[i]; norm[o] += win[i];
    }
  }
  const y = new Float32Array(len);
  for (let i = 0; i < len; i++) y[i] = norm[i] > 1e-3 ? out[i] / norm[i] : 0;
  // restore original gain envelope slightly lost to grain cancellation
  return y;
}

// ---------------------------------------------------------------- formant-preserving pitch shifter (TD-PSOLA)
// Moves the pitch of a sung voice without moving its formants, so a corrected or transposed note still
// sounds like the same throat. One pitch period is lifted out at a time and laid back down closer
// together (higher) or further apart (lower). Unvoiced sound (breaths, S, T) passes through untouched.
//   shift      per-frame shift in semitones, same frames as track.f0
//   formant    semitones to move the formants on their own (voice character), 0 = natural
export function psolaShift(x, sr, track, shift, { formant = 0 } = {}) {
  const { f0, hop, win } = track;
  const len = x.length, frames = f0.length;
  if (!frames) return x.slice();
  const fr = Math.pow(2, formant / 12);
  const frameOf = (pos) => (pos - win / 2) / hop;
  const f0At = (pos) => {
    const f = frameOf(pos);
    const i = Math.max(0, Math.min(frames - 1, Math.floor(f)));
    const j = Math.min(frames - 1, i + 1);
    const a = f0[i], b = f0[j];
    if (a && b) return a + (b - a) * Math.max(0, Math.min(1, f - i));
    return f - i < 0.5 ? a : b;
  };
  const shiftAt = (pos) => {
    const f = frameOf(pos);
    const i = Math.max(0, Math.min(frames - 1, Math.floor(f)));
    const j = Math.min(frames - 1, i + 1);
    return shift[i] + (shift[j] - shift[i]) * Math.max(0, Math.min(1, f - i));
  };
  // a darker copy to find each pitch pulse on
  const lpc = biquadCoeffs('lowpass', Math.min(1100, sr * 0.2), sr, 0.7071);
  const xl = biquad(x, lpc);

  // analysis marks: one per pitch period on voiced sound, every 5 ms elsewhere
  const unv = Math.round(sr * 0.005);
  const mPos = [], mT = [];
  let pos = 0, prevVoiced = false;
  while (pos < len) {
    const f = f0At(pos);
    if (!(f > 0)) { mPos.push(pos); mT.push(0); pos += unv; prevVoiced = false; continue; }
    const T = sr / f;
    const r = (prevVoiced ? 0.3 : 0.5) * T;
    let best = Math.round(pos), bv = -Infinity;
    const lo = Math.max(0, Math.round(pos - r)), hi = Math.min(len - 1, Math.round(pos + r));
    for (let k = lo; k <= hi; k++) if (xl[k] > bv) { bv = xl[k]; best = k; }
    mPos.push(best); mT.push(T);
    pos = best + T; prevVoiced = true;
  }

  const out = new Float32Array(len + 4096);
  const norm = new Float32Array(len + 4096);
  const M = mPos.length;
  let ts = 0, idx = 0, wasV = false;
  while (ts < len) {
    while (idx + 1 < M && Math.abs(mPos[idx + 1] - ts) <= Math.abs(mPos[idx] - ts)) idx++;
    const T = mT[idx];
    if (!T) {
      // unvoiced: copy straight across
      const c = Math.round(ts);
      for (let j = -unv; j <= unv; j++) {
        const o = c + j; if (o < 0 || o >= len) continue;
        const w = 0.5 + 0.5 * Math.cos((Math.PI * j) / unv);
        out[o] += x[o] * w; norm[o] += w;
      }
      ts += unv; wasV = false;
      continue;
    }
    // start each sung phrase exactly on a pitch pulse, so an untouched note comes out untouched
    if (!wasV && Math.abs(mPos[idx] - ts) < T) ts = mPos[idx];
    wasV = true;
    const ratio = Math.pow(2, shiftAt(ts) / 12);
    const half = Math.max(8, Math.round(T / fr));
    const c = Math.round(ts), src = mPos[idx] + (ts - c);
    for (let j = -half; j <= half; j++) {
      const o = c + j; if (o < 0 || o >= out.length) continue;
      const p = src + j * fr;
      if (p < 0 || p >= len - 1) continue;
      const i = p | 0, v = x[i] + (x[i + 1] - x[i]) * (p - i);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * j) / half);
      out[o] += v * w; norm[o] += w;
    }
    const period = idx + 1 < M && mT[idx + 1] ? mPos[idx + 1] - mPos[idx] : T;
    ts += Math.max(16, period / ratio);
  }
  const y = new Float32Array(len);
  for (let i = 0; i < len; i++) y[i] = norm[i] > 0.05 ? out[i] / norm[i] : x[i];
  return y;
}

// One call: analyse + correct. Returns { audio, track, curve }.
export function autotune(x, sr, settings = {}) {
  const track = detectPitch(x, sr);
  const curve = correctionCurve(track, settings);
  const audio = psolaShift(x, sr, track, curve.shift, { formant: settings.formant || 0 });
  return { audio, track, curve };
}

// ---------------------------------------------------------------- harmony + doubles
// Move a scale note by a number of scale steps (2 steps = a third, 4 = a fifth).
export function scaleStep(note, root, scaleKey, steps) {
  const scale = SCALES[scaleKey] || SCALES.chromatic;
  if (scale.length === 12) return note + ({ 2: 4, '-2': -3, 4: 7, '-4': -7 }[steps] ?? steps);
  const pc = (((Math.round(note) - root) % 12) + 12) % 12;
  let idx = scale.indexOf(pc);
  if (idx < 0) idx = 0;
  const j = idx + steps;
  const oct = Math.floor(j / scale.length);
  return Math.round(note) - pc + scale[((j % scale.length) + scale.length) % scale.length] + 12 * oct;
}

export const HARMONIES = {
  off: null,
  thirdUp: { label: 'Third above', steps: 2 },
  thirdDown: { label: 'Third below', steps: -2 },
  fifthUp: { label: 'Fifth above', steps: 4 },
  octaveUp: { label: 'Octave above', semis: 12 },
  octaveDown: { label: 'Octave below', semis: -12 },
};

// A second voice sung in key: every lead note is moved to its harmony note in the same scale.
export function harmonize(x, sr, settings, mode) {
  const h = HARMONIES[mode];
  if (!h) return null;
  const track = detectPitch(x, sr);
  const { root = 0, scale = 'minor', keepVibrato = 0.3 } = settings || {};
  const curve = correctionCurve(track, { root, scale, speedMs: 25, amount: 1, keepVibrato });
  const n = track.f0.length;
  const shift = new Float32Array(n);
  let last = h.semis ?? (h.steps > 0 ? 3.5 : -3.5);
  for (let i = 0; i < n; i++) {
    if (track.f0[i]) {
      const lead = curve.target[i];
      const want = h.semis != null ? lead + h.semis : scaleStep(lead, root, scale, h.steps);
      const s = curve.shift[i] + (want - lead);
      last += (s - last) * 0.5; // settle between notes instead of jumping
    }
    shift[i] = last;
  }
  // a touch of formant movement keeps the harmony from sounding like a clone of the lead
  const up = (h.semis ?? h.steps) > 0;
  return psolaShift(x, sr, track, shift, { formant: h.semis ? 0 : up ? 0.6 : -0.6 });
}

// Two extra voices from one take: a hair sharp and a hair flat, a few ms late, for a wide double.
export function doubleTrack(x, sr, cents = 9) {
  const hop = Math.round(sr * 0.005);
  const frames = Math.ceil(x.length / hop) + 2;
  const up = new Float32Array(frames).fill(cents / 100), down = new Float32Array(frames).fill(-cents / 100);
  const late = (y, ms) => { const d = Math.round(sr * ms / 1000); const o = new Float32Array(y.length); o.set(y.subarray(0, y.length - d), d); return o; };
  return { left: late(pitchShiftVarying(x, sr, up, hop), 13), right: late(pitchShiftVarying(x, sr, down, hop), 22) };
}

// ---------------------------------------------------------------- noise gate
// Downward expander keyed to the take itself. amount 0..1: how firmly quiet gaps get pulled down.
export function gate(x, sr, amount) {
  if (!(amount > 0)) return x;
  const n = x.length, frame = Math.max(1, Math.round(sr * 0.01));
  const frames = Math.ceil(n / frame);
  const lv = new Float32Array(frames);
  for (let f = 0; f < frames; f++) lv[f] = rms(x, f * frame, Math.min(n, (f + 1) * frame));
  const sorted = Float32Array.from(lv).sort();
  const loud = sorted[Math.min(frames - 1, Math.floor(frames * 0.95))] || 1e-6;
  const thr = loud * dbToGain(-(46 - amount * 26));   // 46 dB below the loud parts at the lightest, 20 dB at the firmest
  const floor = dbToGain(-(8 + amount * 40));          // how far closed gaps drop
  const out = new Float32Array(n);
  const att = Math.exp(-1 / (sr * 0.003)), rel = Math.exp(-1 / (sr * 0.14));
  const hold = Math.round(sr * 0.09);
  let g = floor, held = 0;
  for (let i = 0; i < n; i++) {
    const open = lv[(i / frame) | 0] > thr || lv[Math.min(frames - 1, ((i + frame * 2) / frame) | 0)] > thr; // 20 ms lookahead keeps consonants
    if (open) held = hold; else if (held > 0) held--;
    const want = open || held > 0 ? 1 : floor;
    g = want > g ? want + (g - want) * att : want + (g - want) * rel;
    out[i] = x[i] * g;
  }
  return out;
}

// Shift curve frames are centred at s+win/2; realign so index k ≈ sample k*hop.
function alignCurve(shift, track) {
  const lag = Math.round(track.win / 2 / track.hop);
  const out = new Float32Array(shift.length + lag);
  for (let i = 0; i < shift.length; i++) out[i + lag] = shift[i];
  for (let i = 0; i < lag; i++) out[i] = shift[0] || 0;
  return out;
}

// ---------------------------------------------------------------- FFT (radix-2, in place)
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

// ---------------------------------------------------------------- key detection
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export function chroma(x, sr, maxSeconds = 90) {
  const N = 8192;
  const hopN = N;
  const limit = Math.min(x.length, Math.round(maxSeconds * sr));
  const c = new Float64Array(12);
  const re = new Float64Array(N), im = new Float64Array(N);
  const binLo = Math.ceil((55 * N) / sr), binHi = Math.floor((4200 * N) / sr);
  const pcOfBin = new Int8Array(N / 2).fill(-1);
  for (let b = binLo; b <= binHi && b < N / 2; b++) {
    const m = Math.round(freqToMidi((b * sr) / N));
    pcOfBin[b] = ((m % 12) + 12) % 12;
  }
  for (let s = 0; s + N <= limit; s += hopN) {
    for (let i = 0; i < N; i++) { re[i] = x[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)); im[i] = 0; }
    fft(re, im);
    for (let b = binLo; b <= binHi && b < N / 2; b++) {
      const pc = pcOfBin[b];
      if (pc >= 0) c[pc] += Math.sqrt(Math.sqrt(re[b] * re[b] + im[b] * im[b])); // compressed magnitude
    }
  }
  return c;
}

function corr(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return num / Math.sqrt(da * db || 1);
}

// Returns { root (0-11), scale: 'major'|'minor', confidence, label }
export function detectKey(x, sr) {
  const c = chroma(x, sr);
  let best = { root: 0, scale: 'minor', confidence: -1 };
  for (let root = 0; root < 12; root++) {
    const rot = new Float64Array(12);
    for (let i = 0; i < 12; i++) rot[i] = c[(i + root) % 12];
    const cm = corr(rot, KK_MAJOR), cn = corr(rot, KK_MINOR);
    if (cm > best.confidence) best = { root, scale: 'major', confidence: cm };
    if (cn > best.confidence) best = { root, scale: 'minor', confidence: cn };
  }
  best.label = `${NOTE_NAMES[best.root]} ${best.scale}`;
  return best;
}

// ---------------------------------------------------------------- tempo estimate (onset autocorrelation)
export function detectTempo(x, sr) {
  const hop = 256;
  const N = Math.floor(x.length / hop);
  if (N < 128) return 0;
  // onset envelope: positive log-energy jumps in low / mid / high bands
  const env = new Float32Array(N);
  const a1 = 1 - Math.exp(-2 * Math.PI * 200 / sr), a2 = 1 - Math.exp(-2 * Math.PI * 3000 / sr);
  let l1 = 0, l2 = 0;
  const prev = [0, 0, 0];
  for (let f = 0; f < N; f++) {
    const e = [0, 0, 0];
    for (let i = 0; i < hop; i++) {
      const v = x[f * hop + i];
      l1 += (v - l1) * a1; l2 += (v - l2) * a2;
      e[0] += l1 * l1; e[1] += (l2 - l1) * (l2 - l1); e[2] += (v - l2) * (v - l2);
    }
    let o = 0;
    for (let b = 0; b < 3; b++) { const lg = Math.log(1 + 1000 * e[b] / hop); o += Math.max(0, lg - prev[b]); prev[b] = lg; }
    env[f] = o;
  }
  // widen each onset a little so tempo peaks are broad and stable
  const sm = new Float32Array(N);
  const k = [1, 3, 5, 6, 5, 3, 1];
  for (let f = 0; f < N; f++) {
    let a = 0;
    for (let j = 0; j < k.length; j++) { const q = f + j - 3; if (q >= 0 && q < N) a += env[q] * k[j]; }
    sm[f] = a / 24;
  }
  env.set(sm);
  let mean = 0;
  for (let f = 0; f < N; f++) mean += env[f];
  mean /= N;
  for (let f = 0; f < N; f++) env[f] -= mean;
  // autocorrelation at fractional lags; favour lags whose double and half also line up
  const r = (L) => {
    const i = Math.floor(L), fr = L - i;
    let a = 0, b = 0;
    for (let f = 0; f + i + 1 < N; f++) { a += env[f] * env[f + i]; b += env[f] * env[f + i + 1]; }
    return (a * (1 - fr) + b * fr) / (N - L);
  };
  const fps = sr / hop;
  let best = 0, bestScore = -Infinity;
  for (let bpm = 60; bpm <= 190; bpm += 0.25) {
    const L = (60 / bpm) * fps;
    let s = r(L) + 0.5 * r(2 * L) + 0.25 * r(4 * L);
    s *= 1 - 0.25 * Math.abs(Math.log2(bpm / 110));
    if (s > bestScore) { bestScore = s; best = bpm; }
  }
  return Math.round(best);
}
function interp(a, p) { const i = p | 0; const f = p - i; return i + 1 < a.length ? a[i] + (a[i + 1] - a[i]) * f : 0; }

// ---------------------------------------------------------------- BS.1770 loudness
function biquadCoeffs(type, fc, sr, Q, gainDb) {
  const w0 = (2 * Math.PI * fc) / sr, cw = Math.cos(w0), alpha = Math.sin(w0) / (2 * Q);
  if (type === 'highshelf') {
    const A = Math.pow(10, gainDb / 40), sA = Math.sqrt(A);
    const b0 = A * ((A + 1) + (A - 1) * cw + 2 * sA * alpha);
    const b1 = -2 * A * ((A - 1) + (A + 1) * cw);
    const b2 = A * ((A + 1) + (A - 1) * cw - 2 * sA * alpha);
    const a0 = (A + 1) - (A - 1) * cw + 2 * sA * alpha;
    const a1 = 2 * ((A - 1) - (A + 1) * cw);
    const a2 = (A + 1) - (A - 1) * cw - 2 * sA * alpha;
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }
  if (type === 'lowpass') {
    const b0 = (1 - cw) / 2, b1 = 1 - cw, b2 = (1 - cw) / 2;
    const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }
  const b0 = (1 + cw) / 2, b1 = -(1 + cw), b2 = (1 + cw) / 2;
  const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
function biquad(x, [b0, b1, b2, a1, a2]) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = o; y[i] = o;
  }
  return y;
}

// Integrated loudness in LUFS (gated, 400 ms blocks, 75% overlap).
export function integratedLoudness(channels, sr) {
  const shelf = biquadCoeffs('highshelf', 1681.974450955533, sr, 0.7071752369554196, 3.999843853973347);
  const hp = biquadCoeffs('highpass', 38.13547087602444, sr, 0.5003270373238773);
  const filtered = channels.map((ch) => biquad(biquad(ch, shelf), hp));
  const block = Math.round(0.4 * sr), step = Math.round(0.1 * sr);
  const n = channels[0].length;
  const z = [];
  for (let s = 0; s + block <= n; s += step) {
    let sum = 0;
    for (const ch of filtered) { let a = 0; for (let i = s; i < s + block; i++) a += ch[i] * ch[i]; sum += a / block; }
    z.push(sum);
  }
  if (!z.length) return -70;
  const L = (v) => -0.691 + 10 * Math.log10(v || 1e-12);
  const abs = z.filter((v) => L(v) > -70);
  if (!abs.length) return -70;
  const meanAbs = abs.reduce((p, q) => p + q, 0) / abs.length;
  const rel = L(meanAbs) - 10;
  const gated = abs.filter((v) => L(v) > rel);
  return L(gated.reduce((p, q) => p + q, 0) / gated.length);
}

// ---------------------------------------------------------------- lookahead brickwall limiter (in place, linked stereo)
export function limit(channels, sr, ceilingDb = -1, releaseMs = 80, lookaheadMs = 5) {
  const n = channels[0].length;
  const ceil = dbToGain(ceilingDb);
  const L = Math.max(1, Math.round((lookaheadMs / 1000) * sr));
  const req = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const ch of channels) { const a = Math.abs(ch[i]); if (a > p) p = a; }
    req[i] = p > ceil ? ceil / p : 1;
  }
  // sliding-window minimum over [i, i+L] (monotonic deque)
  const g = new Float32Array(n);
  const dq = new Int32Array(n + L + 1);
  let head = 0, tail = 0;
  for (let i = n - 1 + L; i >= 0; i--) {
    const idx = i < n ? i : -1;
    if (idx >= 0) {
      while (tail > head && req[dq[tail - 1]] >= req[idx]) tail--;
      dq[tail++] = idx;
    }
    while (tail > head && dq[head] > i + L) head++;
    if (i < n) g[i] = tail > head ? req[dq[head]] : 1;
  }
  // smooth: instant attack (window already anticipates), exponential release, then short ramp
  const rel = Math.exp(-1 / ((releaseMs / 1000) * sr));
  let env = 1;
  for (let i = 0; i < n; i++) {
    env = g[i] < env ? g[i] : g[i] + (env - g[i]) * rel;
    g[i] = env;
  }
  // moving-average the gain over the lookahead to remove clicks, then enforce ceiling
  let acc = 0;
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    acc += g[i];
    if (i >= L) acc -= g[i - L];
    sm[i] = Math.min(g[i], acc / Math.min(i + 1, L));
  }
  let reduction = 0;
  for (let i = 0; i < n; i++) {
    const gi = Math.min(sm[i], req[i]);
    if (1 - gi > reduction) reduction = 1 - gi;
    for (const ch of channels) ch[i] *= gi;
  }
  return gainToDb(1 - reduction);
}

// Loudness-normalise then limit. Returns { lufs, gainDb, reductionDb }.
export function master(channels, sr, targetLufs = -14, ceilingDb = -1) {
  let lufs = integratedLoudness(channels, sr);
  let applied = 0;
  let reductionDb = 0; // deepest the limiter had to pull down across every pass (negative dB)
  for (let pass = 0; pass < 3 && lufs > -69; pass++) {
    const diff = Math.max(-24, Math.min(24, targetLufs - lufs));
    if (Math.abs(diff) < 0.2) break;
    const g = dbToGain(diff);
    for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] *= g;
    applied += diff;
    const red = limit(channels, sr, ceilingDb);
    reductionDb += red;
    lufs = integratedLoudness(channels, sr);
    if (red > -0.05 && pass > 0) break;
  }
  reductionDb += limit(channels, sr, ceilingDb);
  return { lufs: integratedLoudness(channels, sr), gainDb: applied, reductionDb, peakDb: gainToDb(peak(channels)) };
}

// ---------------------------------------------------------------- WAV encoding
export function encodeWav(channels, sr, bitDepth = 24) {
  const nCh = channels.length, n = channels[0].length;
  const bps = bitDepth / 8;
  const dataLen = n * nCh * bps;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nCh, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * nCh * bps, true); v.setUint16(32, nCh * bps, true); v.setUint16(34, bitDepth, true);
  str(36, 'data'); v.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      if (bitDepth === 16) { v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
      else { const q = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff); v.setUint8(o, q & 0xff); v.setUint8(o + 1, (q >> 8) & 0xff); v.setUint8(o + 2, (q >> 16) & 0xff); o += 3; }
    }
  }
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------- misc
export function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

// Min/max peaks per pixel column for fast waveform drawing.
export function waveformPeaks(x, columns) {
  const out = new Float32Array(columns * 2);
  const per = x.length / columns;
  for (let c = 0; c < columns; c++) {
    const s = Math.floor(c * per), e = Math.min(x.length, Math.floor((c + 1) * per));
    let mn = 0, mx = 0;
    for (let i = s; i < e; i++) { const v = x[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    out[c * 2] = mn; out[c * 2 + 1] = mx;
  }
  return out;
}
