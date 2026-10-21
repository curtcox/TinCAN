/**
 * TinCAN Bands — how the bands compare in loudness, reach and capacity,
 * computed from the band plan and the standards in acoustics.js, plus a way
 * to hear and measure them on this device.
 */

import {
  BANDS, PROFILES, timing, maxRange, bandsCompatible, profileFitsBand, nearFarMarginDb, bandFitsRate, sampleRateFor,
} from '../../src/tincan/params.js';
import { CONTEXT_OPTIONS, audioConstraints, Modem } from '../../src/tincan/modem.js';
import { Session } from '../../src/tincan/transport.js';
import { $, el, topbar, escapeHtml, fitProfiles, LogView, measuredLatency } from '../ui.js';
import { BandTestPanel } from '../bandtest.js';
import { toneAmplitude, AMPLITUDE } from '../selftest/probe.js';
import {
  sweepPlan, sweepSignal, analyseSweep, CARRIES_DB, USABLE_DB, FLAT_DB, USABLE_FLAT_DB,
} from './sweep.js';
import {
  phon, hearingThreshold, aWeighting, airAbsorption, shannon, toneBalance, TIGHT_RATIO,
} from './acoustics.js';

$('#chrome').replaceWith(topbar('Bands'));

const KEYS = Object.keys(BANDS);
const tones = (b) => [BANDS[b].fR, BANDS[b].fD];
const hz = (f) => (f >= 1000 ? `${(f / 1000).toFixed(f % 1000 ? 2 : 0)} kHz` : `${f} Hz`);
const fmt = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d));
const signed = (v, d = 1) => {
  const s = v.toFixed(d);
  return Number(s) > 0 ? `+${s}` : Number(s) === 0 ? (0).toFixed(d) : s;   // never "-0"
};

/** Who hears a band, in words. Above ISO 226, from Wang et al. (2021). */
const HEARD_BY = {
  A: 'Everyone with normal hearing: 3–4 kHz is where the ear is most sensitive.',
  B: 'At 18 kHz, 78 % of 21–30 year olds, 20 % of 31–40, and almost nobody older. Those who hear it '
    + 'often find it shrill. Pets, especially dogs and cats, hear it easily.',
  C: 'Everyone with normal hearing; it sits in the range of speech.',
  D: 'Everyone with normal hearing, a little less keenly than A.',
  E: 'Everyone with normal hearing, less keenly than A or C. It sits among the vowels of speech, so it is '
    + 'easily masked by talk and blends into it rather than standing out.',
  F: 'Practically nobody: adult hearing ends below 20 kHz, and even young adults rarely hear past it. '
    + 'Dogs and cats hear it easily, and some find it unpleasant.',
  G: 'Everyone, but faintly: at 150 Hz the ear needs about 20 dB more sound to hear a tone than at 3 kHz. '
    + 'Low notes carry through walls and floors, and are felt as much as heard.',
};

function table(node, head, rows) {
  node.replaceChildren(
    el('thead', {}, el('tr', {}, head.map((h) => el('th', { html: h })))),
    el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c) => el('td', { html: String(c) }))))));
}

/* ------------------------------------------------------------------ */
/* loudness                                                            */
/* ------------------------------------------------------------------ */

function renderLoudness() {
  const spl = Number($('#spl').value);
  $('#refspl').textContent = String(spl);
  const loud = (b) => Math.max(...tones(b).map((f) => phon(f, spl) ?? -Infinity));
  const ref = loud('A');
  table($('#loudness'),
    ['Band', 'Tones', 'Loudness', 'vs band A', 'Threshold of hearing<br><span class="muted">dB SPL, age 18–25</span>',
      'A-weighting', 'Who hears it'],
    KEYS.map((b) => {
      const L = loud(b);
      const iso = Number.isFinite(L);
      return [
        `<b>${escapeHtml(BANDS[b].name)}</b>`,
        tones(b).map(hz).join(' / '),
        iso ? `${fmt(L)} phon` : '<span class="muted">beyond ISO 226</span>',
        iso ? (b === 'A' ? '—' : `${signed(L - ref)} phon`) : '<span class="muted">much quieter, or silent</span>',
        tones(b).map((f) => fmt(hearingThreshold(f))).join(' / '),
        tones(b).map((f) => `${signed(aWeighting(f))} dB`).join(' / '),
        escapeHtml(HEARD_BY[b]),
      ];
    }));
}
$('#spl').addEventListener('input', renderLoudness);
renderLoudness();

/* ------------------------------------------------------------------ */
/* reach                                                               */
/* ------------------------------------------------------------------ */

table($('#carry'),
  ['Band', 'Absorbed per 10 m', 'Below 1 m level at 3 m', 'at 10 m', 'at 30 m', 'Notes'],
  KEYS.map((b) => {
    const a = airAbsorption(BANDS[b].fD);
    const at = (d) => `${(20 * Math.log10(d) + a * (d - 1)).toFixed(1)} dB`;
    return [
      `<b>${escapeHtml(BANDS[b].name)}</b>`, `${(a * 10).toFixed(2)} dB`, at(3), at(10), at(30),
      escapeHtml(BANDS[b].note),
    ];
  }));

/* ------------------------------------------------------------------ */
/* capacity                                                            */
/* ------------------------------------------------------------------ */

const FRAME_BITS = 123;                               // 8-octet base frame, no stuffing (Part 1 App. A)
const slotHz = (b) => BANDS[b].guardHi - BANDS[b].guardLo;
/** The fastest profile a band's tone spacing allows (Part 1 §4.2). */
const fastestOn = (b) => Object.keys(PROFILES).find((p) => profileFitsBand(b, p));

table($('#rates'),
  ['Profile', 'Bit rate', '8-octet frame', 'User data', 'Arbitration range', 'Bands'],
  Object.keys(PROFILES).map((p) => {
    const t = timing(p);
    return [
      `<code>${p}</code>`, `${fmt(t.bitRate, t.bitRate < 10 ? 0 : 0)} bit/s`, `${(FRAME_BITS / t.bitRate).toFixed(1)} s`,
      `${(8 * t.bitRate / FRAME_BITS).toFixed(2)} octet/s`, `~${maxRange(p).toFixed(1)} m`,
      KEYS.filter((b) => profileFitsBand(b, p)).join(' '),
    ];
  }));

table($('#capacity'),
  ['Band', 'Slot', 'Could carry<br><span class="muted">Shannon, at 20 / 30 / 40 dB SNR</span>',
    'TinCAN at its fastest uses', 'Can share a device with', 'Needs'],
  KEYS.map((b) => {
    const others = KEYS.filter((o) => o !== b).map((o) => {
      // The fastest profile both bands allow, then the fastest at which they share.
      const both = Object.keys(PROFILES).filter((p) => profileFitsBand(b, p) && profileFitsBand(o, p));
      const p = both.find((q) => bandsCompatible(b, q, o, q));
      if (!p) return null;
      return p === both[0] ? o : `${o} <span class="muted">(${p} and slower)</span>`;
    }).filter(Boolean);
    const c30 = shannon(slotHz(b), 30);
    const top = fastestOn(b);
    return [
      `<b>${escapeHtml(BANDS[b].name)}</b>`,
      `${hz(BANDS[b].guardLo)}–${hz(BANDS[b].guardHi)}`,
      [20, 30, 40].map((s) => `${(shannon(slotHz(b), s) / 1000).toFixed(0)}`).join(' / ') + ' kbit/s',
      `${(100 * timing(top).bitRate / c30).toFixed(2)} % <span class="muted">of it at 30 dB, at ${top}</span>`,
      others.join(', '),
      [
        sampleRateFor(b) > 16000 && `audio at ${hz(sampleRateFor(b))} or more, and a speaker and microphone that reach ${hz(BANDS[b].guardHi)}`,
        top !== 'T100' && `${top} or slower, since its tones are ${BANDS[b].fD - BANDS[b].fR} Hz apart, not 1250`,
        BANDS[b].guardHi < 1500 && `a speaker with real output down to ${hz(BANDS[b].guardLo)}, which a phone's or a thin laptop's may barely have`,
        b === 'D' && 'nothing in principle; intended for a cable',
      ].filter(Boolean).join('; ') || 'nothing special',
    ];
  }));

/* ------------------------------------------------------------------ */
/* hear them                                                           */
/* ------------------------------------------------------------------ */

let playing = null;

/** Two seconds of a band's tones alternating at T25's 40 ms bits, with the Phy's 1 ms ramps. */
function bandPattern(ctx, b) {
  const fs = ctx.sampleRate;
  const bit = Math.round(timing('T25').bitTime * fs);
  const ramp = Math.round(0.001 * fs);
  const buf = ctx.createBuffer(1, 50 * bit, fs);
  const x = buf.getChannelData(0);
  for (let k = 0; k < 50; k++) {
    const f = (k & 1) ? BANDS[b].fD : BANDS[b].fR;
    for (let i = 0; i < bit; i++) {
      const edge = Math.min(i, bit - 1 - i);
      const g = edge < ramp ? 0.5 - 0.5 * Math.cos((Math.PI * (edge + 1)) / ramp) : 1;
      x[k * bit + i] = AMPLITUDE * g * Math.sin((2 * Math.PI * f * (k * bit + i)) / fs);
    }
  }
  return buf;
}

for (const b of KEYS) {
  $('#play').append(el('button', {
    onclick: async () => {
      if (playing) { playing.ctx.close(); playing = null; }
      const ctx = new (window.AudioContext || window.webkitAudioContext)(CONTEXT_OPTIONS);
      if (!bandFitsRate(b, ctx.sampleRate)) {
        $('#playstate').textContent = `band ${b} needs a higher sample rate than ${ctx.sampleRate} Hz`;
        ctx.close();
        return;
      }
      const src = ctx.createBufferSource();
      src.buffer = bandPattern(ctx, b);
      src.connect(ctx.destination);
      src.onended = () => { if (playing?.ctx === ctx) { ctx.close(); playing = null; $('#playstate').textContent = 'silent'; } };
      playing = { ctx };
      $('#playstate').textContent = `playing band ${b}`;
      src.start();
    },
  }, `Play band ${b}`));
}

/* ------------------------------------------------------------------ */
/* measure them                                                        */
/* ------------------------------------------------------------------ */

const MARGIN_DB = Math.abs(nearFarMarginDb());   // Part 1 §4.6: how much weaker the dominant may arrive
// Written here, not in the page, so that a page cached from before it still loads.
$('#measure').parentElement.before(el('p', {
  class: 'note',
  html: 'It also compares the two tones. In arbitration one node\'s dominant tone has to hold its own against '
    + `another's recessive tone, which it can do arriving up to ${fmt(MARGIN_DB)} dB weaker `
    + '(<a href="../../spec/tincan-1.0.html#46-near-far-limit">Part 1 §4.6</a>): in open air, a contender up to '
    + `${fmt(10 ** (MARGIN_DB / 20))} times as far away. A speaker and microphone that reproduce the dominant tone `
    + 'weaker than the recessive spend that margin before distance does, on every path between devices like this '
    + `one. The page warns when what is left allows less than a ${TIGHT_RATIO}:1 distance ratio. Below 1 kHz the `
    + 'balance also depends on where the device sits in the room, so measure where it will be used.',
}));
const QUIET = 0.5;          // seconds of silence first, for the noise
const TONE = 0.35;          // each tone
const GAP = 0.15;           // after each tone, for its echo to die and latency
const TAIL = 0.6;           // after the last, for latency

/** The schedule: [band, frequency, start seconds] for each tone played. */
function schedule(bands) {
  const out = [];
  let t = QUIET;
  for (const b of bands) for (const f of tones(b)) { out.push([b, f, t]); t += TONE + GAP; }
  return { tones: out, seconds: t + TAIL };
}

function measureSignal(fs, plan) {
  const x = new Float32Array(Math.round(plan.seconds * fs));
  const ramp = Math.round(0.001 * fs);
  const n = Math.round(TONE * fs);
  for (const [, f, t0] of plan.tones) {
    const s = Math.round(t0 * fs);
    for (let i = 0; i < n; i++) {
      const edge = Math.min(i, n - 1 - i);
      const g = edge < ramp ? 0.5 - 0.5 * Math.cos((Math.PI * (edge + 1)) / ramp) : 1;
      x[s + i] = AMPLITUDE * g * Math.sin((2 * Math.PI * f * i) / fs);
    }
  }
  return x;
}

/**
 * The level of tone `f` played from `t0`, wherever in the next TONE + TAIL
 * seconds it arrived: the best TONE-long stretch of 20 ms readings.
 */
function heardLevel(rec, fs, f, t0) {
  const w = Math.round(0.02 * fs);
  const hop = Math.round(0.005 * fs);
  const env = [];
  for (let e = Math.round(t0 * fs) + w; e <= Math.min(rec.length, Math.round((t0 + TONE + TAIL) * fs)); e += hop) {
    env.push(toneAmplitude(rec, e, w, f, fs));
  }
  const span = Math.max(1, Math.round((TONE - 0.04) * fs / hop));
  let best = 0;
  for (let i = 0; i + span <= env.length; i++) {
    let s = 0;
    for (let k = i; k < i + span; k++) s += env[k];
    best = Math.max(best, s / span);
  }
  return best;
}

function noiseLevel(rec, fs, f) {
  const w = Math.round(0.02 * fs);
  let sum = 0, n = 0;
  for (let e = Math.round(0.05 * fs) + w; e <= Math.round((QUIET - 0.02) * fs); e += Math.round(0.005 * fs)) {
    sum += toneAmplitude(rec, e, w, f, fs) ** 2;
    n++;
  }
  return Math.sqrt(sum / Math.max(1, n));
}

/**
 * Plays the signal `build(fs)` returns ({signal, seconds, ...}) and records
 * the microphone in the same audio callbacks, so that the recording and the
 * signal share one clock. Resolves with the recording, the sample rate, the
 * microphone's name and whatever else `build` returned.
 */
async function playAndRecord(build) {
  let stream = null, ctx = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: await audioConstraints('') });
    ctx = new (window.AudioContext || window.webkitAudioContext)(CONTEXT_OPTIONS);
    if (ctx.state === 'suspended') await ctx.resume();
    const fs = ctx.sampleRate;
    const built = build(fs);
    await ctx.audioWorklet.addModule(new URL('../selftest/probe-worklet.js', import.meta.url));
    const probe = new AudioWorkletNode(ctx, 'tincan-probe', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { signal: built.signal, recordSamples: Math.round(built.seconds * fs) },
    });
    const done = new Promise((resolve) => { probe.port.onmessage = (e) => resolve(e.data.recording); });
    ctx.createMediaStreamSource(stream).connect(probe);
    probe.connect(ctx.destination);
    const rec = await done;
    return { ...built, rec, fs, label: stream.getAudioTracks()[0]?.label || 'the default microphone' };
  } finally {
    if (stream) for (const t of stream.getTracks()) t.stop();
    if (ctx) ctx.close();
  }
}

$('#measure').addEventListener('click', async () => {
  $('#measure').disabled = true;
  $('#measurestate').textContent = 'playing…';
  $('#measurestate').className = 'pill live';
  try {
    const { rec, fs, label, bands, plan } = await playAndRecord((fs) => {
      const bands = KEYS.filter((b) => bandFitsRate(b, fs));
      const plan = schedule(bands);
      return { bands, plan, signal: measureSignal(fs, plan), seconds: plan.seconds };
    });

    const rows = KEYS.map((b) => {
      if (!bands.includes(b)) {
        return [`<b>${escapeHtml(BANDS[b].name)}</b>`, '—', '—', '—', '—', `not at ${fs} Hz`];
      }
      const cells = tones(b).map((f) => {
        const lvl = heardLevel(rec, fs, f, plan.tones.find(([bb, ff]) => bb === b && ff === f)[2]);
        const nse = noiseLevel(rec, fs, f);
        return { lvl, snr: 20 * Math.log10(Math.max(lvl, 1e-9) / Math.max(nse, 1e-9)) };
      });
      const worst = Math.min(...cells.map((c) => c.snr));
      let verdict = worst >= 30 ? 'carries well' : worst >= 15 ? 'usable, short range' : worst >= 6 ? 'barely' : 'not heard';
      // Tone balance only matters for a band that is heard at all.
      const bal = toneBalance(cells[0].lvl, cells[1].lvl, MARGIN_DB);
      let balance = `${signed(bal.tiltDb, 0)} dB: ${fmt(bal.marginDb)} dB left, ${fmt(bal.ratio)}:1`;
      if (worst >= 6 && bal.level === 'fails') {
        balance = `<b>${signed(bal.tiltDb, 0)} dB: no margin left</b>`;
        verdict = `<b>${verdict}, but cannot arbitrate</b>`;
      } else if (worst >= 6 && bal.level === 'tight') {
        balance = `<b>${balance}</b>`;
        verdict = `<b>${verdict}, but contenders must be within ${fmt(bal.ratio)}:1 of each other's distance</b>`;
      }
      return [
        `<b>${escapeHtml(BANDS[b].name)}</b>`,
        cells.map((c) => `${fmt(20 * Math.log10(Math.max(c.lvl, 1e-9)), 0)}`).join(' / ') + ' dBFS',
        cells.map((c) => `${signed(20 * Math.log10(Math.max(c.lvl, 1e-9) / AMPLITUDE), 0)}`).join(' / ') + ' dB',
        cells.map((c) => fmt(c.snr, 0)).join(' / ') + ' dB',
        balance,
        verdict,
      ];
    });
    table($('#measured'), ['Band', 'Heard', 'Speaker to microphone', 'Above the room\'s noise',
      `Dominant vs recessive<br><span class="muted">and what it leaves of the ${fmt(MARGIN_DB)} dB margin</span>`,
      'Here'], rows);
    $('#measurestate').textContent = `measured through ${label}`;
    $('#measurestate').className = 'pill ok';
  } catch (err) {
    $('#measurestate').textContent = `failed: ${err.message || err}`;
    $('#measurestate').className = 'pill bad';
  } finally {
    $('#measure').disabled = false;
  }
});

/* ------------------------------------------------------------------ */
/* find the range                                                      */
/* ------------------------------------------------------------------ */

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

/**
 * One measure against frequency, on a log axis, with dashed threshold lines:
 * `key` of each point, `rules` as [value, name] pairs, `lo`–`hi` the scale.
 */
function drawSweep(points, key, title, rules, lo, hi) {
  const W = 720, H = 220, L = 44, R = 12, T = 18, B = 30;
  const fMin = 40, fMax = Math.max(...points.map((p) => p.f));
  const x = (f) => L + ((Math.log(f) - Math.log(fMin)) / (Math.log(fMax) - Math.log(fMin))) * (W - L - R);
  const y = (v) => T + (1 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (H - T - B);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': `${title} against frequency`,
    style: 'max-width:46rem;display:block;font-family:var(--sans);margin-top:.5rem' });
  const text = (x0, y0, str, attrs = {}) => {
    const t = svg('text', { x: x0, y: y0, 'font-size': 11, fill: 'var(--faint)', ...attrs });
    t.textContent = str;
    root.append(t);
  };
  for (let v = lo; v <= hi; v += 20) {
    root.append(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: 'var(--line)', 'stroke-width': 1 }));
    text(L - 6, y(v) + 4, `${v}`, { 'text-anchor': 'end' });
  }
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].filter((f) => f <= fMax)) {
    text(x(f), H - B + 16, f >= 1000 ? `${f / 1000}k` : `${f}`, { 'text-anchor': 'middle' });
  }
  text(W - R, H - 2, 'Hz', { 'text-anchor': 'end', fill: 'var(--dim)' });
  text(L, T - 6, title, { fill: 'var(--dim)' });
  for (const [v, name] of rules) {
    root.append(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: 'var(--dim)', 'stroke-width': 1, 'stroke-dasharray': '4 3' }));
    text(W - R, y(v) - 4, name, { 'text-anchor': 'end', fill: 'var(--dim)' });
  }
  root.append(svg('path', {
    d: points.map((p, i) => `${i ? 'L' : 'M'}${x(p.f).toFixed(1)},${y(p[key]).toFixed(1)}`).join(''),
    fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, 'stroke-linejoin': 'round',
  }));
  // A hover target per frequency, wider than the line.
  for (const p of points) {
    const hit = svg('rect', { x: x(p.f) - 4, y: T, width: 8, height: H - T - B, fill: 'transparent' });
    const tip = svg('title');
    tip.textContent = `${hz(p.f)}: ${fmt(p.snrDb, 0)} dB above the noise, ${signed(p.gainDb, 0)} dB speaker to microphone`;
    hit.append(tip);
    root.append(hit);
  }
  return root;
}

function drawRange(r) {
  const top = Math.max(60, Math.ceil(Math.max(...r.points.map((p) => p.snrDb)) / 20) * 20);
  const floor = Math.min(-60, Math.floor(Math.min(...r.points.map((p) => p.gainDb)) / 20) * 20);
  $('#sweepchart').replaceChildren(
    drawSweep(r.points, 'snrDb', 'dB above the room\'s noise', [[CARRIES_DB, 'carries well'], [USABLE_DB, 'usable']], 0, top),
    drawSweep(r.points, 'gainDb', 'dB speaker to microphone',
      [[r.typicalDb, 'typical'], [r.typicalDb - FLAT_DB, 'carries well'], [r.typicalDb - USABLE_FLAT_DB, 'usable']], floor, 0));
}

$('#sweep').addEventListener('click', async () => {
  $('#sweep').disabled = true;
  $('#measure').disabled = true;
  $('#sweepstate').textContent = 'playing…';
  $('#sweepstate').className = 'pill live';
  try {
    const { rec, fs, label, plan } = await playAndRecord((fs) => {
      const plan = sweepPlan(fs);
      return { plan, signal: sweepSignal(fs, plan), seconds: plan.seconds };
    });
    const r = analyseSweep(rec, fs, plan);
    const span = (x) => (x ? `${hz(x.low)} to ${hz(x.high)}` : 'nowhere');
    $('#sweepresult').innerHTML = `Carries well (${CARRIES_DB} dB or more above the room's noise, and within `
      + `${FLAT_DB} dB of this device's typical ${fmt(r.typicalDb, 0)} dB) from <b>${span(r.carries)}</b>; `
      + `usable (${USABLE_DB} dB, within ${USABLE_FLAT_DB} dB) from <b>${span(r.usable)}</b>. `
      + `Measured at ${fs} Hz, ${(r.latency * 1000).toFixed(0)} ms speaker to microphone. Hover the line for each frequency.`;
    drawRange(r);
    table($('#sweeptable'), ['Frequency', 'Speaker to microphone', 'Above the room\'s noise'],
      r.points.map((p) => [hz(p.f), `${signed(p.gainDb, 0)} dB`, `${fmt(p.snrDb, 0)} dB`]));
    $('#sweepdetails').hidden = false;
    $('#sweepstate').textContent = `measured through ${label}`;
    $('#sweepstate').className = 'pill ok';
    window.tincanSweep = { fs, label, ...r };
  } catch (err) {
    $('#sweepstate').textContent = `failed: ${err.message || err}`;
    $('#sweepstate').className = 'pill bad';
  } finally {
    $('#sweep').disabled = false;
    $('#measure').disabled = false;
  }
});

/* ------------------------------------------------------------------ */
/* testing the bands with other devices — Part 2 §9                    */
/* ------------------------------------------------------------------ */

// Made here rather than in the page, so a cached page still gets them.
function panelAfterSweep(id) {
  let node = $(`#${id}`);
  if (!node) {
    node = el('div', { class: 'panel', id });
    const after = $('#bandtest') || $('#busjoin') || $('#sweep').closest('.panel');
    after.after(node);
  }
  return node;
}

const join = {
  root: panelAfterSweep('busjoin'),
  callsign: el('input', { type: 'text', maxlength: 6, placeholder: 'up to 6 characters' }),
  address: el('input', { type: 'number', min: 1, max: 30, value: 1 + Math.floor(Math.random() * 30) }),
  band: el('select', {}, KEYS.map((b) => el('option', { value: b }, `${BANDS[b].name} — ${BANDS[b].fR}/${BANDS[b].fD} Hz`))),
  profile: el('select', {}, Object.keys(PROFILES).map((p) => el('option', { value: p }, p))),
  start: el('button', { class: 'primary' }, 'Join the bus'),
  stop: el('button', { disabled: true }, 'Leave'),
  state: el('span', { class: 'pill' }, 'offline'),
  log: el('div', { class: 'log', style: 'max-height:10rem;margin-top:.6rem' }),
  modem: null,
  session: null,
};
join.profile.value = 'T25';
join.band.addEventListener('change', () => fitProfiles(join.profile, join.band.value));
join.root.replaceChildren(
  el('div', { class: 'row', style: 'margin-bottom:.6rem' },
    el('h2', { style: 'margin:0' }, 'Test them with other devices'), el('span', { class: 'spacer' }), join.state),
  el('p', {
    class: 'note', style: 'margin-top:0',
    html: 'The measurements above are of this device hearing itself. To learn which bands carry between this device '
      + 'and others, join the bus they are on — the same band and bit timing as their '
      + '<a href="../console/">Consoles</a> — then request a band test, or take part in one they request.',
  }),
  el('label', { class: 'field' }, el('span', {}, 'Callsign'), join.callsign),
  el('label', { class: 'field' }, el('span', {}, 'Address'), join.address),
  el('label', { class: 'field' }, el('span', {}, 'Band'), join.band),
  el('label', { class: 'field' }, el('span', {}, 'Bit timing'), join.profile),
  el('div', { class: 'row' }, join.start, join.stop),
  join.log,
);
const joinLog = new LogView(join.log, { limit: 200 });
const bandTest = new BandTestPanel(panelAfterSweep('bandtest'), { log: (html, kind) => joinLog.add(html, kind) });

function setJoined(live, text, cls = '') {
  join.start.disabled = live;
  join.stop.disabled = !live;
  for (const c of [join.callsign, join.address, join.band, join.profile]) c.disabled = live;
  join.state.textContent = text;
  join.state.className = `pill ${cls}`;
}

join.start.addEventListener('click', async () => {
  join.start.disabled = true;
  try {
    const m = new Modem({ band: join.band.value, profile: join.profile.value, name: join.callsign.value || 'bands' });
    join.modem = m;
    await m.start();
    const label = m.diagnostics().input?.label;
    const lat = label && measuredLatency(label);
    if (lat) m.measuredLatencyMs = lat.ms;
    const s = new Session({ on: (ev, fn) => m.on(ev, (e) => fn(e.detail)), send: (f) => m.send(f) },
      { address: Number(join.address.value) || 1, callsign: join.callsign.value });
    join.session = s;
    s.on('presence', ({ address, announce }) => {
      if (!announce.leaving) joinLog.add(`heard ${escapeHtml(announce.callsign || `node ${address}`)} (node ${address})`);
    });
    m.on('error-frame', (e) => joinLog.add(`${escapeHtml(e.detail.kind)} error on the bus`, 'err'));
    bandTest.attach({ modem: m, session: s, profile: join.profile.value });
    s.announce();
    setJoined(true, `on band ${join.band.value} at ${join.profile.value}`, 'live');
    joinLog.add(`joined as node ${s.address}`);
  } catch (err) {
    joinLog.add(`could not join: ${escapeHtml(err.message || err)}`, 'err');
    if (join.modem) await join.modem.stop().catch(() => {});
    join.modem = join.session = null;
    setJoined(false, 'failed', 'bad');
  }
});

join.stop.addEventListener('click', async () => {
  bandTest.detach();
  if (join.modem) await join.modem.stop();
  join.modem = join.session = null;
  setJoined(false, 'offline');
});

