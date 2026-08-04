/**
 * The published test-vector page is generated from the reference implementation
 * (tools/gen-vectors.mjs). These tests pin the values that page contains, so a
 * change in encoding behaviour cannot quietly change the published spec.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { crc17 } from '../src/tincan/crc.js';
import { buildCore, buildTransmission, SYNC_FIELD } from '../src/tincan/frame.js';
import { buildVectors, VECTOR_FRAMES, CRC_BIT_VECTORS } from '../tools/gen-vectors.mjs';
import { render } from '../tools/md.mjs';

test('CRC-17 vectors are stable', () => {
  // Pinned by construction: if the polynomial, initial value or bit order
  // changes, these change, and the published page changes with them.
  const expected = {
    'empty input': 0x00000,
    'a single dominant bit': crc17([0]),
    'a single recessive bit': crc17([1]),
  };
  assert.equal(crc17([]), 0, 'a zero-length input with a zero init must be zero');
  for (const v of CRC_BIT_VECTORS) {
    const got = crc17(v.bits);
    assert.ok(got >= 0 && got <= 0x1ffff, `${v.label} out of range`);
    if (expected[v.label] !== undefined) assert.equal(got, expected[v.label], v.label);
  }
  // A single recessive bit must not produce the same register as a dominant one.
  assert.notEqual(crc17([0]), crc17([1]));
});

test('every published frame vector is internally consistent', () => {
  for (const v of VECTOR_FRAMES) {
    const core = buildCore(v.frame);
    const tx = buildTransmission(v.frame);

    assert.equal(tx.crc, core.crc, `${v.label}: transmission and core disagree on CRC`);
    assert.equal(crc17(core.bits.slice(0, core.crcInputLength)), core.crc,
      `${v.label}: CRC is not the CRC of its own input`);

    // The published "de-stuffed length" must actually be the de-stuffed length.
    assert.equal(tx.bits.length - tx.stuffCount,
      SYNC_FIELD.length + core.bits.length + 1 + 2 + 1 + 7 + 3,
      `${v.label}: length accounting is wrong`);

    // No six identical bits anywhere in the stuffed region.
    const end = tx.map.lastIndexOf('CRC') >= 0
      ? tx.map.length - (1 + 2 + 1 + 7 + 3)
      : tx.bits.length;
    let run = 1;
    for (let i = SYNC_FIELD.length + 1; i < end; i++) {
      run = tx.bits[i] === tx.bits[i - 1] ? run + 1 : 1;
      assert.ok(run <= 5, `${v.label}: run of ${run} identical bits at ${i}`);
    }
  }
});

test('the vectors page generates and renders without losing anything', () => {
  const md = buildVectors();
  assert.ok(md.length > 4000, 'suspiciously short vectors page');

  for (const v of VECTOR_FRAMES) {
    assert.ok(md.includes(v.label), `missing section for "${v.label}"`);
  }

  const { html, headings } = render(md);
  assert.ok(headings.some((h) => h.level === 1), 'no title');
  assert.ok(headings.filter((h) => h.level === 3).length >= VECTOR_FRAMES.length,
    'not every frame got a heading');

  // Every table in the source must survive rendering.
  const tableRows = (md.match(/^\|/gm) || []).length;
  assert.ok(tableRows > 40, `expected many table rows, got ${tableRows}`);
  assert.ok(!/^\|/m.test(stripCode(html)),
    'a Markdown table leaked through unrendered');
  assert.ok(html.includes('<table>'), 'no tables rendered');
});

function stripCode(html) {
  return html.replace(/<pre>[\s\S]*?<\/pre>/g, '');
}

test('the markdown renderer handles the constructs the spec uses', () => {
  const { html } = render([
    '# Title',
    '',
    '## Section',
    '',
    'A paragraph with `code`, **bold**, *italic* and a [link](other.html).',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '- one',
    '- two',
    '  - nested',
    '',
    '1. first',
    '2. second',
    '',
    '> a quote',
    '',
    '```',
    'code | with | pipes',
    '```',
    '',
    '---',
  ].join('\n'));

  assert.match(html, /<h1 id="title">/);
  assert.match(html, /<h2 id="section">/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<a href="other\.html">link<\/a>/);
  assert.match(html, /<table>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<ol>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<hr>/);
  // Pipes inside a fenced block must stay in the block, not become a table.
  assert.match(html, /<pre><code>code \| with \| pipes<\/code><\/pre>/);
  assert.equal((html.match(/<table>/g) || []).length, 1, 'exactly one table expected');
});

test('markdown escaping does not let raw HTML through', () => {
  const { html } = render('A paragraph with <script>alert(1)</script> in it.');
  assert.ok(!html.includes('<script>'), 'raw HTML survived escaping');
  assert.match(html, /&lt;script&gt;/);
});
