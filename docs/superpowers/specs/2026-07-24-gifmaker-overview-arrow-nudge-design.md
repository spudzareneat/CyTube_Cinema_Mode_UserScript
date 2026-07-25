# GIF Maker overview scrubber — arrow-key nudge — design

## Goal

The whole-movie overview scrubber (already shipped on this branch) maps a
long movie onto a ~390px bar — at second-level precision, mouse dragging
alone can't reliably land on a specific timestamp. Add keyboard nudging:
once the track has focus, Left/Right shifts the current clip window by
±1s, Shift+Left/Right by ±10s, preserving whatever clip length is already
set (this is a fine-tune on top of a click/drag jump, not another
teleport-and-reset).

This only touches `cytube.gifmaker.user.js` — specifically `openGifPanel`
and `injectPanelCss`. No other file changes.

## Focus model

`.sc-gif-overview-track` gets `tabindex="0"`, making it a normal focusable
element — clicking it (the existing click-to-jump interaction) also gives
it focus, same as clicking any other focusable control. A `:focus` CSS
rule adds a visible amber outline so it's clear keyboard nudging is now
available.

Arrow-key handling is a `keydown` listener on the track element itself,
**not** a document-level listener — this is the key safety property: with
a per-element listener, arrows only ever act while the track has focus.
While the user is typing in the caption text fields or the ImgBB key
field, focus is elsewhere, so arrow keys there behave normally (moving the
text cursor) and are never intercepted.

`cytube.pc.user.js` shares this script's exact `@match` URLs and installs
an unguarded document-level `ArrowLeft`/`ArrowRight` video-seek handler,
so without stopping propagation, nudging the clip window would also seek
the live video — the handler below calls `e.stopPropagation()` for this
reason.

## Nudge, not re-teleport

A click or drag-release on the overview track already resets `startT`/
`endT` to a fresh `DEFAULT_CLIP_LEN`-length clip centered at the clicked
point (the existing "teleport" behavior). Arrow-key nudging is different
on purpose: it **shifts** the current window by the step amount while
**preserving the clip's current duration** — if the user has already
fine-tuned the clip length via the filmstrip's own handles, nudging the
position shouldn't discard that work.

```js
const OVERVIEW_NUDGE_SEC = 1;
const OVERVIEW_NUDGE_SEC_FAST = 10;

overviewTrack.setAttribute('tabindex', '0');
overviewTrack.addEventListener('keydown', (e) => {
    if (isBlob || !src || !isFinite(vidDur)) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault(); // arrows would otherwise scroll the page/chat behind the panel
    e.stopPropagation(); // stop cytube.pc.user.js's document-level arrow-key video-seek handler from also firing
    const step = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? OVERVIEW_NUDGE_SEC_FAST : OVERVIEW_NUDGE_SEC);
    const dur = endT - startT;
    let newStart = startT + step;
    newStart = Math.max(0, Math.min(newStart, vidDur - dur));
    startT = newStart;
    endT = startT + dur;
    render('both');
});
```

Same disabled-state guard as the click/drag path
(`isBlob || !src || !isFinite(vidDur)`). `render('both')` is the panel's
existing render function — same one the click/drag teleport and the
filmstrip handles already use, so this gets the filmstrip reframe, tile
refetch, and both large previews "for free."

The `Math.max(0, Math.min(newStart, vidDur - dur))` clamp keeps the whole
window (not just one edge) inside `[0, vidDur]` — nudging off either end
of the movie stops there rather than letting `startT` go negative or
`endT` exceed `vidDur`, and it never changes `dur`, so the clip length is
never silently altered by a nudge.

## CSS addition (in `injectPanelCss()`)

One new rule: `.sc-gif-overview-track:focus` — a 2px amber outline
(`outline: 2px solid #ffcc44 !important; outline-offset: 1px !important;`)
so keyboard focus is visually obvious, consistent with the panel's
existing amber accent color used throughout (handles, selection band,
viewport indicator).

## Testing plan

No automated test framework exists in this repo — verification is
`node --check cytube.gifmaker.user.js` (syntax only) plus manual testing:

1. Click the overview track once (a normal jump); confirm it now shows a
   visible amber focus outline.
2. Press Right arrow a few times; confirm the clip window shifts forward
   by 1s per press, the filmstrip/previews update, and the clip's
   *duration* (shown in the "Duration" line) stays exactly the same as
   before the first press.
3. Press Shift+Right; confirm a 10s shift instead of 1s.
4. Press Left/Shift+Left near the very start of the movie (`startT` close
   to 0); confirm it clamps at 0 rather than going negative or erroring.
5. Press Right/Shift+Right near the very end; confirm it clamps so `endT`
   never exceeds the movie's duration.
6. Click into the caption top/bottom text fields or the ImgBB key field,
   then press Left/Right arrow; confirm the text cursor moves normally in
   the field and the overview scrubber does **not** nudge — this is the
   whole point of scoping the listener to the track element, not the
   document.
7. Tab through the panel's focusable elements; confirm the overview track
   receives focus in the tab order like any other control (no explicit
   ordering requirement, just confirm nothing breaks).
8. `node --check cytube.gifmaker.user.js` passes.
