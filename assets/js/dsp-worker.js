// Background DSP so long takes never freeze the studio.
import { autotune, detectKey, detectTempo, toMono, master, detectPitch, harmonize, doubleTrack } from './dsp.js';
import { recordCheck } from './check.js';

self.onmessage = (e) => {
  const { id, type, payload } = e.data;
  try {
    let result, transfer = [];
    if (type === 'autotune') {
      const { x, sr, settings } = payload;
      const r = autotune(x, sr, settings);
      result = { audio: r.audio, f0: r.track.f0, hop: r.track.hop, win: r.track.win, target: r.curve.target, shift: r.curve.shift };
      transfer = [r.audio.buffer];
    } else if (type === 'pitch') {
      const t = detectPitch(payload.x, payload.sr);
      result = { f0: t.f0, hop: t.hop, win: t.win };
    } else if (type === 'analyzeBeat') {
      const mono = toMono(payload.channels);
      result = { key: detectKey(mono, payload.sr), bpm: detectTempo(mono, payload.sr) };
    } else if (type === 'harmony') {
      const audio = harmonize(payload.x, payload.sr, payload.settings, payload.mode);
      result = { audio };
      transfer = [audio.buffer];
    } else if (type === 'double') {
      const d = doubleTrack(payload.x, payload.sr);
      result = d;
      transfer = [d.left.buffer, d.right.buffer];
    } else if (type === 'check') {
      result = recordCheck(payload);
    } else if (type === 'master') {
      const { channels, sr, target, ceiling } = payload;
      const stats = master(channels, sr, target, ceiling);
      result = { channels, stats };
      transfer = channels.map((c) => c.buffer);
    }
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
