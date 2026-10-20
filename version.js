/**
 * Which build of the site this is.
 *
 * This copy is what a checkout serves: no commit, because files served straight
 * from a working tree may not match any commit. `npm run build` replaces it in
 * `_site/` with the commit it built and when, and writes the same values to
 * `_site/version.json`, so that
 *
 *   curl https://curtcox.github.io/TinCAN/version.json
 *
 * says what is deployed, and every page and report says what it was loaded from.
 */
export const BUILD = {
  commit: null,
  committedAt: null,
  deployedAt: null,
  dirty: false,
  run: null,
};

const REPO = 'https://github.com/curtcox/TinCAN';

/** `2026-10-20T19:12:03.456Z` → `2026-10-20 19:12 UTC`. */
function utc(iso) {
  return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : '';
}

/**
 * How to show a build: `short` to compare at a glance, `text` for the page,
 * `title` for a tooltip with the full commit, `url` for the commit on GitHub.
 */
export function describeBuild(b = BUILD) {
  if (!b.commit) {
    return { short: 'unbuilt', text: 'development copy (not a build)', title: 'Served from a working tree, not from npm run build', url: null };
  }
  const short = b.commit.slice(0, 7) + (b.dirty ? '+changes' : '');
  const when = b.run ? 'deployed' : 'built locally';
  return {
    short,
    text: `${short} · ${when} ${utc(b.deployedAt)}`,
    title: `commit ${b.commit}${b.dirty ? ' with uncommitted changes' : ''}`
      + (b.committedAt ? `, committed ${utc(new Date(b.committedAt).toISOString())}` : '')
      + `, ${when} ${utc(b.deployedAt)}`,
    url: `${REPO}/commit/${b.commit}`,
  };
}
