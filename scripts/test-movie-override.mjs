// scripts/test-movie-override.mjs
//
// Standalone assertions for the match-override store accessors in
// src/pc/modules/movie-title-links/index.js -- getMovieOverride /
// setMovieOverride / clearMovieOverride and their once-loaded `movieOverrides`
// backing object (Task 4, "Layer 3c"). No test harness in this repo (no
// package.json, no runner), so this is a plain node script:
//
//   node scripts/test-movie-override.mjs
//
// Exits non-zero on the first failing assertion; prints a one-line pass
// summary otherwise.
//
// src/pc/** files are script fragments concatenated inside one IIFE -- not ES
// modules -- so the file can't be imported. The accessor block references only
// two names from outside itself (`localStorage` and the `LS_MOVIE_OVERRIDE`
// key constant), so we slice it out between its "test marker" comments and
// eval it with both injected, faithful to how it runs in the bundle. The block
// is re-eval'd fresh per scenario so the once-only `movieOverrides` loader is
// exercised against each localStorage shim state.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(__dirname, '..', 'src', 'pc', 'modules', 'movie-title-links', 'index.js');
const src = fs.readFileSync(srcPath, 'utf8');

const START = '// ── test marker: override store slice start ──';
const END = '// ── test marker: override store slice end ──';
const start = src.indexOf(START);
const end = src.indexOf(END);
if (start === -1 || end === -1 || end < start) {
    console.error('FAIL: could not locate the "override store" test-marker slice in movie-title-links/index.js');
    process.exit(1);
}
const snippet = src.slice(start, end);

const LS_MOVIE_OVERRIDE = 'sc_movie_override_v1';

// Minimal localStorage shim: a plain backing object + the three methods the
// accessors touch. `raw` lets a test seed a pre-existing (possibly malformed)
// value before the slice's loader runs.
function makeLocalStorage(raw) {
    const store = Object.create(null);
    if (raw !== undefined) store[LS_MOVIE_OVERRIDE] = raw;
    return {
        _store: store,
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; },
    };
}

// Fresh eval of the sliced accessor block against a given localStorage shim.
function loadAccessors(localStorage) {
    // eslint-disable-next-line no-new-func
    return new Function('localStorage', 'LS_MOVIE_OVERRIDE',
        `${snippet}\n;return { getMovieOverride, setMovieOverride, clearMovieOverride };`
    )(localStorage, LS_MOVIE_OVERRIDE);
}

let failed = 0;
function assert(label, cond) {
    if (!cond) { console.error(`FAIL: ${label}`); failed++; }
}
function eq(label, actual, expected) {
    assert(`${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`,
        JSON.stringify(actual) === JSON.stringify(expected));
}

// 1. set -> get round-trip, and persistence to the localStorage shim.
{
    const ls = makeLocalStorage();
    const { getMovieOverride, setMovieOverride } = loadAccessors(ls);
    setMovieOverride('The.Thing.1982.mkv', { imdbId: 'tt0084787', tmdbId: 1091 });
    const got = getMovieOverride('The.Thing.1982.mkv');
    eq('round-trip imdbId', got && got.imdbId, 'tt0084787');
    eq('round-trip tmdbId', got && got.tmdbId, 1091);
    assert('round-trip ts is a number', got && typeof got.ts === 'number');
    const persisted = JSON.parse(ls.getItem(LS_MOVIE_OVERRIDE));
    eq('persisted to localStorage', persisted['The.Thing.1982.mkv'].imdbId, 'tt0084787');
}

// 2. tmdbId omitted -> normalized to null (not undefined).
{
    const ls = makeLocalStorage();
    const { getMovieOverride, setMovieOverride } = loadAccessors(ls);
    setMovieOverride('Nosferatu.1922.avi', { imdbId: 'tt0013442' });
    const got = getMovieOverride('Nosferatu.1922.avi');
    eq('tmdbId defaults to null', got && got.tmdbId, null);
}

// 3. absent key -> undefined, no throw.
{
    const ls = makeLocalStorage();
    const { getMovieOverride } = loadAccessors(ls);
    eq('absent filename -> undefined', getMovieOverride('never.pinned.mp4'), undefined);
    eq('empty filename -> undefined', getMovieOverride(''), undefined);
    eq('undefined filename -> undefined', getMovieOverride(undefined), undefined);
}

// 4. clear removes the key and persists the removal.
{
    const ls = makeLocalStorage();
    const { getMovieOverride, setMovieOverride, clearMovieOverride } = loadAccessors(ls);
    setMovieOverride('a.mkv', { imdbId: 'tt1' });
    setMovieOverride('b.mkv', { imdbId: 'tt2' });
    clearMovieOverride('a.mkv');
    eq('cleared entry -> undefined', getMovieOverride('a.mkv'), undefined);
    eq('sibling entry untouched', getMovieOverride('b.mkv').imdbId, 'tt2');
    const persisted = JSON.parse(ls.getItem(LS_MOVIE_OVERRIDE));
    assert('cleared key gone from localStorage', !('a.mkv' in persisted));
    assert('sibling key still in localStorage', 'b.mkv' in persisted);
}

// 5. clearing a filename that was never pinned is a silent no-op.
{
    const ls = makeLocalStorage();
    const { clearMovieOverride } = loadAccessors(ls);
    clearMovieOverride('ghost.mkv'); // must not throw
    assert('no-op clear left store unwritten', ls.getItem(LS_MOVIE_OVERRIDE) === null);
}

// 6. malformed JSON already in localStorage -> loader tolerates it, treats the
//    store as empty, and still works for subsequent writes.
{
    const ls = makeLocalStorage('{ this is not json ');
    const { getMovieOverride, setMovieOverride } = loadAccessors(ls);
    eq('malformed store -> get returns undefined', getMovieOverride('x.mkv'), undefined);
    setMovieOverride('x.mkv', { imdbId: 'tt9' });
    eq('write recovers after malformed load', getMovieOverride('x.mkv').imdbId, 'tt9');
}

// 7. non-object JSON (array / string / number / null) -> treated as empty map.
{
    for (const raw of ['[1,2,3]', '"hello"', '42', 'null']) {
        const ls = makeLocalStorage(raw);
        const { getMovieOverride, setMovieOverride } = loadAccessors(ls);
        eq(`non-object store ${raw} -> undefined`, getMovieOverride('k.mkv'), undefined);
        setMovieOverride('k.mkv', { imdbId: 'ttA' });
        eq(`write works after non-object store ${raw}`, getMovieOverride('k.mkv').imdbId, 'ttA');
    }
}

// 8. malformed entry (object without imdbId) -> getMovieOverride returns
//    undefined, so lookupMovie never enters its override fork with a bad id.
{
    const ls = makeLocalStorage(JSON.stringify({ 'bad.mkv': { tmdbId: 5, ts: 1 } }));
    const { getMovieOverride } = loadAccessors(ls);
    eq('entry without imdbId -> undefined', getMovieOverride('bad.mkv'), undefined);
}

// 9. setMovieOverride with no imdbId is a no-op (no partial entry written).
{
    const ls = makeLocalStorage();
    const { getMovieOverride, setMovieOverride } = loadAccessors(ls);
    setMovieOverride('c.mkv', {});
    setMovieOverride('c.mkv', { tmdbId: 7 });
    setMovieOverride('', { imdbId: 'ttZ' });
    eq('no-imdbId set -> nothing pinned', getMovieOverride('c.mkv'), undefined);
    assert('no-imdbId set -> store never written', ls.getItem(LS_MOVIE_OVERRIDE) === null);
}

if (failed) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
}
console.log('PASS: movie-override store — 9 scenarios, all assertions green');
