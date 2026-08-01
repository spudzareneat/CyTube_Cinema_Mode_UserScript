# GIF Maker panel relayout — design

## Goal

The Effects section added a large block of new controls (playback mode/speed/freeze, three filter rows, a live preview canvas) to a panel that was already fairly tall (overview scrubber, filmstrip, start/end marks, captions, format options, ImgBB, optimize toggle, Make GIF, result). The panel is now taller than typical viewports, and the current fix (`max-height: 88vh` + `overflow-y: auto` on the body, landed in commit `e47317b`) makes the whole panel scroll for normal use — functional but not liked. Replace it with a layout that actually fits without scrolling in the common case, while keeping the panel draggable and narrow enough that the video stays visible around it.

## Approach

Two changes, both to `cytube.gifmaker.user.js`:

1. **Two-column row for Captions + Format/Effects-toggle.** Below the (already two-column) start/end thumbnail marks and the duration line, split into `.sc-gif-col-left` (the existing `.sc-gif-captions` block, unchanged internally) and `.sc-gif-col-right` (the existing `.sc-gif-opts` FPS/Width/Shape row, plus a new compact "▸ Effects" toggle button). Panel width grows from 420px to ~600px (`max-width: 92vw` unchanged, so it still degrades gracefully on narrow viewports — `flex-wrap: wrap` on the two columns lets them stack back to one column below a certain width, no separate media query needed).

2. **Effects body becomes a full-width collapsible section, not confined to the right column.** The existing `.sc-gif-fx` block (playback mode/speed/freeze row, filter checkboxes+sliders, live preview canvas+scrub+play/status/button) moves out from under the right column and sits full-width directly below the two-column row, toggled by the button added in the right column. Collapsed by default. This is deliberate: at ~600px total panel width, a right-column-confined Effects block would only have ~280px for the preview canvas — less than the canvas gets today. Full-width when expanded keeps the preview usable.

Both sections reuse the existing ImgBB-row collapsible pattern already in this file (`.sc-gif-imgbb-header`/`.sc-gif-imgbb-toggle`/`.sc-gif-imgbb-body`/`.sc-gif-imgbb-open`, `▸`/`▾` chevron swap, `aria-expanded`) — new, independently-named classes (`.sc-gif-fx-header` etc.), not a shared refactor, matching this file's existing convention of small per-component CSS repetition rather than introducing a new shared abstraction into working code.

The `max-height: 88vh` / scrollable-body CSS from commit `e47317b` stays as a fallback for genuine edge cases (a very short viewport with Effects expanded) — it stops being the primary UX, which was the actual complaint, but removing it entirely would leave no safety net for small windows.

## What does NOT change

- All existing element IDs, function names, and behavior inside `.sc-gif-captions`, `.sc-gif-opts`, and `.sc-gif-fx`'s internals (mode/speed/freeze controls, filter rows, preview canvas/scrub/play, `fx` state object, `ensurePreviewFrames`, `renderSequenceFrame`, etc.) — this is a pure DOM/CSS reorganization. No JS logic added beyond the collapse/expand toggle (mirroring the existing ImgBB toggle's JS exactly).
- The start/end thumbnail marks row, filmstrip, overview scrubber, ImgBB row, Optimize checkbox, Make GIF button, status, and result view are all unmoved.
- The `#sc-gif-panel` centering/dragging behavior (`position: fixed`, pointer-based drag) is untouched — only its `width` value changes.

## Testing

No automated test framework in this repo (established convention) — verification is `node --check` plus a code-reading self-review, plus manual browser verification (outstanding from the effects feature itself, and this relayout should be checked in the same pass): panel opens at ~600px wide and fits within the viewport without scrolling in the default (Effects collapsed) state; clicking "▸ Effects" expands it full-width, and the live preview canvas is visibly wider than it would be confined to a half-width column; the panel remains draggable by its header in both collapsed and expanded states; on a narrow browser window the two columns stack to one column without any control becoming unreachable; the `max-height`/scroll fallback still works if the window is made very short with Effects expanded.
