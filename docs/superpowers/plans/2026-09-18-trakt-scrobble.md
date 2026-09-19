# Trakt Scrobble Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in `trakt-scrobble` module: when a viewer passes 90% (configurable) of a movie, a dark, semi-transparent card appears at the bottom-right of the video for 60 seconds offering to log the watch (and an optional 1–10 rating) on trakt.tv.

**Architecture:** One new module folder (`src/pc/modules/trakt-scrobble/`) following the `trivia-popup` shape: pure helpers (unit-tested through a "test marker" slice), a Trakt client layer (device-code OAuth, refresh, `/sync/history` + `/sync/ratings`, unit-tested with a fake `GM_xmlhttpRequest`), a panel state machine + 3 s heartbeat, and four Settings rows registered through `scRegisterSetting`. No shared-core changes except a one-line `mask` option for text rows.

**Tech Stack:** Vanilla JS userscript fragments concatenated into one IIFE by `scripts/assemble.mjs`; Tampermonkey `GM_xmlhttpRequest`; plain-node test scripts (no npm, no test runner).

**Spec:** `docs/superpowers/specs/2026-09-18-trakt-scrobble-design.md`

## Global Constraints

- **Scope:** movies only. Skip YouTube (`isYouTubeMedia()`) and TV episodes. Identify by IMDb id (`_currentImdbId`).
- **Trigger:** progress `currentTime / duration >= threshold`; threshold is a Settings number, min **50**, max **100**, default **90**; require `duration >= 10 min` (600 s); already-handled TTL **12 h** (single-slot `sc_trakt_prompted`).
- **Panel lifetime:** **60 s** for the prompt state (pauses while hovered or in submitting/connect views); success state auto-dismisses after **6 s**. Thin countdown line along the bottom edge.
- **Panel look:** anchored to the bottom-right of the **video area** (not the viewport corner), inset 16 px right / 56 px bottom (clears the player control bar); dark `rgba(14, 14, 18, 0.78)`, `backdrop-filter: blur(14px)`, 1 px light hairline border, ~14 px radius, light text; font stack `"Inter", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif` — **no comic/display fonts**; one accent colour `#ed2224`; z-index **15500**.
- **Storage keys (localStorage):** `sc_trakt_enabled` (`'on'`), `sc_trakt_client_id`, `sc_trakt_client_secret`, `sc_trakt_threshold`, `sc_trakt_token` (JSON `{access, refresh, expiresAt, clientId}`), `sc_trakt_prompted` (JSON `{imdbId, ts, outcome}`).
- **Trakt API:** base `https://api.trakt.tv`; headers `Content-Type: application/json`, `trakt-api-version: 2`, `trakt-api-key: <client id>`, `Authorization: Bearer <access>` when authorized. Endpoints: `POST /oauth/device/code`, `POST /oauth/device/token`, `POST /oauth/token` (refresh, `redirect_uri` `urn:ietf:wg:oauth:2.0:oob`), `POST /sync/history`, `POST /sync/ratings`, `GET /movies/trending?limit=1` (key check). Success link: `https://trakt.tv/search/imdb/<tt id>`.
- **Settings rows:** `order` 13–16 (12 is imdb-link-preview); group `trakt-scrobble`.
- **Code conventions:** files under `src/pc/**` are IIFE *fragments* (no `import`/`export`, 4-space indent inside the IIFE, top-level `const`/`function`). Name everything with a `trakt` / `TRAKT_` / `_trakt` prefix so it can't collide with other modules. CSS uses `!important` (CyTube's Bootstrap otherwise wins) and must contain **no backticks, no `${`, no backslashes** (the assembler embeds it in a template literal).
- **Dependencies:** none added. Node built-ins only in scripts. Manifest module `dependsOn: ["core", "movie-title-links"]`, `grants: ["GM_xmlhttpRequest"]`, `connects: ["api.trakt.tv"]`.
- **Repo hygiene:** work on branch `feat/trakt-scrobble` (never on `main`). The working tree contains the user's **unrelated uncommitted edits**, notably a comment-only change in `src/pc/core/15-settings-modal-shell.js` — **never `git add -A` / `git add .` / `git commit -a`**; stage explicit paths only, and stage only *our* hunk of the settings-shell file (Task 3). Commit messages end with the line `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- **Shell:** Windows; run every command below from `C:\Repos\cytube_tv_interface_script` in **Git Bash** (POSIX syntax).

## File Structure

| File | Responsibility |
|---|---|
| `src/pc/modules/trakt-scrobble/index.js` (new) | Everything runtime: constants, pure helpers, Trakt client, panel + heartbeat, settings rows |
| `src/pc/modules/trakt-scrobble/style.css` (new) | Panel styling only |
| `scripts/test-trakt-scrobble.mjs` (new) | Unit tests for the helper slice and the client slice |
| `src/pc/manifest.json` + `docs/manifest.json` | Module entry + version bump (the two files are kept byte-identical by copy) |
| `src/pc/core/15-settings-modal-shell.js` | One-line `mask` support in `textRowHtml` |

`index.js` is laid out top to bottom as: `LS_*` keys → **helpers slice** → **client slice** → panel → heartbeat/boot → settings rows.

---

### Task 1: Pure helpers + tests

**Files:**
- Create: `src/pc/modules/trakt-scrobble/index.js`
- Create: `scripts/test-trakt-scrobble.mjs`

**Interfaces:**
- Produces (used by Tasks 2–4, all inside the `trakt-helpers` slice):
  - constants `LS_TRAKT_ENABLED`, `LS_TRAKT_CLIENT_ID`, `LS_TRAKT_SECRET`, `LS_TRAKT_THRESHOLD`, `LS_TRAKT_TOKEN`, `LS_TRAKT_PROMPTED`, `TRAKT_THRESHOLD_MIN/MAX/DEFAULT`, `TRAKT_MIN_DURATION_SEC`, `TRAKT_PROMPT_TTL_MS`, `TRAKT_REFRESH_WINDOW_MS`, `TRAKT_PANEL_LIFETIME_MS`, `TRAKT_SUCCESS_MS`, `TRAKT_PANEL_INSET`
  - `traktClampThreshold(raw) -> int`
  - `traktShouldPrompt({enabled, isYouTube, imdbId, duration, currentTime, thresholdPct, prompted, now}) -> boolean`
  - `traktUsableToken(token, clientId) -> token | null`
  - `traktTokenNeedsRefresh(token, nowMs) -> boolean`
  - `traktTokenFromResponse(json, clientId, nowMs) -> {access, refresh, expiresAt, clientId}`
  - `traktBuildHistoryPayload(snap, nowIso) -> {movies:[…]}`, `traktBuildRatingPayload(snap, rating, nowIso) -> {movies:[…]}`
  - `traktInterpretSyncResponse(json) -> 'added' | 'not_found' | 'unknown'`
  - `traktTickLifetime(remainingMs, dtMs, paused) -> number`
  - `traktPanelPosition(rect | null, {width, height}) -> {right, bottom}` (px, already including the inset)

- [ ] **Step 1: Create the feature branch (carries the working-tree edits along)**

```bash
git switch -c feat/trakt-scrobble
git status --short
```
Expected: `Switched to a new branch 'feat/trakt-scrobble'`, and the same ` M …` files as before (the user's edits are preserved, nothing committed).

- [ ] **Step 2: Write the failing test file**

Create `scripts/test-trakt-scrobble.mjs`:

```js
// scripts/test-trakt-scrobble.mjs
//
// Standalone assertions for the trakt-scrobble module in
// src/pc/modules/trakt-scrobble/index.js:
//   - the PURE helper slice  ("trakt-helpers")  -- thresholds, eligibility, tokens, payloads, layout math
//   - the CLIENT slice       ("trakt-client")   -- Trakt HTTP + token store + device auth + submit,
//                                                  run against a fake GM_xmlhttpRequest / localStorage
//
// No test harness in this repo (no package.json, no runner), so this is a plain node script:
//
//   node scripts/test-trakt-scrobble.mjs
//
// Exits non-zero on the first failing assertion; prints a one-line pass summary otherwise.
// src/pc/** files are script fragments concatenated inside one IIFE, not ES modules, so the file
// can't be imported -- instead this slices code out between "test marker" comments and evals it
// faithfully to how it runs in the bundle, same convention as scripts/test-imdb-link-preview.mjs.

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(__dirname, '..', 'src', 'pc', 'modules', 'trakt-scrobble', 'index.js');
const src = fs.readFileSync(srcPath, 'utf8');

function slice(name) {
    const START = `// ── test marker: ${name} slice start ──`;
    const END = `// ── test marker: ${name} slice end ──`;
    const a = src.indexOf(START);
    const b = src.indexOf(END);
    if (a === -1 || b === -1 || b < a) {
        console.error(`FAIL: could not locate the "${name}" test-marker slice in trakt-scrobble/index.js`);
        process.exit(1);
    }
    return src.slice(a, b);
}

let passed = 0;
async function test(name, fn) {
    try {
        await fn();
        passed++;
    } catch (e) {
        console.error(`FAIL: ${name}`);
        console.error(e);
        process.exit(1);
    }
}

// ── helper slice ─────────────────────────────────────────────────────────────

const HELPER_NAMES = [
    'traktClampThreshold', 'traktShouldPrompt', 'traktUsableToken', 'traktTokenNeedsRefresh',
    'traktTokenFromResponse', 'traktBuildHistoryPayload', 'traktBuildRatingPayload',
    'traktInterpretSyncResponse', 'traktTickLifetime', 'traktPanelPosition',
    'TRAKT_THRESHOLD_DEFAULT', 'TRAKT_PROMPT_TTL_MS', 'TRAKT_REFRESH_WINDOW_MS',
];
// eslint-disable-next-line no-new-func
const H = new Function(`${slice('trakt-helpers')}\n;return { ${HELPER_NAMES.join(', ')} };`)();

await test('traktClampThreshold clamps and defaults', () => {
    assert.equal(H.traktClampThreshold('90'), 90);
    assert.equal(H.traktClampThreshold(75), 75);
    assert.equal(H.traktClampThreshold('10'), 50);
    assert.equal(H.traktClampThreshold('250'), 100);
    assert.equal(H.traktClampThreshold(''), H.TRAKT_THRESHOLD_DEFAULT);
    assert.equal(H.traktClampThreshold(null), H.TRAKT_THRESHOLD_DEFAULT);
    assert.equal(H.traktClampThreshold('abc'), H.TRAKT_THRESHOLD_DEFAULT);
});

const NOW = 1_800_000_000_000;
const BASE = {
    enabled: true, isYouTube: false, imdbId: 'tt0087332',
    duration: 7200, currentTime: 6600, thresholdPct: 90, prompted: null, now: NOW,
};

await test('traktShouldPrompt: happy path and exact threshold boundary', () => {
    assert.equal(H.traktShouldPrompt(BASE), true);
    assert.equal(H.traktShouldPrompt({ ...BASE, currentTime: 6480 }), true);   // exactly 90%
    assert.equal(H.traktShouldPrompt({ ...BASE, currentTime: 6479 }), false);  // just under
});

await test('traktShouldPrompt: threshold 100 needs the very end', () => {
    assert.equal(H.traktShouldPrompt({ ...BASE, thresholdPct: 100, currentTime: 7200 }), true);
    assert.equal(H.traktShouldPrompt({ ...BASE, thresholdPct: 100, currentTime: 7199 }), false);
});

await test('traktShouldPrompt: gate conditions', () => {
    assert.equal(H.traktShouldPrompt({ ...BASE, enabled: false }), false);
    assert.equal(H.traktShouldPrompt({ ...BASE, isYouTube: true }), false);
    assert.equal(H.traktShouldPrompt({ ...BASE, imdbId: null }), false);
    assert.equal(H.traktShouldPrompt({ ...BASE, imdbId: '' }), false);
    assert.equal(H.traktShouldPrompt({ ...BASE, duration: 599, currentTime: 599 }), false); // < 10 min
    assert.equal(H.traktShouldPrompt({ ...BASE, duration: NaN }), false);
    assert.equal(H.traktShouldPrompt({ ...BASE, duration: Infinity }), false);
    assert.equal(H.traktShouldPrompt({ ...BASE, currentTime: NaN }), false);
});

await test('traktShouldPrompt: already-handled TTL is per movie and expires', () => {
    const recent = { imdbId: 'tt0087332', ts: NOW - 60_000, outcome: 'shown' };
    assert.equal(H.traktShouldPrompt({ ...BASE, prompted: recent }), false);
    const stale = { imdbId: 'tt0087332', ts: NOW - H.TRAKT_PROMPT_TTL_MS - 1, outcome: 'skipped' };
    assert.equal(H.traktShouldPrompt({ ...BASE, prompted: stale }), true);
    const other = { imdbId: 'tt0000001', ts: NOW - 60_000, outcome: 'scrobbled' };
    assert.equal(H.traktShouldPrompt({ ...BASE, prompted: other }), true);
});

await test('traktUsableToken requires access token and matching client id', () => {
    const t = { access: 'A', refresh: 'R', expiresAt: NOW + 1000, clientId: 'cid' };
    assert.equal(H.traktUsableToken(t, 'cid'), t);
    assert.equal(H.traktUsableToken(t, 'other'), null);
    assert.equal(H.traktUsableToken(t, ''), null);
    assert.equal(H.traktUsableToken(null, 'cid'), null);
    assert.equal(H.traktUsableToken({ ...t, access: '' }, 'cid'), null);
});

await test('traktTokenNeedsRefresh triggers inside the 1-day window', () => {
    const day = H.TRAKT_REFRESH_WINDOW_MS;
    assert.equal(H.traktTokenNeedsRefresh({ expiresAt: NOW + day + 5000 }, NOW), false);
    assert.equal(H.traktTokenNeedsRefresh({ expiresAt: NOW + day - 5000 }, NOW), true);
    assert.equal(H.traktTokenNeedsRefresh({ expiresAt: NOW - 1 }, NOW), true);
    assert.equal(H.traktTokenNeedsRefresh(null, NOW), false);
});

await test('traktTokenFromResponse computes expiresAt from created_at + expires_in', () => {
    const json = { access_token: 'A', refresh_token: 'R', expires_in: 7776000, created_at: 1_700_000_000 };
    assert.deepEqual(H.traktTokenFromResponse(json, 'cid', NOW), {
        access: 'A', refresh: 'R', expiresAt: (1_700_000_000 + 7776000) * 1000, clientId: 'cid',
    });
    const noCreated = { access_token: 'A', refresh_token: 'R', expires_in: 100 };
    assert.equal(H.traktTokenFromResponse(noCreated, 'cid', NOW).expiresAt, NOW + 100_000);
});

await test('payload builders target the IMDb id', () => {
    const snap = { imdbId: 'tt0087332', title: 'Ghostbusters', year: '1984', poster: '' };
    assert.deepEqual(H.traktBuildHistoryPayload(snap, '2026-09-18T20:00:00.000Z'),
        { movies: [{ watched_at: '2026-09-18T20:00:00.000Z', ids: { imdb: 'tt0087332' } }] });
    assert.deepEqual(H.traktBuildRatingPayload(snap, 8, '2026-09-18T20:00:00.000Z'),
        { movies: [{ rated_at: '2026-09-18T20:00:00.000Z', rating: 8, ids: { imdb: 'tt0087332' } }] });
});

await test('traktInterpretSyncResponse', () => {
    assert.equal(H.traktInterpretSyncResponse({ added: { movies: 1 }, not_found: { movies: [] } }), 'added');
    assert.equal(H.traktInterpretSyncResponse({ added: { movies: 0 }, not_found: { movies: [{ ids: { imdb: 'tt1' } }] } }), 'not_found');
    assert.equal(H.traktInterpretSyncResponse({ added: { movies: 0 }, not_found: { movies: [] } }), 'unknown');
    assert.equal(H.traktInterpretSyncResponse({}), 'unknown');
    assert.equal(H.traktInterpretSyncResponse(null), 'unknown');
});

await test('traktTickLifetime counts down unless paused, floors at 0', () => {
    assert.equal(H.traktTickLifetime(60000, 250, false), 59750);
    assert.equal(H.traktTickLifetime(60000, 250, true), 60000);
    assert.equal(H.traktTickLifetime(100, 250, false), 0);
});

await test('traktPanelPosition anchors to the video rect and never goes negative', () => {
    const vp = { width: 1600, height: 900 };
    assert.deepEqual(H.traktPanelPosition({ right: 1200, bottom: 700 }, vp), { right: 416, bottom: 256 });
    assert.deepEqual(H.traktPanelPosition(null, vp), { right: 16, bottom: 56 });
    assert.deepEqual(H.traktPanelPosition({ right: 1700, bottom: 950 }, vp), { right: 16, bottom: 56 });
});

console.log(`OK: ${passed} trakt-scrobble test groups passed`);
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node scripts/test-trakt-scrobble.mjs`
Expected: exits non-zero with `ENOENT … trakt-scrobble/index.js` (the module file does not exist yet).

- [ ] **Step 4: Create the module file with the helpers slice**

Create `src/pc/modules/trakt-scrobble/index.js`:

```js
    /* ==========================================================
       TRAKT SCROBBLE — end-of-movie "log this on Trakt?" panel.

       When playback of a movie passes a configurable share of its
       runtime (default 90%), a dark, semi-transparent card appears at
       the bottom-right of the video for one minute offering to record
       the watch (and an optional 1-10 rating) on trakt.tv. Everything
       is configured in the Settings modal: an opt-in toggle, the
       user's own Trakt app Client ID + Secret, and the threshold.

       Movies only (matched by the IMDb id movie-title-links resolves:
       _currentImdbId / _npData); YouTube items are skipped. Auth is
       Trakt's device-code flow, done inline in the panel. The watch is
       sent as a one-shot POST /sync/history (not the live
       /scrobble/start|pause|stop session API -- we only ask after the
       fact), and the "already handled" state lives in localStorage
       (single slot, 12 h TTL) so reloads during the credits don't
       re-prompt.

       Like trivia-popup, settings here are poll-per-use: Save just
       writes localStorage, so the heartbeat re-reads them each tick.

       Layout of this file: LS keys -> helpers slice (pure, unit-tested)
       -> client slice (Trakt HTTP/token/device-auth, unit-tested with a
       fake GM_xmlhttpRequest) -> panel + heartbeat -> settings rows.
       scripts/test-trakt-scrobble.mjs slices the two test-marker
       regions out of this file.
    ========================================================== */

    // ── test marker: trakt-helpers slice start ──
    const LS_TRAKT_ENABLED   = 'sc_trakt_enabled';        // 'on' = opted in (off by default)
    const LS_TRAKT_CLIENT_ID = 'sc_trakt_client_id';
    const LS_TRAKT_SECRET    = 'sc_trakt_client_secret';
    const LS_TRAKT_THRESHOLD = 'sc_trakt_threshold';      // percent of runtime, 50-100
    const LS_TRAKT_TOKEN     = 'sc_trakt_token';          // JSON {access, refresh, expiresAt, clientId}
    const LS_TRAKT_PROMPTED  = 'sc_trakt_prompted';       // JSON {imdbId, ts, outcome} -- single slot

    const TRAKT_THRESHOLD_MIN     = 50;
    const TRAKT_THRESHOLD_MAX     = 100;
    const TRAKT_THRESHOLD_DEFAULT = 90;
    const TRAKT_MIN_DURATION_SEC  = 10 * 60;              // ignore shorts / bumpers
    const TRAKT_PROMPT_TTL_MS     = 12 * 60 * 60 * 1000;  // don't re-ask about the same movie within 12 h
    const TRAKT_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;  // refresh the token when < 1 day from expiry
    const TRAKT_PANEL_LIFETIME_MS = 60 * 1000;            // how long the prompt stays up
    const TRAKT_SUCCESS_MS        = 6 * 1000;             // how long the "Logged" confirmation stays up
    const TRAKT_PANEL_INSET       = { right: 16, bottom: 56 }; // px from the video's corner; bottom clears the control bar

    function traktClampThreshold(raw) {
        const n = parseInt(raw, 10);
        const v = Number.isFinite(n) ? n : TRAKT_THRESHOLD_DEFAULT;
        return Math.min(TRAKT_THRESHOLD_MAX, Math.max(TRAKT_THRESHOLD_MIN, v));
    }

    // s = { enabled, isYouTube, imdbId, duration, currentTime, thresholdPct, prompted, now }
    function traktShouldPrompt(s) {
        if (!s.enabled || s.isYouTube || !s.imdbId) return false;
        if (!Number.isFinite(s.duration) || s.duration < TRAKT_MIN_DURATION_SEC) return false;
        if (!Number.isFinite(s.currentTime) || s.currentTime < 0) return false;
        if (s.currentTime / s.duration < s.thresholdPct / 100) return false;
        const p = s.prompted;
        if (p && p.imdbId === s.imdbId && s.now - p.ts < TRAKT_PROMPT_TTL_MS) return false;
        return true;
    }

    function traktUsableToken(token, clientId) {
        return (token && token.access && clientId && token.clientId === clientId) ? token : null;
    }

    function traktTokenNeedsRefresh(token, nowMs) {
        return !!token && Number.isFinite(token.expiresAt) && nowMs >= token.expiresAt - TRAKT_REFRESH_WINDOW_MS;
    }

    // Trakt's token response: { access_token, refresh_token, expires_in (s), created_at (unix s), ... }
    function traktTokenFromResponse(json, clientId, nowMs) {
        const createdMs = Number.isFinite(json.created_at) ? json.created_at * 1000 : nowMs;
        return { access: json.access_token, refresh: json.refresh_token, expiresAt: createdMs + json.expires_in * 1000, clientId };
    }

    function traktBuildHistoryPayload(snap, nowIso) {
        return { movies: [{ watched_at: nowIso, ids: { imdb: snap.imdbId } }] };
    }

    function traktBuildRatingPayload(snap, rating, nowIso) {
        return { movies: [{ rated_at: nowIso, rating, ids: { imdb: snap.imdbId } }] };
    }

    // Trakt's /sync/* reply: { added: { movies: n }, not_found: { movies: [...] } }
    function traktInterpretSyncResponse(json) {
        const nf = json && json.not_found && json.not_found.movies;
        if (nf && nf.length) return 'not_found';
        const added = json && json.added && json.added.movies;
        return added > 0 ? 'added' : 'unknown';
    }

    function traktTickLifetime(remainingMs, dtMs, paused) {
        return paused ? remainingMs : Math.max(0, remainingMs - dtMs);
    }

    // rect = the video's getBoundingClientRect() (or null); viewport = { width, height } of the visible
    // viewport. Returns CSS `right`/`bottom` px for a position:fixed box so it hugs the rect's bottom-right.
    function traktPanelPosition(rect, viewport) {
        const right  = rect ? viewport.width  - rect.right  : 0;
        const bottom = rect ? viewport.height - rect.bottom : 0;
        return {
            right:  Math.max(0, Math.round(right))  + TRAKT_PANEL_INSET.right,
            bottom: Math.max(0, Math.round(bottom)) + TRAKT_PANEL_INSET.bottom,
        };
    }
    // ── test marker: trakt-helpers slice end ──
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node scripts/test-trakt-scrobble.mjs`
Expected: `OK: 12 trakt-scrobble test groups passed`

- [ ] **Step 6: Syntax-check the fragment**

Run: `node --check src/pc/modules/trakt-scrobble/index.js`
Expected: no output, exit 0.

- [ ] **Step 7: Commit (explicit paths only)**

```bash
git add scripts/test-trakt-scrobble.mjs src/pc/modules/trakt-scrobble/index.js \
        docs/superpowers/specs/2026-09-18-trakt-scrobble-design.md \
        docs/superpowers/plans/2026-09-18-trakt-scrobble.md
git commit -m "feat(trakt-scrobble): add pure helpers, tests, spec and plan" \
           -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git status --short
```
Expected: commit succeeds; `git status` still lists the user's pre-existing ` M` files (unstaged, untouched).

---

### Task 2: Trakt client (HTTP, tokens, device auth, submit)

**Files:**
- Modify: `src/pc/modules/trakt-scrobble/index.js` (append after the helpers slice end marker)
- Modify: `scripts/test-trakt-scrobble.mjs` (add client tests above the final `console.log`)

**Interfaces:**
- Consumes: everything from Task 1's `trakt-helpers` slice, plus globals `GM_xmlhttpRequest`, `getKey` (core `02-keys-and-helpers.js`), `localStorage`.
- Produces (inside the `trakt-client` slice):
  - `TRAKT_API`, `TRAKT_OOB_REDIRECT`
  - `traktEnabled() -> boolean`, `traktThreshold() -> int`, `traktClientId() -> string`, `traktSecret() -> string`
  - `traktRequest(method, path, {body?, token?, clientId?}) -> Promise<{status, json}>` (rejects on network error/timeout)
  - `validateTraktClientId(clientId) -> Promise<'valid'|'invalid'|'error'>`
  - `traktLoadToken() / traktSaveToken(t) / traktClearToken()`; `traktLoadPrompted() / traktMarkPrompted(imdbId, outcome)`
  - `traktStartDeviceAuth() -> Promise<{device_code, user_code, verification_url, expires_in, interval}>` (throws on failure)
  - `traktPollDeviceToken(dev, handle, sleep?) -> Promise<'ok'|'denied'|'expired'|'cancelled'|'error'>` (`handle = {cancelled:boolean}`; saves the token on `'ok'`)
  - `traktRefreshToken(token) -> Promise<token|null>`; `traktEnsureToken() -> Promise<token|null>`
  - `traktSubmit(snap, rating) -> Promise<{result:'added'|'not_found'|'auth'|'error', ratingFailed:boolean}>`

- [ ] **Step 1: Write the failing client tests**

In `scripts/test-trakt-scrobble.mjs`, insert the following **immediately above** the final line `console.log(\`OK: …\`);`:

```js
// ── client slice ─────────────────────────────────────────────────────────────

const CLIENT_NAMES = [
    'traktEnabled', 'traktThreshold', 'traktRequest', 'validateTraktClientId',
    'traktLoadToken', 'traktSaveToken', 'traktClearToken', 'traktLoadPrompted', 'traktMarkPrompted',
    'traktStartDeviceAuth', 'traktPollDeviceToken', 'traktRefreshToken', 'traktEnsureToken', 'traktSubmit',
];

// Fresh fake environment per test: Map-backed localStorage, a scripted GM_xmlhttpRequest that
// replays `replies` in order ({status, body} | 'error') and records every request it sees.
function loadClient() {
    const store = new Map();
    const localStorage = {
        getItem: k => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: k => { store.delete(k); },
    };
    const getKey = id => localStorage.getItem(id) || '';
    const replies = [];
    const requests = [];
    const GM_xmlhttpRequest = opts => {
        requests.push(opts);
        const next = replies.shift();
        queueMicrotask(() => {
            if (!next || next === 'error') return opts.onerror && opts.onerror();
            opts.onload({ status: next.status, responseText: next.body === undefined ? '' : JSON.stringify(next.body) });
        });
    };
    const code = `${slice('trakt-helpers')}\n${slice('trakt-client')}\n;return { ${CLIENT_NAMES.join(', ')} };`;
    // eslint-disable-next-line no-new-func
    const api = new Function('GM_xmlhttpRequest', 'localStorage', 'getKey', code)(GM_xmlhttpRequest, localStorage, getKey);
    return { api, store, replies, requests };
}

const SNAP = { imdbId: 'tt0087332', title: 'Ghostbusters', year: '1984', poster: '' };
const ADDED = { status: 201, body: { added: { movies: 1 }, not_found: { movies: [] } } };
const DAY = 24 * 60 * 60 * 1000;
function withKeys(env) {
    env.store.set('sc_trakt_client_id', 'cid');
    env.store.set('sc_trakt_client_secret', 'sec');
}
function withToken(env, over = {}) {
    withKeys(env);
    env.store.set('sc_trakt_token', JSON.stringify({ access: 'A1', refresh: 'R1', expiresAt: Date.now() + 30 * DAY, clientId: 'cid', ...over }));
}
const tokenReply = (access, refresh) => ({
    status: 200,
    body: { access_token: access, refresh_token: refresh, expires_in: 7776000, created_at: Math.floor(Date.now() / 1000) },
});

await test('config accessors read settings', () => {
    const env = loadClient();
    assert.equal(env.api.traktEnabled(), false);
    env.store.set('sc_trakt_enabled', 'on');
    assert.equal(env.api.traktEnabled(), true);
    assert.equal(env.api.traktThreshold(), 90);
    env.store.set('sc_trakt_threshold', '75');
    assert.equal(env.api.traktThreshold(), 75);
});

await test('prompted slot round-trips and tolerates corrupt JSON', () => {
    const env = loadClient();
    assert.equal(env.api.traktLoadPrompted(), null);
    env.api.traktMarkPrompted('tt1', 'shown');
    const p = env.api.traktLoadPrompted();
    assert.equal(p.imdbId, 'tt1');
    assert.equal(p.outcome, 'shown');
    assert.ok(Math.abs(p.ts - Date.now()) < 2000);
    env.store.set('sc_trakt_prompted', '{not json');
    assert.equal(env.api.traktLoadPrompted(), null);
});

await test('validateTraktClientId maps status codes', async () => {
    for (const [reply, expected] of [[{ status: 200, body: [] }, 'valid'], [{ status: 403, body: {} }, 'invalid'],
                                     [{ status: 401, body: {} }, 'invalid'], [{ status: 500, body: {} }, 'error'], ['error', 'error']]) {
        const env = loadClient();
        env.replies.push(reply);
        assert.equal(await env.api.validateTraktClientId('cid'), expected);
        assert.match(env.requests[0].url, /\/movies\/trending\?limit=1$/);
        assert.equal(env.requests[0].headers['trakt-api-key'], 'cid');
    }
});

await test('traktSubmit: no token -> auth without touching the network', async () => {
    const env = loadClient();
    withKeys(env);
    assert.deepEqual(await env.api.traktSubmit(SNAP, 0), { result: 'auth', ratingFailed: false });
    assert.equal(env.requests.length, 0);
});

await test('traktSubmit: token for a different client id is unusable', async () => {
    const env = loadClient();
    withToken(env, { clientId: 'someone-else' });
    assert.equal((await env.api.traktSubmit(SNAP, 0)).result, 'auth');
    assert.equal(env.requests.length, 0);
});

await test('traktSubmit: success sends one authorized history request', async () => {
    const env = loadClient();
    withToken(env);
    env.replies.push(ADDED);
    assert.deepEqual(await env.api.traktSubmit(SNAP, 0), { result: 'added', ratingFailed: false });
    assert.equal(env.requests.length, 1);
    assert.match(env.requests[0].url, /^https:\/\/api\.trakt\.tv\/sync\/history$/);
    assert.equal(env.requests[0].method, 'POST');
    assert.equal(env.requests[0].headers['Authorization'], 'Bearer A1');
    assert.equal(env.requests[0].headers['trakt-api-key'], 'cid');
    assert.equal(env.requests[0].headers['trakt-api-version'], '2');
    assert.equal(JSON.parse(env.requests[0].data).movies[0].ids.imdb, 'tt0087332');
});

await test('traktSubmit: rating goes to /sync/ratings; a failed rating does not fail the watch', async () => {
    let env = loadClient();
    withToken(env);
    env.replies.push(ADDED, ADDED);
    assert.deepEqual(await env.api.traktSubmit(SNAP, 8), { result: 'added', ratingFailed: false });
    assert.equal(env.requests.length, 2);
    assert.match(env.requests[1].url, /\/sync\/ratings$/);
    assert.equal(JSON.parse(env.requests[1].data).movies[0].rating, 8);

    env = loadClient();
    withToken(env);
    env.replies.push(ADDED, { status: 500, body: {} });
    assert.deepEqual(await env.api.traktSubmit(SNAP, 8), { result: 'added', ratingFailed: true });
});

await test('traktSubmit: not_found, http error and network error', async () => {
    let env = loadClient();
    withToken(env);
    env.replies.push({ status: 201, body: { added: { movies: 0 }, not_found: { movies: [{ ids: { imdb: 'tt0087332' } }] } } });
    assert.equal((await env.api.traktSubmit(SNAP, 0)).result, 'not_found');

    env = loadClient();
    withToken(env);
    env.replies.push({ status: 500, body: {} });
    assert.equal((await env.api.traktSubmit(SNAP, 0)).result, 'error');

    env = loadClient();
    withToken(env);
    env.replies.push('error');
    assert.equal((await env.api.traktSubmit(SNAP, 0)).result, 'error');
});

await test('traktSubmit: 401 triggers one refresh then a retry with the new token', async () => {
    const env = loadClient();
    withToken(env);
    env.replies.push({ status: 401, body: {} }, tokenReply('A2', 'R2'), ADDED);
    assert.equal((await env.api.traktSubmit(SNAP, 0)).result, 'added');
    assert.match(env.requests[1].url, /\/oauth\/token$/);
    const refreshBody = JSON.parse(env.requests[1].data);
    assert.equal(refreshBody.grant_type, 'refresh_token');
    assert.equal(refreshBody.refresh_token, 'R1');
    assert.equal(refreshBody.client_secret, 'sec');
    assert.equal(refreshBody.redirect_uri, 'urn:ietf:wg:oauth:2.0:oob');
    assert.equal(env.requests[2].headers['Authorization'], 'Bearer A2');
    assert.equal(JSON.parse(env.store.get('sc_trakt_token')).access, 'A2');
});

await test('traktSubmit: 401 then rejected refresh -> auth and token cleared', async () => {
    const env = loadClient();
    withToken(env);
    env.replies.push({ status: 401, body: {} }, { status: 401, body: {} });
    assert.equal((await env.api.traktSubmit(SNAP, 0)).result, 'auth');
    assert.equal(env.store.has('sc_trakt_token'), false);
});

await test('traktEnsureToken: refresh network failure keeps a not-yet-expired token, drops an expired one', async () => {
    let env = loadClient();
    withToken(env, { expiresAt: Date.now() + 60 * 60 * 1000 });   // inside the 1-day window, still valid
    env.replies.push('error');
    assert.equal((await env.api.traktEnsureToken()).access, 'A1');

    env = loadClient();
    withToken(env, { expiresAt: Date.now() - 1000 });             // already expired
    env.replies.push('error');
    assert.equal(await env.api.traktEnsureToken(), null);
});

await test('traktStartDeviceAuth returns the device payload or throws', async () => {
    let env = loadClient();
    withKeys(env);
    const dev = { device_code: 'D', user_code: 'ABCD1234', verification_url: 'https://trakt.tv/activate', expires_in: 600, interval: 5 };
    env.replies.push({ status: 200, body: dev });
    assert.deepEqual(await env.api.traktStartDeviceAuth(), dev);
    assert.equal(JSON.parse(env.requests[0].data).client_id, 'cid');

    env = loadClient();
    withKeys(env);
    env.replies.push({ status: 403, body: {} });
    await assert.rejects(() => env.api.traktStartDeviceAuth());
});

await test('traktPollDeviceToken: pending, slow-down, then success saves the token', async () => {
    const env = loadClient();
    withKeys(env);
    env.replies.push({ status: 400, body: {} }, { status: 429, body: {} }, tokenReply('A9', 'R9'));
    const sleeps = [];
    const handle = { cancelled: false };
    const result = await env.api.traktPollDeviceToken({ device_code: 'D', expires_in: 600, interval: 5 }, handle, async ms => { sleeps.push(ms); });
    assert.equal(result, 'ok');
    assert.deepEqual(sleeps, [5000, 5000, 6000]);   // 429 adds 1 s to the interval
    const saved = JSON.parse(env.store.get('sc_trakt_token'));
    assert.equal(saved.access, 'A9');
    assert.equal(saved.clientId, 'cid');
    const body = JSON.parse(env.requests[2].data);
    assert.equal(body.code, 'D');
    assert.equal(body.client_secret, 'sec');
});

await test('traktPollDeviceToken: denied, expired, error and cancel', async () => {
    const run = async reply => {
        const env = loadClient();
        withKeys(env);
        env.replies.push(reply);
        return env.api.traktPollDeviceToken({ device_code: 'D', expires_in: 600, interval: 5 }, { cancelled: false }, async () => {});
    };
    assert.equal(await run({ status: 418, body: {} }), 'denied');
    assert.equal(await run({ status: 410, body: {} }), 'expired');
    assert.equal(await run({ status: 404, body: {} }), 'expired');
    assert.equal(await run({ status: 401, body: {} }), 'error');

    const env = loadClient();
    withKeys(env);
    const handle = { cancelled: false };
    const r = await env.api.traktPollDeviceToken({ device_code: 'D', expires_in: 600, interval: 5 }, handle, async () => { handle.cancelled = true; });
    assert.equal(r, 'cancelled');
    assert.equal(env.requests.length, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node scripts/test-trakt-scrobble.mjs`
Expected: exits non-zero with `FAIL: could not locate the "trakt-client" test-marker slice in trakt-scrobble/index.js`.

- [ ] **Step 3: Implement the client slice**

In `src/pc/modules/trakt-scrobble/index.js`, append **after** the `// ── test marker: trakt-helpers slice end ──` line:

```js

    // ── test marker: trakt-client slice start ──
    const TRAKT_API          = 'https://api.trakt.tv';
    const TRAKT_OOB_REDIRECT = 'urn:ietf:wg:oauth:2.0:oob';

    const traktEnabled   = () => getKey(LS_TRAKT_ENABLED) === 'on';   // opt-in
    const traktThreshold = () => traktClampThreshold(getKey(LS_TRAKT_THRESHOLD));
    const traktClientId  = () => getKey(LS_TRAKT_CLIENT_ID);
    const traktSecret    = () => getKey(LS_TRAKT_SECRET);

    // Resolves { status, json } for any HTTP response (json is null when the body isn't JSON);
    // rejects only on a network error / timeout. `opts.clientId` overrides the saved Client ID
    // (used by the Settings "Test" button, which validates the value currently typed in the box).
    function traktRequest(method, path, opts = {}) {
        const { body, token, clientId } = opts;
        return new Promise((resolve, reject) => {
            const headers = {
                'Content-Type': 'application/json',
                'trakt-api-version': '2',
                'trakt-api-key': clientId || traktClientId(),
            };
            if (token && token.access) headers['Authorization'] = 'Bearer ' + token.access;
            GM_xmlhttpRequest({
                method,
                url: TRAKT_API + path,
                headers,
                data: body ? JSON.stringify(body) : undefined,
                timeout: 15000,
                onload: r => {
                    let json = null;
                    try { json = JSON.parse(r.responseText); } catch (e) {}
                    resolve({ status: r.status, json });
                },
                onerror: () => reject(new Error('network')),
                ontimeout: () => reject(new Error('timeout')),
            });
        });
    }

    // Settings "Test" button handler: an unauthenticated public endpoint that still requires a valid
    // trakt-api-key. 200 = key accepted, 401/403 = rejected, anything else = couldn't tell.
    async function validateTraktClientId(clientId) {
        try {
            const res = await traktRequest('GET', '/movies/trending?limit=1', { clientId });
            if (res.status === 200) return 'valid';
            if (res.status === 401 || res.status === 403) return 'invalid';
            return 'error';
        } catch (e) { return 'error'; }
    }

    function traktLoadToken() { try { return JSON.parse(localStorage.getItem(LS_TRAKT_TOKEN)); } catch (e) { return null; } }
    function traktSaveToken(t) { try { localStorage.setItem(LS_TRAKT_TOKEN, JSON.stringify(t)); } catch (e) {} }
    function traktClearToken() { try { localStorage.removeItem(LS_TRAKT_TOKEN); } catch (e) {} }

    function traktLoadPrompted() { try { return JSON.parse(localStorage.getItem(LS_TRAKT_PROMPTED)); } catch (e) { return null; } }
    // outcome: 'shown' (panel appeared -- also what an auto-dismiss leaves behind) | 'skipped' | 'scrobbled'
    function traktMarkPrompted(imdbId, outcome) {
        try { localStorage.setItem(LS_TRAKT_PROMPTED, JSON.stringify({ imdbId, ts: Date.now(), outcome })); } catch (e) {}
    }

    // Device flow step 1. Resolves { device_code, user_code, verification_url, expires_in, interval }; throws on failure.
    async function traktStartDeviceAuth() {
        const res = await traktRequest('POST', '/oauth/device/code', { body: { client_id: traktClientId() } });
        if (res.status !== 200 || !res.json || !res.json.device_code) throw new Error('device-code HTTP ' + res.status);
        return res.json;
    }

    // Device flow step 2: polls at Trakt's interval until approved / denied / expired / cancelled.
    // `handle` is { cancelled: boolean } -- set it true to stop. `sleep` is injectable for tests.
    // Saves the token and resolves 'ok' on success; else 'denied' | 'expired' | 'cancelled' | 'error'.
    async function traktPollDeviceToken(dev, handle, sleep = ms => new Promise(r => setTimeout(r, ms))) {
        let intervalMs = Math.max(1, dev.interval || 5) * 1000;
        const deadline = Date.now() + dev.expires_in * 1000;
        while (!handle.cancelled && Date.now() < deadline) {
            await sleep(intervalMs);
            if (handle.cancelled) break;
            let res;
            try {
                res = await traktRequest('POST', '/oauth/device/token',
                    { body: { code: dev.device_code, client_id: traktClientId(), client_secret: traktSecret() } });
            } catch (e) { continue; }                                   // transient network error: keep polling until expiry
            if (res.status === 200 && res.json && res.json.access_token) {
                traktSaveToken(traktTokenFromResponse(res.json, traktClientId(), Date.now()));
                return 'ok';
            }
            if (res.status === 400) continue;                            // pending: user hasn't approved yet
            if (res.status === 429) { intervalMs += 1000; continue; }    // polling too fast
            if (res.status === 418) return 'denied';
            if (res.status === 404 || res.status === 409 || res.status === 410) return 'expired';
            return 'error';                                              // e.g. 401 = wrong Client Secret
        }
        return handle.cancelled ? 'cancelled' : 'expired';
    }

    // Exchanges the refresh token. Saves + returns the fresh token, or null. A definitive rejection
    // (400/401/403) also clears the stored token so the next attempt goes through Connect.
    async function traktRefreshToken(token) {
        try {
            const res = await traktRequest('POST', '/oauth/token', {
                body: {
                    refresh_token: token.refresh, client_id: traktClientId(), client_secret: traktSecret(),
                    redirect_uri: TRAKT_OOB_REDIRECT, grant_type: 'refresh_token',
                },
            });
            if (res.status === 200 && res.json && res.json.access_token) {
                const fresh = traktTokenFromResponse(res.json, traktClientId(), Date.now());
                traktSaveToken(fresh);
                return fresh;
            }
            if (res.status === 400 || res.status === 401 || res.status === 403) traktClearToken();
        } catch (e) {}
        return null;
    }

    // A token that can be used right now, or null (=> the panel must run Connect).
    async function traktEnsureToken() {
        const token = traktUsableToken(traktLoadToken(), traktClientId());
        if (!token) return null;
        if (traktTokenNeedsRefresh(token, Date.now())) {
            const fresh = await traktRefreshToken(token);
            if (fresh) return fresh;
            if (!traktLoadToken()) return null;                 // refresh was rejected and the token was cleared
            if (Date.now() >= token.expiresAt) return null;     // hard-expired and couldn't refresh
        }
        return token;                                           // near expiry but refresh failed transiently: still valid
    }

    // Logs the watch (+ rating). Resolves { result, ratingFailed }; result is
    // 'added' | 'not_found' | 'auth' (needs Connect) | 'error'. A failed rating never fails the watch.
    // NOTE: a Retry after a lost *response* can log the watch twice -- Trakt doesn't dedupe history adds.
    async function traktSubmit(snap, rating) {
        let token = await traktEnsureToken();
        if (!token) return { result: 'auth', ratingFailed: false };
        const nowIso = new Date().toISOString();
        const post = (path, body) => traktRequest('POST', path, { body, token });
        try {
            let res = await post('/sync/history', traktBuildHistoryPayload(snap, nowIso));
            if (res.status === 401) {                           // token rejected: one refresh, one retry
                token = await traktRefreshToken(token);
                if (!token) return { result: 'auth', ratingFailed: false };
                res = await post('/sync/history', traktBuildHistoryPayload(snap, nowIso));
            }
            if (res.status !== 200 && res.status !== 201) return { result: 'error', ratingFailed: false };
            const verdict = traktInterpretSyncResponse(res.json);
            if (verdict === 'not_found') return { result: 'not_found', ratingFailed: false };
            if (verdict !== 'added') return { result: 'error', ratingFailed: false };
            let ratingFailed = false;
            if (rating) {
                try {
                    const rr = await post('/sync/ratings', traktBuildRatingPayload(snap, rating, nowIso));
                    ratingFailed = !((rr.status === 200 || rr.status === 201) && traktInterpretSyncResponse(rr.json) === 'added');
                } catch (e) { ratingFailed = true; }
            }
            return { result: 'added', ratingFailed };
        } catch (e) {
            return { result: 'error', ratingFailed: false };
        }
    }
    // ── test marker: trakt-client slice end ──
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node scripts/test-trakt-scrobble.mjs`
Expected: `OK: 26 trakt-scrobble test groups passed` (12 helper groups + 14 client groups), exit code 0.

- [ ] **Step 5: Syntax-check and commit**

```bash
node --check src/pc/modules/trakt-scrobble/index.js
git add scripts/test-trakt-scrobble.mjs src/pc/modules/trakt-scrobble/index.js
git commit -m "feat(trakt-scrobble): add Trakt client (device auth, refresh, history/ratings submit)" \
           -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
Expected: `node --check` silent; commit succeeds.

---

### Task 3: Settings rows, manifest wiring, secret masking

**Files:**
- Modify: `src/pc/modules/trakt-scrobble/index.js` (append settings block at the end)
- Modify: `src/pc/manifest.json` (add module entry), then copy to `docs/manifest.json`
- Modify: `src/pc/core/15-settings-modal-shell.js:73` (one line)

**Interfaces:**
- Consumes: `LS_TRAKT_*`, `TRAKT_THRESHOLD_MIN/MAX/DEFAULT`, `validateTraktClientId` (Tasks 1–2); core `scRegisterSetting`.
- Produces: four registered settings rows (`sc-input-trakt-enabled`, `sc-input-trakt-clientid`, `sc-input-trakt-secret`, `sc-input-trakt-threshold`); manifest module id `trakt-scrobble`; text rows accept `mask: true`.

- [ ] **Step 1: Add `mask` support to text settings rows**

In `src/pc/core/15-settings-modal-shell.js`, in `textRowHtml`, change the input tag (line 73–74):

Old:
```js
                        <input id="${r.id}" class="sc-settings-input" type="text"
                            placeholder="${r.placeholder || ''}" value="${val}" spellcheck="false" />
```
New:
```js
                        <input id="${r.id}" class="sc-settings-input" ${r.mask ? 'type="password" autocomplete="off"' : 'type="text"'}
                            placeholder="${r.placeholder || ''}" value="${val}" spellcheck="false" />
```

Also update the row-type doc comment above `scRegisterSetting` **only if** it lists text-row options — it lives in `src/pc/core/10-registry.js` (lines 13–18); add one line after the `'text'` bullet: `//               Set `mask: true` to render it as a password field (e.g. secrets).` (Do not touch anything else in either file.)

- [ ] **Step 2: Append the settings rows to the module**

Append at the end of `src/pc/modules/trakt-scrobble/index.js`:

```js

    /* ==========================================================
       SETTINGS ROWS — order 13-16 (12 is imdb-link-preview).
    ========================================================== */
    scRegisterSetting({
        id: 'sc-input-trakt-enabled',
        group: 'trakt-scrobble',
        label: 'Trakt: offer to log movies at the end',
        note: 'When you reach the end of a movie, a small card appears at the bottom-right of the video for a minute asking if you want to log the watch (and an optional rating) on trakt.tv. Off by default. Needs your own Trakt app credentials below. Movies only -- not YouTube or TV episodes.',
        key: LS_TRAKT_ENABLED,
        defaultOn: false,
        order: 13,
    });
    scRegisterSetting({
        id: 'sc-input-trakt-clientid',
        group: 'trakt-scrobble',
        type: 'text',
        label: 'Trakt Client ID',
        note: 'Create a Trakt app (any name; set the Redirect URI to urn:ietf:wg:oauth:2.0:oob), then paste its Client ID here.',
        key: LS_TRAKT_CLIENT_ID,
        placeholder: 'Paste Trakt Client ID…',
        testHandler: validateTraktClientId,
        testEmptyMessage: 'Enter a Client ID first',
        testValidMessage: '✓ Valid Client ID',
        testInvalidMessage: '✗ Invalid Client ID',
        testErrorMessage: '⚠ Couldn\'t reach Trakt',
        link: 'https://trakt.tv/oauth/applications',
        linkText: 'Create a Trakt app ↗',
        order: 14,
    });
    scRegisterSetting({
        id: 'sc-input-trakt-secret',
        group: 'trakt-scrobble',
        type: 'text',
        mask: true,
        label: 'Trakt Client Secret',
        note: 'From the same Trakt app page. Stored in this browser only, like the other keys. You sign in to Trakt from the pop-up card the first time it appears.',
        key: LS_TRAKT_SECRET,
        placeholder: 'Paste Trakt Client Secret…',
        order: 15,
    });
    scRegisterSetting({
        id: 'sc-input-trakt-threshold',
        group: 'trakt-scrobble',
        type: 'number',
        label: 'Trakt prompt point (% of the movie)',
        note: 'How far into the movie the card appears. 90 leaves room for the end credits; 100 waits for the very last second.',
        key: LS_TRAKT_THRESHOLD,
        min: TRAKT_THRESHOLD_MIN, max: TRAKT_THRESHOLD_MAX, step: 1, defaultValue: TRAKT_THRESHOLD_DEFAULT,
        order: 16,
    });
```

- [ ] **Step 3: Add the module to the manifest**

In `src/pc/manifest.json`, insert this object **between** the `imdb-link-preview` entry (ends at `]\n    },` just before `"id": "movie-lead-time"`) and the `movie-lead-time` entry. (No `cssFiles` yet — the stylesheet arrives in Task 4.)

```json
    {
      "id": "trakt-scrobble",
      "name": "Trakt Scrobble Prompt",
      "category": "Movie Info",
      "locked": false,
      "defaultOn": true,
      "files": [
        "src/pc/modules/trakt-scrobble/index.js"
      ],
      "dependsOn": ["core", "movie-title-links"],
      "grants": [
        "GM_xmlhttpRequest"
      ],
      "connects": [
        "api.trakt.tv"
      ],
      "features": [
        "At the end of a movie, a dark semi-transparent card appears at the bottom-right of the video for a minute offering to log the watch on trakt.tv",
        "Optional 1–10 rating sent with the watch; sign in to Trakt right from the card (device code — no redirect setup)",
        "Uses your own Trakt app Client ID + Secret from Settings; prompt point is configurable (default 90% of the movie)",
        "Movies only (not YouTube / TV episodes); off by default — opt in from Settings"
      ]
    },
```

Then keep the two manifests identical:

```bash
cp src/pc/manifest.json docs/manifest.json
cmp src/pc/manifest.json docs/manifest.json && echo IDENTICAL
node -e "JSON.parse(require('fs').readFileSync('src/pc/manifest.json','utf8')); console.log('manifest JSON ok')"
```
Expected: `IDENTICAL` and `manifest JSON ok`.

- [ ] **Step 4: Build the bundle and verify the wiring**

```bash
node scripts/build-dev-bundle.mjs
node --check cytube.pc.dev.user.js && echo BUNDLE_SYNTAX_OK
grep -n "api.trakt.tv" cytube.pc.dev.user.js | head
grep -c "sc-input-trakt-" cytube.pc.dev.user.js
```
Expected: the build line lists `trakt-scrobble` among the modules; `BUNDLE_SYNTAX_OK`; at least one `@connect … api.trakt.tv` header line plus the `TRAKT_API` constant; the count is `>= 4`. (`cytube.pc.dev.user.js` is git-ignored — it will not appear in `git status`.)

- [ ] **Step 5: Re-run the unit tests**

Run: `node scripts/test-trakt-scrobble.mjs`
Expected: `OK: …` (unchanged — the settings block is outside both slices).

- [ ] **Step 6: Commit — stage only OUR hunk of the settings-shell file**

The shell file also contains the user's unrelated comment-only edit (first hunk). Stage just our (second) hunk non-interactively:

```bash
git add src/pc/modules/trakt-scrobble/index.js src/pc/manifest.json docs/manifest.json src/pc/core/10-registry.js
printf 'n\ny\n' | git add -p src/pc/core/15-settings-modal-shell.js
git diff --cached --stat
git diff --cached src/pc/core/15-settings-modal-shell.js
```
Expected for the shell file: exactly **one** changed line (the `<input … type=…>` line, `+1 -1`), and no comment lines about `sc-input-gifoptimize`. **If the staged diff for that file contains anything else, or `git add -p` misbehaves:** run `git restore --staged src/pc/core/15-settings-modal-shell.js`, commit without it, and tell the user the one-line `mask` change is left unstaged in their working tree.

Also confirm `src/pc/manifest.json`'s staged diff shows only the new module entry plus the pre-existing `4.13.17 → 4.13.18` version line (the user's own uncommitted bump — fine to include).

```bash
git commit -m "feat(trakt-scrobble): register settings rows, manifest entry, masked secret field" \
           -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git status --short
```
Expected: commit succeeds; remaining ` M` entries are only the user's pre-existing unrelated edits (and the shell file's comment hunk).

---

### Task 4: The panel — styling, state machine, heartbeat

**Files:**
- Create: `src/pc/modules/trakt-scrobble/style.css`
- Modify: `src/pc/modules/trakt-scrobble/index.js` (insert panel + boot code **above** the `SETTINGS ROWS` block comment)
- Modify: `src/pc/manifest.json` (add `cssFiles`, bump version), then copy to `docs/manifest.json`

**Interfaces:**
- Consumes: Task 1 helpers/constants; Task 2 client (`traktEnabled`, `traktThreshold`, `traktClientId`, `traktSecret`, `traktLoadToken`, `traktClearToken`, `traktLoadPrompted`, `traktMarkPrompted`, `traktStartDeviceAuth`, `traktPollDeviceToken`, `traktSubmit`); core/other-module globals `_currentImdbId`, `_npData`, `lastMovieTitle`, `parseMovieFilename` (core `01-movie-identity.js`), `isYouTubeMedia` (core `12-…`), `openSettingsModal` (core `15-…`), `scRegisterInit` (core `10-registry.js`).
- Produces: `traktSnapshot()`, `traktShowPanel(snap)`, `traktClosePanel()`, `traktTick()`, `traktBoot()`.

- [ ] **Step 1: Write the stylesheet**

Create `src/pc/modules/trakt-scrobble/style.css` (remember: no backticks, no `${`, no backslashes):

```css
            #sc-trakt-panel {
                position: fixed !important;
                z-index: 15500 !important; /* above video chrome (~10001-10004), below dropdowns/modals (~19000/20001) */
                box-sizing: border-box !important;
                width: 340px !important; max-width: calc(100vw - 32px) !important;
                padding: 14px 14px 18px !important;
                background: rgba(14, 14, 18, 0.78) !important;
                -webkit-backdrop-filter: blur(14px) saturate(1.2) !important;
                backdrop-filter: blur(14px) saturate(1.2) !important;
                border: 1px solid rgba(255, 255, 255, 0.10) !important;
                border-radius: 14px !important;
                box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45) !important;
                color: #ececf1 !important;
                font-family: "Inter", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif !important;
                font-size: 13px !important; line-height: 1.4 !important; letter-spacing: 0.01em !important;
                overflow: hidden !important;
                opacity: 0 !important; transform: translateY(8px) !important;
                transition: opacity 0.28s ease, transform 0.28s ease !important;
            }
            #sc-trakt-panel.sc-trakt-in  { opacity: 1 !important; transform: translateY(0) !important; }
            #sc-trakt-panel.sc-trakt-out { opacity: 0 !important; transform: translateY(8px) !important; }
            #sc-trakt-panel * { box-sizing: border-box !important; font-family: inherit !important; }

            #sc-trakt-panel .sc-trakt-row  { display: flex !important; gap: 12px !important; align-items: flex-start !important; }
            #sc-trakt-panel .sc-trakt-poster {
                flex: 0 0 auto !important; width: 60px !important; height: 90px !important;
                object-fit: cover !important; border-radius: 8px !important;
                background: rgba(255, 255, 255, 0.06) !important;
                box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4) !important;
            }
            #sc-trakt-panel .sc-trakt-noposter {
                display: flex !important; align-items: center !important; justify-content: center !important;
                font-size: 22px !important; color: rgba(236, 236, 241, 0.5) !important;
            }
            #sc-trakt-panel .sc-trakt-main  { flex: 1 1 auto !important; min-width: 0 !important; }
            #sc-trakt-panel .sc-trakt-title {
                font-size: 15px !important; font-weight: 600 !important; line-height: 1.25 !important;
                margin: 0 0 6px !important; color: #f4f4f7 !important;
                overflow: hidden !important; text-overflow: ellipsis !important; display: -webkit-box !important;
                -webkit-line-clamp: 2 !important; -webkit-box-orient: vertical !important;
            }
            #sc-trakt-panel .sc-trakt-year { font-weight: 400 !important; color: rgba(236, 236, 241, 0.55) !important; }
            #sc-trakt-panel .sc-trakt-q    { font-size: 13px !important; color: rgba(236, 236, 241, 0.85) !important; margin: 0 0 8px !important; }
            #sc-trakt-panel .sc-trakt-ok   { color: #7fd99a !important; font-weight: 600 !important; }
            #sc-trakt-panel .sc-trakt-bad  { color: #ff8a8c !important; }
            #sc-trakt-panel .sc-trakt-note { font-weight: 400 !important; color: rgba(236, 236, 241, 0.55) !important; }
            #sc-trakt-panel .sc-trakt-help { font-size: 12px !important; color: rgba(236, 236, 241, 0.62) !important; margin: 0 0 6px !important; }

            #sc-trakt-panel .sc-trakt-stars { display: flex !important; gap: 1px !important; margin: 0 0 2px -2px !important; }
            #sc-trakt-panel .sc-trakt-star {
                background: none !important; border: 0 !important; box-shadow: none !important;
                padding: 0 1px !important; margin: 0 !important; cursor: pointer !important;
                font-size: 18px !important; line-height: 1 !important; color: rgba(255, 255, 255, 0.24) !important;
                transition: color 0.12s ease, transform 0.12s ease !important;
            }
            #sc-trakt-panel .sc-trakt-star.on    { color: #ed2224 !important; }
            #sc-trakt-panel .sc-trakt-star:hover { color: #ff5457 !important; transform: scale(1.15) !important; }
            #sc-trakt-panel .sc-trakt-rating-label { font-size: 11px !important; color: rgba(236, 236, 241, 0.5) !important; margin: 0 0 10px !important; }

            #sc-trakt-panel .sc-trakt-actions { display: flex !important; gap: 8px !important; flex-wrap: wrap !important; }
            #sc-trakt-panel .sc-trakt-btn {
                appearance: none !important; cursor: pointer !important;
                padding: 7px 12px !important; margin: 0 !important; border-radius: 8px !important;
                background: rgba(255, 255, 255, 0.07) !important; color: #ececf1 !important;
                border: 1px solid rgba(255, 255, 255, 0.16) !important; box-shadow: none !important;
                font-size: 12.5px !important; font-weight: 500 !important; line-height: 1.2 !important;
                transition: background 0.15s ease, border-color 0.15s ease !important;
            }
            #sc-trakt-panel .sc-trakt-btn:hover { background: rgba(255, 255, 255, 0.13) !important; }
            #sc-trakt-panel .sc-trakt-primary { background: #ed2224 !important; border-color: #ed2224 !important; color: #fff !important; font-weight: 600 !important; }
            #sc-trakt-panel .sc-trakt-primary:hover { background: #ff3b3d !important; border-color: #ff3b3d !important; }

            #sc-trakt-panel .sc-trakt-link {
                display: inline-block !important; margin-top: 8px !important;
                font-size: 11.5px !important; color: rgba(236, 236, 241, 0.6) !important; text-decoration: underline !important;
            }
            #sc-trakt-panel .sc-trakt-link:hover { color: #fff !important; }
            #sc-trakt-panel .sc-trakt-help .sc-trakt-link { margin: 0 !important; font-size: inherit !important; color: #ff8a8c !important; }

            #sc-trakt-panel .sc-trakt-code {
                margin: 4px 0 8px !important; padding: 8px 12px !important; text-align: center !important;
                font-family: ui-monospace, "SF Mono", "Cascadia Mono", Consolas, "Liberation Mono", monospace !important;
                font-size: 22px !important; font-weight: 600 !important; letter-spacing: 0.18em !important;
                background: rgba(255, 255, 255, 0.07) !important; border-radius: 8px !important;
                color: #fff !important; user-select: all !important;
            }

            #sc-trakt-panel .sc-trakt-life { position: absolute !important; left: 0 !important; right: 0 !important; bottom: 0 !important; height: 3px !important; background: rgba(255, 255, 255, 0.06) !important; }
            #sc-trakt-panel .sc-trakt-life-bar { height: 100% !important; width: 100% !important; background: rgba(236, 236, 241, 0.35) !important; transition: width 0.25s linear !important; }
```

- [ ] **Step 2: Insert the panel + heartbeat code**

In `src/pc/modules/trakt-scrobble/index.js`, insert the following **immediately above** the comment block that starts `/* ====…  SETTINGS ROWS — order 13-16`:

```js
    /* ==========================================================
       PANEL — #sc-trakt-panel, a single card whose body is re-rendered
       per view: 'prompt' | 'submitting' | 'success' | 'notfound' |
       'error' | 'connect' | 'needsconfig'. Events are delegated from
       the card itself (data-act / data-r), so re-rendering the body
       never needs re-binding.
    ========================================================== */
    const TRAKT_POLL_MS = 3000;   // heartbeat: decides when the movie has reached the prompt point
    const TRAKT_LIFE_TICK_MS = 250;

    let _traktPanelEl    = null;  // live panel node, or null when closed
    let _traktCtx        = null;  // { snap, rating, view, message, remaining, lifeTotal, hover, dev, devExpiresAt, poll, ratingFailed }
    let _traktLifeTimer  = null;
    let _traktKeyHandler = null;

    function _traktEsc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Everything the panel needs about the movie, captured once at trigger time so a queue advance
    // while the card is open can't change what gets submitted.
    function traktSnapshot() {
        const np = (_npData && _npData.imdbId === _currentImdbId) ? _npData : null;
        const parsed = lastMovieTitle ? parseMovieFilename(lastMovieTitle) : { title: '', year: null };
        return {
            imdbId: _currentImdbId,
            title:  (np && np.cleanTitle) || parsed.title || 'this movie',
            year:   (np && np.cleanYear) || parsed.year || '',
            poster: (np && np.poster) || '',
        };
    }

    // Normally <body>; while something is fullscreened via the Fullscreen API the card must live
    // inside that element to stay visible (a <video> can't hold children, so that case is skipped).
    function _traktHost() {
        const fs = document.fullscreenElement;
        return (fs && fs.tagName !== 'VIDEO') ? fs : document.body;
    }

    // Pins the card to the bottom-right of the video (or #videowrap, else the viewport corner).
    // Runs every life tick, so window resizes / chat-panel drags / fullscreen changes are followed.
    function _traktReposition() {
        if (!_traktPanelEl) return;
        const host = _traktHost();
        if (_traktPanelEl.parentNode !== host) host.appendChild(_traktPanelEl);
        const v = document.querySelector('#ytapiplayer video');
        const wrap = document.getElementById('videowrap');
        let r = (v && v.getBoundingClientRect()) || null;
        if (!r || r.width <= 0 || r.height <= 0) r = (wrap && wrap.getBoundingClientRect()) || null;
        if (r && (r.width <= 0 || r.height <= 0)) r = null;
        const pos = traktPanelPosition(r, { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight });
        _traktPanelEl.style.setProperty('right', pos.right + 'px', 'important');
        _traktPanelEl.style.setProperty('bottom', pos.bottom + 'px', 'important');
    }

    function _traktStars(rating) {
        let out = '';
        for (let i = 1; i <= 10; i++) {
            out += `<button type="button" class="sc-trakt-star${i <= rating ? ' on' : ''}" data-r="${i}" aria-label="Rate ${i} out of 10">★</button>`;
        }
        return out;
    }

    function _traktPaintLife() {
        const bar = _traktPanelEl && _traktPanelEl.querySelector('.sc-trakt-life-bar');
        if (bar && _traktCtx) bar.style.setProperty('width', Math.max(0, Math.min(100, _traktCtx.remaining / _traktCtx.lifeTotal * 100)) + '%', 'important');
    }

    function _traktRender() {
        const c = _traktCtx, el = _traktPanelEl;
        if (!c || !el) return;
        const s = c.snap;
        const title = `${_traktEsc(s.title)}${s.year ? ` <span class="sc-trakt-year">(${_traktEsc(s.year)})</span>` : ''}`;
        const poster = s.poster
            ? `<img class="sc-trakt-poster" src="${_traktEsc(s.poster)}" alt="" />`
            : '<div class="sc-trakt-poster sc-trakt-noposter">🎬</div>';
        let body = '';
        switch (c.view) {
            case 'prompt':
                body = `
                    <div class="sc-trakt-q">You reached the end. Log it on Trakt?</div>
                    <div class="sc-trakt-stars" role="group" aria-label="Optional rating">${_traktStars(c.rating)}</div>
                    <div class="sc-trakt-rating-label">${c.rating ? c.rating + ' / 10' : 'Optional rating'}</div>
                    <div class="sc-trakt-actions">
                        <button type="button" class="sc-trakt-btn sc-trakt-primary" data-act="scrobble">Scrobble to Trakt</button>
                        <button type="button" class="sc-trakt-btn" data-act="skip">Not now</button>
                    </div>
                    ${traktLoadToken() ? '<a href="#" class="sc-trakt-link" data-act="disconnect">Disconnect Trakt</a>' : ''}`;
                break;
            case 'submitting':
                body = '<div class="sc-trakt-q">Logging to Trakt…</div>';
                break;
            case 'success':
                body = `
                    <div class="sc-trakt-q sc-trakt-ok">Logged ✓${c.ratingFailed ? ' <span class="sc-trakt-note">(rating didn\'t save)</span>' : ''}</div>
                    <a class="sc-trakt-link" href="https://trakt.tv/search/imdb/${_traktEsc(s.imdbId)}" target="_blank" rel="noopener">View on Trakt ↗</a>`;
                break;
            case 'notfound':
                body = `
                    <div class="sc-trakt-q sc-trakt-bad">Trakt couldn't match this movie.</div>
                    <div class="sc-trakt-actions"><button type="button" class="sc-trakt-btn" data-act="skip">Close</button></div>`;
                break;
            case 'error':
                body = `
                    <div class="sc-trakt-q sc-trakt-bad">${_traktEsc(c.message || 'Something went wrong.')}</div>
                    <div class="sc-trakt-actions">
                        <button type="button" class="sc-trakt-btn sc-trakt-primary" data-act="retry">Retry</button>
                        <button type="button" class="sc-trakt-btn" data-act="skip">Close</button>
                    </div>`;
                break;
            case 'connect':
                body = c.dev ? `
                    <div class="sc-trakt-q">Connect your Trakt account</div>
                    <div class="sc-trakt-help">Open <a class="sc-trakt-link" href="${_traktEsc(c.dev.verification_url)}" target="_blank" rel="noopener">${_traktEsc(String(c.dev.verification_url).replace(/^https?:\/\//, ''))}</a> and enter:</div>
                    <div class="sc-trakt-code">${_traktEsc(c.dev.user_code)}</div>
                    <div class="sc-trakt-help">Waiting for approval… <span class="sc-trakt-expiry"></span></div>
                    <div class="sc-trakt-actions"><button type="button" class="sc-trakt-btn" data-act="cancelconnect">Cancel</button></div>`
                : '<div class="sc-trakt-q">Contacting Trakt…</div>';
                break;
            case 'needsconfig':
                body = `
                    <div class="sc-trakt-q">Trakt isn't set up yet</div>
                    <div class="sc-trakt-help">Add your Trakt Client ID and Secret in Settings to log movies.</div>
                    <div class="sc-trakt-actions">
                        <button type="button" class="sc-trakt-btn sc-trakt-primary" data-act="settings">Open Settings</button>
                        <button type="button" class="sc-trakt-btn" data-act="skip">Dismiss</button>
                    </div>`;
                break;
        }
        el.innerHTML = `
            <div class="sc-trakt-row">
                ${poster}
                <div class="sc-trakt-main">
                    <div class="sc-trakt-title">${title}</div>
                    ${body}
                </div>
            </div>
            <div class="sc-trakt-life"><div class="sc-trakt-life-bar"></div></div>`;
        _traktPaintLife();
    }

    // opts.life (ms) restarts the countdown for the new view; opts.message feeds the 'error' view.
    function _traktSetView(view, opts = {}) {
        const c = _traktCtx;
        if (!c) return;
        c.view = view;
        c.message = opts.message || '';
        if (opts.life) { c.remaining = opts.life; c.lifeTotal = opts.life; }
        _traktRender();
    }

    function _traktLifeTick() {
        const c = _traktCtx;
        if (!c || !_traktPanelEl) return;
        const paused = c.hover || c.view === 'submitting' || c.view === 'connect';
        c.remaining = traktTickLifetime(c.remaining, TRAKT_LIFE_TICK_MS, paused);
        _traktReposition();
        _traktPaintLife();
        const exp = _traktPanelEl.querySelector('.sc-trakt-expiry');
        if (exp && c.devExpiresAt) {
            const secs = Math.max(0, Math.round((c.devExpiresAt - Date.now()) / 1000));
            exp.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
        }
        if (c.remaining <= 0) traktClosePanel();   // auto-dismiss: the 'shown' outcome recorded at show time stands
    }

    function traktClosePanel() {
        const el = _traktPanelEl, c = _traktCtx;
        if (c && c.poll) c.poll.cancelled = true;
        clearInterval(_traktLifeTimer); _traktLifeTimer = null;
        if (_traktKeyHandler) { document.removeEventListener('keydown', _traktKeyHandler); _traktKeyHandler = null; }
        _traktCtx = null; _traktPanelEl = null;
        if (el) {
            el.classList.remove('sc-trakt-in');
            el.classList.add('sc-trakt-out');
            setTimeout(() => el.remove(), 350);
        }
    }

    async function _traktBeginConnect() {
        const c = _traktCtx;
        if (!c) return;
        _traktSetView('connect');                        // no c.dev yet -> "Contacting Trakt…"
        let dev;
        try { dev = await traktStartDeviceAuth(); }
        catch (e) {
            if (_traktCtx !== c) return;
            _traktSetView('error', { message: 'Couldn\'t start Trakt sign-in. Check your Client ID in Settings.', life: TRAKT_PANEL_LIFETIME_MS });
            return;
        }
        if (_traktCtx !== c) return;
        c.dev = dev;
        c.devExpiresAt = Date.now() + dev.expires_in * 1000;
        c.poll = { cancelled: false };
        _traktSetView('connect');
        const r = await traktPollDeviceToken(dev, c.poll);
        if (_traktCtx !== c || r === 'cancelled') return;
        c.dev = null; c.devExpiresAt = 0; c.poll = null;
        if (r === 'ok') { _traktBeginSubmit(); return; }
        const message = r === 'denied' ? 'Trakt sign-in was denied.'
            : r === 'expired' ? 'The code expired -- try again.'
            : 'Trakt sign-in failed. Check your Client Secret in Settings.';
        _traktSetView('error', { message, life: TRAKT_PANEL_LIFETIME_MS });
    }

    async function _traktBeginSubmit() {
        const c = _traktCtx;
        if (!c) return;
        if (!traktUsableToken(traktLoadToken(), traktClientId())) { _traktBeginConnect(); return; }
        _traktSetView('submitting');
        const out = await traktSubmit(c.snap, c.rating);
        if (_traktCtx !== c) return;                     // panel was closed while we waited
        if (out.result === 'added') {
            traktMarkPrompted(c.snap.imdbId, 'scrobbled');
            c.ratingFailed = out.ratingFailed;
            _traktSetView('success', { life: TRAKT_SUCCESS_MS });
        } else if (out.result === 'not_found') {
            _traktSetView('notfound', { life: TRAKT_PANEL_LIFETIME_MS });
        } else if (out.result === 'auth') {
            _traktBeginConnect();
        } else {
            _traktSetView('error', { message: 'Couldn\'t reach Trakt -- try again.', life: TRAKT_PANEL_LIFETIME_MS });
        }
    }

    function _traktOnAction(act) {
        const c = _traktCtx;
        if (!c) return;
        if (act === 'skip')          { traktMarkPrompted(c.snap.imdbId, 'skipped'); traktClosePanel(); return; }
        if (act === 'settings')      { traktClosePanel(); openSettingsModal(); return; }
        if (act === 'disconnect')    { traktClearToken(); _traktRender(); return; }
        if (act === 'cancelconnect') { if (c.poll) c.poll.cancelled = true; c.dev = null; c.devExpiresAt = 0; _traktSetView('prompt'); return; }
        if (act === 'scrobble' || act === 'retry') { _traktBeginSubmit(); }
    }

    function traktShowPanel(snap) {
        traktMarkPrompted(snap.imdbId, 'shown');         // survives reloads: no re-prompt for this movie for 12 h
        const el = document.createElement('div');
        el.id = 'sc-trakt-panel';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', 'Log this movie on Trakt');
        _traktPanelEl = el;
        const configured = !!(traktClientId() && traktSecret());
        _traktCtx = {
            snap, rating: 0, view: configured ? 'prompt' : 'needsconfig', message: '',
            remaining: TRAKT_PANEL_LIFETIME_MS, lifeTotal: TRAKT_PANEL_LIFETIME_MS,
            hover: false, dev: null, devExpiresAt: 0, poll: null, ratingFailed: false,
        };
        el.addEventListener('mouseenter', () => { if (_traktCtx) _traktCtx.hover = true; });
        el.addEventListener('mouseleave', () => { if (_traktCtx) _traktCtx.hover = false; });
        el.addEventListener('click', e => {
            if (!_traktCtx) return;
            const star = e.target.closest('[data-r]');
            if (star) {
                const n = parseInt(star.dataset.r, 10);
                _traktCtx.rating = _traktCtx.rating === n ? 0 : n;   // click the selected star again to clear
                _traktRender();
                return;
            }
            const a = e.target.closest('[data-act]');
            if (a) { e.preventDefault(); _traktOnAction(a.dataset.act); }
        });
        _traktKeyHandler = e => {
            if (e.key !== 'Escape' || !_traktCtx || _traktCtx.view === 'submitting') return;
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;   // don't steal Esc from chat/settings
            _traktOnAction('skip');
        };
        document.addEventListener('keydown', _traktKeyHandler);
        _traktHost().appendChild(el);
        _traktRender();
        _traktReposition();
        requestAnimationFrame(() => el.classList.add('sc-trakt-in'));
        _traktLifeTimer = setInterval(_traktLifeTick, TRAKT_LIFE_TICK_MS);
    }

    /* ==========================================================
       HEARTBEAT — same idiom as trivia-popup: poll shared state,
       re-read the settings every time (Save only writes localStorage).
    ========================================================== */
    function traktTick() {
        if (_traktPanelEl) return;
        const v = document.querySelector('#ytapiplayer video');   // strictly the player's own <video> (not preview/gif clones)
        if (!v) return;
        const eligible = traktShouldPrompt({
            enabled: traktEnabled(),
            isYouTube: isYouTubeMedia(),
            imdbId: _currentImdbId,
            duration: v.duration,
            currentTime: v.currentTime,
            thresholdPct: traktThreshold(),
            prompted: traktLoadPrompted(),
            now: Date.now(),
        });
        if (eligible) traktShowPanel(traktSnapshot());
    }

    function traktBoot() { setInterval(traktTick, TRAKT_POLL_MS); }
    scRegisterInit(traktBoot);

```

- [ ] **Step 3: Add the stylesheet to the manifest and bump the version**

In `src/pc/manifest.json`:

1. In the `trakt-scrobble` entry, add after the `"files": [...]` array:
```json
      "cssFiles": [
        "src/pc/modules/trakt-scrobble/style.css"
      ],
```
2. Change `"baseVersion": "4.13.18"` to `"baseVersion": "4.13.19"` (Tampermonkey won't reload the dev script unless this changes).

Then sync and rebuild:

```bash
cp src/pc/manifest.json docs/manifest.json
cmp src/pc/manifest.json docs/manifest.json && echo IDENTICAL
node scripts/build-dev-bundle.mjs
```
Expected: `IDENTICAL`; the build line lists `trakt-scrobble`.

- [ ] **Step 4: Verify everything that can be verified without a browser**

```bash
node scripts/test-trakt-scrobble.mjs
node --check src/pc/modules/trakt-scrobble/index.js && echo FRAGMENT_OK
node --check cytube.pc.dev.user.js && echo BUNDLE_OK
grep -c "sc-trakt-panel" cytube.pc.dev.user.js
grep -n "@version" cytube.pc.dev.user.js | head -2
grep -n "@connect.*api.trakt.tv\|@grant.*GM_xmlhttpRequest" cytube.pc.dev.user.js | head -3
grep -nP '[`]|\$\{|\\' src/pc/modules/trakt-scrobble/style.css || echo "CSS_CLEAN"
for f in scripts/test-*.mjs; do node "$f" >/dev/null 2>&1 && echo "PASS $f" || echo "FAIL $f"; done
```
Expected: test script prints `OK: …`; `FRAGMENT_OK`; `BUNDLE_OK`; a count `>= 1`; `@version` shows `4.13.19`; header lines for `api.trakt.tv` / `GM_xmlhttpRequest`; `CSS_CLEAN`; every existing `scripts/test-*.mjs` still `PASS` (if any of the *pre-existing* tests fail, check with `git stash`-free reasoning: they don't touch this module — report the failure rather than "fixing" unrelated code).

- [ ] **Step 5: Commit**

```bash
git add src/pc/modules/trakt-scrobble/index.js src/pc/modules/trakt-scrobble/style.css \
        src/pc/manifest.json docs/manifest.json
git commit -m "feat(trakt-scrobble): end-of-movie panel (bottom-right of video, 60s, dark glass) and heartbeat; bump to 4.13.19" \
           -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git status --short
git log --oneline -5
```
Expected: commit succeeds; `git status` shows only the user's pre-existing unrelated edits.

- [ ] **Step 6: Hand off for the live test (do not attempt to automate — needs Tampermonkey + a real Trakt app)**

Report to the user, verbatim checklist:

1. Reinstall/refresh `cytube.pc.dev.user.js` in Tampermonkey (it is now v4.13.19 — the version bump forces the reload) and open `https://cytu.be/r/testing`.
2. ⚙ Settings → the four new Trakt rows appear at the bottom of the feature list. Tick **Trakt: offer to log movies…**, paste the Client ID → **Test** shows ✓ (and ✗ for a garbage value); paste the Client Secret (shown as dots); leave the threshold at 90; **Save**.
3. Play a movie file (not YouTube), seek to ~91%. Within ~3 s a dark, semi-transparent card should slide in at the **bottom-right of the video**, with the poster, title/year, star row, **Scrobble to Trakt** / **Not now**, and a thin countdown line draining over 60 s (it should pause while hovered).
4. Pick a rating, click **Scrobble to Trakt** → the device code appears → approve at trakt.tv/activate → **Logged ✓**; confirm the watch (and rating) in your Trakt history.
5. Reload the page while still >90% → **no** second card. Try **Not now** / **Esc** on another movie; try leaving the card untouched for 60 s (it fades out on its own).
6. Untick the setting mid-movie → no card. Clear the secret → card shows "Trakt isn't set up yet" with **Open Settings**.

---

## Self-Review

**Spec coverage**
- Opt-in via config; keys in config → Task 3 (rows, masked secret) ✓
- Movies only / YouTube skipped → `traktShouldPrompt` (`isYouTube`), `#ytapiplayer video` in Task 4 ✓
- Threshold trigger (default 90, 50–100 configurable), min 10 min duration → Task 1 helpers, Task 3 number row ✓
- Once per movie, remembered across reloads, 12 h TTL, snapshot at trigger time → Task 1 (`traktShouldPrompt`), Task 2 (`traktMarkPrompted`), Task 4 (`traktSnapshot`, mark on show) ✓
- Device-code auth, refresh on near-expiry / 401, clientId mismatch discards token → Task 2 ✓
- `/sync/history` + `/sync/ratings`, `not_found` handling, rating failure non-fatal → Task 2 ✓
- Panel: bottom-right of the video, dark semi-transparent, blur, non-comic font stack, accent colour, 60 s with countdown line, hover pause, success 6 s → Task 1 (`traktPanelPosition`, `traktTickLifetime`), Task 4 (CSS + tick) ✓
- Views: prompt / submitting / success / error / not-found / connect / needs-config, Disconnect link, Esc, Not now → Task 4 ✓
- Settings "Test" button → Task 2 `validateTraktClientId`, Task 3 row ✓
- Manifest (`dependsOn`, `grants`, `connects`, features), both manifests, version bump → Tasks 3–4 ✓
- Tests via marker slices, repo convention → Tasks 1–2 ✓
- Out-of-scope items (episodes, live scrobble, don't-ask-again, …) → not implemented ✓

**Placeholder scan:** none — every code step has complete code; the only conditional instruction is the explicit fallback for `git add -p` in Task 3 Step 6.

**Type/name consistency:** helper and client names in Task 4 match Tasks 1–2 exactly (`traktShouldPrompt`, `traktPanelPosition`, `traktTickLifetime`, `traktUsableToken`, `traktLoadToken`, `traktClearToken`, `traktLoadPrompted`, `traktMarkPrompted`, `traktStartDeviceAuth`, `traktPollDeviceToken`, `traktSubmit`, `traktEnabled`, `traktThreshold`, `traktClientId`, `traktSecret`); constants `TRAKT_PANEL_LIFETIME_MS` / `TRAKT_SUCCESS_MS` are defined in the helpers slice and consumed in Task 4; settings rows use `TRAKT_THRESHOLD_MIN/MAX/DEFAULT` and `validateTraktClientId` as defined earlier; the test's `CLIENT_NAMES` all exist in the client slice; `traktPollDeviceToken(dev, handle, sleep?)` matches its use in both the tests and the panel.

**Known limitations (accepted, documented in code/spec):** a Retry after a lost *response* can double-log a watch (Trakt doesn't dedupe history adds); joining late or seeking past the threshold still prompts; the live end-to-end flow (real Trakt app + Tampermonkey) can only be verified by the user (Task 4, Step 6).
