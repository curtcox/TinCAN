import test from 'node:test';
import assert from 'node:assert/strict';

import { Protocol, ERROR_STATE, DOMINANT, RECESSIVE, arbitrationKey } from '../src/tincan/protocol.js';
import { IdealBus } from '../src/tincan/bus.js';
import { frameBitLength } from '../src/tincan/frame.js';

function collect(p, event) {
  const out = [];
  p.on(event, (d) => out.push(d));
  return out;
}

test('a frame goes from one node to another over an ideal bus', () => {
  const a = new Protocol({ name: 'a' });
  const b = new Protocol({ name: 'b' });
  const bus = new IdealBus([a, b]);

  const got = collect(b, 'frame');
  const sent = collect(a, 'tx-complete');

  a.send({ id: 0x123, data: [0xde, 0xad, 0xbe, 0xef] });
  bus.run(200);

  assert.equal(got.length, 1, 'receiver saw exactly one frame');
  assert.equal(got[0].frame.id, 0x123);
  assert.deepEqual(Array.from(got[0].frame.data), [0xde, 0xad, 0xbe, 0xef]);
  assert.equal(sent.length, 1, 'transmitter saw its frame acknowledged');
  assert.equal(a.stats.ackErrors, 0);
});

test('a frame is delivered to every listening node at once', () => {
  const a = new Protocol({ name: 'a' });
  const rx = [1, 2, 3, 4].map((i) => new Protocol({ name: `r${i}` }));
  const bus = new IdealBus([a, ...rx]);
  const seen = rx.map((p) => collect(p, 'frame'));

  a.send({ id: 0x0aa, data: [7] });
  bus.run(200);

  for (const s of seen) {
    assert.equal(s.length, 1);
    assert.equal(s[0].frame.id, 0x0aa);
  }
});

test('the numerically lower identifier wins arbitration, and the loser loses nothing', () => {
  const lo = new Protocol({ name: 'lo' });
  const hi = new Protocol({ name: 'hi' });
  const bus = new IdealBus([lo, hi]);

  const loDone = collect(lo, 'tx-complete');
  const hiDone = collect(hi, 'tx-complete');
  const hiLost = collect(hi, 'arbitration-lost');
  const loLost = collect(lo, 'arbitration-lost');

  // Both become ready in the same bit time.
  bus.run(12);
  lo.send({ id: 0x201, data: [1] });
  hi.send({ id: 0x205, data: [2] });
  bus.run(400);

  assert.equal(hiLost.length, 1, 'the high identifier lost arbitration exactly once');
  assert.equal(loLost.length, 0, 'the low identifier never lost');
  assert.equal(loDone.length, 1, 'low identifier delivered');
  assert.equal(hiDone.length, 1, 'high identifier delivered afterwards');
  assert.equal(lo.stats.bitErrors + hi.stats.bitErrors, 0, 'contention cost no errors');
  assert.equal(lo.stats.crcErrors + hi.stats.crcErrors, 0);
});

test('the winner is bit-exact: contention does not corrupt the winning frame', () => {
  const lo = new Protocol({ name: 'lo' });
  const hi = new Protocol({ name: 'hi' });
  const spy = new Protocol({ name: 'spy', mode: 'listener' });
  const bus = new IdealBus([lo, hi, spy]);
  const seen = collect(spy, 'frame');

  bus.run(12);
  lo.send({ id: 0x0f0, data: [0x11, 0x22] });
  hi.send({ id: 0x0f1, data: [0x33, 0x44] });
  bus.run(600);

  assert.equal(seen.length, 2);
  assert.equal(seen[0].frame.id, 0x0f0);
  assert.deepEqual(Array.from(seen[0].frame.data), [0x11, 0x22]);
  assert.equal(seen[1].frame.id, 0x0f1);
  assert.deepEqual(Array.from(seen[1].frame.data), [0x33, 0x44]);
});

test('eight contenders are delivered in strict identifier order', () => {
  const ids = [0x30, 0x1f0, 0x005, 0x2c8, 0x101, 0x077, 0x400, 0x00a];
  const nodes = ids.map((id, i) => new Protocol({ name: `n${i}` }));
  const spy = new Protocol({ name: 'spy', mode: 'listener' });
  const bus = new IdealBus([...nodes, spy]);
  const seen = collect(spy, 'frame');

  bus.run(12);
  ids.forEach((id, i) => nodes[i].send({ id, data: [i] }));
  bus.run(20000);

  assert.deepEqual(seen.map((s) => s.frame.id), ids.slice().sort((x, y) => x - y));
  const errors = nodes.reduce((n, p) => n + p.stats.bitErrors + p.stats.crcErrors + p.stats.stuffErrors, 0);
  assert.equal(errors, 0, 'a full arbitration cascade produced no errors at all');
});

test('a data frame beats a remote frame with the same identifier', () => {
  const d = new Protocol({ name: 'data' });
  const r = new Protocol({ name: 'remote' });
  const spy = new Protocol({ name: 'spy', mode: 'listener' });
  const bus = new IdealBus([d, r, spy]);
  const seen = collect(spy, 'frame');

  bus.run(12);
  r.send({ id: 0x180, rtr: true, dlc: 2 });
  d.send({ id: 0x180, data: [9, 9] });
  bus.run(600);

  assert.equal(seen[0].frame.rtr, false, 'data frame went first');
  assert.equal(seen[1].frame.rtr, true);
});

test('a base frame beats an extended frame sharing its top 11 bits', () => {
  const b = new Protocol({ name: 'base' });
  const e = new Protocol({ name: 'ext' });
  const spy = new Protocol({ name: 'spy', mode: 'listener' });
  const bus = new IdealBus([b, e, spy]);
  const seen = collect(spy, 'frame');

  bus.run(12);
  e.send({ id: (0x2aa << 18) >>> 0, extended: true, data: [1] });
  b.send({ id: 0x2aa, data: [2] });
  bus.run(800);

  assert.equal(seen[0].frame.extended, false);
  assert.equal(seen[1].frame.extended, true);
});

test('arbitrationKey orders the same way the bus does', () => {
  assert.ok(arbitrationKey({ id: 0x100, extended: false, rtr: false })
          < arbitrationKey({ id: 0x101, extended: false, rtr: false }));
  assert.ok(arbitrationKey({ id: 0x100, extended: false, rtr: false })
          < arbitrationKey({ id: 0x100, extended: false, rtr: true }));
  assert.ok(arbitrationKey({ id: 0x100, extended: false, rtr: true })
          < arbitrationKey({ id: 0x100 * 0x40000, extended: true, rtr: false }));
});

test('a lone node never reaches bus-off, but does go error-passive', () => {
  const solo = new Protocol({ name: 'solo' });
  const bus = new IdealBus([solo]);
  const states = collect(solo, 'error-state');

  solo.send({ id: 0x111, data: [1] });
  bus.run(60000);

  assert.ok(solo.stats.ackErrors > 20, `expected repeated ACK errors, got ${solo.stats.ackErrors}`);
  assert.equal(solo.errorState, ERROR_STATE.PASSIVE, 'stayed error-passive');
  assert.ok(solo.tec <= 255, `TEC clamped, got ${solo.tec}`);
  assert.ok(states.some((s) => s.to === ERROR_STATE.PASSIVE));
  assert.ok(!states.some((s) => s.to === ERROR_STATE.BUS_OFF), 'never bussed off');
});

test('a listener never acknowledges, so a transmitter alone with one still reports no peer', () => {
  const tx = new Protocol({ name: 'tx' });
  const spy = new Protocol({ name: 'spy', mode: 'listener' });
  const bus = new IdealBus([tx, spy]);
  const decoded = collect(spy, 'frame-decoded');
  const delivered = collect(spy, 'frame');

  tx.send({ id: 0x222, data: [5] });
  bus.run(400);

  assert.ok(decoded.length >= 1, 'the listener decoded the frame');
  assert.equal(decoded[0].frame.id, 0x222);
  assert.equal(delivered.length, 0,
    'but the frame was destroyed by the ACK-error flag, so it was never delivered');
  assert.ok(tx.stats.ackErrors >= 1, 'because the listener did not acknowledge');
  assert.throws(() => spy.send({ id: 1 }), /may not transmit/);
});

test('a receiver that sees a corrupted frame destroys it and the sender retries', () => {
  const a = new Protocol({ name: 'a' });
  const b = new Protocol({ name: 'b' });
  const bus = new IdealBus([a, b]);
  const delivered = collect(b, 'frame');
  const errors = collect(a, 'error-frame');

  a.send({ id: 0x150, data: [0xaa, 0xbb] });

  // Overwrite one recessive bit of the first attempt, well past the
  // arbitration field, so the transmitter reads back a bit it did not send.
  let injected = false;
  bus.corrupt = (bit, level, tx) => {
    if (injected || !a.txItem) return;
    if (a.txIndex > a.txItem.tx.arbitrationEnd + 4 && tx[0] === RECESSIVE) {
      injected = true;
      return DOMINANT;
    }
  };
  bus.run(800);
  assert.ok(injected, 'the fault was actually injected');

  assert.ok(errors.length >= 1, 'the transmitter noticed');
  assert.equal(delivered.length, 1, 'the frame arrived exactly once, after a retry');
  assert.deepEqual(Array.from(delivered[0].frame.data), [0xaa, 0xbb]);
  assert.ok(a.txQueue.length === 0);
});

test('64-octet FDF frames survive the full path', () => {
  const a = new Protocol({ name: 'a' });
  const b = new Protocol({ name: 'b' });
  const bus = new IdealBus([a, b]);
  const seen = collect(b, 'frame');

  const payload = Uint8Array.from({ length: 64 }, (_, i) => (i * 37) & 0xff);
  a.send({ id: 0x7ff, extended: false, fdf: true, data: payload });
  bus.run(2000);

  assert.equal(seen.length, 1);
  assert.deepEqual(Array.from(seen[0].frame.data), Array.from(payload));
});

test('frames whose bodies force stuff bits still decode', () => {
  const a = new Protocol({ name: 'a' });
  const b = new Protocol({ name: 'b' });
  const bus = new IdealBus([a, b]);
  const seen = collect(b, 'frame');

  // All-zero and all-one payloads maximise stuffing in both directions.
  a.send({ id: 0x000, data: new Uint8Array(8).fill(0x00) });
  a.send({ id: 0x7ff, data: new Uint8Array(8).fill(0xff) });
  bus.run(2000);

  assert.equal(seen.length, 2);
  assert.deepEqual(Array.from(seen[0].frame.data), new Array(8).fill(0));
  assert.deepEqual(Array.from(seen[1].frame.data), new Array(8).fill(0xff));
  assert.equal(a.stats.stuffErrors + b.stats.stuffErrors, 0);
});

test('a queue drains in priority order regardless of submission order', () => {
  const a = new Protocol({ name: 'a' });
  const b = new Protocol({ name: 'b' });
  const bus = new IdealBus([a, b]);
  const seen = collect(b, 'frame');

  a.send({ id: 0x700, data: [3] });
  a.send({ id: 0x010, data: [1] });
  a.send({ id: 0x200, data: [2] });
  bus.run(1500);

  assert.deepEqual(seen.map((s) => s.frame.id), [0x010, 0x200, 0x700]);
});

/*
 * Interframe-space recovery. On air, a node's view of the bus can differ from
 * everyone else's for a bit: noise crosses the carrier threshold, or its bit
 * clock lands its INTERMISSION a little behind the node that starts next.
 * `stepWith` runs one bit of a wired-AND bus but lets each node be shown
 * something different.
 */
function stepWith(nodes, view) {
  const tx = nodes.map((n) => n.beginBit());
  const carrier = tx.some((l) => l !== null);
  const level = tx.some((l) => l === DOMINANT) ? DOMINANT : RECESSIVE;
  nodes.forEach((n, i) => {
    const seen = view(i, level, carrier);
    if (seen) n.endBit(...seen);            // null: this node misses the bit
  });
}

/** a sends 0x100 and b sends 0x200, which b starts as soon as 0x100's IFS ends. */
function backToBack() {
  const a = new Protocol({ name: 'a' });
  const b = new Protocol({ name: 'b' });
  const c = new Protocol({ name: 'c', mode: 'listener' });
  a.send({ id: 0x100, data: [1] });
  b.send({ id: 0x200, data: [2] });
  return { a, b, c, nodes: [a, b, c], got: collect(c, 'frame'), overloads: collect(c, 'overload') };
}

function errorCount(...nodes) {
  return nodes.reduce((n, p) => n + p.stats.bitErrors + p.stats.stuffErrors + p.stats.crcErrors
    + p.stats.formErrors + p.stats.ackErrors, 0);
}

test('one noisy dominant bit in INTERMISSION does not cost a node the next frame', () => {
  const { a, b, c, nodes, got, overloads } = backToBack();
  let glitched = false;
  for (let i = 0; i < 400; i++) {
    stepWith(nodes, (k, level, carrier) => {
      if (k === 2 && !glitched && c.state === 'intermission') { glitched = true; return [DOMINANT, true]; }
      return [level, carrier];
    });
  }

  assert.ok(glitched);
  assert.deepEqual(got.map((g) => g.frame.id), [0x100, 0x200], 'c received both frames');
  assert.equal(overloads.length, 0, 'a lone bit followed by silence is not an overload flag');
  assert.equal(errorCount(a, b, c), 0);
});

test('a node whose INTERMISSION runs a bit late takes the next SYNC as a frame, not an overload', () => {
  // c's bit clock slips one bit behind during EOF (it misses a bit), so b's
  // first SYNC bit lands in c's last INTERMISSION bit — the CAN "dominant in
  // the third IFS bit is SOF" case.
  const { a, b, c, nodes, got, overloads } = backToBack();
  let slipped = false;
  for (let i = 0; i < 400; i++) {
    stepWith(nodes, (k, level, carrier) => {
      if (k === 2 && !slipped && c.state === 'eof') { slipped = true; return null; }
      return [level, carrier];
    });
  }

  assert.ok(slipped);

  assert.deepEqual(got.map((g) => g.frame.id), [0x100, 0x200], 'c received both frames');
  assert.equal(overloads.length, 0);
  assert.equal(errorCount(a, b, c), 0);
});

test('six dominant bits in INTERMISSION are still read as an overload flag', () => {
  const { a, b, c, nodes, got, overloads } = backToBack();
  let flag = 0;
  for (let i = 0; i < 400; i++) {
    if (!flag && c.state === 'intermission') flag = 6;
    const forced = flag > 0;
    if (forced) flag--;
    stepWith(nodes, (k, level, carrier) => (forced ? [DOMINANT, true] : [level, carrier]));
    if (forced && flag === 0) flag = -1;
  }

  assert.equal(overloads.length, 1, 'c recognised the overload flag');
  assert.deepEqual(got.map((g) => g.frame.id), [0x100, 0x200], 'and still received the next frame');
  assert.equal(b.stats.framesSent, 1);
  assert.equal(errorCount(a, b), 0);
});
