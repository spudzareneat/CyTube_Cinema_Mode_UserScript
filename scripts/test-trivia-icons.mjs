// scripts/test-trivia-icons.mjs
//
// Assertions for the named Pop-up Video icon map in
// src/pc/modules/trivia-popup/index.js. The key set is a contract shared
// with the generator repo (spec: docs/superpowers/specs/2026-10-03-
// curated-popup-trivia-design.md), so it is pinned exactly here.
//
//   node scripts/test-trivia-icons.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pc', 'modules', 'trivia-popup', 'index.js'), 'utf8');

const START = '// ── test marker: icon-map slice start ──';
const END = '// ── test marker: icon-map slice end ──';
const s = src.indexOf(START), e = src.indexOf(END);
if (s === -1 || e === -1 || e < s) {
    console.error('FAIL: could not locate the "icon-map" test-marker slice in trivia-popup/index.js');
    process.exit(1);
}
// eslint-disable-next-line no-new-func
const { TP_ICON_SVGS, TP_ICON_KEYS, tpPickIconKey } = new Function(
    `${src.slice(s, e)}\n;return { TP_ICON_SVGS, TP_ICON_KEYS, tpPickIconKey };`
)();

let failed = 0;
function eq(label, actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        console.error(`FAIL: ${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
        failed++;
    }
}

const EXPECTED = ['skull', 'tombstone', 'reel', 'saucer', 'alien', 'rocket', 'robot', 'radioactive',
    'explosion', 'crosshair', 'knuckles', 'disco', 'boombox', 'sunglasses',
    'joebob', 'money', 'camera', 'star', 'link', 'mic', 'censor', 'trophy'];

eq('exact key set, in order', TP_ICON_KEYS, EXPECTED);
eq('TP_ICON_KEYS mirrors TP_ICON_SVGS', TP_ICON_KEYS, Object.keys(TP_ICON_SVGS));
for (const k of EXPECTED) {
    const svg = TP_ICON_SVGS[k] || '';
    eq(`${k}: has drawable markup`, /<(path|circle|rect|ellipse|polygon|polyline|line|text)\b/.test(svg), true);
    eq(`${k}: no stray <svg> wrapper (showTriviaBubble supplies it)`, /<svg\b/.test(svg), false);
}
eq('known key kept', tpPickIconKey('camera', EXPECTED, () => 0.99), 'camera');
eq('unknown key -> random (rnd 0 -> first)', tpPickIconKey('bogus', EXPECTED, () => 0), 'skull');
eq('null key -> random (rnd .999 -> last)', tpPickIconKey(null, EXPECTED, () => 0.999), 'trophy');

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('PASS: trivia-popup — icon map, all assertions green');
