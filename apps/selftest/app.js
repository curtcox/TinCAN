/**
 * TinCAN Self-test — two real nodes in one browser, through a simulated room.
 *
 * The same harness as test/worklet.test.mjs, but on the browser's own
 * AudioWorklet, MessagePort and module loader, which no Node test can reach.
 * It renders offline, so it is silent and faster than real time.
 */

import { Modem } from '../../src/tincan/modem.js';
import { Session } from '../../src/tincan/transport.js';
import { formatFrame } from '../../src/tincan/frame.js';
import { $, el, LogView, topbar, escapeHtml } from '../ui.js';

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

function check(ok, text) {
  checks.add(`${ok ? '✓' : '✗'} ${escapeHtml(text)}`, ok ? '' : 'err');
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
