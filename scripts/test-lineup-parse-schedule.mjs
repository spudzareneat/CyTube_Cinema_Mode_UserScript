// scripts/test-lineup-parse-schedule.mjs
//
// Standalone assertions for lineupParseSchedule in
// src/pc/modules/tonights-lineup/index.js -- the Reddit schedule post body parser.
// Fixtures are trimmed copies of real posts' decoded content HTML.
//
//   node scripts/test-lineup-parse-schedule.mjs
//
// Same slice-and-eval approach as the other scripts/test-*.mjs files.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pc', 'modules', 'tonights-lineup', 'index.js'), 'utf8');
const start = src.indexOf('// ── test marker: parse-schedule slice start ──');
const end = src.indexOf('// ── test marker: parse-schedule slice end ──');
if (start === -1 || end === -1 || end < start) {
    console.error('FAIL: could not locate the "parse-schedule" slice in tonights-lineup/index.js');
    process.exit(1);
}
// eslint-disable-next-line no-new-func
const EXPORTS = 'lineupParseSchedule, lineupParseListItems, lineupParseDateRange, lineupTitleVariants, lineupItemMatchesTitle';
const { lineupParseSchedule, lineupParseListItems, lineupParseDateRange, lineupTitleVariants, lineupItemMatchesTitle } =
    new Function(`${src.slice(start, end)}\n;return { ${EXPORTS} };`)();

let failed = 0;
function eq(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) { console.error(`FAIL: ${label}\n  got  ${a}\n  want ${e}`); failed++; }
}
const shape = (days) => days.map(d => ({ day: d.day, sections: d.sections.map(s => `${s.name}:${s.items.map(i => i.title).join('|')}`) }));

// Plain headers.
eq('plain day headers', shape(lineupParseSchedule(
    '<p><strong>Playing this weekend @</strong> x</p>' +
    '<p><strong>Friday</strong></p><p><strong>Funky Cheese Friday</strong></p><ul><li>A (1990)</li></ul>' +
    '<p><strong>Saturday</strong></p><p><strong>Psychedelic Saturday</strong></p><ul><li>B (1991)</li></ul>')),
    [{ day: 'Friday', sections: ['Funky Cheese Friday:A'] }, { day: 'Saturday', sections: ['Psychedelic Saturday:B'] }]);

// "==Friday==" decoration (2026-08-07).
eq('== decorated day header', shape(lineupParseSchedule(
    '<p><strong>==Friday==</strong></p><p><strong>Friday Night Freak Show</strong></p><ul><li>A (1990)</li></ul>')),
    [{ day: 'Friday', sections: ['Friday Night Freak Show:A'] }]);

// Halloween weekend 2026-10-30: themed day headers with extra words, and a section
// header with nested <em> inside the <strong>.
eq('themed day headers + nested-tag section', shape(lineupParseSchedule(
    '<p><strong>Playing this weekend @</strong> <a href="x">420Grindhouse</a>.</p> <p><em>Showtime starts each day @ 3pm EST/12pm PST.</em></p> ' +
    '<p><strong>==Halloween Eve Friday==</strong></p> <p><strong>Funky Cheese Friday</strong></p> <ul> <li>Ernest Scared Stupid (1991)</li> </ul> ' +
    '<p><strong>==Halloween Saturday==</strong></p> <p><strong>Saturday Prime Time Drive-In</strong></p> <ul> <li>The Exorcist (1973)</li> </ul> ' +
    '<p>**<strong><em>Halloween Raffle Winners Reveal</em></strong>**</p> <ul> <li>The Beyond (1981)</li> </ul> ' +
    '<p><strong>==Halloween Hangover Sunday==</strong></p> <p><strong>The Sunday Classics</strong></p> <ul> <li>Blood Feast (1963)</li> </ul>')),
    [
        { day: 'Friday', sections: ['Funky Cheese Friday:Ernest Scared Stupid'] },
        { day: 'Saturday', sections: ['Saturday Prime Time Drive-In:The Exorcist', 'Halloween Raffle Winners Reveal:The Beyond'] },
        { day: 'Sunday', sections: ['The Sunday Classics:Blood Feast'] },
    ]);

// Year typos and double-encoded '&' seen across the 2024-2026 posts; unbracketed numbers stay in titles.
const items = lineupParseListItems(['Jason X )2001)', 'Family Reunion [2003]', 'A Wrestling Christmas Miracle (2020',
    'Fit to Kill 1993)', 'Judge &amp; Jury (1996)', 'Equalizer 2000 (1987)', 'Class of 1984 (1982)',
    'The Chosen (1977) aka Holocaust 2000', 'Decampitated (1998))'].map(t => `<li>${t}</li>`).join(''));
eq('year typos + entities', items.map(i => [i.title, i.year]), [
    ['Jason X', '2001'], ['Family Reunion', '2003'], ['A Wrestling Christmas Miracle', '2020'], ['Fit to Kill', '1993'],
    ['Judge & Jury', '1996'], ['Equalizer 2000', '1987'], ['Class of 1984', '1982'], ['The Chosen', '1977'], ['Decampitated', '1998']]);
eq('aka keeps its number', items[7].akas, ['Holocaust 2000']);

// A list under a day with no section header of its own is kept, named for the day.
eq('unlabeled list under a day', shape(lineupParseSchedule(
    '<p><strong>Friday</strong></p><ul><li>A (1990)</li></ul><p><strong>Late</strong></p><ul><li>B (1991)</li></ul>')),
    [{ day: 'Friday', sections: ['Friday:A', 'Late:B'] }]);

// Event-label prefixes: lookup variants and now-playing matching.
eq('variants: label prefix', lineupTitleVariants('Basement Grindhouse - HauntedWeen'), ['HauntedWeen']);
eq('variants: label + subtitle', lineupTitleVariants('Monstervision – The Howling III: The Marsupials'), ['The Howling III: The Marsupials', 'The Howling III']);
eq('variants: none for plain / unspaced hyphen', [lineupTitleVariants('Carnival of Souls'), lineupTitleVariants('Psycho-Circus')], [[], []]);
eq('now-playing matches past the label', lineupItemMatchesTitle({ title: 'Basement Grindhouse - HauntedWeen', akas: [] }, 'HauntedWeen'), true);

// Every saved schedule post from the trivia generator repo (97 posts, Dec 2024 - Oct 2026)
// must parse with all three days, every non-empty <li> captured, and a year on each film.
// Read in place, not copied: set SCHEDULE_CORPUS_DIR, or keep grindhouse-popup-trivia
// checked out next to this repo. Refresh it there with scripts/fetch-schedule-corpus.js.
const corpusDir = process.env.SCHEDULE_CORPUS_DIR
    || path.join(__dirname, '..', '..', 'grindhouse-popup-trivia', 'test', 'fixtures', 'schedule-corpus');
const KNOWN_YEARLESS = new Set(['Bloodstone: Subspecies II']);   // the post itself gives no year
if (fs.existsSync(corpusDir)) {
    const files = fs.readdirSync(corpusDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
        const post = JSON.parse(fs.readFileSync(path.join(corpusDir, f), 'utf8'));
        if (!lineupParseDateRange(post.title, post.publishedAt)) { console.error(`FAIL: corpus ${f}: no date range`); failed++; continue; }
        const days = lineupParseSchedule(post.contentHtml);
        eq(`corpus ${f}: days`, days.map(d => d.day), ['Friday', 'Saturday', 'Sunday']);
        const liCount = [...post.contentHtml.matchAll(/<li>([\s\S]*?)<\/li>/g)].filter(m => m[1].replace(/<[^>]+>/g, '').trim()).length;
        const parsed = days.flatMap(d => d.sections.flatMap(s => s.items));
        eq(`corpus ${f}: items captured`, parsed.length, liCount);
        for (const it of parsed) if (!it.year && !KNOWN_YEARLESS.has(it.title)) { console.error(`FAIL: corpus ${f}: no year for "${it.title}"`); failed++; }
    }
    console.log(`corpus: ${files.length} posts checked`);
} else {
    console.log(`corpus: skipped (${corpusDir} not found)`);
}

if (failed) { console.error(`\n${failed} failure(s)`); process.exit(1); }
console.log('OK: lineupParseSchedule');
