/**
 * Plays and records at given audio times, beside a TinCAN node's own
 * processor on the same microphone and speaker: the tones and recording of a
 * band test (Part 2 §9.3), on the same timeline as the node's events.
 *
 * Messages in: {type:'play', at, signal}, {type:'record', id, at, samples}.
 * Out: {type:'recorded', id, samples}. Signal or recording that falls before
 * the message arrived is skipped, or left as zeros.
 */
class TinCanTones extends AudioWorkletProcessor {
  constructor() {
    super();
    this.plays = [];
    this.recs = [];
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'play') this.plays.push({ at: Math.round(m.at * sampleRate), signal: m.signal });
      if (m.type === 'record') this.recs.push({ id: m.id, at: Math.round(m.at * sampleRate), buf: new Float32Array(m.samples) });
    };
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    const n = output ? output.length : 128;
    const t0 = Math.round(currentTime * sampleRate);
    if (output) {
      output.fill(0);
      for (const p of this.plays) {
        for (let i = 0; i < n; i++) {
          const k = t0 + i - p.at;
          if (k >= 0 && k < p.signal.length) output[i] += p.signal[k];
        }
      }
      this.plays = this.plays.filter((p) => t0 + n - p.at < p.signal.length);
    }
    for (const r of this.recs) {
      for (let i = 0; i < n && input; i++) {
        const k = t0 + i - r.at;
        if (k >= 0 && k < r.buf.length) r.buf[k] = input[i];
      }
      if (t0 + n - r.at >= r.buf.length) {
        r.done = true;
        this.port.postMessage({ type: 'recorded', id: r.id, samples: r.buf }, [r.buf.buffer]);
      }
    }
    this.recs = this.recs.filter((r) => !r.done);
    return true;
  }
}

registerProcessor('tincan-tones', TinCanTones);
