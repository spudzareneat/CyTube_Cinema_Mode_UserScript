// scripts/test-simkl-scrobble.mjs
//
// Standalone assertions for the simkl-scrobble module in
// src/pc/modules/simkl-scrobble/index.js:
//   - the PURE helper slice  ("simkl-helpers")  -- thresholds, eligibility, tokens, payloads, layout math
//   - the CLIENT slice       ("simkl-client")   -- Simkl HTTP + token store + device auth + submit,
//                                                  run against a fake GM_xmlhttpRequest / localStorage
//
// No test harness in this repo (no package.json, no runner), so this is a plain node script:
//
//   node scripts/test-simkl-scrobble.mjs
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
const srcPath = path.join(__dirname, '..', 'src', 'pc', 'modules', 'simkl-scrobble', 'index.js');
const src = fs.readFileSync(srcPath, 'utf8');

function slice(name) {
    const START = `// ── test marker: ${name} slice start ──`;
    const END = `// ── test marker: ${name} slice end ──`;
    const a = src.indexOf(START);
    const b = src.indexOf(END);
    if (a === -1 || b === -1 || b < a) {
        console.error(`FAIL: could not locate the "${name}" test-marker slice in simkl-scrobble/index.js`);
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
    'simklClampThreshold', 'simklShouldPrompt', 'simklUsableToken', 'simklTokenNeedsRefresh',
    'simklTokenFromResponse', 'simklBuildHistoryPayload', 'simklBuildRatingPayload',
    'simklInterpretSyncResponse', 'simklTickLifetime', 'simklPanelPosition',
    '_simklEsc', 'simklPastThreshold', 'simklIsHotkey',
    'SIMKL_THRESHOLD_DEFAULT', 'SIMKL_PROMPT_TTL_MS', 'SIMKL_REFRESH_WINDOW_MS',
];
// eslint-disable-next-line no-new-func
const H = new Function(`${slice('simkl-helpers')}\n;return { ${HELPER_NAMES.join(', ')} };`)();

await test('simklClampThreshold clamps and defaults', () => {
    assert.equal(H.simklClampThreshold('90'), 90);
    assert.equal(H.simklClampThreshold(75), 75);
    assert.equal(H.simklClampThreshold('10'), 50);
    assert.equal(H.simklClampThreshold('250'), 100);
    assert.equal(H.simklClampThreshold(''), H.SIMKL_THRESHOLD_DEFAULT);
    assert.equal(H.simklClampThreshold(null), H.SIMKL_THRESHOLD_DEFAULT);
    assert.equal(H.simklClampThreshold('abc'), H.SIMKL_THRESHOLD_DEFAULT);
});

const NOW = 1_800_000_000_000;
const BASE = {
    enabled: true, isYouTube: false, imdbId: 'tt0087332',
    duration: 7200, currentTime: 6600, thresholdPct: 90, prompted: null, now: NOW,
};

await test('simklShouldPrompt: happy path and exact threshold boundary', () => {
    assert.equal(H.simklShouldPrompt(BASE), true);
    assert.equal(H.simklShouldPrompt({ ...BASE, currentTime: 6480 }), true);   // exactly 90%
    assert.equal(H.simklShouldPrompt({ ...BASE, currentTime: 6479 }), false);  // just under
});

await test('simklShouldPrompt: threshold 100 needs the very end', () => {
    assert.equal(H.simklShouldPrompt({ ...BASE, thresholdPct: 100, currentTime: 7200 }), true);
    assert.equal(H.simklShouldPrompt({ ...BASE, thresholdPct: 100, currentTime: 7199 }), false);
});

await test('simklShouldPrompt: gate conditions', () => {
    assert.equal(H.simklShouldPrompt({ ...BASE, enabled: false }), false);
    assert.equal(H.simklShouldPrompt({ ...BASE, isYouTube: true }), false);
    assert.equal(H.simklShouldPrompt({ ...BASE, isEpisode: true }), false);
    assert.equal(H.simklShouldPrompt({ ...BASE, isEpisode: false }), true);
    assert.equal(H.simklShouldPrompt({ ...BASE, imdbId: null }), false);
    assert.equal(H.simklShouldPrompt({ ...BASE, imdbId: '' }), false);
    assert.equal(H.simklShouldPrompt({ ...BASE, duration: 599, currentTime: 599 }), false); // < 10 min
    assert.equal(H.simklShouldPrompt({ ...BASE, duration: NaN }), false);
    assert.equal(H.simklShouldPrompt({ ...BASE, duration: Infinity }), false);
    assert.equal(H.simklShouldPrompt({ ...BASE, currentTime: NaN }), false);
});

await test('simklShouldPrompt: already-handled TTL is per movie and expires', () => {
    const recent = { imdbId: 'tt0087332', ts: NOW - 60_000, outcome: 'shown' };
    assert.equal(H.simklShouldPrompt({ ...BASE, prompted: recent }), false);
    const stale = { imdbId: 'tt0087332', ts: NOW - H.SIMKL_PROMPT_TTL_MS - 1, outcome: 'skipped' };
    assert.equal(H.simklShouldPrompt({ ...BASE, prompted: stale }), true);
    const other = { imdbId: 'tt0000001', ts: NOW - 60_000, outcome: 'scrobbled' };
    assert.equal(H.simklShouldPrompt({ ...BASE, prompted: other }), true);
});

await test('simklUsableToken requires access token and matching client id', () => {
    const t = { access: 'A', refresh: 'R', expiresAt: NOW + 1000, clientId: 'cid' };
    assert.equal(H.simklUsableToken(t, 'cid'), t);
    assert.equal(H.simklUsableToken(t, 'other'), null);
    assert.equal(H.simklUsableToken(t, ''), null);
    assert.equal(H.simklUsableToken(null, 'cid'), null);
    assert.equal(H.simklUsableToken({ ...t, access: '' }, 'cid'), null);
});

await test('simklTokenNeedsRefresh triggers inside the 1-day window', () => {
    const day = H.SIMKL_REFRESH_WINDOW_MS;
    assert.equal(H.simklTokenNeedsRefresh({ expiresAt: NOW + day + 5000 }, NOW), false);
    assert.equal(H.simklTokenNeedsRefresh({ expiresAt: NOW + day - 5000 }, NOW), true);
    assert.equal(H.simklTokenNeedsRefresh({ expiresAt: NOW - 1 }, NOW), true);
    assert.equal(H.simklTokenNeedsRefresh(null, NOW), false);
});

await test('simklTokenFromResponse computes expiresAt from created_at + expires_in', () => {
    const json = { access_token: 'A', refresh_token: 'R', expires_in: 7776000, created_at: 1_700_000_000 };
    assert.deepEqual(H.simklTokenFromResponse(json, 'cid', NOW), {
        access: 'A', refresh: 'R', expiresAt: (1_700_000_000 + 7776000) * 1000, clientId: 'cid',
    });
    const noCreated = { access_token: 'A', refresh_token: 'R', expires_in: 100 };
    assert.equal(H.simklTokenFromResponse(noCreated, 'cid', NOW).expiresAt, NOW + 100_000);
});

await test('payload builders target the IMDb id', () => {
    const snap = { imdbId: 'tt0087332', title: 'Ghostbusters', year: '1984', poster: '' };
    assert.deepEqual(H.simklBuildHistoryPayload(snap, '2026-09-18T20:00:00.000Z'),
        { movies: [{ watched_at: '2026-09-18T20:00:00.000Z', ids: { imdb: 'tt0087332' } }] });
    assert.deepEqual(H.simklBuildRatingPayload(snap, 8, '2026-09-18T20:00:00.000Z'),
        { movies: [{ rated_at: '2026-09-18T20:00:00.000Z', rating: 8, ids: { imdb: 'tt0087332' } }] });
});

await test('simklInterpretSyncResponse', () => {
    assert.equal(H.simklInterpretSyncResponse({ added: { movies: 1 }, not_found: { movies: [] } }), 'added');
    assert.equal(H.simklInterpretSyncResponse({ added: { movies: 0 }, not_found: { movies: [{ ids: { imdb: 'tt1' } }] } }), 'not_found');
    assert.equal(H.simklInterpretSyncResponse({ added: { movies: 0 }, not_found: { movies: [] } }), 'unknown');
    assert.equal(H.simklInterpretSyncResponse({}), 'unknown');
    assert.equal(H.simklInterpretSyncResponse(null), 'unknown');
});

await test('simklTickLifetime counts down unless paused, floors at 0', () => {
    assert.equal(H.simklTickLifetime(60000, 250, false), 59750);
    assert.equal(H.simklTickLifetime(60000, 250, true), 60000);
    assert.equal(H.simklTickLifetime(100, 250, false), 0);
});

await test('simklPanelPosition anchors to the video rect and never goes negative', () => {
    const vp = { width: 1600, height: 900 };
    assert.deepEqual(H.simklPanelPosition({ right: 1200, bottom: 700 }, vp), { right: 416, bottom: 256 });
    assert.deepEqual(H.simklPanelPosition(null, vp), { right: 16, bottom: 56 });
    assert.deepEqual(H.simklPanelPosition({ right: 1700, bottom: 950 }, vp), { right: 16, bottom: 56 });
});

await test('_simklEsc escapes markup characters and blanks null/undefined', () => {
    assert.equal(H._simklEsc('a & b < c > d "e"'), 'a &amp; b &lt; c &gt; d &quot;e&quot;');
    assert.equal(H._simklEsc('<img src="x" onerror="1">'), '&lt;img src=&quot;x&quot; onerror=&quot;1&quot;&gt;');
    assert.equal(H._simklEsc(null), '');
    assert.equal(H._simklEsc(undefined), '');
    assert.equal(H._simklEsc(0), '0');
    assert.equal(H._simklEsc('plain'), 'plain');
});

await test('simklPastThreshold: exact boundary, under, bad inputs, threshold 100', () => {
    assert.equal(H.simklPastThreshold(6480, 7200, 90), true);    // exactly 90%
    assert.equal(H.simklPastThreshold(6479, 7200, 90), false);   // just under
    assert.equal(H.simklPastThreshold(7200, 7200, 100), true);
    assert.equal(H.simklPastThreshold(7199, 7200, 100), false);
    assert.equal(H.simklPastThreshold(7300, 7200, 90), true);    // past the end still counts
    assert.equal(H.simklPastThreshold(0, 7200, 90), false);
    assert.equal(H.simklPastThreshold(100, NaN, 90), false);
    assert.equal(H.simklPastThreshold(100, Infinity, 90), false);
    assert.equal(H.simklPastThreshold(100, 0, 90), false);
    assert.equal(H.simklPastThreshold(100, -50, 90), false);
    assert.equal(H.simklPastThreshold(NaN, 7200, 90), false);
    assert.equal(H.simklPastThreshold(-1, 7200, 90), false);
    assert.equal(H.simklPastThreshold(undefined, 7200, 90), false);
});

await test('simklIsHotkey is true only for a bare Alt+S', () => {
    assert.equal(H.simklIsHotkey({ altKey: true, code: 'KeyS' }), true);
    assert.equal(H.simklIsHotkey({ altKey: false, code: 'KeyS' }), false);
    assert.equal(H.simklIsHotkey({ code: 'KeyS' }), false);
    assert.equal(H.simklIsHotkey({ altKey: true, ctrlKey: true, code: 'KeyS' }), false);
    assert.equal(H.simklIsHotkey({ altKey: true, metaKey: true, code: 'KeyS' }), false);
    assert.equal(H.simklIsHotkey({ altKey: true, shiftKey: true, code: 'KeyS' }), false);
    assert.equal(H.simklIsHotkey({ altKey: true, code: 'KeyD' }), false);
    assert.equal(H.simklIsHotkey(null), false);
    assert.equal(H.simklIsHotkey(undefined), false);
});

// ── client slice ─────────────────────────────────────────────────────────────

const CLIENT_NAMES = [
    'simklEnabled', 'simklThreshold', 'simklRequest', 'validateSimklClientId',
    'simklLoadToken', 'simklSaveToken', 'simklClearToken', 'simklLoadPrompted', 'simklMarkPrompted',
    'simklStartDeviceAuth', 'simklPollDeviceToken', 'simklRefreshToken', 'simklEnsureToken', 'simklSubmit',
    'simklFetchUsername', 'simklConnectAndVerify',
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
    const setKey = (id, v) => localStorage.setItem(id, String(v).trim());   // core helper: trims on write
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
    const code = `${slice('simkl-helpers')}\n${slice('simkl-client')}\n;return { ${CLIENT_NAMES.join(', ')} };`;
    // eslint-disable-next-line no-new-func
    const api = new Function('GM_xmlhttpRequest', 'localStorage', 'getKey', 'setKey', code)(GM_xmlhttpRequest, localStorage, getKey, setKey);
    return { api, store, replies, requests };
}

const SNAP = { imdbId: 'tt0087332', title: 'Ghostbusters', year: '1984', poster: '' };
const ADDED = { status: 201, body: { added: { movies: 1 }, not_found: { movies: [] } } };
const DAY = 24 * 60 * 60 * 1000;
function withKeys(env) {
    env.store.set('sc_simkl_client_id', 'cid');
    env.store.set('sc_simkl_client_secret', 'sec');
}
function withToken(env, over = {}) {
    withKeys(env);
    env.store.set('sc_simkl_token', JSON.stringify({ access: 'A1', refresh: 'R1', expiresAt: Date.now() + 30 * DAY, clientId: 'cid', ...over }));
}
const tokenReply = (access, refresh) => ({
    status: 200,
    body: { access_token: access, refresh_token: refresh, expires_in: 7776000, created_at: Math.floor(Date.now() / 1000) },
});

await test('config accessors read settings', () => {
    const env = loadClient();
    assert.equal(env.api.simklEnabled(), false);
    env.store.set('sc_simkl_enabled', 'on');
    assert.equal(env.api.simklEnabled(), true);
    assert.equal(env.api.simklThreshold(), 90);
    env.store.set('sc_simkl_threshold', '75');
    assert.equal(env.api.simklThreshold(), 75);
});

await test('prompted slot round-trips and tolerates corrupt JSON', () => {
    const env = loadClient();
    assert.equal(env.api.simklLoadPrompted(), null);
    env.api.simklMarkPrompted('tt1', 'shown');
    const p = env.api.simklLoadPrompted();
    assert.equal(p.imdbId, 'tt1');
    assert.equal(p.outcome, 'shown');
    assert.ok(Math.abs(p.ts - Date.now()) < 2000);
    env.store.set('sc_simkl_prompted', '{not json');
    assert.equal(env.api.simklLoadPrompted(), null);
});

await test('validateSimklClientId maps status codes', async () => {
    for (const [reply, expected] of [[{ status: 200, body: [] }, 'valid'], [{ status: 403, body: {} }, 'invalid'],
                                     [{ status: 401, body: {} }, 'invalid'], [{ status: 500, body: {} }, 'error'], ['error', 'error']]) {
        const env = loadClient();
        env.replies.push(reply);
        assert.equal(await env.api.validateSimklClientId('cid'), expected);
        assert.match(env.requests[0].url, /\/movies\/trending\?limit=1$/);
        assert.equal(env.requests[0].headers['simkl-api-key'], 'cid');
    }
});

await test('simklSubmit: no token -> auth without touching the network', async () => {
    const env = loadClient();
    withKeys(env);
    assert.deepEqual(await env.api.simklSubmit(SNAP, 0), { result: 'auth', ratingFailed: false });
    assert.equal(env.requests.length, 0);
});

await test('simklSubmit: token for a different client id is unusable', async () => {
    const env = loadClient();
    withToken(env, { clientId: 'someone-else' });
    assert.equal((await env.api.simklSubmit(SNAP, 0)).result, 'auth');
    assert.equal(env.requests.length, 0);
});

await test('simklSubmit: success sends one authorized history request', async () => {
    const env = loadClient();
    withToken(env);
    env.replies.push(ADDED);
    assert.deepEqual(await env.api.simklSubmit(SNAP, 0), { result: 'added', ratingFailed: false });
    assert.equal(env.requests.length, 1);
    assert.match(env.requests[0].url, /^https:\/\/api\.trakt\.tv\/sync\/history$/);
    assert.equal(env.requests[0].method, 'POST');
    assert.equal(env.requests[0].headers['Authorization'], 'Bearer A1');
    assert.equal(env.requests[0].headers['simkl-api-key'], 'cid');
    assert.equal(env.requests[0].headers['simkl-api-version'], '2');
    assert.equal(JSON.parse(env.requests[0].data).movies[0].ids.imdb, 'tt0087332');
});

await test('simklSubmit: rating goes to /sync/ratings; a failed rating does not fail the watch', async () => {
    let env = loadClient();
    withToken(env);
    env.replies.push(ADDED, ADDED);
    assert.deepEqual(await env.api.simklSubmit(SNAP, 8), { result: 'added', ratingFailed: false });
    assert.equal(env.requests.length, 2);
    assert.match(env.requests[1].url, /\/sync\/ratings$/);
    assert.equal(JSON.parse(env.requests[1].data).movies[0].rating, 8);

    env = loadClient();
    withToken(env);
    env.replies.push(ADDED, { status: 500, body: {} });
    assert.deepEqual(await env.api.simklSubmit(SNAP, 8), { result: 'added', ratingFailed: true });
});

await test('simklSubmit: not_found, http error and network error', async () => {
    let env = loadClient();
    withToken(env);
    env.replies.push({ status: 201, body: { added: { movies: 0 }, not_found: { movies: [{ ids: { imdb: 'tt0087332' } }] } } });
    assert.equal((await env.api.simklSubmit(SNAP, 0)).result, 'not_found');

    env = loadClient();
    withToken(env);
    env.replies.push({ status: 500, body: {} });
    assert.equal((await env.api.simklSubmit(SNAP, 0)).result, 'error');

    env = loadClient();
    withToken(env);
    env.replies.push('error');
    assert.equal((await env.api.simklSubmit(SNAP, 0)).result, 'error');
});

await test('simklSubmit: 401 triggers one refresh then a retry with the new token', async () => {
    const env = loadClient();
    withToken(env);
    env.replies.push({ status: 401, body: {} }, tokenReply('A2', 'R2'), ADDED);
    assert.equal((await env.api.simklSubmit(SNAP, 0)).result, 'added');
    assert.match(env.requests[1].url, /\/oauth\/token$/);
    const refreshBody = JSON.parse(env.requests[1].data);
    assert.equal(refreshBody.grant_type, 'refresh_token');
    assert.equal(refreshBody.refresh_token, 'R1');
    assert.equal(refreshBody.client_secret, 'sec');
    assert.equal(refreshBody.redirect_uri, 'urn:ietf:wg:oauth:2.0:oob');
    assert.equal(env.requests[2].headers['Authorization'], 'Bearer A2');
    assert.equal(JSON.parse(env.store.get('sc_simkl_token')).access, 'A2');
});

await test('simklSubmit: 401 then rejected refresh -> auth and token cleared', async () => {
    const env = loadClient();
    withToken(env);
    env.replies.push({ status: 401, body: {} }, { status: 401, body: {} });
    assert.equal((await env.api.simklSubmit(SNAP, 0)).result, 'auth');
    assert.equal(env.store.has('sc_simkl_token'), false);
});

await test('simklSubmit: 401 then transient refresh failure -> error (Retry), token kept', async () => {
    const env = loadClient();
    withToken(env);
    env.replies.push({ status: 401, body: {} }, 'error');
    assert.deepEqual(await env.api.simklSubmit(SNAP, 0), { result: 'error', ratingFailed: false });
    assert.equal(env.store.has('sc_simkl_token'), true);
    assert.equal(JSON.parse(env.store.get('sc_simkl_token')).access, 'A1');
});

await test('simklSubmit: hard-expired token with transient refresh failure -> error, token kept', async () => {
    const env = loadClient();
    withToken(env, { expiresAt: Date.now() - 1000 });
    env.replies.push('error');
    assert.equal((await env.api.simklSubmit(SNAP, 0)).result, 'error');
    assert.equal(env.store.has('sc_simkl_token'), true);
});

await test('simklEnsureToken: refresh network failure keeps a not-yet-expired token, drops an expired one', async () => {
    let env = loadClient();
    withToken(env, { expiresAt: Date.now() + 60 * 60 * 1000 });   // inside the 1-day window, still valid
    env.replies.push('error');
    assert.equal((await env.api.simklEnsureToken()).access, 'A1');

    env = loadClient();
    withToken(env, { expiresAt: Date.now() - 1000 });             // already expired
    env.replies.push('error');
    assert.equal(await env.api.simklEnsureToken(), null);
});

await test('simklStartDeviceAuth returns the device payload or throws', async () => {
    let env = loadClient();
    withKeys(env);
    const dev = { device_code: 'D', user_code: 'ABCD1234', verification_url: 'https://trakt.tv/activate', expires_in: 600, interval: 5 };
    env.replies.push({ status: 200, body: dev });
    assert.deepEqual(await env.api.simklStartDeviceAuth(), dev);
    assert.equal(JSON.parse(env.requests[0].data).client_id, 'cid');

    env = loadClient();
    withKeys(env);
    env.replies.push({ status: 403, body: {} });
    await assert.rejects(() => env.api.simklStartDeviceAuth());
});

await test('simklPollDeviceToken: pending, slow-down, then success saves the token', async () => {
    const env = loadClient();
    withKeys(env);
    env.replies.push({ status: 400, body: {} }, { status: 429, body: {} }, tokenReply('A9', 'R9'));
    const sleeps = [];
    const handle = { cancelled: false };
    const result = await env.api.simklPollDeviceToken({ device_code: 'D', expires_in: 600, interval: 5 }, handle, async ms => { sleeps.push(ms); });
    assert.equal(result, 'ok');
    assert.deepEqual(sleeps, [5000, 5000, 6000]);   // 429 adds 1 s to the interval
    const saved = JSON.parse(env.store.get('sc_simkl_token'));
    assert.equal(saved.access, 'A9');
    assert.equal(saved.clientId, 'cid');
    const body = JSON.parse(env.requests[2].data);
    assert.equal(body.code, 'D');
    assert.equal(body.client_secret, 'sec');
});

await test('simklPollDeviceToken: denied, expired, error and cancel', async () => {
    const run = async reply => {
        const env = loadClient();
        withKeys(env);
        env.replies.push(reply);
        return env.api.simklPollDeviceToken({ device_code: 'D', expires_in: 600, interval: 5 }, { cancelled: false }, async () => {});
    };
    assert.equal(await run({ status: 418, body: {} }), 'denied');
    assert.equal(await run({ status: 410, body: {} }), 'expired');
    assert.equal(await run({ status: 404, body: {} }), 'expired');
    assert.equal(await run({ status: 401, body: {} }), 'error');

    const env = loadClient();
    withKeys(env);
    const handle = { cancelled: false };
    const r = await env.api.simklPollDeviceToken({ device_code: 'D', expires_in: 600, interval: 5 }, handle, async () => { handle.cancelled = true; });
    assert.equal(r, 'cancelled');
    assert.equal(env.requests.length, 0);
});

// ── Settings: simklFetchUsername + Connect & verify ──────────────────────────

const TOKEN_KEY = 'sc_simkl_token';
const DEV = { device_code: 'DEV123', user_code: 'ABCD1234', verification_url: 'https://trakt.tv/activate', expires_in: 600, interval: 5 };
const TRENDING_OK = { status: 200, body: [] };
const SETTINGS_OK = { status: 200, body: { user: { username: 'spud' } } };
const F_ID = 'sc-input-simkl-clientid';
const F_SECRET = 'sc-input-simkl-secret';
const CREDS = { [F_ID]: 'cid', [F_SECRET]: 'sec' };

// Fake Task-A ctx: records every setStatus/setDetail call; `open.v` flips isOpen().
function makeCtx(values, open = { v: true }) {
    const statuses = [];
    const details = [];
    const ctx = {
        getValue: id => String(values[id] == null ? '' : values[id]).trim(),
        setStatus: (text, kind) => { statuses.push({ text, kind }); },
        setDetail: html => { details.push(html); },
        isOpen: () => open.v,
    };
    return { ctx, statuses, details, open, last: () => statuses[statuses.length - 1] };
}
const instantSleep = async () => {};
const urlsOf = env => env.requests.map(r => r.method + ' ' + r.url.replace('https://api.trakt.tv', ''));

await test('simklFetchUsername: 200 returns the name and sends the Bearer token', async () => {
    const env = loadClient();
    withKeys(env);
    env.replies.push(SETTINGS_OK);
    assert.equal(await env.api.simklFetchUsername({ access: 'A1' }), 'spud');
    assert.equal(env.requests.length, 1);
    assert.equal(env.requests[0].method, 'GET');
    assert.equal(env.requests[0].url, 'https://api.trakt.tv/users/settings');
    assert.equal(env.requests[0].headers['Authorization'], 'Bearer A1');
    assert.equal(env.requests[0].headers['simkl-api-key'], 'cid');
});

await test('simklFetchUsername: 401, missing name and network error all give null', async () => {
    for (const reply of [{ status: 401, body: {} }, { status: 200, body: { user: {} } }, { status: 200, body: { user: { username: 42 } } }, 'error']) {
        const env = loadClient();
        withKeys(env);
        env.replies.push(reply);
        assert.equal(await env.api.simklFetchUsername({ access: 'A1' }), null);
    }
});

await test('connect: empty Client ID or Secret -> bad status, no requests, nothing saved', async () => {
    for (const values of [{}, { [F_ID]: 'cid' }, { [F_SECRET]: 'sec' }, { [F_ID]: '   ', [F_SECRET]: 'sec' }]) {
        const env = loadClient();
        const t = makeCtx(values);
        await env.api.simklConnectAndVerify(t.ctx, { cancelled: false }, instantSleep);
        assert.deepEqual(t.statuses, [{ text: 'Enter your Client ID and Client Secret first', kind: 'bad' }]);
        assert.equal(env.requests.length, 0);
        assert.equal(env.store.size, 0);
        assert.equal(t.details.length, 0);
    }
});

await test('connect: typed credentials are trimmed and saved before anything else happens', async () => {
    const env = loadClient();
    const t = makeCtx({ [F_ID]: '  typed-id  ', [F_SECRET]: ' typed-sec ' });
    env.replies.push({ status: 403, body: {} });
    await env.api.simklConnectAndVerify(t.ctx, { cancelled: false }, instantSleep);
    assert.equal(env.store.get('sc_simkl_client_id'), 'typed-id');
    assert.equal(env.store.get('sc_simkl_client_secret'), 'typed-sec');
    assert.equal(env.requests[0].headers['simkl-api-key'], 'typed-id');
    assert.deepEqual(t.statuses[0], { text: 'Checking Client ID…', kind: 'pending' });
    assert.equal(t.details[0], '');
});

await test('connect: a Client ID Simkl rejects stops with a bad status', async () => {
    const env = loadClient();
    const t = makeCtx(CREDS);
    env.replies.push({ status: 403, body: {} });
    await env.api.simklConnectAndVerify(t.ctx, { cancelled: false }, instantSleep);
    assert.deepEqual(t.last(), { text: '✗ Client ID rejected by Simkl', kind: 'bad' });
    assert.deepEqual(urlsOf(env), ['GET /movies/trending?limit=1']);
});

await test('connect: Simkl unreachable stops with a bad status', async () => {
    for (const reply of ['error', { status: 500, body: {} }]) {
        const env = loadClient();
        const t = makeCtx(CREDS);
        env.replies.push(reply);
        await env.api.simklConnectAndVerify(t.ctx, { cancelled: false }, instantSleep);
        assert.deepEqual(t.last(), { text: '⚠ Couldn\'t reach Simkl', kind: 'bad' });
        assert.deepEqual(urlsOf(env), ['GET /movies/trending?limit=1']);
    }
});

await test('connect: already connected -> verifies the stored token and never starts a sign-in', async () => {
    const env = loadClient();
    withToken(env);
    const t = makeCtx(CREDS);
    env.replies.push(TRENDING_OK, SETTINGS_OK);
    await env.api.simklConnectAndVerify(t.ctx, { cancelled: false }, instantSleep);
    assert.deepEqual(t.last(), { text: '✓ Connected as spud', kind: 'ok' });
    assert.deepEqual(urlsOf(env), ['GET /movies/trending?limit=1', 'GET /users/settings']);
    assert.equal(env.requests[1].headers['Authorization'], 'Bearer A1');
    assert.ok(t.statuses.some(s => s.text === 'Checking sign-in…' && s.kind === 'pending'));
    assert.equal(env.requests.some(r => /oauth\/device/.test(r.url)), false);
});

await test('connect: a stored token that /users/settings rejects falls through to a fresh sign-in', async () => {
    const env = loadClient();
    withToken(env);
    const t = makeCtx(CREDS);
    env.replies.push(TRENDING_OK, { status: 401, body: {} }, { status: 200, body: DEV }, tokenReply('A5', 'R5'), SETTINGS_OK);
    await env.api.simklConnectAndVerify(t.ctx, { cancelled: false }, instantSleep);
    assert.deepEqual(urlsOf(env), ['GET /movies/trending?limit=1', 'GET /users/settings', 'POST /oauth/device/code',
        'POST /oauth/device/token', 'GET /users/settings']);
    assert.equal(env.requests[4].headers['Authorization'], 'Bearer A5');
    assert.deepEqual(t.last(), { text: '✓ Connected as spud', kind: 'ok' });
});

await test('connect: full fresh sign-in shows the code + link, polls, saves the token and connects', async () => {
    const env = loadClient();
    const t = makeCtx(CREDS);
    env.replies.push(TRENDING_OK, { status: 200, body: DEV }, { status: 400, body: {} }, tokenReply('A7', 'R7'), SETTINGS_OK);
    const sleeps = [];
    await env.api.simklConnectAndVerify(t.ctx, { cancelled: false }, async ms => { sleeps.push(ms); });
    assert.deepEqual(urlsOf(env), ['GET /movies/trending?limit=1', 'POST /oauth/device/code',
        'POST /oauth/device/token', 'POST /oauth/device/token', 'GET /users/settings']);
    assert.deepEqual(JSON.parse(env.requests[1].data), { client_id: 'cid' });
    for (const i of [2, 3]) {
        assert.deepEqual(JSON.parse(env.requests[i].data), { code: 'DEV123', client_id: 'cid', client_secret: 'sec' });
    }
    assert.equal(env.requests[4].headers['Authorization'], 'Bearer A7');
    assert.deepEqual(sleeps, [5000, 5000]);
    const saved = JSON.parse(env.store.get(TOKEN_KEY));
    assert.equal(saved.access, 'A7');
    assert.equal(saved.clientId, 'cid');
    // detail: shown with the code and the activate link, cleared at the end
    const shown = t.details.find(d => d.includes('ABCD1234'));
    assert.ok(shown, 'detail HTML should contain the user code');
    assert.ok(shown.includes('class="sc-simkl-set-code">ABCD1234</div>'));
    assert.ok(shown.includes('href="https://trakt.tv/activate"'));
    assert.ok(shown.includes('>trakt.tv/activate</a>'));
    assert.ok(shown.includes('target="_blank" rel="noopener"'));
    assert.equal(t.details[t.details.length - 1], '');
    // status walked through the expected phases and ended connected
    const texts = t.statuses.map(s => s.text);
    assert.ok(texts.includes('Checking Client ID…'));
    assert.ok(texts.includes('Checking sign-in…'));
    assert.ok(texts.some(x => /^Waiting for approval… \d+:\d\d$/.test(x)));
    assert.deepEqual(t.last(), { text: '✓ Connected as spud', kind: 'ok' });
});

await test('connect: signed in but the username lookup fails -> plain Connected', async () => {
    const env = loadClient();
    const t = makeCtx(CREDS);
    env.replies.push(TRENDING_OK, { status: 200, body: DEV }, tokenReply('A8', 'R8'), 'error');
    await env.api.simklConnectAndVerify(t.ctx, { cancelled: false }, instantSleep);
    assert.deepEqual(t.last(), { text: '✓ Connected', kind: 'ok' });
    assert.equal(JSON.parse(env.store.get(TOKEN_KEY)).access, 'A8');
});

await test('connect: the user code is HTML-escaped in the detail', async () => {
    const env = loadClient();
    const t = makeCtx(CREDS);
    env.replies.push(TRENDING_OK, { status: 200, body: { ...DEV, user_code: '<b>X&"' } }, { status: 418, body: {} });
    await env.api.simklConnectAndVerify(t.ctx, { cancelled: false }, instantSleep);
    const shown = t.details.find(d => d.includes('sc-simkl-set-code'));
    assert.ok(shown.includes('&lt;b&gt;X&amp;&quot;'));
    assert.equal(shown.includes('<b>X'), false);
});

await test('connect: denied, expired and wrong-secret sign-ins report and clear the detail', async () => {
    for (const [reply, expected] of [
        [{ status: 418, body: {} }, '✗ Sign-in was denied'],
        [{ status: 410, body: {} }, '✗ Code expired — click Test again'],
        [{ status: 401, body: {} }, '✗ Sign-in failed — check the Client Secret'],
    ]) {
        const env = loadClient();
        const t = makeCtx(CREDS);
        env.replies.push(TRENDING_OK, { status: 200, body: DEV }, reply);
        await env.api.simklConnectAndVerify(t.ctx, { cancelled: false }, instantSleep);
        assert.deepEqual(t.last(), { text: expected, kind: 'bad' });
        assert.equal(t.details[t.details.length - 1], '');
        assert.equal(env.store.has(TOKEN_KEY), false);
        assert.deepEqual(urlsOf(env), ['GET /movies/trending?limit=1', 'POST /oauth/device/code', 'POST /oauth/device/token']);
    }
});

await test('connect: device-code start failure reports a bad status and shows no code', async () => {
    const env = loadClient();
    const t = makeCtx(CREDS);
    env.replies.push(TRENDING_OK, { status: 403, body: {} });
    await env.api.simklConnectAndVerify(t.ctx, { cancelled: false }, instantSleep);
    assert.deepEqual(t.last(), { text: '✗ Couldn\'t start sign-in — check the Client ID', kind: 'bad' });
    assert.deepEqual(urlsOf(env), ['GET /movies/trending?limit=1', 'POST /oauth/device/code']);
    assert.equal(t.details.some(d => d !== ''), false);
});

await test('connect: user cancel stops the poll and reports Cancelled with no kind', async () => {
    const env = loadClient();
    const t = makeCtx(CREDS);
    const handle = { cancelled: false };
    env.replies.push(TRENDING_OK, { status: 200, body: DEV });
    await env.api.simklConnectAndVerify(t.ctx, handle, async () => { handle.cancelled = true; });
    assert.deepEqual(t.last(), { text: 'Cancelled', kind: undefined });
    assert.equal(t.details[t.details.length - 1], '');
    assert.deepEqual(urlsOf(env), ['GET /movies/trending?limit=1', 'POST /oauth/device/code']);   // no token request
    assert.equal(env.store.has(TOKEN_KEY), false);
});

await test('connect: closing Settings mid-wait cancels the poll before any token request', async () => {
    const env = loadClient();
    const open = { v: true };
    const t = makeCtx(CREDS, open);
    const origSetDetail = t.ctx.setDetail;
    t.ctx.setDetail = html => { origSetDetail(html); if (html.includes('sc-simkl-set-code')) open.v = false; };   // user closes Settings once the code is up
    const handle = { cancelled: false };
    let slept = 0;
    env.replies.push(TRENDING_OK, { status: 200, body: DEV });
    await env.api.simklConnectAndVerify(t.ctx, handle, async () => { slept++; });
    assert.equal(handle.cancelled, true);
    assert.equal(slept, 0);
    assert.deepEqual(t.last(), { text: 'Cancelled', kind: undefined });
    assert.deepEqual(urlsOf(env), ['GET /movies/trending?limit=1', 'POST /oauth/device/code']);
});

await test('connect: a non-https verification_url falls back to trakt.tv/activate', async () => {
    const env = loadClient();
    const t = makeCtx(CREDS);
    env.replies.push(TRENDING_OK, { status: 200, body: { ...DEV, verification_url: 'javascript:alert(1)' } }, { status: 418, body: {} });
    await env.api.simklConnectAndVerify(t.ctx, { cancelled: false }, instantSleep);
    const shown = t.details.find(d => d.includes('sc-simkl-set-code'));
    assert.ok(shown.includes('href="https://trakt.tv/activate"'));
    assert.ok(shown.includes('>trakt.tv/activate</a>'));
    assert.equal(shown.includes('javascript'), false);
});

console.log(`OK: ${passed} simkl-scrobble test groups passed`);
