/**
 * The band comparison page's figures, checked against the standards they
 * come from.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  phon, splForPhon, hearingThreshold, aWeighting, airAbsorption, shannon,
} from '../apps/bands/acoustics.js';

const near = (actual, expected, tol, what) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} not within ${tol} of ${expected}`);

test('ISO 226: 1 kHz defines the phon, and the contours and their inverse agree', () => {
  for (const L of [20, 40, 60, 80]) near(splForPhon(1000, L), L, 0.1, `${L} phon at 1 kHz`);
  // Points on the 40-phon contour, as J. Tackett's widely used ISO 226
  // implementation computes them.
  for (const [f, spl] of [[20, 99.85], [100, 64.37], [4000, 36.65], [12500, 51.49]]) {
    near(splForPhon(f, 40), spl, 0.01, `40 phon at ${f} Hz`);
  }
  for (const f of [125, 1000, 3000, 4250, 7250, 12500]) {
    near(phon(f, splForPhon(f, 60)), 60, 0.05, `round trip at ${f} Hz`);
  }
  assert.equal(hearingThreshold(4000), -5.4);
  assert.equal(hearingThreshold(17250), null, 'the standard stops at 12.5 kHz');
  assert.equal(phon(18500, 60), null);
});

test('IEC 61672 A-weighting at its tabulated frequencies', () => {
  near(aWeighting(1000), 0, 0.05, '1 kHz');
  near(aWeighting(100), -19.1, 0.1, '100 Hz');
  near(aWeighting(4000), 1.0, 0.1, '4 kHz');
  near(aWeighting(10000), -2.5, 0.1, '10 kHz');
  near(aWeighting(20000), -9.3, 0.1, '20 kHz');
});

test('ISO 9613-1 air absorption reproduces the 10 °C, 70 % table of ISO 9613-2', () => {
  const at = (f) => airAbsorption(f, { celsius: 10, rh: 70 }) * 1000;     // dB/km
  near(at(1000), 3.7, 0.2, '1 kHz');
  near(at(2000), 9.7, 0.3, '2 kHz');
  near(at(4000), 32.8, 1, '4 kHz');
  near(at(8000), 117, 3, '8 kHz');
});

test('Shannon capacity', () => {
  near(shannon(1000, 0), 1000, 1e-9, '0 dB');
  near(shannon(2250, 30), 22427, 1, 'a band\'s slot at 30 dB');
});
