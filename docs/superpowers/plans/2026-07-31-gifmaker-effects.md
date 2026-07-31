# GIF Maker Reaction Effects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add playback effects (boomerang, reverse, speed, freeze-frame hold) and visual filters (deep-fry, VHS/glitch, zoom punch-in/shake) to the GIF Maker in `cytube.gifmaker.user.js`, with a live canvas preview so effects can be tuned before the (slow) gif.js encode.

**Architecture:** Captured frames stay untouched in the existing `sourceFrames` array from `captureGifFrames()`. A new pure function `buildPlaybackSequence(frameCount, playback)` turns playback settings into a flat array of frame indices (repeats represent held/duplicated frames — no separate duration metadata needed, since gif.js keeps a constant per-frame delay). A new `renderSequenceFrame(sourceFrames, sequence, i, w, h, filters)` resolves one sequence position to a filtered `ImageData`, cloning before mutating so a source frame reused at multiple sequence positions (boomerang, freeze-hold) is never double-filtered. Both the live preview canvas and `encodeGif()` call this same function, so preview and final output can never drift apart.

**Tech Stack:** Tampermonkey userscript (vanilla JS, no build step), gif.js (already `@require`'d), Canvas 2D API for pixel/geometric filter math.

## Global Constraints

- No automated test framework in this repo — verification is `node --check cytube.gifmaker.user.js` (syntax only) plus a code-reading self-review, matching every other GIF Maker task on this codebase (see `docs/superpowers/plans/2026-07-25-gif-optimization.md`).
- **Scope: `cytube.gifmaker.user.js` only.** This codebase's established pattern for multi-part GIF Maker features (filmstrip trimmer, overview scrubber, selection drag) is to build and land the feature in the standalone script first, then port it to `cytube.pc.user.js` as a separate follow-up plan (see `docs/superpowers/plans/2026-07-25-gifmaker-pc-port.md`). Do not touch `cytube.pc.user.js` in this plan.
- Exact function signatures — later tasks depend on these exactly:
  - `buildPlaybackSequence(frameCount, playback) → number[]` — `playback = { mode: 'normal'|'reverse'|'boomerang', speed: number, freezeHoldMs: number, fps: number }`. Always returns at least 1 index.
  - `applyDeepFry(imageData, intensity) → ImageData` — mutates and returns `imageData` in place.
  - `applyVhs(imageData, intensity, seqPosition) → ImageData` — mutates and returns `imageData` in place.
  - `applyZoomShake(imageData, w, h, mode, intensity, seqPosition, seqLength) → ImageData` — `mode = 'zoom'|'shake'`. Returns a **new** `ImageData`, does not mutate the input.
  - `applyFilters(imageData, w, h, filters, seqPosition, seqLength) → ImageData` — `filters = { deepFry: {enabled, intensity}, vhs: {enabled, intensity}, zoomShake: {enabled, mode, intensity} }`. Composes in fixed order: zoomShake → deepFry → vhs.
  - `renderSequenceFrame(sourceFrames, sequence, i, w, h, filters) → ImageData`.
- **Non-destructive rule:** `renderSequenceFrame` must clone the source frame (`cloneImageData`) before passing it into `applyFilters` whenever any filter is enabled, and must return the source frame directly (no clone) when no filter is enabled. This is not an optimization — it is required for correctness: boomerang and freeze-hold cause the same `sourceFrames[i]` entry to be read at multiple sequence positions, and `applyDeepFry`/`applyVhs` mutate their input in place, so skipping the clone would double-apply filters on repeated frames.
- **Determinism rule:** any filter randomness (VHS jitter, shake offset, deep-fry noise) must use the deterministic `_seededNoise(seed)` helper, never `Math.random()`, so the live preview always matches the final rendered GIF exactly for the same inputs.
- Composition order is fixed regardless of UI interaction order: playback mode → speed → freeze-hold (inside `buildPlaybackSequence`); zoomShake → deepFry → vhs (inside `applyFilters`).
- Effect settings (`fx` state) live only in the `openGifPanel()` closure, matching trim/caption state — not persisted to `localStorage`, unlike the `sc_gif_optimize` toggle. They reset to defaults every time the panel is opened.
- `encodeGif()`'s public behavior must stay unchanged when called without `playback`/`filters` (both optional) — `buildPlaybackSequence(frames.length, {})` must produce the same 1:1 frame order as the current `frames.forEach`, and `renderSequenceFrame` with no filters enabled must return frames unmodified. This lets Task 2 land safely before any UI exists to set non-default effects.

---

### Task 1: Playback sequence and filter math

**Files:**
- Modify: `cytube.gifmaker.user.js` (insert after `captureGifFrames()`, before `const GIF_WORKER_URL`, i.e. around line 521)

**Interfaces:**
- Produces: `buildPlaybackSequence(frameCount, playback)`, `_seededNoise(seed)`, `cloneImageData(imageData)`, `applyDeepFry(imageData, intensity)`, `applyVhs(imageData, intensity, seqPosition)`, `applyZoomShake(imageData, w, h, mode, intensity, seqPosition, seqLength)`, `applyFilters(imageData, w, h, filters, seqPosition, seqLength)`.
- Consumes: nothing (pure functions). Not called from anywhere yet — this task only adds code, it does not wire it in.

- [ ] **Step 1: Insert the new functions**

Find:
```js
            vid.src = src;
        });
    }

    const GIF_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js';
```

Replace:
```js
            vid.src = src;
        });
    }

    /* ==========================================================
       REACTION EFFECTS — playback sequencing + visual filters.
       sourceFrames captured above is never mutated: buildPlaybackSequence
       only computes which frame index plays at each output position, and
       renderSequenceFrame (added later) clones before filtering so a
       frame reused by boomerang/freeze-hold is never double-filtered.
    ========================================================== */
    function buildPlaybackSequence(frameCount, playback) {
        const mode = (playback && playback.mode) || 'normal';
        const speed = (playback && playback.speed) || 1;
        const freezeHoldMs = (playback && playback.freezeHoldMs) || 0;
        const fps = (playback && playback.fps) || 12;

        let seq;
        if (mode === 'reverse') {
            seq = [];
            for (let i = frameCount - 1; i >= 0; i--) seq.push(i);
        } else if (mode === 'boomerang') {
            const forward = [];
            for (let i = 0; i < frameCount; i++) forward.push(i);
            const middle = forward.slice(1, -1).reverse();
            seq = forward.concat(middle);
        } else {
            seq = [];
            for (let i = 0; i < frameCount; i++) seq.push(i);
        }

        if (speed > 1) {
            const sped = [];
            for (let i = 0; i * speed < seq.length; i++) sped.push(seq[Math.floor(i * speed)]);
            seq = sped.length ? sped : [seq[seq.length - 1]];
        } else if (speed < 1 && speed > 0) {
            const repeatCount = Math.max(1, Math.round(1 / speed));
            const slowed = [];
            seq.forEach(idx => { for (let r = 0; r < repeatCount; r++) slowed.push(idx); });
            seq = slowed;
        }

        if (freezeHoldMs > 0 && seq.length) {
            const holdFrames = Math.round((freezeHoldMs / 1000) * fps);
            const lastIdx = seq[seq.length - 1];
            for (let r = 0; r < holdFrames; r++) seq.push(lastIdx);
        }

        return seq.length ? seq : [0];
    }

    // Deterministic pseudo-random 0..1, never Math.random() — the live
    // preview and the final render must produce identical noise/jitter
    // for the same frame, or the two would visibly diverge.
    function _seededNoise(seed) {
        const x = Math.sin(seed) * 10000;
        return x - Math.floor(x);
    }

    function cloneImageData(imageData) {
        return new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
    }

    function applyDeepFry(imageData, intensity) {
        const amt = Math.max(0, Math.min(100, intensity || 0)) / 100;
        if (amt <= 0) return imageData;
        const d = imageData.data;
        const contrast = 1 + amt * 1.5;
        const satBoost = 1 + amt * 1.2;
        const noiseAmt = amt * 40;
        for (let i = 0; i < d.length; i += 4) {
            let r = d[i], g = d[i + 1], b = d[i + 2];
            r = (r - 128) * contrast + 128;
            g = (g - 128) * contrast + 128;
            b = (b - 128) * contrast + 128;
            const gray = 0.299 * r + 0.587 * g + 0.114 * b;
            r = gray + (r - gray) * satBoost;
            g = gray + (g - gray) * satBoost;
            b = gray + (b - gray) * satBoost;
            const n = (_seededNoise(i * 0.9973 + 1) - 0.5) * noiseAmt;
            d[i]     = Math.max(0, Math.min(255, r + n));
            d[i + 1] = Math.max(0, Math.min(255, g + n));
            d[i + 2] = Math.max(0, Math.min(255, b + n));
        }
        return imageData;
    }

    function applyVhs(imageData, intensity, seqPosition) {
        const amt = Math.max(0, Math.min(100, intensity || 0)) / 100;
        if (amt <= 0) return imageData;
        const d = imageData.data, w = imageData.width, h = imageData.height;
        const shift = Math.round(amt * 4);
        const scanlineDark = amt * 0.35;
        const srcCopy = new Uint8ClampedArray(d);
        for (let y = 0; y < h; y++) {
            const rowJitter = shift > 0
                ? Math.round((_seededNoise(y * 12.9898 + seqPosition * 78.233) - 0.5) * amt * 6) : 0;
            for (let x = 0; x < w; x++) {
                const di = (y * w + x) * 4;
                const rx = Math.max(0, Math.min(w - 1, x - shift + rowJitter));
                const bx = Math.max(0, Math.min(w - 1, x + shift + rowJitter));
                const ri = (y * w + rx) * 4, bi = (y * w + bx) * 4;
                d[di]     = srcCopy[ri];
                d[di + 1] = srcCopy[di + 1];
                d[di + 2] = srcCopy[bi + 2];
                if (y % 2 === 0) {
                    d[di]     *= (1 - scanlineDark);
                    d[di + 1] *= (1 - scanlineDark);
                    d[di + 2] *= (1 - scanlineDark);
                }
            }
        }
        return imageData;
    }

    let _fxScratchCanvas = null;
    function getFxScratchCanvas(w, h) {
        if (!_fxScratchCanvas) _fxScratchCanvas = document.createElement('canvas');
        _fxScratchCanvas.width = w; _fxScratchCanvas.height = h;
        return _fxScratchCanvas;
    }
    function applyZoomShake(imageData, w, h, mode, intensity, seqPosition, seqLength) {
        const amt = Math.max(0, Math.min(100, intensity || 0)) / 100;
        if (amt <= 0) return imageData;
        const srcCanvas = getFxScratchCanvas(w, h);
        const sctx = srcCanvas.getContext('2d');
        sctx.putImageData(imageData, 0, 0);
        const out = document.createElement('canvas');
        out.width = w; out.height = h;
        const octx = out.getContext('2d');
        if (mode === 'shake') {
            const dx = (_seededNoise(seqPosition * 17.23 + 3) - 0.5) * amt * 0.08 * w;
            const dy = (_seededNoise(seqPosition * 41.11 + 7) - 0.5) * amt * 0.08 * h;
            octx.drawImage(srcCanvas, dx, dy);
        } else {
            const progress = seqLength > 1 ? seqPosition / (seqLength - 1) : 0;
            const scale = 1 + progress * amt * 0.35;
            const sw = w / scale, sh = h / scale;
            const sx = (w - sw) / 2, sy = (h - sh) / 2;
            octx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, w, h);
        }
        return octx.getImageData(0, 0, w, h);
    }

    function applyFilters(imageData, w, h, filters, seqPosition, seqLength) {
        let out = imageData;
        if (filters && filters.zoomShake && filters.zoomShake.enabled) {
            out = applyZoomShake(out, w, h, filters.zoomShake.mode, filters.zoomShake.intensity, seqPosition, seqLength);
        }
        if (filters && filters.deepFry && filters.deepFry.enabled) {
            out = applyDeepFry(out, filters.deepFry.intensity);
        }
        if (filters && filters.vhs && filters.vhs.enabled) {
            out = applyVhs(out, filters.vhs.intensity, seqPosition);
        }
        return out;
    }

    const GIF_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js';
```

- [ ] **Step 2: Verify syntax**

Run: `node --check cytube.gifmaker.user.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Self-review**

Trace through by hand and confirm:
1. `buildPlaybackSequence(5, { mode: 'normal', speed: 1, freezeHoldMs: 0, fps: 12 })` → `[0,1,2,3,4]`.
2. `buildPlaybackSequence(5, { mode: 'reverse', ... })` → `[4,3,2,1,0]`.
3. `buildPlaybackSequence(4, { mode: 'boomerang', speed: 1, freezeHoldMs: 0, fps: 12 })` → forward `[0,1,2,3]`, middle = `[0,1,2,3].slice(1,-1).reverse()` = `[2,1]` → `[0,1,2,3,2,1]`.
4. `buildPlaybackSequence(1, { mode: 'boomerang', ... })` → forward `[0]`, `slice(1,-1)` on a 1-element array is `[]` → `[0]`. No crash on a 1-frame clip.
5. `buildPlaybackSequence(4, { mode: 'normal', speed: 2, freezeHoldMs: 0, fps: 12 })` → `i=0: seq[0]`, `i=1: seq[2]` (since `1*2=2<4`), `i=2: 2*2=4` not `<4`, stop → `[0,2]`.
6. `buildPlaybackSequence(2, { mode: 'normal', speed: 0.5, freezeHoldMs: 0, fps: 12 })` → `repeatCount = round(1/0.5) = 2` → `[0,0,1,1]`.
7. `buildPlaybackSequence(3, { mode: 'normal', speed: 1, freezeHoldMs: 500, fps: 10 })` → `holdFrames = round(0.5*10) = 5` → `[0,1,2,2,2,2,2,2]`.
8. `applyDeepFry`/`applyVhs` mutate `imageData.data` in place and return the same object — confirm callers that need the original unmodified must pass a clone (this is what Task 2's `renderSequenceFrame` will do).
9. `applyZoomShake` returns a brand-new `ImageData` from `getImageData` — the passed-in `imageData` is read via `putImageData` but not itself mutated.
10. `applyFilters` composes in the fixed order zoomShake → deepFry → vhs, matching the design spec.
11. No filter function ever calls `Math.random()` — only `_seededNoise`.

- [ ] **Step 4: Commit**

```bash
git add cytube.gifmaker.user.js
git commit -m "Add playback-sequence and filter math for GIF Maker reaction effects"
```

---

### Task 2: Wire effects into the encode pipeline

**Files:**
- Modify: `cytube.gifmaker.user.js` (`renderSequenceFrame` insertion before `encodeGif`, ~line 577; `encodeGif` body, lines 577-588)

**Interfaces:**
- Consumes: `buildPlaybackSequence`, `applyFilters`, `cloneImageData` (Task 1).
- Produces: `renderSequenceFrame(sourceFrames, sequence, i, w, h, filters)`. Changes `encodeGif`'s parameter object to accept optional `playback`/`filters` keys.

- [ ] **Step 1: Insert `renderSequenceFrame` and update `encodeGif`**

Find:
```js
    function encodeGif({ frames, w, h, delay }, onProgress) {
        return getGifWorkerUrl().then(workerScript => new Promise((resolve, reject) => {
            const Ctor = getGifCtor();
            if (!Ctor) { reject(new Error('gif.js not loaded (@require missing?)')); return; }
            const gif = new Ctor({ workers: 2, quality: 10, width: w, height: h, workerScript, repeat: 0 });
            frames.forEach(f => gif.addFrame(f, { delay }));
            gif.on('progress', p => onProgress && onProgress(p));
            gif.on('finished', blob => resolve(blob));
            gif.on('abort', () => reject(new Error('encode aborted')));
            gif.render();
        }));
    }
```

Replace:
```js
    // Resolves one output position to a filtered frame. Clones the source
    // before filtering (only when a filter is actually enabled) because
    // boomerang/freeze-hold reuse the same sourceFrames[i] entry at
    // multiple sequence positions, and applyDeepFry/applyVhs mutate their
    // input in place — without the clone, a repeated frame would be
    // filtered again every time it recurs.
    function renderSequenceFrame(sourceFrames, sequence, i, w, h, filters) {
        const frameIndex = sequence[i];
        const source = sourceFrames[frameIndex];
        const hasAnyFilter = !!(filters && (
            (filters.zoomShake && filters.zoomShake.enabled) ||
            (filters.deepFry && filters.deepFry.enabled) ||
            (filters.vhs && filters.vhs.enabled)));
        if (!hasAnyFilter) return source;
        return applyFilters(cloneImageData(source), w, h, filters, i, sequence.length);
    }

    function encodeGif({ frames, w, h, delay, playback, filters }, onProgress) {
        return getGifWorkerUrl().then(workerScript => new Promise((resolve, reject) => {
            const Ctor = getGifCtor();
            if (!Ctor) { reject(new Error('gif.js not loaded (@require missing?)')); return; }
            const gif = new Ctor({ workers: 2, quality: 10, width: w, height: h, workerScript, repeat: 0 });
            const sequence = buildPlaybackSequence(frames.length, playback || {});
            for (let i = 0; i < sequence.length; i++) {
                gif.addFrame(renderSequenceFrame(frames, sequence, i, w, h, filters || {}), { delay });
            }
            gif.on('progress', p => onProgress && onProgress(p));
            gif.on('finished', blob => resolve(blob));
            gif.on('abort', () => reject(new Error('encode aborted')));
            gif.render();
        }));
    }
```

- [ ] **Step 2: Verify syntax**

Run: `node --check cytube.gifmaker.user.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Self-review**

1. `encodeGif` is still called from `goBtn`'s click handler (unchanged in this task) with only `{frames, w, h, delay}` — `playback`/`filters` are `undefined`, so `playback || {}` → `buildPlaybackSequence(frames.length, {})` → mode defaults to `'normal'`, speed `1`, freezeHoldMs `0` → sequence is `[0, 1, ..., frames.length-1]`, identical order to the old `frames.forEach`.
2. `filters || {}` → `renderSequenceFrame`'s `hasAnyFilter` is `false` for every frame → returns `source` unchanged, no clone, no filtering. Output is byte-for-byte the same GIF as before this task.
3. This confirms the task is safe to land with zero UI changes — existing "Make GIF" behavior is provably unchanged.

- [ ] **Step 4: Commit**

```bash
git add cytube.gifmaker.user.js
git commit -m "Wire playback sequence and filters into encodeGif (no behavior change yet)"
```

---

### Task 3: Effects panel UI

**Files:**
- Modify: `cytube.gifmaker.user.js` (CSS block ~line 296-298, HTML template ~line 862-863, panel wiring ~line 1043)

**Interfaces:**
- Produces: `.sc-gif-fx*` CSS classes, the Effects UI markup, an in-closure `fx` state object (`{ mode, speed, freezeHoldMs, deepFry: {enabled, intensity}, vhs: {enabled, intensity}, zoomShake: {enabled, mode, intensity} }`), and `syncFxState()` which reads all Effects controls into `fx`.
- Consumes: nothing new yet — controls exist and update `fx`, but `fx` is not read by `goBtn` until Task 4.

- [ ] **Step 1: Add CSS**

Find:
```js
            .sc-gif-optimize-row { display: flex !important; align-items: center !important; gap: 6px !important; }
            .sc-gif-optimize-row label { color: rgba(255,255,255,0.8) !important; font-size: 12px !important; }
            .sc-test-ok      { color: #7dffa0 !important; }
```

Replace:
```js
            .sc-gif-optimize-row { display: flex !important; align-items: center !important; gap: 6px !important; }
            .sc-gif-optimize-row label { color: rgba(255,255,255,0.8) !important; font-size: 12px !important; }
            .sc-gif-fx { display: flex !important; flex-direction: column !important; gap: 8px !important; }
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
```

- [ ] **Step 2: Add the Effects + Preview HTML**

Find:
```js
                    <label>Shape
                        <select id="sc-gif-aspect">
                            <option value="native">Native</option>
                            <option value="crop" selected>4:3 Crop</option>
                            <option value="fit">4:3 Bars</option>
                        </select>
                    </label>
                </div>
                <div class="sc-gif-imgbb-row" id="sc-gif-imgbb-row">
```

Replace:
```js
                    <label>Shape
                        <select id="sc-gif-aspect">
                            <option value="native">Native</option>
                            <option value="crop" selected>4:3 Crop</option>
                            <option value="fit">4:3 Bars</option>
                        </select>
                    </label>
                </div>
                <div class="sc-gif-fx">
                    <div class="sc-gif-fx-row">
                        <label>Playback
                            <select id="sc-gif-fx-mode">
                                <option value="normal" selected>Normal</option>
                                <option value="reverse">Reverse</option>
                                <option value="boomerang">Boomerang</option>
                            </select>
                        </label>
                        <label>Speed
                            <select id="sc-gif-fx-speed">
                                <option value="0.5">0.5x</option>
                                <option value="1" selected>1x</option>
                                <option value="1.5">1.5x</option>
                                <option value="2">2x</option>
                            </select>
                        </label>
                    </div>
                    <div class="sc-gif-fx-row">
                        <label>Freeze hold (ms)
                            <input type="number" id="sc-gif-fx-freeze" min="0" max="3000" step="100" value="0">
                        </label>
                    </div>
                    <div class="sc-gif-fx-filters">
                        <div class="sc-gif-fx-filter">
                            <input type="checkbox" id="sc-gif-fx-deepfry-on">
                            <label for="sc-gif-fx-deepfry-on">Deep-fry</label>
                            <input type="range" id="sc-gif-fx-deepfry-amt" min="0" max="100" value="60">
                        </div>
                        <div class="sc-gif-fx-filter">
                            <input type="checkbox" id="sc-gif-fx-vhs-on">
                            <label for="sc-gif-fx-vhs-on">VHS / glitch</label>
                            <input type="range" id="sc-gif-fx-vhs-amt" min="0" max="100" value="60">
                        </div>
                        <div class="sc-gif-fx-filter">
                            <input type="checkbox" id="sc-gif-fx-zoomshake-on">
                            <label for="sc-gif-fx-zoomshake-on">Zoom / Shake</label>
                            <select id="sc-gif-fx-zoomshake-mode">
                                <option value="zoom" selected>Zoom-in</option>
                                <option value="shake">Shake</option>
                            </select>
                            <input type="range" id="sc-gif-fx-zoomshake-amt" min="0" max="100" value="60">
                        </div>
                    </div>
                    <div class="sc-gif-preview">
                        <canvas id="sc-gif-fx-canvas"></canvas>
                        <div class="sc-gif-preview-controls">
                            <button type="button" id="sc-gif-fx-play">▶</button>
                            <input type="range" id="sc-gif-fx-scrub" min="0" max="0" value="0" step="1" disabled>
                        </div>
                        <div class="sc-gif-preview-status" id="sc-gif-fx-status">Click Preview to load frames</div>
                        <button type="button" id="sc-gif-fx-preview-btn">Preview effects</button>
                    </div>
                </div>
                <div class="sc-gif-imgbb-row" id="sc-gif-imgbb-row">
```

- [ ] **Step 3: Add `fx` state + control wiring**

Find:
```js
        renderCaptionPreviews();

        const thumbTimers = {};
```

Replace:
```js
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

- [ ] **Step 4: Verify syntax**

Run: `node --check cytube.gifmaker.user.js`
Expected: no output, exit code 0.

- [ ] **Step 5: Self-review**

1. Every new element ID referenced in Step 3's JS (`sc-gif-fx-mode`, `sc-gif-fx-speed`, `sc-gif-fx-freeze`, `sc-gif-fx-deepfry-on`, `sc-gif-fx-deepfry-amt`, `sc-gif-fx-vhs-on`, `sc-gif-fx-vhs-amt`, `sc-gif-fx-zoomshake-on`, `sc-gif-fx-zoomshake-mode`, `sc-gif-fx-zoomshake-amt`) exists in Step 2's HTML.
2. `fx` object's default values match the HTML controls' default values (mode `normal`/`selected`, speed `1`/`selected`, freeze `0`, all filter checkboxes unchecked, intensities `60`) — opening the panel and immediately reading `fx` without touching any control gives the same result as `syncFxState()` would.
3. This task does not yet change what `goBtn` sends to `encodeGif` — opening the panel and clicking controls has no visible effect on the rendered GIF until Task 4. That is expected for this task.
4. `.sc-gif-fx-row input[type=number]` styling was added since `sc-gif-fx-freeze` is a number input, distinct from the existing `.sc-gif-cap-sizes input[type=number]` rule (kept separate, not reused, since it's a different section).

- [ ] **Step 6: Commit**

```bash
git add cytube.gifmaker.user.js
git commit -m "Add GIF Maker Effects panel UI (playback mode/speed/freeze-hold, filter toggles)"
```

---

### Task 4: Apply effects to the rendered GIF

**Files:**
- Modify: `cytube.gifmaker.user.js` (`goBtn` click handler, ~line 1348-1373)

**Interfaces:**
- Consumes: `fx` state and `syncFxState()` (Task 3), `encodeGif`'s `playback`/`filters` params (Task 2).

- [ ] **Step 1: Pass `fx` state into `encodeGif`**

Find:
```js
                setWork('Encoding GIF… (' + cap.frames.length + ' frames)');
                let blob = await encodeGif(cap, p => setWork('Encoding GIF… ' + Math.round(p * 100) + '%'));
                if (gifOptimizeEnabled()) setWork('Optimizing…');
```

Replace:
```js
                syncFxState();
                const playback = { mode: fx.mode, speed: fx.speed, freezeHoldMs: fx.freezeHoldMs, fps };
                const filters = { deepFry: fx.deepFry, vhs: fx.vhs, zoomShake: fx.zoomShake };
                setWork('Encoding GIF… (' + cap.frames.length + ' frames)');
                let blob = await encodeGif({ ...cap, playback, filters }, p => setWork('Encoding GIF… ' + Math.round(p * 100) + '%'));
                if (gifOptimizeEnabled()) setWork('Optimizing…');
```

- [ ] **Step 2: Verify syntax**

Run: `node --check cytube.gifmaker.user.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Self-review**

1. `fps` is already in scope in this handler (declared a few lines above as `const fps = parseInt($('#sc-gif-fps').value, 10);`) — the new `playback` object reuses it, not a re-declaration.
2. `cap` (the result of `captureGifFrames`) already has `{frames, w, h, delay}` — spreading it with `...cap` plus the new `playback`/`filters` keys matches `encodeGif`'s `{ frames, w, h, delay, playback, filters }` signature from Task 2 exactly.
3. With every Effects control at its default (Normal, 1x, 0ms hold, no filters enabled), `playback`/`filters` produce the exact same no-op behavior verified in Task 2 — so a user who never opens the Effects section sees zero change in output.

- [ ] **Step 4: Manual browser verification**

Load the userscript in a Tampermonkey dev profile against a live CyTube video (`420Grindhouse` or `testing` room). Open the GIF Maker, set Boomerang mode, generate a GIF, and confirm the output plays forward then backward before looping. Repeat for Reverse, 2x speed, 0.5x speed, and a 500ms freeze-hold, each individually. Then enable Deep-fry alone and confirm the output looks visibly fried; repeat for VHS and for Zoom/Shake (both sub-modes). Finally combine Boomerang + Deep-fry + Shake in one GIF and confirm all three effects are visibly present together.

Also test the degenerate case: drag the trim handles down to the shortest possible clip (near `MIN_CLIP_GAP`, i.e. close to a single captured frame), enable Boomerang + freeze-hold + 2x speed together, and click Make GIF. Confirm it does not crash or hang, and produces a valid (non-empty) GIF.

- [ ] **Step 5: Commit**

```bash
git add cytube.gifmaker.user.js
git commit -m "Apply Effects panel settings to rendered GIFs"
```

---

### Task 5: Live preview

**Files:**
- Modify: `cytube.gifmaker.user.js` (panel wiring, after Task 3's `fx` block; `close()`, ~line 896-901; `goBtn` handler, from Task 4)

**Interfaces:**
- Consumes: `captureGifFrames`, `buildPlaybackSequence`, `renderSequenceFrame` (Tasks 1-2), `fx`/`syncFxState` (Task 3), `startT`/`endT`/`src`/`isBlob`/`capTopInput`/`capBottomInput`/`getCapColor`/`getCapSizePct`/`capPos` (all pre-existing, in the same closure).
- Produces: `ensurePreviewFrames()`, `currentCaptureFingerprint()`, `refreshPreviewFrame()` — reusable by `goBtn` to skip a redundant capture when the previewed clip still matches current settings.

- [ ] **Step 1: Add the preview cache, canvas rendering, and playback controls**

Find:
```js
        [fxModeSel, fxSpeedSel, fxFreezeInput, fxDeepFryOn, fxDeepFryAmt, fxVhsOn, fxVhsAmt, fxZsOn, fxZsMode, fxZsAmt]
            .forEach(el => el.addEventListener('input', syncFxState));
        syncFxState();

        const thumbTimers = {};
```

Replace:
```js
        let _previewFrames = null; // { frames, w, h, delay, fingerprint }
        let _previewSeq = null;
        let _previewPlaying = false;
        let _previewTimer = null;

        const fxCanvas = $('#sc-gif-fx-canvas');
        const fxCtx = fxCanvas.getContext('2d');
        const fxScrub = $('#sc-gif-fx-scrub');
        const fxPlayBtn = $('#sc-gif-fx-play');
        const fxStatus = $('#sc-gif-fx-status');
        const fxPreviewBtn = $('#sc-gif-fx-preview-btn');

        function currentCaptureFingerprint() {
            return [startT.toFixed(2), endT.toFixed(2), $('#sc-gif-fps').value, $('#sc-gif-width').value,
                $('#sc-gif-aspect').value, capTopInput.value, capBottomInput.value,
                getCapColor(), getCapSizePct('top'), getCapSizePct('bottom'),
                capPos.top.x, capPos.top.y, capPos.bottom.x, capPos.bottom.y].join('|');
        }

        function stopPreviewPlayback() {
            _previewPlaying = false;
            clearTimeout(_previewTimer);
            fxPlayBtn.textContent = '▶';
        }

        function rebuildPreviewSequence() {
            if (!_previewFrames) return;
            _previewSeq = buildPlaybackSequence(_previewFrames.frames.length,
                { mode: fx.mode, speed: fx.speed, freezeHoldMs: fx.freezeHoldMs, fps: parseInt($('#sc-gif-fps').value, 10) });
            fxScrub.max = String(_previewSeq.length - 1);
            if (parseInt(fxScrub.value, 10) > _previewSeq.length - 1) fxScrub.value = '0';
        }

        function drawPreviewFrame(i) {
            if (!_previewFrames || !_previewSeq || !_previewSeq.length) return;
            const idx = Math.max(0, Math.min(_previewSeq.length - 1, i));
            const filters = { deepFry: fx.deepFry, vhs: fx.vhs, zoomShake: fx.zoomShake };
            const imgData = renderSequenceFrame(_previewFrames.frames, _previewSeq, idx, _previewFrames.w, _previewFrames.h, filters);
            fxCanvas.width = _previewFrames.w;
            fxCanvas.height = _previewFrames.h;
            fxCtx.putImageData(imgData, 0, 0);
        }

        function refreshPreviewFrame() {
            if (!_previewFrames) return;
            rebuildPreviewSequence();
            drawPreviewFrame(parseInt(fxScrub.value, 10) || 0);
        }

        fxScrub.addEventListener('input', () => { stopPreviewPlayback(); drawPreviewFrame(parseInt(fxScrub.value, 10) || 0); });

        function stepPreviewPlayback() {
            if (!_previewPlaying || !_previewSeq) return;
            let next = parseInt(fxScrub.value, 10) + 1;
            if (next > _previewSeq.length - 1) next = 0;
            fxScrub.value = String(next);
            drawPreviewFrame(next);
            const fps = parseInt($('#sc-gif-fps').value, 10) || 12;
            _previewTimer = setTimeout(stepPreviewPlayback, Math.round(1000 / fps));
        }
        fxPlayBtn.addEventListener('click', () => {
            if (!_previewSeq) return;
            if (_previewPlaying) { stopPreviewPlayback(); return; }
            _previewPlaying = true;
            fxPlayBtn.textContent = '⏸';
            stepPreviewPlayback();
        });

        async function ensurePreviewFrames() {
            if (isBlob || !src) return null;
            const fp = currentCaptureFingerprint();
            if (_previewFrames && _previewFrames.fingerprint === fp) return _previewFrames;
            stopPreviewPlayback();
            fxStatus.textContent = 'Capturing preview frames…';
            fxPreviewBtn.disabled = true;
            const fps = parseInt($('#sc-gif-fps').value, 10);
            const width = parseInt($('#sc-gif-width').value, 10);
            const aspect = $('#sc-gif-aspect').value;
            const captions = {
                color: getCapColor(),
                top: { text: capTopInput.value.trim(), size: getCapSizePct('top'), x: capPos.top.x, y: capPos.top.y },
                bottom: { text: capBottomInput.value.trim(), size: getCapSizePct('bottom'), x: capPos.bottom.x, y: capPos.bottom.y },
            };
            try {
                const cap = await captureGifFrames({ src, startT, endT, fps, width, aspect, captions },
                    p => { fxStatus.textContent = 'Capturing preview frames… ' + Math.round(p * 100) + '%'; });
                cap.fingerprint = fp;
                _previewFrames = cap;
                fxScrub.disabled = false;
                fxStatus.textContent = _previewFrames.frames.length + ' frames loaded';
                rebuildPreviewSequence();
                fxScrub.value = '0';
                drawPreviewFrame(0);
                return _previewFrames;
            } catch (e) {
                fxStatus.textContent = 'Preview failed: ' + (e.message || e);
                return null;
            } finally {
                fxPreviewBtn.disabled = false;
            }
        }
        fxPreviewBtn.addEventListener('click', () => { ensurePreviewFrames(); });

        [fxModeSel, fxSpeedSel, fxFreezeInput, fxDeepFryOn, fxDeepFryAmt, fxVhsOn, fxVhsAmt, fxZsOn, fxZsMode, fxZsAmt]
            .forEach(el => el.addEventListener('input', () => { syncFxState(); refreshPreviewFrame(); }));
        syncFxState();

        const thumbTimers = {};
```

- [ ] **Step 2: Stop preview playback on panel close**

Find:
```js
        const close = () => {
            clearTimeout(_filmstripTimer);
            Object.values(thumbTimers).forEach(clearTimeout);
            stopSelectionAutoScroll();
            _revokeGifResult(); destroyScrubClone(); panel.remove();
        };
```

Replace:
```js
        const close = () => {
            clearTimeout(_filmstripTimer);
            Object.values(thumbTimers).forEach(clearTimeout);
            stopSelectionAutoScroll();
            stopPreviewPlayback();
            _revokeGifResult(); destroyScrubClone(); panel.remove();
        };
```

- [ ] **Step 3: Reuse previewed frames in `goBtn` when the fingerprint still matches**

Find:
```js
            try {
                setStatus('');
                const cap = await captureGifFrames(
                    { src, startT, endT, fps, width, aspect, captions },
                    p => setWork('Capturing frames… ' + Math.round(p * 100) + '%'));
                syncFxState();
```

Replace:
```js
            try {
                setStatus('');
                const fp = currentCaptureFingerprint();
                let cap = (_previewFrames && _previewFrames.fingerprint === fp) ? _previewFrames : null;
                if (!cap) {
                    cap = await captureGifFrames(
                        { src, startT, endT, fps, width, aspect, captions },
                        p => setWork('Capturing frames… ' + Math.round(p * 100) + '%'));
                } else {
                    setWork('Using previewed frames… (' + cap.frames.length + ' frames)');
                }
                syncFxState();
```

Note: this Find block assumes Task 4's edit already landed (`syncFxState();` immediately follows the capture). If applying this step against a file where Task 4 has not yet run, apply Task 4 first — this task depends on it.

- [ ] **Step 4: Verify syntax**

Run: `node --check cytube.gifmaker.user.js`
Expected: no output, exit code 0.

- [ ] **Step 5: Self-review**

1. `ensurePreviewFrames()` and the `goBtn` handler compute `currentCaptureFingerprint()` the same way — same field list, same order, same `.join('|')` — so a preview taken right before clicking "Make GIF" is correctly detected as reusable and `captureGifFrames` is not called twice.
2. Changing any fingerprinted input (trim handles, FPS, width, aspect, caption text/size/position/color) after a preview was taken means the next `ensurePreviewFrames()` or `goBtn` click re-captures fresh frames — stale previews are never silently reused across a param change.
3. `fxScrub`'s `input` listener calls `stopPreviewPlayback()` before drawing — scrubbing manually always stops any in-progress play loop, so they can't fight over the scrub position.
4. `stepPreviewPlayback` reads `fps` fresh from `$('#sc-gif-fps').value` on every step (not captured once at play-start) — if the user changes FPS mid-playback, the next step immediately uses the new interval.
5. `_previewFrames` is not explicitly cleared on `close()` — acceptable, since the entire `openGifPanel()` closure (including `_previewFrames`) is discarded when the panel is removed and a fresh closure is created next time `openGifPanel()` runs.
6. Confirm no other code path references `ensurePreviewFrames`/`currentCaptureFingerprint`/`_previewFrames` before this task's insertion point (avoids temporal-dead-zone `const`/`let` errors from hoisting).

- [ ] **Step 6: Manual browser verification**

In a Tampermonkey dev profile against a live CyTube video: open the GIF Maker, click "Preview effects," confirm the canvas shows a frame and the scrub bar becomes enabled with a range matching the frame count. Drag the scrub bar and confirm it updates the canvas. Click ▶ and confirm it plays through the sequence and loops. Toggle Boomerang mode while paused and confirm the scrub bar's max updates to the longer boomerang sequence length and the preview reflects it. Enable Deep-fry and confirm the preview canvas updates live as the intensity slider is dragged. Change the trim handles, click "Make GIF" without clicking Preview again, and confirm it captures fresh frames (status shows "Capturing frames…", not "Using previewed frames…"). Then click Preview, immediately click "Make GIF," and confirm the status shows "Using previewed frames…" and the result renders without a second capture delay.

- [ ] **Step 7: Commit**

```bash
git add cytube.gifmaker.user.js
git commit -m "Add live preview canvas for GIF Maker reaction effects"
```
