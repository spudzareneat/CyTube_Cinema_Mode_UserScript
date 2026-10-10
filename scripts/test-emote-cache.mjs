// scripts/test-emote-cache.mjs
//
// Standalone assertions for the emote-cache module's fetch/priming path in
// src/pc/modules/emote-cache/index.js, run against fakes for Cache Storage,
// the DOM and GM_xmlhttpRequest:
//
//   node scripts/test-emote-cache.mjs
//
// The point being locked in: emote bytes are downloaded through
// GM_xmlhttpRequest (no CORS), NEVER a page-context fetch() -- a plain fetch
// to a CDN without CORS headers fails AND logs a "Cross-Origin Request
// Blocked" console error for every such emote on every page load.
//
// No test harness in this repo (no package.json, no runner), so this is a
// plain node script that exits non-zero on the first failing assertion.
// src/pc/** files are script fragments concatenated inside one IIFE, not ES
// modules, so it slices the code out between "test marker" comments and evals
// it, same convention as scripts/test-simkl-scrobble.mjs.

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(__dirname, '..', 'src', 'pc', 'modules', 'emote-cache', 'index.js');
const src = fs.readFileSync(srcPath, 'utf8');

const START = '// ── test marker: emote-cache slice start ──';
const END = '// ── test marker: emote-cache slice end ──';
const a = src.indexOf(START);
const b = src.indexOf(END);
if (a === -1 || b === -1 || b < a) {
    console.error('FAIL: could not locate the "emote-cache" test-marker slice in emote-cache/index.js');
    process.exit(1);
}
const snippet = src.slice(a, b);

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

// Fresh module instance + fakes per test. `replies` maps url -> a function
// that drives the GM callbacks: (details) => details.onload({ status, response, responseHeaders }) etc.
function makeEnv(replies, preCached = {}) {
    const gmCalls = [];
    const fetchCalls = [];
    const store = new Map(Object.entries(preCached));
    const cache = {
        put: async (url, res) => { store.set(url, res); },
        match: async url => (store.has(url) ? store.get(url).clone() : undefined),
        delete: async url => store.delete(url),
    };
    const fakeDocument = { querySelectorAll: () => [], getElementById: () => null };
    const GM_xmlhttpRequest = details => {
        gmCalls.push(details);
        const reply = replies[details.url];
        if (!reply) { details.onerror && details.onerror({}); return; }
        reply(details);
    };
    // eslint-disable-next-line no-new-func
    const api = new Function(
        'window', 'caches', 'document', 'fetch', 'GM_xmlhttpRequest',
        `${snippet}\n;return { primeEmoteCache, getEmoteBlobUrl, _scEmoteCacheFailed };`
    )(
        { caches: true },
        { open: async () => cache },
        fakeDocument,
        (...args) => { fetchCalls.push(args); return Promise.reject(new TypeError('NetworkError')); },
        GM_xmlhttpRequest,
    );
    return { api, gmCalls, fetchCalls, store };
}

const bytes = () => new Uint8Array([71, 73, 70, 56, 57, 97]).buffer; // "GIF89a"
const ok = (headers = 'content-type: image/gif\r\n') => details =>
    details.onload({ status: 200, response: bytes(), responseHeaders: headers });

await test('downloads an emote via GM_xmlhttpRequest, never a page-context fetch()', async () => {
    const url = 'https://image.ibb.co/x/meh.png';
    const env = makeEnv({ [url]: ok() });
    await env.api.primeEmoteCache([{ name: 'meh', image: url }]);
    assert.equal(env.fetchCalls.length, 0, 'fetch() must not be used -- it logs a CORS error per emote');
    assert.equal(env.gmCalls.length, 1);
    assert.equal(env.gmCalls[0].url, url);
    assert.equal(env.gmCalls[0].method, 'GET');
    assert.equal(env.gmCalls[0].responseType, 'arraybuffer');
});

await test('a successful download is put in Cache Storage under its URL and exposed as a blob URL', async () => {
    const url = 'https://i.pinimg.com/originals/aa/bb/cc.gif';
    const env = makeEnv({ [url]: ok() });
    await env.api.primeEmoteCache([{ name: 'wave', image: url }]);
    assert.ok(env.store.has(url), 'cached under the image URL so cache.match(e.image) hits next load');
    assert.equal(env.api._scEmoteCacheFailed.has('wave'), false);
    assert.ok(env.api.getEmoteBlobUrl('wave'), 'blob URL resolved for the renderers');
});

await test('the response Content-Type is preserved on the cached copy', async () => {
    const url = 'https://i.gifer.com/85q.gif';
    const env = makeEnv({ [url]: ok('Server: x\r\nContent-Type: image/gif; charset=binary\r\nX-Other: 1\r\n') });
    await env.api.primeEmoteCache([{ name: 'g', image: url }]);
    assert.equal(env.store.get(url).headers.get('content-type'), 'image/gif; charset=binary');
});

await test('a missing Content-Type header still caches (no crash, no type)', async () => {
    const url = 'https://i.gifer.com/me.gif';
    const env = makeEnv({ [url]: ok('') });
    await env.api.primeEmoteCache([{ name: 'm', image: url }]);
    assert.ok(env.store.has(url));
    assert.ok(env.api.getEmoteBlobUrl('m'));
});

await test('a non-2xx status is not cached and is remembered as failed for the session', async () => {
    const url = 'https://i.makeagif.com/media/x.gif';
    const env = makeEnv({ [url]: d => d.onload({ status: 403, response: bytes(), responseHeaders: '' }) });
    await env.api.primeEmoteCache([{ name: 'bad', image: url }]);
    assert.equal(env.store.has(url), false);
    assert.equal(env.api.getEmoteBlobUrl('bad'), null);
    assert.ok(env.api._scEmoteCacheFailed.has('bad'));
    await env.api.primeEmoteCache([{ name: 'bad', image: url }]);
    assert.equal(env.gmCalls.length, 1, 'a failed emote is not re-requested this session');
});

await test('a network error and a timeout are swallowed and remembered as failed', async () => {
    const u1 = 'https://dead.example/a.gif';
    const u2 = 'https://slow.example/b.gif';
    const env = makeEnv({ [u1]: d => d.onerror({}), [u2]: d => d.ontimeout({}) });
    await env.api.primeEmoteCache([{ name: 'a', image: u1 }, { name: 'b', image: u2 }]);
    assert.ok(env.api._scEmoteCacheFailed.has('a'));
    assert.ok(env.api._scEmoteCacheFailed.has('b'));
    assert.equal(env.store.size, 0);
});

await test('an already-cached emote is served from Cache Storage with no request at all', async () => {
    const url = 'https://image.ibb.co/y/cached.gif';
    const env = makeEnv({}, { [url]: new Response(bytes(), { headers: { 'content-type': 'image/gif' } }) });
    await env.api.primeEmoteCache([{ name: 'cached', image: url }]);
    assert.equal(env.gmCalls.length, 0);
    assert.equal(env.fetchCalls.length, 0);
    assert.ok(env.api.getEmoteBlobUrl('cached'));
});

console.log(`test-emote-cache: ${passed} passed`);
