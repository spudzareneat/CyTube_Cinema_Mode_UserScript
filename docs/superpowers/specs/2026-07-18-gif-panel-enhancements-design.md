# GIF Maker panel enhancements — captions, dragging, scrubbing

Date: 2026-07-18

## Goal

Three independent improvements to the existing GIF Maker panel (`openGifPanel()` in `cytube.pc.user.js`, ~line 990):

1. Optional top/bottom meme captions baked into the GIF.
2. A draggable panel, so it can be moved out of the way while the movie keeps playing behind it.
3. A coarse scrubber per mark (START/END), since the current ±0.5s nudge buttons alone make it slow to find a starting point far from the current playhead.

## 1. Meme captions

**UI**: two text inputs, "TOP TEXT" and "BOTTOM TEXT" (both optional — empty means no caption), plus a shared Yellow/White color toggle. Placed in the panel body between the marks section and the FPS/Width/Shape row. State resets to empty/White each time the panel opens, matching how the marks reset.

**Live preview**: captions overlay the existing `.sc-gif-thumb` START/END preview divs (already `position: relative`) as absolutely-positioned text layers — no canvas involved for the preview. Styled as classic meme text: font stack `Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif`, forced uppercase, black outline via `-webkit-text-stroke` with a `text-shadow` fallback. Recomputed on every keystroke and whenever aspect mode changes (Native/Crop/Bars changes the thumb's box dimensions).

**Auto-fit/wrap**: one shared function, `fitCaptionText(text, boxW, boxH)`, used by both the live preview and the final frame render so they match:
- Base font size proportional to `boxH` (e.g. `boxH * 0.16`).
- Greedy word-wrap against `boxW` using `measureText` on an offscreen canvas.
- If it still doesn't fit at the current size, shrink by a step and re-wrap, down to a floor size.
- No hard line-count cap — long captions degrade to more, smaller lines rather than clipping.

**Baking into the GIF**: captions are drawn onto every captured frame's canvas inside `captureGifFrames`'s `onFrame` callback, immediately after the existing `drawImage` call and before `ctx.getImageData(...)`. This means Download and Upload need no changes — the pixels already have the caption in them by the time `encodeGif`/`uploadToImgbb` see them.

## 2. Draggable panel

`#sc-gif-panel` is currently positioned via `top:50%; left:50%; transform:translate(-50%,-50%)`. Dragging is initiated from `#sc-gif-head` (excluding the `✕` close button) using pointer events:
- On `pointerdown`, capture the pointer and record the offset between the cursor and the panel's current rendered top-left.
- On the first `pointermove`, convert the panel from the centered-transform positioning to explicit `top`/`left` pixel values (computed from `getBoundingClientRect()`), then remove the `transform`.
- On subsequent `pointermove`, update `top`/`left` directly, clamped so the panel can't be dragged fully off-screen (keep at least the header within the viewport).
- Position resets to centered each time the panel is (re)opened — not persisted across close/reopen.

## 3. Per-mark scrubber

Each of the START/END mark cards gets a new `<input type="range" min="0" max={videoDuration} step="0.1">` beneath its thumbnail:
- Dragging it (`input` event) updates that mark's `startT`/`endT` and drives the existing debounced `refreshThumb`/`grabPreviewFrame` pipeline — reusing infrastructure already built for exactly this kind of live preview refresh.
- Clicking anywhere on the track jumps there directly (native range-input behavior) — this is what solves "hard to get to the start."
- Existing **⤓ Now** / **−.5** / **+.5** buttons are unchanged and still work for snapping to the live playhead and fine-tuning after a coarse scrub.
- The existing `clampStart`/`clampEnd` rules still apply (can't drag start past end or vice versa) — after a slider input the value is clamped and the slider's own displayed value is corrected to match.
- If `vidDur` isn't finite (shouldn't happen for a source the panel would let you capture from, since blob/streaming sources already disable the whole panel), the slider is disabled like the rest of the controls.

## Testing

No build step or test runner in this repo (matches [[2026-07-10-tonights-lineup-design]] and the rest of the project) — verification is manual: exercise the panel in a real CyTube session (drag the panel while a movie plays, scrub to a distant point and fine-tune with ±0.5, type top/bottom captions in both colors and confirm the preview matches the final GIF, confirm Download/Upload both include the caption).

## Out of scope

- Persisting caption text, panel position, or color choice across panel close/reopen.
- Per-line caption color (only one shared Yellow/White toggle).
- A dual-handle single timeline (per-mark sliders were chosen instead — simpler, reuses existing per-mark state/thumbnail architecture).
- Custom fonts, custom text positioning/dragging within the frame, or more than two caption lines.
