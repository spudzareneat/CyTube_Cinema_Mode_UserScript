// scripts/test-lineup-queue-times.mjs
//
// Standalone assertions for the Up Next bot-queue timing helpers in
// src/pc/modules/tonights-lineup/index.js:
//   - lineupQueueTimesFor: walks the bot's real queue (exact durations of every
//     bumper/commercial/feature) and pins each queued schedule film to a real
//     start/end instant.
//   - lineupMergeQueueEstimates: overlays those onto the guess-based estimates,
//     re-walking the guess model from the last queued film's real end.
//
//   node scripts/test-lineup-queue-times.mjs
//
// Same slice-and-eval approach as the other scripts/test-*.mjs files: the
// helpers sit between "test marker" comments and reference nothing but their
// arguments.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(__dirname, '..', 'src', 'pc', 'modules', 'tonights-lineup', 'index.js');
const src = fs.readFileSync(srcPath, 'utf8');

const start = src.indexOf('// ── test marker: queue-times slice start ──');
const end = src.indexOf('// ── test marker: queue-times slice end ──');
if (start === -1 || end === -1 || end < start) {
    console.error('FAIL: could not locate the "queue-times" slice in tonights-lineup/index.js');
    process.exit(1);
}
const snippet = src.slice(start, end);
// eslint-disable-next-line no-new-func
const { lineupQueueTimesFor, lineupMergeQueueEstimates } =
    new Function(`${snippet}\n;return { lineupQueueTimesFor, lineupMergeQueueEstimates };`)();

let failed = 0;
function eq(label, actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        console.error(`FAIL: ${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
        failed++;
    }
}

// Minimal stand-ins for parseMovieFilename + lineupItemMatchesTitle.
const titleOf = (raw) => raw.replace(/\.(mp4|mkv)$/i, '').replace(/[.\s]*[[(]\d{4}[\])].*$/, '').replace(/\./g, ' ').trim();
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const matches = (item, title) => norm(item.title) === norm(title)
    || (item.akas || []).some(a => norm(a) === norm(title));
const MIN_FEATURE = 600;

const items = [
    { title: 'Voyage of the Rock Aliens' },
    { title: 'Ms. 45' },
    { title: 'Hellraiser' },
    { title: 'Castle Freak' },
    { title: 'Not In Queue Tonight' },
    { title: 'Last One' },
];
const queue = {
    anchorMs: 1_000_000,
    remainingSec: 100,
    playlist: [
        { title: 'Intermission 03', seconds: 113 },
        { title: 'Voyage.Of.The.Rock.Aliens.[1984].mp4', seconds: 5730 },
        { title: 'Ms. 45 | Original Trailer', seconds: 104 },
        { title: 'Hellraiser (1987) Trailer', seconds: 90 },   // trailer: too short to be the feature
        { title: 'Bumper', seconds: 50 },
        { title: 'Ms..45.[1981].mp4', seconds: 4851 },
        { title: 'Bumper', seconds: 119 },
        { title: 'HellRaiser.[1987].mp4', seconds: 5603 },
    ],
};

// --- lineupQueueTimesFor ---
const qt = lineupQueueTimesFor(items, queue, titleOf, matches, MIN_FEATURE);
const voyageStart = 1_000_000 + 100_000 + 113_000;
eq('voyage start = anchor + remaining + intermission', qt[0] && qt[0].startMs, voyageStart);
eq('voyage end = start + its real duration', qt[0] && qt[0].endMs, voyageStart + 5_730_000);
const ms45Start = voyageStart + 5_730_000 + 104_000 + 90_000 + 50_000;
eq('ms45 start counts the trailers as filler', qt[1] && qt[1].startMs, ms45Start);
eq('hellraiser matched by the feature, not the 90s trailer', qt[2] && qt[2].startMs, ms45Start + 4_851_000 + 119_000);
eq('castle freak not queued -> null', qt[3], null);
eq('no queue -> all null', lineupQueueTimesFor(items, null, titleOf, matches, MIN_FEATURE), items.map(() => null));
eq('missing remainingSec treated as 0',
    lineupQueueTimesFor(items, { anchorMs: 0, playlist: [{ title: 'Voyage.Of.The.Rock.Aliens.[1984].mp4', seconds: 5730 }] }, titleOf, matches, MIN_FEATURE)[0],
    { startMs: 0, endMs: 5_730_000 });
// A film queued twice (e.g. a rerun) only claims the first schedule slot once; the
// second showing takes the next unclaimed slot with the same title, if any.
const twice = lineupQueueTimesFor([{ title: 'Ms. 45' }, { title: 'Ms. 45' }],
    { anchorMs: 0, remainingSec: 0, playlist: [{ title: 'Ms..45.[1981].mp4', seconds: 1000 }, { title: 'Ms..45.[1981].mp4', seconds: 1000 }] },
    titleOf, matches, MIN_FEATURE);
eq('rerun fills slots in order', twice.map(t => t && t.startMs), [0, 1_000_000]);

// --- lineupMergeQueueEstimates ---
const blank = { played: false, isNowPlaying: false, etaMs: null, precision: 'approx' };
const estimates = [
    { ...blank, isNowPlaying: false, etaMs: 5, precision: 'exact' },
    { ...blank, played: true },             // stale "played" guess; queue says it's upcoming
    { ...blank, etaMs: 7 },
    { ...blank, etaMs: 8 },
    { ...blank, etaMs: 9 },
    { ...blank },
];
const runtimesMin = [95, 81, 93, 95, 100, null];
const gapMsFor = () => 10 * 60000;
const merged = lineupMergeQueueEstimates(estimates, qt, { runtimesMin, gapMsFor, maxAhead: 4 });
eq('queued film gets the queue time + queue precision', [merged[0].etaMs, merged[0].precision], [qt[0].startMs, 'queue']);
eq('queue overrides a stale played guess', [merged[1].played, merged[1].etaMs], [false, qt[1].startMs]);
eq('hellraiser queued', merged[2].etaMs, qt[2].startMs);
const castleEta = qt[2].endMs + 10 * 60000;
eq('first film past the queue walks from last queued real end + gap', [merged[3].etaMs, merged[3].precision], [castleEta, 'approx']);
const nextEta = castleEta + 95 * 60000 + 10 * 60000;
eq('walk continues with runtime + gap', merged[4].etaMs, nextEta);
eq('walk continues to film with unknown runtime', merged[5].etaMs, nextEta + 100 * 60000 + 10 * 60000);

// Now-playing stays untouched; a non-queued film sandwiched before a queued one is
// unknown (blank), not a contradictory guess.
const est2 = [{ ...blank, isNowPlaying: true }, { ...blank, etaMs: 1 }, { ...blank, etaMs: 2 }];
const qt2 = [null, null, { startMs: 50, endMs: 60 }];
const m2 = lineupMergeQueueEstimates(est2, qt2, { runtimesMin: [90, 90, 90], gapMsFor, maxAhead: 4 });
eq('now playing untouched', m2[0], est2[0]);
eq('unqueued film before a queued one is blanked', m2[1].etaMs, null);
eq('queued film after it', m2[2].etaMs, 50);

// Nothing queued for this day -> estimates returned unchanged (e.g. Sunday viewed on Friday).
eq('no queue matches -> unchanged', lineupMergeQueueEstimates(estimates, items.map(() => null), { runtimesMin, gapMsFor, maxAhead: 4 }), estimates);

// Unknown runtime past the queue latches the walk off, like the base model.
const m3 = lineupMergeQueueEstimates(
    [{ ...blank }, { ...blank }, { ...blank }, { ...blank }],
    [{ startMs: 0, endMs: 100 }, null, null, null],
    { runtimesMin: [90, null, 90, 90], gapMsFor, maxAhead: 4 });
eq('unknown runtime: that film gets a time, later ones blank', m3.map(e => e.etaMs), [0, 100 + 600000, null, null]);

// maxAhead caps how many guessed films past the queue get a time.
const m4 = lineupMergeQueueEstimates(
    [{ ...blank }, { ...blank }, { ...blank }, { ...blank }],
    [{ startMs: 0, endMs: 0 }, null, null, null],
    { runtimesMin: [1, 1, 1, 1], gapMsFor: () => 0, maxAhead: 2 });
eq('maxAhead cap', m4.map(e => e.etaMs), [0, 0, 60000, null]);

if (failed) { console.error(`${failed} assertion(s) failed`); process.exit(1); }
console.log('test-lineup-queue-times: all assertions passed');
