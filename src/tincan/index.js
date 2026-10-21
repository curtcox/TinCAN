/**
 * TinCAN reference implementation.
 *
 * Spec: spec/tincan-1.0.md (Part 1), spec/transport.md (Part 2).
 *
 * Nothing in this bundle other than `modem.js` touches the DOM or Web Audio,
 * so `protocol.js`, `phy.js` and `bus.js` run unchanged in Node, in a worker,
 * and inside an AudioWorkletGlobalScope.
 */

export * from './params.js';
export * from './crc.js';
export * from './frame.js';
export * from './protocol.js';
export { Phy } from './phy.js';
export * from './bus.js';
export * from './transport.js';
export * from './bandtest.js';

export const VERSION = '1.0.0-draft';
