# TinCAN test rig — descriptions, messages and limits

**Status:** Draft
**Date:** 2026-10-21

TinCAN's hardest problems show up only between real devices: a speaker going
silent mid-run, a band whose tones arrive unbalanced, a detector threshold that
suits one microphone and not another. Two tabs on one Mac share a speaker and
a microphone, so they hide most of this. The rig puts several machines on the
local network under one coordinator, so a run can be described once, played and
recorded on every device on a shared clock, and kept for analysis.

Browsers run descriptions, not code. The server sends JSON in the small DSL of
§2–§3; each device's page holds a fixed interpreter and rejects anything
outside it, so the signal processing a device runs is always the code in this
repository, loaded when it loads the page.

---

## 1. Purpose

A **run** is one description delivered to every joined device at once. Each
device renders the description's play actions into a single signal, starts it
and its recordings on the shared clock of §4, and returns one result per
record and measure action, plus its WAV uploads. The server keeps everything —
the description, each device's events, results and recordings — under
`runs/` (§8).

The DSL exists so that a device never executes delivered code. A description
names actions and numbers only; every other key, and every action outside §3,
is rejected.

## 2. Descriptions

A description is a JSON object:

| Field | Required | Meaning |
|---|---|---|
| `rig` | yes | The DSL version; MUST be `1` |
| `name` | no | A label for the run records |
| `at` | no | Server time in milliseconds since the Unix epoch (a float). The server fills it in when absent |
| `actions` | yes | A non-empty array, at most 64 actions |

Every action has `do` (its kind) and `t` (seconds, ≥ 0, relative to `at`;
default 0). Validation reports **every** problem, and an unknown `do`, or an
unknown key on an action or on the description, is a rejection — the page runs
descriptions, not code.

```json
{
  "rig": 1, "name": "band A basics",
  "actions": [
    { "do": "tone", "t": 0.2, "band": "A", "which": "D", "seconds": 0.5, "level": 0.25 },
    { "do": "frame", "t": 1.0, "band": "A", "profile": "T25",
      "frame": { "id": 1665, "data": "DEADBEEF" } },
    { "do": "record", "t": 0, "seconds": 2.0, "return": ["levels", "edges", "wav"] }
  ]
}
```

## 3. Actions

### 3.1 Play

Play actions render into one Float32Array per description; overlapping actions
sum. `level` is amplitude relative to full scale (0–0.5, default 0.25).
`ramp` gives raised-cosine onsets and ends, as Part 1 §4.3.

`tone` — a steady tone, by band or by frequency:

| Field | Default | Meaning |
|---|---|---|
| `band` + `which` | — | A band key (Part 1 §4.2) and `"R"` or `"D"`, **or** |
| `hz` | — | the frequency directly |
| `level` | 0.25 | Amplitude, 0–0.5 |
| `seconds` | 0.5 | Duration, > 0 |
| `ramp` | 0.01 | Edge time, seconds |

`chirp` — a linear sweep:

| Field | Default | Meaning |
|---|---|---|
| `from`, `to` | — | Start and end Hz |
| `seconds` | 0.1 | Duration, > 0 |
| `level` | 0.25 | Amplitude |
| `ramp` | Hann over the whole chirp | When given, raised-cosine edges of this length instead |

`noise` — a burst of noise, scaled so its peak equals `level`:

| Field | Default | Meaning |
|---|---|---|
| `color` | `"white"` | `"white"` or `"pink"` (Paul Kellet's economy filter) |
| `seconds` | 0.5 | Duration, > 0 |
| `level` | 0.25 | Peak amplitude |
| `seed` | 1 | PRNG seed, an integer |

`silence` — `{seconds}`: renders nothing but extends the description's span,
useful inside a repeat.

`frame` — a TinCAN frame as audio:

| Field | Default | Meaning |
|---|---|---|
| `band` | — | A band key |
| `profile` | — | A profile key (Part 1 §5.2); MUST satisfy the band's shortest time quantum, as the Phy checks |
| `frame` | — | `{id, data, extended?, rtr?}`; `data` is a hex string of even length or an array of octets, ≤ 64 |
| `level` | 0.25 | Amplitude |
| `errors` | none | Deliberate corruption, below |

Bits are `buildTransmission(frame).bits` at the profile's bit time; 1 plays
f_R, 0 plays f_D. Two phase-continuous oscillators carry the tones with the
Phy's 1 ms raised-cosine cross-fade between them — and the same ramp into and
out of silence at the ends.

| `errors` field | Meaning |
|---|---|
| `flip` | Bit indices to invert; out of range is a rejection |
| `cut` | Transmit only the first `cut` bits; past the frame's length is a rejection |

### 3.2 Record

`record` — capture `seconds` (> 0) of microphone input and return summaries:

| Field | Default | Meaning |
|---|---|---|
| `seconds` | — | Duration, > 0 |
| `return` | `["levels"]` | A subset of `["wav", "levels", "goertzel", "spectrum", "edges"]` |
| `hz` | every band's two tones | Frequencies for `goertzel` |
| `window` | 0.1 s; 0.01 s for `edges` | Hop/window of the per-window series |
| `band` | `"A"` | Whose tones `edges` classifies |
| `thetaD` | 0.12 | Dominant-fraction threshold for `edges` (Part 1 §4.4) |
| `floor` | 0.01 | Amplitude below which `edges` reports `idle` |
| `bins` | 256 | `spectrum` bins, equally spaced from 0 to 0.46·fs |

The summaries:

| Kind | Shape |
|---|---|
| `levels` | `{peak, rms, dbfs, series: [{t, rms}]}` |
| `goertzel` | `[{hz, amplitude, series: [..]}]` — Hann-windowed, whole record and per window |
| `spectrum` | `{hz: [], db: []}` — Hann-windowed amplitude per bin, dB floored at −127 |
| `edges` | `[{t, level}]`, level `"D"`, `"R"` or `"idle"`, emitted whenever it changes |
| `wav` | The samples themselves; the summary carries only `{samples, seconds}` |

### 3.3 Measure

`measure` — `{what}`:

| `what` | Expands to |
|---|---|
| `latency` | A 2000–5000 Hz chirp of 0.05 s at level 0.25 at `t`, plus a 1.0 s record at `t` |
| `noise` | A 1.0 s record at `t` |
| `clock` | Nothing: the page answers it from its ping offset (§4) |
| `audio` | Nothing: the page answers with its audio settings |

`latency` and `noise` expand *before* the description reaches the page's
scheduler: the replacement actions carry `measure` (the kind) and `index` (the
original action's position), which is how their results are labelled. Both
keys are internal to the expanded form; a description that arrives with them
is rejected. Latency is the lag of the best normalized cross-correlation peak
of the recording against the chirp, searched over 0–1 s. `noise` reports the
record's dBFS and the amplitude at every band's two tones.

### 3.4 Node

`node` — `{op}` on the device's bus node. A device has one node; `join`
restarts its audio with the given band, profile and detector parameters.
Validation only checks the fields; the duration is 0 — `bandtest` included,
whose end the page reports as an event.

| `op` | Fields |
|---|---|
| `join` | `band`, `profile`, `address` (0–30), `callsign?` (≤ 8 chars), `level?`, `thetaD?`, `kappa?`; the profile MUST fit the band as in `frame` |
| `send` | `frame` — the same `{id, data, extended?, rtr?}` as §3.1 |
| `stats` | none |
| `bandtest` | `bands` (band keys), `window` (1–255 s) — a Part 2 §9 test |
| `leave` | none |

### 3.5 Repeat

`repeat` — `{times, every, actions}`:

| Field | Meaning |
|---|---|
| `times` | Repetitions, an integer 1–64 |
| `every` | Seconds between repetition starts, > 0 |
| `actions` | A non-empty array; inner `t` is relative to `t + i·every` |

Repeats nest to depth 2. Inner actions may be any kind — a record inside a
repeat produces one result per repetition.

## 4. Timing

`at` is on the **server's** clock, in milliseconds since the Unix epoch, and
every action's `t` is seconds after it. Each page keeps its offset from the
server by ping exchanges:

```
POST /api/ping  {t0}  →  {t0, t1}
```

with `t0` the page's send time and `t1` the server's receive time. The offset
is `t1 − (t0 + t2)/2` for reply time `t2`, and the page keeps the sample with
the lowest round trip. A description scheduled at `at` starts in AudioContext
time at

```
ctx.currentTime + (at − serverNow) / 1000
```

where `serverNow` is the server's clock estimated at that instant.

## 5. Limits

| Limit | Value |
|---|---|
| `maxLevel` | 0.5 amplitude |
| `maxSeconds` | 120 s description span |
| `maxActions` | 64 |
| `maxRepeat` | 64 repetitions |
| `maxDepth` | 2 nested repeats |

A level above `maxLevel` or a span above `maxSeconds` is a rejection, not a
clamp. Frequencies must sit below 0.46·fs — where converters' anti-alias
filters start (Part 1 §4.2); since the sample rate is the device's, the check
happens at render time.

A device MAY set a lower level cap of its own: each action's level is then
clamped to the cap, and the render reports it clipped. Every device page has
a **Stop** button that silences playback and abandons the run locally, however
the description was written.

## 6. Messages

Devices talk to the rig server over HTTPS on the LAN. Joining:

```
POST /api/join  {code, name, info}  →  {token, device}
```

The `code` is printed when the server starts; a wrong code gets `401`. The
token buys the device's event stream and result posts:

| Endpoint | Direction | Payload |
|---|---|---|
| `GET /api/events?token=` | server → device | SSE: `hello`, `description` `{run, id, description}`, `stop` |
| `POST /api/ping` | device → server | `{t0}` → `{t0, t1}` (§4) |
| `POST /api/event?token=` | device → server | `{run, id, type, detail, at}` |
| `POST /api/result?token=` | device → server | `{run, id, result}` |
| `POST /api/wav?token=&run=&id=&name=` | device → server | WAV body (16-bit PCM mono) |

The result shape, one per device per description:

```json
{
  "run": "103015-band-a", "id": "d3", "device": "kitchen", "at": 1761095400123.4,
  "actions": [{ "index": 2, "do": "record", "levels": { } }],
  "errors": []
}
```

## 7. Control API

A second HTTP listener on 127.0.0.1 — the machine running the server only — is
the CLI's interface:

| Endpoint | Meaning |
|---|---|
| `GET /devices` | Joined devices and their audio settings |
| `POST /send {to, description}` | Queue a description for a device or `all` → `{id, at}` |
| `GET /wait?id&timeout` | Block until results for `id` are in, or `timeout` s |
| `GET /results?id` | The results collected for `id` |
| `GET /run` / `POST /run {name}` | The current run / start a new one |
| `GET /log` | SSE stream of the server's event log |
| `POST /stop {to}` | Send `stop` to a device or `all` |
| `GET /info` | `{url, code, run}` — the device URL and join code |
| `GET /files?id` | The record files kept for `id` (§8) |

## 8. Records

Each run keeps a folder `runs/<YYYY-MM-DD>/<HHMMSS-name>/` holding:

| Path | Contents |
|---|---|
| `devices/<device>.json` | Each device's `info` from its join |
| `events.ndjson` | Every event, one JSON object per line |
| `descriptions/<id>.json` | Each description as sent, with `at` filled in |
| `results/<id>-<device>.json` | Each device's result (§6) |
| `wav/<id>-<device>-<name>.wav` | Each uploaded recording |

`runs/` is gitignored: the records are data, not source.

## 9. Hosts

The CLI starts and stops the devices' browsers over SSH, so a run needs no
screen interaction on the machines. Hosts are aliases in a gitignored
`rig-hosts.json` at the repository root (`rig-hosts.example.json` is the
committed template):

```json
{
  "kitchen": { "ssh": "curt@kitchen.local", "os": "macos", "browser": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "name": "kitchen" },
  "pi":      { "ssh": "pi@pi.local",        "os": "linux", "browser": "google-chrome chromium-browser chromium", "name": "pi", "display": ":0" }
}
```

| Field | Default | Meaning |
|---|---|---|
| `ssh` | the alias | The `ssh` target, key-based (BatchMode) |
| `os` | `"macos"` | `"macos"` or `"linux"` |
| `browser` | Chrome, or `google-chrome` then `chromium-browser`, `chromium` | Executable or `command -v` candidates |
| `name` | the alias | The device name the page joins with |
| `display` | `":0"` | X display, Linux only |

Three commands, each a single `ssh` invocation:

| Command | Remote action |
|---|---|
| `rig launch <host>` | Starts Chrome with its own `--user-data-dir` at `…/apps/rig/?code=&name=&auto=1`, leaving the machine's normal profile alone, with the flags that allow the microphone, autoplay and the self-signed certificate without a click |
| `rig info <host>` | `uname`, then the audio devices and volume (`system_profiler` and `osascript` on macOS, `pactl` on Linux) |
| `rig stop <host>` | Kills the pid `launch` recorded (a `pkill` matching only the rig's profile dir as fallback), never the machine's normal browser |

`launch` records its browser's pid in `~/.tincan-rig.pid` and refuses to start
a second while one runs. SSH is used for these commands and nothing else:
installing software or changing system settings is always asked about first.

Some Chrome versions ignore `--autoplay-policy` for the very first
navigation; `?auto=1` also clicks Start on load, but if the page still shows
its Start button one click on the device is needed once.
