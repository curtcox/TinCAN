# TinCAN

**A CAN-inspired multi-master bus that runs over sound.**

📖 **[Specification and live apps →](https://curtcox.github.io/TinCAN/)**

Two devices in the same room, with nothing but a speaker and a microphone each,
form a bus. When they transmit at the same instant, the higher-priority message
survives *intact* — resolved bit by bit by the air itself, with no collision, no
backoff, and nothing retransmitted.

That mechanism — non-destructive bitwise arbitration — is CAN's one genuinely
original idea. TinCAN is an attempt to find out whether it survives a channel
whose propagation delay is measured in milliseconds rather than nanoseconds.

It does, at 10–100 bit/s, within a couple of metres. That is a bad bit rate and
a perfectly good control bus.

> **TinCAN is not CAN.** No interoperability with any CAN, CAN FD or CAN XL
> implementation is attempted or possible. The frame format, arbitration scheme
> and error-confinement model are taken from CAN; the field widths, polynomials,
> timing and physical layer are not.

---

## What is here

| | |
|---|---|
| [`spec/tincan-1.0.md`](spec/tincan-1.0.md) | **Part 1** — physical and data link layers. Normative. |
| [`spec/transport.md`](spec/transport.md) | **Part 2** — addressing, segmented transport, application profiles. Normative. |
| [`spec/rationale.md`](spec/rationale.md) | Why it is shaped this way, what was rejected, and where the design is on thin ice. Non-normative. |
| [`src/tincan/`](src/tincan/) | Reference implementation. Dependency-free ES modules. |
| [`apps/`](apps/) | Three single-page apps: a bus analyzer, an interactive node, and an offline simulator. |
| [`test/`](test/) | 60 tests, run with Node's built-in runner. |
| [`tools/`](tools/) | The site build: a small Markdown renderer and a test-vector generator. |

## How it works, briefly

A CAN bus is a wired-AND: a node driving *dominant* overrides every node driving
*recessive*, and every transmitter reads the bus back while it drives it. A node
that sends recessive and reads dominant knows immediately that something with a
lower identifier is talking, and withdraws — having sent nothing that disturbed
the winner. Priority is resolved in the medium, per bit, for free.

TinCAN builds that wired-AND out of two sine waves:

| Bus level | Tone |
|---|---|
| **dominant** (logical `0`) | `f_D` — 4250 Hz in the default band |
| **recessive** (logical `1`) | `f_R` — 3000 Hz |
| *idle* | silence |

A bit is dominant when the fraction of in-band energy sitting at `f_D`, measured
over a window ending at the sample point, exceeds `theta_D` (0.12 by default).
Because the decision is a **ratio between two simultaneous measurements from the
same microphone**, it needs no calibration, no automatic gain control, and no
knowledge of distance.

Making recessive a *tone* rather than silence is the single most consequential
choice in the design — it is what gives echoes something to compete against,
keeps voice codecs and noise gates from squelching the channel, and makes "idle"
physically distinct from "recessive".
[The rationale explains why](spec/rationale.md#2-why-tones-rather-than-silence).

Above the tones it is CAN, with two changes forced by acoustics: an eight-bit
fixed-form `SYNC` preamble that lets contending transmitters align their clocks
before any information-bearing bit is at stake, and a two-bit acknowledgement
slot, because an acknowledging node's clock is a full propagation delay behind
the transmitter's.

## What it costs

| Profile | Bit rate | 8-octet frame | Arbitration range | For |
|---|---|---|---|---|
| `T100` | 100 bit/s | 1.2 s | ~0.2 m | bench, cable, loopback |
| `T50` | 50 bit/s | 2.5 s | ~0.3 m | two devices on a desk |
| `T25` *(default)* | 25 bit/s | 4.9 s | ~2.4 m | a room |
| `T10` | 10 bit/s | 12.3 s | ~6.9 m | a hall, or a reverberant one |
| `T5` | 5 bit/s | 24.6 s | ~3.4 m | devices with a slow audio path, such as laptops' built-in speakers and microphones |
| `T4` | 4 bit/s | 30.8 s | ~12 m | the same, further apart |
| `T2` | 2 bit/s | 61.5 s | ~45 m | the same, across a hall |

The ranges are for arbitration, and assume each device's own audio path,
speaker to microphone, takes no more than 1 ms (`T100`), 3 ms (`T50`, `T25`),
5 ms (`T10`) or 60 ms (`T5`, `T4`, `T2`). The
[Self-test](https://curtcox.github.io/TinCAN/apps/selftest/) measures that
path, and the Console uses the figure. Two nodes must also hear each other
within 8.6 dB of how loudly each hears itself to arbitrate at all (Part 1
§4.6), which distance does not help; frames from one sender at a time carry
further than the figures above.

If you want to move bytes over sound, use a packet modem —
[Wavest](https://github.com/curtcox/Wavest) and the ggwave codec underneath it
are far better at that and always will be. What they cannot give you is a shared
medium where the collision of two transmissions has a defined, useful outcome.
On a ggwave link, two simultaneous transmissions are two lost packets. On a
TinCAN bus, they are one delivered frame and one deferred frame.

## Try it

Everything is static files and ES modules, so any HTTP server will do. Module
imports do not work over `file://`, so you do need a server.

```bash
npm run dev
```

Then open <http://localhost:8080/apps/simulator/> — it needs no microphone and
no second device.

To build the published site, including the rendered specification and the
generated test-vector page:

```bash
npm run build
```

Every page shows, at the right of its top bar, the commit it was built from and
when it was deployed, and says so if a newer build has been deployed since the
page loaded. Every report the apps download records the same. To ask the live
site directly:

```bash
curl -s https://curtcox.github.io/TinCAN/version.json
```

To run the tests:

```bash
npm test
```

## Testing between real devices

Two tabs on one machine share a speaker and a microphone, which hides the
problems a bus over air actually has. The test rig puts several machines on
the LAN under one coordinator, and every device plays and records the same
audio description on a shared clock — for finding what only shows between
real machines:

```bash
npm run rig                    # starts the server; it prints the URL and join code
node tools/rig.mjs devices     # who has joined
node tools/rig.mjs send all description.json --wait
```

The description language, its limits and the wire messages are in
[spec/rig.md](spec/rig.md); the SSH host list goes in `rig-hosts.json`
(see `rig-hosts.example.json`).

There is nothing to install. That is deliberate: the implementation, the tests
and the site build are all plain ES modules and Node's own test runner, so there
is no lockfile to rot and no dependency to audit. CI enforces it.

## Using the implementation

Live, over a real microphone and speaker:

```js
import { Modem } from './src/tincan/modem.js';

const modem = new Modem({ band: 'A', profile: 'T25' });
modem.on('frame', (e) => console.log('received', e.detail.frame));
await modem.start();                        // asks for the microphone
modem.send({ id: 0x123, data: [0xde, 0xad] });
```

Offline, with no audio hardware at all — the same `Phy` and `Protocol`, over a
simulated room with propagation delay, distance attenuation, noise and reverb:

```js
import { AcousticChannel } from './src/tincan/bus.js';

const ch = new AcousticChannel({
  nodes: [{ name: 'a', x: 0, y: 0 }, { name: 'b', x: 1, y: 0 }],
});
const [a, b] = ch.protocols;
b.on('frame', ({ frame }) => console.log(frame));
a.send({ id: 0x123, data: [1, 2, 3] });
ch.run(6);                                   // six seconds of simulated air
```

Nothing but `modem.js` touches the DOM or Web Audio, so `protocol.js`, `phy.js`
and `bus.js` run unchanged in Node, in a worker, and inside an
`AudioWorkletGlobalScope` — which is where the live apps run them, because a
transmit decision is due at every bit boundary and the main thread cannot be
trusted with that deadline.

## Caveats worth reading first

- **There is no security.** Every frame is audible to the whole room, any node
  may claim any identifier, and a continuous tone denies the bus to everyone.
  See [§10](spec/tincan-1.0.md#10-security-considerations).
- **Echo cancellation breaks it.** A node must hear its own transmission to
  arbitrate at all, and AEC exists to remove exactly that signal. The apps ask
  the browser to disable it and warn you loudly when the browser declines.
- **Distance *ratios* matter more than distance.** The binding constraint is not
  how far apart nodes are but how unequal the distances are — past roughly 4:1
  the far node is silently excluded from the bus. See
  [§4.6](spec/tincan-1.0.md#46-near-far-limit) and Appendix C.1.
- **Band A is audible**, and after a while, irritating. It is the default on
  purpose: it works on every device, and a bus you can hear is a bus you can
  debug.

## Status

Draft. The specification is complete and the reference implementation passes it,
including bitwise arbitration, near-far exclusion and error confinement over the
sample-level acoustic simulation. It has not been run on a hundred real devices,
and the error-confinement rules in §8.2 are simplified from CAN's and should be
expected to need revision.
