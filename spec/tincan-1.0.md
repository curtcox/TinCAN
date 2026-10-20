# TinCAN 1.0 — Part 1: Physical and Data Link Layers

**Status:** Draft
**Version:** 1.0.0-draft
**Date:** 2026-08-04

TinCAN is an acoustic multi-master serial bus for arbitrary device-to-device
communication. Its frame format, arbitration scheme, error confinement model and
general shape are taken from ISO 11898 CAN. Its physical layer is sound.

> **TinCAN is not CAN.** No attempt is made at bit-level, frame-level, or
> electrical interoperability with any CAN, CAN FD, or CAN XL implementation.
> Field widths, polynomials, and timing differ. Do not bridge a TinCAN segment to
> a vehicle bus and expect anything sensible to happen.

---

## 1. Scope

### 1.1 What this specifies

TinCAN defines two layers:

- A **physical layer** that carries a single, bus-wide, wired-AND binary signal
  over an acoustic channel — air, an audio cable, a speakerphone leg of a
  conference call, or anything else that moves an audio waveform from one or more
  transmitters to one or more receivers.
- A **data link layer** providing framing, addressing by message identifier,
  non-destructive bitwise arbitration, CRC-protected delivery, in-band
  acknowledgement, and error confinement.

Addressing conventions, segmented transport, and application profiles are
specified separately in [Part 2](transport.html).

### 1.2 Design goals

1. **Non-destructive arbitration.** When two devices start talking at the same
   instant, the higher-priority message survives intact. The loser does not
   corrupt it and does not need to retransmit anything it already sent.
2. **No master, no clock line, no configuration.** A device joins a bus by
   listening and then talking. There is no pairing, association, or address
   assignment step.
3. **Any device with a speaker and a microphone.** No ultrasonic-capable
   hardware is required; no special drivers; no root.
4. **Auditable.** The entire protocol state is recoverable by a passive listener
   with one microphone. There are no hidden channels, no per-link keys, no
   negotiated parameters.

### 1.3 Non-goals

- Throughput. TinCAN's fastest defined profile is 100 bit/s. Bitwise arbitration
  over a channel whose propagation delay is measured in milliseconds is
  intrinsically slow, and TinCAN chooses arbitration over speed. If you want a
  fast acoustic link, use a packet modem such as ggwave and give up arbitration.
- Confidentiality. See [§10](#10-security-considerations).
- CAN interoperability. See the note above.
- Full-duplex operation. TinCAN is half-duplex per node and single-channel per
  bus segment.

### 1.4 Terminology

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**,
**SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** are to be
interpreted as described in RFC 2119.

| Term | Meaning |
|---|---|
| **Bus** | A shared acoustic space. All nodes within it hear each other. |
| **Node** | A device attached to the bus. Has a transmitter and a receiver. |
| **Bit time** | The nominal duration of one bus bit, `T_bit`. |
| **Time quantum** | The bit-timing granularity, `TQ`. `T_bit` is an integer number of `TQ`. |
| **Dominant** | Logical `0`. Overrides recessive on the bus. |
| **Recessive** | Logical `1`. Yields to dominant. |
| **Idle** | No node is transmitting; no carrier is present. Distinct from recessive. |
| **Sample point** | The instant within a bit time at which the bus level is decided. |
| **Frame** | A complete transmission unit. |
| **Segment** | The set of nodes that can hear one another. |

Bit values are written as `0` (dominant) and `1` (recessive) throughout, matching
CAN's polarity. Multi-bit fields are transmitted most-significant bit first.

---

## 2. Architecture

```
+-------------------------------------------------------+
|  Application                                          |
+-------------------------------------------------------+
|  Part 2: addressing, segmented transport, profiles    |
+=======================================================+
|  Data link  §6 framing  §7 arbitration  §8 errors     |   Part 1
+-------------------------------------------------------+
|  Bit timing and synchronization            §5         |   (this
+-------------------------------------------------------+   document)
|  Physical: tone signalling and detection   §4         |
+=======================================================+
|  Acoustic channel (air / cable / codec / VoIP)        |
+-------------------------------------------------------+
```

A TinCAN node is a state machine driven by two clocks that must be kept in
agreement: its own bit clock, and the bus's bit clock as recovered from observed
signal transitions.

---

## 3. The bus abstraction

The entire protocol rests on one property, which §4 realises acoustically:

> **Wired-AND rule.** At any instant, the level of the bus is dominant if *any*
> node is transmitting dominant, and recessive if *every* transmitting node is
> transmitting recessive. If no node is transmitting, the bus is idle.

Two consequences follow, and everything else in TinCAN is built on them.

1. **A transmitter can detect that it lost.** A node that transmits recessive and
   observes dominant knows, without any negotiation, that some other node is
   transmitting and that the other node's bit is `0` where its own was `1`.
2. **A receiver can inject one bit into someone else's frame.** A node that
   transmits dominant during a slot that the frame's transmitter left open
   changes what the transmitter reads back. This is how acknowledgement (§6.7)
   and error signalling (§8) work with no reverse channel and no extra frames.

---

## 4. Physical layer

### 4.1 Signalling

A transmitting node emits exactly one continuous sinusoid for the whole of every
bit time it transmits:

| Bit | Tone emitted |
|---|---|
| Recessive (`1`) | `f_R` |
| Dominant (`0`) | `f_D` |

An idle node emits nothing. The one exception inside a frame is the `ACK` field,
during which the frame's own transmitter emits nothing either (§6.7).

The wired-AND rule is realised by **energy detection at `f_D`**: the presence of
the dominant tone is what makes the bus dominant, and no combination of recessive
transmitters can remove it. Recessive is signalled by an actual tone rather than
by silence for three reasons:

- it gives receivers a continuous amplitude reference against which the dominant
  threshold is set, which makes the decision a **ratio** rather than an absolute
  level and therefore immune to distance, gain drift, and AGC;
- it makes "idle" and "recessive" physically distinguishable, so carrier sense is
  real rather than inferred from a bit counter;
- it keeps energy on the channel continuously, which stops voice-oriented codecs,
  noise gates and automatic gain control from treating a frame's recessive runs
  as silence and squelching them.

Nodes MUST NOT emit both tones simultaneously.

### 4.2 Band plans

A bus operates in exactly one band. All nodes on a segment MUST be configured
with the same band. Band identifiers are one octet and are carried only in
out-of-band configuration; TinCAN has no in-band band negotiation.

| ID | Name | `f_R` | `f_D` | Guard low | Guard high | Notes |
|---|---|---|---|---|---|---|
| `0x01` | **A — audible** | 3000 Hz | 4250 Hz | 2500 Hz | 4750 Hz | Default. Works on every speaker and microphone. Audible and mildly irritating. |
| `0x02` | **B — near-ultrasonic** | 17250 Hz | 18500 Hz | 16750 Hz | 19000 Hz | Requires ≥44.1 kHz sampling and hardware with usable response above 17 kHz. Inaudible to most adults. Range is short and highly directional. |
| `0x03` | **C — low** | 1000 Hz | 2250 Hz | 500 Hz | 2750 Hz | For small transducers and poor high-frequency response. Most exposed to ambient noise (speech, HVAC, traffic). |
| `0x04` | **D — line** | 6000 Hz | 7250 Hz | 5500 Hz | 7750 Hz | For a physical audio cable between devices, or a loopback device. Not intended for air. |
| `0x00`, `0x05`–`0xEF` | reserved | | | | | |
| `0xF0`–`0xFF` | experimental | | | | | Available for private use; MUST NOT be assumed interoperable. |

Tone frequencies are chosen so that no harmonic of `f_R` falls on `f_D` or on
either guard frequency. A harmonic of the *recessive* tone landing on the
dominant bin would allow a single loud recessive transmitter to force the bus
dominant, which would break arbitration; the reverse case is harmless.

Implementations MUST NOT round tone frequencies to a DFT bin grid derived from
their own sample rate. The detector in §4.4 has no such requirement.

### 4.3 Transmitter requirements

- **Level.** A node SHOULD transmit both tones at the same amplitude, and SHOULD
  hold that amplitude constant for the duration of a frame. Segments in which
  nodes' received levels differ by more than the near-far margin of §4.6 will not
  arbitrate correctly.
- **Phase.** The transmitted waveform SHOULD be phase-continuous across bit
  boundaries within a tone, and each tone's phase SHOULD be generated from a
  free-running oscillator rather than reset per bit, to limit spectral splatter
  into the guard bins.
- **Switching.** A transmitter switching between tones at a bit boundary MUST
  complete the transition within `SYNC_SEG` (§5.1). A raised-cosine cross-fade of
  0.5–1.0 ms is RECOMMENDED; a hard discontinuity produces a broadband click that
  raises the measured noise floor for every node in earshot.
- **Turn-on and turn-off.** The first and last bit of a transmission SHOULD be
  ramped in and out over ≤ 1 ms.
- **Self-monitoring.** A transmitting node MUST continue to receive and decode
  the bus for the entire duration of its own transmission. This is not optional;
  arbitration (§7.2), acknowledgement (§6.7), and bit-error detection (§8.1) all
  depend on a transmitter reading back what it and everyone else put on the bus.

### 4.4 Receiver

A receiver estimates, once per **detector hop** `H`, the power at four
frequencies over a window of length `W` ending at the current instant:

| Symbol | Frequency | Meaning |
|---|---|---|
| `E_R` | `f_R` | recessive tone power |
| `E_D` | `f_D` | dominant tone power |
| `N_lo` | guard low | noise reference |
| `N_hi` | guard high | noise reference |

A Goertzel filter is RECOMMENDED: four filters of length `W · f_s` samples cost
far less than an FFT and impose no bin-alignment constraint on `f_R` and `f_D`.

#### 4.4.1 The noise floor

`N` is a **tracked estimate**, not an instantaneous measurement. A single-bin
power estimate has two degrees of freedom regardless of window length, so the raw
value of `(N_lo + N_hi) / 2` fluctuates by many decibels from hop to hop; a
detector that thresholds against it directly will declare carrier on noise
several times a second and will never keep a bit clock. Implementations MUST
smooth it:

```
if not carrier or noise_carrier:
    N  <-  N + alpha * ( (N_lo + N_hi)/2 - N )
```

with `alpha` corresponding to a time constant of **at least 2 bit times**
(4 bit times RECOMMENDED). An estimate that has only ever seen digital silence
(`N = 0`) SHOULD be seeded from the first non-zero reading instead.

The estimate MUST be frozen while a transmission is present. Guard frequencies
sit 500 Hz from the tones, which is inside the main lobe of a short detection
window, so a transmission would otherwise inflate the estimated floor and
desensitise the detector for as long as the frame lasts.

It MUST NOT be frozen by noise, though, and a frozen estimate can fall behind the
noise. A microphone that delivers digital silence — while the capture device
starts, or when it drops out — drives `N` to zero or near it, and when sound
returns every window then exceeds `kappa * N`. The node reads carrier forever,
never sees the bus idle (§4.5), and never transmits. A tone puts most of its
energy in its own bin and little in the guard bins; noise puts about as much in
each. So a "carrier" is treated as noise, `noise_carrier`, when

```
E_R + E_D  <=  4 * (N_lo + N_hi)/2
```

and that has held for most of the last bit time. A tone stays above 7 times the
guard power even in the shortest edge window (T100's 2 ms); white noise sits
near 2. The bit-time requirement matters: a window that straddles a tone
switching on or off is briefly broadband too.

An implementation using two window lengths — a short one for edge timing and
`W` for the sample point (§5.5) — may track one estimate and scale it between
them: for white noise the expected single-bin power is proportional to the sum of
the squared window coefficients.

Until the estimate has converged (RECOMMENDED: 8 window lengths of input),
a receiver MUST report no carrier rather than guess.

#### 4.4.2 The bus state

The **bus state** at any instant is determined as:

```
carrier  =  (E_R + E_D)  >=  kappa * N
dominant =  carrier  AND  ( E_D / (E_R + E_D)  >=  theta_D )

if      not carrier  ->  IDLE       (treated as recessive by the bit engine)
else if dominant     ->  DOMINANT
else                 ->  RECESSIVE
```

| Parameter | Default | Range | Meaning |
|---|---|---|---|
| `kappa` | 8.0 (9.0 dB) | 2.0 – 64.0 | carrier-sense margin above the noise floor |
| `theta_D` | 0.12 | 0.02 – 0.50 | fraction of in-band energy at `f_D` required to declare dominant |
| `W` | `PHASE_SEG1` (§5.1) | ≥ 3 ms | detection window |
| `H` | ≤ 1 `TQ` | | detector hop; sets edge-timing resolution |

`W` is deliberately tied to `PHASE_SEG1` rather than fixed: the window then
begins exactly when the propagation segment ends and closes exactly at the sample
point, so it never overlaps the interval in which the bus level is still settling
after a transition.

Receivers MUST NOT apply hysteresis to the dominant decision. Hysteresis
lengthens the effective decay of a dominant bit into the recessive bit that
follows it, which is the exact failure mode reverberation already causes (§4.7).

#### 4.4.3 Edge debouncing

A recessive-to-dominant *edge* restarts or adjusts the bit clock (§5.3–§5.5), so
a single noisy hop must not be able to produce one. An edge SHALL be declared
only after the dominant condition has held for `D` consecutive hops, with `D ≥ 2`
(2 RECOMMENDED). The onset estimate is then corrected back by `(D − 1) · H` as
well as by the window's own group delay (§5.5).

This is separate from the sample-point decision, which is never debounced: the
level at the sample point is whatever a single measurement over `W` says it is.

### 4.5 Bus states

| State | Condition | Duration |
|---|---|---|
| **Idle** | no carrier | ≥ 3 bit times after a complete interframe space, or ≥ 11 bit times otherwise |
| **Carrier** | carrier present | — |
| **Dominant** | carrier present and `E_D` fraction ≥ `theta_D` | — |
| **Recessive** | carrier present and `E_D` fraction < `theta_D` | — |

A node that has not yet observed a complete, valid frame MUST wait for 11
consecutive bit times of idle before transmitting. A node that has just seen a
frame end normally MAY transmit after the 3-bit interframe space (§6.8).

### 4.6 Near-far limit

At the moment of arbitration, one node transmits `f_D` and one or more others
transmit `f_R`. For the receiver in question — which may be either contender, or
a third party — the dominant decision holds when

```
E_D / (E_R + E_D)  >=  theta_D
```

that is, when

```
E_D  >=  E_R * theta_D / (1 - theta_D)
```

With the default `theta_D = 0.12`, that is `E_D ≥ 0.136 · E_R`: an amplitude
ratio of 0.37, or **−8.6 dB**. In words:

> The dominant transmitter may arrive at any given receiver up to 8.6 dB weaker
> than the *sum* of all simultaneous recessive transmitters, and arbitration will
> still resolve correctly at that receiver.

This is the tightest real constraint in TinCAN and it is what limits practical
segment size. Consequences:

- Received level falls as `1/r` in the direct field. An 8.6 dB margin is a
  distance ratio of about 2.7:1 in the free field. A segment in which the
  furthest pair is more than roughly 2.7× the distance of the closest pair is at
  risk of arbitration failure at some receiver, even though all nodes hear all
  frames perfectly well.
- Lowering `theta_D` widens the margin (`theta_D = 0.05` gives −12.8 dB, a 4.4:1
  ratio) at the cost of a higher false-dominant rate from noise and reverberation.
- Nodes SHOULD normalise their transmit level and SHOULD NOT run automatic gain
  control on the transmit path.

Arbitration failure is **noisy, not silent** — but it does not look the way one
might expect, and implementations should recognise the signature.

When the imbalance is moderate, one contender misses a dominant bit, both keep
transmitting, and the frame dies of a bit error at one transmitter and a CRC or
form error everywhere else. Both retry. This costs frames, not correctness.

When the imbalance is severe — beyond roughly a 4:1 distance ratio — something
qualitatively different happens: **each node's own recessive tone buries the
other's dominant tone at its own microphone**, so *neither* withdraws and neither
detects a bit error. Both transmit complete frames straight through each other.
The near node's frame is received and acknowledged normally by everyone that can
hear it. The far node's frame is received by nobody — but because a transmitter
is silent during `ACK` (§6.7), the far node hears the acknowledgements meant for
the near node's frame and **completes as though its own frame had been
delivered**.

Severe near-far exclusion is therefore **silent**: both transmitters report
success and one frame is lost. Neither node's counters show anything. The only
evidence is at the application layer — a frame that was sent and never arrived —
and at an analyzer, which decodes one frame where two transmitters each claim to
have sent one. That is a near-far exclusion, not interference, and no amount of
retrying fixes it — the far node must move closer or the segment must be
re-planned. An analyzer SHOULD display received level per source
so this is diagnosable rather than mysterious.

### 4.7 Reverberation

The recessive tone that follows a dominant bit competes with the reverberant tail
of that dominant bit. The dominant decision is a ratio, so the requirement is
that at the sample point

```
E_D(reverberant tail)  <  theta_D / (1 - theta_D)  *  E_R(direct)
```

Three factors make this achievable:

1. the sample point sits 80–85 % of the way through the bit, giving the tail a
   full `PROP_SEG + PHASE_SEG1` to decay;
2. the direct-path recessive tone is typically 6–10 dB above the reverberant
   field at conversational distances;
3. `theta_D` gives another 8.6 dB.

Nonetheless, reverberation is the practical limit on bit rate in a live room.
In spaces with RT60 above roughly 0.4 s, implementations SHOULD select a slower
bit-timing profile (§5.2). A quantitative guide: the `T25` profile tolerates
RT60 up to about 0.5 s at 1–2 m; `T10` extends that to about 1.5 s.

---

## 5. Bit timing and synchronization

### 5.1 Nominal bit time

The bit time is divided into four segments, in the manner of CAN, each an
integer number of time quanta:

```
|<--------------------------- T_bit --------------------------->|
|  SYNC_SEG  |     PROP_SEG     |  PHASE_SEG1   |   PHASE_SEG2   |
|            |                  |               |                |
|            |<-- settling  --->|<---- detection window W ------>|
                                                ^
                                                sample point
```

| Segment | Length | Purpose |
|---|---|---|
| `SYNC_SEG` | exactly 1 `TQ` | The nominal instant of the bit boundary. Transitions are expected here. Transmitters complete their tone switch within it. |
| `PROP_SEG` | 1 – 32 `TQ` | Covers twice the worst-case propagation delay across the segment, plus transmitter and receiver latency. |
| `PHASE_SEG1` | 1 – 16 `TQ` | Detection window. Lengthened or shortened by resynchronization. |
| `PHASE_SEG2` | ≥ `SJW`, ≥ 2 `TQ` | Processing time between the sample point and the next bit boundary. Shortened by resynchronization. |

`T_bit = SYNC_SEG + PROP_SEG + PHASE_SEG1 + PHASE_SEG2`.
The **sample point** is the boundary between `PHASE_SEG1` and `PHASE_SEG2`.
The **detection window** `W` is `PHASE_SEG1`, ending at the sample point.
The **synchronization jump width** `SJW` is 1 – 4 `TQ` and MUST be ≤ `PHASE_SEG2`.

### 5.2 Bit-timing profiles

All nodes on a segment MUST use the same profile. Like the band, the profile is
configured out of band.

| ID | Name | `TQ` | `T_bit` | Rate | `SYNC` | `PROP` | `PS1` | `PS2` | `SJW` | Sample pt | Max range |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `0x10` | `T100` — bench | 1 ms | 10 ms | 100 bit/s | 1 | 3 | 4 | 2 | 1 | 80 % | ~0.2 m |
| `0x11` | `T50` — desk | 2 ms | 20 ms | 50 bit/s | 1 | 4 | 3 | 2 | 1 | 80 % | ~0.3 m |
| `0x12` | `T25` — room *(default)* | 2 ms | 40 ms | 25 bit/s | 1 | 10 | 6 | 3 | 2 | 85 % | ~2.4 m |
| `0x13` | `T10` — hall | 5 ms | 100 ms | 10 bit/s | 1 | 10 | 6 | 3 | 2 | 85 % | ~6.9 m |
| `0x14` | `T5` — slow | 10 ms | 200 ms | 5 bit/s | 1 | 14 | 3 | 2 | 2 | 90 % | ~3.4 m |
| `0x15` | `T4` — far | 10 ms | 250 ms | 4 bit/s | 1 | 19 | 3 | 2 | 2 | 92 % | ~12 m |
| `0x16` | `T2` — farther | 20 ms | 500 ms | 2 bit/s | 1 | 19 | 3 | 2 | 2 | 92 % | ~45 m |
| `0x1F` | custom | | | | | | | | | | |

Max range is computed in §5.6, and every profile's depends on the audio
latency of the devices using it: `PROP_SEG` must cover twice a device's latency
as well as twice the distance. `T100` and `T50` assume a near-zero audio path,
`T25` one of a few milliseconds, `T10` up to about 20 ms.

`T5` exists for devices whose own audio path is slow. A laptop's built-in
speaker and microphone, driven from a browser, measured 58–63 ms from speaker to
microphone, against the 26 ms the browser reported; the rest is in the
device's own output and input processing, out of the page's reach. Two such
devices need more than 120 ms of `PROP_SEG` before distance is counted at all,
more than any faster profile has, however close they are. `T5` gives 140 ms
of its 200 ms bit to `PROP_SEG`, leaving a 30 ms detection window, as `T10` has.
Implementations SHOULD measure the real loopback latency, as the reference
self-test does, and choose the fastest profile whose `PROP_SEG` covers it with
room for the distance between nodes (§5.6).

`T4` and `T2` stretch `T5` for distance, with the same slow audio path in mind:
`PROP_SEG` grows to 190 ms and 380 ms, while the detection window stays 30 ms
and 60 ms. Their range figures are for arbitration timing alone. Two
contending nodes must also hear each other within the near-far margin of §4.6,
which distance does not help: in the reference simulation, two nodes 5 m apart
collide unnoticed at every profile, each hearing itself 14 dB louder than the
other. Frames from one sender at a time carry further than the range figure,
because the receivers' acknowledgement has the second `ACK` bit to arrive in
(§6.7).

### 5.3 Hard synchronization

On the first dominant edge observed after an idle bus — the leading edge of
`SYNC` bit 0 (§6.2) — every receiving node MUST restart its bit clock so that
`SYNC_SEG` of bit 0 contains that edge. No `SJW` limit applies to hard
synchronization.

### 5.4 Transmit hard synchronization

This has no CAN analogue and exists because acoustic propagation delay is four
to six orders of magnitude larger than on a wire.

Two nodes that decide to transmit in the same bit time start their `SYNC` fields
up to one propagation delay apart. Because the `SYNC` field is fixed-form and
identical for every node (§6.2), the later starter can measure its own lateness
directly:

> During the `SYNC` field, a transmitting node that observes a dominant edge
> **earlier** than the start of its own `SYNC` bit 0 by δ, where δ is less than
> half a bit time, MUST advance its own transmit bit clock by δ for the remainder
> of the frame. Its `SYNC` bit 0 is thereby shortened by δ.

After this correction, contending transmitters are aligned to within the
detector's edge resolution `H` rather than to within a propagation delay, which
is what makes bitwise arbitration usable at conversational distances at all.
A node MUST apply this correction at most once per frame, and MUST NOT apply it
after the `SYNC` field has ended.

A node that observes a dominant edge *later* than its own `SYNC` bit 0 does
nothing: it started first, and the other node will correct itself.

### 5.5 Resynchronization

Within a frame, on every recessive-to-dominant edge that does not fall within
`SYNC_SEG`, a receiving node MUST resynchronize:

- edge arrives **late** (after `SYNC_SEG`, before the sample point): lengthen
  `PHASE_SEG1` of the current bit by the phase error, clamped to `SJW`;
- edge arrives **early** (after the sample point of the previous bit): shorten
  `PHASE_SEG2` of the current bit by the phase error, clamped to `SJW`.

Bit stuffing (§6.9) guarantees a recessive-to-dominant edge at least once every
10 bits, bounding the accumulated clock error a node must absorb.

A node MUST NOT resynchronize on an edge it produced itself while it is the only
transmitter, and MUST NOT resynchronize during the `SYNC` field (§5.4 governs
there instead).

### 5.6 Range limit

`PROP_SEG` must cover the round trip, because a node that transmits recessive
must observe a competing node's dominant bit before its own sample point, and the
competitor's bit clock is offset from its own by everything between them.

A node synchronizes to edges as it *hears* them (§5.3–§5.5), so its bit clock
lags the node it synchronized to by that node's output latency, the
propagation delay, and its own input latency. What it sends back — an
acknowledgement, or a dominant bit in arbitration — then takes its own output
latency, the propagation delay and the first node's input latency to be heard.
In the first node's own time the answer arrives

```
t_prop + t_prop + t_slop(first) + t_slop(answering)
```

after the bit began, and its detection window must not open before then. As
in CAN, where the propagation segment is twice the sum of bus, transmitter and
receiver delays, the audio path is counted at both ends:

```
PROP_SEG  >=  2 * t_prop_max  +  2 * t_slop

t_prop_max = d_max / c ,   c = 343 m/s

t_slop = detector hop H + output latency + input latency + tone switch time,
         the largest of any node on the segment
```

Solving for distance:

```
d_max = (PROP_SEG - 2 * t_slop) * c / 2
```

The `Max range` column of §5.2 assumes `t_slop` of 3 ms for `T50`/`T25`, 1 ms for
`T100` (bench/loopback, low-latency audio path), 5 ms for `T10`, and 60 ms for
`T5`, `T4` and `T2`, whose reason to exist is a slow audio path.

Earlier drafts of this section counted `t_slop` once. The reference
simulation, with each node's audio latency applied to every path it sends or
hears on, bears out counting it twice: at 1 m, `T10` delivers between two nodes
of 20 ms latency and fails between two of 30 ms, and `T25` delivers at 5 ms and
fails at 10 ms, when a third node close to the transmitter acknowledges too.
The transmitter fails first, reading that acknowledgement's late tail in the
`ACK` delimiter as a form error. An acknowledgement from further away is
drowned there by the transmitter's own recessive tone, which is why frames from
one sender at a time carry further than `d_max`; arbitration does not.

Implementations SHOULD measure their own loopback latency and reduce the
advertised range accordingly. The latency an `AudioContext` reports is not
enough: it covers the browser's buffers but not the device's own processing,
which on the laptop described in §5.2 was more than half of the total. Exceeding `d_max` does not stop
frames being received; it stops *arbitration* from resolving correctly, which
shows up as an elevated rate of CRC and bit errors under contention only.

---

## 6. Frame formats

### 6.1 Frame types

| Frame | Purpose | §|
|---|---|---|
| **Data frame** | carries 0–64 octets of payload | 6.3 |
| **Remote frame** | requests that some node transmit a data frame with the same identifier | 6.4 |
| **Error frame** | signals a detected error and destroys the frame in progress | 8.4 |
| **Overload frame** | requests extra delay before the next frame | 6.6 |

Data and remote frames are separated from what follows by the interframe space
(§6.8).

### 6.2 SYNC field

Every data and remote frame is preceded by an 8-bit fixed-form `SYNC` field:

```
bit index   0  1  2  3  4  5  6  7
value       0  1  0  1  0  1  0  1
            D  R  D  R  D  R  D  R
```

The `SYNC` field is **not** bit-stuffed and is **not** included in the CRC. It
serves four purposes:

1. its leading edge is the hard-synchronization reference (§5.3);
2. it gives contending transmitters a fixed-form interval in which to align their
   transmit clocks (§5.4);
3. its four dominant and four recessive bits let a receiver measure `E_D` and
   `E_R` at known times and validate its thresholds before any information-
   bearing bit arrives;
4. it lets receivers with automatic gain control settle before `SOF`.

A receiver MUST read carrier at every `SYNC` sample point, recessive bits
included: recessive is a tone (§4.1), so silence where `SYNC` expects recessive is
a mismatch. A receiver that observes a `SYNC` field which does not match
`01010101` at every sample point MUST abandon the frame and return to waiting for
idle. It MUST NOT generate an error frame; a malformed `SYNC` is far more likely
to be ambient noise than a protocol violation.

One mismatch is handled differently. If a receiver entered `SYNC` on a single
dominant bit read while idle, in `INTERMISSION`, or in suspend transmission, and
then reads **no carrier** at `SYNC` bit 1, that dominant bit was noise crossing
the carrier threshold. The receiver MUST disregard it and resume exactly where it
was, counting both bits as the silent bits they were — in particular it MUST NOT
lose its place in the interframe space, its warm idle (§4.5), or its suspend
count. Otherwise a single noisy bit in a gap between frames costs the node the
next frame.

### 6.3 Data frame

**Base format** (`IDE = 0`), 11-bit identifier:

| Field | Bits | Value | Stuffed | In CRC |
|---|---|---|---|---|
| `SYNC` | 8 | `01010101` | no | no |
| `SOF` | 1 | `0` | yes | yes |
| `ID` | 11 | identifier, MSB first | yes | yes |
| `RTR` | 1 | `0` = data, `1` = remote | yes | yes |
| `IDE` | 1 | `0` = base | yes | yes |
| `FDF` | 1 | `0` = classic, `1` = extended payload | yes | yes |
| `r0` | 1 | `0`, reserved | yes | yes |
| `DLC` | 4 | data length code (§6.5) | yes | yes |
| `DATA` | 8 × *n* | payload, byte 0 first, MSB first | yes | yes |
| `CRC` | 17 | §6.10 | yes | no |
| `CRC_DELIM` | 1 | `1` | no | no |
| `ACK` | 2 | transmitter silent, receivers assert `00` | no | no |
| `ACK_DELIM` | 1 | `1` | no | no |
| `EOF` | 7 | `1111111` | no | no |

**Extended format** (`IDE = 1`), 29-bit identifier:

| Field | Bits | Value | Stuffed | In CRC |
|---|---|---|---|---|
| `SYNC` | 8 | `01010101` | no | no |
| `SOF` | 1 | `0` | yes | yes |
| `ID_A` | 11 | identifier bits 28..18 | yes | yes |
| `SRR` | 1 | `1`, substitute remote request | yes | yes |
| `IDE` | 1 | `1` = extended | yes | yes |
| `ID_B` | 18 | identifier bits 17..0 | yes | yes |
| `RTR` | 1 | `0` = data, `1` = remote | yes | yes |
| `FDF` | 1 | `0` = classic, `1` = extended payload | yes | yes |
| `r1` | 1 | `0`, reserved | yes | yes |
| `r0` | 1 | `0`, reserved | yes | yes |
| `DLC` | 4 | data length code (§6.5) | yes | yes |
| `DATA` | 8 × *n* | payload | yes | yes |
| `CRC` | 17 | §6.10 | yes | no |
| `CRC_DELIM` | 1 | `1` | no | no |
| `ACK` | 2 | transmitter silent, receivers assert `00` | no | no |
| `ACK_DELIM` | 1 | `1` | no | no |
| `EOF` | 7 | `1111111` | no | no |

Receivers MUST treat a reserved bit received as `1` as a form error only if
strict mode is enabled; by default a recessive reserved bit is accepted and
ignored, so that future revisions can use it.

### 6.4 Remote frame

Identical to a data frame with `RTR = 1` and no `DATA` field. `DLC` carries the
number of octets being requested, and MUST be interpreted as in §6.5. Remote
frames MUST have `FDF = 0`.

A data frame always wins arbitration against a remote frame with the same
identifier, because `RTR` is dominant for data.

Support for remote frames is OPTIONAL. A node that does not implement them MUST
still parse and forward them correctly, and MUST still acknowledge them.

### 6.5 Data length code

| `DLC` | Octets (`FDF = 0`) | Octets (`FDF = 1`) |
|---|---|---|
| `0`–`8` | 0–8 | 0–8 |
| `9` | *invalid* | 12 |
| `10` | *invalid* | 16 |
| `11` | *invalid* | 20 |
| `12` | *invalid* | 24 |
| `13` | *invalid* | 32 |
| `14` | *invalid* | 48 |
| `15` | *invalid* | 64 |

A `DLC` of 9–15 with `FDF = 0` is a form error.

`FDF` costs one bit and buys payloads up to 64 octets, but at `T25` a 64-octet
frame occupies roughly 24 seconds of bus time and blocks every lower-priority
message for its whole duration. Payloads above 8 octets SHOULD be carried by the
segmented transport of Part 2 instead, which yields the bus between segments.

### 6.6 Overload frame

An overload frame has the same form as an active error frame (§8.4) — 6 dominant
bits followed by 8 recessive bits — but is transmitted only in the first two bits
of the interframe space, and does not affect error counters. It requests
additional delay before the next frame. Support is OPTIONAL for transmission and
REQUIRED for reception. At most 2 consecutive overload frames may be generated.

A receiver recognises an overload flag as a dominant bit in `INTERMISSION`
followed by a second dominant bit (§6.8).

### 6.7 Acknowledgement

The `ACK` field is **two bit times long**, unlike CAN's one.

The transmitter MUST emit no tone for both `ACK` bits. Every node that received
the frame with a valid CRC and a valid form up to the CRC delimiter MUST emit
dominant for both `ACK` bits. The transmitter samples the `ACK` field at the
sample point of the **second** `ACK` bit, where it reads dominant if any
acknowledgement arrived and recessive (no carrier) otherwise.

The transmitter falls silent because its own speaker is by far the loudest
source at its own microphone — typically 20–30 dB louder than a peer a metre
away. Were it to keep emitting `f_R`, the acknowledgers' dominant tone would have
to arrive within the −8.6 dB margin of §4.6 *relative to the transmitter's own
recessive tone*, which on ordinary hardware it never does: every frame would end
in an acknowledgement error no matter who was listening. With the transmitter
silent, the acknowledgement need only clear the carrier threshold.

This has a cost. An acknowledgement says that *some* frame was received, not
which one. A transmitter that has been excluded by a near-far collision (§4.6),
and whose frame nobody received, now hears the acknowledgements for the frame
that was received, and completes as though its own had been.

The field is doubled because an acknowledging node's bit clock is offset from the
transmitter's by one propagation delay, and the node cannot begin its dominant
tone until it has passed the CRC delimiter's sample point on its own clock. One
bit time would leave the transmitter sampling a tone that had only just begun to
arrive; two gives a full bit time of overlap, tolerating propagation delay up to
roughly one bit time (13 m at `T25`) — far beyond the arbitration range limit.

If the transmitter reads recessive at the second `ACK` sample point, it has an
**acknowledgement error** (§8.1). A transmitter that is alone on the bus will
always have acknowledgement errors; this is intended, and is why acknowledgement
errors drive a node to error-passive but never on their own to bus-off (§8.3).

### 6.8 Interframe space

Data and remote frames are separated by the interframe space:

| Field | Bits | Value |
|---|---|---|
| `INTERMISSION` | 3 | `111` |

During `INTERMISSION` no node may start a transmission. A dominant bit observed
during `INTERMISSION` is the first bit of one of three things, and the bit after
it tells them apart:

| Next bit | Meaning | Receiver |
|---|---|---|
| recessive, carrier present | `SYNC` of a frame whose transmitter's interframe space ended slightly ahead of this node's | MUST receive it as `SYNC` bit 0 |
| dominant | an overload flag (§6.6) | waits out the flag and delimiter, then a new `INTERMISSION` |
| no carrier | noise | MUST disregard it and resume the interframe space (§6.2) |

Over air, bit clocks that are aligned to the same frame still differ by up to a
propagation delay plus the residual after resynchronization, so the next
transmitter's first `SYNC` bit can reach a node while that node is still sampling
its own last `INTERMISSION` bit. This is CAN's rule that a dominant bit in the
third bit of the interframe space is `SOF`, applied to the whole field because
`SYNC` makes the three cases distinguishable. Treating that bit as an overload
instead leaves the node out of step with the frame that follows, and it then
transmits into that frame's `EOF`.

A node with a frame pending that sees another node's `SYNC` begin this way
receives that frame and contends again afterwards; it does not join arbitration
late.

An error-passive node that has just transmitted MUST additionally wait 8
recessive bit times (**suspend transmission**) after `INTERMISSION` before
starting a new transmission, giving error-active nodes first access.

### 6.9 Bit stuffing

From `SOF` through the last bit of the `CRC` field inclusive, after five
consecutive bits of identical value the transmitter MUST insert one bit of the
opposite value. Receivers MUST remove such bits. Stuff bits are not included in
the CRC and are not counted as data.

`CRC_DELIM`, `ACK`, `ACK_DELIM`, `EOF`, `INTERMISSION` and `SYNC` are fixed-form
and are not stuffed.

A receiver that observes six consecutive bits of identical value in the stuffed
region has a **stuff error** (§8.1), except that six dominant bits are an error
frame (§8.4).

Stuffing serves two purposes here: it guarantees an edge for resynchronization at
least every 10 bit times, and it makes the 6-dominant-bit error flag
unambiguously distinguishable from data.

### 6.10 CRC

TinCAN uses a 17-bit CRC.

| Property | Value |
|---|---|
| Width | 17 |
| Polynomial | `0x1685B` (`x¹⁷ + x¹⁶ + x¹⁴ + x¹³ + x¹¹ + x⁶ + x⁴ + x³ + x + 1`) |
| Initial value | `0x00000` |
| Reflect input | no |
| Reflect output | no |
| Final XOR | `0x00000` |
| Input | de-stuffed bits from `SOF` through the last `DATA` bit inclusive, MSB first |

The polynomial value is borrowed from CAN FD's CRC-17. Its application here — the
initial value, and the range of bits covered — is TinCAN's own and produces
different results from any CAN implementation. Test vectors are in
[Appendix B](#appendix-b-crc-test-vectors).

The CRC is computed over the **de-stuffed** bit sequence, so a stuff error and a
CRC error are independent detections.

---

## 7. Medium access and arbitration

### 7.1 Starting a transmission

A node with a frame ready MUST:

1. wait for the bus to be idle for the interval required by §4.5 — 3 bit times
   after a completed interframe space, or 11 bit times otherwise;
2. if it is error-passive and transmitted the previous frame, wait a further 8
   recessive bit times (§6.8);
3. begin the `SYNC` field at the next bit boundary of its own bit clock;
4. apply transmit hard synchronization during `SYNC` (§5.4);
5. transmit `SOF` and the arbitration field while monitoring the bus.

A node that observes a dominant bit while waiting in step 1 or 2 abandons the
attempt, receives the frame in progress, and retries afterwards.

**When contention actually happens.** Two nodes that independently become ready
on a long-idle bus rarely collide: their bit clocks are free-running and
unrelated, so one reaches a bit boundary first, and by the time the other does,
carrier is present and it defers at step 1. Real contention arises when several
nodes are *waiting on a busy bus*: they are all synchronized to the frame in
progress, so when the interframe space ends they start within one propagation
delay of each other, and §5.4 closes the remaining gap. Implementations testing
arbitration should construct that case deliberately rather than expecting two
idle nodes to collide.

### 7.2 Bitwise arbitration

Throughout the **arbitration field** — `SOF` through `IDE` for base frames, and
`SOF` through `RTR` for extended frames — a transmitting node compares the level
it transmitted with the level it read at the sample point:

| Transmitted | Read | Result |
|---|---|---|
| `0` (dominant) | `0` | continue |
| `0` (dominant) | `1` | **bit error** (§8.1) — the bus should have been dominant |
| `1` (recessive) | `1` | continue |
| `1` (recessive) | `0` | **arbitration lost** |

On losing arbitration a node MUST, without generating any error:

- stop transmitting immediately — it is already emitting the recessive tone, and
  it MUST cease emitting entirely at the next bit boundary;
- become a receiver of the frame in progress for the remainder of the frame,
  including participating in acknowledgement;
- retain its pending frame and retry once the bus is next available.

Because the loser transmitted only recessive bits up to the point of loss, and
recessive bits do not disturb the winner's dominant bits, the winner's frame is
undamaged. This is the whole point of the exercise.

After the arbitration field ends, a transmitted-recessive/read-dominant mismatch
is no longer arbitration loss — it is a bit error. The `ACK` field is exempt: the
transmitter is silent there (§6.7) and dominant is the expected outcome.

### 7.3 Priority semantics

The arbitration field is compared as an unsigned binary number transmitted MSB
first, with dominant as `0`. Therefore:

- **Numerically lower identifier wins.**
- A data frame beats a remote frame with the same identifier, because `RTR` is
  dominant for data.
- **A base frame always beats an extended frame whose top 11 identifier bits are
  equal.** At bit position 12 the base frame transmits `RTR` and the extended
  frame transmits `SRR`, which is always recessive: a base *data* frame therefore
  wins outright there. A base *remote* frame ties at bit 12 and wins at the next
  bit instead, because `IDE` is dominant for base format and recessive for
  extended. Either way the base frame wins, and the extended frame's remaining 18
  identifier bits are never reached.

Two nodes MUST NOT transmit different frames with the same arbitration field. If
they do, arbitration cannot separate them, both continue transmitting, their
first differing bit produces a bit error at one of them, and the frame is
destroyed. Identifier uniqueness is an application responsibility; Part 2's
addressing scheme embeds a source node identifier in the low bits of every
identifier precisely to make collisions impossible by construction.

---

## 8. Error detection and confinement

### 8.1 Error types

| Error | Detected by | Condition |
|---|---|---|
| **Bit error** | transmitter | Level read at the sample point differs from the level transmitted, outside the arbitration field and outside the `ACK` field. |
| **Stuff error** | any node | Six consecutive equal bits in the stuffed region, other than a valid error flag. |
| **CRC error** | receiver | Computed CRC over the de-stuffed frame differs from the received `CRC` field. |
| **Form error** | any node | A fixed-form field holds an illegal value: `CRC_DELIM`, `ACK_DELIM`, `EOF`, `INTERMISSION`, or an invalid `DLC`. |
| **Acknowledgement error** | transmitter | `ACK` field read recessive at the second `ACK` bit's sample point. |

A node detecting an error MUST transmit an error flag (§8.4) beginning at the
next bit time, except for CRC errors, where the flag begins after the `ACK`
delimiter.

### 8.2 Error counters

Every node maintains a transmit error counter `TEC` and a receive error counter
`REC`, both 9-bit saturating at 511.

| Event | Change |
|---|---|
| Receiver detects an error | `REC += 1` |
| Receiver detects an error and is the first to signal it | `REC += 8` |
| Transmitter transmits an error flag | `TEC += 8` |
| Transmitter detects a bit error while transmitting its own error flag | `TEC += 8` |
| Frame transmitted successfully (`ACK` received) | `TEC -= 1` (floor 0) |
| Frame received successfully | `REC -= 1` if `REC > 0`; if `REC` is 0 it stays 0 |
| Acknowledgement error while error-active and no other node ever acknowledged | `TEC += 8`, but see §8.3 |

These rules are simplified from CAN's; the intent is preserved — a node that is
persistently wrong accumulates penalty eight times faster than it earns credit —
without reproducing CAN's full exception table.

### 8.3 Error states

| State | Condition | Behaviour |
|---|---|---|
| **Error-active** | `TEC < 128` and `REC < 128` | Signals errors with an **active error flag**: 6 dominant bits. Participates fully. |
| **Error-passive** | `TEC ≥ 128` or `REC ≥ 128` | Signals errors with a **passive error flag**: 6 recessive bits, which disturb nothing. Must wait an extra 8 bits after transmitting (§6.8). |
| **Bus-off** | `TEC ≥ 256` | Transmits nothing at all. May still receive. |

A bus-off node MAY return to error-active after observing 128 occurrences of 11
consecutive recessive bit times, with `TEC` and `REC` reset to 0. Automatic
recovery SHOULD be user-controllable.

**Lone-node exception.** A node that is the only node on a bus will accumulate
acknowledgement errors on every frame. Implementations MUST NOT drive a node to
bus-off on acknowledgement errors alone: if the only errors observed since `TEC`
was last zero have been acknowledgement errors, `TEC` MUST be clamped at 255.
The node becomes error-passive — visibly, so a user interface can say "nobody is
listening" — but never bus-off. This differs from CAN, where a lone node's
retransmissions eventually bus it off, and it differs because a TinCAN bus
routinely has exactly one node on it while a user waits for a second device.

### 8.4 Error frames

An **active error flag** is 6 dominant bits. It deliberately violates bit
stuffing, which guarantees that every other node detects it as a stuff error and
transmits its own error flag; the superposition of these flags is 6 to 12
dominant bits, the **error flag superposition**.

An **error delimiter** of 8 recessive bits follows the superposition. A node
transmitting an error delimiter waits for the bus to go recessive, then counts 8
recessive bits.

A **passive error flag** is 6 recessive bits and is invisible to other nodes
unless the signalling node is the only transmitter.

After an error frame, the interframe space (§6.8) applies, and the transmitter of
the destroyed frame SHOULD retransmit it, subject to §8.3.

Automatic retransmission MAY be disabled per frame; a node with retransmission
disabled discards the frame after one attempt and reports the failure upward.

---

## 9. Conformance

### 9.1 Profiles

| Profile | Requirements |
|---|---|
| **Listener** | §4.4 receiver, §5 timing including hard sync and resync, §6 frame decoding, §6.10 CRC verification. Transmits nothing at all — not even acknowledgement. Cannot detect its own errors. Suitable for an analyzer. |
| **Basic node** | Listener, plus §4.3 transmitter, §6.7 acknowledgement, §7 arbitration, §8 error detection and counters, base frames, `FDF = 0`. |
| **Full node** | Basic node, plus extended identifiers, remote frames, `FDF = 1` payloads, overload frames. |

A **Listener** MUST NOT acknowledge. An analyzer that acknowledges changes the
behaviour of the bus it is observing — a transmitter alone with an acknowledging
analyzer will believe it has a peer. Implementations offering an "acknowledge"
option in a monitor MUST default it to off and label it clearly.

### 9.2 Implementation conformance statement

An implementation claiming TinCAN 1.0 conformance SHOULD publish:

| Item | |
|---|---|
| Profile | Listener / Basic / Full |
| Bands supported | |
| Bit-timing profiles supported | |
| Measured `t_slop` | output latency + input latency + detector hop |
| `theta_D`, `kappa` defaults | |
| Retransmission | automatic / manual / disabled |
| Bus-off recovery | automatic / manual |

---

## 10. Security considerations

TinCAN inherits CAN's security model, which is to say it has none, and adds the
properties of an open acoustic channel, which are worse.

- **No confidentiality.** Every frame is audible to everything in the room,
  including devices whose owners did not consent to being on the bus, and
  including any recording device. Band B is inaudible to humans but is not in any
  sense private.
- **No authentication.** Any node may transmit any identifier. Part 2's source
  field is a convention, not a credential.
- **Trivial denial of service.** A continuous `f_D` tone holds the bus dominant
  forever. Any loud noise in band raises the noise floor past `kappa · N` and
  stops carrier sense. Neither requires protocol knowledge.
- **Arbitration is an oracle.** A node that consistently wins arbitration reveals
  the identifiers of the frames it beat, because losers reveal their identifier
  prefix before withdrawing. Identifier bits are transmitted in the clear before
  any decision to withhold them can be made — this is inherent to the mechanism.
- **Physical reach exceeds intent.** Sound leaks through doors, is picked up by
  open conference-call microphones, and is re-radiated by any speaker in the
  path. A TinCAN segment's boundary is not a network boundary you can see.

Applications requiring confidentiality, integrity, or authenticity MUST provide
them above TinCAN, in the payload, with the understanding that identifiers,
lengths, and timing remain observable. Do not use TinCAN to carry anything whose
disclosure matters.

### 10.1 Courtesy

Band A is audible and unpleasant at length. Implementations SHOULD:

- provide an obvious, immediate transmit mute;
- default to a modest output level;
- avoid transmitting periodic heartbeats in band A by default;
- indicate visually when they are transmitting.

---

## Appendix A — Frame timing

Bit counts exclude stuff bits, which add up to 20 % in the worst case and
typically 2–4 %.

**Base data frame, `FDF = 0`, no stuffing:**

```
bits = 8 (SYNC) + 1 (SOF) + 11 (ID) + 1 (RTR) + 1 (IDE) + 1 (FDF) + 1 (r0)
     + 4 (DLC) + 8n (DATA) + 17 (CRC) + 1 (delim) + 2 (ACK) + 1 (delim)
     + 7 (EOF) + 3 (IFS)
     = 59 + 8n
```

| Payload | Bits | `T100` | `T50` | `T25` | `T10` | `T5` | `T4` | `T2` |
|---|---|---|---|---|---|---|---|---|
| 0 B | 59 | 0.59 s | 1.18 s | 2.36 s | 5.9 s | 11.8 s | 14.8 s | 29.5 s |
| 1 B | 67 | 0.67 s | 1.34 s | 2.68 s | 6.7 s | 13.4 s | 16.8 s | 33.5 s |
| 4 B | 91 | 0.91 s | 1.82 s | 3.64 s | 9.1 s | 18.2 s | 22.8 s | 45.5 s |
| 8 B | 123 | 1.23 s | 2.46 s | 4.92 s | 12.3 s | 24.6 s | 30.8 s | 61.5 s |

**Extended data frame** adds 20 bits: `bits = 79 + 8n`.

| Payload | Bits | `T100` | `T50` | `T25` | `T10` | `T5` | `T4` | `T2` |
|---|---|---|---|---|---|---|---|---|
| 0 B | 79 | 0.79 s | 1.58 s | 3.16 s | 7.9 s | 15.8 s | 19.8 s | 39.5 s |
| 8 B | 143 | 1.43 s | 2.86 s | 5.72 s | 14.3 s | 28.6 s | 35.8 s | 71.5 s |
| 64 B | 591 | 5.91 s | 11.8 s | 23.6 s | 59.1 s | 118 s | 148 s | 296 s |

Effective payload throughput for 8-octet base frames at `T25` is about
13 octet/s, or 1.6 octet/s of user data per second of bus time — which is to say,
TinCAN is a bus for control messages, not for files.

## Appendix B — CRC test vectors

CRC-17, polynomial `0x1685B`, initial value `0x00000`, over the de-stuffed bit
sequence from `SOF` through the last `DATA` bit.

Bit sequences are written MSB first. `CRC` is shown as a 17-bit value in hex.

| # | Frame | Bits fed to CRC | CRC |
|---|---|---|---|
| 1 | base, `ID=0x000`, data frame, `DLC=0` | `0 00000000000 0 0 0 0 0000` | see `test/crc.test.mjs` |
| 2 | base, `ID=0x123`, data frame, `DLC=1`, data `0xA5` | | |
| 3 | base, `ID=0x7FF`, remote, `DLC=8` | | |
| 4 | extended, `ID=0x1FFFFFFF`, `DLC=8`, data `00..07` | | |

The authoritative vectors are generated by the reference implementation and
asserted in `test/crc.test.mjs`; they are reproduced on the published
[test vectors](vectors.html) page, which is generated from the reference
implementation at build time so that the document and the code cannot disagree.

## Appendix C — A worked arbitration example

Three nodes on a `T25` segment. Node 1 is 0.5 m from the microphone under
consideration, node 2 is 1.0 m, node 3 is 2.0 m. All transmit at the same level.

The bus goes idle. Nodes 1 and 2 both have a frame ready:

- node 1: base data frame, `ID = 0x201`
- node 2: base data frame, `ID = 0x205`

**`SYNC` field.** Node 1's decision instant precedes node 2's by 4 ms. Node 2
observes node 1's dominant edge 4 ms + 1.5 ms of propagation before its own
`SYNC` bit 0 boundary, and applies transmit hard synchronization (§5.4),
shortening its own `SYNC` bit 0 by 5.5 ms. From `SYNC` bit 1 onward the two are
aligned to within the detector hop.

**Arbitration field.** Identifiers, MSB first:

```
bit    10 9 8 7 6 5 4 3 2 1 0
0x201   1 0 0 0 0 0 0 0 0 0 1
0x205   1 0 0 0 0 0 0 0 1 0 1
                        ^
                        node 2 sends recessive, reads dominant
```

Bits 10 down to 3 are identical, so both nodes transmit them and both read back
what they sent. At bit 2, node 1 transmits dominant (`f_D`) and node 2 transmits
recessive (`f_R`). At node 2's sample point, `E_D/(E_R + E_D)` is dominated by
node 1's tone arriving 0.5 m away versus node 2's own tone leaking into its own
microphone — comfortably above `theta_D`. Node 2 declares arbitration lost.

**Withdrawal.** Node 2 stops emitting at the next bit boundary and becomes a
receiver. Node 1's frame is untouched: node 2 contributed only recessive tones,
which never mask dominant.

**Acknowledgement.** Nodes 2 and 3 both validate the CRC and both emit `f_D` for
both `ACK` bits. Node 3, at 2.0 m, arrives 3 dB weaker than node 2 — irrelevant,
because both are dominant and dominant tones sum.

**Retry.** After `EOF` and `INTERMISSION`, node 2 finds the bus idle and
transmits `0x205`. Total cost of the collision: zero retransmitted bits for node
1, and one deferred frame for node 2.

### C.1 The same example, outside the near-far margin

Now move node 3 out to 4.0 m and give it the *lower* identifier, so it ought to
win against node 1 at 0.15 m.

Node 1 must detect node 3's dominant bit while node 1's own recessive tone is
roughly 28 dB stronger at node 1's own microphone. That is far outside the
−8.6 dB margin of §4.6, so node 1 reads recessive — the level it transmitted —
and does not withdraw. Symmetrically, node 3 hears node 1's dominant bits buried
under its own recessive tone and does not withdraw either. Neither node reports
arbitration loss and neither reports a bit error. They transmit two complete,
overlapping frames.

What happens next is the part worth internalising:

- **Node 1's frame is delivered.** Node 2, in the middle, hears node 1 far more
  strongly than node 3, decodes node 1's frame, and acknowledges it. Node 1 sees
  the acknowledgement and completes normally. Nothing tells node 1 that anything
  went wrong.
- **Node 3's frame is delivered to nobody, and node 3 does not know.** No node
  hears it well enough over node 1's simultaneous transmission to validate its
  CRC. But node 3 is silent during `ACK` (§6.7), so it hears node 2
  acknowledging node 1's frame, takes that as its own acknowledgement, and
  completes. It does not retry. The frame is simply gone.

The net effect is that node 3 is **excluded from the bus** rather than colliding
with it. This is the failure mode the range limit exists to prevent, and it is
why §4.3 requires normalised transmit levels and why an analyzer should display
received level per source: from node 1's point of view the bus is healthy, and
only a third-party view makes the exclusion visible.
