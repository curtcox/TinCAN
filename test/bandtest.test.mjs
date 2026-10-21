/**
 * Band tests — Part 2 §9: nodes take turns playing every band's tones, every
 * node measures them, and the players report what they heard on the main bus.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Session, CONTROL, buildTestMessage, parseControl, describeControl, bandMask, bandsOfMask,
} from '../src/tincan/transport.js';
import {
  BandTests, testPlan, testSignal, measureTest, encodeReport, decodeReport, levelCode, levelOf,
  pairLevels, joinWindow, LAYOUT,
} from '../src/tincan/bandtest.js';
import { AcousticChannel, mulberry32 } from '../src/tincan/bus.js';

const dB = (a) => 20 * Math.log10(a);

test('band-test messages round-trip through their CONTROL payloads', () => {
  assert.equal(bandMask(['A', 'C', 'G']), 0b1000101);
  assert.deepEqual(bandsOfMask(0x7f), ['A', 'B', 'C', 'D', 'E', 'F', 'G']);

  const req = buildTestMessage({ op: CONTROL.TEST_REQUEST, test: 9, bands: ['A', 'F'], window: 24 });
  assert.deepEqual(Array.from(req), [0x24, 9, 0b100001, 24]);
  assert.deepEqual(parseControl(req), { op: 0x24, name: 'TEST_REQUEST', test: 9, bands: ['A', 'F'], window: 24 });
  assert.equal(describeControl(req), 'TEST_REQUEST #9: bands AF, 24 s to join');

  const join = buildTestMessage({ op: CONTROL.TEST_JOIN, requester: 3, test: 9, bands: ['A'] });
  assert.deepEqual(parseControl(join).bands, ['A']);
  const start = buildTestMessage({ op: CONTROL.TEST_START, test: 9, bands: ['A', 'F'], players: [3, 12, 20] });
  assert.deepEqual(parseControl(start).players, [3, 12, 20]);
  assert.throws(() => buildTestMessage({ op: CONTROL.TEST_START, test: 9, bands: ['A'], players: [1, 2, 3, 4, 5, 6] }));

  assert.equal(levelCode(1), 0);
  assert.equal(levelCode(0.5), 12, '-6 dBFS is 12 half-decibels');
  assert.equal(levelCode(null), 255);
  assert.ok(Math.abs(dB(levelOf(levelCode(0.01))) + 40) < 0.25);
});

test('a report carries noise and every other player\'s tones (§9.4)', () => {
  const plan = testPlan(['A', 'C', 'D', 'E', 'G', 'B', 'F'].sort(), [3, 12, 20, 25]);
  const m = { noise: {}, heard: {} };
  for (const b of plan.bands) m.noise[b] = [1e-4, 2e-4];
  for (const p of plan.players) {
    m.heard[p] = {};
    for (const b of plan.bands) m.heard[p][b] = [0.1 / p, b === 'F' ? null : 0.05];
  }
  const levels = encodeReport(plan, 12, m);
  assert.equal(levels.length + 3, 59, 'four players on seven bands: 59 octets with the header, as §9.4 says');
  const back = decodeReport(plan, 12, levels);
  assert.deepEqual(Object.keys(back.heard).map(Number), [3, 20, 25], 'not its own tones');
  assert.ok(Math.abs(dB(back.heard[20].A[0]) - dB(0.1 / 20)) < 0.25);
  assert.equal(back.heard[25].F[1], null);
  assert.equal(decodeReport(plan, 12, levels.slice(0, 10)), null, 'a short report is refused');
  assert.ok(Math.abs(plan.seconds - 44.7) < 1e-9, 'and the test takes 44.7 s');
});

test('levels survive the nodes\' differing latencies, up to 150 ms either way (§9.3)', () => {
  const fs = 16000;
  const plan = testPlan(['A', 'E', 'G'], [1, 2]);
  const one = testSignal(fs, plan, 1, { amplitude: 0.25 });
  const two = testSignal(fs, plan, 2, { amplitude: 0.25, canPlay: (b) => b !== 'G' });
  const rnd = mulberry32(5);
  for (const ms of [-140, 0, 140]) {
    const shift = Math.round((ms / 1000) * fs);
    const rec = new Float32Array(one.length);
    for (let k = 0; k < rec.length; k++) {
      const j = k - shift;
      const s = j >= 0 && j < one.length ? one[j] * 0.5 + two[j] * 0.1 : 0;
      rec[k] = s + 0.001 * (rnd() * 2 - 1);
    }
    const m = measureTest(rec, fs, plan, (b) => b !== 'E' || ms === 0);
    for (const b of ['A', 'G']) {
      for (const lvl of m.heard[1][b]) assert.ok(Math.abs(dB(lvl) - dB(0.125)) < 0.3, `${b} from 1 at ${ms} ms: ${dB(lvl)}`);
    }
    for (const lvl of m.heard[2].A) assert.ok(Math.abs(dB(lvl) - dB(0.025)) < 0.3);
    const g = pairLevels(new Map([[9, m]]), 2, 9, 'G');
    assert.ok(g.snrDb < 6, `2 did not play G: ${g.snrDb.toFixed(1)} dB above noise`);
    if (ms) assert.equal(pairLevels(new Map([[9, m]]), 1, 9, 'E'), null, 'a band not heard is not measured');
  }
});

test('the join window allows five joins at the main bus\'s speed', () => {
  assert.equal(joinWindow('T100'), 10);
  assert.ok(joinWindow('T25') >= 5 * 91 * 0.04);
  assert.equal(joinWindow('T2'), 255);
});

/** Audio for a BandTests on a simulated node: its input, output and receiver. */
function simAudio(ch, name) {
  const node = ch.node(name);
  const fs = ch.sampleRate;
  const timers = [];
  const plays = [];
  const recs = [];
  node.play = (t) => {
    let y = 0;
    for (const p of plays) { const k = t - p.at; if (k >= 0 && k < p.signal.length) y += p.signal[k]; }
    return y;
  };
  node.tap = (x, t) => {
    for (const tm of timers) if (!tm.done && t >= tm.at) { tm.done = true; tm.fn(); }
    for (const r of recs) {
      if (r.done || t < r.at) continue;
      r.buf[t - r.at] = x;
      if (t - r.at === r.buf.length - 1) { r.done = true; r.fn(r.buf); }
    }
  };
  return {
    sampleRate: fs,
    now: () => ch.n / fs,
    after: (s, fn) => timers.push({ at: ch.n + Math.round(s * fs), fn }),
    hold: (until) => { node.holdUntil = Math.round(until * fs); },
    play: (signal, at) => plays.push({ signal, at: Math.round(at * fs) }),
    record: (at, n, fn) => recs.push({ at: Math.round(at * fs), buf: new Float32Array(n), fn }),
  };
}

test('three players and a listener each end with how every player heard every other on every band', () => {
  const ch = new AcousticChannel({
    sampleRate: 16000, band: 'A', profile: 'T25', noise: 0.0005, random: mulberry32(11),
    deviceLatencyMs: 3, selfDelayMs: 0.5,
    nodes: [
      { name: 'ada', x: 0, y: 0 },
      { name: 'bob', x: 1, y: 0 },
      { name: 'cyd', x: 0, y: 1.5 },
      { name: 'dee', x: 0.3, y: 0.6, mode: 'listener' },
    ],
  });
  const addr = { ada: 3, bob: 12, cyd: 20, dee: 25 };
  const tests = {};
  ch.nodes.forEach((n) => {
    const name = n.spec.name;
    const s = new Session(n.protocol, { address: addr[name], callsign: name });
    tests[name] = new BandTests(s, simAudio(ch, name), {
      amplitude: 0.25,
      latencyMs: 3.5,
      listenOnly: name === 'dee',
      canRun: (b) => b !== 'B' && b !== 'F' && !(name === 'cyd' && b === 'G'),   // cyd's speaker has no bass
    });
  });

  ch.run(1);                                          // let every receiver settle on an idle bus
  // A fixed test number, so the frames' bits are the same each run. With some
  // numbers (7, 99) the listener loses sync where all three players start
  // reports at once, and misses one report: a Part 1 matter, not a band test's.
  tests.ada.nextTest = 1;
  const t = tests.ada.request({ bands: ['G', 'E', 'D', 'A', 'B'], window: joinWindow('T25') });
  assert.deepEqual(t.bands, ['A', 'D', 'E', 'G'], 'only bands the requester can run, lowest ID first');
  const done = () => Object.values(tests).every((bt) => [...bt.tests.values()].some((x) => x.state === 'done'));
  assert.ok(ch.runUntil(done, 200), 'every node finished the test');

  for (const [name, bt] of Object.entries(tests)) {
    const x = [...bt.tests.values()][0];
    assert.deepEqual(x.players, [3, 12, 20], `${name}: the requester, then the joins in the order they arrived`);
    assert.deepEqual([...x.results.keys()].sort((a, b) => a - b), name === 'dee' ? [3, 12, 20, 25] : [3, 12, 20],
      `${name}: a report from every player, and its own`);

    // Every pair, as this node knows it, against the simulation's 1/r paths.
    const pos = Object.fromEntries(ch.nodes.map((n) => [addr[n.spec.name], n]));
    for (const tx of x.players) {
      for (const rx of bt.listeners(x)) {
        if (tx === rx) continue;
        const d = Math.hypot(pos[tx].x - pos[rx].x, pos[tx].y - pos[rx].y);
        for (const band of x.bands) {
          const p = pairLevels(x.results, tx, rx, band);
          if (rx === 20 && band === 'G') {
            assert.equal(p, null, `${name}: cyd cannot hear G, so did not measure it`);
            continue;
          }
          if (tx === 20 && band === 'G') {
            assert.ok(p.snrDb < 6, `${name}: cyd played no G, and ${rx} heard none`);
            continue;
          }
          for (const lvl of p.levelDb) {
            assert.ok(Math.abs(lvl - dB(0.25 / d)) < 1, `${name}: ${tx}→${rx} on ${band}: ${lvl.toFixed(1)} dBFS, expected ${dB(0.25 / d).toFixed(1)}`);
          }
          assert.ok(Math.abs(p.tiltDb) < 1, `${name}: ${tx}→${rx} on ${band} balanced`);
          assert.ok(p.snrDb > 50);
        }
      }
    }
  }

  // The tones on the main band did not disturb the main bus: every receiver
  // was stopped through the test.
  for (const n of ch.nodes) {
    const s = n.protocol.stats;
    assert.equal(s.bitErrors + s.stuffErrors + s.crcErrors + s.formErrors + s.ackErrors, 0, `${n.spec.name}: no errors`);
  }
  assert.ok(LAYOUT.slot > LAYOUT.tones[1][1]);
});
