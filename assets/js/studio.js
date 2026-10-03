// STUDIO365 studio — record, tune, mix, master, export. Everything runs in the browser; sessions live in IndexedDB.
import * as D from './dsp.js';
import { renderMix, createGraph, migrateMix, compFromMacro, DEFAULT_MIX, DELAY_NOTES } from './mixer.js';
import * as Edit from './edit.js';
import { initConsole, syncConsole, selectStrip, kickMeters, initEq, drawEq, selectBand, selectedBand, EQ_BANDS } from './console.js';
import { vocalBeatBalance, BALANCE_TARGET } from './check.js';
import * as Store from './store.js';
import { initPro, isPro, requirePro, openPro } from './pro.js';
import { PRESETS } from './presets.js';
import * as Pack from './pack.js';
import { runJob } from './dsp-jobs.js';

const $ = (id) => document.getElementById(id);
const DEFAULT_TUNE = { enabled: true, root: 9, scale: 'minor', speedMs: 15, amount: 100, keepVibrato: 30, humanize: 0, flex: 0, glideMs: 0, transpose: 0, formant: 0, detune: 0, mask: null, edits: {} };
const DEFAULT_MASTER = { enabled: true, target: -14, ceiling: -1 };
const DEFAULT_STACK = { double: 0, harmony: 'off', harmonyLevel: 50, takes: {} };
const DEFAULTS = { tune: DEFAULT_TUNE, mix: DEFAULT_MIX, stack: DEFAULT_STACK };
const LAST_KEY = 'studio365:last-session';

// ------------------------------------------------------------------ state
let P = newProject();
let ctx = null;
let mixCache = null;          // { sig, channels, buffer, stats }
let renderToken = 0;
let tuneToken = 0;
let playing = false, playStartCtx = 0, position = 0;
let live = null, liveBusy = null, playSrcs = [], playDur = 0, playSig = '', playToken = 0;   // the live console
const bufCache = new WeakMap();
let zoom = 1, viewStart = 0, sel = null, tool = 'select', loopOn = false, tlDrag = null;       // timeline view + selection (seconds)
let undoStack = [], redoStack = [];
let pitchDrag = null;
const segCache = new WeakMap();
let recording = false, recFrom = 0, recStartAt = 0, beatLive = null, clickTimer = null;
let micStream = null, micSrc = null, recNode = null, monitorGain = null, silentOut = null;
let recResolve = null;
let saveTimer = null, renderTimer = null, tuneTimer = null;
let peakHold = 0, peakHoldTime = 0;
const peaksCache = new WeakMap();
const gateCache = new WeakMap();   // audio array -> { amount, out }
let stackCache = { double: null, harmony: null, takes: new Map() };

function uid() { return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)); }
function newProject() {
  return {
    id: uid(), name: 'Untitled session', created: Date.now(), updated: Date.now(), sr: null,
    bpm: 90, key: null, beat: null, takes: [], activeTake: null,
    tune: { ...DEFAULT_TUNE, edits: {} }, mix: migrateMix({}), master: { ...DEFAULT_MASTER }, tuned: null,
    stack: { ...DEFAULT_STACK, takes: {} }, preset: '', release: null, cover: null,
  };
}

// ------------------------------------------------------------------ worker
// Heavy audio jobs run in a background worker. If this browser can't start it (or it never answers),
// the same jobs run on the page instead: slower to respond while they work, but everything still works.
let worker = null, workerOk = false, workerDead = false;
let wid = 0;
const pending = new Map();
const runLocal = (type, payload) => new Promise((res, rej) => {
  setTimeout(() => { try { res(runJob(type, payload).result); } catch (err) { rej(err); } }, 0);
});
function killWorker() {
  if (workerDead) return;
  workerDead = true; workerOk = false;
  try { worker && worker.terminate(); } catch { /* already gone */ }
  // anything that was waiting on the worker gets redone on the page
  for (const [, p] of pending) (p.payload ? runLocal(p.type, p.payload).then(p.res, p.rej) : p.rej(new Error('The audio engine restarted. Try that again.')));
  pending.clear();
}
try {
  worker = new Worker(new URL('./dsp-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    if (e.data.result === 'pong') { workerOk = true; return; }
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    e.data.ok ? p.res(e.data.result) : p.rej(new Error(e.data.error));
  };
  worker.onerror = (e) => { console.warn('Audio worker failed, running on the page instead.', e && e.message); killWorker(); };
  worker.postMessage({ id: 0, type: 'ping' });
  setTimeout(() => { if (!workerOk) killWorker(); }, 4000);
} catch (err) { console.warn('Audio worker unavailable, running on the page instead.', err); workerDead = true; }
const work = (type, payload, transfer = []) => {
  if (workerDead || !worker) return runLocal(type, payload);
  return new Promise((res, rej) => {
    const id = ++wid;
    // until the worker has proven it is alive, keep the data here too so the job can be redone locally
    const keep = !workerOk;
    pending.set(id, { res, rej, type, payload: keep ? payload : null });
    try { worker.postMessage({ id, type, payload }, keep ? [] : transfer); }
    catch (err) { pending.delete(id); runLocal(type, payload).then(res, rej); }
  });
};

// ------------------------------------------------------------------ audio context
function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
function projectSr() { if (!P.sr) P.sr = audio().sampleRate; return P.sr; }

async function resample(channels, fromSr, toSr) {
  if (fromSr === toSr) return channels;
  const len = Math.max(1, Math.round(channels[0].length * toSr / fromSr));
  const off = new OfflineAudioContext(channels.length, len, toSr);
  const b = off.createBuffer(channels.length, channels[0].length, fromSr);
  channels.forEach((c, i) => b.copyToChannel(c, i));
  const s = off.createBufferSource(); s.buffer = b; s.connect(off.destination); s.start();
  const r = await off.startRendering();
  return Array.from({ length: channels.length }, (_, i) => r.getChannelData(i).slice());
}

async function decodeFile(file) {
  const bytes = await file.arrayBuffer();
  const c = audio();
  let buf;
  try { buf = await c.decodeAudioData(bytes.slice(0)); }
  catch { throw new Error(`Couldn't read "${file.name}". Try an MP3 or WAV export of it.`); }
  let chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i).slice());
  chans = await resample(chans, buf.sampleRate, projectSr());
  return chans;
}

// ------------------------------------------------------------------ helpers
const activeTake = () => P.takes.find((t) => t.id === P.activeTake) || null;
const fmtTime = (s, tenths = true) => {
  s = Math.max(0, s);
  const m = Math.floor(s / 60), r = s - m * 60;
  return tenths ? `${m}:${r.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.floor(r)).padStart(2, '0')}`;
};
function projectDuration() {
  const sr = P.sr || 48000;
  let d = P.beat ? P.beat.channels[0].length / sr : 0;
  for (const t of P.takes) d = Math.max(d, (t.start || 0) + t.audio.length / sr);
  if (mixCache) d = Math.max(d, mixCache.channels[0].length / sr);
  return d;
}
// What the tuning engine is asked to do for a take. The Tune Pro controls only count for Pro members.
function tuneSettings(t) {
  const T = P.tune, pro = isPro();
  return {
    root: T.root, scale: T.scale, speedMs: T.speedMs, amount: T.amount / 100, keepVibrato: T.keepVibrato / 100,
    humanize: pro ? T.humanize / 100 : 0, flex: pro ? T.flex / 100 : 0, glideMs: pro ? T.glideMs : 0,
    transpose: pro ? T.transpose : 0, formant: pro ? T.formant : 0, detune: pro ? T.detune : 0,
    mask: pro && T.mask ? T.mask : null, edits: pro && T.edits[t.id] ? T.edits[t.id] : [],
  };
}
function tuneSig(t) { return JSON.stringify([t.id, t.rev || 0, tuneSettings(t)]); }
function vocalSignal() {
  const t = activeTake();
  if (!t) return null;
  if (P.tune.enabled && P.tuned && P.tuned.sig === tuneSig(t)) return P.tuned.audio;
  return t.audio;
}
// Noise gate sits in front of the whole chain. Cached per take so faders stay quick.
function gated(x) {
  const amount = (P.mix.gate || 0) / 100;
  if (!x || !amount) return x;
  const c = gateCache.get(x);
  if (c && c.amount === amount) return c.out;
  const out = D.gate(x, P.sr, amount);
  gateCache.set(x, { amount, out });
  return out;
}
const stackedTakes = () => P.takes.filter((t) => t.id !== P.activeTake && P.stack.takes[t.id]?.on);
const stackActive = () => isPro() && (P.stack.double > 0 || (P.stack.harmony !== 'off' && P.stack.harmonyLevel > 0) || stackedTakes().length > 0);

// Extra voices behind the lead: generated doubles, a generated harmony, and any other takes the artist stacked.
async function buildLayers() {
  if (!stackActive()) return [];
  const t = activeTake(), S = P.stack, out = [];
  const base = P.mix.vocalOffsetMs;
  if (t) {
    const lead = gated(vocalSignal());
    const off = base + (t.start || 0) * 1000;
    if (S.double > 0) {
      const sig = JSON.stringify([t.id, t.rev || 0, P.tune.enabled && P.tuned ? P.tuned.sig : 'raw', P.mix.gate]);
      if (!stackCache.double || stackCache.double.sig !== sig) {
        setRenderState('Building your doubles…', true);
        stackCache.double = { sig, ...(await work('double', { x: lead.slice(), sr: P.sr })) };
      }
      const db = -20 + S.double * 0.15;
      out.push({ audio: stackCache.double.left, offsetMs: off, db, pan: -72 }, { audio: stackCache.double.right, offsetMs: off, db, pan: 72 });
    }
    if (S.harmony !== 'off' && S.harmonyLevel > 0) {
      const sig = JSON.stringify([t.id, t.rev || 0, S.harmony, P.tune.root, P.tune.scale, P.tune.keepVibrato]);
      if (!stackCache.harmony || stackCache.harmony.sig !== sig) {
        setRenderState('Singing the harmony…', true);
        const r = await work('harmony', { x: t.audio.slice(), sr: P.sr, mode: S.harmony, settings: { root: P.tune.root, scale: P.tune.scale, keepVibrato: P.tune.keepVibrato / 100 } });
        stackCache.harmony = { sig, audio: r.audio };
      }
      out.push({ audio: gated(stackCache.harmony.audio), offsetMs: off + 9, db: -22 + S.harmonyLevel * 0.17, pan: 18 });
    }
  }
  for (const tk of stackedTakes()) {
    const st = P.stack.takes[tk.id];
    let audio = tk.audio;
    if (P.tune.enabled) {
      const sig = tuneSig(tk);
      let c = stackCache.takes.get(tk.id);
      if (!c || c.sig !== sig) {
        setRenderState(`Tuning ${tk.name} for the stack…`, true);
        const r = await work('autotune', { x: tk.audio.slice(), sr: P.sr, settings: tuneSettings(tk) });
        c = { sig, audio: r.audio }; stackCache.takes.set(tk.id, c);
      }
      audio = c.audio;
    }
    out.push({ audio: gated(audio), offsetMs: base + (tk.start || 0) * 1000, db: st.db ?? -8, pan: st.pan ?? 0 });
  }
  return out;
}

function renderSig() {
  const t = activeTake();
  return JSON.stringify({
    stack: stackActive() ? P.stack : null,
    beat: P.beat ? P.beat.id : null, take: t ? t.id : null, rev: t ? t.rev || 0 : 0, start: t ? t.start : 0,
    tuned: t && P.tune.enabled && P.tuned && P.tuned.sig === tuneSig(t) ? P.tuned.sig : 'raw',
    mix: P.mix, master: P.master, bpm: P.bpm,
  });
}

let toastTimer;
function toast(msg, error = false) {
  const el = $('toast');
  el.textContent = msg; el.classList.toggle('error', !!error); el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), error ? 6000 : 3500);
}
function setRenderState(msg, busy = false) {
  const el = $('renderState');
  el.textContent = msg; el.classList.toggle('busy', busy);
}

// ------------------------------------------------------------------ persistence
function markDirty() {
  P.updated = Date.now();
  $('saveState').textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 700);
}
async function save() {
  try {
    await Store.saveProject(P);
    localStorage.setItem(LAST_KEY, P.id);
    $('saveState').textContent = 'Saved on this device';
    Store.requestPersistence();
  } catch (err) {
    console.error(err);
    $('saveState').textContent = 'Not saved';
    toast("This session couldn't be saved. Your browser may be out of storage space. Export your mix to keep it.", true);
  }
}

// ------------------------------------------------------------------ tuning
function scheduleTune(delay = 350) {
  clearTimeout(tuneTimer);
  tuneTimer = setTimeout(runTune, delay);
}
async function runTune() {
  const t = activeTake();
  if (!t || !P.tune.enabled) { drawPitch(); scheduleRender(0); updateTuneStatus(); return; }
  const sig = tuneSig(t);
  if (P.tuned && P.tuned.sig === sig) { drawPitch(); scheduleRender(0); updateTuneStatus(); return; }
  const token = ++tuneToken;
  setRenderState(`Tuning ${t.name} to ${D.NOTE_NAMES[P.tune.root]} ${D.SCALE_LABELS[P.tune.scale].toLowerCase()}…`, true);
  try {
    const res = await work('autotune', { x: t.audio.slice(), sr: P.sr, settings: tuneSettings(t) });
    if (token !== tuneToken) return;
    P.tuned = { sig, takeId: t.id, audio: res.audio, f0: res.f0, shift: res.shift, target: res.target, hop: res.hop, win: res.win };
    markDirty();
    drawPitch();
    drawTimeline();
    updateTuneStatus();
    scheduleRender(0);
  } catch (err) {
    console.error(err);
    if (token === tuneToken) { setRenderState('Tuning failed. The raw take is playing instead.'); toast(`Tuning failed: ${err.message}`, true); scheduleRender(0); }
  }
}
function updateTuneStatus() {
  const t = activeTake();
  const el = $('tuneStatus');
  if (!t) { el.textContent = 'Record or import a take, then the tuning runs automatically.'; return; }
  if (!P.tune.enabled) { el.textContent = `${t.name} plays untouched.`; return; }
  if (P.tuned && P.tuned.sig === tuneSig(t)) {
    let moved = 0, voiced = 0;
    for (let i = 0; i < P.tuned.f0.length; i++) if (P.tuned.f0[i]) { voiced++; moved += Math.abs(P.tuned.shift[i]); }
    const avg = voiced ? (moved / voiced) * 100 : 0;
    el.textContent = voiced
      ? `${t.name} is tuned. Notes moved ${avg.toFixed(0)} cents on average to land in ${D.NOTE_NAMES[P.tune.root]} ${D.SCALE_LABELS[P.tune.scale].toLowerCase()}.${isPro() && (P.tune.edits[t.id] || []).length ? ` ${P.tune.edits[t.id].length} placed by hand.` : ''}`
      : `No sung pitch found in ${t.name}. Spoken or whispered takes pass through untouched.`;
  }
}

// ------------------------------------------------------------------ mixing
// Settings reach the live console at once. The offline bounce behind it (loudness, export, record check)
// follows a moment later, and waits a little longer while you are listening.
function scheduleRender(delay = 220) {
  applyLive();
  clearTimeout(renderTimer);
  renderTimer = setTimeout(runRender, playing ? Math.max(delay, 450) : delay);
}
async function runRender() {
  if (!P.beat && !activeTake()) { mixCache = null; updateTransport(); setRenderState('Load a beat or record a take to start.'); return; }
  const sig = renderSig();
  if (playing && liveSig() !== playSig) restartPlayback();
  if (mixCache && mixCache.sig === sig) { setRenderState(readyText()); return; }
  const token = ++renderToken;
  setRenderState('Mixing…', true);
  try {
    const t = activeTake();
    const vocal = gated(vocalSignal());
    const mix = { ...P.mix, vocalOffsetMs: P.mix.vocalOffsetMs + (t ? (t.start || 0) * 1000 : 0) };
    const layers = await buildLayers();
    if (token !== renderToken) return;
    if (sig !== renderSig()) { scheduleRender(0); return; }
    setRenderState('Mixing…', true);
    let channels = await renderMix({ sr: P.sr, beat: P.beat ? P.beat.channels : null, vocal, mix, bpm: P.bpm, layers });
    if (token !== renderToken) return;
    let stats = null;
    if (P.master.enabled) {
      setRenderState('Mastering…', true);
      const r = await work('master', { channels, sr: P.sr, target: P.master.target, ceiling: P.master.ceiling }, channels.map((c) => c.buffer));
      if (token !== renderToken) return;
      channels = r.channels; stats = r.stats;
    } else {
      stats = { lufs: null, peakDb: D.gainToDb(D.peak(channels)), reductionDb: 0 };
    }
    mixCache = { sig, channels, stats };
    updateStats();
    updateTransport();
    applyLive();
    setRenderState(readyText());
  } catch (err) {
    console.error(err);
    if (token === renderToken) { setRenderState('Mix failed.'); toast(`Mixing failed: ${err.message}`, true); }
  }
}
function readyText() {
  const t = activeTake();
  if (!t) return 'Beat loaded. Press Record when you are ready.';
  const n = stackActive() ? (P.stack.double > 0 ? 2 : 0) + (P.stack.harmony !== 'off' && P.stack.harmonyLevel > 0 ? 1 : 0) + stackedTakes().length : 0;
  return `Mix is current. ${n ? `${n} stacked voice${n === 1 ? '' : 's'}. ` : ''}${P.master.enabled ? 'Master on.' : 'Master off.'}`;
}
function updateStats() {
  const s = mixCache?.stats;
  $('statLufs').textContent = s && s.lufs != null ? `${s.lufs.toFixed(1)} LUFS` : '–';
  $('statPeak').textContent = s ? `${s.peakDb.toFixed(1)} dB` : '–';
  $('statGr').textContent = s && s.reductionDb != null ? `${Math.abs(s.reductionDb).toFixed(1)} dB` : '–';
}

// ------------------------------------------------------------------ playback (the live console)
// Playback runs through the console itself, so every fader, mute, EQ point and send answers while it plays.
async function liveGraph() {
  if (live) return live;
  if (!liveBusy) liveBusy = createGraph(audio(), { live: true }).then((g) => { live = g; applyLive(); return g; });
  return liveBusy;
}
function applyLive() {
  if (!live) return;
  live.update(P.mix, P.bpm);
  const s = mixCache?.stats;
  live.setMaster({ on: P.master.enabled, gainDb: s && s.gainDb != null ? s.gainDb : 0, ceiling: P.master.ceiling });
}
function monoBuffer(arr) {
  let b = bufCache.get(arr);
  if (!b) { b = audio().createBuffer(1, arr.length, P.sr); b.copyToChannel(arr, 0); bufCache.set(arr, b); }
  return b;
}
function beatBuffer() {
  const ch = P.beat.channels;
  let b = bufCache.get(ch);
  if (!b) { b = audio().createBuffer(ch.length, ch[0].length, P.sr); ch.forEach((c, i) => b.copyToChannel(c, i)); bufCache.set(ch, b); }
  return b;
}
// Everything that decides which audio is loaded on the console. If it changes mid-play, playback reloads in place.
function liveSig() {
  const t = activeTake();
  return JSON.stringify([
    P.beat ? P.beat.id : 0, t ? [t.id, t.rev || 0, t.start || 0] : 0,
    t && P.tune.enabled && P.tuned && P.tuned.sig === tuneSig(t) ? P.tuned.sig : 'raw',
    P.mix.gate, P.mix.vocalOffsetMs, stackActive() ? P.stack : 0,
  ]);
}
function currentPosition() {
  if (playing && ctx) return Math.max(0, ctx.currentTime - playStartCtx);
  return position;
}
function killSources() {
  for (const s of playSrcs) { try { s.stop(); } catch { /* not started */ } try { s.disconnect(); } catch { /* gone */ } }
  playSrcs = [];
}
async function startPlayback(from = position) {
  if (recording || (!P.beat && !activeTake())) return;
  const c = audio();
  await c.resume();
  const token = ++playToken;
  killSources();
  let G, layers;
  try {
    if (!mixCache) await runRender();
    G = await liveGraph();
    layers = await buildLayers();
  } catch (err) { console.error(err); toast(`Playback failed: ${err.message}`, true); return; }
  if (token !== playToken) return;
  const t = activeTake(), sr = P.sr;
  const lead = t ? gated(vocalSignal()) : null;
  const leadOff = t ? (t.start || 0) + P.mix.vocalOffsetMs / 1000 : 0;
  const tail = Math.max(2.5, P.mix.revDecay + 0.5);
  let dur = P.beat ? P.beat.channels[0].length / sr : 0;
  if (lead) dur = Math.max(dur, leadOff + lead.length / sr + tail);
  for (const l of layers) dur = Math.max(dur, l.offsetMs / 1000 + l.audio.length / sr + tail);
  if (from >= dur - 0.05) from = 0;
  if (loopOn && sel && (from < sel.a || from >= sel.b - 0.02)) from = sel.a;
  G.clearLayers();
  const when = c.currentTime + 0.05;
  const launch = (buffer, dest, off) => {
    if (from - off >= buffer.duration) return;
    const s = c.createBufferSource(); s.buffer = buffer; s.connect(dest);
    if (from >= off) s.start(when, from - off); else s.start(when + (off - from), 0);
    playSrcs.push(s);
  };
  if (P.beat) launch(beatBuffer(), G.inputs.beat, 0);
  if (lead) launch(monoBuffer(lead), G.inputs.lead, leadOff);
  for (const l of layers) launch(monoBuffer(l.audio), G.addLayer({ db: l.db, pan: l.pan }), l.offsetMs / 1000);
  applyLive();
  playStartCtx = when - from; playDur = dur; playSig = liveSig(); playing = true;
  if (!$('renderState').classList.contains('busy') || mixCache?.sig === renderSig()) setRenderState(readyText());
  updateTransport();
  kickMeters();
  requestAnimationFrame(tick);
}
function stopPlayback(keepPosition = true) {
  playToken++;
  if (playing) position = keepPosition ? Math.min(currentPosition(), projectDuration()) : 0;
  killSources();
  playing = false;
  updateTransport();
  drawTimeline();
}
function restartPlayback(at = currentPosition()) { stopPlayback(true); position = at; return startPlayback(at); }
function tick() {
  if (playing) {
    const pos = currentPosition();
    if (loopOn && sel && pos >= sel.b) { restartPlayback(sel.a); return; }
    if (pos >= playDur) { stopPlayback(false); drawPitch(); return; }
  }
  $('clock').textContent = fmtTime(recording ? Math.max(0, ctx.currentTime - recStartAt + recFrom) : currentPosition());
  drawTimeline();
  if (playing && !$('pitchPanel').hidden) drawPitch();
  if (playing || recording) requestAnimationFrame(tick);
}

// ------------------------------------------------------------------ recording
function click(time, accent) {
  const c = audio();
  const o = c.createOscillator(); const g = c.createGain();
  o.frequency.value = accent ? 1760 : 1175;
  g.gain.setValueAtTime(0, time); g.gain.linearRampToValueAtTime(accent ? 0.5 : 0.32, time + 0.002); g.gain.exponentialRampToValueAtTime(0.001, time + 0.06);
  o.connect(g).connect(c.destination); o.start(time); o.stop(time + 0.07);
}

async function ensureMic() {
  const c = audio();
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('This browser cannot record audio. Use current Chrome, Edge, Firefox or Safari.'), { user: true });
  if (!micStream) {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
  }
  if (!recNode) {
    await c.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));
    micSrc = c.createMediaStreamSource(micStream);
    recNode = new AudioWorkletNode(c, 'studio365-recorder', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
    silentOut = c.createGain(); silentOut.gain.value = 0;
    micSrc.connect(recNode).connect(silentOut).connect(c.destination);
    monitorGain = c.createGain(); monitorGain.gain.value = $('optMonitor').checked ? 1 : 0;
    micSrc.connect(monitorGain).connect(c.destination);
    recNode.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'meter') updateMeter(m.peak);
      if (m.type === 'done' && recResolve) { const r = recResolve; recResolve = null; r(m.audio || new Float32Array(0)); }
    };
  }
}

function updateMeter(pk) {
  const db = D.gainToDb(pk);
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  $('meterFill').style.width = `${pct}%`;
  const now = performance.now();
  if (pct > peakHold || now - peakHoldTime > 1200) { peakHold = pct; peakHoldTime = now; }
  const pk2 = $('meterPeak');
  pk2.style.left = `calc(${peakHold}% - 2px)`;
  pk2.style.background = db > -1 ? 'var(--red)' : 'var(--text)';
}

async function startRecording() {
  let c;
  try {
    c = audio(); await c.resume();
    await ensureMic();
  } catch (err) {
    const msg = err.user ? err.message
      : err.name === 'NotAllowedError' ? 'Microphone access is blocked. Allow the mic for this site in your browser settings, then press Record again.'
      : err.name === 'NotFoundError' ? 'No microphone found. Plug one in or check your system sound settings.'
      : `Couldn't open the microphone: ${err.message}`;
    toast(msg, true);
    return;
  }
  projectSr();
  stopPlayback(true);
  recFrom = P.beat ? Math.min(position, P.beat.channels[0].length / P.sr - 1) : 0;
  if (recFrom < 0) recFrom = 0;
  const bpm = P.bpm || 90, spb = 60 / bpm;
  const countBeats = $('optCountIn').checked ? 4 : 0;
  const t0 = c.currentTime + 0.15;
  recStartAt = t0 + countBeats * spb;
  for (let i = 0; i < countBeats; i++) click(t0 + i * spb, i === 0);

  if (P.beat) {
    const b = c.createBuffer(P.beat.channels.length, P.beat.channels[0].length, P.sr);
    P.beat.channels.forEach((ch, i) => b.copyToChannel(ch, i));
    beatLive = c.createBufferSource(); beatLive.buffer = b;
    const g = c.createGain(); g.gain.value = D.dbToGain(P.mix.beatDb);
    beatLive.connect(g).connect(c.destination);
    beatLive.start(recStartAt, recFrom);
  }
  if ($('optClick').checked) {
    // clicks on the song grid, scheduled 200 ms ahead
    let nextBeat = Math.ceil(recFrom / spb - 1e-6);
    clickTimer = setInterval(() => {
      const horizon = c.currentTime + 0.2;
      for (;;) {
        const tt = recStartAt + nextBeat * spb - recFrom;
        if (tt > horizon) break;
        if (tt >= c.currentTime) click(tt, nextBeat % 4 === 0);
        nextBeat++;
      }
    }, 50);
  }
  recNode.port.postMessage({ cmd: 'start', frame: Math.round(recStartAt * c.sampleRate) });
  recording = true;
  $('btnRecord').setAttribute('aria-pressed', 'true');
  $('btnRecord').querySelector('.rec-label').textContent = countBeats ? 'Count-in' : 'Stop';
  if (countBeats) {
    $('btnRecord').classList.add('counting');
    setTimeout(() => { if (recording) { $('btnRecord').classList.remove('counting'); $('btnRecord').querySelector('.rec-label').textContent = 'Stop'; } }, (recStartAt - c.currentTime) * 1000);
  }
  updateTransport();
  requestAnimationFrame(tick);
}

async function stopRecording() {
  const c = audio();
  const done = new Promise((res) => { recResolve = res; });
  recNode.port.postMessage({ cmd: 'stop' });
  if (beatLive) { try { beatLive.stop(); } catch { /* noop */ } beatLive = null; }
  clearInterval(clickTimer); clickTimer = null;
  recording = false;
  const btn = $('btnRecord');
  btn.setAttribute('aria-pressed', 'false'); btn.classList.remove('counting'); btn.querySelector('.rec-label').textContent = 'Record';
  let raw = await done;
  // compensate round-trip latency so the take sits on the beat
  const track = micStream.getAudioTracks()[0];
  const inLat = (track.getSettings && track.getSettings().latency) || 0;
  const comp = Math.round(((c.baseLatency || 0) + (c.outputLatency || 0) + inLat) * c.sampleRate);
  if (comp > 0 && raw.length > comp) raw = raw.slice(comp);
  if (raw.length < c.sampleRate * 0.4) { toast('That take was too short to keep. Hold Record a little longer.'); updateTransport(); return; }
  let take = raw;
  if (c.sampleRate !== P.sr) take = (await resample([raw], c.sampleRate, P.sr))[0];
  const pk = D.peak([take]);
  const n = P.takes.length ? Math.max(...P.takes.map((t) => t.num || 0)) + 1 : 1;
  const t = { id: uid(), num: n, name: `Take ${n}`, audio: take, start: recFrom, created: Date.now() };
  P.takes.push(t);
  P.activeTake = t.id;
  if (pk > 0.98) toast('That take clipped. Back off the mic or lower your input gain for a cleaner vocal.', true);
  else if (pk < 0.03) toast('That take is very quiet. Move closer to the mic or raise your input level.', true);
  position = recFrom;
  afterTakesChanged();
}

function afterTakesChanged() {
  renderTakes();
  updateTransport();
  updateEditUi();
  drawTimeline();
  markDirty();
  scheduleTune(0);
}

// ------------------------------------------------------------------ beat + vocal import
async function loadBeat(file) {
  try {
    setRenderState(`Loading ${file.name}…`, true);
    const chans = await decodeFile(file);
    const stereo = chans.length === 1 ? [chans[0], chans[0].slice()] : chans.slice(0, 2);
    P.beat = { id: uid(), name: file.name.replace(/\.[^.]+$/, ''), channels: stereo };
    if (P.name === 'Untitled session') { P.name = P.beat.name; $('projectName').value = P.name; }
    position = 0;
    updateBeatUi(); drawTimeline(); markDirty();
    setRenderState('Reading key and tempo…', true);
    await analyzeBeat(true);
    scheduleRender(0);
  } catch (err) { toast(err.message, true); setRenderState(''); }
}

async function analyzeBeat(apply) {
  if (!P.beat) return;
  const r = await work('analyzeBeat', { channels: P.beat.channels.map((c) => c.slice()), sr: P.sr });
  P.key = r.key;
  if (apply) {
    if (r.bpm) P.bpm = r.bpm;
    P.tune.root = r.key.root; P.tune.scale = r.key.scale;
    syncControls();
    if (activeTake()) scheduleTune(0);
    toast(`Your beat reads as ${r.key.label}${r.bpm ? `, ${r.bpm} BPM` : ''}. Tuning is set to match.`);
  }
  markDirty();
  return r;
}

async function importVocal(file) {
  try {
    setRenderState(`Loading ${file.name}…`, true);
    const chans = await decodeFile(file);
    const mono = D.toMono(chans);
    const n = P.takes.length ? Math.max(...P.takes.map((t) => t.num || 0)) + 1 : 1;
    const t = { id: uid(), num: n, name: file.name.replace(/\.[^.]+$/, '').slice(0, 40), audio: mono, start: 0, created: Date.now() };
    P.takes.push(t); P.activeTake = t.id;
    afterTakesChanged();
  } catch (err) { toast(err.message, true); setRenderState(''); }
}

// ------------------------------------------------------------------ drawing
function fitCanvas(cv) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w: cv.clientWidth, h: cv.clientHeight };
}
function peaksFor(arr, cols) {
  let m = peaksCache.get(arr);
  if (!m) { m = new Map(); peaksCache.set(arr, m); }
  if (!m.has(cols)) { if (m.size > 6) m.delete(m.keys().next().value); m.set(cols, D.waveformPeaks(arr, cols)); }
  return m.get(cols);
}
function drawWave(g, peaks, x0, y0, w, h, color, cols) {
  g.fillStyle = color;
  const mid = y0 + h / 2;
  const from = Math.max(0, Math.ceil(-x0)), to = Math.min(cols, Math.floor(w - x0));
  for (let c = from; c < to; c++) {
    const mn = peaks[c * 2], mx = peaks[c * 2 + 1];
    const top = mid - mx * (h / 2) * 0.92, bot = mid - mn * (h / 2) * 0.92;
    g.fillRect(x0 + c, top, 1, Math.max(1, bot - top));
  }
}
// The stretch of the song on screen. Zoom 1 shows all of it; the pitch editor shares the same window.
function timelineDur() { return Math.max(projectDuration(), recording ? ctx.currentTime - recStartAt + recFrom + 4 : 0, 8); }
function view() {
  const dur = timelineDur(), span = dur / zoom;
  viewStart = Math.max(0, Math.min(dur - span, viewStart));
  return { t0: viewStart, span, dur };
}
function setZoom(z, around = currentPosition()) {
  const v = view();
  const frac = Math.max(0, Math.min(1, (around - v.t0) / v.span));
  zoom = Math.max(1, Math.min(64, z));
  viewStart = around - frac * (v.dur / zoom);
  $('zoomOutLabel').textContent = zoom <= 1 ? 'Fit' : `${zoom >= 10 ? Math.round(zoom) : Math.round(zoom * 10) / 10}x`;
  $('zoomOut').disabled = zoom <= 1;
  drawTimeline(); drawPitch();
}
const takeOffset = (t) => (t.start || 0) + P.mix.vocalOffsetMs / 1000;

function drawTimeline() {
  const cv = $('timelineCanvas');
  if (!cv.clientWidth) return;
  const { g, w, h } = fitCanvas(cv);
  const sr = P.sr || 48000;
  if (zoom > 1 && (playing || recording)) {
    const v0 = view(), pos = recording ? ctx.currentTime - recStartAt + recFrom : currentPosition();
    if (pos > v0.t0 + v0.span * 0.96 || pos < v0.t0) viewStart = pos - v0.span * 0.08;
  }
  const { t0, span } = view();
  const pxPerSec = w / span;
  const X = (t) => (t - t0) * pxPerSec;
  const laneH = h / 2;
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#12121a'; g.fillRect(0, 0, w, laneH);
  g.fillStyle = '#15151f'; g.fillRect(0, laneH, w, laneH);
  // bar grid, with beats once there is room for them
  const beat = 60 / (P.bpm || 90), bar = beat * 4;
  if (bar * pxPerSec > 14) {
    const fine = beat * pxPerSec > 22;
    const step = fine ? beat : bar;
    for (let k = Math.floor(t0 / step); k * step < t0 + span; k++) {
      const onBar = !fine || k % 4 === 0;
      g.fillStyle = onBar ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.03)';
      g.fillRect(Math.round(X(k * step)), 0, 1, h);
    }
  }
  g.fillStyle = '#262633'; g.fillRect(0, laneH, w, 1);
  if (P.beat) {
    const len = P.beat.channels[0].length;
    const cols = Math.max(1, Math.round((len / sr) * pxPerSec));
    drawWave(g, peaksFor(P.beat.channels[0], cols), Math.round(X(0)), 8, w, laneH - 16, P.mix.mute.beat ? 'rgba(125,125,146,0.4)' : 'rgba(34,211,238,0.55)', cols);
  }
  const t = activeTake();
  const v = vocalSignal();
  if (t && v) {
    const x0 = Math.round(X(takeOffset(t)));
    const cols = Math.max(1, Math.round((v.length / sr) * pxPerSec));
    const tuned = v !== t.audio;
    // the clip itself, so it reads as something you can pick up and move
    g.fillStyle = tuned ? 'rgba(168,85,247,0.08)' : 'rgba(237,237,242,0.05)';
    g.fillRect(x0, laneH + 5, cols, laneH - 10);
    g.fillStyle = tuned ? 'rgba(168,85,247,0.5)' : 'rgba(237,237,242,0.3)';
    g.fillRect(x0, laneH + 5, 1, laneH - 10); g.fillRect(x0 + cols - 1, laneH + 5, 1, laneH - 10);
    const col = P.mix.mute.vocal ? 'rgba(125,125,146,0.5)' : tuned ? 'rgba(168,85,247,0.85)' : 'rgba(237,237,242,0.6)';
    drawWave(g, peaksFor(v, cols), x0, laneH + 8, w, laneH - 16, col, cols);
  }
  if (sel) {
    const a = X(sel.a), b = X(sel.b);
    g.fillStyle = loopOn ? 'rgba(251,191,36,0.16)' : 'rgba(34,211,238,0.16)';
    g.fillRect(a, laneH + 1, b - a, laneH - 1);
    g.fillStyle = loopOn ? '#fbbf24' : '#22d3ee';
    g.fillRect(Math.round(a), laneH + 1, 1, laneH - 1); g.fillRect(Math.round(b), laneH + 1, 1, laneH - 1);
    if (loopOn) g.fillRect(a, 0, b - a, 3);
  }
  if (recording) {
    const a = X(recFrom), b = Math.max(a, X(ctx.currentTime - recStartAt + recFrom));
    g.fillStyle = 'rgba(239,68,68,0.22)'; g.fillRect(a, laneH + 1, b - a, laneH - 1);
    g.fillStyle = '#ef4444'; g.fillRect(b, 0, 2, h);
  } else {
    g.fillStyle = '#ededf2'; g.fillRect(Math.round(X(currentPosition())), 0, 2, h);
  }
  $('clockTotal').textContent = `/ ${fmtTime(projectDuration(), false)}`;
}

// ---- pitch editor: what was sung, where it lands, and the notes as blocks you can pick up
function currentTuned() {
  const t = activeTake();
  return P.tuned && t && P.tuned.takeId === t.id && P.tune.enabled && P.tuned.sig === tuneSig(t) ? P.tuned : null;
}
function pitchGeom() {
  const t = activeTake(), tuned = currentTuned();
  if (!t || !tuned || !tuned.f0.some((v) => v > 0)) return null;
  const cv = $('pitchCanvas');
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w) return null;
  const { f0, shift, hop, win } = tuned;
  const target = tuned.target || null;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < f0.length; i++) if (f0[i]) {
    const m = D.freqToMidi(f0[i]);
    lo = Math.min(lo, m, m + shift[i]); hi = Math.max(hi, m, m + shift[i]);
  }
  if (pitchDrag) { lo = Math.min(lo, pitchDrag.note - 1); hi = Math.max(hi, pitchDrag.note + 1); }
  lo = Math.floor(lo) - 2; hi = Math.ceil(hi) + 2;
  const { t0, span } = view();
  const sr = P.sr, off = takeOffset(t);
  const tOf = (i) => off + (i * hop + win / 2) / sr;         // project time of frame i
  const X = (time) => ((time - t0) / span) * w;
  const Y = (m) => h - 8 - ((m - lo) / (hi - lo)) * (h - 16);
  const semi = (h - 16) / (hi - lo);
  let segs = null;
  if (target) { segs = segCache.get(tuned.f0); if (!segs) { segs = D.noteSegments(f0, target); segCache.set(tuned.f0, segs); } }
  const edits = isPro() ? P.tune.edits[t.id] || [] : [];
  // seconds on the take's own clock for a frame edge
  const edge = (i) => (i * hop + win / 2 - hop / 2) / sr;
  return { t, tuned, f0, shift, hop, win, w, h, lo, hi, X, Y, semi, tOf, off, segs, edits, edge, sr, t0, span };
}
function drawPitch() {
  const panel = $('pitchPanel');
  const tuned = currentTuned();
  const voiced = tuned && tuned.f0.some((v) => v > 0);
  panel.hidden = !voiced;
  if (!voiced) return;
  const G = pitchGeom();
  if (!G) return;
  const cv = $('pitchCanvas');
  const { g, w, h } = fitCanvas(cv);
  const { f0, shift, X, Y, semi, tOf, lo, hi, segs, edits, t } = G;
  const n = f0.length;
  g.clearRect(0, 0, w, h);
  const mask = isPro() && P.tune.mask ? P.tune.mask : null;
  const scale = D.SCALES[P.tune.scale];
  const allowed = (m) => (mask ? mask[((m % 12) + 12) % 12] : scale.includes((((m - P.tune.root) % 12) + 12) % 12));
  g.font = '10px "Space Mono", monospace';
  for (let m = lo; m <= hi; m++) {
    const ok = allowed(m);
    if (ok) { g.fillStyle = 'rgba(168,85,247,0.07)'; g.fillRect(0, Y(m) - semi / 2, w, Math.max(1, semi - 1)); }
    else { g.fillStyle = 'rgba(255,255,255,0.03)'; g.fillRect(0, Y(m) - 0.5, w, 1); }
  }
  // which frames are on screen
  const frameAt = (x) => Math.round(((G.t0 + (x / w) * G.span - G.off) * G.sr - G.win / 2) / G.hop);
  const i0 = Math.max(0, frameAt(0) - 2), i1 = Math.min(n, frameAt(w) + 3);
  // notes
  const bh = Math.max(7, Math.min(22, semi * 0.82));
  const isEdited = (a, b) => edits.some((e) => !e.off && e.b > a + 0.01 && e.a < b - 0.01);
  for (const e of edits) {
    if (!e.off) continue;
    const xa = X(G.off + e.a), xb = X(G.off + e.b);
    if (xb < 0 || xa > w) continue;
    g.fillStyle = 'rgba(125,125,146,0.16)'; g.fillRect(xa, 0, xb - xa, h);
    g.fillStyle = '#7d7d92'; g.fillText('untuned', xa + 4, 12);
  }
  if (segs) for (const s of segs) {
    const a = G.edge(s.i0), b = G.edge(s.i1);
    if (edits.some((e) => e.off && e.b > a + 0.01 && e.a < b - 0.01)) continue;
    const xa = X(G.off + a), xb = X(G.off + b);
    if (xb < 0 || xa > w) continue;
    const dragging = pitchDrag && pitchDrag.seg === s;
    const note = dragging ? pitchDrag.note : s.note;
    const edited = dragging || isEdited(a, b);
    g.fillStyle = edited ? 'rgba(251,191,36,0.26)' : 'rgba(168,85,247,0.26)';
    g.strokeStyle = edited ? '#fbbf24' : 'rgba(168,85,247,0.9)';
    g.lineWidth = dragging ? 2 : 1;
    const y = Y(note) - bh / 2, bw = Math.max(3, xb - xa - 1);
    g.beginPath();
    if (g.roundRect) g.roundRect(xa + 0.5, y + 0.5, bw, bh, 3); else g.rect(xa + 0.5, y + 0.5, bw, bh);
    g.fill(); g.stroke();
    if (bw > 26) { g.fillStyle = edited ? '#fbbf24' : '#d6b4fe'; g.fillText(D.midiName(note), xa + 4, y + bh / 2 + 3.5); }
  }
  // the lines
  const step = Math.max(1, Math.floor((i1 - i0) / (w * 2)));
  const line = (fn, color, width) => {
    g.strokeStyle = color; g.lineWidth = width; g.lineJoin = 'round'; g.beginPath();
    let pen = false;
    for (let i = i0; i < i1; i += step) {
      if (!f0[i]) { pen = false; continue; }
      const px = X(tOf(i)), py = Y(fn(i));
      if (!pen) { g.moveTo(px, py); pen = true; } else g.lineTo(px, py);
    }
    g.stroke();
  };
  line((i) => D.freqToMidi(f0[i]), '#6b6b80', 1.5);
  line((i) => D.freqToMidi(f0[i]) + shift[i], '#ededf2', 1.5);
  // note names down the left edge
  g.fillStyle = 'rgba(10,10,15,0.72)'; g.fillRect(0, 0, 30, h);
  for (let m = lo; m <= hi; m++) if (allowed(m) && semi >= 9) { g.fillStyle = '#7d7d92'; g.fillText(D.midiName(m), 3, Y(m) + 3); }
  const px = X(currentPosition());
  if (px >= 0 && px <= w) { g.fillStyle = 'rgba(237,237,242,0.7)'; g.fillRect(Math.round(px), 0, 1, h); }
  $('btnResetNotes').hidden = !(isPro() && (P.tune.edits[t.id] || []).length);
}
function pitchHit(e) {
  const G = pitchGeom();
  if (!G || !G.segs) return null;
  const r = $('pitchCanvas').getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const time = G.t0 + (x / G.w) * G.span;
  for (const ed of G.edits) if (ed.off && time >= G.off + ed.a && time <= G.off + ed.b) return { G, off: ed, time, y };
  const pad = Math.max(6, G.semi / 2 + 3);
  for (const s of G.segs) {
    const a = G.off + G.edge(s.i0), b = G.off + G.edge(s.i1);
    if (time >= a && time <= b && Math.abs(y - G.Y(s.note)) <= pad) return { G, seg: s, time, y };
  }
  return { G, time, y };
}
function setNoteEdit(t, a, b, payload) {
  const list = (P.tune.edits[t.id] || []).filter((e) => e.b <= a + 0.005 || e.a >= b - 0.005);
  if (payload) list.push({ a, b, ...payload });
  list.sort((p, q) => p.a - q.a);
  P.tune.edits = { ...P.tune.edits, [t.id]: list };
  markDirty(); scheduleTune(0);
}
function bindPitchEditor() {
  const cv = $('pitchCanvas');
  cv.addEventListener('pointerdown', (e) => {
    if (e.button || recording) return;
    const hit = pitchHit(e);
    if (!hit) return;
    if (hit.off) { if (e.altKey && requirePro('Tune Pro')) setNoteEdit(hit.G.t, hit.off.a, hit.off.b, null); return; }
    if (!hit.seg) { seekTo(hit.time); return; }
    const a = hit.G.edge(hit.seg.i0), b = hit.G.edge(hit.seg.i1);
    if (e.altKey) { if (requirePro('Tune Pro')) setNoteEdit(hit.G.t, a, b, { off: true }); return; }
    cv.setPointerCapture(e.pointerId);
    pitchDrag = { seg: hit.seg, a, b, y0: e.clientY, from: hit.seg.note, note: hit.seg.note, semi: hit.G.semi, moved: false };
    e.preventDefault();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!pitchDrag) { const h = pitchHit(e); cv.style.cursor = h && h.seg ? 'ns-resize' : 'default'; return; }
    const note = pitchDrag.from + Math.round((pitchDrag.y0 - e.clientY) / pitchDrag.semi);
    if (note !== pitchDrag.note) { pitchDrag.note = Math.max(24, Math.min(96, note)); pitchDrag.moved = true; drawPitch(); }
  });
  const end = () => {
    const d = pitchDrag; pitchDrag = null;
    if (!d) return;
    const t = activeTake();
    if (d.moved && d.note !== d.from && t) {
      if (requirePro('Tune Pro')) { setNoteEdit(t, d.a, d.b, { note: d.note }); setRenderState(`Moving that note to ${D.midiName(d.note)}…`, true); }
    }
    drawPitch();
  };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  cv.addEventListener('dblclick', (e) => {
    const hit = pitchHit(e), t = activeTake();
    if (!hit || !t || !isPro()) return;
    if (hit.off) setNoteEdit(t, hit.off.a, hit.off.b, null);
    else if (hit.seg) setNoteEdit(t, hit.G.edge(hit.seg.i0), hit.G.edge(hit.seg.i1), null);
  });
  $('btnResetNotes').addEventListener('click', () => {
    const t = activeTake(); if (!t) return;
    P.tune.edits = { ...P.tune.edits, [t.id]: [] }; markDirty(); scheduleTune(0);
    toast('Your hand-placed notes are cleared. The scale decides again.');
  });
}

// ------------------------------------------------------------------ editing
function seekTo(time) {
  const was = playing;
  stopPlayback(true);
  position = Math.max(0, Math.min(time, projectDuration()));
  if (was) startPlayback(position); else { updateTransport(); drawTimeline(); drawPitch(); }
}
// The selection, in samples of the active take.
function selRange(t) {
  if (!sel) return null;
  const off = takeOffset(t), sr = P.sr;
  const a = Math.max(0, Math.round((sel.a - off) * sr)), b = Math.min(t.audio.length, Math.round((sel.b - off) * sr));
  return b - a > 32 ? [a, b] : null;
}
function updateEditUi() {
  const t = activeTake();
  const r = t ? selRange(t) : null;
  const busy = recording;
  document.querySelectorAll('.eb[data-edit]').forEach((b) => {
    const k = b.dataset.edit;
    const needsSel = ['trim', 'remove', 'silence', 'fadeIn', 'fadeOut', 'copy'].includes(k);
    b.disabled = busy || !t || (needsSel && !r);
  });
  $('btnLoop').disabled = !sel && !loopOn;
  $('btnLoop').setAttribute('aria-pressed', String(loopOn));
  $('btnUndo').disabled = busy || !undoStack.length;
  $('btnRedo').disabled = busy || !redoStack.length;
  $('toolSelect').setAttribute('aria-pressed', String(tool === 'select'));
  $('toolMove').setAttribute('aria-pressed', String(tool === 'move'));
  $('timeline').classList.toggle('tool-move', tool === 'move');
  $('selReadout').textContent = sel
    ? `Selected ${fmtTime(sel.a)} to ${fmtTime(sel.b)} (${(sel.b - sel.a).toFixed(2)} s)${r ? '' : '. No vocal in that range.'}`
    : !t ? 'Record or import a vocal to edit it.' : tool === 'move' ? 'Drag the vocal left or right to move it against the beat.' : 'Drag across the vocal to select. Gain, Normalize and Reverse work on the whole take when nothing is selected.';
}
function snapshot(t) { return { takeId: t.id, audio: t.audio, start: t.start || 0, edits: P.tune.edits[t.id] || [] }; }
function restore(snap) {
  const t = P.takes.find((x) => x.id === snap.takeId);
  if (!t) return null;
  const now = snapshot(t);
  t.audio = snap.audio; t.start = snap.start; t.rev = (t.rev || 0) + 1;
  P.tune.edits = { ...P.tune.edits, [t.id]: snap.edits };
  invalidateTake(t);
  return now;
}
function invalidateTake(t) {
  if (P.tuned && P.tuned.takeId === t.id) P.tuned = null;
  stackCache.double = null; stackCache.harmony = null; stackCache.takes.delete(t.id);
}
function commitEdit(t, audio, start, edits, msg) {
  undoStack.push(snapshot(t)); if (undoStack.length > 12) undoStack.shift();
  redoStack = [];
  t.audio = audio; t.start = Math.max(0, start); t.rev = (t.rev || 0) + 1;
  P.tune.edits = { ...P.tune.edits, [t.id]: edits };
  invalidateTake(t);
  afterTakesChanged();
  if (msg) toast(msg);
}
function applyEdit(kind) {
  const t = activeTake();
  if (!t || recording) return;
  const sr = P.sr, r = selRange(t);
  const needsSel = ['trim', 'remove', 'silence', 'fadeIn', 'fadeOut', 'copy'].includes(kind);
  if (needsSel && !r) { toast('Drag across the vocal first to choose the part to edit.'); return; }
  const [a, b] = r || [0, t.audio.length];
  const aS = a / sr, bS = b / sr, where = r ? 'the selection' : t.name;
  const edits = P.tune.edits[t.id] || [];
  const start = t.start || 0;
  switch (kind) {
    case 'trim': commitEdit(t, Edit.trim(t.audio, a, b, sr), start + aS, Edit.shiftNoteEdits(edits, 'trim', aS, bS), `${t.name} trimmed to the selection.`); sel = null; break;
    case 'remove':
      if (t.audio.length - (b - a) < sr * 0.2) { toast('That would leave nothing of the take. Delete the take instead.'); return; }
      commitEdit(t, Edit.remove(t.audio, a, b, sr), start, Edit.shiftNoteEdits(edits, 'remove', aS, bS), 'Cut out. Everything after it moved up to close the gap.'); sel = null; break;
    case 'silence': commitEdit(t, Edit.silence(t.audio, a, b, sr), start, Edit.shiftNoteEdits(edits, 'silence', aS, bS), 'Silenced. The timing around it is untouched.'); break;
    case 'fadeIn': commitEdit(t, Edit.fadeIn(t.audio, a, b), start, edits, 'Fade in added.'); break;
    case 'fadeOut': commitEdit(t, Edit.fadeOut(t.audio, a, b), start, edits, 'Fade out added.'); break;
    case 'up': case 'down': commitEdit(t, Edit.gain(t.audio, a, b, kind === 'up' ? 1 : -1, sr), start, edits, `${kind === 'up' ? '+1' : '-1'} dB on ${where}.`); break;
    case 'normalize': {
      const n = Edit.normalize(t.audio, a, b, sr, -3);
      if (Math.abs(n.db) < 0.1) { toast(`${r ? 'The selection' : t.name} already peaks at -3 dB.`); return; }
      commitEdit(t, n.audio, start, edits, `${n.db > 0 ? 'Turned up' : 'Turned down'} ${Math.abs(n.db).toFixed(1)} dB so ${where} peaks at -3 dB.`); break;
    }
    case 'reverse': commitEdit(t, Edit.reverse(t.audio, a, b), start, Edit.shiftNoteEdits(edits, 'reverse', aS, bS), `${r ? 'Selection' : t.name} reversed.`); break;
    case 'copy': {
      const num = Math.max(...P.takes.map((x) => x.num || 0)) + 1;
      P.takes.push({ id: uid(), num, name: `${t.name} cut`.slice(0, 40), audio: Edit.trim(t.audio, a, b, sr), start: start + aS, created: Date.now() });
      afterTakesChanged();
      toast('New take made from the selection. Stack it behind the lead from the Stack tab, or pick it as the lead.');
      break;
    }
    default: return;
  }
  updateEditUi();
}
function undo() {
  const s = undoStack.pop(); if (!s) return;
  const now = restore(s); if (now) redoStack.push(now);
  afterTakesChanged(); toast('Undone.');
}
function redo() {
  const s = redoStack.pop(); if (!s) return;
  const now = restore(s); if (now) undoStack.push(now);
  afterTakesChanged(); toast('Redone.');
}
function bindEditing() {
  document.querySelectorAll('.eb[data-edit]').forEach((b) => b.addEventListener('click', () => applyEdit(b.dataset.edit)));
  $('btnUndo').addEventListener('click', undo);
  $('btnRedo').addEventListener('click', redo);
  $('toolSelect').addEventListener('click', () => { tool = 'select'; updateEditUi(); });
  $('toolMove').addEventListener('click', () => { tool = 'move'; updateEditUi(); });
  $('btnLoop').addEventListener('click', toggleLoop);
  $('zoomIn').addEventListener('click', () => setZoom(zoom * 2, sel ? (sel.a + sel.b) / 2 : currentPosition()));
  $('zoomOut').addEventListener('click', () => setZoom(zoom / 2, sel ? (sel.a + sel.b) / 2 : currentPosition()));

  const tl = $('timeline');
  const at = (e) => { const r = tl.getBoundingClientRect(); const v = view(); return { time: v.t0 + ((e.clientX - r.left) / r.width) * v.span, lower: e.clientY > r.top + r.height / 2, pps: r.width / v.span }; };
  tl.addEventListener('pointerdown', (e) => {
    if (recording || e.button || e.target.closest('button')) return;
    const p = at(e), t = activeTake();
    tlDrag = { x0: e.clientX, t0: p.time, mode: p.lower && t ? tool : 'seek', moved: false, start: t ? t.start || 0 : 0, pps: p.pps };
    tl.setPointerCapture(e.pointerId);
  });
  tl.addEventListener('pointermove', (e) => {
    const d = tlDrag; if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.x0) < 4) return;
    d.moved = true;
    const p = at(e);
    if (d.mode === 'select') {
      const dur = timelineDur();
      sel = { a: Math.max(0, Math.min(d.t0, p.time)), b: Math.min(dur, Math.max(d.t0, p.time)) };
      drawTimeline(); updateEditUi();
    } else if (d.mode === 'move') {
      const t = activeTake();
      t.start = Math.max(0, d.start + (e.clientX - d.x0) / d.pps);
      drawTimeline(); drawPitch();
    }
  });
  const up = (e) => {
    const d = tlDrag; tlDrag = null;
    if (!d) return;
    if (!d.moved) { if (d.mode === 'select' && sel) { sel = null; if (loopOn) { loopOn = false; } updateEditUi(); } seekTo(at(e).time); return; }
    if (d.mode === 'select') {
      if (sel && sel.b - sel.a < 0.03) sel = null;
      updateEditUi(); drawTimeline();
      if (sel && loopOn && playing) restartPlayback(sel.a);
    } else if (d.mode === 'move') {
      const t = activeTake();
      undoStack.push({ takeId: t.id, audio: t.audio, start: d.start, edits: P.tune.edits[t.id] || [] }); if (undoStack.length > 12) undoStack.shift();
      redoStack = [];
      const ms = Math.round((t.start - d.start) * 1000);
      markDirty(); updateEditUi(); scheduleRender(0);
      toast(ms ? `${t.name} moved ${Math.abs(ms)} ms ${ms > 0 ? 'later' : 'earlier'}.` : `${t.name} is where it was.`);
    }
  };
  tl.addEventListener('pointerup', up);
  tl.addEventListener('pointercancel', () => { tlDrag = null; });
  tl.addEventListener('wheel', (e) => {
    const r = tl.getBoundingClientRect(), v = view();
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setZoom(zoom * (e.deltaY < 0 ? 1.3 : 1 / 1.3), v.t0 + ((e.clientX - r.left) / r.width) * v.span);
    } else if (zoom > 1 && (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey)) {
      e.preventDefault();
      viewStart += ((Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / r.width) * v.span;
      drawTimeline(); drawPitch();
    }
  }, { passive: false });
}
function toggleLoop() {
  if (!sel && !loopOn) return;
  loopOn = !loopOn;
  updateEditUi(); drawTimeline();
  if (loopOn && playing && sel) restartPlayback(sel.a);
}

// ------------------------------------------------------------------ UI binding
function renderTakes() {
  const list = $('takeList');
  list.textContent = '';
  $('takesEmpty').hidden = P.takes.length > 0;
  for (const t of P.takes) {
    const li = document.createElement('li');
    li.className = 'take' + (t.id === P.activeTake ? ' active' : '');
    const radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'take'; radio.checked = t.id === P.activeTake;
    radio.setAttribute('aria-label', `Use ${t.name}`);
    radio.addEventListener('change', () => { const was = playing; stopPlayback(true); P.activeTake = t.id; if (!was) position = t.start || 0; afterTakesChanged(); if (was) startPlayback(position); });
    const name = document.createElement('input');
    name.className = 'take-name'; name.value = t.name; name.maxLength = 40; name.setAttribute('aria-label', 'Take name');
    name.addEventListener('change', () => { t.name = name.value.trim() || t.name; name.value = t.name; markDirty(); updateBeatUi(); });
    const len = document.createElement('span');
    len.className = 'take-len'; len.textContent = fmtTime(t.audio.length / P.sr);
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'take-del'; del.textContent = 'Delete';
    del.addEventListener('click', () => {
      if (!confirm(`Delete ${t.name}? This can't be undone.`)) return;
      P.takes = P.takes.filter((x) => x.id !== t.id);
      if (P.activeTake === t.id) P.activeTake = P.takes.length ? P.takes[P.takes.length - 1].id : null;
      if (P.tuned && P.tuned.takeId === t.id) P.tuned = null;
      delete P.stack.takes[t.id]; stackCache.takes.delete(t.id);
      const ed = { ...P.tune.edits }; delete ed[t.id]; P.tune.edits = ed;
      undoStack = undoStack.filter((u) => u.takeId !== t.id); redoStack = redoStack.filter((u) => u.takeId !== t.id);
      afterTakesChanged();
    });
    li.append(radio, name, len, del);
    list.append(li);
  }
  renderStackTakes();
  updateBeatUi();
}

function renderStackTakes() {
  const list = $('stackTakes');
  list.textContent = '';
  const others = P.takes.filter((t) => t.id !== P.activeTake);
  $('stackTakesNote').hidden = others.length > 0;
  for (const t of others) {
    const st = P.stack.takes[t.id] || { on: false, db: -8, pan: 0 };
    const li = document.createElement('li');
    li.className = 'stack-take' + (st.on && isPro() ? ' on' : '');
    const head = document.createElement('div'); head.className = 'stack-take-head';
    const nm = document.createElement('span'); nm.textContent = t.name;
    const tg = document.createElement('button'); tg.type = 'button'; tg.className = 'stack-toggle';
    tg.setAttribute('aria-pressed', String(!!st.on && isPro())); tg.textContent = st.on && isPro() ? 'Stacked' : 'Stack it';
    tg.addEventListener('click', () => {
      if (!requirePro('Vocal stacks')) return;
      // alternate sides so two stacked takes spread left and right
      const side = stackedTakes().length % 2 ? 35 : -35;
      P.stack.takes[t.id] = { db: -8, pan: side, ...P.stack.takes[t.id], on: !st.on };
      renderStackTakes(); updateBeatUi(); markDirty(); scheduleRender(0);
    });
    head.append(nm, tg); li.append(head);
    if (st.on && isPro()) {
      const mini = (label, key, min, max, step, fmt) => {
        const row = document.createElement('label'); row.className = 'mini';
        const sp = document.createElement('span'); sp.textContent = label;
        const inp = document.createElement('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = st[key];
        const o = document.createElement('output'); o.textContent = fmt(st[key]);
        inp.addEventListener('input', () => { P.stack.takes[t.id][key] = Number(inp.value); o.textContent = fmt(Number(inp.value)); markDirty(); scheduleRender(); });
        row.append(sp, inp, o); return row;
      };
      li.append(mini('Level', 'db', -24, 0, 0.5, (v) => `${v.toFixed(1)} dB`), mini('Pan', 'pan', -100, 100, 1, (v) => fmtVal('pan', v)));
    }
    list.append(li);
  }
}

function updateBeatUi() {
  $('beatName').textContent = P.beat ? P.beat.name : 'No beat loaded';
  const t = activeTake();
  const extra = stackActive() ? stackedTakes().length : 0;
  $('vocalName').textContent = t ? t.name + (extra ? ` + ${extra} stacked` : '') : 'No take yet';
  $('btnCheck').disabled = !mixCache;
  $('stackNeedsTake').hidden = !!t;
  $('dropHint').hidden = !!P.beat;
  $('btnDetectKey').disabled = !P.beat;
  $('btnBalance').disabled = !(P.beat && t);
  $('btnReplaceBeat').textContent = P.beat ? 'Replace beat' : 'Add beat';
  $('keyReadout').textContent = `${D.NOTE_NAMES[P.tune.root]} ${P.tune.scale === 'major' || P.tune.scale === 'minor' ? P.tune.scale : D.SCALE_LABELS[P.tune.scale].toLowerCase()}`;
}

function updateTransport() {
  const btn = $('btnPlay');
  btn.classList.toggle('playing', playing);
  btn.setAttribute('aria-label', playing ? 'Stop' : 'Play');
  btn.disabled = recording || (!P.beat && !activeTake());
  $('btnExport').disabled = !mixCache || recording;
  $('btnCheck').disabled = !mixCache || recording;
  $('btnRewind').disabled = recording;
  if (!playing && !recording) $('clock').textContent = fmtTime(position);
  updateEditUi();
}

function fmtVal(key, v) {
  switch (key) {
    case 'vocalDb': case 'beatDb': case 'body': case 'presence': case 'air': return `${v > 0 ? '+' : ''}${Number(v).toFixed(1)} dB`;
    case 'sibilance': return v ? `-${Number(v).toFixed(1)} dB` : 'Off';
    case 'pan': return v == 0 ? 'Center' : v < 0 ? `L ${-v}` : `R ${v}`;
    case 'hpf': return `${v} Hz`;
    case 'vocalOffsetMs': return v == 0 ? 'On grid' : `${v > 0 ? 'Later' : 'Earlier'} ${Math.abs(v)} ms`;
    case 'speedMs': return v == 0 ? 'Instant' : `${v} ms`;
    case 'gate': case 'double': case 'harmonyLevel': case 'glue': case 'humanize': case 'flex': case 'reverb': case 'delay': return v == 0 ? 'Off' : `${v}%`;
    case 'beatLow': case 'beatMid': case 'beatHigh': case 'compMakeup': case 'mud': return `${v > 0 ? '+' : ''}${Number(v).toFixed(1)} dB`;
    case 'compThr': return `${Number(v).toFixed(1)} dB`;
    case 'compRatio': return `${Number(v).toFixed(1)} : 1`;
    case 'compAtk': case 'compRel': case 'revPre': return `${v} ms`;
    case 'deessHz': case 'revTone': case 'delayTone': case 'revLowCut': return v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${v} Hz`;
    case 'revDecay': return `${Number(v).toFixed(1)} s`;
    case 'delayWide': return v == 0 ? 'Center' : `${v}%`;
    case 'glideMs': return v == 0 ? 'Step' : `${v} ms`;
    case 'transpose': return v == 0 ? 'None' : `${v > 0 ? '+' : ''}${v} semitone${Math.abs(v) === 1 ? '' : 's'}`;
    case 'formant': return v == 0 ? 'Natural' : `${v > 0 ? '+' : ''}${Number(v).toFixed(1)}`;
    case 'detune': return v == 0 ? 'A = 440' : `${v > 0 ? '+' : ''}${v} cents`;
    default: return `${v}%`;
  }
}
function paintFader(input) {
  const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--pct', `${pct}%`);
}
function syncControls() {
  document.querySelectorAll('.fader[data-group]').forEach((f) => {
    const input = f.querySelector('input'); const group = f.dataset.group, key = f.dataset.key;
    input.value = P[group][key];
    f.querySelector('output').textContent = fmtVal(key, P[group][key]);
    paintFader(input);
  });
  $('tuneOn').checked = P.tune.enabled;
  $('tuneRoot').value = String(P.tune.root);
  $('tuneScale').value = P.tune.scale;
  $('harmonySelect').value = P.stack.harmony;
  $('presetSelect').value = P.preset || '';
  showPresetAbout();
  $('masterOn').checked = P.master.enabled;
  document.querySelectorAll('input[name="target"]').forEach((r) => { r.checked = Number(r.value) === P.master.target; });
  $('bpm').value = P.bpm;
  $('projectName').value = P.name;
  $('compOn').checked = !!P.mix.compOn;
  $('delayNote').value = P.mix.delayNote;
  renderKeys(); syncBand(); syncConsole(); drawEq();
  updateBeatUi();
}

// ---- the note keyboard: which notes the tuning may land on
function allowedNotes() {
  if (isPro() && P.tune.mask) return P.tune.mask.slice();
  const sc = D.SCALES[P.tune.scale];
  return Array.from({ length: 12 }, (_, pc) => sc.includes((((pc - P.tune.root) % 12) + 12) % 12));
}
function renderKeys() {
  const box = $('noteKeys');
  const ok = allowedNotes();
  box.textContent = '';
  D.NOTE_NAMES.forEach((name, pc) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'key' + (name.includes('#') ? ' sharp' : '') + (pc === P.tune.root ? ' root' : '');
    b.textContent = name; b.setAttribute('aria-pressed', String(ok[pc]));
    b.title = ok[pc] ? `${name} is in. Click to keep the tuning off it.` : `${name} is out. Click to let the tuning land on it.`;
    b.addEventListener('click', () => {
      if (!requirePro('Tune Pro')) return;
      const next = allowedNotes(); next[pc] = !next[pc];
      if (!next.some(Boolean)) { toast('Keep at least one note in.'); return; }
      const sc = D.SCALES[P.tune.scale];
      const same = next.every((v, i) => v === sc.includes((((i - P.tune.root) % 12) + 12) % 12));
      P.tune.mask = same ? null : next;
      renderKeys(); markDirty(); scheduleTune(0);
    });
    box.append(b);
  });
  $('btnKeysReset').hidden = !(isPro() && P.tune.mask);
}

// ---- console plumbing
function setMix(key, v) {
  P.mix[key] = v;
  const f = document.querySelector(`.fader[data-group="mix"][data-key="${key}"]`);
  if (f) { const input = f.querySelector('input'); input.value = v; f.querySelector('output').textContent = fmtVal(key, v); paintFader(input); }
  markDirty(); scheduleRender();
}
function selectChannel(ch) {
  if (ch === 'stack') { $('tab-stack').click(); selectStrip('stack'); return; }
  $('tab-mix').click();
  document.querySelectorAll('.chan-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ch === ch)));
  document.querySelectorAll('.chan').forEach((c) => { c.hidden = c.dataset.ch !== ch; });
  selectStrip(ch);
  if (ch === 'vocal') drawEq();
}
const Q_MIN = 0.3, Q_MAX = 8;
function syncBand() {
  const b = selectedBand();
  if (!b) return;
  document.querySelectorAll('#bandTabs button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.band === b.id)));
  const m = P.mix;
  const setRow = (id, on, value, text) => {
    const row = $(id), input = row.querySelector('input');
    row.classList.toggle('off', !on); input.disabled = !on;
    if (on) input.value = value;
    row.querySelector('output').textContent = on ? text : 'n/a';
    paintFader(input);
  };
  const hz = m[b.f];
  setRow('bandFreq', true, Math.round((Math.log(hz / b.fMin) / Math.log(b.fMax / b.fMin)) * 1000), hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${Math.round(hz)} Hz`);
  setRow('bandGain', !!b.g, b.g ? m[b.g] : 0, b.g ? `${m[b.g] > 0 ? '+' : ''}${Number(m[b.g]).toFixed(1)} dB` : '');
  setRow('bandQ', !!b.q, b.q ? Math.round((Math.log(m[b.q] / Q_MIN) / Math.log(Q_MAX / Q_MIN)) * 100) : 0, b.q ? `Q ${Number(m[b.q]).toFixed(2)}` : '');
}
function bindConsole() {
  initConsole({
    root: $('strips'),
    mix: () => P.mix,
    set: (key, v) => { setMix(key, v); if (key.endsWith('Db')) { /* strip faders */ } },
    reset: (keys) => { keys.forEach((k) => setMix(k, DEFAULT_MIX[k])); },
    flag: (kind, ch, on) => {
      P.mix[kind] = { ...P.mix[kind], [ch]: on };
      syncConsole(); drawTimeline();
      if (kind === 'mute') markDirty();
      scheduleRender();
    },
    select: selectChannel,
    graph: () => live,
    playing: () => playing,
    onFrame: (red, on) => {
      const bar = (id, db) => { const v = red && on ? Math.min(0, db) : 0; $(id).style.width = `${Math.min(100, (Math.abs(v) / 18) * 100)}%`; $(`${id}Val`).textContent = `${v.toFixed(1)} dB`; };
      if ($('panel-mix').hidden) return;
      bar('grComp', red ? red.comp : 0); bar('grDeess', red ? red.deess : 0); bar('grGlue', red ? red.glue : 0);
      if (on && live && !document.querySelector('.chan[data-ch="vocal"]').hidden) drawEq(live.fx.eq);
    },
  });
  initEq($('eqCanvas'), { onSelect: syncBand });
  EQ_BANDS.forEach((b) => {
    const x = document.createElement('button'); x.type = 'button'; x.dataset.band = b.id; x.textContent = b.label; x.style.setProperty('--dot', b.color);
    x.addEventListener('click', () => selectBand(b.id));
    $('bandTabs').append(x);
  });
  $('f-bandFreq').addEventListener('input', (e) => { const b = selectedBand(); const hz = b.fMin * Math.pow(b.fMax / b.fMin, Number(e.target.value) / 1000); setMix(b.f, hz >= 1000 ? Math.round(hz / 10) * 10 : Math.round(hz)); syncBand(); drawEq(); });
  $('f-bandGain').addEventListener('input', (e) => { const b = selectedBand(); if (!b.g) return; setMix(b.g, Number(e.target.value)); syncBand(); drawEq(); });
  $('f-bandQ').addEventListener('input', (e) => { const b = selectedBand(); if (!b.q) return; setMix(b.q, Math.round(Q_MIN * Math.pow(Q_MAX / Q_MIN, Number(e.target.value) / 100) * 100) / 100); syncBand(); drawEq(); });
  document.querySelectorAll('.chan-tabs button').forEach((b) => b.addEventListener('click', () => selectChannel(b.dataset.ch)));
  $('compOn').addEventListener('change', (e) => { P.mix.compOn = e.target.checked; markDirty(); scheduleRender(); });
  Object.entries(DELAY_NOTES).forEach(([k, n]) => $('delayNote').add(new Option(n.label, k)));
  $('delayNote').addEventListener('change', (e) => { P.mix.delayNote = e.target.value; markDirty(); scheduleRender(); });
  $('btnKeysReset').addEventListener('click', () => { P.tune.mask = null; renderKeys(); markDirty(); scheduleTune(0); });
  selectStrip('vocal');
}

function bindControls() {
  D.NOTE_NAMES.forEach((n, i) => $('tuneRoot').add(new Option(n, String(i))));
  Object.entries(D.SCALE_LABELS).forEach(([k, label]) => $('tuneScale').add(new Option(label, k)));

  document.querySelectorAll('.fader[data-group]').forEach((f) => {
    const input = f.querySelector('input'); const group = f.dataset.group, key = f.dataset.key;
    input.addEventListener('input', () => {
      if (group === 'stack' && !isPro()) { input.value = P.stack[key]; paintFader(input); openPro('Vocal stacks'); return; }
      if (f.dataset.pro && !isPro()) { input.value = P[group][key]; paintFader(input); openPro(f.dataset.pro); return; }
      P[group][key] = Number(input.value);
      f.querySelector('output').textContent = fmtVal(key, P[group][key]);
      paintFader(input);
      if (group === 'tune') { scheduleTune(); } else { drawTimeline(); scheduleRender(); }
      markDirty();
    });
    input.addEventListener('dblclick', () => {
      const def = DEFAULTS[group][key];
      input.value = def; input.dispatchEvent(new Event('input'));
    });
  });
  $('tuneOn').addEventListener('change', (e) => { P.tune.enabled = e.target.checked; markDirty(); drawTimeline(); scheduleTune(0); });
  $('tuneRoot').addEventListener('change', (e) => { P.tune.root = Number(e.target.value); P.tune.mask = null; renderKeys(); updateBeatUi(); markDirty(); scheduleTune(0); });
  $('tuneScale').addEventListener('change', (e) => { P.tune.scale = e.target.value; P.tune.mask = null; renderKeys(); updateBeatUi(); markDirty(); scheduleTune(0); });
  $('masterOn').addEventListener('change', (e) => { P.master.enabled = e.target.checked; markDirty(); scheduleRender(0); });
  document.querySelectorAll('input[name="target"]').forEach((r) => r.addEventListener('change', () => { P.master.target = Number(r.value); markDirty(); scheduleRender(0); }));
  $('bpm').addEventListener('change', (e) => {
    const v = Math.max(40, Math.min(220, Math.round(Number(e.target.value) || 90)));
    P.bpm = v; e.target.value = v; markDirty(); drawTimeline(); scheduleRender();
  });
  $('projectName').addEventListener('change', (e) => { P.name = e.target.value.trim() || 'Untitled session'; e.target.value = P.name; markDirty(); });
  $('projectName').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

  $('btnDetectKey').addEventListener('click', async () => {
    setRenderState('Reading key and tempo…', true);
    try { await analyzeBeat(true); } catch (err) { toast(err.message, true); }
    scheduleRender(0);
  });
  $('btnBalance').addEventListener('click', balanceNow);
  $('btnResetMix').addEventListener('click', () => { P.mix = migrateMix({}); P.preset = ''; syncControls(); drawTimeline(); markDirty(); scheduleRender(0); toast('The console is back to its starting mix.'); });

  // stack + presets
  Object.entries(D.HARMONIES).forEach(([k, h]) => $('harmonySelect').add(new Option(h ? h.label : 'No harmony', k)));
  $('harmonySelect').addEventListener('change', (e) => {
    if (!requirePro('Auto harmony')) { e.target.value = P.stack.harmony; return; }
    P.stack.harmony = e.target.value; markDirty(); scheduleRender(0);
  });
  const free = document.createElement('optgroup'); free.label = 'Included';
  const paid = document.createElement('optgroup'); paid.label = 'Pro';
  PRESETS.forEach((p) => (p.pro ? paid : free).append(new Option(p.name, p.id)));
  $('presetSelect').append(free, paid);
  $('presetSelect').addEventListener('change', (e) => applyPreset(e.target.value));
  $('btnPro').addEventListener('click', () => openPro());
  $('btnCheck').addEventListener('click', runCheck);
  $('btnReleasePack').addEventListener('click', openRelease);
  $('releaseForm').addEventListener('submit', (e) => { e.preventDefault(); buildRelease(); });
  $('releaseForm').addEventListener('input', () => { const m = $('relMsg'); if (m.classList.contains('err')) { m.className = 'note'; m.textContent = ''; } });
  $('coverDrop').addEventListener('click', () => $('fileCover').click());
  $('fileCover').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) setCover(f); });
  $('btnBackup').addEventListener('click', backupSession);
  $('btnRestore').addEventListener('click', () => { if (requirePro('Session backup')) $('fileSession').click(); });
  $('fileSession').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) restoreSession(f); });

  // tabs
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  tabs.forEach((tab) => tab.addEventListener('click', () => {
    tabs.forEach((t) => { const on = t === tab; t.setAttribute('aria-selected', String(on)); $(t.getAttribute('aria-controls')).hidden = !on; });
  }));
  tabs.forEach((tab, i) => tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    next.focus(); next.click();
  }));

  // transport
  $('btnRecord').addEventListener('click', () => (recording ? stopRecording() : startRecording()));
  $('btnPlay').addEventListener('click', () => (playing ? stopPlayback(true) : startPlayback()));
  $('btnRewind').addEventListener('click', () => { const was = playing; stopPlayback(false); position = 0; viewStart = 0; if (was) startPlayback(0); updateTransport(); drawTimeline(); drawPitch(); });
  $('optMonitor').addEventListener('change', (e) => {
    if (monitorGain) monitorGain.gain.setTargetAtTime(e.target.checked ? 1 : 0, audio().currentTime, 0.01);
    if (e.target.checked) toast('Wear headphones while you hear your mic, or the speakers will feed back.');
  });

  // timeline: seek, select, move (see bindEditing) + drag and drop
  const tl = $('timeline');
  bindEditing(); bindPitchEditor(); bindConsole();
  ['dragenter', 'dragover'].forEach((ev) => tl.addEventListener(ev, (e) => { e.preventDefault(); tl.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => tl.addEventListener(ev, () => tl.classList.remove('dragover')));
  tl.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (!f) return;
    const r = tl.getBoundingClientRect();
    if (P.beat && e.clientY > r.top + r.height / 2) importVocal(f); else loadBeat(f);
  });
  $('btnPickBeat').addEventListener('click', (e) => { e.stopPropagation(); $('fileBeat').click(); });
  $('btnReplaceBeat').addEventListener('click', () => $('fileBeat').click());
  $('btnImportVocal').addEventListener('click', () => $('fileVocal').click());
  $('fileBeat').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadBeat(f); });
  $('fileVocal').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importVocal(f); });

  // keyboard
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'select', 'textarea', 'button'].includes(tag) && !(tag === 'input' && ['range', 'radio', 'checkbox'].includes(e.target.type))) return;
    if (document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (!recording) (e.shiftKey ? redo() : undo()); return; }
    if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); if (!recording) redo(); return; }
    if (mod || e.altKey) return;
    if (e.code === 'Space') { e.preventDefault(); if (!recording) (playing ? stopPlayback(true) : startPlayback()); }
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); recording ? stopRecording() : startRecording(); }
    if (e.key === 'l' || e.key === 'L') { e.preventDefault(); toggleLoop(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); applyEdit('silence'); }
    if (e.key === 'Escape' && sel) { sel = null; loopOn = false; updateEditUi(); drawTimeline(); }
    if (e.key === '=' || e.key === '+') setZoom(zoom * 2);
    if (e.key === '-') setZoom(zoom / 2);
  });

  // sessions
  $('btnLibrary').addEventListener('click', openLibrary);
  $('btnNew').addEventListener('click', async () => {
    if (recording) return;
    stopPlayback(false);
    await save();
    loadIntoUi(newProject());
    toast('New session started. Your last one is saved under Sessions.');
  });
  $('btnExport').addEventListener('click', () => {
    $('exportProgress').hidden = true;
    const names = { vocal: 'the vocal', stack: 'the stack', beat: 'the beat', rev: 'the reverb', delay: 'the echo' };
    const soloed = Object.keys(P.mix.solo).filter((k) => P.mix.solo[k]), muted = Object.keys(P.mix.mute).filter((k) => P.mix.mute[k]);
    const note = $('exportNote');
    note.hidden = !soloed.length && !muted.length;
    note.textContent = soloed.length ? `Heads up: ${soloed.map((k) => names[k]).join(' and ')} ${soloed.length > 1 ? 'are' : 'is'} soloed, so the export will hold only that. Clear the solo on the console for the full record.`
      : `Heads up: ${muted.map((k) => names[k]).join(' and ')} ${muted.length > 1 ? 'are' : 'is'} muted on the console and will be missing from the export.`;
    $('exportDialog').showModal();
  });
  document.querySelectorAll('.export-opt[data-format]').forEach((b) => b.addEventListener('click', () => exportAs(b.dataset.format)));

  window.addEventListener('resize', () => { drawTimeline(); drawPitch(); drawEq(); });
  window.addEventListener('beforeunload', (e) => { if (recording) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { clearTimeout(saveTimer); if (P.beat || P.takes.length) save(); } });
}

// ------------------------------------------------------------------ sessions library
async function openLibrary() {
  const list = $('sessionList');
  list.textContent = '';
  const all = await Store.listProjects();
  if (!all.length) {
    const li = document.createElement('li'); li.className = 'session';
    li.innerHTML = '<span><b>No saved sessions yet</b><small>Load a beat or record a take and it saves here automatically.</small></span>';
    list.append(li);
  }
  for (const p of all) {
    const li = document.createElement('li');
    li.className = 'session' + (p.id === P.id ? ' current' : '');
    const info = document.createElement('span');
    const b = document.createElement('b'); b.textContent = p.name;
    const s = document.createElement('small');
    s.textContent = `${new Date(p.updated).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${p.takes} take${p.takes === 1 ? '' : 's'} · ${fmtTime(p.seconds, false)}`;
    info.append(b, s);
    const open = document.createElement('button'); open.className = 'btn ghost small'; open.type = 'button';
    open.textContent = p.id === P.id ? 'Open now' : 'Open';
    open.disabled = p.id === P.id;
    open.addEventListener('click', async () => {
      stopPlayback(false); await save();
      const full = await Store.loadProject(p.id);
      if (full) loadIntoUi(full);
      $('libraryDialog').close();
    });
    const del = document.createElement('button'); del.className = 'take-del'; del.type = 'button'; del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (!confirm(`Delete "${p.name}" and all its takes? This can't be undone.`)) return;
      await Store.deleteProject(p.id);
      if (p.id === P.id) loadIntoUi(newProject());
      openLibrary();
    });
    li.append(info, open, del);
    list.append(li);
  }
  const est = await Store.storageEstimate();
  $('storageNote').textContent = est
    ? `Sessions stay in this browser on this device. Using ${(est.usage / 1e6).toFixed(0)} MB of about ${(est.quota / 1e9).toFixed(1)} GB available. Export mixes you want to keep forever.`
    : 'Sessions stay in this browser on this device. Export mixes you want to keep forever.';
  if (!$('libraryDialog').open) $('libraryDialog').showModal();
}

function loadIntoUi(p) {
  P = p;
  P.stack = { ...DEFAULT_STACK, ...P.stack, takes: { ...(P.stack?.takes || {}) } };
  P.preset = P.preset || ''; P.release = P.release || null; P.cover = P.cover || null;
  stackCache = { double: null, harmony: null, takes: new Map() };
  P.tune = { ...DEFAULT_TUNE, ...P.tune, edits: { ...(P.tune?.edits || {}) } };
  P.mix = migrateMix(P.mix);
  zoom = 1; viewStart = 0; sel = null; loopOn = false; undoStack = []; redoStack = [];
  $('zoomOutLabel').textContent = 'Fit'; $('zoomOut').disabled = true;
  P.master = { ...DEFAULT_MASTER, ...P.master };
  mixCache = null; position = 0; renderToken++; tuneToken++;
  syncControls(); renderTakes(); updateTransport(); drawTimeline(); drawPitch(); updateStats(); updateTuneStatus(); applyLive();
  if (P.beat || P.takes.length) { localStorage.setItem(LAST_KEY, P.id); scheduleTune(0); }
  else setRenderState('Load a beat or record a take to start.');
}


// ------------------------------------------------------------------ balance
// Measures the finished vocal against the beat and sets the vocal fader so the words sit on top.
async function balanceNow() {
  const t = activeTake();
  if (!t || !P.beat) return;
  const btn = $('btnBalance'); btn.disabled = true;
  try {
    const mix = { ...P.mix, vocalOffsetMs: P.mix.vocalOffsetMs + (t.start || 0) * 1000 };
    const stem = await renderMix({ sr: P.sr, beat: null, vocal: gated(vocalSignal()), mix, bpm: P.bpm, vocalOnly: true });
    const d = vocalBeatBalance(stem, P.beat.channels, P.mix.beatDb, P.sr);
    if (d == null) { toast('There is no vocal sound in this take to balance.'); return; }
    P.mix.vocalDb = Math.max(-24, Math.min(12, Math.round((P.mix.vocalDb + BALANCE_TARGET - d) * 2) / 2));
    syncControls(); markDirty(); scheduleRender(0);
    toast(`Vocal set to ${fmtVal('vocalDb', P.mix.vocalDb)} so it sits on top of the beat.`);
  } catch (err) { toast(`Couldn't balance: ${err.message}`, true); }
  finally { updateBeatUi(); }
}

// ------------------------------------------------------------------ presets
function showPresetAbout() {
  const p = PRESETS.find((x) => x.id === P.preset);
  $('presetAbout').textContent = p ? p.about : 'A preset sets tuning, tone and space in one pick. Adjust anything after.';
}
function applyPreset(id) {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) { P.preset = ''; showPresetAbout(); markDirty(); return; }
  if (p.pro && !requirePro(`The ${p.name} preset`)) { $('presetSelect').value = P.preset || ''; return; }
  P.tune = { ...P.tune, enabled: true, ...p.tune };
  P.mix = { ...P.mix, ...p.mix, ...(p.mix.comp != null ? compFromMacro(p.mix.comp) : {}) };
  if (p.stack && isPro()) P.stack = { ...P.stack, ...p.stack };
  P.preset = id;
  syncControls(); markDirty(); drawTimeline(); scheduleTune(0);
  toast(`${p.name} is on. ${p.about}`);
}

// ------------------------------------------------------------------ Pro state
function onProChange() {
  document.body.classList.toggle('is-pro', isPro());
  const b = $('btnPro');
  b.textContent = isPro() ? 'Pro' : 'Go Pro';
  b.classList.toggle('on', isPro());
  b.title = isPro() ? 'Your Pro membership' : 'Unlock stacks, pro presets, record check and release packs';
  renderStackTakes(); updateBeatUi(); renderKeys();
  if (P.beat || P.takes.length) scheduleTune(0);
}

// resolves once the mix on screen matches the current settings
async function settled(timeout = 120000) {
  const t0 = performance.now();
  await new Promise((r) => setTimeout(r, 300));
  while (performance.now() - t0 < timeout) {
    const t = activeTake();
    const tuneDone = !t || !P.tune.enabled || (P.tuned && P.tuned.sig === tuneSig(t));
    if (tuneDone && mixCache && mixCache.sig === renderSig()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// ------------------------------------------------------------------ A&R365 record check
async function runCheck() {
  if (!requirePro('The A&R365 record check')) return;
  if (!mixCache) return;
  const dlg = $('checkDialog');
  $('checkScore').textContent = '–'; $('checkVerdict').textContent = 'Listening…'; $('checkList').textContent = '';
  if (!dlg.open) dlg.showModal();
  try {
    await settled();
    const t = activeTake();
    const layers = await buildLayers();
    let stem = null;
    if (t && P.beat) {
      const mix = { ...P.mix, vocalOffsetMs: P.mix.vocalOffsetMs + (t.start || 0) * 1000 };
      stem = await renderMix({ sr: P.sr, beat: null, vocal: gated(vocalSignal()), mix, bpm: P.bpm, vocalOnly: true, layers });
    }
    let f0 = null, shift = null;
    if (t) {
      if (P.tuned && P.tuned.takeId === t.id && P.tuned.sig === tuneSig(t)) { f0 = P.tuned.f0; shift = P.tune.enabled ? P.tuned.shift : null; }
      else f0 = (await work('pitch', { x: t.audio.slice(), sr: P.sr })).f0;
    }
    const r = await work('check', {
      sr: P.sr, master: mixCache.channels, stats: mixCache.stats, target: P.master.target, masterOn: P.master.enabled,
      take: t ? t.audio : null, f0, shift, tune: { root: P.tune.root, scale: P.tune.scale, enabled: P.tune.enabled },
      vocalStem: stem, beat: P.beat ? P.beat.channels : null, beatDb: P.mix.beatDb, gateAmount: P.mix.gate, stacked: layers.length > 0,
    });
    $('checkScore').textContent = r.score;
    $('checkVerdict').textContent = r.verdict;
    const fixes = {
      balance: ['Balance it for me', balanceNow],
      gate: ['Turn on the noise gate', () => { P.mix.gate = 40; syncControls(); markDirty(); scheduleRender(0); }],
      master: ['Turn the master on', () => { P.master.enabled = true; syncControls(); markDirty(); scheduleRender(0); }],
      tune: ['Turn tuning on', () => { P.tune.enabled = true; syncControls(); markDirty(); scheduleTune(0); }],
      key: P.beat ? ['Read the key again', () => analyzeBeat(true)] : null,
    };
    for (const it of r.items) {
      const li = document.createElement('li'); li.className = `check-item ${it.state}`;
      const h = document.createElement('h3'); h.textContent = it.label;
      const v = document.createElement('span'); v.className = 'val'; v.textContent = it.value;
      const p = document.createElement('p'); p.textContent = it.detail;
      li.append(h, v, p);
      const fx = it.fix && fixes[it.fix];
      if (fx) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ghost small'; b.textContent = fx[0];
        b.addEventListener('click', async () => { b.disabled = true; b.textContent = 'Fixing…'; await fx[1](); await settled(); runCheck(); });
        li.append(b);
      }
      $('checkList').append(li);
    }
  } catch (err) {
    console.error(err);
    $('checkVerdict').textContent = 'The check could not finish.';
    toast(`Record check failed: ${err.message}`, true);
  }
}

// ------------------------------------------------------------------ release pack
function openRelease() {
  if (!requirePro('The release pack')) return;
  $('exportDialog').close();
  const r = P.release || {};
  $('relTitle').value = r.title || (P.name === 'Untitled session' ? '' : P.name);
  $('relArtist').value = r.artist || localStorage.getItem('studio365:artist') || '';
  $('relFeat').value = r.feat || ''; $('relGenre').value = r.genre || ''; $('relExplicit').value = r.explicit || 'clean';
  $('relCredits').value = r.credits || ''; $('relStem').checked = !!r.stem;
  paintCover();
  $('relProgress').hidden = true;
  $('relMsg').className = 'note';
  $('relMsg').textContent = 'You get one ZIP: 24-bit master, 16-bit 44.1 kHz master, tagged MP3 320, cover at 3000 px and a release sheet to copy from when you upload.';
  $('releaseDialog').showModal();
}
function paintCover() {
  const c = P.cover;
  $('coverPreview').hidden = !c; $('coverHint').hidden = !!c;
  if (c) $('coverPreview').src = c.preview;
  $('coverNote').textContent = !c ? 'No cover yet. Most distributors will not take a release without one.'
    : c.sourceSide < 1400 ? `Your image is ${c.sourceSide} px. It was enlarged to 3000 px and may look soft. Use one at least 1400 px, ideally 3000.`
      : c.sourceSide < 3000 ? `Your image is ${c.sourceSide} px, enlarged to 3000 px. It will pass, and a 3000 px original looks sharper.`
        : 'Cover is 3000 px square. Ready.';
}
async function setCover(file) {
  try { P.cover = await Pack.squareCover(file, 3000); paintCover(); markDirty(); }
  catch (err) { toast(err.message, true); }
}
function ditherTo16(channels) {
  // triangular dither at one 16-bit step so quiet tails fade into hiss instead of grit
  const q = 1 / 32768;
  return channels.map((c) => { const o = new Float32Array(c.length); for (let i = 0; i < c.length; i++) o[i] = c[i] + (Math.random() - Math.random()) * q; return o; });
}
async function buildRelease() {
  const msg = $('relMsg'), bar = $('relBar'), btn = $('relBuild');
  const title = $('relTitle').value.trim(), artist = $('relArtist').value.trim();
  msg.className = 'note';
  if (!title || !artist) { msg.textContent = 'Add the song title and artist name. They go into the files and the release sheet.'; msg.classList.add('err'); (title ? $('relArtist') : $('relTitle')).focus(); return; }
  P.release = { title, artist, feat: $('relFeat').value.trim(), genre: $('relGenre').value.trim(), explicit: $('relExplicit').value, credits: $('relCredits').value.trim(), stem: $('relStem').checked };
  localStorage.setItem('studio365:artist', artist);
  markDirty();
  const R = P.release;
  btn.disabled = true; $('relProgress').hidden = false;
  const step = (p, text) => { bar.style.width = `${p}%`; msg.textContent = text; };
  try {
    step(5, 'Rendering the master…');
    const channels = await renderFinal(false);
    const seconds = channels[0].length / P.sr;
    const base = slug(`${artist}-${title}`);
    const fullTitle = R.feat ? `${title} (feat. ${R.feat})` : title;
    const files = [];
    step(25, 'Writing the 24-bit master…');
    files.push({ name: `${base}-master-24bit-${Math.round(P.sr / 100) / 10}k.wav`, bytes: D.encodeWav(channels, P.sr, 24) });
    step(35, 'Writing the 16-bit 44.1 kHz master…');
    const c44 = await resample(channels, P.sr, 44100);
    D.limit(c44, 44100, -1);
    files.push({ name: `${base}-master-16bit-44k.wav`, bytes: D.encodeWav(ditherTo16(c44), 44100, 16) });
    step(45, 'Encoding the MP3…');
    const mp3 = await encodeMp3(channels, P.sr, 320, (p) => { bar.style.width = `${45 + p * 30}%`; });
    const keyName = `${D.NOTE_NAMES[P.tune.root]}${P.tune.scale.toLowerCase().includes('minor') ? 'm' : ''}`;
    files.push({ name: `${base}-320.mp3`, bytes: Pack.tagMp3(mp3, { title: fullTitle, artist, album: title, genre: R.genre, year: new Date().getFullYear(), bpm: P.beat ? P.bpm : null, key: P.beat || activeTake() ? keyName : null, coverJpeg: P.cover ? P.cover.bytes : null }) });
    if (P.cover) files.push({ name: 'cover-3000.jpg', bytes: P.cover.bytes });
    if (R.stem && activeTake()) {
      step(80, 'Rendering the vocal stem…');
      files.push({ name: `${base}-vocal-stem.wav`, bytes: D.encodeWav(await renderFinal(true), P.sr, 24) });
    }
    step(90, 'Writing the release sheet…');
    const s = mixCache?.stats;
    const lyr = { clean: 'Clean', explicit: 'Explicit', instrumental: 'Instrumental (no lyrics)' }[R.explicit];
    const sheet = [
      'RELEASE SHEET', '=============', '',
      `Title:            ${fullTitle}`, `Primary artist:   ${artist}`, R.feat ? `Featured:         ${R.feat}` : null,
      `Genre:            ${R.genre || '(choose one when you upload)'}`, `Lyrics:           ${lyr}`,
      R.credits ? `Credits:          ${R.credits}` : null,
      `Length:           ${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`,
      P.beat ? `Tempo:            ${P.bpm} BPM` : null, `Key:              ${D.NOTE_NAMES[P.tune.root]} ${D.SCALE_LABELS[P.tune.scale].toLowerCase()}`,
      P.master.enabled && s && s.lufs != null ? `Loudness:         ${s.lufs.toFixed(1)} LUFS integrated, peak ${s.peakDb.toFixed(1)} dB` : 'Loudness:         Master was off for this export',
      `Made:             ${new Date().toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' })} in STUDIO365`,
      '', 'FILES IN THIS PACK', '------------------',
      ...files.map((f) => `  ${f.name}`), '  release-sheet.txt',
      '', 'WHICH FILE GOES WHERE', '---------------------',
      '  Distributor upload (Spotify, Apple Music and the rest): the 16-bit 44.1 kHz WAV is the standard format distributors take.',
      '  If your distributor takes 24-bit, send the 24-bit WAV instead.',
      '  The MP3 is for sending to people, DJs, blogs and playlists. It already carries the title, artist and cover.',
      P.cover ? '  cover-3000.jpg is the artwork file to upload.' : '  No cover in this pack. You need a square image, 3000 x 3000 px, before you upload.',
      '', 'BEFORE YOU UPLOAD', '-----------------',
      '  [ ] You own or have licensed the beat. Keep the receipt or the lease agreement.',
      '  [ ] Every writer and producer is credited the way they want to be.',
      '  [ ] No uncleared samples.',
      '  [ ] Cover art has no logos, web addresses or other people\'s brands on it.',
      '  [ ] Pick a release date at least a week out so stores have time to list it.',
      '', 'Your music is yours. STUDIO365 claims no rights to anything you record.', '',
    ].filter((l) => l !== null).join('\r\n');
    files.push({ name: 'release-sheet.txt', bytes: new TextEncoder().encode(sheet) });
    step(96, 'Packing the ZIP…');
    download(Pack.zip(files.map((f) => ({ ...f, name: `${base}/${f.name}` }))), `${base}-release-pack.zip`);
    step(100, `Done. ${files.length} files are in your downloads as ${base}-release-pack.zip.`);
    msg.classList.add('ok');
  } catch (err) {
    console.error(err);
    msg.textContent = `The pack could not be built: ${err.message}`; msg.classList.add('err');
  } finally { btn.disabled = false; }
}

// ------------------------------------------------------------------ session backup
function backupSession() {
  if (!requirePro('Session backup')) return;
  if (!P.beat && !P.takes.length) { toast('Nothing to back up yet. Load a beat or record a take first.'); return; }
  download(Pack.packSession(P), `${slug(P.name)}.studio365`);
  toast('Session file saved to your downloads. Open it on any device with "Open a session file".');
}
async function restoreSession(file) {
  try {
    const p = await Pack.unpackSession(file);
    stopPlayback(false); await save();
    p.id = uid(); p.updated = Date.now();
    loadIntoUi(p);
    markDirty();
    if ($('libraryDialog').open) $('libraryDialog').close();
    toast(`"${p.name}" is open. It now saves on this device too.`);
  } catch (err) { toast(err.message, true); }
}

// ------------------------------------------------------------------ export
function slug(s) { return (s || 'studio365').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'studio365'; }
function download(data, name, type) {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
// Full-quality render of what you hear. stem = the processed vocal (and stack) alone.
async function renderFinal(stem = false) {
  const t = activeTake();
  const mix = { ...P.mix, vocalOffsetMs: P.mix.vocalOffsetMs + (t ? (t.start || 0) * 1000 : 0) };
  const layers = await buildLayers();
  let channels;
  if (stem) {
    if (!t) throw new Error('Record or import a take first. The stem is your vocal alone.');
    channels = await renderMix({ sr: P.sr, beat: null, vocal: gated(vocalSignal()), mix, bpm: P.bpm, vocalOnly: true, layers });
    const pk = D.peak(channels);
    if (pk > 0) { const g = D.dbToGain(-1) / pk; channels.forEach((c) => { for (let i = 0; i < c.length; i++) c[i] *= g; }); }
  } else {
    channels = await renderMix({ sr: P.sr, beat: P.beat ? P.beat.channels : null, vocal: gated(vocalSignal()), mix, bpm: P.bpm, layers });
    if (P.master.enabled) {
      const r = await work('master', { channels, sr: P.sr, target: P.master.target, ceiling: P.master.ceiling }, channels.map((c) => c.buffer));
      channels = r.channels;
    } else {
      D.limit(channels, P.sr, -0.3);
    }
  }
  trimTail(channels, P.sr);
  return channels;
}
async function exportAs(format) {
  const prog = $('exportProgress'), bar = $('exportBar'), msg = $('exportMsg');
  const opts = document.querySelectorAll('.export-opt');
  opts.forEach((b) => { b.disabled = true; });
  prog.hidden = false; bar.style.width = '5%'; msg.textContent = 'Rendering full quality…';
  try {
    const channels = await renderFinal(format === 'stem');
    bar.style.width = '55%';
    const base = slug(P.name);
    if (format === 'wav24' || format === 'stem') {
      msg.textContent = 'Writing WAV…';
      const bytes = D.encodeWav(channels, P.sr, 24);
      download(bytes, `${base}${format === 'stem' ? '-vocal-stem' : '-master'}.wav`, 'audio/wav');
    } else {
      const kbps = format === 'mp3-320' ? 320 : 128;
      msg.textContent = `Encoding MP3 ${kbps}…`;
      const bytes = await encodeMp3(channels, P.sr, kbps, (p) => { bar.style.width = `${55 + p * 45}%`; });
      download(bytes, `${base}-${kbps}.mp3`, 'audio/mpeg');
    }
    bar.style.width = '100%'; msg.textContent = 'Done. Check your downloads.';
  } catch (err) {
    console.error(err);
    msg.textContent = `Export failed: ${err.message}`;
  } finally {
    opts.forEach((b) => { b.disabled = false; });
  }
}
function trimTail(channels, sr) {
  // drop trailing silence beyond a short fade, keep at least 1 s
  let end = channels[0].length;
  const th = D.dbToGain(-70);
  while (end > sr && channels.every((c) => Math.abs(c[end - 1]) < th)) end--;
  end = Math.min(channels[0].length, end + Math.round(sr * 0.25));
  for (let c = 0; c < channels.length; c++) channels[c] = channels[c].subarray(0, end);
}
async function encodeMp3(channels, sr, kbps, onProgress) {
  if (!window.lamejs) throw new Error('The MP3 encoder did not load. Check your connection and try again, or export WAV.');
  let chans = channels, rate = sr;
  if (![32000, 44100, 48000].includes(sr)) { chans = await resample(channels, sr, 44100); rate = 44100; }
  const enc = new window.lamejs.Mp3Encoder(2, rate, kbps);
  const n = chans[0].length, block = 1152;
  const l16 = new Int16Array(block), r16 = new Int16Array(block);
  const parts = [];
  for (let i = 0, k = 0; i < n; i += block, k++) {
    const len = Math.min(block, n - i);
    for (let j = 0; j < len; j++) {
      const a = Math.max(-1, Math.min(1, chans[0][i + j])), b = Math.max(-1, Math.min(1, chans[1][i + j]));
      l16[j] = a < 0 ? a * 32768 : a * 32767; r16[j] = b < 0 ? b * 32768 : b * 32767;
    }
    const out = enc.encodeBuffer(l16.subarray(0, len), r16.subarray(0, len));
    if (out.length) parts.push(new Uint8Array(out));
    if (k % 200 === 0) { onProgress(i / n); await new Promise((r) => setTimeout(r)); }
  }
  const tail = enc.flush();
  if (tail.length) parts.push(new Uint8Array(tail));
  const total = parts.reduce((a, p) => a + p.length, 0);
  const bytes = new Uint8Array(total);
  let o = 0; for (const p of parts) { bytes.set(p, o); o += p.length; }
  onProgress(1);
  return bytes;
}

// ------------------------------------------------------------------ boot
async function boot() {
  bindControls();
  const linkToast = (r) => toast(r.ok ? `Pro is on until ${new Date(r.expires).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}. Welcome in.` : r.reason, !r.ok);
  initPro({ onChange: onProChange, onLink: linkToast }).then(({ fromLink }) => { if (fromLink) linkToast(fromLink); });
  syncControls();
  renderTakes();
  updateTransport();
  drawTimeline();
  $('zoomOut').disabled = true;
  try {
    const last = localStorage.getItem(LAST_KEY);
    if (last) {
      const p = await Store.loadProject(last);
      if (p) { loadIntoUi(p); return; }
    }
  } catch (err) { console.warn('Could not restore last session', err); }
  setRenderState('Load a beat or record a take to start.');
}
boot();
