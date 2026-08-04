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

export class Modem extends EventTarget {
  /**
   * @param {object} [opts]
   * @param {'A'|'B'|'C'|'D'} [opts.band]
   * @param {'T100'|'T50'|'T25'|'T10'} [opts.profile]
   * @param {'node'|'listener'} [opts.mode]
   * @param {number} [opts.amplitude]
   * @param {string} [opts.name]
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
  }

  get band() { return BANDS[this.opts.band]; }
  get profile() { return PROFILES[this.opts.profile]; }
  get timing() { return timing(this.opts.profile); }
  get maxRange() { return maxRange(this.opts.profile, this.measuredSlopMs); }

  /** Combined output + input latency, milliseconds, if the browser reports it. */
  get measuredSlopMs() {
    if (!this.ctx) return undefined;
    const out = (this.ctx.outputLatency || this.ctx.baseLatency || 0) * 1000;
    const settings = this.stream && this.stream.getAudioTracks()[0]?.getSettings?.();
    const inp = settings && settings.latency ? settings.latency * 1000 : 0;
    const hop = (this.timing.tq / 4) * 1000;
    return out + inp + hop;
  }

  async start() {
    if (this.ready) return this;

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: CAPTURE_CONSTRAINTS });
    this._checkCaptureSettings();

    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();

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
      },
    });

    this.node.port.onmessage = (e) => this._onMessage(e.data);
    this.source.connect(this.node);
    this.node.connect(this.ctx.destination);

    this.ready = true;
    this.dispatchEvent(new CustomEvent('start', { detail: { sampleRate: this.ctx.sampleRate } }));
    return this;
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
    if (this.warnings.length) {
      this.dispatchEvent(new CustomEvent('warning', { detail: { warnings: this.warnings } }));
    }
  }

  async stop() {
    if (this.node) { this.node.port.postMessage({ type: 'stop' }); this.node.disconnect(); }
    if (this.source) this.source.disconnect();
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    if (this.ctx) await this.ctx.close();
    this.ready = false;
    this.node = this.ctx = this.stream = this.source = null;
    this.dispatchEvent(new CustomEvent('stop'));
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
