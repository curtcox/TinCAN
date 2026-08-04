/**
 * TinCAN CRC-17 — spec §6.10.
 *
 *   width       17
 *   polynomial  0x1685B  (x^17 + x^16 + x^14 + x^13 + x^11 + x^6 + x^4 + x^3 + x + 1)
 *   init        0x00000
 *   refin/out   no
 *   xorout      0x00000
 *
 * Input is the de-stuffed bit sequence from SOF through the last DATA bit,
 * most significant bit first.
 */

export const CRC_WIDTH = 17;
export const CRC_POLY = 0x1685b;
export const CRC_INIT = 0x00000;
export const CRC_MASK = (1 << CRC_WIDTH) - 1; // 0x1FFFF
const TOP_BIT = 1 << (CRC_WIDTH - 1);         // 0x10000

/**
 * @param {ArrayLike<number>} bits bit values, 0 or 1, MSB first
 * @returns {number} 17-bit CRC
 */
export function crc17(bits) {
  let reg = CRC_INIT;
  for (let i = 0; i < bits.length; i++) {
    const inBit = bits[i] & 1;
    const outBit = (reg & TOP_BIT) ? 1 : 0;
    reg = (reg << 1) & CRC_MASK;
    if (inBit ^ outBit) reg ^= CRC_POLY & CRC_MASK;
  }
  return reg & CRC_MASK;
}

/** Incremental form, for feeding a CRC one bit at a time while receiving. */
export class Crc17 {
  constructor() { this.reg = CRC_INIT; }
  reset() { this.reg = CRC_INIT; return this; }
  push(bit) {
    const outBit = (this.reg & TOP_BIT) ? 1 : 0;
    this.reg = (this.reg << 1) & CRC_MASK;
    if ((bit & 1) ^ outBit) this.reg ^= CRC_POLY & CRC_MASK;
    return this;
  }
  get value() { return this.reg & CRC_MASK; }
}
