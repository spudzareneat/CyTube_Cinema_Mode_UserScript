# Standalone Pop-up Video Userscript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `cytube.popupvideo.user.js` — a minimal standalone Tampermonkey script that runs only the pop-up trivia feature (curated timeline + catch-up + headshots + IMDb fallback) on stock CyTube, built from the same source files as the main script.

**Architecture:** Three pure code moves pull the shared pieces out of big files into `src/pc/shared/` (player helpers, IMDb title resolution, IMDb trivia fetch); the main manifest lists them, so the main bundle is byte-for-byte the same set of lines. `trivia-popup` gets four small `SC_POPUPVIDEO_STANDALONE` hooks. A new `scripts/build-popupvideo.mjs` reuses `scripts/assemble.mjs` with an in-memory manifest: shim + movie identity + shared files + trivia-popup + a tiny title watcher.

**Tech Stack:** Tampermonkey userscript fragments concatenated into one IIFE; Node built-ins only for build/tests (`node scripts/<name>.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-03-curated-popup-trivia-design.md` §4, as refined 2026-10-04 with the user: bare minimum (no trivia panel, no settings modal, no layout/styling), one small mute pill, default frequency **Frequent**, stand down when the main script's pop-ups module is present.

## Global Constraints

- Work on branch `feat/popupvideo-standalone` in a git worktree off `main`. `main`'s working tree has unrelated uncommitted WIP (README.md, core/05, core/14, core/16, emote-cache, gifmaker, scripts/test-emote-cache.mjs) — never touch, stage, or commit those. Every subagent first runs `git rev-parse --show-toplevel && git branch --show-current` and confirms the worktree + branch.
- Code moves must be **pure moves**: the assembled main bundle (`node scripts/build-dev-bundle.mjs`) must contain exactly the same multiset of lines before and after (verified by sorted-line diff, ignoring the `@version` header line).
- `src/pc/manifest.json` and `docs/manifest.json` stay identical.
- Main script version: bump both manifests' `baseVersion` to `4.13.56` in Task 2. Standalone has its own version `1.0.0` (in its build script).
- Standalone header: `@name Grindhouse Pop-up Video`, `@namespace http://tampermonkey.net/`, `@match https://cytu.be/r/420Grindhouse` and `https://cytu.be/r/testing`, `@grant GM_xmlhttpRequest`, `@connect caching.graphql.imdb.com`, `@connect raw.githubusercontent.com`, `@run-at document-start`, `@updateURL`/`@downloadURL` = `https://raw.githubusercontent.com/spudzareneat/CyTube_Cinema_Mode_UserScript/main/cytube.popupvideo.user.js`.
- Standalone defaults: pop-ups ON, frequency `frequent` when the user hasn't chosen one; mute pill only.
- Stand-down: if `<html data-sc-trivia-popup="1">` is present at the standalone's `load`, it does nothing (no watcher, no pops).
- Stage files by explicit path. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Bump-and-rebuild rule: Tampermonkey won't reload a dev build without a version change.

## Review Focus

1. Main script still identifies movies exactly as before after the moves (sorted-line equality + existing tests `test-runtime-demote`, `test-movie-identity`, `test-movie-override`, `test-fix-match-helpers`).
2. Both scripts installed → only the main script's bubbles (standalone stands down) (Task 3 smoke test "stand-down").
3. Main script installed WITHOUT the trivia-popup module (custom build) → marker absent → standalone runs normally (marker only set by trivia-popup).
4. Stock CyTube layout: bubbles stay over the video, mute pill visible and not hidden under chat (Task 3 CSS + live check).
5. Title changes rapidly / stale lookup resolves late → only the latest title's id is used (sequence token in watcher).

---

### Task 1: Pure moves into `src/pc/shared/`

**Files:**
- Create: `src/pc/shared/player-helpers.js`, `src/pc/shared/imdb-resolve.js`, `src/pc/shared/imdb-trivia-fetch.js`
- Modify: `src/pc/core/12-playback-sync-and-seek.js`, `src/pc/modules/movie-title-links/index.js`, `src/pc/modules/imdb-trivia/index.js`, `src/pc/manifest.json`, `docs/manifest.json`, `scripts/test-runtime-demote.mjs`

**Interfaces — Produces (unchanged names, new homes):**
- `player-helpers.js`: `currentMediaSeconds`, `currentMediaType`, `currentYtVideoId`, `parseTimeToSeconds`, `getCurrentMediaSeconds`, `isYouTubeMedia`, `getPlayerVideoEl`
- `imdb-resolve.js`: `IMDB_GQL`, `imdbGmFetch`, `imdbQuery`, `fetchImdbEpisodeInfo`, `IMDB_MAIN_SEARCH_QUERY`, `byVoteCountDesc`, `demoteByRuntime` (keep its `// ── test marker: slice start ──` / `slice end` comments), `imdbCandidateRuntimeMin`, `ROMAN_NUMERALS`, `normalizeTitle`, `TITLE_STOPWORDS`, `titleTokens`, `titlesMatch`, `imdbSearchTitle`, `IMDB_TITLE_FIELDS_QUERY`, `fetchImdbTitleFields`, `fetchImdbMovieByTitle`
- `imdb-trivia-fetch.js`: `_triviaCache`, `fetchImdbTrivia`, `_escHtml`

- [ ] **Step 1: Baseline.** `node scripts/build-dev-bundle.mjs && grep -v '^// @version' cytube.pc.dev.user.js | sort > /tmp-or-scratch/before.txt` (use a scratch path outside the repo, e.g. `$TMPDIR` or the session scratchpad). Run all `scripts/test-*.mjs`, all PASS.
- [ ] **Step 2: Move player helpers.** Cut from `src/pc/core/12-playback-sync-and-seek.js`: the three `let current…` lines + `parseTimeToSeconds` + `getCurrentMediaSeconds` (with its comments) + the `isYouTubeMedia` comment+function (top of file), and `getPlayerVideoEl` (inside the CHAT → MOVIE SEEK section). Paste into `src/pc/shared/player-helpers.js` in the same order, with a header comment: "Player/media helpers shared by core and the standalone Pop-up Video build." In BOTH manifests, insert `"src/pc/shared/player-helpers.js"` into the `core` module's `files` right after `"src/pc/core/01-movie-identity.js"`.
- [ ] **Step 3: Move IMDb resolution.** Cut from `src/pc/modules/movie-title-links/index.js`: `IMDB_GQL` + `imdbGmFetch` (incl. its comment block), `imdbQuery`, `fetchImdbEpisodeInfo`, and the contiguous block from the comment section above `IMDB_MAIN_SEARCH_QUERY` (≈ line 181) through the end of `fetchImdbMovieByTitle` (≈ line 489). Do NOT move `_domYtVideoId`, `fetchYtOembed`, `fetchImdbTitleGuide`, `LINK_DEFS`, or anything after `fetchImdbMovieByTitle`. Paste into `src/pc/shared/imdb-resolve.js` preserving order and comments. In BOTH manifests set the `movie-title-links` module's `files` to `["src/pc/shared/imdb-resolve.js", "src/pc/modules/movie-title-links/index.js"]`. In `scripts/test-runtime-demote.mjs` change the source path from `movie-title-links/index.js` to `src/pc/shared/imdb-resolve.js` (and its comments/error message).
- [ ] **Step 4: Move IMDb trivia fetch.** Cut `_triviaCache`, `fetchImdbTrivia`, `_escHtml` from `src/pc/modules/imdb-trivia/index.js` into `src/pc/shared/imdb-trivia-fetch.js`. In BOTH manifests set `imdb-trivia` `files` to `["src/pc/shared/imdb-trivia-fetch.js", "src/pc/modules/imdb-trivia/index.js"]`.
- [ ] **Step 5: Verify pure move.** Rebuild, `grep -v '^// @version' cytube.pc.dev.user.js | sort > after.txt`, `diff before.txt after.txt` → **no output**. All `scripts/test-*.mjs` PASS. `node -e "new Function(require('fs').readFileSync('cytube.pc.dev.user.js','utf8'))"` OK. `diff <(tr -d '\r' < src/pc/manifest.json) <(tr -d '\r' < docs/manifest.json)` → no output.
- [ ] **Step 6: Commit** (explicit paths: the 3 new files, 3 modified sources, 2 manifests, test-runtime-demote.mjs): `refactor: move player helpers, IMDb title resolution and IMDb trivia fetch into src/pc/shared (pure move)`.

---

### Task 2: Standalone hooks in `trivia-popup` (main behavior unchanged)

**Files:** Modify `src/pc/modules/trivia-popup/index.js`, `src/pc/modules/trivia-popup/style.css` (no change expected), both manifests (version).

**Interfaces — Consumes:** an optional global `SC_POPUPVIDEO_STANDALONE` (declared `const ... = true` only by the standalone shim, which is emitted first) and an optional `scPopupUsableArea()` returning `{left, top, right, bottom}` viewport px.

- [ ] **Step 1:** Near the top (after the header comment), add:
```js
    // True only inside the standalone Pop-up Video build (its shim declares the
    // const before this module). typeof on an undeclared name is safe.
    const TP_STANDALONE = typeof SC_POPUPVIDEO_STANDALONE !== 'undefined' && SC_POPUPVIDEO_STANDALONE === true;
    // Mark the page as soon as the main script's module loads (document-start),
    // so a standalone Pop-up Video script checking at its own `load` stands down.
    if (!TP_STANDALONE) document.documentElement.setAttribute('data-sc-trivia-popup', '1');
```
  and remove the `setAttribute('data-sc-trivia-popup', '1')` line (and its comment) from `triviaPopupBoot`.
- [ ] **Step 2:** `popupTriviaConfigured` → `() => TP_STANDALONE || getKey(LS_TRIVIA_POPUP_ENABLED) === 'on'`. `TP_FREQUENCY_DEFAULT` → `TP_STANDALONE ? 'frequent' : 'occasional'`.
- [ ] **Step 3:** In `_tpUsableArea`, first line: `if (typeof scPopupUsableArea === 'function') { const a = scPopupUsableArea(); if (a) return a; }` with a comment that the standalone defines it for stock CyTube's layout.
- [ ] **Step 4:** Bump both manifests to `4.13.56`; rebuild; all tests PASS; syntax OK; `grep -c "data-sc-trivia-popup" cytube.pc.dev.user.js` ≥ 1.
- [ ] **Step 5: Commit:** `feat(trivia-popup): standalone hooks (always-on, frequent default, usable-area hook, marker at load time); bump to 4.13.56`.

---

### Task 3: Standalone sources, build script, smoke test, docs

**Files:**
- Create: `src/popupvideo/header.template.js`, `src/popupvideo/shim.js`, `src/popupvideo/watcher.js`, `src/popupvideo/style.css`, `scripts/build-popupvideo.mjs`, `scripts/test-popupvideo-build.mjs`, `cytube.popupvideo.user.js` (generated, committed)
- Modify: `README.md` — **careful:** `main` has uncommitted README WIP; in the worktree README is the committed version. Add only an install bullet (see Step 6).

- [ ] **Step 1: `src/popupvideo/header.template.js`** — same shape as `src/pc/header.template.js` (read it) with the Global Constraints header values; keep `{{VERSION}}`, `{{GRANTS}}`, `{{CONNECTS}}`, `{{REQUIRES}}` placeholders; `@description  VH1 Pop-up Video style trivia bubbles for movies on the r/420Grindhouse CyTube channel — curated timed facts when available, IMDb trivia otherwise.`; add the `@updateURL`/`@downloadURL` lines.

- [ ] **Step 2: `src/popupvideo/shim.js`** (emitted first):
```js
    /* Standalone Pop-up Video shim: the few helpers trivia-popup expects from the
       main script's core, nothing else. */
    const SC_POPUPVIDEO_STANDALONE = true;
    const getKey = id => { try { return localStorage.getItem(id) || ''; } catch (e) { return ''; } };
    function injectCSS(id, css) {
        const add = () => { if (document.getElementById(id)) return; const s = document.createElement('style'); s.id = id; s.textContent = css; (document.head || document.documentElement).appendChild(s); };
        if (document.head) add(); else document.addEventListener('DOMContentLoaded', add);
    }
    function scRegisterSetting() {} // no settings modal in the standalone
    const _pvInits = [];
    function scRegisterInit(fn) { _pvInits.push(fn); }
    // Stand down if the full Grindhouse script's pop-up module is on this page
    // (it marks <html> at document-start); otherwise run every registered init.
    window.addEventListener('load', () => {
        if (document.documentElement.getAttribute('data-sc-trivia-popup') === '1') return;
        for (const fn of _pvInits) { try { fn(); } catch (e) { console.error('[popupvideo]', e); } }
    });
    // Stock CyTube layout: keep bubbles over the video area.
    function scPopupUsableArea() {
        const w = document.getElementById('videowrap');
        const r = w && w.getBoundingClientRect();
        if (!r || r.width < 50 || r.height < 50) return null;
        return { left: r.left + 8, top: r.top + 8, right: r.right - 8, bottom: r.bottom - 8 };
    }
```

- [ ] **Step 3: `src/popupvideo/watcher.js`** (emitted last):
```js
    /* Standalone title watcher: CyTube media title -> IMDb id, the minimum the
       pop-up module needs (_currentImdbId, _npData.episode). Same parser
       (core/01-movie-identity.js) and IMDb search (shared/imdb-resolve.js) as
       the main script; none of its links/cards/TMDB. */
    const LS_PV_ID_CACHE = 'sc_popupvideo_ids_v1';
    const PV_CACHE_MAX = 300;
    let _pvIdCache = (() => { try { return JSON.parse(localStorage.getItem(LS_PV_ID_CACHE)) || {}; } catch (e) { return {}; } })();
    let _pvSeq = 0;

    function _pvRemember(raw, id) {
        _pvIdCache[raw] = id;
        const keys = Object.keys(_pvIdCache);
        if (keys.length > PV_CACHE_MAX) for (const k of keys.slice(0, keys.length - PV_CACHE_MAX)) delete _pvIdCache[k];
        try { localStorage.setItem(LS_PV_ID_CACHE, JSON.stringify(_pvIdCache)); } catch (e) {}
    }

    async function pvResolveImdbId(raw, parsed, knownSeconds) {
        if (Object.prototype.hasOwnProperty.call(_pvIdCache, raw)) return _pvIdCache[raw];
        if (!parsed || !parsed.title) return null;
        const m = await imdbSearchTitle(parsed.title, parsed.year, knownSeconds);
        if (!m || !m.tconst) return null; // not cached: a later visit may resolve
        let id = m.tconst;
        if (parsed.season != null && parsed.episode != null) {
            const ep = await fetchImdbEpisodeInfo(id, parsed.season, parsed.episode);
            if (ep && ep.tconst) id = ep.tconst;
        }
        _pvRemember(raw, id);
        return id;
    }

    function _pvCleanTitle(t) {
        return String(t || '').replace(/^\s*(currently|now)\s+playing:\s*/i, '').trim();
    }

    function pvOnTitle(rawTitle) {
        const raw = _pvCleanTitle(rawTitle);
        if (!raw || /^nothing playing$/i.test(raw) || raw === lastMovieTitle) return;
        lastMovieTitle = raw;
        _currentImdbId = null;
        _npData = null;
        const old = document.getElementById('sc-trivia-popup-btn');
        if (old) old.remove();
        const seq = ++_pvSeq;
        if (isYouTubeMedia()) return; // bubbles never run on YouTube embeds
        const parsed = parseMovieFilename(raw);
        pvResolveImdbId(raw, parsed, getCurrentMediaSeconds()).then(id => {
            if (seq !== _pvSeq || !id) return;
            _npData = { episode: parsed && parsed.episode != null ? parsed.episode : null };
            _currentImdbId = id;
            if (typeof scRenderTriviaPopupBtn === 'function') scRenderTriviaPopupBtn();
        }).catch(() => {});
    }

    function _pvDomTitle() {
        const el = document.querySelector('#currenttitle, #videowrap-header .pull-left, #videowrap-header span, .video-title');
        return el ? el.textContent : '';
    }

    function pvWatcherBoot() {
        // Socket first (authoritative title + duration), DOM title as fallback / for
        // a page loaded mid-movie. Bound at load and again 2s later in case CyTube's
        // socket isn't up yet (same pattern as the main script's initMediaWatcher).
        let bound = false;
        const bind = () => {
            const s = (typeof socket !== 'undefined' && socket) || window.socket;
            if (bound || !s || typeof s.on !== 'function') return;
            bound = true;
            s.on('changeMedia', data => {
                currentMediaSeconds = Number(data && data.seconds) || 0;
                currentMediaType = (data && data.type) || '';
                if (data && data.title) pvOnTitle(data.title);
            });
        };
        bind();
        setTimeout(bind, 2000);
        pvOnTitle(_pvDomTitle());
        let polls = 0;
        const poll = setInterval(() => { pvOnTitle(_pvDomTitle()); if (++polls >= 14) clearInterval(poll); }, 1500);
    }
    scRegisterInit(pvWatcherBoot);
```

- [ ] **Step 4: `src/popupvideo/style.css`** (emitted after trivia-popup's CSS, so it wins):
```css
            /* Standalone: stock CyTube has no --sc-chat-w / top bar, so pin the
               mute pill to the top-right corner of the page. */
            #sc-trivia-popup-btn {
                position: fixed !important; top: 10px !important; right: 12px !important;
                left: auto !important; bottom: auto !important; z-index: 15600 !important;
            }
```

- [ ] **Step 5: `scripts/build-popupvideo.mjs`** — reuse `assemble` with an in-memory manifest; export `buildPopupVideo()` returning the string and write the file only when run directly:
```js
// scripts/build-popupvideo.mjs
//
// Builds cytube.popupvideo.user.js -- the standalone Pop-up Video userscript --
// from the same source files as the main script, via scripts/assemble.mjs.
//   node scripts/build-popupvideo.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemble } from './assemble.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

export const POPUPVIDEO_VERSION = '1.0.0';

export const POPUPVIDEO_MANIFEST = {
    headerTemplate: 'src/popupvideo/header.template.js',
    baseVersion: POPUPVIDEO_VERSION,
    modules: [
        { id: 'pv-shim', locked: true, files: ['src/popupvideo/shim.js'], grants: ['GM_xmlhttpRequest'], connects: ['caching.graphql.imdb.com', 'raw.githubusercontent.com'] },
        { id: 'pv-identity', locked: true, dependsOn: ['pv-shim'], files: ['src/pc/core/01-movie-identity.js', 'src/pc/shared/player-helpers.js'] },
        { id: 'pv-imdb', dependsOn: ['pv-identity'], files: ['src/pc/shared/imdb-resolve.js', 'src/pc/shared/imdb-trivia-fetch.js'] },
        { id: 'pv-popup', dependsOn: ['pv-imdb'], files: ['src/pc/modules/trivia-popup/index.js'], cssFiles: ['src/pc/modules/trivia-popup/style.css'] },
        { id: 'pv-watcher', dependsOn: ['pv-popup'], files: ['src/popupvideo/watcher.js'], cssFiles: ['src/popupvideo/style.css'] },
    ],
};

export function buildPopupVideo() {
    return assemble(POPUPVIDEO_MANIFEST, POPUPVIDEO_MANIFEST.modules.map(m => m.id), { baseDir: repoRoot });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const out = path.join(repoRoot, 'cytube.popupvideo.user.js');
    fs.writeFileSync(out, buildPopupVideo());
    console.log(`Wrote ${out} (v${POPUPVIDEO_VERSION})`);
}
```
  (Read `scripts/assemble.mjs` first and adapt only if its manifest field names differ — e.g. how `locked`, `dependsOn`, `cssFiles`, `grants`, `connects` are read and how emission order is decided. Shim must be emitted first and watcher last.)

- [ ] **Step 6: `scripts/test-popupvideo-build.mjs`** (write before running the build for real; it fails until Steps 1–5 exist):
```js
// scripts/test-popupvideo-build.mjs
//
// Builds the standalone Pop-up Video script in memory and checks: header,
// minimal contents, syntax, and that it boots / stands down in a stub DOM.
//   node scripts/test-popupvideo-build.mjs
import vm from 'node:vm';
import { buildPopupVideo, POPUPVIDEO_VERSION } from './build-popupvideo.mjs';

let failed = 0;
const ok = (label, cond) => { if (!cond) { console.error('FAIL:', label); failed++; } };

const src = buildPopupVideo();
ok('name', /\/\/ @name\s+Grindhouse Pop-up Video/.test(src));
ok('version', new RegExp(`// @version\\s+${POPUPVIDEO_VERSION.replace(/\./g, '\\.')}`).test(src));
ok('match 420Grindhouse', src.includes('// @match        https://cytu.be/r/420Grindhouse'));
ok('grant GM_xmlhttpRequest', /\/\/ @grant\s+GM_xmlhttpRequest/.test(src));
const connects = [...src.matchAll(/\/\/ @connect\s+(\S+)/g)].map(m => m[1]).sort();
ok('exactly the two connects', JSON.stringify(connects) === JSON.stringify(['caching.graphql.imdb.com', 'raw.githubusercontent.com']));
ok('no @require', !/\/\/ @require/.test(src));
for (const absent of ['showNowPlayingCard', 'openFixMatchModal', 'showTriviaCard', 'fetchTmdbPrimary', 'LINK_DEFS', 'initMediaWatcher']) {
    ok(`does not contain ${absent}`, !src.includes(absent));
}
for (const present of ['SC_POPUPVIDEO_STANDALONE', 'imdbSearchTitle', 'parseMovieFilename', 'tpDueFact', 'tpCatchUpFact', 'pvWatcherBoot']) {
    ok(`contains ${present}`, src.includes(present));
}
try { new Function(src); } catch (e) { ok('syntax: ' + e.message, false); }

// Boot in a stub browser. Returns what the socket saw bound.
function boot({ marker }) {
    const listeners = {};
    const socketOn = [];
    const attrs = marker ? { 'data-sc-trivia-popup': '1' } : {};
    const el = () => ({ style: { setProperty() {} }, classList: { add() {}, toggle() {}, contains: () => false }, addEventListener() {}, appendChild() {}, remove() {}, setAttribute() {}, querySelector: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }) });
    const store = {};
    const ctx = {
        console, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
        localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
        GM_xmlhttpRequest() {},
        socket: { on: (ev) => socketOn.push(ev) },
        document: {
            head: el(), body: el(),
            documentElement: { getAttribute: k => attrs[k] ?? null, setAttribute: (k, v) => { attrs[k] = v; } },
            createElement: el, createElementNS: el, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
            addEventListener() {}, hasFocus: () => true,
        },
        window: null,
        innerWidth: 1920, innerHeight: 1080,
    };
    ctx.window = { addEventListener: (ev, fn) => { (listeners[ev] ||= []).push(fn); }, ...ctx };
    ctx.addEventListener = ctx.window.addEventListener;
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    for (const fn of listeners.load || []) fn();
    return { socketOn, attrs };
}

const solo = boot({ marker: false });
ok('runs alone: binds changeMedia', solo.socketOn.includes('changeMedia'));
ok('standalone never sets the stand-down marker', solo.attrs['data-sc-trivia-popup'] !== '1');
const withMain = boot({ marker: true });
ok('stands down when main script marker present', withMain.socketOn.length === 0);

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('PASS: popupvideo standalone build — header, contents, syntax, boot, stand-down');
```
  Run it → FAIL before Steps 1–5 are in place (module not found / missing files); after → PASS. If the stub DOM is missing something the real boot touches, extend the stub (don't weaken the assertions) and note it in the report.

- [ ] **Step 7: Build + docs.** `node scripts/build-popupvideo.mjs` → writes `cytube.popupvideo.user.js`. Also run all `scripts/test-*.mjs` and `node scripts/build-dev-bundle.mjs` (main still builds). Add to `README.md` (worktree copy), in the install section next to the other standalone scripts, a bullet: "**Pop-up Video only** — `cytube.popupvideo.user.js`: just the VH1-style trivia bubbles (curated timed facts + IMDb fallback) on stock CyTube, nothing else. Stays off automatically if the full Grindhouse script with Pop-up Trivia is installed." Add to the spec §4 a short "Revised 2026-10-04" note listing the decisions in this plan's header.
- [ ] **Step 8: Commit** all new files + README + spec by explicit path: `feat: standalone Pop-up Video userscript (cytube.popupvideo.user.js) built from shared sources`.

---

## Verification (end-to-end, after merge)

- `for t in scripts/test-*.mjs; do node $t; done` all PASS; `node scripts/build-dev-bundle.mjs` and `node scripts/build-popupvideo.mjs` both succeed.
- User, live: disable the main Grindhouse script in Tampermonkey, install `cytube.popupvideo.user.js`, open cytu.be/r/420Grindhouse (stock layout). A "● Pop-ups" pill appears top-right once a movie is identified; curated movies pop at their times (Frequent), late-join catch-up and headshots work; clicking the pill mutes/resumes.
- Re-enable the main script (with Pop-up Trivia) alongside: only one stream of bubbles (standalone silent).
