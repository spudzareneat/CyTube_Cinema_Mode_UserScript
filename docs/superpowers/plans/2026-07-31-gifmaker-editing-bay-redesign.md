# GIF Maker Panel "Editing Bay" Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the GIF Maker panel's visual design with a cohesive "film editing bay" identity — amber tally-light accent, monospace timecode readouts, card-grouped sections, one primary action vs. ghost secondaries, and small hover transitions — with zero behavior changes.

**Architecture:** Two tasks, both confined to `cytube.gifmaker.user.js`. Task 1 replaces the entire CSS template literal inside `injectPanelCss()` in one pass (color/ink/border retint, radius scale, spacing scale, new font declarations, card rule, button hierarchy, monospace-timecode selectors, and scoped hover transitions — nearly every line changes, so one coherent block-replace is more reliable than dozens of overlapping micro-edits). Task 2 adds the HTML card wrappers, the one approved HTML+JS change for the "Currently editing" timecode, and carries manual browser verification.

**Tech Stack:** Tampermonkey userscript (vanilla JS, no build step), CSS `!important` (existing file convention).

## Global Constraints

- No automated test framework in this repo — verification is `node --check cytube.gifmaker.user.js` (syntax only) plus a code-reading self-review, matching every other task on this codebase.
- Design system token values (exact, from the approved design plan):
  - `bg-void #0c0c0e`, `bg-panel #17171a` (unchanged, reused), `bg-well #1f1f22` (unchanged)
  - `accent #ffb020` (replaces `#ffcc44` everywhere), `accent-dim rgba(255,176,32,0.14)`
  - `ink-hi #f4f4f2`, `ink-mid rgba(244,244,242,0.62)`, `ink-lo rgba(244,244,242,0.34)`
  - Border tiers: `rgba(244,244,242,0.06)` (cards) / `0.08` (structural containers) / `0.14` (interactive controls, including the panel's own outer border)
  - Radius tiers: `4px` (small inline controls), `8px` (cards/major controls), `12px` (outer panel)
  - Sans stack: `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` (new — panel currently has no explicit font-family)
  - Mono stack (timecodes only): `"SF Mono", "Cascadia Code", Consolas, monospace`
- Unchanged/out of scope: status colors `#7dffa0`/`#ff8080`, link color `#8ab4ff`, caption yellow `#ffe135`, the entire `.sc-gif-cap` Impact meme-font block (lines 114–123), `cytube.pc.user.js` (not touched).
- Primary button (`#sc-gif-go`) gets a solid `accent` fill with `bg-void` text. Every other button becomes a ghost button (transparent bg, `0.14`-tier border, `ink-mid` text, `accent`-tinted hover). The two disclosure headers (ImgBB, Effects) and the close button stay borderless, retinted only.
- New transitions (`background-color`/`border-color`/`color`, 120ms ease) apply only to buttons, inputs, and disclosure headers — never to any element the JS drag code repositions via inline styles during `pointermove` (the panel itself, filmstrip handles/selection/dim-overlays, overview viewport/ghost, caption position handles, `.sc-gif-filmstrip-handle-grip`).
- One approved JS line change (Task 2 only): `#sc-gif-overview-current`'s ID moves onto a new inner `<span>` wrapping just the formatted time, and its `.textContent` assignment drops the `'Currently editing: '` prefix (now static HTML) — identical rendered output, not a logic change.

---

### Task 1: Full CSS system replacement

**Files:**
- Modify: `cytube.gifmaker.user.js` (the entire CSS template literal inside `injectPanelCss()`, lines 54–363)

**Interfaces:**
- Produces: `.sc-gif-card` (new shared card rule), `.sc-gif-mono` (new shared monospace class, also targets `#sc-gif-time-start`, `#sc-gif-time-end`, `#sc-gif-dur-line b`, `#sc-gif-overview-total`, `#sc-gif-filmstrip-range`, `.sc-gif-fx-row input[type=number]` directly by selector), `#sc-gif-fx-preview-btn` (new rule — this button previously had no CSS coverage at all).
- Consumes: nothing new. All existing element IDs/classes referenced by JS are preserved exactly.

- [ ] **Step 1: Replace the entire CSS block**

Find this exact block (the full contents of the `style.textContent` template literal, from `#sc-gif-panel {` through the closing `#sc-gif-upload:disabled` rule):

```js
            #sc-gif-panel {
                position: fixed !important;
                top: 50% !important; left: 50% !important; transform: translate(-50%, -50%) !important;
                z-index: 30002 !important;
                width: 600px !important; max-width: 92vw !important;
                max-height: 88vh !important;
                display: flex !important; flex-direction: column !important;
                background: rgba(18,18,20,0.98) !important;
                border: 1px solid rgba(255,255,255,0.16) !important;
                border-radius: 10px !important;
                box-shadow: 0 12px 40px rgba(0,0,0,0.6) !important;
                color: #eee !important; font-size: 13px !important;
            }
            #sc-gif-head {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                flex: none !important;
                padding: 10px 14px !important;
                border-bottom: 1px solid rgba(255,255,255,0.1) !important;
                font-weight: 600 !important; color: #ffcc44 !important;
                cursor: grab !important; user-select: none !important; touch-action: none !important;
            }
            #sc-gif-head.sc-gif-dragging { cursor: grabbing !important; }
            #sc-gif-close {
                background: transparent !important; border: none !important; color: rgba(255,255,255,0.6) !important;
                font-size: 15px !important; cursor: pointer !important; padding: 0 4px !important;
            }
            #sc-gif-close:hover { color: white !important; }
            #sc-gif-body {
                padding: 12px 14px !important; display: flex !important; flex-direction: column !important; gap: 10px !important;
                flex: 1 1 auto !important; min-height: 0 !important; overflow-y: auto !important;
            }
            #sc-gif-body label {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                color: rgba(255,255,255,0.8) !important; font-weight: 500 !important;
            }
            #sc-gif-body select {
                background: #1f1f22 !important; color: white !important;
                border: 1px solid rgba(255,255,255,0.2) !important; border-radius: 5px !important;
                padding: 3px 8px !important; font-size: 13px !important;
            }
            #sc-gif-body select option {
                background-color: #1f1f22 !important; color: white !important;
            }
            .sc-gif-marks { display: flex !important; gap: 10px !important; max-width: 420px !important; margin: 0 auto !important; }
            .sc-gif-mark {
                flex: 1 1 0 !important; min-width: 0 !important;
                display: flex !important; flex-direction: column !important; gap: 6px !important;
            }
            .sc-gif-thumb {
                width: 100% !important; aspect-ratio: 16 / 9 !important;
                background-color: #000 !important;
                background-position: center !important;
                background-size: cover !important;
                background-repeat: no-repeat !important;
                border: 1px solid rgba(255,255,255,0.18) !important; border-radius: 6px !important;
                position: relative !important;
            }
            .sc-gif-thumb-43 { aspect-ratio: 4 / 3 !important; }
            .sc-gif-thumb-fit { background-size: contain !important; }
            .sc-gif-thumb-readonly { border-style: dashed !important; opacity: 0.92 !important; }
            .sc-gif-cap {
                position: absolute !important;
                width: 92% !important;
                text-align: center !important; white-space: pre-line !important;
                font-family: Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif !important;
                font-weight: bold !important; color: #fff !important;
                -webkit-text-stroke: 1.5px #000 !important;
                text-shadow: -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000 !important;
                pointer-events: none !important; transform: translate(-50%, -50%) !important;
            }
            .sc-gif-cap-top { left: var(--cx-top, 50%) !important; top: var(--cy-top, 10%) !important; }
            .sc-gif-cap-bottom { left: var(--cx-bottom, 50%) !important; top: var(--cy-bottom, 90%) !important; }
            .sc-gif-cap-yellow { color: #ffe135 !important; }
            .sc-gif-cap-handle {
                position: absolute !important; width: 14px !important; height: 14px !important;
                border-radius: 50% !important; background: rgba(255,204,68,0.9) !important;
                border: 2px solid #000 !important; transform: translate(-50%, -50%) !important;
                cursor: grab !important; pointer-events: auto !important; touch-action: none !important;
            }
            .sc-gif-cap-handle:active { cursor: grabbing !important; }
            .sc-gif-cap-handle-top { left: var(--cx-top, 50%) !important; top: var(--cy-top, 10%) !important; }
            .sc-gif-cap-handle-bottom { left: var(--cx-bottom, 50%) !important; top: var(--cy-bottom, 90%) !important; }
            .sc-gif-cap-sizes { display: flex !important; flex-wrap: wrap !important; gap: 14px !important; justify-content: center !important; }
            .sc-gif-cap-sizes label {
                display: flex !important; align-items: center !important; gap: 4px !important;
                color: rgba(255,255,255,0.8) !important; font-size: 12px !important;
            }
            .sc-gif-cap-sizes input[type=number] {
                width: 48px !important; background: #1f1f22 !important; color: white !important;
                border: 1px solid rgba(255,255,255,0.2) !important; border-radius: 5px !important; padding: 2px 4px !important;
            }
            .sc-gif-cap-hint { text-align: center !important; color: rgba(255,255,255,0.4) !important; font-size: 11px !important; }
            .sc-gif-overview { display: flex !important; flex-direction: column !important; gap: 4px !important; margin-bottom: 2px !important; }
            .sc-gif-overview-track {
                position: relative !important; height: 16px !important; border-radius: 4px !important;
                background: #17171a !important; border: 1px solid rgba(255,255,255,0.14) !important;
                cursor: pointer !important; user-select: none !important; touch-action: none !important;
            }
            .sc-gif-overview-track:focus {
                outline: 2px solid #ffcc44 !important; outline-offset: 1px !important;
            }
            .sc-gif-overview-viewport {
                position: absolute !important; top: 0 !important; bottom: 0 !important;
                background: rgba(255,204,68,0.55) !important;
                border-left: 1px solid #ffcc44 !important; border-right: 1px solid #ffcc44 !important;
                border-radius: 2px !important; pointer-events: none !important;
            }
            .sc-gif-overview-ghost {
                position: absolute !important; top: -3px !important; bottom: -3px !important; width: 2px !important;
                background: #fff !important; box-shadow: 0 0 4px rgba(255,255,255,0.8) !important;
                display: none !important; pointer-events: none !important;
            }
            .sc-gif-overview-labels {
                display: flex !important; justify-content: space-between !important;
                color: rgba(255,255,255,0.4) !important; font-size: 10px !important;
            }
            .sc-gif-overview-current { color: rgba(255,204,68,0.85) !important; font-weight: 600 !important; }
            .sc-gif-filmstrip { display: flex !important; flex-direction: column !important; gap: 6px !important; }
            .sc-gif-filmstrip-window-label { text-align: center !important; color: rgba(255,255,255,0.55) !important; font-size: 11px !important; }
            .sc-gif-filmstrip-strip {
                position: relative !important; height: 64px !important; border-radius: 6px !important;
                overflow: hidden !important; border: 1px solid rgba(255,255,255,0.18) !important; user-select: none !important;
            }
            .sc-gif-filmstrip-tiles { position: absolute !important; inset: 0 !important; display: flex !important; }
            .sc-gif-filmstrip-tile {
                flex: 1 1 0 !important;
                background-color: #1a1a1e !important;
                background-position: center !important; background-size: cover !important; background-repeat: no-repeat !important;
                border-right: 1px solid rgba(255,255,255,0.06) !important;
                position: relative !important;
            }
            .sc-gif-filmstrip-tile:last-child { border-right: 0 !important; }
            .sc-gif-filmstrip-dim-left, .sc-gif-filmstrip-dim-right {
                position: absolute !important; top: 0 !important; bottom: 0 !important;
                background: rgba(0,0,0,0.55) !important; pointer-events: none !important;
            }
            .sc-gif-filmstrip-dim-left { left: 0 !important; }
            .sc-gif-filmstrip-dim-right { right: 0 !important; }
            .sc-gif-filmstrip-selection {
                position: absolute !important; top: 0 !important; bottom: 0 !important;
                background: rgba(255,204,68,0.08) !important;
                border-left: 2px solid #ffcc44 !important; border-right: 2px solid #ffcc44 !important;
                pointer-events: auto !important; cursor: grab !important; touch-action: none !important;
            }
            .sc-gif-filmstrip-selection:active { cursor: grabbing !important; }
            .sc-gif-filmstrip-handle {
                position: absolute !important; top: 0 !important; bottom: 0 !important; width: 14px !important; margin-left: -7px !important;
                cursor: ew-resize !important; display: flex !important; align-items: center !important; justify-content: center !important;
                z-index: 3 !important; touch-action: none !important;
            }
            .sc-gif-filmstrip-handle-grip {
                width: 6px !important; height: 28px !important; border-radius: 3px !important;
                background: #ffcc44 !important; border: 1px solid #000 !important;
                box-shadow: 0 0 0 3px rgba(255,204,68,0.15) !important;
            }
            .sc-gif-captions { display: flex !important; flex-direction: column !important; gap: 6px !important; }
            .sc-gif-cap-input {
                background: #1f1f22 !important; color: white !important;
                border: 1px solid rgba(255,255,255,0.2) !important; border-radius: 5px !important;
                padding: 6px 8px !important; font-size: 13px !important; width: 100% !important;
                box-sizing: border-box !important;
            }
            .sc-gif-cap-input::placeholder { color: rgba(255,255,255,0.35) !important; }
            .sc-gif-cap-color {
                display: flex !important; align-items: center !important; gap: 14px !important; justify-content: center !important;
                color: rgba(255,255,255,0.8) !important; font-size: 12px !important;
            }
            .sc-gif-cap-color label { display: flex !important; align-items: center !important; gap: 4px !important; cursor: pointer !important; }
            .sc-gif-thumb-loading::after {
                content: '' !important;
                position: absolute !important;
                top: 50% !important; left: 50% !important;
                width: 22px !important; height: 22px !important;
                margin: -11px 0 0 -11px !important;
                border: 2px solid rgba(255,255,255,0.25) !important;
                border-top-color: #ffcc44 !important;
                border-radius: 50% !important;
                animation: sc-gif-spin 0.8s linear infinite !important;
            }
            @keyframes sc-gif-spin { to { transform: rotate(360deg); } }
            .sc-gif-spinner {
                display: inline-block !important;
                width: 18px !important; height: 18px !important;
                border: 2px solid rgba(255,255,255,0.25) !important;
                border-top-color: #ffcc44 !important;
                border-radius: 50% !important;
                animation: sc-gif-spin 0.8s linear infinite !important;
                flex: none !important;
            }
            .sc-gif-spinner-sm { width: 13px !important; height: 13px !important; }
            .sc-gif-working {
                display: flex !important; align-items: center !important; gap: 10px !important;
                padding: 14px 4px !important; color: rgba(255,255,255,0.75) !important; font-size: 13px !important;
            }
            .sc-gif-mark-label {
                color: #ffcc44 !important; font-size: 11px !important; font-weight: 700 !important;
                letter-spacing: 0.04em !important; text-align: center !important;
            }
            .sc-gif-mark-btns { display: flex !important; gap: 4px !important; }
            .sc-gif-mark-btns button {
                flex: 1 1 0 !important; min-width: 0 !important;
                background: rgba(255,255,255,0.1) !important; color: white !important;
                border: 1px solid rgba(255,255,255,0.2) !important; border-radius: 5px !important;
                padding: 4px 0 !important; font-size: 11px !important; cursor: pointer !important;
            }
            .sc-gif-mark-btns button:hover { background: rgba(255,255,255,0.22) !important; }
            #sc-gif-dur-line {
                text-align: center !important; color: rgba(255,255,255,0.7) !important; font-size: 12px !important;
            }
            #sc-gif-dur-line b { color: #fff !important; }
            .sc-gif-opts { display: flex !important; gap: 12px !important; }
            .sc-gif-col-right .sc-gif-opts { flex-direction: column !important; gap: 6px !important; }
            .sc-gif-opts label { flex: 1 1 0 !important; }
            #sc-gif-go {
                background: rgba(255,200,50,0.18) !important; color: #ffcc44 !important;
                border: 1px solid rgba(255,200,50,0.45) !important; border-radius: 6px !important;
                padding: 8px 12px !important; font-size: 13px !important; font-weight: 600 !important;
                cursor: pointer !important;
            }
            #sc-gif-go:hover:not(:disabled) { background: rgba(255,200,50,0.28) !important; }
            #sc-gif-go:disabled { opacity: 0.5 !important; cursor: default !important; }
            #sc-gif-status { color: rgba(255,255,255,0.65) !important; font-size: 12px !important; min-height: 14px !important; }
            #sc-gif-result img { width: 100% !important; border-radius: 6px !important; display: block !important; }
            #sc-gif-actions { display: flex !important; align-items: center !important; gap: 10px !important; margin-top: 8px !important; }
            #sc-gif-dl { background: rgba(255,255,255,0.1) !important; color: white !important;
                         border: 1px solid rgba(255,255,255,0.2) !important; border-radius: 5px !important;
                         padding: 5px 12px !important; font-size: 12px !important; cursor: pointer !important;
                         text-decoration: none !important; }
            #sc-gif-dl:hover { background: rgba(255,255,255,0.2) !important; }
            #sc-gif-size { color: rgba(255,255,255,0.45) !important; font-size: 11px !important; margin-left: auto !important; }
            .sc-gif-imgbb-row { display: flex !important; flex-direction: column !important; gap: 4px !important; }
            .sc-gif-imgbb-label { color: rgba(255,255,255,0.8) !important; font-size: 12px !important; font-weight: 500 !important; }
            .sc-gif-imgbb-header {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                background: transparent !important; border: none !important; padding: 0 !important;
                cursor: pointer !important; width: 100% !important; text-align: left !important;
            }
            .sc-gif-imgbb-header:focus-visible { outline: 2px solid #ffcc44 !important; outline-offset: 1px !important; }
            .sc-gif-imgbb-toggle { color: rgba(255,255,255,0.5) !important; font-size: 11px !important; }
            .sc-gif-imgbb-body { display: none !important; flex-direction: column !important; gap: 4px !important; margin-top: 4px !important; }
            .sc-gif-imgbb-row.sc-gif-imgbb-open .sc-gif-imgbb-body { display: flex !important; }
            .sc-gif-imgbb-input-row { display: flex !important; gap: 6px !important; }
            .sc-gif-imgbb-input { flex: 1 1 auto !important; }
            .sc-gif-imgbb-test-btn {
                background: rgba(255,255,255,0.1) !important; color: white !important;
                border: 1px solid rgba(255,255,255,0.2) !important; border-radius: 5px !important;
                padding: 5px 12px !important; font-size: 12px !important; cursor: pointer !important;
            }
            .sc-gif-imgbb-test-btn:hover:not(:disabled) { background: rgba(255,255,255,0.2) !important; }
            .sc-gif-imgbb-status { font-size: 11px !important; min-height: 13px !important; }
            .sc-gif-optimize-row { display: flex !important; align-items: center !important; gap: 6px !important; }
            .sc-gif-optimize-row label { color: rgba(255,255,255,0.8) !important; font-size: 12px !important; }
            .sc-gif-cols { display: flex !important; flex-wrap: wrap !important; gap: 14px !important; }
            .sc-gif-col-left, .sc-gif-col-right {
                flex: 1 1 260px !important; min-width: 0 !important;
                display: flex !important; flex-direction: column !important; gap: 10px !important;
            }
            .sc-gif-fx-header {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                background: transparent !important; border: none !important; padding: 0 !important;
                cursor: pointer !important; width: 100% !important; text-align: left !important;
                color: rgba(255,255,255,0.8) !important; font-size: 12px !important; font-weight: 500 !important;
            }
            .sc-gif-fx-header:focus-visible { outline: 2px solid #ffcc44 !important; outline-offset: 1px !important; }
            .sc-gif-fx-toggle { color: rgba(255,255,255,0.5) !important; font-size: 11px !important; }
            .sc-gif-fx { display: none !important; flex-direction: column !important; gap: 8px !important; }
            .sc-gif-fx.sc-gif-fx-open { display: flex !important; }
            .sc-gif-fx-row { display: flex !important; align-items: center !important; gap: 10px !important; }
            .sc-gif-fx-row label { flex: 1 1 0 !important; }
            .sc-gif-fx-row input[type=number] {
                width: 64px !important; background: #1f1f22 !important; color: white !important;
                border: 1px solid rgba(255,255,255,0.2) !important; border-radius: 5px !important; padding: 2px 4px !important;
            }
            .sc-gif-fx-filters { display: flex !important; flex-direction: column !important; gap: 6px !important; }
            .sc-gif-fx-filter { display: flex !important; align-items: center !important; gap: 8px !important; }
            .sc-gif-fx-filter label { flex: 1 1 auto !important; color: rgba(255,255,255,0.8) !important; font-size: 12px !important; }
            .sc-gif-fx-filter input[type=range] { flex: 1 1 auto !important; accent-color: #ffcc44 !important; }
            .sc-gif-preview { display: flex !important; flex-direction: column !important; gap: 6px !important; }
            .sc-gif-preview canvas {
                width: 100% !important; background: #000 !important; border-radius: 6px !important;
                border: 1px solid rgba(255,255,255,0.18) !important; display: block !important;
            }
            .sc-gif-preview-controls { display: flex !important; align-items: center !important; gap: 8px !important; }
            .sc-gif-preview-controls input[type=range] { flex: 1 1 auto !important; accent-color: #ffcc44 !important; }
            .sc-gif-preview-controls button {
                background: rgba(255,255,255,0.1) !important; color: white !important;
                border: 1px solid rgba(255,255,255,0.2) !important; border-radius: 5px !important;
                padding: 4px 10px !important; font-size: 12px !important; cursor: pointer !important;
            }
            .sc-gif-preview-status { color: rgba(255,255,255,0.5) !important; font-size: 11px !important; text-align: center !important; }
            .sc-test-ok      { color: #7dffa0 !important; }
            .sc-test-bad     { color: #ff8080 !important; }
            .sc-test-pending { color: rgba(255,255,255,0.55) !important; }
            #sc-gif-link {
                display: flex !important; align-items: center !important; gap: 8px !important;
                flex-wrap: wrap !important; margin-top: 8px !important;
            }
            .sc-gif-link-url {
                color: #8ab4ff !important; font-size: 12px !important; word-break: break-all !important;
                text-decoration: none !important;
            }
            .sc-gif-link-url:hover { text-decoration: underline !important; }
            .sc-gif-link-msg { color: rgba(255,255,255,0.6) !important; font-size: 12px !important; }
            #sc-gif-copylink, #sc-gif-upload {
                background: rgba(255,255,255,0.1) !important; color: white !important;
                border: 1px solid rgba(255,255,255,0.2) !important; border-radius: 5px !important;
                padding: 5px 12px !important; font-size: 12px !important; cursor: pointer !important;
            }
            #sc-gif-copylink:hover, #sc-gif-upload:hover:not(:disabled) { background: rgba(255,255,255,0.2) !important; }
            #sc-gif-upload:disabled { opacity: 0.5 !important; cursor: default !important; }
```

Replace with:

```js
            #sc-gif-panel {
                position: fixed !important;
                top: 50% !important; left: 50% !important; transform: translate(-50%, -50%) !important;
                z-index: 30002 !important;
                width: 600px !important; max-width: 92vw !important;
                max-height: 88vh !important;
                display: flex !important; flex-direction: column !important;
                background: #0c0c0e !important;
                border: 1px solid rgba(244,244,242,0.14) !important;
                border-radius: 12px !important;
                box-shadow: 0 12px 40px rgba(0,0,0,0.6) !important;
                color: #f4f4f2 !important; font-size: 13px !important;
                font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif !important;
            }
            #sc-gif-head {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                flex: none !important;
                padding: 10px 16px !important;
                border-bottom: 1px solid rgba(244,244,242,0.08) !important;
                font-weight: 600 !important; font-size: 14px !important; color: #ffb020 !important;
                cursor: grab !important; user-select: none !important; touch-action: none !important;
            }
            #sc-gif-head.sc-gif-dragging { cursor: grabbing !important; }
            #sc-gif-close {
                background: transparent !important; border: none !important; color: rgba(244,244,242,0.62) !important;
                font-size: 15px !important; cursor: pointer !important; padding: 0 4px !important;
                transition: color 120ms ease !important;
            }
            #sc-gif-close:hover { color: #f4f4f2 !important; }
            #sc-gif-body {
                padding: 16px !important; display: flex !important; flex-direction: column !important; gap: 16px !important;
                flex: 1 1 auto !important; min-height: 0 !important; overflow-y: auto !important;
            }
            #sc-gif-body label {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                color: rgba(244,244,242,0.62) !important; font-weight: 500 !important;
            }
            #sc-gif-body select {
                background: #1f1f22 !important; color: #f4f4f2 !important;
                border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 4px !important;
                padding: 3px 8px !important; font-size: 13px !important;
                transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important;
            }
            #sc-gif-body select option {
                background-color: #1f1f22 !important; color: #f4f4f2 !important;
            }
            .sc-gif-card {
                background: rgba(244,244,242,0.02) !important;
                border: 1px solid rgba(244,244,242,0.06) !important;
                border-radius: 8px !important;
                padding: 12px !important;
                display: flex !important; flex-direction: column !important; gap: 8px !important;
            }
            .sc-gif-mono, #sc-gif-time-start, #sc-gif-time-end, #sc-gif-dur-line b,
            #sc-gif-overview-total, #sc-gif-filmstrip-range, .sc-gif-fx-row input[type=number] {
                font-family: "SF Mono", "Cascadia Code", Consolas, monospace !important;
            }
            .sc-gif-marks { display: flex !important; gap: 10px !important; max-width: 420px !important; margin: 0 auto !important; }
            .sc-gif-mark {
                flex: 1 1 0 !important; min-width: 0 !important;
                display: flex !important; flex-direction: column !important; gap: 6px !important;
            }
            .sc-gif-thumb {
                width: 100% !important; aspect-ratio: 16 / 9 !important;
                background-color: #000 !important;
                background-position: center !important;
                background-size: cover !important;
                background-repeat: no-repeat !important;
                border: 1px solid rgba(244,244,242,0.08) !important; border-radius: 8px !important;
                position: relative !important;
            }
            .sc-gif-thumb-43 { aspect-ratio: 4 / 3 !important; }
            .sc-gif-thumb-fit { background-size: contain !important; }
            .sc-gif-thumb-readonly { border-style: dashed !important; opacity: 0.92 !important; }
            .sc-gif-cap {
                position: absolute !important;
                width: 92% !important;
                text-align: center !important; white-space: pre-line !important;
                font-family: Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif !important;
                font-weight: bold !important; color: #fff !important;
                -webkit-text-stroke: 1.5px #000 !important;
                text-shadow: -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000 !important;
                pointer-events: none !important; transform: translate(-50%, -50%) !important;
            }
            .sc-gif-cap-top { left: var(--cx-top, 50%) !important; top: var(--cy-top, 10%) !important; }
            .sc-gif-cap-bottom { left: var(--cx-bottom, 50%) !important; top: var(--cy-bottom, 90%) !important; }
            .sc-gif-cap-yellow { color: #ffe135 !important; }
            .sc-gif-cap-handle {
                position: absolute !important; width: 14px !important; height: 14px !important;
                border-radius: 50% !important; background: rgba(255,176,32,0.9) !important;
                border: 2px solid #000 !important; transform: translate(-50%, -50%) !important;
                cursor: grab !important; pointer-events: auto !important; touch-action: none !important;
            }
            .sc-gif-cap-handle:active { cursor: grabbing !important; }
            .sc-gif-cap-handle-top { left: var(--cx-top, 50%) !important; top: var(--cy-top, 10%) !important; }
            .sc-gif-cap-handle-bottom { left: var(--cx-bottom, 50%) !important; top: var(--cy-bottom, 90%) !important; }
            .sc-gif-cap-sizes { display: flex !important; flex-wrap: wrap !important; gap: 14px !important; justify-content: center !important; }
            .sc-gif-cap-sizes label {
                display: flex !important; align-items: center !important; gap: 4px !important;
                color: rgba(244,244,242,0.62) !important; font-size: 12px !important;
            }
            .sc-gif-cap-sizes input[type=number] {
                width: 48px !important; background: #1f1f22 !important; color: #f4f4f2 !important;
                border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 4px !important; padding: 2px 4px !important;
                transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important;
            }
            .sc-gif-cap-hint { text-align: center !important; color: rgba(244,244,242,0.34) !important; font-size: 11px !important; }
            .sc-gif-overview { display: flex !important; flex-direction: column !important; gap: 4px !important; margin-bottom: 2px !important; }
            .sc-gif-overview-track {
                position: relative !important; height: 16px !important; border-radius: 4px !important;
                background: #17171a !important; border: 1px solid rgba(244,244,242,0.14) !important;
                cursor: pointer !important; user-select: none !important; touch-action: none !important;
            }
            .sc-gif-overview-track:focus {
                outline: 2px solid #ffb020 !important; outline-offset: 1px !important;
            }
            .sc-gif-overview-viewport {
                position: absolute !important; top: 0 !important; bottom: 0 !important;
                background: rgba(255,176,32,0.55) !important;
                border-left: 1px solid #ffb020 !important; border-right: 1px solid #ffb020 !important;
                border-radius: 2px !important; pointer-events: none !important;
            }
            .sc-gif-overview-ghost {
                position: absolute !important; top: -3px !important; bottom: -3px !important; width: 2px !important;
                background: #f4f4f2 !important; box-shadow: 0 0 4px rgba(244,244,242,0.8) !important;
                display: none !important; pointer-events: none !important;
            }
            .sc-gif-overview-labels {
                display: flex !important; justify-content: space-between !important;
                color: rgba(244,244,242,0.34) !important; font-size: 11px !important;
            }
            .sc-gif-overview-current { color: rgba(255,176,32,0.85) !important; font-weight: 600 !important; }
            .sc-gif-filmstrip { display: flex !important; flex-direction: column !important; gap: 6px !important; }
            .sc-gif-filmstrip-window-label { text-align: center !important; color: rgba(244,244,242,0.34) !important; font-size: 11px !important; }
            .sc-gif-filmstrip-strip {
                position: relative !important; height: 64px !important; border-radius: 8px !important;
                overflow: hidden !important; border: 1px solid rgba(244,244,242,0.08) !important; user-select: none !important;
            }
            .sc-gif-filmstrip-tiles { position: absolute !important; inset: 0 !important; display: flex !important; }
            .sc-gif-filmstrip-tile {
                flex: 1 1 0 !important;
                background-color: #1a1a1e !important;
                background-position: center !important; background-size: cover !important; background-repeat: no-repeat !important;
                border-right: 1px solid rgba(244,244,242,0.06) !important;
                position: relative !important;
            }
            .sc-gif-filmstrip-tile:last-child { border-right: 0 !important; }
            .sc-gif-filmstrip-dim-left, .sc-gif-filmstrip-dim-right {
                position: absolute !important; top: 0 !important; bottom: 0 !important;
                background: rgba(0,0,0,0.55) !important; pointer-events: none !important;
            }
            .sc-gif-filmstrip-dim-left { left: 0 !important; }
            .sc-gif-filmstrip-dim-right { right: 0 !important; }
            .sc-gif-filmstrip-selection {
                position: absolute !important; top: 0 !important; bottom: 0 !important;
                background: rgba(255,176,32,0.08) !important;
                border-left: 2px solid #ffb020 !important; border-right: 2px solid #ffb020 !important;
                pointer-events: auto !important; cursor: grab !important; touch-action: none !important;
            }
            .sc-gif-filmstrip-selection:active { cursor: grabbing !important; }
            .sc-gif-filmstrip-handle {
                position: absolute !important; top: 0 !important; bottom: 0 !important; width: 14px !important; margin-left: -7px !important;
                cursor: ew-resize !important; display: flex !important; align-items: center !important; justify-content: center !important;
                z-index: 3 !important; touch-action: none !important;
            }
            .sc-gif-filmstrip-handle-grip {
                width: 6px !important; height: 28px !important; border-radius: 3px !important;
                background: #ffb020 !important; border: 1px solid #000 !important;
                box-shadow: 0 0 0 3px rgba(255,176,32,0.15) !important;
            }
            .sc-gif-captions { display: flex !important; flex-direction: column !important; gap: 8px !important; }
            .sc-gif-cap-input {
                background: #1f1f22 !important; color: #f4f4f2 !important;
                border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 4px !important;
                padding: 6px 8px !important; font-size: 13px !important; width: 100% !important;
                box-sizing: border-box !important;
                transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important;
            }
            .sc-gif-cap-input::placeholder { color: rgba(244,244,242,0.34) !important; }
            .sc-gif-cap-color {
                display: flex !important; align-items: center !important; gap: 14px !important; justify-content: center !important;
                color: rgba(244,244,242,0.62) !important; font-size: 12px !important;
            }
            .sc-gif-cap-color label { display: flex !important; align-items: center !important; gap: 4px !important; cursor: pointer !important; }
            .sc-gif-thumb-loading::after {
                content: '' !important;
                position: absolute !important;
                top: 50% !important; left: 50% !important;
                width: 22px !important; height: 22px !important;
                margin: -11px 0 0 -11px !important;
                border: 2px solid rgba(244,244,242,0.25) !important;
                border-top-color: #ffb020 !important;
                border-radius: 50% !important;
                animation: sc-gif-spin 0.8s linear infinite !important;
            }
            @keyframes sc-gif-spin { to { transform: rotate(360deg); } }
            .sc-gif-spinner {
                display: inline-block !important;
                width: 18px !important; height: 18px !important;
                border: 2px solid rgba(244,244,242,0.25) !important;
                border-top-color: #ffb020 !important;
                border-radius: 50% !important;
                animation: sc-gif-spin 0.8s linear infinite !important;
                flex: none !important;
            }
            .sc-gif-spinner-sm { width: 13px !important; height: 13px !important; }
            .sc-gif-working {
                display: flex !important; align-items: center !important; gap: 10px !important;
                padding: 14px 4px !important; color: rgba(244,244,242,0.62) !important; font-size: 13px !important;
            }
            .sc-gif-mark-label {
                color: #ffb020 !important; font-size: 11px !important; font-weight: 700 !important;
                letter-spacing: 0.06em !important; text-align: center !important;
            }
            .sc-gif-mark-btns { display: flex !important; gap: 4px !important; }
            .sc-gif-mark-btns button {
                flex: 1 1 0 !important; min-width: 0 !important;
                background: transparent !important; color: rgba(244,244,242,0.62) !important;
                border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 4px !important;
                padding: 4px 0 !important; font-size: 11px !important; cursor: pointer !important;
                transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important;
            }
            .sc-gif-mark-btns button:hover {
                background: rgba(255,176,32,0.14) !important; border-color: #ffb020 !important; color: #f4f4f2 !important;
            }
            #sc-gif-dur-line {
                text-align: center !important; color: rgba(244,244,242,0.62) !important; font-size: 12px !important;
            }
            #sc-gif-dur-line b { color: #f4f4f2 !important; }
            .sc-gif-opts { display: flex !important; gap: 12px !important; }
            .sc-gif-col-right .sc-gif-opts { flex-direction: column !important; gap: 6px !important; }
            .sc-gif-opts label { flex: 1 1 0 !important; }
            #sc-gif-go {
                background: #ffb020 !important; color: #0c0c0e !important;
                border: none !important; border-radius: 8px !important;
                padding: 8px 16px !important; font-size: 13px !important; font-weight: 600 !important;
                cursor: pointer !important;
                transition: box-shadow 120ms ease, opacity 120ms ease !important;
            }
            #sc-gif-go:hover:not(:disabled), #sc-gif-go:focus-visible:not(:disabled) {
                box-shadow: 0 0 0 3px rgba(255,176,32,0.14) !important;
            }
            #sc-gif-go:disabled { opacity: 0.5 !important; cursor: default !important; }
            #sc-gif-status { color: rgba(244,244,242,0.62) !important; font-size: 12px !important; min-height: 14px !important; }
            #sc-gif-result img { width: 100% !important; border-radius: 8px !important; display: block !important; }
            #sc-gif-actions { display: flex !important; align-items: center !important; gap: 10px !important; margin-top: 8px !important; }
            #sc-gif-dl { background: transparent !important; color: rgba(244,244,242,0.62) !important;
                         border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 8px !important;
                         padding: 5px 12px !important; font-size: 12px !important; cursor: pointer !important;
                         text-decoration: none !important;
                         transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important; }
            #sc-gif-dl:hover { background: rgba(255,176,32,0.14) !important; border-color: #ffb020 !important; color: #f4f4f2 !important; }
            #sc-gif-size { color: rgba(244,244,242,0.34) !important; font-size: 11px !important; margin-left: auto !important; }
            .sc-gif-imgbb-row { display: flex !important; flex-direction: column !important; gap: 4px !important; }
            .sc-gif-imgbb-label {
                color: rgba(244,244,242,0.62) !important; font-size: 12px !important; font-weight: 500 !important;
                text-transform: uppercase !important; letter-spacing: 0.06em !important;
            }
            .sc-gif-imgbb-header {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                background: transparent !important; border: none !important; padding: 0 !important;
                cursor: pointer !important; width: 100% !important; text-align: left !important;
                transition: color 120ms ease !important;
            }
            .sc-gif-imgbb-header:focus-visible { outline: 2px solid #ffb020 !important; outline-offset: 1px !important; }
            .sc-gif-imgbb-toggle { color: rgba(244,244,242,0.34) !important; font-size: 11px !important; }
            .sc-gif-imgbb-body { display: none !important; flex-direction: column !important; gap: 8px !important; margin-top: 4px !important; }
            .sc-gif-imgbb-row.sc-gif-imgbb-open .sc-gif-imgbb-body { display: flex !important; }
            .sc-gif-imgbb-input-row { display: flex !important; gap: 6px !important; }
            .sc-gif-imgbb-input { flex: 1 1 auto !important; }
            .sc-gif-imgbb-test-btn {
                background: transparent !important; color: rgba(244,244,242,0.62) !important;
                border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 8px !important;
                padding: 5px 12px !important; font-size: 12px !important; cursor: pointer !important;
                transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important;
            }
            .sc-gif-imgbb-test-btn:hover:not(:disabled) {
                background: rgba(255,176,32,0.14) !important; border-color: #ffb020 !important; color: #f4f4f2 !important;
            }
            .sc-gif-imgbb-status { font-size: 11px !important; min-height: 13px !important; }
            .sc-gif-optimize-row { display: flex !important; align-items: center !important; gap: 6px !important; }
            .sc-gif-optimize-row label { color: rgba(244,244,242,0.62) !important; font-size: 12px !important; }
            .sc-gif-cols { display: flex !important; flex-wrap: wrap !important; gap: 16px !important; }
            .sc-gif-col-left, .sc-gif-col-right {
                flex: 1 1 260px !important; min-width: 0 !important;
                display: flex !important; flex-direction: column !important; gap: 8px !important;
                background: rgba(244,244,242,0.02) !important;
                border: 1px solid rgba(244,244,242,0.06) !important;
                border-radius: 8px !important;
                padding: 12px !important;
            }
            .sc-gif-fx-header {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                background: transparent !important; border: none !important; padding: 0 !important;
                cursor: pointer !important; width: 100% !important; text-align: left !important;
                color: rgba(244,244,242,0.62) !important; font-size: 12px !important; font-weight: 500 !important;
                text-transform: uppercase !important; letter-spacing: 0.06em !important;
                transition: color 120ms ease !important;
            }
            .sc-gif-fx-header:focus-visible { outline: 2px solid #ffb020 !important; outline-offset: 1px !important; }
            .sc-gif-fx-toggle { color: rgba(244,244,242,0.34) !important; font-size: 11px !important; }
            .sc-gif-fx { display: none !important; flex-direction: column !important; gap: 8px !important; }
            .sc-gif-fx.sc-gif-fx-open { display: flex !important; }
            .sc-gif-fx-row { display: flex !important; align-items: center !important; gap: 10px !important; }
            .sc-gif-fx-row label { flex: 1 1 0 !important; }
            .sc-gif-fx-row input[type=number] {
                width: 64px !important; background: #1f1f22 !important; color: #f4f4f2 !important;
                border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 4px !important; padding: 2px 4px !important;
                transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important;
            }
            .sc-gif-fx-filters { display: flex !important; flex-direction: column !important; gap: 6px !important; }
            .sc-gif-fx-filter { display: flex !important; align-items: center !important; gap: 8px !important; }
            .sc-gif-fx-filter label { flex: 1 1 auto !important; color: rgba(244,244,242,0.62) !important; font-size: 12px !important; }
            .sc-gif-fx-filter input[type=range] { flex: 1 1 auto !important; accent-color: #ffb020 !important; }
            .sc-gif-preview { display: flex !important; flex-direction: column !important; gap: 6px !important; }
            .sc-gif-preview canvas {
                width: 100% !important; background: #000 !important; border-radius: 8px !important;
                border: 1px solid rgba(244,244,242,0.08) !important; display: block !important;
            }
            .sc-gif-preview-controls { display: flex !important; align-items: center !important; gap: 8px !important; }
            .sc-gif-preview-controls input[type=range] { flex: 1 1 auto !important; accent-color: #ffb020 !important; }
            .sc-gif-preview-controls button {
                background: transparent !important; color: rgba(244,244,242,0.62) !important;
                border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 4px !important;
                padding: 4px 10px !important; font-size: 12px !important; cursor: pointer !important;
                transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important;
            }
            .sc-gif-preview-controls button:hover {
                background: rgba(255,176,32,0.14) !important; border-color: #ffb020 !important; color: #f4f4f2 !important;
            }
            #sc-gif-fx-preview-btn {
                background: transparent !important; color: rgba(244,244,242,0.62) !important;
                border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 8px !important;
                padding: 5px 12px !important; font-size: 12px !important; cursor: pointer !important;
                transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important;
            }
            #sc-gif-fx-preview-btn:hover {
                background: rgba(255,176,32,0.14) !important; border-color: #ffb020 !important; color: #f4f4f2 !important;
            }
            .sc-gif-preview-status { color: rgba(244,244,242,0.34) !important; font-size: 11px !important; text-align: center !important; }
            .sc-test-ok      { color: #7dffa0 !important; }
            .sc-test-bad     { color: #ff8080 !important; }
            .sc-test-pending { color: rgba(244,244,242,0.34) !important; }
            #sc-gif-link {
                display: flex !important; align-items: center !important; gap: 8px !important;
                flex-wrap: wrap !important; margin-top: 8px !important;
            }
            .sc-gif-link-url {
                color: #8ab4ff !important; font-size: 12px !important; word-break: break-all !important;
                text-decoration: none !important;
            }
            .sc-gif-link-url:hover { text-decoration: underline !important; }
            .sc-gif-link-msg { color: rgba(244,244,242,0.62) !important; font-size: 12px !important; }
            #sc-gif-copylink, #sc-gif-upload {
                background: transparent !important; color: rgba(244,244,242,0.62) !important;
                border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 8px !important;
                padding: 5px 12px !important; font-size: 12px !important; cursor: pointer !important;
                transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important;
            }
            #sc-gif-copylink:hover, #sc-gif-upload:hover:not(:disabled) {
                background: rgba(255,176,32,0.14) !important; border-color: #ffb020 !important; color: #f4f4f2 !important;
            }
            #sc-gif-upload:disabled { opacity: 0.5 !important; cursor: default !important; }
```

- [ ] **Step 2: Verify syntax**

Run: `node --check cytube.gifmaker.user.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Self-review**

Trace through and confirm:
1. Every `#ffcc44`/`rgba(255,204,68,…)`/`rgba(255,200,50,…)` accent occurrence in the old block has a corresponding `#ffb020`/`rgba(255,176,32,…)` occurrence in the new block, at the same selector, with the same opacity value carried over unchanged (only the hue changed, not the alpha).
2. `.sc-gif-cap` (the WYSIWYG meme caption text style, `color: #fff`, Impact font stack) is byte-identical between old and new — this is explicitly out of scope.
3. `#7dffa0`, `#ff8080`, `#8ab4ff`, `#ffe135` (status/link/caption-yellow) are unchanged.
4. The primary/ghost button split: `#sc-gif-go` is the only rule with a solid non-transparent background fill among all button-like selectors; `.sc-gif-mark-btns button`, `#sc-gif-dl`, `.sc-gif-imgbb-test-btn`, `.sc-gif-preview-controls button`, `#sc-gif-fx-preview-btn` (new), `#sc-gif-copylink`/`#sc-gif-upload` all use `background: transparent` with a `0.14`-tier border and an `accent`-tinted `:hover`.
5. `.sc-gif-card`, `.sc-gif-mono` (combined selector), and `#sc-gif-fx-preview-btn` are genuinely new rules — confirm none of these class/ID names existed in the old block (search the old block text above for each).
6. `.sc-gif-col-left, .sc-gif-col-right` still has its pre-existing `flex: 1 1 260px !important; min-width: 0 !important;` — only the `gap` value and the four new card-look properties were added; nothing about its flex-layout role changed.
7. No `transition` was added to `#sc-gif-panel`, `.sc-gif-filmstrip-handle`, `.sc-gif-filmstrip-handle-grip`, `.sc-gif-filmstrip-selection`, `.sc-gif-filmstrip-dim-left`, `.sc-gif-filmstrip-dim-right`, `.sc-gif-overview-viewport`, `.sc-gif-overview-ghost`, `.sc-gif-cap-handle`, `.sc-gif-cap-top`, or `.sc-gif-cap-bottom` — these are all repositioned via inline styles by JS `pointermove` handlers, and a CSS transition on any of them would visibly lag or fight that positioning.
8. `.sc-gif-mark-label` does NOT have a `font-family` change — only `#sc-gif-time-start`/`#sc-gif-time-end` (targeted by the new combined `.sc-gif-mono, …` selector) go monospace, not the "START ·"/"END ·" label text that shares the parent element.

- [ ] **Step 4: Commit**

```bash
git add cytube.gifmaker.user.js
git commit -m "Redesign GIF Maker panel CSS: Editing Bay visual system (color, type, cards, button hierarchy, motion)"
```

---

### Task 2: HTML card wrappers, timecode label split, manual verification

**Files:**
- Modify: `cytube.gifmaker.user.js` (`openGifPanel()`'s HTML template, lines ~1017–1186; one JS line at ~1575)

**Interfaces:**
- Consumes: `.sc-gif-card` and `.sc-gif-mono` CSS classes from Task 1.
- Produces: no new IDs except the moved `#sc-gif-overview-current` (same ID, new element). No function signatures change.

- [ ] **Step 1: Wrap the Trim card (overview scrubber + filmstrip + marks + duration line)**

Find this exact block:
```js
            <div id="sc-gif-body">
                <div class="sc-gif-overview">
```
Replace with:
```js
            <div id="sc-gif-body">
                <div class="sc-gif-card">
                <div class="sc-gif-overview">
```

Find this exact block:
```js
                <div id="sc-gif-dur-line">Duration <b id="sc-gif-dur-val"></b></div>
                <div class="sc-gif-cols">
```
Replace with:
```js
                <div id="sc-gif-dur-line">Duration <b id="sc-gif-dur-val"></b></div>
                </div>
                <div class="sc-gif-cols">
```

- [ ] **Step 2: Wrap the Output card (ImgBB row + Optimize row)**

Find this exact block:
```js
                <div class="sc-gif-imgbb-row" id="sc-gif-imgbb-row">
```
Replace with:
```js
                <div class="sc-gif-card">
                <div class="sc-gif-imgbb-row" id="sc-gif-imgbb-row">
```

Find this exact block:
```js
                <div class="sc-gif-optimize-row">
                    <input type="checkbox" id="sc-gif-optimize" ${gifOptimizeEnabled() ? 'checked' : ''} />
                    <label for="sc-gif-optimize">Optimize GIF before upload</label>
                </div>
                <button id="sc-gif-go" type="button">● Make GIF</button>
```
Replace with:
```js
                <div class="sc-gif-optimize-row">
                    <input type="checkbox" id="sc-gif-optimize" ${gifOptimizeEnabled() ? 'checked' : ''} />
                    <label for="sc-gif-optimize">Optimize GIF before upload</label>
                </div>
                </div>
                <button id="sc-gif-go" type="button">● Make GIF</button>
```

- [ ] **Step 3: Split the "Currently editing" timecode label (approved HTML+JS change)**

Find this exact line:
```js
                        <span class="sc-gif-overview-current" id="sc-gif-overview-current"></span>
```
Replace with:
```js
                        <span class="sc-gif-overview-current">Currently editing: <span id="sc-gif-overview-current" class="sc-gif-mono"></span></span>
```

Find this exact line (inside the `render()`/scrubber-drag logic further down in `openGifPanel()`, not the HTML template):
```js
                overviewCurrent.textContent = 'Currently editing: ' + _fmtClockTenths(startT);
```
Replace with:
```js
                overviewCurrent.textContent = _fmtClockTenths(startT);
```

(`const overviewCurrent = $('#sc-gif-overview-current');` a few dozen lines earlier is unaffected — the ID it queries still exists, just on the inner `<span>` now instead of the outer one, and `overviewCurrent.textContent = ...` still sets exactly the time-value text as intended.)

- [ ] **Step 4: Verify syntax**

Run: `node --check cytube.gifmaker.user.js`
Expected: no output, exit code 0.

- [ ] **Step 5: Self-review**

Trace through and confirm:
1. Every `<div>` opened by this task's HTML edits has a matching `</div>` — count carefully: the Trim card wrap adds one opening `<div class="sc-gif-card">` right after `<div id="sc-gif-body">` and one matching closing `</div>` right before `<div class="sc-gif-cols">`; the Output card wrap adds one opening `<div class="sc-gif-card">` right before `<div class="sc-gif-imgbb-row" ...>` and one matching closing `</div>` right after the `.sc-gif-optimize-row` block's own closing `</div>`, before `<button id="sc-gif-go" ...>`.
2. `#sc-gif-overview-current` still exists exactly once in the HTML (now on the inner span) and is still queried by `$('#sc-gif-overview-current')` — no other code references the outer `.sc-gif-overview-current`-classed span by ID.
3. No existing ID was removed, renamed, or duplicated.
4. The two-column `.sc-gif-cols` block (Captions/Format) and the `.sc-gif-fx`/`#sc-gif-fx-body` Effects block are both left completely untouched by this task — neither gets a `.sc-gif-card` wrapper, per the design plan.
5. `overviewCurrent.textContent = _fmtClockTenths(startT);` produces the exact same rendered string as before (`"Currently editing: " + time`) once combined with the static `"Currently editing: "` text now in the HTML — read both the HTML and the JS line together to confirm.

- [ ] **Step 6: Manual browser verification**

Load the userscript in a Tampermonkey dev profile against a live CyTube video (`420Grindhouse` or `testing` room). Open the GIF Maker and confirm:
- The Trim card (scrubber + filmstrip + marks + duration) and the Output card (ImgBB + Optimize) each render as a visually distinct grouped region with a subtle background/border, not just a flat stack.
- Every time/duration value (start/end mark labels, duration line, overview scrubber's current/total, filmstrip window range) renders in the monospace font, and the "Currently editing:" label text does NOT render in monospace — only the time value after it.
- "● Make GIF" is the only solid-filled button in the panel; every other button (±.5/Now, Download, ImgBB Test, Preview effects, play/pause, Copy link, Upload) is a transparent/ghost style that fills amber on hover.
- Hovering any button/input shows a smooth, small color transition — not an instant snap, but also not a noticeable lag.
- Drag the panel by its header, drag both filmstrip handles, drag the filmstrip selection band, drag the overview scrubber, and drag a caption position dot — confirm none of these show any visible lag, jitter, or fighting against the new hover transitions (this is the one behavioral risk in an otherwise purely visual change).
- Expand the Effects section and confirm its filter-intensity number input (freeze-hold ms) renders in monospace, and the "Effects"/"ImgBB key (for Upload)" disclosure header labels render in uppercase with letter-spacing.
- Close and reopen the panel — everything still opens correctly with no console errors.

- [ ] **Step 7: Commit**

```bash
git add cytube.gifmaker.user.js
git commit -m "Add card grouping and split the timecode label for monospace styling"
```
