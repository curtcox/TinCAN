/**
 * TinCAN Console — a full node you can drive by hand.
 */

import { Modem, checkSupport } from '../../src/tincan/modem.js';
import { BANDS, PROFILES, timing, maxRange } from '../../src/tincan/params.js';
import { buildTransmission, formatFrame } from '../../src/tincan/frame.js';
import {
  Session, baseId, describeId, PRIO, TOPIC, segment,
} from '../../src/tincan/transport.js';
import {
  $, el, hex, hexBytes, parseHexBytes, parseId,
  LogView, topbar, escapeHtml,
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
profSel.value = 'T25';

$('#callsign').value = ['ada', 'bob', 'cyd', 'dee', 'eli', 'fay'][Math.floor(Math.random() * 6)];
$('#address').value = String(1 + Math.floor(Math.random() * 30));

function describePhy() {
  const t = timing(profSel.value);
  const b = BANDS[bandSel.value];
  $('#phynote').innerHTML =
    `${b.fR} Hz recessive, ${b.fD} Hz dominant. `
    + `${Math.round(t.bitRate)} bit/s — an 8-octet frame takes about `
    + `${(123 / t.bitRate).toFixed(1)} s of bus time. Arbitration good to about `
    + `${maxRange(profSel.value).toFixed(1)} m.`
    + (bandSel.value === 'A' ? ' <b>This band is audible.</b>' : '');
  updateHints();
}
bandSel.addEventListener('change', describePhy);
profSel.addEventListener('change', describePhy);
describePhy();

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

const log = new LogView($('#log'), { limit: 500 });
const chat = new LogView($('#chat'), { limit: 200 });

const txButtons = ['#sendtext', '#sendraw', '#burst', '#clearq', '#announce', '#mute'];
function setLive(live) {
  for (const s of txButtons) $(s).disabled = !live;
  $('#start').disabled = live;
  $('#stop').disabled = !live;
  for (const s of ['#band', '#profile', '#address', '#callsign']) $(s).disabled = live;
}

/* ---------------------------------------------------------------- */
/* join / leave                                                      */
/* ---------------------------------------------------------------- */

$('#start').addEventListener('click', async () => {
  $('#start').disabled = true;
  try {
    modem = new Modem({
      band: bandSel.value,
      profile: profSel.value,
      mode: 'node',
      amplitude: Number($('#amp').value) / 100,
      name: $('#callsign').value || 'node',
    });
    wire(modem);
    await modem.start();

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
  if (modem) await modem.stop();
  modem = null; session = null;
  setLive(false);
  setState('offline');
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

function wire(m) {
  m.on('warning', (e) => {
    for (const w of e.detail.warnings) $('#warnings').append(el('p', { class: 'note warn' }, w));
  });
  m.on('ready', (e) => log.add(
    `<span class="muted">audio at ${e.detail.sampleRate} Hz, ${e.detail.bitRate.toFixed(1)} bit/s</span>`));

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
    log.add(`← ${escapeHtml(formatFrame(f))} `
      + `<span class="muted">${escapeHtml(describeId(f).text)}</span>`);
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
}

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
          + (p.segmented ? ' seg' : '') + (p.text ? ' text' : '')))));
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
