/**
 * Band tests — Part 2 §9.
 *
 * Every node that joins plays each band's two tones in its own slot; every
 * node listening measures what arrives; the players then report what they
 * heard on the main bus. This module lays the test out, makes and measures
 * its tones, packs and unpacks reports, and runs the exchange over a Session.
 * It touches audio only through an adapter, so the same code runs in a
 * browser (apps/bandtest.js) and in the acoustic simulation (test/).
 */

import { BANDS, timing } from './params.js';
import { CONTROL, parseBaseId, TOPIC } from './transport.js';

/** The layout of §9.3, in seconds from time 0. */
export const LAYOUT = {
  quiet: [1.0, 2.2],
  noiseAt: [1.15, 1.45, 1.75],
  first: 2.2,
  slot: 1.5,
  tones: [[0.1, 0.7], [0.8, 1.4]],
  measureAt: [0.25, 0.95],
  window: 0.3,
  tail: 0.5,
  ramp: 0.01,
};

export const MAX_PLAYERS = 5;

/** A band's tones, recessive first. */
export const tonesOf = (band) => [BANDS[band].fR, BANDS[band].fD];

/**
 * @param {string[]} bands lowest ID first
 * @param {number[]} players in slot order
 */
export function testPlan(bands, players) {
  const slots = [];
  players.forEach((player, p) => bands.forEach((band, b) => {
    slots.push({ player, band, start: LAYOUT.first + LAYOUT.slot * (p * bands.length + b) });
  }));
  return { bands, players, slots, seconds: LAYOUT.first + LAYOUT.slot * slots.length + LAYOUT.tail };
}

/**
 * What player `me` plays, from time 0 to the end of the test.
 * @param {number} fs
 * @param {ReturnType<typeof testPlan>} plan
 * @param {number} me
 * @param {{canPlay?:(band:string)=>boolean, amplitude?:number}} [o]
 */
export function testSignal(fs, plan, me, { canPlay = () => true, amplitude = 0.25 } = {}) {
  const out = new Float32Array(Math.round(plan.seconds * fs));
  const ramp = Math.round(LAYOUT.ramp * fs);
  for (const s of plan.slots) {
    if (s.player !== me || !canPlay(s.band)) continue;
    tonesOf(s.band).forEach((f, i) => {
      const [a, b] = LAYOUT.tones[i];
      const k0 = Math.round((s.start + a) * fs);
      const n = Math.round((b - a) * fs);
      const w = (2 * Math.PI * f) / fs;
      for (let k = 0; k < n; k++) {
        const edge = Math.min(k, n - 1 - k);
        const g = edge < ramp ? 0.5 - 0.5 * Math.cos((Math.PI * edge) / ramp) : 1;
        out[k0 + k] = amplitude * g * Math.sin(w * k);
      }
    });
  }
  return out;
}

/** Amplitude of a tone at `f` over [t0, t0 + LAYOUT.window), Hann-windowed. */
export function toneLevel(rec, fs, f, t0) {
  const k0 = Math.round(t0 * fs);
  const n = Math.round(LAYOUT.window * fs);
  const w = (2 * Math.PI * f) / fs;
  const c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0, sum = 0;
  for (let k = 0; k < n; k++) {
    const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (n - 1));
    sum += h;
    const s0 = h * (rec[k0 + k] || 0) + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const re = s1 - s2 * Math.cos(w);
  const im = s2 * Math.sin(w);
  return (2 * Math.hypot(re, im)) / sum;
}

/**
 * What one node heard: its noise at each tone, and each player's tones.
 * Levels are amplitudes relative to full scale; null where not measured.
 * @param {Float32Array} rec the input from time 0
 * @param {number} fs
 * @param {ReturnType<typeof testPlan>} plan
 * @param {(band:string)=>boolean} [canHear]
 * @returns {{noise:Object<string,(number|null)[]>, heard:Object<number,Object<string,(number|null)[]>>}}
 */
export function measureTest(rec, fs, plan, canHear = () => true) {
  const noise = {};
  for (const band of plan.bands) {
    noise[band] = tonesOf(band).map((f) => (canHear(band)
      ? Math.sqrt(LAYOUT.noiseAt.reduce((s, t) => s + toneLevel(rec, fs, f, t) ** 2, 0) / LAYOUT.noiseAt.length)
      : null));
  }
  const heard = {};
  for (const s of plan.slots) {
    heard[s.player] ??= {};
    heard[s.player][s.band] = tonesOf(s.band).map((f, i) => (canHear(s.band)
      ? toneLevel(rec, fs, f, s.start + LAYOUT.measureAt[i]) : null));
  }
  return { noise, heard };
}

/** §9.4: one octet per level, 0.5 dB steps below full scale; 255 not measured. */
export function levelCode(a) {
  if (a == null) return 255;
  return Math.max(0, Math.min(254, Math.round(-40 * Math.log10(Math.max(a, 1e-9)))));
}
export const levelOf = (code) => (code === 255 ? null : 10 ** (-code / 40));

/** The levels of `me`'s TEST_REPORT (§9.4). */
export function encodeReport(plan, me, m) {
  const out = [];
  for (const band of plan.bands) out.push(...m.noise[band].map(levelCode));
  for (const p of plan.players) {
    if (p === me) continue;
    for (const band of plan.bands) out.push(...m.heard[p][band].map(levelCode));
  }
  return Uint8Array.from(out);
}

/** A TEST_REPORT's levels, in the shape `measureTest` returns, or null if short. */
export function decodeReport(plan, reporter, levels) {
  const B = plan.bands.length;
  const others = plan.players.filter((p) => p !== reporter);
  if (levels.length < 2 * B * (1 + others.length)) return null;
  let i = 0;
  const pair = () => [levelOf(levels[i++]), levelOf(levels[i++])];
  const noise = {};
  for (const band of plan.bands) noise[band] = pair();
  const heard = {};
  for (const p of others) {
    heard[p] = {};
    for (const band of plan.bands) heard[p][band] = pair();
  }
  return { noise, heard };
}

const dB = (a) => 20 * Math.log10(Math.max(a, 1e-9));

/**
 * How `rx` heard `tx` on `band`: the weaker tone's height above rx's noise,
 * and the dominant tone's level less the recessive's (Part 1 §4.6). Null if
 * rx did not measure it.
 */
export function pairLevels(results, tx, rx, band) {
  const r = results.get(rx);
  const heard = r?.heard[tx]?.[band];
  const noise = r?.noise[band];
  if (!heard || !noise || heard.includes(null) || noise.includes(null)) return null;
  return {
    snrDb: Math.min(dB(heard[0]) - dB(noise[0]), dB(heard[1]) - dB(noise[1])),
    tiltDb: dB(heard[1]) - dB(heard[0]),
    levelDb: [dB(heard[0]), dB(heard[1])],
  };
}

/** Seconds to wait for joins: enough for five joins at the main bus's speed. */
export function joinWindow(profile) {
  const joinFrame = (59 + 8 * 4) * 1.2 * timing(profile).bitTime;
  return Math.max(10, Math.min(255, Math.ceil(5 * joinFrame)));
}

/**
 * Runs band tests over a main-bus Session — Part 2 §9.
 *
 * The audio adapter works on the timeline of the node's input, in seconds:
 *   sampleRate
 *   now()                      the current time
 *   after(seconds, fn)         call fn later
 *   hold(until)                stop the main-bus receiver until then (§9.3)
 *   play(signal, at)           play signal, sample 0 at `at`; parts already past are skipped
 *   record(at, samples, done)  record from `at`; parts already past are zeros
 *
 * Events: 'request' {test}, 'state' {test}, 'join' {test, address}, 'start' {test},
 * 'measured' {test}, 'report' {test, from}, 'done' {test}, 'log' {text, kind}.
 */
export class BandTests {
  /**
   * @param {import('./transport.js').Session} session
   * @param {object} audio see above
   * @param {object} [opts]
   * @param {(band:string)=>boolean} [opts.canRun] bands this node can play and hear
   * @param {number} [opts.amplitude] tone level, as for frames
   * @param {number|(()=>number)} [opts.latencyMs] speaker to microphone, to start tones early by
   * @param {boolean} [opts.listenOnly] never join
   * @param {(test:object)=>boolean} [opts.join] whether to join another node's test
   */
  constructor(session, audio, opts = {}) {
    this.session = session;
    this.audio = audio;
    this.opts = { canRun: () => true, amplitude: 0.25, latencyMs: 0, listenOnly: false, join: () => true, ...opts };
    this.tests = new Map();
    this.handlers = new Map();
    this.nextTest = 1 + Math.floor(Math.random() * 255);
    session.on('band-test', (e) => this._onMessage(e));
    session.protocol.on('tx-complete', ({ frame, at }) => this._onSent(frame, at));
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(fn);
    return () => this.handlers.get(event).delete(fn);
  }

  _emit(event, detail) {
    for (const fn of this.handlers.get(event) || []) fn(detail);
  }

  _log(text, kind = '') { this._emit('log', { text, kind }); }

  get me() { return this.session.address; }

  /** A test in progress or done, if any is not done yet. */
  get busy() {
    return [...this.tests.values()].some((t) => t.state !== 'done' && t.state !== 'abandoned');
  }

  _test(requester, test) {
    const key = `${requester}:${test}`;
    if (!this.tests.has(key)) {
      this.tests.set(key, {
        requester, test, bands: [], window: 0, joins: new Map(), players: [], plan: null,
        t0: null, state: 'requested', results: new Map(), mine: requester === this.me,
      });
    }
    return this.tests.get(key);
  }

  /** Ask every node on the main bus to test `bands` (§9.2). */
  request({ bands, window }) {
    const test = this.nextTest;
    this.nextTest = (this.nextTest % 255) + 1;
    const t = this._test(this.me, test);
    t.bands = bands.filter((b) => this.opts.canRun(b)).sort((a, b) => BANDS[a].id - BANDS[b].id);
    t.window = window;
    t.joins.set(this.me, t.bands);
    this.session.sendTestMessage({ op: CONTROL.TEST_REQUEST, test, bands: t.bands, window });
    this._emit('request', { test: t });
    return t;
  }

  /** The requester's own frames: its request's delivery and its start (§9.2, §9.3). */
  _onSent(frame, at) {
    if (!frame || frame.extended || parseBaseId(frame.id).topic !== TOPIC.CONTROL) return;
    if (parseBaseId(frame.id).source !== this.me) return;
    const [op, test] = frame.data;
    const t = this.tests.get(`${this.me}:${test}`);
    if (!t) return;
    if (op === CONTROL.TEST_REQUEST && t.state === 'requested') {
      t.state = 'joining';
      this._emit('state', { test: t });
      this._log(`band test #${test}: waiting ${t.window} s for nodes to join`);
      this.audio.after(t.window, () => this._start(t));
    } else if (op === CONTROL.TEST_START && t.state === 'starting') {
      this._begin(t, at ?? this.audio.now());
    }
  }

  _start(t) {
    if (t.state !== 'joining') return;
    t.players = [...t.joins.keys()].slice(0, MAX_PLAYERS);
    t.state = 'starting';
    this._emit('state', { test: t });
    this.session.sendTestMessage({ op: CONTROL.TEST_START, test: t.test, bands: t.bands, players: t.players });
  }

  _onMessage({ message: c, source, at }) {
    switch (c.op) {
      case CONTROL.TEST_REQUEST: {
        if (source === this.me) return;
        const t = this._test(source, c.test);
        Object.assign(t, { bands: c.bands, window: c.window });
        t.joins.set(source, c.bands);
        const mine = c.bands.filter((b) => this.opts.canRun(b));
        if (!this.opts.listenOnly && mine.length && this.opts.join(t)) {
          this.session.sendTestMessage({ op: CONTROL.TEST_JOIN, requester: source, test: c.test, bands: mine });
          t.joins.set(this.me, mine);
          t.joined = true;
        }
        this._emit('request', { test: t });
        return;
      }
      case CONTROL.TEST_JOIN: {
        const t = this.tests.get(`${c.requester}:${c.test}`);
        if (!t || t.players.length) return;
        if (!t.joins.has(source)) t.joins.set(source, c.bands);
        this._emit('join', { test: t, address: source });
        return;
      }
      case CONTROL.TEST_START: {
        const t = this._test(source, c.test);
        if (t.plan) return;
        Object.assign(t, { bands: c.bands, players: c.players });
        this._begin(t, at ?? this.audio.now());
        return;
      }
      case CONTROL.TEST_REPORT: {
        const t = this.tests.get(`${c.requester}:${c.test}`);
        if (!t?.plan || !t.players.includes(source)) return;
        const r = decodeReport(t.plan, source, c.levels);
        if (!r) { this._log(`band test #${c.test}: short report from node ${source}`, 'err'); return; }
        t.results.set(source, r);
        this._emit('report', { test: t, from: source });
        this._checkDone(t);
        return;
      }
      default:
    }
  }

  _begin(t, t0) {
    const { audio, opts } = this;
    t.t0 = t0;
    t.plan = testPlan(t.bands, t.players);
    t.state = 'running';
    const fs = audio.sampleRate;
    audio.hold(t0 + t.plan.seconds);
    if (t.players.includes(this.me)) {
      const signal = testSignal(fs, t.plan, this.me, { canPlay: opts.canRun, amplitude: opts.amplitude });
      const latencyMs = typeof opts.latencyMs === 'function' ? opts.latencyMs() : opts.latencyMs;
      audio.play(signal, t0 - (latencyMs || 0) / 1000);
    }
    audio.record(t0, Math.round(t.plan.seconds * fs), (rec) => this._measured(t, rec));
    this._emit('start', { test: t });
  }

  _measured(t, rec) {
    const m = measureTest(rec, this.audio.sampleRate, t.plan, this.opts.canRun);
    t.results.set(this.me, m);
    t.state = 'reporting';
    if (t.players.includes(this.me)) {
      this.session.sendTestMessage({
        op: CONTROL.TEST_REPORT, requester: t.requester, test: t.test, levels: encodeReport(t.plan, this.me, m),
      });
    }
    this._emit('measured', { test: t });
    this._checkDone(t);
  }

  _checkDone(t) {
    if (!t.results.has(this.me)) return;
    if (t.players.every((p) => t.results.has(p))) {
      t.state = 'done';
      this._emit('done', { test: t });
    }
  }

  /** Who heard whom: listeners are the players and this node. */
  listeners(t) {
    return [...new Set([...t.players, this.me])];
  }
}
