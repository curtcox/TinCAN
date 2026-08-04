/**
 * TinCAN Snooper — a passive bus analyzer.
 *
 * Conforms to the Listener profile of spec §9.1: it decodes everything and
 * transmits nothing, deliberately, so that watching the bus does not change it.
 */

import { Modem, checkSupport } from '../../src/tincan/modem.js';
import { BANDS, PROFILES, timing, maxRange, DETECTOR_DEFAULTS } from '../../src/tincan/params.js';
import { describeId, describePci, TOPIC, parseBaseId } from '../../src/tincan/transport.js';
import { $, el, hex, hexBytes, asciiBytes, LogView, topbar, escapeHtml, download, db } from '../ui.js';

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
profSel.value = 'T25';

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
bandSel.addEventListener('change', describePhy);
profSel.addEventListener('change', describePhy);
describePhy();

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
    });
    wire(modem);
    await modem.start();
    startedAt = performance.now() / 1000;
    bandSel.disabled = profSel.disabled = true;
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
  bandSel.disabled = profSel.disabled = false;
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
  download(`tincan-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`,
    lines.join('\n') + '\n', 'application/x-ndjson');
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

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight || parseInt(canvas.getAttribute('height'), 10);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawBits() {
  const { ctx, w, h } = fitCanvas($('#bits'));
  ctx.clearRect(0, 0, w, h);
  const n = Math.max(1, Math.floor(w / 3));
  const shown = bitHistory.slice(-n);
  const bw = w / n;

  const dom = cssVar('--dominant');
  const rec = cssVar('--recessive');
  const faint = cssVar('--faint');
  const line = cssVar('--line');

  for (let i = 0; i < shown.length; i++) {
    const b = shown[i];
    const x = i * bw;
    const frac = Math.max(0.04, Math.min(1, b.ratio || 0));
    const bh = Math.max(2, frac * (h - 10));
    ctx.fillStyle = !b.carrier ? faint : (b.level === 0 ? dom : rec);
    ctx.globalAlpha = b.carrier ? 1 : 0.35;
    ctx.fillRect(x, h - bh - 4, Math.max(1, bw - 0.6), bh);
  }
  ctx.globalAlpha = 1;

  // theta_D threshold line
  const theta = DETECTOR_DEFAULTS.thetaD;
  const ty = h - 4 - theta * (h - 10);
  ctx.strokeStyle = line;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(0, ty); ctx.lineTo(w, ty); ctx.stroke();
  ctx.setLineDash([]);
}

function drawMeter(sig) {
  const { ctx, w, h } = fitCanvas($('#meter'));
  ctx.clearRect(0, 0, w, h);

  const dom = cssVar('--dominant');
  const rec = cssVar('--recessive');
  const line = cssVar('--line');
  const dim = cssVar('--dim');

  const pad = 34;
  const barH = 16;
  const toX = (v) => pad + Math.max(0, Math.min(1, (db(v) === '−∞' ? 0 : (60 + 10 * Math.log10(Math.max(v, 1e-12))) / 60))) * (w - pad - 8);

  const rows = [
    ['f_R', sig.eR || 0, rec],
    ['f_D', sig.eD || 0, dom],
    ['noise', sig.noise || 0, dim],
  ];
  ctx.font = '10px ui-monospace, monospace';
  rows.forEach(([label, value, colour], i) => {
    const y = 8 + i * (barH + 8);
    ctx.fillStyle = dim;
    ctx.fillText(label, 0, y + barH - 4);
    ctx.fillStyle = line;
    ctx.fillRect(pad, y, w - pad - 8, barH);
    ctx.fillStyle = colour;
    ctx.fillRect(pad, y, Math.max(1, toX(value) - pad), barH);
  });

  // ratio marker with the theta_D decision point
  const y = 8 + 3 * (barH + 8);
  const trackW = w - pad - 8;
  ctx.fillStyle = dim;
  ctx.fillText('E_D/Σ', 0, y + 10);
  ctx.fillStyle = line;
  ctx.fillRect(pad, y, trackW, 6);
  ctx.fillStyle = (sig.ratio || 0) >= DETECTOR_DEFAULTS.thetaD ? dom : rec;
  ctx.fillRect(pad, y, Math.max(1, (sig.ratio || 0) * trackW), 6);
  ctx.fillStyle = dom;
  ctx.fillRect(pad + DETECTOR_DEFAULTS.thetaD * trackW - 1, y - 3, 2, 12);
}

window.addEventListener('resize', () => { drawBits(); drawMeter(modem?.status?.signal || {}); });
drawBits();
drawMeter({});
