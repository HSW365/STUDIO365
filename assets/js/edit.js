// Take editing. Pure functions on mono Float32Array audio; every one returns a new array and leaves the
// original alone, so undo is just a pointer back. a and b are sample positions, b exclusive.
import { peak, dbToGain } from './dsp.js';

const clampRange = (x, a, b) => {
  a = Math.max(0, Math.min(x.length, Math.round(a))); b = Math.max(0, Math.min(x.length, Math.round(b)));
  return a <= b ? [a, b] : [b, a];
};
const ramp = (sr, ms = 5) => Math.max(1, Math.round(sr * ms / 1000));

// Keep only the selection. A few ms of fade on each end so the cut can't click.
export function trim(x, a, b, sr) {
  [a, b] = clampRange(x, a, b);
  const y = x.slice(a, b), r = Math.min(ramp(sr), y.length >> 1);
  for (let i = 0; i < r; i++) { const g = i / r; y[i] *= g; y[y.length - 1 - i] *= g; }
  return y;
}

// Mute the selection but keep everything after it where it is. For breaths, coughs and headphone bleed.
export function silence(x, a, b, sr) {
  [a, b] = clampRange(x, a, b);
  const y = x.slice(), r = Math.min(ramp(sr), (b - a) >> 1);
  for (let i = a; i < b; i++) {
    const edge = Math.min(i - a, b - 1 - i);
    y[i] = edge < r ? y[i] * (1 - (edge + 1) / r) : 0;
  }
  return y;
}

// Remove the selection and close the gap, with a short crossfade over the join.
export function remove(x, a, b, sr) {
  [a, b] = clampRange(x, a, b);
  const r = Math.min(ramp(sr, 8), a, x.length - b);
  const y = new Float32Array(x.length - (b - a));
  y.set(x.subarray(0, a), 0);
  y.set(x.subarray(b), a);
  for (let i = 0; i < r; i++) {
    const g = (i + 1) / (r + 1);
    y[a - r + i] = x[a - r + i] * (1 - g) + x[b - r + i] * g;
  }
  return y;
}

// Equal-power fades across the selection.
export function fadeIn(x, a, b) {
  [a, b] = clampRange(x, a, b);
  const y = x.slice(), n = Math.max(1, b - a);
  for (let i = a; i < b; i++) y[i] *= Math.sin(((i - a) / n) * Math.PI / 2);
  return y;
}
export function fadeOut(x, a, b) {
  [a, b] = clampRange(x, a, b);
  const y = x.slice(), n = Math.max(1, b - a);
  for (let i = a; i < b; i++) y[i] *= Math.cos(((i - a) / n) * Math.PI / 2);
  return y;
}

// Clip gain on the selection, eased in and out so there is no step in level.
export function gain(x, a, b, db, sr) {
  [a, b] = clampRange(x, a, b);
  const y = x.slice(), g = dbToGain(db), r = Math.min(ramp(sr, 10), (b - a) >> 1);
  for (let i = a; i < b; i++) {
    const edge = Math.min(i - a, b - 1 - i);
    const k = r > 0 && edge < r ? edge / r : 1;
    y[i] *= 1 + (g - 1) * k;
  }
  return y;
}

// Bring the loudest peak in the selection to `targetDb`. Returns { audio, db } so the UI can say what it did.
export function normalize(x, a, b, sr, targetDb = -3) {
  [a, b] = clampRange(x, a, b);
  const pk = peak([x.subarray(a, b)]);
  if (pk < 1e-5) return { audio: x, db: 0 };
  const db = targetDb - 20 * Math.log10(pk);
  return { audio: gain(x, a, b, db, sr), db };
}

export function reverse(x, a, b) {
  [a, b] = clampRange(x, a, b);
  const y = x.slice();
  y.subarray(a, b).reverse();
  return y;
}

// Hand-placed tuning notes live on the take's own clock (seconds). Keep them lined up after an edit.
export function shiftNoteEdits(edits, kind, aSec, bSec) {
  if (!edits || !edits.length) return [];
  if (kind === 'trim') return edits.filter((e) => e.b > aSec && e.a < bSec).map((e) => ({ ...e, a: Math.max(0, e.a - aSec), b: Math.min(bSec, e.b) - aSec }));
  if (kind === 'remove') {
    const d = bSec - aSec;
    return edits.filter((e) => e.b <= aSec || e.a >= bSec).map((e) => (e.a >= bSec ? { ...e, a: e.a - d, b: e.b - d } : e));
  }
  if (kind === 'silence') return edits.filter((e) => e.b <= aSec || e.a >= bSec);
  if (kind === 'reverse') return edits.filter((e) => e.b <= aSec || e.a >= bSec);
  return edits;
}
