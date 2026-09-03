// scripts/test-tmdb-year-merge.mjs
//
// Standalone assertions for tagYearFilteredResults() in
// src/pc/modules/tmdb/index.js -- the pure merge+tag helper behind the
// year-filtered TMDB search (Task 2). There is no test harness in this repo
// (no package.json, no runner), so this is a plain node script:
//
//   node scripts/test-tmdb-year-merge.mjs
//
// Exits non-zero on the first failing assertion; prints a one-line pass
// summary otherwise.
//
// src/pc/** files are script fragments concatenated inside one IIFE -- not ES
// modules -- and fetchTmdbPrimary references runtime globals (GM_xmlhttpRequest,
// hasKey, scRegisterInit...), so the whole file can't be eval'd. Instead we
// slice out just the pure helper between its "test marker" comments and eval
// that. The helper references nothing but its two arguments, so this is
// faithful to how it runs in the assembled bundle.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(__dirname, '..', 'src', 'pc', 'modules', 'tmdb', 'index.js');
const src = fs.readFileSync(srcPath, 'utf8');

const start = src.indexOf('// ── test marker: slice start ──');
const end = src.indexOf('// ── test marker: slice end ──');
if (start === -1 || end === -1 || end < start) {
    console.error('FAIL: could not locate the "test marker" slice in tmdb/index.js');
    process.exit(1);
}
const snippet = src.slice(start, end);

// eslint-disable-next-line no-new-func
const { tagYearFilteredResults } = new Function(`${snippet}\n;return { tagYearFilteredResults };`)();

let failed = 0;
function assert(label, cond) {
    if (!cond) { console.error(`FAIL: ${label}`); failed++; }
}
function eq(label, actual, expected) {
    assert(`${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`,
        JSON.stringify(actual) === JSON.stringify(expected));
}

// 1. Tags every movie result with media_type: 'movie', preserving other fields.
{
    const out = tagYearFilteredResults([{ id: 1, title: 'A', release_date: '1984-01-01' }], []);
    eq('movie tagged + fields kept', out, [{ id: 1, title: 'A', release_date: '1984-01-01', media_type: 'movie' }]);
}

// 2. Tags every tv result with media_type: 'tv'.
{
    const out = tagYearFilteredResults([], [{ id: 9, name: 'B', first_air_date: '1984-09-01' }]);
    eq('tv tagged + fields kept', out, [{ id: 9, name: 'B', first_air_date: '1984-09-01', media_type: 'tv' }]);
}

// 3. Merge order is movies-first, then tv (so the downstream year tiebreak,
//    which takes the FIRST date match, favours a movie the same way
//    /search/multi's ordering does).
{
    const out = tagYearFilteredResults([{ id: 1 }, { id: 2 }], [{ id: 3 }, { id: 4 }]);
    eq('merge order movies-then-tv', out.map(r => [r.id, r.media_type]),
        [[1, 'movie'], [2, 'movie'], [3, 'tv'], [4, 'tv']]);
}

// 4. Existing media_type on a raw result is overwritten by the correct tag
//    (defensive: /search/movie shouldn't send one, but if it ever does it must
//    not win over the endpoint we actually called).
{
    const out = tagYearFilteredResults([{ id: 1, media_type: 'person' }], []);
    eq('stale media_type overwritten', out[0].media_type, 'movie');
}

// 5. Null / undefined / missing inputs -> empty array, never throws. This is the
//    "both searches errored / non-200" case that must fall through to
//    /search/multi (caller checks merged.length).
eq('both null -> []', tagYearFilteredResults(null, null), []);
eq('both undefined -> []', tagYearFilteredResults(undefined, undefined), []);
eq('no args -> []', tagYearFilteredResults(), []);
eq('empty arrays -> []', tagYearFilteredResults([], []), []);

// 6. One side empty, other populated -> just the populated side (a movie-only
//    or tv-only year match still counts as a hit).
eq('movie-only hit', tagYearFilteredResults([{ id: 7 }], []).map(r => r.media_type), ['movie']);
eq('tv-only hit', tagYearFilteredResults(null, [{ id: 7 }]).map(r => r.media_type), ['tv']);

// 7. Does not mutate the input objects.
{
    const input = { id: 1 };
    tagYearFilteredResults([input], []);
    assert('input not mutated', input.media_type === undefined);
}

if (failed) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
}
console.log('PASS: tagYearFilteredResults — 13 assertions across 7 cases');
