/**
 * The browser path, minus the browser: the real AudioWorkletProcessor from
 * worklet.js and the real Modem message handling from modem.js, wired the way
 * the Console wires them, with the Web Audio pieces stubbed out.
 *
 * Every other suite drives Protocol and Phy directly, so none of them would
 * notice a frame that the worklet fails to forward, serializes wrongly, or
 * that the Console's Session adapter drops.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const FS = 48000;
const BLOCK = 128;

// AudioWorkletGlobalScope, as far as worklet.js needs it. Messages are
// structured-cloned, as they are across a real MessagePort.
let Processor = null;
globalThis.sampleRate = FS;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.outbox = [];
    this.port = { onmessage: null, postMessage: (m) => this.outbox.push(structuredClone(m)) };
  }
};
globalThis.registerProcessor = (name, cls) => { Processor = cls; };

await import('../src/tincan/worklet.js');
const { Modem } = await import('../src/tincan/modem.js');
const { Session } = await import('../src/tincan/transport.js');

/** One Console: worklet processor, Modem front end, Session on top. */
function consoleNode({ name, address, profile = 'T25' }) {
  const proc = new Processor({
    processorOptions: { name, mode: 'node', band: 'A', profile, amplitude: 0.25 },
  });
  const modem = new Modem({ name, profile });
  modem.node = { port: { postMessage: (m) => proc.port.onmessage({ data: structuredClone(m) }) } };

  // Exactly the adapter apps/console/app.js builds.
  const session = new Session({
    on: (ev, fn) => modem.on(ev, (e) => fn(e.detail)),
    send: (frame) => modem.send(frame),
  }, { address, callsign: name });

  const heard = [];
  session.on('message', (m) => heard.push(m.text));
  const peers = [];
  session.on('presence', (p) => peers.push(p.announce.callsign));
  return { proc, modem, session, heard, peers, history: new Float32Array(1 << 16) };
}

/** Two nodes in free air: each hears itself and the other after `delayMs`. */
function room(nodes, { delayMs = 3, noise = 0.0005 } = {}) {
  const mask = (1 << 16) - 1;
  const delay = Math.round((delayMs / 1000) * FS);
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let t = 0;
  return function run(seconds) {
    for (let k = Math.round((seconds * FS) / BLOCK); k > 0; k--) {
      const inputs = nodes.map(() => {
        const x = new Float32Array(BLOCK);
        for (let j = 0; j < BLOCK; j++) {
          let v = noise * (rnd() * 2 - 1);
          for (const m of nodes) v += m.history[(t + j - delay) & mask];
          x[j] = v;
        }
        return x;
      });
      nodes.forEach((n, i) => {
        const out = new Float32Array(BLOCK);
        n.proc.process([[inputs[i]]], [[out]]);
        for (let j = 0; j < BLOCK; j++) n.history[(t + j) & mask] = out[j];
        for (const m of n.proc.outbox.splice(0)) n.modem._onMessage(m);
      });
      t += BLOCK;
    }
  };
}

test('two Consoles announce and exchange text through the real worklet and Modem', () => {
  const ada = consoleNode({ name: 'ada', address: 3 });
  const bob = consoleNode({ name: 'bob', address: 12 });
  const run = room([ada, bob]);

  run(0.5);
  ada.session.announce();
  bob.session.announce();
  run(12);
  ada.session.sendText('hello bob');
  run(12);
  bob.session.sendText('hi ada, segmented');   // three frames, ~4 s each at T25
  run(20);

  assert.deepEqual(ada.peers, ['bob']);
  assert.deepEqual(bob.peers, ['ada']);
  assert.deepEqual(bob.heard, ['hello bob']);
  assert.deepEqual(ada.heard, ['hi ada, segmented']);
  for (const n of [ada, bob]) {
    assert.equal(n.modem.status.queue, 0, 'nothing left queued');
    assert.equal(n.modem.status.errorState, 'error-active');
  }
});

test('the worklet reports a rejected frame instead of throwing on the audio thread', () => {
  const ada = consoleNode({ name: 'ada', address: 3 });
  const rejected = [];
  ada.modem.on('rejected', (e) => rejected.push(e.detail.error));

  ada.modem.send({ id: 0x123, data: new Uint8Array(9) });   // 9 octets without FDF
  for (const m of ada.proc.outbox.splice(0)) ada.modem._onMessage(m);

  assert.equal(rejected.length, 1);
});

test('a muted Console transmits nothing and does not acknowledge', () => {
  const ada = consoleNode({ name: 'ada', address: 3 });
  const bob = consoleNode({ name: 'bob', address: 12 });
  const run = room([ada, bob]);
  const errors = [];
  ada.modem.on('error-frame', (e) => errors.push(e.detail.kind));

  bob.modem.setMuted(true);
  run(0.5);
  ada.session.sendText('anyone?');
  run(8);

  assert.ok(errors.includes('ack'), 'ada was not acknowledged');
  assert.deepEqual(bob.heard, [], 'and bob, a listener, never saw the frame complete');
  assert.equal(bob.modem.status.stats.framesSent, 0);
});
