# Remove GIF Maker Live Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the GIF Maker's live preview canvas/scrub/play subsystem entirely, and move the Effects controls (playback mode/speed/freeze-hold, filter checkboxes+sliders) back inside the right column so they sit directly under the "Effects" disclosure toggle, instead of rendering as a full-width section below both columns.

**Architecture:** Deletion-heavy change to `cytube.gifmaker.user.js`: remove the `.sc-gif-preview` HTML block, its CSS, and the entire JS preview subsystem (frame caching, canvas rendering, scrub/play, staleness tracking), then move `#sc-gif-fx-body` from being a sibling after `.sc-gif-cols` to being nested inside `.sc-gif-col-right`, right after the Effects toggle button. `goBtn`'s Make-GIF flow reverts to always capturing fresh frames (as it did before the live preview was added), since there's no cached preview to reuse anymore. `buildPlaybackSequence`/`renderSequenceFrame`/`applyFilters`/etc. (the pure playback/filter math) are untouched — `encodeGif` still uses them directly.

**Tech Stack:** Tampermonkey userscript (vanilla JS, no build step).

## Global Constraints

- No automated test framework in this repo — verification is `node --check cytube.gifmaker.user.js` (syntax only) plus a code-reading self-review.
- Do not touch `buildPlaybackSequence`, `applyDeepFry`, `applyVhs`, `applyZoomShake`, `applyFilters`, `cloneImageData`, `_seededNoise`, `renderSequenceFrame`, or `encodeGif` — these are consumed directly by the Make-GIF flow, independent of the (now-removed) preview UI.
- The `fx` state object and `syncFxState()` (reads the Effects controls into `fx`) are unchanged — they're still needed to pass `playback`/`filters` into `encodeGif`.
- After this change, `goBtn`'s click handler always calls `captureGifFrames` fresh — no fingerprint-based cache/reuse logic remains anywhere in the file.
- `#sc-gif-fx-body` keeps its `sc-gif-fx` class (governs its collapse/expand via `.sc-gif-fx-open`) but loses the `sc-gif-card` class it currently has — it no longer needs its own card styling once nested inside `.sc-gif-col-right`'s existing card.
- No behavior change to anything outside the preview subsystem: trim, captions, format options, ImgBB, optimize toggle, and the playback-mode/speed/freeze-hold/filter controls themselves (their values, defaults, and effect on the rendered GIF) are all unchanged.

---

### Task 1: Remove live preview, move Effects into the right column

**Files:**
- Modify: `cytube.gifmaker.user.js` (CSS block, HTML template, and `openGifPanel()`'s JS)

**Interfaces:**
- Removes: `fxCanvas`, `fxCtx`, `fxScrub`, `fxPlayBtn`, `fxStatus`, `fxPreviewBtn`, `_previewFrames`, `_previewSeq`, `_previewPlaying`, `_previewTimer`, `currentCaptureFingerprint()`, `markPreviewStale()`, `stopPreviewPlayback()`, `rebuildPreviewSequence()`, `drawPreviewFrame()`, `refreshPreviewFrame()`, `stepPreviewPlayback()`, `ensurePreviewFrames()`, and the `.sc-gif-preview`/`.sc-gif-preview-controls`/`.sc-gif-preview-status`/`#sc-gif-fx-preview-btn` CSS rules and HTML.
- Consumes: nothing new. `fx`, `syncFxState()`, `buildPlaybackSequence`, `renderSequenceFrame`, `captureGifFrames`, `encodeGif` are all pre-existing and unchanged.

- [ ] **Step 1: Remove the preview CSS rules**

Find this exact block:
```js
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
```
Replace with: (delete the whole block — replace with nothing, i.e. remove these lines entirely)

- [ ] **Step 2: Move `#sc-gif-fx-body` into `.sc-gif-col-right`, and remove the preview HTML block from inside it**

Find this exact block:
```js
                    <div class="sc-gif-col-right">
                        <div class="sc-gif-opts">
                            <label>FPS
                                <select id="sc-gif-fps">
                                    <option value="8">8</option><option value="10">10</option>
                                    <option value="12" selected>12</option><option value="15">15</option>
                                </select>
                            </label>
                            <label>Width
                                <select id="sc-gif-width">
                                    <option value="320">320</option><option value="480" selected>480</option><option value="640">640</option>
                                </select>
                            </label>
                            <label>Shape
                                <select id="sc-gif-aspect">
                                    <option value="native">Native</option>
                                    <option value="crop" selected>4:3 Crop</option>
                                    <option value="fit">4:3 Bars</option>
                                </select>
                            </label>
                        </div>
                        <button type="button" class="sc-gif-fx-header" id="sc-gif-fx-header" aria-expanded="false">
                            <span>Effects</span>
                            <span class="sc-gif-fx-toggle" id="sc-gif-fx-toggle">▸</span>
                        </button>
                    </div>
                </div>
                <div class="sc-gif-fx sc-gif-card" id="sc-gif-fx-body">
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
```
Replace with:
```js
                    <div class="sc-gif-col-right">
                        <div class="sc-gif-opts">
                            <label>FPS
                                <select id="sc-gif-fps">
                                    <option value="8">8</option><option value="10">10</option>
                                    <option value="12" selected>12</option><option value="15">15</option>
                                </select>
                            </label>
                            <label>Width
                                <select id="sc-gif-width">
                                    <option value="320">320</option><option value="480" selected>480</option><option value="640">640</option>
                                </select>
                            </label>
                            <label>Shape
                                <select id="sc-gif-aspect">
                                    <option value="native">Native</option>
                                    <option value="crop" selected>4:3 Crop</option>
                                    <option value="fit">4:3 Bars</option>
                                </select>
                            </label>
                        </div>
                        <button type="button" class="sc-gif-fx-header" id="sc-gif-fx-header" aria-expanded="false">
                            <span>Effects</span>
                            <span class="sc-gif-fx-toggle" id="sc-gif-fx-toggle">▸</span>
                        </button>
                        <div class="sc-gif-fx" id="sc-gif-fx-body">
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
                        </div>
                    </div>
                </div>
```

(Note: this moves `#sc-gif-fx-body`'s closing `</div>` to just before `.sc-gif-col-right`'s own closing `</div>`, which is itself followed by `.sc-gif-cols`'s closing `</div>` — one fewer top-level `</div>` remains where the old full-width `#sc-gif-fx-body` used to close, since it's now nested one level deeper. Also note `sc-gif-card` was dropped from `#sc-gif-fx-body`'s class list — only `sc-gif-fx` remains, since `.sc-gif-col-right` already provides the card look.)

- [ ] **Step 3: Remove the live-preview JS subsystem**

Find this exact block:
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

        // Cosmetic only — does not affect capture/cache/render logic, which
        // already re-derives correctness from the fingerprint on every
        // capture/encode. This just keeps the visible status text honest
        // when the underlying settings have drifted since the last preview.
        function markPreviewStale() {
            if (_previewFrames && currentCaptureFingerprint() !== _previewFrames.fingerprint) {
                fxStatus.textContent = 'Preview out of date — click Preview effects';
            }
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
```
Replace with:
```js
        [fxModeSel, fxSpeedSel, fxFreezeInput, fxDeepFryOn, fxDeepFryAmt, fxVhsOn, fxVhsAmt, fxZsOn, fxZsMode, fxZsAmt]
            .forEach(el => el.addEventListener('input', syncFxState));
        syncFxState();
```

- [ ] **Step 4: Remove the `stopPreviewPlayback()` call from `close()`**

Find this exact block:
```js
        const close = () => {
            clearTimeout(_filmstripTimer);
            Object.values(thumbTimers).forEach(clearTimeout);
            stopSelectionAutoScroll();
            stopPreviewPlayback();
            _revokeGifResult(); destroyScrubClone(); panel.remove();
        };
```
Replace with:
```js
        const close = () => {
            clearTimeout(_filmstripTimer);
            Object.values(thumbTimers).forEach(clearTimeout);
            stopSelectionAutoScroll();
            _revokeGifResult(); destroyScrubClone(); panel.remove();
        };
```

- [ ] **Step 5: Remove the `markPreviewStale()` calls wired into the trim/format/caption change listeners**

Find this exact line:
```js
        aspectSel.addEventListener('change', () => { applyThumbAspect(); renderCaptionPreviews(); markPreviewStale(); });
```
Replace with:
```js
        aspectSel.addEventListener('change', () => { applyThumbAspect(); renderCaptionPreviews(); });
```

Find this exact block:
```js
        $('#sc-gif-fps').addEventListener('change', markPreviewStale);
        $('#sc-gif-width').addEventListener('change', markPreviewStale);
```
Replace with: (delete these two lines entirely — no replacement)

Find this exact block:
```js
        capTopInput.addEventListener('input', () => { renderCaptionPreviews(); markPreviewStale(); });
        capBottomInput.addEventListener('input', () => { renderCaptionPreviews(); markPreviewStale(); });
        capSizeInputs.top.addEventListener('input', () => { renderCaptionPreviews(); markPreviewStale(); });
        capSizeInputs.bottom.addEventListener('input', () => { renderCaptionPreviews(); markPreviewStale(); });
        panel.querySelectorAll('input[name="sc-gif-cap-color"]').forEach(r => r.addEventListener('change', () => { renderCaptionPreviews(); markPreviewStale(); }));
```
Replace with:
```js
        capTopInput.addEventListener('input', renderCaptionPreviews);
        capBottomInput.addEventListener('input', renderCaptionPreviews);
        capSizeInputs.top.addEventListener('input', renderCaptionPreviews);
        capSizeInputs.bottom.addEventListener('input', renderCaptionPreviews);
        panel.querySelectorAll('input[name="sc-gif-cap-color"]').forEach(r => r.addEventListener('change', renderCaptionPreviews));
```

Find this exact line (inside the trim `render(changed)` function):
```js
            markPreviewStale();
```
Replace with: (delete this line entirely — no replacement; the line immediately above it in `render()` is `scheduleFilmstripRefresh();`, which stays as the function's last statement)

- [ ] **Step 6: Revert `goBtn` to always capture fresh frames**

Find this exact block:
```js
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
Replace with:
```js
                setStatus('');
                const cap = await captureGifFrames(
                    { src, startT, endT, fps, width, aspect, captions },
                    p => setWork('Capturing frames… ' + Math.round(p * 100) + '%'));
                syncFxState();
```

- [ ] **Step 7: Verify syntax**

Run: `node --check cytube.gifmaker.user.js`
Expected: no output, exit code 0.

- [ ] **Step 8: Self-review**

Trace through and confirm:
1. Grep the whole file for `_previewFrames`, `_previewSeq`, `_previewPlaying`, `_previewTimer`, `fxCanvas`, `fxCtx`, `fxScrub`, `fxPlayBtn`, `fxStatus`, `fxPreviewBtn`, `currentCaptureFingerprint`, `markPreviewStale`, `stopPreviewPlayback`, `rebuildPreviewSequence`, `drawPreviewFrame`, `refreshPreviewFrame`, `stepPreviewPlayback`, `ensurePreviewFrames`, `sc-gif-preview`, `sc-gif-fx-canvas`, `sc-gif-fx-scrub`, `sc-gif-fx-play`, `sc-gif-fx-status`, `sc-gif-fx-preview-btn` — every one of these should have zero remaining occurrences.
2. `#sc-gif-fx-body` (the Effects disclosure body) is now nested inside `.sc-gif-col-right`, as a sibling after the `#sc-gif-fx-header` button and before `.sc-gif-col-right`'s own closing `</div>` — not a sibling of `.sc-gif-cols`.
3. `#sc-gif-fx-body` carries only `class="sc-gif-fx"` (no `sc-gif-card`).
4. Every `<div>` opened remains matched by exactly one `</div>` — count carefully around the Step 2 edit, since it both removes content (the preview block) and re-nests content (moving `#sc-gif-fx-body` one level deeper).
5. `buildPlaybackSequence`, `renderSequenceFrame`, `applyFilters`, `encodeGif`, `fx`, `syncFxState` are all still present and unchanged — only the preview UI layer was removed, not the underlying effects math or the effects controls' own state syncing.
6. `goBtn`'s click handler always calls `captureGifFrames` — no conditional cache-reuse branch remains.
7. `close()` no longer references `stopPreviewPlayback`.

- [ ] **Step 9: Manual browser verification**

Load the userscript in a Tampermonkey dev profile against a live CyTube video (`420Grindhouse` or `testing` room). Open the GIF Maker, expand "Effects" — confirm the mode/speed/freeze-hold controls and the three filter rows appear directly under the toggle, inside the right-column card, with no canvas/scrub bar/play button/"Preview effects" button anywhere. Confirm the panel is visibly shorter than before (no more full-width Effects section). Set a few effects (e.g. Boomerang + Deep-fry), click Make GIF, and confirm the rendered output still reflects those settings — the actual effects (not just the preview) must still work.

- [ ] **Step 10: Commit**

```bash
git add cytube.gifmaker.user.js
git commit -m "Remove GIF Maker live preview; move Effects controls into the right-column card"
```
