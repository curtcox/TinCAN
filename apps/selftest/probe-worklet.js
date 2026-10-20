/**
 * Plays a test signal and records the microphone in the same audio callbacks,
 * so that sample k of the recording and sample k of the signal are the same
 * instant on the audio thread. The delay between them in the recording is
 * then exactly the speaker-to-microphone latency a TinCAN node's own Phy sees.
 */
class TinCanProbe extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.signal = o.signal;
    this.recording = new Float32Array(o.recordSamples);
    this.n = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    const len = output ? output.length : 128;
    for (let i = 0; i < len; i++) {
      const k = this.n + i;
      if (output) output[i] = k < this.signal.length ? this.signal[k] : 0;
      if (k < this.recording.length) this.recording[k] = input ? input[i] : 0;
    }
    this.n += len;
    if (this.n >= this.recording.length) {
      this.port.postMessage({ recording: this.recording }, [this.recording.buffer]);
      return false;
    }
    return true;
  }
}

registerProcessor('tincan-probe', TinCanProbe);
