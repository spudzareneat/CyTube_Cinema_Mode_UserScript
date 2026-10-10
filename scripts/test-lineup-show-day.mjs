// scripts/test-lineup-show-day.mjs
//
// Standalone assertions for lineupPacificDateString in
// src/pc/modules/tonights-lineup/index.js: the lineup's "today" is the SHOW day,
// which rolls over at 6 AM Pacific rather than midnight, so a night's late films
// (running until ~5 AM) still count as that night.
//
//   node scripts/test-lineup-show-day.mjs
//
// Same slice-and-eval approach as the other scripts/test-*.mjs files.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pc', 'modules', 'tonights-lineup', 'index.js'), 'utf8');
const start = src.indexOf('// ── test marker: show-day slice start ──');
const end = src.indexOf('// ── test marker: show-day slice end ──');
if (start === -1 || end === -1 || end < start) {
    console.error('FAIL: could not locate the "show-day" slice in tonights-lineup/index.js');
    process.exit(1);
}
// eslint-disable-next-line no-new-func
const { lineupPacificDateString } = new Function(`${src.slice(start, end)}\n;return { lineupPacificDateString };`)();

let failed = 0;
function eq(label, actual, expected) {
    if (actual !== expected) { console.error(`FAIL: ${label} (got ${actual}, want ${expected})`); failed++; }
}

// October 2026 is PDT (UTC-7).
eq('Saturday 11 PM PDT is Saturday', lineupPacificDateString(new Date('2026-10-11T06:00:00Z')), '2026-10-10');
eq('Sunday 1 AM PDT is still Saturday', lineupPacificDateString(new Date('2026-10-11T08:00:00Z')), '2026-10-10');
eq('Sunday 5:59 AM PDT is still Saturday', lineupPacificDateString(new Date('2026-10-11T12:59:00Z')), '2026-10-10');
eq('Sunday 6:00 AM PDT is Sunday', lineupPacificDateString(new Date('2026-10-11T13:00:00Z')), '2026-10-11');
eq('Sunday noon PDT is Sunday', lineupPacificDateString(new Date('2026-10-11T19:00:00Z')), '2026-10-11');
// Month and year boundaries roll back correctly.
eq('Nov 1 3 AM PDT -> Oct 31', lineupPacificDateString(new Date('2026-11-01T10:00:00Z')), '2026-10-31');
eq('Jan 1 2 AM PST -> Dec 31', lineupPacificDateString(new Date('2027-01-01T10:00:00Z')), '2026-12-31');
// Hour 0 must not be rendered as "24" (hourCycle h23).
eq('midnight PDT -> previous day', lineupPacificDateString(new Date('2026-10-11T07:00:00Z')), '2026-10-10');

if (failed) { console.error(`${failed} assertion(s) failed`); process.exit(1); }
console.log('test-lineup-show-day: all assertions passed');
