# GIF Maker filmstrip trimmer — design

## Goal

Replace the GIF Maker panel's current trim UI (a single scrubber under the
START thumbnail, plus ±0.5s nudge buttons, where moving START always resets
END to `START + 2s`) with a proper dual-handle filmstrip trimmer, matching
the pattern used by YouTube's clip trimmer, iOS Photos, and most GIF/clip
tools: a strip of thumbnail tiles spanning a local time window, with two
independently-draggable handles marking the in/out points directly on the
strip.

Also consolidates meme-caption positioning: both caption handles (top and
bottom) move to the START preview frame only; the END preview frame becomes
a read-only mirror that shows where the same caption lands on the closing
frame, with no drag handles of its own.

This only touches `cytube.gifmaker.user.js` (the standalone script from the
prior branch work) — specifically `openGifPanel` and `injectPanelCss`. No
other file changes.

## Background: what's being replaced

Today, `openGifPanel`'s trim UI is:
- A single `<input type="range" id="sc-gif-scrub-start">` under the START
  thumbnail only (END has an empty `.sc-gif-scrub-spacer` div just to keep
  its label/buttons row aligned with START's).
- `resetEndFromStart()`, called every time START changes (via the scrubber,
  "⤓ Now", or ±0.5), which snaps `endT = min(vidDur, startT + 2)`. END's own
  ±0.5 buttons are the only way to fine-tune END independently afterward.
- Two large preview thumbnails (`#sc-gif-thumb-start`/`-end`), each with its
  own pair of draggable caption-position handles (top + bottom), both
  showing the same shared caption text/color/size — only the drag target
  differs per thumb, but they write to the same shared `capPos` state, so
  dragging either thumb's handle moves the caption on both.

## New trim UI: filmstrip + independent handles

### Layout

A new `.sc-gif-filmstrip` block is inserted directly above the existing
`.sc-gif-marks` row (which keeps its two large preview cards, described
below). Top to bottom:

1. A small window-range label: `Window: 8.4s – 20.4s` — the absolute
   timestamps the strip currently covers.
2. The strip itself: a fixed-height (64px) horizontal bar containing:
   - **Tiles** — 10 equal-width thumbnail tiles spanning the current
     window, each a real frame grabbed via the existing
     `grabPreviewFrame(src, time, w)` (same hidden crossOrigin clone +
     `requestVideoFrameCallback` capture the two large previews already
     use), at evenly-spaced timestamps across the window. Each tile shows
     the existing `.sc-gif-thumb-loading` spinner treatment while its frame
     is being fetched.
   - **Dim overlays** — a semi-transparent black layer (`rgba(0,0,0,0.55)`)
     covering the portion of the strip left of the start handle and right
     of the end handle.
   - **Selection band** — the region between the two handles gets a subtle
     amber tint (`rgba(255,204,68,0.08)` background) with 2px amber borders
     on both edges.
   - **Two handles** — absolutely-positioned 14px-wide grab targets (an
     amber 6×28px grip bar centered in each), positioned by `left: <pct>%`
     computed from the handle's time within the current window. Dragging
     either is a plain pointer-events drag (`pointerdown`/`pointermove`/
     `pointerup`, matching the existing drag-handle pattern already used for
     the panel header and caption dots) — **not** a native
     `<input type=range>`, since two independent handles on one track isn't
     expressible with a single range input.

### Window framing — sticky viewport, reframed only near its edges

The window is *not* the whole movie — for a 90-minute film, a whole-movie
filmstrip would make each tile represent minutes, useless for picking a
few-second window. It's also not recomputed from scratch on every render:
doing `windowStart = startT - MARGIN` unconditionally would shift the
window on nearly every drag tick (any 0.1s move of `startT` moves
`windowStart` by 0.1s too), which would defeat the whole point of
debouncing tile regeneration below — the "did the window change" check
would almost never see two equal windows in a row.

Instead the window is **sticky state** (`_filmstripWindow`, persisted
across renders) that only gets recomputed — and only then does the strip
refetch its 10 thumbnails — when the current selection drifts within a
small pad of the *existing* window's edges:

```js
const FILMSTRIP_MARGIN = 3;       // seconds of context on each side when (re)framing
const FILMSTRIP_MIN_WINDOW = 12;  // never show a window narrower than this
const FILMSTRIP_EDGE_PAD = 1;     // reframe once a handle gets this close to the edge
const FILMSTRIP_TILES = 10;

let _filmstripWindow = null; // { windowStart, windowEnd } — sticky across renders

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
```

This also means handle dragging effectively **auto-pans**: as you drag a
handle toward the edge of the visible strip, the window reframes itself
(with the usual margin) before you actually run out of room, rather than
hard-stopping at a fixed boundary. No scroll physics needed — reframing is
just "recompute + refetch," the same operation that already happens on
open.

### Handle position math (every `render()` call — cheap, no thumbnail fetch)

```js
function renderFilmstripHandles() {
    const win = _filmstripWindow;
    const pctFor = t => Math.max(0, Math.min(100,
        ((t - win.windowStart) / (win.windowEnd - win.windowStart)) * 100));
    const sp = pctFor(startT), ep = pctFor(endT);
    // position the two handle elements at sp%/ep%, size the dim-left/
    // dim-right overlays and the selection band from sp/ep — all plain
    // style writes, no network/canvas work. Safe to call on every render,
    // including every pointermove tick of a drag.
}
```

### Tile regeneration (debounced — the expensive part, rare in practice)

Regenerating all 10 tiles means up to 10 sequential `grabPreviewFrame`
calls through the same serialized hidden-clone queue the two large
previews already use (`_gifScrub.busy` chain) — too slow to run on every
`pointermove` tick of a drag. Thanks to the sticky window above, this only
needs to actually happen when `ensureFilmstripWindow()` returns `true`
(i.e., reframing), which is inherently rare during a drag — but the fetch
itself is still debounced the same way `refreshThumb()` already debounces
the two large previews (180ms today), at 220ms, so a fast drag that
crosses the edge-pad repeatedly only fetches once it settles:

```js
let _filmstripTimer = null;
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
```

Called from the existing `render()` function (which already runs on every
start/end change, from every interaction path: marks buttons, filmstrip
drag, "⤓ Now"). `renderFilmstripHandles()` runs eagerly (not debounced) so
handle position/dim/selection tracking always feels immediate; only the
network-bound tile refetch is debounced and edge-gated.

### Removed: the old scrubber and auto-reset

- `#sc-gif-scrub-start` (`<input type=range>`) and `.sc-gif-scrub-spacer`
  are deleted from the panel HTML entirely — the filmstrip replaces both.
- `resetEndFromStart()` is deleted. Nothing calls it anymore.
- The `start-current`/`start-minus`/`start-plus` button handlers now just
  mutate `startT`, call `clampStart()`, and `render('both')` — they no
  longer touch `endT` at all. `end-minus`/`end-plus` are unchanged (already
  independent today).

### New: a maximum clip length

Today, hitting a large clip duration is impractical (moving START always
snaps END back to a 2s window; you'd need ~dozens of "+.5" clicks on END
alone to build a long clip). With independent free-dragging handles, this
friction disappears — a single fast drag can produce a 60-second clip
attempt, which the encoder would eventually reject via its 60s *capture*
timeout, but only after wastefully spinning up the capture pipeline first.
`clampStart()`/`clampEnd()` gain a new rule enforcing `MAX_CLIP_LEN = 10`
seconds (generous for a meme GIF, comfortably under the 60s capture
timeout that remains the hard backstop):

```js
const MIN_CLIP_GAP = 0.1;  // unchanged from today
const MAX_CLIP_LEN = 10;   // new

function clampStart() {
    startT = Math.max(0, startT);
    if (isFinite(vidDur)) startT = Math.min(startT, vidDur - MIN_CLIP_GAP);
    if (endT - startT < MIN_CLIP_GAP) startT = Math.max(0, endT - MIN_CLIP_GAP);
    if (endT - startT > MAX_CLIP_LEN) startT = endT - MAX_CLIP_LEN;
}
function clampEnd() {
    endT = Math.min(isFinite(vidDur) ? vidDur : endT, Math.max(endT, startT + MIN_CLIP_GAP));
    if (endT - startT > MAX_CLIP_LEN) endT = startT + MAX_CLIP_LEN;
}
```

Both are called after every drag/button mutation to either handle, same as
today's call sites.

## Caption handles: consolidated on START

- `#sc-gif-cap-handle-top-start` / `#sc-gif-cap-handle-bottom-start` are
  unchanged — both stay draggable on the START thumbnail.
- `#sc-gif-cap-handle-top-end` / `#sc-gif-cap-handle-bottom-end` are
  **removed** from the panel HTML. The `wireCapHandle` loop that currently
  wires both `['start', 'end']` thumbs now only wires `'start'`.
- The END thumbnail keeps its `.sc-gif-cap-top`/`.sc-gif-cap-bottom` text
  overlay elements (so `renderCaptionPreview('end')` still renders the
  mirrored text at the shared `capPos`), just with no handles on top of
  them. `renderCaptionPreviews()` (which calls `renderCaptionPreview` for
  both `'start'` and `'end'`) is unchanged — the text still needs to render
  on both frames, only the *drag input* moves to START exclusively.
- `.sc-gif-thumb-end` gets a `sc-gif-thumb-readonly` class (dashed border,
  slightly reduced opacity) as a visual cue that it's a preview, not an
  input — matching the mockup validated in brainstorming.
- The actual GIF-capture caption baking (`drawCaptions`/
  `drawCaptionBlockAdvanced` in `captureGifFrames`) is **unchanged** — it
  already renders the same `capPos`-derived position on every frame
  regardless of which thumb you dragged, so this is a pure UI
  simplification with no change to render output.

## CSS additions (in `injectPanelCss()`)

New classes: `.sc-gif-filmstrip`, `.sc-gif-filmstrip-window-label`,
`.sc-gif-filmstrip-strip`, `.sc-gif-filmstrip-tiles`,
`.sc-gif-filmstrip-tile`, `.sc-gif-filmstrip-dim-left`,
`.sc-gif-filmstrip-dim-right`, `.sc-gif-filmstrip-selection`,
`.sc-gif-filmstrip-handle`, `.sc-gif-filmstrip-handle-grip`,
`.sc-gif-thumb-readonly`. Values match the validated mockup (dark tile
gradient placeholders swapped for real `background-image` once loaded,
amber `#ffcc44` accent consistent with the rest of the panel's existing
palette, `.sc-gif-thumb-loading` spinner reused as-is).

Removed: `.sc-gif-scrub`, `.sc-gif-scrub:disabled`,
`.sc-gif-scrub-spacer` (no longer referenced by any HTML).

## Testing plan

No automated test framework exists in this repo (established in the prior
branch work) — verification is `node --check cytube.gifmaker.user.js`
(syntax only) plus manual testing in a real browser:

1. Open the GIF panel on a locally-hosted (non-YouTube) file. Confirm the
   filmstrip renders 10 real thumbnail tiles (not placeholders) spanning a
   window around the default 2s selection, with the amber selection band
   correctly framing the default clip.
2. Drag the start handle left and right; confirm: it can't cross the end
   handle minus the minimum gap, the selection band/dim overlays track it
   live, the START large preview updates (debounced), and dragging stops
   at the window edge rather than scrolling.
3. Drag the end handle; confirm the same, plus that a duration beyond 10s
   is unreachable (handle stops at `start + 10`).
4. Click "⤓ Now" / start ±0.5 / end ±0.5; confirm moving start no longer
   snaps end anywhere, and the filmstrip window re-frames (new tiles load)
   once a handle drifts near/outside the current window.
5. Type top and bottom caption text; confirm both drag-dots appear only on
   the START frame, dragging either one updates the live text position on
   *both* the START and END previews, and the END preview shows no drag
   dots of its own (dashed border, non-interactive).
6. Generate a GIF; confirm the captured/encoded result still bakes in the
   caption at the position set via the START-only handles (this pipeline
   is unchanged, but confirms the UI simplification didn't silently break
   the shared `capPos` wiring).
7. `node --check cytube.gifmaker.user.js` passes.
