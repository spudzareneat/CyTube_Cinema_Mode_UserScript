# Port GIF Maker Improvements Into pc.user.js Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the filmstrip trimmer, consolidated caption handles, whole-movie overview scrubber with arrow-key nudging, and draggable selection band with edge auto-scroll — all already built and reviewed in `cytube.gifmaker.user.js` on this branch — into `cytube.pc.user.js`'s `openGifPanel`, replacing its original single-scrubber trim UI.

**Architecture:** All changes live inside `cytube.pc.user.js`'s existing `openGifPanel()` function and its `#sc-gif-*` CSS block (around line 4783 in the file as it stands at the start of this plan). Every function being added is copied verbatim from `cytube.gifmaker.user.js`'s current committed state on this same branch — this is a port, not new design. Tasks are ordered to match how these features were originally built (filmstrip, then overview scrubber, then selection drag), so each task leaves the file in a valid, working state before the next one starts.

**Tech Stack:** Vanilla JS, Pointer Events, CSS `!important` (matching `cytube.pc.user.js`'s existing convention throughout).

## Global Constraints

- No automated test framework in this repo — verification is `node --check cytube.pc.user.js` (syntax only) plus manual browser testing, unavailable to implementer/reviewer subagents. Every task's test step is `node --check` plus a code-reading self-review, matching every task on the `feature/gifmaker-standalone` branch this plan continues from.
- Only `cytube.pc.user.js` is touched. Do not modify `cytube.gifmaker.user.js` — it is only a read-only reference for this port.
- **Do NOT port:** the ImgBB collapsible section or "Download-only when no key" behavior (`cytube.pc.user.js` keeps its existing settings-modal-based key management and always-show-Upload-with-hint result view, unchanged); the video-corner button relocation into `#videocontrols` (inapplicable — `cytube.pc.user.js` hides that entire native control row as part of its fullscreen layout; its own floating `#sc-gif-btn` stays as-is); `_gifTitleSlug()`/`parseMovieFilename`/`lastMovieTitle` (kept exactly as they are — `cytube.pc.user.js`'s own TMDB-aware title logic, not the standalone script's raw-title version).
- Exact constants, copied verbatim from `cytube.gifmaker.user.js`: `MIN_CLIP_GAP = 0.1`, `MAX_CLIP_LEN = 10`, `FILMSTRIP_MARGIN = 3`, `FILMSTRIP_MIN_WINDOW = 12`, `FILMSTRIP_EDGE_PAD = 1`, `FILMSTRIP_TILES = 10`, `OVERVIEW_NUDGE_SEC = 1`, `OVERVIEW_NUDGE_SEC_FAST = 10`, `SELECTION_EDGE_ZONE_PX = 20`, `SELECTION_AUTOSCROLL_STEP = 0.2`, `SELECTION_AUTOSCROLL_INTERVAL_MS = 100`.
- The overview scrubber's `keydown` handler's `e.stopPropagation()` call is load-bearing: `cytube.pc.user.js` has its own document-level `ArrowLeft`/`ArrowRight` video-seek handler elsewhere in this same file, and without stopping propagation, nudging the clip would also seek the live video — the exact bug the standalone script's own fix addressed, just intra-file here instead of cross-file.
- `close()` must stop both the filmstrip's debounce timer and the selection band's auto-scroll interval — ported directly from the standalone script's own fix for this exact leak class.

---

### Task 1: Filmstrip trimmer + consolidated caption handles

**Files:**
- Modify: `cytube.pc.user.js` (the `openGifPanel()` HTML template, its `#sc-gif-*` CSS block around line 4783, and the trim/caption logic inside `openGifPanel()`)

**Interfaces:**
- Consumes: `getPlayerVideoEl`, `grabPreviewFrame`, `_fmtClockTenths` (all pre-existing, unchanged).
- Produces: the `.sc-gif-overview*`, `.sc-gif-filmstrip*`, `.sc-gif-thumb-readonly` CSS classes and their corresponding HTML elements; `MIN_CLIP_GAP`, `MAX_CLIP_LEN`, `FILMSTRIP_MARGIN`, `FILMSTRIP_MIN_WINDOW`, `FILMSTRIP_EDGE_PAD`, `FILMSTRIP_TILES` (module-level constants); `ensureFilmstripWindow()`, `renderFilmstripHandles()` (filmstrip-only version — extended in Task 2), `refetchFilmstripTiles()`, `scheduleFilmstripRefresh()`, `wireFilmstripDrag(handleEl, which)`; an updated `render`/`clampStart`/`clampEnd`/`close`. Removes `resetEndFromStart`, `scrubStart` and its wiring, and the END thumbnail's own caption handles.

CSS/HTML and JS logic are bundled into one task rather than split across two — a markup-only intermediate commit would leave the JS referencing elements (`#sc-gif-scrub-start`, the END caption handles) that no longer exist, which `node --check` can't catch (it only validates syntax) and which would throw at runtime if the panel were opened in that state. Steps are still ordered CSS → HTML → JS so each individual edit is easy to review in isolation, but the task as a whole is the smallest unit that's actually safe to open the panel against.

- [ ] **Step 1: Add `.sc-gif-thumb-readonly` CSS**

Find this exact block:

```js
            /* Preview reframing to match the chosen output shape */
            .sc-gif-thumb-43 { aspect-ratio: 4 / 3 !important; }
            .sc-gif-thumb-fit { background-size: contain !important; }
```

Replace with:

```js
            /* Preview reframing to match the chosen output shape */
            .sc-gif-thumb-43 { aspect-ratio: 4 / 3 !important; }
            .sc-gif-thumb-fit { background-size: contain !important; }
            .sc-gif-thumb-readonly { border-style: dashed !important; opacity: 0.92 !important; }
```

- [ ] **Step 2: Replace the scrubber CSS with filmstrip + overview CSS**

Find this exact block:

```js
            .sc-gif-cap-hint { text-align: center !important; color: rgba(255,255,255,0.4) !important; font-size: 11px !important; }
            /* Coarse scrubber under each thumbnail */
            .sc-gif-scrub {
                width: 100% !important; margin: 0 !important; accent-color: #ffcc44 !important;
                cursor: pointer !important;
            }
            .sc-gif-scrub:disabled { opacity: 0.4 !important; cursor: default !important; }
            /* END has no scrubber — this keeps its label/buttons row aligned
               with START's, which still has one above its label. */
            .sc-gif-scrub-spacer { height: 20px !important; }
```

Replace with:

```js
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
```

- [ ] **Step 3: Replace the marks/scrub/caption-handle HTML template with the overview + filmstrip + consolidated-caption-handle markup**

Find this exact block (from the start of `#sc-gif-body` through the caption hint):

```js
            <div id="sc-gif-body">
                <div class="sc-gif-marks">
                    <div class="sc-gif-mark">
                        <div class="sc-gif-thumb" id="sc-gif-thumb-start">
                            <div class="sc-gif-cap sc-gif-cap-top" id="sc-gif-cap-top-start"></div>
                            <div class="sc-gif-cap sc-gif-cap-bottom" id="sc-gif-cap-bottom-start"></div>
                            <div class="sc-gif-cap-handle sc-gif-cap-handle-top" id="sc-gif-cap-handle-top-start" title="Drag top caption"></div>
                            <div class="sc-gif-cap-handle sc-gif-cap-handle-bottom" id="sc-gif-cap-handle-bottom-start" title="Drag bottom caption"></div>
                        </div>
                        <input type="range" class="sc-gif-scrub" id="sc-gif-scrub-start" min="0" max="0" step="0.1" value="0">
                        <div class="sc-gif-mark-label">START · <span id="sc-gif-time-start"></span></div>
                        <div class="sc-gif-mark-btns">
                            <button type="button" data-act="start-current" title="Set start to current playback position">⤓ Now</button>
                            <button type="button" data-act="start-minus">−.5</button>
                            <button type="button" data-act="start-plus">+.5</button>
                        </div>
                    </div>
                    <div class="sc-gif-mark">
                        <div class="sc-gif-thumb" id="sc-gif-thumb-end">
                            <div class="sc-gif-cap sc-gif-cap-top" id="sc-gif-cap-top-end"></div>
                            <div class="sc-gif-cap sc-gif-cap-bottom" id="sc-gif-cap-bottom-end"></div>
                            <div class="sc-gif-cap-handle sc-gif-cap-handle-top" id="sc-gif-cap-handle-top-end" title="Drag top caption"></div>
                            <div class="sc-gif-cap-handle sc-gif-cap-handle-bottom" id="sc-gif-cap-handle-bottom-end" title="Drag bottom caption"></div>
                        </div>
                        <div class="sc-gif-scrub-spacer"></div>
                        <div class="sc-gif-mark-label">END · <span id="sc-gif-time-end"></span></div>
                        <div class="sc-gif-mark-btns">
                            <button type="button" data-act="end-minus">−.5</button>
                            <button type="button" data-act="end-plus">+.5</button>
                        </div>
                    </div>
                </div>
                <div id="sc-gif-dur-line">Duration <b id="sc-gif-dur-val"></b></div>
                <div class="sc-gif-captions">
                    <input type="text" id="sc-gif-cap-top" class="sc-gif-cap-input" placeholder="TOP TEXT (optional)" maxlength="120">
                    <input type="text" id="sc-gif-cap-bottom" class="sc-gif-cap-input" placeholder="BOTTOM TEXT (optional)" maxlength="120">
                    <div class="sc-gif-cap-color">
                        <label><input type="radio" name="sc-gif-cap-color" value="white" checked> White</label>
                        <label><input type="radio" name="sc-gif-cap-color" value="yellow"> Yellow</label>
                    </div>
                    <div class="sc-gif-cap-sizes">
                        <label>Top size <input type="number" id="sc-gif-cap-top-size" min="4" max="40" step="1" value="16">%</label>
                        <label>Bottom size <input type="number" id="sc-gif-cap-bottom-size" min="4" max="40" step="1" value="16">%</label>
                    </div>
                    <div class="sc-gif-cap-hint">Drag the dots on the previews to position each caption.</div>
                </div>
```

Replace with:

```js
            <div id="sc-gif-body">
                <div class="sc-gif-overview">
                    <div class="sc-gif-overview-track" id="sc-gif-overview-track" tabindex="0">
                        <div class="sc-gif-overview-viewport" id="sc-gif-overview-viewport"></div>
                        <div class="sc-gif-overview-ghost" id="sc-gif-overview-ghost"></div>
                    </div>
                    <div class="sc-gif-overview-labels">
                        <span>0:00</span>
                        <span class="sc-gif-overview-current" id="sc-gif-overview-current"></span>
                        <span id="sc-gif-overview-total"></span>
                    </div>
                </div>
                <div class="sc-gif-filmstrip">
                    <div class="sc-gif-filmstrip-window-label">Window: <span id="sc-gif-filmstrip-range"></span></div>
                    <div class="sc-gif-filmstrip-strip" id="sc-gif-filmstrip-strip">
                        <div class="sc-gif-filmstrip-tiles" id="sc-gif-filmstrip-tiles"></div>
                        <div class="sc-gif-filmstrip-dim-left" id="sc-gif-filmstrip-dim-left"></div>
                        <div class="sc-gif-filmstrip-dim-right" id="sc-gif-filmstrip-dim-right"></div>
                        <div class="sc-gif-filmstrip-selection" id="sc-gif-filmstrip-selection"></div>
                        <div class="sc-gif-filmstrip-handle" id="sc-gif-filmstrip-handle-start" data-handle="start" title="Drag: start"><div class="sc-gif-filmstrip-handle-grip"></div></div>
                        <div class="sc-gif-filmstrip-handle" id="sc-gif-filmstrip-handle-end" data-handle="end" title="Drag: end"><div class="sc-gif-filmstrip-handle-grip"></div></div>
                    </div>
                </div>
                <div class="sc-gif-marks">
                    <div class="sc-gif-mark">
                        <div class="sc-gif-thumb" id="sc-gif-thumb-start">
                            <div class="sc-gif-cap sc-gif-cap-top" id="sc-gif-cap-top-start"></div>
                            <div class="sc-gif-cap sc-gif-cap-bottom" id="sc-gif-cap-bottom-start"></div>
                            <div class="sc-gif-cap-handle sc-gif-cap-handle-top" id="sc-gif-cap-handle-top-start" title="Drag top caption"></div>
                            <div class="sc-gif-cap-handle sc-gif-cap-handle-bottom" id="sc-gif-cap-handle-bottom-start" title="Drag bottom caption"></div>
                        </div>
                        <div class="sc-gif-mark-label">START · <span id="sc-gif-time-start"></span></div>
                        <div class="sc-gif-mark-btns">
                            <button type="button" data-act="start-current" title="Set start to current playback position">⤓ Now</button>
                            <button type="button" data-act="start-minus">−.5</button>
                            <button type="button" data-act="start-plus">+.5</button>
                        </div>
                    </div>
                    <div class="sc-gif-mark">
                        <div class="sc-gif-thumb sc-gif-thumb-readonly" id="sc-gif-thumb-end">
                            <div class="sc-gif-cap sc-gif-cap-top" id="sc-gif-cap-top-end"></div>
                            <div class="sc-gif-cap sc-gif-cap-bottom" id="sc-gif-cap-bottom-end"></div>
                        </div>
                        <div class="sc-gif-mark-label">END · <span id="sc-gif-time-end"></span></div>
                        <div class="sc-gif-mark-btns">
                            <button type="button" data-act="end-minus">−.5</button>
                            <button type="button" data-act="end-plus">+.5</button>
                        </div>
                    </div>
                </div>
                <div id="sc-gif-dur-line">Duration <b id="sc-gif-dur-val"></b></div>
                <div class="sc-gif-captions">
                    <input type="text" id="sc-gif-cap-top" class="sc-gif-cap-input" placeholder="TOP TEXT (optional)" maxlength="120">
                    <input type="text" id="sc-gif-cap-bottom" class="sc-gif-cap-input" placeholder="BOTTOM TEXT (optional)" maxlength="120">
                    <div class="sc-gif-cap-color">
                        <label><input type="radio" name="sc-gif-cap-color" value="white" checked> White</label>
                        <label><input type="radio" name="sc-gif-cap-color" value="yellow"> Yellow</label>
                    </div>
                    <div class="sc-gif-cap-sizes">
                        <label>Top size <input type="number" id="sc-gif-cap-top-size" min="4" max="40" step="1" value="16">%</label>
                        <label>Bottom size <input type="number" id="sc-gif-cap-bottom-size" min="4" max="40" step="1" value="16">%</label>
                    </div>
                    <div class="sc-gif-cap-hint">Drag the dots on the START preview to position each caption.</div>
                </div>
```

Note: everything from `<div class="sc-gif-opts">` onward (FPS/Width/Shape selects, Make GIF button, status, result divs) is **not** part of this old/new block and stays completely untouched — this step only touches the trim marks and caption sections above it.

- [ ] **Step 4: Add the filmstrip constants**

Find this exact block:

```js
    function _fmtClockTenths(sec) {
        sec = Math.max(0, sec);
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
    }

    function openGifPanel(initialSec) {
```

Replace with:

```js
    function _fmtClockTenths(sec) {
        sec = Math.max(0, sec);
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
    }

    const MIN_CLIP_GAP = 0.1;
    const MAX_CLIP_LEN = 10;
    const FILMSTRIP_MARGIN = 3;
    const FILMSTRIP_MIN_WINDOW = 12;
    const FILMSTRIP_EDGE_PAD = 1;
    const FILMSTRIP_TILES = 10;

    function openGifPanel(initialSec) {
```

- [ ] **Step 5: Add the sticky filmstrip-window state variable**

Find this exact block:

```js
        const DEFAULT_CLIP_LEN = 2;
        let startT = Math.max(0, now - DEFAULT_CLIP_LEN);
        let endT = Math.min(vidDur, startT + DEFAULT_CLIP_LEN);
```

Replace with:

```js
        const DEFAULT_CLIP_LEN = 2;
        let startT = Math.max(0, now - DEFAULT_CLIP_LEN);
        let endT = Math.min(vidDur, startT + DEFAULT_CLIP_LEN);
        let _filmstripWindow = null; // { windowStart, windowEnd } — sticky across renders
```

- [ ] **Step 6: Only wire caption-drag handles for START**

Find this exact block:

```js
        ['start', 'end'].forEach(which => {
            ['top', 'bottom'].forEach(key => {
                wireCapHandle($('#sc-gif-cap-handle-' + key + '-' + which), $('#sc-gif-thumb-' + which), key);
            });
        });
```

Replace with:

```js
        ['top', 'bottom'].forEach(key => {
            wireCapHandle($('#sc-gif-cap-handle-' + key + '-start'), $('#sc-gif-thumb-start'), key);
        });
```

- [ ] **Step 7: Update `close()` to clean up the filmstrip's debounce timer**

Find this exact block:

```js
        const close = () => { _revokeGifResult(); destroyScrubClone(); panel.remove(); };
        $('#sc-gif-close').addEventListener('click', close);
```

Replace with:

```js
        const close = () => {
            clearTimeout(_filmstripTimer);
            Object.values(thumbTimers).forEach(clearTimeout);
            _revokeGifResult(); destroyScrubClone(); panel.remove();
        };
        $('#sc-gif-close').addEventListener('click', close);
```

Note: `close` is a `const` arrow function invoked only later, from the ✕ button's click listener — by the time it can actually run, `_filmstripTimer` and `thumbTimers` (both declared later in this same `openGifPanel` body, in Step 5 below) have already been initialized during `openGifPanel`'s single synchronous execution. This exact pattern (referencing a later-declared `const`/`let` from an earlier-defined closure that only runs after setup completes) is already used throughout this file — e.g. `render` already references `refreshThumb`, declared after it. Do not reorder anything to "fix" this.

- [ ] **Step 8: Replace the scrubber setup + `render()` with the filmstrip functions and an updated `render()`**

Find this exact block:

```js
        const scrubStart = $('#sc-gif-scrub-start');
        scrubStart.max = isFinite(vidDur) ? vidDur : 0;
        scrubStart.disabled = isBlob || !src || !isFinite(vidDur);

        const render = (changed) => {
            $('#sc-gif-time-start').textContent = _fmtClockTenths(startT);
            $('#sc-gif-time-end').textContent = _fmtClockTenths(endT);
            scrubStart.value = startT.toFixed(1);
            const dur = Math.max(0, endT - startT);
            $('#sc-gif-dur-val').textContent = dur.toFixed(1) + 's';
            goBtn.disabled = isBlob || !src || dur < 0.1;
            if (changed === 'start' || changed === 'both') refreshThumb('start');
            if (changed === 'end' || changed === 'both') refreshThumb('end');
        };
```

Replace with:

```js
        const filmstripStrip = $('#sc-gif-filmstrip-strip');
        const filmstripHandleStart = $('#sc-gif-filmstrip-handle-start');
        const filmstripHandleEnd = $('#sc-gif-filmstrip-handle-end');
        let _filmstripTimer = null;
        let _tilesWindowKey = null; // the window the on-screen tiles currently show

        for (let i = 0; i < FILMSTRIP_TILES; i++) {
            const tile = document.createElement('div');
            tile.className = 'sc-gif-filmstrip-tile';
            $('#sc-gif-filmstrip-tiles').appendChild(tile);
        }

        // Return value is advisory only — tile refetching is decided by
        // refetchFilmstripTiles() via _tilesWindowKey, not by this return value.
        function ensureFilmstripWindow() {
            const needsReframe = !_filmstripWindow ||
                startT < _filmstripWindow.windowStart + FILMSTRIP_EDGE_PAD ||
                endT   > _filmstripWindow.windowEnd   - FILMSTRIP_EDGE_PAD;
            if (!needsReframe) return false;

            const span = Math.max(FILMSTRIP_MIN_WINDOW, (endT - startT) + FILMSTRIP_MARGIN * 2);
            let windowStart = Math.max(0, startT - FILMSTRIP_MARGIN);
            if (isFinite(vidDur)) windowStart = Math.min(windowStart, Math.max(0, vidDur - span));
            const windowEnd = isFinite(vidDur) ? Math.min(vidDur, windowStart + span) : windowStart + span;

            const changed = !_filmstripWindow ||
                _filmstripWindow.windowStart !== windowStart ||
                _filmstripWindow.windowEnd   !== windowEnd;
            _filmstripWindow = { windowStart, windowEnd };
            return changed;
        }

        function renderFilmstripHandles() {
            const win = _filmstripWindow;
            if (!win) return;
            const pctFor = t => Math.max(0, Math.min(100,
                ((t - win.windowStart) / (win.windowEnd - win.windowStart)) * 100));
            const sp = pctFor(startT), ep = pctFor(endT);
            filmstripHandleStart.style.left = sp + '%';
            filmstripHandleEnd.style.left = ep + '%';
            $('#sc-gif-filmstrip-dim-left').style.width = sp + '%';
            $('#sc-gif-filmstrip-dim-right').style.width = (100 - ep) + '%';
            const selection = $('#sc-gif-filmstrip-selection');
            selection.style.left = sp + '%';
            selection.style.width = (ep - sp) + '%';
            $('#sc-gif-filmstrip-range').textContent =
                _fmtClockTenths(win.windowStart) + ' – ' + _fmtClockTenths(win.windowEnd);
        }

        function refetchFilmstripTiles() {
            const win = _filmstripWindow;
            if (!win || isBlob || !src) return;
            const key = win.windowStart + '|' + win.windowEnd;
            if (key === _tilesWindowKey) return; // tiles already match this window
            _tilesWindowKey = key;
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
        }

        function scheduleFilmstripRefresh() {
            renderFilmstripHandles(); // cheap; keep the handles live even mid-debounce
            clearTimeout(_filmstripTimer);
            _filmstripTimer = setTimeout(() => {
                ensureFilmstripWindow();
                renderFilmstripHandles();
                refetchFilmstripTiles();
            }, 220);
        }

        function wireFilmstripDrag(handleEl, which) {
            let dragging = false;
            handleEl.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                dragging = true;
                handleEl.setPointerCapture(e.pointerId);
            });
            handleEl.addEventListener('pointermove', (e) => {
                if (!dragging || !_filmstripWindow) return;
                const win = _filmstripWindow;
                const rect = filmstripStrip.getBoundingClientRect();
                const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                const t = win.windowStart + pct * (win.windowEnd - win.windowStart);
                if (which === 'start') { startT = t; clampStart(); render('start'); }
                else { endT = t; clampEnd(); render('end'); }
            });
            const endDrag = (e) => {
                dragging = false;
                try { handleEl.releasePointerCapture(e.pointerId); } catch (err) {}
            };
            handleEl.addEventListener('pointerup', endDrag);
            handleEl.addEventListener('pointercancel', endDrag);
        }
        wireFilmstripDrag(filmstripHandleStart, 'start');
        wireFilmstripDrag(filmstripHandleEnd, 'end');

        const render = (changed) => {
            $('#sc-gif-time-start').textContent = _fmtClockTenths(startT);
            $('#sc-gif-time-end').textContent = _fmtClockTenths(endT);
            const dur = Math.max(0, endT - startT);
            $('#sc-gif-dur-val').textContent = dur.toFixed(1) + 's';
            goBtn.disabled = isBlob || !src || dur < MIN_CLIP_GAP;
            if (changed === 'start' || changed === 'both') refreshThumb('start');
            if (changed === 'end' || changed === 'both') refreshThumb('end');
            scheduleFilmstripRefresh();
        };
```

Note: `wireFilmstripDrag`, `render`, `clampStart`, and `clampEnd` reference each other and `renderFilmstripHandles`/`ensureFilmstripWindow`/`refetchFilmstripTiles` out of top-to-bottom declaration order relative to some call sites — this is safe for the same closure-timing reason as Step 7's note. Apply steps in the given order; do not reorder.

- [ ] **Step 9: Update `clampStart`/`clampEnd`, remove `resetEndFromStart`**

Find this exact block:

```js
        const clampStart = () => {
            startT = Math.max(0, startT);
            if (isFinite(vidDur)) startT = Math.min(startT, vidDur - 0.1);
        };
        const clampEnd = () => { endT = Math.min(Math.max(endT, startT + 0.1), vidDur); };
        // The end mark has no scrubber of its own — moving the start always
        // re-anchors it to a fresh 2s window, then end's own ±.5 fine-tunes
        // from there independently.
        const resetEndFromStart = () => {
            endT = isFinite(vidDur) ? Math.min(vidDur, startT + DEFAULT_CLIP_LEN) : startT + DEFAULT_CLIP_LEN;
            if (endT - startT < 0.1) endT = startT + 0.1;
        };
```

Replace with:

```js
        const clampStart = () => {
            startT = Math.max(0, startT);
            if (isFinite(vidDur)) startT = Math.min(startT, vidDur - MIN_CLIP_GAP);
            if (endT - startT < MIN_CLIP_GAP) startT = Math.max(0, endT - MIN_CLIP_GAP);
            if (endT - startT > MAX_CLIP_LEN) startT = endT - MAX_CLIP_LEN;
        };
        const clampEnd = () => {
            endT = Math.max(endT, startT + MIN_CLIP_GAP);
            if (isFinite(vidDur)) endT = Math.min(endT, vidDur);
            if (endT - startT > MAX_CLIP_LEN) endT = startT + MAX_CLIP_LEN;
        };
```

- [ ] **Step 10: Remove `resetEndFromStart()` calls from the marks button handler, and use `render('start')` instead of `render('both')` for start-only changes**

Find this exact block:

```js
            switch (btn.dataset.act) {
                case 'start-current': startT = cur; clampStart(); resetEndFromStart(); render('both'); break;
                case 'start-minus':   startT -= 0.5; clampStart(); resetEndFromStart(); render('both'); break;
                case 'start-plus':    startT += 0.5; clampStart(); resetEndFromStart(); render('both'); break;
                case 'end-minus':     endT -= 0.5; clampEnd(); render('end'); break;
                case 'end-plus':      endT += 0.5; clampEnd(); render('end'); break;
            }
```

Replace with:

```js
            switch (btn.dataset.act) {
                case 'start-current': startT = cur; clampStart(); render('start'); break;
                case 'start-minus':   startT -= 0.5; clampStart(); render('start'); break;
                case 'start-plus':    startT += 0.5; clampStart(); render('start'); break;
                case 'end-minus':     endT -= 0.5; clampEnd(); render('end'); break;
                case 'end-plus':      endT += 0.5; clampEnd(); render('end'); break;
            }
```

- [ ] **Step 11: Remove the old scrubber's input listener**

Find this exact block:

```js

        // Coarse scrubber — drag to roughly land near a moment (native range
        // click-to-jump handles "hard to get to the start"), then fine-tune
        // with the ⤓ Now / ±.5 buttons above. End re-anchors to start+2s and
        // is fine-tuned separately via its own ±.5 buttons only.
        scrubStart.addEventListener('input', () => {
            startT = parseFloat(scrubStart.value);
            clampStart();
            resetEndFromStart();
            render('both');
        });
```

Replace with nothing (delete the block, including its leading blank line and comment).

- [ ] **Step 12: Use `MIN_CLIP_GAP` in the duration check inside the Make-GIF handler**

Find this exact line:

```js
            if (endT - startT < 0.1) { setStatus('End must be after start.'); return; }
```

Replace with:

```js
            if (endT - startT < MIN_CLIP_GAP) { setStatus('End must be after start.'); return; }
```

- [ ] **Step 13: Pre-seed the filmstrip window before the initial render**

Find this exact block (the final two lines of `openGifPanel`, immediately before its closing brace):

```js

        render('both');
    }
```

Replace with:

```js

        ensureFilmstripWindow();
        render('both');
    }
```

(This must be the last occurrence of this exact text in the file — `openGifPanel`'s own closing — not any earlier, unrelated `render('both');` call site. If it appears more than once, use the surrounding `}` that closes the whole function to confirm you're editing the right one.)

- [ ] **Step 14: Verify syntax**

Run: `node --check cytube.pc.user.js`
Expected: no output, exit code 0.

- [ ] **Step 15: Self-review (no browser available — trace the code instead)**

1. Grep the file to confirm `scrubStart`, `resetEndFromStart`, `.sc-gif-scrub`, `.sc-gif-scrub-spacer`, `#sc-gif-cap-handle-top-end`, `#sc-gif-cap-handle-bottom-end` no longer appear anywhere. Also confirm the new overview/filmstrip HTML block sits between `<div id="sc-gif-body">` and `<div class="sc-gif-marks">`, `<div class="sc-gif-marks">` still has exactly two `.sc-gif-mark` children, and nothing after the caption-hint `<div>` (opts/go/status/result) was touched.
2. Confirm `ensureFilmstripWindow()`'s sticky-window logic matches the constraint exactly: it only recomputes `_filmstripWindow` when `startT`/`endT` drift within `FILMSTRIP_EDGE_PAD` of the *current* window's edge, and only returns `true` (signaling tiles need refetching) when the recomputed window's values actually differ from the stored ones.
3. Confirm `clampStart`/`clampEnd` enforce both `MIN_CLIP_GAP` (can't cross the other handle) and `MAX_CLIP_LEN` (10s cap on duration).
4. Trace `close()`: confirm `_filmstripTimer` and every `thumbTimers` entry are cleared before `panel.remove()` runs.
5. Confirm the marks-button handler's `start-*` cases call `render('start')`, not `render('both')`, since `clampStart()` never touches `endT` anymore.
6. Confirm `wireCapHandle` is only invoked for `'start'` — grep for `cap-handle-` to confirm no remaining reference to an `-end` handle element.
7. Confirm this task did not touch anything ImgBB-related, the floating `#sc-gif-btn`, or `_gifTitleSlug`/`parseMovieFilename`/`lastMovieTitle` — grep for `LS_IMGBB`, `uploadToImgbb`, `_gifTitleSlug` and confirm none of those call sites were modified by this diff.

- [ ] **Step 16: Commit**

```bash
git add cytube.pc.user.js
git commit -m "Port filmstrip trimmer and consolidated caption handles into pc.user.js, replacing the single-scrubber trim UI"
```

---

### Task 2: Whole-movie overview scrubber + arrow-key nudging

**Files:**
- Modify: `cytube.pc.user.js` (inside `openGifPanel()`)

**Interfaces:**
- Consumes: `_fmtClockTenths`, `DEFAULT_CLIP_LEN`, `render`, `clampStart`, `clampEnd`, `renderFilmstripHandles`, `ensureFilmstripWindow`, `_filmstripWindow` (all from Task 1, unchanged).
- Produces: `OVERVIEW_NUDGE_SEC`, `OVERVIEW_NUDGE_SEC_FAST` constants; `overviewTimeFromEvent(e)`, `overviewCommit(e)`; extends `renderFilmstripHandles()` to also drive the overview viewport indicator and current-position label.

- [ ] **Step 1: Add the overview-nudge constants**

Find this exact block:

```js
    const FILMSTRIP_EDGE_PAD = 1;
    const FILMSTRIP_TILES = 10;

    function openGifPanel(initialSec) {
```

Replace with:

```js
    const FILMSTRIP_EDGE_PAD = 1;
    const FILMSTRIP_TILES = 10;
    const OVERVIEW_NUDGE_SEC = 1;
    const OVERVIEW_NUDGE_SEC_FAST = 10;

    function openGifPanel(initialSec) {
```

- [ ] **Step 2: Set the overview track's total-duration label after the panel is added to the DOM**

Find this exact block:

```js
        document.body.appendChild(panel);

        const $ = id => panel.querySelector(id);
        const goBtn = $('#sc-gif-go'), status = $('#sc-gif-status'), result = $('#sc-gif-result');
        const setStatus = (txt) => { status.textContent = txt || ''; };
```

Replace with:

```js
        document.body.appendChild(panel);

        const $ = id => panel.querySelector(id);
        const goBtn = $('#sc-gif-go'), status = $('#sc-gif-status'), result = $('#sc-gif-result');
        $('#sc-gif-overview-total').textContent = isFinite(vidDur) ? _fmtClockTenths(vidDur) : '';
        const setStatus = (txt) => { status.textContent = txt || ''; };
```

- [ ] **Step 3: Grab the overview elements**

Find this exact block:

```js
        let _filmstripTimer = null;
        let _tilesWindowKey = null; // the window the on-screen tiles currently show

        for (let i = 0; i < FILMSTRIP_TILES; i++) {
```

Replace with:

```js
        let _filmstripTimer = null;
        let _tilesWindowKey = null; // the window the on-screen tiles currently show

        const overviewTrack = $('#sc-gif-overview-track');
        const overviewViewport = $('#sc-gif-overview-viewport');
        const overviewGhost = $('#sc-gif-overview-ghost');
        const overviewCurrent = $('#sc-gif-overview-current');
        let overviewDragging = false;

        for (let i = 0; i < FILMSTRIP_TILES; i++) {
```

- [ ] **Step 4: Extend `renderFilmstripHandles()` to position the overview viewport indicator and current-position label**

Find this exact block:

```js
        function renderFilmstripHandles() {
            const win = _filmstripWindow;
            if (!win) return;
            const pctFor = t => Math.max(0, Math.min(100,
                ((t - win.windowStart) / (win.windowEnd - win.windowStart)) * 100));
            const sp = pctFor(startT), ep = pctFor(endT);
            filmstripHandleStart.style.left = sp + '%';
            filmstripHandleEnd.style.left = ep + '%';
            $('#sc-gif-filmstrip-dim-left').style.width = sp + '%';
            $('#sc-gif-filmstrip-dim-right').style.width = (100 - ep) + '%';
            const selection = $('#sc-gif-filmstrip-selection');
            selection.style.left = sp + '%';
            selection.style.width = (ep - sp) + '%';
            $('#sc-gif-filmstrip-range').textContent =
                _fmtClockTenths(win.windowStart) + ' – ' + _fmtClockTenths(win.windowEnd);
        }
```

Replace with:

```js
        function renderFilmstripHandles() {
            const win = _filmstripWindow;
            if (!win) return;
            const pctFor = t => Math.max(0, Math.min(100,
                ((t - win.windowStart) / (win.windowEnd - win.windowStart)) * 100));
            const sp = pctFor(startT), ep = pctFor(endT);
            filmstripHandleStart.style.left = sp + '%';
            filmstripHandleEnd.style.left = ep + '%';
            $('#sc-gif-filmstrip-dim-left').style.width = sp + '%';
            $('#sc-gif-filmstrip-dim-right').style.width = (100 - ep) + '%';
            const selection = $('#sc-gif-filmstrip-selection');
            selection.style.left = sp + '%';
            selection.style.width = (ep - sp) + '%';
            $('#sc-gif-filmstrip-range').textContent =
                _fmtClockTenths(win.windowStart) + ' – ' + _fmtClockTenths(win.windowEnd);

            if (isFinite(vidDur) && vidDur > 0) {
                const ovStart = (win.windowStart / vidDur) * 100;
                const ovEnd = (win.windowEnd / vidDur) * 100;
                overviewViewport.style.left = ovStart + '%';
                overviewViewport.style.width = Math.max(0.5, ovEnd - ovStart) + '%';
            }
            if (!overviewDragging) {
                overviewCurrent.textContent = 'Currently editing: ' + _fmtClockTenths(startT);
            }
        }
```

- [ ] **Step 5: Wire the overview track's drag-to-preview / release-to-commit / arrow-key interaction**

Find this exact block:

```js
        wireFilmstripDrag(filmstripHandleStart, 'start');
        wireFilmstripDrag(filmstripHandleEnd, 'end');
```

Replace with:

```js
        wireFilmstripDrag(filmstripHandleStart, 'start');
        wireFilmstripDrag(filmstripHandleEnd, 'end');

        function overviewTimeFromEvent(e) {
            const rect = overviewTrack.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            return pct * vidDur;
        }
        overviewTrack.addEventListener('pointerdown', (e) => {
            if (isBlob || !src || !isFinite(vidDur)) return;
            if (e.button !== 0) return; // ignore right-click/middle-click; pen and touch report button 0 on pointerdown
            e.stopPropagation();
            overviewDragging = true;
            overviewTrack.setPointerCapture(e.pointerId);
            overviewGhost.style.setProperty('display', 'block', 'important');
            overviewGhost.style.left = (overviewTimeFromEvent(e) / vidDur * 100) + '%';
        });
        overviewTrack.addEventListener('pointermove', (e) => {
            if (!overviewDragging) return;
            const t = overviewTimeFromEvent(e);
            overviewGhost.style.left = (t / vidDur * 100) + '%';
            overviewCurrent.textContent = 'Jump to: ' + _fmtClockTenths(t) + ' (release to commit)';
        });
        function overviewCommit(e) {
            if (!overviewDragging) return;
            overviewDragging = false;
            overviewGhost.style.setProperty('display', 'none', 'important');
            try { overviewTrack.releasePointerCapture(e.pointerId); } catch (err) {}
            const t = overviewTimeFromEvent(e);
            startT = Math.max(0, t - DEFAULT_CLIP_LEN / 2);
            endT = Math.min(vidDur, startT + DEFAULT_CLIP_LEN);
            clampStart();
            clampEnd();
            render('both');
        }
        overviewTrack.addEventListener('pointerup', overviewCommit);
        overviewTrack.addEventListener('pointercancel', (e) => {
            overviewDragging = false;
            overviewGhost.style.setProperty('display', 'none', 'important');
            try { overviewTrack.releasePointerCapture(e.pointerId); } catch (err) {}
            renderFilmstripHandles(); // restore the "Currently editing" label, no jump
        });
        overviewTrack.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault(); // arrows would otherwise scroll the page/chat behind the panel
            e.stopPropagation(); // stop this same script's OWN document-level arrow-key video-seek handler from also firing, even in the disabled-state branch below
            if (isBlob || !src || !isFinite(vidDur)) return;
            const step = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? OVERVIEW_NUDGE_SEC_FAST : OVERVIEW_NUDGE_SEC);
            const dur = endT - startT;
            // Deliberately bypasses clampStart()/clampEnd() -- those can change
            // dur (MAX_CLIP_LEN/MIN_CLIP_GAP), but a nudge must never alter the
            // clip's length, only its position.
            let newStart = startT + step;
            newStart = Math.max(0, Math.min(newStart, Math.max(0, vidDur - dur)));
            startT = newStart;
            endT = startT + dur;
            render('both');
        });
```

Note on the `stopPropagation()` comment: this file (`cytube.pc.user.js`) has its own document-level `ArrowLeft`/`ArrowRight` keydown handler elsewhere (used for video seeking). Without `stopPropagation()` here, a keydown on the focused overview track would bubble up to that same handler and also seek the live video — this is not a cross-script concern in this file the way it was in the standalone script, but the fix is identically necessary.

- [ ] **Step 6: Verify syntax**

Run: `node --check cytube.pc.user.js`
Expected: no output, exit code 0.

- [ ] **Step 7: Self-review (no browser available — trace the code instead)**

1. Confirm `overviewTimeFromEvent`'s clamp (`Math.max(0, Math.min(1, ...))`) bounds the result to `[0, vidDur]` regardless of how far outside the track the pointer is.
2. Confirm the commit path (`overviewCommit`) resets to a fresh `DEFAULT_CLIP_LEN`-length clip centered at the release point, then calls `clampStart()`/`clampEnd()`/`render('both')` — the full existing pipeline.
3. Confirm `pointermove` never mutates `startT`/`endT`/calls `render` — only the ghost position and the "Jump to: …" label text.
4. Confirm the `keydown` handler's guard ordering: the key-type filter and `preventDefault()`/`stopPropagation()` happen *before* the disabled-state check, so an arrow key is always suppressed once identified as an arrow, regardless of whether the nudge itself proceeds — grep to confirm `e.stopPropagation()` appears before the `isBlob || !src || !isFinite(vidDur)` check inside this handler specifically.
5. Confirm this file's own pre-existing document-level `ArrowLeft`/`ArrowRight` handler (search for where it's defined) is completely unmodified by this diff — this task only adds a *target-scoped* listener that stops propagation, it does not touch the document-level handler itself.
6. Confirm `renderFilmstripHandles()`'s new `!overviewDragging` guard correctly prevents the "Currently editing" text from clobbering the live "Jump to: …" label during a drag.

- [ ] **Step 8: Commit**

```bash
git add cytube.pc.user.js
git commit -m "Port whole-movie overview scrubber with arrow-key nudging into pc.user.js"
```

---

### Task 3: Draggable filmstrip selection band with edge auto-scroll

**Files:**
- Modify: `cytube.pc.user.js` (inside `openGifPanel()`)

**Interfaces:**
- Consumes: `startT`/`endT`/`vidDur`/`isBlob`/`src`/`_filmstripWindow` (closures), `render`, `ensureFilmstripWindow`, `renderFilmstripHandles`, `filmstripStrip` (all from Tasks 1-2, unchanged).
- Produces: `SELECTION_EDGE_ZONE_PX`, `SELECTION_AUTOSCROLL_STEP`, `SELECTION_AUTOSCROLL_INTERVAL_MS` constants; `selectionShiftTo(newStart)`, `stopSelectionAutoScroll()`, `startSelectionAutoScroll(dir)`; a fully-wired `#sc-gif-filmstrip-selection`; an updated `close()`.

- [ ] **Step 1: Add the selection auto-scroll constants**

Find this exact block:

```js
    const OVERVIEW_NUDGE_SEC = 1;
    const OVERVIEW_NUDGE_SEC_FAST = 10;

    function openGifPanel(initialSec) {
```

Replace with:

```js
    const OVERVIEW_NUDGE_SEC = 1;
    const OVERVIEW_NUDGE_SEC_FAST = 10;
    const SELECTION_EDGE_ZONE_PX = 20;
    const SELECTION_AUTOSCROLL_STEP = 0.2;
    const SELECTION_AUTOSCROLL_INTERVAL_MS = 100;

    function openGifPanel(initialSec) {
```

- [ ] **Step 2: Stop any active auto-scroll when the panel closes**

Find this exact block:

```js
        const close = () => {
            clearTimeout(_filmstripTimer);
            Object.values(thumbTimers).forEach(clearTimeout);
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

- [ ] **Step 3: Add the selection-drag state, functions, and wiring**

Find this exact block:

```js
        wireFilmstripDrag(filmstripHandleStart, 'start');
        wireFilmstripDrag(filmstripHandleEnd, 'end');

        function overviewTimeFromEvent(e) {
```

Replace with:

```js
        wireFilmstripDrag(filmstripHandleStart, 'start');
        wireFilmstripDrag(filmstripHandleEnd, 'end');

        let selectionDragging = false;
        let selectionDragStartX = 0;
        let selectionDragStartT0 = 0; // startT captured at pointerdown
        let selectionAutoScrollTimer = null;
        let selectionAutoScrollDir = 0; // -1 (backward), 0 (idle), 1 (forward)

        function selectionShiftTo(newStart) {
            const dur = endT - startT;
            newStart = Math.max(0, Math.min(newStart, Math.max(0, vidDur - dur)));
            startT = newStart;
            endT = startT + dur;
            render('both');
        }
        function stopSelectionAutoScroll() {
            if (selectionAutoScrollTimer) { clearInterval(selectionAutoScrollTimer); selectionAutoScrollTimer = null; }
            selectionAutoScrollDir = 0;
        }
        function startSelectionAutoScroll(dir) {
            if (selectionAutoScrollDir === dir) return;
            stopSelectionAutoScroll();
            selectionAutoScrollDir = dir;
            selectionAutoScrollTimer = setInterval(() => {
                selectionShiftTo(startT + dir * SELECTION_AUTOSCROLL_STEP);
                // render('both') above only re-arms the 220ms tile-refetch
                // debounce, which this 100ms tick perpetually resets, so the
                // filmstrip window itself would never reframe during a
                // sustained hold. Force the cheap (no-network) reframe/
                // reposition every tick so the visible window actually pans;
                // tile thumbnails stay on the existing debounce and catch up
                // shortly after the hold ends, same as they already do for a
                // fast handle drag.
                ensureFilmstripWindow();
                renderFilmstripHandles();
            }, SELECTION_AUTOSCROLL_INTERVAL_MS);
        }

        const selectionEl = $('#sc-gif-filmstrip-selection');
        selectionEl.addEventListener('pointerdown', (e) => {
            if (isBlob || !src || !isFinite(vidDur)) return;
            if (e.button !== 0) return;
            e.stopPropagation();
            selectionDragging = true;
            selectionDragStartX = e.clientX;
            selectionDragStartT0 = startT;
            selectionEl.setPointerCapture(e.pointerId);
        });
        selectionEl.addEventListener('pointermove', (e) => {
            if (!selectionDragging || !_filmstripWindow) return;
            const rect = filmstripStrip.getBoundingClientRect();
            if (e.clientX <= rect.left + SELECTION_EDGE_ZONE_PX) { startSelectionAutoScroll(-1); return; }
            if (e.clientX >= rect.right - SELECTION_EDGE_ZONE_PX) { startSelectionAutoScroll(1); return; }
            if (selectionAutoScrollDir !== 0) {
                // Leaving the edge zone after auto-scrolling -- resync the drag
                // anchor to the current pointer position/time. Without this,
                // the delta below would be computed against the position the
                // drag originally started at, snapping the clip back to
                // wherever it was before auto-scroll ran and discarding all
                // of that movement.
                selectionDragStartX = e.clientX;
                selectionDragStartT0 = startT;
            }
            stopSelectionAutoScroll();
            const win = _filmstripWindow;
            const deltaPx = e.clientX - selectionDragStartX;
            const deltaSec = deltaPx / rect.width * (win.windowEnd - win.windowStart);
            selectionShiftTo(selectionDragStartT0 + deltaSec);
        });
        function endSelectionDrag(e) {
            selectionDragging = false;
            stopSelectionAutoScroll();
            try { selectionEl.releasePointerCapture(e.pointerId); } catch (err) {}
        }
        selectionEl.addEventListener('pointerup', endSelectionDrag);
        selectionEl.addEventListener('pointercancel', endSelectionDrag);
        selectionEl.addEventListener('lostpointercapture', endSelectionDrag);

        function overviewTimeFromEvent(e) {
```

Note: `render`, `ensureFilmstripWindow`, and `renderFilmstripHandles` are referenced here before their own point of use elsewhere in the function — safe for the same closure-timing reason established in Task 1 Step 7's note. Apply in the given order.

- [ ] **Step 4: Verify syntax**

Run: `node --check cytube.pc.user.js`
Expected: no output, exit code 0.

- [ ] **Step 5: Self-review (no browser available — trace the code instead)**

1. Confirm `selectionShiftTo` never changes `endT - startT`: trace `startT=100, endT=103` (dur=3), `selectionShiftTo(150)` → `startT=150, endT=153`, dur unchanged.
2. Confirm the clamp: trace `selectionShiftTo(-50)` with `vidDur=5400` → clamps to `startT=0`. Trace a case pushing `endT` past `vidDur` → clamps correctly there too.
3. Confirm `startSelectionAutoScroll`'s same-direction no-op: two consecutive calls with `dir=-1` — the second returns immediately without creating a second `setInterval`.
4. Confirm the edge-zone check uses `filmstripStrip.getBoundingClientRect()`, never `selectionEl.getBoundingClientRect()`.
5. Confirm the anchor-resync block (`if (selectionAutoScrollDir !== 0) { ... }`) sits *before* `stopSelectionAutoScroll()` in the `pointermove` handler — reading `selectionAutoScrollDir` after it's cleared would always see `0` and the resync would never fire.
6. Confirm `close()` calls `stopSelectionAutoScroll()` unconditionally, clearing `selectionAutoScrollTimer` and resetting `selectionAutoScrollDir` before `panel.remove()` runs.
7. Confirm the disabled-state guard and `e.button !== 0` guard are both checked in `pointerdown`, before any state mutation or `stopPropagation()`.
8. Confirm the HTML template's DOM order (from Task 1) still has `.sc-gif-filmstrip-selection` before `.sc-gif-filmstrip-handle-start`/`-end`, so the handles still take priority over the band wherever they visually overlap it.

- [ ] **Step 6: Commit**

```bash
git add cytube.pc.user.js
git commit -m "Port draggable filmstrip selection band with edge auto-scroll into pc.user.js"
```
