/** The apps' shared helpers that do not need a page. */
import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
const { micName, saveMeasuredLatency, measuredLatency } = await import('../apps/ui.js');

test('a microphone is known by one name, however it is listed', () => {
  const name = 'MacBook Pro Microphone (Built-in)';
  assert.equal(micName(name), name);
  assert.equal(micName(`Default - ${name}`), name, 'Chrome\'s entry for the system default');
  assert.equal(micName(`system default (${name})`), name, 'the picker\'s option for it');
  assert.equal(micName(''), '');
});

test('a latency the self-test measured is found again by the Console, for that microphone only', () => {
  saveMeasuredLatency('Default - MacBook Pro Microphone (Built-in)', 0.05862);
  const m = measuredLatency('system default (MacBook Pro Microphone (Built-in))');
  assert.equal(m.ms, 58.6);
  assert.match(m.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(measuredLatency('2024 iPhone 16 Microphone'), null);
});
