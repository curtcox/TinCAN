/** The Bands page's frequency-range sweep, against a speaker and microphone of known response. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { sweepFrequencies, sweepPlan, sweepSignal, analyseSweep } from '../apps/bands/sweep.js';
import { mulberry32 } from '../src/tincan/bus.js';

test('the sweep finds the band a speaker and microphone carry, wherever the sound arrives', () => {
  const fs = 48000;
  const freqs = sweepFrequencies(fs);
  assert.equal(freqs[0], 40);
  assert.ok(freqs.at(-1) <= 23500 && freqs.at(-1) > 23000, 'up to just below the Nyquist limit');
  const plan = sweepPlan(fs);
  assert.deepEqual(plan.tones.map((t) => t.f).sort((a, b) => a - b), freqs, 'every frequency once');
  for (let i = 1; i < plan.tones.length; i++) {
    const r = plan.tones[i].f / plan.tones[i - 1].f;
    assert.ok(r > 4 || r < 1 / 4, 'consecutive tones far apart');
  }
  assert.ok(plan.seconds < 20, 'under twenty seconds');

  // Carries 120 Hz – 19 kHz; 25 dB down from 90 Hz and to 20.5 kHz; −80 dB beyond.
  const gain = (f) => (f >= 120 && f <= 19000 ? 1 : f >= 90 && f <= 20500 ? 10 ** (-25 / 20) : 1e-4);
  const played = sweepSignal(fs, plan, gain);
  const delay = Math.round(0.047 * fs);
  const rnd = mulberry32(5);
  const rec = new Float32Array(played.length);
  for (let i = 0; i < rec.length; i++) rec[i] = 0.5 * (i >= delay ? played[i - delay] : 0) + 0.06 * (rnd() - 0.5);   // about 45 dB below the tones in an 80 ms reading

  const r = analyseSweep(rec, fs, plan);
  assert.ok(Math.abs(r.latency - 0.047) < 0.001, `latency ${r.latency}`);
  const first = (lo) => freqs.find((f) => f >= lo);
  const last = (hi) => freqs.filter((f) => f <= hi).at(-1);
  assert.deepEqual(r.carries, { low: first(120), high: last(19000) });
  assert.deepEqual(r.usable, { low: first(90), high: last(20500) });
  const at1k = r.points.find((p) => p.f === 1000);
  assert.ok(Math.abs(at1k.gainDb - 20 * Math.log10(0.5)) < 0.5, `gain at 1 kHz ${at1k.gainDb}`);

  assert.throws(() => analyseSweep(new Float32Array(rec.length), fs, plan), /did not hear/);
});
