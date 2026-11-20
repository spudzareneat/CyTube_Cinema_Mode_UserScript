// scripts/test-lineup-published-schedule.mjs
//
// Standalone assertions for lineupParsePublishedSchedule in
// src/pc/modules/tonights-lineup/index.js -- the validator/reader for the weekend lineup that
// grindhouse-popup-trivia publishes as schedule/current.json (Reddit RSS ended 2026-11-13).
//
//   node scripts/test-lineup-published-schedule.mjs
//
// Same slice-and-eval approach as the other scripts/test-*.mjs files.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pc', 'modules', 'tonights-lineup', 'index.js'), 'utf8');
const start = src.indexOf('// ── test marker: published-schedule slice start ──');
const end = src.indexOf('// ── test marker: published-schedule slice end ──');
if (start === -1 || end === -1 || end < start) {
    console.error('FAIL: could not locate the "published-schedule" slice in tonights-lineup/index.js');
    process.exit(1);
}
// eslint-disable-next-line no-new-func
const { lineupParsePublishedSchedule } = new Function(`${src.slice(start, end)}\n;return { lineupParsePublishedSchedule };`)();

let failed = 0;
function eq(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) { console.error(`FAIL: ${label}\n  got  ${a}\n  want ${e}`); failed++; }
}
function throws(label, fn, re) {
    try { fn(); console.error(`FAIL: ${label}: did not throw`); failed++; }
    catch (e) { if (!re.test(String(e && e.message))) { console.error(`FAIL: ${label}: wrong error: ${e && e.message}`); failed++; } }
}

const doc = () => ({
    schema: 1, fetchedAt: '2026-11-20T05:00:00.000Z', postId: 't3_1p2q3r', title: 'Weekend Grindhouse Schedule - Fri 11/20 - Sun 11/22',
    publishedAt: '2026-11-18T12:00:00+00:00', weekend: { fri: '2026-11-20', sat: '2026-11-21', sun: '2026-11-22' },
    days: [
        { day: 'Friday', date: '2026-11-20', sections: [{ name: 'Friday', slug: 'friday', items: [
            { title: 'Zeiram', year: '1991', display: 'Zeiram (1991)', akas: [], imdbId: 'tt0103327', imdbRating: 6.4, imdbVotes: 3100 },
            { title: 'Mystery Film', year: null, display: 'Mystery Film', akas: [], imdbId: null, imdbRating: null, imdbVotes: null },
        ] }] },
        { day: 'Saturday', date: '2026-11-21', sections: [{ name: 'Late Show', slug: 'late-show', items: [
            { title: 'Tenebre', year: '1984', display: 'Tenebre (1984)', akas: ['Tenebrae'], imdbId: null, imdbRating: null, imdbVotes: null },
        ] }] },
    ],
});
const parse = d => lineupParsePublishedSchedule(JSON.stringify(d));

// Returns exactly what fetchTonightsSchedule used to return from Reddit (postId, title, publishedAt, days), items intact.
const ok = parse(doc());
eq('top-level fields', { postId: ok.postId, title: ok.title, publishedAt: ok.publishedAt }, { postId: 't3_1p2q3r', title: 'Weekend Grindhouse Schedule - Fri 11/20 - Sun 11/22', publishedAt: '2026-11-18T12:00:00+00:00' });
eq('days keep day/date/section slugs', ok.days.map(d => [d.day, d.date, d.sections.map(s => s.slug)]), [['Friday', '2026-11-20', ['friday']], ['Saturday', '2026-11-21', ['late-show']]]);
eq('item keeps the parser fields, the string year and the new id/rating fields', ok.days[0].sections[0].items[0], doc().days[0].sections[0].items[0]);
eq('a yearless item stays yearless', ok.days[0].sections[0].items[1].year, null);
eq('only the four fields the lineup code reads are returned', Object.keys(ok).sort(), ['days', 'postId', 'publishedAt', 'title']);

// Failures behave like the old fetch: throw, so lineupEnsureSchedule keeps its cache / falls back.
throws('not JSON', () => lineupParsePublishedSchedule('<html>404</html>'), /JSON|published schedule/i);
throws('newer schema', () => parse({ ...doc(), schema: 2 }), /schema/);
throws('missing schema', () => { const d = doc(); delete d.schema; parse(d); }, /schema/);
throws('no days', () => parse({ ...doc(), days: [] }), /no days/);
throws('days not an array', () => parse({ ...doc(), days: 'x' }), /no days/);
throws('a day without sections', () => parse({ ...doc(), days: [{ day: 'Friday', date: '2026-11-20' }] }), /sections/);
throws('an empty body', () => lineupParsePublishedSchedule(''), /JSON|published schedule/i);

if (failed) { console.error(`\n${failed} failure(s)`); process.exit(1); }
console.log('OK: published-schedule parser');
