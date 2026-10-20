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

/**
 * One Console: worklet processor, Modem front end, Session on top.
 * `rate` is what its AudioContext reports; `ppm` is how far its crystal is
 * off that. `joinAt` is when its user presses Join, in room time, and
 * `micAfter` is how long its microphone then takes to deliver anything.
 */
function consoleNode({ name, address, profile = 'T25', rate = FS, ppm = 0, joinAt = 0, micAfter = 0 }) {
  globalThis.sampleRate = rate;
  const proc = new Processor({
    processorOptions: { name, mode: 'node', band: 'A', profile, amplitude: 0.25 },
  });
  globalThis.sampleRate = FS;
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
  return {
    proc, modem, session, heard, peers,
    rate: rate * (1 + ppm * 1e-6), joinAt, micAfter, k: 0, history: new Float32Array(1 << 16),
  };
}

/**
 * A room: every node hears itself and every other node after `delayMs`, plus
 * noise. Each node runs on its own clock in 128-sample blocks, and hears the
 * others resampled onto it. `gain[i][j]` is how loudly i hears j, and
 * `shape(i, x, t)` stands in for i's microphone (clipping, dropouts).
 */
function room(nodes, { delayMs = 3, noise = 0.0005, gain = null, shape = null } = {}) {
  const mask = (1 << 16) - 1;
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const clock = (n) => n.joinAt + n.k / n.rate;
  const heardFrom = (m, t) => {
    const f = (t - m.joinAt) * m.rate;
    if (f < 0) return 0;
    const i = Math.floor(f);
    const a = m.history[i & mask], b = m.history[(i + 1) & mask];
    return a + (b - a) * (f - i);
  };
  let now = 0;
  return function run(seconds) {
    now += seconds;
    for (;;) {
      // Always advance whichever node is furthest behind. `delayMs` exceeds a
      // block, so everything it is about to hear has already been played.
      const n = nodes.reduce((a, b) => (clock(b) < clock(a) ? b : a));
      const t0 = clock(n);
      if (t0 >= now) return;
      const i = nodes.indexOf(n);
      let input = [];
      if (t0 >= n.joinAt + n.micAfter) {
        const x = new Float32Array(BLOCK);
        for (let j = 0; j < BLOCK; j++) {
          const t = t0 + j / n.rate;
          let v = noise * (rnd() * 2 - 1);
          nodes.forEach((m, mi) => { v += (gain ? gain[i][mi] : 1) * heardFrom(m, t - delayMs / 1000); });
          x[j] = shape ? shape(i, v, t) : v;
        }
        input = [x];
      }
      const out = new Float32Array(BLOCK);
      n.proc.process([input], [[out]]);
      for (let j = 0; j < BLOCK; j++) n.history[(n.k + j) & mask] = out[j];
      n.k += BLOCK;
      for (const m of n.proc.outbox.splice(0)) n.modem._onMessage(m);
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

/** Both Consoles announce, then each sends the other a line of text. */
function converse(run, ada, bob) {
  ada.session.announce();
  bob.session.announce();
  run(12);
  ada.session.sendText('hello bob');
  run(10);
  bob.session.sendText('hi ada, segmented');
  run(20);
}

function assertConversed(ada, bob) {
  assert.deepEqual(ada.peers, ['bob']);
  assert.deepEqual(bob.peers, ['ada']);
  assert.deepEqual(bob.heard, ['hello bob']);
  assert.deepEqual(ada.heard, ['hi ada, segmented']);
  for (const n of [ada, bob]) assert.equal(n.modem.status.queue, 0, 'nothing left queued');
}

test('a 44.1 kHz Console and a 48 kHz Console, crystals 200 ppm apart, still talk', () => {
  // A Mac and a PC rarely agree on a sample rate. At 44.1 kHz a 2 ms time
  // quantum rounds to 88 samples, so that node's bits are 0.2 % short, on top
  // of whatever its crystal is doing.
  const ada = consoleNode({ name: 'ada', address: 3, rate: 44100, ppm: 100 });
  const bob = consoleNode({ name: 'bob', address: 12, rate: 48000, ppm: -100 });
  const run = room([ada, bob]);

  run(0.5);
  converse(run, ada, bob);

  assertConversed(ada, bob);
});

test('a Console that joins after the first has been retrying alone for two minutes hears it and is heard', () => {
  // The usual first session: one person joins, the other takes a while. By
  // then the first node has been unacknowledged long enough to go
  // error-passive (§8.3), and the second joins in the middle of its frames.
  const ada = consoleNode({ name: 'ada', address: 3 });
  const bob = consoleNode({ name: 'bob', address: 12, joinAt: 120 });
  const run = room([ada, bob]);

  run(0.5);
  ada.session.announce();
  run(120);
  assert.equal(ada.modem.status.errorState, 'error-passive', 'ada has been talking to nobody');
  assert.equal(ada.modem.status.queue + (ada.modem.status.transmitting ? 1 : 0), 1, 'and is still trying');

  bob.session.announce();
  run(30);

  assert.deepEqual(ada.peers, ['bob']);
  assert.deepEqual(bob.peers, ['ada']);
});

test('two Consoles talk when each hears itself 20× louder than the other and clips its own microphone', () => {
  // A laptop's speaker sits centimetres from its microphone. Capture clips at
  // ±1, so the node's own tone is squared off while the peer's rides on it.
  const ada = consoleNode({ name: 'ada', address: 3 });
  const bob = consoleNode({ name: 'bob', address: 12 });
  const run = room([ada, bob], {
    gain: [[20, 1], [1, 20]],
    shape: (i, x) => Math.max(-1, Math.min(1, x)),
  });

  run(0.5);
  converse(run, ada, bob);

  assertConversed(ada, bob);
});

test('two Consoles talk with the room noise only 10 dB below the peer\'s tone', () => {
  // Wideband: uniform noise of amplitude 0.1 against a 0.25 tone. Each
  // detector listens in a band about 100 Hz wide, so it sees far better.
  const ada = consoleNode({ name: 'ada', address: 3 });
  const bob = consoleNode({ name: 'bob', address: 12 });
  const run = room([ada, bob], { noise: 0.1 });

  run(0.5);
  converse(run, ada, bob);

  assertConversed(ada, bob);
});

test('a Console whose microphone delivers nothing for its first 0.2 s still transmits', () => {
  // Capture devices take a moment to start, and until they do the worklet's
  // input has no channels at all.
  const ada = consoleNode({ name: 'ada', address: 3 });
  const bob = consoleNode({ name: 'bob', address: 12, micAfter: 0.2 });
  const run = room([ada, bob]);

  run(1);
  converse(run, ada, bob);

  assertConversed(ada, bob);
});

test('a Console recovers from its microphone dropping out for three seconds', () => {
  const ada = consoleNode({ name: 'ada', address: 3 });
  const bob = consoleNode({ name: 'bob', address: 12 });
  const run = room([ada, bob], {
    shape: (i, x, t) => (i === 1 && t >= 2 && t < 5 ? 0 : x),
  });

  run(6);
  converse(run, ada, bob);

  assertConversed(ada, bob);
});

test('a reply queued while the other Console is mid-message waits its turn without a collision',
  { todo: 'each Console hears its own recessive tone 10× louder than the other\'s dominant, past the 8.6 dB margin of §4.6, so neither withdraws; the frames collide, neither is acknowledged, and both retry until they fall out of step' },
  () => {
    // The everyday case: bob answers while ada's two-frame message is still
    // on the bus, so when it frees bob's reply and ada's second frame start in
    // the same bit. Here each laptop hears itself 10× louder than the other.
    const ada = consoleNode({ name: 'ada', address: 3 });
    const bob = consoleNode({ name: 'bob', address: 12 });
    const run = room([ada, bob], { gain: [[10, 1], [1, 10]] });
    const collisions = [];
    for (const n of [ada, bob]) n.modem.on('error-frame', (e) => collisions.push(e.detail.kind));

    run(0.5);
    ada.session.sendText('hello bob');
    run(2);
    bob.session.sendText('hi ada');
    run(20);

    assert.deepEqual(bob.heard, ['hello bob']);
    assert.deepEqual(ada.heard, ['hi ada']);
    assert.deepEqual(collisions, [], 'arbitration settled it: no frame was destroyed');
    assert.equal(ada.modem.status.stats.arbitrationsLost, 1, 'ada\'s second frame (priority 6) yielded to bob\'s reply (priority 5)');
  });

test('the same reply arbitrates cleanly when each Console hears itself no louder than the other', () => {
  const ada = consoleNode({ name: 'ada', address: 3 });
  const bob = consoleNode({ name: 'bob', address: 12 });
  const run = room([ada, bob]);
  const collisions = [];
  for (const n of [ada, bob]) n.modem.on('error-frame', (e) => collisions.push(e.detail.kind));

  run(0.5);
  ada.session.sendText('hello bob');
  run(2);
  bob.session.sendText('hi ada');
  run(20);

  assert.deepEqual(bob.heard, ['hello bob']);
  assert.deepEqual(ada.heard, ['hi ada']);
  assert.deepEqual(collisions, []);
  assert.equal(ada.modem.status.stats.arbitrationsLost, 1);
});
