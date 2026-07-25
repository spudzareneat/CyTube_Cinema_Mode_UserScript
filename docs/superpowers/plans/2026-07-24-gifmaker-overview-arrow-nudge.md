# GIF Maker Overview Scrubber Arrow-Key Nudge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add keyboard nudging to the GIF Maker's whole-movie overview scrubber — once the track has focus, Left/Right shifts the current clip window by ±1s (Shift+arrow ±10s), preserving clip duration, so a user can land on a precise timestamp that mouse dragging on a ~390px/90-minute bar can't reliably reach.

**Architecture:** All changes live inside the existing `openGifPanel()` function and `injectPanelCss()` in `cytube.gifmaker.user.js`. The nudge reuses the panel's existing `render('both')` pipeline (same one the click/drag teleport already drives) — this task only adds focus support and a scoped `keydown` listener.

**Tech Stack:** Vanilla JS, native focus/`tabindex`, CSS `!important` (matching this file's established convention).

## Global Constraints

- No automated test framework — verification is `node --check cytube.gifmaker.user.js` (syntax only) plus manual browser testing, unavailable to implementer/reviewer subagents. Test steps are `node --check` plus a code-reading self-review, matching every prior task on this branch.
- Only `cytube.gifmaker.user.js` is touched.
- The `keydown` listener must be attached to `overviewTrack` itself, **not** `document` or `window` — this is the load-bearing safety property that keeps arrow keys from being hijacked while the user is typing in the caption fields or the ImgBB key field. Do not implement this any other way.
- Nudging **shifts** the current `startT`/`endT` window by the step amount, preserving `endT - startT` (the clip's current duration) exactly — it must NOT reset to a fresh `DEFAULT_CLIP_LEN` clip the way a click/drag-release does. This is deliberately different behavior from the click/drag teleport already on this branch.
- Exact constants: `OVERVIEW_NUDGE_SEC = 1`, `OVERVIEW_NUDGE_SEC_FAST = 10`.
- Same disabled-state guard as the click/drag path: `isBlob || !src || !isFinite(vidDur)`.

---

### Task 1: Arrow-key nudging on the overview scrubber

**Files:**
- Modify: `cytube.gifmaker.user.js` (inside `openGifPanel()` and `injectPanelCss()`)

**Interfaces:**
- Consumes: `startT`/`endT`/`vidDur`/`isBlob`/`src` (closures), `render(changed)`, `overviewTrack` (already-existing element ref) — all pre-existing, unchanged.
- Produces: `OVERVIEW_NUDGE_SEC`, `OVERVIEW_NUDGE_SEC_FAST` (module-level constants), a `keydown` listener on `overviewTrack`.

- [ ] **Step 1: Add the nudge-step constants**

Find this exact block:

```js
    const MIN_CLIP_GAP = 0.1;
    const MAX_CLIP_LEN = 10;
    const FILMSTRIP_MARGIN = 3;
    const FILMSTRIP_MIN_WINDOW = 12;
    const FILMSTRIP_EDGE_PAD = 1;
    const FILMSTRIP_TILES = 10;
```

Replace with:

```js
    const MIN_CLIP_GAP = 0.1;
    const MAX_CLIP_LEN = 10;
    const FILMSTRIP_MARGIN = 3;
    const FILMSTRIP_MIN_WINDOW = 12;
    const FILMSTRIP_EDGE_PAD = 1;
    const FILMSTRIP_TILES = 10;
    const OVERVIEW_NUDGE_SEC = 1;
    const OVERVIEW_NUDGE_SEC_FAST = 10;
```

- [ ] **Step 2: Make the overview track focusable**

Find this exact block:

```js
                    <div class="sc-gif-overview-track" id="sc-gif-overview-track">
```

Replace with:

```js
                    <div class="sc-gif-overview-track" id="sc-gif-overview-track" tabindex="0">
```

- [ ] **Step 3: Add the focus-visible CSS**

In `injectPanelCss()`'s template string, find this exact block:

```js
            .sc-gif-overview-track {
                position: relative !important; height: 16px !important; border-radius: 4px !important;
                background: #17171a !important; border: 1px solid rgba(255,255,255,0.14) !important;
                cursor: pointer !important; user-select: none !important; touch-action: none !important;
            }
            .sc-gif-overview-viewport {
```

Replace with:

```js
            .sc-gif-overview-track {
                position: relative !important; height: 16px !important; border-radius: 4px !important;
                background: #17171a !important; border: 1px solid rgba(255,255,255,0.14) !important;
                cursor: pointer !important; user-select: none !important; touch-action: none !important;
            }
            .sc-gif-overview-track:focus {
                outline: 2px solid #ffcc44 !important; outline-offset: 1px !important;
            }
            .sc-gif-overview-viewport {
```

- [ ] **Step 4: Add the keydown listener**

Find this exact block:

```js
        overviewTrack.addEventListener('pointerup', overviewCommit);
        overviewTrack.addEventListener('pointercancel', (e) => {
            overviewDragging = false;
            overviewGhost.style.setProperty('display', 'none', 'important');
            try { overviewTrack.releasePointerCapture(e.pointerId); } catch (err) {}
            renderFilmstripHandles(); // restore the "Currently editing" label, no jump
        });
```

Replace with:

```js
        overviewTrack.addEventListener('pointerup', overviewCommit);
        overviewTrack.addEventListener('pointercancel', (e) => {
            overviewDragging = false;
            overviewGhost.style.setProperty('display', 'none', 'important');
            try { overviewTrack.releasePointerCapture(e.pointerId); } catch (err) {}
            renderFilmstripHandles(); // restore the "Currently editing" label, no jump
        });
        overviewTrack.addEventListener('keydown', (e) => {
            if (isBlob || !src || !isFinite(vidDur)) return;
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault(); // arrows would otherwise scroll the page/chat behind the panel
            const step = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? OVERVIEW_NUDGE_SEC_FAST : OVERVIEW_NUDGE_SEC);
            const dur = endT - startT;
            let newStart = startT + step;
            newStart = Math.max(0, Math.min(newStart, vidDur - dur));
            startT = newStart;
            endT = startT + dur;
            render('both');
        });
```

- [ ] **Step 5: Verify syntax**

Run: `node --check cytube.gifmaker.user.js`
Expected: no output, exit code 0.

- [ ] **Step 6: Self-review (no browser available — trace the code instead)**

For each point, read the relevant code and confirm, noting what you traced:

1. Confirm the listener is attached to `overviewTrack` (not `document`/`window`) — grep to be certain there's exactly one `addEventListener('keydown', ...)` call in the whole file and it's the one on `overviewTrack`.
2. Confirm duration preservation: trace a case where `startT=100, endT=103` (`dur=3`), pressing Right (`step=1`) — confirm the result is `startT=101, endT=104` (still `dur=3`), not a reset to `DEFAULT_CLIP_LEN`.
3. Confirm the clamp preserves duration at the boundaries: trace `startT=0.5, endT=3.5` (`dur=3`), pressing Left (`step=-1`, target `newStart=-0.5`) — confirm `newStart` clamps to `0`, giving `startT=0, endT=3` (still `dur=3`, not clamped to some other length). Trace the same near `vidDur` for Right/Shift+Right.
4. Confirm `e.preventDefault()` is called before the state mutation, so the page/chat behind the panel never scrolls when the track has focus and an arrow is pressed — grep to confirm no other code path calls `preventDefault` redundantly or the mutation happens first (order shouldn't functionally matter here, but confirm it's present at all).
5. Confirm the disabled-state guard is checked first, before reading `e.key` — so a keydown on a disabled panel state does nothing at all, consistent with the click/drag path's own guard.
6. Confirm no other key besides `ArrowLeft`/`ArrowRight` is intercepted — e.g. Tab, typing keys, or other arrows (Up/Down) must fall through untouched so normal browser focus/typing behavior elsewhere in the panel is unaffected.

- [ ] **Step 7: Commit**

```bash
git add cytube.gifmaker.user.js
git commit -m "Add arrow-key nudging to the overview scrubber, scoped to the track's own focus"
```
