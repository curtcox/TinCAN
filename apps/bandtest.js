/**
 * The band test (Part 2 §9) for a page that runs a main-bus Modem and
 * Session: the Console and the Bands page. A BandTestPanel fills an empty
 * element with its controls and results; `attach` it once the node has
 * joined the bus and `detach` it when the node leaves.
 */

import { BandTests, pairLevels, joinWindow, testPlan } from '../src/tincan/bandtest.js';
import { BANDS, bandFitsRate, nearFarMarginDb } from '../src/tincan/params.js';
import { toneBalance } from './bands/acoustics.js';
import { el, escapeHtml } from './ui.js';

const MARGIN_DB = Math.abs(nearFarMarginDb());

/** A Modem as the audio a BandTests needs: its own clock, speaker and microphone. */
export function modemAudio(modem) {
  return {
    get sampleRate() { return modem.ctx.sampleRate; },
    now: () => modem.ctx.currentTime,
    after: (seconds, fn) => setTimeout(fn, seconds * 1000),
    hold: (until) => modem.hold(until),
    play: (signal, at) => { modem.playAt(signal, at); },
    record: (at, samples, done) => { modem.recordAt(at, samples).then(done); },
  };
}

/** How `rx` heard `tx` on a band, in words and a class: Part 1 §4.6's margin applied. */
export function verdict(p) {
  if (!p) return { text: '—', cls: 'muted', title: 'not measured: this listener cannot run the band' };
  const word = p.snrDb >= 30 ? 'carries well' : p.snrDb >= 15 ? 'usable, short range' : p.snrDb >= 6 ? 'barely' : 'not heard';
  const tilt = `${p.tiltDb >= 0.5 ? '+' : p.tiltDb <= -0.5 ? '−' : ''}${Math.abs(Math.round(p.tiltDb))} dB`;
  const bal = toneBalance(10 ** (p.levelDb[0] / 20), 10 ** (p.levelDb[1] / 20), MARGIN_DB);
  let cls = p.snrDb >= 30 ? 'ok' : p.snrDb >= 15 ? 'warn' : 'bad';
  let note = word;
  if (p.snrDb >= 6 && bal.level === 'fails') { cls = 'bad'; note += ', but the tones are too unbalanced to arbitrate'; }
  else if (p.snrDb >= 6 && bal.level === 'tight') {
    if (cls === 'ok') cls = 'warn';
    note += `, but contenders must be within ${bal.ratio.toFixed(1)}:1 of each other's distance`;
  }
  return { text: `${Math.round(p.snrDb)} dB · ${tilt}`, cls, title: note };
}

export class BandTestPanel {
  /**
   * @param {HTMLElement} root an empty panel
   * @param {object} [o]
   * @param {(html:string, kind?:string)=>void} [o.log]
   */
  constructor(root, { log = () => {} } = {}) {
    this.root = root;
    this.log = log;
    this.tests = null;
    this.current = null;
    this.state = el('span', { class: 'pill' }, 'offline');
    this.joinBox = el('input', { type: 'checkbox', checked: '', style: 'width:auto' });
    this.button = el('button', { disabled: '' }, 'Request a band test');
    this.status = el('p', { class: 'note' }, 'Join the bus to take part.');
    this.results = el('div', { style: 'overflow-x:auto' });
    root.replaceChildren(
      el('div', { class: 'row', style: 'margin-bottom:.6rem' },
        el('h2', { style: 'margin:0' }, 'Band test'), el('span', { class: 'spacer' }), this.state),
      el('p', {
        class: 'note', style: 'margin-top:0',
        html: 'Every node that joins plays each band\'s two tones in turn, every node on the bus measures them, '
          + 'and the players report what they heard (<a href="../../spec/transport.html#9-band-tests">Part 2 §9</a>). '
          + 'At the end each node knows how well every player heard every other on every band. '
          + 'It is loud: every band but B and F is audible.',
      }),
      el('label', { class: 'row tight' }, this.joinBox, 'Join band tests that other nodes request'),
      el('div', { class: 'row', style: 'margin-top:.6rem' }, this.button),
      this.status,
      this.results,
    );
    this.button.addEventListener('click', () => this.request());
  }

  /**
   * @param {object} c
   * @param {import('../src/tincan/modem.js').Modem} c.modem
   * @param {import('../src/tincan/transport.js').Session} c.session
   * @param {string} c.profile the main bus's
   * @param {()=>number} [c.latencyMs] this device's speaker to microphone
   */
  attach({ modem, session, profile, latencyMs = () => modem.measuredLatencyMs ?? modem.measuredSlopMs ?? 0 }) {
    this.modem = modem;
    this.session = session;
    this.profile = profile;
    const fs = modem.ctx.sampleRate;
    this.tests = new BandTests(session, modemAudio(modem), {
      canRun: (b) => bandFitsRate(b, fs),
      latencyMs,
      join: () => this.joinBox.checked && !modem.muted,
    });
    // BandTests copies its options; keep the level current.
    Object.defineProperty(this.tests.opts, 'amplitude', { get: () => modem.opts.amplitude });
    const t = this.tests;
    t.on('log', ({ text, kind }) => this.log(escapeHtml(text), kind));
    t.on('request', ({ test }) => {
      this.current = test;
      if (!test.mine) {
        const joining = !!test.joined;
        this.log(`${this.name(test.requester)} requests a band test of ${test.bands.join('')}: `
          + (joining ? 'joining' : 'listening only'));
      }
      this.show();
    });
    t.on('state', ({ test }) => { if (test === this.current) this.show(); });
    t.on('join', ({ test, address }) => { if (test === this.current) this.show(); this.log(`${this.name(address)} joins the band test`); });
    t.on('start', ({ test }) => {
      this.current = test;
      this.log(`band test #${test.test} started: ${test.players.map((p) => this.name(p)).join(', ')} play `
        + `${test.bands.join('')}, ${Math.round(test.plan.seconds)} s`);
      this.tick = setInterval(() => this.show(), 1000);
      this.show();
    });
    t.on('measured', ({ test }) => { clearInterval(this.tick); if (test === this.current) this.show(); });
    t.on('report', ({ test, from }) => { this.log(`band test report from ${this.name(from)}`); if (test === this.current) this.show(); });
    t.on('done', ({ test }) => {
      this.log(`band test #${test.test} done`, 'tx');
      if (test === this.current) this.show();
      window.tincanBandTest = this.summary(test);
    });
    this.show();
  }

  detach() {
    clearInterval(this.tick);
    this.tests = null;
    this.modem = this.session = null;
    this.show();
  }

  name(address) {
    if (this.session && address === this.session.address) return this.session.callsign || `node ${address} (this one)`;
    const p = this.session?.peers.get(address);
    return p?.callsign ? `${p.callsign}` : `node ${address}`;
  }

  /** Request a test of every band this node can run, less those of open side links. */
  request() {
    if (!this.tests || this.tests.busy) return;
    const inUse = this.session.bandsInUse();
    const bands = Object.keys(BANDS).filter((b) => !inUse.includes(b));
    const window = joinWindow(this.profile);
    this.current = this.tests.request({ bands, window });
    this.log(`requested a band test of ${this.current.bands.join('')}; nodes have ${window} s to join`);
    this.show();
  }

  show() {
    const live = !!this.tests;
    const t = this.current;
    this.button.disabled = !live || !!this.tests?.busy || !!this.session?.bandsInUse().length;
    if (!live) {
      this.state.textContent = 'offline';
      this.state.className = 'pill';
      this.status.textContent = 'Join the bus to take part.';
      return;
    }
    if (!t) {
      this.state.textContent = 'ready';
      this.state.className = 'pill ok';
      const n = Object.keys(BANDS).filter((b) => this.tests.opts.canRun(b)).length;
      this.status.textContent = `A test with four players on this device's ${n} bands takes about `
        + `${Math.round(testPlan(Array(n).fill('A'), [1, 2, 3, 4]).seconds)} s, plus `
        + `${joinWindow(this.profile)} s to join and the reports, which follow on the main bus.`
        + (this.session.bandsInUse().length ? ' Close the side link first: the test would disturb it.' : '');
      return;
    }
    const pill = {
      requested: ['requested', 'live'], joining: ['waiting for joins', 'live'], starting: ['starting', 'live'],
      running: ['playing', 'live'], reporting: ['waiting for reports', 'live'], done: ['done', 'ok'],
    }[t.state] || [t.state, ''];
    this.state.textContent = pill[0];
    this.state.className = `pill ${pill[1]}`;
    const who = [...t.joins.keys()].map((a) => this.name(a)).join(', ');
    if (t.state === 'requested' || t.state === 'joining' || t.state === 'starting') {
      this.status.textContent = `Test #${t.test} from ${this.name(t.requester)} of bands ${t.bands.join('')}. `
        + `Joined so far: ${who || 'nobody'}.`;
    } else if (t.state === 'running') {
      const left = Math.max(0, t.t0 + t.plan.seconds - this.modem.ctx.currentTime);
      const k = Math.floor((this.modem.ctx.currentTime - t.t0 - 2.2) / 1.5);
      const slot = t.plan.slots[k];
      this.status.textContent = `Playing: ${Math.round(left)} s left`
        + (slot ? `; now ${this.name(slot.player)} on band ${slot.band}.` : '.')
        + ' Keep the room quiet.';
    } else {
      const got = t.players.filter((p) => t.results.has(p)).length;
      this.status.textContent = t.state === 'done'
        ? `Test #${t.test} done: results from all ${t.players.length} players.`
        : `Measured. Reports from ${got} of ${t.players.length} players so far; each takes a while on the main bus.`;
    }
    this.renderResults(t);
  }

  renderResults(t) {
    if (!t.plan || !t.results.size) { this.results.replaceChildren(); return; }
    const listeners = this.tests.listeners(t);
    const rows = [];
    for (const tx of t.players) {
      for (const rx of listeners) {
        if (tx === rx) continue;
        const known = t.results.has(rx);
        const cells = t.bands.map((b) => {
          if (!known) return el('td', { class: 'muted' }, '…');
          if (t.joins.get(tx) && !t.joins.get(tx).includes(b)) {
            return el('td', { class: 'muted', title: `${this.name(tx)} cannot play band ${b}` }, 'does not play');
          }
          const v = verdict(pairLevels(t.results, tx, rx, b));
          return el('td', { title: v.title }, el('span', { class: `pill ${v.cls}` }, v.text));
        });
        rows.push(el('tr', {}, el('td', {}, `${this.name(tx)} → ${this.name(rx)}`), ...cells));
      }
    }
    this.results.replaceChildren(
      el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'From → to'), ...t.bands.map((b) => el('th', { title: BANDS[b].name }, b)))),
        el('tbody', {}, rows)),
      el('p', {
        class: 'note',
        html: 'Each cell: how far the weaker tone arrived above the listener\'s noise, and the dominant tone\'s level '
          + `less the recessive's. 30 dB and up carries well; past ${MARGIN_DB.toFixed(1)} dB of imbalance the band `
          + 'cannot arbitrate between that pair (Part 1 §4.6). Hover a cell for the verdict.',
      }),
    );
  }

  /** The results as plain data, for the page's console and reports. */
  summary(t) {
    const out = { test: t.test, requester: t.requester, bands: t.bands, players: t.players, pairs: [] };
    for (const tx of t.players) {
      for (const rx of this.tests.listeners(t)) {
        if (tx === rx) continue;
        for (const band of t.bands) {
          const p = pairLevels(t.results, tx, rx, band);
          out.pairs.push({ from: tx, to: rx, band, ...(p && { snrDb: +p.snrDb.toFixed(1), tiltDb: +p.tiltDb.toFixed(1) }) });
        }
      }
    }
    return out;
  }
}
