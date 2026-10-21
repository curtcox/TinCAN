/** Small shared helpers for the TinCAN apps. No framework. */

import { DETECTOR_DEFAULTS } from '../src/tincan/params.js';
import { listMicrophones, wirelessMicReason, builtInMicrophone, CONTEXT_OPTIONS } from '../src/tincan/modem.js';
import { BUILD, describeBuild } from '../version.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const hex = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, '0');

export function hexBytes(bytes) {
  return Array.from(bytes || []).map((b) => hex(b)).join(' ');
}

export function asciiBytes(bytes) {
  return Array.from(bytes || [])
    .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·'))
    .join('');
}

export function parseHexBytes(text) {
  const cleaned = (text || '').replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
  if (cleaned.length % 2) throw new Error('hex payload must have an even number of digits');
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(cleaned.substr(i * 2, 2), 16);
  return out;
}

export function parseId(text) {
  const t = (text || '').trim();
  if (!t) return 0;
  const v = /^0x/i.test(t) ? parseInt(t.slice(2), 16) : parseInt(t, /^[0-9]+$/.test(t) ? 10 : 16);
  if (!Number.isFinite(v) || v < 0) throw new Error(`cannot read identifier "${text}"`);
  return v;
}

export function clock(t) {
  const s = Math.floor(t);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(Math.floor((t % 1) * 10))}`;
}

export function db(x) {
  if (!(x > 0)) return '−∞';
  return (10 * Math.log10(x)).toFixed(1);
}

/** A capped, auto-scrolling log list. */
export class LogView {
  constructor(node, { limit = 400 } = {}) {
    this.node = node;
    this.limit = limit;
    this.count = 0;
    this.empty = el('div', { class: 'empty' }, 'nothing yet');
    this.node.append(this.empty);
  }

  add(text, kind = '') {
    if (this.empty.isConnected) this.empty.remove();
    const stick = this.node.scrollTop + this.node.clientHeight >= this.node.scrollHeight - 24;
    this.node.append(el('div', { class: `entry ${kind}` },
      el('span', { class: 't' }, clock(performance.now() / 1000)),
      el('span', { class: 'body', html: text })));
    this.count++;
    while (this.node.children.length > this.limit) this.node.firstChild.remove();
    if (stick) this.node.scrollTop = this.node.scrollHeight;
  }

  clear() {
    this.node.replaceChildren(this.empty);
    this.count = 0;
  }
}

/** Shared top bar so the three apps and the spec pages agree with each other. */
export function topbar(current) {
  const links = [
    ['../../spec/tincan-1.0.html', 'Part 1'],
    ['../../spec/transport.html', 'Part 2'],
    ['../../spec/rationale.html', 'Rationale'],
    ['../snooper/', 'Snooper'],
    ['../console/', 'Console'],
    ['../simulator/', 'Simulator'],
    ['../selftest/', 'Self-test'],
    ['../pair/', 'Pair test'],
    ['../bands/', 'Bands'],
  ];
  return el('header', { class: 'topbar' },
    el('a', { class: 'brand', href: '../../', html: 'Tin<span>CAN</span>' }),
    el('nav', {}, links.map(([href, label]) =>
      el('a', { href, 'aria-current': label === current ? 'page' : null }, label))),
    versionBadge());
}

/**
 * Which build this page was loaded from, and whether it is still the one
 * deployed. Pages caches files for ten minutes, so a page can be older than
 * the site; the deployed version.json is fetched past the cache to tell.
 */
function versionBadge() {
  const v = describeBuild(BUILD);
  const badge = el('a', { class: 'version', href: v.url, title: v.title }, v.text);
  if (BUILD.commit) {
    fetch(new URL('../version.json', import.meta.url), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((live) => {
        if (!live?.commit || live.commit === BUILD.commit) return;
        badge.classList.add('stale');
        badge.textContent = `${v.short} — out of date: ${live.short} is deployed. Hold Shift and reload.`;
        badge.title = `${v.title}; deployed now: ${describeBuild(live).title}`;
      })
      .catch(() => {});
  }
  return badge;
}

/**
 * A microphone's own name, from a device label or a picker option: without
 * Chrome's "Default - " prefix or the picker's "system default (…)".
 */
export function micName(label) {
  const s = String(label || '');
  const m = /^system default \((.*)\)$/.exec(s);
  return (m ? m[1] : s).replace(/^default\s*[-–:]\s*/i, '').trim();
}

const LATENCY_KEY = 'tincan.latency';

/** Remember the speaker-to-microphone latency the self-test measured through `label`. */
export function saveMeasuredLatency(label, seconds) {
  try {
    const all = JSON.parse(localStorage.getItem(LATENCY_KEY) || '{}');
    all[micName(label)] = {
      ms: Math.round(seconds * 10000) / 10, at: new Date().toISOString(), build: BUILD.commit,
      latencyHint: CONTEXT_OPTIONS.latencyHint,
    };
    localStorage.setItem(LATENCY_KEY, JSON.stringify(all));
  } catch { /* not remembered */ }
}

/**
 * The latency measured through `label`, as { ms, at, build }, or null if never
 * measured, or measured with other audio buffers than a node now uses.
 */
export function measuredLatency(label) {
  try {
    const m = JSON.parse(localStorage.getItem(LATENCY_KEY) || '{}')[micName(label)];
    return m && m.latencyHint === CONTEXT_OPTIONS.latencyHint ? m : null;
  } catch { return null; }
}

/** What every downloaded report starts with, so it says which build made it. */
export function reportHeader() {
  return {
    generated: new Date().toISOString(),
    build: { ...BUILD, short: describeBuild(BUILD).short },
    page: location.href,
    userAgent: navigator.userAgent,
  };
}

/** `tincan-console-28bdab2-2026-10-20T19-05-28-163Z.json` */
export function reportName(kind, ext) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `tincan-${kind}-${describeBuild(BUILD).short}-${stamp}.${ext}`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function download(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------------ */
/* physical-layer views, shared by the Snooper and the Console         */
/* ------------------------------------------------------------------ */

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

/**
 * One column per bit time, newest on the right: colour is the level read,
 * height the dominant fraction, the dashed line theta_D. With `markTx`, a bit
 * this node sent and read back as something else gets a mark on top.
 */
export function drawBits(canvas, bits, { thetaD = DETECTOR_DEFAULTS.thetaD, markTx = false } = {}) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const n = Math.max(1, Math.floor(w / 3));
  const shown = bits.slice(-n);
  const bw = w / n;
  const top = markTx ? 6 : 0;

  const dom = cssVar('--dominant');
  const rec = cssVar('--recessive');
  const faint = cssVar('--faint');
  const line = cssVar('--line');
  const bad = cssVar('--bad');

  for (let i = 0; i < shown.length; i++) {
    const b = shown[i];
    const x = i * bw;
    const frac = Math.max(0.04, Math.min(1, b.ratio || 0));
    const bh = Math.max(2, frac * (h - 10 - top));
    ctx.fillStyle = !b.carrier ? faint : (b.level === 0 ? dom : rec);
    ctx.globalAlpha = b.carrier ? 1 : 0.35;
    ctx.fillRect(x, h - bh - 4, Math.max(1, bw - 0.6), bh);
    if (markTx && b.tx !== null && b.tx !== undefined && b.tx !== b.level) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = bad;
      ctx.fillRect(x, 0, Math.max(1, bw - 0.6), 4);
    }
  }
  ctx.globalAlpha = 1;

  const ty = h - 4 - thetaD * (h - 10 - top);
  ctx.strokeStyle = line;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(0, ty); ctx.lineTo(w, ty); ctx.stroke();
  ctx.setLineDash([]);
}

/** Bars for E_R, E_D and the noise floor, and the dominant fraction against theta_D. */
export function drawMeter(canvas, sig, { thetaD = DETECTOR_DEFAULTS.thetaD } = {}) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);

  const dom = cssVar('--dominant');
  const rec = cssVar('--recessive');
  const line = cssVar('--line');
  const dim = cssVar('--dim');

  const pad = 34;
  const barH = 16;
  const toX = (v) => pad + Math.max(0, Math.min(1, (60 + 10 * Math.log10(Math.max(v, 1e-12))) / 60)) * (w - pad - 8);

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

  const y = 8 + 3 * (barH + 8);
  const trackW = w - pad - 8;
  ctx.fillStyle = dim;
  ctx.fillText('E_D/Σ', 0, y + 10);
  ctx.fillStyle = line;
  ctx.fillRect(pad, y, trackW, 6);
  ctx.fillStyle = (sig.ratio || 0) >= thetaD ? dom : rec;
  ctx.fillRect(pad, y, Math.max(1, (sig.ratio || 0) * trackW), 6);
  ctx.fillStyle = dom;
  ctx.fillRect(pad + thetaD * trackW - 1, y - 3, 2, 12);
}

/* ------------------------------------------------------------------ */
/* microphone choice, shared by every page that captures                */
/* ------------------------------------------------------------------ */

const MIC_KEY = 'tincan.microphone';

function rememberedMic() {
  try { return localStorage.getItem(MIC_KEY) || ''; } catch { return ''; }
}

/**
 * Fill `select` with the browser's microphones, keeping the one last chosen
 * on any TinCAN page, and put advice in `advice` when the choice looks
 * wireless. Call again after the first capture, when the browser starts
 * telling us their names. Returns the chosen deviceId ('' = default).
 */
export async function fillMicrophones(select, advice = null) {
  let mics = [];
  try { mics = await listMicrophones(); } catch { /* none to list */ }
  const want = select.value || rememberedMic();
  // Chrome lists the system default separately, as "Default - <its name>".
  const def = mics.find((m) => m.deviceId === 'default');
  const defName = def ? def.label.replace(/^default\s*[-–:]\s*/i, '') : '';
  select.replaceChildren(el('option', { value: '' }, defName ? `system default (${defName})` : 'system default'),
    ...mics.filter((m) => m.deviceId && m.deviceId !== 'default')
      .map((m) => el('option', { value: m.deviceId }, m.label)));
  if ([...select.options].some((o) => o.value === want)) select.value = want;
  if (!select.dataset.wired) {
    select.dataset.wired = '1';
    select.addEventListener('change', () => {
      try { localStorage.setItem(MIC_KEY, select.value); } catch { /* not remembered */ }
      if (select.micAdvice) select.micAdvice();
    });
  }
  if (advice) {
    select.micAdvice = () => showMicAdvice(select, advice, mics);
    select.micAdvice();
  }
  return select.value;
}

/** Steer away from a wireless microphone, offering the built-in one if there is one. */
function showMicAdvice(select, advice, mics) {
  const label = select.selectedOptions[0]?.textContent || '';
  const reason = wirelessMicReason(label);
  advice.replaceChildren();
  if (!reason) return;
  const builtIn = builtInMicrophone(mics);
  const note = el('p', { class: 'note warn' },
    `"${label}" looks like ${reason}. Wireless microphones hear 100–200 ms late, several times more than `
    + 'any TinCAN timing profile allows, and are rarely next to this computer\'s speaker. '
    + (builtIn ? '' : mics.filter((m) => m.deviceId !== 'default').length > 1
      ? 'None of the others here looks built in. If one is, choose it; if this computer has none (a Mac mini, '
        + 'Mac Studio or desktop PC usually doesn\'t), use a wired microphone, USB or a headset in the audio jack, next to the speaker.'
      : 'It is the only microphone listed. Use a wired one, USB or a headset in the audio jack, next to the speaker.'));
  if (builtIn) {
    if (select.disabled) {
      note.append(`Stop, choose "${builtIn.label}", and start again.`);
    } else {
      note.append(el('button', {
        style: 'margin-left:.4rem',
        onclick: () => {
          select.value = builtIn.deviceId;
          select.dispatchEvent(new Event('change'));
        },
      }, `Use ${builtIn.label}`));
    }
  }
  advice.append(note);
}
