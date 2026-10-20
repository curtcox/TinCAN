/**
 * TinCAN data-link state machine — spec §6, §7, §8.
 *
 * This class is driven one bit at a time and knows nothing about time, audio,
 * or sample rates. The physical layer calls, per bit and in this order:
 *
 *     const level = protocol.beginBit();   // level to transmit, or null for idle
 *     ...                                   // PHY emits `level` for one bit time
 *     protocol.endBit(observedLevel, carrier);
 *
 * Arbitration, acknowledgement and error signalling all fall out of those two
 * calls, because the bus itself does the work (spec §3).
 */

import {
  SYNC_FIELD, EOF_BITS, IFS_BITS, ACK_BITS, STUFF_RUN,
  ERROR_FLAG_BITS, ERROR_DELIM_BITS,
  buildTransmission, FrameDecoder, RX,
} from './frame.js';

export const DOMINANT = 0;
export const RECESSIVE = 1;

export const STATE = {
  BUS_IDLE: 'bus-idle',
  SYNC: 'sync',
  FRAME: 'frame',
  CRC_DELIM: 'crc-delim',
  ACK: 'ack',
  ACK_DELIM: 'ack-delim',
  EOF: 'eof',
  INTERMISSION: 'intermission',
  SUSPEND: 'suspend',
  ERROR_FLAG: 'error-flag',
  ERROR_ECHO: 'error-echo',
  ERROR_DELIM: 'error-delim',
};

export const ERROR_STATE = {
  ACTIVE: 'error-active',
  PASSIVE: 'error-passive',
  BUS_OFF: 'bus-off',
};

const IDLE_BITS_COLD = 11;       // spec §4.5
const SUSPEND_BITS = 8;          // spec §6.8
const TEC_PASSIVE = 128;
const TEC_BUS_OFF = 256;
const TEC_ACK_ONLY_CLAMP = 255;  // spec §8.3 lone-node exception
const REC_PASSIVE = 128;
const BUS_OFF_RECOVERY_SEQUENCES = 128;

let SEQ = 1;

export class Protocol {
  /**
   * @param {object} [opts]
   * @param {'node'|'listener'} [opts.mode] listeners never transmit (spec §9.1)
   * @param {boolean} [opts.strict] treat recessive reserved bits as form errors
   * @param {boolean} [opts.autoRetransmit]
   * @param {boolean} [opts.autoBusOffRecovery]
   * @param {string} [opts.name] label used in events
   */
  constructor(opts = {}) {
    this.mode = opts.mode || 'node';
    this.name = opts.name || 'node';
    this.strict = !!opts.strict;
    this.autoRetransmit = opts.autoRetransmit !== false;
    this.autoBusOffRecovery = opts.autoBusOffRecovery !== false;

    this.tec = 0;
    this.rec = 0;
    this.errorState = ERROR_STATE.ACTIVE;
    this._ackOnlyErrors = true;
    this._busOffSequences = 0;
    this._recessiveRun = 0;

    this.txQueue = [];
    this.listeners = new Map();

    this.stats = {
      framesSent: 0, framesReceived: 0,
      arbitrationsLost: 0, arbitrationsWon: 0,
      bitErrors: 0, stuffErrors: 0, crcErrors: 0, formErrors: 0, ackErrors: 0,
      bitsObserved: 0, bitsDominant: 0, framesAbandoned: 0,
    };

    this.decoder = new FrameDecoder({ strict: this.strict });
    this._reset();
  }

  /* ---------------------------------------------------------------- */
  /* events                                                            */
  /* ---------------------------------------------------------------- */

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event).delete(fn);
  }

  emit(event, detail = {}) {
    const set = this.listeners.get(event);
    if (set) for (const fn of set) fn(detail);
    const all = this.listeners.get('*');
    if (all) for (const fn of all) fn({ event, node: this.name, ...detail });
  }

  /* ---------------------------------------------------------------- */
  /* public API                                                        */
  /* ---------------------------------------------------------------- */

  /** Queue a frame for transmission. Returns the queue item. */
  send(frame) {
    if (this.mode === 'listener') throw new Error('a listener may not transmit');
    const tx = buildTransmission(frame);
    const item = { seq: SEQ++, frame: tx.frame, tx, attempts: 0 };
    this.txQueue.push(item);
    this._sortQueue();
    this.emit('queued', { item });
    return item;
  }

  _sortQueue() {
    this.txQueue.sort((a, b) => arbitrationKey(a.frame) - arbitrationKey(b.frame) || a.seq - b.seq);
  }

  get queueLength() { return this.txQueue.length; }
  get transmitting() { return this.txItem !== null; }
  /** True while this node is inside the fixed-form SYNC field of its own frame. */
  get inTxSyncField() { return this.txItem !== null && this.state === STATE.SYNC; }

  /* ---------------------------------------------------------------- */
  /* bit engine                                                        */
  /* ---------------------------------------------------------------- */

  /** @returns {0|1|null} level to transmit for the bit now starting. */
  beginBit() {
    this.txLevel = this._decideTxLevel();
    return this.txLevel;
  }

  /**
   * @param {0|1} level   bus level read at the sample point
   * @param {boolean} carrier whether any carrier was present
   */
  endBit(level, carrier) {
    this.bitIndex++;
    this.stats.bitsObserved++;
    if (level === DOMINANT) this.stats.bitsDominant++;

    const tx = this.txLevel;
    this.txLevel = null;

    this.prevIdleCount = this.idleCount;
    if (!carrier) this.idleCount++; else this.idleCount = 0;
    if (this.errorState === ERROR_STATE.BUS_OFF) this._trackBusOffRecovery(carrier, level);

    this._handleBit(level, carrier, tx);
  }

  _handleBit(level, carrier, tx) {
    switch (this.state) {
      case STATE.BUS_IDLE:     this._bitBusIdle(level, carrier); break;
      case STATE.SYNC:         this._bitSync(level, carrier); break;
      case STATE.FRAME:        this._bitFrame(level, tx); break;
      case STATE.CRC_DELIM:    this._bitCrcDelim(level, tx); break;
      case STATE.ACK:          this._bitAck(level); break;
      case STATE.ACK_DELIM:    this._bitAckDelim(level, tx); break;
      case STATE.EOF:          this._bitEof(level); break;
      case STATE.INTERMISSION: this._bitIntermission(level, carrier); break;
      case STATE.SUSPEND:      this._bitSuspend(level, carrier); break;
      case STATE.ERROR_FLAG:   this._bitErrorFlag(); break;
      case STATE.ERROR_ECHO:   this._bitErrorEcho(level); break;
      case STATE.ERROR_DELIM:  this._bitErrorDelim(level); break;
    }
  }

  /* ---------------------------------------------------------------- */
  /* transmit-level decision                                           */
  /* ---------------------------------------------------------------- */

  _decideTxLevel() {
    switch (this.state) {
      case STATE.BUS_IDLE:
        if (this._mayStart()) { this._startTransmission(); return this.txItem.tx.bits[0]; }
        return null;

      case STATE.SYNC:
      case STATE.FRAME:
      case STATE.CRC_DELIM:
      case STATE.ACK_DELIM:
      case STATE.EOF:
        return this.txItem ? this.txItem.tx.bits[this.txIndex] : null;

      case STATE.ACK:
        // Spec §6.7: the transmitter falls silent, because its own recessive
        // tone at its own microphone would bury the acknowledgers' dominant.
        if (this.txItem) return null;
        return this.ackPending ? DOMINANT : null;

      case STATE.ERROR_FLAG:
        // Active nodes destroy the frame; passive nodes signal invisibly (§8.4).
        return this.errorState === ERROR_STATE.ACTIVE ? DOMINANT : null;

      default:
        return null;
    }
  }

  _mayStart() {
    if (this.mode === 'listener') return false;
    if (this.errorState === ERROR_STATE.BUS_OFF) return false;
    if (!this.txQueue.length) return false;
    return this.warmIdle || this.idleCount >= IDLE_BITS_COLD;
  }

  _startTransmission() {
    this.txItem = this.txQueue.shift();
    this.txItem.attempts++;
    this.txIndex = 0;
    this._enterSync();
    this.emit('tx-start', { item: this.txItem, attempt: this.txItem.attempts, frame: this.txItem.frame });
  }

  /* ---------------------------------------------------------------- */
  /* frame reception scaffolding                                       */
  /* ---------------------------------------------------------------- */

  /**
   * @param {object|null} [resume] for a receiver, where it was when the
   *   dominant bit arrived, so that an isolated noise bit can be undone
   */
  _enterSync(resume = null) {
    this.state = STATE.SYNC;
    this.syncIndex = 0;
    this.syncResume = resume;
    if (resume) this.justTransmitted = false;
    this.warmIdle = false;
    this.frameStartBit = this.bitIndex;
  }

  _enterFrameField() {
    this.state = STATE.FRAME;
    this.decoder.reset();
    this.destuffRun = 0;
    this.destuffLast = -1;
    this.expectStuffBit = false;
    this.rxWire = [];
    this.crcFailed = false;
    this.crcErrorPending = false;
    this.ackPending = false;
    this.ackSeen = RECESSIVE;
  }

  _bitBusIdle(level, carrier) {
    if (level === DOMINANT) {
      // Another node started; this is SYNC bit 0.
      this._enterSync(this._resumePoint());
      this._bitSync(level, carrier);
    }
  }

  _bitSync(level, carrier) {
    const index = this.syncIndex;
    if (this.txItem) {
      this.txIndex = index + 1;
    } else if (level !== SYNC_FIELD[index] || !carrier) {
      // Spec §6.2: recessive is a tone, so a SYNC bit with no carrier is as
      // malformed as one at the wrong level.
      const resume = this.syncResume;
      if (index === 1 && resume && !carrier) {
        // A lone dominant bit followed by silence is noise, not a frame.
        this._resumeAfterGlitch(resume);
        return;
      }
      if (index === 1 && level === DOMINANT && resume && resume.state === STATE.INTERMISSION) {
        // Two dominant bits where INTERMISSION was: an overload flag (§6.6).
        this.emit('overload', {});
        this.state = STATE.ERROR_ECHO;
        return;
      }
      // Abandon silently. Malformed SYNC is far more likely to be ambient
      // noise than a protocol violation.
      this.stats.framesAbandoned++;
      this.emit('abandoned', { reason: 'malformed SYNC', at: index });
      this._goIdle(false);
      return;
    }
    this.syncIndex = index + 1;
    if (this.syncIndex >= SYNC_FIELD.length) this._enterFrameField();
  }

  /* ---------------------------------------------------------------- */
  /* the frame body                                                    */
  /* ---------------------------------------------------------------- */

  _bitFrame(level, tx) {
    // --- transmitter: arbitration, then bit monitoring (spec §7.2) ---
    if (this.txItem) {
      const inArbitration = this.txIndex < this.txItem.tx.arbitrationEnd;
      if (tx === RECESSIVE && level === DOMINANT) {
        if (inArbitration) {
          this._loseArbitration();
        } else {
          this._signalError('bit', 'transmitted recessive, read dominant');
          return;
        }
      } else if (tx === DOMINANT && level === RECESSIVE) {
        this._signalError('bit', 'transmitted dominant, read recessive');
        return;
      } else {
        this.txIndex++;
      }
    }

    // --- receiver: de-stuff, then feed the decoder (spec §6.9) ---
    this.rxWire.push(level);

    if (this.pendingCrcTail) {
      // The CRC sequence ended on a run of five, so one last stuff bit follows
      // it before the (fixed-form, unstuffed) CRC delimiter.
      this.pendingCrcTail = false;
      this.expectStuffBit = false;
      if (level === this.destuffLast) {
        if (level === DOMINANT) this._observeErrorFlag();
        else this._signalError('stuff', 'six consecutive recessive bits');
        return;
      }
      this.state = STATE.CRC_DELIM;
      return;
    }

    if (this.expectStuffBit) {
      this.expectStuffBit = false;
      if (level === this.destuffLast) {
        // Six identical bits. Six dominant is an error flag; anything else is
        // a stuff error.
        if (level === DOMINANT) this._observeErrorFlag();
        else this._signalError('stuff', 'six consecutive recessive bits');
        return;
      }
      this.destuffLast = level;
      this.destuffRun = 1;
      return;                                   // discard the stuff bit
    }

    if (level === this.destuffLast) this.destuffRun++;
    else { this.destuffLast = level; this.destuffRun = 1; }
    if (this.destuffRun >= STUFF_RUN) this.expectStuffBit = true;

    const r = this.decoder.push(level);
    if (r === RX.NEED_MORE) return;

    if (r === RX.FORM_ERROR) { this._signalError('form', this.decoder.error); return; }

    // CRC is the last stuffed field; the delimiter follows either way.
    this.crcFailed = (r === RX.CRC_ERROR);
    if (this.expectStuffBit) this.pendingCrcTail = true;
    else this.state = STATE.CRC_DELIM;
  }

  _bitCrcDelim(level, tx) {
    if (this.txItem) {
      if (tx === DOMINANT && level === RECESSIVE) { this._signalError('bit', 'CRC delimiter'); return; }
      if (tx === RECESSIVE && level === DOMINANT) { this._signalError('bit', 'CRC delimiter overwritten'); return; }
      this.txIndex++;
    } else if (level !== RECESSIVE) {
      this._signalError('form', 'CRC delimiter not recessive');
      return;
    }
    if (this.crcFailed) {
      this.crcErrorPending = true;
    } else if (this.decoder.state === 'COMPLETE') {
      // The frame's content is now known and CRC-valid. Whether it is also
      // *delivered* depends on the rest of the frame surviving (spec §6.7,
      // §8.4), which is what the later `frame` event reports. Analyzers want
      // to see this one — a listener never acknowledges, so every frame it
      // decodes is destroyed by the transmitter's ACK-error flag.
      this.emit('frame-decoded', {
        frame: this.decoder.frame,
        crc: this.decoder.receivedCrc,
        wireBits: this.rxWire.length,
        startBit: this.frameStartBit,
        fields: this.decoder.fields,
        transmitting: !!this.txItem,
      });
    }
    // Spec §6.7 / §9.1: listeners never acknowledge.
    this.ackPending = !this.crcFailed && !this.txItem && this.mode !== 'listener';
    this.state = STATE.ACK;
    this.ackIndex = 0;
    this.ackSeen = RECESSIVE;
  }

  _bitAck(level) {
    this.ackIndex++;
    if (this.txItem) this.txIndex++;
    // Spec §6.7: the transmitter samples the *second* ACK bit.
    if (this.ackIndex >= ACK_BITS) {
      this.ackSeen = level;
      this.ackPending = false;
      this.state = STATE.ACK_DELIM;
    }
  }

  _bitAckDelim(level, tx) {
    if (this.txItem) this.txIndex++;
    if (this.crcErrorPending) {
      this.crcErrorPending = false;
      this._signalError('crc', this.decoder.error || 'CRC mismatch');
      return;
    }
    if (this.txItem && this.ackSeen !== DOMINANT) {
      this._signalError('ack', 'no node acknowledged');
      return;
    }
    if (level !== RECESSIVE) { this._signalError('form', 'ACK delimiter not recessive'); return; }
    this.state = STATE.EOF;
    this.eofIndex = 0;
  }

  _bitEof(level) {
    if (this.txItem) this.txIndex++;
    this.eofIndex++;
    if (level !== RECESSIVE && this.eofIndex < EOF_BITS) {
      this._signalError('form', 'dominant bit in EOF');
      return;
    }
    if (this.eofIndex >= EOF_BITS) this._completeFrame();
  }

  _completeFrame() {
    if (this.txItem) {
      this.stats.framesSent++;
      this.stats.arbitrationsWon++;
      this.tec = Math.max(0, this.tec - 1);
      if (this.tec === 0) this._ackOnlyErrors = true;
      this._updateErrorState();
      this.emit('tx-complete', { item: this.txItem, frame: this.txItem.frame });
      this.txItem = null;
      this.justTransmitted = true;
    } else if (this.decoder.state === 'COMPLETE' && !this.crcFailed) {
      this.stats.framesReceived++;
      if (this.rec > 0) this.rec -= 1;
      this._updateErrorState();
      this.emit('frame', {
        frame: this.decoder.frame,
        crc: this.decoder.receivedCrc,
        wireBits: this.rxWire.length,
        startBit: this.frameStartBit,
        fields: this.decoder.fields,
      });
    }
    this._enterIntermission();
  }

  _enterIntermission() {
    this.state = STATE.INTERMISSION;
    this.ifsIndex = 0;
    this.expectStuffBit = false;
  }

  _bitIntermission(level, carrier) {
    if (level === DOMINANT) {
      // Spec §6.8: the SOF of a node whose interframe space ended a little
      // ahead of ours, the first bit of an overload flag, or noise. The SYNC
      // field tells them apart on the next bit.
      this._enterSync(this._resumePoint());
      this._bitSync(level, carrier);
      return;
    }
    this.ifsIndex++;
    if (this.ifsIndex >= IFS_BITS) {
      const wasTransmitter = this.justTransmitted;
      this.justTransmitted = false;
      if (wasTransmitter && this.errorState === ERROR_STATE.PASSIVE) {
        this.state = STATE.SUSPEND;
        this.suspendIndex = 0;
      } else {
        this._goIdle(true);
      }
    }
  }

  _bitSuspend(level, carrier) {
    if (level === DOMINANT) {
      this._enterSync(this._resumePoint());
      this._bitSync(level, carrier);
      return;
    }
    this.suspendIndex++;
    if (this.suspendIndex >= SUSPEND_BITS) this._goIdle(true);
  }

  /** Where a receiver was when a dominant bit sent it into SYNC. */
  _resumePoint() {
    return {
      state: this.state,
      warmIdle: this.warmIdle,
      ifsIndex: this.ifsIndex,
      suspendIndex: this.suspendIndex,
      justTransmitted: this.justTransmitted,
      idleCount: this.prevIdleCount,
    };
  }

  /**
   * Undo a SYNC that turned out to be one noisy bit: go back to where the node
   * was and count the glitch and the bit after it as the silent bits they were.
   * Without this, one false dominant reading in INTERMISSION used to cost the
   * whole next frame.
   */
  _resumeAfterGlitch(r) {
    this.stats.framesAbandoned++;
    this.emit('abandoned', { reason: 'isolated dominant bit', at: 0 });
    this.syncResume = null;
    this.state = r.state;
    this.warmIdle = r.warmIdle;
    this.ifsIndex = r.ifsIndex;
    this.suspendIndex = r.suspendIndex;
    this.justTransmitted = r.justTransmitted;
    this.idleCount = r.idleCount + 2;
    this._handleBit(RECESSIVE, false, null);
    this._handleBit(RECESSIVE, false, null);
  }

  _goIdle(warm) {
    this.state = STATE.BUS_IDLE;
    this.warmIdle = !!warm;
  }

  /* ---------------------------------------------------------------- */
  /* errors — spec §8                                                  */
  /* ---------------------------------------------------------------- */

  _signalError(kind, detail) {
    switch (kind) {
      case 'bit':   this.stats.bitErrors++; break;
      case 'stuff': this.stats.stuffErrors++; break;
      case 'crc':   this.stats.crcErrors++; break;
      case 'form':  this.stats.formErrors++; break;
      case 'ack':   this.stats.ackErrors++; break;
    }

    if (this.txItem) {
      if (kind === 'ack') {
        // Spec §8.3: acknowledgement errors alone must never cause bus-off.
        this.tec = Math.min(this.tec + 8, this._ackOnlyErrors ? TEC_ACK_ONLY_CLAMP : 511);
      } else {
        this._ackOnlyErrors = false;
        this.tec = Math.min(this.tec + 8, 511);
      }
    } else {
      this.rec = Math.min(this.rec + (this.errorState === ERROR_STATE.ACTIVE ? 8 : 1), 511);
    }
    this._updateErrorState();

    this.emit('error-frame', {
      kind, detail,
      transmitting: !!this.txItem,
      tec: this.tec, rec: this.rec, errorState: this.errorState,
    });

    if (this.txItem) {
      const item = this.txItem;
      this.txItem = null;
      this.justTransmitted = true;
      if (this.autoRetransmit && this.errorState !== ERROR_STATE.BUS_OFF) {
        this.txQueue.unshift(item);
      } else {
        this.emit('tx-failed', { item, kind, detail });
      }
    }

    this.state = STATE.ERROR_FLAG;
    this.errorFlagIndex = 0;
    this.expectStuffBit = false;
  }

  /** Another node's active error flag turned up in our receive stream. */
  _observeErrorFlag() {
    this.rec = Math.min(this.rec + 1, 511);
    this._updateErrorState();
    this.emit('error-frame', {
      kind: 'observed', detail: 'active error flag from another node',
      transmitting: !!this.txItem, tec: this.tec, rec: this.rec, errorState: this.errorState,
    });
    if (this.txItem) {
      const item = this.txItem;
      this.txItem = null;
      this.justTransmitted = true;
      if (this.autoRetransmit) this.txQueue.unshift(item);
      else this.emit('tx-failed', { item, kind: 'observed', detail: 'destroyed by another node' });
    }
    this.state = STATE.ERROR_ECHO;
  }

  _bitErrorFlag() {
    this.errorFlagIndex++;
    if (this.errorFlagIndex >= ERROR_FLAG_BITS) this.state = STATE.ERROR_ECHO;
  }

  /** Wait out the superposition of every node's error flag (spec §8.4). */
  _bitErrorEcho(level) {
    if (level === RECESSIVE) {
      this.state = STATE.ERROR_DELIM;
      this.errorDelimIndex = 1;
    }
  }

  _bitErrorDelim(level) {
    this.errorDelimIndex++;
    if (this.errorDelimIndex >= ERROR_DELIM_BITS) this._enterIntermission();
  }

  _loseArbitration() {
    this.stats.arbitrationsLost++;
    const item = this.txItem;
    this.txItem = null;
    this.txQueue.unshift(item);
    this._sortQueue();
    this.emit('arbitration-lost', { item, bit: this.txIndex, frame: item.frame });
    // We keep decoding the winner's frame and will acknowledge it (spec §7.2).
  }

  _updateErrorState() {
    const prev = this.errorState;
    if (this.tec >= TEC_BUS_OFF) this.errorState = ERROR_STATE.BUS_OFF;
    else if (this.tec >= TEC_PASSIVE || this.rec >= REC_PASSIVE) this.errorState = ERROR_STATE.PASSIVE;
    else this.errorState = ERROR_STATE.ACTIVE;
    if (this.errorState !== prev) {
      if (this.errorState === ERROR_STATE.BUS_OFF) this._busOffSequences = 0;
      this.emit('error-state', { from: prev, to: this.errorState, tec: this.tec, rec: this.rec });
    }
  }

  _trackBusOffRecovery(carrier, level) {
    if (!this.autoBusOffRecovery) return;
    if (!carrier || level === RECESSIVE) this._recessiveRun++;
    else this._recessiveRun = 0;
    if (this._recessiveRun >= 11) {
      this._recessiveRun = 0;
      if (++this._busOffSequences >= BUS_OFF_RECOVERY_SEQUENCES) {
        this.tec = 0; this.rec = 0; this._ackOnlyErrors = true;
        this._updateErrorState();
        this.emit('bus-off-recovered', {});
      }
    }
  }

  /* ---------------------------------------------------------------- */

  _reset() {
    this.state = STATE.BUS_IDLE;
    this.bitIndex = 0;
    this.idleCount = 0;
    this.prevIdleCount = 0;
    this.warmIdle = false;
    this.txItem = null;
    this.txIndex = 0;
    this.txLevel = null;
    this.justTransmitted = false;
    this.syncIndex = 0;
    this.syncResume = null;
    this.frameStartBit = 0;
    this.decoder.reset();
    this.rxWire = [];
    this.destuffRun = 0;
    this.destuffLast = -1;
    this.expectStuffBit = false;
    this.pendingCrcTail = false;
    this.crcFailed = false;
    this.crcErrorPending = false;
    this.ackPending = false;
    this.ackSeen = RECESSIVE;
    this.ackIndex = 0;
    this.eofIndex = 0;
    this.ifsIndex = 0;
    this.suspendIndex = 0;
    this.errorFlagIndex = 0;
    this.errorDelimIndex = 0;
  }
}

/**
 * Sort key so the highest-priority queued frame is offered to the bus first.
 * Mirrors how the arbitration field would actually resolve (spec §7.3).
 */
export function arbitrationKey(frame) {
  if (!frame.extended) return (frame.id * 4) + (frame.rtr ? 2 : 0);   // ID, RTR, IDE=0
  return ((frame.id >>> 18) * 4) + 2 + 1;                             // ID_A, SRR=1, IDE=1
}
