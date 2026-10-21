#!/usr/bin/env node
/**
 * The TinCAN test rig's server — spec/rig.md §6–§8.
 *
 * Serves the repository over HTTPS on the LAN (browsers need a secure context
 * for the microphone, so the certificate is self-signed, made here with
 * openssl), answers the device API, and listens on 127.0.0.1 for the control
 * API that tools/rig.mjs talks to. Zero dependencies: everything is node:*.
 */

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validate } from '../../src/tincan/rig-dsl.js';

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.md': 'text/markdown',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.wav': 'audio/wav',
  '.txt': 'text/plain',
};

// Never served, however the path is spelled.
const PRIVATE = new Set(['.rig', 'runs', '.git', 'rig-hosts.json']);

const sanitize = (name) => String(name ?? '')
  .toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'device';

/** The first non-internal IPv4, for the banner and the certificate. */
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}

/** A request body, bounded; rejects with {status:413} past `limit` bytes. */
function readBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const readJson = async (req, limit = 1 << 20) => {
  const body = await readBody(req, limit);
  if (!body.length) return {};
  return JSON.parse(body);
};

const sendJson = (res, status, obj) => {
  const data = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(data);
};

const sse = (res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
  });
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

export async function startRig(opts = {}) {
  const root = opts.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const code = opts.code ?? String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const runsDir = opts.runsDir ?? join(root, 'runs');
  const certDir = opts.certDir ?? join(root, '.rig');
  const host = opts.host ?? lanAddress();
  const lead = opts.lead ?? 1500;
  const log = opts.log ?? console.log;

  /* certificate ------------------------------------------------------- */
  mkdirSync(certDir, { recursive: true });
  const keyFile = join(certDir, 'key.pem');
  const certFile = join(certDir, 'cert.pem');
  if (!existsSync(keyFile) || !existsSync(certFile)) {
    try {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyFile, '-out', certFile, '-days', '3650',
        '-subj', '/CN=tincan-rig',
        '-addext', `subjectAltName=IP:${host},IP:127.0.0.1,DNS:localhost`,
      ], { stdio: 'ignore' });
    } catch {
      throw new Error(`openssl is needed to create the rig certificate in ${certDir}`);
    }
  }

  /* state ------------------------------------------------------------- */
  const devices = new Map();     // device id -> record
  const byToken = new Map();     // token -> record
  const pending = new Map();     // description id -> {id, at, to, results, done, waiters}
  const logSubs = new Set();     // control /log SSE responses
  const sockets = new Set();
  let nextId = 1;
  let run = null;                // {name, dir}

  const pad = (n) => String(n).padStart(2, '0');
  function startRun(name) {
    const d = new Date();
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const stamp = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const base = name ? `${stamp}-${sanitize(name)}` : stamp;
    const dir = join(runsDir, day, base);
    for (const sub of ['devices', 'descriptions', 'results', 'wav']) {
      mkdirSync(join(dir, sub), { recursive: true });
    }
    run = { name: `${day}/${base}`, dir };
    for (const dev of devices.values()) writeDeviceFile(dev);
    return run;
  }

  const writeDeviceFile = (dev) => writeFileSync(
    join(run.dir, 'devices', `${dev.device}.json`),
    JSON.stringify({ device: dev.device, name: dev.name, info: dev.info, joinedAt: dev.joinedAt }, null, 2) + '\n');

  /** One line of events.ndjson, also pushed to every control /log stream. */
  function logEvent(evt) {
    const line = { serverTime: Date.now(), ...evt };
    appendFileSync(join(run.dir, 'events.ndjson'), JSON.stringify(line) + '\n');
    for (const emit of logSubs) emit('log', line);
    return line;
  }

  /** Deliver an SSE event to a device; queue it if its stream is closed. */
  function sendToDevice(dev, event, data) {
    dev.queue.push({ event, data });
    if (dev.stream) {
      for (const m of dev.queue.splice(0)) dev.stream.emit(m.event, m.data);
    }
  }

  /* device API (HTTPS) ------------------------------------------------ */

  function serveStatic(req, res) {
    // WHATWG URL normalization would silently collapse "/../", so check the
    // raw request target — after decoding — for segments that climb out.
    const raw = (req.url ?? '').split('?')[0];
    let p;
    try { p = decodeURIComponent(raw); } catch { res.writeHead(404).end(); return; }
    if (p.split('/').includes('..')) { res.writeHead(404).end(); return; }
    const file = resolve(root, `.${p}`);
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(404).end(); return; }
    const rel = file === root ? '' : file.slice(root.length + 1);
    if (PRIVATE.has(rel.split(sep)[0])) { res.writeHead(404).end(); return; }
    let target = file;
    try {
      if (statSync(target).isDirectory()) target = join(target, 'index.html');
      const data = readFileSync(target);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    } catch {
      res.writeHead(404).end();
    }
  }

  async function deviceApi(req, res, u) {
    const dev = byToken.get(u.searchParams.get('token'));
    switch (u.pathname) {
      case '/api/join': {
        if (req.method !== 'POST') break;
        const body = await readJson(req);
        if (body.code !== code) { sendJson(res, 401, { error: 'wrong join code' }); return; }
        let id = sanitize(body.name);
        if (devices.get(id)?.online) {
          const base = id;
          let n = 2;
          while (devices.get(`${base}-${n}`)?.online) n++;
          id = `${base}-${n}`;
        }
        const record = {
          device: id, name: body.name ?? id, info: body.info ?? {},
          token: crypto.randomBytes(16).toString('hex'),
          joinedAt: Date.now(), lastSeen: Date.now(),
          online: false, stream: null, timer: null, queue: [],
        };
        devices.set(id, record);
        byToken.set(record.token, record);
        writeDeviceFile(record);
        sendJson(res, 200, { token: record.token, device: id, run: run.name, serverTime: Date.now() });
        return;
      }
      case '/api/events': {
        if (!dev || req.method !== 'GET') break;
        if (dev.stream) { dev.stream.res.end(); clearInterval(dev.timer); }
        const emit = sse(res);
        dev.stream = { res, emit };
        dev.timer = setInterval(() => res.write(': ping\n\n'), 15000);
        dev.timer.unref();
        dev.online = true;
        dev.lastSeen = Date.now();
        emit('hello', { device: dev.device, run: run.name, serverTime: Date.now() });
        for (const m of dev.queue.splice(0)) emit(m.event, m.data);
        res.on('close', () => {
          clearInterval(dev.timer);
          if (dev.stream?.res === res) dev.stream = null;
          dev.online = false;
          dev.lastSeen = Date.now();
        });
        return;
      }
      case '/api/ping': {
        if (!dev || req.method !== 'POST') break;
        const { t0 } = await readJson(req);
        dev.lastSeen = Date.now();
        sendJson(res, 200, { t0, t1: Date.now() });
        return;
      }
      case '/api/event': {
        if (!dev || req.method !== 'POST') break;
        const { id, type, detail, at } = await readJson(req);
        dev.lastSeen = Date.now();
        logEvent({ device: dev.device, id, type, detail, at });
        res.writeHead(204).end();
        return;
      }
      case '/api/result': {
        if (!dev || req.method !== 'POST') break;
        const { id, result } = await readJson(req);
        const p = pending.get(id);
        if (!p || !p.to.includes(dev.device)) { sendJson(res, 404, { error: `unknown description ${id}` }); return; }
        dev.lastSeen = Date.now();
        const record = { ...result, device: dev.device, id, serverTime: Date.now() };
        writeFileSync(join(run.dir, 'results', `${id}-${dev.device}.json`), JSON.stringify(record, null, 2) + '\n');
        p.results[dev.device] = record;
        if (!p.done.includes(dev.device)) p.done.push(dev.device);
        if (p.to.every((d) => p.results[d])) settle(p, true);
        res.writeHead(204).end();
        return;
      }
      case '/api/wav': {
        if (!dev || req.method !== 'POST') break;
        const id = u.searchParams.get('id');
        const p = pending.get(id);
        if (!p || !p.to.includes(dev.device)) { sendJson(res, 404, { error: `unknown description ${id}` }); return; }
        const body = await readBody(req, 64 << 20);
        const name = sanitize(u.searchParams.get('name'));
        dev.lastSeen = Date.now();
        writeFileSync(join(run.dir, 'wav', `${id}-${dev.device}-${name}.wav`), body);
        res.writeHead(204).end();
        return;
      }
      default:
    }
    sendJson(res, 401, { error: 'bad or missing token' });
  }

  /** Answer every waiter of a description, complete or timed out. */
  function settle(p, complete) {
    for (const w of p.waiters.splice(0)) {
      clearTimeout(w.timer);
      sendJson(w.res, 200, { id: p.id, complete, results: p.results });
    }
  }

  /* control API (HTTP on 127.0.0.1) ----------------------------------- */

  function controlTargets(to) {
    if (to === 'all') return [...devices.values()].filter((d) => d.online);
    const dev = devices.get(to);
    return dev?.online ? [dev] : [];
  }

  async function controlApi(req, res, u) {
    const { pathname } = u;
    if (pathname === '/info' && req.method === 'GET') {
      sendJson(res, 200, { url, code, run: run.name, controlUrl });
    } else if (pathname === '/devices' && req.method === 'GET') {
      sendJson(res, 200, [...devices.values()].map((d) => ({
        device: d.device, name: d.name, online: d.online,
        joinedAt: d.joinedAt, info: d.info, lastSeen: d.lastSeen,
      })));
    } else if (pathname === '/run' && req.method === 'GET') {
      sendJson(res, 200, { run: run.name, dir: run.dir });
    } else if (pathname === '/run' && req.method === 'POST') {
      const { name } = await readJson(req);
      const r = startRun(name);
      sendJson(res, 200, { run: r.name, dir: r.dir });
    } else if (pathname === '/send' && req.method === 'POST') {
      const { to, description } = await readJson(req);
      const v = validate(description);
      if (!v.ok) { sendJson(res, 400, { errors: v.errors }); return; }
      const targets = controlTargets(to);
      if (!targets.length) { sendJson(res, 404, { error: `no online device ${JSON.stringify(to)}` }); return; }
      const id = `d${nextId++}`;
      const at = v.desc.at ?? Date.now() + lead;
      v.desc.at = at;
      const toList = targets.map((d) => d.device);
      writeFileSync(join(run.dir, 'descriptions', `${id}.json`),
        JSON.stringify({ id, to: toList, at, description: v.desc }, null, 2) + '\n');
      const p = { id, at, to: toList, results: {}, done: [], waiters: [] };
      pending.set(id, p);
      for (const dev of targets) sendToDevice(dev, 'description', { run: run.name, id, description: v.desc });
      logEvent({ device: 'server', id, type: 'sent', detail: { to: toList, at }, at });
      sendJson(res, 200, { id, at, to: toList });
    } else if (pathname === '/wait' && req.method === 'GET') {
      const p = pending.get(u.searchParams.get('id'));
      if (!p) { sendJson(res, 404, { error: 'unknown description' }); return; }
      const timeout = parseFloat(u.searchParams.get('timeout') ?? '30');
      if (p.to.every((d) => p.results[d])) { sendJson(res, 200, { id: p.id, complete: true, results: p.results }); return; }
      const timer = setTimeout(() => settle(p, false), Math.max(0, timeout * 1000));
      timer.unref();
      p.waiters.push({ res, timer });
    } else if (pathname === '/results' && req.method === 'GET') {
      const id = u.searchParams.get('id');
      if (id) {
        const p = pending.get(id);
        if (!p) { sendJson(res, 404, { error: 'unknown description' }); return; }
        sendJson(res, 200, { id, complete: p.to.every((d) => p.results[d]), results: p.results });
      } else {
        sendJson(res, 200, [...pending.values()].map((p) => ({ id: p.id, at: p.at, to: p.to, done: p.done })));
      }
    } else if (pathname === '/files' && req.method === 'GET') {
      const id = u.searchParams.get('id');
      const files = [];
      const desc = join(run.dir, 'descriptions', `${id}.json`);
      if (existsSync(desc)) files.push(desc);
      else if (!pending.has(id)) { sendJson(res, 404, { error: 'unknown description' }); return; }
      for (const sub of ['results', 'wav']) {
        for (const f of readdirSync(join(run.dir, sub))) {
          if (f.startsWith(`${id}-`)) files.push(join(run.dir, sub, f));
        }
      }
      sendJson(res, 200, { id, files });
    } else if (pathname === '/log' && req.method === 'GET') {
      const emit = sse(res);
      logSubs.add(emit);
      emit('hello', { run: run.name, serverTime: Date.now() });
      res.on('close', () => logSubs.delete(emit));
    } else if (pathname === '/stop' && req.method === 'POST') {
      const { to } = await readJson(req);
      const targets = to === 'all' || to === undefined ? [...devices.values()] : controlTargets(to);
      for (const dev of targets) sendToDevice(dev, 'stop', {});
      res.writeHead(204).end();
    } else {
      sendJson(res, 404, { error: `no such endpoint: ${req.method} ${pathname}` });
    }
  }

  /* wiring ------------------------------------------------------------ */

  const deviceServer = https.createServer(
    { key: readFileSync(keyFile), cert: readFileSync(certFile) },
    (req, res) => {
      const u = new URL(req.url, 'http://rig');
      if (u.pathname.startsWith('/api/')) {
        deviceApi(req, res, u).catch((err) => sendJson(res, err.status ?? 500, { error: String(err.message ?? err) }));
      } else {
        serveStatic(req, res);
      }
    });
  const controlServer = http.createServer(
    (req, res) => controlApi(req, res, new URL(req.url, 'http://rig'))
      .catch((err) => sendJson(res, err.status ?? 500, { error: String(err.message ?? err) })));

  for (const s of [deviceServer, controlServer]) {
    for (const ev of ['connection', 'secureConnection']) {
      s.on(ev, (sock) => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); });
    }
  }
  const listen = (s, port, h) => new Promise((okListen, fail) => {
    s.once('error', fail);
    s.listen(port, h, okListen);
  });
  await listen(deviceServer, opts.port ?? 8443);
  await listen(controlServer, opts.controlPort ?? 8444, '127.0.0.1');

  const port = deviceServer.address().port;
  const controlBound = controlServer.address().port;
  const url = `https://${host}:${port}/`;
  const controlUrl = `http://127.0.0.1:${controlBound}`;
  startRun();

  const rig = {
    url, code, controlUrl, devices,
    get run() { return run.dir; },
    async close() {
      for (const emit of logSubs) emit('bye', {});
      logSubs.clear();
      for (const dev of devices.values()) {
        clearInterval(dev.timer);
        dev.stream?.res.end();
      }
      for (const p of pending.values()) settle(p, false);
      for (const sock of sockets) sock.destroy();
      await Promise.all([deviceServer, controlServer].map((s) => new Promise((okClose) => s.close(okClose))));
    },
  };
  log(`rig listening on ${url} (control ${controlUrl})`);
  return rig;
}

/* -------------------------------------------------------------------- */

async function main() {
  const opts = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    if (argv[i] === '--port') { opts.port = Number(v); i++; }
    else if (argv[i] === '--control-port') { opts.controlPort = Number(v); i++; }
    else if (argv[i] === '--code') { opts.code = v; i++; }
    else if (argv[i] === '--runs') { opts.runsDir = resolve(v); i++; }
    else if (argv[i] === '--host') { opts.host = v; i++; }
  }
  const rig = await startRig(opts);
  const run = await (await fetch(`${rig.controlUrl}/run`)).json();
  console.log(`TinCAN rig
  devices:   ${rig.url}apps/rig/
  join code: ${rig.code}
  control:   ${rig.controlUrl}
  run:       ${run.dir}
Ctrl-C to stop`);
  process.on('SIGINT', async () => { await rig.close(); process.exit(0); });
}

// argv[1] is empty under `node -e`, which is how CI imports this module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
