// Sample-accurate microphone capture. Starts on an exact context frame so takes line up with the beat.
// Audio leaves the audio thread in half-second blocks as it is recorded, so a ten minute take costs the
// same as a ten second one and nothing has to be stitched together on the audio thread when you stop.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.startFrame = Infinity;
    this.active = false;
    this.blockSize = Math.round(sampleRate / 2);
    this.block = new Float32Array(this.blockSize);
    this.fill = 0;
    this.meterPeak = 0;
    this.meterCount = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.cmd === 'start') { this.startFrame = m.frame; this.active = true; this.fill = 0; }
      if (m.cmd === 'stop') { this.active = false; this.send(); this.port.postMessage({ type: 'done' }); }
    };
  }
  send() {
    if (!this.fill) return;
    const out = this.fill === this.blockSize ? this.block : this.block.slice(0, this.fill);
    this.port.postMessage({ type: 'chunk', audio: out }, [out.buffer]);
    this.block = new Float32Array(this.blockSize);
    this.fill = 0;
  }
  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch) return true;
    // meter (always on so the input light works before recording)
    let pk = this.meterPeak;
    for (let i = 0; i < ch.length; i++) { const a = ch[i] < 0 ? -ch[i] : ch[i]; if (a > pk) pk = a; }
    this.meterPeak = pk;
    this.meterCount += ch.length;
    if (this.meterCount >= 2048) { this.port.postMessage({ type: 'meter', peak: pk }); this.meterPeak = 0; this.meterCount = 0; }
    if (this.active) {
      const end = currentFrame + ch.length;
      if (end > this.startFrame) {
        let from = Math.max(0, this.startFrame - currentFrame);
        while (from < ch.length) {
          const n = Math.min(ch.length - from, this.blockSize - this.fill);
          this.block.set(ch.subarray(from, from + n), this.fill);
          this.fill += n; from += n;
          if (this.fill === this.blockSize) this.send();
        }
      }
    }
    return true;
  }
}
registerProcessor('studio365-recorder', RecorderProcessor);
