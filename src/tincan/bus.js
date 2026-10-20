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

/** Echoes in each source's reverberant tail. */
const REVERB_TAPS = 128;

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
   * @param {number} [opts.reverbLevel] reverberant energy relative to the direct sound at 1 m
   * @param {number} [opts.reverbSeed] seed for the reverberant tail's echo pattern
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

    // Reverberation: a diffuse tail, one per source, heard equally by every
    // node (including the source itself). It is a sparse impulse response of
    // randomly placed, random-sign echoes whose amplitude decays by 60 dB over
    // RT60, scaled so its total energy is `reverbLevel` times the direct sound
    // at 1 m — i.e. the critical distance is 1/sqrt(reverbLevel) metres. That
    // reproduces the failure mode that matters: a dominant tone smearing into
    // the recessive bit after it (spec §4.7).
    //
    // An earlier model low-pass filtered the waveform instead, which left a
    // 3–4 kHz tone about 60 dB down: reverberation in name only.
    this.reverbTaps = [];
    if (this.rt60 > 0 && this.reverbLevel > 0) {
      const rnd = mulberry32(opts.reverbSeed ?? 0x5eed);
      const first = Math.round(0.005 * this.sampleRate);
      const span = Math.max(1, Math.round(this.rt60 * this.sampleRate) - first);
      let energy = 0;
      for (let k = 0; k < REVERB_TAPS; k++) {
        const d = first + Math.floor(rnd() * span);
        const a = (rnd() < 0.5 ? -1 : 1) * Math.pow(10, -3 * (d / this.sampleRate) / this.rt60);
        this.reverbTaps.push([d, a]);
        energy += a * a;
      }
      const scale = Math.sqrt(this.reverbLevel / energy);
      for (const tap of this.reverbTaps) tap[1] *= scale;
    }
    const maxTap = this.reverbTaps.reduce((m, [d]) => Math.max(m, d), 0);
    this.reverbState = new Float64Array(N);

    this.histLen = 1;
    while (this.histLen < Math.max(maxDelay, maxTap) + 2) this.histLen <<= 1;
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
    let diffuse = 0;
    if (this.reverbTaps.length) {
      for (let j = 0; j < N; j++) {
        const h = this.nodes[j].history;
        let s = 0;
        for (const [d, a] of this.reverbTaps) s += a * h[(t - d) & this.histMask];
        this.reverbState[j] = s;
        diffuse += s;
      }
    }
    for (let i = 0; i < N; i++) {
      // Assemble node i's input from every node's already-emitted history.
      let x = diffuse;
      for (let j = 0; j < N; j++) {
        const h = this.nodes[j].history;
        x += this.gain[i][j] * h[(t - this.delay[i][j]) & this.histMask];
      }
      if (this.noise > 0) x += this.noise * (this.random() * 2 - 1);
      const y = this.nodes[i].phy.processSample(x);
      this.nodes[i].history[t & this.histMask] = y;
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
