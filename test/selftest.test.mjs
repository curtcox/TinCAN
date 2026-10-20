/**
 * The self-test page's microphone check, fed synthetic recordings whose
 * latency, level and reverberation are known, so that what it tells a user
 * about their device can be trusted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProbeSignal, analyseSelf, analysePeer, assess, encodeWav, inputStats, AMPLITUDE, RECORD_SECONDS, SCHEDULE,
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
function record({ src = signal, at = 0, seconds = RECORD_SECONDS, latencyMs = 0, gain = 1, rt60 = 0, reverbLevel = 0, noise = 0.0005, seed = 1 }) {
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
    for (let i = 0; i < src.length; i++) {
      const k = i + shift + d;
      if (k >= out.length) break;
      out[k] += a * src[i];
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
  // 12 ms at each of two devices is 24 ms before distance: past T25's 22 ms.
  assert.equal(verdict(a, 'T25', 'latency').ok, false);
  assert.equal(verdict(a, 'T10', 'latency').ok, true);
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

test('a wireless microphone is called out even when its delay fits the slowest profile', () => {
  // The figures from a real report: a Mac recording through an iPhone 16 over
  // Continuity heard itself 169 ms late. Only T2 can absorb that.
  const self = analyseSelf(record({ latencyMs: 168.7, gain: 0.01 }), FS);
  assert.ok(Math.abs(self.latency * 1000 - 168.7) < 0.5, `latency ${self.latency * 1000} ms`);

  const a = assess(self, null, { microphone: '2024 iPhone 16 Microphone' });
  assert.match(general(a, 'latency').detail, /T2 is the fastest profile that allows it/);
  assert.equal(general(a, 'microphone').ok, false);
  assert.match(general(a, 'microphone').detail, /iPhone 16/);
  for (const p of a.profiles) {
    assert.equal(p.checks.find((c) => c.name === 'latency').ok, p.profile === 'T2', p.profile);
  }
});

test('a delay no profile can absorb is called out, with the usual cause', () => {
  // A Bluetooth headset's microphone: a quarter of a second.
  const self = analyseSelf(record({ latencyMs: 250, gain: 0.01 }), FS);
  const a = assess(self, null, { microphone: 'AirPods Pro' });
  assert.equal(general(a, 'latency').ok, false);
  assert.match(general(a, 'latency').detail, /longer than any profile allows \(T2.*197 ms\)/);
  assert.match(general(a, 'latency').detail, /built-in microphone/);
  for (const p of a.profiles) assert.equal(p.checks.find((c) => c.name === 'latency').ok, false, p.profile);
});

test('a built-in microphone with a short delay raises neither warning', () => {
  const a = assess(analyseSelf(record({ latencyMs: 12, gain: 0.5 }), FS), null, { microphone: 'MacBook Pro Microphone' });
  assert.equal(general(a, 'latency').ok, true);
  assert.equal(general(a, 'microphone'), undefined);
});

test('a microphone that delivers nothing is told apart from one that hears no test signal', () => {
  const silent = analyseSelf(record({ gain: 0, noise: 0 }), FS);
  assert.equal(silent.heard, false);
  assert.equal(silent.why, 'silent');
  assert.equal(silent.input.peakDb, -Infinity);
  assert.match(general(assess(silent), 'hears itself').detail, /delivered silence.*locked, asleep or out of range/);

  const quiet = analyseSelf(record({ gain: 0 }), FS);
  assert.equal(quiet.why, 'quiet');
  assert.ok(quiet.input.peakDb > -70 && quiet.input.peakDb < -60, `noise peak ${quiet.input.peakDb} dBFS`);
  assert.match(general(assess(quiet), 'hears itself').detail, /hears sound \(-6\d dBFS peak\) but not the test signal/);
});

test('a wireless microphone\'s long delay is still measured, up to a second', () => {
  const self = analyseSelf(record({ latencyMs: 620, gain: 0.05 }), FS);
  assert.ok(self.heard);
  assert.equal(self.repeats, 2);
  assert.ok(Math.abs(self.latency * 1000 - 620) < 0.5, `latency ${self.latency * 1000} ms`);
  assert.equal(general(assess(self), 'latency').ok, false);
});

test('a delay past the search is reported as late, with an estimate, not as unheard', () => {
  const self = analyseSelf(record({ latencyMs: 1300, gain: 0.05 }), FS);
  assert.equal(self.heard, false);
  assert.equal(self.why, 'late');
  assert.ok(Math.abs(self.toneDelay - 1.3) < 0.03, `tone delay ${self.toneDelay} s`);
  assert.match(general(assess(self), 'hears itself').detail, /arrived about 1\d{3} ms late, longer than the 1000 ms/);
});

test('tones that arrive without a recognisable chirp are reported as such', () => {
  const src = Float32Array.from(signal);
  for (let r = 0; r < SCHEDULE.repeats; r++) {
    const c0 = Math.round((r * SCHEDULE.repeatEvery + SCHEDULE.chirpAt) * FS);
    src.fill(0, c0, c0 + Math.round(SCHEDULE.chirpLen * FS));
  }
  const self = analyseSelf(record({ src, latencyMs: 40, gain: 0.3 }), FS);
  assert.equal(self.heard, false);
  assert.equal(self.why, 'unmatched');
  assert.ok(Math.abs(self.toneDelay - 0.04) < 0.03, `tone delay ${self.toneDelay} s`);
  assert.ok(self.bestMatch.correlation < 0.3);
  assert.match(general(assess(self), 'hears itself').detail, /chirp that times them was not recognised/);
});

test('a heard recording reports its level over time and the strength of its match', () => {
  const self = analyseSelf(record({ latencyMs: 12, gain: 0.5 }), FS);
  assert.equal(self.input.envelopeDb.length, Math.ceil(RECORD_SECONDS * 10));
  assert.ok(self.input.peakDb > -20 && self.input.peakDb < -16, `peak ${self.input.peakDb} dBFS`);
  assert.ok(self.bestMatch.correlation > 0.9);
  // The level rises while the tones play and falls back in the gaps.
  assert.ok(self.input.envelopeDb[10] > self.input.envelopeDb[3] + 30);
  assert.deepEqual(inputStats(new Float32Array(0), FS).envelopeDb, []);
});

test('the advice names the built-in microphone, or a wired one when there is none', () => {
  const self = analyseSelf(record({ latencyMs: 250, gain: 0.01 }), FS);
  const mic = '2024 iPhone 16 Microphone';
  const named = assess(self, null, { microphone: mic, builtIn: 'MacBook Pro Microphone' });
  assert.match(general(named, 'microphone').detail, /Use "MacBook Pro Microphone" and measure again/);
  assert.match(general(named, 'latency').detail, /Use "MacBook Pro Microphone"/);

  const none = assess(self, null, { microphone: mic, builtIn: null });
  for (const name of ['microphone', 'latency']) {
    assert.match(general(none, name).detail, /lists no built-in microphone.*use a wired one/);
    assert.doesNotMatch(general(none, name).detail, /Use the computer's built-in/);
  }
});

test('a recording downloads as a 16-bit mono WAV file', () => {
  const wav = new DataView(encodeWav(Float32Array.from([0, 0.5, -1, 2]), FS));
  const text = (at, n) => String.fromCharCode(...Array.from({ length: n }, (_, i) => wav.getUint8(at + i)));
  assert.equal(text(0, 4), 'RIFF');
  assert.equal(text(8, 4), 'WAVE');
  assert.equal(wav.getUint16(22, true), 1, 'mono');
  assert.equal(wav.getUint32(24, true), FS);
  assert.equal(wav.getUint16(34, true), 16);
  assert.equal(wav.getUint32(40, true), 8);
  assert.deepEqual([0, 1, 2, 3].map((i) => wav.getInt16(44 + 2 * i, true)), [0, 16384, -32767, 32767]);
});
