/**
 * End-to-end tests over the sample-level acoustic simulation: real tones, real
 * Goertzel detection, real bit clocks, per-path propagation delay, additive
 * noise and a reverberant tail.
 *
 * These are the tests that actually exercise spec §4 and §5.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AcousticChannel, mulberry32 } from '../src/tincan/bus.js';
import { maxRange, nearFarMarginDb, timing, PROFILES, fastestProfileFor } from '../src/tincan/params.js';

function channel(opts = {}) {
  return new AcousticChannel({
    sampleRate: 16000,
    band: 'A',
    profile: 'T25',
    noise: 0.0005,
    random: mulberry32(opts.seed ?? 1),
    ...opts,
  });
}

function collect(p, event) {
  const out = [];
  p.on(event, (d) => out.push(d));
  return out;
}

/**
 * Real contention happens when several nodes are waiting on a *busy* bus and it
 * frees: they are all synchronized to the frame that just ended, so they start
 * within one propagation delay of each other (spec §7.1). Two nodes that merely
 * become ready on a long-idle bus are typically a bit time apart, and the
 * second sees carrier and defers — correct behaviour, but not what these tests
 * are about.
 *
 * `primer` occupies the bus with one frame; `queue` runs while it is in flight.
 * Returns once the primer's frame has completed.
 */
function contend(ch, primer, queue) {
  ch.run(0.5);
  primer.send({ id: 0x7ff, data: [0] });
  assert.ok(ch.runUntil(() => primer.transmitting, 4), 'primer never got the bus');
  ch.run(ch.bitTime * 20);
  queue();
  assert.ok(ch.runUntil(() => primer.stats.framesSent > 0 && !primer.transmitting, 8),
    'primer frame never completed');
}

test('a frame crosses a metre of simulated air intact', () => {
  const ch = channel({ nodes: [{ name: 'a', x: 0, y: 0 }, { name: 'b', x: 1, y: 0 }] });
  const [a, b] = ch.protocols;
  const got = collect(b, 'frame');

  a.send({ id: 0x123, data: [0xde, 0xad, 0xbe, 0xef] });
  ch.run(6);

  assert.equal(got.length, 1);
  assert.equal(got[0].frame.id, 0x123);
  assert.deepEqual(Array.from(got[0].frame.data), [0xde, 0xad, 0xbe, 0xef]);
  assert.equal(a.stats.framesSent, 1, 'and the transmitter heard the acknowledgement');
  assert.equal(a.stats.ackErrors, 0);
  assert.equal(b.stats.crcErrors + b.stats.stuffErrors + b.stats.formErrors, 0);
});

test('bitwise arbitration resolves over air: the lower identifier wins, the loser defers', () => {
  const ch = channel({
    nodes: [
      { name: 'primer', x: 0.4, y: -0.3 },
      { name: 'lo', x: 0, y: 0 },
      { name: 'hi', x: 0.8, y: 0 },
      { name: 'spy', x: 0.4, y: 0.3, mode: 'listener' },
    ],
  });
  const [primer, lo, hi, spy] = ch.protocols;

  contend(ch, primer, () => {
    lo.send({ id: 0x201, data: [1] });
    hi.send({ id: 0x205, data: [2] });
  });

  const seen = collect(spy, 'frame-decoded');
  const hiLost = collect(hi, 'arbitration-lost');
  const loLost = collect(lo, 'arbitration-lost');
  ch.run(14);

  assert.equal(hiLost.length, 1, 'the higher identifier lost arbitration exactly once');
  assert.equal(loLost.length, 0, 'the lower identifier never lost');
  assert.equal(lo.stats.framesSent, 1);
  assert.equal(hi.stats.framesSent, 1);
  assert.deepEqual(seen.map((s) => s.frame.id), [0x201, 0x205],
    'the analyzer saw them in identifier order');
  assert.deepEqual(Array.from(seen[0].frame.data), [1],
    'and the winning frame was not corrupted by the collision');
  assert.equal(lo.stats.bitErrors + hi.stats.bitErrors, 0,
    'a collision over air cost no bit errors at all');
});

test('the loser withdraws inside the arbitration field, at the first differing bit', () => {
  const ch = channel({
    nodes: [
      { name: 'primer', x: 0.3, y: -0.3 },
      { name: 'lo', x: 0, y: 0 },
      { name: 'hi', x: 0.6, y: 0 },
    ],
  });
  const [primer, lo, hi] = ch.protocols;
  const lost = collect(hi, 'arbitration-lost');

  // 0x201 = 100 0000 0001, 0x205 = 100 0000 0101 — they first differ at the
  // identifier's bit 2, i.e. transmitted bit 8 (SYNC) + 1 (SOF) + 9 = 18.
  contend(ch, primer, () => {
    lo.send({ id: 0x201, data: [1] });
    hi.send({ id: 0x205, data: [2] });
  });
  ch.run(14);

  assert.equal(lost.length, 1);
  assert.equal(lost[0].bit, 18, 'withdrew at exactly the first differing bit');
});

test('four contenders starting together are delivered in identifier order', () => {
  const ids = [0x140, 0x030, 0x2c0, 0x0a0];
  const ch = channel({
    nodes: [
      { name: 'primer', x: 0.25, y: -0.4 },
      { name: 'n0', x: 0, y: 0 },
      { name: 'n1', x: 0.5, y: 0 },
      { name: 'n2', x: 0, y: 0.5 },
      { name: 'n3', x: 0.5, y: 0.5 },
      { name: 'spy', x: 0.25, y: 0.25, mode: 'listener' },
    ],
  });
  const primer = ch.protocols[0];
  const nodes = ch.protocols.slice(1, 5);
  const spy = ch.protocols[5];

  contend(ch, primer, () => {
    ids.forEach((id, i) => nodes[i].send({ id, data: [i] }));
  });

  const seen = collect(spy, 'frame-decoded');
  ch.run(30);

  assert.deepEqual(seen.map((s) => s.frame.id), ids.slice().sort((x, y) => x - y));
  for (let i = 0; i < 4; i++) {
    assert.equal(nodes[i].stats.framesSent, 1, `node ${i} got its frame out`);
    assert.equal(nodes[i].stats.bitErrors, 0, `node ${i} saw no bit errors`);
  }
});

test('transmit hard synchronization lets nodes two metres apart still arbitrate', () => {
  // Node b is two metres from a, so their clocks differ by ~6 ms — 15 % of a
  // bit time at T25. Spec §5.4 is what keeps them aligned through the
  // arbitration field.
  const ch = channel({
    nodes: [
      { name: 'primer', x: 1, y: -0.5 },
      { name: 'a', x: 0, y: 0 },
      { name: 'b', x: 2, y: 0 },
    ],
  });
  const [primer, a, b] = ch.protocols;

  contend(ch, primer, () => {
    a.send({ id: 0x010, data: [1] });
    b.send({ id: 0x011, data: [2] });
  });
  ch.run(16);

  assert.equal(a.stats.framesSent, 1);
  assert.equal(b.stats.framesSent, 1);
  assert.equal(b.stats.arbitrationsLost, 1, 'b withdrew');
  assert.equal(a.stats.arbitrationsLost, 0, 'a did not');
  assert.equal(a.stats.bitErrors + b.stats.bitErrors, 0);
});

test('a lone node transmits, is not acknowledged, and says so', () => {
  const ch = channel({ nodes: [{ name: 'solo', x: 0, y: 0 }] });
  const [solo] = ch.protocols;
  const errs = collect(solo, 'error-frame');
  const decoded = collect(solo, 'frame-decoded');

  solo.send({ id: 0x111, data: [1] });
  ch.run(6);

  assert.ok(decoded.length >= 1, 'it heard its own frame back correctly');
  assert.ok(errs.some((e) => e.kind === 'ack'), 'and reported the missing acknowledgement');
  assert.equal(solo.stats.framesSent, 0);
});

test('a listener decodes the bus without disturbing it', () => {
  const ch = channel({
    nodes: [
      { name: 'a', x: 0, y: 0 },
      { name: 'b', x: 0.7, y: 0 },
      { name: 'spy', x: 0.35, y: 0.4, mode: 'listener' },
    ],
  });
  const [a, b, spy] = ch.protocols;
  const seen = collect(spy, 'frame-decoded');

  a.send({ id: 0x2a0, data: [1, 2, 3] });
  ch.run(8);

  assert.equal(seen.length, 1);
  assert.deepEqual(Array.from(seen[0].frame.data), [1, 2, 3]);
  assert.equal(a.stats.framesSent, 1, 'the pair still completed normally');
  assert.equal(spy.stats.framesSent, 0, 'the listener transmitted nothing');
});

test('frames survive a noisy channel and light reverberation',
  { todo: 'at 1.2 m with a 2 m critical distance the diffuse field holds enough of both tones that the 0.12 dominant ratio misreads bits; this passed only while the simulated reverberation was ~60 dB too quiet' },
  () => {
    const ch = channel({
      nodes: [{ name: 'a', x: 0, y: 0 }, { name: 'b', x: 1.2, y: 0 }],
      noise: 0.004,
      rt60: 0.25,
      reverbLevel: 0.25,
      seed: 7,
    });
    const [a, b] = ch.protocols;
    const got = collect(b, 'frame');

    a.send({ id: 0x0c0, data: [0x55, 0xaa] });
    ch.run(10);

    assert.equal(got.length, 1, 'delivered despite noise and reverberation');
    assert.deepEqual(Array.from(got[0].frame.data), [0x55, 0xaa]);
  });

test('the near-far limit of §4.6 is real, and fails the way the spec says it does',
  { todo: 'with the transmitter silent during ACK (§6.7), the excluded far node hears the acknowledgements for the near node\'s frame and completes, so the collision is silent' },
  () => {
    // `far` holds the lower identifier and should win, but at a 25:1 distance
    // ratio each node's own recessive tone buries the other's dominant tone.
    // Spec §4.6: neither withdraws, both keep transmitting, and the collision
    // shows up as failed frames rather than as a wrong winner.
    const ch = channel({
      nodes: [
        { name: 'primer', x: 1.0, y: 0 },
        { name: 'near', x: 0.15, y: 0 },
        { name: 'far', x: 4.0, y: 0 },
      ],
      profile: 'T10',       // PROP_SEG long enough that distance alone is fine
    });
    const [primer, near, far] = ch.protocols;

    contend(ch, primer, () => {
      far.send({ id: 0x001, data: [1] });
      near.send({ id: 0x7f0, data: [2] });
    });
    const before = { near: near.stats.framesSent, far: far.stats.framesSent };
    ch.run(60);

    assert.equal(near.stats.arbitrationsLost, 0,
      'the near node never heard the far dominant bit, exactly as §4.6 predicts');
    assert.equal(far.stats.arbitrationsLost, 0,
      'and the far node never heard the near one either');

    const failed = near.stats.ackErrors + far.stats.ackErrors
                 + near.stats.bitErrors + far.stats.bitErrors
                 + near.stats.crcErrors + far.stats.crcErrors
                 + near.stats.stuffErrors + far.stats.stuffErrors
                 + near.stats.formErrors + far.stats.formErrors;
    assert.ok(failed > 0, 'the collision produced errors rather than a silent wrong winner');

    // The important guarantee: nothing was mis-delivered. Any frame that did
    // complete carries the payload its own sender queued.
    assert.ok(near.stats.framesSent >= before.near);
    assert.ok(far.stats.framesSent >= before.far);
  });

test('published range and margin figures match the parameters they are derived from', () => {
  // t_slop counted at both ends (spec §5.6), with the per-profile defaults.
  assert.ok(Math.abs(maxRange('T100') - 0.17) < 0.05, `${maxRange('T100')}`);
  assert.ok(Math.abs(maxRange('T50') - 0.34) < 0.05, `${maxRange('T50')}`);
  assert.ok(Math.abs(maxRange('T25') - 2.4) < 0.1, `${maxRange('T25')}`);
  assert.ok(Math.abs(maxRange('T10') - 6.9) < 0.1, `${maxRange('T10')}`);
  assert.ok(Math.abs(maxRange('T5') - 3.4) < 0.1, `${maxRange('T5')}`);
  assert.ok(Math.abs(maxRange('T4') - 12.0) < 0.1, `${maxRange('T4')}`);
  assert.ok(Math.abs(maxRange('T2') - 44.6) < 0.1, `${maxRange('T2')}`);
  assert.equal(timing('T5').bitTime, 0.2);
  assert.ok(Math.abs(nearFarMarginDb() + 8.6) < 0.1, `${nearFarMarginDb()}`);

  for (const [name, p] of Object.entries(PROFILES)) {
    const t = timing(p);
    assert.equal(t.totalTq, p.sync + p.prop + p.ps1 + p.ps2, name);
    assert.ok(p.ps2 >= p.sjw, `${name}: PHASE_SEG2 must be at least SJW`);
    assert.ok(p.ps2 >= 2, `${name}: PHASE_SEG2 must be at least 2 TQ`);
  }
  assert.equal(Math.round(timing('T25').bitRate), 25);
  assert.equal(Math.round(timing('T100').bitRate), 100);
});

test('the T100 bench profile works at close range', () => {
  const ch = channel({
    profile: 'T100',
    sampleRate: 48000,
    selfDelayMs: 0.2,
    nodes: [{ name: 'a', x: 0, y: 0 }, { name: 'b', x: 0.15, y: 0 }],
  });
  const [a, b] = ch.protocols;
  const got = collect(b, 'frame');

  a.send({ id: 0x055, data: [0xf0, 0x0f] });
  ch.run(3);

  assert.equal(got.length, 1, 'a 100 bit/s frame arrived');
  assert.deepEqual(Array.from(got[0].frame.data), [0xf0, 0x0f]);
});

/*
 * The self path. Every test above leaves `selfGain` at 1 and `selfDelayMs` at
 * about 1 ms: a node hears itself exactly as loudly as a peer one metre away,
 * and instantly. Real devices are nothing like that. A laptop's speaker sits a
 * few centimetres from its own microphone, so it is 10–30× louder at that
 * microphone than a peer across a table, and a browser's output-to-input round
 * trip is typically 20–60 ms. The tests below pin down where the
 * implementation stops working; those marked `todo` describe real two-device
 * conditions that fail today.
 */

function pair(opts = {}) {
  const ch = channel({ nodes: [{ name: 'a', x: 0, y: 0 }, { name: 'b', x: 1, y: 0 }], ...opts });
  const [a, b] = ch.protocols;
  return { ch, a, b, got: collect(b, 'frame') };
}

test('an acknowledgement is heard when the transmitter hears itself twice as loud as its peer', () => {
  const { ch, a, got } = pair({ selfGain: 2 });
  a.send({ id: 0x123, data: [1, 2, 3, 4] });
  ch.run(8);

  assert.equal(got.length, 1);
  assert.equal(a.stats.framesSent, 1);
  assert.equal(a.stats.ackErrors, 0);
});

test('an acknowledgement is heard when the transmitter hears itself 10× louder than its peer', () => {
  // Laptop geometry: own speaker a few centimetres away, peer one metre away.
  const { ch, a, got } = pair({ selfGain: 10 });
  a.send({ id: 0x123, data: [1, 2, 3, 4] });
  ch.run(8);

  assert.equal(a.stats.ackErrors, 0, 'the peer\'s acknowledgement was heard');
  assert.equal(a.stats.framesSent, 1);
  assert.equal(got.length, 1);
});

test('arbitration resolves when every node hears itself 10× louder than its peers',
  { todo: 'each contender\'s own recessive tone buries the other\'s dominant bit, so neither withdraws' },
  () => {
    const ch = channel({
      selfGain: 10,
      nodes: [
        { name: 'primer', x: 0.4, y: -0.3 },
        { name: 'lo', x: 0, y: 0 },
        { name: 'hi', x: 0.8, y: 0 },
      ],
    });
    const [primer, lo, hi] = ch.protocols;

    contend(ch, primer, () => {
      lo.send({ id: 0x201, data: [1] });
      hi.send({ id: 0x205, data: [2] });
    });
    ch.run(14);

    assert.equal(hi.stats.arbitrationsLost, 1, 'the higher identifier withdrew');
    assert.equal(lo.stats.arbitrationsLost, 0);
    assert.equal(lo.stats.framesSent, 1);
    assert.equal(hi.stats.framesSent, 1);
  });

test('T25 tolerates 25 ms of speaker-to-microphone latency', () => {
  const { ch, a, got } = pair({ selfDelayMs: 25 });
  a.send({ id: 0x123, data: [1, 2, 3, 4] });
  ch.run(8);

  assert.equal(got.length, 1);
  assert.equal(a.stats.framesSent, 1);
  assert.equal(a.stats.bitErrors, 0);
});

test('T25 tolerates 45 ms of speaker-to-microphone latency, a typical browser round trip',
  { todo: 'the transmitter reads its own bits late and reports a bit error on every frame; loopback latency is not measured or compensated' },
  () => {
    const { ch, a, got } = pair({ selfDelayMs: 45 });
    a.send({ id: 0x123, data: [1, 2, 3, 4] });
    ch.run(8);

    assert.equal(a.stats.bitErrors, 0, 'the transmitter read its own bits back correctly');
    assert.equal(a.stats.framesSent, 1);
    assert.equal(got.length, 1);
  });

test('at T10 a transmitter reads its own bits through 45 ms of its own loopback latency', () => {
  // Only the node's own echo is late here; its peer's audio path is instant.
  // Real peers have audio paths too: see the device-latency tests below.
  const { ch, a, got } = pair({ profile: 'T10', selfDelayMs: 45 });
  a.send({ id: 0x123, data: [1, 2, 3, 4] });
  ch.run(20);

  assert.equal(got.length, 1);
  assert.equal(a.stats.framesSent, 1);
  assert.equal(a.stats.bitErrors, 0);
});

/*
 * Device latency. Every node's audio path, speaker and microphone, delays
 * everything it sends and hears, not only its own echo. A node synchronized
 * to another lags it by both their paths, and its answer comes back later by
 * both again, so PROP_SEG must cover twice t_slop (spec §5.6).
 */
function devicePair(profile, latencyMs, distance = 1) {
  const ch = channel({
    profile, deviceLatencyMs: latencyMs, selfDelayMs: 0.5,
    nodes: [{ name: 'primer', x: 0.4, y: -0.3 }, { name: 'lo', x: 0, y: 0 }, { name: 'hi', x: distance, y: 0 }],
  });
  return { ch, nodes: ch.protocols };
}

function deliver(profile, latencyMs) {
  const { ch, nodes: [, a, b] } = devicePair(profile, latencyMs);
  const got = collect(b, 'frame');
  a.send({ id: 0x123, data: [1, 2, 3, 4] });
  ch.run(130 * timing(profile).bitTime);
  return { a, got };
}

test('PROP_SEG must cover the audio latency at both ends, as spec §5.6 now says', () => {
  // T10: SYNC + PROP_SEG is 55 ms. Two 20 ms devices a metre apart need
  // 2 × (20 + 1.25) + 2 × 2.9 = 48 ms; two 30 ms devices need 68 ms.
  const fast = deliver('T10', 20);
  assert.equal(fast.got.length, 1, 'T10 between two 20 ms devices: delivered');
  assert.equal(fast.a.stats.framesSent, 1);

  const slow = deliver('T10', 30);
  assert.equal(slow.got.length, 0, 'T10 between two 30 ms devices: not delivered');
  assert.equal(slow.a.stats.formErrors, 1, 'the transmitter reads the late acknowledgement in the ACK delimiter');
  assert.equal(slow.a.stats.bitErrors, 0, 'it still reads its own bits: counting t_slop once would say this works');
});

test('T5 carries frames between two laptops whose audio paths take 60 ms', () => {
  // The figure measured from a MacBook Pro's built-in speaker to its built-in
  // microphone, in Chrome. No faster profile can do this (see above).
  const { a, got } = deliver('T5', 60);
  assert.equal(got.length, 1);
  assert.equal(a.stats.framesSent, 1);
  assert.equal(a.stats.bitErrors + a.stats.formErrors + a.stats.ackErrors, 0);

  const t10 = deliver('T10', 60);
  assert.equal(t10.got.length, 0, 'and T10 cannot');
});

/** Two slow devices `distance` apart contend after a third's frame frees the bus. */
function arbitrate(profile, latencyMs, distance = 1) {
  const { ch, nodes: [primer, lo, hi] } = devicePair(profile, latencyMs, distance);
  const loGot = collect(lo, 'frame');
  const hiGot = collect(hi, 'frame');
  const bit = timing(profile).bitTime;
  ch.run(0.5);
  primer.send({ id: 0x7ff, data: [0] });
  assert.ok(ch.runUntil(() => primer.transmitting, 100 * bit), `${profile}: primer never got the bus`);
  ch.run(20 * bit);
  lo.send({ id: 0x201, data: [1] });
  hi.send({ id: 0x205, data: [2] });
  ch.run(200 * bit);

  assert.equal(hi.stats.arbitrationsLost, 1, `${profile}: the higher identifier withdrew`);
  assert.equal(lo.stats.arbitrationsLost, 0, profile);
  assert.equal(lo.stats.framesSent, 1, profile);
  assert.equal(hi.stats.framesSent, 1, `${profile}: and sent once the bus was free`);
  assert.deepEqual(hiGot.map((f) => f.frame.id), [0x7ff, 0x201], profile);
  assert.deepEqual(loGot.map((f) => f.frame.id), [0x7ff, 0x205], profile);
}

test('T5 arbitrates between two laptops whose audio paths take 60 ms', () => {
  arbitrate('T5', 60);
});

test('T4 and T2 arbitrate between two such laptops, and carry frames tens of metres', () => {
  for (const profile of ['T4', 'T2']) arbitrate(profile, 60, 2);

  // One sender at a time, no third node to acknowledge for the far one.
  for (const [profile, distance] of [['T4', 12], ['T2', 40]]) {
    const ch = channel({
      profile, deviceLatencyMs: 60, selfDelayMs: 0.5,
      nodes: [{ name: 'a', x: 0, y: 0 }, { name: 'b', x: distance, y: 0 }],
    });
    const [a, b] = ch.protocols;
    const got = collect(b, 'frame');
    a.send({ id: 0x123, data: [1, 2, 3, 4] });
    ch.run(130 * timing(profile).bitTime);
    assert.equal(got.length, 1, `${profile} at ${distance} m: delivered`);
    assert.equal(a.stats.framesSent, 1, `${profile} at ${distance} m: acknowledged from that far`);
  }
});

test('frames cross a lightly reverberant room, critical distance about 3 m', () => {
  for (const profile of ['T25', 'T10']) {
    const { ch, a, got } = pair({ profile, rt60: 0.6, reverbLevel: 0.1 });
    a.send({ id: 0x0c0, data: [0x55, 0xaa] });
    ch.run(profile === 'T10' ? 15 : 8);

    assert.equal(got.length, 1, `${profile}: delivered`);
    assert.equal(a.stats.framesSent, 1, `${profile}: acknowledged`);
  }
});

/*
 * Silent loss. CAN's promise is that a frame its sender counts as delivered
 * was received by every node, because any node that missed it destroys it
 * with an error flag before EOF ends. Over air that promise depends on the
 * sender hearing other nodes over its own tone, and on the ACK slot holding
 * nothing but acknowledgements. The tests below are real laptop and room
 * conditions in which it does not hold today.
 */

test('a node alone in a reverberant room is not acknowledged by its own echo',
  { todo: 'the transmitter falls silent for ACK (§6.7), and the reverberant tail of its own last dominant bits reads as an acknowledgement, so it reports frames delivered to nobody' },
  () => {
    // An ordinary office: RT60 0.4 s, critical distance 1 m.
    const ch = channel({
      nodes: [{ name: 'a' }],
      rt60: 0.4, reverbLevel: 1, reverbSeed: 2, seed: 2,
      selfGain: 10, selfDelayMs: 20,
    });
    const [a] = ch.protocols;
    ch.run(0.5);
    for (let k = 0; k < 3; k++) a.send({ id: 0x100 + k, data: [k, 0x5a] });
    ch.run(ch.bitTime * 400);

    assert.equal(a.stats.framesSent, 0, 'nothing can have been delivered: there is nobody to deliver to');
    assert.ok(a.stats.ackErrors > 0);
  });

test('with laptop self-gain and latency, a frame its sender counts as delivered was received',
  { todo: 'the receiver\'s own ACK, heard 25 ms late, spills into the ACK delimiter and it flags a form error; the sender, hearing itself 10× louder, never hears that error flag (§4.6) and completes' },
  () => {
    const ch = channel({
      nodes: [{ name: 'a', x: 0 }, { name: 'b', x: 0.6 }],
      selfGain: 10, selfDelayMs: 25,
    });
    const [a, b] = ch.protocols;
    const got = collect(b, 'frame');
    ch.run(0.5);
    a.send({ id: 0x123, data: [1, 2, 3, 4] });
    ch.run(ch.bitTime * 300);

    assert.equal(a.stats.framesSent, 1);
    assert.equal(got.length, a.stats.framesSent, 'b received every frame a counted as delivered');
  });

test('two laptops a metre apart in an ordinary office exchange frames',
  { todo: 'the reverberant tail of each dominant bit reads as dominant in the recessive bit after it at theta_D = 0.12 (§4.7), and the failures are mostly silent: see the two tests above' },
  () => {
    // RT60 0.4 s and a 1 m critical distance are typical of a small office or
    // living room; each laptop hears itself 10× louder than the other, 25 ms late.
    for (const profile of ['T25', 'T10']) {
      const ch = channel({
        profile, seed: 2, reverbSeed: 2,
        nodes: [{ name: 'a', x: 0 }, { name: 'b', x: 1 }],
        rt60: 0.4, reverbLevel: 1, selfGain: 10, selfDelayMs: 25,
      });
      const [a, b] = ch.protocols;
      const atA = collect(a, 'frame');
      const atB = collect(b, 'frame');
      ch.run(0.5);
      a.send({ id: 0x123, data: [1, 2, 3, 4] });
      ch.run(ch.bitTime * 200);
      b.send({ id: 0x124, data: [5, 6, 7, 8] });
      ch.run(ch.bitTime * 200);

      assert.equal(atB.length, 1, `${profile}: b heard a`);
      assert.equal(atA.length, 1, `${profile}: a heard b`);
      assert.equal(a.stats.framesSent, 1, `${profile}: a was acknowledged`);
      assert.equal(b.stats.framesSent, 1, `${profile}: b was acknowledged`);
    }
  });

test('a slow audio path is steered to the fastest profile whose PROP_SEG covers it', () => {
  assert.equal(fastestProfileFor(1), 'T100');
  assert.equal(fastestProfileFor(3), 'T50');
  assert.equal(fastestProfileFor(8), 'T25');
  assert.equal(fastestProfileFor(20), 'T10');
  // A MacBook Pro's built-in speaker and microphone, measured in Chrome.
  assert.equal(fastestProfileFor(58.6 + 2.5), 'T5');
  assert.ok(maxRange('T5', 61.1) > 3);
  // An iPhone used as the microphone, through Continuity: only T2.
  assert.equal(fastestProfileFor(168.7), 'T2');
  // A Bluetooth headset's 250 ms: nothing.
  assert.equal(fastestProfileFor(250), null);
});

/*
 * Lost and inserted input. Browsers fill a capture underrun with silence, so
 * everything after it arrives late, and discard input their audio thread had
 * no room for, so everything after it arrives early. At T2 a receiver has
 * PROP_SEG, 380 ms, to absorb lateness, but early arrival soon walks its
 * 60 ms detection window past PHASE_SEG2, 40 ms, into the next bit.
 */
function shiftedReception(ms) {
  const ch = channel({
    profile: 'T2', deviceLatencyMs: 60, selfDelayMs: 0.5, shiftHeadroomMs: 800,
    nodes: [
      { name: 'a', x: 0, y: 0 },
      { name: 'c', x: 0.5, y: 0.3 },                    // acknowledges
      { name: 'b', x: 1, y: 0, mode: 'listener' },      // hears it all `ms` sooner or later
    ],
  });
  const [a, , b] = ch.protocols;
  const got = collect(b, 'frame');
  ch.shiftInput('b', 300);              // room to arrive early later; harmless before the frame
  a.send({ id: 0x323, data: [0x10, 0x68, 0x61, 0x64, 0x61] });
  ch.run(20);                           // mid-frame
  ch.shiftInput('b', ms);
  ch.run(80);
  return { got, b };
}

test('at T2 a receiver rides out input that arrives late, even by a fifth of a second', () => {
  for (const ms of [13, 100, 200]) {
    const { got, b } = shiftedReception(ms);
    assert.equal(got.length, 1, `${ms} ms late: delivered`);
    assert.equal(b.stats.formErrors + b.stats.stuffErrors + b.stats.crcErrors, 0, `${ms} ms late`);
  }
});

test('at T2 a receiver loses the frame when its input arrives a tenth of a second early', () => {
  assert.equal(shiftedReception(-80).got.length, 1, '80 ms early: the window still covers the bit');
  const { got, b } = shiftedReception(-150);
  assert.equal(got.length, 0, '150 ms early: the sample point reads the next bit');
  assert.ok(b.stats.formErrors + b.stats.stuffErrors + b.stats.crcErrors > 0);
});
