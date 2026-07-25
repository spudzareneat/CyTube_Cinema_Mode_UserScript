# Port GIF Maker improvements back into cytube.pc.user.js — design

## Goal

`cytube.pc.user.js`'s GIF Maker panel still has the original trim UI
(single scrubber, auto-reset-on-start-move, both thumbnails with their
own caption handles). Every improvement built on the
`feature/gifmaker-standalone` branch — filmstrip trimmer, consolidated
caption handles, whole-movie overview scrubber with arrow-key nudging,
and the draggable selection band with edge auto-scroll — gets ported into
`cytube.pc.user.js`'s `openGifPanel`/CSS, replacing the equivalent old
code.

This is a **port of already-designed, already-reviewed code**, not new
design work — every function below already exists, validated, in
`cytube.gifmaker.user.js` on this same branch. The source of truth for
exact code is that file's current committed state; this document records
what transfers, what doesn't, and where the two scripts have to diverge.

## Explicitly NOT ported

- **ImgBB key management.** `cytube.pc.user.js` already manages the
  ImgBB key through its own settings modal (`⚙` button), which is fine
  as-is. Neither the standalone script's collapsible inline key section
  nor its "Download-only when no key" result-view behavior are ported.
  `cytube.pc.user.js`'s result view keeps showing both Download and
  Upload unconditionally, with Upload's existing
  `"Add an ImgBB API key in ⚙ Settings to enable uploads."` hint on click
  when no key is set — confirmed with the user.
- **The video-corner record button relocation** (into CyTube's native
  `#videocontrols` `.btn-group`). This doesn't apply: `cytube.pc.user.js`
  already `display: none`s that entire native control row
  (`#resizewrap, footer, #userlisttoggle, #rightcontrols, ...`) as part
  of its fullscreen layout, and `#videocontrols` lives inside
  `#rightcontrols`. `cytube.pc.user.js` keeps its own existing floating
  circular `◉` button (`#sc-gif-btn`) exactly as it is today.
- Title/filename slugging (`_gifTitleSlug()`, `parseMovieFilename`,
  `lastMovieTitle`) — `cytube.pc.user.js`'s TMDB-aware version is kept
  unchanged; the standalone script's raw-title version was a deliberate
  simplification specific to not having TMDB integration, which doesn't
  apply here.
- Anything about `cytube.gifmaker.user.js`'s own video-corner button,
  `isYouTubeMedia()`, boot sequence, or `@match`/metadata — none of that
  is userscript-level code that "ported" means anything for; only the
  GIF panel's *internals* are shared code.

## What ports, and where it diverges

All of the following are copied from `cytube.gifmaker.user.js`'s current
`openGifPanel`/`injectPanelCss`-equivalent CSS block **verbatim**, except
for the specific divergences called out:

1. **Filmstrip trimmer** — replaces the single `<input type=range
   id="sc-gif-scrub-start">` + `resetEndFromStart()` auto-reset behavior.
   `MIN_CLIP_GAP`/`MAX_CLIP_LEN`/`FILMSTRIP_*` constants are new to
   `cytube.pc.user.js`. `render()`'s duration-check literal `0.1` becomes
   `MIN_CLIP_GAP` (matching the standalone script's already-fixed
   version) — this is a magic-number cleanup that comes along with
   introducing the constant, not a behavior change.
2. **Caption handles consolidated onto START** — the END thumbnail's own
   drag handles (`#sc-gif-cap-handle-*-end`) are removed from the
   template; `wireCapHandle`'s wiring loop only wires `'start'`. END
   keeps its caption *text* overlay elements (still renders the mirrored
   preview) and gains `sc-gif-thumb-readonly`.
3. **Whole-movie overview scrubber** — click/drag-to-jump with a live
   ghost-line preview, committed only on release; `DEFAULT_CLIP_LEN`
   (already declared in `cytube.pc.user.js`'s `openGifPanel`, unchanged)
   is reused for the teleport's fresh-clip length, exactly as the
   standalone script does.
4. **Arrow-key nudging on the overview scrubber** — Left/Right shifts by
   `OVERVIEW_NUDGE_SEC` (1s), Shift+arrow by `OVERVIEW_NUDGE_SEC_FAST`
   (10s), duration preserved. The `e.stopPropagation()` in its `keydown`
   handler is **still required and still does the same job**, just
   intra-file now instead of cross-file: `cytube.pc.user.js` has its own
   document-level `ArrowLeft`/`ArrowRight` video-seek handler (the one
   the standalone script's fix was specifically written to avoid
   triggering), and without stopping propagation the same collision
   would happen within this one file.
5. **Draggable filmstrip selection band with edge auto-scroll** — delta-
   based shift (duration preserved) while dragging the amber band;
   holding at either edge of the visible strip auto-scrolls at a fixed
   rate (`SELECTION_*` constants). `close()` gains the same
   `stopSelectionAutoScroll()` cleanup call the standalone script needed,
   for the identical reason (an uncleared interval must not keep running
   against a closed/detached panel).

## Known, deliberately out-of-scope adjacent issue

While porting the arrow-key handler's `stopPropagation()` fix, note that
`cytube.pc.user.js`'s own document-level arrow-key handler (used for
video seeking) only excludes `TEXTAREA`/`INPUT`/`contentEditable`
targets — not `<select>` or `<button>` elements. This means the GIF
panel's FPS/Width/Shape dropdowns (and every button in the panel) can
still leak arrow-key presses to that handler when focused, exactly the
issue flagged (and left unfixed, by the user's choice) during the
standalone script's ImgBB-collapse review. This port does not fix that —
it's a pre-existing, cross-cutting gap in `cytube.pc.user.js`'s own
handler, not something introduced by anything being ported, and touching
it is out of scope here. Flagged for a possible future follow-up.

## Testing plan

No automated test framework exists in this repo — verification is
`node --check cytube.pc.user.js` (syntax only) plus manual testing,
mirroring the standalone script's own testing plans for each ported
piece (filmstrip trim, caption consolidation, overview scrubber + arrow
nudge, selection drag + auto-scroll) — same behaviors, same edge cases,
now exercised inside `cytube.pc.user.js`'s fullscreen layout instead of
CyTube's default layout. Additionally:

1. Confirm `cytube.pc.user.js`'s own existing GIF-panel entry points
   still work unchanged: the floating `◉` button, and the chat
   right-click → "Create a GIF from here" (`openGifPanel(initialSec)`
   with a specific timestamp).
2. Confirm the ImgBB Upload flow (via `⚙ Settings`, unrelated to this
   port) still works exactly as before — both when a key is already
   saved and when it isn't.
3. Confirm nothing about the fullscreen layout (chat panel, floating
   button row, top-bar dimming) is disturbed — this port only touches
   code inside `#sc-gif-panel`'s own template/logic/CSS.
4. `node --check cytube.pc.user.js` passes.
