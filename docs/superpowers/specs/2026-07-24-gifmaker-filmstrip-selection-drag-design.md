# GIF Maker filmstrip — drag the selection band — design

## Goal

The filmstrip's amber selection band (between the START and END handles)
is currently a display-only overlay (`pointer-events: none`). Make it
draggable: grabbing the band and moving the mouse shifts the whole
start/end window together (duration preserved — same "shift, don't
resize" idea as the overview scrubber's arrow-key nudge, just via direct
drag). Dragging the band all the way to the left or right edge of the
visible filmstrip and holding it there starts a continuous
backward/forward auto-scroll at a fixed rate, for as long as it's held at
the edge.

This only touches `cytube.gifmaker.user.js` — specifically `openGifPanel`
and `injectPanelCss`. No other file changes. The START/END handle drags
(`wireFilmstripDrag`) are unaffected — they already work correctly per the
user and are out of scope.

## Normal drag: shift, not resize

Dragging the band is delta-based, not absolute-position-based: the offset
between the cursor and its position at `pointerdown` is what matters, not
where the cursor lands relative to the window. This preserves the exact
grab point and avoids a jump-to-cursor snap the moment the drag starts
(the same reason native slider/scrollbar-thumb dragging works this way).

```js
const SELECTION_EDGE_ZONE_PX = 20;      // px from either strip edge that triggers auto-scroll
const SELECTION_AUTOSCROLL_STEP = 0.2;  // seconds per auto-scroll tick
const SELECTION_AUTOSCROLL_INTERVAL_MS = 100; // -> 2s/sec while held at the edge

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
```

`selectionShiftTo` is the same duration-preserving shift-and-clamp shape
already used by the overview scrubber's arrow-key nudge (`vidDur - dur`
floored at 0, `dur` never altered) — this task reuses that pattern rather
than inventing a new one.

## Edge auto-scroll

While dragging, every `pointermove` checks the cursor's position against
`filmstripStrip`'s own bounding rect (the visible strip boundary the user
perceives, not the selection band's own rect, which moves/resizes as the
window changes):

```js
function stopSelectionAutoScroll() {
    if (selectionAutoScrollTimer) { clearInterval(selectionAutoScrollTimer); selectionAutoScrollTimer = null; }
    selectionAutoScrollDir = 0;
}
function startSelectionAutoScroll(dir) {
    if (selectionAutoScrollDir === dir) return; // already scrolling this direction, no-op
    stopSelectionAutoScroll();
    selectionAutoScrollDir = dir;
    selectionAutoScrollTimer = setInterval(() => {
        selectionShiftTo(startT + dir * SELECTION_AUTOSCROLL_STEP);
        // render('both') above only re-arms the 220ms tile-refetch debounce,
        // which this 100ms tick perpetually resets, so the filmstrip window
        // itself would never reframe during a sustained hold (see "Full
        // wiring" below). Force the cheap (no-network) reframe/reposition
        // every tick so the visible window actually pans; tile thumbnails
        // stay on the existing debounce and catch up shortly after the hold
        // ends, same as they already do for a fast handle drag.
        ensureFilmstripWindow();
        renderFilmstripHandles();
    }, SELECTION_AUTOSCROLL_INTERVAL_MS);
}
```

When the cursor is within `SELECTION_EDGE_ZONE_PX` of the strip's left
edge, auto-scroll backward (`dir = -1`); within that distance of the right
edge, forward (`dir = 1`); otherwise, normal delta-based positioning
applies and any active auto-scroll stops. `startSelectionAutoScroll`'s
same-direction no-op guard means a `setInterval` isn't torn down and
recreated on every intervening `pointermove` while the cursor sits still
at the edge — only a direction *change* (or leaving the edge zone)
restarts it.

Auto-scroll naturally stops at either end of the movie because
`selectionShiftTo` reuses the same `Math.max(0, Math.min(...))` clamp as
normal dragging — no separate boundary check needed.

## Full wiring

```js
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
    if (selectionAutoScrollDir !== 0) {
        // Leaving the edge zone after auto-scrolling -- resync the drag
        // anchor to the current pointer position/time. Without this,
        // the delta below would be computed against the position the
        // drag originally started at, snapping the clip back to
        // wherever it was before auto-scroll ran and discarding all
        // of that movement.
        selectionDragStartX = e.clientX;
        selectionDragStartT0 = startT;
    }
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
selectionEl.addEventListener('lostpointercapture', endSelectionDrag);
```

Note the anchor-resync guard right after the edge-zone checks: `selectionDragStartX`/
`selectionDragStartT0` are only set once, at `pointerdown`, and the auto-scroll
interval moves the clip by writing `startT` directly — it never touches those
anchor variables. If the user drags into an edge zone (auto-scroll takes over)
and then moves back toward the middle *without releasing the pointer*, the code
re-enters the delta-based branch below with a stale anchor: `deltaPx`/`deltaSec`
would be computed against the original pointerdown position, and
`selectionShiftTo(selectionDragStartT0 + deltaSec)` would snap the clip back to
wherever it was *before* auto-scroll ran, discarding all of that scrolled
movement. Since dragging to an edge and correcting back toward the middle
without releasing the button is the natural way to use this control, that isn't
an edge case — it's the common path.

The fix relies on `selectionAutoScrollDir` still being nonzero on the exact
`pointermove` event where the cursor exits the edge zone (it's only reset to 0
inside `stopSelectionAutoScroll()`, called on the next line). That lets the new
`if` block detect "auto-scroll was just active" and resync the anchor to the
*current* pointer position and *current* (post-auto-scroll) `startT` before the
delta calculation runs. For that same event, `deltaPx` then computes to `0`,
so `selectionShiftTo` is called with the position auto-scroll already reached —
a no-op that preserves it rather than reverting it. Every subsequent
`pointermove` drags normally from this fresh anchor.

Same disabled-state guard as every other interactive control in this
panel (`isBlob || !src || !isFinite(vidDur)`), same `e.button !== 0`
right-click guard as the overview scrubber (dragging with a right-click
button held must not move the selection), same `stopPropagation()`
pattern as every other drag handle in this file. `lostpointercapture` is
wired alongside `pointerup`/`pointercancel` as the same safety net this
bug class already required elsewhere on this branch: if capture is lost
without either of those firing (browser-initiated capture loss), the
drag/auto-scroll would otherwise never stop.

`render('both')` — called from both the normal-drag path and the
auto-scroll interval — is the panel's existing render function, so a
single click or a normal (non-edge) drag gets the filmstrip window
reframe (via the already-shipped `ensureFilmstripWindow()`/
`refetchFilmstripTiles()`), the two large previews, and the duration
line "for free": those interactions settle, the 220ms tile-refetch
debounce fires once motion stops, and `scheduleFilmstripRefresh()`'s
own `renderFilmstripHandles()` call keeps the handles/band visually in
sync in the meantime.

That "for free" reframe does *not* hold for a sustained edge
auto-scroll. The auto-scroll interval ticks every
`SELECTION_AUTOSCROLL_INTERVAL_MS` (100ms), and each tick's
`selectionShiftTo` → `render('both')` re-arms the same 220ms debounce
timer that `ensureFilmstripWindow()`'s reframe is gated behind. Because
100ms is shorter than the 220ms debounce, a sustained hold perpetually
resets that timer before it ever fires — the filmstrip window
(`_filmstripWindow`) never reframes for as long as the hold continues.
Only the band's position *within* that stale, unchanging window keeps
updating, and since that position is clamped to the window's bounds,
the band visually collapses to zero width at the edge instead of the
window panning forward/backward. `startSelectionAutoScroll`'s tick
therefore calls `ensureFilmstripWindow()`/`renderFilmstripHandles()`
directly (see above) instead of relying on the debounce — those two
calls are cheap and side-effect-free (no network), so calling them
every 100ms is fine. Tile refetching stays debounced (220ms) exactly
as it already is for handle drags — a continuous drag or auto-scroll
firing `render()` faster than the debounce interval simply keeps
deferring the tile *refetch* until motion stops, identical to how
`wireFilmstripDrag` already behaves today; only the window-reframe
math needed to be pulled out from behind that debounce.

## Interaction with the handles

`.sc-gif-filmstrip-handle-start`/`-end` are later in the DOM than
`.sc-gif-filmstrip-selection` (already true today), so — once the
selection band's `pointer-events` changes from `none` to `auto` — the
handles still receive pointer events preferentially wherever they overlap
the band, since later elements win hit-testing ties in the same stacking
context. Dragging near either handle still grabs the handle; dragging the
open middle area grabs the selection band. No z-index changes needed.

## Closing the panel mid-auto-scroll

This branch has already hit exactly this leak once before: `close()`
clears `_filmstripTimer` and every pending `thumbTimers` entry so a
pending debounce can't resurrect a hidden `<video>` after the panel is
gone. `selectionAutoScrollTimer` is the same hazard in `setInterval`
form — if the panel is closed while auto-scroll is actively running, an
uncleared interval keeps firing forever (this closure's `startT`/`endT`/
`render` keep being invoked against a detached, invisible panel), wasting
`grabPreviewFrame` calls indefinitely. `close()` must also stop it:

```js
const close = () => {
    clearTimeout(_filmstripTimer);
    Object.values(thumbTimers).forEach(clearTimeout);
    stopSelectionAutoScroll();
    _revokeGifResult(); destroyScrubClone(); panel.remove();
};
```

## CSS changes (in `injectPanelCss()`)

- `.sc-gif-filmstrip-selection`: `pointer-events: none` → `pointer-events: auto`,
  plus `cursor: grab` and `touch-action: none` (consistent with every other
  draggable surface in this file — without it, a touch drag on the band can
  be hijacked by the browser's default touch scroll/zoom gestures instead of
  reaching the pointer handlers).
- New rule: `.sc-gif-filmstrip-selection:active { cursor: grabbing; }`.

No other visual changes — the existing amber tint/borders already make
clear which region is "the selection"; a cursor change is enough
affordance for draggability, consistent with how the handles themselves
signal drag-ability (`cursor: ew-resize`) without extra hover treatment.

## Testing plan

No automated test framework exists in this repo — verification is
`node --check cytube.gifmaker.user.js` (syntax only) plus manual testing:

1. Open the panel, confirm the cursor changes to a grab hand over the
   amber selection band (not over the handles or the dimmed edges).
2. Drag the band left/right by a small amount; confirm both START and END
   times shift together by the same amount, duration stays exactly the
   same, and the filmstrip/previews update.
3. Drag slowly toward the left edge of the strip and stop just short of
   it; confirm normal 1:1 dragging still applies right up to the edge
   zone.
4. Drag into the left edge zone and hold without further mouse movement;
   confirm the clip continuously moves backward at a steady rate until
   released or dragged back toward the middle. Same for the right edge/
   forward.
5. Hold the auto-scroll near t=0 or the end of the movie; confirm it
   stops cleanly at the boundary rather than erroring or going negative/
   past `vidDur`.
6. Release mid-drag and mid-auto-scroll in both cases; confirm the motion
   stops immediately and no stray `setInterval` keeps running (e.g. open
   the panel, drag-and-release repeatedly, confirm nothing accumulates or
   speeds up on subsequent drags).
7. Right-click-drag on the selection band; confirm it does not move.
8. Start an edge auto-scroll, then close the panel (✕) while it's still
   running; confirm the clip stops moving immediately (no residual
   `setInterval` still ticking — reopen the panel and confirm it opens
   cleanly at the expected position, not mid-auto-scroll from before).
9. `node --check cytube.gifmaker.user.js` passes.
