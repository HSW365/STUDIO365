// The mixing board: channel strips with faders, pan, mute, solo and live meters, plus the channel EQ editor.
// This file only draws and listens; the sound itself is built in mixer.js.

const CHANNELS = [
  { id: 'vocal', name: 'Vocal', sub: 'Lead', fader: 'vocalDb', min: -24, max: 12, def: 0, pan: 'pan', solo: true, gr: 'comp', tone: 'violet' },
  { id: 'stack', name: 'Stack', sub: 'Doubles + harmony', fader: 'stackDb', min: -24, max: 12, def: 0, solo: true, tone: 'violet' },
  { id: 'beat', name: 'Beat', sub: 'Instrumental', fader: 'beatDb', min: -24, max: 6, def: -3, pan: 'beatPan', solo: true, tone: 'cyan' },
  { id: 'rev', name: 'Reverb', sub: 'Return', fader: 'revDb', min: -24, max: 12, def: 0, tone: 'plain' },
  { id: 'delay', name: 'Echo', sub: 'Return', fader: 'delayDb', min: -24, max: 12, def: 0, tone: 'plain' },
  { id: 'master', name: 'Master', sub: 'Mix bus', fader: 'masterDb', min: -12, max: 12, def: 0, stereo: true, gr: 'limiter', master: true, tone: 'yellow' },
];
const METER_MIN = -54, METER_MAX = 6;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const fmtDb = (v) => `${v > 0 ? '+' : ''}${Number(v).toFixed(1)} dB`;
const fmtPan = (v) => (v == 0 ? 'C' : v < 0 ? `L${-v}` : `R${v}`);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

let api = null;
const strips = new Map();
let raf = 0, idleFrames = 0;

// ---------------------------------------------------------------- a slider you drag, wheel or key
// Shared by the long-throw faders and the pan knobs. Calls back with the new value; double-click resets.
function control(node, { min, max, step, def, vertical = true, throwPx = null, get, set, label, text }) {
  node.setAttribute('role', 'slider'); node.tabIndex = 0;
  node.setAttribute('aria-label', label); node.setAttribute('aria-valuemin', min); node.setAttribute('aria-valuemax', max);
  const snap = (v) => Math.max(min, Math.min(max, Math.round(v / step) * step));
  const commit = (v) => { v = snap(v); if (v !== get()) set(v); paint(); };
  const paint = () => { const v = get(); node.style.setProperty('--pos', (v - min) / (max - min)); node.setAttribute('aria-valuenow', v); node.setAttribute('aria-valuetext', text(v)); };
  let start = null;
  node.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    node.setPointerCapture(e.pointerId); node.focus();
    const px = throwPx || node.getBoundingClientRect()[vertical ? 'height' : 'width'];
    if (!throwPx && vertical) { // jump to where the track was pressed, then drag from there
      const r = node.getBoundingClientRect();
      const pos = Math.max(0, Math.min(1, 1 - (e.clientY - r.top - 11) / (r.height - 22)));   // the cap travels inside an 11 px inset
      if (!e.target.classList.contains('cap')) commit(min + pos * (max - min));
    }
    start = { y: e.clientY, v: get(), px };
    node.classList.add('drag'); e.preventDefault();
  });
  node.addEventListener('pointermove', (e) => {
    if (!start) return;
    const d = (start.y - e.clientY) / start.px * (max - min) * (e.shiftKey ? 0.25 : 1);
    commit(start.v + d);
  });
  const end = () => { start = null; node.classList.remove('drag'); };
  node.addEventListener('pointerup', end); node.addEventListener('pointercancel', end);
  node.addEventListener('dblclick', () => commit(def));
  node.addEventListener('wheel', (e) => { e.preventDefault(); commit(get() + (e.deltaY < 0 ? step : -step) * (e.shiftKey ? 1 : 2)); }, { passive: false });
  node.addEventListener('keydown', (e) => {
    const k = { ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step, PageUp: step * 6, PageDown: -step * 6 }[e.key];
    if (k) { e.preventDefault(); commit(get() + k); }
    if (e.key === 'Home') { e.preventDefault(); commit(min); }
    if (e.key === 'End') { e.preventDefault(); commit(max); }
  });
  return paint;
}

// ---------------------------------------------------------------- strips
export function initConsole(opts) {
  api = opts;
  const root = opts.root;
  root.textContent = '';
  for (const ch of CHANNELS) {
    const s = el('div', `strip tone-${ch.tone}${ch.master ? ' strip-master' : ''}`);
    s.dataset.ch = ch.id;
    const name = el('button', 'strip-name'); name.type = 'button';
    name.append(el('b', null, ch.name), el('span', null, ch.sub));
    name.title = `Open the ${ch.name} channel`;
    name.addEventListener('click', () => api.select(ch.id));

    const panBox = el('div', 'strip-pan');
    let paintPan = null;
    if (ch.pan) {
      const knob = el('div', 'knob'); knob.append(el('i'));
      const out = el('output', null, 'C');
      paintPan = control(knob, {
        min: -100, max: 100, step: 1, def: 0, throwPx: 160, label: `${ch.name} pan`, text: fmtPan,
        get: () => api.mix()[ch.pan], set: (v) => { api.set(ch.pan, v); out.textContent = fmtPan(v); },
      });
      const p0 = paintPan; paintPan = () => { p0(); out.textContent = fmtPan(api.mix()[ch.pan]); };
      panBox.append(knob, out);
    } else panBox.append(el('span', 'strip-pan-none', ch.master ? 'Stereo' : ch.id === 'stack' ? 'Bus' : 'FX'));

    const body = el('div', 'strip-body');
    const scale = el('div', 'strip-scale');
    for (const db of [ch.max, 0, -6, -12, -18, ch.min]) {
      if (db > ch.max || db < ch.min) continue;
      const t = el('span', null, db > 0 ? `+${db}` : String(db)); t.style.bottom = `${((db - ch.min) / (ch.max - ch.min)) * 100}%`; scale.append(t);
    }
    const fader = el('div', 'vfader'); fader.append(el('i', 'cap'));
    const meter = el('canvas', 'strip-meter'); meter.setAttribute('aria-hidden', 'true');
    body.append(scale, fader, meter);
    const val = el('output', 'strip-val', '0.0 dB');
    const paintFader = control(fader, {
      min: ch.min, max: ch.max, step: 0.5, def: ch.def, label: `${ch.name} level`, text: fmtDb,
      get: () => api.mix()[ch.fader], set: (v) => { api.set(ch.fader, v); val.textContent = fmtDb(v); },
    });

    const btns = el('div', 'strip-btns');
    let mute = null, solo = null;
    if (!ch.master) {
      mute = el('button', 'ms mute', 'M'); mute.type = 'button'; mute.title = `Mute ${ch.name}`; mute.setAttribute('aria-label', `Mute ${ch.name}`);
      mute.addEventListener('click', () => api.flag('mute', ch.id, !api.mix().mute[ch.id]));
      btns.append(mute);
      if (ch.solo) {
        solo = el('button', 'ms solo', 'S'); solo.type = 'button'; solo.title = `Solo ${ch.name}`; solo.setAttribute('aria-label', `Solo ${ch.name}`);
        solo.addEventListener('click', () => api.flag('solo', ch.id, !api.mix().solo[ch.id]));
        btns.append(solo);
      }
    } else {
      const clip = el('button', 'clip', 'Hot'); clip.type = 'button'; clip.title = 'Lights when the limiter is holding back more than 3 dB. Click to clear.';
      clip.addEventListener('click', () => { clip.classList.remove('on'); });
      btns.append(clip);
    }
    s.append(name, panBox, body, val, btns);
    root.append(s);
    strips.set(ch.id, { ch, el: s, meter, val, mute, solo, paintFader, paintPan, lv: [METER_MIN, METER_MIN], hold: [METER_MIN, METER_MIN], holdT: [0, 0], gr: 0, clip: s.querySelector('.clip') });
  }
  syncConsole();
  paintMeters(true);
}

export function syncConsole() {
  if (!api) return;
  const m = api.mix();
  const anySolo = m.solo.vocal || m.solo.stack || m.solo.beat;
  for (const s of strips.values()) {
    s.paintFader(); if (s.paintPan) s.paintPan();
    s.val.textContent = fmtDb(m[s.ch.fader]);
    if (s.mute) { s.mute.classList.toggle('on', !!m.mute[s.ch.id]); s.mute.setAttribute('aria-pressed', String(!!m.mute[s.ch.id])); }
    if (s.solo) { s.solo.classList.toggle('on', !!m.solo[s.ch.id]); s.solo.setAttribute('aria-pressed', String(!!m.solo[s.ch.id])); }
    const silent = !s.ch.master && (m.mute[s.ch.id] || (s.ch.solo && anySolo && !m.solo[s.ch.id]));
    s.el.classList.toggle('silent', !!silent);
  }
}
export function selectStrip(id) { for (const s of strips.values()) s.el.classList.toggle('selected', s.ch.id === id); }

// ---------------------------------------------------------------- meters
const tbuf = new Float32Array(2048);
function levelOf(an) {
  if (!an) return METER_MIN;
  const n = an.fftSize; const b = n === tbuf.length ? tbuf : tbuf.subarray(0, n);
  an.getFloatTimeDomainData(b);
  let pk = 0;
  for (let i = 0; i < n; i++) { const a = Math.abs(b[i]); if (a > pk) pk = a; }
  return Math.max(METER_MIN, 20 * Math.log10(pk + 1e-9));
}
function paintMeters(force = false) {
  const G = api.graph();
  const playing = api.playing();
  const now = performance.now();
  const red = G ? G.reduction() : null;
  let alive = false;
  for (const s of strips.values()) {
    const ids = s.ch.stereo ? ['masterL', 'masterR'] : [s.ch.id];
    ids.forEach((id, k) => {
      const v = G && playing ? levelOf(G.meters[id]) : METER_MIN;
      s.lv[k] = v > s.lv[k] ? v : Math.max(METER_MIN, s.lv[k] - 1.1);
      if (v >= s.hold[k] || now - s.holdT[k] > 1400) { s.hold[k] = v > s.lv[k] ? v : s.lv[k]; s.holdT[k] = now; }
      if (s.lv[k] > METER_MIN + 0.5) alive = true;
    });
    const gr = red && s.ch.gr && playing ? Math.min(0, red[s.ch.gr]) : 0;
    s.gr = gr < s.gr ? gr : Math.min(0, s.gr + 0.6);
    if (s.gr < -0.2) alive = true;
    if (s.clip && playing && red && red.limiter < -3) s.clip.classList.add('on');
    drawMeter(s);
  }
  if (api.onFrame) api.onFrame(red, playing);
  if (playing || alive || force) { idleFrames = 0; }
  else if (++idleFrames > 30) { raf = 0; return; }
  raf = requestAnimationFrame(() => paintMeters());
}
export function kickMeters() { idleFrames = 0; if (!raf) raf = requestAnimationFrame(() => paintMeters()); }

function drawMeter(s) {
  const cv = s.meter;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const bars = s.ch.stereo ? 2 : 1;
  const grW = s.ch.gr ? 4 : 0;
  const bw = (w - grW - (bars - 1) * 2 - (grW ? 3 : 0)) / bars;
  const y = (db) => h - ((Math.max(METER_MIN, Math.min(METER_MAX, db)) - METER_MIN) / (METER_MAX - METER_MIN)) * h;
  const cyan = css('--cyan') || '#22d3ee', yellow = css('--yellow') || '#fbbf24', redc = css('--red') || '#ef4444';
  for (let k = 0; k < bars; k++) {
    const x = k * (bw + 2);
    g.fillStyle = '#0a0a0f'; g.fillRect(x, 0, bw, h);
    const top = y(s.lv[k]);
    const grad = g.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, cyan); grad.addColorStop(Math.max(0, (-12 - METER_MIN) / (METER_MAX - METER_MIN)), cyan);
    grad.addColorStop((-4 - METER_MIN) / (METER_MAX - METER_MIN), yellow); grad.addColorStop((0 - METER_MIN) / (METER_MAX - METER_MIN), redc); grad.addColorStop(1, redc);
    g.fillStyle = grad; g.fillRect(x, top, bw, h - top);
    // segment lines so it reads as an LED ladder
    g.fillStyle = 'rgba(10,10,15,.55)';
    for (let yy = h - 3; yy > 0; yy -= 4) g.fillRect(x, yy, bw, 1);
    if (s.hold[k] > METER_MIN + 1) { g.fillStyle = s.hold[k] > -1 ? redc : '#ededf2'; g.fillRect(x, Math.max(0, y(s.hold[k]) - 1), bw, 2); }
  }
  // 0 dB line
  g.fillStyle = 'rgba(255,255,255,.28)'; g.fillRect(0, y(0), w - grW - (grW ? 3 : 0), 1);
  if (grW) {
    const x = w - grW;
    g.fillStyle = '#0a0a0f'; g.fillRect(x, 0, grW, h);
    const len = Math.min(h, (Math.abs(s.gr) / 20) * h);
    g.fillStyle = yellow; g.fillRect(x, 0, grW, len);
  }
}

// ---------------------------------------------------------------- channel EQ editor
// Six points on a curve: low cut, four bands, high cut. Drag a point to move it; wheel over it to change width.
const BANDS = [
  { id: 'hpf', label: 'Low cut', type: 'highpass', f: 'hpf', fMin: 20, fMax: 400, color: '#7d7d92' },
  { id: 'body', label: 'Low', type: 'peaking', f: 'bodyHz', g: 'body', q: 'bodyQ', fMin: 60, fMax: 600, color: '#ef4444' },
  { id: 'mud', label: 'Low mid', type: 'peaking', f: 'mudHz', g: 'mud', q: 'mudQ', fMin: 150, fMax: 1500, color: '#fbbf24' },
  { id: 'pres', label: 'High mid', type: 'peaking', f: 'presHz', g: 'presence', q: 'presQ', fMin: 800, fMax: 8000, color: '#22d3ee' },
  { id: 'air', label: 'Air', type: 'highshelf', f: 'airHz', g: 'air', fMin: 4000, fMax: 16000, color: '#a855f7' },
  { id: 'lpf', label: 'High cut', type: 'lowpass', f: 'lpf', fMin: 2000, fMax: 20000, color: '#7d7d92' },
];
const F_LO = 20, F_HI = 20000, G_RANGE = 15;
const eq = { cv: null, sel: 'pres', scratch: null, nodes: null, freqs: null, mag: null, ph: null, tot: null, spec: null, onSelect: null };
export const EQ_BANDS = BANDS;

export function initEq(canvas, { onSelect } = {}) {
  eq.cv = canvas; eq.onSelect = onSelect;
  const N = 220;
  eq.freqs = new Float32Array(N); eq.mag = new Float32Array(N); eq.ph = new Float32Array(N); eq.tot = new Float32Array(N);
  for (let i = 0; i < N; i++) eq.freqs[i] = F_LO * Math.pow(F_HI / F_LO, i / (N - 1));
  try {
    const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    eq.scratch = new OC(1, 1, 48000);
    eq.nodes = BANDS.map((b) => { const n = eq.scratch.createBiquadFilter(); n.type = b.type; return n; });
  } catch { eq.nodes = null; }
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }; };
  const hit = (p) => {
    const m = api.mix(); let best = null, bd = 18;
    for (const b of BANDS) {
      const bx = fx(m[b.f], p.w), by = gy(b.g ? m[b.g] : 0, p.h);
      const d = Math.hypot(bx - p.x, by - p.y);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  };
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    const p = pos(e), b = hit(p);
    if (!b) return;
    drag = b; canvas.setPointerCapture(e.pointerId); selectBand(b.id); e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pos(e);
    if (!drag) { canvas.style.cursor = hit(p) ? 'grab' : 'default'; return; }
    const f = Math.max(drag.fMin, Math.min(drag.fMax, xf(p.x, p.w)));
    api.set(drag.f, f >= 1000 ? Math.round(f / 50) * 50 : Math.round(f / 5) * 5);
    if (drag.g) api.set(drag.g, Math.max(-12, Math.min(12, Math.round(yg(p.y, p.h) * 2) / 2)));
    drawEq(); if (eq.onSelect) eq.onSelect(drag.id);
  });
  const end = () => { drag = null; };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', (e) => {
    const b = hit(pos(e)) || BANDS.find((x) => x.id === eq.sel);
    if (!b || !b.q) return;
    e.preventDefault();
    const q = Math.max(0.3, Math.min(8, api.mix()[b.q] * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    api.set(b.q, Math.round(q * 100) / 100); drawEq(); if (eq.onSelect) eq.onSelect(b.id);
  }, { passive: false });
  canvas.addEventListener('dblclick', (e) => {
    const b = hit(pos(e)); if (!b) return;
    api.reset([b.f, b.g, b.q].filter(Boolean)); drawEq(); if (eq.onSelect) eq.onSelect(b.id);
  });
  drawEq();
}
export function selectBand(id) { eq.sel = id; drawEq(); if (eq.onSelect) eq.onSelect(id); }
export const selectedBand = () => BANDS.find((b) => b.id === eq.sel);

const fx = (f, w) => (Math.log(f / F_LO) / Math.log(F_HI / F_LO)) * w;
const xf = (x, w) => F_LO * Math.pow(F_HI / F_LO, Math.max(0, Math.min(1, x / w)));
const gy = (g, h) => h / 2 - (g / G_RANGE) * (h / 2);
const yg = (y, h) => ((h / 2 - y) / (h / 2)) * G_RANGE;

export function drawEq(specAnalyser = null) {
  const cv = eq.cv;
  if (!cv || !cv.clientWidth) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#0d0d14'; g.fillRect(0, 0, w, h);
  g.font = '9px "Space Mono", monospace'; g.textBaseline = 'alphabetic';
  // grid
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = Math.round(fx(f, w)) + 0.5;
    g.strokeStyle = 'rgba(255,255,255,.06)'; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    g.fillStyle = '#5d5d70'; g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 3, h - 4);
  }
  for (const db of [-12, -6, 0, 6, 12]) {
    const y = Math.round(gy(db, h)) + 0.5;
    g.strokeStyle = db === 0 ? 'rgba(255,255,255,.2)' : 'rgba(255,255,255,.06)'; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    if (db) { g.fillStyle = '#5d5d70'; g.fillText(`${db > 0 ? '+' : ''}${db}`, 3, y - 3); }
  }
  // live spectrum of the vocal, behind the curve
  if (specAnalyser) {
    const n = specAnalyser.frequencyBinCount;
    if (!eq.spec || eq.spec.length !== n) eq.spec = new Float32Array(n);
    specAnalyser.getFloatFrequencyData(eq.spec);
    const sr = specAnalyser.context.sampleRate;
    g.beginPath(); g.moveTo(0, h);
    for (let x = 0; x <= w; x += 2) {
      const f = xf(x, w), bin = Math.min(n - 1, Math.round((f / (sr / 2)) * n));
      const v = Math.max(-100, eq.spec[bin]);
      g.lineTo(x, h - Math.max(0, (v + 100) / 80) * h);
    }
    g.lineTo(w, h); g.closePath();
    g.fillStyle = 'rgba(168,85,247,.16)'; g.fill();
  }
  // response curve
  const m = api.mix();
  if (eq.nodes) {
    eq.tot.fill(0);
    BANDS.forEach((b, i) => {
      const nd = eq.nodes[i];
      nd.frequency.value = Math.min(m[b.f], 23000); nd.gain.value = b.g ? m[b.g] : 0; nd.Q.value = b.q ? m[b.q] : 0.707;
      nd.getFrequencyResponse(eq.freqs, eq.mag, eq.ph);
      for (let k = 0; k < eq.tot.length; k++) eq.tot[k] += 20 * Math.log10(Math.max(1e-6, eq.mag[k]));
    });
    g.beginPath();
    for (let k = 0; k < eq.tot.length; k++) {
      const x = fx(eq.freqs[k], w), y = Math.max(-4, Math.min(h + 4, gy(eq.tot[k], h)));
      k ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.strokeStyle = '#ededf2'; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
    g.lineTo(w, gy(0, h)); g.lineTo(0, gy(0, h)); g.closePath();
    g.fillStyle = 'rgba(34,211,238,.10)'; g.fill();
  }
  // band points
  for (const b of BANDS) {
    const x = fx(m[b.f], w), y = gy(b.g ? m[b.g] : 0, h), on = b.id === eq.sel;
    g.beginPath(); g.arc(x, y, on ? 8 : 6, 0, Math.PI * 2);
    g.fillStyle = b.color; g.globalAlpha = on ? 1 : 0.75; g.fill(); g.globalAlpha = 1;
    if (on) { g.strokeStyle = '#ededf2'; g.lineWidth = 2; g.stroke(); }
  }
  g.lineWidth = 1;
}
