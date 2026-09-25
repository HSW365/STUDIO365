// Sample-accurate microphone capture. Starts on an exact context frame so takes line up with the beat.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.startFrame = Infinity;
    this.active = false;
    this.buf = [];
    this.size = 0;
    this.meterAcc = 0;
    this.meterPeak = 0;
    this.meterCount = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.cmd === 'start') { this.startFrame = m.frame; this.active = true; this.buf = []; this.size = 0; }
      if (m.cmd === 'stop') { this.active = false; this.flush(); }
    };
  }
  flush() {
    if (!this.size) { this.port.postMessage({ type: 'done', chunks: [] }); return; }
    const out = new Float32Array(this.size);
    let o = 0;
    for (const c of this.buf) { out.set(c, o); o += c.length; }
    this.buf = []; this.size = 0;
    this.port.postMessage({ type: 'done', audio: out }, [out.buffer]);
  }
  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch) return true;
    // meter (always on so the input light works before recording)
    for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > this.meterPeak) this.meterPeak = a; this.meterAcc += ch[i] * ch[i]; }
    this.meterCount += ch.length;
    if (this.meterCount >= 2048) {
      this.port.postMessage({ type: 'meter', peak: this.meterPeak, rms: Math.sqrt(this.meterAcc / this.meterCount) });
      this.meterPeak = 0; this.meterAcc = 0; this.meterCount = 0;
    }
    if (this.active) {
      const end = currentFrame + ch.length;
      if (end > this.startFrame) {
        const from = Math.max(0, this.startFrame - currentFrame);
        this.buf.push(ch.slice(from));
        this.size += ch.length - from;
      }
    }
    return true;
  }
}
registerProcessor('studio365-recorder', RecorderProcessor);
