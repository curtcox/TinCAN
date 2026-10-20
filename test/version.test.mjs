/** How a page describes the build it came from. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { BUILD, describeBuild } from '../version.js';

test('a working tree is not mistaken for a build', () => {
  assert.equal(BUILD.commit, null, 'the checked-in version.js must stay unstamped; the build stamps its copy');
  const v = describeBuild();
  assert.equal(v.short, 'unbuilt');
  assert.equal(v.url, null);
});

test('a deployed build shows its short commit and deployment time, and links the commit', () => {
  const commit = '28bdab2150f69c6db9b916e16acc014a757ab83b';
  const v = describeBuild({
    commit,
    committedAt: '2026-10-20T19:10:12.000Z',
    deployedAt: '2026-10-20T19:12:40.123Z',
    dirty: false,
    run: 'https://github.com/curtcox/TinCAN/actions/runs/1',
  });
  assert.equal(v.short, '28bdab2');
  assert.equal(v.text, '28bdab2 · deployed 2026-10-20 19:12 UTC');
  assert.match(v.title, new RegExp(commit));
  assert.match(v.title, /committed 2026-10-20 19:10 UTC/);
  assert.equal(v.url, `https://github.com/curtcox/TinCAN/commit/${commit}`);
});

test('a local build with uncommitted changes says so', () => {
  const v = describeBuild({ commit: 'abcdef0123456789', committedAt: null, deployedAt: '2026-10-20T19:12:40Z', dirty: true, run: null });
  assert.equal(v.short, 'abcdef0+changes');
  assert.equal(v.text, 'abcdef0+changes · built locally 2026-10-20 19:12 UTC');
  assert.match(v.title, /uncommitted changes/);
});
