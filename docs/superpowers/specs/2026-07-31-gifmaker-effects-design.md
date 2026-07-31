# GIF Maker reaction effects — design

## Goal

The GIF Maker currently captures frames straight from the trimmed selection
and encodes them 1:1 with a caption overlay — no playback or visual effects.
Add a set of reaction-gif effects: **playback effects** (boomerang, reverse,
speed, freeze-frame hold) and **visual filters** (deep-fry, VHS/glitch, zoom
punch-in/shake), with a live preview so effects can be tuned before spending
time on the (slow) gif.js encode. Applies to both `cytube.gifmaker.user.js`
(standalone) and `cytube.pc.user.js` (embedded copy), matching how the
filmstrip trimmer and optimization pass were both ported to each script.

## Current pipeline (context)

Both scripts share the same flow and function names:

- `captureGifFrames()` seeks a hidden offscreen `<video>` clone to the
  trimmed selection, captures frames via `requestVideoFrameCallback`
  (falling back to `setInterval` polling), draws each to an offscreen
  `<canvas>`, burns in captions via `drawCaptions`, and reads pixels out via
  `ctx.getImageData` into an in-memory array of source frames.
- `encodeGif()` builds a gif.js `GIF` instance and adds each source frame in
  order, then renders to a Blob.
- `maybeOptimizeGif()` (existing, from the gifsicle-wasm feature) optionally
  runs `-O3` on the resulting blob before the result view. This step is
  untouched by this design — it only ever sees the final blob.

There is no existing speed/reverse/filter code in either script — this is a
clean slate.

## Architecture

Three new pieces slot in between `captureGifFrames()` and `encodeGif()`:

- **`buildPlaybackSequence(sourceFrames, playbackOptions) → sequence[]`** —
  pure function producing an ordered list of `{ frameIndex, holdCount }`
  entries that index into the untouched `sourceFrames` array. Handles
  boomerang, reverse, speed, and freeze-hold purely through index/repeat
  math — no pixel work, no copying of frame data.
- **`applyFilters(sourceFrame, filterOptions, seqPosition) → ImageData`** —
  pure function taking one source frame and returning a filtered copy.
  Static filters (deep-fry, VHS) only need `filterOptions`; zoom/shake also
  needs `seqPosition` (the output frame's position in the sequence) to
  animate scale/offset over time.
- **`renderSequenceFrame(sequence, i)`** — the single renderer used by
  *both* the live preview canvas and `encodeGif()`. It resolves
  `sequence[i]` to a source frame, applies filters, and returns the pixels
  to draw/add. Because preview and final encode call the same function,
  they cannot drift apart.

`encodeGif()` changes from iterating `sourceFrames` directly to iterating
`buildPlaybackSequence(sourceFrames, playbackOptions)` and calling
`renderSequenceFrame` per entry.

This is deliberately non-destructive: `sourceFrames` is never mutated or
copied. That matters specifically because boomerang and freeze-hold cause
the *same* source frame to appear at multiple sequence positions — baking a
filter into a shared source frame would double-apply it everywhere that
frame recurs. Filters must be computed lazily per output position, not
baked into the source array.

## Playback sequence behavior

`buildPlaybackSequence` composes effects in a fixed order, regardless of the
order the user toggled controls in the UI, so results are predictable:

**mode (normal / reverse / boomerang) → speed → freeze-hold**

- **Normal** (default): sequence = source frames 1:1, `holdCount: 1` each.
- **Reverse**: source frames walked back-to-front.
- **Boomerang**: forward pass + reverse pass appended, with the last/first
  frame de-duplicated at the turn to avoid a visible stutter. Mutually
  exclusive with Reverse in the UI — both live in one playback-mode dropdown
  (Normal / Reverse / Boomerang).
- **Speed**: a multiplier (dropdown: 0.5x / 1x / 1.5x / 2x) applied after
  mode. >1x drops frames at a stride; <1x duplicates frames (raises
  `holdCount` / repeats indices) to stretch duration. The GIF's per-frame
  delay passed to gif.js stays constant — speed is expressed as frame
  selection, not per-frame delay changes, so exported GIF timing stays
  uniform.
- **Freeze-hold**: appends N extra repeats of the *last* frame of the
  sequence (post mode/speed) before it loops. UI exposes this as a
  milliseconds field, converted to a frame count using the GIF's fps at
  build time.

Edge case: a degenerate 1-frame capture makes reverse/boomerang safe no-ops
and freeze-hold still works (repeats the single frame). Sequence length is
clamped to at least 1 frame so a 2x speed-up on a very short clip can never
produce zero frames.

## Filters

Three independent checkboxes, combinable, applied in a fixed order so
results are deterministic regardless of which was toggled last:

**zoom/shake (geometric) → deep-fry (color) → VHS (color/overlay)**

- **Deep-fry**: one intensity slider (0–100%) driving contrast boost,
  saturation boost, and a light noise overlay together as a single combined
  knob — a one-tap meme aesthetic, not a manual color-grading tool.
- **VHS/glitch**: one intensity slider driving scanline opacity,
  chromatic aberration (RGB channel offset), and occasional per-frame
  horizontal jitter together.
- **Zoom punch-in/shake**: a mode toggle (Zoom-in / Shake) plus an intensity
  slider. Zoom-in ramps scale smoothly across the sequence; Shake applies a
  small per-frame x/y offset seeded deterministically by frame position
  (not `Math.random()`), so preview and final render always match exactly.

## UI & live preview

- A new "Effects" panel section sits below the existing caption editor and
  above the render button: playback-mode dropdown, speed dropdown,
  freeze-hold ms field, and the three filter checkbox+slider rows —
  following the existing `#sc-gif-*` control naming and visual style
  (`cytube.gifmaker.user.js`'s `injectPanelCss()`; the mirrored section in
  `cytube.pc.user.js`).
- Live preview reuses the existing captured-frames canvas area: a play/pause
  control plus a scrub bar drives `renderSequenceFrame(sequence, i)` onto
  the visible canvas at the sequence's effective fps, so scrubbing shows
  boomerang/reverse/speed/freeze-hold timing and filters exactly as they
  will render.
- Recomputing `buildPlaybackSequence()` on any control change is cheap
  (index/repeat-count math only, no pixel work). `applyFilters` — the real
  per-pixel canvas operation — is only run for the frame currently on
  screen during scrubbing, not the whole sequence, so slider dragging stays
  responsive.
- Effect settings (playback mode, speed, freeze-hold, filter toggles and
  intensities) live in the same in-memory panel-state object that already
  holds fps/width/aspect/caption settings. They are **not** persisted to
  localStorage — unlike the optimize toggle (a stable preference), effect
  choices are per-clip creative decisions and reset to defaults (Normal
  playback, no filters) each time the GIF panel is opened.

## Encode integration

`encodeGif()`'s frame-adding loop switches from `sourceFrames.forEach(...)`
to iterating `buildPlaybackSequence(sourceFrames, playbackOptions)` and
calling `renderSequenceFrame` per entry before adding it to the `GIF`
instance. `maybeOptimizeGif()` and the result view are unaffected — they
only ever see the final blob.

## Error handling

Playback-sequence and filter math is pure local canvas/array computation —
no network calls, no external dependencies, nothing that can fail the way
the gifsicle CDN fetch can. No new user-facing error states or fallback UI
are needed beyond what already exists for capture/encode failures.

## Testing plan

No automated test framework covers the GIF maker today (canvas/video
capture in a userscript) — manual verification, run in a Tampermonkey dev
profile against a live CyTube video:

1. Each playback mode (Normal/Reverse/Boomerang) individually, confirming
   correct frame order and no stutter at the boomerang turn.
2. Each speed setting (0.5x/1.5x/2x) individually, confirming duration
   changes as expected and frame delay stays uniform.
3. Freeze-hold with a couple of ms values, confirming the hold appears at
   the end of the sequence before it loops.
4. Each filter individually, then combined (e.g. deep-fry + shake +
   boomerang together), confirming the fixed composition order holds.
5. Preview-vs-rendered-output visual parity: scrub the live preview, then
   render, and confirm the output GIF matches what was previewed.
6. A degenerate very-short (near 1-frame) selection with reverse/boomerang/
   freeze-hold/2x speed enabled, confirming no crash and no zero-frame
   output.
7. Confirm `cytube.gifmaker.user.js` and the ported section of
   `cytube.pc.user.js` behave identically.
8. Confirm `node --check` passes on both scripts after implementation.
