/**
 * Every app page's script runs to completion on load.
 *
 * The apps are plain modules with no build step, so a mistake that only shows
 * when the page loads — a name used before its `let`, a missing import, a
 * typo in a selector chain — would otherwise reach the site unnoticed, as one
 * did. Each script is imported against a deliberately permissive stand-in for
 * the DOM: every element, property and method exists and does nothing. That
 * cannot check what a page looks like, only that its script does not throw.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * An object that has every property and method, each another such object.
 * Attributes set on it read back, and like a <select> it takes the value of
 * the first child appended with one.
 */
const propsOf = new WeakMap();
function anything() {
  const props = new Map();
  const target = function () {};
  const proxy = new Proxy(target, {
    get(t, key) {
      if (key === Symbol.toPrimitive) return (hint) => (hint === 'number' ? 0 : '');
      if (key === 'setAttribute') return (k, v) => { props.set(k, v); };
      if (key === 'append') {
        return (...kids) => {
          for (const kid of kids) {
            const v = propsOf.get(kid)?.get('value');
            if (!props.has('value') && v !== undefined) props.set('value', v);
          }
        };
      }
      if (key === Symbol.iterator) return function* () {};
      if (key === 'then') return undefined;           // not a promise
      if (typeof key === 'symbol') return t[key];
      if (!props.has(key)) props.set(key, anything());
      return props.get(key);
    },
    set(t, key, value) { props.set(key, value); return true; },
    has() { return true; },
    apply() { return anything(); },
    construct() { return anything(); },
  });
  propsOf.set(proxy, props);
  return proxy;
}

const errors = [];
const page = anything();
Object.assign(globalThis, {
  window: globalThis,
  document: page,
  location: new URL('https://example.test/TinCAN/apps/page/'),
  isSecureContext: true,
  devicePixelRatio: 1,
  Node: class {},
  getComputedStyle: () => anything(),
  addEventListener: () => {},
  requestAnimationFrame: () => 0,
  localStorage: { getItem: () => null, setItem: () => {} },
});
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'test', mediaDevices: { getUserMedia: async () => anything(), enumerateDevices: async () => [] } },
});
process.on('unhandledRejection', (err) => errors.push(err));

for (const app of ['console', 'snooper', 'simulator', 'selftest', 'bands']) {
  test(`the ${app} page's script runs to completion on load`, async () => {
    await import(`../apps/${app}/app.js`);
    await new Promise((r) => setTimeout(r, 20));      // let start-up promises settle
    assert.deepEqual(errors.map((e) => e.stack || String(e)), []);
  });
}
