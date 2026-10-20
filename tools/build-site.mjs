#!/usr/bin/env node
/**
 * Build the TinCAN Pages site into `_site/`.
 *
 * Zero dependencies, by design: the whole site is static files plus a small
 * Markdown renderer, so `node tools/build-site.mjs` is the entire toolchain and
 * there is no lockfile to rot.
 *
 * The published tree mirrors the repository tree exactly, so
 * `python3 -m http.server` in the repository root serves the same site (with
 * unrendered spec Markdown) that Pages serves.
 */

import { mkdir, readFile, writeFile, cp, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { render, toc, escapeHtml } from './md.mjs';
import { buildVectors } from './gen-vectors.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '_site');

const NAV = [
  ['spec/tincan-1.0.html', 'Part 1'],
  ['spec/transport.html', 'Part 2'],
  ['spec/rationale.html', 'Rationale'],
  ['spec/vectors.html', 'Test vectors'],
  ['apps/snooper/', 'Snooper'],
  ['apps/console/', 'Console'],
  ['apps/simulator/', 'Simulator'],
  ['apps/selftest/', 'Self-test'],
];

const PAGES = [
  { src: 'spec/tincan-1.0.md', dest: 'spec/tincan-1.0.html', nav: 'Part 1' },
  { src: 'spec/transport.md', dest: 'spec/transport.html', nav: 'Part 2' },
  { src: 'spec/rationale.md', dest: 'spec/rationale.html', nav: 'Rationale' },
];

function layout({ title, description, body, nav, depth }) {
  const up = '../'.repeat(depth);
  const links = NAV.map(([href, label]) =>
    `<a href="${up}${href}"${label === nav ? ' aria-current="page"' : ''}>${label}</a>`).join('\n      ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="stylesheet" href="${up}style.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='13' font-size='13'>🥫</text></svg>">
</head>
<body>
<header class="topbar">
  <a class="brand" href="${up}">Tin<span>CAN</span></a>
  <nav>
      ${links}
      <a href="https://github.com/curtcox/TinCAN">GitHub</a>
  </nav>
</header>
<main class="wrap">
<article class="prose">
${body}
</article>
</main>
<footer class="site">
  TinCAN 1.0.0-draft ·
  <a href="${up}">specification and apps</a> ·
  <a href="https://github.com/curtcox/TinCAN">source</a>
</footer>
</body>
</html>
`;
}

/**
 * Cross-document links in the Markdown are written as `foo.html` so that the
 * published site works; nothing to rewrite, but check they resolve.
 */
function checkLinks(html, dest, produced) {
  const problems = [];
  for (const m of html.matchAll(/href="([^"#][^"]*?)"/g)) {
    const href = m[1];
    if (/^(https?:|mailto:|data:)/.test(href)) continue;
    const target = resolve(dirname(join(out, dest)), href.split('#')[0]);
    if (!produced.has(target) && !existsSync(target)) {
      problems.push(`${dest} → ${href}`);
    }
  }
  return problems;
}

async function main() {
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, 'spec'), { recursive: true });

  // Static assets, copied so that the published paths match the repository's.
  await cp(join(root, 'index.html'), join(out, 'index.html'));
  await cp(join(root, 'style.css'), join(out, 'style.css'));
  await cp(join(root, 'apps'), join(out, 'apps'), { recursive: true });
  await cp(join(root, 'src'), join(out, 'src'), { recursive: true });
  await writeFile(join(out, '.nojekyll'), '');

  const produced = new Set();
  const rendered = [];

  for (const page of PAGES) {
    const md = await readFile(join(root, page.src), 'utf8');
    const { html, headings, title } = render(md);
    const description = firstParagraph(md);
    const body = insertToc(html, toc(headings));
    const file = join(out, page.dest);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, layout({
      title: `${title} — TinCAN`,
      description,
      body,
      nav: page.nav,
      depth: page.dest.split('/').length - 1,
    }));
    produced.add(file);
    rendered.push({ ...page, html: body, headings });
    console.log(`  rendered ${page.src} → ${page.dest} (${headings.length} headings)`);
  }

  // Test vectors, generated from the reference implementation so that the
  // document and the code cannot drift apart.
  const vectorsMd = await buildVectors();
  const v = render(vectorsMd);
  const vectorsFile = join(out, 'spec/vectors.html');
  await writeFile(vectorsFile, layout({
    title: 'Test vectors — TinCAN',
    description: 'CRC-17 and on-air bit sequence test vectors, generated from the TinCAN reference implementation.',
    body: insertToc(v.html, toc(v.headings)),
    nav: 'Test vectors',
    depth: 1,
  }));
  produced.add(vectorsFile);
  rendered.push({ dest: 'spec/vectors.html', html: v.html });
  console.log('  generated spec/vectors.html from the reference implementation');

  // Link check across everything we produced plus the hand-written pages.
  const problems = [];
  for (const r of rendered) problems.push(...checkLinks(r.html, r.dest, produced));
  const indexHtml = await readFile(join(out, 'index.html'), 'utf8');
  problems.push(...checkLinks(indexHtml, 'index.html', produced));
  for (const app of await readdir(join(out, 'apps'), { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    const p = join('apps', app.name, 'index.html');
    problems.push(...checkLinks(await readFile(join(out, p), 'utf8'), p, produced));
  }

  if (problems.length) {
    console.error('\nbroken links:');
    for (const p of problems) console.error(`  ${p}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nsite built into ${out}`);
}

/** Put the table of contents after the page title rather than above it. */
function insertToc(html, tocHtml) {
  if (!tocHtml) return html;
  const end = html.indexOf('</h1>');
  if (end < 0) return tocHtml + '\n' + html;
  return html.slice(0, end + 5) + '\n' + tocHtml + html.slice(end + 5);
}

function firstParagraph(md) {
  const lines = md.split('\n');
  const buf = [];
  for (const line of lines) {
    if (/^[#*>|-]/.test(line) || /^\*\*/.test(line)) { if (buf.length) break; continue; }
    if (!line.trim()) { if (buf.length) break; continue; }
    buf.push(line.trim());
  }
  return buf.join(' ').replace(/[`*_]/g, '').slice(0, 200);
}

main().catch((err) => { console.error(err); process.exit(1); });
