// scripts/test-lineup-published-info.mjs
//
// Standalone assertions for lineupInfoFromItem in src/pc/modules/tonights-lineup/index.js -- the file-first
// path of Coming Attractions: a published schedule item carries an `info` object (everything the cards show,
// looked up once by the grindhouse-popup-trivia generator), and lineupLookupItem returns it instead of running
// lookupMovie in every viewer's browser. Items without usable info fall back to the lookup chain.
//
//   node scripts/test-lineup-published-info.mjs
//
// Same slice-and-eval approach as the other scripts/test-*.mjs files.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pc', 'modules', 'tonights-lineup', 'index.js'), 'utf8');
const start = src.indexOf('// ── test marker: published-info slice start ──');
const end = src.indexOf('// ── test marker: published-info slice end ──');
if (start === -1 || end === -1 || end < start) {
    console.error('FAIL: could not locate the "published-info" slice in tonights-lineup/index.js');
    process.exit(1);
}
// eslint-disable-next-line no-new-func
const { lineupInfoFromItem } = new Function(`${src.slice(start, end)}\n;return { lineupInfoFromItem };`)();

let failed = 0;
function eq(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) { console.error(`FAIL: ${label}\n  got  ${a}\n  want ${e}`); failed++; }
}

const info = () => ({
    imdbId: 'tt0103327', cleanTitle: 'Zeiram', cleanYear: 1991, rating: 6.4, runtime: 85, genres: ['Action', 'Sci-Fi'],
    poster: 'https://image.tmdb.org/t/p/w342/p.jpg', backdrop: 'https://image.tmdb.org/t/p/w780/b.jpg', overview: 'A bounty hunter.',
    certificate: 'Not Rated', parentalGuide: [{ category: 'Violence & Gore', severity: 'Moderate' }],
    cast: [{ name: 'Star', nconst: 'nm1', character: 'Iria', photo: 'https://m.media-amazon.com/images/M/a._V1_UX120_.jpg', knownFor: null }],
    killCount: 12, links: { imdb: 'https://www.imdb.com/title/tt0103327/', letterboxd: 'https://letterboxd.com/imdb/tt0103327', wiki: 'https://en.wikipedia.org/wiki/Zeiram' },
});
const item = (over = {}) => ({ title: 'Zeiram', year: '1991', display: 'Zeiram (1991)', akas: [], imdbId: 'tt0103327', imdbRating: 6.4, imdbVotes: 3100, info: info(), ...over });

// A complete info becomes a lookupMovie-shaped result: every field lineupBuildItem reads survives, resolved is true.
const out = lineupInfoFromItem(item());
for (const k of ['cleanTitle', 'cleanYear', 'poster', 'backdrop', 'overview', 'rating', 'runtime', 'genres', 'parentalGuide', 'certificate', 'cast', 'killCount', 'imdbId', 'links']) {
    eq(`field ${k} survives`, out[k], info()[k]);
}
eq('resolved is true', out.resolved, true);

// imdbId falls back to the item's own id when info lacks one.
eq('imdbId from the item when info has none', lineupInfoFromItem(item({ info: { ...info(), imdbId: undefined } })).imdbId, 'tt0103327');

// Info that belongs to a DIFFERENT film than the item (stale or hand-edited file) is never shown: fall back to the lookup.
eq('mismatched ids fall back', lineupInfoFromItem(item({ imdbId: 'tt9999999' })), null);
eq('matching ids are served', lineupInfoFromItem(item({ imdbId: 'tt0103327' })) !== null, true);
eq('an item without an id still uses its info', lineupInfoFromItem(item({ imdbId: null })) !== null, true);
eq('partial info is still served (the generator retries it; a card without a cast beats a slow lookup)', lineupInfoFromItem(item({ info: { ...info(), partial: true, cast: null } })) !== null, true);

// No usable info -> null, so lineupLookupItem falls back to the lookup chain.
eq('no info key', lineupInfoFromItem({ title: 'Tenebre', year: '1984' }), null);
eq('info null', lineupInfoFromItem(item({ info: null })), null);
eq('info without cleanTitle', lineupInfoFromItem(item({ info: { ...info(), cleanTitle: null } })), null);
eq('info empty object', lineupInfoFromItem(item({ info: {} })), null);
eq('null item', lineupInfoFromItem(null), null);

// The published item is not mutated (it lives in the cached schedule).
const it = item();
const before = JSON.stringify(it);
const mapped = lineupInfoFromItem(it);
mapped.genres.push('X'); mapped.resolved = false;
eq('input item untouched', JSON.stringify(it), before);

if (failed) { console.error(`\n${failed} failure(s)`); process.exit(1); }
console.log('OK: published-info mapping');
