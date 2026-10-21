/**
 * TinCAN Snooper — a passive bus analyzer.
 *
 * Conforms to the Listener profile of spec §9.1: it decodes everything and
 * transmits nothing, deliberately, so that watching the bus does not change it.
 */

import { Modem, checkSupport } from '../../src/tincan/modem.js';
import { BANDS, PROFILES, timing, maxRange, longestRangeProfile } from '../../src/tincan/params.js';
import { describeId, describePci, describeControl, TOPIC, parseBaseId } from '../../src/tincan/transport.js';
import {
  $, el, hex, hexBytes, asciiBytes, LogView, topbar, escapeHtml, download, db, reportHeader, reportName,
  drawBits as drawBitStrip, drawMeter as drawLevels, fillMicrophones, fitProfiles,
} from '../ui.js';

$('#chrome').replaceWith(topbar('Snooper'));

/* ---------------------------------------------------------------- */
/* configuration                                                     */
/* ---------------------------------------------------------------- */

const bandSel = $('#band');
for (const [key, b] of Object.entries(BANDS)) {
  bandSel.append(el('option', { value: key }, `${b.name} — ${b.fR}/${b.fD} Hz`));
}
bandSel.value = 'A';

const profSel = $('#profile');
for (const [key, p] of Object.entries(PROFILES)) {
  const t = timing(p);
  profSel.append(el('option', { value: key },
    `${key} — ${Math.round(t.bitRate)} bit/s, ~${maxRange(key).toFixed(1)} m`));
}
profSel.value = longestRangeProfile();       // the Console's default

function describePhy() {
  const t = timing(profSel.value);
  const b = BANDS[bandSel.value];
  $('#phynote').innerHTML =
    `Recessive <b>${b.fR} Hz</b>, dominant <b>${b.fD} Hz</b>, noise reference at `
    + `${b.guardLo} and ${b.guardHi} Hz. Bit time ${(t.bitTime * 1000).toFixed(0)} ms, `
    + `sample point at ${(t.samplePointFraction * 100).toFixed(0)} %, detection window `
    + `${(t.window * 1000).toFixed(0)} ms. Arbitration works out to about `
    + `${maxRange(profSel.value).toFixed(1)} m.`;
}
bandSel.addEventListener('change', () => { fitProfiles(profSel, bandSel.value); describePhy(); });
profSel.addEventListener('change', describePhy);
describePhy();
fillMicrophones($('#mic'), $('#micadvice'));

const support = checkSupport();
if (!support.ok) {
  $('#support').append(el('div', { class: 'panel' },
    el('p', { class: 'note bad' },
      'This browser cannot run the snooper: ' + support.problems.join('; ') + '.')));
  $('#start').disabled = true;
}

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

let modem = null;
const frames = [];
const bitHistory = [];
const BIT_HISTORY = 900;
let startedAt = 0;
let carrierBits = 0;
let totalBits = 0;

const frameLog = new LogView($('#frames'), { limit: 500 });
const errLog = new LogView($('#errlog'), { limit: 200 });

/* ---------------------------------------------------------------- */
/* start / stop                                                      */
/* ---------------------------------------------------------------- */

$('#start').addEventListener('click', async () => {
  $('#start').disabled = true;
  try {
    modem = new Modem({
      band: bandSel.value,
      profile: profSel.value,
      mode: 'listener',
      name: 'snooper',
      deviceId: $('#mic').value || undefined,
    });
    wire(modem);
    await modem.start();
    fillMicrophones($('#mic'), $('#micadvice'));
    const input = modem.diagnostics().input;
    if (input) errLog.add(`<span class="muted">microphone: ${escapeHtml(input.label || 'unnamed')}</span>`);
    startedAt = performance.now() / 1000;
    bandSel.disabled = profSel.disabled = $('#mic').disabled = true;
    $('#mic').micAdvice?.();
    $('#stop').disabled = false;
    setState('listening', 'live');
  } catch (err) {
    $('#start').disabled = false;
    errLog.add(`could not start: ${escapeHtml(err.message || err)}`, 'err');
    setState('failed', 'bad');
  }
});

$('#stop').addEventListener('click', async () => {
  if (modem) await modem.stop();
  modem = null;
  bandSel.disabled = profSel.disabled = $('#mic').disabled = false;
  $('#mic').micAdvice?.();
  $('#start').disabled = false;
  $('#stop').disabled = true;
  setState('stopped');
});

function setState(text, kind = '') {
  const p = $('#state');
  p.textContent = text;
  p.className = `pill ${kind}`;
}

function wire(m) {
  m.on('warning', (e) => {
    for (const w of e.detail.warnings) {
      $('#warnings').append(el('p', { class: 'note warn' }, w));
    }
  });

  m.on('stalled', () => {
    errLog.add('the audio thread has stopped reporting — nothing is being heard. Click the page, or stop and start again.', 'err');
    setState('audio stalled', 'bad');
  });
  m.on('resumed', () => { errLog.add('the audio thread is running again'); setState('listening', 'live'); });
  m.on('audio-state', (e) => errLog.add(`audio context is now <b>${escapeHtml(e.detail.state)}</b>`,
    e.detail.state === 'running' ? '' : 'warnrow'));

  m.on('ready', (e) => {
    errLog.add(`audio running at ${e.detail.sampleRate} Hz, `
      + `${e.detail.bitRate.toFixed(1)} bit/s, ${e.detail.bitSamples} samples per bit`);
  });

  m.on('frame-decoded', (e) => onFrame(e.detail, 'decoded'));
  m.on('frame', (e) => markDelivered(e.detail));

  m.on('error-frame', (e) => {
    const d = e.detail;
    errLog.add(`<b>${escapeHtml(d.kind)} error</b> — ${escapeHtml(d.detail || '')}`, 'err');
  });
  m.on('abandoned', (e) => {
    // Noise routinely produces these; they are not protocol violations (§6.2).
    errLog.add(`<span class="muted">abandoned: ${escapeHtml(e.detail.reason || '')}</span>`);
  });
  m.on('overload', () => errLog.add('overload frame'));
  m.on('error-state', (e) => {
    errLog.add(`error state ${e.detail.from} → <b>${e.detail.to}</b>`, 'warnrow');
  });

  m.on('status', (e) => onStatus(e.detail));
}

/* ---------------------------------------------------------------- */
/* frames                                                            */
/* ---------------------------------------------------------------- */

function onFrame(detail, status) {
  const f = detail.frame;
  const rec = {
    t: performance.now() / 1000 - startedAt,
    frame: f,
    crc: detail.crc,
    status,
    bits: detail.wireBits,
    startBit: detail.startBit,
  };
  frames.push(rec);
  render(rec);
  $('#nframes').textContent = frames.length;
}

function markDelivered(detail) {
  // `frame` follows `frame-decoded` for the same frame, so upgrade the last one.
  for (let i = frames.length - 1; i >= 0 && i > frames.length - 4; i--) {
    if (frames[i].frame.id === detail.frame.id && frames[i].status === 'decoded') {
      frames[i].status = 'delivered';
      const node = document.getElementById(`f${i}`);
      if (node) node.querySelector('.status').outerHTML = statusPill('delivered');
      return;
    }
  }
}

function statusPill(status) {
  return status === 'delivered'
    ? '<span class="status pill ok">delivered</span>'
    : '<span class="status pill">decoded</span>';
}

function render(rec) {
  const f = rec.frame;
  const idText = f.extended
    ? `0x${hex(f.id, 8)}<span class="muted">x</span>`
    : `0x${hex(f.id, 3)}`;
  const desc = describeId(f);
  const bytes = Array.from(f.data || []);

  let payload = '';
  if (bytes.length) {
    payload = `<span class="muted">[</span>${hexBytes(bytes)}<span class="muted">]</span>`
      + ` <span class="muted">${escapeHtml(asciiBytes(bytes))}</span>`;
  }

  // If the identifier follows Part 2, say what it means.
  let annotation = `<span class="muted">${escapeHtml(desc.text)}</span>`;
  if (!f.extended && parseBaseId(f.id).topic === TOPIC.TRANSPORT && bytes.length) {
    const pci = describePci(f.data);
    if (pci) annotation += ` <span class="muted">· ${escapeHtml(pci)}</span>`;
  }
  if (!f.extended && parseBaseId(f.id).topic === TOPIC.CONTROL && bytes.length) {
    const control = describeControl(f.data);              // side links, Part 2 §8
    if (control) annotation += ` <span class="muted">· ${escapeHtml(control)}</span>`;
  }

  const index = frames.length - 1;
  const body =
    `${statusPill(rec.status)} <b>${idText}</b> `
    + `${f.rtr ? '<span class="pill">RTR</span> ' : ''}`
    + `${f.extended ? '<span class="pill">ext</span> ' : ''}`
    + `${f.fdf ? '<span class="pill">FDF</span> ' : ''}`
    + `dlc=${f.dlc} ${payload} ${annotation} `
    + `<span class="muted">crc=0x${hex(rec.crc, 5)} ${rec.bits}b</span>`;

  if (!matchesFilter(rec)) return;
  frameLog.add(body);
  const last = $('#frames').lastElementChild;
  if (last) last.id = `f${index}`;
}

const filterInput = $('#filter');
filterInput.addEventListener('input', redraw);

function matchesFilter(rec) {
  const q = filterInput.value.trim().toLowerCase();
  if (!q) return true;
  const f = rec.frame;
  const hay = [
    hex(f.id, 3), hex(f.id, 8), `0x${hex(f.id, 3)}`,
    hexBytes(f.data), asciiBytes(f.data), describeId(f).text,
  ].join(' ').toLowerCase();
  return hay.includes(q);
}

function redraw() {
  frameLog.clear();
  frames.forEach((rec, i) => { if (matchesFilter(rec)) { render(rec); } });
}

$('#clear').addEventListener('click', () => {
  frames.length = 0;
  frameLog.clear();
  errLog.clear();
  $('#nframes').textContent = '0';
});

$('#export').addEventListener('click', () => {
  const lines = frames.map((r) => JSON.stringify({
    t: +r.t.toFixed(4),
    status: r.status,
    id: r.frame.id,
    idHex: `0x${hex(r.frame.id, r.frame.extended ? 8 : 3)}`,
    extended: r.frame.extended,
    rtr: r.frame.rtr,
    fdf: r.frame.fdf,
    dlc: r.frame.dlc,
    data: Array.from(r.frame.data || []),
    crc: r.crc,
    wireBits: r.bits,
  }));
  // The first line says which build captured the rest.
  lines.unshift(JSON.stringify({ capture: reportHeader() }));
  download(reportName('snooper', 'jsonl'), lines.join('\n') + '\n', 'application/x-ndjson');
});

/* ---------------------------------------------------------------- */
/* status and drawing                                                */
/* ---------------------------------------------------------------- */

function onStatus(s) {
  const sig = s.signal || {};
  $('#ratio').textContent = sig.ratio !== undefined ? sig.ratio.toFixed(3) : '—';
  $('#er').textContent = `${db(sig.eR)} dB`;
  $('#ed').textContent = `${db(sig.eD)} dB`;
  $('#nf').textContent = `${db(sig.noise)} dB`;

  const c = $('#carrier');
  c.textContent = sig.carrier ? 'carrier' : 'no carrier';
  c.className = `pill ${sig.carrier ? 'live' : ''}`;

  $('#rec').textContent = `REC ${s.rec}`;
  $('#errstate').textContent = s.errorState;
  $('#errstate').className = `pill ${s.errorState === 'error-active' ? 'ok' : 'warn'}`;

  const st = s.stats || {};
  $('#nbits').textContent = st.bitsObserved ?? 0;
  $('#nerr').textContent =
    (st.crcErrors || 0) + (st.stuffErrors || 0) + (st.formErrors || 0) + (st.bitErrors || 0);

  for (const b of s.bits || []) {
    bitHistory.push(b);
    totalBits++;
    if (b.carrier) carrierBits++;
  }
  while (bitHistory.length > BIT_HISTORY) bitHistory.shift();
  $('#load').textContent = totalBits ? `${Math.round((carrierBits / totalBits) * 100)}%` : '0%';

  drawBits();
  drawMeter(sig);
}

function drawBits() {
  drawBitStrip($('#bits'), bitHistory);
}

function drawMeter(sig) {
  drawLevels($('#meter'), sig);
}

window.addEventListener('resize', () => { drawBits(); drawMeter(modem?.status?.signal || {}); });
drawBits();
drawMeter({});
