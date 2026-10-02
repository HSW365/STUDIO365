// STUDIO365 studio — record, tune, mix, master, export. Everything runs in the browser; sessions live in IndexedDB.
import * as D from './dsp.js';
import { renderMix, DEFAULT_MIX } from './mixer.js';
import { vocalBeatBalance, BALANCE_TARGET } from './check.js';
import * as Store from './store.js';
import { initPro, isPro, requirePro, openPro } from './pro.js';
import { PRESETS } from './presets.js';
import * as Pack from './pack.js';

const $ = (id) => document.getElementById(id);
const DEFAULT_TUNE = { enabled: true, root: 9, scale: 'minor', speedMs: 15, amount: 100, keepVibrato: 30 };
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
let playing = false, playSrc = null, playStartCtx = 0, position = 0;
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
    tune: { ...DEFAULT_TUNE }, mix: { ...DEFAULT_MIX }, master: { ...DEFAULT_MASTER }, tuned: null,
    stack: { ...DEFAULT_STACK, takes: {} }, preset: '', release: null, cover: null,
  };
}

// ------------------------------------------------------------------ worker
const worker = new Worker(new URL('./dsp-worker.js', import.meta.url), { type: 'module' });
let wid = 0;
const pending = new Map();
worker.onmessage = (e) => {
  const p = pending.get(e.data.id);
  if (!p) return;
  pending.delete(e.data.id);
  e.data.ok ? p.res(e.data.result) : p.rej(new Error(e.data.error));
};
worker.onerror = (e) => { console.error(e); toast('The audio engine hit an error. Reload the page to restart it.', true); };
const work = (type, payload, transfer = []) => new Promise((res, rej) => {
  const id = ++wid; pending.set(id, { res, rej }); worker.postMessage({ id, type, payload }, transfer);
});

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
function tuneSig(t) { return JSON.stringify([t.id, P.tune.root, P.tune.scale, P.tune.speedMs, P.tune.amount, P.tune.keepVibrato]); }
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
      const sig = JSON.stringify([t.id, P.tune.enabled && P.tuned ? P.tuned.sig : 'raw', P.mix.gate]);
      if (!stackCache.double || stackCache.double.sig !== sig) {
        setRenderState('Building your doubles…', true);
        stackCache.double = { sig, ...(await work('double', { x: lead.slice(), sr: P.sr })) };
      }
      const db = -20 + S.double * 0.15;
      out.push({ audio: stackCache.double.left, offsetMs: off, db, pan: -72 }, { audio: stackCache.double.right, offsetMs: off, db, pan: 72 });
    }
    if (S.harmony !== 'off' && S.harmonyLevel > 0) {
      const sig = JSON.stringify([t.id, S.harmony, P.tune.root, P.tune.scale, P.tune.keepVibrato]);
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
        const r = await work('autotune', { x: tk.audio.slice(), sr: P.sr, settings: { root: P.tune.root, scale: P.tune.scale, speedMs: P.tune.speedMs, amount: P.tune.amount / 100, keepVibrato: P.tune.keepVibrato / 100 } });
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
    beat: P.beat ? P.beat.id : null, take: t ? t.id : null, start: t ? t.start : 0,
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
    const res = await work('autotune', {
      x: t.audio.slice(), sr: P.sr,
      settings: { root: P.tune.root, scale: P.tune.scale, speedMs: P.tune.speedMs, amount: P.tune.amount / 100, keepVibrato: P.tune.keepVibrato / 100 },
    });
    if (token !== tuneToken) return;
    P.tuned = { sig, takeId: t.id, audio: res.audio, f0: res.f0, shift: res.shift, hop: res.hop, win: res.win };
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
      ? `${t.name} is tuned. Notes moved ${avg.toFixed(0)} cents on average to land in ${D.NOTE_NAMES[P.tune.root]} ${D.SCALE_LABELS[P.tune.scale].toLowerCase()}.`
      : `No sung pitch found in ${t.name}. Spoken or whispered takes pass through untouched.`;
  }
}

// ------------------------------------------------------------------ mixing
function scheduleRender(delay = 220) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(runRender, delay);
}
async function runRender() {
  if (!P.beat && !activeTake()) { mixCache = null; updateTransport(); setRenderState('Load a beat or record a take to start.'); return; }
  const sig = renderSig();
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
    const c = audio();
    const buffer = c.createBuffer(2, channels[0].length, P.sr);
    buffer.copyToChannel(channels[0], 0); buffer.copyToChannel(channels[1], 1);
    const wasPlaying = playing;
    const at = currentPosition();
    mixCache = { sig, channels, buffer, stats };
    updateStats();
    updateTransport();
    setRenderState(readyText());
    if (wasPlaying) { stopPlayback(true); startPlayback(at); }
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

// ------------------------------------------------------------------ playback
function currentPosition() {
  if (playing && ctx) return Math.max(0, ctx.currentTime - playStartCtx);
  return position;
}
async function startPlayback(from = position) {
  if (!mixCache) { await runRender(); if (!mixCache) return; }
  const c = audio();
  await c.resume();
  const dur = mixCache.buffer.duration;
  if (from >= dur - 0.05) from = 0;
  playSrc = c.createBufferSource();
  playSrc.buffer = mixCache.buffer;
  playSrc.connect(c.destination);
  playSrc.start(c.currentTime + 0.02, from);
  playStartCtx = c.currentTime + 0.02 - from;
  playing = true;
  const src = playSrc;
  src.onended = () => { if (playSrc === src && playing) { playing = false; position = 0; updateTransport(); drawTimeline(); } };
  updateTransport();
  requestAnimationFrame(tick);
}
function stopPlayback(keepPosition = true) {
  if (playSrc) { try { playSrc.onended = null; playSrc.stop(); } catch { /* already stopped */ } playSrc = null; }
  if (playing) position = keepPosition ? currentPosition() : 0;
  playing = false;
  updateTransport();
  drawTimeline();
}
function tick() {
  $('clock').textContent = fmtTime(recording ? Math.max(0, ctx.currentTime - recStartAt + recFrom) : currentPosition());
  drawTimeline();
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
  if (!m.has(cols)) m.set(cols, D.waveformPeaks(arr, cols));
  return m.get(cols);
}
function drawWave(g, peaks, x0, y0, w, h, color, cols) {
  g.fillStyle = color;
  const mid = y0 + h / 2;
  for (let c = 0; c < cols; c++) {
    const mn = peaks[c * 2], mx = peaks[c * 2 + 1];
    const top = mid - mx * (h / 2) * 0.92, bot = mid - mn * (h / 2) * 0.92;
    g.fillRect(x0 + c, top, 1, Math.max(1, bot - top));
  }
}
function drawTimeline() {
  const cv = $('timelineCanvas');
  if (!cv.clientWidth) return;
  const { g, w, h } = fitCanvas(cv);
  const sr = P.sr || 48000;
  const dur = Math.max(projectDuration(), recording ? ctx.currentTime - recStartAt + recFrom + 4 : 0, 8);
  const pxPerSec = w / dur;
  const laneH = h / 2;
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#12121a'; g.fillRect(0, 0, w, laneH);
  g.fillStyle = '#15151f'; g.fillRect(0, laneH, w, laneH);
  // bar grid
  const bar = (60 / (P.bpm || 90)) * 4;
  if (bar * pxPerSec > 14) {
    g.fillStyle = 'rgba(255,255,255,0.05)';
    for (let t = 0; t < dur; t += bar) g.fillRect(Math.round(t * pxPerSec), 0, 1, h);
  }
  g.fillStyle = '#262633'; g.fillRect(0, laneH, w, 1);
  if (P.beat) {
    const len = P.beat.channels[0].length;
    const cols = Math.max(1, Math.round((len / sr) * pxPerSec));
    drawWave(g, peaksFor(P.beat.channels[0], cols), 0, 8, w, laneH - 16, 'rgba(34,211,238,0.55)', cols);
  }
  const t = activeTake();
  const v = vocalSignal();
  if (t && v) {
    const x0 = Math.round(((t.start || 0) + P.mix.vocalOffsetMs / 1000) * pxPerSec);
    const cols = Math.max(1, Math.round((v.length / sr) * pxPerSec));
    const tuned = v !== t.audio;
    drawWave(g, peaksFor(v, cols), x0, laneH + 8, w, laneH - 16, tuned ? 'rgba(168,85,247,0.85)' : 'rgba(237,237,242,0.6)', cols);
  }
  if (recording) {
    const a = recFrom * pxPerSec, b = Math.max(a, (ctx.currentTime - recStartAt + recFrom) * pxPerSec);
    g.fillStyle = 'rgba(239,68,68,0.22)'; g.fillRect(a, laneH + 1, b - a, laneH - 1);
    g.fillStyle = '#ef4444'; g.fillRect(b, 0, 2, h);
  } else {
    const x = currentPosition() * pxPerSec;
    g.fillStyle = '#ededf2'; g.fillRect(Math.round(x), 0, 2, h);
  }
  $('clockTotal').textContent = `/ ${fmtTime(projectDuration(), false)}`;
}

function drawPitch() {
  const panel = $('pitchPanel');
  const t = activeTake();
  const tuned = P.tuned && t && P.tuned.takeId === t.id && P.tune.enabled && P.tuned.sig === tuneSig(t) ? P.tuned : null;
  const voiced = tuned && tuned.f0.some((v) => v > 0);
  panel.hidden = !voiced;
  if (!voiced) return;
  const cv = $('pitchCanvas');
  const { g, w, h } = fitCanvas(cv);
  const { f0, shift } = tuned;
  const n = f0.length;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) if (f0[i]) { const m = D.freqToMidi(f0[i]); lo = Math.min(lo, m); hi = Math.max(hi, m); }
  g.clearRect(0, 0, w, h);
  lo = Math.floor(lo) - 2; hi = Math.ceil(hi) + 2;
  const gutter = 36;
  const y = (m) => h - 6 - ((m - lo) / (hi - lo)) * (h - 12);
  const x = (i) => gutter + (i / (n - 1)) * (w - gutter - 4);
  const scale = D.SCALES[P.tune.scale];
  g.font = '10px "Space Mono", monospace';
  for (let m = lo; m <= hi; m++) {
    const inScale = scale.includes((((m - P.tune.root) % 12) + 12) % 12);
    g.fillStyle = inScale ? 'rgba(168,85,247,0.10)' : 'rgba(255,255,255,0.02)';
    g.fillRect(gutter, y(m) - 0.5, w - gutter, 1);
    if (inScale && (hi - lo) < 30) { g.fillStyle = '#7d7d92'; g.fillText(D.midiName(m), 2, y(m) + 3); }
  }
  const line = (fn, color, width) => {
    g.strokeStyle = color; g.lineWidth = width; g.lineJoin = 'round'; g.beginPath();
    let pen = false;
    for (let i = 0; i < n; i++) {
      if (!f0[i]) { pen = false; continue; }
      const px = x(i), py = y(fn(i));
      if (!pen) { g.moveTo(px, py); pen = true; } else g.lineTo(px, py);
    }
    g.stroke();
  };
  line((i) => D.freqToMidi(f0[i]), '#6b6b80', 1.5);
  line((i) => D.freqToMidi(f0[i]) + shift[i], '#a855f7', 2);
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
    radio.addEventListener('change', () => { P.activeTake = t.id; position = t.start || 0; afterTakesChanged(); });
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
}

function fmtVal(key, v) {
  switch (key) {
    case 'vocalDb': case 'beatDb': case 'body': case 'presence': case 'air': return `${v > 0 ? '+' : ''}${Number(v).toFixed(1)} dB`;
    case 'sibilance': return v ? `-${Number(v).toFixed(1)} dB` : 'Off';
    case 'pan': return v == 0 ? 'Center' : v < 0 ? `L ${-v}` : `R ${v}`;
    case 'hpf': return `${v} Hz`;
    case 'vocalOffsetMs': return v == 0 ? 'On grid' : `${v > 0 ? 'Later' : 'Earlier'} ${Math.abs(v)} ms`;
    case 'speedMs': return v == 0 ? 'Instant' : `${v} ms`;
    case 'gate': case 'double': case 'harmonyLevel': return v == 0 ? 'Off' : `${v}%`;
    default: return `${v}%`;
  }
}
function paintFader(input) {
  const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--pct', `${pct}%`);
}
function syncControls() {
  document.querySelectorAll('.fader').forEach((f) => {
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
  updateBeatUi();
}

function bindControls() {
  D.NOTE_NAMES.forEach((n, i) => $('tuneRoot').add(new Option(n, String(i))));
  Object.entries(D.SCALE_LABELS).forEach(([k, label]) => $('tuneScale').add(new Option(label, k)));

  document.querySelectorAll('.fader').forEach((f) => {
    const input = f.querySelector('input'); const group = f.dataset.group, key = f.dataset.key;
    input.addEventListener('input', () => {
      if (group === 'stack' && !isPro()) { input.value = P.stack[key]; paintFader(input); openPro('Vocal stacks'); return; }
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
  $('tuneRoot').addEventListener('change', (e) => { P.tune.root = Number(e.target.value); updateBeatUi(); markDirty(); scheduleTune(0); });
  $('tuneScale').addEventListener('change', (e) => { P.tune.scale = e.target.value; updateBeatUi(); markDirty(); scheduleTune(0); });
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
  $('btnResetMix').addEventListener('click', () => { P.mix = { ...DEFAULT_MIX }; syncControls(); markDirty(); scheduleRender(0); });

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
  $('btnRewind').addEventListener('click', () => { const was = playing; stopPlayback(false); position = 0; if (was) startPlayback(0); updateTransport(); drawTimeline(); });
  $('optMonitor').addEventListener('change', (e) => {
    if (monitorGain) monitorGain.gain.setTargetAtTime(e.target.checked ? 1 : 0, audio().currentTime, 0.01);
    if (e.target.checked) toast('Wear headphones while you hear your mic, or the speakers will feed back.');
  });

  // timeline seek + drag and drop
  const tl = $('timeline');
  tl.addEventListener('click', (e) => {
    if (recording) return;
    const r = tl.getBoundingClientRect();
    const dur = Math.max(projectDuration(), 8);
    const at = ((e.clientX - r.left) / r.width) * dur;
    const was = playing;
    stopPlayback(true);
    position = Math.max(0, Math.min(at, projectDuration()));
    if (was) startPlayback(position); else { updateTransport(); drawTimeline(); }
  });
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
    if (e.code === 'Space') { e.preventDefault(); if (!recording) (playing ? stopPlayback(true) : startPlayback()); }
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); recording ? stopRecording() : startRecording(); }
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
  $('btnExport').addEventListener('click', () => { $('exportProgress').hidden = true; $('exportDialog').showModal(); });
  document.querySelectorAll('.export-opt[data-format]').forEach((b) => b.addEventListener('click', () => exportAs(b.dataset.format)));

  window.addEventListener('resize', () => { drawTimeline(); drawPitch(); });
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
  P.tune = { ...DEFAULT_TUNE, ...P.tune };
  P.mix = { ...DEFAULT_MIX, ...P.mix };
  P.master = { ...DEFAULT_MASTER, ...P.master };
  mixCache = null; position = 0; renderToken++; tuneToken++;
  syncControls(); renderTakes(); updateTransport(); drawTimeline(); drawPitch(); updateStats(); updateTuneStatus();
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
  P.mix = { ...P.mix, ...p.mix };
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
  renderStackTakes(); updateBeatUi();
  if (P.beat || P.takes.length) scheduleRender(0);
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
