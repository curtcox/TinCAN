/**
 * TinCAN 1.0 — band plans, bit-timing profiles and detector defaults.
 * Normative source: spec/tincan-1.0.md §4.2, §5.2, §4.4.
 *
 * This module is pure data plus derivation helpers. It must stay free of any
 * DOM or Web Audio reference so that it can be imported inside an
 * AudioWorkletGlobalScope.
 */

/** Band plans — spec §4.2. Frequencies in Hz. */
export const BANDS = {
  A: { id: 0x01, name: 'A — audible',         fR: 3000,  fD: 4250,  guardLo: 2500,  guardHi: 4750,
       note: 'Default. Works on every speaker and microphone. Audible.' },
  B: { id: 0x02, name: 'B — near-ultrasonic', fR: 17250, fD: 18500, guardLo: 16750, guardHi: 19000,
       note: 'Needs >=44.1 kHz and usable response above 17 kHz. Short range.' },
  C: { id: 0x03, name: 'C — low',             fR: 1000,  fD: 2250,  guardLo: 500,   guardHi: 2750,
       note: 'For small transducers. Most exposed to ambient noise.' },
  D: { id: 0x04, name: 'D — line',            fR: 6000,  fD: 7250,  guardLo: 5500,  guardHi: 7750,
       note: 'For a physical audio cable or loopback. Not intended for air.' },
};

/**
 * Bit-timing profiles — spec §5.2. Segment lengths are in time quanta.
 * `slopMs` is the assumed t_slop used for the published range figure; it is
 * not used by the engine, which measures what it can instead.
 */
export const PROFILES = {
  T100: { id: 0x10, name: 'T100 — bench', tqMs: 1, sync: 1, prop: 3,  ps1: 4, ps2: 2, sjw: 1, slopMs: 1 },
  T50:  { id: 0x11, name: 'T50 — desk',   tqMs: 2, sync: 1, prop: 4,  ps1: 3, ps2: 2, sjw: 1, slopMs: 3 },
  T25:  { id: 0x12, name: 'T25 — room',   tqMs: 2, sync: 1, prop: 10, ps1: 6, ps2: 3, sjw: 2, slopMs: 3 },
  T10:  { id: 0x13, name: 'T10 — hall',   tqMs: 5, sync: 1, prop: 10, ps1: 6, ps2: 3, sjw: 2, slopMs: 5 },
  // For devices whose own speaker-to-microphone path is slow: a MacBook Pro's
  // built-in speaker and microphone measured 58–63 ms in Chrome. PROP_SEG must
  // cover both ends' latency (spec §5.6), so 140 ms of a 200 ms bit.
  T5:   { id: 0x14, name: 'T5 — slow',    tqMs: 10, sync: 1, prop: 14, ps1: 3, ps2: 2, sjw: 2, slopMs: 60 },
  // The same split stretched for distance with the same slow audio path:
  // PROP_SEG grows, the 30–60 ms detection window stays.
  T4:   { id: 0x15, name: 'T4 — far',     tqMs: 10, sync: 1, prop: 19, ps1: 3, ps2: 2, sjw: 2, slopMs: 60 },
  T2:   { id: 0x16, name: 'T2 — farther', tqMs: 20, sync: 1, prop: 19, ps1: 3, ps2: 2, sjw: 2, slopMs: 60 },
};

export const DEFAULT_BAND = 'A';
export const DEFAULT_PROFILE = 'T25';

/** Speed of sound, m/s, dry air at 20 °C. */
export const SPEED_OF_SOUND = 343;

/** Detector defaults — spec §4.4. */
export const DETECTOR_DEFAULTS = {
  /** Carrier-sense margin above the noise floor, linear power ratio. */
  kappa: 8.0,
  /** Fraction of in-band energy at f_D required to declare dominant. */
  thetaD: 0.12,
  /** Edge-detector window, in time quanta (spec §5.5 discussion). */
  edgeWindowTq: 2,
  /** Detector hops per time quantum. Sets edge-timing resolution. */
  hopsPerTq: 4,
  /**
   * Time constant of the noise-floor estimator, in bit times. The estimator
   * is frozen while a transmission is present (spec §4.4.1).
   */
  noiseTauBits: 4,
  /**
   * A carrier must put more than this many times the guard-bin power into the
   * two tone bins. Below it the energy is broadband, so it is noise, and the
   * noise floor keeps tracking it (spec §4.4.1). White noise sits near 2; a
   * tone, even in the 2 ms edge window of T100, stays above 7.
   */
  toneToGuard: 4,
  /** Consecutive dominant hops required before an edge is declared. */
  edgeDebounceHops: 2,
};

/** Derived timing for a profile. All times in seconds unless noted. */
export function timing(profile) {
  const p = typeof profile === 'string' ? PROFILES[profile] : profile;
  if (!p) throw new Error(`unknown bit-timing profile: ${profile}`);
  const tq = p.tqMs / 1000;
  const totalTq = p.sync + p.prop + p.ps1 + p.ps2;
  return {
    ...p,
    tq,
    totalTq,
    bitTime: totalTq * tq,
    bitRate: 1 / (totalTq * tq),
    /** Offset of the sample point from the bit boundary, seconds. */
    samplePoint: (p.sync + p.prop + p.ps1) * tq,
    samplePointFraction: (p.sync + p.prop + p.ps1) / totalTq,
    /** Main detection window length, seconds (spec §4.4: W = PHASE_SEG1). */
    window: p.ps1 * tq,
    edgeWindow: DETECTOR_DEFAULTS.edgeWindowTq * tq,
  };
}

/**
 * Max segment radius in metres for a profile — spec §5.6. `slopMs` is t_slop,
 * taken to be the same at every node: PROP_SEG covers it twice, once for the
 * node whose edge the other synchronized to and once for the node answering.
 */
export function maxRange(profile, slopMs) {
  const p = typeof profile === 'string' ? PROFILES[profile] : profile;
  const slop = slopMs === undefined ? p.slopMs : slopMs;
  const propMs = p.prop * p.tqMs;
  return Math.max(0, ((propMs - 2 * slop) / 1000) * SPEED_OF_SOUND / 2);
}

/**
 * The profile with the longest arbitration range at its assumed t_slop: the
 * apps' default, since it works between the most devices, however slow.
 */
export function longestRangeProfile() {
  return Object.keys(PROFILES).reduce((best, key) => (maxRange(key) > maxRange(best) ? key : best));
}

/**
 * The fastest profile that can still arbitrate on a device whose t_slop is
 * `slopMs` (spec §5.6), or null if none can.
 */
export function fastestProfileFor(slopMs) {
  return Object.keys(PROFILES).find((key) => maxRange(key, slopMs) > 0) ?? null;
}

/**
 * Near-far margin in dB — spec §4.6. The dominant transmitter may arrive this
 * much weaker than the summed recessive transmitters and still win.
 */
export function nearFarMarginDb(thetaD = DETECTOR_DEFAULTS.thetaD) {
  const powerRatio = thetaD / (1 - thetaD);
  return 10 * Math.log10(powerRatio);
}

export function bandOf(name) {
  const b = BANDS[name];
  if (!b) throw new Error(`unknown band: ${name}`);
  return b;
}
