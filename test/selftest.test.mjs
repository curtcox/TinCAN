/**
 * The self-test page's microphone check, fed synthetic recordings whose
 * latency, level and reverberation are known, so that what it tells a user
 * about their device can be trusted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProbeSignal, analyseSelf, analysePeer, assess, AMPLITUDE, RECORD_SECONDS,
} from '../apps/selftest/probe.js';
import { mulberry32 } from '../src/tincan/bus.js';

const FS = 48000;
const signal = buildProbeSignal(FS);

/**
 * What a microphone records of `signal` played `at` seconds into a recording
 * of `seconds`: the direct sound at `gain` after `latencyMs`, a reverberant
 * tail with `reverbLevel` times the energy of a unit-gain direct sound and the
 * given RT60, and white noise.
 */
function record({ at = 0, seconds = RECORD_SECONDS, latencyMs = 0, gain = 1, rt60 = 0, reverbLevel = 0, noise = 0.0005, seed = 1 }) {
  const rnd = mulberry32(seed);
  const out = new Float32Array(Math.round(seconds * FS));
  const taps = [[0, gain]];
  if (rt60 > 0) {
    const first = Math.round(0.005 * FS);
    const span = Math.round(rt60 * FS) - first;
    const tail = [];
    let energy = 0;
    for (let k = 0; k < 400; k++) {
      const d = first + Math.floor(rnd() * span);
      const a = (rnd() < 0.5 ? -1 : 1) * Math.pow(10, (-3 * d) / FS / rt60);
      tail.push([d, a]);
      energy += a * a;
    }
    const scale = Math.sqrt(reverbLevel / energy);
    for (const [d, a] of tail) taps.push([d, a * scale]);
  }
  const shift = Math.round((at + latencyMs / 1000) * FS);
  for (const [d, a] of taps) {
    for (let i = 0; i < signal.length; i++) {
      const k = i + shift + d;
      if (k >= out.length) break;
      out[k] += a * signal[i];
    }
  }
  for (let i = 0; i < out.length; i++) out[i] += noise * (rnd() * 2 - 1);
  return out;
}

const verdict = (a, profile, name) => a.profiles.find((p) => p.profile === profile).checks.find((c) => c.name === name);
const general = (a, name) => a.general.find((c) => c.name === name);

test('the self check measures latency and level, and judges latency against each profile', () => {
  const self = analyseSelf(record({ latencyMs: 23.4, gain: 0.6 }), FS);

  assert.ok(self.heard);
  assert.equal(self.repeats, 2);
  assert.ok(Math.abs(self.latency * 1000 - 23.4) < 0.1, `latency ${self.latency * 1000} ms`);
  const level = self.profiles.T25.steady / (0.6 * AMPLITUDE);
  assert.ok(Math.abs(20 * Math.log10(level)) < 0.5, `level off by ${20 * Math.log10(level)} dB`);

  const a = assess(self);
  assert.equal(general(a, 'hears itself').ok, true);
  // T25 lets a transmitter's own bit arrive up to (SYNC + PROP) = 22 ms late.
  assert.equal(verdict(a, 'T25', 'latency').ok, false);
  assert.equal(verdict(a, 'T10', 'latency').ok, true);
  assert.equal(verdict(a, 'T50', 'latency').ok, false);
  for (const profile of ['T100', 'T50', 'T25', 'T10']) {
    assert.equal(verdict(a, profile, 'own echo in the ACK slot').ok, true, `${profile}: no room, no echo`);
  }
  assert.equal(general(a, 'own tone vs the other device').ok, null, 'not judged without the other device');
});

test('the self check measures a room\'s decay and flags an echo that can fake an acknowledgement', () => {
  const self = analyseSelf(record({ latencyMs: 12, gain: 1, rt60: 0.5, reverbLevel: 0.3, seed: 3 }), FS);

  assert.ok(self.heard);
  assert.ok(Math.abs(self.latency * 1000 - 12) < 0.5, `latency ${self.latency * 1000} ms`);
  assert.ok(self.rt60 > 0.35 && self.rt60 < 0.65, `RT60 ${self.rt60} s`);

  const a = assess(self);
  assert.equal(verdict(a, 'T25', 'latency').ok, true);
  assert.equal(verdict(a, 'T25', 'own echo in the ACK slot').ok, false,
    'half a second of reverberation is still well above the noise 114 ms after a bit');
});

test('a perfectly silent input does not make a vanished echo look like a live one', () => {
  const a = assess(analyseSelf(record({ latencyMs: 5, gain: 0.5, noise: 0 }), FS));
  assert.equal(verdict(a, 'T25', 'own echo in the ACK slot').ok, true);
  assert.match(general(a, 'hears itself').detail, /99 dB above the noise/);
});

test('a device that never hears its own signal is told so', () => {
  const self = analyseSelf(record({ gain: 0 }), FS);
  assert.equal(self.heard, false);
  const a = assess(self);
  assert.equal(general(a, 'hears itself').ok, false);
  assert.match(general(a, 'hears itself').detail, /echo cancellation/);
  assert.equal(verdict(a, 'T25', 'latency').ok, null);
});

test('listening to another device finds its signal at an unknown time and compares levels', () => {
  const self = analyseSelf(record({ latencyMs: 15, gain: 1 }), FS);
  // The other device started its check 3.137 s into a 10 s listen, a metre
  // or so away: a tenth of the level this device hears itself at.
  const peer = analysePeer(record({ at: 3.137, seconds: 10, gain: 0.1, seed: 5 }), FS);

  assert.ok(peer.heard);
  assert.equal(peer.repeats, 2);
  const gainDb = 20 * Math.log10(self.profiles.T25.steady / peer.profiles.T25.steady);
  assert.ok(Math.abs(gainDb - 20) < 0.5, `self-gain ${gainDb} dB`);

  const a = assess(self, peer);
  assert.ok(Math.abs(a.selfGainDb - 20) < 0.5);
  assert.equal(general(a, 'own tone vs the other device').ok, false, '20 dB is far past the 8.6 dB margin');
  assert.equal(general(a, 'other device above the noise').ok, true);
  assert.equal(verdict(a, 'T25', 'other device\'s echo').ok, true, 'no room, no echo');
});

test('the other device\'s echo is judged by the detector\'s own dominant fraction', () => {
  const self = analyseSelf(record({ latencyMs: 15, gain: 2 }), FS);
  // An office a metre away: RT60 0.4 s, reverberant energy equal to the
  // direct sound. Whether a given spot fails depends on where the two tones
  // fade; at this one the dominant tail outlasts a T25 bit but not a T10 one.
  const peer = analysePeer(record({ at: 1.5, seconds: 8, gain: 0.25, rt60: 0.4, reverbLevel: 0.0625, seed: 2 }), FS);

  assert.ok(peer.heard);
  assert.ok(peer.rt60 > 0.3 && peer.rt60 < 0.55, `RT60 ${peer.rt60} s`);
  const a = assess(self, peer);
  assert.equal(verdict(a, 'T25', 'other device\'s echo').ok, false, `T25: ${verdict(a, 'T25', 'other device\'s echo').detail}`);
  assert.equal(verdict(a, 'T10', 'other device\'s echo').ok, true, `T10: ${verdict(a, 'T10', 'other device\'s echo').detail}`);
  assert.equal(general(a, 'own tone vs the other device').ok, false);
});

test('a transmitter whose own bits come back late is told it will misread them', () => {
  const a = assess(analyseSelf(record({ latencyMs: 30, gain: 1 }), FS));
  assert.equal(verdict(a, 'T25', 'reads its own bits back').ok, false, 'a 30 ms echo is still in the T25 window');
  assert.equal(verdict(a, 'T10', 'reads its own bits back').ok, true);
});

test('two devices close together in a dead room pass every check', () => {
  const self = analyseSelf(record({ latencyMs: 8, gain: 0.5 }), FS);
  const peer = analysePeer(record({ at: 2.2, seconds: 8, gain: 0.3, rt60: 0.15, reverbLevel: 0.001, seed: 11 }), FS);
  const a = assess(self, peer);

  for (const c of a.general) assert.equal(c.ok, true, `${c.name}: ${c.detail}`);
  for (const c of a.profiles.find((p) => p.profile === 'T25').checks) assert.equal(c.ok, true, `T25 ${c.name}: ${c.detail}`);
});
