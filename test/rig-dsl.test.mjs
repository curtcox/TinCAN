/**
 * Rig descriptions — spec/rig.md: what the DSL rejects, the limits, rendered
 * levels and frequencies checked by Goertzel, and the record summaries.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIMITS, validate, span, expand, render, summarize,
  latencyOf, noiseOf, goertzelAmplitude, renderFrame, chirpSignal,
} from '../src/tincan/rig-dsl.js';
import { buildTransmission } from '../src/tincan/frame.js';
import { timing } from '../src/tincan/params.js';

const ok = (desc) => {
  const v = validate(desc);
  assert.ok(v.ok, v.errors.join('; '));
  return v.desc;
};

test('validation rejects what is outside the DSL, and collects every problem', () => {
  const v = validate({ rig: 2, bogus: 1, actions: [
    { do: 'explode' },
    { do: 'tone', hz: 1000, t: -1, level: 0.9, extra: true },
  ] });
  assert.equal(v.ok, false);
  const text = v.errors.join('\n');
  for (const frag of ['rig', 'bogus', 'unknown action', 'extra', 't:', 'above the limit of 0.5']) {
    assert.ok(text.includes(frag), `expected an error naming ${frag}: ${text}`);
  }
  assert.ok(v.errors.length >= 6, 'several errors in one call');
});

test('validation rejects each bad shape', () => {
  const bad = (desc, frag) => {
    const v = validate(desc);
    assert.equal(v.ok, false, 'should fail');
    assert.ok(v.errors.join('\n').includes(frag), `${frag}: ${v.errors.join('; ')}`);
  };
  bad({ rig: 1, actions: [{ do: 'silence', seconds: 1 }], at: 'soon' }, 'at');
  bad({ rig: 1, actions: [] }, 'actions');
  bad({ rig: 1, actions: [{ do: 'tone', hz: 1000 }, { do: 'tone', hz: 1000, t: 119.6 }] }, 'limit of 120');
  bad({ rig: 1, actions: [{ do: 'frame', band: 'A', profile: 'T25', frame: { id: 1, data: 'DEADBEE' } }] }, 'data');
  bad({ rig: 1, actions: [{ do: 'frame', band: 'A', profile: 'T25', frame: { id: 1, data: [256] } }] }, 'data');
  bad({ rig: 1, actions: [{ do: 'frame', band: 'A', profile: 'T25', frame: { id: 1, data: '00' }, errors: { flip: [4000] } }] }, 'out of range');
  bad({ rig: 1, actions: [{ do: 'frame', band: 'G', profile: 'T25', frame: { id: 1, data: '00' } }] }, 'too fast for band G');
  bad({ rig: 1, actions: [{ do: 'node', op: 'join', band: 'A', profile: 'T25', address: 31 }] }, 'address');
  bad({ rig: 1, actions: Array.from({ length: 65 }, () => ({ do: 'silence', seconds: 0.01 })) }, 'the limit of 64');
  bad({ rig: 1, actions: [{ do: 'repeat', times: 2, every: 1, actions: [
    { do: 'repeat', times: 2, every: 1, actions: [
      { do: 'repeat', times: 2, every: 1, actions: [{ do: 'silence', seconds: 0.01 }] }] }] }] }, 'nest');
  bad({ rig: 1, actions: [{ do: 'record', seconds: 1, measure: 'noise' }] }, 'unknown key');
  bad({ rig: 1, actions: [{ do: 'repeat', times: 65, every: 1, actions: [{ do: 'silence', seconds: 0.01 }] }] }, 'times');
});

test('a valid description normalises with defaults filled', () => {
  const d = ok({ rig: 1, actions: [
    { do: 'tone', band: 'A', which: 'D' },
    { do: 'record', seconds: 1 },
    { do: 'frame', band: 'A', profile: 'T25', frame: { id: 1665, data: 'DEADBEEF' } },
  ] });
  assert.equal(d.actions[0].t, 0);
  assert.equal(d.actions[0].level, 0.25);
  assert.equal(d.actions[0].seconds, 0.5);
  assert.equal(d.actions[0].ramp, 0.01);
  assert.deepEqual(d.actions[1].return, ['levels']);
  assert.deepEqual(d.actions[2].frame.data, [0xDE, 0xAD, 0xBE, 0xEF], 'data stays JSON');
});

test('a tone renders at its level and frequency', () => {
  const fs = 16000;
  const d = ok({ rig: 1, actions: [{ do: 'tone', band: 'A', which: 'D', level: 0.2, seconds: 0.5 }] });
  const { signal, seconds } = render(d, fs);
  assert.equal(seconds, 0.5);
  const mid = goertzelAmplitude(signal, fs, 4250, Math.round(0.1 * fs), Math.round(0.3 * fs));
  assert.ok(Math.abs(mid - 0.2) < 0.004, `mid-tone amplitude ${mid}`);
  assert.ok(goertzelAmplitude(signal, fs, 3000, Math.round(0.1 * fs), Math.round(0.3 * fs)) < 0.002);
});

test('a chirp peaks at its level', () => {
  const fs = 16000;
  const a = { do: 'chirp', from: 2000, to: 5000, seconds: 0.05, level: 0.25 };
  const c = chirpSignal(a, fs);
  const peak = Math.max(...c.map(Math.abs));
  assert.ok(Math.abs(peak - 0.25) < 0.0025, `peak ${peak}`);
});

test('white and pink noise peak at level; pink favours the lows', () => {
  const fs = 16000;
  const d = ok({ rig: 1, actions: [
    { do: 'noise', color: 'white', seconds: 0.5, level: 0.1, seed: 3 },
    { do: 'record', seconds: 0.5, t: 0.6, return: ['spectrum'] },
  ] });
  const { signal } = render(d, fs);
  const peak = Math.max(...signal.map(Math.abs));
  assert.ok(Math.abs(peak - 0.1) < 1e-6, `white peak ${peak}`);

  const pink = ok({ rig: 1, actions: [{ do: 'noise', color: 'pink', seconds: 1, level: 0.1, seed: 3 }] });
  const rec = render(pink, fs).signal;
  assert.ok(Math.abs(Math.max(...rec.map(Math.abs)) - 0.1) < 1e-6, 'pink peak');
  const s = summarize({ do: 'record', seconds: 1, return: ['spectrum'], bins: 128 }, rec, fs).spectrum;
  const low = s.db.filter((_, i) => s.hz[i] < 500).reduce((a, b) => a + b, 0);
  const high = s.db.filter((_, i) => s.hz[i] > 2000).reduce((a, b) => a + b, 0);
  assert.ok(low > high, `pink below 500 Hz (${low.toFixed(0)}) vs above 2000 Hz (${high.toFixed(0)})`);
});

test('a frame renders bits·bitTime long and its edges recover the bits', () => {
  const fs = 48000;
  const a = ok({ rig: 1, actions: [
    { do: 'frame', band: 'A', profile: 'T100', frame: { id: 1665, data: '00' }, level: 0.3 },
  ] }).actions[0];
  const bits = buildTransmission(a.frame).bits;
  const sig = renderFrame(a, fs);
  const bitN = Math.round(timing('T100').bitTime * fs);
  assert.equal(sig.length, bits.length * bitN);

  // Summarize with the bit time as the edge window: the D/R sequence matches.
  const edges = summarize({ do: 'record', seconds: sig.length / fs, return: ['edges'], band: 'A', window: timing('T100').bitTime }, sig, fs).edges;
  const levels = edges.map((e) => e.level);
  assert.equal(levels[0], bits[0] ? 'R' : 'D');
  const changes = levels.filter((l) => l !== 'idle');
  const expected = [];
  for (const b of bits) if (expected[expected.length - 1] !== (b ? 'R' : 'D')) expected.push(b ? 'R' : 'D');
  assert.deepEqual(changes, expected);

  // Each hop classified per bit, aligned on bit times.
  for (let b = 0; b < bits.length; b++) {
    const t = b * timing('T100').bitTime;
    const e = edges.filter((x) => x.t <= t + 1e-9).at(-1);
    assert.equal(e.level, bits[b] ? 'R' : 'D', `bit ${b}`);
  }

  const cut = renderFrame({ ...a, errors: { cut: 10 } }, fs);
  assert.equal(cut.length, 10 * bitN);
  const flip = renderFrame({ ...a, errors: { flip: [0, 1] } }, fs);
  let diff = 0;
  for (let b = 0; b < bits.length; b++) {
    let same = true;
    for (let i = Math.round(bitN / 4); i < Math.round(bitN / 2); i++) {
      if (Math.abs(flip[b * bitN + i] - sig[b * bitN + i]) > 0.01) same = false;
    }
    if (!same) diff++;
  }
  assert.equal(diff, 2, 'exactly the flipped bits differ');
});

test('repeat yields one burst per repetition', () => {
  const fs = 16000;
  const d = ok({ rig: 1, actions: [
    { do: 'repeat', times: 3, every: 0.4, actions: [{ do: 'tone', hz: 1000, seconds: 0.1, level: 0.2 }] },
    { do: 'record', seconds: 1.2, return: ['levels'], window: 0.05 },
  ] });
  assert.ok(Math.abs(span(d) - 1.2) < 1e-9);
  const { signal } = render(d, fs);
  const { levels } = summarize(d.actions[1], signal, fs);
  const peaks = levels.series.filter((s) => s.rms > 0.05);
  assert.ok(peaks.length >= 3);
  // Three bursts near t = 0, 0.4, 0.8.
  const starts = peaks.filter((s, i) => i === 0 || peaks[i - 1].t < s.t - 0.1);
  assert.equal(starts.length, 3);
  assert.ok(Math.abs(starts[1].t - 0.4) < 0.05);
});

test('measure latency expands to a chirp plus a record; latencyOf finds the delay', () => {
  const fs = 48000;
  const d = ok({ rig: 1, actions: [{ do: 'measure', what: 'latency', t: 0.1 }] });
  const e = expand(d);
  assert.deepEqual(e.actions.map((a) => a.do), ['chirp', 'record']);
  assert.equal(e.actions[0].measure, 'latency');
  assert.equal(e.actions[1].index, 0);
  assert.equal(e.actions[1].seconds, 1.0);

  const chirp = chirpSignal(e.actions[0], fs);
  const rec = new Float32Array(fs);
  const delay = Math.round(0.037 * fs);
  rec.set(chirp.map((v) => v * 0.6), delay);
  const m = latencyOf(rec, fs, chirp);
  assert.ok(Math.abs(m.ms - 37) < 1, `latency ${m.ms} ms`);
  assert.ok(m.peak > 0.9);
});

test('noiseOf reads a quiet recording', () => {
  const fs = 16000;
  const d = ok({ rig: 1, actions: [{ do: 'noise', color: 'white', seconds: 1, level: 0.01, seed: 9 }] });
  const { signal } = render(d, fs);
  const n = noiseOf(signal, fs);
  assert.ok(Math.abs(n.dbfs + 45) < 3, `dbfs ${n.dbfs}`);
  assert.ok(n.bands.A.length === 2 && n.bands.G.length === 2);
});

test('render throws above 0.46·fs, and cap clips', () => {
  const fs = 16000;
  const high = ok({ rig: 1, actions: [{ do: 'tone', hz: 8000 }] });
  assert.throws(() => render(high, fs), /0\.46/);
  const d = ok({ rig: 1, actions: [{ do: 'tone', hz: 1000, level: 0.4 }] });
  const r = render(d, fs, { cap: 0.2 });
  assert.equal(r.clipped, true);
  assert.ok(Math.abs(Math.max(...r.signal.map(Math.abs)) - 0.2) < 0.01);
  assert.equal(render(d, fs).clipped, false);
});

test('summaries have their documented shapes', () => {
  const fs = 16000;
  const d = ok({ rig: 1, actions: [{ do: 'tone', band: 'A', which: 'R', t: 0.2, seconds: 0.2, level: 0.2 }] });
  const rec = new Float32Array(Math.round(0.6 * fs));
  rec.set(render(d, fs).signal.subarray(0, rec.length));
  const s = summarize(
    { do: 'record', seconds: 0.6, return: ['wav', 'levels', 'goertzel', 'spectrum', 'edges'], hz: [2000, 3000], bins: 64 },
    rec, fs);
  assert.equal(s.wav.samples, rec.length);
  assert.ok(Math.abs(s.levels.peak - 0.2) < 0.01);
  assert.equal(s.levels.series.length, 6);
  assert.equal(s.goertzel.length, 2);
  // The tone fills the middle third of the record, where the Hann window weighs most.
  assert.ok(s.goertzel[1].amplitude > 0.05 && s.goertzel[1].amplitude < 0.15,
    `3000 Hz reads ${s.goertzel[1].amplitude}`);
  assert.ok(Math.abs(Math.max(...s.goertzel[1].series) - 0.2) < 0.02, 'per-window amplitude');
  assert.ok(s.goertzel[0].amplitude < 0.01);
  assert.equal(s.spectrum.hz.length, 64);
  const peakBin = s.spectrum.db.indexOf(Math.max(...s.spectrum.db));
  assert.ok(Math.abs(s.spectrum.hz[peakBin] - 3000) < 150, `spectrum peaks at ${s.spectrum.hz[peakBin]} Hz`);
  assert.deepEqual(s.edges.map((e) => e.level), ['idle', 'R', 'idle']);
});
