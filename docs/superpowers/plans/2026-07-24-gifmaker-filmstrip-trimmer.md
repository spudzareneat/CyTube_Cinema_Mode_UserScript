# GIF Maker Filmstrip Trimmer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `cytube.gifmaker.user.js`'s single-scrubber trim UI (moving START always resets END to `START+2s`) with a dual-handle filmstrip trimmer, and consolidate meme-caption drag handles onto the START preview frame only (END becomes a read-only mirror).

**Architecture:** Both changes live entirely inside the existing `openGifPanel()` function and `injectPanelCss()` in `cytube.gifmaker.user.js` — no new files, no changes to any other script. The filmstrip is a sticky-window widget (state persists across renders, only reframes/refetches when a handle nears the window edge) driven by the same `grabPreviewFrame()` hidden-clone frame-grabber the two large previews already use.

**Tech Stack:** Vanilla JS (matches the rest of the file), Pointer Events for drag, CSS custom properties + `!important` rules (matching the file's existing convention throughout `injectPanelCss()`).

## Global Constraints

- This repo has no automated test framework — verification is `node --check <file>` (syntax only) plus manual browser testing, which is not available to implementer/reviewer subagents (no live cytu.be session, no Tampermonkey). Every task's "test" step is `node --check cytube.gifmaker.user.js`, plus a careful code-reading self-review tracing through the manual-verification checklist instead of actually running it in a browser — the human will do that live-QA pass separately (this matches how the prior branch's tasks were executed and reviewed).
- Only `cytube.gifmaker.user.js` is touched. Do not modify `cytube.pc.user.js` or any other file.
- Exact constants (copied verbatim from the design spec — do not substitute different values):
  `MIN_CLIP_GAP = 0.1`, `MAX_CLIP_LEN = 10`, `FILMSTRIP_MARGIN = 3`, `FILMSTRIP_MIN_WINDOW = 12`, `FILMSTRIP_EDGE_PAD = 1`, `FILMSTRIP_TILES = 10`.
- The filmstrip window (`_filmstripWindow`) is **sticky state** — it must NOT be recomputed from `startT`/`endT` on every render (that would shift the window on nearly every drag tick and defeat the debounced-refetch optimization). It only recomputes when `ensureFilmstripWindow()` determines a handle has drifted within `FILMSTRIP_EDGE_PAD` of the current window's edge.
- Filmstrip tile thumbnails are generated via the existing `grabPreviewFrame(src, time, w)` — no new frame-capture mechanism.
- Caption handles (`.sc-gif-cap-handle-*`) exist only on the START thumbnail after this work. The END thumbnail keeps its caption **text** overlay elements (so the mirrored preview still renders) but has no drag handles and gets a `sc-gif-thumb-readonly` CSS class. The underlying caption render pipeline (`drawCaptions`, `captureGifFrames`, shared `capPos` state) is unchanged — this is a UI-only simplification.

---

### Task 1: Filmstrip trim UI

**Files:**
- Modify: `cytube.gifmaker.user.js` (inside `openGifPanel()` and `injectPanelCss()`)

**Interfaces:**
- Consumes: `grabPreviewFrame(src, time, w)`, `_fmtClockTenths(sec)`, `getPlayerVideoEl()` (all pre-existing, unchanged).
- Produces (all scoped inside `openGifPanel`, as closures over `startT`/`endT`/`vidDur`/`src`/`isBlob`/`panel`, matching the existing style of `render`/`clampStart`/`clampEnd`): `ensureFilmstripWindow()` (returns bool — whether the window was reframed), `renderFilmstripHandles()`, `scheduleFilmstripRefresh()`, `wireFilmstripDrag(handleEl, which)`. Also produces module-level constants `MIN_CLIP_GAP`, `MAX_CLIP_LEN`, `FILMSTRIP_MARGIN`, `FILMSTRIP_MIN_WINDOW`, `FILMSTRIP_EDGE_PAD`, `FILMSTRIP_TILES` (declared just above `openGifPanel`, available to Task 2 without any further work).
- Removes: `resetEndFromStart()`, the `#sc-gif-scrub-start` range input and its wiring, `.sc-gif-scrub-spacer`, and their CSS (`.sc-gif-scrub`, `.sc-gif-scrub:disabled`, `.sc-gif-scrub-spacer`).

- [ ] **Step 1: Add module-level constants above `openGifPanel`**

Find this exact block:

```js
    /* ==========================================================
       GIF PANEL
    ========================================================== */
    function openGifPanel(initialSec) {
```

Replace with:

```js
    /* ==========================================================
       GIF PANEL
    ========================================================== */
    const MIN_CLIP_GAP = 0.1;
    const MAX_CLIP_LEN = 10;
    const FILMSTRIP_MARGIN = 3;
    const FILMSTRIP_MIN_WINDOW = 12;
    const FILMSTRIP_EDGE_PAD = 1;
    const FILMSTRIP_TILES = 10;

    function openGifPanel(initialSec) {
```

- [ ] **Step 2: Add the sticky filmstrip-window state variable**

Find this exact block:

```js
        const DEFAULT_CLIP_LEN = 2;
        let startT = Math.max(0, now - DEFAULT_CLIP_LEN);
        let endT = Math.min(vidDur, startT + DEFAULT_CLIP_LEN);
```

Replace with:

```js
        const DEFAULT_CLIP_LEN = 2;
        let startT = Math.max(0, now - DEFAULT_CLIP_LEN);
        let endT = Math.min(vidDur, startT + DEFAULT_CLIP_LEN);
        let _filmstripWindow = null; // { windowStart, windowEnd } — sticky across renders
```

- [ ] **Step 3: Insert the filmstrip HTML block above the marks row**

Find this exact block:

```js
            <div id="sc-gif-body">
                <div class="sc-gif-marks">
```

Replace with:

```js
            <div id="sc-gif-body">
                <div class="sc-gif-filmstrip">
                    <div class="sc-gif-filmstrip-window-label">Window: <span id="sc-gif-filmstrip-range"></span></div>
                    <div class="sc-gif-filmstrip-strip" id="sc-gif-filmstrip-strip">
                        <div class="sc-gif-filmstrip-tiles" id="sc-gif-filmstrip-tiles"></div>
                        <div class="sc-gif-filmstrip-dim-left" id="sc-gif-filmstrip-dim-left"></div>
                        <div class="sc-gif-filmstrip-dim-right" id="sc-gif-filmstrip-dim-right"></div>
                        <div class="sc-gif-filmstrip-selection" id="sc-gif-filmstrip-selection"></div>
                        <div class="sc-gif-filmstrip-handle" id="sc-gif-filmstrip-handle-start" data-handle="start" title="Drag: start"><div class="sc-gif-filmstrip-handle-grip"></div></div>
                        <div class="sc-gif-filmstrip-handle" id="sc-gif-filmstrip-handle-end" data-handle="end" title="Drag: end"><div class="sc-gif-filmstrip-handle-grip"></div></div>
                    </div>
                </div>
                <div class="sc-gif-marks">
```

- [ ] **Step 4: Remove the old START scrubber input**

Find this exact block:

```js
                        <input type="range" class="sc-gif-scrub" id="sc-gif-scrub-start" min="0" max="0" step="0.1" value="0">
                        <div class="sc-gif-mark-label">START · <span id="sc-gif-time-start"></span></div>
```

Replace with:

```js
                        <div class="sc-gif-mark-label">START · <span id="sc-gif-time-start"></span></div>
```

- [ ] **Step 5: Remove the old END scrub spacer**

Find this exact block:

```js
                        <div class="sc-gif-scrub-spacer"></div>
                        <div class="sc-gif-mark-label">END · <span id="sc-gif-time-end"></span></div>
```

Replace with:

```js
                        <div class="sc-gif-mark-label">END · <span id="sc-gif-time-end"></span></div>
```

- [ ] **Step 6: Replace the old `scrubStart` wiring with the filmstrip functions, and update `render()`**

Find this exact block:

```js
        const scrubStart = $('#sc-gif-scrub-start');
        scrubStart.max = isFinite(vidDur) ? vidDur : 0;
        scrubStart.disabled = isBlob || !src || !isFinite(vidDur);

        const render = (changed) => {
            $('#sc-gif-time-start').textContent = _fmtClockTenths(startT);
            $('#sc-gif-time-end').textContent = _fmtClockTenths(endT);
            scrubStart.value = startT.toFixed(1);
            const dur = Math.max(0, endT - startT);
            $('#sc-gif-dur-val').textContent = dur.toFixed(1) + 's';
            goBtn.disabled = isBlob || !src || dur < 0.1;
            if (changed === 'start' || changed === 'both') refreshThumb('start');
            if (changed === 'end' || changed === 'both') refreshThumb('end');
        };
```

Replace with:

```js
        const filmstripStrip = $('#sc-gif-filmstrip-strip');
        const filmstripHandleStart = $('#sc-gif-filmstrip-handle-start');
        const filmstripHandleEnd = $('#sc-gif-filmstrip-handle-end');
        let _filmstripTimer = null;

        for (let i = 0; i < FILMSTRIP_TILES; i++) {
            const tile = document.createElement('div');
            tile.className = 'sc-gif-filmstrip-tile';
            $('#sc-gif-filmstrip-tiles').appendChild(tile);
        }

        // Returns true if the window was (re)computed (i.e. tiles need refetching).
        function ensureFilmstripWindow() {
            const needsReframe = !_filmstripWindow ||
                startT < _filmstripWindow.windowStart + FILMSTRIP_EDGE_PAD ||
                endT   > _filmstripWindow.windowEnd   - FILMSTRIP_EDGE_PAD;
            if (!needsReframe) return false;

            const span = Math.max(FILMSTRIP_MIN_WINDOW, (endT - startT) + FILMSTRIP_MARGIN * 2);
            let windowStart = Math.max(0, startT - FILMSTRIP_MARGIN);
            if (isFinite(vidDur)) windowStart = Math.min(windowStart, Math.max(0, vidDur - span));
            const windowEnd = isFinite(vidDur) ? Math.min(vidDur, windowStart + span) : windowStart + span;
            _filmstripWindow = { windowStart, windowEnd };
            return true;
        }

        function renderFilmstripHandles() {
            const win = _filmstripWindow;
            if (!win) return;
            const pctFor = t => Math.max(0, Math.min(100,
                ((t - win.windowStart) / (win.windowEnd - win.windowStart)) * 100));
            const sp = pctFor(startT), ep = pctFor(endT);
            filmstripHandleStart.style.left = sp + '%';
            filmstripHandleEnd.style.left = ep + '%';
            $('#sc-gif-filmstrip-dim-left').style.width = sp + '%';
            $('#sc-gif-filmstrip-dim-right').style.width = (100 - ep) + '%';
            const selection = $('#sc-gif-filmstrip-selection');
            selection.style.left = sp + '%';
            selection.style.width = (ep - sp) + '%';
            $('#sc-gif-filmstrip-range').textContent =
                _fmtClockTenths(win.windowStart) + ' – ' + _fmtClockTenths(win.windowEnd);
        }

        function scheduleFilmstripRefresh() {
            renderFilmstripHandles(); // cheap; keep the handles live even mid-debounce
            clearTimeout(_filmstripTimer);
            _filmstripTimer = setTimeout(() => {
                if (!ensureFilmstripWindow()) { renderFilmstripHandles(); return; }
                renderFilmstripHandles();
                if (isBlob || !src) return;
                const win = _filmstripWindow;
                const tiles = [...panel.querySelectorAll('.sc-gif-filmstrip-tile')];
                const span = win.windowEnd - win.windowStart;
                tiles.forEach((tile, i) => {
                    const t = win.windowStart + (i + 0.5) * span / FILMSTRIP_TILES;
                    tile.classList.add('sc-gif-thumb-loading');
                    grabPreviewFrame(src, t, 64).then(url => {
                        tile.style.backgroundImage = `url("${url}")`;
                        tile.classList.remove('sc-gif-thumb-loading');
                    }).catch(() => tile.classList.remove('sc-gif-thumb-loading'));
                });
            }, 220);
        }

        function wireFilmstripDrag(handleEl, which) {
            let dragging = false;
            handleEl.addEventListener('pointerdown', (e) => {
                dragging = true;
                handleEl.setPointerCapture(e.pointerId);
            });
            handleEl.addEventListener('pointermove', (e) => {
                if (!dragging || !_filmstripWindow) return;
                const win = _filmstripWindow;
                const rect = filmstripStrip.getBoundingClientRect();
                const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                const t = win.windowStart + pct * (win.windowEnd - win.windowStart);
                if (which === 'start') { startT = t; clampStart(); render('both'); }
                else { endT = t; clampEnd(); render('end'); }
            });
            const endDrag = (e) => {
                dragging = false;
                try { handleEl.releasePointerCapture(e.pointerId); } catch (err) {}
            };
            handleEl.addEventListener('pointerup', endDrag);
            handleEl.addEventListener('pointercancel', endDrag);
        }
        wireFilmstripDrag(filmstripHandleStart, 'start');
        wireFilmstripDrag(filmstripHandleEnd, 'end');

        const render = (changed) => {
            $('#sc-gif-time-start').textContent = _fmtClockTenths(startT);
            $('#sc-gif-time-end').textContent = _fmtClockTenths(endT);
            const dur = Math.max(0, endT - startT);
            $('#sc-gif-dur-val').textContent = dur.toFixed(1) + 's';
            goBtn.disabled = isBlob || !src || dur < 0.1;
            if (changed === 'start' || changed === 'both') refreshThumb('start');
            if (changed === 'end' || changed === 'both') refreshThumb('end');
            scheduleFilmstripRefresh();
        };
```

Note: `wireFilmstripDrag`, `render`, `clampStart`, and `clampEnd` reference each other and are defined out of top-to-bottom call order relative to one another — this is safe. They're all `function`/`const` closures inside `openGifPanel` that are only ever *invoked* later (from event handlers or the final `render('both')` call at the end of `openGifPanel`), never at definition time, so by the time any of them actually runs, every `const`/`function` in this step and Step 7 has already been declared. Do not "fix" this by reordering — it matches the file's existing style (e.g. `render` already references `refreshThumb`, defined earlier in the same pattern).

- [ ] **Step 7: Update `clampStart`/`clampEnd`, remove `resetEndFromStart`**

Find this exact block:

```js
        const clampStart = () => {
            startT = Math.max(0, startT);
            if (isFinite(vidDur)) startT = Math.min(startT, vidDur - 0.1);
        };
        const clampEnd = () => { endT = Math.min(Math.max(endT, startT + 0.1), vidDur); };
        // The end mark has no scrubber of its own — moving the start always
        // re-anchors it to a fresh 2s window, then end's own ±.5 fine-tunes
        // from there independently.
        const resetEndFromStart = () => {
            endT = isFinite(vidDur) ? Math.min(vidDur, startT + DEFAULT_CLIP_LEN) : startT + DEFAULT_CLIP_LEN;
            if (endT - startT < 0.1) endT = startT + 0.1;
        };
```

Replace with:

```js
        const clampStart = () => {
            startT = Math.max(0, startT);
            if (isFinite(vidDur)) startT = Math.min(startT, vidDur - MIN_CLIP_GAP);
            if (endT - startT < MIN_CLIP_GAP) startT = Math.max(0, endT - MIN_CLIP_GAP);
            if (endT - startT > MAX_CLIP_LEN) startT = endT - MAX_CLIP_LEN;
        };
        const clampEnd = () => {
            endT = Math.min(isFinite(vidDur) ? vidDur : endT, Math.max(endT, startT + MIN_CLIP_GAP));
            if (endT - startT > MAX_CLIP_LEN) endT = startT + MAX_CLIP_LEN;
        };
```

- [ ] **Step 8: Remove the `resetEndFromStart()` calls from the marks button handler**

Find this exact block:

```js
                case 'start-current': startT = cur; clampStart(); resetEndFromStart(); render('both'); break;
                case 'start-minus':   startT -= 0.5; clampStart(); resetEndFromStart(); render('both'); break;
                case 'start-plus':    startT += 0.5; clampStart(); resetEndFromStart(); render('both'); break;
```

Replace with:

```js
                case 'start-current': startT = cur; clampStart(); render('both'); break;
                case 'start-minus':   startT -= 0.5; clampStart(); render('both'); break;
                case 'start-plus':    startT += 0.5; clampStart(); render('both'); break;
```

- [ ] **Step 9: Remove the old scrubber's input listener**

Find this exact block:

```js

        scrubStart.addEventListener('input', () => {
            startT = parseFloat(scrubStart.value);
            clampStart();
            resetEndFromStart();
            render('both');
        });
```

Replace with nothing (delete the block, including its leading blank line).

- [ ] **Step 10: Replace the scrubber CSS with the filmstrip CSS**

In `injectPanelCss()`'s template string, find this exact block:

```js
            .sc-gif-scrub {
                width: 100% !important; margin: 0 !important; accent-color: #ffcc44 !important;
                cursor: pointer !important;
            }
            .sc-gif-scrub:disabled { opacity: 0.4 !important; cursor: default !important; }
            .sc-gif-scrub-spacer { height: 20px !important; }
```

Replace with:

```js
            .sc-gif-filmstrip { display: flex !important; flex-direction: column !important; gap: 6px !important; }
            .sc-gif-filmstrip-window-label { text-align: center !important; color: rgba(255,255,255,0.55) !important; font-size: 11px !important; }
            .sc-gif-filmstrip-strip {
                position: relative !important; height: 64px !important; border-radius: 6px !important;
                overflow: hidden !important; border: 1px solid rgba(255,255,255,0.18) !important; user-select: none !important;
            }
            .sc-gif-filmstrip-tiles { position: absolute !important; inset: 0 !important; display: flex !important; }
            .sc-gif-filmstrip-tile {
                flex: 1 1 0 !important;
                background-color: #1a1a1e !important;
                background-position: center !important; background-size: cover !important; background-repeat: no-repeat !important;
                border-right: 1px solid rgba(255,255,255,0.06) !important;
                position: relative !important;
            }
            .sc-gif-filmstrip-tile:last-child { border-right: 0 !important; }
            .sc-gif-filmstrip-dim-left, .sc-gif-filmstrip-dim-right {
                position: absolute !important; top: 0 !important; bottom: 0 !important;
                background: rgba(0,0,0,0.55) !important; pointer-events: none !important;
            }
            .sc-gif-filmstrip-dim-left { left: 0 !important; }
            .sc-gif-filmstrip-dim-right { right: 0 !important; }
            .sc-gif-filmstrip-selection {
                position: absolute !important; top: 0 !important; bottom: 0 !important;
                background: rgba(255,204,68,0.08) !important;
                border-left: 2px solid #ffcc44 !important; border-right: 2px solid #ffcc44 !important;
                pointer-events: none !important;
            }
            .sc-gif-filmstrip-handle {
                position: absolute !important; top: 0 !important; bottom: 0 !important; width: 14px !important; margin-left: -7px !important;
                cursor: ew-resize !important; display: flex !important; align-items: center !important; justify-content: center !important;
                z-index: 3 !important; touch-action: none !important;
            }
            .sc-gif-filmstrip-handle-grip {
                width: 6px !important; height: 28px !important; border-radius: 3px !important;
                background: #ffcc44 !important; border: 1px solid #000 !important;
                box-shadow: 0 0 0 3px rgba(255,204,68,0.15) !important;
            }
```

- [ ] **Step 11: Verify syntax**

Run: `node --check cytube.gifmaker.user.js`
Expected: no output, exit code 0.

- [ ] **Step 12: Self-review (no browser available — trace the code instead)**

For each point below, read the relevant function(s) and confirm the behavior, noting in your report which lines you traced:

1. Opening the panel: `render('both')` (final line of `openGifPanel`) → `scheduleFilmstripRefresh()` → since `_filmstripWindow` starts `null`, `ensureFilmstripWindow()` returns `true` inside the 220ms timeout → all 10 tiles get a `grabPreviewFrame` call and the loading spinner class. Confirm this chain.
2. Dragging `filmstripHandleStart`: `pointermove` computes `t` from cursor position within `_filmstripWindow`, sets `startT`, calls `clampStart()` (confirm it can't push `startT` past `endT - MIN_CLIP_GAP` or below 0), then `render('both')` — confirm `render` repositions the handle immediately (via the eager `renderFilmstripHandles()` call at the top of `scheduleFilmstripRefresh`) even before the 220ms tile-refetch debounce fires.
3. Confirm `clampEnd()` now caps `endT - startT` at `MAX_CLIP_LEN` (10s) — trace a scenario where `endT` is dragged far past `startT + 10`.
4. Confirm `ensureFilmstripWindow()` only returns `true` (triggering a tile refetch) when `startT`/`endT` are within `FILMSTRIP_EDGE_PAD` (1s) of the *current* `_filmstripWindow`'s edges — not on every call — by tracing a drag that stays well within the window (should reframe: false) vs. one that approaches the edge (should reframe: true).
5. Confirm nothing in this diff still references `scrubStart`, `resetEndFromStart`, `.sc-gif-scrub`, or `.sc-gif-scrub-spacer` (grep the file).

- [ ] **Step 13: Commit**

```bash
git add cytube.gifmaker.user.js
git commit -m "Replace the single-scrubber trim UI with a dual-handle filmstrip trimmer"
```

---

### Task 2: Consolidate caption handles onto the START frame

**Files:**
- Modify: `cytube.gifmaker.user.js` (inside `openGifPanel()` and `injectPanelCss()`)

**Interfaces:**
- Consumes: `wireCapHandle(handleEl, thumbEl, key)`, `renderCaptionPreview(which)`/`renderCaptionPreviews()`, `capPos` (all pre-existing and **unchanged** — this task only changes which handle elements exist and get wired, not how captions are computed or rendered).
- Produces: `.sc-gif-thumb-readonly` CSS class, applied to `#sc-gif-thumb-end`.

- [ ] **Step 1: Remove the END thumbnail's caption drag handles, mark it read-only**

Find this exact block:

```js
                        <div class="sc-gif-thumb" id="sc-gif-thumb-end">
                            <div class="sc-gif-cap sc-gif-cap-top" id="sc-gif-cap-top-end"></div>
                            <div class="sc-gif-cap sc-gif-cap-bottom" id="sc-gif-cap-bottom-end"></div>
                            <div class="sc-gif-cap-handle sc-gif-cap-handle-top" id="sc-gif-cap-handle-top-end" title="Drag top caption"></div>
                            <div class="sc-gif-cap-handle sc-gif-cap-handle-bottom" id="sc-gif-cap-handle-bottom-end" title="Drag bottom caption"></div>
                        </div>
```

Replace with:

```js
                        <div class="sc-gif-thumb sc-gif-thumb-readonly" id="sc-gif-thumb-end">
                            <div class="sc-gif-cap sc-gif-cap-top" id="sc-gif-cap-top-end"></div>
                            <div class="sc-gif-cap sc-gif-cap-bottom" id="sc-gif-cap-bottom-end"></div>
                        </div>
```

- [ ] **Step 2: Only wire caption-drag handles for START**

Find this exact block:

```js
        ['start', 'end'].forEach(which => {
            ['top', 'bottom'].forEach(key => {
                wireCapHandle($('#sc-gif-cap-handle-' + key + '-' + which), $('#sc-gif-thumb-' + which), key);
            });
        });
```

Replace with:

```js
        ['top', 'bottom'].forEach(key => {
            wireCapHandle($('#sc-gif-cap-handle-' + key + '-start'), $('#sc-gif-thumb-start'), key);
        });
```

- [ ] **Step 3: Add the read-only CSS treatment**

In `injectPanelCss()`'s template string, find this exact block:

```js
            .sc-gif-thumb-43 { aspect-ratio: 4 / 3 !important; }
            .sc-gif-thumb-fit { background-size: contain !important; }
```

Replace with:

```js
            .sc-gif-thumb-43 { aspect-ratio: 4 / 3 !important; }
            .sc-gif-thumb-fit { background-size: contain !important; }
            .sc-gif-thumb-readonly { border-style: dashed !important; opacity: 0.92 !important; }
```

- [ ] **Step 4: Verify syntax**

Run: `node --check cytube.gifmaker.user.js`
Expected: no output, exit code 0.

- [ ] **Step 5: Self-review (no browser available — trace the code instead)**

For each point below, read the relevant function(s) and confirm, noting which lines you traced:

1. Confirm `renderCaptionPreview('end')` (called from `renderCaptionPreviews()`, which runs on every caption input/size/color change and every `wireCapHandle` drag) still writes to `#sc-gif-cap-top-end`/`#sc-gif-cap-bottom-end` and to `--cx-*`/`--cy-*` custom properties on `#sc-gif-thumb-end` — none of that logic touched the now-removed handle elements, so it should be completely unaffected. Confirm by reading the function body.
2. Confirm `#sc-gif-cap-handle-top-end`/`#sc-gif-cap-handle-bottom-end` are referenced nowhere else in the file after Step 1/2 above (grep the file) — no dangling `wireCapHandle`/`$(...)` call that would now return `null` and throw.
3. Confirm `captureGifFrames`/`drawCaptions` (the actual GIF-baking pipeline) still reads `capPos.top`/`capPos.bottom` exactly as before — this task changed no code in that pipeline, only which DOM elements can write to `capPos`. Confirm by reading `captureGifFrames`'s `captions` object construction in the `goBtn` click handler (unchanged by this task) and tracing that it still reads `capPos.top.x/y`/`capPos.bottom.x/y`.
4. Confirm `#sc-gif-thumb-end` now has both `sc-gif-thumb` and `sc-gif-thumb-readonly` classes in the HTML template, and that `applyThumbAspect()` (which does `el.classList.toggle('sc-gif-thumb-43', ...)` etc. on both thumbs) doesn't clobber the new class — `classList.toggle` only affects the named class, so this should be safe; confirm by reading `applyThumbAspect`.

- [ ] **Step 6: Commit**

```bash
git add cytube.gifmaker.user.js
git commit -m "Consolidate caption drag handles onto the START preview frame"
```
