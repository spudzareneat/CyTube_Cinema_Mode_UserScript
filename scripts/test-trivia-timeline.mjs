// scripts/test-trivia-timeline.mjs
//
// Assertions for the pure curated-timeline helpers in
// src/pc/modules/trivia-popup/index.js (tpValidateCurated, tpRankAllowed,
// tpDueFact). src/pc/** files are IIFE fragments, not ES modules, so this
// slices the code between its test markers and evals it -- same convention
// as scripts/test-imdb-link-preview.mjs.
//
//   node scripts/test-trivia-timeline.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pc', 'modules', 'trivia-popup', 'index.js'), 'utf8');

const START = '// ── test marker: curated-timeline slice start ──';
const END = '// ── test marker: curated-timeline slice end ──';
const s = src.indexOf(START), e = src.indexOf(END);
if (s === -1 || e === -1 || e < s) {
    console.error('FAIL: could not locate the "curated-timeline" test-marker slice in trivia-popup/index.js');
    process.exit(1);
}
// eslint-disable-next-line no-new-func
const { tpValidateCurated, tpRankAllowed, tpDueFact, tpCatchUpFact, TP_TIMELINE_WINDOW_S, tpValidateDriveIn, tpDriveInAction, tpStarFills, TP_DRIVEIN_SEEN_KEY } = new Function(
    `${src.slice(s, e)}\n;return { tpValidateCurated, tpRankAllowed, tpDueFact, tpCatchUpFact, TP_TIMELINE_WINDOW_S, tpValidateDriveIn, tpDriveInAction, tpStarFills, TP_DRIVEIN_SEEN_KEY };`
)();

let failed = 0;
function eq(label, actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        console.error(`FAIL: ${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
        failed++;
    }
}

const doc = (facts, extra = {}) => ({ schema: 1, imdbId: 'tt0055830', title: 'X', year: 1962, runtimeSec: 4680, facts, ...extra });
const F = (t, text, rank = 1, icon = 'reel', byline = null) => ({ t, rank, anchor: 'spread', text, icon, byline, source: { type: 'imdb' } });

/* ---- tpValidateCurated ---------------------------------------------------- */

eq('valid doc -> sorted normalized facts',
    tpValidateCurated(doc([F(300, 'b'), F(120, 'a', 2, 'skull', 'Joe Bob')]), 'tt0055830'),
    [{ t: 120, rank: 2, anchor: 'spread', text: 'a', icon: 'skull', byline: 'Joe Bob' }, { t: 300, rank: 1, anchor: 'spread', text: 'b', icon: 'reel', byline: null }]);
eq('headshot image kept only from the IMDb image CDN',
    tpValidateCurated(doc([
        { ...F(100, 'ok'), image: 'https://m.media-amazon.com/images/M/abc@._V1_QL75_UX120_CR0,0,120,120_.jpg' },
        { ...F(200, 'evil'), image: 'https://evil.example/images/x.jpg' },
        { ...F(300, 'sneaky'), image: 'https://m.media-amazon.com.evil.example/images/x.jpg' },
        { ...F(400, 'js'), image: 'javascript:alert(1)' },
        { ...F(500, 'none') },
    ]), 'tt0055830').map(f => f.image),
    ['https://m.media-amazon.com/images/M/abc@._V1_QL75_UX120_CR0,0,120,120_.jpg', null, null, null, null]);
eq('source url kept only when plain http(s)',
    tpValidateCurated(doc([
        { ...F(100, 'web'), source: { type: 'web', url: 'https://www.denofgeek.com/movies/carnival-of-souls/' } },
        { ...F(200, 'http'), source: { type: 'web', url: 'http://example.com/a' } },
        { ...F(300, 'js'), source: { type: 'web', url: 'javascript:alert(1)' } },
        { ...F(400, 'quote'), source: { type: 'web', url: 'https://x.com/a"onmouseover="alert(1)' } },
        { ...F(500, 'imdb') },
    ]), 'tt0055830').map(f => f.sourceUrl),
    ['https://www.denofgeek.com/movies/carnival-of-souls/', 'http://example.com/a', undefined, undefined, undefined]);
eq('anchor scene kept, anything else -> spread',
    tpValidateCurated(doc([{ ...F(100, 'x'), anchor: 'scene' }, { ...F(200, 'y'), anchor: 'weird' }]), 'tt0055830').map(f => f.anchor), ['scene', 'spread']);
eq('null doc -> null', tpValidateCurated(null, 'tt0055830'), null);
eq('wrong schema -> null', tpValidateCurated(doc([F(1, 'a')], { schema: 2 }), 'tt0055830'), null);
eq('id mismatch -> null', tpValidateCurated(doc([F(100, 'a')]), 'tt9999999'), null);
eq('expectedId null skips id check (dev override)', tpValidateCurated(doc([F(100, 'a')]), null).length, 1);
eq('facts not an array -> null', tpValidateCurated(doc('nope'), 'tt0055830'), null);
eq('empty facts -> null', tpValidateCurated(doc([]), 'tt0055830'), null);
eq('drops string t / negative t / NaN t, keeps good',
    tpValidateCurated(doc([F('100', 'x'), F(-5, 'y'), F(NaN, 'z'), F(200, 'ok')]), 'tt0055830').map(f => f.text), ['ok']);
eq('drops empty and over-280 text, trims text',
    tpValidateCurated(doc([F(100, '   '), F(110, 'x'.repeat(281)), F(120, '  hi  ')]), 'tt0055830').map(f => f.text), ['hi']);
eq('all facts invalid -> null', tpValidateCurated(doc([F('1', 'a'), F(2, '')]), 'tt0055830'), null);
eq('out-of-range rank -> 2', tpValidateCurated(doc([F(100, 'a', 7)]), 'tt0055830')[0].rank, 2);
eq('non-string icon -> null', tpValidateCurated(doc([F(100, 'a', 1, 42)]), 'tt0055830')[0].icon, null);
eq('blank byline -> null', tpValidateCurated(doc([F(100, 'a', 1, 'reel', '  ')]), 'tt0055830')[0].byline, null);
eq('null entries in facts skipped', tpValidateCurated(doc([null, F(100, 'a')]), 'tt0055830').length, 1);

/* ---- tpRankAllowed --------------------------------------------------------- */

eq('frequent allows 3', tpRankAllowed(3, 'frequent'), true);
eq('occasional allows 2', tpRankAllowed(2, 'occasional'), true);
eq('occasional blocks 3', tpRankAllowed(3, 'occasional'), false);
eq('rare allows 1', tpRankAllowed(1, 'rare'), true);
eq('rare blocks 2', tpRankAllowed(2, 'rare'), false);
eq('unknown tier behaves as occasional', [tpRankAllowed(2, ''), tpRankAllowed(3, 'bogus')], [true, false]);

/* ---- tpDueFact ------------------------------------------------------------- */

const facts = tpValidateCurated(doc([F(100, 'r1'), F(200, 'r3', 3), F(300, 'r2', 2), F(400, 'r1b')]), 'tt0055830');
eq('window constant is 20', TP_TIMELINE_WINDOW_S, 20);
eq('before first fact -> null', tpDueFact(facts, 99, 'frequent', []), null);
eq('exactly at t -> due', tpDueFact(facts, 100, 'frequent', [])?.text, 'r1');
eq('inside window -> due', tpDueFact(facts, 119, 'frequent', [])?.text, 'r1');
eq('edge of window (t+20) -> due', tpDueFact(facts, 120, 'frequent', [])?.text, 'r1');
eq('late join past window -> null (no burst)', tpDueFact(facts, 150, 'frequent', []), null);
eq('seek far ahead lands in later window -> only that fact', tpDueFact(facts, 405, 'frequent', [])?.text, 'r1b');
eq('rank filter: rare skips rank-3 fact', tpDueFact(facts, 205, 'rare', []), null);
eq('rank filter: frequent shows rank-3 fact', tpDueFact(facts, 205, 'frequent', [])?.text, 'r3');
eq('seen (reload inside window) -> null', tpDueFact(facts, 105, 'frequent', ['r1']), null);
eq('NaN currentTime -> null', tpDueFact(facts, NaN, 'frequent', []), null);
eq('null facts -> null', tpDueFact(null, 100, 'frequent', []), null);

/* ---- tpCatchUpFact (late join / seek-ahead catch-up) ---------------------- */

const S = (t, text, rank = 1) => ({ ...F(t, text, rank), anchor: 'scene' });
const cu = tpValidateCurated(doc([F(100, 'a'), S(200, 'scene-only'), F(300, 'b', 2), F(400, 'c'), F(1000, 'future')]), 'tt0055830');
eq('late join: best-ranked earliest missed spread fact', tpCatchUpFact(cu, 600, 'frequent', [], 100)?.text, 'a');
eq('already-seen missed fact skipped -> next best', tpCatchUpFact(cu, 600, 'frequent', ['a'], 100)?.text, 'c');
eq('rank 1 beats an earlier rank 2', tpCatchUpFact(cu, 600, 'frequent', ['a', 'c'], 100)?.text, 'b');
eq('scene facts never caught up', tpCatchUpFact(cu, 600, 'frequent', ['a', 'b', 'c'], 100), null);
eq('too soon after the last bubble -> null', tpCatchUpFact(cu, 600, 'frequent', [], 30), null);
eq('timed fact less than 60s away -> null (keep the gap clear)', tpCatchUpFact(cu, 950, 'frequent', [], 100), null);
eq('a fact still inside its due window is not "missed"', tpCatchUpFact(cu, 110, 'frequent', [], 100), null);
eq('rank filter applies to catch-ups', tpCatchUpFact(cu, 600, 'rare', ['a', 'c'], 100), null);
eq('upcoming timed fact filtered out by rank does not block catch-up',
    tpCatchUpFact(tpValidateCurated(doc([F(100, 'a'), F(620, 'r3', 3)]), 'tt0055830'), 600, 'rare', [], 100)?.text, 'a');
eq('upcoming timed fact already seen does not block catch-up',
    tpCatchUpFact(tpValidateCurated(doc([F(100, 'a'), F(620, 'z')]), 'tt0055830'), 600, 'frequent', ['z'], 100)?.text, 'a');
eq('nothing missed at movie start -> null', tpCatchUpFact(cu, 50, 'frequent', [], 100), null);
eq('NaN currentTime -> null', tpCatchUpFact(cu, NaN, 'frequent', [], 100), null);
eq('null facts -> null', tpCatchUpFact(null, 600, 'frequent', [], 100), null);

/* ---- Drive-In Totals card --------------------------------------------- */

const DI = { t: 15, lines: ['19 Dead Bodies', 'Zombie Fu'], stars: 4, says: 'Joe Bob says check it out.' };
eq('driveIn: valid card normalized',
    tpValidateDriveIn(doc([F(100, 'a')], { driveIn: { ...DI, lines: [' 19 Dead Bodies ', '', 42, 'Zombie Fu'], stars: 3.7 } })),
    { t: 15, lines: ['19 Dead Bodies', 'Zombie Fu'], stars: 3.5, says: 'Joe Bob says check it out.' });
eq('driveIn: missing -> null', tpValidateDriveIn(doc([F(100, 'a')])), null);
eq('driveIn: bad t -> null', tpValidateDriveIn(doc([], { driveIn: { ...DI, t: 'soon' } })), null);
eq('driveIn: negative t -> null', tpValidateDriveIn(doc([], { driveIn: { ...DI, t: -1 } })), null);
eq('driveIn: no usable lines -> null', tpValidateDriveIn(doc([], { driveIn: { ...DI, lines: ['', '  '] } })), null);
eq('driveIn: lines not an array -> null', tpValidateDriveIn(doc([], { driveIn: { ...DI, lines: '19 Dead Bodies' } })), null);
eq('driveIn: stars clamped; junk stars -> null, junk says -> ""',
    [tpValidateDriveIn(doc([], { driveIn: { ...DI, stars: 9 } })).stars, tpValidateDriveIn(doc([], { driveIn: { ...DI, stars: 'four', says: 7 } }))],
    [4, { t: 15, lines: DI.lines, stars: null, says: '' }]);
eq('driveIn: max 60 lines, over-long lines dropped',
    [tpValidateDriveIn(doc([], { driveIn: { ...DI, lines: Array(80).fill('x') } })).lines.length,
     tpValidateDriveIn(doc([], { driveIn: { ...DI, lines: ['x'.repeat(301), 'ok'] } })).lines],
    [60, ['ok']]);
eq('driveIn field does not change the facts',
    tpValidateCurated(doc([F(100, 'a')], { driveIn: DI }), 'tt0055830'), tpValidateCurated(doc([F(100, 'a')]), 'tt0055830'));

eq('card: not before t', tpDriveInAction(DI, 14, [], 999), null);
eq('card: due at t and through the window',
    [tpDriveInAction(DI, 15, [], 0), tpDriveInAction(DI, 15 + TP_TIMELINE_WINDOW_S, [], 0)], ['due', 'due']);
eq('card: late joiner gets it 15s after joining (or after the last pop), not before',
    [tpDriveInAction(DI, 600, [], 14), tpDriveInAction(DI, 600, [], 15)], [null, 'catchup']);
eq('card: seen -> never', tpDriveInAction(DI, 15, [TP_DRIVEIN_SEEN_KEY], 999), null);
eq('card: none -> null', tpDriveInAction(null, 15, [], 999), null);
eq('card: bad currentTime -> null', tpDriveInAction(DI, NaN, [], 999), null);
eq('stars: fill per slot',
    [tpStarFills(4), tpStarFills(3.5), tpStarFills(0), tpStarFills(1.5)],
    [[1, 1, 1, 1], [1, 1, 1, 0.5], [0, 0, 0, 0], [1, 0.5, 0, 0]]);

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('PASS: trivia-popup — curated timeline helpers, all assertions green');
