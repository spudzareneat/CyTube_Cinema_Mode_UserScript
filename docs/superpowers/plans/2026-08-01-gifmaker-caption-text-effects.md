# GIF Maker Caption Text Effects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three caption text effects to the GIF Maker in `cytube.gifmaker.user.js` — drop shadow, rainbow color-cycle, and wiggle — extending the existing Impact-font meme caption renderer.

**Architecture:** Captions are already drawn inline, once per captured frame, from `captureGifFrames`'s `onFrame` handler via `drawCaptions` → `drawCaptionBlockAdvanced` → `applyCaptionCtxStyle`. That handler already computes clip progress (`(t - startT) / span`) for its `onProgress` callback; Task 1 threads that same progress value into the caption draw calls so rainbow (hue cycles with progress) and wiggle (sine-offset driven by progress) have a time signal to animate against, with drop shadow riding along as a static (non-time-based) canvas shadow. Task 2 adds the Effects-panel controls (checkbox+slider rows, matching the existing Deep-fry/VHS/Zoom-Shake pattern) and a third "Rainbow" option in the existing caption color radio group, plus CSS approximations so the live caption preview thumbnails reflect the chosen effects.

**Tech Stack:** Tampermonkey userscript (vanilla JS, no build step), Canvas 2D API (`shadowBlur`/`shadowOffset`, HSL fill strings) for the render, CSS `@keyframes`/`filter: drop-shadow` for the preview approximation.

## Global Constraints

- No automated test framework in this repo — verification is `node --check cytube.gifmaker.user.js` (syntax only) plus a code-reading self-review and manual browser verification, matching every other GIF Maker task on this codebase (see `docs/superpowers/plans/2026-07-25-gif-optimization.md`, `docs/superpowers/plans/2026-07-31-gifmaker-effects.md`).
- **Scope: `cytube.gifmaker.user.js` only.** `cytube.pc.user.js` does not duplicate any caption-rendering code — it only exposes a title/floating-button bridge object and shares one localStorage key (`sc_gif_optimize`) with the GIF Maker script, which owns the entire panel. Do not touch `cytube.pc.user.js`.
- All three new effects are **shared toggles** — they apply identically to both the top and bottom captions. There is no per-caption (top vs. bottom) independent control.
- Rainbow lives as a third option (`value="rainbow"`) in the existing `.sc-gif-cap-color` radio group, alongside White/Yellow — not a separate Effects-panel checkbox. It is mutually exclusive with White/Yellow by construction (radio group).
- Drop shadow and wiggle are new checkbox+slider rows in the existing `.sc-gif-fx-filters` block, each `0–100` intensity, default `60`, **off by default** — exact same shape as the existing Deep-fry/VHS/Zoom-Shake rows (`sc-gif-fx-<name>-on` checkbox id, `sc-gif-fx-<name>-amt` range id).
- Labeled "Caption drop shadow" and "Caption wiggle" in the UI (not just "Drop shadow" / "Wiggle") to avoid confusion with the existing "Zoom/Shake" video-level effect, which shakes the whole frame, not just caption text.
- None of the new effect state is persisted to `localStorage` — it lives only in the `fx` object inside the `openGifPanel()` closure, resetting to defaults every time the panel opens. This matches every existing Effects-panel control.
- Exact function signatures — later tasks depend on these exactly:
  - `applyCaptionCtxStyle(ctx, fontPx, color, progress)` — `progress` is a `0..1` float (or `undefined`, treated as `0`). When `color === 'rainbow'`, `fillStyle` is set from `progress`; otherwise unchanged from current behavior.
  - `drawCaptionBlockAdvanced(ctx, w, h, text, color, sizePct, xPct, yPct, progress, fx)` — `fx` is `undefined` or `{ shadow: { enabled, intensity }, wiggle: { enabled, intensity } }`.
  - `drawCaptions(ctx, w, h, captions, progress)` — `captions.fx` (optional) is read and passed through to `drawCaptionBlockAdvanced`.
- **Regression rule:** with `progress` omitted/`undefined` and `captions.fx` omitted, output must be pixel-identical to the current renderer (`color: 'white'|'yellow'` unaffected, no shadow, no wiggle). This lets Task 1 land safely before any UI exists to set non-default effects.

---

### Task 1: Thread progress into caption rendering; implement the three effects

**Files:**
- Modify: `cytube.gifmaker.user.js` — `applyCaptionCtxStyle`, `drawCaptionBlockAdvanced`, `drawCaptions` (currently lines 540-575); `captureGifFrames`'s `onFrame` handler (currently around lines 637-644)

**Interfaces:**
- Consumes: nothing new — pure extension of existing functions.
- Produces: the four signatures listed in Global Constraints. Not yet reachable from any UI control (no task wires `captions.fx` from real checkboxes until Task 2) — `captions.fx` stays `undefined` in the one real caller (`goBtn`'s handler) until then, so this task changes zero visible behavior on its own.

- [ ] **Step 1: Replace the caption rendering functions**

Find:
```js
    function applyCaptionCtxStyle(ctx, fontPx, color) {
        ctx.font = 'bold ' + fontPx + 'px ' + CAPTION_FONT_STACK;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        ctx.fillStyle = color === 'yellow' ? '#ffe135' : '#ffffff';
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = Math.max(2, Math.round(fontPx / 14));
    }
    function drawCaptionBlockAdvanced(ctx, w, h, text, color, sizePct, xPct, yPct) {
        if (!text) return;
        const fontPx = Math.max(4, Math.round(h * (sizePct || 16) / 100));
        const { lines } = wrapCaptionAtSize(getCaptionMeasureCtx(), text.toUpperCase(), fontPx, w * 0.92);
        const lineHeight = Math.round(fontPx * 1.15);
        ctx.save();
        applyCaptionCtxStyle(ctx, fontPx, color);
        const cx = w * ((xPct == null ? 50 : xPct) / 100);
        const cy = h * ((yPct == null ? 50 : yPct) / 100);
        const blockH = lines.length * lineHeight;
        const firstBaselineY = cy - blockH / 2 + fontPx * 0.8;
        lines.forEach((line, i) => {
            const ly = firstBaselineY + i * lineHeight;
            ctx.strokeText(line, cx, ly);
            ctx.fillText(line, cx, ly);
        });
        ctx.restore();
    }
    function drawCaptions(ctx, w, h, captions) {
        if (!captions) return;
        ['top', 'bottom'].forEach(key => {
            const line = captions[key];
            if (!line || !line.text) return;
            drawCaptionBlockAdvanced(ctx, w, h, line.text, captions.color, line.size, line.x, line.y);
        });
    }
```

Replace:
```js
    function applyCaptionCtxStyle(ctx, fontPx, color, progress) {
        ctx.font = 'bold ' + fontPx + 'px ' + CAPTION_FONT_STACK;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        if (color === 'rainbow') {
            ctx.fillStyle = 'hsl(' + Math.round((progress || 0) * 360) + ', 90%, 60%)';
        } else {
            ctx.fillStyle = color === 'yellow' ? '#ffe135' : '#ffffff';
        }
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = Math.max(2, Math.round(fontPx / 14));
    }
    // Wiggle offsets the block center with a progress-driven sine wobble
    // (not per-frame random jitter) because GIF capture runs at low fps
    // (8-15) — random jitter at that rate reads as flicker, not motion.
    // Different x/y frequencies avoid a simple circular path.
    function drawCaptionBlockAdvanced(ctx, w, h, text, color, sizePct, xPct, yPct, progress, fx) {
        if (!text) return;
        const fontPx = Math.max(4, Math.round(h * (sizePct || 16) / 100));
        const { lines } = wrapCaptionAtSize(getCaptionMeasureCtx(), text.toUpperCase(), fontPx, w * 0.92);
        const lineHeight = Math.round(fontPx * 1.15);
        ctx.save();
        applyCaptionCtxStyle(ctx, fontPx, color, progress);
        let cx = w * ((xPct == null ? 50 : xPct) / 100);
        let cy = h * ((yPct == null ? 50 : yPct) / 100);
        if (fx && fx.wiggle && fx.wiggle.enabled) {
            const amp = Math.max(0, Math.min(100, fx.wiggle.intensity || 0)) / 100 * fontPx * 0.35;
            cx += Math.sin((progress || 0) * Math.PI * 2 * 3) * amp;
            cy += Math.cos((progress || 0) * Math.PI * 2 * 2.3) * amp;
        }
        const blockH = lines.length * lineHeight;
        const firstBaselineY = cy - blockH / 2 + fontPx * 0.8;
        // Shadow is applied under the stroke pass only, then cleared before
        // the fill pass — canvas shadow would otherwise render twice
        // (once per draw call) and look doubled/blurred.
        if (fx && fx.shadow && fx.shadow.enabled) {
            const amt = Math.max(0, Math.min(100, fx.shadow.intensity || 0)) / 100;
            ctx.shadowColor = 'rgba(0,0,0,0.7)';
            ctx.shadowBlur = amt * 14;
            ctx.shadowOffsetX = amt * 5;
            ctx.shadowOffsetY = amt * 5;
        }
        lines.forEach((line, i) => {
            const ly = firstBaselineY + i * lineHeight;
            ctx.strokeText(line, cx, ly);
        });
        ctx.shadowColor = 'transparent';
        lines.forEach((line, i) => {
            const ly = firstBaselineY + i * lineHeight;
            ctx.fillText(line, cx, ly);
        });
        ctx.restore();
    }
    function drawCaptions(ctx, w, h, captions, progress) {
        if (!captions) return;
        ['top', 'bottom'].forEach(key => {
            const line = captions[key];
            if (!line || !line.text) return;
            drawCaptionBlockAdvanced(ctx, w, h, line.text, captions.color, line.size, line.x, line.y, progress, captions.fx);
        });
    }
```

- [ ] **Step 2: Pass clip progress from the capture loop**

Find:
```js
                    if (geom.src) ctx.drawImage(vid, geom.src[0], geom.src[1], geom.src[2], geom.src[3],
                                                     geom.dst[0], geom.dst[1], geom.dst[2], geom.dst[3]);
                    else ctx.drawImage(vid, geom.dst[0], geom.dst[1], geom.dst[2], geom.dst[3]);
                    drawCaptions(ctx, w, h, captions);
                    frames.push(ctx.getImageData(0, 0, w, h));
                    if (onProgress) onProgress(Math.min(0.999, (t - startT) / span));
```

Replace:
```js
                    if (geom.src) ctx.drawImage(vid, geom.src[0], geom.src[1], geom.src[2], geom.src[3],
                                                     geom.dst[0], geom.dst[1], geom.dst[2], geom.dst[3]);
                    else ctx.drawImage(vid, geom.dst[0], geom.dst[1], geom.dst[2], geom.dst[3]);
                    const capProgress = Math.min(1, Math.max(0, (t - startT) / span));
                    drawCaptions(ctx, w, h, captions, capProgress);
                    frames.push(ctx.getImageData(0, 0, w, h));
                    if (onProgress) onProgress(Math.min(0.999, (t - startT) / span));
```

- [ ] **Step 3: Verify syntax**

Run: `node --check cytube.gifmaker.user.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Self-review**

Trace through by hand and confirm:
1. Existing caller (`captureGifFrames`'s `onFrame`, Step 2's edit) always passes a real `capProgress` number and the existing `captions` object built in `goBtn`'s handler has no `fx` key yet (added in Task 2) — so `drawCaptionBlockAdvanced`'s `fx` parameter is `undefined` for every call until Task 2 lands, meaning both new `if (fx && fx.wiggle...)` and `if (fx && fx.shadow...)` blocks are skipped and rendering is byte-for-byte unchanged from before this task.
2. `color` is still only ever `'white'` or `'yellow'` until Task 2 adds the Rainbow radio option, so the `color === 'rainbow'` branch in `applyCaptionCtxStyle` is unreachable (but present and correct) until then.
3. `applyCaptionCtxStyle(ctx, fontPx, 'rainbow', 0.25)` → `fillStyle = 'hsl(90, 90%, 60%)'`. `applyCaptionCtxStyle(ctx, fontPx, 'rainbow', undefined)` → `progress || 0` → `'hsl(0, 90%, 60%)'`, no `NaN`.
4. `drawCaptionBlockAdvanced` with `fx.wiggle = { enabled: true, intensity: 100 }`, `fontPx = 40`, `progress = 0` → `amp = 1 * 40 * 0.35 = 14`; `cx += sin(0) * 14 = 0`; `cy += cos(0) * 14 = 14`. At `progress = 0.25` → `sin(0.25 * 2π * 3) = sin(1.5π) = -1` → `cx -= 14`; `cos(0.25 * 2π * 2.3) = cos(1.15π) ≈ -0.976` → `cy -= 13.6`. Motion is bounded to `±14px` at max intensity for a 40px font — proportional, not extreme.
5. `drawCaptionBlockAdvanced` with `fx.shadow = { enabled: true, intensity: 60 }` → `amt = 0.6` → `shadowBlur = 8.4`, `shadowOffsetX = shadowOffsetY = 3`. The two separate `lines.forEach` passes mean `ctx.shadowColor` is `'rgba(0,0,0,0.7)'` during the `strokeText` pass and `'transparent'` during the `fillText` pass — shadow renders once, under the outline, not doubled under the fill.
6. `ctx.save()`/`ctx.restore()` still wraps the whole function, so `shadowColor`/`shadowBlur`/`shadowOffsetX`/`shadowOffsetY` set here never leak into the next caption block's draw (top vs. bottom) or the next frame's `drawImage` call.

- [ ] **Step 5: Commit**

```bash
git add cytube.gifmaker.user.js
git commit -m "Add drop shadow, rainbow, and wiggle caption rendering (not yet wired to UI)"
```

---

### Task 2: Effects panel UI, caption color option, and preview approximation

**Files:**
- Modify: `cytube.gifmaker.user.js` — CSS block (`.sc-gif-cap-yellow` rule, currently line 173; `.sc-gif-fx-filters` HTML, currently around lines 1241-1250); caption color radio HTML (currently lines 1190-1193); panel wiring — the `fx` state block (currently lines 1497-1522) and the code around it (currently lines 1430-1441, 1443-1461); `goBtn`'s click handler (currently lines 1833-1866)

**Interfaces:**
- Consumes: `applyCaptionCtxStyle`/`drawCaptionBlockAdvanced`/`drawCaptions`/`captureGifFrames` (Task 1, unchanged signatures already in place).
- Produces: `fx.shadow`/`fx.wiggle` state (added to the existing `fx` object), `sc-gif-fx-shadow-on`/`-amt` and `sc-gif-fx-wiggle-on`/`-amt` controls, the `rainbow` radio option, and `captions.fx` populated in `goBtn`'s handler — the first real caller of Task 1's `fx` parameter.

- [ ] **Step 1: Add CSS for the preview approximations**

Find:
```js
            .sc-gif-cap-yellow { color: #ffe135 !important; }
```

Replace:
```js
            .sc-gif-cap-yellow { color: #ffe135 !important; }
            .sc-gif-cap-rainbow { animation: sc-gif-cap-rainbow-cycle 3s linear infinite !important; }
            @keyframes sc-gif-cap-rainbow-cycle {
                0%   { color: hsl(0, 90%, 60%); }
                25%  { color: hsl(90, 90%, 60%); }
                50%  { color: hsl(180, 90%, 60%); }
                75%  { color: hsl(270, 90%, 60%); }
                100% { color: hsl(360, 90%, 60%); }
            }
            .sc-gif-cap-shadow { filter: drop-shadow(3px 4px 3px rgba(0,0,0,0.75)) !important; }
            .sc-gif-cap-wiggle { animation: sc-gif-cap-wiggle-cycle 1.4s ease-in-out infinite !important; }
            @keyframes sc-gif-cap-wiggle-cycle {
                0%   { transform: translate(-50%, -50%) translate(0, 0); }
                25%  { transform: translate(-50%, -50%) translate(4px, -3px); }
                50%  { transform: translate(-50%, -50%) translate(-3px, 3px); }
                75%  { transform: translate(-50%, -50%) translate(3px, 2px); }
                100% { transform: translate(-50%, -50%) translate(0, 0); }
            }
```

(`!important` is omitted inside the `@keyframes` bodies themselves — it's invalid there per spec and browsers strip it; the class-level `animation`/`filter` declarations keep `!important` to match this file's existing convention. Animated properties already win over `!important` base rules like `.sc-gif-cap`'s `color`/`transform` while the animation runs, so no conflict with the existing rules.)

- [ ] **Step 2: Add the Rainbow radio option**

Find:
```js
                            <div class="sc-gif-cap-color">
                                <label><input type="radio" name="sc-gif-cap-color" value="white" checked> White</label>
                                <label><input type="radio" name="sc-gif-cap-color" value="yellow"> Yellow</label>
                            </div>
```

Replace:
```js
                            <div class="sc-gif-cap-color">
                                <label><input type="radio" name="sc-gif-cap-color" value="white" checked> White</label>
                                <label><input type="radio" name="sc-gif-cap-color" value="yellow"> Yellow</label>
                                <label><input type="radio" name="sc-gif-cap-color" value="rainbow"> Rainbow</label>
                            </div>
```

- [ ] **Step 3: Add the Effects panel rows**

Find:
```js
                                <div class="sc-gif-fx-filter">
                                    <input type="checkbox" id="sc-gif-fx-zoomshake-on">
                                    <label for="sc-gif-fx-zoomshake-on">Zoom/Shake</label>
                                    <select id="sc-gif-fx-zoomshake-mode">
                                        <option value="zoom" selected>Zoom-in</option>
                                        <option value="shake">Shake</option>
                                    </select>
                                    <input type="range" id="sc-gif-fx-zoomshake-amt" min="0" max="100" value="60">
                                </div>
                            </div>
```

Replace:
```js
                                <div class="sc-gif-fx-filter">
                                    <input type="checkbox" id="sc-gif-fx-zoomshake-on">
                                    <label for="sc-gif-fx-zoomshake-on">Zoom/Shake</label>
                                    <select id="sc-gif-fx-zoomshake-mode">
                                        <option value="zoom" selected>Zoom-in</option>
                                        <option value="shake">Shake</option>
                                    </select>
                                    <input type="range" id="sc-gif-fx-zoomshake-amt" min="0" max="100" value="60">
                                </div>
                                <div class="sc-gif-fx-filter">
                                    <input type="checkbox" id="sc-gif-fx-shadow-on">
                                    <label for="sc-gif-fx-shadow-on">Caption drop shadow</label>
                                    <input type="range" id="sc-gif-fx-shadow-amt" min="0" max="100" value="60">
                                </div>
                                <div class="sc-gif-fx-filter">
                                    <input type="checkbox" id="sc-gif-fx-wiggle-on">
                                    <label for="sc-gif-fx-wiggle-on">Caption wiggle</label>
                                    <input type="range" id="sc-gif-fx-wiggle-amt" min="0" max="100" value="60">
                                </div>
                            </div>
```

- [ ] **Step 4: Move the `fx` state block earlier and extend it with shadow/wiggle**

The `fx` object must exist before `renderCaptionPreviews()` is first called, because Step 6 makes `renderCaptionPreview` read `fx.shadow.enabled`/`fx.wiggle.enabled`. Today `renderCaptionPreviews()` is first called (line 1495) *before* `const fx = {...}` is declared (line 1497) — calling a function that reads a not-yet-initialized `const` would throw. Move the whole block earlier, folding in the two new effects.

First, remove it from its current location. Find:
```js
        }
        ['top', 'bottom'].forEach(key => {
            wireCapHandle($('#sc-gif-cap-handle-' + key + '-start'), $('#sc-gif-thumb-start'), key);
        });

        renderCaptionPreviews();

        const fx = {
            mode: 'normal', speed: 1, freezeHoldMs: 0,
            deepFry: { enabled: false, intensity: 60 },
            vhs: { enabled: false, intensity: 60 },
            zoomShake: { enabled: false, mode: 'zoom', intensity: 60 },
        };
        const fxModeSel = $('#sc-gif-fx-mode'), fxSpeedSel = $('#sc-gif-fx-speed'), fxFreezeInput = $('#sc-gif-fx-freeze');
        const fxDeepFryOn = $('#sc-gif-fx-deepfry-on'), fxDeepFryAmt = $('#sc-gif-fx-deepfry-amt');
        const fxVhsOn = $('#sc-gif-fx-vhs-on'), fxVhsAmt = $('#sc-gif-fx-vhs-amt');
        const fxZsOn = $('#sc-gif-fx-zoomshake-on'), fxZsMode = $('#sc-gif-fx-zoomshake-mode'), fxZsAmt = $('#sc-gif-fx-zoomshake-amt');

        function syncFxState() {
            fx.mode = fxModeSel.value;
            fx.speed = parseFloat(fxSpeedSel.value) || 1;
            fx.freezeHoldMs = Math.max(0, parseInt(fxFreezeInput.value, 10) || 0);
            fx.deepFry.enabled = fxDeepFryOn.checked;
            fx.deepFry.intensity = parseInt(fxDeepFryAmt.value, 10) || 0;
            fx.vhs.enabled = fxVhsOn.checked;
            fx.vhs.intensity = parseInt(fxVhsAmt.value, 10) || 0;
            fx.zoomShake.enabled = fxZsOn.checked;
            fx.zoomShake.mode = fxZsMode.value;
            fx.zoomShake.intensity = parseInt(fxZsAmt.value, 10) || 0;
        }
        [fxModeSel, fxSpeedSel, fxFreezeInput, fxDeepFryOn, fxDeepFryAmt, fxVhsOn, fxVhsAmt, fxZsOn, fxZsMode, fxZsAmt]
            .forEach(el => el.addEventListener('input', syncFxState));
        syncFxState();

        const thumbTimers = {};
```

Replace:
```js
        }
        ['top', 'bottom'].forEach(key => {
            wireCapHandle($('#sc-gif-cap-handle-' + key + '-start'), $('#sc-gif-thumb-start'), key);
        });

        renderCaptionPreviews();

        const thumbTimers = {};
```

- [ ] **Step 5: Insert the extended `fx` block before the caption preview code**

Find:
```js
        };
        aspectSel.addEventListener('change', () => { applyThumbAspect(); renderCaptionPreviews(); });
        applyThumbAspect();

        const capTopInput = $('#sc-gif-cap-top');
        const capBottomInput = $('#sc-gif-cap-bottom');
        const capSizeInputs = { top: $('#sc-gif-cap-top-size'), bottom: $('#sc-gif-cap-bottom-size') };
        const getCapColor = () => (panel.querySelector('input[name="sc-gif-cap-color"]:checked') || {}).value || 'white';
        const getCapSizePct = (key) => Math.max(1, parseFloat(capSizeInputs[key].value) || 16);
        const clampPct = (n) => Math.min(100, Math.max(0, isFinite(n) ? n : 50));
        const capPos = { top: { x: 50, y: 10 }, bottom: { x: 50, y: 90 } };
```

Replace:
```js
        };
        aspectSel.addEventListener('change', () => { applyThumbAspect(); renderCaptionPreviews(); });
        applyThumbAspect();

        const fx = {
            mode: 'normal', speed: 1, freezeHoldMs: 0,
            deepFry: { enabled: false, intensity: 60 },
            vhs: { enabled: false, intensity: 60 },
            zoomShake: { enabled: false, mode: 'zoom', intensity: 60 },
            shadow: { enabled: false, intensity: 60 },
            wiggle: { enabled: false, intensity: 60 },
        };
        const fxModeSel = $('#sc-gif-fx-mode'), fxSpeedSel = $('#sc-gif-fx-speed'), fxFreezeInput = $('#sc-gif-fx-freeze');
        const fxDeepFryOn = $('#sc-gif-fx-deepfry-on'), fxDeepFryAmt = $('#sc-gif-fx-deepfry-amt');
        const fxVhsOn = $('#sc-gif-fx-vhs-on'), fxVhsAmt = $('#sc-gif-fx-vhs-amt');
        const fxZsOn = $('#sc-gif-fx-zoomshake-on'), fxZsMode = $('#sc-gif-fx-zoomshake-mode'), fxZsAmt = $('#sc-gif-fx-zoomshake-amt');
        const fxShadowOn = $('#sc-gif-fx-shadow-on'), fxShadowAmt = $('#sc-gif-fx-shadow-amt');
        const fxWiggleOn = $('#sc-gif-fx-wiggle-on'), fxWiggleAmt = $('#sc-gif-fx-wiggle-amt');

        function syncFxState() {
            fx.mode = fxModeSel.value;
            fx.speed = parseFloat(fxSpeedSel.value) || 1;
            fx.freezeHoldMs = Math.max(0, parseInt(fxFreezeInput.value, 10) || 0);
            fx.deepFry.enabled = fxDeepFryOn.checked;
            fx.deepFry.intensity = parseInt(fxDeepFryAmt.value, 10) || 0;
            fx.vhs.enabled = fxVhsOn.checked;
            fx.vhs.intensity = parseInt(fxVhsAmt.value, 10) || 0;
            fx.zoomShake.enabled = fxZsOn.checked;
            fx.zoomShake.mode = fxZsMode.value;
            fx.zoomShake.intensity = parseInt(fxZsAmt.value, 10) || 0;
            fx.shadow.enabled = fxShadowOn.checked;
            fx.shadow.intensity = parseInt(fxShadowAmt.value, 10) || 0;
            fx.wiggle.enabled = fxWiggleOn.checked;
            fx.wiggle.intensity = parseInt(fxWiggleAmt.value, 10) || 0;
        }
        [fxModeSel, fxSpeedSel, fxFreezeInput, fxDeepFryOn, fxDeepFryAmt, fxVhsOn, fxVhsAmt, fxZsOn, fxZsMode, fxZsAmt]
            .forEach(el => el.addEventListener('input', syncFxState));
        [fxShadowOn, fxShadowAmt, fxWiggleOn, fxWiggleAmt]
            .forEach(el => el.addEventListener('input', () => { syncFxState(); renderCaptionPreviews(); }));
        syncFxState();

        const capTopInput = $('#sc-gif-cap-top');
        const capBottomInput = $('#sc-gif-cap-bottom');
        const capSizeInputs = { top: $('#sc-gif-cap-top-size'), bottom: $('#sc-gif-cap-bottom-size') };
        const getCapColor = () => (panel.querySelector('input[name="sc-gif-cap-color"]:checked') || {}).value || 'white';
        const getCapSizePct = (key) => Math.max(1, parseFloat(capSizeInputs[key].value) || 16);
        const clampPct = (n) => Math.min(100, Math.max(0, isFinite(n) ? n : 50));
        const capPos = { top: { x: 50, y: 10 }, bottom: { x: 50, y: 90 } };
```

`renderCaptionPreviews` (called by the new shadow/wiggle listeners) is a `function` declaration defined later in the same closure — function declarations are fully hoisted, so referencing it here before its textual definition is safe (this is a plain forward-reference within one scope, not a `const`/`let` temporal-dead-zone case like `fx` was).

- [ ] **Step 6: Toggle the new preview CSS classes**

Find:
```js
                el.classList.toggle('sc-gif-cap-yellow', color === 'yellow');
                if (!text || !w || !h) { el.textContent = ''; return; }
```

Replace:
```js
                el.classList.toggle('sc-gif-cap-yellow', color === 'yellow');
                el.classList.toggle('sc-gif-cap-rainbow', color === 'rainbow');
                el.classList.toggle('sc-gif-cap-shadow', fx.shadow.enabled);
                el.classList.toggle('sc-gif-cap-wiggle', fx.wiggle.enabled);
                if (!text || !w || !h) { el.textContent = ''; return; }
```

- [ ] **Step 7: Populate `captions.fx` and sync `fx` before building `captions`**

Find:
```js
        goBtn.addEventListener('click', async () => {
            if (isBlob || !src) return;
            const fps    = parseInt($('#sc-gif-fps').value, 10);
            const width  = parseInt($('#sc-gif-width').value, 10);
            const aspect = $('#sc-gif-aspect').value;
            const captions = {
                color: getCapColor(),
                top: { text: capTopInput.value.trim(), size: getCapSizePct('top'), x: capPos.top.x, y: capPos.top.y },
                bottom: { text: capBottomInput.value.trim(), size: getCapSizePct('bottom'), x: capPos.bottom.x, y: capPos.bottom.y },
            };
            if (endT - startT < MIN_CLIP_GAP) { setStatus('End must be after start.'); return; }
```

Replace:
```js
        goBtn.addEventListener('click', async () => {
            if (isBlob || !src) return;
            const fps    = parseInt($('#sc-gif-fps').value, 10);
            const width  = parseInt($('#sc-gif-width').value, 10);
            const aspect = $('#sc-gif-aspect').value;
            syncFxState();
            const captions = {
                color: getCapColor(),
                top: { text: capTopInput.value.trim(), size: getCapSizePct('top'), x: capPos.top.x, y: capPos.top.y },
                bottom: { text: capBottomInput.value.trim(), size: getCapSizePct('bottom'), x: capPos.bottom.x, y: capPos.bottom.y },
                fx: { shadow: fx.shadow, wiggle: fx.wiggle },
            };
            if (endT - startT < MIN_CLIP_GAP) { setStatus('End must be after start.'); return; }
```

- [ ] **Step 8: Remove the now-redundant later `syncFxState()` call**

`syncFxState()` now runs before `captions` is built (Step 7), so the later call — previously needed only for `playback`/`filters` — is redundant. Find:
```js
                const cap = await captureGifFrames(
                    { src, startT, endT, fps, width, aspect, captions },
                    p => setWork('Capturing frames… ' + Math.round(p * 100) + '%'));
                syncFxState();
                const playback = { mode: fx.mode, speed: fx.speed, freezeHoldMs: fx.freezeHoldMs, fps };
                const filters = { deepFry: fx.deepFry, vhs: fx.vhs, zoomShake: fx.zoomShake };
```

Replace:
```js
                const cap = await captureGifFrames(
                    { src, startT, endT, fps, width, aspect, captions },
                    p => setWork('Capturing frames… ' + Math.round(p * 100) + '%'));
                const playback = { mode: fx.mode, speed: fx.speed, freezeHoldMs: fx.freezeHoldMs, fps };
                const filters = { deepFry: fx.deepFry, vhs: fx.vhs, zoomShake: fx.zoomShake };
```

- [ ] **Step 9: Verify syntax**

Run: `node --check cytube.gifmaker.user.js`
Expected: no output, exit code 0.

- [ ] **Step 10: Self-review**

1. Every new element ID referenced in Step 5's JS (`sc-gif-fx-shadow-on`, `sc-gif-fx-shadow-amt`, `sc-gif-fx-wiggle-on`, `sc-gif-fx-wiggle-amt`) exists in Step 3's HTML, and the `rainbow` value referenced in Step 6 exists in Step 2's HTML.
2. `fx.shadow`/`fx.wiggle` default values (`{ enabled: false, intensity: 60 }`) match the HTML controls' defaults (checkbox unchecked, range `value="60"`) — opening the panel and immediately reading `fx` without touching any control matches what `syncFxState()` would compute.
3. With every control at default (White selected, no filters enabled), `captions.fx = { shadow: {enabled:false,...}, wiggle: {enabled:false,...} }` and `captions.color = 'white'` — Task 1's regression rule (Step 4.1) holds: both `fx` branches skip and the rainbow branch is unreachable, so a user who never touches these new controls sees byte-for-byte the same output as before this plan.
4. `goBtn`'s handler now calls `syncFxState()` once, before `captions` is built, instead of after `captureGifFrames` — confirm no other code between the old and new call sites (`clipStartForName`, `tagEl`, `midBody` collapse, `_revokeGifResult`, spinner HTML) reads `fx` before the old call site used to run, so moving the call earlier changes nothing else's behavior.
5. `renderCaptionPreview` (singular, per-thumbnail) now reads `fx.shadow.enabled`/`fx.wiggle.enabled` — confirm `fx` is in scope (declared in Step 5, before `renderCaptionPreview`'s definition later in the same closure) and is not `undefined` at the time `renderCaptionPreviews()` is first called (Step 5 places the `fx` block before that first call).
6. Rainbow's CSS `@keyframes` `color` steps and wiggle's `transform` steps have no `!important` (invalid inside `@keyframes`, silently stripped by browsers) while the class-level `animation`/`filter` declarations that reference them do — consistent with this file's existing `!important`-per-declaration convention everywhere it's syntactically valid.
7. `.sc-gif-cap-shadow` uses the `filter: drop-shadow(...)` CSS property, not `text-shadow` — `.sc-gif-cap`'s existing base rule already uses `text-shadow` (four-directional, to simulate the black outline in the CSS preview), so reusing `text-shadow` for the new "drop shadow" effect would have silently overwritten the outline simulation instead of adding a separate shadow. `filter` and `text-shadow` are independent properties and compose without conflict.

- [ ] **Step 11: Manual browser verification**

Load the userscript in a Tampermonkey dev profile against a live CyTube video (`420Grindhouse` or `testing` room). Open the GIF Maker, enter top and bottom caption text, then:

1. Enable "Caption drop shadow" alone (default 60 intensity), generate a GIF, confirm the rendered captions show a soft dark shadow behind the outline and the black stroke outline is still crisp and unaffected.
2. Select "Rainbow" alone (no shadow/wiggle), generate a GIF, confirm the caption fill color visibly cycles through hues across the GIF's playback instead of staying a fixed color. Switch back to White, confirm the caption is solid white again (no leftover rainbow state).
3. Enable "Caption wiggle" alone, generate a GIF, confirm the caption visibly wobbles frame-to-frame without the wrapped text moving so far it clips outside the frame at the default intensity.
4. Enable all three together (Rainbow + drop shadow + wiggle), confirm no visual conflict — the cycling fill color is still readable through the shadow, and stroke/fill stay aligned with the wiggling position.
5. Test on a very short clip (~1s) and a longer clip (~8-10s) with Rainbow and Wiggle enabled — confirm the hue-cycle speed and wobble rate scale with clip length (i.e. progress-based, not a fixed-duration animation that would look identical regardless of clip length).
6. Compare the live caption preview thumbnails (before rendering) against the actual rendered GIF for each effect — confirm they're recognizably the same effect (exact pixels don't need to match; the CSS preview is an approximation per the design spec).

- [ ] **Step 12: Commit**

```bash
git add cytube.gifmaker.user.js
git commit -m "Add Caption drop shadow, Rainbow, and Caption wiggle controls to GIF Maker Effects panel"
```
