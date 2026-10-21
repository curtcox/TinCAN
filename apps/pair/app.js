/**
 * TinCAN Pair Test — two nodes in one tab negotiate, use and close a side
 * link (Part 2 §8), with every step checked. The side-link handling is the
 * Console's own (../sidelink.js); bob judges the proposal with the same
 * assessProposal the Console uses.
 */

import { Modem, checkSupport } from '../../src/tincan/modem.js';
import { BANDS, PROFILES, timing, longestRangeProfile, bandsCompatible } from '../../src/tincan/params.js';
import { formatFrame } from '../../src/tincan/frame.js';
import {
  Session, describeControl, parseBaseId, TOPIC, assessProposal, DECLINE_TEXT, CLOSE_TEXT,
} from '../../src/tincan/transport.js';
import { $, el, LogView, topbar, escapeHtml, download, reportHeader, reportName } from '../ui.js';
import { LinkEnd } from '../sidelink.js';

$('#chrome').replaceWith(topbar('Pair test'));

/** The run in progress or last finished: its checks, timeline and nodes. */
let run = null;

/* ---------------------------------------------------------------- */
/* settings                                                          */
/* ---------------------------------------------------------------- */

for (const [sel, value] of [['#band', 'B'], ['#linkband', 'D']]) {
  $(sel).replaceChildren(...Object.entries(BANDS).map(([k, b]) => el('option', { value: k }, `${b.name} — ${b.fR}/${b.fD} Hz`)));
  $(sel).value = value;
}
for (const [sel, value] of [['#profile', longestRangeProfile()], ['#linkprofile', 'T5']]) {
  $(sel).replaceChildren(...Object.keys(PROFILES).map((k) => el('option', { value: k }, `${k} — ${Math.round(timing(k).bitRate)} bit/s`)));
  $(sel).value = value;
}
$('#amp').addEventListener('input', () => { $('#ampval').textContent = `${$('#amp').value}%`; });

/** Bits in a frame of `octets`, with a little stuffing. */
const frameSeconds = (profile, octets) => (59 + 8 * octets) * 1.1 * timing(profile).bitTime;

/** A generous bound on the whole run: two announces, propose, accept, close, plus the link's own. */
function budgetSeconds() {
  const main = run?.settings.profile ?? $('#profile').value, link = run?.settings.linkProfile ?? $('#linkprofile').value;
  return 2 * (2 * frameSeconds(main, 5) + 3 * frameSeconds(main, 6)) + 2 * (2 * frameSeconds(link, 5) + 2 * frameSeconds(link, 8)) + 30;
}

function describePlan() {
  const main = $('#profile').value, link = $('#linkprofile').value;
  if (!PROFILES[main] || !PROFILES[link] || !BANDS[$('#band').value] || !BANDS[$('#linkband').value]) return;
  const ok = bandsCompatible($('#band').value, main, $('#linkband').value, link);
  $('#plan').innerHTML = `About ${Math.round(budgetSeconds() / 2 / 60)}–${Math.ceil(budgetSeconds() / 60)} minutes. `
    + `${['A', 'C', 'D'].includes($('#band').value) || ['A', 'C', 'D'].includes($('#linkband').value) ? '<b>Some of it is audible.</b> ' : ''}`
    + (ok ? '' : '<b>These two can not share a device (Part 2 §8.2): bob will decline.</b>');
}
for (const s of ['#band', '#profile', '#linkband', '#linkprofile']) $(s).addEventListener('change', describePlan);
describePlan();

const support = checkSupport();
if (!support.ok) {
  $('#plan').innerHTML = `<b>This browser cannot run a node: ${escapeHtml(support.problems.join('; '))}.</b>`;
  $('#start').disabled = true;
}

/* ---------------------------------------------------------------- */
/* checks and timeline                                               */
/* ---------------------------------------------------------------- */

const CHECKS = [
  ['joined', 'both nodes joined the main bus'],
  ['ada-heard-bob', 'ada heard bob announce on the main bus'],
  ['bob-heard-ada', 'bob heard ada announce on the main bus'],
  ['proposal', 'bob received ada\'s proposal'],
  ['accepted', 'bob judged the proposal and accepted it'],
  ['acceptance', 'ada received the acceptance and opened her end'],
  ['bob-up', 'bob heard ada on the link'],
  ['ada-up', 'ada heard bob on the link'],
  ['to-bob', '"hello bob" crossed the link'],
  ['to-ada', '"hello ada" crossed the link'],
  ['closed', 'the link closed at both ends'],
  ['clean', 'no errors on any of the four nodes'],
];

const checkView = $('#checks');
const timeline = new LogView($('#timeline'), { limit: 2000 });

function renderChecks() {
  checkView.replaceChildren(...CHECKS.map(([key, text]) => {
    const c = run?.checks[key];
    const mark = !c ? '·' : c.ok ? '✓' : '✗';
    const kind = c && !c.ok ? 'err' : '';
    return el('div', { class: `entry ${kind}` },
      el('span', { class: 't' }, c ? `${c.at.toFixed(1)} s` : ''),
      el('span', { class: 'body' }, `${mark} ${text}${c?.detail ? ` — ${c.detail}` : ''}`));
  }));
}
renderChecks();

const now = () => (performance.now() - run.t0) / 1000;

function check(key, ok = true, detail = '') {
  if (!run || run.checks[key]) return;
  run.checks[key] = { ok, at: now(), detail };
  log('check', `${ok ? '✓' : '✗'} ${CHECKS.find(([k]) => k === key)[1]}${detail ? ` — ${detail}` : ''}`, ok ? 'tx' : 'err');
  renderChecks();
  if (!ok) finish(false, CHECKS.find(([k]) => k === key)[1]);
}

function log(who, text, kind = '') {
  if (!run) return;
  run.timeline.push({ t: +now().toFixed(2), who, text });
  timeline.add(`<span class="muted">${now().toFixed(1)} s</span> <b>${escapeHtml(who)}</b> ${escapeHtml(text)}`, kind);
}

function renderCounters() {
  const rows = [];
  for (const [name, n] of Object.entries(run?.nodes || {})) {
    for (const [bus, m] of [['main', n.modem], ['link', n.link?.modem]]) {
      const s = m?.status?.stats;
      rows.push([`${name} · ${bus}`, s ? s.framesSent : '—', s ? s.framesReceived ?? '—' : '—',
        s ? s.bitErrors + s.stuffErrors + s.crcErrors + s.formErrors + s.ackErrors : '—']);
    }
  }
  $('#counters').replaceChildren(
    el('thead', {}, el('tr', {}, ['Node', 'Sent', 'Received', 'Errors'].map((h) => el('th', {}, h)))),
    el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c) => el('td', {}, String(c)))))));
}

/* ---------------------------------------------------------------- */
/* the run                                                           */
/* ---------------------------------------------------------------- */

function watch(name, bus, m) {
  m.on('tx-start', (e) => log(`${name} ${bus}`, `→ ${formatFrame(e.detail.frame)}${e.detail.attempt > 1 ? ` (attempt ${e.detail.attempt})` : ''}`));
  m.on('tx-complete', (e) => log(`${name} ${bus}`, `✓ delivered ${formatFrame(e.detail.frame)}`, 'tx'));
  m.on('frame', (e) => {
    const f = e.detail.frame;
    const control = !f.extended && parseBaseId(f.id).topic === TOPIC.CONTROL ? describeControl(f.data) : null;
    log(`${name} ${bus}`, `← ${formatFrame(f)}${control ? ` — ${control}` : ''}`);
  });
  m.on('error-frame', (e) => log(`${name} ${bus}`, `${e.detail.kind} error: ${e.detail.detail || ''}`, 'err'));
  m.on('arbitration-lost', (e) => log(`${name} ${bus}`, `lost arbitration at bit ${e.detail.bit}`, 'warnrow'));
  m.on('input-gap', (e) => log(`${name} ${bus}`, `browser inserted ${e.detail.ms.toFixed(0)} ms of silence into the input`, 'warnrow'));
  m.on('input-lost', (e) => log(`${name} ${bus}`, `audio thread stalled ${e.detail.ms.toFixed(0)} ms`, 'warnrow'));
  m.on('warning', (e) => { for (const w of e.detail.warnings) log(`${name} ${bus}`, w, 'warnrow'); });
  m.on('status', () => renderCounters());
}

async function startNode(name, address) {
  const m = new Modem({
    band: $('#band').value, profile: $('#profile').value, mode: 'node',
    amplitude: Number($('#amp').value) / 100, name,
  });
  watch(name, 'main', m);
  await m.start();
  const session = new Session({ on: (ev, fn) => m.on(ev, (e) => fn(e.detail)), send: (f) => m.send(f) },
    { address, callsign: name });
  const node = { name, address, modem: m, session, link: null };
  session.on('link-open', ({ link: rec }) => openEnd(node, rec));
  session.on('link-closed', ({ link: rec, reason, by }) => {
    log(`${name} main`, `link #${rec.link} closed by ${by}: ${CLOSE_TEXT[reason] ?? reason}`);
    node.link?.stop('closed');
  });
  return node;
}

async function openEnd(node, rec) {
  if (node.link) return;
  if (node.name === 'ada') check('acceptance');
  const end = new LinkEnd({
    rec, session: node.session, modem: node.modem,
    modemOptions: { amplitude: Number($('#amp').value) / 100 },
  });
  node.link = end;
  end.on('modem', ({ modem }) => watch(node.name, 'link', modem));
  end.on('log', ({ text, kind }) => log(`${node.name} link`, text, kind));
  end.on('up', () => {
    check(`${node.name}-up`);
    const { ada, bob } = run.nodes;
    if (ada.link?.up && bob.link?.up) {
      log('ada link', 'sending "hello bob"');
      ada.link.sendText('hello bob');
    }
  });
  end.on('message', ({ text }) => {
    if (node.name === 'bob' && text === 'hello bob') {
      check('to-bob');
      log('bob link', 'sending "hello ada"');
      run.nodes.bob.link.sendText('hello ada');
    } else if (node.name === 'ada' && text === 'hello ada') {
      check('to-ada');
      log('ada link', 'closing the link');
      run.nodes.ada.link.close();
    }
  });
  end.on('ended', ({ reason }) => {
    log(`${node.name} link`, `ended: ${reason}`);
    if (!run) return;
    const { ada, bob } = run.nodes;
    if (!run.checks['to-ada']) { check('closed', false, `${node.name}'s end ended early (${reason})`); return; }
    if (ada.link?.ended && bob.link?.ended) {
      check('closed');
      finishClean();
    }
  });
  await end.open();
}

/** Wait for the last frames to leave, then judge the error counters. */
async function finishClean() {
  await new Promise((r) => setTimeout(r, 1500));
  if (!run) return;
  const errors = [];
  for (const n of Object.values(run.nodes)) {
    for (const [bus, m] of [['main', n.modem], ['link', n.link?.modem]]) {
      const s = m?.status?.stats;
      const e = s ? s.bitErrors + s.stuffErrors + s.crcErrors + s.formErrors + s.ackErrors : 0;
      if (e) errors.push(`${n.name} ${bus}: ${e}`);
    }
  }
  check('clean', errors.length === 0, errors.join(', '));
  if (errors.length === 0) finish(true);
}

$('#start').addEventListener('click', async () => {
  $('#start').disabled = true;
  $('#stop').disabled = false;
  timeline.clear();
  run = { t0: performance.now(), checks: {}, timeline: [], nodes: {}, settings: {
    band: $('#band').value, profile: $('#profile').value, linkBand: $('#linkband').value,
    linkProfile: $('#linkprofile').value, amplitude: Number($('#amp').value) / 100,
  } };
  renderChecks();
  setVerdict('running…', 'live');
  run.ticker = setInterval(() => {
    $('#elapsed').textContent = `${Math.floor(now() / 60)}:${String(Math.floor(now() % 60)).padStart(2, '0')}`;
    const pending = CHECKS.find(([k]) => !run.checks[k]);
    if (pending && now() > budgetSeconds()) check(pending[0], false, `not done in ${Math.round(budgetSeconds())} s`);
  }, 1000);
  try {
    const [ada, bob] = await Promise.all([startNode('ada', 3), startNode('bob', 12)]);
    if (!run) { ada.modem.stop(); bob.modem.stop(); return; }
    run.nodes = { ada, bob };
    check('joined');
    renderCounters();

    ada.session.on('presence', ({ address }) => { if (address === 12) check('ada-heard-bob'); });
    bob.session.on('presence', ({ address }) => { if (address === 3) check('bob-heard-ada'); });
    bob.session.on('link-proposal', ({ link: rec }) => {
      check('proposal');
      const reason = assessProposal(rec, {
        mainBand: run.settings.band, mainProfile: run.settings.profile, slopMs: null,
        bandsInUse: bob.session.bandsInUse(), canUseBand: (b) => b !== 'B' || bob.modem.ctx.sampleRate >= 44100,
      });
      if (reason) {
        bob.session.declineLink(rec, reason);
        check('accepted', false, `declined: ${DECLINE_TEXT[reason]}`);
      } else {
        bob.session.acceptLink(rec, null);
        check('accepted');
      }
    });
    ada.session.on('link-declined', ({ reason }) => log('ada main', `declined: ${DECLINE_TEXT[reason]}`, 'err'));

    ada.session.announce();
    bob.session.announce();
    const rec = ada.session.proposeLink({ to: 12, band: run.settings.linkBand, profile: run.settings.linkProfile });
    log('ada main', `proposed #${rec.link}: band ${rec.band}, ${rec.profile}`);
  } catch (err) {
    log('page', `could not start: ${err.message || err}`, 'err');
    finish(false, 'could not start the nodes');
  }
});

function setVerdict(text, kind) {
  $('#verdict').textContent = text;
  $('#verdict').className = `pill ${kind}`;
}

async function finish(ok, why = '') {
  if (!run || run.done) return;
  run.done = true;
  clearInterval(run.ticker);
  setVerdict(ok ? 'pass' : `fail: ${why}`, ok ? 'ok' : 'bad');
  log('page', ok ? 'every check passed' : `stopped: ${why}`, ok ? 'tx' : 'err');
  renderCounters();
  await stopAll();
}

async function stopAll() {
  const nodes = Object.values(run?.nodes || {});
  for (const n of nodes) {
    if (n.link) await n.link.stop('test over');
    await n.modem.stop().catch(() => {});
  }
  $('#start').disabled = false;
  $('#stop').disabled = true;
}

$('#stop').addEventListener('click', () => finish(false, 'stopped by hand'));

$('#report').addEventListener('click', () => {
  if (!run) return;
  const counters = {};
  for (const n of Object.values(run.nodes)) {
    counters[n.name] = { main: n.modem?.status?.stats ?? null, link: n.link?.modem?.status?.stats ?? null };
  }
  download(reportName('pair', 'json'), JSON.stringify({
    ...reportHeader(), settings: run.settings, checks: run.checks, counters, timeline: run.timeline,
  }, null, 1), 'application/json');
});
