import test from 'node:test';
import assert from 'node:assert/strict';

import {
  baseId, parseBaseId, extendedId, parseExtendedId, describeId,
  segment, Reassembler, PCI, PRIO, TOPIC, BROADCAST_EXT,
  buildAnnounce, parseAnnounce, Session, MAX_TRANSFER,
} from '../src/tincan/transport.js';
import { Protocol, arbitrationKey } from '../src/tincan/protocol.js';
import { IdealBus } from '../src/tincan/bus.js';

test('base identifiers pack and unpack', () => {
  for (const prio of [0, 3, 7]) {
    for (const topic of [0, 4, 7]) {
      for (const source of [0, 1, 17, 31]) {
        const id = baseId({ prio, topic, source });
        assert.ok(id <= 0x7ff);
        assert.deepEqual(parseBaseId(id), { prio, topic, source });
      }
    }
  }
});

test('extended identifiers pack and unpack across the full 29-bit range', () => {
  const cases = [
    { prio: 0, type: 0, dest: 0, source: 0, flags: 0 },
    { prio: 7, type: 31, dest: 255, source: 255, flags: 31 },
    { prio: 4, type: 6, dest: 12, source: 7, flags: 0x10 },
  ];
  for (const c of cases) {
    const id = extendedId(c);
    assert.ok(id <= 0x1fffffff, `${id.toString(16)}`);
    assert.deepEqual(parseExtendedId(id), c);
  }
});

test('source in the low bits makes identical arbitration fields impossible', () => {
  // Two nodes with the same priority and topic still differ, because SOURCE
  // occupies the least significant bits (Part 2 §1.1).
  const a = baseId({ prio: PRIO.NORMAL, topic: TOPIC.STATE, source: 3 });
  const b = baseId({ prio: PRIO.NORMAL, topic: TOPIC.STATE, source: 9 });
  assert.notEqual(a, b);
  assert.ok(arbitrationKey({ id: a, extended: false, rtr: false })
          < arbitrationKey({ id: b, extended: false, rtr: false }),
    'the lower address wins the tiebreak');
});

test('priority ordering dominates topic and source', () => {
  const urgent = baseId({ prio: PRIO.EMERGENCY, topic: TOPIC.EVENT, source: 31 });
  const bulk = baseId({ prio: PRIO.BULK, topic: TOPIC.CONTROL, source: 0 });
  assert.ok(urgent < bulk);
});

test('describeId renders both formats without asserting Part 2 is in use', () => {
  const b = describeId({ id: baseId({ prio: 2, topic: TOPIC.TEXT, source: 5 }), extended: false });
  assert.equal(b.kind, 'base');
  assert.equal(b.typeName, 'TEXT');
  assert.equal(b.source, 5);

  const e = describeId({ id: extendedId({ prio: 1, type: TOPIC.DATA, dest: BROADCAST_EXT, source: 9 }), extended: true });
  assert.equal(e.kind, 'extended');
  assert.equal(e.destName, 'all');
  assert.equal(e.source, 9);
});

test('short payloads become a single frame', () => {
  for (let n = 0; n <= 7; n++) {
    const frames = segment(new Uint8Array(n).fill(0x41));
    assert.equal(frames.length, 1);
    assert.equal(frames[0][0] >> 4, PCI.SINGLE);
    assert.equal(frames[0][0] & 0x0f, n);
    assert.equal(frames[0].length, n + 1);
  }
});

test('segmentation and reassembly round-trip at every length', () => {
  for (const n of [0, 1, 7, 8, 13, 14, 20, 100, 255, 1000, MAX_TRANSFER]) {
    const src = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);
    const frames = segment(src);
    for (const f of frames) assert.ok(f.length <= 8, `frame of ${f.length} octets`);

    const r = new Reassembler();
    let out = null;
    for (const f of frames) {
      const res = r.push(f);
      assert.ok(!res.error, `${n}: ${res.error}`);
      if (res.done) out = res.data;
    }
    assert.ok(out, `${n} octets never completed`);
    assert.deepEqual(Array.from(out), Array.from(src), `${n} octets`);
  }
});

test('sequence numbers wrap past 15 without confusing the reassembler', () => {
  const src = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);
  const frames = segment(src);
  assert.ok(frames.length > 17, 'this transfer really does wrap the sequence counter');
  const r = new Reassembler();
  let out = null;
  for (const f of frames) { const res = r.push(f); if (res.done) out = res.data; }
  assert.deepEqual(Array.from(out), Array.from(src));
});

test('a dropped middle frame is detected, not silently reassembled', () => {
  const src = Uint8Array.from({ length: 60 }, (_, i) => i);
  const frames = segment(src);
  const r = new Reassembler();
  let error = null;
  frames.forEach((f, i) => {
    if (i === 3) return;                       // drop one
    const res = r.push(f);
    if (res.error && !error) error = res.error;
  });
  assert.match(error || '', /sequence gap/);
});

test('a transfer larger than the 12-bit length field is refused', () => {
  assert.throws(() => segment(new Uint8Array(MAX_TRANSFER + 1)), /exceeds 4095/);
});

test('ANNOUNCE round-trips including the callsign', () => {
  const a = parseAnnounce(buildAnnounce('ada'));
  assert.equal(a.version, 0x10);
  assert.equal(a.callsign, 'ada');
  assert.ok(a.segmented && a.text);

  const long = parseAnnounce(buildAnnounce('abcdefghij'));
  assert.equal(long.callsign.length, 6, 'callsign is truncated to the field width');
});

test('a Session carries text end to end over a real bus, segmenting as needed', () => {
  const pa = new Protocol({ name: 'a' });
  const pb = new Protocol({ name: 'b' });
  const bus = new IdealBus([pa, pb]);
  const a = new Session(pa, { address: 7, callsign: 'ada' });
  const b = new Session(pb, { address: 12, callsign: 'bob' });

  const messages = [];
  b.on('message', (m) => messages.push(m));
  const presence = [];
  b.on('presence', (p) => presence.push(p));

  a.announce();
  a.sendText('hi');
  a.sendText('hello, bus — this one has to be segmented across several frames');
  bus.run(20000);

  assert.equal(presence.length, 1);
  assert.equal(presence[0].address, 7);
  assert.equal(presence[0].announce.callsign, 'ada');

  assert.equal(messages.length, 2);
  assert.equal(messages[0].source, 7);
  assert.equal(messages[0].text, 'hi');
  assert.equal(messages[1].text, 'hello, bus — this one has to be segmented across several frames');
});

test('two sessions talking at once interleave without corrupting either message', () => {
  const pa = new Protocol({ name: 'a' });
  const pb = new Protocol({ name: 'b' });
  const bus = new IdealBus([pa, pb]);
  const a = new Session(pa, { address: 3, callsign: 'a' });
  const b = new Session(pb, { address: 20, callsign: 'b' });

  const atB = [];
  const atA = [];
  b.on('message', (m) => atB.push(m));
  a.on('message', (m) => atA.push(m));

  bus.run(12);
  a.sendText('message from three, long enough to need segmenting properly');
  b.sendText('message from twenty, also long enough to need several frames');
  bus.run(60000);

  assert.equal(atB.length, 1);
  assert.equal(atA.length, 1);
  assert.equal(atB[0].text, 'message from three, long enough to need segmenting properly');
  assert.equal(atA[0].text, 'message from twenty, also long enough to need several frames');
  assert.equal(pa.stats.crcErrors + pb.stats.crcErrors, 0);
});

test('binary payloads that are not valid UTF-8 are surfaced as bytes', () => {
  const pa = new Protocol({ name: 'a' });
  const pb = new Protocol({ name: 'b' });
  const bus = new IdealBus([pa, pb]);
  const a = new Session(pa, { address: 1 });
  const b = new Session(pb, { address: 2 });

  const got = [];
  b.on('message', (m) => got.push(m));

  const bytes = Uint8Array.from([0xff, 0xfe, 0x00, 0x80, 0x41]);
  for (const f of segment(bytes)) pa.send({ id: baseId({ topic: TOPIC.TRANSPORT, source: 1 }), data: f });
  bus.run(5000);

  assert.equal(got.length, 1);
  assert.equal(got[0].text, null, 'not decoded as text');
  assert.deepEqual(Array.from(got[0].data), Array.from(bytes));
});
