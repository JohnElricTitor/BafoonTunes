// Runs on the audio thread: passes microphone samples (with their exact frame position)
// to the page while a mic take is being recorded.
class MicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.port.onmessage = e => { this.on = e.data === 'start' ? true : e.data === 'stop' ? false : this.on; };
  }
  process(inputs) {
    const input = inputs[0];
    if (this.on && input && input[0]) {
      // mix to mono
      const n = input[0].length;
      const out = new Float32Array(n);
      for (const ch of input) for (let i = 0; i < n; i++) out[i] += ch[i] / input.length;
      this.port.postMessage({ frame: currentFrame, data: out }, [out.buffer]);
    }
    return true;
  }
}
registerProcessor('mic-capture', MicCapture);
