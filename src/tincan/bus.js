/**
 * Two ways to wire TinCAN nodes together without any audio hardware.
 *
 *  - `IdealBus` is a bit-level bus: it applies the wired-AND rule of spec §3
 *    directly, with perfect bit alignment. Useful for exercising the data-link
 *    layer (§6–§8) in isolation.
 *  - `AcousticChannel` is a sample-level simulation: real `Phy` instances,
 *    real tones, per-path propagation delay, distance attenuation, additive
 *    noise and a simple exponential reverberation tail. Useful for exercising
 *    arbitration, synchronization and the near-far limit (§4.6, §5.6).
 */

import { Phy } from './phy.js';
import { Protocol, DOMINANT, RECESSIVE } from './protocol.js';
import { SPEED_OF_SOUND, PROFILES, timing } from './params.js';

/* ------------------------------------------------------------------ */
/* bit-level                                                           */
/* ------------------------------------------------------------------ */

export class IdealBus {
  /** @param {Protocol[]} nodes */
  constructor(nodes) {
    this.nodes = nodes;
    this.bit = 0;
    this.trace = [];
    this.traceLimit = 0;
    /**
     * Optional fault injector. Called with (bitIndex, busLevel, txLevels); a
     * return of 0 or 1 overrides the level every node reads for that bit.
     * @type {null | ((bit:number, level:number, tx:(0|1|null)[]) => 0|1|void)}
     */
    this.corrupt = null;
  }

  /** Advance the bus by one bit time. */
  step() {
    const levels = this.nodes.map((n) => n.beginBit());
    const carrier = levels.some((l) => l !== null);
    let level = levels.some((l) => l === DOMINANT) ? DOMINANT : RECESSIVE;
    if (this.corrupt) {
      const forced = this.corrupt(this.bit, level, levels);
      if (forced === DOMINANT || forced === RECESSIVE) level = forced;
    }
    for (const n of this.nodes) n.endBit(level, carrier);
    if (this.traceLimit && this.trace.length < this.traceLimit) {
      this.trace.push({ bit: this.bit, level, carrier, tx: levels });
    }
    this.bit++;
    return { level, carrier, tx: levels };
  }

  run(bits) { for (let i = 0; i < bits; i++) this.step(); return this; }

  /** Run until `predicate()` is true or `limit` bits have elapsed. */
  runUntil(predicate, limit = 100000) {
    for (let i = 0; i < limit; i++) {
      if (predicate()) return true;
      this.step();
    }
    return predicate();
  }
}

/* ------------------------------------------------------------------ */
/* sample-level                                                        */
/* ------------------------------------------------------------------ */

/**
 * A node in the acoustic simulation.
 * @typedef {object} SimNodeSpec
 * @property {string} name
 * @property {number} [x] position, metres
 * @property {number} [y]
 * @property {number} [gain] transmit gain multiplier (1 = nominal)
 * @property {'node'|'listener'} [mode]
 */

export class AcousticChannel {
  /**
   * @param {object} opts
   * @param {SimNodeSpec[]} opts.nodes
   * @param {number} [opts.sampleRate] simulation rate; 16 kHz is enough for band A
   * @param {string} [opts.band]
   * @param {string} [opts.profile]
   * @param {number} [opts.noise] additive white noise amplitude
   * @param {number} [opts.rt60] reverberation time, seconds; 0 disables
   * @param {number} [opts.reverbLevel] reverberant level relative to direct
   * @param {number} [opts.selfDelayMs] speaker-to-own-microphone latency
   * @param {number} [opts.selfGain] how loudly a node hears itself
   * @param {() => number} [opts.random] uniform [0,1) source, for repeatability
   */
  constructor(opts) {
    this.sampleRate = opts.sampleRate || 16000;
    this.band = opts.band || 'A';
    this.profile = opts.profile || 'T25';
    this.noise = opts.noise ?? 0;
    this.rt60 = opts.rt60 ?? 0;
    this.reverbLevel = opts.reverbLevel ?? 0.3;
    this.random = opts.random || Math.random;
    this.t = timing(PROFILES[this.profile] || this.profile);

    const selfDelayMs = opts.selfDelayMs ?? 1;
    const selfGain = opts.selfGain ?? 1;

    this.nodes = opts.nodes.map((spec, i) => {
      const protocol = new Protocol({ name: spec.name || `n${i}`, mode: spec.mode || 'node' });
      const phy = new Phy({
        sampleRate: this.sampleRate,
        protocol,
        band: this.band,
        profile: this.profile,
        amplitude: (spec.gain ?? 1) * 0.3,
        onBit: spec.onBit,
      });
      return { spec, protocol, phy, x: spec.x ?? 0, y: spec.y ?? 0, history: null, head: 0 };
    });

    // Path delays and gains. Distance attenuation is 1/r with a 0.25 m floor so
    // that co-located nodes do not produce absurd gains.
    const N = this.nodes.length;
    this.delay = [];
    this.gain = [];
    let maxDelay = 1;
    for (let i = 0; i < N; i++) {
      this.delay[i] = [];
      this.gain[i] = [];
      for (let j = 0; j < N; j++) {
        if (i === j) {
          this.delay[i][j] = Math.max(1, Math.round((selfDelayMs / 1000) * this.sampleRate));
          this.gain[i][j] = selfGain;
        } else {
          const d = Math.hypot(this.nodes[i].x - this.nodes[j].x, this.nodes[i].y - this.nodes[j].y);
          this.delay[i][j] = Math.max(1, Math.round((d / SPEED_OF_SOUND) * this.sampleRate));
          this.gain[i][j] = 1 / Math.max(0.25, d);
        }
        maxDelay = Math.max(maxDelay, this.delay[i][j]);
      }
    }

    // Reverberation: one exponentially decaying tap per path, delayed by an
    // extra 20 ms. Crude, but it reproduces the failure mode that matters —
    // a dominant tone smearing into the recessive bit after it (spec §4.7).
    this.reverbDelay = Math.round(0.02 * this.sampleRate);
    this.reverbDecay = this.rt60 > 0 ? Math.exp(-6.9078 / (this.rt60 * this.sampleRate)) : 0;
    this.reverbState = new Float64Array(N);

    this.histLen = 1;
    while (this.histLen < maxDelay + this.reverbDelay + 2) this.histLen <<= 1;
    this.histMask = this.histLen - 1;
    for (const n of this.nodes) n.history = new Float32Array(this.histLen);

    this.n = 0;
    this.busTrace = null;
  }

  node(name) { return this.nodes.find((n) => n.spec.name === name); }
  get protocols() { return this.nodes.map((n) => n.protocol); }

  /** Advance the simulation by one sample. */
  stepSample() {
    const N = this.nodes.length;
    const t = this.n;
    for (let i = 0; i < N; i++) {
      // Assemble node i's input from every node's already-emitted history.
      let x = 0;
      for (let j = 0; j < N; j++) {
        const h = this.nodes[j].history;
        x += this.gain[i][j] * h[(t - this.delay[i][j]) & this.histMask];
        if (this.reverbDecay > 0 && i !== j) {
          x += this.gain[i][j] * this.reverbLevel * this.reverbState[j];
        }
      }
      if (this.noise > 0) x += this.noise * (this.random() * 2 - 1);
      const y = this.nodes[i].phy.processSample(x);
      this.nodes[i].history[t & this.histMask] = y;
    }
    if (this.reverbDecay > 0) {
      for (let j = 0; j < N; j++) {
        const src = this.nodes[j].history[(t - this.reverbDelay) & this.histMask];
        this.reverbState[j] = this.reverbState[j] * this.reverbDecay + src * (1 - this.reverbDecay);
      }
    }
    this.n++;
  }

  /** Advance by a number of seconds. */
  run(seconds) {
    const n = Math.round(seconds * this.sampleRate);
    for (let i = 0; i < n; i++) this.stepSample();
    return this;
  }

  /** Advance until `predicate()` is true, or `seconds` elapse. */
  runUntil(predicate, seconds) {
    const n = Math.round(seconds * this.sampleRate);
    for (let i = 0; i < n; i++) {
      if (predicate()) return true;
      this.stepSample();
    }
    return predicate();
  }

  /** Bit times, for sizing runs. */
  get bitTime() { return this.t.bitTime; }
}

/** Deterministic uniform [0,1) source, so simulations reproduce exactly. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
