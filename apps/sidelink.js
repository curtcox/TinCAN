/**
 * One end of a side link (Part 2 §8.3), for a page that already runs a
 * main-bus Modem and Session. Shared by the Console and the pair test, so
 * that what the pair test checks is what the Console does.
 *
 * Once its link is accepted, a LinkEnd starts a second node on the link's
 * band and profile, announces (the proposer) or answers the announcement
 * (the other end), is up once it hears the other end, closes the link on the
 * main bus if that has not happened within T_link of the acceptance being
 * delivered, and stops its node when the link closes.
 *
 * Events: 'modem' {modem} as its node is created, 'log' {text, kind}, 'up',
 * 'message' {text, data}, 'counters', 'ended' {reason}.
 */

import { Modem } from '../src/tincan/modem.js';
import {
  Session, linkTimeout, parseBaseId, TOPIC, CONTROL, CLOSE,
} from '../src/tincan/transport.js';

export class LinkEnd extends EventTarget {
  /**
   * @param {object} o
   * @param {object} o.rec the link record from the main Session
   * @param {Session} o.session the main-bus Session
   * @param {Modem} o.modem the main-bus Modem
   * @param {object} [o.modemOptions] for the link's node: amplitude, deviceId, thresholds
   */
  constructor({ rec, session, modem, modemOptions = {} }) {
    super();
    this.rec = rec;
    this.main = { session, modem };
    this.modemOptions = modemOptions;
    this.mine = rec.proposer === session.address;
    this.peer = this.mine ? rec.peer : rec.proposer;
    this.up = false;
    this.ended = false;
    this.sent = 0;
    this.recv = 0;
    this.errors = 0;
    this.modem = null;
    this.session = null;
    this.timer = null;
    this.unhook = [];
  }

  on(type, fn) {
    const h = (e) => fn(e.detail);
    this.addEventListener(type, h);
    return () => this.removeEventListener(type, h);
  }

  _emit(type, detail = {}) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  _log(text, kind = '') { this._emit('log', { text, kind }); }

  async open() {
    const { rec } = this;
    const { session } = this.main;
    this._log(`opening #${rec.link} with node ${this.peer}: band ${rec.band}, ${rec.profile}`);
    try {
      const m = new Modem({
        mode: 'node', ...this.modemOptions,
        band: rec.band, profile: rec.profile, name: `${session.callsign || 'node'}-link`,
      });
      this.modem = m;
      this._emit('modem', { modem: m });
      await m.start();
      if (this.main.modem?.measuredLatencyMs != null) m.measuredLatencyMs = this.main.modem.measuredLatencyMs;
      if (this.ended) { await m.stop(); return; }
      const ls = new Session({ on: (ev, fn) => m.on(ev, (e) => fn(e.detail)), send: (f) => m.send(f) },
        { address: session.address, callsign: session.callsign });
      this.session = ls;
      m.on('tx-complete', () => { this.sent++; this._emit('counters'); });
      m.on('frame', () => { this.recv++; this._emit('counters'); });
      m.on('error-frame', (e) => {
        this.errors++;
        this._emit('counters');
        this._log(e.detail.kind === 'ack' ? 'no acknowledgement on the link' : `${e.detail.kind} error on the link`, 'err');
      });
      ls.on('presence', ({ address }) => {
        if (address !== this.peer || this.up) return;
        this.up = true;
        clearTimeout(this.timer);
        this._log(`#${rec.link} is up: heard node ${this.peer} on band ${rec.band}`, 'tx');
        if (!this.mine) ls.announce();               // answer the proposer's
        this._emit('up');
      });
      ls.on('message', (msg) => this._emit('message', msg));
      if (this.mine) ls.announce();
      this._armTimer();
    } catch (err) {
      this._log(`could not start the link: ${err.message || err}`, 'err');
      session.closeLink(rec, CLOSE.ERRORS);
      await this.stop('could not start');
    }
  }

  /**
   * T_link runs from the acceptance's delivery (§8.3): for the proposer, now,
   * since it has heard it; for the other end, once its transmission of the
   * acceptance completes, which on a slow, busy main bus can be minutes away.
   */
  _armTimer() {
    const { rec } = this;
    const limit = linkTimeout(rec.profile);
    const start = () => {
      this.timer = setTimeout(() => {
        if (this.up || this.ended) return;
        this._log(`nothing heard on #${rec.link} in ${limit.toFixed(0)} s: closing`, 'err');
        this.main.session.closeLink(rec, CLOSE.NO_CONTACT);
        this.stop('no contact');
      }, limit * 1000);
    };
    if (this.mine) { start(); return; }
    const isAccept = (f) => f && !f.extended && parseBaseId(f.id).topic === TOPIC.CONTROL
      && f.data?.[0] === CONTROL.LINK_ACCEPT && f.data?.[2] === rec.link;
    const mm = this.main.modem;
    this.unhook.push(
      mm.on('tx-complete', (e) => {
        if (!isAccept(e.detail.frame) || this.timer) return;
        this._log(`acceptance of #${rec.link} delivered; waiting for node ${this.peer} on band ${rec.band}`);
        start();
      }),
      mm.on('tx-failed', (e) => {
        if (!isAccept(e.detail.item?.frame)) return;
        this._log(`could not deliver the acceptance of #${rec.link}: closing`, 'err');
        this.stop('acceptance not delivered');
      }),
    );
  }

  sendText(text) {
    if (!this.up) throw new Error('the link is not up');
    this.session.sendText(text);
  }

  /** Close on the main bus, then stop. */
  close(reason = CLOSE.FINISHED) {
    this.main.session.closeLink(this.rec, reason);
    return this.stop('closed');
  }

  async stop(reason = 'stopped') {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    for (const off of this.unhook) off();
    if (this.modem) await this.modem.stop().catch(() => {});
    this._emit('ended', { reason });
  }
}
