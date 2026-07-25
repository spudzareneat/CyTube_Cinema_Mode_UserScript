# GIF Maker Overview Scrubber Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a thin, whole-movie overview scrubber above the GIF Maker panel's filmstrip — drag or click anywhere on it, and on release the panel teleports (fresh default-length clip, filmstrip reframes there), so a user can get to a different part of a long movie without dozens of small filmstrip-edge nudges.

**Architecture:** All changes live inside the existing `openGifPanel()` function and `injectPanelCss()` in `cytube.gifmaker.user.js` — no new files, no other scripts touched. The scrubber reuses the already-shipped `render()`/`clampStart()`/`clampEnd()`/filmstrip-refresh pipeline for the actual teleport; it only adds the drag-to-preview UI and the one-time "jump" mutation on release.

**Tech Stack:** Vanilla JS (matches the rest of the file), Pointer Events for drag (matching `wireFilmstripDrag`/`wireCapHandle`), CSS with `!important` throughout (matching `injectPanelCss()`'s existing convention).

## Global Constraints

- No automated test framework in this repo — verification is `node --check cytube.gifmaker.user.js` (syntax only) plus manual browser testing, unavailable to implementer/reviewer subagents. Every task's "test" step is `node --check` plus a code-reading self-review tracing the manual-verification checklist, matching how this branch's prior tasks were executed and reviewed.
- Only `cytube.gifmaker.user.js` is touched.
- The scrubber commits **only on `pointerup`** (or a plain click, which is a `pointerdown`+`pointerup` with no intervening move) — never mid-drag. `pointermove` while dragging only updates a ghost-line/label preview; it must not call `render()`, mutate `startT`/`endT`, or touch the filmstrip.
- On commit: `startT = Math.max(0, t - DEFAULT_CLIP_LEN / 2); endT = Math.min(vidDur, startT + DEFAULT_CLIP_LEN);` (reuses the existing `DEFAULT_CLIP_LEN` constant already declared in `openGifPanel`), then `clampStart(); clampEnd(); render('both');` — the existing clamp/render pipeline, unmodified.
- Disabled when `isBlob || !src || !isFinite(vidDur)` — matches the guard pattern already used by `refreshThumb`/`scheduleFilmstripRefresh`'s tile fetch.

---

### Task 1: Whole-movie overview scrubber

**Files:**
- Modify: `cytube.gifmaker.user.js` (inside `openGifPanel()` and `injectPanelCss()`)

**Interfaces:**
- Consumes: `_fmtClockTenths(sec)`, `DEFAULT_CLIP_LEN`, `startT`/`endT`/`vidDur`/`isBlob`/`src` (closures), `clampStart()`, `clampEnd()`, `render(changed)`, `_filmstripWindow` (all pre-existing, unchanged).
- Produces: `overviewTimeFromEvent(e)`, `overviewCommit(e)` (both scoped inside `openGifPanel`), an extended `renderFilmstripHandles()` that also positions the overview viewport indicator and current-position label.

- [ ] **Step 1: Add the overview CSS**

Find this exact block in `injectPanelCss()`'s template string:

```js
            .sc-gif-cap-hint { text-align: center !important; color: rgba(255,255,255,0.4) !important; font-size: 11px !important; }
            .sc-gif-filmstrip { display: flex !important; flex-direction: column !important; gap: 6px !important; }
```

Replace with:

```js
            .sc-gif-cap-hint { text-align: center !important; color: rgba(255,255,255,0.4) !important; font-size: 11px !important; }
            .sc-gif-overview { display: flex !important; flex-direction: column !important; gap: 4px !important; margin-bottom: 2px !important; }
            .sc-gif-overview-track {
                position: relative !important; height: 16px !important; border-radius: 4px !important;
                background: #17171a !important; border: 1px solid rgba(255,255,255,0.14) !important;
                cursor: pointer !important; user-select: none !important; touch-action: none !important;
            }
            .sc-gif-overview-viewport {
                position: absolute !important; top: 0 !important; bottom: 0 !important;
                background: rgba(255,204,68,0.55) !important;
                border-left: 1px solid #ffcc44 !important; border-right: 1px solid #ffcc44 !important;
                border-radius: 2px !important; pointer-events: none !important;
            }
            .sc-gif-overview-ghost {
                position: absolute !important; top: -3px !important; bottom: -3px !important; width: 2px !important;
                background: #fff !important; box-shadow: 0 0 4px rgba(255,255,255,0.8) !important;
                display: none !important; pointer-events: none !important;
            }
            .sc-gif-overview-labels {
                display: flex !important; justify-content: space-between !important;
                color: rgba(255,255,255,0.4) !important; font-size: 10px !important;
            }
            .sc-gif-overview-current { color: rgba(255,204,68,0.85) !important; font-weight: 600 !important; }
            .sc-gif-filmstrip { display: flex !important; flex-direction: column !important; gap: 6px !important; }
```

- [ ] **Step 2: Add the overview HTML block above the filmstrip**

Find this exact block:

```js
            <div id="sc-gif-body">
                <div class="sc-gif-filmstrip">
```

Replace with:

```js
            <div id="sc-gif-body">
                <div class="sc-gif-overview">
                    <div class="sc-gif-overview-track" id="sc-gif-overview-track">
                        <div class="sc-gif-overview-viewport" id="sc-gif-overview-viewport"></div>
                        <div class="sc-gif-overview-ghost" id="sc-gif-overview-ghost"></div>
                    </div>
                    <div class="sc-gif-overview-labels">
                        <span>0:00</span>
                        <span class="sc-gif-overview-current" id="sc-gif-overview-current"></span>
                        <span id="sc-gif-overview-total"></span>
                    </div>
                </div>
                <div class="sc-gif-filmstrip">
```

- [ ] **Step 3: Set the total-duration label once, right after the panel is added to the DOM**

Find this exact block:

```js
        document.body.appendChild(panel);

        const $ = id => panel.querySelector(id);
        const goBtn = $('#sc-gif-go'), status = $('#sc-gif-status'), result = $('#sc-gif-result');
```

Replace with:

```js
        document.body.appendChild(panel);

        const $ = id => panel.querySelector(id);
        const goBtn = $('#sc-gif-go'), status = $('#sc-gif-status'), result = $('#sc-gif-result');
        $('#sc-gif-overview-total').textContent = isFinite(vidDur) ? _fmtClockTenths(vidDur) : '';
```

- [ ] **Step 4: Grab the overview elements and add the drag-to-preview/commit wiring**

Find this exact block:

```js
        const filmstripStrip = $('#sc-gif-filmstrip-strip');
        const filmstripHandleStart = $('#sc-gif-filmstrip-handle-start');
        const filmstripHandleEnd = $('#sc-gif-filmstrip-handle-end');
        let _filmstripTimer = null;
        let _tilesWindowKey = null; // the window the on-screen tiles currently show
```

Replace with:

```js
        const filmstripStrip = $('#sc-gif-filmstrip-strip');
        const filmstripHandleStart = $('#sc-gif-filmstrip-handle-start');
        const filmstripHandleEnd = $('#sc-gif-filmstrip-handle-end');
        let _filmstripTimer = null;
        let _tilesWindowKey = null; // the window the on-screen tiles currently show

        const overviewTrack = $('#sc-gif-overview-track');
        const overviewViewport = $('#sc-gif-overview-viewport');
        const overviewGhost = $('#sc-gif-overview-ghost');
        const overviewCurrent = $('#sc-gif-overview-current');
        let overviewDragging = false;
```

- [ ] **Step 5: Extend `renderFilmstripHandles()` to position the viewport indicator and current-position label**

Find this exact block:

```js
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
```

Replace with:

```js
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

            if (isFinite(vidDur) && vidDur > 0) {
                const ovStart = (win.windowStart / vidDur) * 100;
                const ovEnd = (win.windowEnd / vidDur) * 100;
                overviewViewport.style.left = ovStart + '%';
                overviewViewport.style.width = Math.max(0.5, ovEnd - ovStart) + '%';
            }
            if (!overviewDragging) {
                overviewCurrent.textContent = _fmtClockTenths(startT);
            }
        }
```

- [ ] **Step 6: Wire the overview track's drag-to-preview / release-to-commit interaction**

Find this exact block:

```js
        wireFilmstripDrag(filmstripHandleStart, 'start');
        wireFilmstripDrag(filmstripHandleEnd, 'end');
```

Replace with:

```js
        wireFilmstripDrag(filmstripHandleStart, 'start');
        wireFilmstripDrag(filmstripHandleEnd, 'end');

        function overviewTimeFromEvent(e) {
            const rect = overviewTrack.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            return pct * vidDur;
        }
        overviewTrack.addEventListener('pointerdown', (e) => {
            if (isBlob || !src || !isFinite(vidDur)) return;
            overviewDragging = true;
            overviewTrack.setPointerCapture(e.pointerId);
            overviewGhost.style.display = 'block';
            overviewGhost.style.left = (overviewTimeFromEvent(e) / vidDur * 100) + '%';
        });
        overviewTrack.addEventListener('pointermove', (e) => {
            if (!overviewDragging) return;
            const t = overviewTimeFromEvent(e);
            overviewGhost.style.left = (t / vidDur * 100) + '%';
            overviewCurrent.textContent = 'Jump to: ' + _fmtClockTenths(t) + ' (release to commit)';
        });
        function overviewCommit(e) {
            if (!overviewDragging) return;
            overviewDragging = false;
            overviewGhost.style.display = 'none';
            try { overviewTrack.releasePointerCapture(e.pointerId); } catch (err) {}
            const t = overviewTimeFromEvent(e);
            startT = Math.max(0, t - DEFAULT_CLIP_LEN / 2);
            endT = Math.min(vidDur, startT + DEFAULT_CLIP_LEN);
            clampStart();
            clampEnd();
            render('both');
        }
        overviewTrack.addEventListener('pointerup', overviewCommit);
        overviewTrack.addEventListener('pointercancel', () => {
            overviewDragging = false;
            overviewGhost.style.display = 'none';
            renderFilmstripHandles(); // restore the "Currently editing" label, no jump
        });
```

Note: `overviewCommit` calls `clampStart`, `clampEnd`, and `render` — all defined later in `openGifPanel` (same as `wireFilmstripDrag`'s handlers already do with `clampStart`/`clampEnd`/`render`). This is safe for the same reason already established elsewhere in this file: these are closures that only ever execute later, via an actual pointer event, never at definition time — by then every `const`/`function` in the whole `openGifPanel` body has been declared. Do not reorder anything.

- [ ] **Step 7: Verify syntax**

Run: `node --check cytube.gifmaker.user.js`
Expected: no output, exit code 0.

- [ ] **Step 8: Self-review (no browser available — trace the code instead)**

For each point, read the relevant code and confirm, noting what you traced:

1. Trace a plain click (no `pointermove` between `pointerdown` and `pointerup`, same `e.clientX` both times): confirm `overviewCommit` still fires correctly and computes the same `t` both times — click-to-jump works via the same code path as drag-to-commit, no special-casing needed.
2. Trace a drag: `pointerdown` at t=10 → `pointermove` to t=500 (ghost/label update only, confirm `startT`/`endT`/`_filmstripWindow` are untouched — grep the `pointermove` handler body to confirm it never calls `render`, `clampStart`, `clampEnd`, or touches `startT`/`endT`) → `pointerup` at t=500 → confirm `overviewCommit` computes `startT`/`endT` from t=500, not from wherever the panel was before the drag.
3. Confirm the disabled-state guard: with `isBlob === true` or `!src` or `!isFinite(vidDur)`, `pointerdown` returns immediately (before `overviewDragging = true`) — no drag starts, no ghost shows, no capture happens.
4. Confirm `renderFilmstripHandles()`'s new `!overviewDragging` guard: while a drag is in progress, does anything else in the file call `render()` (which calls `scheduleFilmstripRefresh()` which calls `renderFilmstripHandles()` inside its debounce)? If so, confirm that debounced call — which could fire mid-drag from an unrelated filmstrip-handle interaction — doesn't clobber the "Jump to: …" label the overview `pointermove` handler is actively writing. (It shouldn't, because of the guard — confirm by reading, not assuming.)
5. Confirm the viewport indicator math: `(win.windowStart / vidDur) * 100` and the `Math.max(0.5, ...)` width floor — trace a case where the filmstrip window is very narrow relative to `vidDur` (e.g. a 12s window in a 5400s movie) and confirm the computed width doesn't collapse to an invisible 0%.
6. Confirm `$('#sc-gif-overview-total')` is set exactly once (Step 3), using `_fmtClockTenths(vidDur)` only when `isFinite(vidDur)` — grep to confirm there's no second write site that could go stale.
7. Confirm edge clamping: `overviewTimeFromEvent`'s `Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))` means a pointer past either edge of the track still yields `pct` in `[0, 1]`, so `t` is always in `[0, vidDur]` — a drag/click far outside the track's bounds can't produce a negative or over-`vidDur` jump target.
8. Confirm `pointercancel` never commits: its handler only resets `overviewDragging`/hides the ghost/calls `renderFilmstripHandles()` — it does not call `overviewCommit` or touch `startT`/`endT`. Confirm `renderFilmstripHandles()` at that point re-reads `overviewDragging` (now `false`) and restores the plain `_fmtClockTenths(startT)` label.
9. Confirm nothing in this task's new code references `capPos`, `.sc-gif-cap-*`, or any caption-related state — the teleport only ever mutates `startT`/`endT` and calls the pre-existing `render()`, so captions (positioned independently via the START thumbnail's own handles) are structurally unaffected by a jump. Confirm by grepping this task's diff for `capPos`/`cap-handle`/`cap-top`/`cap-bottom` — should be zero matches.

- [ ] **Step 9: Commit**

```bash
git add cytube.gifmaker.user.js
git commit -m "Add whole-movie overview scrubber with drag-to-preview, release-to-commit teleport"
```
