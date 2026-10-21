# Plan: a TinCAN test rig

Status: planned, not started (2026-10-21).

TinCAN's hardest problems show up only between real devices: a speaker
going silent mid-run, a band whose tones arrive unbalanced, a detector
threshold that suits one microphone and not another. Two tabs on one Mac
share a speaker and a microphone, so they hide most of this. The rig puts
several machines on the local network under one coordinator, so a run can
be described once, played and recorded on every device on a shared clock,
and kept for analysis.

## Decisions

- **Browsers run descriptions, not code.** The server sends JSON in a
  small audio DSL; each device's page holds a fixed interpreter and rejects
  anything outside the DSL. Changes to the signal processing are ordinary
  commits to this repository, which a device loads when it reloads the page.
- **HTTPS with a self-signed certificate**, because remote browsers allow
  the microphone only in a secure context. The server makes the
  certificate itself with openssl; no installs on the devices.
- **A join code**, printed when the server starts, is required before a
  device receives descriptions.
- **Control through a CLI over a local API**: the control listener answers
  only on the machine running the server.
- **Kept per run**: logs, reports, results, and WAV recordings, in a
  gitignored `runs/` folder.
- **SSH** to the machines handles setup: starting and stopping the rig's
  browser, and reading audio hardware and volume.
- **No dependencies**, as with the rest of the repository.
- Audible runs between machines happen only when asked.

## Pieces

### Server — `tools/rig/server.mjs`

- Serves the repository over HTTPS on the LAN (port 8443 by default), with
  a certificate it creates into a gitignored `.rig/` folder.
- Device ↔ server: server-sent events carry descriptions to devices;
  devices POST events, results and WAV uploads back. The join code buys a
  device token.
- A second HTTP listener, bound to 127.0.0.1, is the control API.
- Records: `runs/<date>/<run>/` holds each device's info, an NDJSON event
  log, JSON results and WAV recordings.

### CLI — `tools/rig.mjs`

- `devices`: who has joined, with each device's audio settings.
- `send <device|all> <description>`: from a file or inline JSON.
- `wait`, `results`, `fetch`: get outputs back.
- `log`: follow events live.
- `launch | info | stop <host>`: the SSH commands below.

### The DSL — `spec/rig.md`

Versioned JSON descriptions, validated on the server and again on the page.

- **Play**
  - tone: by band or by frequency, with level, duration and ramp
  - chirp or sweep
  - noise: white or pink, at a level
  - silence
  - a TinCAN frame: band, profile, ID, data, and optional deliberate errors
  - sequences and repeats
- **Record**: a start and a duration, returning a WAV or a summary —
  levels, Goertzel energies at chosen frequencies, a spectrum, or the times
  of detected edges.
- **Measure**: speaker-to-microphone latency, noise floor, clock offset and
  drift against the server, and the browser's audio settings (sample rate,
  base latency, echo cancellation, noise suppression, automatic gain).
- **Node**: join the bus with given parameters (detector thresholds
  included), send frames, report protocol statistics and bit logs, run a
  band test (Part 2 §9).
- **Timing**: every action is scheduled in server time; each page keeps its
  offset from the server by ping exchanges and converts to AudioContext time.
- **Limits**: a maximum level and duration, so no description can blast a
  speaker. Each device can set a lower cap and has a Stop button.

### Page — `apps/rig/`

- A Start button unlocks the microphone and audio and keeps the screen
  awake.
- Shows the device's name, what it is doing, a level meter, and Stop.
- The interpreter is split in two:
  - `src/tincan/rig-dsl.js`, pure and testable: validates descriptions,
    renders signals, computes summaries.
  - The page's own code, reusing the Modem's `playAt` and `recordAt` and the
    existing Session.

### SSH — hosts listed in a gitignored `rig-hosts.json`

- `launch`: starts Chrome with its own `--user-data-dir`, leaving the
  machine's normal profile alone, with flags that allow the microphone,
  autoplay and the self-signed certificate without a click.
- `info`: audio devices and volume (`system_profiler` and `osascript` on
  macOS, `pactl` on Linux).
- `stop`: closes only the browser that `launch` started.
- Anything beyond that, such as installing software or changing system
  settings, is asked about first.

## Steps

Each step is committed and pushed to main.

1. The spec: the DSL, the messages, the limits, the join flow.
2. `src/tincan/rig-dsl.js` with tests: what it rejects, the limits,
   rendered levels and frequencies checked by Goertzel, summaries.
3. The server and CLI, with an end-to-end Node test: a fake device joins,
   is refused without the code, and runs a description.
4. The rig page, checked in a local browser tab with silent and
   record-only descriptions.
5. The SSH commands.
6. CI file checks and a link from the index page.

## Needed before step 5

- The SSH host aliases, and each machine's OS and browser.
