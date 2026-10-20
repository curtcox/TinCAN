# TinCAN — Design Rationale

This document is not normative. It records why TinCAN is shaped the way it is,
what was rejected, and where the design is on thin ice. If you are implementing
TinCAN, read [Part 1](tincan-1.0.html); if you are wondering why Part 1 says
something strange, read this.

---

## 1. Why arbitration at all

Almost every acoustic data link — ggwave, Chirp, the various ultrasonic beacon
schemes, Wavest — is a **packet modem**. One device transmits a burst, other
devices try to decode it, and collisions are handled by not having any, or by
retry. That is the right design for those systems, and it goes much faster than
TinCAN does.

CAN's contribution to the world was a different answer: make the medium itself
resolve contention, bit by bit, so that a collision costs the loser nothing and
the winner nothing. The bus never carries a corrupted frame due to contention,
there is no backoff, no exponential retry, and latency for the highest-priority
message is bounded by the length of one frame rather than by the number of
contenders.

The question TinCAN asks is whether that mechanism survives contact with a
channel where "the medium" is a room, and where propagation delay is a thousand
times the bit period on a wire rather than a small fraction of it.

The answer is yes, at 10–100 bit/s, within a few metres, with one addition
(transmit hard synchronization, Part 1 §5.4) and one relaxation (a two-bit
acknowledgement slot, Part 1 §6.7).

That is not a useful bit rate for moving data. It is a perfectly useful bit rate
for control messages between devices that happen to be in the same room and have
no other way to talk to each other — which is the interesting case, because it
requires no pairing, no network, no account, and no shared infrastructure beyond
air.

## 2. Why tones rather than silence

The obvious mapping to a wired-AND bus is *dominant = tone, recessive = silence*.
It is simpler, it uses one frequency, and it makes the wired-AND property
completely obvious.

It was rejected for four reasons.

**Absolute thresholds.** With silence as recessive, the dominant decision is
"is there energy at `f_D` above some level". That level has to track distance,
gain, and microphone sensitivity. Every implementation would need its own AGC,
and two implementations with different AGC time constants would disagree about
the bus state during a long run of dominant bits.

With a recessive tone the decision becomes a *ratio* between two simultaneous
narrowband measurements taken from the same microphone in the same window. The
ratio is invariant to distance, to gain, and to anything else that scales both
tones equally. Part 1's `theta_D` is a pure number and needs no calibration.

**Reverberation.** A dominant bit's reverberant tail decays into the following
bit. Against silence it is the only thing there and will be read as dominant.
Against a full-amplitude direct-path recessive tone it has to beat that tone by
the `theta_D` margin, which it will not. The recessive tone is, in effect, a
continuous jamming signal against your own echo.

**Codecs and noise gates.** TinCAN was intended to survive a speakerphone, a
conference call, and a Bluetooth link. Every one of those has voice-oriented
processing that treats silence as an opportunity: noise gates close, comfort
noise is substituted, DTX kicks in, AGC ramps up and finds the noise floor. A
continuous tone keeps all of it quiescent. This turned out to matter more than
expected — an early sketch with silence-as-recessive was unusable over any
Bluetooth speaker.

**Carrier sense.** With silence as recessive, "bus idle" and "bus recessive" are
the same observation, and idle can only be inferred by counting bit times. With
a recessive tone they are physically distinct and carrier sense is a direct
measurement, which makes the "wait for idle" rule robust against a receiver
that joined mid-frame.

The cost is that recessive transmissions from several nodes can interfere with
each other. This turns out not to matter for correctness: the bus rule keys only
on `E_D`, and where multiple nodes transmit recessive they are by definition
transmitting the *same* bit, so cancellation degrades the denominator of the
ratio but cannot invert the decision — it can only make a recessive bit look
*more* dominant. That is a real failure mode, and it is bounded by the carrier
check (`E_R + E_D ≥ kappa · N`) which fails first and produces a clean
frame abort rather than a wrong bit.

## 3. Why two frequencies and not more

MFSK with 8 or 16 tones would multiply the bit rate by 3 or 4. It is
incompatible with arbitration: the wired-AND property requires a total order on
symbols where the "dominant" symbol survives superposition, and with more than
two symbols, superposition of two different mid-rank tones produces a spectrum
that is not any single symbol. You could define dominance by "lowest tone
present wins" and get 3-bit arbitration per symbol time, which is a genuinely
interesting idea — but the near-far margin (Part 1 §4.6) has to hold
simultaneously between every pair of tones, and the margin shrinks with the
number of levels. Two levels is the design point where the margin is largest.

A layered alternative was considered and rejected: arbitrate the identifier with
two-level signalling, then switch to MFSK for the data field once a single
transmitter is established. This works — it is exactly what CAN FD does with its
bit-rate switch — and would give roughly 4× throughput on the payload. It was
left out of 1.0 because it doubles the physical layer's surface area and because
the honest use case for TinCAN is short control messages, where the identifier
and framing dominate the frame length anyway. It is the most likely candidate
for a 2.0.

## 4. Why the SYNC field

CAN has no preamble. The falling edge of `SOF` is the synchronization reference,
and that is sufficient on a wire because every node's clock is within a fraction
of a bit of every other's already.

Over air, two things break that. First, the receiver has no continuous signal to
lock to and must decide, from a single edge, where the bit boundaries are.
Second, two nodes that decide to transmit in the same bit time may be several
milliseconds apart, which at these bit rates is a significant fraction of a bit.

The `SYNC` field of `01010101` fixes both. Four dominant-to-recessive and four
recessive-to-dominant transitions at known instants let a receiver both establish
the bit phase and *measure* `E_D` and `E_R` at times when it knows which tone
should be present — a free per-frame calibration of the ratio detector.

More importantly, `SYNC` is fixed-form and identical for every node, which means
contending transmitters are transmitting *the same bits* during it. That is what
makes transmit hard synchronization (Part 1 §5.4) possible: a late-starting node
can measure its own lateness against a signal it knows the content of, and
correct, before any information-bearing bit is at stake.

Without transmit hard sync, `PROP_SEG` would have to cover the sum of the
scheduling jitter and the round-trip propagation, which at a 40 ms bit time
would leave almost nothing for the detection window. With it, `PROP_SEG` covers
only the residual, and the range limits in Part 1 §5.2 become achievable.

## 5. Why the acknowledgement slot is two bits

In CAN the ACK slot is one bit, and it works because propagation is negligible: a
receiver samples the CRC delimiter, decides, and drives the ACK bit essentially
instantaneously on the same bit boundary the transmitter is watching.

Over air the receiver's whole bit clock is offset from the transmitter's by one
propagation delay. It cannot decide before its own CRC-delimiter sample point,
which is already `t_prop` late; its ACK tone then takes another `t_prop` to
arrive. The transmitter would be sampling, at 85 % of one bit time, a tone that
started at `2·t_prop` — fine at 1 m, marginal at 3 m, hopeless at 10 m.

Two bits costs 40 ms at `T25` and moves the constraint from "propagation must be
a small fraction of a bit" to "propagation must be less than about a bit", which
is 13 m — comfortably outside the arbitration range limit, so the ACK slot is
never the binding constraint. Making it two bits rather than making the whole bit
time longer keeps the bit rate where it is.

The transmitter is silent for both bits rather than emitting recessive, as a CAN
transmitter would. On a wire, recessive is the absence of drive and costs a
listener nothing. Over air, recessive is a tone, and the loudest tone at any
node's microphone is its own. A transmitter that kept emitting `f_R` would need
the acknowledgement to arrive within 8.6 dB of its own speaker (Part 1 §4.6),
which a peer a metre away never does. Silence also means that a transmitter
hears acknowledgements meant for someone else's frame when a near-far collision
has hidden the overlap from it; Part 1 §6.7 and §9 below cover that
cost.

## 6. Why CRC-17 and not CRC-15

CAN's CRC-15 is dimensioned for frames up to 127 bits at a bit error rate that a
twisted pair delivers. An acoustic channel is far noisier and TinCAN's frames run
to 591 bits with a 64-octet payload. CRC-17 was taken from CAN FD, which added it
for exactly the same reason — longer frames.

The initial value differs from CAN FD's (TinCAN uses 0, CAN FD sets bit 16) and
the covered range differs, because there is no interoperability to preserve and a
zero initial value is one less thing to get wrong in an independent
implementation. The consequence — that leading zero bits are not detected as
length changes — is harmless here because the frame always begins with a dominant
`SOF` inside the CRC's coverage and the length is fixed by `DLC`, which is also
covered.

## 7. Why the lone-node exception

On CAN, a node transmitting to an empty bus retransmits, fails to get an ACK,
retransmits, and eventually goes bus-off. That is correct behaviour for a vehicle
harness, where an empty bus means a broken harness.

For TinCAN, an empty bus is the *normal startup condition*. The user opens the
app on one phone, sends something, then walks over and opens it on the second
phone. If the first phone had bussed itself off in the meantime, the protocol
would be actively hostile to its own primary use case.

The exception (Part 1 §8.3) keeps such a node error-passive forever instead —
which is honest, because it genuinely has not been heard by anyone — but never
bus-off. Error-passive is also a useful thing for a user interface to surface:
"transmitting, nobody is acknowledging" is exactly the right message.

## 8. Rejected: CSMA with priority backoff

The obvious alternative MAC is carrier sense with a priority-weighted backoff:
listen, wait a number of slots derived from the message priority, transmit if
still idle. It is simpler, it works at any bit rate, and it composes with an MFSK
physical layer for 10–50× the throughput.

It was rejected because it is a different protocol that happens to reuse CAN's
frame format, and the frame format is the least interesting thing CAN invented.
Priority backoff gives *statistical* priority; CAN arbitration gives
*deterministic* priority with zero collision cost. Reproducing the latter over
air is the entire point of this exercise. A CSMA profile remains an obvious
extension for anyone who wants the throughput and not the determinism, and it
would slot in below the framing layer without disturbing Part 1 §6.

## 9. Where this is on thin ice

Honest list of the things most likely to fail in practice.

**Reverberation at the sample point.** Part 1 §4.7 argues that direct-path
recessive plus the `theta_D` margin beats a decaying dominant tail. In a live
room at 3 m, where the direct-to-reverberant ratio approaches 0 dB, that argument
gets thin. The mitigation is a slower profile, which works, but the failure is
gradual and shows up as sporadic stuff errors rather than as anything obviously
diagnosable. An implementation should surface the measured `E_D/(E_D+E_R)`
distribution so this is visible.

**Near-far.** Part 1 §4.6 gives an 8.6 dB margin, which is a 2.7:1 distance
ratio. Three devices on a table are fine. Three devices spread across a room are
not, and the failure mode is specific to *contention* — everything works until
two nodes talk at once, which makes it look intermittent and mysterious. This is
the single biggest practical limitation and no amount of protocol design removes
it; it is a property of the channel.

Worse, the severe case does not present as a collision at all. Past roughly a
4:1 distance ratio each node's own recessive tone buries the other's dominant
tone at its own microphone, so neither withdraws and neither sees a bit error;
they transmit straight through each other. The near node's frame is
acknowledged and completes, and from its point of view the bus is perfectly
healthy. The far node's frame is received by nobody, but because a transmitter
falls silent during `ACK` (§5 above), it hears the acknowledgements for the
near node's frame and completes too. Both report success; one frame is lost and
no counter anywhere records it. Part 1 Appendix C.1 works this through.

An earlier draft kept the transmitter emitting recessive during `ACK`, and then
this case was noisy: the far node's own tone masked the acknowledgements, so it
saw acknowledgement errors and retried. But the same masking defeats every
acknowledgement on real hardware, where a device's own speaker is 20–30 dB
louder at its own microphone than any peer. A protocol that only reports near-far
exclusion by never working at all was the wrong trade.

**Audio I/O latency.** `t_slop` in Part 1 §5.6 is treated as a constant. On real
systems it is neither constant nor accurately reported — Bluetooth adds 100–200
ms, some Android devices add tens of milliseconds of unreported buffering, and
browser `AudioContext` latency estimates are approximate. Latency does not break
frame reception (the receiver syncs to what it hears), but it does eat directly
into the arbitration budget, and a node with an unexpectedly long output path
will lose arbitrations it should win and win ones it should lose. Measuring
loopback latency at startup is strongly advisable and is why the `T100` profile
exists — it is short enough that a device failing to arbitrate at `T100` while
succeeding at `T25` tells you the latency budget is the problem.

**Half-duplex hardware.** Some devices — many Bluetooth headsets, some
speakerphones — will not run the microphone and speaker simultaneously, or apply
acoustic echo cancellation that removes exactly the self-monitoring signal
arbitration depends on. AEC is the worst case: it is designed to subtract your
own transmitted signal from what you hear, which is precisely what a TinCAN node
must not do. Implementations MUST disable echo cancellation, noise suppression,
and automatic gain control on the capture path (`echoCancellation: false`,
`noiseSuppression: false`, `autoGainControl: false` in
`getUserMedia` constraints) and SHOULD warn the user when the browser declines.

**Nobody has run this on a hundred nodes.** The error-confinement rules are
simplified from CAN's and have not been exercised anywhere near the corner cases
CAN's were written for. Expect Part 1 §8.2 to need revision.

## 10. Relationship to Wavest and ggwave

[Wavest](https://github.com/curtcox/Wavest) and the ggwave library it builds on
solve the adjacent problem well: get a packet of bytes from one device to another
over sound, quickly, with strong error correction, across a wide range of
hardware. If your problem is "send this string to that phone", use them.

TinCAN deliberately does not compete there. It gives up an order of magnitude of
throughput and all of ggwave's error correction to buy one thing ggwave does not
have and structurally cannot have: **a shared medium with deterministic
priority, where the collision of two transmissions has a defined, useful
outcome**. On a ggwave link, two simultaneous transmissions are two lost packets.
On a TinCAN bus, they are one delivered frame and one deferred frame.

The two are complementary. A plausible system uses TinCAN for coordination —
who is present, who may talk, what the current state is — and hands off to a
fast packet modem for bulk transfer once the bus has decided whose turn it is.
