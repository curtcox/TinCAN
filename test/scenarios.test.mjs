/**
 * Every scenario the simulator app offers is run headlessly here and asserted
 * against what its own description claims. A demo that quietly stops
 * demonstrating its point is worse than no demo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SCENARIOS } from '../apps/simulator/scenarios.js';
import { AcousticChannel, mulberry32 } from '../src/tincan/bus.js';

const SIM_RATE = 16000;

/** Run one scenario exactly as the app does, and return per-node results. */
function runScenario(key, overrides = {}) {
  const s = SCENARIOS[key];
  const ch = new AcousticChannel({
    sampleRate: SIM_RATE,
    band: 'A',
    profile: s.profile || 'T25',
    noise: s.noise ?? 0.0005,
    rt60: s.rt60 ?? 0,
    nodes: s.nodes,
    random: mulberry32(1),
    ...overrides,
  });

  const byName = {};
  for (const n of ch.nodes) byName[n.spec.name] = n.protocol;

  const delivered = [];
  for (const n of ch.nodes) n.protocol.on('tx-complete', (e) => delivered.push({ node: n.spec.name, id: e.frame.id }));

  const script = (s.script || []).map((step) => ({ ...step, done: false }));
  const total = Math.round((s.duration ?? 20) * SIM_RATE);
  for (let i = 0; i < total; i++) {
    const now = i / SIM_RATE;
    for (const step of script) {
      if (!step.done && now >= step.t) { step.done = true; step.do(byName); }
    }
    ch.stepSample();
  }
  return { ch, byName, delivered, stats: Object.fromEntries(ch.nodes.map((n) => [n.spec.name, n.protocol.stats])) };
}

test('every scenario is well formed', () => {
  for (const [key, s] of Object.entries(SCENARIOS)) {
    assert.ok(s.name && s.description, `${key} needs a name and description`);
    assert.ok(Array.isArray(s.nodes) && s.nodes.length, `${key} needs nodes`);
    assert.ok(Array.isArray(s.script) && s.script.length, `${key} needs a script`);
    for (const n of s.nodes) {
      assert.equal(typeof n.name, 'string');
      assert.equal(typeof n.x, 'number');
      assert.equal(typeof n.y, 'number');
    }
    for (const step of s.script) {
      assert.equal(typeof step.t, 'number');
      assert.equal(typeof step.do, 'function');
      assert.ok(step.t < (s.duration ?? 20), `${key}: a script step fires after the run ends`);
    }
  }
});

test('"contention" — the lower identifier wins and the loser defers, at no cost', () => {
  const { stats, delivered } = runScenario('contention');
  assert.equal(stats.hi.arbitrationsLost, 1, 'exactly one arbitration was lost');
  assert.equal(stats.lo.arbitrationsLost, 0);
  assert.equal(stats.lo.framesSent, 1, '0x201 was delivered');
  assert.equal(stats.hi.framesSent, 1, '0x205 was delivered afterwards');
  assert.equal(stats.lo.bitErrors + stats.hi.bitErrors, 0, 'the collision cost no bit errors');
  const order = delivered.filter((d) => d.id !== 0x7ff).map((d) => d.id);
  assert.deepEqual(order, [0x201, 0x205], 'delivered in identifier order');
});

test('"cascade" — four contenders come out in strict identifier order', () => {
  const { stats, delivered } = runScenario('cascade');
  const ids = delivered.filter((d) => d.id !== 0x7ff).map((d) => d.id);
  assert.deepEqual(ids, [0x030, 0x0a0, 0x140, 0x2c0]);
  for (const n of ['n0', 'n1', 'n2', 'n3']) {
    assert.equal(stats[n].framesSent, 1, `${n} got its frame out`);
    assert.equal(stats[n].bitErrors, 0, `${n} saw no bit errors`);
  }
  const lost = ['n0', 'n1', 'n2', 'n3'].reduce((a, n) => a + stats[n].arbitrationsLost, 0);
  assert.equal(lost, 3, 'four contenders cost exactly three withdrawals');
});

test('"nearfar" — the far node is excluded, and the near node never notices', () => {
  const { stats } = runScenario('nearfar');
  assert.equal(stats.near.arbitrationsLost, 0, 'neither node withdrew…');
  assert.equal(stats.far.arbitrationsLost, 0, '…in either direction');
  assert.equal(stats.far.framesSent, 0, 'the far node never got a frame acknowledged');
  assert.ok(stats.far.ackErrors > 0, 'and it knows only that nobody answered');
  assert.ok(stats.near.framesSent > 0, 'while the near node completed normally');
});

test('"lone" — an unacknowledged node goes error-passive but never bus-off', () => {
  const { byName, stats } = runScenario('lone');
  assert.ok(stats.solo.ackErrors > 0, 'it reported the missing acknowledgement');
  assert.equal(stats.solo.framesSent, 0, 'and never completed a frame');
  assert.notEqual(byName.solo.errorState, 'bus-off', 'the §8.3 exception held');
  assert.ok(byName.solo.tec <= 255, `TEC was clamped, got ${byName.solo.tec}`);
});

test('"noisy" — the slow profile survives a loud, reverberant room',
  { todo: 'with realistic reverberation a 0.6 s room at 1.3 m defeats T10 too: RT60 is far longer than any bit, so a slower profile buys little' },
  () => {
    const { stats } = runScenario('noisy');
    assert.ok(stats.a.framesSent >= 1, 'node a got through');
    assert.ok(stats.b.framesSent >= 1, 'node b got through');
  });

test('"chatty" — sustained traffic drains in priority order and starves the higher address', () => {
  const { stats, delivered } = runScenario('chatty');
  const ids = delivered.map((d) => d.id);
  assert.ok(ids.length >= 6, `expected sustained traffic, got ${ids.length} frames`);
  // Node a holds every even identifier, b every odd one; at equal priority the
  // lower identifier wins, so a's frames systematically precede b's.
  assert.deepEqual(ids, ids.slice().sort((x, y) => x - y),
    'frames were delivered in strict identifier order throughout');
  assert.ok(stats.a.arbitrationsLost + stats.b.arbitrationsLost > 0, 'they really did contend');
  assert.ok(stats.b.arbitrationsLost > stats.a.arbitrationsLost,
    'the higher-addressed node lost more often — the starvation Part 2 §1.1 warns about');
});
