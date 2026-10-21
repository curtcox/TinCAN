/**
 * Generate the published test-vector page from the reference implementation,
 * so the specification and the code cannot disagree about what a frame looks
 * like on the wire. Run by tools/build-site.mjs; asserted by test/vectors.test.mjs.
 */

import { crc17 } from '../src/tincan/crc.js';
import { buildCore, buildTransmission } from '../src/tincan/frame.js';
import { timing, PROFILES, BANDS, maxRange, nearFarMarginDb, minTqMs } from '../src/tincan/params.js';

/** The frames whose vectors are published. Keep this list stable. */
export const VECTOR_FRAMES = [
  { label: 'empty base data frame', frame: { id: 0x000, data: [] } },
  { label: 'base data frame, one octet', frame: { id: 0x123, data: [0xa5] } },
  { label: 'base data frame, eight octets', frame: { id: 0x400, data: [0, 1, 2, 3, 4, 5, 6, 7] } },
  { label: 'highest base identifier, all ones payload', frame: { id: 0x7ff, data: [0xff, 0xff] } },
  { label: 'base remote frame', frame: { id: 0x001, rtr: true, dlc: 8 } },
  { label: 'extended data frame', frame: { id: 0x1abcdef, extended: true, data: [0xde, 0xad, 0xbe, 0xef] } },
  { label: 'highest extended identifier', frame: { id: 0x1fffffff, extended: true, data: [0x00] } },
  { label: 'FDF frame, 12 octets', frame: { id: 0x2aa, fdf: true, data: Array.from({ length: 12 }, (_, i) => i * 17 & 0xff) } },
  { label: 'worst case for stuffing: all-zero payload', frame: { id: 0x000, data: new Array(8).fill(0x00) } },
  { label: 'worst case for stuffing: all-one payload', frame: { id: 0x7ff, data: new Array(8).fill(0xff) } },
];

export const CRC_BIT_VECTORS = [
  { label: 'empty input', bits: [] },
  { label: 'a single dominant bit', bits: [0] },
  { label: 'a single recessive bit', bits: [1] },
  { label: 'eight alternating bits', bits: [0, 1, 0, 1, 0, 1, 0, 1] },
  { label: 'sixteen dominant bits', bits: new Array(16).fill(0) },
  { label: 'sixteen recessive bits', bits: new Array(16).fill(1) },
];

const hex17 = (v) => `0x${v.toString(16).toUpperCase().padStart(5, '0')}`;

function bitString(bits) {
  return bits.map((b) => b).join('');
}

/** Group a bit string for readability without changing its meaning. */
function grouped(bits, size = 8) {
  const s = bitString(bits);
  const parts = [];
  for (let i = 0; i < s.length; i += size) parts.push(s.slice(i, i + size));
  return parts.join(' ');
}

export function buildVectors() {
  const L = [];
  const p = (s = '') => L.push(s);

  p('# TinCAN 1.0 — Test Vectors');
  p();
  p('**Generated from the reference implementation at build time.** These values are');
  p('not maintained by hand; `tools/gen-vectors.mjs` produces this page and');
  p('`test/vectors.test.mjs` asserts them, so if the implementation changes behaviour');
  p('either this page changes with it or the test suite fails.');
  p();
  p('Bits are written most significant first, `0` = dominant, `1` = recessive,');
  p('exactly as they go on the wire.');
  p();
  p('---');
  p();

  /* -------------------------------------------------------------- */
  p('## CRC-17');
  p();
  p('Polynomial `0x1685B`, initial value `0x00000`, no reflection, no final XOR');
  p('([Part 1 §6.10](tincan-1.0.html#610-crc)). Input is the de-stuffed bit sequence');
  p('from `SOF` through the last `DATA` bit.');
  p();
  p('### Raw bit sequences');
  p();
  p('These exercise the CRC register directly and do not correspond to legal frames.');
  p();
  p('| Input | Bits | CRC-17 |');
  p('|---|---|---|');
  for (const v of CRC_BIT_VECTORS) {
    p(`| ${v.label} | \`${v.bits.length ? grouped(v.bits) : '(none)'}\` | \`${hex17(crc17(v.bits))}\` |`);
  }
  p();

  /* -------------------------------------------------------------- */
  p('## Frames');
  p();
  p('For each frame: the fields as encoded, the CRC computed over `SOF`..`DATA`,');
  p('and the complete on-air bit sequence from `SYNC` through `IFS` including stuff');
  p('bits ([Part 1 §6.3](tincan-1.0.html#63-data-frame), [§6.9](tincan-1.0.html#69-bit-stuffing)).');
  p();

  for (const v of VECTOR_FRAMES) {
    const core = buildCore(v.frame);
    const tx = buildTransmission(v.frame);
    const f = tx.frame;

    p(`### ${v.label}`);
    p();
    p('| Property | Value |');
    p('|---|---|');
    p(`| Identifier | \`0x${f.id.toString(16).toUpperCase().padStart(f.extended ? 8 : 3, '0')}\` (${f.extended ? 'extended, 29-bit' : 'base, 11-bit'}) |`);
    p(`| Kind | ${f.rtr ? 'remote' : 'data'}${f.fdf ? ', FDF' : ''} |`);
    p(`| DLC | ${f.dlc} (${f.data.length} octets) |`);
    if (!f.rtr && f.data.length) {
      p(`| Payload | \`${Array.from(f.data).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}\` |`);
    }
    p(`| CRC-17 | \`${hex17(tx.crc)}\` |`);
    p(`| CRC input length | ${core.crcInputLength} bits |`);
    p(`| De-stuffed length | ${tx.bits.length - tx.stuffCount} bits |`);
    p(`| Stuff bits | ${tx.stuffCount} |`);
    p(`| On-air length | ${tx.bits.length} bits |`);
    p(`| Arbitration field ends at | bit ${tx.arbitrationEnd} |`);
    for (const [key, prof] of Object.entries(PROFILES)) {
      if (key !== 'T25') continue;
      p(`| Air time at T25 | ${(tx.bits.length / timing(prof).bitRate).toFixed(2)} s |`);
    }
    p();
    p('CRC input (de-stuffed, `SOF` through last `DATA` bit):');
    p();
    p('```');
    p(grouped(core.bits.slice(0, core.crcInputLength)));
    p('```');
    p();
    p('On-air bit sequence (`SYNC` through `IFS`, stuff bits included):');
    p();
    p('```');
    p(grouped(tx.bits));
    p('```');
    p();
  }

  /* -------------------------------------------------------------- */
  p('## Derived parameters');
  p();
  p('Every number here is computed from the band and profile tables of');
  p('[Part 1 §4.2](tincan-1.0.html#42-band-plans) and');
  p('[§5.2](tincan-1.0.html#52-bit-timing-profiles), not transcribed.');
  p();
  p('### Bands');
  p();
  p('| Band | `f_R` | `f_D` | Guards | Separation | Shortest `TQ` |');
  p('|---|---|---|---|---|---|');
  for (const b of Object.values(BANDS)) {
    p(`| ${b.name} | ${b.fR} Hz | ${b.fD} Hz | ${b.guardLo} / ${b.guardHi} Hz | ${b.fD - b.fR} Hz | ${minTqMs(b)} ms |`);
  }
  p();
  p('### Bit timing');
  p();
  p('| Profile | `TQ` | `T_bit` | Rate | Sample point | Window `W` | Max range |');
  p('|---|---|---|---|---|---|---|');
  for (const [key, prof] of Object.entries(PROFILES)) {
    const t = timing(prof);
    p(`| ${key} | ${prof.tqMs} ms | ${(t.bitTime * 1000).toFixed(0)} ms `
      + `| ${t.bitRate.toFixed(1)} bit/s | ${(t.samplePointFraction * 100).toFixed(0)} % `
      + `| ${(t.window * 1000).toFixed(0)} ms | ${maxRange(key).toFixed(2)} m |`);
  }
  p();
  p(`Near-far margin at the default \`theta_D\`: **${nearFarMarginDb().toFixed(2)} dB**`);
  p(`(a free-field distance ratio of ${(1 / Math.pow(10, nearFarMarginDb() / 20)).toFixed(2)}:1).`);
  p();
  p('### Frame air time');
  p();
  p('Base data frames, excluding stuff bits.');
  p();
  p('| Payload | Bits | ' + Object.keys(PROFILES).join(' | ') + ' |');
  p('|---|---|' + Object.keys(PROFILES).map(() => '---').join('|') + '|');
  for (const n of [0, 1, 2, 4, 8]) {
    const bits = 59 + 8 * n;
    p(`| ${n} B | ${bits} | `
      + Object.keys(PROFILES).map((k) => `${(bits / timing(k).bitRate).toFixed(2)} s`).join(' | ')
      + ' |');
  }
  p();

  return L.join('\n');
}
