/**
 * Side links — Part 2 §8: two nodes agree, on the main bus, to run a second
 * bus between themselves on another band, without disturbing the first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Session, CONTROL, DECLINE, CLOSE, BROADCAST_BASE, buildLinkMessage, parseControl, describeControl,
  assessProposal, linkTimeout, parseAnnounce, buildAnnounce,
} from '../src/tincan/transport.js';
import { bandsCompatible } from '../src/tincan/params.js';
import { AcousticChannel, mulberry32 } from '../src/tincan/bus.js';

test('side-link messages round-trip through their CONTROL payloads', () => {
  const propose = buildLinkMessage({ op: CONTROL.LINK_PROPOSE, to: 12, link: 7, band: 'C', profile: 'T5', slopMs: 61.6 });
  assert.deepEqual(Array.from(propose), [0x20, 12, 7, 0x03, 0x14, 62]);
  assert.deepEqual(parseControl(propose), {
    op: 0x20, name: 'LINK_PROPOSE', to: 12, link: 7, band: 'C', profile: 'T5', slopMs: 62,
  });
  assert.equal(describeControl(propose), 'LINK_PROPOSE #7 to 12: band C, T5, t_slop 62 ms');

  const accept = buildLinkMessage({ op: CONTROL.LINK_ACCEPT, proposer: 3, link: 7, slopMs: null });
  assert.deepEqual(Array.from(accept), [0x21, 3, 7, 255], 'an unknown t_slop is 255');
  assert.equal(parseControl(accept).slopMs, null);

  const decline = buildLinkMessage({ op: CONTROL.LINK_DECLINE, proposer: 3, link: 7, reason: DECLINE.TIMING });
  assert.match(describeControl(decline), /cannot cover both audio paths/);
  const close = buildLinkMessage({ op: CONTROL.LINK_CLOSE, peer: 12, link: 7, reason: CLOSE.NO_CONTACT });
  assert.match(describeControl(close), /LINK_CLOSE #7 with 12: no contact/);

  assert.equal(parseControl(Uint8Array.of(0x20, 1, 2)), null, 'truncated');
  assert.equal(parseControl(Uint8Array.of(0x06)).name, 'ACK', 'Part 2 §3.4 still parses');
  assert.ok(parseAnnounce(buildAnnounce('ada')).sideLinks, 'nodes announce that they support side links');
});

test('a proposal is judged by band, by what can share the devices, and by both audio paths', () => {
  const laptop = { mainBand: 'A', mainProfile: 'T2', slopMs: 60 };
  assert.equal(assessProposal({ band: 'C', profile: 'T5', slopMs: 62 }, laptop), null, 'two laptops, C at T5');
  assert.equal(assessProposal({ band: 'A', profile: 'T5', slopMs: 62 }, laptop), DECLINE.BUSY, 'the main bus\'s band');
  assert.equal(assessProposal({ band: 'C', profile: 'T5', slopMs: 62 }, { ...laptop, bandsInUse: ['C'] }),
    DECLINE.BUSY, 'a band another link holds');
  assert.equal(assessProposal({ band: 'C', profile: 'T25', slopMs: 2 }, { mainBand: 'A', mainProfile: 'T25', slopMs: 2 }),
    DECLINE.BUSY, 'A and C cannot both run T25 on the same devices');
  assert.equal(assessProposal({ band: 'D', profile: 'T25', slopMs: 2 }, { mainBand: 'A', mainProfile: 'T25', slopMs: 2 }),
    null, 'A and D can');
  assert.equal(assessProposal({ band: 'C', profile: 'T10', slopMs: 62 }, laptop), DECLINE.TIMING,
    'T10 cannot cover two 60 ms audio paths');
  assert.equal(assessProposal({ band: 'C', profile: 'T10', slopMs: null }, { ...laptop, slopMs: null }), null,
    'with neither t_slop known, try it: the link check will tell');
  assert.equal(assessProposal({ band: 'B', profile: 'T5', slopMs: 62 }, { ...laptop, canUseBand: (b) => b !== 'B' }),
    DECLINE.BAND, 'a band this device cannot run');

  assert.equal(bandsCompatible('A', 'T10', 'C', 'T10'), true);
  assert.equal(bandsCompatible('A', 'T25', 'C', 'T10'), false);
  assert.equal(bandsCompatible('A', 'T100', 'B', 'T100'), true);
  assert.equal(linkTimeout('T100'), 10, 'at least ten seconds');
  assert.ok(Math.abs(linkTimeout('T5') - 79.2) < 1e-9, 'four 5-octet frames');
});

/** Sessions on an ideal bus: every frame sent reaches every other node. */
function idealBus(addresses) {
  const nodes = [];
  for (const address of addresses) {
    const handlers = new Set();
    const protocol = {
      on: (ev, fn) => { if (ev === 'frame') handlers.add(fn); },
      send: (frame) => { for (const n of nodes) if (n.protocol !== protocol) for (const fn of n.handlers) fn({ frame }); },
    };
    nodes.push({ protocol, handlers, session: new Session(protocol, { address, callsign: `n${address}` }) });
  }
  return nodes.map((n) => n.session);
}

function events(session, names) {
  const seen = [];
  for (const name of names) session.on(name, (d) => seen.push([name, d]));
  return seen;
}

test('a proposal, an acceptance and a close, as each node sees them', () => {
  const [a, b, c] = idealBus([3, 12, 20]);
  const atA = events(a, ['link-open', 'link-declined', 'link-closed']);
  const atB = events(b, ['link-proposal', 'link-open', 'link-closed']);
  const atC = events(c, ['link-proposal']);

  const rec = a.proposeLink({ to: 12, band: 'C', profile: 'T5', slopMs: 60 });
  assert.equal(atB.length, 1);
  const [, { link: offer }] = atB[0];
  assert.deepEqual([offer.proposer, offer.link, offer.band, offer.profile, offer.slopMs], [3, rec.link, 'C', 'T5', 60]);
  assert.equal(atC.length, 0, 'a proposal to someone else is not offered to c');
  assert.deepEqual(c.bandsInUse(), [], 'proposed is not in use');

  b.acceptLink(offer, 62);
  assert.equal(atB.at(-1)[0], 'link-open');
  assert.deepEqual(atA.map(([n]) => n), ['link-open']);
  assert.equal(rec.peer, 12);
  assert.equal(rec.peerSlopMs, 62);
  assert.deepEqual(c.bandsInUse(), ['C'], 'c heard it accepted, and will not propose C');

  b.closeLink(offer, CLOSE.FINISHED);
  assert.deepEqual(atA.at(-1)[0], 'link-closed');
  assert.equal(atA.at(-1)[1].by, 12);
  assert.deepEqual(c.bandsInUse(), [], 'and heard it closed');

  // A refusal reaches the proposer with its reason.
  const second = a.proposeLink({ to: BROADCAST_BASE, band: 'B', profile: 'T5' });
  assert.equal(atC.length, 1, 'an open proposal is offered to every node');
  c.declineLink(atC[0][1].link, DECLINE.BAND);
  assert.equal(atA.at(-1)[0], 'link-declined');
  assert.equal(atA.at(-1)[1].reason, DECLINE.BAND);
  assert.equal(second.state, 'declined');
});

test('two laptops agree on the main bus, then talk on a side link, while the main bus carries on', () => {
  // Three slow devices (60 ms audio paths) share band A at T2. Two of them,
  // a metre apart, open a side link on band C at T5, two and a half times
  // faster, with a second Phy each on the same speaker and microphone.
  const ch = new AcousticChannel({
    sampleRate: 16000, band: 'A', profile: 'T2', noise: 0.0005, random: mulberry32(3),
    deviceLatencyMs: 60, selfDelayMs: 0.5,
    nodes: [
      { name: 'a', x: 0, y: 0, device: 'A' },
      { name: 'b', x: 1, y: 0, device: 'B' },
      { name: 'c', x: 0.5, y: 0.8, device: 'C' },
      { name: 'a-link', x: 0, y: 0, device: 'A', band: 'C', profile: 'T5' },
      { name: 'b-link', x: 1, y: 0, device: 'B', band: 'C', profile: 'T5' },
    ],
  });
  const [pa, pb, pc, pa2, pb2] = ch.protocols;
  const a = new Session(pa, { address: 3, callsign: 'ada' });
  const b = new Session(pb, { address: 12, callsign: 'bob' });
  const c = new Session(pc, { address: 20, callsign: 'cyd' });

  // Each node answers its proposals as the Console does.
  const here = { mainBand: 'A', mainProfile: 'T2', slopMs: 60 };
  b.on('link-proposal', ({ link }) => {
    const reason = assessProposal(link, here);
    if (reason) b.declineLink(link, reason); else b.acceptLink(link, 60);
  });
  // On opening, each starts its link node: the proposer announces first, the
  // other answers when it hears it (§8.3).
  const linkSessions = { a: new Session(pa2, { address: 3, callsign: 'ada' }), b: new Session(pb2, { address: 12, callsign: 'bob' }) };
  const opened = [];
  a.on('link-open', () => { opened.push('a'); linkSessions.a.announce(); });
  b.on('link-open', () => opened.push('b'));
  linkSessions.b.on('presence', ({ address }) => { if (address === 3) linkSessions.b.announce(); });
  const up = new Set();
  linkSessions.a.on('presence', ({ address }) => { if (address === 12) up.add('a'); });
  linkSessions.b.on('presence', ({ address }) => { if (address === 3) up.add('b'); });

  const offer = a.proposeLink({ to: 12, band: 'C', profile: 'T5', slopMs: 60 });
  assert.ok(ch.runUntil(() => opened.length === 2, 400), 'both ends opened the link');
  assert.ok(ch.runUntil(() => up.size === 2, linkTimeout('T5')), 'each heard the other on the link within T_link');

  // Now text both ways on the link, and a frame on the main bus at once.
  const linkText = [];
  linkSessions.b.on('message', ({ text }) => linkText.push(text));
  const mainText = [];
  a.on('message', ({ text }) => mainText.push(text));
  linkSessions.a.sendText('hello, bob');
  c.sendText('hi all');
  assert.ok(ch.runUntil(() => linkText.length === 1 && mainText.length === 1, 600), 'both arrived');
  assert.deepEqual(linkText, ['hello, bob']);
  assert.deepEqual(mainText, ['hi all']);

  // Neither bus noticed the other.
  for (const [name, p] of Object.entries({ a: pa, b: pb, c: pc, 'a-link': pa2, 'b-link': pb2 })) {
    const s = p.stats;
    assert.equal(s.bitErrors + s.stuffErrors + s.crcErrors + s.formErrors + s.ackErrors, 0, `${name}: no errors`);
  }
  assert.deepEqual(c.bandsInUse(), ['C'], 'the third node knows band C is taken');

  a.closeLink(offer);
  assert.ok(ch.runUntil(() => b.links.get(`3:${offer.link}`).state === 'closed', 200), 'closed on the main bus');
});
