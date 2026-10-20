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
import { wirelessMicReason } from '../../src/tincan/modem.js';

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

/**
 * Longest speaker-to-microphone latency searched for. Far beyond anything a
 * profile allows, so that a wireless microphone gets a figure rather than
 * "not heard".
 */
export const MAX_LATENCY = 1.0;
/** Seconds of signal, and how long to keep recording after it for latency. */
export const SIGNAL_SECONDS = SCHEDULE.repeatEvery * SCHEDULE.repeats;
export const RECORD_SECONDS = SIGNAL_SECONDS + MAX_LATENCY;

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
 * `maxDelay` later. Returns the delay in seconds and the normalised
 * correlation at the peak, or null when nothing chirp-like is there.
 */
export function findChirp(x, fs, sentAt, maxDelay = MAX_LATENCY) {
  const best = bestChirp(x, fs, sentAt, maxDelay);
  return best.correlation >= 0.3 ? best : null;
}

/** The best match to the chirp, however weak. */
function bestChirp(x, fs, sentAt, maxDelay) {
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
  return { delay: bestLag / fs, correlation: Math.max(0, best) };
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
  let bestMatch = { delay: 0, correlation: 0 };
  for (let r = 0; r < SCHEDULE.repeats; r++) {
    const base = r * SCHEDULE.repeatEvery;
    const best = bestChirp(rec, fs, base + SCHEDULE.chirpAt, MAX_LATENCY);
    if (best.correlation > bestMatch.correlation) bestMatch = best;
    if (best.correlation < 0.3) continue;
    const burst = measureRepeat(rec, fs, base + SCHEDULE.chirpAt + best.delay, best.delay);
    reps.push({ latency: best.delay, correlation: best.correlation, ...burst });
  }
  const input = inputStats(rec, fs);
  if (!reps.length) return { heard: false, repeats: 0, ...whyUnheard(rec, fs, input), bestMatch, input };
  return { heard: true, repeats: reps.length, ...combine(reps), bestMatch, input };
}

const dbfs = (a) => (a > 0 ? Math.round(20 * Math.log10(a) * 10) / 10 : -Infinity);

/**
 * How loud the recording is: peak and RMS overall in dBFS, and the RMS of
 * each tenth of a second, so a report shows whether anything arrived and when.
 * A level of -Infinity (null in JSON) is digital silence.
 */
export function inputStats(rec, fs) {
  let peak = 0, sum = 0;
  for (const v of rec) { const a = Math.abs(v); if (a > peak) peak = a; sum += v * v; }
  const step = Math.round(0.1 * fs);
  const envelope = [];
  for (let i = 0; i < rec.length; i += step) {
    let e = 0;
    const end = Math.min(rec.length, i + step);
    for (let k = i; k < end; k++) e += rec[k] * rec[k];
    envelope.push(dbfs(Math.sqrt(e / (end - i))));
  }
  return { peakDb: dbfs(peak), rmsDb: dbfs(Math.sqrt(sum / (rec.length || 1))), envelopeDb: envelope, envelopeStep: 0.1 };
}

/** Below this peak the microphone delivered nothing: no real microphone is this quiet. */
const SILENT_DB = -90;

/**
 * Why the chirp was not found, as one of:
 *   silent     the microphone delivered (near) digital silence
 *   late       the test tone arrived, later than MAX_LATENCY
 *   unmatched  the test tone arrived in time, but the chirp did not match
 *   quiet      there is sound, but not the test tone
 * with `toneDelay`, the delay of the first tone burst, when one was heard.
 */
function whyUnheard(rec, fs, input) {
  if (!(input.peakDb > SILENT_DB)) return { why: 'silent' };
  const w = Math.round(0.012 * fs);
  const hop = Math.round(0.005 * fs);
  const env = [];
  for (let e = w; e <= rec.length; e += hop) env.push(toneAmplitude(rec, e, w, TONE_HZ, fs));
  const sorted = [...env].sort((a, b) => a - b);
  const threshold = Math.max((sorted[Math.floor(sorted.length * 0.2)] || 0) * 10, 1e-6);
  const minRun = Math.round((0.6 * SCHEDULE.toneLen * fs) / hop);
  for (let i = 0; i < env.length; i++) {
    if (env[i] < threshold) continue;
    let j = i;
    while (j < env.length && env[j] >= threshold) j++;
    if (j - i >= minRun) {
      // The run starts at the f_D tone, give or take the window.
      const toneDelay = (i * hop + w) / fs - SCHEDULE.toneAt;
      return { why: toneDelay > MAX_LATENCY ? 'late' : 'unmatched', toneDelay };
    }
    i = j;
  }
  return { why: 'quiet' };
}

/**
 * A mono recording as a 16-bit PCM WAV file, to open in an audio editor or
 * send with a report.
 */
export function encodeWav(samples, fs) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const text = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, fs, true); v.setUint32(28, fs * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  text(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const c = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, Math.round(c * 32767), true);
  }
  return buf;
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
  const input = inputStats(rec, fs);
  if (!reps.length) return { heard: false, repeats: 0, input };
  return { heard: true, repeats: reps.length, ...combine(reps), input };
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

/** Why this device did not hear its own test signal, in words. */
function unheard(self) {
  const level = self.input ? `${Number.isFinite(self.input.peakDb) ? self.input.peakDb.toFixed(0) : '−∞'} dBFS peak` : '';
  const late = self.toneDelay !== undefined ? `${(self.toneDelay * 1000).toFixed(0)} ms` : '';
  switch (self.why) {
    case 'silent':
      return 'the microphone delivered silence: nothing at all reached the page. A phone used as a microphone may be '
        + 'locked, asleep or out of range; otherwise the system may be blocking this browser from the microphone.';
    case 'late':
      return `the test tones arrived about ${late} late, longer than the ${MAX_LATENCY * 1000} ms this check searches. `
        + 'Only a wireless or heavily processed microphone is that slow.';
    case 'unmatched':
      return `the test tones arrived, about ${late} late, but the chirp that times them was not recognised `
        + `(best match ${((self.bestMatch?.correlation || 0) * 100).toFixed(0)} %): the speaker or microphone may be `
        + 'distorting it, or something else in the room was loud at the time.';
    case 'quiet':
      return `the microphone hears sound (${level}) but not the test signal: the speaker is muted, turned down or `
        + 'playing somewhere else (headphones, a display, AirPlay), the microphone is too far from it, or echo '
        + 'cancellation removed it.';
    default:
      return 'the test signal never reached the microphone: speaker muted or too quiet, or echo cancellation removed it.';
  }
}

/**
 * What the measurements mean for each bit-timing profile. `peer` is optional:
 * without it the checks that need another device are reported as not run.
 * `microphone` is the capture device's label, when known, and `builtIn` the
 * built-in microphone's label: null when the computer lists none.
 *
 * Each check is { name, ok: true|false|null, detail }; null means unknown.
 */
export function assess(self, peer = null, { microphone = '', builtIn } = {}) {
  const general = [];
  // What to use instead of a microphone that will not do. `builtIn` is the
  // built-in microphone's label, null when none is listed, undefined if unknown.
  const instead = builtIn === null
    ? 'This computer lists no built-in microphone (a Mac mini, Mac Studio or desktop PC usually has none): '
      + 'use a wired one, USB or a headset in the audio jack, next to the speaker, and measure again.'
    : `Use ${builtIn ? `"${builtIn}"` : 'the computer\'s built-in microphone'} and measure again.`;
  const wireless = wirelessMicReason(microphone);
  if (wireless) {
    general.push({
      name: 'microphone',
      ok: false,
      detail: `"${microphone}" looks like ${wireless}. Wireless microphones hear 100–200 ms late and are `
        + `seldom next to this computer's speaker. ${instead}`,
    });
  }
  general.push({
    name: 'hears itself',
    ok: !!self.heard,
    detail: self.heard
      ? `own tone at ${db(self.profiles.T25.steady).toFixed(0)} dBFS, `
        + `${Math.min(99, db(self.profiles.T25.steady / self.profiles.T25.noise)).toFixed(0)} dB above the noise`
      : `${unheard(self)} A node that cannot hear itself cannot arbitrate or monitor its own bits.`,
  });

  if (self.heard) {
    const limits = profileTiming(48000).map((p) => [p.key, p.latencyLimit]);
    const [slowest, most] = limits.reduce((a, b) => (b[1] > a[1] ? b : a));
    const ms = self.latency * 1000;
    general.push({
      name: 'latency',
      ok: self.latency < most,
      detail: self.latency < most
        ? `${ms.toFixed(1)} ms from speaker to microphone; see each profile below for whether that is short enough`
        : `${ms.toFixed(1)} ms from speaker to microphone, longer than any profile allows (${slowest}, the most `
          + `tolerant, allows ${(most * 1000).toFixed(0)} ms), so no setting will work. Delays this long `
          + `usually mean a wireless microphone — an iPhone through Continuity, AirPods, a Bluetooth headset — `
          + `or heavy audio processing. ${instead}`,
    });
  }

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
