/**
 * Finds the frequencies a device's own speaker and microphone carry: plays a
 * chirp, to find the latency, then one short tone at each of about a hundred
 * frequencies from 40 Hz to near the Nyquist limit, and reads each where it
 * arrives, against the room's noise at that frequency.
 *
 * Pure functions, so the test suite can feed them a synthetic recording.
 */

import { AMPLITUDE, MAX_LATENCY, chirp, findChirp, toneAmplitude } from '../selftest/probe.js';

export const SWEEP = {
  quiet: 0.6,       // seconds of silence first, for the noise
  chirpAt: 0.6,     // the latency chirp
  firstTone: 0.8,
  tone: 0.11,       // each tone
  gap: 0.04,        // between tones
  edge: 0.015,      // left out of each tone's reading at either end
};

/** Above this many dB over the room's noise a frequency carries well; above the other, short range. */
export const CARRIES_DB = 30;
export const USABLE_DB = 15;

/**
 * The frequencies: twelfths of an octave below 1 kHz, where speakers give
 * out; thirds of an octave up to 14 kHz, where they rarely do; 250 Hz steps
 * above, up to just below the Nyquist limit.
 */
export function sweepFrequencies(fs) {
  const out = [];
  for (let k = 0; 40 * 2 ** (k / 12) < 1000; k++) out.push(Math.round(40 * 2 ** (k / 12)));
  for (let k = 0; 1000 * 2 ** (k / 3) < 14000; k++) out.push(Math.round(1000 * 2 ** (k / 3)));
  for (let f = 14000; f <= Math.min(23500, 0.49 * fs); f += 250) out.push(f);
  return out;
}

/**
 * When each frequency plays. Consecutive tones are about half the range
 * apart, so a tone's echo does not fall in its successor's reading.
 */
export function sweepPlan(fs) {
  const freqs = sweepFrequencies(fs);
  const half = Math.ceil(freqs.length / 2);
  const order = [];
  for (let i = 0; i < half; i++) {
    order.push(freqs[i]);
    if (i + half < freqs.length) order.push(freqs[i + half]);
  }
  const step = SWEEP.tone + SWEEP.gap;
  const tones = order.map((f, i) => ({ f, at: SWEEP.firstTone + i * step }));
  return { tones, seconds: SWEEP.firstTone + tones.length * step + MAX_LATENCY + 0.1 };
}

/**
 * The signal to play. `gain(f)`, for tests, scales each tone as a speaker and
 * microphone would.
 */
export function sweepSignal(fs, plan, gain = () => 1) {
  const x = new Float32Array(Math.round(plan.seconds * fs));
  const c = chirp(fs);
  const c0 = Math.round(SWEEP.chirpAt * fs);
  for (let i = 0; i < c.length; i++) x[c0 + i] = AMPLITUDE * c[i];
  const n = Math.round(SWEEP.tone * fs);
  const ramp = Math.round(0.005 * fs);
  for (const { f, at } of plan.tones) {
    const s = Math.round(at * fs);
    const a = AMPLITUDE * gain(f);
    for (let i = 0; i < n; i++) {
      const e = Math.min(i, n - 1 - i);
      const g = e < ramp ? 0.5 - 0.5 * Math.cos((Math.PI * (e + 1)) / ramp) : 1;
      x[s + i] = a * g * Math.sin((2 * Math.PI * f * i) / fs);
    }
  }
  return x;
}

/**
 * Each frequency's level where it arrived and its height above the room's
 * noise, and the range around the strongest that carries well and that is
 * usable. Throws if the chirp was not heard, since then nothing else can be
 * placed.
 */
export function analyseSweep(rec, fs, plan) {
  const found = findChirp(rec, fs, SWEEP.chirpAt);
  if (!found) throw new Error('the microphone did not hear the speaker');
  const latency = found.delay;
  const w = Math.round((SWEEP.tone - 2 * SWEEP.edge) * fs);
  const hop = Math.round(0.01 * fs);
  const points = plan.tones.map(({ f, at }) => {
    const level = toneAmplitude(rec, Math.round((at + latency + SWEEP.tone - SWEEP.edge) * fs), w, f, fs);
    let sum = 0, n = 0;
    for (let end = Math.round(0.05 * fs) + w; end <= Math.round((SWEEP.quiet - 0.02) * fs); end += hop) {
      sum += toneAmplitude(rec, end, w, f, fs) ** 2;
      n++;
    }
    const noise = Math.sqrt(sum / Math.max(1, n));
    const db = (v) => 20 * Math.log10(Math.max(v, 1e-9));
    return { f, gainDb: db(level / AMPLITUDE), snrDb: db(level) - db(noise) };
  }).sort((a, b) => a.f - b.f);

  // Outward from the strongest frequency, as far as each threshold holds unbroken.
  const peak = points.reduce((best, p, i) => (p.snrDb > points[best].snrDb ? i : best), 0);
  const range = (min) => {
    if (points[peak].snrDb < min) return null;
    let lo = peak, hi = peak;
    while (lo > 0 && points[lo - 1].snrDb >= min) lo--;
    while (hi < points.length - 1 && points[hi + 1].snrDb >= min) hi++;
    return { low: points[lo].f, high: points[hi].f };
  };
  return { latency, points, carries: range(CARRIES_DB), usable: range(USABLE_DB) };
}
