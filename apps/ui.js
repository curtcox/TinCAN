/** Small shared helpers for the three TinCAN apps. No framework. */

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
  ];
  return el('header', { class: 'topbar' },
    el('a', { class: 'brand', href: '../../', html: 'Tin<span>CAN</span>' }),
    el('nav', {}, links.map(([href, label]) =>
      el('a', { href, 'aria-current': label === current ? 'page' : null }, label))));
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
