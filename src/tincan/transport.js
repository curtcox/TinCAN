/**
 * TinCAN Part 2 — addressing, segmented transport and application profiles.
 * Spec: spec/transport.md
 */

import {
  BANDS, PROFILES, timing, maxRange, bandsCompatible, bandById, profileById,
} from './params.js';

/* ------------------------------------------------------------------ */
/* identifiers                                                         */
/* ------------------------------------------------------------------ */

export const PRIO = {
  EMERGENCY: 0, HIGH: 1, CONTROL: 2, PRESENCE: 3, NORMAL: 4, TEXT: 5, BULK: 6, IDLE: 7,
};

export const TOPIC = {
  CONTROL: 0, PRESENCE: 1, EVENT: 2, STATE: 3, TEXT: 4, DATA: 5, TRANSPORT: 6, PRIVATE: 7,
};

export const TOPIC_NAME = ['CONTROL', 'PRESENCE', 'EVENT', 'STATE', 'TEXT', 'DATA', 'TRANSPORT', 'PRIVATE'];
export const PRIO_NAME = ['EMERGENCY', 'HIGH', 'CONTROL', 'PRESENCE', 'NORMAL', 'TEXT', 'BULK', 'IDLE'];

export const FLAG = { SEG: 0x10, REQ_ACK: 0x08, ENC: 0x04 };

export const BROADCAST_BASE = 31;
export const BROADCAST_EXT = 0xff;

/** Pack an 11-bit base identifier — Part 2 §1.1. */
export function baseId({ prio = PRIO.NORMAL, topic = TOPIC.DATA, source = 0 }) {
  return ((prio & 7) << 8) | ((topic & 7) << 5) | (source & 31);
}

export function parseBaseId(id) {
  return { prio: (id >> 8) & 7, topic: (id >> 5) & 7, source: id & 31 };
}

/** Pack a 29-bit extended identifier — Part 2 §1.2. */
export function extendedId({ prio = PRIO.NORMAL, type = TOPIC.DATA, dest = BROADCAST_EXT, source = 0, flags = 0 }) {
  // 3 + 5 + 8 + 8 + 5 = 29 bits. Built with arithmetic, not <<, to stay exact
  // above 2^31.
  return (((prio & 7) * 0x4000000)
        + ((type & 31) * 0x200000)
        + ((dest & 0xff) * 0x2000)
        + ((source & 0xff) * 0x20)
        + (flags & 31));
}

export function parseExtendedId(id) {
  return {
    prio: Math.floor(id / 0x4000000) & 7,
    type: Math.floor(id / 0x200000) & 31,
    dest: Math.floor(id / 0x2000) & 0xff,
    source: Math.floor(id / 0x20) & 0xff,
    flags: id & 31,
  };
}

/** Describe an identifier for a UI, without asserting Part 2 is in use. */
export function describeId(frame) {
  if (frame.extended) {
    const p = parseExtendedId(frame.id);
    return {
      kind: 'extended',
      ...p,
      prioName: PRIO_NAME[p.prio],
      typeName: p.type < 8 ? TOPIC_NAME[p.type] : (p.type >= 24 ? 'PRIVATE' : 'reserved'),
      destName: p.dest === BROADCAST_EXT ? 'all' : String(p.dest),
      text: `p${p.prio} ${p.type < 8 ? TOPIC_NAME[p.type] : 't' + p.type} ${p.source}→${p.dest === BROADCAST_EXT ? 'all' : p.dest}`,
    };
  }
  const p = parseBaseId(frame.id);
  return {
    kind: 'base',
    ...p,
    prioName: PRIO_NAME[p.prio],
    typeName: TOPIC_NAME[p.topic],
    text: `p${p.prio} ${TOPIC_NAME[p.topic]} from ${p.source}`,
  };
}

/* ------------------------------------------------------------------ */
/* segmented transport — Part 2 §3                                     */
/* ------------------------------------------------------------------ */

export const PCI = { SINGLE: 0, FIRST: 1, CONSECUTIVE: 2, FLOW: 3 };
export const FLOW = { CTS: 0, WAIT: 1, ABORT: 2 };

export const MAX_TRANSFER = 4095;

/** Split a payload into the PCI-prefixed frames of Part 2 §3. */
export function segment(bytes) {
  const data = Uint8Array.from(bytes);
  if (data.length > MAX_TRANSFER) throw new Error(`transfer of ${data.length} exceeds ${MAX_TRANSFER} octets`);
  if (data.length <= 7) {
    const out = new Uint8Array(1 + data.length);
    out[0] = (PCI.SINGLE << 4) | data.length;
    out.set(data, 1);
    return [out];
  }
  const frames = [];
  const first = new Uint8Array(8);
  first[0] = (PCI.FIRST << 4) | ((data.length >> 8) & 0x0f);
  first[1] = data.length & 0xff;
  first.set(data.subarray(0, 6), 2);
  frames.push(first);

  let off = 6;
  let seq = 1;
  while (off < data.length) {
    const chunk = data.subarray(off, off + 7);
    const f = new Uint8Array(1 + chunk.length);
    f[0] = (PCI.CONSECUTIVE << 4) | (seq & 0x0f);
    f.set(chunk, 1);
    frames.push(f);
    off += chunk.length;
    seq = (seq + 1) & 0x0f;
  }
  return frames;
}

/** Reassembles one peer's segmented transfer. */
export class Reassembler {
  constructor() { this.reset(); }

  reset() {
    this.active = false;
    this.total = 0;
    this.buf = null;
    this.off = 0;
    this.nextSeq = 1;
    this.error = null;
  }

  /**
   * @param {Uint8Array} payload one frame's data field
   * @returns {{done:boolean, data?:Uint8Array, error?:string, progress?:number}}
   */
  push(payload) {
    if (!payload || payload.length === 0) return { done: false, error: 'empty frame' };
    const type = payload[0] >> 4;
    const low = payload[0] & 0x0f;

    if (type === PCI.SINGLE) {
      this.reset();
      const len = Math.min(low, payload.length - 1);
      return { done: true, data: payload.slice(1, 1 + len) };
    }

    if (type === PCI.FIRST) {
      if (payload.length < 2) return { done: false, error: 'truncated FIRST' };
      this.reset();
      this.total = (low << 8) | payload[1];
      this.buf = new Uint8Array(this.total);
      const chunk = payload.subarray(2, Math.min(payload.length, 2 + this.total));
      this.buf.set(chunk, 0);
      this.off = chunk.length;
      this.nextSeq = 1;
      this.active = true;
      return { done: false, progress: this.off / this.total };
    }

    if (type === PCI.CONSECUTIVE) {
      if (!this.active) return { done: false, error: 'CONSECUTIVE without FIRST' };
      if (low !== this.nextSeq) {
        const err = `sequence gap: expected ${this.nextSeq}, got ${low}`;
        this.reset();
        return { done: false, error: err };
      }
      const room = this.total - this.off;
      const chunk = payload.subarray(1, 1 + Math.min(room, payload.length - 1));
      this.buf.set(chunk, this.off);
      this.off += chunk.length;
      this.nextSeq = (this.nextSeq + 1) & 0x0f;
      if (this.off >= this.total) {
        const data = this.buf;
        this.reset();
        return { done: true, data };
      }
      return { done: false, progress: this.off / this.total };
    }

    if (type === PCI.FLOW) {
      return { done: false, flow: { status: low, blockSize: payload[1] ?? 0, separation: payload[2] ?? 0 } };
    }

    return { done: false, error: `reserved PCI type ${type}` };
  }
}

/** Describe a transport PCI octet for a UI. */
export function describePci(payload) {
  if (!payload || !payload.length) return null;
  const type = payload[0] >> 4;
  const low = payload[0] & 0x0f;
  switch (type) {
    case PCI.SINGLE: return `SINGLE len=${low}`;
    case PCI.FIRST: return `FIRST total=${(low << 8) | (payload[1] ?? 0)}`;
    case PCI.CONSECUTIVE: return `CONSECUTIVE seq=${low}`;
    case PCI.FLOW: {
      const names = ['CTS', 'WAIT', 'ABORT'];
      return `FLOW ${names[low] ?? low} bs=${payload[1] ?? 0} st=${payload[2] ?? 0}`;
    }
    default: return `PCI ${type}`;
  }
}

/* ------------------------------------------------------------------ */
/* presence — Part 2 §4                                                */
/* ------------------------------------------------------------------ */

export const CAP = {
  FULL_NODE: 0x80, SEGMENTED: 0x40, TEXT: 0x20, LISTENER_ONLY: 0x10, SIDE_LINKS: 0x08,
};

export const PROTOCOL_VERSION = 0x10;

export function buildAnnounce(callsign, caps = CAP.SEGMENTED | CAP.TEXT | CAP.SIDE_LINKS) {
  const name = new TextEncoder().encode(callsign || '');
  const out = new Uint8Array(2 + Math.min(6, name.length));
  out[0] = PROTOCOL_VERSION;
  out[1] = caps;
  out.set(name.subarray(0, 6), 2);
  return out;
}

export function parseAnnounce(data) {
  if (!data || data.length < 2) return null;
  return {
    version: data[0],
    caps: data[1],
    callsign: new TextDecoder().decode(data.subarray(2)).replace(/\0+$/, ''),
    full: !!(data[1] & CAP.FULL_NODE),
    segmented: !!(data[1] & CAP.SEGMENTED),
    text: !!(data[1] & CAP.TEXT),
    leaving: !!(data[1] & CAP.LISTENER_ONLY),
    sideLinks: !!(data[1] & CAP.SIDE_LINKS),
  };
}

/* ------------------------------------------------------------------ */
/* side links — Part 2 §8                                              */
/* ------------------------------------------------------------------ */

/** First octet of a CONTROL frame. */
export const CONTROL = {
  ACK: 0x06, NAK: 0x15, LINK_PROPOSE: 0x20, LINK_ACCEPT: 0x21, LINK_DECLINE: 0x22, LINK_CLOSE: 0x23,
};
export const DECLINE = { BAND: 1, TIMING: 2, BUSY: 3, REFUSED: 4 };
export const CLOSE = { FINISHED: 0, NO_CONTACT: 1, ERRORS: 2 };
export const DECLINE_TEXT = {
  [DECLINE.BAND]: 'band not usable there',
  [DECLINE.TIMING]: 'the profile cannot cover both audio paths',
  [DECLINE.BUSY]: 'band busy, or cannot share the devices with the main bus',
  [DECLINE.REFUSED]: 'refused',
};
export const CLOSE_TEXT = {
  [CLOSE.FINISHED]: 'finished', [CLOSE.NO_CONTACT]: 'no contact on the link', [CLOSE.ERRORS]: 'errors',
};

const slopByte = (ms) => (ms == null || !Number.isFinite(ms) ? 255 : Math.max(0, Math.min(254, Math.round(ms))));
const slopMs = (b) => (b === 255 ? null : b);

/**
 * The payload of a side-link CONTROL frame — Part 2 §8.1.
 * @param {{op:number, to?:number, proposer?:number, peer?:number, link:number,
 *   band?:string, profile?:string, slopMs?:number|null, reason?:number}} m
 */
export function buildLinkMessage(m) {
  switch (m.op) {
    case CONTROL.LINK_PROPOSE:
      return Uint8Array.of(m.op, m.to & 31, m.link & 0xff, BANDS[m.band].id, PROFILES[m.profile].id, slopByte(m.slopMs));
    case CONTROL.LINK_ACCEPT:
      return Uint8Array.of(m.op, m.proposer & 31, m.link & 0xff, slopByte(m.slopMs));
    case CONTROL.LINK_DECLINE:
      return Uint8Array.of(m.op, m.proposer & 31, m.link & 0xff, m.reason & 0xff);
    case CONTROL.LINK_CLOSE:
      return Uint8Array.of(m.op, m.peer & 31, m.link & 0xff, m.reason & 0xff);
    default:
      throw new Error(`not a side-link opcode: ${m.op}`);
  }
}

/** Parse a CONTROL frame's payload, or null if it is not one this knows. */
export function parseControl(data) {
  if (!data || !data.length) return null;
  const op = data[0];
  const need = { [CONTROL.LINK_PROPOSE]: 6, [CONTROL.LINK_ACCEPT]: 4, [CONTROL.LINK_DECLINE]: 4, [CONTROL.LINK_CLOSE]: 4 };
  if (op === CONTROL.ACK || op === CONTROL.NAK) return { op, name: op === CONTROL.ACK ? 'ACK' : 'NAK' };
  if (!need[op] || data.length < need[op]) return null;
  switch (op) {
    case CONTROL.LINK_PROPOSE: {
      const band = bandById(data[3]);
      const profile = profileById(data[4]);
      return { op, name: 'LINK_PROPOSE', to: data[1], link: data[2], band, profile, slopMs: slopMs(data[5]) };
    }
    case CONTROL.LINK_ACCEPT:
      return { op, name: 'LINK_ACCEPT', proposer: data[1], link: data[2], slopMs: slopMs(data[3]) };
    case CONTROL.LINK_DECLINE:
      return { op, name: 'LINK_DECLINE', proposer: data[1], link: data[2], reason: data[3] };
    default:
      return { op, name: 'LINK_CLOSE', peer: data[1], link: data[2], reason: data[3] };
  }
}

/** A CONTROL frame's payload in words, for analyzers. */
export function describeControl(data) {
  const c = parseControl(data);
  if (!c) return null;
  const slop = (ms) => (ms == null ? 't_slop unknown' : `t_slop ${ms} ms`);
  switch (c.op) {
    case CONTROL.LINK_PROPOSE:
      return `LINK_PROPOSE #${c.link} to ${c.to === BROADCAST_BASE ? 'anyone' : c.to}: `
        + `band ${c.band ?? '?'}, ${c.profile ?? '?'}, ${slop(c.slopMs)}`;
    case CONTROL.LINK_ACCEPT: return `LINK_ACCEPT ${c.proposer}#${c.link}, ${slop(c.slopMs)}`;
    case CONTROL.LINK_DECLINE: return `LINK_DECLINE ${c.proposer}#${c.link}: ${DECLINE_TEXT[c.reason] ?? c.reason}`;
    case CONTROL.LINK_CLOSE: return `LINK_CLOSE #${c.link} with ${c.peer}: ${CLOSE_TEXT[c.reason] ?? c.reason}`;
    default: return c.name;
  }
}

/** T_link — Part 2 §8.3: how long a new link has to come up, in seconds. */
export function linkTimeout(profile) {
  const fiveOctetFrame = 59 + 8 * 5;
  return Math.max(10, 4 * fiveOctetFrame * timing(profile).bitTime);
}

/**
 * Whether this node should accept a proposed side link — Part 2 §8.2.
 * Returns null to accept, or the DECLINE reason.
 *
 * @param {{band:string|null, profile:string|null, slopMs:number|null}} proposal
 * @param {object} here
 * @param {string} here.mainBand
 * @param {string} here.mainProfile
 * @param {number|null} [here.slopMs] this node's measured t_slop
 * @param {string[]} [here.bandsInUse] by other links it has heard accepted
 * @param {(band:string) => boolean} [here.canUseBand]
 */
export function assessProposal(proposal, { mainBand, mainProfile, slopMs: mine = null, bandsInUse = [], canUseBand = () => true }) {
  const { band, profile } = proposal;
  if (!band || !profile || !canUseBand(band)) return DECLINE.BAND;
  if (band === mainBand || bandsInUse.includes(band) || !bandsCompatible(mainBand, mainProfile, band, profile)) {
    return DECLINE.BUSY;
  }
  const slops = [proposal.slopMs, mine].filter((v) => v != null);
  if (slops.length && maxRange(profile, Math.max(...slops) + timing(profile).tq * 250) <= 0) return DECLINE.TIMING;
  return null;
}

/* ------------------------------------------------------------------ */
/* a convenience session over a Protocol                               */
/* ------------------------------------------------------------------ */

/**
 * Wraps a `Protocol` with Part 2 addressing, text send/receive and reassembly.
 * Deliberately thin: everything it does is expressible with `protocol.send`.
 */
export class Session {
  /**
   * @param {import('./protocol.js').Protocol} protocol
   * @param {object} [opts]
   * @param {number} [opts.address] 0..30
   * @param {string} [opts.callsign]
   */
  constructor(protocol, opts = {}) {
    this.protocol = protocol;
    this.address = opts.address ?? (1 + Math.floor(Math.random() * 30));
    this.callsign = opts.callsign || '';
    this.peers = new Map();
    this.reassemblers = new Map();
    this.handlers = new Map();
    /** Side links heard or taken part in, by `${proposer}:${link}` — Part 2 §8. */
    this.links = new Map();
    this.nextLink = 1 + Math.floor(Math.random() * 254);

    protocol.on('frame', ({ frame }) => this._onFrame(frame));
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(fn);
    return () => this.handlers.get(event).delete(fn);
  }

  _emit(event, detail) {
    const s = this.handlers.get(event);
    if (s) for (const fn of s) fn(detail);
  }

  /* side links — Part 2 §8 --------------------------------------- */

  _control(m) {
    return this.protocol.send({
      id: baseId({ prio: PRIO.CONTROL, topic: TOPIC.CONTROL, source: this.address }),
      data: buildLinkMessage(m),
    });
  }

  /**
   * Propose a side link to node `to` (or BROADCAST_BASE for anyone). Resolves
   * nothing: 'link-accepted' or 'link-declined' follows when the answer comes.
   */
  proposeLink({ to, band, profile, slopMs = null }) {
    const link = this.nextLink;
    this.nextLink = (this.nextLink % 255) + 1;
    const rec = {
      proposer: this.address, link, to, band, profile, slopMs, state: 'proposed', mine: true, peer: null, peerSlopMs: null,
    };
    this.links.set(`${this.address}:${link}`, rec);
    this._control({ op: CONTROL.LINK_PROPOSE, to, link, band, profile, slopMs });
    return rec;
  }

  acceptLink(rec, slopMs = null) {
    rec.state = 'accepted';
    rec.mine = true;
    rec.peer = rec.proposer;
    this._control({ op: CONTROL.LINK_ACCEPT, proposer: rec.proposer, link: rec.link, slopMs });
    this._emit('link-open', { link: rec });
  }

  declineLink(rec, reason = DECLINE.REFUSED) {
    rec.state = 'declined';
    this._control({ op: CONTROL.LINK_DECLINE, proposer: rec.proposer, link: rec.link, reason });
  }

  closeLink(rec, reason = CLOSE.FINISHED) {
    if (rec.state === 'closed') return;
    rec.state = 'closed';
    this._control({ op: CONTROL.LINK_CLOSE, peer: rec.peer ?? rec.to, link: rec.link, reason });
    this._emit('link-closed', { link: rec, reason, by: this.address });
  }

  /** Bands of links accepted and not closed, so as not to propose them. */
  bandsInUse() {
    return [...this.links.values()].filter((l) => l.state === 'accepted').map((l) => l.band);
  }

  _onControl(c, source) {
    if (c.op === CONTROL.LINK_PROPOSE) {
      const rec = {
        proposer: source, link: c.link, to: c.to, band: c.band, profile: c.profile,
        slopMs: c.slopMs, state: 'proposed', mine: false, peer: null, peerSlopMs: null,
      };
      this.links.set(`${source}:${c.link}`, rec);
      if (source !== this.address && (c.to === this.address || c.to === BROADCAST_BASE)) {
        this._emit('link-proposal', { link: rec });
      }
      return;
    }
    if (c.op === CONTROL.LINK_ACCEPT || c.op === CONTROL.LINK_DECLINE) {
      const rec = this.links.get(`${c.proposer}:${c.link}`);
      if (!rec) return;
      if (c.op === CONTROL.LINK_DECLINE) {
        if (rec.proposer === this.address) {
          rec.state = 'declined';
          this._emit('link-declined', { link: rec, by: source, reason: c.reason });
        }
        return;
      }
      rec.state = 'accepted';
      if (rec.proposer === this.address && rec.peer === null) {
        rec.peer = source;
        rec.peerSlopMs = c.slopMs;
        this._emit('link-open', { link: rec });
      } else if (!rec.mine) {
        rec.peer = source;
      }
      return;
    }
    if (c.op === CONTROL.LINK_CLOSE) {
      // The closer is one end; the other is named. Either may be the proposer.
      const rec = this.links.get(`${source}:${c.link}`) || this.links.get(`${c.peer}:${c.link}`);
      if (!rec || rec.state === 'closed') return;
      rec.state = 'closed';
      if (rec.mine) this._emit('link-closed', { link: rec, reason: c.reason, by: source });
    }
  }

  announce(caps) {
    return this.protocol.send({
      id: baseId({ prio: PRIO.PRESENCE, topic: TOPIC.PRESENCE, source: this.address }),
      data: buildAnnounce(this.callsign, caps),
    });
  }

  /** Send UTF-8 text, segmenting when it does not fit in one frame. */
  sendText(text) {
    const bytes = new TextEncoder().encode(text);
    const frames = segment(bytes);
    const id = baseId({
      prio: frames.length > 1 ? PRIO.BULK : PRIO.TEXT,
      topic: TOPIC.TRANSPORT,
      source: this.address,
    });
    return frames.map((data) => this.protocol.send({ id, data }));
  }

  /** Send opaque octets in a single frame; caller must keep it under 9 bytes. */
  sendData(bytes, { prio = PRIO.NORMAL, topic = TOPIC.DATA } = {}) {
    return this.protocol.send({
      id: baseId({ prio, topic, source: this.address }),
      data: bytes,
    });
  }

  _onFrame(frame) {
    if (frame.extended) { this._emit('frame', { frame }); return; }
    const { topic, source } = parseBaseId(frame.id);

    if (topic === TOPIC.CONTROL) {
      const c = parseControl(frame.data);
      if (c && c.op >= CONTROL.LINK_PROPOSE) { this._onControl(c, source); return; }
    }

    if (topic === TOPIC.PRESENCE) {
      const a = parseAnnounce(frame.data);
      if (a) {
        if (a.leaving) this.peers.delete(source);
        else this.peers.set(source, { ...a, address: source, lastSeen: Date.now() });
        this._emit('presence', { address: source, announce: a });
      }
      return;
    }

    if (topic === TOPIC.TRANSPORT) {
      let r = this.reassemblers.get(source);
      if (!r) { r = new Reassembler(); this.reassemblers.set(source, r); }
      const res = r.push(frame.data);
      if (res.error) { this._emit('transport-error', { source, error: res.error }); return; }
      if (res.done) {
        let text = null;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(res.data); } catch { /* binary */ }
        this._emit('message', { source, data: res.data, text });
      } else if (res.progress !== undefined) {
        this._emit('progress', { source, progress: res.progress });
      }
      return;
    }

    this._emit('frame', { frame, source, topic });
  }
}
