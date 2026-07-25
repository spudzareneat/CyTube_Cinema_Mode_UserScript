# GIF Optimization Pass (gifsicle-wasm) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, default-on lossless GIF optimization pass (via `gifsicle` compiled to WebAssembly) that runs after encoding and before the result view, in both `cytube.pc.user.js` and `cytube.gifmaker.user.js`.

**Architecture:** Lazy-load `gifsicle-wasm-browser`'s script text via `GM_xmlhttpRequest` on first use (never `@require`, since it's ~35x heavier than what's already loaded), execute it to capture its `gifsicle` export, cache the result for the page session, then run `gifsicle.run({..., command: ['-O3 ...']})` on the encoded blob right after `encodeGif()` resolves. A toggle (shared `sc_gif_optimize` localStorage key, default on) controls whether this runs at all; any failure anywhere in the optimize step falls back silently to the original unoptimized blob.

**Tech Stack:** Tampermonkey userscripts (vanilla JS, no build step), `gifsicle-wasm-browser` (WASM, loaded from jsDelivr), existing `GM_xmlhttpRequest`/localStorage patterns already used for gif.js's worker and API keys.

## Global Constraints

- No automated test framework in this repo — verification is `node --check <file>.user.js` (syntax only) plus a code-reading self-review, matching every other task on this codebase's recent branches.
- Do NOT `@require` `gifsicle-wasm-browser` — it must be lazy-loaded via `GM_xmlhttpRequest` on first actual use, exactly like gif.js's own worker script already is in both files (`getGifWorkerUrl`). Loading it eagerly would add ~146KB gzip to every single page load for every visitor, regardless of whether they ever open the GIF maker.
- Exact URL to fetch: `https://cdn.jsdelivr.net/npm/gifsicle-wasm-browser@1.5.19/dist/gifsicle.min.js` (version pinned, not `@latest`, to avoid an unreviewed upstream change silently altering behavior).
- New `@connect` entry required in both scripts' userscript header: `cdn.jsdelivr.net`.
- Shared localStorage key across both scripts: `sc_gif_optimize`. Default **on** — read as `getKey(LS_GIF_OPTIMIZE) !== 'off'`, matching this codebase's existing convention for default-on toggles (`spellCheckEnabled`/`movieLinksEnabled` in `cytube.pc.user.js`), not the `=== 'on'` pattern used for the one existing default-*off* toggle (`lineupTimingEnabled`).
- Any failure in the optimize step (library fetch fails, `gifsicle.run()` throws/rejects, returns no output file) must fall back to the original unoptimized blob silently, with a `console.warn` for debugging. The optimize step must never throw out of `maybeOptimizeGif` and must never block or break the Make-GIF flow.
- `gifsicle.run()`'s command must be `-O3` only (lossless) — no `--lossy=N` flag, per the earlier design decision.
- Both tasks are independent (different files, no shared runtime state) and may be implemented in either order.

---

### Task 1: Add optimization pass to `cytube.pc.user.js`

**Files:**
- Modify: `cytube.pc.user.js`

**Interfaces:**
- Produces: `LS_GIF_OPTIMIZE` (localStorage key constant), `gifOptimizeEnabled()` (returns boolean), `getGifsicleCtor()` (returns `Promise<gifsicle object>`, cached), `maybeOptimizeGif(blob)` (returns `Promise<Blob>` — the optimized blob, or the original `blob` unchanged on any failure or when the setting is off).

- [ ] **Step 1: Add the `@connect` entry for jsDelivr**

Find:
```
// @connect      cdnjs.cloudflare.com
// @connect      api.imgbb.com
```
Replace:
```
// @connect      cdnjs.cloudflare.com
// @connect      cdn.jsdelivr.net
// @connect      api.imgbb.com
```

- [ ] **Step 2: Add the `LS_GIF_OPTIMIZE` constant and `gifOptimizeEnabled()` helper**

Find:
```js
    const LS_CHAT_TEXTAREA_H = 'sc_chat_textarea_h'; // px — manually resized chat entry height
    const getKey   = id => localStorage.getItem(id) || '';
    const setKey   = (id, v) => localStorage.setItem(id, v.trim());
    const hasKey   = id => !!getKey(id);
    const spellCheckEnabled  = () => getKey(LS_SPELLCHECK)  !== 'off';
    const movieLinksEnabled  = () => getKey(LS_MOVIE_LINKS) !== 'off';
    const lineupTimingEnabled = () => getKey(LS_LINEUP_TIMING) === 'on'; // opt-in, unlike the toggles above
```
Replace:
```js
    const LS_CHAT_TEXTAREA_H = 'sc_chat_textarea_h'; // px — manually resized chat entry height
    const LS_GIF_OPTIMIZE = 'sc_gif_optimize'; // shared with cytube.gifmaker.user.js
    const getKey   = id => localStorage.getItem(id) || '';
    const setKey   = (id, v) => localStorage.setItem(id, v.trim());
    const hasKey   = id => !!getKey(id);
    const spellCheckEnabled  = () => getKey(LS_SPELLCHECK)  !== 'off';
    const movieLinksEnabled  = () => getKey(LS_MOVIE_LINKS) !== 'off';
    const lineupTimingEnabled = () => getKey(LS_LINEUP_TIMING) === 'on'; // opt-in, unlike the toggles above
    const gifOptimizeEnabled = () => getKey(LS_GIF_OPTIMIZE) !== 'off'; // default ON, like spellcheck/movielinks
```

- [ ] **Step 3: Add `getGifsicleCtor()` right after `getGifCtor()`**

Find:
```js
    function getGifCtor() {
        if (typeof GIF !== 'undefined') return GIF;
        if (typeof window !== 'undefined' && window.GIF) return window.GIF;
        return null;
    }
```
Replace:
```js
    function getGifCtor() {
        if (typeof GIF !== 'undefined') return GIF;
        if (typeof window !== 'undefined' && window.GIF) return window.GIF;
        return null;
    }

    // gifsicle-wasm-browser is ~35x the size of gif.js — lazy-fetch it only
    // when a GIF is actually being optimized, never @require it. It assigns
    // a bare top-level `let gifsicle = {...}`; running its source inside a
    // Function body whose own last statement returns that binding captures
    // the export without touching any outer/global scope.
    const GIFSICLE_URL = 'https://cdn.jsdelivr.net/npm/gifsicle-wasm-browser@1.5.19/dist/gifsicle.min.js';
    let _gifsicleCtor = null;
    function getGifsicleCtor() {
        if (_gifsicleCtor) return Promise.resolve(_gifsicleCtor);
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url: GIFSICLE_URL,
                onload: r => {
                    if (r.status < 200 || r.status >= 300) { reject(new Error('gifsicle HTTP ' + r.status)); return; }
                    try {
                        _gifsicleCtor = new Function(r.responseText + '\n;return typeof gifsicle !== "undefined" ? gifsicle : null;')();
                        if (!_gifsicleCtor) { reject(new Error('gifsicle export not found')); return; }
                        resolve(_gifsicleCtor);
                    } catch (e) { reject(e); }
                },
                onerror: () => reject(new Error('gifsicle fetch failed')),
            });
        });
    }
```

- [ ] **Step 4: Add `maybeOptimizeGif()` right after `encodeGif()`**

Find:
```js
    function encodeGif({ frames, w, h, delay }, onProgress) {
        return getGifWorkerUrl().then(workerScript => new Promise((resolve, reject) => {
            const Ctor = getGifCtor();
            if (!Ctor) { reject(new Error('gif.js not loaded (@require missing?)')); return; }
            const gif = new Ctor({ workers: 2, quality: 10, width: w, height: h, workerScript, repeat: 0 });
            frames.forEach(f => gif.addFrame(f, { delay }));
            gif.on('progress', p => onProgress && onProgress(p));
            gif.on('finished', blob => resolve(blob));
            gif.on('abort', () => reject(new Error('encode aborted')));
            gif.render();
        }));
    }

    let _gifResultUrl = null;
```
Replace:
```js
    function encodeGif({ frames, w, h, delay }, onProgress) {
        return getGifWorkerUrl().then(workerScript => new Promise((resolve, reject) => {
            const Ctor = getGifCtor();
            if (!Ctor) { reject(new Error('gif.js not loaded (@require missing?)')); return; }
            const gif = new Ctor({ workers: 2, quality: 10, width: w, height: h, workerScript, repeat: 0 });
            frames.forEach(f => gif.addFrame(f, { delay }));
            gif.on('progress', p => onProgress && onProgress(p));
            gif.on('finished', blob => resolve(blob));
            gif.on('abort', () => reject(new Error('encode aborted')));
            gif.render();
        }));
    }

    // Optional lossless size-shrink via gifsicle -O3, run after encodeGif().
    // Any failure anywhere in here falls back to the original blob silently
    // — this step is strictly additive and must never break Make GIF.
    async function maybeOptimizeGif(blob) {
        if (!gifOptimizeEnabled()) return blob;
        try {
            const gifsicle = await getGifsicleCtor();
            const out = await gifsicle.run({
                input: [{ file: blob, name: 'in.gif' }],
                command: ['-O3 in.gif -o /out/out.gif'],
            });
            return (out && out[0]) ? out[0] : blob;
        } catch (e) {
            console.warn('[SC] GIF optimize failed, using unoptimized output:', e);
            return blob;
        }
    }

    let _gifResultUrl = null;
```

- [ ] **Step 5: Add the settings modal checkbox row**

Find:
```html
                <div class="sc-settings-group sc-settings-toggle-group">
                    <label class="sc-settings-toggle-label">
                        <span class="sc-toggle-row">
                            <input type="checkbox" id="sc-input-movielinks" ${movieLinksEnabled() ? 'checked' : ''} />
                            <span class="sc-toggle-text">Show movie links (IMDb / Letterboxd / Wiki)</span>
                        </span>
                        <span class="sc-settings-note">Adds clickable badge icons next to the title</span>
                    </label>
                </div>

                <div class="sc-settings-group sc-settings-divider">
```
Replace:
```html
                <div class="sc-settings-group sc-settings-toggle-group">
                    <label class="sc-settings-toggle-label">
                        <span class="sc-toggle-row">
                            <input type="checkbox" id="sc-input-movielinks" ${movieLinksEnabled() ? 'checked' : ''} />
                            <span class="sc-toggle-text">Show movie links (IMDb / Letterboxd / Wiki)</span>
                        </span>
                        <span class="sc-settings-note">Adds clickable badge icons next to the title</span>
                    </label>
                </div>

                <div class="sc-settings-group sc-settings-toggle-group">
                    <label class="sc-settings-toggle-label">
                        <span class="sc-toggle-row">
                            <input type="checkbox" id="sc-input-gifoptimize" ${gifOptimizeEnabled() ? 'checked' : ''} />
                            <span class="sc-toggle-text">Optimize GIFs before upload</span>
                        </span>
                        <span class="sc-settings-note">Losslessly shrinks the file with gifsicle before Download/Upload — adds a couple seconds</span>
                    </label>
                </div>

                <div class="sc-settings-group sc-settings-divider">
```

- [ ] **Step 6: Save the new checkbox in the settings-save handler**

Find:
```js
            const spell  = document.getElementById('sc-input-spellcheck').checked;
            const links  = document.getElementById('sc-input-movielinks').checked;
            const lineupTiming = document.getElementById('sc-input-lineuptiming').checked;
            const imgbb  = document.getElementById('sc-input-imgbb').value.trim();
            const fontPx = parseInt(fontInput.value, 10);
            setKey(LS_TMDB,        tmdb);
            setKey(LS_SPELLCHECK,  spell ? 'on' : 'off');
            setKey(LS_MOVIE_LINKS, links ? 'on' : 'off');
            setKey(LS_LINEUP_TIMING, lineupTiming ? 'on' : 'off');
            setKey(LS_IMGBB,       imgbb);
```
Replace:
```js
            const spell  = document.getElementById('sc-input-spellcheck').checked;
            const links  = document.getElementById('sc-input-movielinks').checked;
            const lineupTiming = document.getElementById('sc-input-lineuptiming').checked;
            const gifOptimize = document.getElementById('sc-input-gifoptimize').checked;
            const imgbb  = document.getElementById('sc-input-imgbb').value.trim();
            const fontPx = parseInt(fontInput.value, 10);
            setKey(LS_TMDB,        tmdb);
            setKey(LS_SPELLCHECK,  spell ? 'on' : 'off');
            setKey(LS_MOVIE_LINKS, links ? 'on' : 'off');
            setKey(LS_LINEUP_TIMING, lineupTiming ? 'on' : 'off');
            setKey(LS_GIF_OPTIMIZE, gifOptimize ? 'on' : 'off');
            setKey(LS_IMGBB,       imgbb);
```

- [ ] **Step 7: Call `maybeOptimizeGif()` in the Make-GIF flow**

Find:
```js
                setWork('Encoding GIF… (' + cap.frames.length + ' frames)');
                const blob = await encodeGif(cap, p => setWork('Encoding GIF… ' + Math.round(p * 100) + '%'));
                _gifResultUrl = URL.createObjectURL(blob);
```
Replace:
```js
                setWork('Encoding GIF… (' + cap.frames.length + ' frames)');
                let blob = await encodeGif(cap, p => setWork('Encoding GIF… ' + Math.round(p * 100) + '%'));
                if (gifOptimizeEnabled()) setWork('Optimizing…');
                blob = await maybeOptimizeGif(blob);
                _gifResultUrl = URL.createObjectURL(blob);
```

Note: `blob` is referenced later in this same handler by the Upload button's click listener (closure) — changing `const` to `let` and reassigning here means Upload automatically uses the optimized blob. Do not introduce a second variable name.

- [ ] **Step 8: Verify syntax**

Run: `node --check cytube.pc.user.js`
Expected: no output, exit code 0.

- [ ] **Step 9: Self-review**

Trace through and confirm:
1. `@connect cdn.jsdelivr.net` was added, not replacing any existing `@connect` line.
2. `LS_GIF_OPTIMIZE` and `gifOptimizeEnabled` follow the `!== 'off'` (default-on) convention, not `=== 'on'`.
3. `getGifsicleCtor()` caches `_gifsicleCtor` and returns the cached promise-wrapped value on subsequent calls — it does not re-fetch on every GIF.
4. `maybeOptimizeGif()` has no code path that throws or rejects out of the function itself — every branch either returns a blob or is inside the try/catch.
5. The settings modal checkbox reflects `gifOptimizeEnabled()` on open and is saved correctly on Save, using the same `id`/read/write pattern as its `sc-input-movielinks` sibling.
6. `blob` in the goBtn handler is declared with `let` (not `const`) and the Upload button's closure still correctly references the same variable — no shadowing, no separate `optimizedBlob` variable introduced.
7. No leftover reference to a `const blob` in this handler.

- [ ] **Step 10: Commit**

```bash
git add cytube.pc.user.js
git commit -m "Add optional gifsicle-wasm optimization pass to the GIF Maker, default on"
```

---

### Task 2: Add optimization pass to `cytube.gifmaker.user.js`

**Files:**
- Modify: `cytube.gifmaker.user.js`

**Interfaces:**
- Produces: same four symbols as Task 1 (`LS_GIF_OPTIMIZE`, `gifOptimizeEnabled()`, `getGifsicleCtor()`, `maybeOptimizeGif(blob)`), independently defined in this file (no shared module — these are two separate userscripts).
- Consumes: nothing from Task 1; this task is fully independent.

- [ ] **Step 1: Add the `@connect` entry for jsDelivr**

Find:
```
// @connect      cdnjs.cloudflare.com
// @connect      api.imgbb.com
```
Replace:
```
// @connect      cdnjs.cloudflare.com
// @connect      cdn.jsdelivr.net
// @connect      api.imgbb.com
```

- [ ] **Step 2: Add the `LS_GIF_OPTIMIZE` constant and `gifOptimizeEnabled()` helper**

Find:
```js
    const LS_IMGBB = 'sc_imgbb_key';
    const getKey = id => localStorage.getItem(id) || '';
    const setKey = (id, v) => localStorage.setItem(id, v.trim());
```
Replace:
```js
    const LS_IMGBB = 'sc_imgbb_key';
    const LS_GIF_OPTIMIZE = 'sc_gif_optimize'; // shared with cytube.pc.user.js
    const getKey = id => localStorage.getItem(id) || '';
    const setKey = (id, v) => localStorage.setItem(id, v.trim());
    const gifOptimizeEnabled = () => getKey(LS_GIF_OPTIMIZE) !== 'off'; // default ON
```

- [ ] **Step 3: Add `getGifsicleCtor()` right after `getGifCtor()`**

Find:
```js
    function getGifCtor() {
        if (typeof GIF !== 'undefined') return GIF;
        if (typeof window !== 'undefined' && window.GIF) return window.GIF;
        return null;
    }
    function encodeGif({ frames, w, h, delay }, onProgress) {
```
Replace:
```js
    function getGifCtor() {
        if (typeof GIF !== 'undefined') return GIF;
        if (typeof window !== 'undefined' && window.GIF) return window.GIF;
        return null;
    }

    // gifsicle-wasm-browser is ~35x the size of gif.js — lazy-fetch it only
    // when a GIF is actually being optimized, never @require it. It assigns
    // a bare top-level `let gifsicle = {...}`; running its source inside a
    // Function body whose own last statement returns that binding captures
    // the export without touching any outer/global scope.
    const GIFSICLE_URL = 'https://cdn.jsdelivr.net/npm/gifsicle-wasm-browser@1.5.19/dist/gifsicle.min.js';
    let _gifsicleCtor = null;
    function getGifsicleCtor() {
        if (_gifsicleCtor) return Promise.resolve(_gifsicleCtor);
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url: GIFSICLE_URL,
                onload: r => {
                    if (r.status < 200 || r.status >= 300) { reject(new Error('gifsicle HTTP ' + r.status)); return; }
                    try {
                        _gifsicleCtor = new Function(r.responseText + '\n;return typeof gifsicle !== "undefined" ? gifsicle : null;')();
                        if (!_gifsicleCtor) { reject(new Error('gifsicle export not found')); return; }
                        resolve(_gifsicleCtor);
                    } catch (e) { reject(e); }
                },
                onerror: () => reject(new Error('gifsicle fetch failed')),
            });
        });
    }

    function encodeGif({ frames, w, h, delay }, onProgress) {
```

- [ ] **Step 4: Add `maybeOptimizeGif()` right after `encodeGif()`**

Find:
```js
    function encodeGif({ frames, w, h, delay }, onProgress) {
        return getGifWorkerUrl().then(workerScript => new Promise((resolve, reject) => {
            const Ctor = getGifCtor();
            if (!Ctor) { reject(new Error('gif.js not loaded (@require missing?)')); return; }
            const gif = new Ctor({ workers: 2, quality: 10, width: w, height: h, workerScript, repeat: 0 });
            frames.forEach(f => gif.addFrame(f, { delay }));
            gif.on('progress', p => onProgress && onProgress(p));
            gif.on('finished', blob => resolve(blob));
            gif.on('abort', () => reject(new Error('encode aborted')));
            gif.render();
        }));
    }

    let _gifResultUrl = null;
```
Replace:
```js
    function encodeGif({ frames, w, h, delay }, onProgress) {
        return getGifWorkerUrl().then(workerScript => new Promise((resolve, reject) => {
            const Ctor = getGifCtor();
            if (!Ctor) { reject(new Error('gif.js not loaded (@require missing?)')); return; }
            const gif = new Ctor({ workers: 2, quality: 10, width: w, height: h, workerScript, repeat: 0 });
            frames.forEach(f => gif.addFrame(f, { delay }));
            gif.on('progress', p => onProgress && onProgress(p));
            gif.on('finished', blob => resolve(blob));
            gif.on('abort', () => reject(new Error('encode aborted')));
            gif.render();
        }));
    }

    // Optional lossless size-shrink via gifsicle -O3, run after encodeGif().
    // Any failure anywhere in here falls back to the original blob silently
    // — this step is strictly additive and must never break Make GIF.
    async function maybeOptimizeGif(blob) {
        if (!gifOptimizeEnabled()) return blob;
        try {
            const gifsicle = await getGifsicleCtor();
            const out = await gifsicle.run({
                input: [{ file: blob, name: 'in.gif' }],
                command: ['-O3 in.gif -o /out/out.gif'],
            });
            return (out && out[0]) ? out[0] : blob;
        } catch (e) {
            console.warn('[GIFMaker] GIF optimize failed, using unoptimized output:', e);
            return blob;
        }
    }

    let _gifResultUrl = null;
```

- [ ] **Step 5: Add the inline checkbox row's CSS**

Find:
```css
            .sc-gif-imgbb-status { font-size: 11px !important; min-height: 13px !important; }
```
Replace:
```css
            .sc-gif-imgbb-status { font-size: 11px !important; min-height: 13px !important; }
            .sc-gif-optimize-row { display: flex !important; align-items: center !important; gap: 6px !important; }
            .sc-gif-optimize-row label { color: rgba(255,255,255,0.8) !important; font-size: 12px !important; }
```

- [ ] **Step 6: Add the inline checkbox row's markup, right above the Make GIF button**

Find:
```html
                <button id="sc-gif-go" type="button">● Make GIF</button>
```
Replace:
```html
                <div class="sc-gif-optimize-row">
                    <input type="checkbox" id="sc-gif-optimize" ${gifOptimizeEnabled() ? 'checked' : ''} />
                    <label for="sc-gif-optimize">Optimize GIF before upload</label>
                </div>
                <button id="sc-gif-go" type="button">● Make GIF</button>
```

- [ ] **Step 7: Wire the checkbox to persist on change**

Find:
```js
        const $ = id => panel.querySelector(id);
        const goBtn = $('#sc-gif-go'), status = $('#sc-gif-status'), result = $('#sc-gif-result');
        $('#sc-gif-overview-total').textContent = isFinite(vidDur) ? _fmtClockTenths(vidDur) : '';
```
Replace:
```js
        const $ = id => panel.querySelector(id);
        const goBtn = $('#sc-gif-go'), status = $('#sc-gif-status'), result = $('#sc-gif-result');
        $('#sc-gif-overview-total').textContent = isFinite(vidDur) ? _fmtClockTenths(vidDur) : '';
        const optimizeCheckbox = $('#sc-gif-optimize');
        optimizeCheckbox.addEventListener('change', () => {
            setKey(LS_GIF_OPTIMIZE, optimizeCheckbox.checked ? 'on' : 'off');
        });
```

- [ ] **Step 8: Call `maybeOptimizeGif()` in the Make-GIF flow**

Find:
```js
                setWork('Encoding GIF… (' + cap.frames.length + ' frames)');
                const blob = await encodeGif(cap, p => setWork('Encoding GIF… ' + Math.round(p * 100) + '%'));
                _gifResultUrl = URL.createObjectURL(blob);
```
Replace:
```js
                setWork('Encoding GIF… (' + cap.frames.length + ' frames)');
                let blob = await encodeGif(cap, p => setWork('Encoding GIF… ' + Math.round(p * 100) + '%'));
                if (gifOptimizeEnabled()) setWork('Optimizing…');
                blob = await maybeOptimizeGif(blob);
                _gifResultUrl = URL.createObjectURL(blob);
```

Note: same closure consideration as Task 1 Step 7 — `blob` is used later in this same handler by the Upload button's click listener; `let` + reassignment means Upload automatically picks up the optimized blob.

- [ ] **Step 9: Verify syntax**

Run: `node --check cytube.gifmaker.user.js`
Expected: no output, exit code 0.

- [ ] **Step 10: Self-review**

Trace through and confirm:
1. `@connect cdn.jsdelivr.net` was added, not replacing any existing `@connect` line.
2. `gifOptimizeEnabled` follows the `!== 'off'` (default-on) convention.
3. `getGifsicleCtor()` caches `_gifsicleCtor` and returns the cached value on subsequent calls.
4. `maybeOptimizeGif()` has no code path that throws or rejects out of the function itself.
5. The new checkbox's `change` handler persists to the same `LS_GIF_OPTIMIZE` key Task 1 uses in `cytube.pc.user.js` — same key name, same `'on'`/`'off'` string values, so toggling it in one script and reloading the other reflects the change.
6. `blob` in the goBtn handler is declared with `let` (not `const`) and the Upload button's closure still correctly references the same variable.
7. The `hasImgbbKey` conditional result-view logic (Download always shown, Upload only if a key is saved) is unchanged by this diff — this task must not touch that logic at all.
8. No leftover reference to a `const blob` in this handler.

- [ ] **Step 11: Commit**

```bash
git add cytube.gifmaker.user.js
git commit -m "Add optional gifsicle-wasm optimization pass to the GIF Maker, default on"
```
