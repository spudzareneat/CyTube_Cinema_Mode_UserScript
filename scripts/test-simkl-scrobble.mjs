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

// `return { name: <value or undefined if the slice doesn't define it>, ... }` -- a missing symbol then
// fails the specific test that uses it instead of taking the whole file down at load time.
const exportsOf = names => `{ ${names.map(n => `${n}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ')} }`;

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
    'simklInterpretSyncResponse', 'simklAuthQuery', 'simklFormBody',
    'simklItemUrl', 'simklVerificationLink', 'simklTickLifetime', 'simklPanelPosition',
    '_simklEsc', 'simklPastThreshold', 'simklIsHotkey',
    'SIMKL_THRESHOLD_DEFAULT', 'SIMKL_PROMPT_TTL_MS', 'SIMKL_REFRESH_WINDOW_MS', 'SIMKL_APP_NAME', 'SIMKL_API',
];
// eslint-disable-next-line no-new-func
const H = new Function(`${slice('simkl-helpers')}\n;return ${exportsOf(HELPER_NAMES)};`)();

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

await test('simklTokenFromResponse: expiresAt is now + expires_in (Simkl sends no created_at); created_at still honoured', () => {
    const simkl = { access_token: 'A', token_type: 'Bearer', expires_in: 604800, refresh_token: 'R', scope: 'media:read media:write' };
    assert.deepEqual(H.simklTokenFromResponse(simkl, 'cid', NOW), {
        access: 'A', refresh: 'R', expiresAt: NOW + 604_800_000, clientId: 'cid',
    });
    const withCreated = { access_token: 'A', refresh_token: 'R', expires_in: 7776000, created_at: 1_700_000_000 };
    assert.equal(H.simklTokenFromResponse(withCreated, 'cid', NOW).expiresAt, (1_700_000_000 + 7776000) * 1000);
});

await test('simklTokenFromResponse: refresh token comes from the response, else the previous one', () => {
    const withRefresh = { access_token: 'A', refresh_token: 'NEW', expires_in: 100 };
    const noRefresh = { access_token: 'A', expires_in: 100 };
    assert.equal(H.simklTokenFromResponse(withRefresh, 'cid', NOW).refresh, 'NEW');                 // no prev
    assert.equal(H.simklTokenFromResponse(withRefresh, 'cid', NOW, 'OLD').refresh, 'NEW');          // response wins
    assert.equal(H.simklTokenFromResponse(noRefresh, 'cid', NOW, 'OLD').refresh, 'OLD');            // omitted -> keep old
    assert.equal(H.simklTokenFromResponse(noRefresh, 'cid', NOW).refresh, undefined);               // nothing to keep
});

await test('simklBuildHistoryPayload: one movie by IMDb id, rating only when an integer 1..10', () => {
    const snap = { imdbId: 'tt0087332', title: 'Ghostbusters', year: '1984', poster: '' };
    const iso = '2026-09-18T20:00:00.000Z';
    assert.deepEqual(H.simklBuildHistoryPayload(snap, iso),
        { movies: [{ ids: { imdb: 'tt0087332' }, watched_at: iso }] });
    assert.deepEqual(H.simklBuildHistoryPayload(snap, iso, 8),
        { movies: [{ ids: { imdb: 'tt0087332' }, watched_at: iso, rating: 8 }] });
    assert.deepEqual(H.simklBuildHistoryPayload(snap, iso, 1).movies[0].rating, 1);
    assert.deepEqual(H.simklBuildHistoryPayload(snap, iso, 10).movies[0].rating, 10);
    for (const bad of [0, 11, 7.5, '8', null, undefined, NaN, -3]) {
        assert.equal('rating' in H.simklBuildHistoryPayload(snap, iso, bad).movies[0], false, `rating ${String(bad)} must be dropped`);
    }
});

await test('simklBuildRatingPayload is gone (rating rides along in the history call)', () => {
    assert.equal(H.simklBuildRatingPayload, undefined);
});

await test('simklInterpretSyncResponse: not_found / added / exists / unknown', () => {
    assert.equal(H.simklInterpretSyncResponse({ added: { movies: 1 }, not_found: { movies: [] } }), 'added');
    assert.equal(H.simklInterpretSyncResponse({ added: { movies: 1 } }), 'added');
    assert.equal(H.simklInterpretSyncResponse({ added: { movies: 0 }, not_found: { movies: [{ ids: { imdb: 'tt1' } }] } }), 'not_found');
    assert.equal(H.simklInterpretSyncResponse({ added: { movies: 1 }, not_found: { movies: [{ ids: { imdb: 'tt1' } }] } }), 'not_found');   // never trust "added" while something was not found
    assert.equal(H.simklInterpretSyncResponse({ added: { movies: 0 }, not_found: { movies: [] } }), 'exists');
    assert.equal(H.simklInterpretSyncResponse({ added: { movies: 0 } }), 'exists');
    assert.equal(H.simklInterpretSyncResponse({ added: { movies: 0, shows: 0, episodes: 0, statuses: [] }, not_found: { movies: [], shows: [], episodes: [] } }), 'exists');
    assert.equal(H.simklInterpretSyncResponse({}), 'unknown');
    assert.equal(H.simklInterpretSyncResponse(null), 'unknown');
    assert.equal(H.simklInterpretSyncResponse(undefined), 'unknown');
    assert.equal(H.simklInterpretSyncResponse('garbage'), 'unknown');
    assert.equal(H.simklInterpretSyncResponse({ added: null }), 'unknown');
    assert.equal(H.simklInterpretSyncResponse({ not_found: { movies: [] } }), 'unknown');
    assert.equal(H.simklInterpretSyncResponse({ error: 'RATE_LIMIT' }), 'unknown');
});

await test('SIMKL_APP_NAME is the lowercase app name Simkl asks for', () => {
    assert.equal(H.SIMKL_APP_NAME, 'spuds-grindhouse');
});

await test('simklAuthQuery: client_id, app-name, app-version, each URL-encoded', () => {
    assert.equal(H.simklAuthQuery('cid', 'spuds-grindhouse', '4.14.0'), 'client_id=cid&app-name=spuds-grindhouse&app-version=4.14.0');
    assert.equal(H.simklAuthQuery('a b&c=d', 'my app', '1+2/3'), 'client_id=a%20b%26c%3Dd&app-name=my%20app&app-version=1%2B2%2F3');
});

await test('simklItemUrl: Simkl deep-link redirect for an IMDb id, with the auth query', () => {
    assert.equal(H.SIMKL_API, 'https://api.simkl.com');
    assert.equal(H.simklItemUrl('tt0087332', 'cid', '4.13.22'),
        'https://api.simkl.com/redirect?to=simkl&imdb=tt0087332&client_id=cid&app-name=spuds-grindhouse&app-version=4.13.22');
    // every dynamic value is URL-encoded; the app name is the module's own constant
    assert.equal(H.simklItemUrl('tt 1&x', 'a b&c', '1+2'),
        'https://api.simkl.com/redirect?to=simkl&imdb=tt%201%26x&client_id=a%20b%26c&app-name=spuds-grindhouse&app-version=1%2B2');
    assert.ok(H.simklItemUrl('tt1', 'cid', '0').endsWith('&' + H.simklAuthQuery('cid', H.SIMKL_APP_NAME, '0')));
});

await test('simklVerificationLink: https-only link (complete, else plain, else simkl.com/pin) and its shown text', () => {
    const PIN = 'https://simkl.com/pin';
    assert.deepEqual(H.simklVerificationLink({ verification_uri: PIN, verification_uri_complete: PIN + '/BDWP-HQPK' }),
        { url: PIN + '/BDWP-HQPK', shown: 'simkl.com/pin' });
    assert.deepEqual(H.simklVerificationLink({ verification_uri: PIN }), { url: PIN, shown: 'simkl.com/pin' });
    assert.deepEqual(H.simklVerificationLink({ verification_uri: PIN, verification_uri_complete: 'javascript:alert(1)' }), { url: PIN, shown: 'simkl.com/pin' });
    assert.deepEqual(H.simklVerificationLink({ verification_uri: 'https://example.org/go', verification_uri_complete: 'http://example.org/go/X' }),
        { url: 'https://example.org/go', shown: 'example.org/go' });
    assert.deepEqual(H.simklVerificationLink({ verification_uri: 'javascript:alert(1)', verification_uri_complete: 'javascript:alert(2)' }), { url: PIN, shown: 'simkl.com/pin' });
    assert.deepEqual(H.simklVerificationLink({ verification_uri: 'http://simkl.com/pin', verification_uri_complete: 'http://simkl.com/pin/X' }), { url: PIN, shown: 'simkl.com/pin' });
    assert.deepEqual(H.simklVerificationLink({}), { url: PIN, shown: 'simkl.com/pin' });
    // only the complete link is https: it is still used, while the shown text falls back
    assert.deepEqual(H.simklVerificationLink({ verification_uri: 'javascript:1', verification_uri_complete: 'https://simkl.com/pin/Z' }),
        { url: 'https://simkl.com/pin/Z', shown: 'simkl.com/pin' });
});

await test('simklFormBody: encodes keys and values, keeps order, skips null/undefined', () => {
    assert.equal(
        H.simklFormBody({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: 'a b' }),
        'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&client_id=a%20b');
    assert.equal(H.simklFormBody({ a: 1, b: undefined, c: null, d: '', 'e f': 'g&h' }), 'a=1&d=&e%20f=g%26h');
    assert.equal(H.simklFormBody({}), '');
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
    'simklEnabled', 'simklThreshold', 'simklAppVersion', 'simklRequest', 'validateSimklClientId',
    'simklLoadToken', 'simklSaveToken', 'simklClearToken', 'simklLoadPrompted', 'simklMarkPrompted',
    'simklStartDeviceAuth', 'simklPollDeviceToken', 'simklRefreshToken', 'simklEnsureToken', 'simklSubmit',
    'simklFetchUsername', 'simklConnectAndVerify', 'SIMKL_API', 'SIMKL_OOB_REDIRECT',
];

// Fresh fake environment per test: Map-backed localStorage, a scripted GM_xmlhttpRequest that
// replays `replies` in order ({status, body} | {status, raw} | 'error' | 'timeout') and records every
// request it sees. `gmInfo` is injected as the (optional) GM_info global.
function loadClient({ gmInfo } = {}) {
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
            if (next === 'timeout') return opts.ontimeout && opts.ontimeout();
            if (!next || next === 'error') return opts.onerror && opts.onerror();
            const responseText = next.raw !== undefined ? next.raw : (next.body === undefined ? '' : JSON.stringify(next.body));
            opts.onload({ status: next.status, responseText });
        });
    };
    const code = `${slice('simkl-helpers')}\n${slice('simkl-client')}\n;return ${exportsOf(CLIENT_NAMES)};`;
    // eslint-disable-next-line no-new-func
    const api = new Function('GM_xmlhttpRequest', 'localStorage', 'getKey', 'setKey', 'GM_info', code)(GM_xmlhttpRequest, localStorage, getKey, setKey, gmInfo);
    return { api, store, replies, requests };
}

const SNAP = { imdbId: 'tt0087332', title: 'Ghostbusters', year: '1984', poster: '' };
const API = 'https://api.simkl.com';
const AUTHQ = 'client_id=cid&app-name=spuds-grindhouse&app-version=0';   // what every request carries with no GM_info injected
const UA = 'spuds-grindhouse/0';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const ADDED = { status: 201, body: { added: { movies: 1, shows: 0, episodes: 0, statuses: [] }, not_found: { movies: [], shows: [], episodes: [] } } };
const EXISTS = { status: 201, body: { added: { movies: 0, shows: 0, episodes: 0, statuses: [] }, not_found: { movies: [], shows: [], episodes: [] } } };
const DAY = 24 * 60 * 60 * 1000;
function withKeys(env) {
    env.store.set('sc_simkl_client_id', 'cid');
}
function withToken(env, over = {}) {
    withKeys(env);
    env.store.set('sc_simkl_token', JSON.stringify({ access: 'A1', refresh: 'R1', expiresAt: Date.now() + 30 * DAY, clientId: 'cid', ...over }));
}
// Simkl's token response: no created_at, 7-day access token, scope echoed back.
const tokenReply = (access, refresh, scope = 'media:read media:write') => ({
    status: 200,
    body: { access_token: access, token_type: 'Bearer', expires_in: 604800, refresh_token: refresh, scope },
});
const PENDING = { status: 400, body: { error: 'authorization_pending' } };
const form = req => Object.fromEntries(new URLSearchParams(req.data));
const pathOf = req => req.url.replace(API, '').split('?')[0];
const urlsOf = env => env.requests.map(r => r.method + ' ' + pathOf(r));

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

await test('Legacy leftovers are gone (no key-check endpoint, no OOB redirect, API base is Simkl)', () => {
    const env = loadClient();
    assert.equal(env.api.validateSimklClientId, undefined);
    assert.equal(env.api.SIMKL_OOB_REDIRECT, undefined);
    assert.equal(env.api.SIMKL_API, 'https://api.simkl.com');
});

// ── request building ─────────────────────────────────────────────────────────

await test('simklAppVersion: GM_info script version as a string, else "0"', () => {
    assert.equal(loadClient().api.simklAppVersion(), '0');
    assert.equal(loadClient({ gmInfo: { script: { version: '4.14.0' } } }).api.simklAppVersion(), '4.14.0');
    assert.equal(loadClient({ gmInfo: { script: {} } }).api.simklAppVersion(), '0');
    assert.equal(loadClient({ gmInfo: null }).api.simklAppVersion(), '0');
});

await test('simklRequest: a GET carries the auth query + User-Agent, and Bearer only with a token', async () => {
    const env = loadClient();
    withKeys(env);
    env.replies.push({ status: 200, body: { ok: 1 } }, { status: 200, body: {} });
    assert.deepEqual(await env.api.simklRequest('GET', '/users/settings', { token: { access: 'A1' } }), { status: 200, json: { ok: 1 } });
    const r = env.requests[0];
    assert.equal(r.method, 'GET');
    assert.equal(r.url, `${API}/users/settings?${AUTHQ}`);
    assert.equal(r.headers['User-Agent'], UA);
    assert.equal(r.headers['Authorization'], 'Bearer A1');
    assert.equal(r.headers['Content-Type'], undefined);
    assert.equal(r.data, undefined);
    assert.equal(r.timeout, 15000);
    assert.equal('simkl-api-key' in r.headers, false);

    await env.api.simklRequest('GET', '/users/settings');
    assert.equal(env.requests[1].headers['Authorization'], undefined);
});

await test('simklRequest: a JSON body is stringified with a JSON Content-Type', async () => {
    const env = loadClient();
    withKeys(env);
    env.replies.push({ status: 201, body: {} });
    await env.api.simklRequest('POST', '/sync/history', { body: { movies: [{ ids: { imdb: 'tt1' } }] }, token: { access: 'A1' } });
    const r = env.requests[0];
    assert.equal(r.url, `${API}/sync/history?${AUTHQ}`);
    assert.equal(r.headers['Content-Type'], 'application/json');
    assert.equal(r.headers['Authorization'], 'Bearer A1');
    assert.equal(r.headers['User-Agent'], UA);
    assert.deepEqual(JSON.parse(r.data), { movies: [{ ids: { imdb: 'tt1' } }] });
});

await test('simklRequest: form:true sends a urlencoded body with the form Content-Type', async () => {
    const env = loadClient();
    withKeys(env);
    env.replies.push({ status: 200, body: {} });
    await env.api.simklRequest('POST', '/oauth2/token', { body: { grant_type: 'refresh_token', refresh_token: 'R 1&2' }, form: true });
    const r = env.requests[0];
    assert.equal(r.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(r.data, 'grant_type=refresh_token&refresh_token=R%201%262');
    assert.equal(r.headers['Authorization'], undefined);
});

await test('simklRequest: a path that already has a query gets & not ?; opts.clientId overrides the saved id', async () => {
    const env = loadClient();
    withKeys(env);
    env.replies.push({ status: 200, body: {} });
    await env.api.simklRequest('GET', '/x?limit=1', { clientId: 'typed-id' });
    assert.equal(env.requests[0].url, `${API}/x?limit=1&client_id=typed-id&app-name=spuds-grindhouse&app-version=0`);
});

await test('simklRequest: injected GM_info version flows into app-version and the User-Agent', async () => {
    const env = loadClient({ gmInfo: { script: { version: '4.14.0' } } });
    withKeys(env);
    env.replies.push({ status: 200, body: {} });
    await env.api.simklRequest('GET', '/users/settings');
    assert.equal(env.requests[0].url, `${API}/users/settings?client_id=cid&app-name=spuds-grindhouse&app-version=4.14.0`);
    assert.equal(env.requests[0].headers['User-Agent'], 'spuds-grindhouse/4.14.0');
});

await test('simklRequest: any HTTP status resolves (json null for a non-JSON body); only network/timeout reject', async () => {
    let env = loadClient();
    withKeys(env);
    env.replies.push({ status: 502, raw: '<html>bad gateway</html>' }, { status: 429, body: { error: 'rate_limit' } });
    assert.deepEqual(await env.api.simklRequest('GET', '/a'), { status: 502, json: null });
    assert.deepEqual(await env.api.simklRequest('GET', '/a'), { status: 429, json: { error: 'rate_limit' } });

    env = loadClient();
    withKeys(env);
    env.replies.push('error', 'timeout');
    await assert.rejects(() => env.api.simklRequest('GET', '/a'), /network/);
    await assert.rejects(() => env.api.simklRequest('GET', '/a'), /timeout/);
});

// ── device auth ──────────────────────────────────────────────────────────────

const DEVICE_OK = {
    device_code: 'DEV123', user_code: 'BDWP-HQPK', verification_uri: 'https://simkl.com/pin',
    verification_uri_complete: 'https://simkl.com/pin/BDWP-HQPK', expires_in: 900, interval: 5,
};

await test('simklStartDeviceAuth: 200 returns the device payload, sent as a form with the media scopes', async () => {
    const env = loadClient();
    withKeys(env);
    env.replies.push({ status: 200, body: DEVICE_OK });
    assert.deepEqual(await env.api.simklStartDeviceAuth(), DEVICE_OK);
    const r = env.requests[0];
    assert.equal(r.method, 'POST');
    assert.equal(r.url, `${API}/oauth2/device?${AUTHQ}`);
    assert.equal(r.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(r.headers['User-Agent'], UA);
    assert.deepEqual(form(r), { client_id: 'cid', scope: 'media:read media:write' });
});

await test('simklStartDeviceAuth: a 401 (Client ID rejected) throws kind "rejected"', async () => {
    const env = loadClient();
    withKeys(env);
    env.replies.push({ status: 401, body: { error: 'invalid_client' } });
    await assert.rejects(() => env.api.simklStartDeviceAuth(), e => e instanceof Error && e.kind === 'rejected');
});

await test('simklStartDeviceAuth: a network error throws kind "network"', async () => {
    for (const reply of ['error', 'timeout']) {
        const env = loadClient();
        withKeys(env);
        env.replies.push(reply);
        await assert.rejects(() => env.api.simklStartDeviceAuth(), e => e instanceof Error && e.kind === 'network');
    }
});

await test('simklStartDeviceAuth: 200 with a body missing device_code/user_code, or a 500, is "rejected"', async () => {
    for (const reply of [
        { status: 200, body: { user_code: 'X', expires_in: 900 } },
        { status: 200, body: { device_code: 'D', expires_in: 900 } },
        { status: 200, raw: 'not json' },
        { status: 500, body: DEVICE_OK },
        { status: 412, body: {} },
    ]) {
        const env = loadClient();
        withKeys(env);
        env.replies.push(reply);
        await assert.rejects(() => env.api.simklStartDeviceAuth(), e => e instanceof Error && e.kind === 'rejected');
    }
});

const DEV = { device_code: 'D', expires_in: 900, interval: 5 };

await test('simklPollDeviceToken: pending then success saves the token (shape incl. clientId + refresh) and posts the device grant', async () => {
    const env = loadClient();
    withKeys(env);
    env.replies.push(PENDING, tokenReply('A9', 'R9'));
    const sleeps = [];
    const before = Date.now();
    const result = await env.api.simklPollDeviceToken(DEV, { cancelled: false }, async ms => { sleeps.push(ms); });
    assert.equal(result, 'ok');
    assert.deepEqual(sleeps, [5000, 5000]);
    const saved = JSON.parse(env.store.get('sc_simkl_token'));
    assert.deepEqual(Object.keys(saved).sort(), ['access', 'clientId', 'expiresAt', 'refresh']);
    assert.equal(saved.access, 'A9');
    assert.equal(saved.refresh, 'R9');
    assert.equal(saved.clientId, 'cid');
    assert.ok(saved.expiresAt >= before + 604_800_000 && saved.expiresAt <= Date.now() + 604_800_000);
    for (const r of env.requests) {
        assert.equal(r.method, 'POST');
        assert.equal(r.url, `${API}/oauth2/token?${AUTHQ}`);
        assert.equal(r.headers['Content-Type'], 'application/x-www-form-urlencoded');
        assert.deepEqual(form(r), { grant_type: DEVICE_GRANT, client_id: 'cid', device_code: 'D' });
    }
});

await test('simklPollDeviceToken: slow_down adds 5 s to the interval for the following polls', async () => {
    const env = loadClient();
    withKeys(env);
    env.replies.push(PENDING, { status: 400, body: { error: 'slow_down' } }, PENDING, tokenReply('A9', 'R9'));
    const sleeps = [];
    assert.equal(await env.api.simklPollDeviceToken(DEV, { cancelled: false }, async ms => { sleeps.push(ms); }), 'ok');
    assert.deepEqual(sleeps, [5000, 5000, 10000, 10000]);
});

await test('simklPollDeviceToken: interval defaults to 5 s and is floored at 1 s', async () => {
    let env = loadClient();
    withKeys(env);
    env.replies.push(tokenReply('A', 'R'));
    const sleeps = [];
    await env.api.simklPollDeviceToken({ device_code: 'D', expires_in: 900 }, { cancelled: false }, async ms => { sleeps.push(ms); });
    assert.deepEqual(sleeps, [5000]);

    env = loadClient();
    withKeys(env);
    env.replies.push(tokenReply('A', 'R'));
    const sleeps2 = [];
    await env.api.simklPollDeviceToken({ device_code: 'D', expires_in: 900, interval: -3 }, { cancelled: false }, async ms => { sleeps2.push(ms); });
    assert.deepEqual(sleeps2, [1000]);
});

await test('simklPollDeviceToken: expired_token -> expired, invalid_client / other 400 / 401 / 500 -> error, nothing saved', async () => {
    const run = async reply => {
        const env = loadClient();
        withKeys(env);
        env.replies.push(reply);
        const r = await env.api.simklPollDeviceToken(DEV, { cancelled: false }, async () => {});
        assert.equal(env.store.has('sc_simkl_token'), false);
        assert.equal(env.requests.length, 1);
        return r;
    };
    assert.equal(await run({ status: 400, body: { error: 'expired_token' } }), 'expired');
    assert.equal(await run({ status: 401, body: { error: 'invalid_client' } }), 'error');
    assert.equal(await run({ status: 400, body: { error: 'invalid_grant' } }), 'error');
    assert.equal(await run({ status: 400, raw: 'garbage' }), 'error');
    assert.equal(await run({ status: 403, body: {} }), 'error');
    assert.equal(await run({ status: 500, body: {} }), 'error');
    assert.equal(await run({ status: 200, body: { token_type: 'Bearer' } }), 'error');   // 200 without an access_token is not a success
});

await test('simklPollDeviceToken: a grant without media:write is "scope" and stores NO token', async () => {
    for (const scope of ['media:read', 'public', '']) {
        const env = loadClient();
        withKeys(env);
        env.replies.push(tokenReply('A9', 'R9', scope));
        assert.equal(await env.api.simklPollDeviceToken(DEV, { cancelled: false }, async () => {}), 'scope');
        assert.equal(env.store.has('sc_simkl_token'), false);
    }
});

await test('simklPollDeviceToken: a response with no scope field at all is accepted', async () => {
    const env = loadClient();
    withKeys(env);
    env.replies.push({ status: 200, body: { access_token: 'A9', expires_in: 604800, refresh_token: 'R9' } });
    assert.equal(await env.api.simklPollDeviceToken(DEV, { cancelled: false }, async () => {}), 'ok');
    assert.equal(JSON.parse(env.store.get('sc_simkl_token')).access, 'A9');
});

await test('simklPollDeviceToken: cancel flipped by the sleep stops before any request', async () => {
    const env = loadClient();
    withKeys(env);
    const handle = { cancelled: false };
    const r = await env.api.simklPollDeviceToken(DEV, handle, async () => { handle.cancelled = true; });
    assert.equal(r, 'cancelled');
    assert.equal(env.requests.length, 0);
});

await test('simklPollDeviceToken: already-cancelled handle makes no request and no sleep', async () => {
    const env = loadClient();
    withKeys(env);
    let slept = 0;
    assert.equal(await env.api.simklPollDeviceToken(DEV, { cancelled: true }, async () => { slept++; }), 'cancelled');
    assert.equal(slept, 0);
    assert.equal(env.requests.length, 0);
});

await test('simklPollDeviceToken: our own deadline ends the loop as "expired" (Simkl has no deny signal)', async () => {
    // expires_in 0: the deadline has already passed -> the loop body never runs
    let env = loadClient();
    withKeys(env);
    assert.equal(await env.api.simklPollDeviceToken({ device_code: 'D', expires_in: 0, interval: 5 }, { cancelled: false }, async () => {}), 'expired');
    assert.equal(env.requests.length, 0);

    // mid-loop expiry against a fake clock advanced by the sleeps: 5 s + 5 s + 5 s crosses the 12 s deadline
    env = loadClient();
    withKeys(env);
    env.replies.push(PENDING, PENDING, PENDING, PENDING, PENDING);
    const realNow = Date.now;
    let clock = realNow.call(Date);
    Date.now = () => clock;
    try {
        const r = await env.api.simklPollDeviceToken({ device_code: 'D', expires_in: 12, interval: 5 }, { cancelled: false }, async ms => { clock += ms; });
        assert.equal(r, 'expired');
        assert.equal(env.requests.length, 3);
    } finally { Date.now = realNow; }
});

await test('simklPollDeviceToken: a transient network error keeps polling until success', async () => {
    const env = loadClient();
    withKeys(env);
    env.replies.push('error', 'timeout', PENDING, tokenReply('A9', 'R9'));
    const sleeps = [];
    assert.equal(await env.api.simklPollDeviceToken(DEV, { cancelled: false }, async ms => { sleeps.push(ms); }), 'ok');
    assert.equal(env.requests.length, 4);
    assert.deepEqual(sleeps, [5000, 5000, 5000, 5000]);
    assert.equal(JSON.parse(env.store.get('sc_simkl_token')).access, 'A9');
});

// ── refresh + ensure ─────────────────────────────────────────────────────────

await test('simklRefreshToken: 200 saves the new access token; the request is a refresh_token form with only the Client ID', async () => {
    const env = loadClient();
    withToken(env);
    env.replies.push(tokenReply('A2', 'R2'));
    const fresh = await env.api.simklRefreshToken({ access: 'A1', refresh: 'R1', expiresAt: 0, clientId: 'cid' });
    assert.equal(fresh.access, 'A2');
    assert.equal(fresh.refresh, 'R2');
    assert.equal(fresh.clientId, 'cid');
    assert.deepEqual(JSON.parse(env.store.get('sc_simkl_token')), fresh);
    const r = env.requests[0];
    assert.equal(r.method, 'POST');
    assert.equal(r.url, `${API}/oauth2/token?${AUTHQ}`);
    assert.equal(r.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.deepEqual(form(r), { grant_type: 'refresh_token', client_id: 'cid', refresh_token: 'R1' });
    assert.equal(r.headers['Authorization'], undefined);
});

await test('simklRefreshToken: a response without refresh_token keeps the old refresh token', async () => {
    const env = loadClient();
    withToken(env);
    env.replies.push({ status: 200, body: { access_token: 'A2', token_type: 'Bearer', expires_in: 604800 } });
    const fresh = await env.api.simklRefreshToken({ access: 'A1', refresh: 'R1', expiresAt: 0, clientId: 'cid' });
    assert.equal(fresh.access, 'A2');
    assert.equal(fresh.refresh, 'R1');
    assert.equal(JSON.parse(env.store.get('sc_simkl_token')).refresh, 'R1');
    assert.ok(fresh.expiresAt > Date.now() + 6 * DAY);
});

await test('simklRefreshToken: 400/401/403 clear the stored token and return null', async () => {
    for (const status of [400, 401, 403]) {
        const env = loadClient();
        withToken(env);
        env.replies.push({ status, body: {} });
        assert.equal(await env.api.simklRefreshToken({ access: 'A1', refresh: 'R1', clientId: 'cid' }), null);
        assert.equal(env.store.has('sc_simkl_token'), false, `status ${status}`);
    }
});

await test('simklRefreshToken: network error / timeout / 5xx / 200 without access_token return null and keep the token', async () => {
    for (const reply of ['error', 'timeout', { status: 500, body: {} }, { status: 503, body: {} }, { status: 200, body: {} }]) {
        const env = loadClient();
        withToken(env);
        env.replies.push(reply);
        assert.equal(await env.api.simklRefreshToken({ access: 'A1', refresh: 'R1', clientId: 'cid' }), null);
        assert.equal(JSON.parse(env.store.get('sc_simkl_token')).access, 'A1');
    }
});

await test('simklEnsureToken: a fresh token is returned as-is without any request', async () => {
    const env = loadClient();
    withToken(env);
    assert.equal((await env.api.simklEnsureToken()).access, 'A1');
    assert.equal(env.requests.length, 0);
});

await test('simklEnsureToken: near expiry refreshes and returns the new token', async () => {
    const env = loadClient();
    withToken(env, { expiresAt: Date.now() + 60 * 60 * 1000 });
    env.replies.push(tokenReply('A2', 'R2'));
    assert.equal((await env.api.simklEnsureToken()).access, 'A2');
    assert.deepEqual(form(env.requests[0]).refresh_token, 'R1');
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

await test('simklEnsureToken: a rejected refresh clears the token and returns null; a token for another client id is null', async () => {
    let env = loadClient();
    withToken(env, { expiresAt: Date.now() + 60 * 60 * 1000 });
    env.replies.push({ status: 400, body: {} });
    assert.equal(await env.api.simklEnsureToken(), null);
    assert.equal(env.store.has('sc_simkl_token'), false);

    env = loadClient();
    withToken(env, { clientId: 'someone-else' });
    assert.equal(await env.api.simklEnsureToken(), null);
    assert.equal(env.requests.length, 0);
});

// ── simklFetchUsername ───────────────────────────────────────────────────────

const SETTINGS_OK = { status: 200, body: { user: { name: 'spud', joined_at: '2020-01-01' }, account: { type: 'free' } } };

await test('simklFetchUsername: 200 returns user.name and sends the Bearer token + auth query', async () => {
    const env = loadClient();
    withKeys(env);
    env.replies.push(SETTINGS_OK);
    assert.equal(await env.api.simklFetchUsername({ access: 'A1' }), 'spud');
    assert.equal(env.requests.length, 1);
    assert.equal(env.requests[0].method, 'GET');
    assert.equal(env.requests[0].url, `${API}/users/settings?${AUTHQ}`);
    assert.equal(env.requests[0].headers['Authorization'], 'Bearer A1');
    assert.equal(env.requests[0].headers['User-Agent'], UA);
});

await test('simklFetchUsername: 401, network error, missing/blank/non-string name and the old username field all give null', async () => {
    for (const reply of [
        { status: 401, body: {} },
        { status: 500, body: SETTINGS_OK.body },
        'error',
        'timeout',
        { status: 200, body: { user: {} } },
        { status: 200, body: { user: { name: '' } } },
        { status: 200, body: { user: { name: 42 } } },
        { status: 200, body: { user: { username: 'legacy-style' } } },
        { status: 200, body: {} },
        { status: 200, raw: 'not json' },
    ]) {
        const env = loadClient();
        withKeys(env);
        env.replies.push(reply);
        assert.equal(await env.api.simklFetchUsername({ access: 'A1' }), null);
    }
});

// ── simklSubmit ──────────────────────────────────────────────────────────────

// Injectable sleep for simklSubmit: resolves instantly, recording each requested delay and how many
// requests had already gone out when it was asked (proves WHERE in the POST sequence the gap sits).
function sleepRecorder(env) {
    const calls = [];
    const fn = async ms => { calls.push({ ms, sent: env.requests.length }); };
    fn.calls = calls;
    return fn;
}

await test('simklSubmit: no token -> auth without touching the network', async () => {
    const env = loadClient();
    withKeys(env);
    assert.deepEqual(await env.api.simklSubmit(SNAP, 0), { result: 'auth' });
    assert.equal(env.requests.length, 0);
});

await test('simklSubmit: token for a different client id is unusable', async () => {
    const env = loadClient();
    withToken(env, { clientId: 'someone-else' });
    assert.deepEqual(await env.api.simklSubmit(SNAP, 0), { result: 'auth' });
    assert.equal(env.requests.length, 0);
});

await test('simklSubmit: success is exactly ONE authorized JSON POST to /sync/history (no ratings call), watched_at set, no rating key', async () => {
    const env = loadClient();
    withToken(env);
    env.replies.push(ADDED);
    const before = Date.now();
    const sleep = sleepRecorder(env);
    assert.deepEqual(await env.api.simklSubmit(SNAP, 0, sleep), { result: 'added' });
    assert.equal(env.requests.length, 1);
    assert.deepEqual(sleep.calls, [], 'the ordinary success path must not wait');
    const r = env.requests[0];
    assert.equal(r.method, 'POST');
    assert.equal(r.url, `${API}/sync/history?${AUTHQ}`);
    assert.equal(r.headers['Authorization'], 'Bearer A1');
    assert.equal(r.headers['Content-Type'], 'application/json');
    assert.equal(r.headers['User-Agent'], UA);
    const body = JSON.parse(r.data);
    assert.deepEqual(Object.keys(body), ['movies']);
    assert.equal(body.movies.length, 1);
    assert.deepEqual(body.movies[0].ids, { imdb: 'tt0087332' });
    assert.equal('rating' in body.movies[0], false);
    const at = Date.parse(body.movies[0].watched_at);
    assert.ok(at >= before - 1000 && at <= Date.now() + 1000, 'watched_at should be ~now');
    assert.equal(new Date(at).toISOString(), body.movies[0].watched_at);
});

await test('simklSubmit: a rating rides in the SAME single call; still one request', async () => {
    const env = loadClient();
    withToken(env);
    env.replies.push(ADDED);
    assert.deepEqual(await env.api.simklSubmit(SNAP, 8), { result: 'added' });
    assert.equal(env.requests.length, 1);
    assert.equal(pathOf(env.requests[0]), '/sync/history');
    const m = JSON.parse(env.requests[0].data).movies[0];
    assert.equal(m.rating, 8);
    assert.deepEqual(m.ids, { imdb: 'tt0087332' });
});

await test('simklSubmit: a 200 (not just 201) with added movies is also success', async () => {
    const env = loadClient();
    withToken(env);
    env.replies.push({ status: 200, body: ADDED.body });
    assert.deepEqual(await env.api.simklSubmit(SNAP, 0), { result: 'added' });
});

await test('simklSubmit: already in history (added.movies 0, nothing not_found) is "exists", not an error', async () => {
    const env = loadClient();
    withToken(env);
    env.replies.push(EXISTS);
    assert.deepEqual(await env.api.simklSubmit(SNAP, 0), { result: 'exists' });
    assert.equal(env.requests.length, 1);
});

await test('simklSubmit: a 201 whose not_found.movies is non-empty is "not_found" (never success on 201 alone)', async () => {
    const env = loadClient();
    withToken(env);
    env.replies.push({ status: 201, body: { added: { movies: 0 }, not_found: { movies: [{ ids: { imdb: 'tt0087332' } }] } } });
    assert.deepEqual(await env.api.simklSubmit(SNAP, 0), { result: 'not_found' });
});

await test('simklSubmit: an empty / unrecognised 2xx body is "error"', async () => {
    for (const reply of [{ status: 201, body: {} }, { status: 200, raw: 'not json' }, { status: 201, body: { error: 'x' } }]) {
        const env = loadClient();
        withToken(env);
        env.replies.push(reply);
        assert.deepEqual(await env.api.simklSubmit(SNAP, 0), { result: 'error' });
    }
});

await test('simklSubmit: 400 RATE_LIMIT, 412, 500 and a network error are all "error" after a single attempt, with no wait/retry', async () => {
    for (const reply of [
        { status: 400, body: { error: 'RATE_LIMIT' } },
        { status: 412, body: { error: 'client_id_failed' } },
        { status: 500, body: {} },
        'error',
        'timeout',
    ]) {
        const env = loadClient();
        withToken(env);
        env.replies.push(reply);
        const sleep = sleepRecorder(env);
        assert.deepEqual(await env.api.simklSubmit(SNAP, 0, sleep), { result: 'error' }, JSON.stringify(reply));
        assert.equal(env.requests.length, 1);
        assert.deepEqual(sleep.calls, [], JSON.stringify(reply));
        assert.equal(env.store.has('sc_simkl_token'), true);   // none of these are a reason to sign out
    }
});

await test('simklSubmit: 401 triggers one refresh then a retry with the new token', async () => {
    const env = loadClient();
    withToken(env);
    env.replies.push({ status: 401, body: {} }, tokenReply('A2', 'R2'), ADDED);
    const sleep = sleepRecorder(env);
    assert.deepEqual(await env.api.simklSubmit(SNAP, 7, sleep), { result: 'added' });
    assert.equal(env.requests.length, 3);
    assert.deepEqual(urlsOf(env), ['POST /sync/history', 'POST /oauth2/token', 'POST /sync/history']);
    // Simkl allows 1 POST/second: the retry must wait >= ~1 s after the refresh POST (2 requests already sent), not before it
    assert.equal(sleep.calls.length, 1);
    assert.ok(sleep.calls[0].ms >= 1000, 'gap after the refresh should be >= 1000 ms, got ' + sleep.calls[0].ms);
    assert.equal(sleep.calls[0].sent, 2);
    assert.deepEqual(form(env.requests[1]), { grant_type: 'refresh_token', client_id: 'cid', refresh_token: 'R1' });
    assert.equal(env.requests[0].headers['Authorization'], 'Bearer A1');
    assert.equal(env.requests[2].headers['Authorization'], 'Bearer A2');
    assert.equal(JSON.parse(env.requests[2].data).movies[0].rating, 7);   // the retry re-sends the rating too
    assert.equal(JSON.parse(env.store.get('sc_simkl_token')).access, 'A2');
});

await test('simklSubmit: 401, refresh ok, then 401 again -> error (no refresh loop)', async () => {
    const env = loadClient();
    withToken(env);
    env.replies.push({ status: 401, body: {} }, tokenReply('A2', 'R2'), { status: 401, body: {} });
    assert.deepEqual(await env.api.simklSubmit(SNAP, 0, sleepRecorder(env)), { result: 'error' });
    assert.equal(env.requests.length, 3);
});

await test('simklSubmit: 401 then rejected refresh -> auth and token cleared', async () => {
    const env = loadClient();
    withToken(env);
    env.replies.push({ status: 401, body: {} }, { status: 401, body: {} });
    const sleep = sleepRecorder(env);
    assert.deepEqual(await env.api.simklSubmit(SNAP, 0, sleep), { result: 'auth' });
    assert.equal(env.store.has('sc_simkl_token'), false);
    assert.deepEqual(sleep.calls, [], 'no follow-up POST, so no wait');
});

await test('simklSubmit: 401 then transient refresh failure -> error (Retry), token kept', async () => {
    const env = loadClient();
    withToken(env);
    env.replies.push({ status: 401, body: {} }, 'error');
    const sleep = sleepRecorder(env);
    assert.deepEqual(await env.api.simklSubmit(SNAP, 0, sleep), { result: 'error' });
    assert.equal(env.store.has('sc_simkl_token'), true);
    assert.equal(JSON.parse(env.store.get('sc_simkl_token')).access, 'A1');
    assert.deepEqual(sleep.calls, [], 'no follow-up POST, so no wait');
});

await test('simklSubmit: hard-expired token with transient refresh failure -> error, token kept', async () => {
    const env = loadClient();
    withToken(env, { expiresAt: Date.now() - 1000 });
    env.replies.push('error');
    const sleep = sleepRecorder(env);
    assert.deepEqual(await env.api.simklSubmit(SNAP, 0, sleep), { result: 'error' });
    assert.equal(env.store.has('sc_simkl_token'), true);
    assert.equal(env.requests.length, 1);   // only the failed refresh; no history POST
    assert.deepEqual(sleep.calls, []);
});

// ── simklSubmit: Simkl's 1 POST/second limit ─────────────────────────────────

await test('simklSubmit: a proactive (near-expiry) refresh is followed by a >= 1 s gap before /sync/history', async () => {
    const env = loadClient();
    withToken(env, { expiresAt: Date.now() + 60 * 60 * 1000 });   // inside the 1-day refresh window
    env.replies.push(tokenReply('A2', 'R2'), ADDED);
    const sleep = sleepRecorder(env);
    assert.deepEqual(await env.api.simklSubmit(SNAP, 9, sleep), { result: 'added' });
    assert.deepEqual(urlsOf(env), ['POST /oauth2/token', 'POST /sync/history']);
    assert.equal(sleep.calls.length, 1);
    assert.ok(sleep.calls[0].ms >= 1000, 'gap after the refresh should be >= 1000 ms, got ' + sleep.calls[0].ms);
    assert.equal(sleep.calls[0].sent, 1);                          // asked after the refresh POST, before the history POST
    assert.equal(env.requests[1].headers['Authorization'], 'Bearer A2');
});

await test('simklSubmit: a failed proactive refresh on a still-valid token also waits before the history POST', async () => {
    const env = loadClient();
    withToken(env, { expiresAt: Date.now() + 60 * 60 * 1000 });
    env.replies.push('error', ADDED);                              // the refresh POST may have reached Simkl: don't fire straight after it
    const sleep = sleepRecorder(env);
    assert.deepEqual(await env.api.simklSubmit(SNAP, 0, sleep), { result: 'added' });
    assert.deepEqual(urlsOf(env), ['POST /oauth2/token', 'POST /sync/history']);
    assert.equal(sleep.calls.length, 1);
    assert.ok(sleep.calls[0].ms >= 1000);
    assert.equal(sleep.calls[0].sent, 1);
    assert.equal(env.requests[1].headers['Authorization'], 'Bearer A1');
});

await test('simklSubmit: a 429 is retried once after >= 1 s, and a 201 then counts as added', async () => {
    const env = loadClient();
    withToken(env);
    env.replies.push({ status: 429, body: { error: 'rate_limit' } }, ADDED);
    const sleep = sleepRecorder(env);
    assert.deepEqual(await env.api.simklSubmit(SNAP, 6, sleep), { result: 'added' });
    assert.deepEqual(urlsOf(env), ['POST /sync/history', 'POST /sync/history']);
    assert.equal(sleep.calls.length, 1);
    assert.ok(sleep.calls[0].ms >= 1000, 'retry gap should be >= 1000 ms, got ' + sleep.calls[0].ms);
    assert.equal(sleep.calls[0].sent, 1);                          // waited after the 429, before the retry
    assert.equal(env.requests[1].data, env.requests[0].data);      // the retry re-sends the same body (same watched_at, rating)
    assert.equal(JSON.parse(env.requests[1].data).movies[0].rating, 6);
});

await test('simklSubmit: 429 twice -> error after exactly two POSTs (no third), token kept', async () => {
    const env = loadClient();
    withToken(env);
    env.replies.push({ status: 429, body: { error: 'rate_limit' } }, { status: 429, body: { error: 'user_limit_exceeded' } }, ADDED);
    const sleep = sleepRecorder(env);
    assert.deepEqual(await env.api.simklSubmit(SNAP, 0, sleep), { result: 'error' });
    assert.equal(env.requests.length, 2);
    assert.equal(sleep.calls.length, 1);
    assert.equal(env.store.has('sc_simkl_token'), true);
});

await test('simklSubmit: 429 then a network error / 500 on the retry is still just "error"', async () => {
    for (const second of ['error', { status: 500, body: {} }]) {
        const env = loadClient();
        withToken(env);
        env.replies.push({ status: 429, body: {} }, second);
        assert.deepEqual(await env.api.simklSubmit(SNAP, 0, sleepRecorder(env)), { result: 'error' });
        assert.equal(env.requests.length, 2);
    }
});

await test('simklSubmit: 401 -> refresh -> 429 -> retry: waits after the refresh AND after the 429, four POSTs total, ends added', async () => {
    const env = loadClient();
    withToken(env);
    env.replies.push({ status: 401, body: {} }, tokenReply('A2', 'R2'), { status: 429, body: {} }, ADDED);
    const sleep = sleepRecorder(env);
    assert.deepEqual(await env.api.simklSubmit(SNAP, 0, sleep), { result: 'added' });
    assert.deepEqual(urlsOf(env), ['POST /sync/history', 'POST /oauth2/token', 'POST /sync/history', 'POST /sync/history']);
    assert.deepEqual(sleep.calls.map(c => c.sent), [2, 3]);
    assert.ok(sleep.calls.every(c => c.ms >= 1000));
    assert.equal(env.requests[3].headers['Authorization'], 'Bearer A2');
});

// ── Settings: Connect & verify ───────────────────────────────────────────────

const TOKEN_KEY = 'sc_simkl_token';
const F_ID = 'sc-input-simkl-clientid';
const CREDS = { [F_ID]: 'cid' };

// Fake ctx: records every setStatus/setDetail call; `open.v` flips isOpen().
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

await test('connect: empty Client ID -> bad status, no requests, nothing saved', async () => {
    for (const values of [{}, { [F_ID]: '   ' }]) {
        const env = loadClient();
        const t = makeCtx(values);
        await env.api.simklConnectAndVerify(t.ctx, { cancelled: false }, instantSleep);
        assert.deepEqual(t.statuses, [{ text: 'Enter your Client ID first', kind: 'bad' }]);
        assert.equal(env.requests.length, 0);
        assert.equal(env.store.size, 0);
        assert.equal(t.details.length, 0);
    }
});

await test('connect: the typed Client ID is trimmed and saved before any request', async () => {
    const env = loadClient();
    const t = makeCtx({ [F_ID]: '  typed-id  ' });
    env.replies.push({ status: 401, body: { error: 'invalid_client' } });
    await env.api.simklConnectAndVerify(t.ctx, { cancelled: false }, instantSleep);
    assert.equal(env.store.get('sc_simkl_client_id'), 'typed-id');
    assert.equal(env.requests.length, 1);
    assert.ok(env.requests[0].url.includes('client_id=typed-id&'), env.requests[0].url);   // the request used the just-saved id
    assert.equal(form(env.requests[0]).client_id, 'typed-id');
    assert.deepEqual(t.statuses[0], { text: 'Checking sign-in…', kind: 'pending' });
    assert.equal(t.details[0], '');
});

await test('connect: already connected -> verifies the stored token via /users/settings and never starts a sign-in', async () => {
    const env = loadClient();
    withToken(env);
    const t = makeCtx(CREDS);
    env.replies.push(SETTINGS_OK);
    await env.api.simklConnectAndVerify(t.ctx, { cancelled: false }, instantSleep);
    assert.deepEqual(t.last(), { text: '✓ Connected as spud', kind: 'ok' });
    assert.deepEqual(urlsOf(env), ['GET /users/settings']);
    assert.equal(env.requests[0].headers['Authorization'], 'Bearer A1');
    assert.ok(t.statuses.some(s => s.text === 'Checking sign-in…' && s.kind === 'pending'));
    assert.equal(env.requests.some(r => /oauth2\/device/.test(r.url)), false);
});

await test('connect: a stored token for a different Client ID is ignored -> fresh sign-in', async () => {
    const env = loadClient();
    withToken(env, { clientId: 'someone-else' });
    const t = makeCtx(CREDS);
    env.replies.push({ status: 200, body: DEVICE_OK }, tokenReply('A5', 'R5'), SETTINGS_OK);
    await env.api.simklConnectAndVerify(t.ctx, { cancelled: false }, instantSleep);
    assert.deepEqual(urlsOf(env), ['POST /oauth2/device', 'POST /oauth2/token', 'GET /users/settings']);   // no /users/settings with the stale token
    assert.equal(env.requests[2].headers['Authorization'], 'Bearer A5');
    assert.equal(JSON.parse(env.store.get(TOKEN_KEY)).clientId, 'cid');
    assert.deepEqual(t.last(), { text: '✓ Connected as spud', kind: 'ok' });
});

await test('connect: a stored token that /users/settings rejects falls through to a fresh sign-in', async () => {
    const env = loadClient();
    withToken(env);
    const t = makeCtx(CREDS);
    env.replies.push({ status: 401, body: {} }, { status: 200, body: DEVICE_OK }, tokenReply('A5', 'R5'), SETTINGS_OK);
    await env.api.simklConnectAndVerify(t.ctx, { cancelled: false }, instantSleep);
    assert.deepEqual(urlsOf(env), ['GET /users/settings', 'POST /oauth2/device', 'POST /oauth2/token', 'GET /users/settings']);
    assert.equal(env.requests[0].headers['Authorization'], 'Bearer A1');
    assert.equal(env.requests[3].headers['Authorization'], 'Bearer A5');
    assert.deepEqual(t.last(), { text: '✓ Connected as spud', kind: 'ok' });
});

await test('connect: full fresh sign-in shows the code + link, polls, saves the token and connects', async () => {
    const env = loadClient();
    const t = makeCtx(CREDS);
    env.replies.push({ status: 200, body: DEVICE_OK }, PENDING, tokenReply('A7', 'R7'), SETTINGS_OK);
    const sleeps = [];
    await env.api.simklConnectAndVerify(t.ctx, { cancelled: false }, async ms => { sleeps.push(ms); });
    assert.deepEqual(urlsOf(env), ['POST /oauth2/device', 'POST /oauth2/token', 'POST /oauth2/token', 'GET /users/settings']);
    assert.ok(env.requests.every(r => r.url.includes(AUTHQ)));
    assert.deepEqual(form(env.requests[0]), { client_id: 'cid', scope: 'media:read media:write' });
    for (const i of [1, 2]) {
        assert.deepEqual(form(env.requests[i]), { grant_type: DEVICE_GRANT, client_id: 'cid', device_code: 'DEV123' });
    }
    assert.equal(env.requests[3].headers['Authorization'], 'Bearer A7');
    assert.deepEqual(sleeps, [5000, 5000]);
    const saved = JSON.parse(env.store.get(TOKEN_KEY));
    assert.equal(saved.access, 'A7');
    assert.equal(saved.refresh, 'R7');
    assert.equal(saved.clientId, 'cid');
    // detail: shown with the code and the pin link (the prefilled "complete" URL), cleared at the end
    const shown = t.details.find(d => d.includes('BDWP-HQPK'));
    assert.ok(shown, 'detail HTML should contain the user code');
    assert.ok(shown.includes('class="sc-simkl-set-code">BDWP-HQPK</div>'));
    assert.ok(shown.includes('href="https://simkl.com/pin/BDWP-HQPK"'));
    assert.ok(shown.includes('>simkl.com/pin</a>'));
    assert.ok(shown.includes('target="_blank" rel="noopener"'));
    assert.equal(t.details[t.details.length - 1], '');
    // status walked through the expected phases and ended connected
    const texts = t.statuses.map(s => s.text);
    assert.equal(texts[0], 'Checking sign-in…');
    assert.ok(texts.some(x => /^Waiting for approval… \d+:\d\d$/.test(x)));
    assert.deepEqual(t.last(), { text: '✓ Connected as spud', kind: 'ok' });
});

await test('connect: signed in but the username lookup fails -> plain Connected', async () => {
    const env = loadClient();
    const t = makeCtx(CREDS);
    env.replies.push({ status: 200, body: DEVICE_OK }, tokenReply('A8', 'R8'), 'error');
    await env.api.simklConnectAndVerify(t.ctx, { cancelled: false }, instantSleep);
    assert.deepEqual(t.last(), { text: '✓ Connected', kind: 'ok' });
    assert.equal(JSON.parse(env.store.get(TOKEN_KEY)).access, 'A8');
});

await test('connect: the user code is HTML-escaped in the detail', async () => {
    const env = loadClient();
    const t = makeCtx(CREDS);
    env.replies.push({ status: 200, body: { ...DEVICE_OK, user_code: '<b>X&"' } }, { status: 400, body: { error: 'expired_token' } });
    await env.api.simklConnectAndVerify(t.ctx, { cancelled: false }, instantSleep);
    const shown = t.details.find(d => d.includes('sc-simkl-set-code'));
    assert.ok(shown.includes('&lt;b&gt;X&amp;&quot;'));
    assert.equal(shown.includes('<b>X'), false);
});

await test('connect: expired, read-only scope and generic sign-in failures report, clear the detail and store nothing', async () => {
    for (const [reply, expected] of [
        [{ status: 400, body: { error: 'expired_token' } }, '✗ Code expired — click Test again'],
        [tokenReply('A1', 'R1', 'media:read'), '✗ Simkl granted read-only access — click Test again and approve all permissions'],
        [{ status: 401, body: { error: 'invalid_client' } }, '✗ Sign-in failed — check the Client ID'],
        [{ status: 400, body: { error: 'invalid_grant' } }, '✗ Sign-in failed — check the Client ID'],
    ]) {
        const env = loadClient();
        const t = makeCtx(CREDS);
        env.replies.push({ status: 200, body: DEVICE_OK }, reply);
        await env.api.simklConnectAndVerify(t.ctx, { cancelled: false }, instantSleep);
        assert.deepEqual(t.last(), { text: expected, kind: 'bad' });
        assert.equal(t.details[t.details.length - 1], '');
        assert.equal(env.store.has(TOKEN_KEY), false);
        assert.deepEqual(urlsOf(env), ['POST /oauth2/device', 'POST /oauth2/token']);
    }
});

await test('connect: the code running out (our own deadline) reports expired', async () => {
    const env = loadClient();
    const t = makeCtx(CREDS);
    env.replies.push({ status: 200, body: { ...DEVICE_OK, expires_in: 0 } });
    await env.api.simklConnectAndVerify(t.ctx, { cancelled: false }, instantSleep);
    assert.deepEqual(t.last(), { text: '✗ Code expired — click Test again', kind: 'bad' });
    assert.deepEqual(urlsOf(env), ['POST /oauth2/device']);
    assert.equal(t.details[t.details.length - 1], '');
});

await test('connect: a Client ID Simkl rejects (device request refused) stops with the "rejected" status and shows no code', async () => {
    for (const reply of [{ status: 401, body: { error: 'invalid_client' } }, { status: 412, body: {} }, { status: 200, body: {} }]) {
        const env = loadClient();
        const t = makeCtx(CREDS);
        env.replies.push(reply);
        await env.api.simklConnectAndVerify(t.ctx, { cancelled: false }, instantSleep);
        assert.deepEqual(t.last(), { text: '✗ Client ID rejected by Simkl — check it at simkl.com/settings/developer', kind: 'bad' });
        assert.deepEqual(urlsOf(env), ['POST /oauth2/device']);
        assert.equal(t.details.some(d => d !== ''), false);
    }
});

await test('connect: Simkl unreachable (device request fails at the network level) reports "Couldn\'t reach Simkl"', async () => {
    for (const reply of ['error', 'timeout']) {
        const env = loadClient();
        const t = makeCtx(CREDS);
        env.replies.push(reply);
        await env.api.simklConnectAndVerify(t.ctx, { cancelled: false }, instantSleep);
        assert.deepEqual(t.last(), { text: '⚠ Couldn\'t reach Simkl', kind: 'bad' });
        assert.deepEqual(urlsOf(env), ['POST /oauth2/device']);
    }
});

await test('connect: user cancel stops the poll and reports Cancelled with no kind', async () => {
    const env = loadClient();
    const t = makeCtx(CREDS);
    const handle = { cancelled: false };
    env.replies.push({ status: 200, body: DEVICE_OK });
    await env.api.simklConnectAndVerify(t.ctx, handle, async () => { handle.cancelled = true; });
    assert.deepEqual(t.last(), { text: 'Cancelled', kind: undefined });
    assert.equal(t.details[t.details.length - 1], '');
    assert.deepEqual(urlsOf(env), ['POST /oauth2/device']);   // no token request
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
    env.replies.push({ status: 200, body: DEVICE_OK });
    await env.api.simklConnectAndVerify(t.ctx, handle, async () => { slept++; });
    assert.equal(handle.cancelled, true);
    assert.equal(slept, 0);
    assert.deepEqual(t.last(), { text: 'Cancelled', kind: undefined });
    assert.deepEqual(urlsOf(env), ['POST /oauth2/device']);
});

await test('connect: only https verification links are used; anything else falls back to simkl.com/pin', async () => {
    const cases = [
        // [verification_uri, verification_uri_complete, expected href, expected shown text]
        ['https://simkl.com/pin', 'https://simkl.com/pin/BDWP-HQPK', 'https://simkl.com/pin/BDWP-HQPK', 'simkl.com/pin'],
        ['https://simkl.com/pin', undefined, 'https://simkl.com/pin', 'simkl.com/pin'],
        ['https://simkl.com/pin', 'javascript:alert(1)', 'https://simkl.com/pin', 'simkl.com/pin'],
        ['javascript:alert(1)', 'javascript:alert(2)', 'https://simkl.com/pin', 'simkl.com/pin'],
        ['http://simkl.com/pin', 'http://simkl.com/pin/X', 'https://simkl.com/pin', 'simkl.com/pin'],
        [undefined, undefined, 'https://simkl.com/pin', 'simkl.com/pin'],
    ];
    for (const [uri, complete, href, shownText] of cases) {
        const env = loadClient();
        const t = makeCtx(CREDS);
        const dev = { ...DEVICE_OK, verification_uri: uri, verification_uri_complete: complete };
        env.replies.push({ status: 200, body: dev }, { status: 400, body: { error: 'expired_token' } });
        await env.api.simklConnectAndVerify(t.ctx, { cancelled: false }, instantSleep);
        const shown = t.details.find(d => d.includes('sc-simkl-set-code'));
        assert.ok(shown.includes(`href="${href}"`), `${uri} / ${complete}: ${shown}`);
        assert.ok(shown.includes(`>${shownText}</a>`), `${uri} / ${complete}: ${shown}`);
        assert.equal(shown.includes('javascript'), false);
        assert.equal(shown.includes('http://'), false);
    }
});

console.log(`OK: ${passed} simkl-scrobble test groups passed`);
