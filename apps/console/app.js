/**
 * TinCAN Console — a full node you can drive by hand.
 */

import { Modem, checkSupport } from '../../src/tincan/modem.js';
import {
  BANDS, PROFILES, DETECTOR_DEFAULTS, timing, maxRange, fastestProfileFor, longestRangeProfile, bandsCompatible,
} from '../../src/tincan/params.js';
import { buildTransmission, formatFrame } from '../../src/tincan/frame.js';
import {
  Session, baseId, describeId, describeControl, parseBaseId, PRIO, TOPIC, segment, BROADCAST_BASE,
  assessProposal, linkTimeout, DECLINE, DECLINE_TEXT, CLOSE, CLOSE_TEXT,
} from '../../src/tincan/transport.js';
import {
  $, el, hex, hexBytes, parseHexBytes, parseId, db, download, reportHeader, reportName,
  LogView, topbar, escapeHtml, drawBits, drawMeter, fillMicrophones, micName, measuredLatency,
} from '../ui.js';

$('#chrome').replaceWith(topbar('Console'));

/* ---------------------------------------------------------------- */
/* config UI                                                         */
/* ---------------------------------------------------------------- */

const bandSel = $('#band');
for (const [key, b] of Object.entries(BANDS)) {
  bandSel.append(el('option', { value: key }, `${b.name} — ${b.fR}/${b.fD} Hz`));
}
bandSel.value = 'A';

const profSel = $('#profile');
for (const [key, p] of Object.entries(PROFILES)) {
  profSel.append(el('option', { value: key },
    `${key} — ${Math.round(timing(p).bitRate)} bit/s, ~${maxRange(key).toFixed(1)} m`));
}
// Slow, but it works between the most devices at the greatest distance; the
// note below says when this device could use a faster one.
profSel.value = longestRangeProfile();

$('#callsign').value = ['ada', 'bob', 'cyd', 'dee', 'eli', 'fay'][Math.floor(Math.random() * 6)];
$('#address').value = String(1 + Math.floor(Math.random() * 30));

/**
 * t_slop for `profile` from the self-test's measurement through microphone
 * `name` (spec §5.6), or null when that microphone has not been measured.
 */
function measuredSlop(name, profile) {
  const m = measuredLatency(name);
  return m ? { ...m, slopMs: m.ms + timing(profile).tq * 250 } : null;
}

function describePhy() {
  const t = timing(profSel.value);
  const b = BANDS[bandSel.value];
  const name = micName($('#mic').selectedOptions[0]?.textContent);
  const m = name && measuredSlop(name, profSel.value);
  let range;
  if (!m) {
    range = `Arbitration good to about ${maxRange(profSel.value).toFixed(1)} m, if this device's own audio path is `
      + 'fast; <a href="../selftest/">measure it</a> in the Self-test to know.';
  } else if (maxRange(profSel.value, m.slopMs) > 0) {
    const best = fastestProfileFor(m.slopMs);
    const faster = timing(best).bitRate / t.bitRate;
    range = `Through ${escapeHtml(name)} this device hears itself ${m.ms.toFixed(1)} ms late (measured `
      + `${m.at.slice(0, 10)}), so arbitration is good to about ${maxRange(profSel.value, m.slopMs).toFixed(1)} m.`
      + (faster > 1 ? ` ${best} would be ${faster.toFixed(faster < 10 ? 1 : 0)}× faster, good to `
        + `${maxRange(best, measuredSlop(name, best).slopMs).toFixed(1)} m, if every node on the bus can use it too.` : '');
  } else {
    const best = fastestProfileFor(m.slopMs);
    range = `<b>Through ${escapeHtml(name)} this device hears itself ${m.ms.toFixed(1)} ms late (measured `
      + `${m.at.slice(0, 10)}), more than ${profSel.value}'s ${PROFILES[profSel.value].prop * PROFILES[profSel.value].tqMs} ms `
      + `PROP_SEG allows: it will misread its own bits.</b> `
      + (best ? `Choose ${best}, and have every node on the bus do the same.` : 'No profile allows that much.');
  }
  $('#phynote').innerHTML =
    `${b.fR} Hz recessive, ${b.fD} Hz dominant. `
    + `${Math.round(t.bitRate)} bit/s — an 8-octet frame takes about `
    + `${(123 / t.bitRate).toFixed(1)} s of bus time. ${range}`
    + (bandSel.value === 'A' ? ' <b>This band is audible.</b>' : '');
  updateHints();
}
bandSel.addEventListener('change', describePhy);
profSel.addEventListener('change', describePhy);
$('#mic').addEventListener('change', describePhy);
describePhy();

// Runs after this module has finished loading, so the side-link note, which
// needs the whole page, can be refreshed with the microphone's measurement.
fillMicrophones($('#mic'), $('#micadvice')).then(() => { describePhy(); describeLink(); });

$('#amp').addEventListener('input', (e) => {
  const v = Number(e.target.value) / 100;
  $('#ampval').textContent = `${e.target.value}%`;
  if (modem) modem.setAmplitude(v);
});

const support = checkSupport();
if (!support.ok) {
  $('#support').append(el('div', { class: 'panel' },
    el('p', { class: 'note bad' },
      'This browser cannot run a node: ' + support.problems.join('; ') + '.')));
  $('#start').disabled = true;
}

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

let modem = null;
let session = null;
const peers = new Map();

// Diagnostics: recent bits and events, for the Signal panel and the report.
const bitHistory = [];
const BIT_HISTORY = 900;
const events = [];
const EVENT_HISTORY = 1000;
const diag = { stalls: 0, overloads: 0, carrierRun: 0, deafBits: 0, warned: new Set() };
let lastStatus = null;

/* Detector thresholds (spec §4.4.2), adjustable for diagnosis. */
const thetaIn = $('#theta');
const kappaIn = $('#kappa');
const thresholds = () => ({ thetaD: Number(thetaIn.value) / 100, kappa: Number(kappaIn.value) });
function showThresholds() {
  const { thetaD, kappa } = thresholds();
  $('#thetaval').textContent = `${thetaD.toFixed(2)}${thetaD === DETECTOR_DEFAULTS.thetaD ? ' (default)' : ''}`;
  $('#kappaval').textContent = `${kappa} (${(10 * Math.log10(kappa)).toFixed(1)} dB)`
    + `${kappa === DETECTOR_DEFAULTS.kappa ? ' (default)' : ''}`;
  if (modem) modem.setThresholds({ thetaD, kappa });
}
function resetThresholds() {
  thetaIn.value = String(Math.round(DETECTOR_DEFAULTS.thetaD * 100));
  kappaIn.value = String(DETECTOR_DEFAULTS.kappa);
  showThresholds();
}
thetaIn.addEventListener('input', showThresholds);
kappaIn.addEventListener('input', showThresholds);
$('#detreset').addEventListener('click', resetThresholds);
resetThresholds();

const log = new LogView($('#log'), { limit: 500 });
const chat = new LogView($('#chat'), { limit: 200 });

const txButtons = ['#sendtext', '#sendraw', '#burst', '#clearq', '#announce', '#mute'];
function setLive(live) {
  for (const s of txButtons) $(s).disabled = !live;
  $('#start').disabled = live;
  $('#stop').disabled = !live;
  for (const s of ['#band', '#profile', '#address', '#callsign', '#mic']) $(s).disabled = live;
  $('#mic').micAdvice?.();
  setLinkControls();
  if (live) fillLinkChoices();
}

/* ---------------------------------------------------------------- */
/* join / leave                                                      */
/* ---------------------------------------------------------------- */

$('#start').addEventListener('click', async () => {
  $('#start').disabled = true;
  // Warnings describe the last session; this one earns its own.
  $('#warnings').replaceChildren();
  diag.warned.clear();
  try {
    modem = new Modem({
      band: bandSel.value,
      profile: profSel.value,
      mode: 'node',
      amplitude: Number($('#amp').value) / 100,
      name: $('#callsign').value || 'node',
      deviceId: $('#mic').value || undefined,
      ...thresholds(),
    });
    wire(modem);
    await modem.start();
    fillMicrophones($('#mic'), $('#micadvice')).then(describePhy);     // now the browser will name them
    useMeasuredLatency();
    showAudio();

    // The Session helper is written against the pure Protocol interface, so
    // give it the two methods it actually uses.
    session = new Session({
      on: (ev, fn) => modem.on(ev, (e) => fn(e.detail)),
      send: (frame) => modem.send(frame),
    }, {
      address: Number($('#address').value) || 7,
      callsign: $('#callsign').value,
    });
    session.on('message', onMessage);
    session.on('presence', onPresence);
    session.on('progress', ({ source, progress }) => {
      log.add(`<span class="muted">receiving from ${source}: ${Math.round(progress * 100)}%</span>`);
    });
    session.on('transport-error', ({ source, error }) =>
      log.add(`transport error from ${source}: ${escapeHtml(error)}`, 'err'));
    wireLinks(session);

    setLive(true);
    setState('on the bus', 'live');
    log.add(`joined as <b>${escapeHtml(session.callsign || '(no callsign)')}</b> at address ${session.address}`);
    session.announce();
  } catch (err) {
    $('#start').disabled = false;
    log.add(`could not join: ${escapeHtml(err.message || err)}`, 'err');
    setState('failed', 'bad');
  }
});

$('#stop').addEventListener('click', async () => {
  // Part 2 §8.3: close side links on the main bus before leaving it.
  if (link && link.rec.state !== 'closed') {
    setState('closing side link…', 'live');
    session.closeLink(link.rec, CLOSE.FINISHED);
    await stopLink();
    await waitForQueue(modem, 3 * 123 * timing(profSel.value).bitTime * 1000);
  }
  if (modem) await modem.stop();
  modem = null; session = null;
  setLive(false);
  setState('offline');
  setAudioState('no audio');
});

$('#mute').addEventListener('click', () => {
  if (!modem) return;
  const next = !modem.muted;
  modem.setMuted(next);
  $('#mute').textContent = next ? 'Unmute transmit' : 'Mute transmit';
  log.add(next
    ? 'transmit muted — this node is now a listener and will not acknowledge'
    : 'transmit unmuted');
});

function setState(text, kind = '') {
  $('#state').textContent = text;
  $('#state').className = `pill ${kind}`;
}

/* ---------------------------------------------------------------- */
/* modem events                                                      */
/* ---------------------------------------------------------------- */

function setAudioState(text, kind = '') {
  $('#audiostate').textContent = text;
  $('#audiostate').className = `pill ${kind}`;
}

function warnOnce(key, text) {
  if (diag.warned.has(key)) return;
  diag.warned.add(key);
  $('#warnings').append(el('p', { class: 'note warn' }, text));
  log.add(escapeHtml(text), 'warnrow');
}

/**
 * Give the node the latency the self-test measured through the microphone it
 * actually got, and say so if the profile cannot absorb it.
 */
function useMeasuredLatency() {
  const label = modem.diagnostics().input?.label;
  const m = label && measuredLatency(label);
  if (!m) return;
  modem.measuredLatencyMs = m.ms;
  if (maxRange(profSel.value, modem.measuredSlopMs) > 0) return;
  const best = fastestProfileFor(modem.measuredSlopMs);
  warnOnce('latency', `This device hears itself ${m.ms.toFixed(1)} ms late through ${micName(label)}, as the `
    + `self-test measured on ${m.at.slice(0, 10)}: more than ${profSel.value} allows, so it will misread its own `
    + `bits and every frame it sends will fail. `
    + (best ? `Leave, choose ${best}, and join again; every node on the bus must use the same profile.` : ''));
}

/** What the browser gave this node: shown in Diagnostics, and in the report. */
function showAudio() {
  if (!modem) return;
  const d = modem.diagnostics();
  $('#dfs').textContent = d.sampleRate ? `${d.sampleRate} Hz` : '—';
  $('#dlat').textContent = d.measuredSlopMs
    ? `${d.measuredSlopMs.toFixed(1)} ms ${d.latencySource === 'measured' ? 'measured' : 'reported'}` : '—';
  $('#drange').textContent = d.maxRange !== null ? `${d.maxRange.toFixed(1)} m` : '—';
  setAudioState(d.stalled ? 'audio stalled' : `audio ${d.audioState}`,
    d.stalled || d.audioState !== 'running' ? 'bad' : 'ok');
  if (d.input) {
    const st = d.input.settings || {};
    const flags = ['echoCancellation', 'noiseSuppression', 'autoGainControl']
      .map((k) => `${k} ${st[k] === undefined ? 'not reported' : st[k] ? '<b>on</b>' : 'off'}`).join(', ');
    $('#dinput').innerHTML = `Microphone: <b>${escapeHtml(d.input.label || 'unnamed')}</b>`
      + (st.sampleRate ? `, ${st.sampleRate} Hz` : '') + (st.channelCount ? `, ${st.channelCount} channel` : '')
      + `. ${flags}.`;
  }
}

function wire(m) {
  m.on('*', (e) => {
    const d = e.detail;
    events.push({
      t: +(performance.now() / 1000).toFixed(3), event: d.event,
      kind: d.kind, reason: d.reason, detail: d.detail, from: d.from, to: d.to, bit: d.bit,
      id: d.frame ? d.frame.id : undefined,
    });
    if (events.length > EVENT_HISTORY) events.shift();
  });
  m.on('warning', (e) => {
    for (const w of e.detail.warnings) $('#warnings').append(el('p', { class: 'note warn' }, w));
  });
  m.on('audio-state', (e) => {
    log.add(`audio context is now <b>${escapeHtml(e.detail.state)}</b>`, e.detail.state === 'running' ? '' : 'warnrow');
    showAudio();
  });
  m.on('stalled', () => {
    diag.stalls++;
    $('#dstall').textContent = diag.stalls;
    log.add('the audio thread has stopped reporting — this node can neither hear nor send. '
      + 'Click the page; if that does not help, leave and join again.', 'err');
    showAudio();
  });
  m.on('resumed', () => { log.add('the audio thread is running again'); showAudio(); });
  m.on('abandoned', (e) => {
    if ($('#shownoise').checked) {
      log.add(`<span class="muted">noise: ${escapeHtml(e.detail.reason || 'abandoned')}</span>`);
    }
  });
  m.on('overload', () => {
    diag.overloads++;
    $('#dover').textContent = diag.overloads;
    log.add('overload frame', 'warnrow');
  });
  m.on('bus-off-recovered', () => log.add('recovered from bus-off', 'warnrow'));
  m.on('ready', (e) => {
    log.add(`<span class="muted">audio at ${e.detail.sampleRate} Hz, ${e.detail.bitRate.toFixed(1)} bit/s, `
      + `${e.detail.bitSamples} samples per bit</span>`);
    showAudio();
  });

  m.on('tx-start', (e) => log.add(
    `→ transmitting ${escapeHtml(formatFrame(e.detail.frame))}`
    + (e.detail.attempt > 1 ? ` <span class="muted">(attempt ${e.detail.attempt})</span>` : ''), 'tx'));

  m.on('tx-complete', (e) => log.add(
    `✓ delivered ${escapeHtml(formatFrame(e.detail.frame))}`, 'tx'));

  m.on('tx-failed', (e) => log.add(
    `✗ gave up on ${escapeHtml(formatFrame(e.detail.item.frame))}: ${escapeHtml(e.detail.detail || '')}`, 'err'));

  m.on('arbitration-lost', (e) => log.add(
    `⊘ lost arbitration at bit ${e.detail.bit} — deferring `
    + `${escapeHtml(formatFrame(e.detail.frame))}`, 'warnrow'));

  m.on('frame', (e) => {
    const f = e.detail.frame;
    const control = !f.extended && parseBaseId(f.id).topic === TOPIC.CONTROL ? describeControl(f.data) : null;
    log.add(`← ${escapeHtml(formatFrame(f))} `
      + `<span class="muted">${escapeHtml(describeId(f).text)}${control ? ` — ${escapeHtml(control)}` : ''}</span>`);
  });

  m.on('error-frame', (e) => {
    const d = e.detail;
    const msg = d.kind === 'ack'
      ? 'no node acknowledged — is anything else listening?'
      : `${d.kind} error: ${d.detail || ''}`;
    log.add(escapeHtml(msg), 'err');
  });

  m.on('error-state', (e) => {
    log.add(`error state ${e.detail.from} → <b>${e.detail.to}</b>`, 'warnrow');
    if (e.detail.to === 'error-passive') {
      log.add('<span class="muted">error-passive means this node is transmitting but nobody is '
        + 'confirming receipt. It will keep trying and will not bus itself off (§8.3).</span>');
    }
  });

  m.on('rejected', (e) => log.add(`frame rejected: ${escapeHtml(e.detail.error)}`, 'err'));

  m.on('status', (e) => onStatus(e.detail));
}

function onStatus(s) {
  $('#errstate').textContent = s.errorState;
  $('#errstate').className = `pill ${s.errorState === 'error-active' ? 'ok'
    : s.errorState === 'bus-off' ? 'bad' : 'warn'}`;
  $('#queue').textContent = `queue ${s.queue}`;
  $('#queue').className = `pill ${s.queue ? 'live' : ''}`;
  setState(s.transmitting ? 'transmitting' : (s.state === 'bus-idle' ? 'idle' : s.state),
    s.transmitting ? 'live' : '');

  const st = s.stats || {};
  $('#csent').textContent = st.framesSent ?? 0;
  $('#crecv').textContent = st.framesReceived ?? 0;
  $('#clost').textContent = st.arbitrationsLost ?? 0;
  $('#ctec').textContent = s.tec;
  $('#crec').textContent = s.rec;
  $('#cerr').textContent =
    (st.bitErrors || 0) + (st.crcErrors || 0) + (st.stuffErrors || 0)
    + (st.formErrors || 0) + (st.ackErrors || 0);
  $('#cbit').textContent = st.bitErrors || 0;
  $('#cstuff').textContent = st.stuffErrors || 0;
  $('#ccrc').textContent = st.crcErrors || 0;
  $('#cform').textContent = st.formErrors || 0;
  $('#cack').textContent = st.ackErrors || 0;
  $('#caband').textContent = st.framesAbandoned || 0;
  $('#dbits').textContent = st.bitsObserved || 0;

  lastStatus = s;
  const sig = s.signal || {};
  $('#sratio').textContent = sig.ratio !== undefined ? sig.ratio.toFixed(3) : '—';
  $('#ser').textContent = `${db(sig.eR)} dB`;
  $('#sed').textContent = `${db(sig.eD)} dB`;
  $('#snf').textContent = `${db(sig.noise)} dB`;
  $('#carrier').textContent = sig.carrier ? 'carrier' : 'no carrier';
  $('#carrier').className = `pill ${sig.carrier ? 'live' : ''}`;
  if (modem && $('#audiostate').textContent !== 'audio running' && !modem.stalled) showAudio();

  for (const b of s.bits || []) {
    bitHistory.push(b);
    watchBit(b);
  }
  while (bitHistory.length > BIT_HISTORY) bitHistory.shift();
  const th = thresholds();
  drawBits($('#bits'), bitHistory, { thetaD: th.thetaD, markTx: true });
  drawMeter($('#meter'), sig, { thetaD: th.thetaD });
}

/**
 * Symptoms that the counters alone do not make obvious, each named once.
 */
function watchBit(b) {
  // A legitimate frame is never more than about 700 bits of unbroken carrier.
  diag.carrierRun = b.carrier ? diag.carrierRun + 1 : 0;
  if (diag.carrierRun === 700) {
    warnOnce('carrier', 'There has been carrier for 700 bit times without a break, longer than any frame. '
      + 'The room is too loud in the TinCAN band, or something else is sounding on it, so this node never sees '
      + 'the bus idle and cannot send.');
  }
  // While sending, a node must hear itself: no carrier on its own bits means it cannot.
  if (b.tx !== null && b.tx !== undefined) {
    diag.deafBits = b.carrier ? 0 : diag.deafBits + 1;
    if (diag.deafBits === 16) {
      warnOnce('deaf', 'This node is transmitting but hearing no carrier on its own bits. Its speaker may be '
        + 'muted or too quiet, or echo cancellation is removing its own signal. Run the microphone check on the self-test page.');
    }
  }
}

window.addEventListener('resize', () => {
  const th = thresholds();
  drawBits($('#bits'), bitHistory, { thetaD: th.thetaD, markTx: true });
  drawMeter($('#meter'), lastStatus?.signal || {}, { thetaD: th.thetaD });
});
drawBits($('#bits'), []);
drawMeter($('#meter'), {});

$('#report').addEventListener('click', () => {
  const report = {
    ...reportHeader(),
    secureContext: window.isSecureContext,
    config: {
      callsign: $('#callsign').value,
      address: Number($('#address').value),
      band: bandSel.value,
      profile: profSel.value,
      amplitude: Number($('#amp').value) / 100,
      microphone: $('#mic').selectedOptions[0]?.textContent || '',
      ...thresholds(),
    },
    audio: modem ? modem.diagnostics() : null,
    status: lastStatus && { ...lastStatus, bits: undefined },
    diagnostics: { stalls: diag.stalls, overloads: diag.overloads, warned: [...diag.warned] },
    peers: [...peers].map(([address, a]) => ({ address, callsign: a.callsign, version: a.version })),
    events,
    bits: bitHistory,
  };
  download(reportName('console', 'json'),
    JSON.stringify(report, null, 1), 'application/json');
});

/* ---------------------------------------------------------------- */
/* text                                                              */
/* ---------------------------------------------------------------- */

function onMessage({ source, text, data }) {
  const who = peers.get(source)?.callsign || `node ${source}`;
  chat.add(text !== null
    ? `<b>${escapeHtml(who)}</b> ${escapeHtml(text)}`
    : `<b>${escapeHtml(who)}</b> <span class="muted">${hexBytes(data)}</span>`);
}

function onPresence({ address, announce }) {
  if (announce.leaving) { peers.delete(address); }
  else peers.set(address, announce);
  renderPeers();
  log.add(announce.leaving
    ? `<span class="muted">node ${address} left</span>`
    : `<span class="muted">node ${address} is here: "${escapeHtml(announce.callsign)}"</span>`);
}

function renderPeers() {
  const node = $('#peers');
  node.replaceChildren();
  if (!peers.size) {
    node.append(el('div', { class: 'empty' }, 'nobody has announced yet'));
    return;
  }
  for (const [addr, p] of [...peers].sort((a, b) => a[0] - b[0])) {
    node.append(el('div', { class: 'entry' },
      el('span', { class: 't' }, String(addr)),
      el('span', { class: 'body' },
        p.callsign || '(no callsign)',
        el('span', { class: 'muted' }, ` v${p.version.toString(16)}`
          + (p.segmented ? ' seg' : '') + (p.text ? ' text' : '') + (p.sideLinks ? ' links' : '')))));
  }
}
renderPeers();

$('#sendtext').addEventListener('click', sendText);
$('#text').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendText(); });
$('#text').addEventListener('input', updateHints);

function sendText() {
  if (!session) return;
  const text = $('#text').value;
  if (!text) return;
  session.sendText(text);
  chat.add(`<b>${escapeHtml(session.callsign || 'me')}</b> ${escapeHtml(text)}`, 'tx');
  $('#text').value = '';
  updateHints();
}

$('#announce').addEventListener('click', () => session && session.announce());

/* ---------------------------------------------------------------- */
/* raw frames                                                        */
/* ---------------------------------------------------------------- */

function readRawFrame() {
  return {
    id: parseId($('#rid').value),
    extended: $('#rext').checked,
    rtr: $('#rrtr').checked,
    fdf: $('#rfdf').checked,
    data: $('#rrtr').checked ? new Uint8Array(0) : parseHexBytes($('#rdata').value),
    dlc: $('#rrtr').checked ? 0 : undefined,
  };
}

$('#sendraw').addEventListener('click', () => {
  try {
    const f = readRawFrame();
    modem.send(f);
    log.add(`queued ${escapeHtml(formatFrame(buildTransmission(f).frame))}`, 'tx');
  } catch (err) {
    log.add(`bad frame: ${escapeHtml(err.message || err)}`, 'err');
  }
});

$('#burst').addEventListener('click', () => {
  // Queue four frames of different priority at once. On a bus with another
  // node doing the same, this is the arbitration cascade of §7.2 in miniature.
  const addr = session ? session.address : 1;
  const order = [PRIO.EMERGENCY, PRIO.CONTROL, PRIO.NORMAL, PRIO.BULK];
  // Deliberately queue them backwards, to show the queue reorders them.
  for (let i = order.length - 1; i >= 0; i--) {
    modem.send({
      id: baseId({ prio: order[i], topic: TOPIC.EVENT, source: addr }),
      data: Uint8Array.from([order[i], i]),
    });
  }
  log.add('queued four frames, lowest priority first — watch them leave in priority order', 'tx');
});

$('#clearq').addEventListener('click', () => {
  modem.clearQueue();
  log.add('transmit queue cleared');
});

$('#clearlog').addEventListener('click', () => { log.clear(); chat.clear(); });

for (const s of ['#rid', '#rdata', '#rext', '#rrtr', '#rfdf']) {
  $(s).addEventListener('input', updateHints);
}

function updateHints() {
  const rate = timing(profSel.value).bitRate;

  // raw frame
  try {
    const tx = buildTransmission(readRawFrame());
    const secs = tx.bits.length / rate;
    $('#rawhint').innerHTML =
      `${tx.bits.length} bits on the wire (${tx.stuffCount} of them stuff bits) — `
      + `<b>${secs.toFixed(1)} s</b> of bus time. CRC 0x${hex(tx.crc, 5)}. `
      + `Arbitration field ends at bit ${tx.arbitrationEnd}.`;
    $('#rawhint').className = 'note';
  } catch (err) {
    $('#rawhint').textContent = err.message || String(err);
    $('#rawhint').className = 'note bad';
  }

  // text
  const text = $('#text').value;
  if (!text) { $('#texthint').textContent = '—'; $('#texthint').className = 'note'; return; }
  const bytes = new TextEncoder().encode(text);
  try {
    const parts = segment(bytes);
    const bits = parts.reduce((n, p) =>
      n + buildTransmission({ id: 0x123, data: p }).bits.length, 0);
    $('#texthint').innerHTML =
      `${bytes.length} octets → ${parts.length} frame${parts.length === 1 ? '' : 's'} `
      + `→ about <b>${(bits / rate).toFixed(1)} s</b> of bus time.`;
    $('#texthint').className = 'note';
  } catch (err) {
    $('#texthint').textContent = err.message || String(err);
    $('#texthint').className = 'note bad';
  }
}
updateHints();

/* ---------------------------------------------------------------- */
/* side links — Part 2 §8                                            */
/* ---------------------------------------------------------------- */

/** The open link: its record, its own modem and session, and whether it is up. */
let link = null;
const linkLog = new LogView($('#linklog'), { limit: 200 });
const offers = new Map();

function setLinkState(text, kind = '') {
  $('#linkstate').textContent = text;
  $('#linkstate').className = `pill ${kind}`;
}

/** This device's measured t_slop for `profile`, in ms, or null. */
function mySlop(profile = profSel.value) {
  const name = micName(modem?.diagnostics().input?.label || $('#mic').selectedOptions[0]?.textContent);
  return measuredSlop(name, profile)?.slopMs ?? null;
}

function fillLinkChoices() {
  const main = bandSel.value;
  const band = $('#linkband');
  const keep = band.value;
  band.replaceChildren(...Object.entries(BANDS).filter(([k]) => k !== main)
    .map(([k, b]) => el('option', { value: k }, `${b.name} — ${b.fR}/${b.fD} Hz`)));
  band.value = BANDS[keep] && keep !== main ? keep : (main === 'C' ? 'B' : 'C');

  const prof = $('#linkprofile');
  const keepP = prof.value;
  prof.replaceChildren(...Object.entries(PROFILES).map(([k, p]) =>
    el('option', { value: k }, `${k} — ${Math.round(timing(p).bitRate)} bit/s`)));
  // The fastest this device's audio path allows, with another as slow.
  const slop = mySlop('T25');
  prof.value = (PROFILES[keepP] && keepP) || (slop !== null ? fastestProfileFor(slop) : null) || 'T5';
  describeLink();
}

function describeLink() {
  const band = $('#linkband').value;
  const profile = $('#linkprofile').value;
  if (!BANDS[band] || !PROFILES[profile]) return;
  const t = timing(profile);
  const main = timing(profSel.value);
  const slop = mySlop(profile);
  const notes = [`${(t.bitRate / main.bitRate).toFixed(t.bitRate >= main.bitRate ? 1 : 2)}× the main bus's speed.`];
  if (slop !== null) notes.push(`Good to about ${maxRange(profile, slop).toFixed(1)} m between two devices as slow as this one.`);
  if (!bandsCompatible(bandSel.value, profSel.value, band, profile)) {
    notes.push(`<b>Bands ${bandSel.value} and ${band} cannot share a device at these profiles</b> (Part 2 §8.2): `
      + 'use T10 or slower on both, or another band.');
  }
  if (slop !== null && maxRange(profile, slop) <= 0) {
    notes.push(`<b>${profile} cannot cover this device's ${slop.toFixed(0)} ms audio path</b>; `
      + `${fastestProfileFor(slop) ?? 'no profile'} is the fastest that can.`);
  } else if (slop === null) {
    notes.push('This device\'s audio path is not measured, so the peer will judge the timing alone.');
  }
  if (band === 'B') notes.push('Band B needs a speaker and microphone that work above 17 kHz, and carries only a few metres.');
  $('#linknote').innerHTML = notes.join(' ');
}

function fillLinkPeers() {
  const sel = $('#linkpeer');
  const keep = sel.value;
  sel.replaceChildren(el('option', { value: String(BROADCAST_BASE) }, 'anyone who wants to'),
    ...[...peers].filter(([, p]) => p.sideLinks)
      .map(([addr, p]) => el('option', { value: String(addr) }, `${p.callsign || 'node'} (${addr})`)));
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

for (const s of ['#linkband', '#linkprofile', '#mic']) $(s).addEventListener('change', describeLink);
bandSel.addEventListener('change', fillLinkChoices);
profSel.addEventListener('change', describeLink);
fillLinkChoices();
fillLinkPeers();

function setLinkControls() {
  const live = !!session;
  const open = !!link;
  $('#linkpropose').disabled = !live || open;
  $('#linkclose').disabled = !open;
  $('#linktext').disabled = !link?.up;
  $('#linksend').disabled = !link?.up;
  for (const s of ['#linkpeer', '#linkband', '#linkprofile']) $(s).disabled = open;
}
setLinkControls();

function wireLinks(s) {
  s.on('presence', fillLinkPeers);
  s.on('link-proposal', ({ link: rec }) => onProposal(rec));
  s.on('link-open', ({ link: rec }) => openLink(rec));
  s.on('link-declined', ({ link: rec, by, reason }) => {
    linkLog.add(`node ${by} declined #${rec.link}: ${escapeHtml(DECLINE_TEXT[reason] ?? String(reason))}`, 'err');
    setLinkState('declined', 'bad');
  });
  s.on('link-closed', ({ link: rec, reason, by }) => {
    if (by !== s.address) linkLog.add(`node ${by} closed #${rec.link}: ${escapeHtml(CLOSE_TEXT[reason] ?? String(reason))}`);
    stopLink();
  });
}

$('#linkpropose').addEventListener('click', () => {
  const to = Number($('#linkpeer').value);
  const band = $('#linkband').value;
  const profile = $('#linkprofile').value;
  const rec = session.proposeLink({ to, band, profile, slopMs: mySlop(profile) });
  linkLog.add(`proposed #${rec.link} to ${to === BROADCAST_BASE ? 'anyone' : `node ${to}`}: band ${band}, ${profile} `
    + '<span class="muted">— the answer comes on the main bus</span>', 'tx');
  setLinkState('proposed', 'live');
});

$('#linkclose').addEventListener('click', () => {
  if (!link) return;
  session.closeLink(link.rec, CLOSE.FINISHED);
  linkLog.add(`closed #${link.rec.link}`, 'tx');
  stopLink();
});

function onProposal(rec) {
  const canUseBand = (b) => b !== 'B' || (modem?.ctx?.sampleRate ?? 48000) >= 44100;
  const reason = link ? DECLINE.BUSY : assessProposal(rec, {
    mainBand: bandSel.value, mainProfile: profSel.value, slopMs: mySlop(rec.profile ?? profSel.value),
    bandsInUse: session.bandsInUse(), canUseBand,
  });
  const who = peers.get(rec.proposer)?.callsign || `node ${rec.proposer}`;
  const what = `band ${rec.band}, ${rec.profile}`;
  if (reason) {
    session.declineLink(rec, reason);
    linkLog.add(`declined ${escapeHtml(who)}'s #${rec.link} (${what}): ${escapeHtml(DECLINE_TEXT[reason])}`, 'warnrow');
    return;
  }
  const key = `${rec.proposer}:${rec.link}`;
  const row = el('p', { class: 'note' },
    `${who} proposes a side link: ${what}, ${(timing(rec.profile).bitRate / timing(profSel.value).bitRate).toFixed(1)}× `
    + 'the main bus. ',
    el('button', { class: 'primary', onclick: () => { offers.delete(key); row.remove(); session.acceptLink(rec, mySlop(rec.profile)); } }, 'Accept'),
    ' ',
    el('button', { onclick: () => { offers.delete(key); row.remove(); session.declineLink(rec, DECLINE.REFUSED); } }, 'Decline'));
  offers.set(key, row);
  $('#linkoffers').append(row);
  linkLog.add(`${escapeHtml(who)} proposes #${rec.link}: ${what}`);
}

/** Part 2 §8.3: start a second node on the link's band, keep the main one. */
async function openLink(rec) {
  if (link) return;
  const peer = rec.proposer === session.address ? rec.peer : rec.proposer;
  link = { rec, peer, up: false, modem: null, session: null, timer: null, sent: 0, recv: 0, errors: 0 };
  setLinkState('opening…', 'live');
  setLinkControls();
  for (const row of offers.values()) row.remove();
  offers.clear();
  linkLog.add(`opening #${rec.link} with node ${peer}: band ${rec.band}, ${rec.profile}`);
  try {
    const m = new Modem({
      band: rec.band, profile: rec.profile, mode: 'node', amplitude: Number($('#amp').value) / 100,
      name: `${session.callsign || 'node'}-link`, deviceId: $('#mic').value || undefined, ...thresholds(),
    });
    link.modem = m;
    await m.start();
    if (modem?.measuredLatencyMs != null) m.measuredLatencyMs = modem.measuredLatencyMs;
    const ls = new Session({ on: (ev, fn) => m.on(ev, (e) => fn(e.detail)), send: (f) => m.send(f) },
      { address: session.address, callsign: session.callsign });
    link.session = ls;
    m.on('delivered', () => { link && link.sent++; showLinkCounters(); });
    m.on('frame', () => { link && link.recv++; showLinkCounters(); });
    m.on('error-frame', (e) => {
      if (!link) return;
      link.errors++;
      showLinkCounters();
      linkLog.add(escapeHtml(e.detail.kind === 'ack' ? 'no acknowledgement on the link' : `${e.detail.kind} error`), 'err');
    });
    ls.on('presence', ({ address }) => {
      if (!link || address !== peer || link.up) return;
      link.up = true;
      clearTimeout(link.timer);
      setLinkState(`up: band ${rec.band}, ${rec.profile}`, 'ok');
      linkLog.add(`#${rec.link} is up: heard node ${peer} on band ${rec.band}`, 'tx');
      if (rec.proposer !== session.address) ls.announce();     // answer the proposer's
      setLinkControls();
    });
    ls.on('message', ({ text, data }) => {
      const who = peers.get(peer)?.callsign || `node ${peer}`;
      chat.add(`<b>${escapeHtml(who)}</b> <span class="muted">(side link)</span> `
        + (text !== null ? escapeHtml(text) : hexBytes(data)));
    });
    if (rec.proposer === session.address) ls.announce();
    const limit = linkTimeout(rec.profile);
    link.timer = setTimeout(() => {
      if (!link || link.up) return;
      linkLog.add(`nothing heard on #${rec.link} in ${limit.toFixed(0)} s: closing`, 'err');
      session.closeLink(rec, CLOSE.NO_CONTACT);
      stopLink();
    }, limit * 1000);
  } catch (err) {
    linkLog.add(`could not start the link: ${escapeHtml(err.message || err)}`, 'err');
    session.closeLink(rec, CLOSE.ERRORS);
    await stopLink();
  }
}

async function stopLink() {
  if (!link) return;
  const l = link;
  link = null;
  clearTimeout(l.timer);
  if (l.modem) await l.modem.stop().catch(() => {});
  setLinkState(`closed #${l.rec.link}`);
  setLinkControls();
}

function showLinkCounters() {
  if (!link) return;
  $('#lsent').textContent = String(link.sent);
  $('#lrecv').textContent = String(link.recv);
  $('#lerr').textContent = String(link.errors);
}

function sendLinkText() {
  const text = $('#linktext').value;
  if (!link?.up || !text) return;
  link.session.sendText(text);
  chat.add(`<b>${escapeHtml(session.callsign || 'me')}</b> <span class="muted">(side link)</span> ${escapeHtml(text)}`, 'tx');
  $('#linktext').value = '';
}
$('#linksend').addEventListener('click', sendLinkText);
$('#linktext').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendLinkText(); });

/** Resolve once `m` has nothing left to send, or after `ms`. */
function waitForQueue(m, ms) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const q = lastStatus?.queue ?? 0;
      if (!m.ready || (q === 0 && !lastStatus?.transmitting) || Date.now() - start > ms) resolve();
      else setTimeout(check, 250);
    };
    setTimeout(check, 500);
  });
}

