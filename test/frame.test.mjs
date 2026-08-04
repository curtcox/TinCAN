import test from 'node:test';
import assert from 'node:assert/strict';

import { crc17, Crc17 } from '../src/tincan/crc.js';
import {
  buildCore, buildTransmission, stuff, dlcToLength, lengthToDlc,
  FrameDecoder, RX, SYNC_FIELD, normalizeFrame,
} from '../src/tincan/frame.js';

test('CRC-17 is deterministic and 17 bits wide', () => {
  const bits = [0, 1, 1, 0, 1, 0, 0, 1];
  const v = crc17(bits);
  assert.equal(v, crc17(bits));
  assert.ok(v >= 0 && v <= 0x1ffff);
});

test('CRC-17 incremental form matches the block form', () => {
  const bits = Array.from({ length: 137 }, (_, i) => (i * 7 + 3) % 5 === 0 ? 1 : 0);
  const inc = new Crc17();
  for (const b of bits) inc.push(b);
  assert.equal(inc.value, crc17(bits));
});

test('CRC-17 detects every single-bit error in a 123-bit frame', () => {
  const bits = Array.from({ length: 123 }, (_, i) => (i % 3 === 0 ? 1 : 0));
  const good = crc17(bits);
  for (let i = 0; i < bits.length; i++) {
    const bad = bits.slice();
    bad[i] ^= 1;
    assert.notEqual(crc17(bad), good, `single-bit error at ${i} went undetected`);
  }
});

test('CRC-17 detects every double-bit error in a 64-bit frame', () => {
  const bits = Array.from({ length: 64 }, (_, i) => (i % 5 === 0 ? 1 : 0));
  const good = crc17(bits);
  for (let i = 0; i < bits.length; i++) {
    for (let j = i + 1; j < bits.length; j++) {
      const bad = bits.slice();
      bad[i] ^= 1; bad[j] ^= 1;
      assert.notEqual(crc17(bad), good, `double-bit error at ${i},${j} went undetected`);
    }
  }
});

test('DLC table round-trips', () => {
  for (let d = 0; d <= 8; d++) assert.equal(lengthToDlc(dlcToLength(d, false)), d);
  for (let d = 9; d <= 15; d++) {
    assert.equal(dlcToLength(d, false), null, `DLC ${d} must be invalid with FDF=0`);
    assert.equal(lengthToDlc(dlcToLength(d, true)), d);
  }
});

test('bit stuffing inserts after five identical bits', () => {
  const { bits, stuffedAt } = stuff([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  // 0*5 -> stuff 1 -> 0*5 -> stuff 1
  assert.deepEqual(bits, [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(stuffedAt, [5, 11]);
});

test('bit stuffing never leaves six identical bits on the wire', () => {
  for (let seed = 0; seed < 300; seed++) {
    const src = Array.from({ length: 90 }, (_, i) => ((seed * 31 + i * 17) % 11) < 8 ? 0 : 1);
    const { bits } = stuff(src);
    let run = 1;
    for (let i = 1; i < bits.length; i++) {
      run = bits[i] === bits[i - 1] ? run + 1 : 1;
      assert.ok(run <= 5, `run of ${run} at ${i} (seed ${seed})`);
    }
  }
});

test('base data frame has the field layout of spec §6.3', () => {
  const core = buildCore({ id: 0x123, data: [0xa5] });
  const names = core.fields.map((f) => `${f.name}:${f.length}`);
  assert.deepEqual(names, [
    'SOF:1', 'ID:11', 'RTR:1', 'IDE:1', 'FDF:1', 'r0:1', 'DLC:4', 'DATA[0]:8', 'CRC:17',
  ]);
  assert.equal(core.bits.length, 1 + 11 + 1 + 1 + 1 + 1 + 4 + 8 + 17);
});

test('extended data frame has the field layout of spec §6.3', () => {
  const core = buildCore({ id: 0x1abcdef, extended: true, data: [1, 2] });
  const names = core.fields.map((f) => f.name);
  assert.deepEqual(names, [
    'SOF', 'ID_A', 'SRR', 'IDE', 'ID_B', 'RTR', 'FDF', 'r1', 'r0', 'DLC', 'DATA[0]', 'DATA[1]', 'CRC',
  ]);
});

test('frame lengths match Appendix A', () => {
  // 59 + 8n for base, 79 + 8n for extended, before stuffing.
  const base = (n) => buildTransmission({ id: 0, data: new Uint8Array(n) });
  for (const n of [0, 1, 4, 8]) {
    const tx = base(n);
    assert.equal(tx.bits.length - tx.stuffCount, 59 + 8 * n, `base ${n} octets`);
  }
  for (const n of [0, 8]) {
    const tx = buildTransmission({ id: 0, extended: true, data: new Uint8Array(n) });
    assert.equal(tx.bits.length - tx.stuffCount, 79 + 8 * n, `extended ${n} octets`);
  }
});

test('transmission begins with the SYNC field and ends with EOF + IFS', () => {
  const tx = buildTransmission({ id: 0x100, data: [1, 2, 3] });
  assert.deepEqual(tx.bits.slice(0, 8), SYNC_FIELD);
  assert.deepEqual(tx.bits.slice(-10), [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]); // EOF(7) + IFS(3)
  assert.equal(tx.map[8], 'SOF');
});

test('the arbitration field ends at IDE for base and RTR for extended', () => {
  const b = buildTransmission({ id: 0x2aa, data: [] });
  // 8 SYNC + SOF + 11 ID + RTR + IDE = 22 bits, plus any stuff bits inside.
  assert.ok(b.arbitrationEnd >= 22 && b.arbitrationEnd <= 26, `got ${b.arbitrationEnd}`);
  assert.equal(b.map[b.arbitrationEnd - 1], 'IDE');

  const e = buildTransmission({ id: 0x1234567, extended: true, data: [] });
  assert.equal(e.map[e.arbitrationEnd - 1], 'RTR');
});

/** Feed a transmission's stuffed bits into a fresh decoder, de-stuffing. */
function decodeTransmission(tx, { strict = false } = {}) {
  const dec = new FrameDecoder({ strict });
  let run = 0, last = -1, expectStuff = false, result = RX.NEED_MORE;
  for (let i = SYNC_FIELD.length; i < tx.bits.length; i++) {
    const b = tx.bits[i];
    if (expectStuff) { expectStuff = false; last = b; run = 1; continue; }
    if (b === last) run++; else { last = b; run = 1; }
    if (run >= 5) expectStuff = true;
    result = dec.push(b);
    if (result !== RX.NEED_MORE) break;
  }
  return { result, dec };
}

test('every frame shape round-trips through the decoder', () => {
  const cases = [
    { id: 0x000, data: [] },
    { id: 0x7ff, data: [0xff] },
    { id: 0x123, data: [0xa5, 0x5a] },
    { id: 0x400, data: [0, 1, 2, 3, 4, 5, 6, 7] },
    { id: 0x001, rtr: true, dlc: 8 },
    { id: 0x1fffffff, extended: true, data: [1, 2, 3] },
    { id: 0x00000000, extended: true, data: [] },
    { id: 0x0abcdef, extended: true, rtr: true, dlc: 4 },
    { id: 0x555, fdf: true, data: new Uint8Array(64).fill(0xa5) },
    { id: 0x2aa, fdf: true, data: new Uint8Array(12).fill(0x00) },
  ];
  for (const c of cases) {
    const tx = buildTransmission(c);
    const { result, dec } = decodeTransmission(tx);
    assert.equal(result, RX.DONE, `${JSON.stringify(c)} -> ${result} (${dec.error})`);
    const want = normalizeFrame(c);
    assert.equal(dec.frame.id, want.id);
    assert.equal(dec.frame.extended, want.extended);
    assert.equal(dec.frame.rtr, want.rtr);
    assert.equal(dec.frame.dlc, want.dlc);
    assert.deepEqual(Array.from(dec.frame.data), Array.from(want.data));
    assert.equal(dec.receivedCrc, tx.crc);
  }
});

test('a corrupted data bit produces a CRC error, not a silent decode', () => {
  const tx = buildTransmission({ id: 0x321, data: [0x11, 0x22, 0x33, 0x44] });
  const dataBit = tx.map.findIndex((m) => m === 'DATA[1]');
  const bad = { ...tx, bits: tx.bits.slice() };
  bad.bits[dataBit] ^= 1;
  const { result } = decodeTransmission(bad);
  assert.equal(result, RX.CRC_ERROR);
});

test('DLC 9 with FDF=0 is a form error on the wire', () => {
  const tx = buildTransmission({ id: 0x100, fdf: true, data: new Uint8Array(12) });
  const fdfBit = tx.map.indexOf('FDF');
  const bad = { ...tx, bits: tx.bits.slice() };
  bad.bits[fdfBit] = 0;              // claim classic while DLC says 12 octets
  const { result, dec } = decodeTransmission(bad);
  assert.equal(result, RX.FORM_ERROR);
  assert.match(dec.error, /DLC 9 invalid/);
});

test('identifiers wider than the format are rejected', () => {
  assert.throws(() => buildCore({ id: 0x800, data: [] }), /exceeds 11 bits/);
  assert.throws(() => buildCore({ id: 0x20000000, extended: true, data: [] }), /exceeds 29 bits/);
});
