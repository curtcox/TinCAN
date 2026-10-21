/**
 * The rig's SSH hosts — spec/rig.md §9.
 *
 * `rig-hosts.json` (gitignored) names the machines a device browser can be
 * launched on, asked about its audio, and stopped. These three remote scripts
 * are all the rig ever does over SSH: it never installs software or changes a
 * setting. Each is one `sh` script run by a single ssh invocation.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOSTS_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../rig-hosts.json');

const DEFAULT_BROWSER = {
  macos: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: 'google-chrome chromium-browser chromium',
};

/** The host map with defaults filled; throws when the file is absent. */
export function loadHosts(file = HOSTS_FILE) {
  if (!existsSync(file)) {
    throw new Error(`no ${file}: copy rig-hosts.example.json to rig-hosts.json and fill it in`);
  }
  const all = JSON.parse(readFileSync(file, 'utf8'));
  const out = {};
  for (const [alias, h] of Object.entries(all)) {
    out[alias] = {
      ssh: h.ssh ?? alias,
      os: h.os ?? 'macos',
      browser: h.browser ?? DEFAULT_BROWSER[h.os] ?? DEFAULT_BROWSER.macos,
      name: h.name ?? alias,
      display: h.display ?? ':0',
    };
  }
  return out;
}

export function hostFor(alias, file = HOSTS_FILE) {
  const h = loadHosts(file)[alias];
  if (!h) throw new Error(`"${alias}" is not in ${file}`);
  return h;
}

/** Single-quote `s` for /bin/sh. */
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const CHROME_FLAGS = [
  '--user-data-dir="$PROFILE"',
  '--no-first-run',
  '--no-default-browser-check',
  '--ignore-certificate-errors',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-session-crashed-bubble',
];

const PROLOGUE = `PROFILE="$HOME/.tincan-rig-profile"
PIDFILE="$HOME/.tincan-rig.pid"`;

/** Pick the browser binary: on Linux a command -v loop over the candidates. */
function browserLines(host) {
  if (host.os === 'linux') {
    return [
      'export DISPLAY=' + q(host.display),
      `BROWSER=$(for b in ${host.browser}; do command -v "$b" && break; done)`,
      '[ -n "$BROWSER" ] || { echo "no Chrome or Chromium on this host"; exit 1; }',
    ];
  }
  return [
    `BROWSER=${q(host.browser)}`,
    '[ -x "$BROWSER" ] || { echo "browser not found: $BROWSER"; exit 1; }',
  ];
}

/** Launch the rig page in a throwaway Chrome profile; idempotent via the pidfile. */
export function launchScript(host, url) {
  return [
    PROLOGUE,
    `if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then`,
    `  echo "already running (pid $(cat "$PIDFILE"))"`,
    '  exit 0',
    'fi',
    ...browserLines(host),
    `nohup "$BROWSER" ${CHROME_FLAGS.join(' ')} --new-window ${q(url)} >/dev/null 2>&1 &`,
    'echo $! > "$PIDFILE"',
    'echo "launched pid $(cat "$PIDFILE")"',
  ].join('\n');
}

/**
 * Stop the browser `launch` started: the recorded pid first, and, when the
 * pidfile is gone, a pkill that can only match the rig's own profile dir —
 * the machine's normal browser is never touched.
 */
export function stopScript(host) {
  void host;
  return [
    PROLOGUE,
    'if [ -f "$PIDFILE" ]; then',
    '  PID=$(cat "$PIDFILE")',
    '  kill "$PID" 2>/dev/null',
    '  for i in 1 2 3 4 5; do kill -0 "$PID" 2>/dev/null || break; sleep 1; done',
    '  kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null',
    '  rm -f "$PIDFILE"',
    '  echo "stopped (pid $PID)"',
    'elif pkill -f -- "--user-data-dir=$PROFILE" 2>/dev/null; then',
    '  echo "stopped (no pidfile; killed the rig profile\'s browser)"',
    'else',
    '  echo "nothing running"',
    'fi',
  ].join('\n');
}

/** What the host's audio hardware and volume look like, for launch decisions. */
export function infoScript(host) {
  const lines = ['uname -a'];
  if (host.os === 'linux') {
    for (const c of [
      'pactl info',
      'pactl list short sinks',
      'pactl get-sink-volume @DEFAULT_SINK@',
      'pactl list short sources',
      'pactl get-source-volume @DEFAULT_SOURCE@',
    ]) lines.push(`${c} || true`);
  } else {
    lines.push('system_profiler SPAudioDataType', `osascript -e 'get volume settings'`);
  }
  return lines.join('\n');
}
