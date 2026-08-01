# GIF Maker caption text effects — design

## Goal

Captions in the GIF Maker currently render with one fixed style: Impact font,
white-or-yellow fill with a black stroke outline (`drawCaptionBlockAdvanced`,
`cytube.gifmaker.user.js`). Add three new caption text effects — **drop
shadow**, **rainbow color-cycle**, and **wiggle** — giving captions more
variety than the single meme-outline look, while reusing the existing
canvas-based rendering pipeline. Single-file change: `cytube.pc.user.js` does
not duplicate caption code (it only exposes a title/floating-button bridge to
`cytube.gifmaker.user.js`, which owns the whole GIF panel), so no porting is
needed.

## Current pipeline (context)

- `drawCaptions(ctx, w, h, captions)` (`cytube.gifmaker.user.js:568`) is
  called once per captured frame, inline, from `captureGifFrames`'s `onFrame`
  handler (`cytube.gifmaker.user.js:641`) — unlike the video filters
  (deep-fry/VHS/zoom-shake), which post-process captured `ImageData` in a
  separate pass after capture, captions are burned in during capture itself.
- It delegates to `drawCaptionBlockAdvanced` per caption line (top/bottom),
  which wraps text via `wrapCaptionAtSize`, sets canvas text state via
  `applyCaptionCtxStyle` (font, fill color, black stroke), and draws
  `strokeText` then `fillText` per wrapped line.
- `captions.color` is a single shared value (`'white'` or `'yellow'`) used by
  both top and bottom captions — set via a two-option radio group
  (`.sc-gif-cap-color`, `cytube.gifmaker.user.js:1190-1193`).
- A separate "Effects" panel already exists for video-level filters
  (Deep-fry, VHS/glitch, Zoom/Shake), each a checkbox + intensity slider
  (0–100, default 60) pair, e.g. `sc-gif-fx-deepfry-on` /
  `sc-gif-fx-deepfry-amt` (`cytube.gifmaker.user.js:1230-1250`). These
  settings are read into an in-memory `fx` object per render and are **not**
  persisted to localStorage — they reset to off each time the panel opens.
- `captureGifFrames`'s `onFrame` already computes clip progress —
  `(t - startT) / span` — for its `onProgress` callback
  (`cytube.gifmaker.user.js:643`), immediately after the `drawCaptions` call
  at line 641.

## Scope decisions

- All three effects are **shared toggles** affecting both top and bottom
  captions together (matches how `color` already works as one shared value,
  and avoids doubling the already-dense caption UI with independent
  top/bottom controls).
- **Rainbow** is a third option in the existing `.sc-gif-cap-color` radio
  group (`white` / `yellow` / `rainbow`), not a separate Effects-panel
  checkbox — keeps caption color as one mutually-exclusive choice with no
  override logic needed.
- **Drop shadow** and **wiggle** are new checkbox+slider rows in the
  existing Effects panel, following the Deep-fry/VHS/Zoom-Shake pattern
  exactly (0–100 intensity, default 60, off by default). Named "Wiggle"
  specifically to avoid confusion with the existing "Zoom/Shake" *video*
  effect, which shakes the whole frame rather than just caption text.
- All three default off, non-persistent — same as the existing filter
  toggles, since these are per-clip creative choices, not stable
  preferences.

## Architecture

Extend the existing inline caption-drawing path rather than add a second
post-process pass, since captions are already drawn inline during capture:

- `captureGifFrames`'s `onFrame` hoists the progress calculation
  (`(t - startT) / span`, clamped to `[0, 1]`) into a local `progress`
  variable computed just before the `drawCaptions` call, and passes it
  through: `drawCaptions(ctx, w, h, captions, progress)`.
- `drawCaptions` / `drawCaptionBlockAdvanced` gain a `progress` parameter and
  read a new `captions.fx = { shadow: { on, amt }, wiggle: { on, amt } }`
  field (alongside the existing `captions.color`, now allowing `'rainbow'`).
- The live CSS-based preview (`cytube.gifmaker.user.js:1455-1458`) is
  updated separately with CSS approximations of each effect (see "Live
  preview" below) — it's a DOM element, not canvas, so it was never pixel-
  identical to the render already (font metrics only); these effects don't
  change that.

## Effects

- **Drop shadow**: in `applyCaptionCtxStyle`, when `fx.shadow.on`, set
  `ctx.shadowColor = 'rgba(0,0,0,0.7)'` and scale `shadowBlur` /
  `shadowOffsetX` / `shadowOffsetY` from `amt` (e.g. blur 0–14px, offset
  0–5px diagonally down-right). In `drawCaptionBlockAdvanced`, the shadow is
  set before `strokeText` and explicitly cleared (`ctx.shadowColor =
  'transparent'`) before `fillText`, so it renders once under the outline
  instead of doubling under the fill on top.
- **Rainbow**: in `applyCaptionCtxStyle`, when `captions.color === 'rainbow'`,
  `fillStyle` is computed from `progress`: `hsl(${progress * 360}, 90%, 60%)`
  — one full hue rotation across the clip's trimmed duration, synced
  identically across top and bottom captions (shared effect, same `progress`
  input). The black stroke outline is unaffected.
- **Wiggle**: in `drawCaptionBlockAdvanced`, when `fx.wiggle.on`, the caption
  block's center `(cx, cy)` is offset by a `progress`-driven sine wobble:
  `offsetX = sin(progress * 2π * 3) * amp`, `offsetY = cos(progress * 2π *
  2.3) * amp` (different frequencies so the motion isn't a simple circle).
  `amp` scales with both the `amt` slider and `fontPx` (bigger text wobbles
  proportionally more). Sine-based motion is used instead of per-frame
  random jitter because GIF capture runs at low fps (8–15) — random jitter
  at that rate reads as flicker/noise rather than motion, while a smooth
  wobble stays legible.

## UI

- `.sc-gif-cap-color` radio group: add
  `<label><input type="radio" name="sc-gif-cap-color" value="rainbow"> Rainbow</label>`
  after the existing Yellow option.
- `.sc-gif-fx-filters`: add two new `.sc-gif-fx-filter` rows after the
  existing Zoom/Shake row, matching its exact markup shape:
  - `sc-gif-fx-shadow-on` (checkbox) / `sc-gif-fx-shadow-amt` (range,
    0–100, default 60) — label "Drop shadow"
  - `sc-gif-fx-wiggle-on` (checkbox) / `sc-gif-fx-wiggle-amt` (range,
    0–100, default 60) — label "Wiggle"
- Where the panel currently reads `fx.deepFry` / `fx.vhs` / `fx.zoomShake`
  into the in-memory `fx` state object and where `captions` is assembled
  before calling `captureGifFrames` (`cytube.gifmaker.user.js:1500-1520` and
  the caption-building block near line 1838), add `fx.shadow` / `fx.wiggle`
  reads and attach them plus the (now three-way) `color` value onto the
  `captions` object passed through.

## Live preview

The existing preview at `cytube.gifmaker.user.js:1455-1458` sets inline
styles (`fontSize`, `lineHeight`) on a DOM element per caption. Approximate
each effect with CSS so the preview communicates intent without needing to
replicate the exact per-frame canvas math:

- Drop shadow → CSS `text-shadow`, derived from the same `amt` mapping used
  in the canvas render.
- Wiggle → a CSS `@keyframes` transform animation (fixed-loop wobble, not
  literally the per-frame sine formula, but visually representative).
- Rainbow → a CSS `@keyframes` animation cycling `color` through the hue
  range (or an animated `filter: hue-rotate`).

The canvas render during actual capture remains the source of truth; the
preview only needs to be close enough to judge before spending time on the
(slow) gif.js encode — consistent with how the existing preview already
approximates font metrics rather than matching pixel-for-pixel.

## Error handling

Pure local canvas math (shadow properties, HSL string construction, sine
offsets) — no network calls, no new failure modes. No new user-facing error
states needed beyond what already exists for capture/encode failures.

## Testing plan

No automated test framework covers the GIF maker (canvas/video capture in a
userscript) — manual verification in a Tampermonkey dev profile against a
live CyTube video:

1. Each effect individually (drop shadow, rainbow, wiggle) on both a
   top-only and top+bottom caption, confirming visibility and that the
   black stroke outline still renders correctly on top of the shadow.
2. All three combined at once, confirming no visual conflict (e.g. rainbow
   fill still readable through the shadow, wiggle doesn't push wrapped
   lines outside the visible frame at high `amt`).
3. Rainbow with white/yellow toggled back afterward, confirming it's a
   true mutually-exclusive radio switch with no leftover rainbow state.
4. A very short clip (~1s) and a long clip (~10s+) with wiggle/rainbow on,
   confirming the progress-based timing (hue rotation speed, wobble rate)
   scales sensibly with clip length rather than looking identical.
5. Live preview vs. rendered GIF: enable each effect, compare the CSS
   preview approximation against the actual rendered output, confirming
   they're recognizably the same effect even if not pixel-identical.
6. Confirm `node --check` passes on `cytube.gifmaker.user.js` after
   implementation.
