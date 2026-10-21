/**
 * Browser front end for a TinCAN node.
 *
 * This is the only module in the bundle that touches the DOM or Web Audio.
 * It owns the AudioContext, the microphone stream, and the AudioWorklet that
 * runs the actual protocol (see worklet.js); it does no protocol work itself.
 */

import { BANDS, PROFILES, timing, maxRange } from './params.js';

const WORKLET_URL = new URL('./worklet.js', import.meta.url);

/**
 * Capture constraints. Every one of these matters — see rationale §9.
 * Echo cancellation is the dangerous one: it is designed to subtract your own
 * transmitted signal from what you hear, which is precisely the signal that
 * bit monitoring and arbitration depend on.
 */
export const CAPTURE_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
};

/**
 * The AudioContext options for a node. 'interactive' rather than the smallest
 * buffers (`latencyHint: 0`), which save about 5 ms of latency but leave the
 * audio thread less slack: on a MacBook Pro in Chrome, one of two nodes in
 * two tabs at `0` lost about 20 ms of microphone input a second, and misread
 * a T2 frame; at 'interactive' the same pair exchanged frames cleanly. Every
 * lost stretch makes all later edges arrive early, and enough of it moves the
 * sample point into the next bit (spec §5.5).
 */
export const CONTEXT_OPTIONS = { latencyHint: 'interactive' };

/** A stall of the audio thread this long within one second is reported. */
const STALL_MS = 25;

/**
 * getUserMedia audio constraints for the microphone `deviceId`, or for the
 * system default when it is empty.
 *
 * Asking for no device in particular does not get the system default in
 * Chrome: it gets the microphone last chosen for this site, in its permission
 * prompt or site settings, which can be a phone left over from a call. Chrome
 * lists the system default as the device 'default', so ask for that by name;
 * other browsers have no such entry and do give the default.
 */
export async function audioConstraints(deviceId) {
  if (deviceId) return { ...CAPTURE_CONSTRAINTS, deviceId: { exact: deviceId } };
  const mics = await listMicrophones().catch(() => []);
  return mics.some((m) => m.deviceId === 'default')
    ? { ...CAPTURE_CONSTRAINTS, deviceId: { exact: 'default' } }
    : CAPTURE_CONSTRAINTS;
}

export class Modem extends EventTarget {
  /**
   * @param {object} [opts]
   * @param {'A'|'B'|'C'|'D'|'E'} [opts.band]
   * @param {'T100'|'T50'|'T25'|'T10'|'T5'|'T4'|'T2'} [opts.profile]
   * @param {'node'|'listener'} [opts.mode]
   * @param {number} [opts.amplitude]
   * @param {string} [opts.name]
   * @param {string} [opts.deviceId] microphone to capture from; the default if omitted
   */
  constructor(opts = {}) {
    super();
    this.opts = {
      band: 'A', profile: 'T25', mode: 'node', amplitude: 0.25, name: 'node',
      ...opts,
    };
    this.ctx = null;
    this.node = null;
    this.stream = null;
    this.ready = false;
    this.muted = this.opts.mode === 'listener';
    this.status = null;
    this.warnings = [];
    this.lastStatusAt = 0;
    this.stalled = false;
    this.watchdog = null;
  }

  get band() { return BANDS[this.opts.band]; }
  get profile() { return PROFILES[this.opts.profile]; }
  get timing() { return timing(this.opts.profile); }
  get maxRange() { return maxRange(this.opts.profile, this.measuredSlopMs); }

  /**
   * t_slop in milliseconds (spec §5.6): the speaker-to-microphone latency
   * measured by the self-test when one has been set in `measuredLatencyMs`,
   * otherwise output plus input latency as the browser reports them, which
   * leaves out the device's own processing. Either way plus a detector hop.
   */
  get measuredSlopMs() {
    if (!this.ctx) return undefined;
    if (this.measuredLatencyMs != null) return this.measuredLatencyMs + (this.timing.tq / 4) * 1000;
    const out = (this.ctx.outputLatency || this.ctx.baseLatency || 0) * 1000;
    // The track's own statistics, where the browser keeps them, give the
    // input latency the device really has (34 ms on a MacBook Pro in Chrome,
    // where its settings claim 2.7 ms).
    const stats = this._inputStats();
    const settings = this.stream && this.stream.getAudioTracks()[0]?.getSettings?.();
    const inp = stats?.latency ?? (settings && settings.latency ? settings.latency * 1000 : 0);
    const hop = (this.timing.tq / 4) * 1000;
    return out + inp + hop;
  }

  async start() {
    if (this.ready) return this;

    const audio = await audioConstraints(this.opts.deviceId);
    this.stream = await navigator.mediaDevices.getUserMedia({ audio });
    this._checkCaptureSettings();

    this.ctx = new (window.AudioContext || window.webkitAudioContext)(CONTEXT_OPTIONS);
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    // Some browsers fire statechange without the state changing; report changes only.
    // Read the state from this context, not this.ctx, which stop() clears
    // before the context reports that it has closed.
    const ctx = this.ctx;
    let lastState = ctx.state;
    ctx.onstatechange = () => {
      const state = ctx.state;
      if (state === lastState) return;
      lastState = state;
      this.dispatchEvent(new CustomEvent('audio-state', { detail: { state } }));
    };
    if (this.ctx.state !== 'running') {
      // A suspended context runs no worklet: the node would look joined and
      // do nothing at all. Browsers do this when they judge the page has no
      // user activation left, which awaiting the permission prompt can cost.
      this._warn(`The audio context is ${this.ctx.state}, not running, so this node can neither `
        + 'hear nor transmit. Click anywhere on the page; if that does not start it, leave and join again.');
    }

    await this.ctx.audioWorklet.addModule(WORKLET_URL);

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'tincan', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        name: this.opts.name,
        mode: this.opts.mode,
        band: this.opts.band,
        profile: this.opts.profile,
        amplitude: this.opts.amplitude,
        thetaD: this.opts.thetaD,
        kappa: this.opts.kappa,
        muted: this.muted,
        strict: this.opts.strict,
        capture: this.opts.capture || 0,
      },
    });

    this.node.port.onmessage = (e) => this._onMessage(e.data);
    this.source.connect(this.node);
    this.node.connect(this.ctx.destination);

    this.ready = true;
    this.lastStatusAt = Date.now();
    this.clock = { wall: performance.now(), audio: this.ctx.currentTime ?? 0, behindMs: 0, reportedMs: 0 };
    this.watchdog = setInterval(() => this._watch(), 1000);
    this.watchdog.unref?.();
    this.dispatchEvent(new CustomEvent('start', { detail: { sampleRate: this.ctx.sampleRate } }));
    return this;
  }

  /**
   * The worklet reports ten times a second. If that stops, the audio thread
   * is not running, and nothing else on the page will say so.
   */
  /** The capture track's statistics (Chrome), or null. */
  _inputStats() {
    const track = this.stream && this.stream.getAudioTracks()[0];
    try { return track && track.stats ? track.stats : null; } catch { return null; }
  }

  /**
   * Audio the microphone produced but the page never got, in ms. A gap moves
   * every later edge relative to this node's bit clock, as a jump the
   * resynchronization of §5.5 can only follow by SJW per edge.
   */
  _checkDropped() {
    const s = this._inputStats();
    if (!s || !s.totalFramesDuration) return;
    const dropped = s.totalFramesDuration - s.deliveredFramesDuration;
    const before = this.droppedInputMs ?? dropped;
    this.droppedInputMs = dropped;
    if (dropped > before + 0.5) {
      this.dispatchEvent(new CustomEvent('input-dropped', { detail: { ms: dropped - before, totalMs: dropped } }));
    }
  }

  /**
   * Sudden stalls of the audio thread. A thread that stops for tens of
   * milliseconds may leave the browser no room for the microphone audio that
   * arrived meanwhile, and it discards it, uncounted by the track's
   * statistics. Slow divergence between the audio and system clocks is not
   * that: two tabs' nodes drifted 1 ms a second apart from real time while
   * their input stayed on an exact grid. So only a jump of STALL_MS within
   * one check is reported, as a possible loss.
   */
  _checkBehind(wall = performance.now(), audio = this.ctx?.currentTime) {
    if (!this.clock || audio === undefined || this.ctx?.state !== 'running') return;
    const behind = (wall - this.clock.wall) - (audio - this.clock.audio) * 1000;
    const step = behind - (this.clock.last ?? behind);
    this.clock.last = behind;
    this.clock.behindMs = behind;
    if (step >= STALL_MS) {
      this.clock.reportedMs += step;
      this.dispatchEvent(new CustomEvent('input-lost', { detail: { ms: step, totalMs: this.clock.reportedMs } }));
    }
  }

  _watch(now = Date.now()) {
    this._checkDropped();
    this._checkBehind();
    const quiet = now - this.lastStatusAt > 2000;
    if (quiet && !this.stalled) {
      this.stalled = true;
      this.dispatchEvent(new CustomEvent('stalled', { detail: { state: this.ctx && this.ctx.state } }));
    } else if (!quiet && this.stalled) {
      this.stalled = false;
      this.dispatchEvent(new CustomEvent('resumed', {}));
    }
  }

  _warn(text) {
    this.warnings.push(text);
    this.dispatchEvent(new CustomEvent('warning', { detail: { warnings: [text] } }));
  }

  /** What the browser gave this node, for a diagnostics panel or report. */
  diagnostics() {
    const track = this.stream && this.stream.getAudioTracks()[0];
    return {
      band: this.opts.band,
      profile: this.opts.profile,
      audioState: this.ctx ? this.ctx.state : 'none',
      sampleRate: this.ctx ? this.ctx.sampleRate : null,
      baseLatency: this.ctx ? this.ctx.baseLatency ?? null : null,
      outputLatency: this.ctx ? this.ctx.outputLatency ?? null : null,
      measuredSlopMs: this.measuredSlopMs ?? null,
      latencySource: this.measuredLatencyMs != null ? 'measured' : 'reported by the browser',
      maxRange: this.ctx ? this.maxRange : null,
      input: track ? {
        label: track.label || '',
        settings: track.getSettings ? track.getSettings() : {},
        latencyMs: this._inputStats()?.latency ?? null,
        droppedMs: this.droppedInputMs ?? null,
        lostMs: this.clock ? this.clock.reportedMs : null,
      } : null,
      stalled: this.stalled,
      warnings: [...this.warnings],
    };
  }

  /**
   * Browsers may quietly ignore the capture constraints. A node whose input has
   * echo cancellation applied cannot hear its own transmissions and will fail
   * arbitration in ways that look like hardware faults, so say so loudly.
   */
  _checkCaptureSettings() {
    const track = this.stream.getAudioTracks()[0];
    const s = track && track.getSettings ? track.getSettings() : {};
    this.warnings = [];
    for (const key of ['echoCancellation', 'noiseSuppression', 'autoGainControl']) {
      if (s[key] === true) {
        this.warnings.push(
          `${key} is still enabled on the capture track. This browser ignored the ` +
          `request to turn it off. Arbitration and bit monitoring will be unreliable.`);
      }
    }
    const wireless = track && wirelessMicReason(track.label);
    if (wireless) {
      this.warnings.push(
        `The microphone "${track.label}" looks like ${wireless}. Wireless microphones hear 100–200 ms `
        + 'late, far later than any TinCAN timing profile allows, so this node will misread its own bits. '
        + 'Leave, choose this computer\'s built-in microphone (or a wired one, if it has none), and join again.');
    }
    if (this.warnings.length) {
      this.dispatchEvent(new CustomEvent('warning', { detail: { warnings: this.warnings } }));
    }
  }

  async stop() {
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    if (this.node) { this.node.port.postMessage({ type: 'stop' }); this.node.disconnect(); }
    if (this.source) this.source.disconnect();
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    if (this.ctx) await this.ctx.close();
    this.ready = false;
    this.node = this.ctx = this.stream = this.source = null;
    this.dispatchEvent(new CustomEvent('stop'));
  }

  /**
   * The input the node has heard over the last `opts.capture` seconds, as
   * 16-bit samples ending now — for diagnosis, when started with `capture`.
   */
  dumpCapture() {
    return new Promise((resolve) => {
      const off = this.on('capture', (e) => { off(); resolve({ ...e.detail, sampleRate: this.ctx.sampleRate }); });
      this.node.port.postMessage({ type: 'dump' });
    });
  }

  /** Queue a frame. Resolves when the worklet has accepted or rejected it. */
  send(frame) {
    if (!this.node) throw new Error('modem is not started');
    const data = frame.data ? Array.from(frame.data) : undefined;
    this.node.port.postMessage({ type: 'send', frame: { ...frame, data } });
  }

  setMuted(v) {
    this.muted = !!v;
    if (this.node) this.node.port.postMessage({ type: 'mute', value: this.muted });
  }

  setAmplitude(v) {
    this.opts.amplitude = v;
    if (this.node) this.node.port.postMessage({ type: 'amplitude', value: v });
  }

  setThresholds({ thetaD, kappa }) {
    if (this.node) this.node.port.postMessage({ type: 'threshold', thetaD, kappa });
  }

  clearQueue() {
    if (this.node) this.node.port.postMessage({ type: 'clear-queue' });
  }

  on(type, fn) {
    this.addEventListener(type, fn);
    return () => this.removeEventListener(type, fn);
  }

  _onMessage(m) {
    switch (m.type) {
      case 'ready':
        this.info = m;
        this.dispatchEvent(new CustomEvent('ready', { detail: m }));
        break;
      case 'status':
        this.status = m;
        this.lastStatusAt = Date.now();
        this.dispatchEvent(new CustomEvent('status', { detail: m }));
        break;
      case 'event': {
        const detail = m.detail || {};
        if (detail.frame && detail.frame.data) detail.frame.data = Uint8Array.from(detail.frame.data);
        this.dispatchEvent(new CustomEvent(m.event, { detail }));
        this.dispatchEvent(new CustomEvent('*', { detail: { event: m.event, ...detail } }));
        break;
      }
      case 'accepted':
      case 'rejected':
        this.dispatchEvent(new CustomEvent(m.type, { detail: m }));
        break;
      case 'capture':
        this.dispatchEvent(new CustomEvent('capture', { detail: m }));
        break;
      default:
        break;
    }
  }
}

/** True when this browser can run a TinCAN node at all. */
export function checkSupport() {
  const problems = [];
  if (typeof AudioWorkletNode === 'undefined') problems.push('AudioWorklet is not available');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    problems.push('microphone access (getUserMedia) is not available');
  }
  if (!window.isSecureContext) {
    problems.push('this page is not a secure context, so the microphone cannot be used — serve over https:// or localhost');
  }
  return { ok: problems.length === 0, problems };
}

/**
 * The microphones this browser offers. Labels are empty until the page has
 * been granted microphone access once, so call it again after starting.
 * @returns {Promise<{deviceId: string, label: string}[]>}
 */
export async function listMicrophones() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'audioinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `microphone ${i + 1}` }));
}

/**
 * Why a microphone, judged by its label, is probably wireless, or null.
 *
 * A wireless microphone (an iPhone used through macOS Continuity, AirPods, any
 * Bluetooth headset) delays what it hears by 100–200 ms, several times more
 * than any TinCAN profile tolerates (spec §5.6), and is seldom anywhere near
 * this computer's speaker. Labels are all a page can see, so this is a guess.
 */
export function wirelessMicReason(label) {
  const l = String(label || '');
  if (/\biphone\b|\bipad\b|continuity/i.test(l)) return 'a phone or tablet used as a wireless microphone';
  if (/airpods|beats|\bbuds\b|bluetooth|hands-?free|\bBT\b/i.test(l)) return 'a Bluetooth microphone';
  return null;
}

/** The microphone most likely to be built into this computer, or null. */
export function builtInMicrophone(mics) {
  return mics.find((m) => m.deviceId !== 'default'
    && /built-?in|internal|macbook|imac|laptop|\bintegrated\b/i.test(m.label)
    && !wirelessMicReason(m.label)) || null;
}
