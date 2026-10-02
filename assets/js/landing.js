// STUDIO365 landing: live A/B pitch-correction demo, Pro checkout, nav state.
import { initPro, isPro, openPro, prices } from './pro.js';
const $ = (id) => document.getElementById(id);
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const A_MINOR = [0, 2, 3, 5, 7, 8, 10].map((p) => (p + 9) % 12);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// ---------------------------------------------------------------- the phrase
const BPM = 88, SPB = 60 / BPM, LOOP = 8 * SPB;
// [midi, beats, how far off the singer lands in cents]
const PHRASE = [[69, 1, -38], [72, 0.5, 44], [71, 0.5, -31], [69, 1, 27], [67, 1, -42], [64, 1.5, 36], [67, 0.5, -24], [69, 2, 41]];
const NOTES = [];
{ let t = 0; for (const [m, b, off] of PHRASE) { NOTES.push({ m, t, d: b * SPB, off }); t += b * SPB; } }

function noteAt(t) {
  for (let i = 0; i < NOTES.length; i++) if (t < NOTES[i].t + NOTES[i].d) return i;
  return NOTES.length - 1;
}
function vibrato(t, n) {
  const since = t - n.t;
  const depth = Math.min(1, Math.max(0, (since - 0.28) / 0.35)) * 0.32;
  return depth * Math.sin(2 * Math.PI * 5.4 * since);
}
function rawMidi(t) {
  const i = noteAt(t), n = NOTES[i];
  const since = t - n.t;
  const prev = i ? NOTES[i - 1] : null;
  // singer scoops into each note from below / from the last note, then settles off-pitch
  const from = prev ? prev.m + prev.off / 100 : n.m - 1;
  const settle = n.m + n.off / 100;
  const k = Math.min(1, since / 0.11);
  const glide = from + (settle - from) * (1 - Math.pow(1 - k, 3));
  const drift = 0.12 * Math.sin(2 * Math.PI * 0.7 * t + i);
  return glide + drift + vibrato(t, n);
}
function tunedMidi(t) {
  const i = noteAt(t), n = NOTES[i];
  const since = t - n.t;
  const prev = i ? NOTES[i - 1] : null;
  const k = Math.min(1, since / 0.025);
  const from = prev ? prev.m : n.m;
  return from + (n.m - from) * k + vibrato(t, n) * 0.3;
}
function envAt(t) {
  const n = NOTES[noteAt(t)];
  const since = t - n.t, left = n.t + n.d - t;
  return Math.min(1, since / 0.03) * Math.min(1, Math.max(0, left - 0.03) / 0.06);
}

// ---------------------------------------------------------------- audio
let ctx = null, voices = null, master = null, mode = 'tuned', playing = false, loopStart = 0, nextLoop = 0, timer = null, noiseBuf = null;

function makeVoice(c, out) {
  const g = c.createGain(); g.gain.value = 0;
  const env = c.createGain(); env.gain.value = 0;
  const o1 = c.createOscillator(), o2 = c.createOscillator();
  o1.type = 'sawtooth'; o2.type = 'sawtooth'; o2.detune.value = 7;
  const mixIn = c.createGain(); mixIn.gain.value = 0.5;
  o1.connect(mixIn); o2.connect(mixIn);
  const formants = [[730, 6, 1], [1090, 8, 0.5], [2440, 10, 0.28], [3400, 12, 0.12]];
  const sum = c.createGain();
  for (const [f, q, a] of formants) {
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
    const ga = c.createGain(); ga.gain.value = a * 3.2;
    mixIn.connect(bp).connect(ga).connect(sum);
  }
  const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5200;
  sum.connect(lp).connect(env).connect(g).connect(out);
  o1.start(); o2.start();
  return { g, env, o1, o2 };
}

function ensureAudio() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  ctx = new AC();
  master = ctx.createGain(); master.gain.value = 0.9;
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 3;
  master.connect(comp).connect(ctx.destination);
  // vocal room
  const verb = ctx.createConvolver();
  const len = Math.round(ctx.sampleRate * 1.6), ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-4.5 * i / len) * 0.4; }
  verb.buffer = ir;
  const vBus = ctx.createGain(); vBus.gain.value = 0.9;
  const send = ctx.createGain(); send.gain.value = 0.22;
  vBus.connect(master); vBus.connect(send).connect(verb).connect(master);
  voices = { raw: makeVoice(ctx, vBus), tuned: makeVoice(ctx, vBus) };
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const nd = noiseBuf.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
}

function scheduleLoop(t0) {
  const step = 0.01;
  for (const key of ['raw', 'tuned']) {
    const v = voices[key], fn = key === 'raw' ? rawMidi : tunedMidi;
    for (let t = 0; t < LOOP; t += step) {
      const f = mtof(fn(t));
      v.o1.frequency.linearRampToValueAtTime(f, t0 + t);
      v.o2.frequency.linearRampToValueAtTime(f, t0 + t);
      v.env.gain.linearRampToValueAtTime(envAt(t) * 0.55, t0 + t);
    }
  }
  // drums + pad
  for (let b = 0; b < 8; b++) {
    const bt = t0 + b * SPB;
    if (b % 4 === 0) kick(bt);
    if (b % 4 === 2) kick(bt + SPB * 0.5);
    if (b % 2 === 1) clap(bt);
    hat(bt, 0.22); hat(bt + SPB / 2, 0.12);
  }
  pad(t0, [57, 60, 64], 4 * SPB);
  pad(t0 + 4 * SPB, [53, 57, 60], 4 * SPB);
}
function kick(t) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.9, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
  o.connect(g).connect(master); o.start(t); o.stop(t + 0.45);
}
function noiseHit(t, type, freq, q, peak, decay) {
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  s.connect(f).connect(g).connect(master); s.start(t, Math.random() * 0.5); s.stop(t + decay + 0.02);
}
function clap(t) { noiseHit(t, 'bandpass', 1500, 0.8, 0.45, 0.2); noiseHit(t + 0.012, 'bandpass', 1500, 0.8, 0.3, 0.16); }
function hat(t, a) { noiseHit(t, 'highpass', 8000, 0.7, a * 0.5, 0.05); }
function pad(t, notes, dur) {
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.07, t + 0.25); g.gain.setValueAtTime(0.07, t + dur - 0.3); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  lp.connect(g).connect(master);
  for (const m of notes) {
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = mtof(m - 12);
    o.connect(lp); o.start(t); o.stop(t + dur + 0.05);
  }
}

function setMode(m) {
  mode = m;
  $('abRaw').setAttribute('aria-checked', String(m === 'raw'));
  $('abTuned').setAttribute('aria-checked', String(m === 'tuned'));
  if (ctx && voices) {
    const now = ctx.currentTime;
    voices.raw.g.gain.setTargetAtTime(m === 'raw' ? 1 : 0, now, 0.015);
    voices.tuned.g.gain.setTargetAtTime(m === 'tuned' ? 1 : 0, now, 0.015);
  }
  if (!playing) draw();
}

async function play() {
  ensureAudio();
  await ctx.resume();
  master.gain.cancelScheduledValues(0); master.gain.value = 0.9;
  playing = true;
  $('demoPlay').classList.add('playing'); $('demoPlay').setAttribute('aria-label', 'Stop demo');
  loopStart = ctx.currentTime + 0.08; nextLoop = loopStart;
  for (const v of Object.values(voices)) { for (const p of [v.o1.frequency, v.o2.frequency, v.env.gain]) p.cancelScheduledValues(0); }
  setMode(mode);
  const pump = () => { while (nextLoop < ctx.currentTime + 1.5) { scheduleLoop(nextLoop); nextLoop += LOOP; } };
  pump(); timer = setInterval(pump, 250);
  requestAnimationFrame(frame);
}
function stop() {
  playing = false; clearInterval(timer);
  $('demoPlay').classList.remove('playing'); $('demoPlay').setAttribute('aria-label', 'Play demo');
  if (ctx) {
    const now = ctx.currentTime;
    master.gain.setTargetAtTime(0, now, 0.03);
    for (const v of Object.values(voices)) { for (const p of [v.o1.frequency, v.o2.frequency, v.env.gain]) p.cancelScheduledValues(now); v.env.gain.setTargetAtTime(0, now, 0.02); }
    setTimeout(() => { if (!playing) ctx.suspend(); }, 250);
  }
  $('demoNote').textContent = 'A minor';
  draw();
}

// ---------------------------------------------------------------- canvas
const cv = $('demoCanvas');
function frame() { draw(); if (playing) requestAnimationFrame(frame); }
function draw() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w) return;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const lo = 62, hi = 74, gutter = 44, pad = 14;
  const y = (m) => h - pad - ((m - lo) / (hi - lo)) * (h - pad * 2);
  const x = (t) => gutter + (t / LOOP) * (w - gutter - 10);
  const t = playing ? ((ctx.currentTime - loopStart) % LOOP + LOOP) % LOOP : -1;

  g.font = '11px "Space Mono", monospace';
  for (let m = lo; m <= hi; m++) {
    const inKey = A_MINOR.includes(m % 12);
    g.fillStyle = inKey ? 'rgba(168,85,247,0.13)' : 'rgba(255,255,255,0.025)';
    g.fillRect(gutter, Math.round(y(m)), w - gutter, 1);
    if (inKey) { g.fillStyle = '#6f6f86'; g.fillText(NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1), 8, y(m) + 4); }
  }
  // beat ticks
  g.fillStyle = 'rgba(255,255,255,0.05)';
  for (let b = 0; b <= 8; b++) g.fillRect(Math.round(x(b * SPB)), pad, 1, h - pad * 2);

  const trace = (fn, color, width, alpha) => {
    g.globalAlpha = alpha; g.strokeStyle = color; g.lineWidth = width; g.lineJoin = 'round'; g.lineCap = 'round';
    for (const n of NOTES) {
      g.beginPath();
      for (let tt = n.t + 0.02; tt < n.t + n.d - 0.05; tt += 0.008) {
        const px = x(tt), py = y(fn(tt));
        tt === n.t + 0.02 ? g.moveTo(px, py) : g.lineTo(px, py);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
  };
  trace(rawMidi, mode === 'raw' ? '#d9d9e6' : '#5c5c72', mode === 'raw' ? 2.5 : 1.75, 1);
  trace(tunedMidi, '#a855f7', mode === 'tuned' ? 3 : 2, mode === 'tuned' ? 1 : 0.45);

  if (t >= 0) {
    const px = x(t);
    g.fillStyle = 'rgba(34,211,238,0.9)'; g.fillRect(px, pad - 4, 2, h - pad * 2 + 8);
    const m = mode === 'raw' ? rawMidi(t) : tunedMidi(t);
    const on = envAt(t) > 0.2;
    if (on) {
      g.beginPath(); g.fillStyle = mode === 'raw' ? '#ededf2' : '#a855f7'; g.arc(px, y(m), 5, 0, Math.PI * 2); g.fill();
      const nearest = Math.round(m), cents = Math.round((m - nearest) * 100);
      $('demoNote').textContent = `${NOTE_NAMES[((nearest % 12) + 12) % 12]}${Math.floor(nearest / 12) - 1}  ${cents >= 0 ? '+' : ''}${cents}¢`;
    }
  }
}

$('demoPlay').addEventListener('click', () => (playing ? stop() : play()));
document.querySelectorAll('.ab button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
$('abRaw').addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') { $('abTuned').focus(); setMode('tuned'); } });
$('abTuned').addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') { $('abRaw').focus(); setMode('raw'); } });
window.addEventListener('resize', draw);
document.fonts?.ready.then(draw);
draw();
document.addEventListener('visibilitychange', () => { if (document.hidden && playing) stop(); });

// ---------------------------------------------------------------- Pro
const fill = (k, v) => document.querySelectorAll(`[data-price="${k}"]`).forEach((el) => { el.textContent = v; });
fill('monthly', prices.monthly); fill('first', prices.first); fill('tag', prices.cashtag);
const paintPro = (st) => {
  $('btnGoPro').textContent = st.pro ? 'You are Pro. Open the studio' : 'Go Pro with Cash App';
  $('btnHaveKey').hidden = !!st.pro;
  if (st.pro) $('proNote').textContent = `Pro is on for this device until ${new Date(st.expires).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}.`;
};
initPro({ onChange: paintPro });
$('btnGoPro').addEventListener('click', () => { if (isPro()) window.location.href = 'studio.html'; else openPro(); });
$('btnHaveKey').addEventListener('click', () => { openPro(); setTimeout(() => document.getElementById('proKeyInput')?.focus(), 50); });

// ---------------------------------------------------------------- chrome
const nav = document.querySelector('.nav');
const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
window.addEventListener('scroll', onScroll, { passive: true }); onScroll();
$('year').textContent = new Date().getFullYear();
