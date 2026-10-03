// Background DSP so long takes never freeze the studio.
import { runJob } from './dsp-jobs.js';

self.onmessage = (e) => {
  const { id, type, payload } = e.data;
  if (type === 'ping') { self.postMessage({ id, ok: true, result: 'pong' }); return; }
  try {
    const { result, transfer } = runJob(type, payload);
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
