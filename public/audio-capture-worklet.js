// AudioContext resamples the microphone to 24 kHz before this processor.
class CabinAudioCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new ArrayBuffer(4800 * 2);
    this.view = new DataView(this.frame);
    this.samples = 0;
    this.capturing = true;
    this.port.onmessage = event => {
      if (event.data?.type !== 'flush') return;
      this.capturing = false;
      this.sendFrame();
      this.port.postMessage({ type: 'flushed' });
    };
  }

  sendFrame() {
    if (!this.samples) return;
    const audio = this.samples === 4800 ? this.frame : this.frame.slice(0, this.samples * 2);
    this.port.postMessage({ type: 'audio', audio }, [audio]);
    this.frame = new ArrayBuffer(4800 * 2);
    this.view = new DataView(this.frame);
    this.samples = 0;
  }

  process(inputs) {
    if (!this.capturing) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    // Include quiet frames: do not gate translation on local speech/silence detection.
    for (const value of input) {
      const sample = Math.max(-1, Math.min(1, value));
      this.view.setInt16(this.samples++ * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
      if (this.samples === 4800) this.sendFrame();
    }
    return true;
  }
}

registerProcessor('cabin-audio-capture', CabinAudioCapture);
