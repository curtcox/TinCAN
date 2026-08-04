/**
 * TinCAN Simulator — a whole bus, offline.
 *
 * Runs the same `Phy` and `Protocol` as the live apps over a synthetic room.
 * Because it is sample-accurate and seeded, an arbitration you see here is the
 * same arbitration every time, which makes it a usable teaching and debugging
 * instrument rather than a demo.
 */

import { AcousticChannel, mulberry32 } from '../../src/tincan/bus.js';
import { BANDS, PROFILES, timing, maxRange, nearFarMarginDb } from '../../src/tincan/params.js';
import { SCENARIOS } from './scenarios.js';
import { formatFrame } from '../../src/tincan/frame.js';
import { $, el, LogView, topbar, escapeHtml } from '../ui.js';

$('#chrome').replaceWith(topbar('Simulator'));

const SIM_RATE = 16000;   // enough for bands A, C and D; band B needs more

/* ---------------------------------------------------------------- */
/* scenarios                                                         */
/* ---------------------------------------------------------------- */

/* ---------------------------------------------------------------- */
/* controls                                                          */
/* ---------------------------------------------------------------- */

const scenarioSel = $('#scenario');
for (const [key, s] of Object.entries(SCENARIOS)) {
  scenarioSel.append(el('option', { value: key }, s.name));
}

const profSel = $('#profile');
for (const [key, p] of Object.entries(PROFILES)) {
  profSel.append(el('option', { value: key }, `${key} — ${Math.round(timing(p).bitRate)} bit/s`));
}
const bandSel = $('#band');
for (const [key, b] of Object.entries(BANDS)) {
  bandSel.append(el('option', { value: key }, `${b.name}`));
}
bandSel.value = 'A';

const events = new LogView($('#events'), { limit: 1200 });
const outcome = new LogView($('#outcome'), { limit: 200 });

function loadScenario() {
  const s = SCENARIOS[scenarioSel.value];
  $('#desc').innerHTML = escapeHtml(s.description);
  profSel.value = s.profile || 'T25';
  $('#noise').value = String(Math.round((s.noise ?? 0.0005) * 2000));
  $('#rt60').value = String(Math.round((s.rt60 ?? 0) * 100));
  $('#duration').value = String(s.duration ?? 20);
  syncLabels();
  renderNodes(s);
  drawRoom(s);
  timeline = null;
  drawTimeline();
}

function syncLabels() {
  $('#noiseval').textContent = (Number($('#noise').value) / 2000).toFixed(4);
  $('#rtval').textContent = Number($('#rt60').value) === 0
    ? 'off' : `${(Number($('#rt60').value) / 100).toFixed(2)} s`;
  $('#durval').textContent = `${$('#duration').value} s`;
  const p = profSel.value;
  $('#roomnote').innerHTML =
    `${Math.round(timing(p).bitRate)} bit/s, bit time ${(timing(p).bitTime * 1000).toFixed(0)} ms. `
    + `Arbitration is good to about <b>${maxRange(p).toFixed(1)} m</b> at this profile `
    + `(spec §5.6), and the near-far margin is <b>${nearFarMarginDb().toFixed(1)} dB</b> (§4.6). `
    + `Circles are drawn at the arbitration radius around each node.`;
}

for (const id of ['#noise', '#rt60', '#duration']) {
  $(id).addEventListener('input', () => { syncLabels(); drawRoom(SCENARIOS[scenarioSel.value]); });
}
profSel.addEventListener('change', () => { syncLabels(); drawRoom(SCENARIOS[scenarioSel.value]); });
scenarioSel.addEventListener('change', loadScenario);

function renderNodes(s) {
  const box = $('#nodes');
  box.replaceChildren();
  for (const n of s.nodes) {
    box.append(el('div', { class: 'row', style: 'font-family:var(--mono);font-size:.8rem;margin-bottom:.25rem' },
      el('span', { style: 'flex:0 0 4.5rem' }, n.name),
      el('span', { class: 'muted' }, `(${n.x.toFixed(2)}, ${n.y.toFixed(2)}) m`)));
  }
}

/* ---------------------------------------------------------------- */
/* running                                                           */
/* ---------------------------------------------------------------- */

let running = false;
let cancelled = false;
let timeline = null;

$('#run').addEventListener('click', run);
$('#cancel').addEventListener('click', () => { cancelled = true; });

async function run() {
  if (running) return;
  running = true; cancelled = false;
  $('#run').disabled = true; $('#cancel').disabled = false;
  events.clear(); outcome.clear();

  const s = SCENARIOS[scenarioSel.value];
  const duration = Number($('#duration').value);
  const verbose = $('#verbose').checked;

  // A passive probe in the middle of the room, so the timeline's bottom row is
  // what a neutral observer hears rather than what any participant hears.
  const cx = s.nodes.reduce((a, n) => a + n.x, 0) / s.nodes.length;
  const cy = s.nodes.reduce((a, n) => a + n.y, 0) / s.nodes.length;

  const records = new Map();
  const specs = [
    ...s.nodes.map((n) => ({ ...n, onBit: bitRecorder(records, n.name) })),
    { name: 'probe', x: cx, y: cy, mode: 'listener', onBit: bitRecorder(records, 'probe') },
  ];

  const ch = new AcousticChannel({
    sampleRate: SIM_RATE,
    band: bandSel.value,
    profile: profSel.value,
    noise: Number($('#noise').value) / 2000,
    rt60: Number($('#rt60').value) / 100,
    nodes: specs,
    random: mulberry32(Number($('#seed').value) || 1),
  });

  const byName = {};
  for (const n of ch.nodes) byName[n.spec.name] = n.protocol;

  for (const [name, p] of Object.entries(byName)) {
    p.on('*', (e) => {
      if (!verbose && !INTERESTING.has(e.event)) return;
      events.add(describeEvent(name, e, ch), eventClass(e.event));
    });
  }

  const script = (s.script || []).map((step) => ({ ...step, done: false }));
  const totalSamples = Math.round(duration * SIM_RATE);
  const chunk = Math.round(SIM_RATE * 0.05);
  let done = 0;
  const t0 = performance.now();
  let lastYield = t0;

  while (done < totalSamples && !cancelled) {
    const now = done / SIM_RATE;
    for (const step of script) {
      if (!step.done && now >= step.t) { step.done = true; step.do(byName); }
    }
    const n = Math.min(chunk, totalSamples - done);
    for (let i = 0; i < n; i++) ch.stepSample();
    done += n;

    // The engine runs far faster than real time — a 20 s scenario is well under
    // a second of work — so yielding per chunk would be pure overhead, and in a
    // background tab, where timers are clamped to 1 Hz, it would take minutes.
    // Project the total from what we have measured and only yield if the run is
    // long enough for the page to appear frozen without it.
    const nowWall = performance.now();
    const projected = ((nowWall - t0) / done) * totalSamples;
    if (projected > 400 && nowWall - lastYield > 150) {
      lastYield = nowWall;
      $('#progress').textContent = `${Math.round((done / totalSamples) * 100)}%`;
      $('#progress').className = 'pill live';
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const wall = ((performance.now() - t0) / 1000).toFixed(1);
  $('#progress').textContent = cancelled ? 'stopped' : `done in ${wall} s`;
  $('#progress').className = 'pill';

  timeline = { records, order: [...s.nodes.map((n) => n.name), 'probe'], duration: done / SIM_RATE };
  $('#pan').value = '0';
  drawTimeline();
  summarise(ch, s);

  running = false;
  $('#run').disabled = false; $('#cancel').disabled = true;
}

function bitRecorder(records, name) {
  const arr = [];
  records.set(name, arr);
  return (d) => arr.push({ t: d.time, level: d.level, carrier: d.carrier, tx: d.tx, ratio: d.ratio });
}

const INTERESTING = new Set([
  'tx-start', 'tx-complete', 'tx-failed', 'arbitration-lost',
  'error-frame', 'error-state', 'frame', 'bus-off-recovered',
]);

function eventClass(name) {
  if (name === 'error-frame' || name === 'tx-failed') return 'err';
  if (name === 'arbitration-lost' || name === 'error-state') return 'warnrow';
  if (name === 'tx-start' || name === 'tx-complete') return 'tx';
  return '';
}

function describeEvent(name, e, ch) {
  const at = (ch.n / ch.sampleRate).toFixed(2);
  const who = `<b>${escapeHtml(name)}</b>`;
  switch (e.event) {
    case 'tx-start':
      return `${at}s ${who} → ${escapeHtml(formatFrame(e.frame))}`
        + (e.attempt > 1 ? ` <span class="muted">attempt ${e.attempt}</span>` : '');
    case 'tx-complete': return `${at}s ${who} ✓ delivered ${escapeHtml(formatFrame(e.frame))}`;
    case 'tx-failed': return `${at}s ${who} ✗ gave up: ${escapeHtml(e.detail || '')}`;
    case 'arbitration-lost':
      return `${at}s ${who} ⊘ lost arbitration at bit ${e.bit} — deferring `
        + `${escapeHtml(formatFrame(e.frame))}`;
    case 'frame': return `${at}s ${who} ← ${escapeHtml(formatFrame(e.frame))}`;
    case 'error-frame': return `${at}s ${who} ${escapeHtml(e.kind)} error: ${escapeHtml(e.detail || '')}`;
    case 'error-state': return `${at}s ${who} ${e.from} → <b>${e.to}</b> (TEC ${e.tec}, REC ${e.rec})`;
    default: return `${at}s ${who} ${escapeHtml(e.event)}`;
  }
}

function summarise(ch, s) {
  for (const n of ch.nodes) {
    const p = n.protocol;
    const st = p.stats;
    const errs = st.bitErrors + st.crcErrors + st.stuffErrors + st.formErrors + st.ackErrors;
    outcome.add(
      `<b>${escapeHtml(n.spec.name)}</b> `
      + `sent ${st.framesSent}, received ${st.framesReceived}, `
      + `lost arbitration ${st.arbitrationsLost}× `
      + `<span class="muted">· TEC ${p.tec} REC ${p.rec} · ${p.errorState}</span>`
      + (errs ? `<br><span class="muted">errors — bit ${st.bitErrors}, crc ${st.crcErrors}, `
        + `stuff ${st.stuffErrors}, form ${st.formErrors}, ack ${st.ackErrors}</span>` : ''),
      errs ? 'err' : '');
  }
}

/* ---------------------------------------------------------------- */
/* drawing                                                           */
/* ---------------------------------------------------------------- */

function fit(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight || parseInt(canvas.getAttribute('height'), 10);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function drawRoom(s) {
  const { ctx, w, h } = fit($('#room'));
  ctx.clearRect(0, 0, w, h);
  const nodes = s.nodes;
  const range = maxRange(profSel.value);

  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  const pad = 40;
  const minX = Math.min(...xs) - range, maxX = Math.max(...xs) + range;
  const minY = Math.min(...ys) - range, maxY = Math.max(...ys) + range;
  const scale = Math.min((w - pad * 2) / Math.max(0.5, maxX - minX),
                         (h - pad * 2) / Math.max(0.5, maxY - minY));
  const X = (x) => pad + (x - minX) * scale;
  const Y = (y) => pad + (y - minY) * scale;

  ctx.strokeStyle = cssVar('--line');
  ctx.fillStyle = cssVar('--dim');
  ctx.font = '11px ui-monospace, monospace';

  for (const n of nodes) {
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    ctx.arc(X(n.x), Y(n.y), range * scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  for (const n of nodes) {
    ctx.fillStyle = cssVar('--accent');
    ctx.beginPath();
    ctx.arc(X(n.x), Y(n.y), 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = cssVar('--ink');
    ctx.fillText(n.name, X(n.x) + 9, Y(n.y) + 4);
  }

  // scale bar
  ctx.strokeStyle = cssVar('--faint');
  ctx.beginPath();
  ctx.moveTo(pad, h - 14); ctx.lineTo(pad + scale, h - 14); ctx.stroke();
  ctx.fillStyle = cssVar('--faint');
  ctx.fillText('1 m', pad + scale + 6, h - 10);
}

$('#zoom').addEventListener('input', drawTimeline);
$('#pan').addEventListener('input', drawTimeline);

function drawTimeline() {
  const { ctx, w, h } = fit($('#timeline'));
  ctx.clearRect(0, 0, w, h);
  if (!timeline) {
    ctx.fillStyle = cssVar('--faint');
    ctx.font = '12px ui-sans-serif, sans-serif';
    ctx.fillText('run a scenario to see the bus', 12, h / 2);
    return;
  }

  const zoom = Number($('#zoom').value);
  const pan = Number($('#pan').value) / 1000;
  const span = timeline.duration / zoom;
  const t0 = pan * (timeline.duration - span);
  const t1 = t0 + span;

  const labelW = 56;
  const rows = timeline.order;
  const rowH = Math.min(26, (h - 16) / rows.length);
  const dom = cssVar('--dominant');
  const rec = cssVar('--recessive');
  const faint = cssVar('--faint');

  ctx.font = '10px ui-monospace, monospace';

  rows.forEach((name, i) => {
    const y = 8 + i * rowH;
    ctx.fillStyle = name === 'probe' ? cssVar('--ink') : cssVar('--dim');
    ctx.fillText(name, 0, y + rowH * 0.65);

    ctx.strokeStyle = cssVar('--line');
    ctx.beginPath(); ctx.moveTo(labelW, y + rowH - 2); ctx.lineTo(w, y + rowH - 2); ctx.stroke();

    const bits = timeline.records.get(name) || [];
    const isProbe = name === 'probe';
    for (const b of bits) {
      if (b.t < t0 || b.t > t1) continue;
      // A node's own row shows what it transmitted; the probe row shows what
      // it observed, which is the wired-AND of everyone.
      const level = isProbe ? (b.carrier ? b.level : null) : b.tx;
      if (level === null || level === undefined) continue;
      const x = labelW + ((b.t - t0) / span) * (w - labelW);
      const bw = Math.max(1.2, ((1 / (bits.length / timeline.duration)) / span) * (w - labelW) * 0.9);
      ctx.fillStyle = level === 0 ? dom : rec;
      const bh = level === 0 ? rowH - 6 : (rowH - 6) * 0.55;
      ctx.fillRect(x, y + (rowH - 6) - bh, bw, bh);
    }
  });

  // time axis
  ctx.fillStyle = faint;
  ctx.fillText(`${t0.toFixed(1)}s`, labelW, h - 2);
  ctx.fillText(`${t1.toFixed(1)}s`, w - 34, h - 2);
}

window.addEventListener('resize', () => {
  drawRoom(SCENARIOS[scenarioSel.value]);
  drawTimeline();
});

loadScenario();
