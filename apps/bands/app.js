/**
 * TinCAN Bands — how the four bands compare in loudness, reach and capacity,
 * computed from the band plan and the standards in acoustics.js, plus a way
 * to hear and measure them on this device.
 */

import { BANDS, PROFILES, timing, maxRange, bandsCompatible } from '../../src/tincan/params.js';
import { CONTEXT_OPTIONS, audioConstraints } from '../../src/tincan/modem.js';
import { $, el, topbar, escapeHtml } from '../ui.js';
import { toneAmplitude, AMPLITUDE } from '../selftest/probe.js';
import { phon, hearingThreshold, aWeighting, airAbsorption, shannon } from './acoustics.js';

$('#chrome').replaceWith(topbar('Bands'));

const KEYS = Object.keys(BANDS);
const tones = (b) => [BANDS[b].fR, BANDS[b].fD];
const hz = (f) => (f >= 1000 ? `${(f / 1000).toFixed(f % 1000 ? 2 : 0)} kHz` : `${f} Hz`);
const fmt = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d));
const signed = (v, d = 1) => (v > 0 ? `+${v.toFixed(d)}` : v.toFixed(d));

/** Who hears a band, in words. Above ISO 226, from Wang et al. (2021). */
const HEARD_BY = {
  A: 'Everyone with normal hearing: 3–4 kHz is where the ear is most sensitive.',
  B: 'At 18 kHz, 78 % of 21–30 year olds, 20 % of 31–40, and almost nobody older. Those who hear it '
    + 'often find it shrill. Pets, especially dogs and cats, hear it easily.',
  C: 'Everyone with normal hearing; it sits in the range of speech.',
  D: 'Everyone with normal hearing, a little less keenly than A.',
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
const fastest = timing('T100').bitRate;

table($('#rates'),
  ['Profile', 'Bit rate', '8-octet frame', 'User data', 'Arbitration range', 'Same on every band'],
  Object.keys(PROFILES).map((p) => {
    const t = timing(p);
    return [
      `<code>${p}</code>`, `${fmt(t.bitRate, t.bitRate < 10 ? 0 : 0)} bit/s`, `${(FRAME_BITS / t.bitRate).toFixed(1)} s`,
      `${(8 * t.bitRate / FRAME_BITS).toFixed(2)} octet/s`, `~${maxRange(p).toFixed(1)} m`, '✓',
    ];
  }));

table($('#capacity'),
  ['Band', 'Slot', 'Could carry<br><span class="muted">Shannon, at 20 / 30 / 40 dB SNR</span>',
    'TinCAN at T100 uses', 'Can share a device with', 'Needs'],
  KEYS.map((b) => {
    const others = KEYS.filter((o) => o !== b).map((o) => {
      if (bandsCompatible(b, 'T25', o, 'T25')) return o;
      return bandsCompatible(b, 'T10', o, 'T10') ? `${o} <span class="muted">(T10 and slower)</span>` : null;
    }).filter(Boolean);
    const c30 = shannon(slotHz(b), 30);
    return [
      `<b>${escapeHtml(BANDS[b].name)}</b>`,
      `${hz(BANDS[b].guardLo)}–${hz(BANDS[b].guardHi)}`,
      [20, 30, 40].map((s) => `${(shannon(slotHz(b), s) / 1000).toFixed(0)}`).join(' / ') + ' kbit/s',
      `${(100 * fastest / c30).toFixed(2)} % <span class="muted">of it at 30 dB</span>`,
      others.join(', '),
      b === 'B' ? 'a sample rate of 44.1 kHz or more, and a speaker and microphone that reach 19 kHz'
        : b === 'D' ? 'nothing in principle; intended for a cable' : 'nothing special',
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
      if (BANDS[b].guardHi * 2 > ctx.sampleRate) {
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

$('#measure').addEventListener('click', async () => {
  $('#measure').disabled = true;
  $('#measurestate').textContent = 'playing…';
  $('#measurestate').className = 'pill live';
  let stream = null, ctx = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: await audioConstraints('') });
    ctx = new (window.AudioContext || window.webkitAudioContext)(CONTEXT_OPTIONS);
    if (ctx.state === 'suspended') await ctx.resume();
    const fs = ctx.sampleRate;
    const bands = KEYS.filter((b) => BANDS[b].guardHi * 2 <= fs);
    const plan = schedule(bands);
    await ctx.audioWorklet.addModule(new URL('../selftest/probe-worklet.js', import.meta.url));
    const probe = new AudioWorkletNode(ctx, 'tincan-probe', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { signal: measureSignal(fs, plan), recordSamples: Math.round(plan.seconds * fs) },
    });
    const done = new Promise((resolve) => { probe.port.onmessage = (e) => resolve(e.data.recording); });
    ctx.createMediaStreamSource(stream).connect(probe);
    probe.connect(ctx.destination);
    const rec = await done;
    const label = stream.getAudioTracks()[0]?.label || 'the default microphone';

    const rows = KEYS.map((b) => {
      if (!bands.includes(b)) {
        return [`<b>${escapeHtml(BANDS[b].name)}</b>`, '—', '—', '—', `not at ${fs} Hz`];
      }
      const cells = tones(b).map((f) => {
        const lvl = heardLevel(rec, fs, f, plan.tones.find(([bb, ff]) => bb === b && ff === f)[2]);
        const nse = noiseLevel(rec, fs, f);
        return { lvl, snr: 20 * Math.log10(Math.max(lvl, 1e-9) / Math.max(nse, 1e-9)) };
      });
      const worst = Math.min(...cells.map((c) => c.snr));
      const verdict = worst >= 30 ? 'carries well' : worst >= 15 ? 'usable, short range' : worst >= 6 ? 'barely' : 'not heard';
      return [
        `<b>${escapeHtml(BANDS[b].name)}</b>`,
        cells.map((c) => `${fmt(20 * Math.log10(Math.max(c.lvl, 1e-9)), 0)}`).join(' / ') + ' dBFS',
        cells.map((c) => `${signed(20 * Math.log10(Math.max(c.lvl, 1e-9) / AMPLITUDE), 0)}`).join(' / ') + ' dB',
        cells.map((c) => fmt(c.snr, 0)).join(' / ') + ' dB',
        verdict,
      ];
    });
    table($('#measured'), ['Band', 'Heard', 'Speaker to microphone', 'Above the room\'s noise', 'Here'], rows);
    $('#measurestate').textContent = `measured through ${label}`;
    $('#measurestate').className = 'pill ok';
  } catch (err) {
    $('#measurestate').textContent = `failed: ${err.message || err}`;
    $('#measurestate').className = 'pill bad';
  } finally {
    if (stream) for (const t of stream.getTracks()) t.stop();
    if (ctx) ctx.close();
    $('#measure').disabled = false;
  }
});
