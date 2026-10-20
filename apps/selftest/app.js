/**
 * TinCAN Self-test — two real nodes in one browser, through a simulated room,
 * and a microphone check that measures the real one.
 *
 * The same harness as test/worklet.test.mjs, but on the browser's own
 * AudioWorklet, MessagePort and module loader, which no Node test can reach.
 * It renders offline, so it is silent and faster than real time.
 */

import { Modem, CAPTURE_CONSTRAINTS } from '../../src/tincan/modem.js';
import { Session } from '../../src/tincan/transport.js';
import { formatFrame } from '../../src/tincan/frame.js';
import { $, el, LogView, topbar, escapeHtml, download, fillMicrophones, reportHeader, reportName } from '../ui.js';
import {
  buildProbeSignal, analyseSelf, analysePeer, assess, RECORD_SECONDS, TONE_HZ,
} from './probe.js';

$('#chrome').replaceWith(topbar('Self-test'));

const FS = 48000;
const SECONDS = 45;
const WORKLET_URL = new URL('../../src/tincan/worklet.js', import.meta.url);

const checks = new LogView($('#checks'), { limit: 50 });
const log = new LogView($('#log'), { limit: 400 });

const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
$('#env').textContent = `${navigator.userAgent} — `
  + (typeof AudioWorkletNode === 'undefined' ? 'no AudioWorklet' : 'AudioWorklet available')
  + (window.isSecureContext ? ', secure context' : ', NOT a secure context');

const results = { checks: [], self: null, peer: null, input: null, fs: null };

function check(ok, text) {
  checks.add(`${ok ? '✓' : '✗'} ${escapeHtml(text)}`, ok ? '' : 'err');
  results.checks.push({ ok, text });
  return ok;
}

function setVerdict(text, kind) {
  $('#verdict').textContent = text;
  $('#verdict').className = `pill ${kind}`;
}

/**
 * Two nodes, each hearing itself and the other 3 ms later at equal level,
 * plus a little noise: conditions in which every Node test passes.
 */
async function run() {
  if (!Offline || typeof AudioWorkletNode === 'undefined') {
    check(false, 'this browser has no OfflineAudioContext or AudioWorklet');
    return false;
  }
  const ctx = new Offline(1, FS * SECONDS, FS);
  try {
    await ctx.audioWorklet.addModule(WORKLET_URL);
  } catch (err) {
    check(false, `the worklet module did not load: ${err.message || err}`);
    return false;
  }
  check(true, 'the worklet module loaded');

  const now = () => ctx.currentTime.toFixed(2).padStart(5);
  const errors = [];

  function node(name, address) {
    const worklet = new AudioWorkletNode(ctx, 'tincan', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { name, mode: 'node', band: 'A', profile: 'T25', amplitude: 0.25 },
    });
    const modem = new Modem({ name, profile: 'T25' });
    modem.node = worklet;
    worklet.port.onmessage = (e) => modem._onMessage(e.data);
    // Exactly the adapter the Console builds.
    const session = new Session({
      on: (ev, fn) => modem.on(ev, (e) => fn(e.detail)),
      send: (frame) => modem.send(frame),
    }, { address, callsign: name });

    const n = { name, worklet, modem, session, ready: false, peers: [], heard: [] };
    modem.on('ready', () => { n.ready = true; });
    session.on('presence', (p) => n.peers.push(p.announce.callsign));
    session.on('message', (m) => n.heard.push(m.text));
    modem.on('tx-complete', (e) => log.add(`${now()} ${name} ✓ delivered ${escapeHtml(formatFrame(e.detail.frame))}`, 'tx'));
    modem.on('frame', (e) => log.add(`${now()} ${name} ← ${escapeHtml(formatFrame(e.detail.frame))}`));
    modem.on('arbitration-lost', () => log.add(`${now()} ${name} lost arbitration`, 'warnrow'));
    modem.on('error-frame', (e) => {
      errors.push(`${name}: ${e.detail.kind}`);
      log.add(`${now()} ${name} ${escapeHtml(e.detail.kind)} error ${escapeHtml(e.detail.detail || '')}`, 'err');
    });
    return n;
  }

  const ada = node('ada', 3);
  const bob = node('bob', 12);

  for (const [from, to] of [[ada, ada], [ada, bob], [bob, ada], [bob, bob]]) {
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.003;
    from.worklet.connect(delay);
    delay.connect(to.worklet);
  }
  const noise = ctx.createBufferSource();
  noise.buffer = ctx.createBuffer(1, FS * SECONDS, FS);
  const nd = noise.buffer.getChannelData(0);
  let seed = 1;
  for (let i = 0; i < nd.length; i++) { seed = (seed * 16807) % 2147483647; nd[i] = 0.0005 * ((seed / 2147483647) * 2 - 1); }
  noise.connect(ada.worklet);
  noise.connect(bob.worklet);
  noise.start();
  ada.worklet.connect(ctx.destination);
  bob.worklet.connect(ctx.destination);

  // An offline context delivers port messages only while it is paused, so
  // pause it every 100 ms, as a live context effectively does all the time.
  const script = new Map([
    [5, () => { ada.session.announce(); bob.session.announce(); }],
    [125, () => ada.session.sendText('hello bob')],
    [225, () => bob.session.sendText('hi ada, segmented')],
  ]);
  for (let k = 1; k < SECONDS * 10; k++) {
    ctx.suspend(k / 10).then(() => {
      script.get(k)?.();
      setTimeout(() => ctx.resume(), 0);
    });
  }

  await ctx.startRendering();
  await new Promise((r) => setTimeout(r, 300));

  let ok = true;
  ok = check(ada.ready && bob.ready, 'both nodes started on the audio thread') && ok;
  ok = check(ada.peers.includes('bob') && bob.peers.includes('ada'), 'each node heard the other announce') && ok;
  ok = check(bob.heard.includes('hello bob'), 'a two-frame message crossed one way') && ok;
  ok = check(ada.heard.includes('hi ada, segmented'), 'a three-frame message crossed the other way') && ok;
  ok = check(errors.length === 0, errors.length ? `error frames: ${errors.join(', ')}` : 'no error frames') && ok;
  return ok;
}

$('#run').addEventListener('click', async () => {
  $('#run').disabled = true;
  results.checks = [];
  checks.clear();
  log.clear();
  setVerdict('running…', 'live');
  try {
    const ok = await run();
    setVerdict(ok ? 'pass' : 'fail', ok ? 'ok' : 'bad');
  } catch (err) {
    check(false, `the test itself failed: ${err.message || err}`);
    setVerdict('fail', 'bad');
  } finally {
    $('#run').disabled = false;
  }
});

/* ---------------------------------------------------------------- */
/* microphone check                                                  */
/* ---------------------------------------------------------------- */

const PROBE_URL = new URL('./probe-worklet.js', import.meta.url);
const LISTEN_SECONDS = 15;
let ownResult = null;
let peerResult = null;
const verdicts = new LogView($('#verdicts'), { limit: 100 });

function setMicState(text, kind = '') {
  $('#micstate').textContent = text;
  $('#micstate').className = `pill ${kind}`;
}

/**
 * Play `signal` (or nothing) and record the microphone for `seconds`, through
 * the same capture constraints and kind of AudioContext the Console uses.
 */
async function capture(signal, seconds) {
  const deviceId = $('#mic').value;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: deviceId ? { ...CAPTURE_CONSTRAINTS, deviceId: { exact: deviceId } } : CAPTURE_CONSTRAINTS,
  });
  fillMicrophones($('#mic'), $('#micadvice'));     // named now that access is granted
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  try {
    const track = stream.getAudioTracks()[0];
    const settings = track?.getSettings?.() || {};
    results.input = { label: track?.label || '', settings };
    const ignored = ['echoCancellation', 'noiseSuppression', 'autoGainControl'].filter((k) => settings[k] === true);
    $('#micwarnings').replaceChildren(...ignored.map((k) => el('p', { class: 'note warn' },
      `${k} is still on: this browser ignored the request to turn it off, so these figures `
      + 'describe the processed signal, and so will the Console\'s.')));

    if (ctx.state === 'suspended') await ctx.resume();
    if (ctx.state !== 'running') throw new Error(`the audio context is ${ctx.state}, not running`);
    await ctx.audioWorklet.addModule(PROBE_URL);
    const fs = ctx.sampleRate;
    const probe = new AudioWorkletNode(ctx, 'tincan-probe', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { signal: signal ? signal(fs) : new Float32Array(0), recordSamples: Math.round(seconds * fs) },
    });
    const recording = new Promise((resolve) => { probe.port.onmessage = (e) => resolve(e.data.recording); });
    ctx.createMediaStreamSource(stream).connect(probe);
    probe.connect(ctx.destination);
    return { recording: await recording, fs, reported: (ctx.outputLatency || ctx.baseLatency || 0) + (settings.latency || 0) };
  } finally {
    for (const t of stream.getTracks()) t.stop();
    ctx.close();
  }
}

const mark = (ok) => (ok === true ? '✓' : ok === false ? '✗' : '–');

function render() {
  verdicts.clear();
  if (!ownResult) return;
  const a = assess(ownResult, peerResult, { microphone: results.input?.label || '' });
  for (const c of a.general) {
    verdicts.add(`${mark(c.ok)} <b>${escapeHtml(c.name)}</b> — ${escapeHtml(c.detail)}`, c.ok === false ? 'err' : '');
  }
  if (a.rt60 !== null) verdicts.add(`– <b>room</b> — reverberation time about ${a.rt60.toFixed(2)} s at ${TONE_HZ} Hz`);
  // A failure above applies to every profile.
  const generalBad = a.general.filter((c) => c.ok === false).length;
  for (const p of a.profiles) {
    const bad = p.checks.filter((c) => c.ok === false).length + generalBad;
    const unknown = p.checks.filter((c) => c.ok === null).length;
    verdicts.add(`<b>${p.profile}</b> — ${bad ? `${bad} problem${bad > 1 ? 's' : ''}` : unknown ? 'no problems yet' : 'should work'}`,
      bad ? 'err' : '');
    for (const c of p.checks) {
      verdicts.add(`&nbsp;&nbsp;${mark(c.ok)} ${escapeHtml(c.name)} — ${escapeHtml(c.detail)}`, c.ok === false ? 'err' : '');
    }
  }
}

$('#measure').addEventListener('click', async () => {
  $('#measure').disabled = true;
  $('#listen').disabled = true;
  setMicState('playing…', 'live');
  try {
    const { recording, fs, reported } = await capture(buildProbeSignal, RECORD_SECONDS);
    ownResult = analyseSelf(recording, fs);
    results.self = ownResult;
    results.fs = fs;
    results.reportedLatency = reported;
    setMicState(ownResult.heard ? 'measured' : 'heard nothing', ownResult.heard ? 'ok' : 'bad');
    $('#micsummary').textContent = ownResult.heard
      ? `Speaker-to-microphone latency ${(ownResult.latency * 1000).toFixed(1)} ms`
        + (reported > 0 ? ` (the browser reports ${(reported * 1000).toFixed(1)} ms)` : '')
        + ` at ${fs} Hz, from ${results.input?.label || 'the default microphone'}.`
      : 'This device did not hear its own test signal.';
    render();
  } catch (err) {
    setMicState('failed', 'bad');
    $('#micsummary').textContent = `Could not run the check: ${err.message || err}`;
  } finally {
    $('#measure').disabled = false;
    $('#listen').disabled = !ownResult || !ownResult.heard;
  }
});

$('#listen').addEventListener('click', async () => {
  $('#measure').disabled = true;
  $('#listen').disabled = true;
  setMicState(`listening for ${LISTEN_SECONDS} s…`, 'live');
  try {
    const { recording, fs } = await capture(null, LISTEN_SECONDS);
    const peer = analysePeer(recording, fs);
    if (peer.heard) {
      peerResult = peer;
      results.peer = peer;
      setMicState('compared', 'ok');
    } else {
      setMicState('heard no other device', 'warn');
    }
    render();
  } catch (err) {
    setMicState('failed', 'bad');
    $('#micsummary').textContent = `Could not listen: ${err.message || err}`;
  } finally {
    $('#measure').disabled = false;
    $('#listen').disabled = false;
  }
});

fillMicrophones($('#mic'), $('#micadvice'));

$('#report').addEventListener('click', () => {
  const report = {
    ...reportHeader(),
    secureContext: window.isSecureContext,
    audioWorklet: typeof AudioWorkletNode !== 'undefined',
    selfTest: results.checks,
    microphone: results.input,
    sampleRate: results.fs,
    reportedLatency: results.reportedLatency ?? null,
    self: results.self,
    peer: results.peer,
    assessment: ownResult ? assess(ownResult, peerResult, { microphone: results.input?.label || '' }) : null,
  };
  download(reportName('selftest', 'json'),
    JSON.stringify(report, null, 1), 'application/json');
});
