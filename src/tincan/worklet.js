/**
 * TinCAN AudioWorkletProcessor.
 *
 * The whole node — detector, bit clock, and data-link state machine — runs
 * inside the audio thread. That is not an optimisation; it is a requirement.
 * Arbitration needs a transmit decision at every bit boundary, taken from a
 * sample read at 80–85 % of the previous bit, which leaves 3–6 ms of slack. A
 * main-thread scheduler cannot meet that deadline reliably, and a missed
 * deadline is a corrupted frame rather than a glitch.
 *
 * The main thread talks to this over `port`: it queues frames and receives
 * events. It never sees a bit.
 */

import { Protocol } from './protocol.js';
import { Phy } from './phy.js';

const FORWARDED_EVENTS = [
  'frame', 'frame-decoded', 'tx-start', 'tx-complete', 'tx-failed',
  'arbitration-lost', 'error-frame', 'error-state', 'overload',
  'abandoned', 'bus-off-recovered', 'queued',
];

class TinCanProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};

    this.protocol = new Protocol({
      name: o.name || 'node',
      mode: o.mode || 'node',
      strict: !!o.strict,
      autoRetransmit: o.autoRetransmit !== false,
      autoBusOffRecovery: o.autoBusOffRecovery !== false,
    });

    this.baseMode = o.mode || 'node';
    this.muted = !!o.muted;
    if (this.muted) this.protocol.mode = 'listener';
    this.bitLog = [];
    this.bitLogLimit = o.bitLogLimit ?? 256;

    this.phy = new Phy({
      sampleRate,
      protocol: this.protocol,
      band: o.band || 'A',
      profile: o.profile || 'T25',
      amplitude: o.amplitude ?? 0.25,
      thetaD: o.thetaD,
      kappa: o.kappa,
      onBit: (d) => this._onBit(d),
    });

    for (const name of FORWARDED_EVENTS) {
      this.protocol.on(name, (detail) => this._post({ type: 'event', event: name, detail: serialize(detail) }));
    }

    // Input gaps: runs of exact zeros, which no microphone produces but the
    // browser inserts when the capture side falls behind (and which its track
    // statistics do not count). Every later sample arrives that much late.
    this.zeroRun = 0;
    this.gaps = { count: 0, ms: 0 };
    // Optional capture of the last `capture` seconds of input, for diagnosis.
    this.capture = o.capture > 0 ? new Int16Array(Math.round(o.capture * sampleRate)) : null;
    this.captureAt = 0;

    this.port.onmessage = (e) => this._onMessage(e.data);
    this.running = true;
    this.lastReport = 0;
    this.reportEvery = Math.round(sampleRate / 10);   // 10 Hz
    this.frames = 0;

    this._post({
      type: 'ready',
      sampleRate,
      band: this.phy.band,
      bitRate: this.phy.bitRate,
      bitSamples: this.phy.bitSamples,
      samplePointFraction: this.phy.t.samplePointFraction,
    });
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'send':
        try {
          const item = this.protocol.send(reviveFrame(msg.frame));
          this._post({ type: 'accepted', seq: item.seq, frame: serializeFrame(item.frame) });
        } catch (err) {
          this._post({ type: 'rejected', error: String(err && err.message || err) });
        }
        break;
      case 'mute':
        this._setMuted(!!msg.value);
        break;
      case 'amplitude':
        this.phy.amplitude = msg.value;
        break;
      case 'threshold':
        if (msg.thetaD !== undefined) this.phy.thetaD = msg.thetaD;
        if (msg.kappa !== undefined) this.phy.kappa = msg.kappa;
        break;
      case 'clear-queue':
        this.protocol.txQueue.length = 0;
        break;
      case 'stop':
        this.running = false;
        break;
      case 'dump': {
        // The capture in time order, ending now.
        const c = this.capture;
        const out = c ? new Int16Array(c.length) : new Int16Array(0);
        if (c) {
          const k = this.captureAt % c.length;
          out.set(c.subarray(k), 0);
          out.set(c.subarray(0, k), c.length - k);
        }
        this._post({ type: 'capture', samples: out, endTime: this.frames / sampleRate, filled: Math.min(this.captureAt, out.length) });
        break;
      }
      default:
        break;
    }
  }

  /**
   * Muting has to stop the node participating, not just silence the speaker.
   * A node that transmits into a muted output would read back recessive where
   * it sent dominant and log a bit error on every frame.
   */
  _setMuted(v) {
    if (v === this.muted) return;
    this.muted = v;
    this.protocol.mode = v ? 'listener' : (this.baseMode || 'node');
    if (v) this.protocol.txQueue.length = 0;
  }

  _onBit(d) {
    this.bitLog.push({
      i: d.index, t: d.time, level: d.level, carrier: d.carrier,
      ratio: d.ratio, eR: d.eR, eD: d.eD, noise: d.noise,
      tx: d.tx, state: d.state,
    });
    if (this.bitLog.length > this.bitLogLimit) this.bitLog.shift();
  }

  _watchInput(x, i) {
    if (this.capture) {
      this.capture[this.captureAt % this.capture.length] = Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
      this.captureAt++;
    }
    if (x === 0) { this.zeroRun++; return; }
    if (this.zeroRun >= 64) {
      const ms = (this.zeroRun / sampleRate) * 1000;
      this.gaps.count++;
      this.gaps.ms += ms;
      this._post({ type: 'event', event: 'input-gap', detail: { ms, at: (this.frames + i) / sampleRate } });
    }
    this.zeroRun = 0;
  }

  _post(m) { this.port.postMessage(m); }

  process(inputs, outputs) {
    if (!this.running) return false;

    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    const n = output ? output.length : (input ? input.length : 128);

    for (let i = 0; i < n; i++) {
      const x = input ? input[i] : 0;
      if (input) this._watchInput(x, i);
      const y = this.phy.processSample(x);
      if (output) output[i] = this.muted ? 0 : y;
    }

    this.frames += n;
    if (this.frames - this.lastReport >= this.reportEvery) {
      this.lastReport = this.frames;
      this._post({
        type: 'status',
        time: this.frames / sampleRate,
        state: this.protocol.state,
        errorState: this.protocol.errorState,
        tec: this.protocol.tec,
        rec: this.protocol.rec,
        queue: this.protocol.queueLength,
        transmitting: this.protocol.transmitting,
        stats: { ...this.protocol.stats },
        inputGaps: { ...this.gaps },
        signal: {
          eR: this.phy.last.eR, eD: this.phy.last.eD,
          noise: this.phy.last.noise, ratio: this.phy.last.ratio,
          carrier: this.phy.last.carrier,
        },
        bits: this.bitLog.splice(0, this.bitLog.length),
      });
    }
    return true;
  }
}

function serializeFrame(f) {
  return f && {
    id: f.id, extended: f.extended, rtr: f.rtr, fdf: f.fdf, dlc: f.dlc,
    data: Array.from(f.data || []),
  };
}

function serialize(detail) {
  if (!detail) return {};
  const out = {};
  for (const [k, v] of Object.entries(detail)) {
    if (k === 'frame') out.frame = serializeFrame(v);
    else if (k === 'item') out.item = { seq: v.seq, attempts: v.attempts, frame: serializeFrame(v.frame) };
    else if (k === 'fields') out.fields = v;
    else if (typeof v === 'function' || typeof v === 'object') continue;
    else out[k] = v;
  }
  return out;
}

function reviveFrame(f) {
  return { ...f, data: f.data ? Uint8Array.from(f.data) : undefined };
}

registerProcessor('tincan', TinCanProcessor);
