/**
 * TinCAN physical layer — spec §4 and §5.
 *
 * Sample-rate driven, environment-free: it consumes and produces raw audio
 * samples and drives a `Protocol` instance one bit at a time. The same class
 * runs inside an AudioWorklet (live audio) and inside the offline channel
 * simulator, which is why it may not touch anything browser-specific.
 */

import { BANDS, PROFILES, DETECTOR_DEFAULTS, timing } from './params.js';
import { DOMINANT, RECESSIVE, STATE } from './protocol.js';

/** Goertzel power of a windowed block, read from a ring buffer. */
function goertzel(ring, mask, endIndex, length, coeff, win) {
  let s1 = 0, s2 = 0;
  const start = endIndex - length + 1;
  for (let i = 0; i < length; i++) {
    const x = ring[(start + i) & mask] * win[i];
    const s0 = x + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/** Sum of squared window coefficients: white-noise power scales with this. */
function sumSquares(w) {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i] * w[i];
  return s;
}

function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

export class Phy {
  /**
   * @param {object} opts
   * @param {number} opts.sampleRate
   * @param {import('./protocol.js').Protocol} opts.protocol
   * @param {string|object} [opts.band]     key of BANDS or a band object
   * @param {string|object} [opts.profile]  key of PROFILES or a profile object
   * @param {number} [opts.amplitude]       peak output amplitude, 0..1
   * @param {number} [opts.thetaD]
   * @param {number} [opts.kappa]
   * @param {(d: object) => void} [opts.onBit] per-bit diagnostics
   */
  constructor(opts) {
    const { sampleRate, protocol } = opts;
    if (!sampleRate) throw new Error('sampleRate is required');
    this.sampleRate = sampleRate;
    this.protocol = protocol;
    this.band = typeof opts.band === 'string' ? BANDS[opts.band] : (opts.band || BANDS.A);
    this.profileKey = typeof opts.profile === 'string' ? opts.profile : null;
    const prof = typeof opts.profile === 'string' ? PROFILES[opts.profile] : (opts.profile || PROFILES.T25);
    this.t = timing(prof);
    this.amplitude = opts.amplitude ?? 0.25;
    this.thetaD = opts.thetaD ?? DETECTOR_DEFAULTS.thetaD;
    this.kappa = opts.kappa ?? DETECTOR_DEFAULTS.kappa;
    this.onBit = opts.onBit || null;
    this.onEdge = opts.onEdge || null;

    const fs = sampleRate;
    this.tqSamples = Math.max(1, Math.round(this.t.tq * fs));
    this.bitSamples = this.tqSamples * this.t.totalTq;
    this.syncSamples = this.tqSamples * this.t.sync;
    this.propSamples = this.tqSamples * this.t.prop;
    this.ps1Samples = this.tqSamples * this.t.ps1;
    this.ps2Samples = this.tqSamples * this.t.ps2;
    this.sjwSamples = this.tqSamples * this.t.sjw;
    this.hopSamples = Math.max(1, Math.round(this.tqSamples / DETECTOR_DEFAULTS.hopsPerTq));

    this.winSamples = this.ps1Samples;
    this.edgeSamples = Math.max(8, this.tqSamples * DETECTOR_DEFAULTS.edgeWindowTq);

    // Detection ring buffer
    const ringSize = nextPow2(Math.max(this.winSamples, this.edgeSamples) + 2);
    this.ring = new Float32Array(ringSize);
    this.mask = ringSize - 1;

    this.winMain = hann(this.winSamples);
    this.winEdge = hann(this.edgeSamples);
    // A single-bin power estimate has two degrees of freedom no matter how long
    // the window is, so the instantaneous guard-bin reading is far too noisy to
    // threshold against directly. Track it instead, and scale the estimate
    // between the two window lengths (white-noise power ∝ Σ w²).
    this.noiseScale = sumSquares(this.winMain) / sumSquares(this.winEdge);
    this.noiseEst = 0;
    this.noiseAlpha = 1 - Math.exp(-this.hopSamples
      / (DETECTOR_DEFAULTS.noiseTauBits * this.bitSamples));
    this.noisePrimed = false;
    // Fraction of recent carrier hops that were broadband, over about a bit.
    this.broadband = 0;
    this.broadbandAlpha = 1 - Math.exp(-this.hopSamples / this.bitSamples);
    this.edgeRun = 0;

    const k = (f) => 2 * Math.cos((2 * Math.PI * f) / fs);
    this.coefR = k(this.band.fR);
    this.coefD = k(this.band.fD);
    this.coefLo = k(this.band.guardLo);
    this.coefHi = k(this.band.guardHi);

    // Tone generator
    this.incR = (2 * Math.PI * this.band.fR) / fs;
    this.incD = (2 * Math.PI * this.band.fD) / fs;
    this.phaseR = 0;
    this.phaseD = 0;
    this.switchSamples = Math.max(1, Math.min(this.syncSamples, Math.round(0.001 * fs)));
    this.txLevel = null;
    this.prevTxLevel = null;
    this.switchCount = this.switchSamples;

    // Bit clock
    this.n = 0;                       // absolute sample index
    this.bitStart = 0;
    this.samplePointAt = this.syncSamples + this.propSamples + this.ps1Samples;
    this.bitEndAt = this.bitSamples;
    this.bitCount = 0;
    this.sampled = false;
    this.txSyncApplied = false;

    // Edge tracking
    this.lastEdgeLevel = RECESSIVE;
    this.firstDominantEdge = null;
    this.nextHopAt = this.hopSamples;

    // Diagnostics
    this.last = { eR: 0, eD: 0, noise: 0, ratio: 0, carrier: false, level: RECESSIVE };

    // Prime the first bit.
    this._beginBit();
  }

  /** @returns {number} the bit rate actually in use */
  get bitRate() { return this.sampleRate / this.bitSamples; }

  /* ---------------------------------------------------------------- */

  /**
   * Process one input sample and return one output sample. The returned value
   * does not depend on `x`, so a caller may compute all nodes' outputs for a
   * sample before assembling any node's input for that sample.
   */
  processSample(x) {
    const y = this._emit();

    this.ring[this.n & this.mask] = x;

    if (this.n >= this.nextHopAt) {
      this.nextHopAt += this.hopSamples;
      this._edgeDetect();
    }

    if (!this.sampled && this.n >= this.samplePointAt) { this.sampled = true; this._samplePoint(); }
    if (this.n >= this.bitEndAt) {
      if (!this.sampled) { this.sampled = true; this._samplePoint(); }
      this._nextBit();
    }

    this.n++;
    return y;
  }

  /** Block form. `input` and `output` must be the same length. */
  process(input, output) {
    for (let i = 0; i < input.length; i++) output[i] = this.processSample(input[i]);
  }

  /* ---------------------------------------------------------------- */
  /* transmit                                                          */
  /* ---------------------------------------------------------------- */

  _emit() {
    this.phaseR += this.incR; if (this.phaseR > 6.283185307179586) this.phaseR -= 6.283185307179586;
    this.phaseD += this.incD; if (this.phaseD > 6.283185307179586) this.phaseD -= 6.283185307179586;

    if (this.txLevel === null && this.prevTxLevel === null) return 0;

    let gNew = 1, gOld = 0;
    if (this.switchCount < this.switchSamples) {
      // raised-cosine cross-fade, spec §4.3
      const p = (this.switchCount + 1) / this.switchSamples;
      gNew = 0.5 - 0.5 * Math.cos(Math.PI * p);
      gOld = 1 - gNew;
      this.switchCount++;
    }
    const tone = (lvl) => lvl === null ? 0 : (lvl === DOMINANT ? Math.sin(this.phaseD) : Math.sin(this.phaseR));
    return this.amplitude * (gNew * tone(this.txLevel) + gOld * tone(this.prevTxLevel));
  }

  _setTxLevel(level) {
    if (level === this.txLevel) return;
    this.prevTxLevel = this.txLevel;
    this.txLevel = level;
    this.switchCount = 0;
  }

  /* ---------------------------------------------------------------- */
  /* detection                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * @param {number} length window length in samples
   * @param {Float32Array} win
   * @param {number} noiseFloor estimated guard-bin power at this window length
   */
  _measure(length, win, noiseFloor) {
    const end = this.n;
    const eR = goertzel(this.ring, this.mask, end, length, this.coefR, win);
    const eD = goertzel(this.ring, this.mask, end, length, this.coefD, win);
    const total = eR + eD;
    const carrier = this.noisePrimed && total >= this.kappa * noiseFloor && total > 1e-18;
    const ratio = total > 0 ? eD / total : 0;
    const level = carrier && ratio >= this.thetaD ? DOMINANT : RECESSIVE;
    return { eR, eD, noise: noiseFloor, total, carrier, ratio, level };
  }

  /** Guard-bin power over the edge window, used to track the noise floor. */
  _guard() {
    const end = this.n;
    const lo = goertzel(this.ring, this.mask, end, this.edgeSamples, this.coefLo, this.winEdge);
    const hi = goertzel(this.ring, this.mask, end, this.edgeSamples, this.coefHi, this.winEdge);
    return 0.5 * (lo + hi);
  }

  _edgeDetect() {
    if (this.n < this.edgeSamples) return;
    const m = this._measure(this.edgeSamples, this.winEdge, this.noiseEst);

    // Track the floor while the channel is quiet. The edge window is short
    // enough that a tone's main lobe reaches the guard bins, so updating during
    // a carrier would inflate the floor and desensitise the detector — unless
    // the "carrier" has been broadband for most of the last bit time, which no
    // transmission is: that is noise the estimate has fallen behind, most
    // often because the microphone delivered silence for a while (§4.4.1).
    // Transmissions look broadband too, but only for the few hops in which a
    // window straddles a tone switching on or off.
    const g = this._guard();
    const broadband = m.carrier && g * DETECTOR_DEFAULTS.toneToGuard >= m.total;
    this.broadband = m.carrier ? this.broadband + this.broadbandAlpha * ((broadband ? 1 : 0) - this.broadband) : 0;
    if (!m.carrier || (broadband && this.broadband > 0.5)) {
      // An estimate of exactly zero has only ever seen digital silence: seed
      // it from the first real reading rather than creeping up from nothing.
      this.noiseEst = this.noiseEst === 0 ? g : this.noiseEst + this.noiseAlpha * (g - this.noiseEst);
      if (!this.noisePrimed && this.n > 8 * this.edgeSamples) this.noisePrimed = true;
    }

    // Debounce: a single noisy hop must not be able to restart the bit clock.
    if (m.level === DOMINANT) this.edgeRun++; else this.edgeRun = 0;
    const level = this.edgeRun >= DETECTOR_DEFAULTS.edgeDebounceHops ? DOMINANT : RECESSIVE;

    if (level === DOMINANT && this.lastEdgeLevel !== DOMINANT) {
      // The window is trailing, so the true onset sits roughly half a window
      // back, plus the debounce delay. Every node applies the same correction,
      // so the bias cancels in the differential comparisons that matter
      // (rationale §4).
      const onset = this.n - (this.edgeSamples >> 1)
        - (DETECTOR_DEFAULTS.edgeDebounceHops - 1) * this.hopSamples;
      this._onDominantEdge(onset);
    }
    this.lastEdgeLevel = level;
  }

  _onDominantEdge(onset) {
    if (this.onEdge) this.onEdge({ onset, bit: this.bitCount });

    const proto = this.protocol;

    // Transmit hard synchronization — spec §5.4.
    if (proto.inTxSyncField && !this.txSyncApplied && proto.syncIndex === 0) {
      const delta = this.bitStart - onset;
      if (delta > 0 && delta < this.bitSamples / 2) {
        this.txSyncApplied = true;
        this.bitEndAt -= delta;
        this.samplePointAt = Math.max(this.n + 1, this.samplePointAt - delta);
        return;
      }
    }

    // Hard synchronization on the leading edge of SYNC bit 0 — spec §5.3.
    if (!proto.transmitting && proto.state === STATE.BUS_IDLE) {
      this.bitStart = onset;
      this.samplePointAt = onset + this.syncSamples + this.propSamples + this.ps1Samples;
      this.bitEndAt = onset + this.bitSamples;
      // This is a brand new bit 0: whatever was sampled for the free-running
      // bit we were in the middle of no longer applies.
      this.sampled = false;
      this.txSyncApplied = false;
      return;
    }

    // Resynchronization — spec §5.5.
    if (proto.transmitting) return;                 // never resync on our own edges
    const phaseError = onset - this.bitStart;
    if (phaseError <= this.syncSamples && phaseError >= 0) return;   // edge is in SYNC_SEG

    if (this.n < this.samplePointAt && phaseError > this.syncSamples) {
      const adj = Math.min(phaseError - this.syncSamples, this.sjwSamples);
      this.samplePointAt += adj;
      this.bitEndAt += adj;
    } else if (this.n >= this.samplePointAt) {
      const wanted = onset - this.syncSamples;          // where this bit should end
      const adj = Math.min(Math.max(this.bitEndAt - wanted, 0), this.sjwSamples);
      this.bitEndAt = Math.max(this.n + 1, this.bitEndAt - adj);
    }
  }

  _samplePoint() {
    const m = this._measure(this.winSamples, this.winMain, this.noiseEst * this.noiseScale);
    this.last = m;
    this.protocol.endBit(m.level, m.carrier);
    if (this.onBit) {
      this.onBit({
        index: this.bitCount,
        time: this.n / this.sampleRate,
        level: m.level,
        carrier: m.carrier,
        ratio: m.ratio,
        eR: m.eR, eD: m.eD, noise: m.noise,
        tx: this.txLevel,
        state: this.protocol.state,
      });
    }
  }

  _nextBit() {
    this.bitStart = this.bitEndAt;
    this.samplePointAt = this.bitStart + this.syncSamples + this.propSamples + this.ps1Samples;
    this.bitEndAt = this.bitStart + this.bitSamples;
    this.bitCount++;
    this.sampled = false;
    this._beginBit();
  }

  _beginBit() {
    if (this.protocol.state === STATE.BUS_IDLE) this.txSyncApplied = false;
    const level = this.protocol.beginBit();
    this._setTxLevel(level);
  }
}
