/**
 * TinCAN Rig — one device of the test rig (spec/rig.md).
 *
 * The page joins the rig server once, then runs the descriptions it is sent:
 * it renders their play actions into one signal scheduled on the shared
 * clock, records its microphone, summarizes, measures latency and noise, and
 * can join the bus as a node. It executes descriptions, not code: everything
 * arrives as JSON through src/tincan/rig-dsl.js and is validated again here.
 */

import { Modem, checkSupport } from '../../src/tincan/modem.js';
import { bandFitsRate } from '../../src/tincan/params.js';
import { formatFrame } from '../../src/tincan/frame.js';
import { Session } from '../../src/tincan/transport.js';
import { BandTests, pairLevels } from '../../src/tincan/bandtest.js';
import {
  LIMITS, validate, expand, render, summarize, eachAction,
  latencyOf, noiseOf, chirpSignal,
} from '../../src/tincan/rig-dsl.js';
import { encodeWav } from '../selftest/probe.js';
import { modemAudio } from '../bandtest.js';
import { $, LogView, topbar, escapeHtml, fillMicrophones, reportHeader } from '../ui.js';

$('#chrome').replaceWith(topbar('Rig'));

const q = new URLSearchParams(location.search);
const NAME_KEY = 'tincan.rigname';

$('#server').value = q.get('server') ?? location.origin;
$('#code').value = q.get('code') ?? '';
$('#name').value = q.get('name') ?? (() => { try { return localStorage.getItem(NAME_KEY); } catch { return null; } })() ?? 'device';
$('#cap').addEventListener('input', () => { $('#capval').textContent = `${$('#cap').value}%`; });
fillMicrophones($('#mic'), $('#micadvice'));

const support = checkSupport();
if (!support.ok) {
  $('#support').innerHTML = `<b>This browser cannot be a rig device: ${escapeHtml(support.problems.join('; '))}.</b>`;
  $('#start').disabled = true;
}

const timeline = new LogView($('#timeline'), { limit: 2000 });
const say = (text, kind = '') => timeline.add(escapeHtml(text), kind);

const state = {
  server: '', token: null, device: null, runName: '',
  modem: null, session: null, bandTests: null,
  offset: 0, bestRtt: Infinity, clockSamples: [],
  runs: new Map(),           // description id -> run state
  analyser: null, wakeLock: null, syncTimer: null, lastLatencyMs: null,
};

const pill = (text, cls = '') => { $('#state').textContent = text; $('#state').className = `pill ${cls}`; };
const cap = () => Number($('#cap').value) / 100;
const serverNow = () => Date.now() + state.offset;
const audioTimeOf = (ms) => state.modem.ctx.currentTime + (ms - serverNow()) / 1000;
const atTime = (audioT) => new Promise((r) => setTimeout(r, Math.max(0, (audioT - state.modem.ctx.currentTime) * 1000)));

function updateDoing() {
  $('#doing').textContent = state.runs.size
    ? [...state.runs.values()].map((s) => s.label).join('; ')
    : 'idle';
}

/* ------------------------------------------------------------------ */
/* server calls                                                        */
/* ------------------------------------------------------------------ */

async function api(path, body, { raw } = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${state.server}${path}${state.token ? `${sep}token=${state.token}` : ''}`, {
    method: 'POST',
    headers: raw ? {} : { 'Content-Type': 'application/json' },
    body: raw ? body : JSON.stringify(body),
  });
  return r;
}

/** Log an event to the timeline and post it to the run's events.ndjson. */
function event(type, detail = {}, id = null) {
  say(`${id ? `${id} ` : ''}${type} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`,
    type === 'failed' || type === 'rejected' ? 'err' : '');
  if (state.token) {
    api('/api/event', { run: state.runName, id, type, detail, at: serverNow() }).catch(() => {});
  }
}

async function postResult(st, result) {
  if (st.posted) return;
  st.posted = true;
  try {
    await api('/api/result', { id: st.id, result });
  } catch (err) {
    say(`could not post the result for ${st.id}: ${err.message}`, 'err');
  }
  event('done', { actions: result.actions?.length ?? 0, errors: result.errors?.length ?? 0 }, st.id);
}

/* ------------------------------------------------------------------ */
/* clock sync — spec/rig.md §4                                         */
/* ------------------------------------------------------------------ */

async function ping() {
  const t0 = Date.now();
  const r = await fetch(`${state.server}/api/ping?token=${state.token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t0 }),
  });
  if (!r.ok) throw new Error(`ping ${r.status}`);
  const { t1 } = await r.json();
  const t2 = Date.now();
  return { rtt: t2 - t0, offset: t1 - (t0 + t2) / 2, at: t2 };
}

/** `n` pings; adopt the lowest-RTT sample unless it is much worse than the best seen. */
async function syncClock(n) {
  try {
    let best = null;
    for (let k = 0; k < n; k++) {
      const s = await ping();
      state.clockSamples.push({ t: s.at, offset: s.offset });
      if (!best || s.rtt < best.rtt) best = s;
    }
    state.clockSamples = state.clockSamples.filter((s) => s.t >= Date.now() - 10 * 60 * 1000);
    if (state.bestRtt === Infinity || best.rtt <= 1.5 * state.bestRtt) {
      if (Math.abs(best.offset - state.offset) > 2 || Math.abs(best.rtt - state.bestRtt) > 2) {
        $('#clock').textContent = `clock offset ${best.offset.toFixed(1)} ms · rtt ${best.rtt.toFixed(1)} ms`;
      }
      state.offset = best.offset;
      state.bestRtt = Math.min(state.bestRtt, best.rtt);
    }
  } catch { /* the server went away; the event stream will say so too */ }
}

/** Offset drift, ms per minute, from a linear fit of the last 10 minutes. */
function clockDrift() {
  const s = state.clockSamples;
  if (s.length < 3) return null;
  const mx = s.reduce((a, p) => a + p.t, 0) / s.length;
  const my = s.reduce((a, p) => a + p.offset, 0) / s.length;
  let sxy = 0, sxx = 0;
  for (const p of s) { sxy += (p.t - mx) * (p.offset - my); sxx += (p.t - mx) ** 2; }
  return sxx ? (sxy / sxx) * 60000 : null;
}

/* ------------------------------------------------------------------ */
/* the modem: listener by default, node while joined                   */
/* ------------------------------------------------------------------ */

function watchModem(m) {
  m.on('frame', (e) => event('frame', { text: formatFrame(e.detail.frame) }));
  m.on('error-frame', (e) => event('warning', { kind: e.detail.kind, detail: e.detail.detail || '' }));
  for (const ev of ['input-lost', 'input-dropped', 'stalled']) m.on(ev, (e) => event(ev, { ...e.detail }));
  m.on('warning', (e) => { for (const w of e.detail.warnings) event('warning', { text: w }); });
  m.on('audio-state', (e) => event('audio-state', e.detail));
}

function attachMeter(m) {
  if (!m.ctx || !m.source) return;
  const an = m.ctx.createAnalyser();
  an.fftSize = 2048;
  m.source.connect(an);
  state.analyser = an;
}

/** Stop whatever modem runs and restart the quiet listener. */
async function startListener() {
  if (state.modem) await state.modem.stop().catch(() => {});
  const m = new Modem({
    mode: 'listener', band: 'A', profile: 'T25',
    name: $('#name').value || 'device', deviceId: $('#mic').value,
  });
  watchModem(m);
  await m.start();
  state.modem = m;
  state.session = null;
  state.bandTests = null;
  window.rig = { state, modem: m };
  attachMeter(m);
  return m;
}

/** A microphone RMS bar, redrawn while the page is up. */
const meterData = new Float32Array(2048);
function meterLoop() {
  requestAnimationFrame(meterLoop);
  const canvas = $('#meter');
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx || !state.analyser) return;
  state.analyser.getFloatTimeDomainData(meterData);
  let sum = 0;
  for (const v of meterData) sum += v * v;
  const rms = Math.sqrt(sum / meterData.length);
  const frac = Math.max(0, Math.min(1, (60 + 20 * Math.log10(Math.max(rms, 1e-6))) / 60));
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#2a3550';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#5aa469';
  ctx.fillRect(0, 0, w * frac, h);
}
requestAnimationFrame(meterLoop);

/* ------------------------------------------------------------------ */
/* node actions                                                        */
/* ------------------------------------------------------------------ */

async function joinNode(a) {
  await state.modem.stop();
  const m = new Modem({
    mode: 'node', band: a.band, profile: a.profile,
    amplitude: a.level ?? 0.25,
    name: a.callsign ?? ($('#name').value || 'device'), deviceId: $('#mic').value,
    thetaD: a.thetaD, kappa: a.kappa,
  });
  watchModem(m);
  await m.start();
  state.modem = m;
  window.rig.modem = m;
  attachMeter(m);
  const session = new Session(
    { on: (ev, fn) => m.on(ev, (e) => fn(e.detail)), send: (f) => m.send(f) },
    { address: a.address, callsign: a.callsign ?? '' });
  state.session = session;
  state.bandTests = new BandTests(session, modemAudio(m), {
    canRun: (b) => bandFitsRate(b, m.ctx.sampleRate),
    latencyMs: () => state.lastLatencyMs ?? 0,
  });
  session.announce();
}

/** Queue `a.frame` and wait for its outcome until `deadline` (audio time + 2 s). */
function sendFrame(a, deadline) {
  return new Promise((resolve) => {
    const m = state.modem;
    if (!m?.node) { resolve({ queued: false, error: 'no node joined' }); return; }
    const id = a.frame.id;
    const done = (r) => { off1(); off2(); clearTimeout(timer); resolve(r); };
    const off1 = m.on('tx-complete', (e) => { if (e.detail.frame.id === id) done({ queued: true, delivered: true }); });
    const off2 = m.on('tx-failed', (e) => { if (e.detail.frame.id === id) done({ queued: true, delivered: false, kind: e.detail.kind }); });
    const timer = setTimeout(() => done({ queued: true, delivered: null, note: 'no outcome heard' }),
      Math.max(0, (deadline - m.ctx.currentTime) * 1000) + 2000);
    timer.unref?.();
    m.send({ id: a.frame.id, data: a.frame.data, extended: a.frame.extended, rtr: a.frame.rtr });
  });
}

function bandSummary(t) {
  const out = { test: t.test, requester: t.requester, bands: t.bands, players: t.players, pairs: [] };
  for (const tx of t.players) {
    for (const rx of state.bandTests.listeners(t)) {
      if (tx === rx) continue;
      for (const band of t.bands) {
        const p = pairLevels(t.results, tx, rx, band);
        out.pairs.push({ from: tx, to: rx, band, ...(p && { snrDb: +p.snrDb.toFixed(1), tiltDb: +p.tiltDb.toFixed(1) }) });
      }
    }
  }
  return out;
}

function runBandTest(a) {
  return new Promise((resolve) => {
    if (!state.bandTests) { resolve({ error: 'no node joined' }); return; }
    const t = state.bandTests.request({ bands: a.bands, window: a.window });
    const off = state.bandTests.on('done', ({ test }) => {
      if (test !== t) return;
      clearTimeout(timer); off(); resolve(bandSummary(t));
    });
    const timer = setTimeout(() => { off(); resolve({ error: 'the band test did not finish in 10 min' }); }, 600000);
    timer.unref?.();
  });
}

/* ------------------------------------------------------------------ */
/* running a description                                               */
/* ------------------------------------------------------------------ */

async function runDescription({ run, id, description }) {
  const st = { id, entries: [], errors: [], tasks: [], posted: false, stopped: false, label: id };
  state.runs.set(id, st);
  const v = validate(description);
  if (!v.ok) {
    event('rejected', { errors: v.errors }, id);
    await postResult(st, { at: description.at, actions: [], errors: v.errors });
    state.runs.delete(id); updateDoing();
    return;
  }
  const desc = expand(v.desc);
  const fs = state.modem.ctx.sampleRate;
  let rendered;
  try {
    rendered = render(desc, fs, { cap: cap() });
  } catch (err) {
    event('failed', { error: err.message }, id);
    await postResult(st, { at: desc.at, actions: [], errors: [err.message] });
    state.runs.delete(id); updateDoing();
    return;
  }
  const { signal, seconds, clipped } = rendered;
  if (clipped) event('clipped', { cap: cap() }, id);
  const ctx = state.modem.ctx;
  const at = audioTimeOf(desc.at);
  const inMs = (at - ctx.currentTime) * 1000;
  event('scheduled', { at: desc.at, inMs: Math.round(inMs * 10) / 10 }, id);
  if (inMs < 50) event('late', { ms: Math.round(Math.max(0, -inMs) * 10) / 10 }, id);
  if (signal.some((x) => x !== 0)) {
    state.modem.playAt(signal, at);
    event('playing', { seconds }, id);
  }
  state.modem.hold(at + seconds);
  const deadline = at + seconds;

  const acts = [];
  eachAction(desc, (a, t, i) => acts.push({ a, t, i }));
  const reps = new Map();
  const recSecs = acts.filter((x) => x.a.do === 'record').reduce((s, x) => s + x.a.seconds, 0);
  st.label = `${id}:${signal.some((x) => x !== 0) ? ` playing ${seconds.toFixed(1)} s` : ''}${recSecs ? `, recording ${recSecs} s` : ''}`;
  updateDoing();

  for (const { a, t, i } of acts) {
    const rep = reps.get(i) ?? 0;
    reps.set(i, rep + 1);
    if (a.do === 'record') {
      // A node join swaps the modem out and takes the pending recording with
      // it; bound the wait so the result still posts.
      const recording = Promise.race([
        state.modem.recordAt(at + t, Math.round(a.seconds * fs)),
        new Promise((_, fail) => setTimeout(() => fail(new Error('the recording never arrived')),
          Math.max(0, (at + t + a.seconds - state.modem.ctx.currentTime) * 1000) + 5000)),
      ]);
      st.tasks.push(recording.then(async (rec) => {
        event('recorded', { index: i, seconds: a.seconds }, id);
        if (a.measure === 'latency') {
          const chirpAction = acts.find((x) => x.a.do === 'chirp' && x.a.measure === 'latency' && x.a.index === a.index)?.a;
          const m = latencyOf(rec, fs, chirpSignal(chirpAction, fs));
          state.lastLatencyMs = m.ms;
          st.entries.push({ index: i, do: 'measure', what: 'latency', ms: m.ms, peak: m.peak });
        } else if (a.measure === 'noise') {
          st.entries.push({ index: i, do: 'measure', what: 'noise', ...noiseOf(rec, fs) });
        } else {
          st.entries.push({ index: i, do: 'record', t, ...summarize(a, rec, fs) });
          if ((a.return ?? []).includes('wav')) {
            await api(`/api/wav?id=${id}&name=rec${i}${rep ? `-${rep}` : ''}`, encodeWav(rec, fs), { raw: true });
          }
        }
      }).catch((err) => st.errors.push(`actions[${i}]: ${err.message}`)));
    } else if (a.do === 'measure') {
      st.tasks.push(atTime(at + t).then(() => {
        if (a.what === 'clock') {
          st.entries.push({
            index: i, do: 'measure', what: 'clock',
            offsetMs: state.offset, rttMs: state.bestRtt === Infinity ? null : state.bestRtt,
            samples: state.clockSamples.length, driftMsPerMin: clockDrift(),
          });
        } else if (a.what === 'audio') {
          st.entries.push({
            index: i, do: 'measure', what: 'audio', ...state.modem.diagnostics(),
            outputLatency: state.modem.ctx.outputLatency ?? null,
            baseLatency: state.modem.ctx.baseLatency ?? null,
            sampleRate: state.modem.ctx.sampleRate,
          });
        }
      }).catch((err) => st.errors.push(`actions[${i}]: ${err.message}`)));
    } else if (a.do === 'node') {
      st.tasks.push(atTime(at + t).then(async () => {
        try {
          if (a.op === 'join') {
            await joinNode(a);
            st.entries.push({ index: i, do: 'node', op: 'join', ok: true, sampleRate: state.modem.ctx.sampleRate });
          } else if (a.op === 'send') {
            st.entries.push({ index: i, do: 'node', op: 'send', ...await sendFrame(a, deadline) });
          } else if (a.op === 'stats') {
            st.entries.push({
              index: i, do: 'node', op: 'stats',
              stats: state.modem.status?.stats ?? null, state: state.modem.status?.state ?? null,
              warnings: state.modem.warnings ?? [],
            });
          } else if (a.op === 'bandtest') {
            st.entries.push({ index: i, do: 'node', op: 'bandtest', ...await runBandTest(a) });
          } else if (a.op === 'leave') {
            await startListener();
            st.entries.push({ index: i, do: 'node', op: 'leave', ok: true });
          }
        } catch (err) {
          st.entries.push({ index: i, do: 'node', op: a.op, ok: false, error: err.message });
        }
      }).catch((err) => st.errors.push(`actions[${i}]: ${err.message}`)));
    }
    // play actions and the chirps that measures expand into produce no entry
  }

  await Promise.allSettled(st.tasks);
  st.entries.sort((x, y) => x.index - y.index);
  await postResult(st, { at: desc.at, actions: st.entries, errors: st.errors });
  state.runs.delete(id);
  updateDoing();
}

/** Stop button or the server's `stop`: silence, and restart as the listener. */
async function stopRun(reason) {
  event('stopped', { reason });
  pill('stopped', 'warn');
  for (const st of state.runs.values()) {
    st.stopped = true;
    await postResult(st, { at: null, actions: st.entries, errors: ['stopped'] });
  }
  await startListener();
  pill('joined', 'ok');
  updateDoing();
}

/* ------------------------------------------------------------------ */
/* start                                                               */
/* ------------------------------------------------------------------ */

$('#start').addEventListener('click', async () => {
  $('#start').disabled = true;
  pill('joining', 'live');
  state.server = $('#server').value.replace(/\/+$/, '');
  const name = $('#name').value || 'device';
  try { localStorage.setItem(NAME_KEY, name); } catch { /* not remembered */ }

  try {
    await startListener();
  } catch (err) {
    say(`could not start audio: ${err.message}`, 'err');
    pill('offline');
    $('#start').disabled = false;
    return;
  }

  if (typeof navigator.wakeLock?.request === 'function') {
    const ask = () => navigator.wakeLock.request('screen')
      .then((w) => { state.wakeLock = w; }).catch(() => {});
    ask();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !state.wakeLock) ask();
    });
  }

  let j;
  try {
    const r = await fetch(`${state.server}/api/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: $('#code').value, name,
        info: { ...reportHeader(), audio: state.modem.diagnostics(), cap: cap() },
      }),
    });
    if (r.status === 401) {
      say('wrong join code', 'err');
      pill('offline');
      $('#start').disabled = false;
      return;
    }
    j = await r.json();
  } catch (err) {
    say(`cannot reach ${state.server}: ${err.message}`, 'err');
    pill('offline');
    $('#start').disabled = false;
    return;
  }
  state.token = j.token;
  state.device = j.device;
  state.runName = j.run;
  $('#who').textContent = `${j.device} · run ${j.run}`;
  event('started', { device: j.device });

  await syncClock(8);
  state.syncTimer = setInterval(() => syncClock(4), 10000);
  state.syncTimer.unref?.();

  if (typeof EventSource === 'undefined') {
    say('this browser has no EventSource; it cannot take descriptions', 'err');
    return;
  }
  const es = new EventSource(`${state.server}/api/events?token=${state.token}`);
  state.es = es;
  es.addEventListener('hello', (e) => {
    const d = JSON.parse(e.data);
    state.runName = d.run;
    $('#who').textContent = `${state.device} · run ${d.run}`;
    pill('joined', 'ok');
  });
  es.addEventListener('description', (e) => {
    const d = JSON.parse(e.data);
    event('description-received', { id: d.id }, d.id);
    runDescription(d).catch((err) => say(`${d.id}: ${err.message}`, 'err'));
  });
  es.addEventListener('stop', () => stopRun('stopped by the server'));
  es.addEventListener('error', () => say('event stream error; the browser reconnects itself', 'warnrow'));
  $('#stop').disabled = false;
});

$('#stop').addEventListener('click', () => stopRun('stopped by hand'));

// ?auto=1 joins without a click: the flags of step 5 make that work.
if (q.get('auto')) $('#start').click();
