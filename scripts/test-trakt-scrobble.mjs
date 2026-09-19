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

// ── client slice ─────────────────────────────────────────────────────────────

const CLIENT_NAMES = [
    'traktEnabled', 'traktThreshold', 'traktRequest', 'validateTraktClientId',
    'traktLoadToken', 'traktSaveToken', 'traktClearToken', 'traktLoadPrompted', 'traktMarkPrompted',
    'traktStartDeviceAuth', 'traktPollDeviceToken', 'traktRefreshToken', 'traktEnsureToken', 'traktSubmit',
];

// Fresh fake environment per test: Map-backed localStorage, a scripted GM_xmlhttpRequest that
// replays `replies` in order ({status, body} | 'error') and records every request it sees.
function loadClient() {
    const store = new Map();
    const localStorage = {
        getItem: k => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: k => { store.delete(k); },
    };
    const getKey = id => localStorage.getItem(id) || '';
    const replies = [];
    const requests = [];
    const GM_xmlhttpRequest = opts => {
        requests.push(opts);
        const next = replies.shift();
        queueMicrotask(() => {
            if (!next || next === 'error') return opts.onerror && opts.onerror();
            opts.onload({ status: next.status, responseText: next.body === undefined ? '' : JSON.stringify(next.body) });
        });
    };
    const code = `${slice('trakt-helpers')}\n${slice('trakt-client')}\n;return { ${CLIENT_NAMES.join(', ')} };`;
    // eslint-disable-next-line no-new-func
    const api = new Function('GM_xmlhttpRequest', 'localStorage', 'getKey', code)(GM_xmlhttpRequest, localStorage, getKey);
    return { api, store, replies, requests };
}

const SNAP = { imdbId: 'tt0087332', title: 'Ghostbusters', year: '1984', poster: '' };
const ADDED = { status: 201, body: { added: { movies: 1 }, not_found: { movies: [] } } };
const DAY = 24 * 60 * 60 * 1000;
function withKeys(env) {
    env.store.set('sc_trakt_client_id', 'cid');
    env.store.set('sc_trakt_client_secret', 'sec');
}
function withToken(env, over = {}) {
    withKeys(env);
    env.store.set('sc_trakt_token', JSON.stringify({ access: 'A1', refresh: 'R1', expiresAt: Date.now() + 30 * DAY, clientId: 'cid', ...over }));
}
const tokenReply = (access, refresh) => ({
    status: 200,
    body: { access_token: access, refresh_token: refresh, expires_in: 7776000, created_at: Math.floor(Date.now() / 1000) },
});

await test('config accessors read settings', () => {
    const env = loadClient();
    assert.equal(env.api.traktEnabled(), false);
    env.store.set('sc_trakt_enabled', 'on');
    assert.equal(env.api.traktEnabled(), true);
    assert.equal(env.api.traktThreshold(), 90);
    env.store.set('sc_trakt_threshold', '75');
    assert.equal(env.api.traktThreshold(), 75);
});

await test('prompted slot round-trips and tolerates corrupt JSON', () => {
    const env = loadClient();
    assert.equal(env.api.traktLoadPrompted(), null);
    env.api.traktMarkPrompted('tt1', 'shown');
    const p = env.api.traktLoadPrompted();
    assert.equal(p.imdbId, 'tt1');
    assert.equal(p.outcome, 'shown');
    assert.ok(Math.abs(p.ts - Date.now()) < 2000);
    env.store.set('sc_trakt_prompted', '{not json');
    assert.equal(env.api.traktLoadPrompted(), null);
});

await test('validateTraktClientId maps status codes', async () => {
    for (const [reply, expected] of [[{ status: 200, body: [] }, 'valid'], [{ status: 403, body: {} }, 'invalid'],
                                     [{ status: 401, body: {} }, 'invalid'], [{ status: 500, body: {} }, 'error'], ['error', 'error']]) {
        const env = loadClient();
        env.replies.push(reply);
        assert.equal(await env.api.validateTraktClientId('cid'), expected);
        assert.match(env.requests[0].url, /\/movies\/trending\?limit=1$/);
        assert.equal(env.requests[0].headers['trakt-api-key'], 'cid');
    }
});

await test('traktSubmit: no token -> auth without touching the network', async () => {
    const env = loadClient();
    withKeys(env);
    assert.deepEqual(await env.api.traktSubmit(SNAP, 0), { result: 'auth', ratingFailed: false });
    assert.equal(env.requests.length, 0);
});

await test('traktSubmit: token for a different client id is unusable', async () => {
    const env = loadClient();
    withToken(env, { clientId: 'someone-else' });
    assert.equal((await env.api.traktSubmit(SNAP, 0)).result, 'auth');
    assert.equal(env.requests.length, 0);
});

await test('traktSubmit: success sends one authorized history request', async () => {
    const env = loadClient();
    withToken(env);
    env.replies.push(ADDED);
    assert.deepEqual(await env.api.traktSubmit(SNAP, 0), { result: 'added', ratingFailed: false });
    assert.equal(env.requests.length, 1);
    assert.match(env.requests[0].url, /^https:\/\/api\.trakt\.tv\/sync\/history$/);
    assert.equal(env.requests[0].method, 'POST');
    assert.equal(env.requests[0].headers['Authorization'], 'Bearer A1');
    assert.equal(env.requests[0].headers['trakt-api-key'], 'cid');
    assert.equal(env.requests[0].headers['trakt-api-version'], '2');
    assert.equal(JSON.parse(env.requests[0].data).movies[0].ids.imdb, 'tt0087332');
});

await test('traktSubmit: rating goes to /sync/ratings; a failed rating does not fail the watch', async () => {
    let env = loadClient();
    withToken(env);
    env.replies.push(ADDED, ADDED);
    assert.deepEqual(await env.api.traktSubmit(SNAP, 8), { result: 'added', ratingFailed: false });
    assert.equal(env.requests.length, 2);
    assert.match(env.requests[1].url, /\/sync\/ratings$/);
    assert.equal(JSON.parse(env.requests[1].data).movies[0].rating, 8);

    env = loadClient();
    withToken(env);
    env.replies.push(ADDED, { status: 500, body: {} });
    assert.deepEqual(await env.api.traktSubmit(SNAP, 8), { result: 'added', ratingFailed: true });
});

await test('traktSubmit: not_found, http error and network error', async () => {
    let env = loadClient();
    withToken(env);
    env.replies.push({ status: 201, body: { added: { movies: 0 }, not_found: { movies: [{ ids: { imdb: 'tt0087332' } }] } } });
    assert.equal((await env.api.traktSubmit(SNAP, 0)).result, 'not_found');

    env = loadClient();
    withToken(env);
    env.replies.push({ status: 500, body: {} });
    assert.equal((await env.api.traktSubmit(SNAP, 0)).result, 'error');

    env = loadClient();
    withToken(env);
    env.replies.push('error');
    assert.equal((await env.api.traktSubmit(SNAP, 0)).result, 'error');
});

await test('traktSubmit: 401 triggers one refresh then a retry with the new token', async () => {
    const env = loadClient();
    withToken(env);
    env.replies.push({ status: 401, body: {} }, tokenReply('A2', 'R2'), ADDED);
    assert.equal((await env.api.traktSubmit(SNAP, 0)).result, 'added');
    assert.match(env.requests[1].url, /\/oauth\/token$/);
    const refreshBody = JSON.parse(env.requests[1].data);
    assert.equal(refreshBody.grant_type, 'refresh_token');
    assert.equal(refreshBody.refresh_token, 'R1');
    assert.equal(refreshBody.client_secret, 'sec');
    assert.equal(refreshBody.redirect_uri, 'urn:ietf:wg:oauth:2.0:oob');
    assert.equal(env.requests[2].headers['Authorization'], 'Bearer A2');
    assert.equal(JSON.parse(env.store.get('sc_trakt_token')).access, 'A2');
});

await test('traktSubmit: 401 then rejected refresh -> auth and token cleared', async () => {
    const env = loadClient();
    withToken(env);
    env.replies.push({ status: 401, body: {} }, { status: 401, body: {} });
    assert.equal((await env.api.traktSubmit(SNAP, 0)).result, 'auth');
    assert.equal(env.store.has('sc_trakt_token'), false);
});

await test('traktSubmit: 401 then transient refresh failure -> error (Retry), token kept', async () => {
    const env = loadClient();
    withToken(env);
    env.replies.push({ status: 401, body: {} }, 'error');
    assert.deepEqual(await env.api.traktSubmit(SNAP, 0), { result: 'error', ratingFailed: false });
    assert.equal(env.store.has('sc_trakt_token'), true);
    assert.equal(JSON.parse(env.store.get('sc_trakt_token')).access, 'A1');
});

await test('traktSubmit: hard-expired token with transient refresh failure -> error, token kept', async () => {
    const env = loadClient();
    withToken(env, { expiresAt: Date.now() - 1000 });
    env.replies.push('error');
    assert.equal((await env.api.traktSubmit(SNAP, 0)).result, 'error');
    assert.equal(env.store.has('sc_trakt_token'), true);
});

await test('traktEnsureToken: refresh network failure keeps a not-yet-expired token, drops an expired one', async () => {
    let env = loadClient();
    withToken(env, { expiresAt: Date.now() + 60 * 60 * 1000 });   // inside the 1-day window, still valid
    env.replies.push('error');
    assert.equal((await env.api.traktEnsureToken()).access, 'A1');

    env = loadClient();
    withToken(env, { expiresAt: Date.now() - 1000 });             // already expired
    env.replies.push('error');
    assert.equal(await env.api.traktEnsureToken(), null);
});

await test('traktStartDeviceAuth returns the device payload or throws', async () => {
    let env = loadClient();
    withKeys(env);
    const dev = { device_code: 'D', user_code: 'ABCD1234', verification_url: 'https://trakt.tv/activate', expires_in: 600, interval: 5 };
    env.replies.push({ status: 200, body: dev });
    assert.deepEqual(await env.api.traktStartDeviceAuth(), dev);
    assert.equal(JSON.parse(env.requests[0].data).client_id, 'cid');

    env = loadClient();
    withKeys(env);
    env.replies.push({ status: 403, body: {} });
    await assert.rejects(() => env.api.traktStartDeviceAuth());
});

await test('traktPollDeviceToken: pending, slow-down, then success saves the token', async () => {
    const env = loadClient();
    withKeys(env);
    env.replies.push({ status: 400, body: {} }, { status: 429, body: {} }, tokenReply('A9', 'R9'));
    const sleeps = [];
    const handle = { cancelled: false };
    const result = await env.api.traktPollDeviceToken({ device_code: 'D', expires_in: 600, interval: 5 }, handle, async ms => { sleeps.push(ms); });
    assert.equal(result, 'ok');
    assert.deepEqual(sleeps, [5000, 5000, 6000]);   // 429 adds 1 s to the interval
    const saved = JSON.parse(env.store.get('sc_trakt_token'));
    assert.equal(saved.access, 'A9');
    assert.equal(saved.clientId, 'cid');
    const body = JSON.parse(env.requests[2].data);
    assert.equal(body.code, 'D');
    assert.equal(body.client_secret, 'sec');
});

await test('traktPollDeviceToken: denied, expired, error and cancel', async () => {
    const run = async reply => {
        const env = loadClient();
        withKeys(env);
        env.replies.push(reply);
        return env.api.traktPollDeviceToken({ device_code: 'D', expires_in: 600, interval: 5 }, { cancelled: false }, async () => {});
    };
    assert.equal(await run({ status: 418, body: {} }), 'denied');
    assert.equal(await run({ status: 410, body: {} }), 'expired');
    assert.equal(await run({ status: 404, body: {} }), 'expired');
    assert.equal(await run({ status: 401, body: {} }), 'error');

    const env = loadClient();
    withKeys(env);
    const handle = { cancelled: false };
    const r = await env.api.traktPollDeviceToken({ device_code: 'D', expires_in: 600, interval: 5 }, handle, async () => { handle.cancelled = true; });
    assert.equal(r, 'cancelled');
    assert.equal(env.requests.length, 0);
});

console.log(`OK: ${passed} trakt-scrobble test groups passed`);
