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
const { lineupParseSchedule } = new Function(`${src.slice(start, end)}\n;return { lineupParseSchedule };`)();

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

if (failed) { console.error(`\n${failed} failure(s)`); process.exit(1); }
console.log('OK: lineupParseSchedule');
