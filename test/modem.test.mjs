/**
 * Modem start-up and shutdown against a stubbed browser: getUserMedia, an
 * AudioContext and AudioWorkletNode that record what they were asked to do.
 *
 * The worklet suite covers what happens once audio flows; this covers whether
 * the Console gets audio flowing at all, and says so when it cannot.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Modem, checkSupport, listMicrophones, wirelessMicReason, builtInMicrophone, CAPTURE_CONSTRAINTS, audioConstraints,
} from '../src/tincan/modem.js';

/**
 * Install a fake browser. `settings` is what the capture track reports back;
 * `suspended` keeps the AudioContext from ever running, as a browser does when
 * it decides the page has no user activation left.
 */
function fakeBrowser({ settings = {}, suspended = false, label = 'Built-in Microphone' } = {}) {
  const calls = { constraints: null, modules: [], wiring: [], posted: [], tracksStopped: 0, closed: false };
  const track = {
    label,
    getSettings: () => ({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, ...settings }),
    stop: () => { calls.tracksStopped++; },
  };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };

  class AudioContext {
    constructor(opts) {
      calls.contextOptions = opts;
      this.state = 'suspended';
      this.sampleRate = 48000;
      this.baseLatency = 0.005;
      this.outputLatency = 0.02;
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
    value: {
      mediaDevices: {
        getUserMedia: async (c) => { calls.constraints = c; return stream; },
        enumerateDevices: async () => [
          { kind: 'audioinput', deviceId: 'default', label: 'Built-in Microphone' },
          { kind: 'audiooutput', deviceId: 'spk', label: 'Built-in Speakers' },
          { kind: 'audioinput', deviceId: 'usb', label: '' },
        ],
      },
    },
  });
  return calls;
}

test('Modem.start asks for raw capture and wires microphone → worklet → speaker', async () => {
  const calls = fakeBrowser();
  const modem = new Modem({ name: 'ada', band: 'A', profile: 'T25', amplitude: 0.4 });
  const warnings = [];
  modem.on('warning', (e) => warnings.push(...e.detail.warnings));

  await modem.start();

  // Chrome lists the system default as 'default', and gives the site's last
  // choice instead unless asked for it by name.
  assert.deepEqual(calls.constraints, { audio: { ...CAPTURE_CONSTRAINTS, deviceId: { exact: 'default' } } });
  assert.deepEqual(calls.contextOptions, { latencyHint: 0 }, 'the smallest audio buffers the browser offers');
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

test('Modem.start does not report a running node while the AudioContext is still suspended', async () => {
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

test('Modem.start captures from the chosen microphone, and lists the ones there are', async () => {
  const calls = fakeBrowser();
  await new Modem({ deviceId: 'usb' }).start();

  assert.deepEqual(calls.constraints, { audio: { ...CAPTURE_CONSTRAINTS, deviceId: { exact: 'usb' } } });
  assert.deepEqual(await listMicrophones(), [
    { deviceId: 'default', label: 'Built-in Microphone' },
    { deviceId: 'usb', label: 'microphone 2' },
  ]);
});

test('Modem.diagnostics reports what the browser actually gave the node', async () => {
  fakeBrowser({ settings: { sampleRate: 48000, latency: 0.01 } });
  const modem = new Modem({ band: 'A', profile: 'T10' });
  await modem.start();

  const d = modem.diagnostics();
  assert.equal(d.audioState, 'running');
  assert.equal(d.sampleRate, 48000);
  assert.equal(d.input.label, 'Built-in Microphone');
  assert.equal(d.input.settings.echoCancellation, false);
  assert.ok(d.measuredSlopMs > 30, `${d.measuredSlopMs} ms: 20 out, 10 in, and a quarter TQ`);
  assert.equal(d.maxRange, 0, 'T10\'s 50 ms PROP_SEG cannot cover 31 ms at both ends (spec §5.6)');
  assert.equal(d.profile, 'T10');
});

test('the Modem says when the audio thread stops reporting, and when it starts again', async () => {
  fakeBrowser();
  const modem = new Modem();
  const seen = [];
  modem.on('stalled', () => seen.push('stalled'));
  modem.on('resumed', () => seen.push('resumed'));
  await modem.start();

  const t = modem.lastStatusAt;
  modem._watch(t + 1000);
  assert.deepEqual(seen, [], 'one quiet second is not a stall');
  modem._watch(t + 2500);
  assert.deepEqual(seen, ['stalled']);
  modem._watch(t + 3500);
  assert.deepEqual(seen, ['stalled'], 'said once');

  modem._onMessage({ type: 'status', stats: {} });
  modem._watch();
  assert.deepEqual(seen, ['stalled', 'resumed']);
  assert.equal(modem.diagnostics().stalled, false);
  await modem.stop();
});

test('the Modem reports audio-context state changes, and only real ones', async () => {
  fakeBrowser();
  const modem = new Modem();
  const states = [];
  modem.on('audio-state', (e) => states.push(e.detail.state));
  await modem.start();

  modem.ctx.onstatechange();
  assert.deepEqual(states, [], 'still running: nothing to report');
  modem.ctx.state = 'interrupted';
  modem.ctx.onstatechange();
  modem.ctx.onstatechange();
  modem.ctx.state = 'running';
  modem.ctx.onstatechange();
  assert.deepEqual(states, ['interrupted', 'running']);
  await modem.stop();
});

test('microphones that are probably wireless are recognised by name', () => {
  for (const label of [
    '2024 iPhone 16 Microphone', 'Default - 2024 iPhone 16 Microphone', 'Ada\'s iPad Microphone',
    'AirPods Pro', 'Beats Studio Buds', 'Bose QC45 Bluetooth Headset', 'Hands-Free AG Audio',
  ]) assert.ok(wirelessMicReason(label), label);
  for (const label of [
    'MacBook Pro Microphone', 'Built-in Microphone', 'External Microphone', 'Microphone Array (Realtek(R) Audio)',
    'Yeti Stereo Microphone', '', undefined,
  ]) assert.equal(wirelessMicReason(label), null, String(label));
});

test('the built-in microphone is picked out of a list that includes a wireless one', () => {
  const mics = [
    { deviceId: 'default', label: 'Default - 2024 iPhone 16 Microphone' },
    { deviceId: 'phone', label: '2024 iPhone 16 Microphone' },
    { deviceId: 'mac', label: 'MacBook Pro Microphone' },
  ];
  assert.equal(builtInMicrophone(mics).deviceId, 'mac');
  assert.equal(builtInMicrophone(mics.slice(0, 2)), null);
});

test('a node capturing from a wireless microphone is told to use the built-in one', async () => {
  fakeBrowser({ label: '2024 iPhone 16 Microphone' });
  const modem = new Modem();
  const warnings = [];
  modem.on('warning', (e) => warnings.push(...e.detail.warnings));
  await modem.start();

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /iPhone 16/);
  assert.match(warnings[0], /built-in microphone/);
  await modem.stop();
});

test('a browser with no "default" microphone entry is left to pick its own default', async () => {
  const calls = fakeBrowser();
  const devices = navigator.mediaDevices;
  devices.enumerateDevices = async () => [{ kind: 'audioinput', deviceId: 'mic1', label: 'Internal Microphone' }];
  await new Modem().start();
  assert.deepEqual(calls.constraints, { audio: CAPTURE_CONSTRAINTS });
  assert.deepEqual(await audioConstraints(''), CAPTURE_CONSTRAINTS);
  assert.deepEqual(await audioConstraints('mic1'), { ...CAPTURE_CONSTRAINTS, deviceId: { exact: 'mic1' } });
});

test('a latency measured by the self-test replaces the browser\'s figure for t_slop and range', async () => {
  fakeBrowser();
  const modem = new Modem({ profile: 'T10' });
  await modem.start();
  assert.equal(modem.diagnostics().latencySource, 'reported by the browser');
  assert.ok(modem.maxRange > 1, 'the browser reports 20 ms; T10 has 50 ms of PROP_SEG for twice that');

  modem.measuredLatencyMs = 58.6;               // a MacBook Pro's built-in speaker and microphone
  assert.equal(modem.measuredSlopMs, 58.6 + 1.25, 'plus a detector hop, TQ/4');
  assert.equal(modem.maxRange, 0, 'T10 cannot absorb it');
  assert.equal(modem.diagnostics().latencySource, 'measured');
});
