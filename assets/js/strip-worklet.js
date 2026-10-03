// Console processors: compressor, de-esser and the monitor limiter.
// The same code runs while you listen and when a mix is bounced, so what you hear is what exports.

const db2g = (db) => Math.pow(10, db / 20);
const coef = (seconds) => Math.exp(-1 / (Math.max(1e-4, seconds) * sampleRate));

// ---------------------------------------------------------------- compressor
// Feed-forward, soft knee, channels linked. No hidden make-up gain: the numbers on the knobs are the numbers.
class Comp extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -18, minValue: -60, maxValue: 0, automationRate: 'k-rate' },
      { name: 'ratio', defaultValue: 3, minValue: 1, maxValue: 20, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 0.005, minValue: 0.0001, maxValue: 0.5, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.12, minValue: 0.005, maxValue: 2, automationRate: 'k-rate' },
      { name: 'knee', defaultValue: 6, minValue: 0, maxValue: 24, automationRate: 'k-rate' },
      { name: 'makeup', defaultValue: 0, minValue: -12, maxValue: 30, automationRate: 'k-rate' },
    ];
  }
  constructor() { super(); this.env = 0; this.minGr = 0; this.count = 0; }
  process(inputs, outputs, p) {
    const input = inputs[0], output = outputs[0];
    if (!input || !input.length) return true;
    const thr = p.threshold[0], slope = 1 / p.ratio[0] - 1, knee = p.knee[0];
    const att = coef(p.attack[0]), rel = coef(p.release[0]), mk = p.makeup[0];
    const n = input[0].length, chs = input.length;
    let env = this.env;
    for (let i = 0; i < n; i++) {
      let pk = 0;
      for (let c = 0; c < chs; c++) { const a = Math.abs(input[c][i]); if (a > pk) pk = a; }
      const over = 20 * Math.log10(pk + 1e-9) - thr;
      let g;
      if (2 * over < -knee) g = 0;
      else if (knee > 0 && 2 * Math.abs(over) <= knee) g = slope * (over + knee / 2) * (over + knee / 2) / (2 * knee);
      else g = slope * over;
      env = g < env ? att * env + (1 - att) * g : rel * env + (1 - rel) * g;
      if (env < this.minGr) this.minGr = env;
      const gain = db2g(env + mk);
      for (let c = 0; c < output.length; c++) output[c][i] = (input[c] || input[0])[i] * gain;
    }
    this.env = env;
    this.count += n;
    if (this.count >= 2048) { this.port.postMessage(this.minGr); this.minGr = 0; this.count = 0; }
    return true;
  }
}
registerProcessor('studio365-comp', Comp);

// ---------------------------------------------------------------- de-esser
// Splits the voice at `freq`, watches how much of the sound is up there, and ducks only that top band
// when an S or T takes over. Works the same on a loud take and a quiet one.
class DeEss extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'freq', defaultValue: 6800, minValue: 2000, maxValue: 12000, automationRate: 'k-rate' },
      { name: 'amount', defaultValue: 3, minValue: 0, maxValue: 18, automationRate: 'k-rate' },
    ];
  }
  constructor() { super(); this.lp = [0, 0]; this.lp2 = [0, 0]; this.eh = 0; this.ef = 0; this.red = 0; this.minGr = 0; this.count = 0; }
  process(inputs, outputs, p) {
    const input = inputs[0], output = outputs[0];
    if (!input || !input.length) return true;
    const amount = p.amount[0];
    const a = 1 - Math.exp(-2 * Math.PI * p.freq[0] / sampleRate);
    const det = coef(0.004), att = coef(0.001), rel = coef(0.06);
    const n = input[0].length;
    for (let i = 0; i < n; i++) {
      let hi2 = 0, full2 = 0;
      for (let c = 0; c < output.length; c++) {
        const x = (input[c] || input[0])[i];
        this.lp[c] += (x - this.lp[c]) * a; this.lp2[c] += (this.lp[c] - this.lp2[c]) * a;
        const hi = x - this.lp2[c];
        hi2 += hi * hi; full2 += x * x;
        output[c][i] = hi; // stash the top band; the low band is rebuilt below
      }
      this.eh = det * this.eh + (1 - det) * hi2; this.ef = det * this.ef + (1 - det) * full2;
      const r = Math.sqrt(this.eh / (this.ef + 1e-12));
      const t = Math.max(0, Math.min(1, (r - 0.3) / 0.35));
      const want = amount * t * t * (3 - 2 * t);
      this.red = want > this.red ? att * this.red + (1 - att) * want : rel * this.red + (1 - rel) * want;
      if (-this.red < this.minGr) this.minGr = -this.red;
      const g = db2g(-this.red);
      for (let c = 0; c < output.length; c++) {
        const x = (input[c] || input[0])[i], hi = output[c][i];
        output[c][i] = (x - hi) + hi * g;
      }
    }
    this.count += n;
    if (this.count >= 2048) { this.port.postMessage(this.minGr); this.minGr = 0; this.count = 0; }
    return true;
  }
}
registerProcessor('studio365-deess', DeEss);

// ---------------------------------------------------------------- monitor limiter
// Brings the mix up to the mastering level and holds peaks under the ceiling while you listen.
// Exports are finished by the offline mastering stage, which measures the whole record.
class Limiter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'gain', defaultValue: 0, minValue: -40, maxValue: 40, automationRate: 'k-rate' },
      { name: 'ceiling', defaultValue: -1, minValue: -12, maxValue: 0, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.L = Math.max(16, Math.round(sampleRate * 0.003));
    this.buf = [new Float32Array(this.L), new Float32Array(this.L)];
    this.w = 0; this.hold = 0; this.target = 1; this.g = 1; this.pre = 1; this.minGr = 0; this.count = 0;
    this.sm = Math.exp(-1 / (this.L / 3));
  }
  process(inputs, outputs, p) {
    const input = inputs[0], output = outputs[0];
    const want = db2g(p.gain[0]), ceil = db2g(p.ceiling[0]);
    const rel = coef(0.09);
    const n = output[0].length, L = this.L;
    for (let i = 0; i < n; i++) {
      this.pre += (want - this.pre) * 0.0005; // glide to a new mastering level
      let pk = 0;
      const frame = [0, 0];
      for (let c = 0; c < 2; c++) {
        const ch = input && input.length ? (input[c] || input[0]) : null;
        const v = ch ? ch[i] * this.pre : 0;
        frame[c] = v; const a = Math.abs(v); if (a > pk) pk = a;
      }
      const need = pk > ceil ? ceil / pk : 1;
      if (need <= this.target) { this.target = need; this.hold = L; }
      else if (this.hold > 0) this.hold--;
      else this.target = need + (this.target - need) * rel;
      if (this.target > 1) this.target = 1;
      this.g = this.target < this.g ? this.sm * this.g + (1 - this.sm) * this.target : this.target;
      const gdb = 20 * Math.log10(this.g); if (gdb < this.minGr) this.minGr = gdb;
      for (let c = 0; c < output.length; c++) {
        const b = this.buf[c] || this.buf[0];
        let o = b[this.w] * this.g;
        if (o > ceil) o = ceil; else if (o < -ceil) o = -ceil;
        output[c][i] = o;
        b[this.w] = frame[c];
      }
      this.w = (this.w + 1) % L;
    }
    this.count += n;
    if (this.count >= 2048) { this.port.postMessage(this.minGr); this.minGr = 0; this.count = 0; }
    return true;
  }
}
registerProcessor('studio365-limiter', Limiter);
