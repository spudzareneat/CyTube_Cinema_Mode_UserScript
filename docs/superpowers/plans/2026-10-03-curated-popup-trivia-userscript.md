# Curated Pop-up Trivia — userscript integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `trivia-popup` module play curated, cited, named-icon facts on a fixed playback timeline (synced across viewers) when a curated JSON exists for the current movie, falling back to today's IMDb random-gap behavior otherwise.

**Architecture:** All changes live in `src/pc/modules/trivia-popup/index.js`. Pure logic (validate curated doc, rank filter, "which fact is due now", icon pick) sits in two test-marker slices that plain-node test scripts slice out and `eval`, the repo's established pattern. A GM_xmlhttpRequest loader fetches `data/<imdbId>.json` from the (not-yet-created) generator repo; a localStorage dev override lets the user live-test with a pasted sample before that repo exists. The existing 3 s heartbeat drives the timeline.

**Tech Stack:** Tampermonkey userscript fragments concatenated into one IIFE (no ES modules, no npm); Node built-ins only for tests/build.

**Spec:** `docs/superpowers/specs/2026-10-03-curated-popup-trivia-design.md` (sections 1 and 2 — this plan is sub-project 1 of 3).

## Global Constraints

- Work on branch `feat/curated-popup-trivia` in a git worktree off `main` (main's working tree has unrelated uncommitted WIP — never touch it). Every subagent must first run `git rev-parse --show-toplevel && git branch --show-current` and confirm it is in the worktree on `feat/curated-popup-trivia` before editing.
- Curated URL: `https://raw.githubusercontent.com/spudzareneat/grindhouse-popup-trivia/main/data/<imdbId>.json`; 404 = not curated.
- Doc shape: `{ schema: 1, imdbId, title, year, runtimeSec, generatedAt, facts: [{ t, rank, anchor, text, icon, byline, source }] }`.
- Rank filter: `frequent` → ranks 1–3, `occasional` → 1–2, `rare` → 1 only. Unknown/empty tier behaves as `occasional` (the existing default).
- Icon keys, existing 14 in current `TP_ICONS` order: `skull, tombstone, reel, saucer, alien, rocket, robot, radioactive, explosion, crosshair, knuckles, disco, boombox, sunglasses`; new 8: `joebob, money, camera, star, link, mic, censor, trophy`. Unknown/missing icon → random key.
- `raw.githubusercontent.com` is already in the manifest's `connect` list — no header change needed.
- Version: bump `baseVersion` in BOTH `src/pc/manifest.json` and `docs/manifest.json` to `4.13.51` in Task 3 (main's WIP is at 4.13.50; Tampermonkey won't reload without a bump).
- Stage files by explicit path only. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests are plain node scripts: `node scripts/<name>.mjs`; exit non-zero on failure.

## Review Focus

1. Viewer joins mid-movie or seeks forward → facts whose `t` is more than 20 s behind are skipped, never burst-fired (Task 1 test "late join").
2. Curated file whose `imdbId` doesn't match the playing movie → rejected, IMDb fallback used (Task 1 test "id mismatch").
3. Partly malformed facts (string `t`, negative `t`, empty/over-long text, rank 7) → those facts dropped, others kept; all bad → `null` → fallback (Task 1 tests).
4. Page reload while a fact is still inside its 20 s window → already-seen fact not re-shown (Task 1 test "seen").
5. Frequency changed mid-movie → next tick uses the new rank cutoff (Task 1 test passes tier per call; Task 3 reads it live each tick).

---

### Task 1: Pure timeline helpers

**Files:**
- Modify: `src/pc/modules/trivia-popup/index.js` (insert new block directly after the `TP_PERSON_TRIVIA_CAP` const, ~line 79)
- Create: `scripts/test-trivia-timeline.mjs`

**Interfaces:**
- Produces (all in slice `curated-timeline`):
  - `TP_TIMELINE_WINDOW_S` (number, 20)
  - `tpValidateCurated(doc, expectedId|null) -> Array<{t:number, rank:1|2|3, text:string, icon:string|null, byline:string|null}> | null` — sorted by `t`
  - `tpRankAllowed(rank:number, tierName:string) -> boolean`
  - `tpDueFact(facts, currentTime:number, tierName:string, seenTexts:string[]) -> fact | null`

- [ ] **Step 1: Write the failing test** — create `scripts/test-trivia-timeline.mjs`:

```js
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
const { tpValidateCurated, tpRankAllowed, tpDueFact, TP_TIMELINE_WINDOW_S } = new Function(
    `${src.slice(s, e)}\n;return { tpValidateCurated, tpRankAllowed, tpDueFact, TP_TIMELINE_WINDOW_S };`
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
    [{ t: 120, rank: 2, text: 'a', icon: 'skull', byline: 'Joe Bob' }, { t: 300, rank: 1, text: 'b', icon: 'reel', byline: null }]);
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

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('PASS: trivia-popup — curated timeline helpers, all assertions green');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-trivia-timeline.mjs`
Expected: `FAIL: could not locate the "curated-timeline" test-marker slice ...`, exit 1.

- [ ] **Step 3: Implement** — insert after the `TP_PERSON_TRIVIA_CAP` line in `src/pc/modules/trivia-popup/index.js`:

```js
    /* ==========================================================
       CURATED TIMELINE -- pure helpers for movies that have a
       generated Pop-up Video file (see
       docs/superpowers/specs/2026-10-03-curated-popup-trivia-design.md).
       Facts carry a playback time `t`, so every viewer (CyTube keeps
       them in sync) sees the same bubble at the same moment. No DOM,
       no globals -- scripts/test-trivia-timeline.mjs slices this
       block out between the markers and evals it.
    ========================================================== */

    // ── test marker: curated-timeline slice start ──
    const TP_CURATED_SCHEMA = 1;
    // A fact is still "due" up to this many seconds after its t -- covers the
    // 3s heartbeat and brief blocks (paused, window unfocused). Anything older
    // counts as missed (seek / late join) and is skipped, never burst-fired.
    const TP_TIMELINE_WINDOW_S = 20;
    const TP_CURATED_MAX_LEN = 280; // same legibility cap as TP_MAX_FACT_LEN; the generator itself targets 200

    // Returns the doc's usable facts, normalized and sorted by t, or null when
    // the doc is unusable (wrong schema / wrong movie / nothing valid) so the
    // caller falls back to IMDb trivia. expectedId null skips the id check
    // (dev override, which applies to whatever is playing).
    function tpValidateCurated(doc, expectedId) {
        if (!doc || typeof doc !== 'object' || doc.schema !== TP_CURATED_SCHEMA) return null;
        if (expectedId && doc.imdbId !== expectedId) return null;
        if (!Array.isArray(doc.facts)) return null;
        const facts = [];
        for (const f of doc.facts) {
            if (!f || typeof f !== 'object') continue;
            if (typeof f.t !== 'number' || !Number.isFinite(f.t) || f.t < 0) continue;
            if (typeof f.text !== 'string') continue;
            const text = f.text.trim();
            if (!text || text.length > TP_CURATED_MAX_LEN) continue;
            facts.push({
                t: f.t,
                rank: [1, 2, 3].includes(f.rank) ? f.rank : 2,
                text,
                icon: typeof f.icon === 'string' ? f.icon : null,
                byline: typeof f.byline === 'string' && f.byline.trim() ? f.byline.trim() : null,
            });
        }
        if (!facts.length) return null;
        facts.sort((a, b) => a.t - b.t);
        return facts;
    }

    // Frequency setting -> highest rank shown. Deterministic, so viewers on
    // the same setting see exactly the same bubbles.
    const TP_RANK_CUTOFF = { frequent: 3, occasional: 2, rare: 1 };
    function tpRankAllowed(rank, tierName) {
        return rank <= (TP_RANK_CUTOFF[tierName] || TP_RANK_CUTOFF.occasional);
    }

    // The earliest unseen, rank-allowed fact whose t has been reached but is
    // no more than TP_TIMELINE_WINDOW_S behind currentTime -- or null.
    function tpDueFact(facts, currentTime, tierName, seenTexts) {
        if (!Array.isArray(facts) || typeof currentTime !== 'number' || !Number.isFinite(currentTime)) return null;
        for (const f of facts) {
            if (f.t > currentTime) break; // sorted by t
            if (currentTime - f.t > TP_TIMELINE_WINDOW_S) continue;
            if (!tpRankAllowed(f.rank, tierName)) continue;
            if (seenTexts.includes(f.text)) continue;
            return f;
        }
        return null;
    }
    // ── test marker: curated-timeline slice end ──
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-trivia-timeline.mjs`
Expected: `PASS: trivia-popup — curated timeline helpers, all assertions green`

- [ ] **Step 5: Commit**

```bash
git add scripts/test-trivia-timeline.mjs src/pc/modules/trivia-popup/index.js
git commit -m "feat(trivia-popup): pure helpers for curated synced-timeline trivia

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Named icon map + 8 new icons

**Files:**
- Modify: `src/pc/modules/trivia-popup/index.js` (`TP_ICONS` array in the BUBBLE UI section, and `showTriviaBubble`)
- Create: `scripts/test-trivia-icons.mjs`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces (slice `icon-map`): `TP_ICON_SVGS` (object, key → SVG inner markup string), `TP_ICON_KEYS` (string[]), `tpPickIconKey(iconKey:string|null, keys:string[], rnd:()=>number) -> string`. `TP_ICONS` is removed.

- [ ] **Step 1: Write the failing test** — create `scripts/test-trivia-icons.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-trivia-icons.mjs`
Expected: `FAIL: could not locate the "icon-map" test-marker slice ...`, exit 1.

- [ ] **Step 3: Convert `TP_ICONS` to a named map.** In `src/pc/modules/trivia-popup/index.js`:
  - Replace the comment above `TP_ICONS` and `const TP_ICONS = [` with:

```js
    // Corner-badge glyphs -- grindhouse-flavored, drawn from scratch (no
    // copied assets), black/red/bone palette. Each entry is just the glyph
    // markup; showTriviaBubble() wraps it in the shared black-circle-plus-
    // red-ring backdrop. Keyed by name because curated facts pick their own
    // icon (`fact.icon`) -- the key set is a contract with the generator repo
    // (pinned by scripts/test-trivia-icons.mjs), so only ever ADD keys.
    // IMDb-fallback facts carry no icon and get a random one.
    // ── test marker: icon-map slice start ──
    const TP_ICON_SVGS = {
```
  - Prefix each of the 14 existing template-literal entries with its key, in file order: `skull:`, `tombstone:`, `reel:`, `saucer:`, `alien:`, `rocket:`, `robot:`, `radioactive:`, `explosion:`, `crosshair:`, `knuckles:`, `disco:`, `boombox:`, `sunglasses:`. Keep every SVG body and the `// --- Sci-fi ...` / `// --- Action ...` / `// --- Comedy ...` group comments byte-for-byte.
  - After the `sunglasses` entry, append the 8 new entries:

```js

        // --- Curated-fact topics (named by the generator, not random-picked by genre) ---

        // Drive-in window speaker -- Joe Bob / Drive-In Totals
        joebob: `<path d="M22 14 V8 H38 V14" fill="none" stroke="#000" stroke-width="2.5"/>
         <rect x="14" y="14" width="32" height="34" rx="5" fill="#d8d8d8" stroke="#000" stroke-width="2.5"/>
         <circle cx="30" cy="31" r="10" fill="#3a2a1a" stroke="#000" stroke-width="2"/>
         <path d="M22 31 H38 M24 26 H36 M24 36 H36" stroke="#000" stroke-width="1.5"/>
         <rect x="24" y="48" width="12" height="5" fill="#c81d25" stroke="#000" stroke-width="1.5"/>`,
        // Banknote -- budget / box office
        money: `<rect x="8" y="16" width="44" height="28" rx="3" fill="#f4f1ea" stroke="#000" stroke-width="2.5"/>
         <rect x="12" y="20" width="36" height="20" rx="2" fill="none" stroke="#000" stroke-width="1"/>
         <circle cx="30" cy="30" r="9" fill="#e8b923" stroke="#000" stroke-width="2"/>
         <text x="30" y="35" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="14" font-weight="900" fill="#000">$</text>`,
        // Two-reel movie camera -- production / behind the scenes
        camera: `<circle cx="20" cy="18" r="9" fill="#f4f1ea" stroke="#000" stroke-width="2.5"/>
         <circle cx="38" cy="18" r="9" fill="#f4f1ea" stroke="#000" stroke-width="2.5"/>
         <circle cx="20" cy="18" r="2.5" fill="#000"/>
         <circle cx="38" cy="18" r="2.5" fill="#000"/>
         <rect x="10" y="28" width="34" height="20" rx="3" fill="#3a2a1a" stroke="#000" stroke-width="2.5"/>
         <polygon points="44,32 54,26 54,50 44,44" fill="#d8d8d8" stroke="#000" stroke-width="2.5" stroke-linejoin="round"/>
         <circle cx="20" cy="38" r="3" fill="#c81d25"/>`,
        // Walk-of-fame star -- cast
        star: `<polygon points="30,6 36,22 53,22 39,32 44,49 30,39 16,49 21,32 7,22 24,22"
                 fill="#e8b923" stroke="#000" stroke-width="2.5" stroke-linejoin="round"/>
         <circle cx="30" cy="28" r="4" fill="#c81d25" stroke="#000" stroke-width="1.5"/>`,
        // Chain links -- ties to other movies
        link: `<rect x="6" y="22" width="28" height="16" rx="8" fill="none" stroke="#000" stroke-width="7"/>
         <rect x="6" y="22" width="28" height="16" rx="8" fill="none" stroke="#d8d8d8" stroke-width="3.5"/>
         <rect x="26" y="22" width="28" height="16" rx="8" fill="none" stroke="#000" stroke-width="7"/>
         <rect x="26" y="22" width="28" height="16" rx="8" fill="none" stroke="#e8b923" stroke-width="3.5"/>`,
        // Ribbon microphone -- interview quotes
        mic: `<rect x="20" y="6" width="20" height="28" rx="10" fill="#d8d8d8" stroke="#000" stroke-width="2.5"/>
         <path d="M24 14 H36 M24 20 H36 M24 26 H36" stroke="#000" stroke-width="1.5"/>
         <path d="M14 26 C14 38 22 42 30 42 C38 42 46 38 46 26" fill="none" stroke="#000" stroke-width="2.5"/>
         <line x1="30" y1="42" x2="30" y2="52" stroke="#000" stroke-width="3"/>
         <rect x="20" y="51" width="20" height="4" rx="1" fill="#c81d25" stroke="#000" stroke-width="1.5"/>`,
        // "CUT" stamp -- censorship / banned / alternate versions
        censor: `<g transform="rotate(-12 30 30)">
           <rect x="7" y="17" width="46" height="26" rx="3" fill="#f4f1ea" stroke="#c81d25" stroke-width="3"/>
           <text x="30" y="36" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="15" font-weight="900" fill="#c81d25">CUT</text>
         </g>`,
        // Trophy -- awards
        trophy: `<path d="M18 12 H10 C10 22 14 24 18 24 M42 12 H50 C50 22 46 24 42 24" fill="none" stroke="#000" stroke-width="2.5"/>
         <path d="M18 8 H42 V22 C42 30 36 36 30 36 C24 36 18 30 18 22 Z" fill="#e8b923" stroke="#000" stroke-width="2.5" stroke-linejoin="round"/>
         <rect x="27" y="36" width="6" height="8" fill="#e8b923" stroke="#000" stroke-width="2"/>
         <rect x="18" y="44" width="24" height="8" rx="1" fill="#3a2a1a" stroke="#000" stroke-width="2.5"/>`,
    };
    const TP_ICON_KEYS = Object.keys(TP_ICON_SVGS);

    // Curated facts name their icon; anything unknown (a key added by a newer
    // generator, a typo) or missing falls back to a random one rather than
    // breaking. rnd injected for testability.
    function tpPickIconKey(iconKey, keys, rnd) {
        if (iconKey && keys.includes(iconKey)) return iconKey;
        return keys[Math.floor(rnd() * keys.length)];
    }
    // ── test marker: icon-map slice end ──
```
  - Remove the old closing `];` of `TP_ICONS`.
  - In `showTriviaBubble`, replace
    `const icon = TP_ICONS[Math.floor(Math.random() * TP_ICONS.length)];`
    with
    `const icon = TP_ICON_SVGS[tpPickIconKey(fact.icon, TP_ICON_KEYS, Math.random)];`
  - Confirm no other `TP_ICONS` reference remains: `grep -n "TP_ICONS\b" src/pc/modules/trivia-popup/index.js` → no output.

- [ ] **Step 4: Run tests**

Run: `node scripts/test-trivia-icons.mjs && node scripts/test-trivia-timeline.mjs`
Expected: both `PASS: ...` lines.

- [ ] **Step 5: Commit**

```bash
git add scripts/test-trivia-icons.mjs src/pc/modules/trivia-popup/index.js
git commit -m "feat(trivia-popup): named icon map with 8 new topic icons

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Curated loader + timeline mode wiring + dev sample

**Files:**
- Modify: `src/pc/modules/trivia-popup/index.js` (state vars, `_tpResetForNewMovie`, new `_tpStartImdbQueue`, new `_tpTimelineTick`, `_tpMoviePollTick`, `triviaPopupBoot`, `_tpSetMuted`, both `scRegisterSetting` notes)
- Create: `docs/popup-trivia-sample.json`
- Modify: `src/pc/manifest.json`, `docs/manifest.json` (`baseVersion` → `4.13.51`)

**Interfaces:**
- Consumes: `tpValidateCurated`, `tpDueFact` (Task 1); `tpPickIconKey`/`TP_ICON_SVGS` via `showTriviaBubble` (Task 2); existing `getKey`, `getPlayerVideoEl`, `_currentImdbId`, `fetchImdbTrivia`, `GM_xmlhttpRequest`.
- Produces: `fetchCuratedTrivia(id) -> Promise<facts|null>`; DOM marker `document.documentElement[data-sc-trivia-popup="1"]` (the standalone script in sub-project 3 checks this — a DOM attribute, not a window global, because Tampermonkey sandboxes each script's `window`); localStorage dev key `sc_trivia_curated_dev`.

- [ ] **Step 1: Add the loader** — insert directly after the `curated-timeline slice end` marker (outside the slice):

```js
    const TP_CURATED_BASE = 'https://raw.githubusercontent.com/spudzareneat/grindhouse-popup-trivia/main/data/';
    // Dev/testing override: paste a whole curated JSON doc into this
    // localStorage key (DevTools) and it's used for WHATEVER movie is playing
    // (id check skipped). Sample: docs/popup-trivia-sample.json. Remove the
    // key to go back to normal.
    const LS_TRIVIA_CURATED_DEV = 'sc_trivia_curated_dev';
    // Session cache keyed by tconst: facts array, or null for "not curated"
    // (404 / invalid). Transient failures (network error, timeout, 5xx) are
    // NOT cached, so the next time that movie comes up it's retried.
    const _tpCuratedCache = {};

    function fetchCuratedTrivia(id) {
        if (!id) return Promise.resolve(null);
        let devRaw = null;
        try { devRaw = localStorage.getItem(LS_TRIVIA_CURATED_DEV); } catch (e) {}
        if (devRaw) {
            try { return Promise.resolve(tpValidateCurated(JSON.parse(devRaw), null)); }
            catch (e) { return Promise.resolve(null); }
        }
        if (id in _tpCuratedCache) return Promise.resolve(_tpCuratedCache[id]);
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: TP_CURATED_BASE + encodeURIComponent(id) + '.json',
                timeout: 10000,
                onload: r => {
                    const ok = r.status >= 200 && r.status < 300;
                    let facts = null;
                    if (ok) { try { facts = tpValidateCurated(JSON.parse(r.responseText), id); } catch (e) {} }
                    if (ok || r.status === 404) _tpCuratedCache[id] = facts;
                    resolve(facts);
                },
                onerror: () => resolve(null),
                ontimeout: () => resolve(null),
            });
        });
    }
```

- [ ] **Step 2: Add timeline state** — next to `let _tpDismissTimer = null;` add:

```js
    let _tpTimeline = null;  // curated facts (sorted by t) for the current movie; null = IMDb random-gap mode
```

- [ ] **Step 3: Split `_tpResetForNewMovie`.** Replace its whole body so it reads:

```js
    function _tpResetForNewMovie(id) {
        clearTimeout(_tpPopTimer); _tpPopTimer = null;
        _tpDismissBubble(true); // hard-remove instantly -- stale trivia, no exit animation
        _tpQueue = [];
        _tpExhausted = false;
        _tpTimeline = null;
        if (!id) return; // not identified yet; next poll tick will retry

        // Curated file first. If there is one, the movie runs in timeline
        // mode (_tpTimelineTick on the heartbeat) and none of the IMDb /
        // cast / known-for fetching below happens -- the generator already
        // folded those sources in. No file / bad file -> the IMDb path,
        // unchanged.
        fetchCuratedTrivia(id).then(facts => {
            if (id !== _tpLastImdbId) return; // movie changed again while this was in flight
            if (facts) { _tpTimeline = facts; return; }
            _tpStartImdbQueue(id);
        });
    }

    // The original (pre-curated) behavior: shuffled IMDb movie trivia plus
    // cast/crew enrichment, popped at random per-viewer gaps.
    function _tpStartImdbQueue(id) {
        fetchImdbTrivia(id).then(async items => {
            /* ...the ENTIRE previous body of the fetchImdbTrivia(id).then(async items => { ... }) callback, moved here verbatim, comments included... */
        });
    }
```
The comment line inside `_tpStartImdbQueue` is an instruction to the implementer: cut the existing callback body (from `if (id !== _tpLastImdbId) return; // movie changed again while this was in flight` through `if (_tpExhausted) { _tpExhausted = false; _tpScheduleNextPop(); }`) and paste it there unchanged. Do not leave that placeholder comment in the file.

- [ ] **Step 4: Add the timeline tick and wire it.** Add after `_tpAttemptPop`:

```js
    // Timeline mode's whole scheduler: every heartbeat, pop whichever curated
    // fact is due at the current playback position. Frequency tier and the
    // seen-set are re-read every tick (poll-per-use, like everything else
    // here), so a mid-movie setting change applies on the next tick. A fact
    // missed while blocked (paused, muted, window unfocused) for longer than
    // its window is simply skipped -- the point is everyone seeing it at the
    // same moment, not catching up.
    function _tpTimelineTick() {
        if (!_tpTimeline || _currentImdbId !== _tpLastImdbId) return;
        if (!popupTriviaEnabled() || !_tpMovieIsPlaying() || !document.hasFocus()) return;
        const v = getPlayerVideoEl();
        const tier = getKey(LS_TRIVIA_POPUP_FREQUENCY) || TP_FREQUENCY_DEFAULT;
        const fact = tpDueFact(_tpTimeline, v.currentTime, tier, _tpLoadSeenTexts(_tpLastImdbId));
        if (!fact) return;
        showTriviaBubble(fact);
        _tpMarkSeen(_tpLastImdbId, fact.text);
    }
```
Change `_tpMoviePollTick` to:

```js
    function _tpMoviePollTick() {
        if (_currentImdbId !== _tpLastImdbId) {
            _tpLastImdbId = _currentImdbId;
            _tpResetForNewMovie(_tpLastImdbId);
        }
        _tpTimelineTick();
    }
```
In `triviaPopupBoot`, add as its first line:

```js
        // Lets the standalone Pop-up Video script (separate Tampermonkey
        // sandbox, so a window global wouldn't be visible) stand down instead
        // of showing a second stream of bubbles.
        document.documentElement.setAttribute('data-sc-trivia-popup', '1');
```
In `_tpSetMuted`, change the unmute branch to only re-arm the random-gap scheduler outside timeline mode:

```js
        } else if (!_tpTimeline) {
            // Resume promptly rather than waiting out a full frequency gap.
            // (Timeline mode needs nothing -- the heartbeat picks up the next due fact.)
            _tpPopTimer = setTimeout(_tpAttemptPop, 1500);
        }
```

- [ ] **Step 5: Update the two settings notes.**
  - `sc-input-triviapopup` note → `'Every few minutes, shows a small trivia fact for about 15 seconds, VH1 Pop-up Video style, then fades out. Off by default. Movies with curated Pop-up Video trivia get hand-picked, sourced facts timed to the movie -- everyone in the channel sees each one at the same moment. Other movies fall back to IMDb trivia at random intervals. Facts never repeat, and this is remembered for a few hours so a page reload won\'t re-show ones you already saw. While a movie is playing, a "Pop-ups" button in the top bar mutes or resumes the bubbles for the session.'`
  - `sc-input-triviapopupfreq` note → `'How often a trivia bubble pops up. For movies with curated trivia (timed for everyone), this picks how many of the timed facts you see: Frequent = all, Occasional = the better ones, Rare = only the best.'`

- [ ] **Step 6: Create the dev sample** `docs/popup-trivia-sample.json` (bylines tagged SAMPLE so nobody mistakes it for real generator output; times bunched early so a tester sees several within ~10 minutes):

```json
{
  "schema": 1,
  "imdbId": "tt0055830",
  "title": "Carnival of Souls",
  "year": 1962,
  "runtimeSec": 4680,
  "generatedAt": "2026-10-03T00:00:00Z",
  "facts": [
    { "t": 70,  "rank": 1, "anchor": "spread", "text": "Herk Harvey shot this on a tiny budget while working as a director of industrial and educational films in Lawrence, Kansas.", "icon": "money", "byline": "SAMPLE", "source": { "type": "wikipedia" } },
    { "t": 160, "rank": 3, "anchor": "spread", "text": "Rank-3 test fact: only visible on the Frequent setting.", "icon": "reel", "byline": "SAMPLE", "source": { "type": "imdb" } },
    { "t": 250, "rank": 1, "anchor": "scene", "text": "The abandoned Saltair Pavilion on the Great Salt Lake is what inspired the film.", "icon": "camera", "byline": "SAMPLE", "source": { "type": "wikipedia" } },
    { "t": 340, "rank": 2, "anchor": "spread", "text": "Harvey also plays the pale, grinning Man who stalks Mary through the film.", "icon": "star", "byline": "SAMPLE", "source": { "type": "imdb" } },
    { "t": 430, "rank": 1, "anchor": "spread", "text": "George A. Romero cited the film's ghoulish look as an influence on Night of the Living Dead.", "icon": "link", "byline": "SAMPLE", "source": { "type": "wikipedia" } },
    { "t": 520, "rank": 2, "anchor": "spread", "text": "Drive-In Totals: Nineteen dead bodies. Approximately 15 zombies. Church organ fu. Zombie fu.", "icon": "joebob", "byline": "Joe Bob Briggs (SAMPLE)", "source": { "type": "driveintotals" } },
    { "t": 610, "rank": 1, "anchor": "spread", "text": "Unknown-icon test fact: should get a random icon.", "icon": "not-a-real-icon", "byline": "SAMPLE", "source": { "type": "imdb" } }
  ]
}
```

- [ ] **Step 7: Bump version** — in BOTH `src/pc/manifest.json` and `docs/manifest.json` set `"baseVersion": "4.13.51"`.

- [ ] **Step 8: Run tests and build**

Run: `node scripts/test-trivia-timeline.mjs && node scripts/test-trivia-icons.mjs && node scripts/build-dev-bundle.mjs && node -e "new Function(require('fs').readFileSync('cytube.pc.dev.user.js','utf8'))" && echo SYNTAX-OK`
Expected: two `PASS:` lines, `Wrote ...cytube.pc.dev.user.js (...)`, `SYNTAX-OK`. (`cytube.pc.dev.user.js` is gitignored — don't stage it.)
Also: `grep -n "_tpStartImdbQueue\|_tpTimelineTick\|data-sc-trivia-popup" src/pc/modules/trivia-popup/index.js` shows the definitions and their call sites; `grep -n "ENTIRE previous body" src/pc/modules/trivia-popup/index.js` → no output.

- [ ] **Step 9: Commit**

```bash
git add src/pc/modules/trivia-popup/index.js docs/popup-trivia-sample.json src/pc/manifest.json docs/manifest.json
git commit -m "feat(trivia-popup): play curated Pop-up Video trivia on a synced timeline; bump to 4.13.51

Fetches data/<imdbId>.json from grindhouse-popup-trivia; falls back to the
existing IMDb random-gap behavior when absent. Dev override via the
sc_trivia_curated_dev localStorage key.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 10: Live test (user, in browser)** — install the rebuilt `cytube.pc.dev.user.js`, enable Pop-up trivia in Settings, then in DevTools console on cytu.be:
  `localStorage.setItem('sc_trivia_curated_dev', JSON.stringify(<contents of docs/popup-trivia-sample.json>))`, reload. Check:
  1. Bubbles appear at ~1:10, ~4:10, ~5:40… of the playing movie with money / camera / star / link / joebob icons; the 10:10 fact gets a random icon.
  2. The rank-3 fact at 2:40 appears only on Frequent; the rank-2 facts disappear on Rare.
  3. Reloading the page mid-window doesn't re-show a fact; joining late doesn't fire a burst.
  4. `localStorage.removeItem('sc_trivia_curated_dev')`, reload → old IMDb random-gap behavior (with random icons) is back.
  5. Mute button still mutes/resumes in both modes.
