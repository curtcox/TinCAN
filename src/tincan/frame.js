/**
 * TinCAN frame construction, bit stuffing, and incremental decoding.
 * Spec §6.
 *
 * Bit polarity throughout: 0 = dominant, 1 = recessive.
 */

import { crc17, Crc17 } from './crc.js';

export const SYNC_FIELD = [0, 1, 0, 1, 0, 1, 0, 1];
export const EOF_BITS = 7;
export const IFS_BITS = 3;
export const ACK_BITS = 2;
export const STUFF_RUN = 5;   // insert after this many identical bits
export const ERROR_FLAG_BITS = 6;
export const ERROR_DELIM_BITS = 8;

/** DLC code -> payload octets. Codes 9..15 require FDF = 1. */
export const DLC_TABLE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];

export function dlcToLength(dlc, fdf) {
  if (dlc < 0 || dlc > 15) return null;
  if (dlc > 8 && !fdf) return null;
  return DLC_TABLE[dlc];
}

export function lengthToDlc(len) {
  const i = DLC_TABLE.indexOf(len);
  if (i >= 0) return i;
  // round up to the next representable size
  for (let d = 0; d < DLC_TABLE.length; d++) if (DLC_TABLE[d] >= len) return d;
  return null;
}

/**
 * @typedef {object} Frame
 * @property {number} id            11-bit (base) or 29-bit (extended) identifier
 * @property {boolean} [extended]   IDE
 * @property {boolean} [rtr]        remote frame
 * @property {boolean} [fdf]        extended payload lengths permitted
 * @property {number} [dlc]         explicit DLC; derived from data when absent
 * @property {Uint8Array|number[]} [data]
 */

export function normalizeFrame(frame) {
  const extended = !!frame.extended;
  const rtr = !!frame.rtr;
  const fdf = !!frame.fdf;
  const data = rtr ? new Uint8Array(0) : Uint8Array.from(frame.data || []);
  let dlc = frame.dlc;
  if (dlc === undefined || dlc === null) {
    dlc = rtr ? 0 : lengthToDlc(data.length);
    if (dlc === null) throw new Error(`payload of ${data.length} octets has no DLC`);
  }
  const len = dlcToLength(dlc, fdf);
  if (len === null) throw new Error(`DLC ${dlc} is invalid with FDF=${fdf ? 1 : 0}`);

  const id = frame.id >>> 0;
  const maxId = extended ? 0x1fffffff : 0x7ff;
  if (id > maxId) {
    throw new Error(`identifier 0x${id.toString(16)} exceeds ${extended ? 29 : 11} bits`);
  }

  // DLC 9..15 name sizes with no smaller representation; pad short payloads.
  if (!rtr && data.length !== len) {
    const padded = new Uint8Array(len);
    padded.set(data.subarray(0, Math.min(len, data.length)));
    return { id, extended, rtr, fdf, dlc, data: padded };
  }
  return { id, extended, rtr, fdf, dlc, data };
}

function pushField(out, fields, name, value, width) {
  const start = out.length;
  for (let i = width - 1; i >= 0; i--) out.push((value >>> i) & 1);
  fields.push({ name, start, length: width, value });
}

/**
 * Build the CRC-protected, de-stuffed bit sequence SOF..DATA, then append the
 * CRC. Returns the bits plus a field map, for analyzers.
 */
export function buildCore(frame) {
  const f = normalizeFrame(frame);
  const bits = [];
  const fields = [];

  pushField(bits, fields, 'SOF', 0, 1);
  if (!f.extended) {
    pushField(bits, fields, 'ID', f.id, 11);
    pushField(bits, fields, 'RTR', f.rtr ? 1 : 0, 1);
    pushField(bits, fields, 'IDE', 0, 1);
    pushField(bits, fields, 'FDF', f.fdf ? 1 : 0, 1);
    pushField(bits, fields, 'r0', 0, 1);
  } else {
    pushField(bits, fields, 'ID_A', (f.id >>> 18) & 0x7ff, 11);
    pushField(bits, fields, 'SRR', 1, 1);
    pushField(bits, fields, 'IDE', 1, 1);
    pushField(bits, fields, 'ID_B', f.id & 0x3ffff, 18);
    pushField(bits, fields, 'RTR', f.rtr ? 1 : 0, 1);
    pushField(bits, fields, 'FDF', f.fdf ? 1 : 0, 1);
    pushField(bits, fields, 'r1', 0, 1);
    pushField(bits, fields, 'r0', 0, 1);
  }
  pushField(bits, fields, 'DLC', f.dlc, 4);
  if (!f.rtr) {
    for (let i = 0; i < f.data.length; i++) {
      pushField(bits, fields, `DATA[${i}]`, f.data[i], 8);
    }
  }
  const crc = crc17(bits);
  pushField(bits, fields, 'CRC', crc, 17);
  return { frame: f, bits, fields, crc, crcInputLength: bits.length - 17 };
}

/** Apply bit stuffing to a bit array — spec §6.9. */
export function stuff(bits) {
  const out = [];
  const stuffedAt = [];
  let run = 0;
  let last = -1;
  for (let i = 0; i < bits.length; i++) {
    const b = bits[i];
    if (b === last) run++; else { run = 1; last = b; }
    out.push(b);
    if (run === STUFF_RUN) {
      out.push(b ^ 1);
      stuffedAt.push(out.length - 1);
      last = b ^ 1;
      run = 1;
    }
  }
  return { bits: out, stuffedAt };
}

/**
 * The complete on-air bit sequence for a frame, from SYNC through IFS.
 * `map` gives, for every transmitted bit index, the field it belongs to.
 */
export function buildTransmission(frame) {
  const core = buildCore(frame);
  const { bits: stuffed, stuffedAt } = stuff(core.bits);
  const stuffSet = new Set(stuffedAt);

  // map de-stuffed index -> field name
  const nameAt = new Array(core.bits.length);
  for (const fld of core.fields) {
    for (let i = 0; i < fld.length; i++) nameAt[fld.start + i] = fld.name;
  }

  const bits = [];
  const map = [];
  const add = (b, name) => { bits.push(b); map.push(name); };

  for (const b of SYNC_FIELD) add(b, 'SYNC');
  let core_i = 0;
  for (let i = 0; i < stuffed.length; i++) {
    if (stuffSet.has(i)) { add(stuffed[i], 'STUFF'); }
    else { add(stuffed[i], nameAt[core_i]); core_i++; }
  }
  add(1, 'CRC_DELIM');
  for (let i = 0; i < ACK_BITS; i++) add(1, 'ACK');
  add(1, 'ACK_DELIM');
  for (let i = 0; i < EOF_BITS; i++) add(1, 'EOF');
  for (let i = 0; i < IFS_BITS; i++) add(1, 'IFS');

  return {
    frame: core.frame,
    crc: core.crc,
    bits,
    map,
    fields: core.fields,
    stuffCount: stuffedAt.length,
    /** index of the first bit that is no longer part of the arbitration field */
    arbitrationEnd: SYNC_FIELD.length + arbitrationLengthStuffed(core, stuffSet),
    syncLength: SYNC_FIELD.length,
  };
}

/** Length of the arbitration field in *stuffed* bits — spec §7.2. */
function arbitrationLengthStuffed(core, stuffSet) {
  // Arbitration field: SOF..IDE for base frames, SOF..RTR for extended.
  const lastName = core.frame.extended ? 'RTR' : 'IDE';
  const fld = core.fields.find((f) => f.name === lastName);
  const destuffedEnd = fld.start + fld.length; // exclusive
  let count = 0;
  let seen = 0;
  let i = 0;
  while (seen < destuffedEnd) {
    if (!stuffSet.has(i)) seen++;
    i++; count++;
  }
  return count;
}

export function frameBitLength(frame) {
  return buildTransmission(frame).bits.length;
}

/* ------------------------------------------------------------------ */
/* Incremental receive-side decoder                                    */
/* ------------------------------------------------------------------ */

export const RX = {
  NEED_MORE: 'need-more',
  DONE: 'done',
  FORM_ERROR: 'form-error',
  CRC_ERROR: 'crc-error',
};

/**
 * Consumes de-stuffed bits from SOF onward and reports when the CRC field has
 * been fully received, along with the parsed frame. Stuffing removal, fixed-form
 * fields and acknowledgement are handled by the protocol engine, not here.
 */
export class FrameDecoder {
  constructor({ strict = false } = {}) {
    this.strict = strict;
    this.reset();
  }

  reset() {
    this.bits = [];
    this.crc = new Crc17();
    this.state = 'SOF';
    this.frame = { id: 0, extended: false, rtr: false, fdf: false, dlc: 0, data: [] };
    this.idA = 0; this.idB = 0;
    this.need = 1;
    this.acc = 0;
    this.count = 0;
    this.dataBytes = 0;
    this.byteIndex = 0;
    this.receivedCrc = 0;
    this.computedCrc = 0;
    this.error = null;
    this.fields = [];
    this.fieldStart = 0;
    return this;
  }

  /** @returns {string} one of RX.* */
  push(bit) {
    bit &= 1;
    this.bits.push(bit);
    if (this.state !== 'CRC') this.crc.push(bit);

    this.acc = (this.acc * 2) + bit;
    this.count++;
    if (this.count < this.need) return RX.NEED_MORE;

    const value = this.acc;
    this.acc = 0;
    const consumed = this.count;
    this.count = 0;
    const start = this.fieldStart;
    this.fieldStart += consumed;
    const emit = (name) => this.fields.push({ name, start, length: consumed, value });

    switch (this.state) {
      case 'SOF':
        emit('SOF');
        if (value !== 0) return this._form('SOF not dominant');
        this.state = 'ID_A'; this.need = 11; return RX.NEED_MORE;

      case 'ID_A':
        emit('ID_A'); this.idA = value;
        this.state = 'RTR_SRR'; this.need = 1; return RX.NEED_MORE;

      case 'RTR_SRR':
        this._rtrOrSrr = value;
        emit('RTR/SRR');
        this.state = 'IDE'; this.need = 1; return RX.NEED_MORE;

      case 'IDE':
        emit('IDE');
        this.frame.extended = value === 1;
        if (!this.frame.extended) {
          this.frame.id = this.idA;
          this.frame.rtr = this._rtrOrSrr === 1;
          this.state = 'FDF'; this.need = 1;
        } else {
          if (this.strict && this._rtrOrSrr !== 1) return this._form('SRR not recessive');
          this.state = 'ID_B'; this.need = 18;
        }
        return RX.NEED_MORE;

      case 'ID_B':
        emit('ID_B'); this.idB = value;
        this.frame.id = (this.idA * 0x40000) + this.idB;
        this.state = 'RTR'; this.need = 1; return RX.NEED_MORE;

      case 'RTR':
        emit('RTR'); this.frame.rtr = value === 1;
        this.state = 'FDF'; this.need = 1; return RX.NEED_MORE;

      case 'FDF':
        emit('FDF'); this.frame.fdf = value === 1;
        this.state = this.frame.extended ? 'r1' : 'r0';
        this.need = 1; return RX.NEED_MORE;

      case 'r1':
        emit('r1');
        if (this.strict && value !== 0) return this._form('r1 not dominant');
        this.state = 'r0'; this.need = 1; return RX.NEED_MORE;

      case 'r0':
        emit('r0');
        if (this.strict && value !== 0) return this._form('r0 not dominant');
        this.state = 'DLC'; this.need = 4; return RX.NEED_MORE;

      case 'DLC': {
        emit('DLC');
        this.frame.dlc = value;
        const len = dlcToLength(value, this.frame.fdf);
        if (len === null) return this._form(`DLC ${value} invalid with FDF=${this.frame.fdf ? 1 : 0}`);
        this.dataBytes = this.frame.rtr ? 0 : len;
        this.byteIndex = 0;
        if (this.dataBytes === 0) { this.state = 'CRC'; this.need = 17; this.computedCrc = this.crc.value; }
        else { this.state = 'DATA'; this.need = 8; }
        return RX.NEED_MORE;
      }

      case 'DATA':
        emit(`DATA[${this.byteIndex}]`);
        this.frame.data.push(value);
        this.byteIndex++;
        if (this.byteIndex >= this.dataBytes) {
          this.state = 'CRC'; this.need = 17; this.computedCrc = this.crc.value;
        } else { this.need = 8; }
        return RX.NEED_MORE;

      case 'CRC':
        emit('CRC');
        this.receivedCrc = value;
        this.state = 'COMPLETE';
        this.frame.data = Uint8Array.from(this.frame.data);
        if (this.receivedCrc !== this.computedCrc) {
          this.error = `CRC mismatch: received 0x${this.receivedCrc.toString(16)}, computed 0x${this.computedCrc.toString(16)}`;
          return RX.CRC_ERROR;
        }
        return RX.DONE;

      default:
        return this._form(`unexpected bit in state ${this.state}`);
    }
  }

  _form(msg) {
    this.error = msg;
    this.state = 'ERROR';
    return RX.FORM_ERROR;
  }
}

/** Human-readable one-liner for a decoded frame. */
export function formatFrame(f) {
  const id = f.extended
    ? `0x${f.id.toString(16).padStart(8, '0').toUpperCase()}x`
    : `0x${f.id.toString(16).padStart(3, '0').toUpperCase()}`;
  const kind = f.rtr ? 'RTR' : 'DATA';
  const hex = Array.from(f.data || []).map((b) => b.toString(16).padStart(2, '0')).join(' ');
  return `${id} ${kind} dlc=${f.dlc}${hex ? ' [' + hex + ']' : ''}`;
}
