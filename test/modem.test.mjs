/**
 * Modem start-up and shutdown against a stubbed browser: getUserMedia, an
 * AudioContext and AudioWorkletNode that record what they were asked to do.
 *
 * The worklet suite covers what happens once audio flows; this covers whether
 * the Console gets audio flowing at all, and says so when it cannot.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Modem, checkSupport, CAPTURE_CONSTRAINTS } from '../src/tincan/modem.js';

/**
 * Install a fake browser. `settings` is what the capture track reports back;
 * `suspended` keeps the AudioContext from ever running, as a browser does when
 * it decides the page has no user activation left.
 */
function fakeBrowser({ settings = {}, suspended = false } = {}) {
  const calls = { constraints: null, modules: [], wiring: [], posted: [], tracksStopped: 0, closed: false };
  const track = {
    getSettings: () => ({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, ...settings }),
    stop: () => { calls.tracksStopped++; },
  };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };

  class AudioContext {
    constructor(opts) {
      calls.contextOptions = opts;
      this.state = 'suspended';
      this.sampleRate = 48000;
      this.destination = { label: 'speaker' };
      this.audioWorklet = { addModule: async (url) => { calls.modules.push(String(url)); } };
    }
    async resume() { if (!suspended) this.state = 'running'; }
    async close() { calls.closed = true; this.state = 'closed'; }
    createMediaStreamSource(s) {
      assert.equal(s, stream);
      return { connect: (n) => calls.wiring.push(['microphone', n.label]), disconnect() {} };
    }
  }

  class AudioWorkletNode {
    constructor(ctx, name, opts) {
      this.label = name;
      calls.nodeOptions = opts;
      this.port = { onmessage: null, postMessage: (m) => calls.posted.push(m) };
    }
    connect(dest) { calls.wiring.push([this.label, dest.label]); }
    disconnect() {}
  }

  globalThis.window = { AudioContext, isSecureContext: true };
  globalThis.AudioWorkletNode = AudioWorkletNode;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async (c) => { calls.constraints = c; return stream; } } },
  });
  return calls;
}

test('Modem.start asks for raw capture and wires microphone → worklet → speaker', async () => {
  const calls = fakeBrowser();
  const modem = new Modem({ name: 'ada', band: 'A', profile: 'T25', amplitude: 0.4 });
  const warnings = [];
  modem.on('warning', (e) => warnings.push(...e.detail.warnings));

  await modem.start();

  assert.deepEqual(calls.constraints, { audio: CAPTURE_CONSTRAINTS });
  assert.deepEqual(CAPTURE_CONSTRAINTS,
    { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    'every capture stage that would alter the signal is off');
  assert.equal(calls.modules.length, 1);
  assert.ok(calls.modules[0].endsWith('/src/tincan/worklet.js'), calls.modules[0]);
  assert.deepEqual(calls.wiring, [['microphone', 'tincan'], ['tincan', 'speaker']]);
  const o = calls.nodeOptions.processorOptions;
  assert.deepEqual([o.name, o.mode, o.band, o.profile, o.amplitude, o.muted], ['ada', 'node', 'A', 'T25', 0.4, false]);
  assert.deepEqual(calls.nodeOptions.outputChannelCount, [1]);
  assert.ok(modem.ready);
  assert.deepEqual(warnings, []);
});

test('a browser that ignores the capture constraints is reported, not hidden', async () => {
  fakeBrowser({ settings: { echoCancellation: true } });
  const modem = new Modem();
  const warnings = [];
  modem.on('warning', (e) => warnings.push(...e.detail.warnings));

  await modem.start();

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /echoCancellation/);
});

test('Modem.start does not report a running node while the AudioContext is still suspended',
  { todo: 'start() resolves with the context suspended, so the Console says "on the bus" while the worklet never runs' },
  async () => {
    // Browsers keep a context suspended when they judge the page has no user
    // activation. The Console creates its context only after awaiting the
    // microphone permission prompt, which may leave it without one.
    fakeBrowser({ suspended: true });
    const modem = new Modem();
    const warnings = [];
    modem.on('warning', (e) => warnings.push(...e.detail.warnings));

    let started = true;
    await modem.start().catch(() => { started = false; });

    assert.ok(!started || warnings.some((w) => /suspend/i.test(w)),
      'either start() rejects or it warns that audio is not running');
  });

test('Modem.stop tells the worklet to stop, releases the microphone and closes the context', async () => {
  const calls = fakeBrowser();
  const modem = new Modem();
  await modem.start();

  await modem.stop();

  assert.deepEqual(calls.posted.at(-1), { type: 'stop' });
  assert.equal(calls.tracksStopped, 1);
  assert.ok(calls.closed);
  assert.equal(modem.ready, false);
  assert.throws(() => modem.send({ id: 1, data: [] }), /not started/);
});

test('checkSupport names an insecure page as the reason the microphone is unavailable', () => {
  fakeBrowser();
  assert.deepEqual(checkSupport(), { ok: true, problems: [] });

  globalThis.window.isSecureContext = false;
  const s = checkSupport();
  assert.equal(s.ok, false);
  assert.match(s.problems.join('; '), /secure context/);
});
