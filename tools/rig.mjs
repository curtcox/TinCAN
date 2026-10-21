#!/usr/bin/env node
/**
 * The rig's command line — spec/rig.md §7. Talks to the control API the
 * server exposes on 127.0.0.1 (RIG_CONTROL env to point it elsewhere);
 * it never touches the devices' HTTPS port itself.
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  HOSTS_FILE, hostFor, launchScript, stopScript, infoScript,
} from './rig/hosts.mjs';

const BASE = process.env.RIG_CONTROL || 'http://127.0.0.1:8444';

const print = (obj) => console.log(JSON.stringify(obj, null, 2));

function call(method, path, body) {
  return new Promise((ok, fail) => {
    const req = http.request(BASE + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* SSE and empty replies */ }
        ok({ status: res.statusCode, json, text });
      });
    });
    req.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        console.error(`the rig server is not running on ${BASE}; start it with node tools/rig/server.mjs`);
        process.exit(1);
      }
      fail(err);
    });
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const get = (path) => call('GET', path);
const post = (path, body) => call('POST', path, body);

function check(r) {
  if (r.status >= 400) {
    console.error(`${r.status}: ${r.text}`);
    process.exit(1);
  }
  return r.json;
}

/** A host alias to its record, or exit 1 saying where it should live. */
function host(alias) {
  try {
    return hostFor(alias, HOSTS_FILE);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

/**
 * One ssh invocation. `capture` collects the remote output so the caller can
 * print the one-line outcome; otherwise it streams. Exit status is ssh's.
 */
function ssh(h, script, { capture = false } = {}) {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', h.ssh, script],
    capture ? { encoding: 'utf8' } : { stdio: 'inherit' });
  if (r.error) { console.error(`ssh: ${r.error.message}`); process.exit(1); }
  if (capture) {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
  }
  process.exit(r.status ?? 1);
}

function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** One line per joined device: id, online, name, and its audio info. */
function printDevices(list) {
  for (const d of list) {
    const a = d.info?.audio ?? {};
    const bits = [
      a.sampleRate && `${a.sampleRate} Hz`,
      a.label || a.microphone,
      a.echoCancellation !== undefined && `echoCancellation ${a.echoCancellation}`,
      a.noiseSuppression !== undefined && `noiseSuppression ${a.noiseSuppression}`,
      a.autoGainControl !== undefined && `autoGainControl ${a.autoGainControl}`,
      a.baseLatency !== undefined && `baseLatency ${a.baseLatency}`,
    ].filter(Boolean).join(', ');
    console.log(`${d.device}\t${d.online ? 'online' : 'offline'}\t${d.name}${bits ? `\t${bits}` : ''}`);
  }
}

/** Follow the control /log stream, one line per event, until Ctrl-C. */
function followLog() {
  http.get(`${BASE}/log`, (res) => {
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk;
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        const event = part.match(/^event: (.*)$/m)?.[1];
        const data = part.match(/^data: (.*)$/m)?.[1];
        if (event === 'log' && data) {
          const e = JSON.parse(data);
          console.log(`${fmtTime(e.serverTime)} ${e.device ?? ''} ${e.id ?? ''} ${e.type ?? ''} ${e.detail ? JSON.stringify(e.detail) : ''}`.replace(/\s+/g, ' ').trim());
        }
      }
    });
    res.on('end', () => process.exit(0));
  }).on('error', (err) => {
    if (err.code === 'ECONNREFUSED') {
      console.error(`the rig server is not running on ${BASE}; start it with node tools/rig/server.mjs`);
      process.exit(1);
    }
    throw err;
  });
}

const usage = `usage: node tools/rig.mjs <command>

  info [host]           the server, or an SSH host from rig-hosts.json
  devices               joined devices and their audio
  send <device|all> <description.json|{json}> [--wait [seconds]]
  wait <id> [seconds]   block until every target's result is in
  results [id]          one description's results, or every send this session
  fetch <id>            the record files kept for a description
  run [name]            the current run, or start a new one
  log                   follow the event log
  stop [device|all|host]  stop playback on devices, or SSH-stop a host
  launch <host>         start a device browser over SSH
  info <host>           a host's audio devices and volume over SSH

SSH hosts are aliases in rig-hosts.json (see spec/rig.html §9). SSH is used
for these commands only: the rig never installs software or changes settings.

control API: ${BASE} (RIG_CONTROL to change)`;

async function main(argv) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'info': {
      if (args.length) {
        const h = host(args[0]);                 // an SSH host's audio
        console.log(`ssh ${h.ssh}: audio devices and volume`);
        ssh(h, infoScript(h));
      }
      print(check(await get('/info')));
      break;
    }
    case 'devices':
      printDevices(check(await get('/devices')));
      break;
    case 'send': {
      const [to, descArg, ...rest] = args;
      if (!to || !descArg) { console.error(usage); process.exit(2); }
      const description = descArg.startsWith('{')
        ? JSON.parse(descArg)
        : JSON.parse(readFileSync(resolve(descArg), 'utf8'));
      const sent = check(await post('/send', { to, description }));
      print({ id: sent.id, at: sent.at, to: sent.to });
      const wi = rest.indexOf('--wait');
      if (wi >= 0) {
        const seconds = Number(rest[wi + 1]) || 30;
        print(check(await get(`/wait?id=${sent.id}&timeout=${seconds}`)));
      }
      break;
    }
    case 'wait': {
      const [id, seconds = 30] = args;
      if (!id) { console.error(usage); process.exit(2); }
      print(check(await get(`/wait?id=${id}&timeout=${seconds}`)));
      break;
    }
    case 'results':
      print(check(await get(args[0] ? `/results?id=${args[0]}` : '/results')));
      break;
    case 'fetch': {
      const r = check(await get(`/files?id=${args[0]}`));
      for (const f of r.files) console.log(f);
      break;
    }
    case 'run':
      if (args[0]) print(check(await post('/run', { name: args.join(' ') })));
      else print(check(await get('/run')));
      break;
    case 'log':
      followLog();
      break;
    case 'stop': {
      const arg = args[0] ?? 'all';
      const list = arg === 'all' ? [] : check(await get('/devices'));
      if (arg === 'all' || list.some((d) => d.device === arg)) {
        await post('/stop', { to: arg });
      } else {
        const h = host(arg);                     // a host alias, not a device
        console.log(`ssh ${h.ssh}: stopping the rig's browser`);
        ssh(h, stopScript(h), { capture: true });
      }
      break;
    }
    case 'launch': {
      if (!args[0]) { console.error(usage); process.exit(2); }
      const h = host(args[0]);
      const { url, code } = check(await get('/info'));
      const page = `${url}apps/rig/?code=${code}&name=${encodeURIComponent(h.name)}&auto=1`;
      console.log(`ssh ${h.ssh}: launching ${h.name}'s browser at ${page}`);
      ssh(h, launchScript(h, page), { capture: true });
      break;
    }
    case 'help': case undefined: case '--help': case '-h':
      console.log(usage);
      break;
    default:
      console.log(usage);
      process.exit(2);
  }
}

main(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exit(1); });
