// scripts/test-imdb-link-preview.mjs
//
// Standalone assertions for the one PURE helper behind the imdb-link-preview
// module's link detection, in src/pc/modules/imdb-link-preview/index.js:
//
//   extractImdbTconst(url) -> a bare "tt…" id, or null
//
// No test harness in this repo (no package.json, no runner), so this is a
// plain node script:
//
//   node scripts/test-imdb-link-preview.mjs
//
// Exits non-zero on the first failing assertion; prints a one-line pass
// summary otherwise. src/pc/** files are script fragments concatenated
// inside one IIFE, not ES modules, so the file can't be imported -- instead
// this slices the function out between its "test marker" comments and evals
// it faithfully to how it runs in the bundle, same convention as
// scripts/test-fix-match-helpers.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(__dirname, '..', 'src', 'pc', 'modules', 'imdb-link-preview', 'index.js');
const src = fs.readFileSync(srcPath, 'utf8');

const START = '// ── test marker: extract-tconst slice start ──';
const END = '// ── test marker: extract-tconst slice end ──';
const start = src.indexOf(START);
const end = src.indexOf(END);
if (start === -1 || end === -1 || end < start) {
    console.error('FAIL: could not locate the "extract-tconst" test-marker slice in imdb-link-preview/index.js');
    process.exit(1);
}
const snippet = src.slice(start, end);

// eslint-disable-next-line no-new-func
const { extractImdbTconst } = new Function(
    `${snippet}\n;return { extractImdbTconst };`
)();

let failed = 0;
function eq(label, actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        console.error(`FAIL: ${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
        failed++;
    }
}

/* ---- extractImdbTconst --------------------------------------------------- */

eq('plain title URL', extractImdbTconst('https://www.imdb.com/title/tt0259308/'), 'tt0259308');
eq('without www.', extractImdbTconst('https://imdb.com/title/tt0259308/'), 'tt0259308');
eq('http (not https)', extractImdbTconst('http://www.imdb.com/title/tt0259308/'), 'tt0259308');
eq('http, no www.', extractImdbTconst('http://imdb.com/title/tt0259308/'), 'tt0259308');
eq('trailing path beyond id', extractImdbTconst('https://www.imdb.com/title/tt0259308/reference/'), 'tt0259308');
eq('trailing query beyond id', extractImdbTconst('https://www.imdb.com/title/tt0259308/?ref_=nv_sr_srsg_0'), 'tt0259308');
eq('8-digit tconst', extractImdbTconst('https://www.imdb.com/title/tt12345678/'), 'tt12345678');
eq('non-imdb domain -> null', extractImdbTconst('https://www.notimdb.com/title/tt0259308/'), null);
eq('imdb.com but not /title/ -> null', extractImdbTconst('https://www.imdb.com/name/nm0000123/'), null);
eq('imdb.com root -> null', extractImdbTconst('https://www.imdb.com/'), null);
eq('malformed/too-short id -> null', extractImdbTconst('https://www.imdb.com/title/tt123/'), null);
eq('no scheme -> null', extractImdbTconst('www.imdb.com/title/tt0259308/'), null);
eq('empty string -> null', extractImdbTconst(''), null);
eq('null input -> null', extractImdbTconst(null), null);
eq('undefined input -> null', extractImdbTconst(undefined), null);

if (failed) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
}
console.log('PASS: imdb-link-preview — extractImdbTconst, all assertions green');
