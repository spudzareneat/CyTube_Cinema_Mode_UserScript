# GIF Maker Filmstrip Selection Drag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the GIF Maker panel's filmstrip selection band (the amber region between the START and END handles) draggable — dragging shifts the whole clip window by the drag delta (duration preserved), and holding the drag at either edge of the visible filmstrip auto-scrolls continuously at a fixed rate.

**Architecture:** All changes live inside the existing `openGifPanel()` function and `injectPanelCss()` in `cytube.gifmaker.user.js`. Reuses the same duration-preserving shift-and-clamp shape already used by the overview scrubber's arrow-key nudge, and the same `render('both')` pipeline every other drag/nudge interaction on this branch already drives.

**Tech Stack:** Vanilla JS, Pointer Events (matching `wireFilmstripDrag`/`wireCapHandle`/the overview track's drag wiring), `setInterval` for the edge auto-scroll, CSS `!important` throughout (matching this file's established convention).

## Global Constraints

- No automated test framework — verification is `node --check cytube.gifmaker.user.js` (syntax only) plus manual browser testing, unavailable to implementer/reviewer subagents. Test steps are `node --check` plus a code-reading self-review, matching every prior task on this branch.
- Only `cytube.gifmaker.user.js` is touched.
- Dragging the selection band **shifts** `startT`/`endT` together, preserving `endT - startT` exactly — never resizes the clip. Reuse the shift-and-clamp shape already established by the overview scrubber's nudge: `newStart` clamped to `[0, Math.max(0, vidDur - dur)]`.
- Exact constants: `SELECTION_EDGE_ZONE_PX = 20`, `SELECTION_AUTOSCROLL_STEP = 0.2`, `SELECTION_AUTOSCROLL_INTERVAL_MS = 100`.
- The edge-zone check uses `filmstripStrip.getBoundingClientRect()` (the visible strip's own boundary), not the selection band's own rect, since the band's rect moves/resizes as the window changes.
- `startSelectionAutoScroll(dir)` must no-op if already scrolling in the same direction (don't tear down and recreate the `setInterval` on every intervening `pointermove` while the cursor sits still at the edge).
- `close()` must stop any active auto-scroll interval — this branch has already shipped and fixed the identical class of leak once before (an uncleared debounce timer resurrecting a hidden `<video>` after panel close); do not reintroduce it in `setInterval` form.
- Same disabled-state guard as every other interactive control in this panel: `isBlob || !src || !isFinite(vidDur)`. Same `e.button !== 0` guard as the overview scrubber (a right-click drag must not move the selection). Same `e.stopPropagation()` pattern as every other drag handle in this file.

---

### Task 1: Draggable filmstrip selection band with edge auto-scroll

**Files:**
- Modify: `cytube.gifmaker.user.js` (inside `openGifPanel()` and `injectPanelCss()`)

**Interfaces:**
- Consumes: `startT`/`endT`/`vidDur`/`isBlob`/`src`/`_filmstripWindow` (closures), `render(changed)`, `filmstripStrip` (already-existing element ref), `thumbTimers`, `_filmstripTimer` (pre-existing, unchanged).
- Produces: `SELECTION_EDGE_ZONE_PX`, `SELECTION_AUTOSCROLL_STEP`, `SELECTION_AUTOSCROLL_INTERVAL_MS` (module-level constants), `selectionShiftTo(newStart)`, `stopSelectionAutoScroll()`, `startSelectionAutoScroll(dir)` (all scoped inside `openGifPanel`), a `pointerdown`/`pointermove`/`pointerup`/`pointercancel`-wired `#sc-gif-filmstrip-selection` element.

- [ ] **Step 1: Add the auto-scroll constants**

Find this exact block:

```js
    const OVERVIEW_NUDGE_SEC = 1;
    const OVERVIEW_NUDGE_SEC_FAST = 10;
```

Replace with:

```js
    const OVERVIEW_NUDGE_SEC = 1;
    const OVERVIEW_NUDGE_SEC_FAST = 10;
    const SELECTION_EDGE_ZONE_PX = 20;
    const SELECTION_AUTOSCROLL_STEP = 0.2;
    const SELECTION_AUTOSCROLL_INTERVAL_MS = 100;
```

- [ ] **Step 2: Make the selection band interactive in CSS**

In `injectPanelCss()`'s template string, find this exact block:

```js
            .sc-gif-filmstrip-selection {
                position: absolute !important; top: 0 !important; bottom: 0 !important;
                background: rgba(255,204,68,0.08) !important;
                border-left: 2px solid #ffcc44 !important; border-right: 2px solid #ffcc44 !important;
                pointer-events: none !important;
            }
```

Replace with:

```js
            .sc-gif-filmstrip-selection {
                position: absolute !important; top: 0 !important; bottom: 0 !important;
                background: rgba(255,204,68,0.08) !important;
                border-left: 2px solid #ffcc44 !important; border-right: 2px solid #ffcc44 !important;
                pointer-events: auto !important; cursor: grab !important;
            }
            .sc-gif-filmstrip-selection:active { cursor: grabbing !important; }
```

- [ ] **Step 3: Stop any active auto-scroll when the panel closes**

Find this exact block:

```js
        const close = () => {
            clearTimeout(_filmstripTimer);
            Object.values(thumbTimers).forEach(clearTimeout);
            _revokeGifResult(); destroyScrubClone(); panel.remove();
        };
```

Replace with:

```js
        const close = () => {
            clearTimeout(_filmstripTimer);
            Object.values(thumbTimers).forEach(clearTimeout);
            stopSelectionAutoScroll();
            _revokeGifResult(); destroyScrubClone(); panel.remove();
        };
```

Note: `close` is a `const` arrow invoked only later, from the ✕ button's click listener — same as it already references `_filmstripTimer`/`thumbTimers`, both declared later in `openGifPanel`'s body. `stopSelectionAutoScroll` (added in Step 4, later still) is safe to reference here for the identical reason: nothing in this file calls `close()` before `openGifPanel`'s synchronous setup has fully run.

- [ ] **Step 4: Add the selection-drag state, functions, and wiring**

Find this exact block:

```js
        wireFilmstripDrag(filmstripHandleStart, 'start');
        wireFilmstripDrag(filmstripHandleEnd, 'end');
```

Replace with:

```js
        wireFilmstripDrag(filmstripHandleStart, 'start');
        wireFilmstripDrag(filmstripHandleEnd, 'end');

        let selectionDragging = false;
        let selectionDragStartX = 0;
        let selectionDragStartT0 = 0; // startT captured at pointerdown
        let selectionAutoScrollTimer = null;
        let selectionAutoScrollDir = 0; // -1 (backward), 0 (idle), 1 (forward)

        function selectionShiftTo(newStart) {
            const dur = endT - startT;
            newStart = Math.max(0, Math.min(newStart, Math.max(0, vidDur - dur)));
            startT = newStart;
            endT = startT + dur;
            render('both');
        }
        function stopSelectionAutoScroll() {
            if (selectionAutoScrollTimer) { clearInterval(selectionAutoScrollTimer); selectionAutoScrollTimer = null; }
            selectionAutoScrollDir = 0;
        }
        function startSelectionAutoScroll(dir) {
            if (selectionAutoScrollDir === dir) return;
            stopSelectionAutoScroll();
            selectionAutoScrollDir = dir;
            selectionAutoScrollTimer = setInterval(() => {
                selectionShiftTo(startT + dir * SELECTION_AUTOSCROLL_STEP);
            }, SELECTION_AUTOSCROLL_INTERVAL_MS);
        }

        const selectionEl = $('#sc-gif-filmstrip-selection');
        selectionEl.addEventListener('pointerdown', (e) => {
            if (isBlob || !src || !isFinite(vidDur)) return;
            if (e.button !== 0) return;
            e.stopPropagation();
            selectionDragging = true;
            selectionDragStartX = e.clientX;
            selectionDragStartT0 = startT;
            selectionEl.setPointerCapture(e.pointerId);
        });
        selectionEl.addEventListener('pointermove', (e) => {
            if (!selectionDragging || !_filmstripWindow) return;
            const rect = filmstripStrip.getBoundingClientRect();
            if (e.clientX <= rect.left + SELECTION_EDGE_ZONE_PX) { startSelectionAutoScroll(-1); return; }
            if (e.clientX >= rect.right - SELECTION_EDGE_ZONE_PX) { startSelectionAutoScroll(1); return; }
            stopSelectionAutoScroll();
            const win = _filmstripWindow;
            const deltaPx = e.clientX - selectionDragStartX;
            const deltaSec = deltaPx / rect.width * (win.windowEnd - win.windowStart);
            selectionShiftTo(selectionDragStartT0 + deltaSec);
        });
        function endSelectionDrag(e) {
            selectionDragging = false;
            stopSelectionAutoScroll();
            try { selectionEl.releasePointerCapture(e.pointerId); } catch (err) {}
        }
        selectionEl.addEventListener('pointerup', endSelectionDrag);
        selectionEl.addEventListener('pointercancel', endSelectionDrag);
```

Note: `render`, `_filmstripWindow` (as a `let` reassigned inside `ensureFilmstripWindow`), `startT`, `endT`, and `vidDur` are all referenced here before their own declarations/full setup appear later or earlier in `openGifPanel`'s body in various places — this is safe for the same reason established throughout this file: every function here is invoked later, via an actual pointer event or the final `render('both')` call, never at definition time. Apply the steps in the given order; do not reorder anything to "fix" this.

- [ ] **Step 5: Verify syntax**

Run: `node --check cytube.gifmaker.user.js`
Expected: no output, exit code 0.

- [ ] **Step 6: Self-review (no browser available — trace the code instead)**

For each point, read the relevant code and confirm, noting what you traced:

1. Confirm `selectionShiftTo` never changes `endT - startT`: trace `startT=100, endT=103` (dur=3), call `selectionShiftTo(150)` — confirm result is `startT=150, endT=153`, dur still 3.
2. Confirm the clamp: trace `selectionShiftTo(-50)` with `vidDur=5400` — confirm it clamps to `startT=0, endT=3` (not negative). Trace `selectionShiftTo(6000)` — confirm it clamps so `endT` never exceeds `vidDur`.
3. Confirm `startSelectionAutoScroll`'s same-direction no-op: trace two consecutive calls with `dir=-1` — confirm the second call returns immediately without calling `stopSelectionAutoScroll()`/creating a second interval (grep for how many `setInterval` calls exist in the function body — should be exactly one, only reached when the direction actually changes or scrolling wasn't already active).
4. Confirm the edge-zone check uses `filmstripStrip.getBoundingClientRect()`, not `selectionEl`'s own rect — grep to confirm `selectionEl.getBoundingClientRect()` is never called anywhere in this task's new code.
5. Confirm normal (non-edge) dragging is delta-based: trace that `selectionDragStartX`/`selectionDragStartT0` are captured once at `pointerdown` and never reassigned during `pointermove` — so the shift amount is always relative to the original grab point, not recomputed from the current absolute cursor position each tick.
6. Confirm `close()` calls `stopSelectionAutoScroll()` — trace that an active `selectionAutoScrollTimer` is cleared and `selectionAutoScrollDir` reset to 0 before `panel.remove()` runs, so no interval keeps firing against a detached panel.
7. Confirm the disabled-state guard and `e.button !== 0` guard are both checked in `pointerdown`, before `e.stopPropagation()`/`selectionDragging = true`/any state capture — matching the overview scrubber's own `pointerdown` guard ordering in the same file.
8. Confirm the handles still take priority over the selection band where they visually overlap it — read the HTML template order (Step 2 of the *filmstrip trimmer* plan, `.sc-gif-filmstrip-selection` before `.sc-gif-filmstrip-handle-start`/`-end`) and confirm this task didn't reorder those elements.

- [ ] **Step 7: Commit**

```bash
git add cytube.gifmaker.user.js
git commit -m "Make the filmstrip selection band draggable, with edge auto-scroll"
```
