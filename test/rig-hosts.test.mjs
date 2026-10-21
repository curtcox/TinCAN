/**
 * The rig's SSH host scripts — tools/rig/hosts.mjs. The scripts themselves
 * are exercised by `sh -n` and by reading their lines; a real ssh check
 * happens by hand against rig-hosts.json.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { loadHosts, hostFor, launchScript, stopScript, infoScript } from '../tools/rig/hosts.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'rig-hosts-'));
const file = join(tmp, 'rig-hosts.json');
writeFileSync(file, JSON.stringify({
  kitchen: { ssh: 'curt@kitchen.local', os: 'macos' },
  pi: { ssh: 'pi@pi.local', os: 'linux' },
}));

const { kitchen, pi } = loadHosts(file);

const shOk = (script) => spawnSync('sh', ['-n'], { input: script }).status === 0;

describe('rig hosts', () => {
  it('fills defaults per os', () => {
    assert.equal(kitchen.browser, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    assert.equal(kitchen.name, 'kitchen');
    assert.equal(pi.browser, 'google-chrome chromium-browser chromium');
    assert.equal(pi.display, ':0');
  });

  it('reports a missing file and an unknown alias', () => {
    assert.throws(() => loadHosts(join(tmp, 'nope.json')), /rig-hosts\.example\.json/);
    assert.throws(() => hostFor('attic', file), /"attic" is not in .*rig-hosts\.json/);
    assert.equal(hostFor('kitchen', file).ssh, 'curt@kitchen.local');
  });

  it('builds a launch script that is safe and contains the essentials', () => {
    const url = 'https://192.168.5.106:8443/apps/rig/?code=123456&name=kitchen&auto=1';
    for (const h of [kitchen, pi]) {
      const s = launchScript(h, url);
      assert.match(s, /\.tincan-rig-profile/);
      assert.match(s, /--ignore-certificate-errors/);
      assert.match(s, /--use-fake-ui-for-media-stream/);
      assert.match(s, /--autoplay-policy=no-user-gesture-required/);
      assert.ok(s.includes(url));
      assert.match(s, /kill -0 "\$\(cat "\$PIDFILE"\)"/);      // the already-running check
      assert.ok(!/\b(sudo|brew|apt|apt-get|chmod|defaults write)\b/.test(s), 'no installs or settings');
      assert.ok(shOk(s), `sh -n: ${s}`);
    }
  });

  it('exports DISPLAY and searches browsers on linux', () => {
    const s = launchScript(pi, 'https://x/');
    assert.match(s, /export DISPLAY=':0'/);
    assert.match(s, /for b in google-chrome chromium-browser chromium/);
  });

  it('stops the recorded pid and only ever pkills the rig profile', () => {
    const s = stopScript(pi);
    assert.match(s, /PIDFILE=.*\.tincan-rig\.pid/);
    assert.match(s, /kill -9/);
    assert.match(s, /pkill -f -- "--user-data-dir=\$PROFILE"/);
    assert.ok(!s.includes('--user-data-dir="$HOME/.config/google-chrome"'), 'never the normal profile');
    assert.ok(shOk(s));
  });

  it('quotes a url containing a single quote safely', () => {
    const s = launchScript(kitchen, "https://x/?name=o'clock&auto=1");
    assert.match(s, /--new-window 'https:\/\/x\/\?name=o'\\''clock&auto=1'/);
    assert.ok(shOk(s));
  });

  it('info scripts probe audio without failing on missing tools', () => {
    assert.match(infoScript(kitchen), /uname -a\nsystem_profiler SPAudioDataType\nosascript -e 'get volume settings'/);
    const s = infoScript(pi);
    assert.match(s, /pactl info \|\| true/);
    assert.match(s, /pactl get-sink-volume @DEFAULT_SINK@ \|\| true/);
    assert.ok(shOk(s));
  });
});
