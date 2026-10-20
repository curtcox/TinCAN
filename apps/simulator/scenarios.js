/**
 * Scenario definitions for the TinCAN simulator.
 *
 * Kept free of any DOM reference so that the test suite can run every scenario
 * headlessly and assert that what each one claims in its description actually
 * happens — a demo that quietly stops demonstrating its point is worse than no
 * demo at all.
 */

import { nearFarMarginDb } from '../../src/tincan/params.js';

/**
 * A scenario is a set of nodes plus a script of (simulated time, action) pairs.
 * Contention is always staged the way §7.1 says it really arises: a primer
 * frame occupies the bus, and the contenders queue while it is in flight, so
 * they all start in the same bit time when the interframe space ends.
 */
export const SCENARIOS = {
  contention: {
    name: 'Two contenders — the basic case',
    profile: 'T25',
    duration: 20,
    description:
      'Two nodes queue a frame while a third is transmitting. When the bus frees they '
      + 'start in the same bit time. Watch the identifier fields overlap bit for bit until '
      + '0x205 reads dominant where it sent recessive, withdraws, and lets 0x201 through '
      + 'undamaged. The loser retransmits nothing it had already sent.',
    nodes: [
      { name: 'primer', x: 0.4, y: -0.4 },
      { name: 'lo', x: 0, y: 0 },
      { name: 'hi', x: 0.8, y: 0 },
    ],
    script: [
      { t: 0.4, do: (n) => n.primer.send({ id: 0x7ff, data: [0] }) },
      { t: 2.0, do: (n) => { n.lo.send({ id: 0x201, data: [0x01] }); n.hi.send({ id: 0x205, data: [0x02] }); } },
    ],
  },

  cascade: {
    name: 'Priority cascade — four at once',
    profile: 'T25',
    duration: 45,
    description:
      'Four nodes queue simultaneously with unrelated identifiers. Each round of arbitration '
      + 'costs exactly one contention, and the frames come out in strict numerical identifier '
      + 'order with no retries and no collisions. That is the property CAN was built for, and '
      + 'the thing a CSMA backoff scheme cannot give you.',
    nodes: [
      { name: 'primer', x: 0.25, y: -0.5 },
      { name: 'n0', x: 0, y: 0 },
      { name: 'n1', x: 0.6, y: 0 },
      { name: 'n2', x: 0, y: 0.6 },
      { name: 'n3', x: 0.6, y: 0.6 },
    ],
    script: [
      { t: 0.4, do: (n) => n.primer.send({ id: 0x7ff, data: [0] }) },
      { t: 2.0, do: (n) => {
        n.n0.send({ id: 0x140, data: [0] });
        n.n1.send({ id: 0x030, data: [1] });
        n.n2.send({ id: 0x2c0, data: [2] });
        n.n3.send({ id: 0x0a0, data: [3] });
      } },
    ],
  },

  nearfar: {
    name: 'Near-far exclusion — the real limit',
    profile: 'T10',
    duration: 45,
    noise: 0.0005,
    description:
      'The far node holds the lower identifier and ought to win. It is 25× further away than '
      + 'the near node, well outside the ' + nearFarMarginDb().toFixed(1) + ' dB margin of §4.6, '
      + 'so each node\'s own recessive tone buries the other\'s dominant tone. Neither withdraws. '
      + 'The near node\'s frame is delivered. The far node\'s frame reaches nobody, but the far '
      + 'node is silent during ACK (§6.7), hears the acknowledgements meant for the near node\'s '
      + 'frame, and completes anyway: both report success and one frame is silently lost. This '
      + 'is what a badly-planned segment looks like.',
    nodes: [
      { name: 'primer', x: 1.0, y: 0 },
      { name: 'near', x: 0.15, y: 0 },
      { name: 'far', x: 4.0, y: 0 },
    ],
    script: [
      { t: 0.4, do: (n) => n.primer.send({ id: 0x7ff, data: [0] }) },
      { t: 4.0, do: (n) => { n.far.send({ id: 0x001, data: [1] }); n.near.send({ id: 0x7f0, data: [2] }); } },
    ],
  },

  lone: {
    name: 'A lone node — nobody is listening',
    profile: 'T25',
    duration: 30,
    description:
      'One node, one frame, an empty room. It hears its own transmission back perfectly and '
      + 'decodes it, but nobody drives the acknowledgement slot, so it signals an '
      + 'acknowledgement error and retries. Watch TEC climb and the node go error-passive — '
      + 'and note that it never reaches bus-off, because §8.3 makes an explicit exception for '
      + 'exactly this case. It is the normal state of the first device you switch on.',
    nodes: [{ name: 'solo', x: 0, y: 0 }],
    script: [{ t: 0.4, do: (n) => n.solo.send({ id: 0x111, data: [0xaa] }) }],
  },

  noisy: {
    name: 'A noisy, reverberant room',
    profile: 'T10',
    duration: 30,
    noise: 0.02,
    rt60: 0.6,
    description:
      'The same two-node exchange with a loud room and a 0.6 s reverberation time. The slower '
      + 'T10 profile buys enough decay time between the sample points that the ratio detector '
      + 'still separates the tones. Turn the noise up further, or switch to T25, and you can '
      + 'watch it fall apart — usually as stuff errors first, which is the signature §4.7 '
      + 'warns about.',
    nodes: [
      { name: 'a', x: 0, y: 0 },
      { name: 'b', x: 1.2, y: 0.4 },
    ],
    script: [
      { t: 0.4, do: (n) => n.a.send({ id: 0x0c0, data: [0x55, 0xaa] }) },
      { t: 12, do: (n) => n.b.send({ id: 0x0c1, data: [0x0f, 0xf0] }) },
    ],
  },

  chatty: {
    name: 'Two chatty nodes — sustained traffic',
    profile: 'T25',
    duration: 60,
    description:
      'Both nodes queue a burst of frames at once and keep the bus saturated. Every time the '
      + 'interframe space ends, both start, and the lower identifier wins — so node A\'s traffic '
      + 'systematically beats node B\'s at equal priority. This is the starvation risk that '
      + 'Part 2 §1.1 warns about when it puts the source address in the low bits of the '
      + 'identifier.',
    nodes: [
      { name: 'a', x: 0, y: 0 },
      { name: 'b', x: 0.7, y: 0 },
    ],
    script: [
      { t: 0.4, do: (n) => { for (let i = 0; i < 5; i++) n.a.send({ id: 0x200 + i * 2, data: [i] }); } },
      { t: 0.4, do: (n) => { for (let i = 0; i < 5; i++) n.b.send({ id: 0x201 + i * 2, data: [i] }); } },
    ],
  },
};
