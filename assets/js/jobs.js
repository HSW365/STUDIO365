// Background audio jobs. Two workers: one for tuning, one for everything else (mastering, analysis, stacks),
// so a long tuning pass never holds up a bounce. A job that has been overtaken is really cancelled: its
// worker is stopped and a fresh one takes the next job, instead of grinding through work nobody wants.
import { runJob } from './dsp-jobs.js';

const URL_ = new URL('./dsp-worker.js', import.meta.url);
export class Cancelled extends Error { constructor() { super('cancelled'); this.name = 'AbortError'; } }
export const isCancel = (err) => !!err && err.name === 'AbortError';

function lane(name) {
  let worker = null, current = null, broken = false, seq = 0;
  const queue = [];
  // Only if the browser truly cannot run the worker does a job run on the page itself.
  const local = (job) => new Promise((r) => setTimeout(r, 0)).then(() => runJob(job.type, job.payload).result);
  const spawn = () => {
    try {
      worker = new Worker(URL_, { type: 'module', name: `studio-${name}` });
      worker.onmessage = (e) => {
        const job = current;
        if (!job || e.data.id !== job.id) return;
        current = null;
        if (e.data.ok) job.res(e.data.result); else job.rej(new Error(e.data.error));
        pump();
      };
      worker.onerror = (e) => {
        console.warn(`Audio worker (${name}) failed; running on the page instead.`, e && e.message);
        broken = true; try { worker.terminate(); } catch { /* gone */ } worker = null;
        const job = current; current = null;
        if (job) local(job).then(job.res, job.rej);
        pump();
      };
    } catch (err) { console.warn('Audio worker unavailable.', err); broken = true; worker = null; }
  };
  const pump = () => {
    if (current || !queue.length) return;
    const job = queue.shift();
    if (broken) { local(job).then(job.res, job.rej).finally(pump); return; }
    if (!worker) spawn();
    if (!worker) { local(job).then(job.res, job.rej).finally(pump); return; }
    current = job;
    try { worker.postMessage({ id: job.id, type: job.type, payload: job.payload }, job.transfer); }
    catch (err) { current = null; job.rej(err); pump(); }
  };
  const drop = (pred) => {
    for (let i = queue.length - 1; i >= 0; i--) if (pred(queue[i])) { const [j] = queue.splice(i, 1); j.rej(new Cancelled()); }
    if (current && pred(current)) {
      const j = current; current = null;
      try { worker.terminate(); } catch { /* gone */ } worker = null;
      j.rej(new Cancelled());
      pump();
    }
  };
  return {
    run(type, payload, transfer = [], key = null) {
      if (key != null) drop((j) => j.key === key);
      return new Promise((res, rej) => { queue.push({ id: ++seq, type, payload, transfer, key, res, rej }); pump(); });
    },
    cancel(key = null) { drop((j) => key == null || j.key === key); },
    get busy() { return !!current || queue.length > 0; },
  };
}

const lanes = { tune: lane('tune'), main: lane('main') };
// work(type, payload, transfer, { lane, key }): key makes a job replace any older job with the same key.
export function work(type, payload, transfer = [], { lane: l = 'main', key = null } = {}) { return lanes[l].run(type, payload, transfer, key); }
export function cancelJobs(l, key = null) { lanes[l].cancel(key); }
