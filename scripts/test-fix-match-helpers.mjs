// scripts/test-fix-match-helpers.mjs
//
// Standalone assertions for the two PURE helpers behind Task 5's "Matched as"
// diagnostic line and the Fix-match modal, in
// src/pc/modules/movie-title-links/index.js:
//
//   _fixMatchDetectTconst(input)  -> a bare "tt…" id, or null
//   _fixRuntimeIndicator(delta, runtimeMin, knownMin) -> the ✓ / ✗ / unknown
//                                                        / '' runtime clause
//
// No test harness in this repo (no package.json, no runner), so this is a plain
// node script:
//
//   node scripts/test-fix-match-helpers.mjs
//
// Exits non-zero on the first failing assertion; prints a one-line pass summary
// otherwise. src/pc/** files are script fragments concatenated inside one IIFE,
// not ES modules, so the file can't be imported -- both helpers reference no
// names from outside their own block, so we slice the block out between its
// "test marker" comments and eval it faithfully to how it runs in the bundle.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(__dirname, '..', 'src', 'pc', 'modules', 'movie-title-links', 'index.js');
const src = fs.readFileSync(srcPath, 'utf8');

const START = '// ── test marker: fix-match helpers slice start ──';
const END = '// ── test marker: fix-match helpers slice end ──';
const start = src.indexOf(START);
const end = src.indexOf(END);
if (start === -1 || end === -1 || end < start) {
    console.error('FAIL: could not locate the "fix-match helpers" test-marker slice in movie-title-links/index.js');
    process.exit(1);
}
const snippet = src.slice(start, end);

// eslint-disable-next-line no-new-func
const { _fixMatchDetectTconst, _fixRuntimeIndicator } = new Function(
    `${snippet}\n;return { _fixMatchDetectTconst, _fixRuntimeIndicator };`
)();

let failed = 0;
function eq(label, actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        console.error(`FAIL: ${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
        failed++;
    }
}

/* ---- _fixMatchDetectTconst ------------------------------------------------ */

eq('bare tt-id', _fixMatchDetectTconst('tt0084787'), 'tt0084787');
eq('tt-id uppercased -> lowercased', _fixMatchDetectTconst('TT0084787'), 'tt0084787');
eq('full imdb URL', _fixMatchDetectTconst('https://www.imdb.com/title/tt0081505/'), 'tt0081505');
eq('imdb URL no scheme', _fixMatchDetectTconst('imdb.com/title/tt1234567'), 'tt1234567');
eq('tt-id embedded in text', _fixMatchDetectTconst('  the thing tt0084787  '), 'tt0084787');
eq('8-digit tt-id', _fixMatchDetectTconst('tt12345678'), 'tt12345678');
eq('plain search term -> null', _fixMatchDetectTconst('The Thing 1982'), null);
eq('too-short digit run -> null', _fixMatchDetectTconst('tt123'), null);
eq('empty string -> null', _fixMatchDetectTconst(''), null);
eq('null input -> null', _fixMatchDetectTconst(null), null);
eq('undefined input -> null', _fixMatchDetectTconst(undefined), null);

/* ---- _fixRuntimeIndicator ----------------------------------------------- */

// No runtime on the resolved title at all -> empty clause (caller omits it).
eq('no runtime -> ""', _fixRuntimeIndicator(3, null, 120), '');
eq('no runtime, everything null -> ""', _fixRuntimeIndicator(null, null, null), '');

// Runtime known but nothing to compare against -> "runtime unknown".
eq('no known duration -> unknown', _fixRuntimeIndicator(null, 128, null), 'runtime unknown');
eq('known duration 0 -> unknown', _fixRuntimeIndicator(null, 128, 0), 'runtime unknown');
eq('delta null but runtime+known present -> unknown', _fixRuntimeIndicator(null, 128, 130), 'runtime unknown');

// Within 15% tolerance -> ✓ with the labelled "≈" form.
eq('exact match -> ✓', _fixRuntimeIndicator(0, 131, 131), 'runtime ✓ IMDb 131m ≈ file 131m');
eq('3m off on 131 -> ✓', _fixRuntimeIndicator(3, 128, 131), 'runtime ✓ IMDb 128m ≈ file 131m');
eq('15% boundary -> ✓', _fixRuntimeIndicator(15, 100, 100), 'runtime ✓ IMDb 100m ≈ file 100m'); // 15/100 == 0.15

// Beyond tolerance -> ✗ with the labelled "vs" form.
eq('far off -> ✗', _fixRuntimeIndicator(36, 128, 92), 'runtime ✗ IMDb 128m vs file 92m');
eq('just past 15% -> ✗', _fixRuntimeIndicator(16, 100, 100), 'runtime ✗ IMDb 100m vs file 100m'); // 16/100 > 0.15

if (failed) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
}
console.log('PASS: fix-match helpers — _fixMatchDetectTconst + _fixRuntimeIndicator, all assertions green');
