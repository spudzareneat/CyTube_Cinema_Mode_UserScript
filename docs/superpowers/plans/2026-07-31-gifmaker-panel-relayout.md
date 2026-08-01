# GIF Maker Panel Relayout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the GIF Maker panel's "everything stacked, scroll if it doesn't fit" layout with a two-column Captions/Format row plus a full-width collapsible Effects section, so the panel fits typical viewports without scrolling in the default state.

**Architecture:** Pure DOM/CSS reorganization inside `openGifPanel()`'s HTML template and its CSS block in `cytube.gifmaker.user.js` — no changes to any existing element IDs, function names, or JS logic inside the Captions, Format-options, or Effects controls themselves. The panel widens from 420px to ~600px; the existing (already two-column) start/end marks row, filmstrip, overview scrubber, ImgBB row, Optimize checkbox, and Make GIF button/result all stay exactly where they are. The Effects section gains a collapsible header (collapsed by default), reusing the existing ImgBB-row collapsible header/chevron pattern already in this file, but is wired independently.

**Tech Stack:** Tampermonkey userscript (vanilla JS, no build step), CSS `!important` (matching this file's existing convention throughout), flexbox with `flex-wrap` for the two-column-to-one-column responsive fallback (no media query needed).

## Global Constraints

- No automated test framework in this repo — verification is `node --check cytube.gifmaker.user.js` (syntax only) plus a code-reading self-review, matching every other task on this codebase.
- Do not change any element ID, function name, or event-listener wiring inside `.sc-gif-captions`, `.sc-gif-opts`, or the Effects controls (mode/speed/freeze/filter checkboxes+sliders/preview canvas+scrub+play+status+button) — only the DOM structure *around* them changes (which parent div wraps them), never their own markup or the JS that queries them by ID.
- The `#sc-gif-fx` element keeps its existing class name `sc-gif-fx` (its flex-column styling is reused) — do not rename it. It gains a new `id="sc-gif-fx-body"` (previously had no ID) and a new `sc-gif-fx-open` modifier class that controls visibility, replacing its current always-visible `display: flex` default with `display: none` by default.
- The Effects toggle button reuses the exact ImgBB-row collapsible pattern already in this file (`cytube.gifmaker.user.js`'s `.sc-gif-imgbb-header`/`.sc-gif-imgbb-toggle` CSS and its header-click JS at the `imgbbHeader.addEventListener('click', ...)` site) as a styling and interaction reference — implemented as new, independently-named classes/IDs (`.sc-gif-fx-header`, `.sc-gif-fx-toggle`, `#sc-gif-fx-header`, `#sc-gif-fx-toggle`), not a shared refactor of the ImgBB code.
- The `max-height: 88vh` / `overflow-y: auto` scroll fallback added in commit `e47317b` (on `#sc-gif-panel` and `#sc-gif-body`) stays unchanged — it remains a fallback for genuine edge cases, not something this plan removes.
- Effects starts collapsed every time the panel opens (no persistence of open/closed state — matches the existing "Effects settings reset every time the panel opens" behavior already established for the `fx` state object itself).

---

### Task 1: Two-column layout + collapsible Effects section

**Files:**
- Modify: `cytube.gifmaker.user.js` (CSS block, HTML template inside `openGifPanel()`, and its panel-wiring JS)

**Interfaces:**
- Consumes: nothing new — reuses existing `$(id)` closure-scoped query helper already used throughout `openGifPanel()`.
- Produces: `.sc-gif-cols`, `.sc-gif-col-left`, `.sc-gif-col-right`, `.sc-gif-fx-header`, `.sc-gif-fx-toggle`, `.sc-gif-fx-open` CSS classes; `#sc-gif-fx-header`, `#sc-gif-fx-toggle`, `#sc-gif-fx-body` (new ID on the existing `.sc-gif-fx` element) IDs; a header-click JS listener toggling `#sc-gif-fx-body`'s `sc-gif-fx-open` class, mirroring the existing `imgbbHeader` click listener's structure exactly.

CSS, HTML, and JS are bundled into one task rather than split across three — a markup-only intermediate commit would leave the JS's toggle listener referencing elements that don't exist yet (or leave `.sc-gif-fx` permanently hidden with no way to open it), which `node --check` can't catch and which would be broken if the panel were opened in that state. Steps are still ordered CSS → HTML → JS so each edit is easy to review individually, but the task as a whole is the smallest unit that's safe to actually open the panel against.

- [ ] **Step 1: Widen the panel and add the two-column + collapsible-header CSS**

Find this exact block:
```js
            #sc-gif-panel {
                position: fixed !important;
                top: 50% !important; left: 50% !important; transform: translate(-50%, -50%) !important;
                z-index: 30002 !important;
                width: 420px !important; max-width: 92vw !important;
                max-height: 88vh !important;
                display: flex !important; flex-direction: column !important;
                background: rgba(18,18,20,0.98) !important;
                border: 1px solid rgba(255,255,255,0.16) !important;
                border-radius: 10px !important;
                box-shadow: 0 12px 40px rgba(0,0,0,0.6) !important;
                color: #eee !important; font-size: 13px !important;
            }
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
                background: rgba(18,18,20,0.98) !important;
                border: 1px solid rgba(255,255,255,0.16) !important;
                border-radius: 10px !important;
                box-shadow: 0 12px 40px rgba(0,0,0,0.6) !important;
                color: #eee !important; font-size: 13px !important;
            }
```

Find this exact block:
```js
            .sc-gif-fx { display: flex !important; flex-direction: column !important; gap: 8px !important; }
```

Replace with:
```js
            .sc-gif-cols { display: flex !important; flex-wrap: wrap !important; gap: 14px !important; }
            .sc-gif-col-left, .sc-gif-col-right {
                flex: 1 1 240px !important; min-width: 0 !important;
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
```

- [ ] **Step 2: Restructure the HTML — wrap Captions/Format into two columns, add the Effects toggle, make the Effects body full-width**

Find this exact block:
```js
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
                <div class="sc-gif-fx">
```

Replace with:
```js
                <div id="sc-gif-dur-line">Duration <b id="sc-gif-dur-val"></b></div>
                <div class="sc-gif-cols">
                    <div class="sc-gif-col-left">
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
                    </div>
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
                <div class="sc-gif-fx" id="sc-gif-fx-body">
```

(Everything inside the `.sc-gif-fx` element — the two `.sc-gif-fx-row` blocks, `.sc-gif-fx-filters`, and `.sc-gif-preview` — is unchanged; only its opening tag gains `id="sc-gif-fx-body"`. Its closing `</div>` before `<div class="sc-gif-imgbb-row" ...>` is also unchanged.)

- [ ] **Step 3: Wire the Effects toggle click handler**

Find this exact block:
```js
        const imgbbRow = $('#sc-gif-imgbb-row');
        const imgbbHeader = $('#sc-gif-imgbb-header');
        const imgbbToggle = $('#sc-gif-imgbb-toggle');
        imgbbHeader.addEventListener('click', () => {
            const open = imgbbRow.classList.toggle('sc-gif-imgbb-open');
            imgbbToggle.textContent = open ? '▾' : '▸';
            imgbbHeader.setAttribute('aria-expanded', String(open));
        });
```

Replace with:
```js
        const imgbbRow = $('#sc-gif-imgbb-row');
        const imgbbHeader = $('#sc-gif-imgbb-header');
        const imgbbToggle = $('#sc-gif-imgbb-toggle');
        imgbbHeader.addEventListener('click', () => {
            const open = imgbbRow.classList.toggle('sc-gif-imgbb-open');
            imgbbToggle.textContent = open ? '▾' : '▸';
            imgbbHeader.setAttribute('aria-expanded', String(open));
        });

        const fxHeader = $('#sc-gif-fx-header');
        const fxToggle = $('#sc-gif-fx-toggle');
        const fxBodyEl = $('#sc-gif-fx-body');
        fxHeader.addEventListener('click', () => {
            const open = fxBodyEl.classList.toggle('sc-gif-fx-open');
            fxToggle.textContent = open ? '▾' : '▸';
            fxHeader.setAttribute('aria-expanded', String(open));
        });
```

Note: this introduces `fxBodyEl` as a new local name, distinct from the `fxCanvas`/`fxScrub`/`fxPlayBtn`/`fxStatus`/`fxPreviewBtn` constants declared later in `openGifPanel()` for the Effects preview wiring (Task 5 of the earlier effects plan) — do not rename any of those, and do not reuse the name `fxBody` for anything else in this function.

- [ ] **Step 4: Verify syntax**

Run: `node --check cytube.gifmaker.user.js`
Expected: no output, exit code 0.

- [ ] **Step 5: Self-review**

Trace through and confirm:
1. Every element ID referenced in the Step 3 JS (`sc-gif-fx-header`, `sc-gif-fx-toggle`, `sc-gif-fx-body`) exists in the Step 2 HTML.
2. `#sc-gif-fx-body` is the same element that already carries the `sc-gif-fx` class (it is `.sc-gif-fx`'s opening tag, not a new wrapper) — the existing `#sc-gif-fx-mode`, `#sc-gif-fx-speed`, etc. controls (and the entire live-preview canvas/scrub/play/status/button block) are still direct or nested children of this element, unchanged from before this task.
3. `.sc-gif-fx`'s default CSS is now `display: none !important` and only becomes visible via the `.sc-gif-fx-open` modifier — confirm no other CSS rule or inline style anywhere in the file sets `display` on `.sc-gif-fx` or `#sc-gif-fx-body` that would override this (in particular, the effects-controls JS added in the earlier effects plan never touches `.style.display` on this element — it only reads/writes individual control values).
4. `.sc-gif-cols` uses `flex-wrap: wrap` with each column at `flex: 1 1 240px` — on a narrow viewport (panel capped at `max-width: 92vw`), the columns stack to one full-width column automatically; no separate media query was needed or added.
5. The panel's `width` changed from `420px` to `600px` in exactly one place (`#sc-gif-panel`) — no other width value in the file was touched.
6. No element ID, class name, or JS reference inside `.sc-gif-captions`, `.sc-gif-opts`, or the effects-controls/preview block (from `.sc-gif-fx-row` through `.sc-gif-preview`) was altered — only their parent wrapper structure changed.
7. `imgbbHeader`'s existing click listener (Step 3's Find block) is untouched — the new `fxHeader` listener is added immediately after it, not merged into it or reordered.

- [ ] **Step 6: Manual browser verification**

Load the userscript in a Tampermonkey dev profile against a live CyTube video (`420Grindhouse` or `testing` room). Open the GIF Maker and confirm:
- The panel opens at roughly 600px wide (or `92vw` on narrow windows), with Captions on the left and Format options + a collapsed "▸ Effects" button on the right, side by side.
- In this default (Effects collapsed) state, the whole panel fits within a normal browser window height with no scrollbar needed.
- Clicking "▸ Effects" expands it (chevron flips to ▾, `aria-expanded` becomes `"true"`) as a full-width section below the two columns — the live preview canvas should visibly span close to the panel's full width, not a half-width column.
- Clicking "▾ Effects" again collapses it back.
- The panel is still draggable by its header title bar in both the collapsed and expanded states.
- Resize the browser window narrower — the two columns stack to one column (Captions above, Format/Effects-toggle below) without any control becoming unreachable or overlapping.
- Make the browser window very short with Effects expanded — confirm the `max-height`/scroll fallback from commit `e47317b` still kicks in rather than the panel running off-screen.
- Closing and reopening the panel resets Effects back to collapsed (no persistence), matching the existing "effects settings reset every time" behavior.
- Confirm the ImgBB-row collapsible section (unrelated, pre-existing) still opens/closes correctly and was not affected by this change.

- [ ] **Step 7: Commit**

```bash
git add cytube.gifmaker.user.js
git commit -m "Relayout GIF Maker panel: two-column Captions/Format row, full-width collapsible Effects section"
```
