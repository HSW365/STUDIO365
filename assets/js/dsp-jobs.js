// The heavy audio jobs, in one place so they can run in the background worker or, if a browser
// can't start the worker, right on the page. Returns { result, transfer }.
import { autotune, detectKey, detectTempo, toMono, master, detectPitch, harmonize, doubleTrack } from './dsp.js';
import { recordCheck } from './check.js';

export function runJob(type, payload) {
  if (type === 'autotune') {
    const r = autotune(payload.x, payload.sr, payload.settings);
    return { result: { audio: r.audio, f0: r.track.f0, hop: r.track.hop, win: r.track.win, target: r.curve.target, shift: r.curve.shift }, transfer: [r.audio.buffer] };
  }
  if (type === 'pitch') {
    const t = detectPitch(payload.x, payload.sr);
    return { result: { f0: t.f0, hop: t.hop, win: t.win }, transfer: [] };
  }
  if (type === 'analyzeBeat') {
    const mono = toMono(payload.channels);
    return { result: { key: detectKey(mono, payload.sr), bpm: detectTempo(mono, payload.sr) }, transfer: [] };
  }
  if (type === 'harmony') {
    const audio = harmonize(payload.x, payload.sr, payload.settings, payload.mode);
    return { result: { audio }, transfer: [audio.buffer] };
  }
  if (type === 'double') {
    const d = doubleTrack(payload.x, payload.sr);
    return { result: d, transfer: [d.left.buffer, d.right.buffer] };
  }
  if (type === 'check') return { result: recordCheck(payload), transfer: [] };
  if (type === 'master') {
    const { channels, sr, target, ceiling } = payload;
    const stats = master(channels, sr, target, ceiling);
    return { result: { channels, stats }, transfer: channels.map((c) => c.buffer) };
  }
  throw new Error(`Unknown audio job: ${type}`);
}
