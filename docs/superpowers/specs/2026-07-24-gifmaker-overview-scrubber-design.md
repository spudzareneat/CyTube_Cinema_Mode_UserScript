# GIF Maker whole-movie overview scrubber — design

## Goal

The filmstrip trimmer (already shipped on this branch) only shows a local
~12s window around the current selection — there's no fast way to jump to
a totally different part of a long movie once the panel is open. Add a
thin, full-width "overview" scrubber above the filmstrip that spans the
whole video: click or drag anywhere on it and, on release, the panel
**teleports** — `startT`/`endT` reset to a fresh default-length clip
centered at that point, and the filmstrip reframes there. This was
validated with the user via an interactive HTML mockup (drag-to-preview,
release-to-commit) during brainstorming.

This only touches `cytube.gifmaker.user.js` — specifically `openGifPanel`
and `injectPanelCss`. No other file changes.

## Layout

A new `.sc-gif-overview` block is inserted directly above the existing
`.sc-gif-filmstrip-window-label`. Top to bottom:

1. **Track** (`.sc-gif-overview-track`) — a thin (16px) full-width bar
   representing `[0, vidDur]`, dark background, rounded corners, click
   cursor.
2. **Viewport indicator** (`.sc-gif-overview-viewport`) — a small amber
   block inside the track showing where the filmstrip's current local
   window (`_filmstripWindow`) sits within the whole video. For a
   90-minute movie and a ~12s local window this is a sliver (~0.2% of the
   track width) — given a minimum width (`min-width: 4px`-equivalent, via
   `Math.max` on the computed percentage) so it never disappears entirely.
3. **Ghost line** (`.sc-gif-overview-ghost`) — a 2px white vertical line
   with a glow, hidden by default, shown only while dragging, following
   the pointer's position on the track live.
4. **Labels row** — `0:00` on the left, `vidDur` formatted on the right,
   and a center label (`.sc-gif-overview-current`) that reads
   `Currently editing: <start time>` normally, or
   `Jump to: <time> (release to commit)` while a drag is in progress.

## Interaction: drag-to-preview, release-to-commit

While dragging, only the ghost line and the center label move — `startT`,
`endT`, and the filmstrip itself are **not** touched, so no thumbnail
refetching happens mid-drag (the filmstrip's existing 220ms debounce would
otherwise make touching it during a coarse whole-movie drag both wasteful
and janky, since the target position can change many times a second).
Only on `pointerup` does the panel actually jump:

```js
const overviewTrack = $('#sc-gif-overview-track');
const overviewViewport = $('#sc-gif-overview-viewport');
const overviewGhost = $('#sc-gif-overview-ghost');
const overviewCurrent = $('#sc-gif-overview-current');

function overviewTimeFromEvent(e) {
    const rect = overviewTrack.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    return pct * vidDur;
}

let overviewDragging = false;
overviewTrack.addEventListener('pointerdown', (e) => {
    if (isBlob || !src || !isFinite(vidDur)) return;
    e.stopPropagation();
    overviewDragging = true;
    overviewTrack.setPointerCapture(e.pointerId);
    overviewGhost.style.setProperty('display', 'block', 'important');
    const pct = ((overviewTimeFromEvent(e)) / vidDur) * 100;
    overviewGhost.style.left = pct + '%';
});
overviewTrack.addEventListener('pointermove', (e) => {
    if (!overviewDragging) return;
    const t = overviewTimeFromEvent(e);
    overviewGhost.style.left = (t / vidDur) * 100 + '%';
    overviewCurrent.textContent = 'Jump to: ' + _fmtClockTenths(t) + ' (release to commit)';
});
function overviewCommit(e) {
    if (!overviewDragging) return;
    overviewDragging = false;
    overviewGhost.style.setProperty('display', 'none', 'important');
    try { overviewTrack.releasePointerCapture(e.pointerId); } catch (err) {}
    const t = overviewTimeFromEvent(e);
    startT = Math.max(0, t - DEFAULT_CLIP_LEN / 2);
    endT = Math.min(vidDur, startT + DEFAULT_CLIP_LEN);
    clampStart();
    clampEnd();
    render('both');
}
overviewTrack.addEventListener('pointerup', overviewCommit);
overviewTrack.addEventListener('pointercancel', (e) => {
    overviewDragging = false;
    overviewGhost.style.setProperty('display', 'none', 'important');
    try { overviewTrack.releasePointerCapture(e.pointerId); } catch (err) {}
    renderFilmstripHandles(); // restore the "Currently editing" label, no jump
});
```

A plain click (no intervening `pointermove`) still fires `pointerdown` then
`pointerup` at the same coordinate, so click-to-jump works with no extra
code — the same commit path handles both click and drag.

The `.sc-gif-overview-ghost` CSS rule (see below) sets `display: none
!important`, matching every other rule in this file's stylesheet — so the
JS toggle above must itself use `style.setProperty(prop, val, 'important')`
rather than a plain `style.display = …` assignment, or the inline value is
silently outranked by the stylesheet's `!important` and the ghost line
never becomes visible. This exact class of bug (inline style losing to an
author-stylesheet `!important` rule) has bitten this branch twice before —
watch for it on every new dynamic style write against this panel's CSS.

`render('both')` is the panel's existing render function — it already
drives `scheduleFilmstripRefresh()` (window reframe + tile refetch via the
already-shipped `ensureFilmstripWindow()`/`refetchFilmstripTiles()`) and
the two large preview thumbnails, so the teleport gets the filmstrip and
previews "for free" from work already on this branch. Nothing about the
filmstrip's own reframe/refetch logic changes.

## Viewport indicator + current-label rendering

Both are driven from the existing `renderFilmstripHandles()` function
(called on every `render()`, so this needs no new render entry point) —
extended to also position the overview elements from `_filmstripWindow`
and `startT`:

```js
function renderFilmstripHandles() {
    const win = _filmstripWindow;
    if (!win) return;
    // ...existing handle/dim/selection code, unchanged...

    if (isFinite(vidDur) && vidDur > 0) {
        const ovStart = (win.windowStart / vidDur) * 100;
        const ovEnd = (win.windowEnd / vidDur) * 100;
        overviewViewport.style.left = ovStart + '%';
        overviewViewport.style.width = Math.max(0.5, ovEnd - ovStart) + '%';
    }
    if (!overviewDragging) {
        overviewCurrent.textContent = 'Currently editing: ' + _fmtClockTenths(startT);
    }
}
```

The `!overviewDragging` guard stops this from clobbering the "Jump to: …"
label that `pointermove` is actively writing during a drag — `render()`
(and therefore `renderFilmstripHandles()`) can still fire from unrelated
causes (e.g. a caption edit doesn't call it, but nothing prevents future
code from calling `render()` while a drag is in progress) without
fighting the live drag label.

## Disabled state

Matches the existing guard pattern already used throughout the panel
(`refreshThumb`, `scheduleFilmstripRefresh`'s tile fetch): if
`isBlob || !src || !isFinite(vidDur)`, `pointerdown` returns immediately
and no drag starts. The track still renders (so the panel's layout doesn't
jump), just inert — same as how the filmstrip already renders blank tiles
in that state rather than hiding itself entirely.

## CSS additions (in `injectPanelCss()`)

New classes: `.sc-gif-overview`, `.sc-gif-overview-track`,
`.sc-gif-overview-viewport`, `.sc-gif-overview-ghost`,
`.sc-gif-overview-labels`, `.sc-gif-overview-current`. Values match the
validated mockup: dark track (`#17171a`, 1px border), amber
(`rgba(255,204,68,0.55)`) viewport block with amber 1px borders, white 2px
ghost line with a glow (`box-shadow: 0 0 4px rgba(255,255,255,0.8)`),
10px labels at `rgba(255,255,255,0.4)`, amber+bold current-position label
consistent with the rest of the panel's accent color.

## Testing plan

No automated test framework exists in this repo — verification is
`node --check cytube.gifmaker.user.js` (syntax only) plus manual testing:

1. Open the panel on a locally-hosted (non-YouTube) file with a known
   duration. Confirm the overview track renders full-width above the
   filmstrip's window label, with a small amber viewport block positioned
   correctly (near wherever the default clip landed) and correct `0:00`/
   total-duration labels.
2. Click somewhere far from the current position; confirm the panel
   teleports there immediately (fresh ~2s clip, filmstrip reframes, large
   previews update) without needing to drag.
3. Press and drag along the track; confirm the ghost line follows the
   cursor live, the center label reads "Jump to: … (release to commit)",
   and — critically — the filmstrip/previews do **not** change mid-drag.
   Release; confirm the teleport commits at the release point.
4. Drag past either edge of the track; confirm the position clamps to
   `0`/`vidDur` rather than erroring.
5. Start a drag, then trigger `pointercancel` (e.g. via a browser gesture
   that cancels pointer capture); confirm no jump occurs and the label
   reverts to "Currently editing: …".
6. After a teleport, confirm the fine filmstrip handles (drag, ±0.5
   buttons, "⤓ Now") all still work normally at the new location — this
   is pure integration with already-shipped code, but worth confirming
   nothing about the jump leaves stale state behind (e.g. `capPos` for
   captions should be unaffected, since captions aren't tied to a specific
   timestamp).
7. `node --check cytube.gifmaker.user.js` passes.
