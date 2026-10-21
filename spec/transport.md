# TinCAN 1.0 — Part 2: Addressing, Transport, and Application Profiles

**Status:** Draft
**Version:** 1.0.0-draft
**Date:** 2026-08-04

[Part 1](tincan-1.0.html) defines a bus that delivers 0–64 octets under an
11- or 29-bit identifier, with priority resolved by that identifier. It says
nothing about who is talking, to whom, or about what. Part 2 fills that in.

Part 1 is usable without Part 2. Part 2 is a convention layer: two devices that
agree on Part 1 alone will interoperate at the frame level, and a Part 1
analyzer will decode their frames perfectly. What Part 2 buys is the ability to
say "node 7 sent a 300-byte text message to node 12" instead of "some frames went
past".

---

## 1. Identifier structure

### 1.1 Base identifiers (11-bit) — broadcast

```
 bit  10  9  8 | 7  6  5 | 4  3  2  1  0
     +---------+---------+---------------+
     |  PRIO   |  TOPIC  |    SOURCE     |
     +---------+---------+---------------+
        3 bits    3 bits      5 bits
```

| Field | Bits | Meaning |
|---|---|---|
| `PRIO` | 3 | Priority class, 0 = highest. |
| `TOPIC` | 3 | What kind of message this is (§1.3). |
| `SOURCE` | 5 | Node address of the sender, 0–31. |

Because `SOURCE` occupies the least-significant bits, **two nodes can never have
identical arbitration fields**, so the pathological collision of Part 1 §7.3 is
impossible by construction between conforming nodes. The cost is that a node's
address also acts as a tiebreak: node 3 beats node 9 when both send the same
priority and topic in the same bit time. Addresses SHOULD therefore be assigned
without regard to importance, and importance expressed in `PRIO`.

### 1.2 Extended identifiers (29-bit) — directed

```
 bit 28 27 26 | 25 .. 21 | 20 ....... 13 | 12 ........ 5 | 4 3 2 1 0
    +---------+----------+---------------+---------------+-----------+
    |  PRIO   |   TYPE   |  DESTINATION  |    SOURCE     |   FLAGS   |
    +---------+----------+---------------+---------------+-----------+
       3 bits    5 bits       8 bits           8 bits       5 bits
```

| Field | Bits | Meaning |
|---|---|---|
| `PRIO` | 3 | Priority class, 0 = highest. |
| `TYPE` | 5 | Message type (§1.3). |
| `DESTINATION` | 8 | Destination node address; `0xFF` = broadcast. |
| `SOURCE` | 8 | Source node address, 0–254. |
| `FLAGS` | 5 | See §1.4. |

Extended identifiers use 8-bit addresses; base identifiers use 5-bit addresses.
A node using both MUST ensure its 5-bit base address equals its 8-bit extended
address when the latter is ≤ 31, and MUST NOT transmit base frames at all when
its extended address exceeds 31.

Note that directed frames still go over a shared bus and are heard by everyone.
`DESTINATION` is a filtering hint, not a privacy mechanism.

### 1.3 Topics and types

Base `TOPIC` (3 bits):

| `TOPIC` | Name | Meaning |
|---|---|---|
| `0` | `CONTROL` | Bus-level control and error reporting. |
| `1` | `PRESENCE` | Announcements and heartbeats (§4). |
| `2` | `EVENT` | One-shot notifications; fire and forget. |
| `3` | `STATE` | Periodic state publication; latest value wins. |
| `4` | `TEXT` | Human-readable text (§5.1). |
| `5` | `DATA` | Application binary data. |
| `6` | `TRANSPORT` | Segmented transport (§3). |
| `7` | `PRIVATE` | Reserved for private use; never assigned by this spec. |

Extended `TYPE` (5 bits): values `0`–`7` have the same meanings as `TOPIC`
above. Values `8`–`23` are reserved. Values `24`–`31` are private use.

### 1.4 Extended flags

| Bit | Name | Meaning when `1` |
|---|---|---|
| 4 | `SEG` | This frame is part of a segmented transfer (§3). |
| 3 | `REQ_ACK` | Sender requests an application-level acknowledgement (§3.4). |
| 2 | `ENC` | Payload is encrypted or otherwise opaque; analyzers should not attempt to decode it. |
| 1–0 | reserved | MUST be `0`. |

`FLAGS` occupies the least-significant bits of the identifier, so flag settings
affect priority. A frame with `SEG` set is *lower* priority than the same frame
without it, which is the desired ordering: single-frame messages should overtake
the middle of a long transfer.

### 1.5 Priority classes

| `PRIO` | Name | Intended use |
|---|---|---|
| `0` | `EMERGENCY` | Stop, fault, safety. Should be rare. |
| `1` | `HIGH` | Time-critical control. |
| `2` | `CONTROL` | Ordinary commands. |
| `3` | `PRESENCE` | Announcements, joins, leaves. |
| `4` | `NORMAL` | Default for application traffic. |
| `5` | `TEXT` | Interactive text. |
| `6` | `BULK` | Segmented transfers, file-like data. |
| `7` | `IDLE` | Background; may be starved indefinitely. |

At the bit rates of Part 1 a single 8-octet frame occupies about five seconds of
bus at `T25`. Priority is therefore not a fine-grained scheduling knob — it is
the difference between "this gets through during a busy transfer" and "this
waits for it to finish". Use `BULK` for anything long, or the bus will feel dead.

---

## 2. Node addresses

Addresses are not assigned by any authority. A node picks one and defends it.

### 2.1 Claiming

On startup a node:

1. selects a candidate address, either configured by the user or drawn uniformly
   at random from 1–30 (base) or 1–254 (extended);
2. listens for `T_claim` — RECOMMENDED 10 s or 3 frame times, whichever is
   longer — and notes the source address of every frame it hears;
3. transmits an `ANNOUNCE` (§4.1) from the candidate address;
4. if it hears an `ANNOUNCE` or any frame from that address that it did not send
   within the following `T_claim`, it selects a new candidate and returns to
   step 3.

Address `0` is reserved for a node that has not yet claimed one and MUST NOT be
used for anything other than `ANNOUNCE` during claiming. Address `31` (base) and
`0xFF` (extended) are the broadcast destination and MUST NOT be claimed.

### 2.2 Collisions

Two nodes that end up with the same address will interleave frames with identical
identifiers, which Part 1 §7.3 warns cannot be arbitrated. In practice they will
both see bit errors and both go error-passive. A node that observes repeated bit
errors on frames carrying its own source address, at times when it was not
transmitting, MUST treat this as an address collision and restart the claiming
procedure with a new random address after a random backoff of 1–5 s.

---

## 3. Segmented transport

A single frame carries at most 8 octets usefully (Part 1 §6.5 discourages larger
`FDF` frames because they monopolise the bus). Longer messages use a segmented
transport modelled on ISO 15765-2 (ISO-TP), simplified.

The first payload octet of every `TRANSPORT` frame is a protocol control
information (PCI) octet:

```
 bit  7  6  5  4 | 3  2  1  0
     +-----------+-----------+
     |    TYPE   |  see below|
     +-----------+-----------+
```

| `TYPE` | Name | Low nibble | Remaining payload |
|---|---|---|---|
| `0` | `SINGLE` | length 0–7 | that many octets |
| `1` | `FIRST` | total length bits 11..8 | total length bits 7..0, then first 6 octets |
| `2` | `CONSECUTIVE` | sequence number mod 16 | up to 7 octets |
| `3` | `FLOW` | flow status | block size, separation time |
| `4`–`15` | reserved | | |

### 3.1 Single frame

```
+------+---------------------------+
| 0x0L | L octets of payload       |
+------+---------------------------+
```

`L` ≤ 7. Used for any message that fits.

### 3.2 Multi-frame transfer

```
sender                                receiver
  |                                       |
  |-- FIRST (total length, 6 octets) ---->|
  |                                       |
  |<---------- FLOW (CTS, bs, st) --------|
  |                                       |
  |-- CONSECUTIVE seq=1 (7 octets) ------>|
  |-- CONSECUTIVE seq=2 (7 octets) ------>|
  |               ...                     |
  |-- CONSECUTIVE seq=n (≤7 octets) ----->|
```

`FIRST` carries a 12-bit total length, so a transfer is at most 4095 octets — 
about 40 minutes at `T25`, which should be read as a warning rather than a
feature.

Sequence numbers start at 1 for the first `CONSECUTIVE` frame and wrap 15 → 0.
A receiver that observes a gap MUST abandon the transfer and MAY send a `FLOW`
with status `ABORT`.

A `CONTROL` message too long for one frame (§9.1) is sent as a broadcast
transfer of the same PCI-prefixed frames in extended identifiers with `TYPE` =
`CONTROL`, `DESTINATION = 0xFF` and `SEG` set; the reassembled contents are the
message, opcode first. It is not text, and `TRANSPORT` frames stay text only (§5.1).

For broadcast transfers (`DESTINATION = 0xFF`, or any base-identifier transfer)
the `FLOW` exchange is omitted and the sender proceeds directly from `FIRST` to
`CONSECUTIVE` frames, separated by at least `ST_min`.

### 3.3 Flow control

```
+------+------------+------------+
| 0x3S | block size | sep. time  |
+------+------------+------------+
```

| `S` | Status |
|---|---|
| `0` | `CTS` — continue sending |
| `1` | `WAIT` — sender must wait for another `FLOW` |
| `2` | `ABORT` — transfer is cancelled |

`block size` is the number of `CONSECUTIVE` frames the sender may send before
waiting for another `FLOW`; `0` means "send them all". `separation time` is the
minimum gap between consecutive frames, in units of 100 ms, 0–255.

Given Part 1's bit rates, the sender's frames are already seconds apart. A
`separation time` above 0 is only useful when the receiver is doing something
slow with each block, and a `block size` above 0 is only useful when the receiver
is memory-constrained. Both SHOULD default to 0.

### 3.4 Application acknowledgement

A frame with `REQ_ACK` set requests that the destination reply with a `CONTROL`
frame carrying a single octet `0x06` (ACK) or `0x15` (NAK) and the same
identifier fields with `SOURCE` and `DESTINATION` exchanged.

Part 1's `ACK` field already tells the sender that *somebody* received the frame
intact. `REQ_ACK` tells it that the *intended recipient* did, and that the
application above accepted it. Use it sparingly: each acknowledgement is a whole
frame and costs a full arbitration cycle.

---

## 4. Presence

### 4.1 ANNOUNCE

`TOPIC = PRESENCE`, `PRIO = 3`, payload:

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | Protocol version, `0x10` for TinCAN 1.0 |
| 1 | 1 | Capability flags |
| 2 | ≤6 | Callsign, UTF-8, not NUL-terminated |

Capability flags:

| Bit | Meaning when `1` |
|---|---|
| 7 | Full node (extended IDs, remote frames, `FDF`) |
| 6 | Supports segmented transport (§3) |
| 5 | Supports text profile (§5.1) |
| 4 | Listener only — will never transmit again after this frame |
| 3 | Supports side links (§8) |
| 2 | Takes part in band tests (§9) |
| 1–0 | reserved |

A node SHOULD transmit `ANNOUNCE` on joining and MAY repeat it at an interval of
not less than 60 s. Given the audibility of band A, implementations SHOULD
default periodic announcements to **off**.

### 4.2 Departure

A node leaving the bus cleanly SHOULD transmit an `ANNOUNCE` with capability bit
4 set and an empty callsign. There is no keepalive; a node that stops
transmitting simply stops being heard, and peers SHOULD age entries out after an
implementation-defined interval rather than declaring failure.

---

## 5. Application profiles

### 5.1 Text

`TOPIC`/`TYPE` = `TEXT` (4). Payload is UTF-8, with no framing of its own. Text
longer than 7 octets uses the segmented transport of §3 with `TOPIC` =
`TRANSPORT` and the transfer's contents interpreted as UTF-8.

A message MUST NOT be split across a UTF-8 code point boundary in a way that
requires the receiver to buffer for correctness — that is, receivers MUST
reassemble the whole transfer before decoding, and MUST NOT decode partial
transfers as text.

### 5.2 State

`TOPIC`/`TYPE` = `STATE` (3). The identifier names the state variable; the
payload is its current value. Repeated transmission is expected, and receivers
keep only the most recent. This is the classic CAN usage pattern and it suits an
acoustic bus well, because a lost frame costs one update rather than a
retransmission.

### 5.3 Raw

`TOPIC`/`TYPE` = `DATA` (5). Payload is opaque octets. Analyzers should render
hex and nothing more.

### 5.4 Private

`TOPIC` = `7` and `TYPE` ≥ 24 are permanently unassigned. Use them for anything;
expect no interoperability and expect analyzers to show hex.

---

## 6. Interaction with Part 1 error confinement

A node driven bus-off by Part 1 §8.3 MUST report this to the application and
MUST NOT silently recover in a way that loses queued frames without saying so.

An application-layer retry loop sitting on top of Part 1's automatic
retransmission can produce an unbounded queue on a bus that is failing: each
frame takes seconds, and a failing bus takes longer. Implementations SHOULD bound
their transmit queue and SHOULD drop oldest-first for `STATE` topics and
newest-first for `EVENT` topics.

---

## 7. Worked example

Node 7 (callsign `ada`) sends the text `hello, bus` — 10 octets — to node 12 over
base identifiers.

```
1.  ID = PRIO 3, TOPIC 1 (PRESENCE), SOURCE 7   ->  0b011_001_00111 = 0x327
    data = 10 E0 'a' 'd' 'a'          (version 0x10, caps 0xE0, callsign "ada")

2.  ID = PRIO 6, TOPIC 6 (TRANSPORT), SOURCE 7  ->  0b110_110_00111 = 0x6C7
    data = 10 0A 'h' 'e' 'l' 'l' 'o' ','
           ^^ ^^ FIRST, total length 0x00A = 10
    
3.  ID = 0x6C7
    data = 21 ' ' 'b' 'u' 's'
           ^^ CONSECUTIVE, seq 1
```

Three frames of 5, 8 and 5 octets — 99, 123 and 99 bits, plus stuffing — about
13 seconds of bus at `T25` to deliver ten characters. This is the correct order
of magnitude for TinCAN and the reason Part 1 §1.3 lists throughput as a
non-goal.

---

## 8. Side links

A bus runs at the speed its slowest, furthest pair of nodes allows, and every
node shares it. Two nodes that could do better between themselves — closer
together, or with faster audio paths — may agree on a **side link**: a second
TinCAN bus, on another band and usually a faster profile, that only they use.
The main bus carries on exactly as before, and both nodes stay on it.

### 8.1 Messages

Side links are negotiated on the main bus, the one bus both nodes are known to
share, with `CONTROL` frames (`TOPIC = 0`, `PRIO = 2`) from the sender's base
address. The first payload octet of a `CONTROL` frame is an opcode:

| Opcode | Name | Payload after the opcode |
|---|---|---|
| `0x06` | `ACK` | §3.4 |
| `0x15` | `NAK` | §3.4 |
| `0x20` | `LINK_PROPOSE` | to, link, band, profile, t_slop |
| `0x21` | `LINK_ACCEPT` | proposer, link, t_slop |
| `0x22` | `LINK_DECLINE` | proposer, link, reason |
| `0x23` | `LINK_CLOSE` | peer, link, reason |
| `0x24`–`0x27` | band tests | §9 |

| Field | Size | Meaning |
|---|---|---|
| to | 1 | The node invited, or `31` for any node that wants to join |
| proposer, peer | 1 | The node the message answers or is addressed to |
| link | 1 | Chosen by the proposer; with the proposer's address it names the link |
| band | 1 | Part 1 §4.2 band ID, `0x01`–`0x07` |
| profile | 1 | Part 1 §5.2 profile ID, `0x10`–`0x16` |
| t_slop | 1 | The sender's measured t_slop (Part 1 §5.6) in ms, 0–254; `255` if unknown |

`LINK_DECLINE` reasons: `1` band not usable here, `2` timing — the profile
cannot cover both nodes' t_slop, or is too fast for the band (Part 1 §4.2), `3` busy — the band is in use by the main
bus or another link, or cannot share the devices with it (§8.2), `4` refused.

`LINK_CLOSE` reasons: `0` finished, `1` no contact (§8.3), `2` errors.

### 8.2 Choosing a band and profile

A side link MUST use a band other than the main bus's, and other than any link
the proposer has heard accepted and not closed. Each bit edge on one bus spills
switching energy across the main lobe of the other's edge window, so two buses
can share devices only when every tone of each band is far enough from every
frequency the other's detector measures (its tones and guards):

```
gap  ≥  1250 Hz · (1 ms / TQ)        TQ the shorter of the two buses'
```

the same rule a band's own tones obey (Part 1 §4.2). Bands A and C come within
250 Hz of each other, so both buses MUST then use `TQ` of at least 5 ms (`T10`
and slower). Band C's recessive tone is band E's upper guard, so C and E MUST
NOT share devices at all. Every other pair may share at any profile both bands
allow. The same holds between a proposed link and any link already in use. In
the reference simulation A and C both at `T25` corrupt each other's frames, and
C and E do at every profile; at `T10` A and C do not, nor does E with A, B or
D, nor does any other pairing.

The profile MUST cover both nodes' t_slop (Part 1 §5.6). The proposer knows
only its own; the invited node, knowing both, MUST decline with reason `2` if
the profile cannot cover the larger of the two at any distance, and MAY decline
if it judges the distance between them too great.

Bands B and F need a sample rate of at least 44.1 and 48 kHz (Part 1 §4.2) and
a speaker and microphone that work above 17 and 20 kHz; a node that cannot run
the band MUST decline with reason `1`.

### 8.3 Opening, checking and closing

When a node sends or hears `LINK_ACCEPT` for a link it belongs to, it starts a
second node on the link's band and profile, from the same address and with the
same callsign, and keeps its main-bus node running unchanged. Both nodes'
transmit levels add at the speaker; implementations SHOULD keep their sum
below full scale.

The proposer then transmits an `ANNOUNCE` (§4.1) on the link, and the other
node answers with its own. A link is **up** for a node once it has received a
frame from the other on it. A link that is not up within

```
T_link = max(10 s, 4 × the time of a 5-octet frame at the link's profile)
```

of the `LINK_ACCEPT` being delivered — for the node that sent it, when its
transmission completes; for the proposer, when it receives it — SHOULD be
closed with `LINK_CLOSE` reason `1`: the main bus can hear both nodes, but the
link evidently cannot. Counting from the decision to accept instead is wrong:
on a slow main bus the acceptance can wait minutes to be sent, and in a live
test the accepting node gave up before the proposer had heard it.

Either node may close the link at any time with `LINK_CLOSE` on the main bus,
and then stops its link node. A node that leaves the main bus closes its links
first. Nodes that hear `LINK_ACCEPT` and `LINK_CLOSE` between others SHOULD
track which bands are in use, so as not to propose them.

### 8.4 Why the main bus carries the control

The link is negotiated where both nodes can already hear each other, and closed
there too, so a link that fails — out of range on its band, or a band one
device's speaker cannot reproduce — is noticed and ended on a bus that still
works. Nothing about a side link changes the main bus: its frames, timing and
arbitration are the same whether or not any links are open.

---

## 9. Band tests

Which bands work, and between which nodes, depends on each device's speaker
and microphone and on where the devices are. A node that has measured its own
(Part 1 §4.2) still does not know whether another node hears it on band F, or
how unevenly. A **band test** answers that for every node at once: each node
that joins plays each band's two tones in its own time slot, every node
listening measures what arrives, and the nodes that played then report what
they heard on the main bus. At the end, every node that listened throughout
has, for each band, how loudly and how evenly each player was heard by each
player, and by itself.

### 9.1 Messages

| Opcode | Name | Payload after the opcode |
|---|---|---|
| `0x24` | `TEST_REQUEST` | test, bands, window |
| `0x25` | `TEST_JOIN` | requester, test, bands |
| `0x26` | `TEST_START` | test, bands, players (1–5 addresses) |
| `0x27` | `TEST_REPORT` | requester, test, noise, levels (§9.4) |

| Field | Size | Meaning |
|---|---|---|
| test | 1 | Chosen by the requester; with its address it names the test |
| bands | 1 | Bit *n*−1 set for the band with Part 1 §4.2 ID *n*: in a request and start, the bands tested; in a join, those of them the joining node can play and hear |
| window | 1 | Seconds the requester waits for joins, 1–255 |
| requester | 1 | The node that requested the test |
| players | 1 each | The nodes that play, in slot order, the requester first |

`TEST_REQUEST`, `TEST_JOIN` and `TEST_START` are `CONTROL` frames like those of
§8.1. `TEST_REPORT` does not fit one frame and is sent segmented (§3.2).

### 9.2 Requesting and joining

The requester chooses the bands: those it can run (Part 1 §4.2), less the
bands of any side links it knows to be open, which the test would disturb. It
SHOULD NOT request a test while it has a side link open itself.

A node that hears `TEST_REQUEST` and wants to play joins with `TEST_JOIN`
before the window ends, giving the bands of the request it can run. A node
that only listens — a listener-only device, or one that chooses not to play —
does not join, and still measures (§9.3).

When the window has passed since its request was delivered, the requester
sends `TEST_START` naming itself and up to four of the nodes that joined, in
the order their joins arrived. A join heard after `TEST_START` is ignored.

### 9.3 The test

Every node that hears `TEST_START`, or sends it, takes the end of that frame's
last bit as it heard it as time 0, and from then until the test's end MUST NOT
start a frame on the main bus. The test's own tones fall on the main band too,
so a node SHOULD also stop its main-bus receiver for that time, so that it
neither decodes them nor signals errors over them; the bus is idle when it
stops and when it resumes.

The test is laid out from time 0 in seconds. With *P* players and *B* bands:

| From | To | What |
|---|---|---|
| 0 | 1.0 | Nothing: nodes stop their main-bus receivers and prepare |
| 1.0 | 2.2 | Quiet: every node measures its noise at each tested tone |
| 2.2 + 1.5 *k* | 3.7 + 1.5 *k* | Slot *k* = *p* · *B* + *b*: player *p* plays band *b* (lowest ID first) |
| 2.2 + 1.5 *P B* | + 0.5 | Late sound dies away; the test ends |

In its slot a player plays the band's recessive tone from 0.1 s to 0.7 s and
its dominant tone from 0.8 s to 1.4 s, each at the level it transmits frames
at, with 10 ms raised-cosine onsets and ends. It SHOULD start each tone early
by its own speaker-to-microphone latency, so that the tones arrive when every
node expects them. A player stays silent in the slots of bands it cannot play.

Every node, player or not, measures the level of each tone over the middle
0.3 s of the time it is played (0.25–0.55 s and 0.95–1.25 s into the slot),
which leaves 150 ms either way for the nodes' differing latencies; and its
noise at each tone over three such 0.3 s windows in the quiet, starting at
1.15 s, as the root-mean-square of the three. Levels are the amplitude of the
tone at the microphone relative to full scale, measured with a Hann window.

At 4 players and 7 bands the test takes 44.7 s. A band test is loud: every
band but B and F is audible, at the level of a frame.

### 9.4 Reporting

When the test ends, each player sends `TEST_REPORT`:

| Octets | What |
|---|---|
| 1 | requester |
| 1 | test |
| 2 *B* | its noise at each band's recessive and dominant tone |
| 2 *B* (*P* − 1) | the level of each of those tones from each other player, in slot order |

Each level is one octet: −2 × its level in dBFS, rounded and limited to 0–254
(0.5 dB steps down to −127 dBFS); `255` where this node did not measure it —
a band it cannot hear. A player that did not play a band shows as that band's
noise. The level of a player's tones at its own microphone is not reported.

Reports from 4 players on 7 bands are 59 octets each: nine frames, or about a
minute at `T25` apiece, during which the main bus is otherwise free.

From the reports and its own measurements, every node that listened has, for
each band, each player's two tones as heard by every player and by itself.
The weaker tone's height above the listener's noise says whether the band
carries between that pair at all; the dominant tone's level less the
recessive's is the tone tilt of Part 1 §4.6, which the pair's arbitration
margin must absorb. A listener-only node's own measurements stay with it.

