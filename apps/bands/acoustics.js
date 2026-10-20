/**
 * Standard psychoacoustic and propagation figures for comparing bands: pure
 * functions, so the test suite checks them against the standards' own values.
 *
 *   ISO 226:2003  normal equal-loudness-level contours, 20 Hz – 12.5 kHz
 *   IEC 61672-1   the A-weighting curve
 *   ISO 9613-1    absorption of sound by the atmosphere
 */

/* ------------------------------------------------------------------ */
/* ISO 226:2003                                                        */
/* ------------------------------------------------------------------ */

// Table 1 of ISO 226:2003, as tabulated in PyDSM (pydsm.iso226).
const F = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400,
  500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300,
  8000, 10000, 12500];
const ALPHA = [0.532, 0.506, 0.480, 0.455, 0.432, 0.409, 0.387, 0.367, 0.349, 0.330,
  0.315, 0.301, 0.288, 0.276, 0.267, 0.259, 0.253, 0.250, 0.246, 0.244,
  0.243, 0.243, 0.243, 0.242, 0.242, 0.245, 0.254, 0.271, 0.301];
const LU = [-31.6, -27.2, -23.0, -19.1, -15.9, -13.0, -10.3, -8.1, -6.2, -4.5,
  -3.1, -2.0, -1.1, -0.4, 0.0, 0.3, 0.5, 0.0, -2.7, -4.1, -1.0, 1.7,
  2.5, 1.2, -2.1, -7.1, -11.2, -10.7, -3.1];
const TF = [78.5, 68.7, 59.5, 51.1, 44.0, 37.5, 31.5, 26.5, 22.1, 17.9, 14.4,
  11.4, 8.6, 6.2, 4.4, 3.0, 2.2, 2.4, 3.5, 1.7, -1.3, -4.2, -6.0, -5.4,
  -1.5, 6.0, 12.6, 13.9, 12.3];

/** The highest frequency ISO 226 covers. */
export const ISO226_MAX_HZ = 12500;

/**
 * The ISO 226 parameters at `f`, interpolated linearly in log frequency
 * between the third-octave points the standard tabulates; null above 12.5 kHz.
 */
function iso226Params(f) {
  if (f < F[0] || f > ISO226_MAX_HZ) return null;
  let i = F.findIndex((x) => x >= f);
  if (F[i] === f) return { alpha: ALPHA[i], lu: LU[i], tf: TF[i] };
  i -= 1;
  const w = Math.log(f / F[i]) / Math.log(F[i + 1] / F[i]);
  const lerp = (a) => a[i] + w * (a[i + 1] - a[i]);
  return { alpha: lerp(ALPHA), lu: lerp(LU), tf: lerp(TF) };
}

/** Threshold of hearing, dB SPL, for otologically normal 18–25 year olds; null above 12.5 kHz. */
export function hearingThreshold(f) {
  return iso226Params(f)?.tf ?? null;
}

/** Loudness level in phon of a pure tone of `f` Hz at `spl` dB SPL (ISO 226 §4.2); null above 12.5 kHz. */
export function phon(f, spl) {
  const p = iso226Params(f);
  if (!p) return null;
  const b = (0.4 * 10 ** ((spl + p.lu) / 10 - 9)) ** p.alpha
    - (0.4 * 10 ** ((p.tf + p.lu) / 10 - 9)) ** p.alpha
    + 0.005135;
  return b > 0 ? 40 * Math.log10(b) + 94 : -Infinity;
}

/** The SPL, dB, of a tone of `f` Hz at loudness level `phons` (ISO 226 §4.1); null above 12.5 kHz. */
export function splForPhon(f, phons) {
  const p = iso226Params(f);
  if (!p) return null;
  const a = 4.47e-3 * (10 ** (0.025 * phons) - 1.15) + (0.4 * 10 ** ((p.tf + p.lu) / 10 - 9)) ** p.alpha;
  return (10 / p.alpha) * Math.log10(a) - p.lu + 94;
}

/* ------------------------------------------------------------------ */
/* IEC 61672-1 A-weighting                                             */
/* ------------------------------------------------------------------ */

/** A-weighting, dB, at `f` Hz: how a sound level meter discounts it. */
export function aWeighting(f) {
  const f2 = f * f;
  const ra = (12194 ** 2 * f2 * f2)
    / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  return 20 * Math.log10(ra) + 2.0;
}

/* ------------------------------------------------------------------ */
/* ISO 9613-1 atmospheric absorption                                   */
/* ------------------------------------------------------------------ */

/**
 * Pure-tone atmospheric absorption, dB per metre, at `f` Hz, `celsius`,
 * relative humidity `rh` percent and `kpa` kilopascals.
 */
export function airAbsorption(f, { celsius = 20, rh = 50, kpa = 101.325 } = {}) {
  const T = celsius + 273.15;
  const T0 = 293.15;
  const T01 = 273.16;
  const pr = kpa / 101.325;
  const C = -6.8346 * (T01 / T) ** 1.261 + 4.6151;
  const h = rh * 10 ** C / pr;
  const frO = pr * (24 + 4.04e4 * h * (0.02 + h) / (0.391 + h));
  const frN = pr * (T / T0) ** -0.5 * (9 + 280 * h * Math.exp(-4.170 * ((T / T0) ** (-1 / 3) - 1)));
  const f2 = f * f;
  return 8.686 * f2 * (1.84e-11 / pr * (T / T0) ** 0.5
    + (T / T0) ** -2.5 * (0.01275 * Math.exp(-2239.1 / T) / (frO + f2 / frO)
      + 0.1068 * Math.exp(-3352.0 / T) / (frN + f2 / frN)));
}

/* ------------------------------------------------------------------ */
/* capacity                                                            */
/* ------------------------------------------------------------------ */

/** Shannon capacity, bit/s, of a channel `hz` wide at signal-to-noise ratio `snrDb`. */
export function shannon(hz, snrDb) {
  return hz * Math.log2(1 + 10 ** (snrDb / 10));
}
