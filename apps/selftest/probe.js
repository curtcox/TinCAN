/**
 * Microphone check: what a test signal played on this device's speaker looks
 * like at its own microphone, and at another device's.
 *
 * Pure functions over sample arrays, with no DOM or Web Audio, so the test
 * suite can feed them synthetic recordings with known latency, level and
 * reverberation and check that they measure what they claim to.
 *
 * The signal, repeated twice, is a long dominant bit followed by a long
 * recessive one, which is the worst case for reverberation (§4.7):
 *
 *   0.05–0.45 s  silence      the noise floor
 *   0.50 s       50 ms chirp  2–6 kHz: a sharp correlation peak, for latency
 *   0.80–1.20 s  f_D tone     dominant, at the Console's level
 *   1.20–1.60 s  f_R tone     recessive, straight after it
 *   1.60–1.80 s  f_D tone     dominant again, then
 *   1.80–2.80 s  silence      its reverberant decay, as a transmitter hears it
 *                             in the ACK slot after its last dominant bit
 */

import { BANDS, PROFILES, DETECTOR_DEFAULTS, timing, nearFarMarginDb } from '../../src/tincan/params.js';

/** Peak output level: the Console's default transmit level. */
export const AMPLITUDE = 0.25;
export const TONE_HZ = BANDS.A.fD;
export const RECESSIVE_HZ = BANDS.A.fR;

export const SCHEDULE = {
  quiet: [0.05, 0.45],
  chirpAt: 0.5,
  chirpLen: 0.05,
  chirpHz: [2000, 6000],
  toneAt: 0.8,
  toneLen: 0.4,
  echoAt: 1.6,
  echoLen: 0.2,
  repeatEvery: 2.8,
  repeats: 2,
};

/** Seconds of signal, and how long to keep recording after it for latency. */
export const SIGNAL_SECONDS = SCHEDULE.repeatEvery * SCHEDULE.repeats;
export const RECORD_SECONDS = SIGNAL_SECONDS + 0.5;
/** Longest speaker-to-microphone latency searched for. */
const MAX_LATENCY = 0.4;

function chirp(fs) {
  const n = Math.round(SCHEDULE.chirpLen * fs);
  const [f0, f1] = SCHEDULE.chirpHz;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const phase = 2 * Math.PI * (f0 * t + ((f1 - f0) * t * t) / (2 * SCHEDULE.chirpLen));
    out[i] = (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)) * Math.sin(phase);
  }
  return out;
}

/** The test signal at sample rate `fs`, peak `AMPLITUDE`. */
export function buildProbeSignal(fs) {
  const out = new Float32Array(Math.round(SIGNAL_SECONDS * fs));
  const c = chirp(fs);
  const ramp = Math.round(0.001 * fs);         // the Phy's own switching time
  const toneN = Math.round(SCHEDULE.toneLen * fs);
  for (let r = 0; r < SCHEDULE.repeats; r++) {
    const base = r * SCHEDULE.repeatEvery;
    const c0 = Math.round((base + SCHEDULE.chirpAt) * fs);
    for (let i = 0; i < c.length; i++) out[c0 + i] = AMPLITUDE * c[i];
    const bursts = [
      [SCHEDULE.toneAt, toneN, TONE_HZ],
      [SCHEDULE.toneAt + SCHEDULE.toneLen, toneN, RECESSIVE_HZ],
      [SCHEDULE.echoAt, Math.round(SCHEDULE.echoLen * fs), TONE_HZ],
    ];
    for (const [at, n, f] of bursts) {
      const t0 = Math.round((base + at) * fs);
      for (let i = 0; i < n; i++) {
        const edge = Math.min(i, n - 1 - i);
        const g = edge < ramp ? 0.5 - 0.5 * Math.cos((Math.PI * (edge + 1)) / ramp) : 1;
        out[t0 + i] += AMPLITUDE * g * Math.sin((2 * Math.PI * f * i) / fs);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* measurement primitives                                              */
/* ------------------------------------------------------------------ */

const hannCache = new Map();
function hann(n) {
  if (!hannCache.has(n)) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    hannCache.set(n, w);
  }
  return hannCache.get(n);
}

/**
 * Amplitude of the `f` component in the `w`-sample Hann window ending at
 * sample `end`, scaled so a steady sine of amplitude A reads A. This is the
 * detector's own measurement (spec §4.4).
 */
export function toneAmplitude(x, end, w, f, fs) {
  const start = end - w;
  if (start < 0 || end > x.length) return 0;
  const win = hann(w);
  const coeff = 2 * Math.cos((2 * Math.PI * f) / fs);
  let s1 = 0, s2 = 0, sw = 0;
  for (let i = 0; i < w; i++) {
    const s0 = x[start + i] * win[i] + coeff * s1 - s2;
    s2 = s1; s1 = s0;
    sw += win[i];
  }
  const p = Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2);
  return (2 * Math.sqrt(p)) / sw;
}

/** RMS of the tone-bin reading over a stretch of noise, for one window length. */
function noiseAmplitude(x, from, to, w, fs) {
  let sum = 0, n = 0;
  const hop = Math.max(1, Math.round(0.002 * fs));
  for (let end = Math.round(from * fs) + w; end <= Math.round(to * fs); end += hop) {
    sum += toneAmplitude(x, end, w, TONE_HZ, fs) ** 2;
    n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

function median(a) {
  const s = [...a].sort((p, q) => p - q);
  return s.length ? s[s.length >> 1] : 0;
}

/**
 * Where the chirp sent at `sentAt` (seconds) arrives in `x`, searching up to
 * MAX_LATENCY later. Returns the delay in seconds and the normalised
 * correlation at the peak, or null when nothing chirp-like is there.
 */
export function findChirp(x, fs, sentAt, maxDelay = MAX_LATENCY) {
  const c = chirp(fs);
  let cc = 0;
  for (const v of c) cc += v * v;
  const s0 = Math.round(sentAt * fs);
  const lags = Math.round(maxDelay * fs);
  let best = -1, bestLag = 0;
  for (let lag = 0; lag < lags; lag++) {
    const o = s0 + lag;
    if (o < 0) continue;
    if (o + c.length > x.length) break;
    let dot = 0, xx = 0;
    for (let k = 0; k < c.length; k++) { const v = x[o + k]; dot += v * c[k]; xx += v * v; }
    const r = xx > 0 ? dot / Math.sqrt(xx * cc) : 0;
    if (r > best) { best = r; bestLag = lag; }
  }
  return best >= 0.3 ? { delay: bestLag / fs, correlation: best } : null;
}

/** The detection window W and the sample-point offset, in samples, for each profile. */
function profileTiming(fs) {
  return Object.keys(PROFILES).map((key) => {
    const t = timing(key);
    return {
      key,
      w: Math.max(8, Math.round(t.window * fs)),
      samplePoint: t.samplePoint,
      bitTime: t.bitTime,
      /** Latency beyond which a transmitter's own bit is still arriving when its window opens. */
      latencyLimit: (t.sync + t.prop) * t.tq,
    };
  });
}

/** Median reading of tone `f` over the last 0.25 s of a burst ending at `end`. */
function steadyLevel(x, fs, end, w, f) {
  const reads = [];
  const hop = Math.round(0.005 * fs);
  for (let e = Math.round((end - 0.25) * fs); e <= Math.round((end - 0.005) * fs); e += hop) {
    reads.push(toneAmplitude(x, e, w, f, fs));
  }
  return median(reads);
}

/**
 * Measure one repeat of the signal, whose chirp reached `x` at `chirpAt`
 * (seconds). `lag` is how late this device hears its own transitions, for
 * the reading a transmitter takes of its own bits; 0 for another device.
 */
function measureRepeat(x, fs, chirpAt, lag = 0) {
  const t0 = chirpAt - SCHEDULE.chirpAt;
  const end = t0 + SCHEDULE.toneAt + SCHEDULE.toneLen;     // dominant gives way to recessive
  const silent = t0 + SCHEDULE.echoAt + SCHEDULE.echoLen;  // the last dominant stops dead
  const quiet = [t0 + SCHEDULE.quiet[0], t0 + SCHEDULE.quiet[1]];
  const profiles = {};
  for (const p of profileTiming(fs)) {
    const at = (dt, f) => toneAmplitude(x, Math.round((end + dt) * fs), p.w, f, fs);
    // The detector's own decision for the recessive bit after a dominant one
    // (§4.4.2), read at the sample point: the dominant fraction of the energy.
    const ratioAt = (dt) => {
      const d = at(dt, TONE_HZ) ** 2;
      const r = at(dt, RECESSIVE_HZ) ** 2;
      return d + r > 0 ? d / (d + r) : 0;
    };
    profiles[p.key] = {
      steady: steadyLevel(x, fs, end, p.w, TONE_HZ),
      recessive: steadyLevel(x, fs, end + SCHEDULE.toneLen, p.w, RECESSIVE_HZ),
      noise: noiseAmplitude(x, quiet[0], quiet[1], p.w, fs),
      // What is left of the dominant bit at the next bit's sample point.
      tailNextBit: at(p.samplePoint, TONE_HZ),
      dominantFraction: ratioAt(p.samplePoint - lag),
      // What is left of a dominant bit, with nothing after it, at the sample
      // point of the second ACK bit: a transmitter reads that two bit times
      // after its last possible dominant bit (§6.7).
      tailAck: toneAmplitude(x, Math.round((silent + 2 * p.bitTime + p.samplePoint) * fs), p.w, TONE_HZ, fs),
    };
  }

  // RT60 from the slope of the decay, 12 ms windows every 5 ms, from 20 ms
  // after the last tone stops until the decay is within 10 dB of the noise.
  const w = Math.round(0.012 * fs);
  const floor = noiseAmplitude(x, quiet[0], quiet[1], w, fs);
  const pts = [];
  for (let dt = 0.02; dt < 0.8; dt += 0.005) {
    const a = toneAmplitude(x, Math.round((silent + dt) * fs), w, TONE_HZ, fs);
    if (a <= floor * 3.16) break;
    pts.push([dt, 20 * Math.log10(a)]);
  }
  let rt60 = null;
  if (pts.length >= 4) {
    const n = pts.length;
    const mx = pts.reduce((s, p) => s + p[0], 0) / n;
    const my = pts.reduce((s, p) => s + p[1], 0) / n;
    let sxy = 0, sxx = 0;
    for (const [px, py] of pts) { sxy += (px - mx) * (py - my); sxx += (px - mx) ** 2; }
    const slope = sxy / sxx;                        // dB per second, negative
    if (slope < 0) rt60 = 60 / -slope;
  }
  return { profiles, rt60, decayPoints: pts.length };
}

/* ------------------------------------------------------------------ */
/* the two measurements                                                */
/* ------------------------------------------------------------------ */

/**
 * Analyse a recording made while this device played `buildProbeSignal`,
 * starting in the same audio callback, so sample 0 of each is the same
 * instant. Returns null fields for anything it could not hear.
 */
export function analyseSelf(rec, fs) {
  const reps = [];
  for (let r = 0; r < SCHEDULE.repeats; r++) {
    const base = r * SCHEDULE.repeatEvery;
    const found = findChirp(rec, fs, base + SCHEDULE.chirpAt);
    if (!found) continue;
    const burst = measureRepeat(rec, fs, base + SCHEDULE.chirpAt + found.delay, found.delay);
    reps.push({ latency: found.delay, correlation: found.correlation, ...burst });
  }
  if (!reps.length) return { heard: false, repeats: 0 };
  return { heard: true, repeats: reps.length, ...combine(reps) };
}

/**
 * Analyse a recording made while *another* device played its probe signal at
 * some unknown moment. Finds its tone bursts by level, then aligns exactly on
 * the chirp that precedes each.
 */
export function analysePeer(rec, fs) {
  const w = Math.round(0.012 * fs);
  const hop = Math.round(0.005 * fs);
  const env = [];
  for (let e = w; e <= rec.length; e += hop) env.push(toneAmplitude(rec, e, w, TONE_HZ, fs));
  const sorted = [...env].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.2)] || 0;
  const threshold = Math.max(floor * 10, 1e-6);

  const reps = [];
  const minRun = Math.round((0.6 * SCHEDULE.toneLen * fs) / hop);
  // A tone fades in and out as it reverberates, so one burst can cross the
  // threshold more than once: once one is found, skip past all of it.
  const burstHops = Math.round((SCHEDULE.repeatEvery - SCHEDULE.toneAt - 0.2) * fs / hop);
  for (let i = 0; i < env.length; i++) {
    if (env[i] < threshold) continue;
    let j = i;
    while (j < env.length && env[j] >= threshold) j++;
    if (j - i < minRun) { i = j; continue; }

    // Only the chirp pins down when the burst really started. The run began
    // either at the tone or, when the chirp's sweep through f_D and its echo
    // were loud enough, at the chirp itself, 0.3 s earlier.
    const runStart = (i * hop) / fs;
    const chirpGuess = runStart - (SCHEDULE.toneAt - SCHEDULE.chirpAt) - 0.1;
    const found = findChirp(rec, fs, chirpGuess, 0.5);
    if (found) {
      const chirpAt = chirpGuess + found.delay;
      const t0 = chirpAt - SCHEDULE.chirpAt;
      if (t0 + SCHEDULE.quiet[0] >= 0 && t0 + SCHEDULE.echoAt + SCHEDULE.echoLen + 0.8 <= rec.length / fs) {
        reps.push({ at: chirpAt, ...measureRepeat(rec, fs, chirpAt) });
      }
    }
    i += burstHops;
  }
  if (!reps.length) return { heard: false, repeats: 0 };
  return { heard: true, repeats: reps.length, ...combine(reps) };
}

/** Median of each figure across repeats. */
function combine(reps) {
  const pick = (f) => median(reps.map(f).filter((v) => v !== null && v !== undefined));
  const out = { profiles: {} };
  if (reps[0].latency !== undefined) out.latency = pick((r) => r.latency);
  const rts = reps.map((r) => r.rt60).filter((v) => v !== null);
  out.rt60 = rts.length ? median(rts) : null;
  for (const key of Object.keys(reps[0].profiles)) {
    out.profiles[key] = {};
    for (const field of Object.keys(reps[0].profiles[key])) {
      out.profiles[key][field] = pick((r) => r.profiles[key][field]);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* verdicts                                                            */
/* ------------------------------------------------------------------ */

const db = (ratio) => 20 * Math.log10(ratio);

/**
 * What the measurements mean for each bit-timing profile. `peer` is optional:
 * without it the checks that need another device are reported as not run.
 *
 * Each check is { name, ok: true|false|null, detail }; null means unknown.
 */
export function assess(self, peer = null) {
  const general = [];
  general.push({
    name: 'hears itself',
    ok: !!self.heard,
    detail: self.heard
      ? `own tone at ${db(self.profiles.T25.steady).toFixed(0)} dBFS, `
        + `${Math.min(99, db(self.profiles.T25.steady / self.profiles.T25.noise)).toFixed(0)} dB above the noise`
      : 'the test signal never reached the microphone: speaker muted or too quiet, or echo cancellation removed it. A node that cannot hear itself cannot arbitrate or monitor its own bits.',
  });

  let selfGainDb = null;
  if (self.heard && peer && peer.heard) selfGainDb = db(self.profiles.T25.steady / peer.profiles.T25.steady);
  const margin = -nearFarMarginDb();
  general.push({
    name: 'own tone vs the other device',
    ok: selfGainDb === null ? null : selfGainDb <= margin,
    detail: selfGainDb === null
      ? 'needs the other device: listen here while it runs its own check'
      : `this device hears itself ${selfGainDb.toFixed(1)} dB louder than the other device. `
        + (selfGainDb <= margin
          ? `Within the ${margin.toFixed(1)} dB margin of §4.6, so arbitration and error flags work.`
          : `Past the ${margin.toFixed(1)} dB margin of §4.6: while it sends recessive it cannot hear the other device's dominant bits, so contention collides and errors the other device flags go unheard.`),
  });
  if (peer && peer.heard) {
    general.push({
      name: 'other device above the noise',
      ok: peer.profiles.T25.steady >= 4 * peer.profiles.T25.noise,
      detail: `${Math.min(99, db(peer.profiles.T25.steady / peer.profiles.T25.noise)).toFixed(0)} dB above the noise in the detector's band`,
    });
  }

  const profiles = profileTiming(48000).map(({ key, latencyLimit }) => {
    const checks = [];
    const s = self.heard ? self.profiles[key] : null;

    checks.push(self.heard ? {
      name: 'latency',
      ok: self.latency < latencyLimit,
      detail: `${(self.latency * 1000).toFixed(1)} ms speaker-to-microphone; ${key} allows ${(latencyLimit * 1000).toFixed(0)} ms`
        + (self.latency < latencyLimit ? '' : ' before a transmitter misreads its own bits'),
    } : { name: 'latency', ok: null, detail: 'not measured' });

    if (s) {
      const f = s.dominantFraction;
      checks.push({
        name: 'reads its own bits back',
        ok: f < DETECTOR_DEFAULTS.thetaD,
        detail: `sending recessive straight after dominant, it reads ${(f * 100).toFixed(0)} % dominant at its sample point; `
          + `${key} calls a bit dominant at ${(DETECTOR_DEFAULTS.thetaD * 100).toFixed(0)} %`
          + (f < DETECTOR_DEFAULTS.thetaD ? '' : ', so it would see a bit error in its own frame'),
      });

      // A floor 80 dB under its own tone: a silent input has no noise to
      // compare with, and an echo that far down is gone anyway.
      const ackRatio = s.tailAck / Math.max(s.noise, s.steady * 1e-4);
      const safe = ackRatio * ackRatio < DETECTOR_DEFAULTS.kappa;
      checks.push({
        name: 'own echo in the ACK slot',
        ok: safe,
        detail: safe
          ? 'its own tone has died away by the time it listens for acknowledgement'
          : `its own tone is still ${db(ackRatio).toFixed(0)} dB above the noise when it listens for acknowledgement, so it may count a frame delivered with nobody listening`,
      });
    }

    const p = peer && peer.heard ? peer.profiles[key] : null;
    if (p) {
      const f = p.dominantFraction;
      checks.push({
        name: 'other device\'s echo',
        ok: f < DETECTOR_DEFAULTS.thetaD,
        detail: `when the other device goes from dominant to recessive, this device reads ${(f * 100).toFixed(0)} % dominant at the next sample point; `
          + `${key} calls a bit dominant at ${(DETECTOR_DEFAULTS.thetaD * 100).toFixed(0)} %`
          + (f < DETECTOR_DEFAULTS.thetaD ? '' : ', so its frames arrive corrupted'),
      });
    } else {
      checks.push({ name: 'other device\'s echo', ok: null, detail: 'needs the other device' });
    }
    return { profile: key, checks };
  });

  return { general, profiles, rt60: self.rt60 ?? null, selfGainDb };
}
