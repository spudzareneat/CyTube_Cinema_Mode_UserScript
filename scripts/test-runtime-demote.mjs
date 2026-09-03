// scripts/test-runtime-demote.mjs
//
// Standalone assertions for demoteByRuntime() in
// src/pc/modules/movie-title-links/index.js -- the pure runtime cross-check
// helper (Task 3, "Layer 1c") that re-orders search candidates so any whose
// runtime is far from the playing file's duration lose priority (but are
// never dropped). No test harness in this repo (no package.json, no runner),
// so this is a plain node script:
//
//   node scripts/test-runtime-demote.mjs
//
// Exits non-zero on the first failing assertion; prints a one-line pass
// summary otherwise.
//
// src/pc/** files are script fragments concatenated inside one IIFE -- not ES
// modules -- so the whole file can't be imported. demoteByRuntime references
// nothing but its three arguments (no globals, no network), so we slice it out
// between its "test marker" comments and eval that -- faithful to how it runs
// in the assembled bundle.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(__dirname, '..', 'src', 'pc', 'modules', 'movie-title-links', 'index.js');
const src = fs.readFileSync(srcPath, 'utf8');

const start = src.indexOf('// ── test marker: slice start ──');
const end = src.indexOf('// ── test marker: slice end ──');
if (start === -1 || end === -1 || end < start) {
    console.error('FAIL: could not locate the "test marker" slice in movie-title-links/index.js');
    process.exit(1);
}
const snippet = src.slice(start, end);

// eslint-disable-next-line no-new-func
const { demoteByRuntime } = new Function(`${snippet}\n;return { demoteByRuntime };`)();

// Mirrors imdbCandidateRuntimeMin in the source: seconds -> whole minutes, or
// null. (Kept tiny + inline here rather than sliced; drift risk is negligible.)
const getRuntimeMin = (c) => (c.runtimeSeconds != null ? Math.round(c.runtimeSeconds / 60) : null);

let failed = 0;
function assert(label, cond) {
    if (!cond) { console.error(`FAIL: ${label}`); failed++; }
}
function eq(label, actual, expected) {
    assert(`${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`,
        JSON.stringify(actual) === JSON.stringify(expected));
}

// A 120-minute playing file -> targetMin = 120.
const TARGET_SECONDS = 120 * 60;

// 1. Exact-runtime match is kept and stays first; a wildly-off candidate that
//    led on votes is demoted behind it.
{
    const cands = [
        { id: 'off',   runtimeSeconds: 200 * 60 }, // +67% -> demoted
        { id: 'exact', runtimeSeconds: 120 * 60 }, // 0%   -> kept
    ];
    eq('exact match kept first', demoteByRuntime(cands, TARGET_SECONDS, getRuntimeMin).map(c => c.id),
        ['exact', 'off']);
}

// 2. 10% off (108 min vs 120) is within the 15% tolerance -> kept, order intact.
{
    const cands = [
        { id: 'ten',  runtimeSeconds: 108 * 60 }, // 10% -> kept
        { id: 'near', runtimeSeconds: 122 * 60 }, // ~1.7% -> kept
    ];
    eq('10% off kept (no reorder)', demoteByRuntime(cands, TARGET_SECONDS, getRuntimeMin).map(c => c.id),
        ['ten', 'near']);
}

// 3. 40% off (168 min vs 120) exceeds tolerance -> demoted behind an in-range
//    candidate that was ranked lower.
{
    const cands = [
        { id: 'forty', runtimeSeconds: 168 * 60 }, // 40% -> demoted
        { id: 'good',  runtimeSeconds: 115 * 60 }, // ~4% -> kept
    ];
    eq('40% off demoted', demoteByRuntime(cands, TARGET_SECONDS, getRuntimeMin).map(c => c.id),
        ['good', 'forty']);
}

// 4. A candidate with no runtime data is NEVER demoted -- it stays exactly
//    where it was, even ahead of a perfect runtime match.
{
    const cands = [
        { id: 'unknown', runtimeSeconds: null },   // no data -> kept, in place
        { id: 'exact',   runtimeSeconds: 120 * 60 },
        { id: 'off',     runtimeSeconds: 300 * 60 }, // demoted
    ];
    eq('no-runtime kept in place', demoteByRuntime(cands, TARGET_SECONDS, getRuntimeMin).map(c => c.id),
        ['unknown', 'exact', 'off']);
}

// 5. All candidates demoted -> incoming relative order fully preserved (nothing
//    is kept, so concat is just the demoted list in its original order).
{
    const cands = [
        { id: 'a', runtimeSeconds: 200 * 60 },
        { id: 'b', runtimeSeconds: 220 * 60 },
        { id: 'c', runtimeSeconds: 60 * 60 },
    ];
    eq('all-demoted preserves order', demoteByRuntime(cands, TARGET_SECONDS, getRuntimeMin).map(c => c.id),
        ['a', 'b', 'c']);
}

// 6. knownSeconds falsy (undefined / 0 / null) -> no-op returning the SAME
//    array reference, order untouched. This is the "no call site passed a
//    duration" path and must be byte-identical to pre-Task-3.
{
    const cands = [
        { id: 'x', runtimeSeconds: 999 * 60 },
        { id: 'y', runtimeSeconds: 1 * 60 },
    ];
    for (const falsy of [undefined, 0, null, NaN]) {
        const out = demoteByRuntime(cands, falsy, getRuntimeMin);
        assert(`knownSeconds ${String(falsy)} -> same reference`, out === cands);
    }
}

// 7. Stable partition with a mix: kept keeps its sub-order, demoted keeps its
//    sub-order, kept ++ demoted.
{
    const cands = [
        { id: 'k1', runtimeSeconds: 118 * 60 }, // kept
        { id: 'd1', runtimeSeconds: 250 * 60 }, // demoted
        { id: 'k2', runtimeSeconds: 125 * 60 }, // kept
        { id: 'd2', runtimeSeconds: 40 * 60 },  // demoted
        { id: 'k3', runtimeSeconds: null },     // kept (no data)
    ];
    eq('stable partition kept++demoted', demoteByRuntime(cands, TARGET_SECONDS, getRuntimeMin).map(c => c.id),
        ['k1', 'k2', 'k3', 'd1', 'd2']);
}

// 8. Boundary: exactly 15% off is NOT demoted (strict `>` in the helper).
{
    const cands = [{ id: 'edge', runtimeSeconds: 138 * 60 }]; // 138 = 120 * 1.15
    eq('exactly 15% off kept', demoteByRuntime(cands, TARGET_SECONDS, getRuntimeMin).map(c => c.id),
        ['edge']);
}

if (failed) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
}
console.log('PASS: demoteByRuntime — 11 assertions across 8 cases');
