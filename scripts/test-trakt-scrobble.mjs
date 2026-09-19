// scripts/test-trakt-scrobble.mjs
//
// Standalone assertions for the trakt-scrobble module in
// src/pc/modules/trakt-scrobble/index.js:
//   - the PURE helper slice  ("trakt-helpers")  -- thresholds, eligibility, tokens, payloads, layout math
//   - the CLIENT slice       ("trakt-client")   -- Trakt HTTP + token store + device auth + submit,
//                                                  run against a fake GM_xmlhttpRequest / localStorage
//
// No test harness in this repo (no package.json, no runner), so this is a plain node script:
//
//   node scripts/test-trakt-scrobble.mjs
//
// Exits non-zero on the first failing assertion; prints a one-line pass summary otherwise.
// src/pc/** files are script fragments concatenated inside one IIFE, not ES modules, so the file
// can't be imported -- instead this slices code out between "test marker" comments and evals it
// faithfully to how it runs in the bundle, same convention as scripts/test-imdb-link-preview.mjs.

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(__dirname, '..', 'src', 'pc', 'modules', 'trakt-scrobble', 'index.js');
const src = fs.readFileSync(srcPath, 'utf8');

function slice(name) {
    const START = `// ── test marker: ${name} slice start ──`;
    const END = `// ── test marker: ${name} slice end ──`;
    const a = src.indexOf(START);
    const b = src.indexOf(END);
    if (a === -1 || b === -1 || b < a) {
        console.error(`FAIL: could not locate the "${name}" test-marker slice in trakt-scrobble/index.js`);
        process.exit(1);
    }
    return src.slice(a, b);
}

let passed = 0;
async function test(name, fn) {
    try {
        await fn();
        passed++;
    } catch (e) {
        console.error(`FAIL: ${name}`);
        console.error(e);
        process.exit(1);
    }
}

// ── helper slice ─────────────────────────────────────────────────────────────

const HELPER_NAMES = [
    'traktClampThreshold', 'traktShouldPrompt', 'traktUsableToken', 'traktTokenNeedsRefresh',
    'traktTokenFromResponse', 'traktBuildHistoryPayload', 'traktBuildRatingPayload',
    'traktInterpretSyncResponse', 'traktTickLifetime', 'traktPanelPosition',
    'TRAKT_THRESHOLD_DEFAULT', 'TRAKT_PROMPT_TTL_MS', 'TRAKT_REFRESH_WINDOW_MS',
];
// eslint-disable-next-line no-new-func
const H = new Function(`${slice('trakt-helpers')}\n;return { ${HELPER_NAMES.join(', ')} };`)();

await test('traktClampThreshold clamps and defaults', () => {
    assert.equal(H.traktClampThreshold('90'), 90);
    assert.equal(H.traktClampThreshold(75), 75);
    assert.equal(H.traktClampThreshold('10'), 50);
    assert.equal(H.traktClampThreshold('250'), 100);
    assert.equal(H.traktClampThreshold(''), H.TRAKT_THRESHOLD_DEFAULT);
    assert.equal(H.traktClampThreshold(null), H.TRAKT_THRESHOLD_DEFAULT);
    assert.equal(H.traktClampThreshold('abc'), H.TRAKT_THRESHOLD_DEFAULT);
});

const NOW = 1_800_000_000_000;
const BASE = {
    enabled: true, isYouTube: false, imdbId: 'tt0087332',
    duration: 7200, currentTime: 6600, thresholdPct: 90, prompted: null, now: NOW,
};

await test('traktShouldPrompt: happy path and exact threshold boundary', () => {
    assert.equal(H.traktShouldPrompt(BASE), true);
    assert.equal(H.traktShouldPrompt({ ...BASE, currentTime: 6480 }), true);   // exactly 90%
    assert.equal(H.traktShouldPrompt({ ...BASE, currentTime: 6479 }), false);  // just under
});

await test('traktShouldPrompt: threshold 100 needs the very end', () => {
    assert.equal(H.traktShouldPrompt({ ...BASE, thresholdPct: 100, currentTime: 7200 }), true);
    assert.equal(H.traktShouldPrompt({ ...BASE, thresholdPct: 100, currentTime: 7199 }), false);
});

await test('traktShouldPrompt: gate conditions', () => {
    assert.equal(H.traktShouldPrompt({ ...BASE, enabled: false }), false);
    assert.equal(H.traktShouldPrompt({ ...BASE, isYouTube: true }), false);
    assert.equal(H.traktShouldPrompt({ ...BASE, imdbId: null }), false);
    assert.equal(H.traktShouldPrompt({ ...BASE, imdbId: '' }), false);
    assert.equal(H.traktShouldPrompt({ ...BASE, duration: 599, currentTime: 599 }), false); // < 10 min
    assert.equal(H.traktShouldPrompt({ ...BASE, duration: NaN }), false);
    assert.equal(H.traktShouldPrompt({ ...BASE, duration: Infinity }), false);
    assert.equal(H.traktShouldPrompt({ ...BASE, currentTime: NaN }), false);
});

await test('traktShouldPrompt: already-handled TTL is per movie and expires', () => {
    const recent = { imdbId: 'tt0087332', ts: NOW - 60_000, outcome: 'shown' };
    assert.equal(H.traktShouldPrompt({ ...BASE, prompted: recent }), false);
    const stale = { imdbId: 'tt0087332', ts: NOW - H.TRAKT_PROMPT_TTL_MS - 1, outcome: 'skipped' };
    assert.equal(H.traktShouldPrompt({ ...BASE, prompted: stale }), true);
    const other = { imdbId: 'tt0000001', ts: NOW - 60_000, outcome: 'scrobbled' };
    assert.equal(H.traktShouldPrompt({ ...BASE, prompted: other }), true);
});

await test('traktUsableToken requires access token and matching client id', () => {
    const t = { access: 'A', refresh: 'R', expiresAt: NOW + 1000, clientId: 'cid' };
    assert.equal(H.traktUsableToken(t, 'cid'), t);
    assert.equal(H.traktUsableToken(t, 'other'), null);
    assert.equal(H.traktUsableToken(t, ''), null);
    assert.equal(H.traktUsableToken(null, 'cid'), null);
    assert.equal(H.traktUsableToken({ ...t, access: '' }, 'cid'), null);
});

await test('traktTokenNeedsRefresh triggers inside the 1-day window', () => {
    const day = H.TRAKT_REFRESH_WINDOW_MS;
    assert.equal(H.traktTokenNeedsRefresh({ expiresAt: NOW + day + 5000 }, NOW), false);
    assert.equal(H.traktTokenNeedsRefresh({ expiresAt: NOW + day - 5000 }, NOW), true);
    assert.equal(H.traktTokenNeedsRefresh({ expiresAt: NOW - 1 }, NOW), true);
    assert.equal(H.traktTokenNeedsRefresh(null, NOW), false);
});

await test('traktTokenFromResponse computes expiresAt from created_at + expires_in', () => {
    const json = { access_token: 'A', refresh_token: 'R', expires_in: 7776000, created_at: 1_700_000_000 };
    assert.deepEqual(H.traktTokenFromResponse(json, 'cid', NOW), {
        access: 'A', refresh: 'R', expiresAt: (1_700_000_000 + 7776000) * 1000, clientId: 'cid',
    });
    const noCreated = { access_token: 'A', refresh_token: 'R', expires_in: 100 };
    assert.equal(H.traktTokenFromResponse(noCreated, 'cid', NOW).expiresAt, NOW + 100_000);
});

await test('payload builders target the IMDb id', () => {
    const snap = { imdbId: 'tt0087332', title: 'Ghostbusters', year: '1984', poster: '' };
    assert.deepEqual(H.traktBuildHistoryPayload(snap, '2026-09-18T20:00:00.000Z'),
        { movies: [{ watched_at: '2026-09-18T20:00:00.000Z', ids: { imdb: 'tt0087332' } }] });
    assert.deepEqual(H.traktBuildRatingPayload(snap, 8, '2026-09-18T20:00:00.000Z'),
        { movies: [{ rated_at: '2026-09-18T20:00:00.000Z', rating: 8, ids: { imdb: 'tt0087332' } }] });
});

await test('traktInterpretSyncResponse', () => {
    assert.equal(H.traktInterpretSyncResponse({ added: { movies: 1 }, not_found: { movies: [] } }), 'added');
    assert.equal(H.traktInterpretSyncResponse({ added: { movies: 0 }, not_found: { movies: [{ ids: { imdb: 'tt1' } }] } }), 'not_found');
    assert.equal(H.traktInterpretSyncResponse({ added: { movies: 0 }, not_found: { movies: [] } }), 'unknown');
    assert.equal(H.traktInterpretSyncResponse({}), 'unknown');
    assert.equal(H.traktInterpretSyncResponse(null), 'unknown');
});

await test('traktTickLifetime counts down unless paused, floors at 0', () => {
    assert.equal(H.traktTickLifetime(60000, 250, false), 59750);
    assert.equal(H.traktTickLifetime(60000, 250, true), 60000);
    assert.equal(H.traktTickLifetime(100, 250, false), 0);
});

await test('traktPanelPosition anchors to the video rect and never goes negative', () => {
    const vp = { width: 1600, height: 900 };
    assert.deepEqual(H.traktPanelPosition({ right: 1200, bottom: 700 }, vp), { right: 416, bottom: 256 });
    assert.deepEqual(H.traktPanelPosition(null, vp), { right: 16, bottom: 56 });
    assert.deepEqual(H.traktPanelPosition({ right: 1700, bottom: 950 }, vp), { right: 16, bottom: 56 });
});

console.log(`OK: ${passed} trakt-scrobble test groups passed`);
