// scripts/test-movie-identity.mjs
//
// Standalone assertions for parseMovieFilename() in
// src/pc/core/01-movie-identity.js. There is no test harness in this repo
// (no package.json, no runner), so this is a plain node script:
//
//   node scripts/test-movie-identity.mjs
//
// Exits non-zero on the first failing suite; prints a one-line pass summary.
//
// src/pc/** files are script fragments concatenated inside one IIFE -- not
// ES modules -- so they can't be imported. Instead the whole fragment is
// read as text and evaluated as a function body that returns the pure
// parser. The fragment references no shared globals (only Date/RegExp), so
// this is faithful to how it runs in the assembled bundle.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(__dirname, '..', 'src', 'pc', 'core', '01-movie-identity.js');
const src = fs.readFileSync(srcPath, 'utf8');

// eslint-disable-next-line no-new-func
const { parseMovieFilename } = new Function(`${src}\n;return { parseMovieFilename };`)();

// Cases from task-1-brief.md, verbatim, plus edge cases exercising each of
// the three changes (digit-bracket repair / bare-year fallback / token strip).
const cases = [
    // --- brief table ---
    { in: 'Collision.Course.1[989].mp4', title: 'Collision Course', year: '1989' },
    { in: 'Collision.Course.1989.mp4', title: 'Collision Course', year: '1989' },
    { in: 'White.Fire.[1984].mkv', title: 'White Fire', year: '1984' },
    { in: '2001.A.Space.Odyssey.1968.1080p.BluRay.mp4', title: '2001 A Space Odyssey', year: '1968' },
    { in: 'Blade.Runner.1982.mkv', title: 'Blade Runner', year: '1982' },
    { in: 'Show.Name.(1984).S01E05.mkv', title: 'Show Name', year: '1984', season: 1, episode: 5 },
    { in: 'The.Thing.[720p].mkv', title: 'The Thing', year: null },

    // --- digit-bracket repair variants from the brief prose ---
    { in: 'White.Fire.[19]84.mkv', title: 'White Fire', year: '1984' },
    { in: 'Movie.Title.19(89).mkv', title: 'Movie Title', year: '1989' },
    { in: 'Some.Film.199[0].mkv', title: 'Some Film', year: '1990' },
    // a bracketed non-year tag with digits must NOT be collapsed or read as a year
    { in: 'The.Thing.[480p].mkv', title: 'The Thing', year: null },

    // --- bare-year fallback edge cases ---
    // leading number is title, not year (no trailing year present)
    { in: '2001.A.Space.Odyssey.mkv', title: '2001 A Space Odyssey', year: null },
    // last plausible year wins when several are present
    { in: 'Movie.1999.Remake.2015.mkv', title: 'Movie 1999 Remake', year: '2015' },
    // implausible far-future 4-digit run is not a year
    { in: 'Area.5150.mkv', title: 'Area 5150', year: null },

    // --- titles that legitimately END in a year ---------------------------
    // These pin the parse as the bare-year fallback actually produces it: the
    // trailing year is indistinguishable from a release-year tag at the
    // filename level, so "Class of 1984" parses to the TRUNCATED title
    // "Class of" plus year "1984". That is the intended parse -- reverting it
    // would break "Blade.Runner.1982" and friends above, which are far more
    // common. What makes these still resolve is a recovery step one layer up,
    // in the SEARCH: imdbSearchTitle() re-runs MainSearch once with the year
    // folded back onto the term (`${title} ${year}`) whenever the tier walk
    // finds no title-matching candidate at all, so IMDb's "Class of 1984" is
    // compared against "Class of 1984" (Dice 1.0) instead of against
    // "Class of" (0.667, under the 0.7 floor -> total match failure). That
    // retry lives in movie-title-links/index.js and is not covered here --
    // this file only exercises the pure parser.
    { in: 'Class.of.1984.mkv',   title: 'Class of',   year: '1984' },
    { in: 'Airport.1975.mkv',    title: 'Airport',    year: '1975' },
    { in: 'Death.Race.2000.mkv', title: 'Death Race', year: '2000' },
    { in: 'Summer.of.1984.mkv',  title: 'Summer of',  year: '1984' },

    // --- quality/codec token strip (no year to cut at) ---
    { in: 'The.Thing.720p.x264.mkv', title: 'The Thing', year: null },
    { in: 'Robo.Vampire.WEB-DL.h265.HEVC.mkv', title: 'Robo Vampire', year: null },

    // --- guards preserved ---
    { in: 'R.O.T.O.R.1987.mkv', title: 'R.O.T.O.R.', year: '1987' },
];

let failures = 0;
for (const c of cases) {
    const got = parseMovieFilename(c.in);
    const expected = { title: c.title, year: c.year };
    if ('season' in c) expected.season = c.season;
    if ('episode' in c) expected.episode = c.episode;

    for (const key of Object.keys(expected)) {
        if (got[key] !== expected[key]) {
            failures++;
            console.error(
                `FAIL  ${c.in}\n` +
                `      ${key}: expected ${JSON.stringify(expected[key])}, got ${JSON.stringify(got[key])}`
            );
        }
    }
}

if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed across ${cases.length} cases`);
    process.exit(1);
}
console.log(`parseMovieFilename: all ${cases.length} cases passed`);
