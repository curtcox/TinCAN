/**
 * The rig server end to end — spec/rig.md §6–§8: a device joins over HTTPS,
 * receives a description on its SSE stream, and posts events, a result and a
 * WAV back; the control API drives it all from 127.0.0.1.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startRig } from '../tools/rig/server.mjs';

let rig;
let tmp;
let deviceBase;   // https://127.0.0.1:port

/** An HTTP(S) request returning {status, json|text}. */
function request(base, path, { method = 'GET', body, headers = {}, secure } = {}) {
  return new Promise((ok, fail) => {
    const mod = secure === false ? http : https;
    const { hostname, port } = new URL(base);
    const req = mod.request({
      hostname, port, path,                         // sent verbatim: no URL normalization
      method, headers, rejectUnauthorized: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        ok({ status: res.statusCode, json, text, body: buf, headers: res.headers });
      });
    });
    req.on('error', fail);
    if (body !== undefined) {
      if (typeof body !== 'string' && !Buffer.isBuffer(body)) {
        req.setHeader('Content-Type', 'application/json');
        req.write(JSON.stringify(body));
      } else {
        req.write(body);
      }
    }
    req.end();
  });
}

const api = (path, o) => request(deviceBase, path, o);
const ctl = (path, o) => request(rig.controlUrl, path, { ...o, secure: false });

/** A device's SSE stream as an async queue of {event, data}. */
function openEvents(token) {
  const u = new URL(`/api/events?token=${token}`, deviceBase);
  const queue = [];
  let notify = null;
  const req = https.get(u, { rejectUnauthorized: false }, (res) => {
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk;
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        const event = part.match(/^event: (.*)$/m)?.[1];
        const data = part.match(/^data: (.*)$/m)?.[1];
        if (event && data) {
          queue.push({ event, data: JSON.parse(data) });
          notify?.();
        }
      }
    });
  });
  return {
    req,
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((okNext) => { notify = () => okNext(queue.shift()); });
    },
  };
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'rig-'));
  rig = await startRig({
    port: 0, controlPort: 0, code: '123456',
    runsDir: join(tmp, 'runs'), certDir: join(tmp, '.rig'),
    host: '127.0.0.1', lead: 50, log: () => {},
  });
  deviceBase = `https://127.0.0.1:${new URL(rig.url).port}`;
});

after(async () => { await rig.close(); });

test('rig server end to end', async () => {
  /* 1 — static files */
  let r = await api('/src/tincan/rig-dsl.js');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/javascript/);
  assert.ok(r.text.includes('export const LIMITS'));
  assert.equal((await api('/.rig/key.pem')).status, 404);
  assert.equal((await api('/runs/')).status, 404);
  assert.equal((await api('/../package.json')).status, 404);
  assert.equal((await api('/rig-hosts.json')).status, 404);

  /* 2 — join needs the code; every other endpoint needs the token */
  assert.equal((await api('/api/join', { method: 'POST', body: { code: '000000', name: 'x' } })).status, 401);
  assert.equal((await api('/api/events')).status, 401);

  /* 3 — join and the event stream */
  r = await api('/api/join', { method: 'POST', body: { code: '123456', name: 'Kitchen Mac', info: { audio: { sampleRate: 48000 } } } });
  assert.equal(r.status, 200);
  const { token, device } = r.json;
  assert.equal(device, 'kitchen-mac');
  assert.ok(existsSync(join(rig.run, 'devices', 'kitchen-mac.json')));
  const events = openEvents(token);
  const hello = await events.next();
  assert.equal(hello.event, 'hello');
  assert.equal(hello.data.device, 'kitchen-mac');
  await new Promise((okWait) => setTimeout(okWait, 20));
  const devs = (await ctl('/devices')).json;
  assert.equal(devs[0].device, 'kitchen-mac');
  assert.equal(devs[0].online, true);
  assert.equal(devs[0].info.audio.sampleRate, 48000);

  /* 4 — send a description */
  const description = { rig: 1, actions: [
    { do: 'tone', band: 'A', which: 'R', seconds: 0.1 },
    { do: 'record', seconds: 0.2 },
  ] };
  const before = Date.now();
  r = await ctl('/send', { method: 'POST', body: { to: 'all', description } });
  assert.equal(r.status, 200);
  assert.equal(r.json.id, 'd1');
  assert.ok(r.json.at >= before && r.json.at <= Date.now() + 60, `at ${r.json.at} ≈ now+50`);
  assert.deepEqual(r.json.to, ['kitchen-mac']);
  const got = await events.next();
  assert.equal(got.event, 'description');
  assert.equal(got.data.id, 'd1');
  assert.equal(got.data.description.at, r.json.at);
  assert.ok(existsSync(join(rig.run, 'descriptions', 'd1.json')));

  /* 5 — an invalid description is refused with every error */
  r = await ctl('/send', { method: 'POST', body: { to: 'all', description: { rig: 1, actions: [{ do: 'tone', hz: 1000, level: 0.9 }] } } });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.some((e) => e.includes('actions[0].level')));

  /* 6 — the device posts an event, a result and a WAV */
  assert.equal((await api(`/api/event?token=${token}`, {
    method: 'POST', body: { id: 'd1', type: 'started', detail: { latencyMs: 42 }, at: Date.now() },
  })).status, 204);
  const result = { run: 'x', id: 'd1', at: Date.now(), actions: [{ index: 1, do: 'record', levels: { peak: 0.1 } }], errors: [] };
  assert.equal((await api(`/api/result?token=${token}`, { method: 'POST', body: { id: 'd1', result } })).status, 204);
  const wav = Buffer.concat([Buffer.from('RIFF----WAVEfmt '), Buffer.alloc(32)]);
  assert.equal((await api(`/api/wav?token=${token}&id=d1&name=rec0`, {
    method: 'POST', body: wav, headers: { 'Content-Type': 'application/octet-stream' },
  })).status, 204);

  r = await ctl('/wait?id=d1&timeout=2');
  assert.equal(r.json.complete, true);
  assert.equal(r.json.results['kitchen-mac'].actions[0].levels.peak, 0.1);
  assert.ok(existsSync(join(rig.run, 'results', 'd1-kitchen-mac.json')));
  assert.ok(existsSync(join(rig.run, 'wav', 'd1-kitchen-mac-rec0.wav')));
  const files = (await ctl('/files?id=d1')).json.files;
  assert.equal(files.length, 3);
  const ndjson = readFileSync(join(rig.run, 'events.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(ndjson.some((e) => e.type === 'sent' && e.id === 'd1'));
  assert.ok(ndjson.some((e) => e.type === 'started' && e.detail.latencyMs === 42));

  /* 7 — a description nobody answers times out */
  r = await ctl('/send', { method: 'POST', body: { to: 'kitchen-mac', description } });
  const d2 = r.json.id;
  await events.next();                                    // the device's copy
  r = await ctl(`/wait?id=${d2}&timeout=0.2`);
  assert.equal(r.json.complete, false);
  assert.deepEqual(r.json.results, {});

  /* 8 — stop reaches the device */
  assert.equal((await ctl('/stop', { method: 'POST', body: { to: 'all' } })).status, 204);
  const stop = await events.next();
  assert.equal(stop.event, 'stop');

  /* 9 — a new run rewrites the device files */
  r = await ctl('/run', { method: 'POST', body: { name: 'Second Try' } });
  assert.match(r.json.dir, /\d{6}-second-try$/);
  assert.ok(existsSync(join(r.json.dir, 'devices', 'kitchen-mac.json')));

  /* 10 — control listens on loopback only */
  assert.ok(rig.controlUrl.startsWith('http://127.0.0.1:'), rig.controlUrl);

  events.req.destroy();
});
