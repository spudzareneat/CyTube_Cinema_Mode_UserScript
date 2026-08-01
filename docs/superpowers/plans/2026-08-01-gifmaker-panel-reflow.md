# GIF Maker Panel Reflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Style the panel body's scrollbar to match the dark theme, make the Captions/Format/Effects section collapsible (starts open, auto-collapses when Make GIF is clicked, manually re-openable via its own toggle header), and reorder the panel so the result GIF appears right after that section, with the Make GIF button and the ImgBB/Optimize settings both moved to below the result.

**Architecture:** One CSS-only addition (scrollbar styling) plus one HTML reorder + a new disclosure header (matching the existing ImgBB/Effects pattern) plus a small JS addition (toggle wiring + auto-collapse on Make GIF click) — all in `cytube.gifmaker.user.js`.

**Tech Stack:** Tampermonkey userscript (vanilla JS, no build step), WebKit scrollbar pseudo-elements plus the standard `scrollbar-width`/`scrollbar-color` properties for cross-browser coverage.

## Global Constraints

- No automated test framework in this repo — verification is `node --check cytube.gifmaker.user.js` (syntax only) plus a code-reading self-review.
- New panel order (top to bottom): header → Trim card (unchanged) → **new** "Captions & Format" disclosure toggle → the existing `.sc-gif-cols` two-column block (captions left, format+Effects right — contents completely unchanged, just wrapped) → `#sc-gif-status` → `#sc-gif-result` → `#sc-gif-go` (Make GIF button) → the existing ImgBB+Optimize card (contents unchanged, just moved).
- The Captions/Format/Effects section starts **open** by default (opposite of the ImgBB/Effects sections, which start closed) — its collapsed state is represented by an added `sc-gif-mid-collapsed` modifier class, not an added "-open" class.
- Clicking "Make GIF" collapses this section (if not already collapsed) as part of the click handler, in addition to whatever the button already does — this does not change any existing capture/encode logic, only adds a UI side effect at the start of the handler.
- The section remains manually toggleable afterward via its own header (same interaction pattern as the existing ImgBB/Effects disclosure headers: chevron flips, `aria-expanded` updates).
- No element ID is removed, renamed, or duplicated. `#sc-gif-status`, `#sc-gif-result`, `#sc-gif-go`'s own IDs and their JS references (`status`, `result`, `goBtn` in `openGifPanel()`) are unaffected by moving their position in the DOM — only where they render changes, not how JS finds them.
- Scrollbar styling targets `#sc-gif-body` (the only scrolling element in the panel) with both `scrollbar-width`/`scrollbar-color` (Firefox) and `::-webkit-scrollbar*` (Chrome/Edge) rules, so it's covered regardless of which engine the user's browser uses.

---

### Task 1: Collapsible middle section, panel reorder, and scrollbar styling

**Files:**
- Modify: `cytube.gifmaker.user.js` (CSS block, HTML template, and `openGifPanel()`'s JS)

**Interfaces:**
- Produces: `.sc-gif-mid-header`, `.sc-gif-mid-toggle`, `.sc-gif-mid-collapsed` CSS classes; `#sc-gif-mid-header`, `#sc-gif-mid-toggle`, `#sc-gif-mid-body` (new ID added to the existing `.sc-gif-cols` element) IDs; a click listener on `#sc-gif-mid-header` toggling `#sc-gif-mid-body`'s `sc-gif-mid-collapsed` class, mirroring the existing `imgbbHeader`/`fxHeader` click-listener pattern exactly.
- Consumes: `goBtn` (existing) — its click handler gains a collapse side effect.

- [ ] **Step 1: Add the scrollbar CSS**

Find this exact block:
```js
            #sc-gif-body {
                padding: 16px !important; display: flex !important; flex-direction: column !important; gap: 16px !important;
                flex: 1 1 auto !important; min-height: 0 !important; overflow-y: auto !important;
            }
```
Replace with:
```js
            #sc-gif-body {
                padding: 16px !important; display: flex !important; flex-direction: column !important; gap: 16px !important;
                flex: 1 1 auto !important; min-height: 0 !important; overflow-y: auto !important;
                scrollbar-width: thin !important; scrollbar-color: rgba(244,244,242,0.2) #000 !important;
            }
            #sc-gif-body::-webkit-scrollbar { width: 10px !important; }
            #sc-gif-body::-webkit-scrollbar-track { background: #000 !important; }
            #sc-gif-body::-webkit-scrollbar-thumb {
                background: rgba(244,244,242,0.2) !important; border-radius: 6px !important; border: 2px solid #000 !important;
            }
            #sc-gif-body::-webkit-scrollbar-thumb:hover { background: #ffb020 !important; }
```

- [ ] **Step 2: Add the collapsible-header and collapsed-state CSS**

Find this exact line:
```js
            .sc-gif-cols { display: flex !important; flex-wrap: wrap !important; gap: 16px !important; }
```
Replace with:
```js
            .sc-gif-mid-header {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                background: transparent !important; border: none !important; padding: 0 !important;
                cursor: pointer !important; width: 100% !important; text-align: left !important;
                color: rgba(244,244,242,0.62) !important; font-size: 12px !important; font-weight: 500 !important;
                text-transform: uppercase !important; letter-spacing: 0.06em !important;
                transition: color 120ms ease !important;
            }
            .sc-gif-mid-header:hover { color: #f4f4f2 !important; }
            .sc-gif-mid-header:focus-visible { outline: 2px solid #ffb020 !important; outline-offset: 1px !important; }
            .sc-gif-mid-toggle { color: rgba(244,244,242,0.34) !important; font-size: 11px !important; }
            .sc-gif-cols { display: flex !important; flex-wrap: wrap !important; gap: 16px !important; }
            .sc-gif-cols.sc-gif-mid-collapsed { display: none !important; }
```

- [ ] **Step 3: Reorder the panel HTML — add the disclosure toggle, move status/result/button/ImgBB-card**

Find this exact block:
```js
                <div id="sc-gif-dur-line">Duration <b id="sc-gif-dur-val"></b></div>
                </div>
                <div class="sc-gif-cols">
                    <div class="sc-gif-col-left">
```
Replace with:
```js
                <div id="sc-gif-dur-line">Duration <b id="sc-gif-dur-val"></b></div>
                </div>
                <button type="button" class="sc-gif-mid-header" id="sc-gif-mid-header" aria-expanded="true">
                    <span>Captions &amp; Format</span>
                    <span class="sc-gif-mid-toggle" id="sc-gif-mid-toggle">▾</span>
                </button>
                <div class="sc-gif-cols" id="sc-gif-mid-body">
                    <div class="sc-gif-col-left">
```

Find this exact block:
```js
                        </div>
                    </div>
                </div>
                <div class="sc-gif-card">
                <div class="sc-gif-imgbb-row" id="sc-gif-imgbb-row">
                    <button type="button" class="sc-gif-imgbb-header" id="sc-gif-imgbb-header" aria-expanded="false">
                        <span class="sc-gif-imgbb-label">ImgBB key (for Upload)</span>
                        <span class="sc-gif-imgbb-toggle" id="sc-gif-imgbb-toggle">▸</span>
                    </button>
                    <div class="sc-gif-imgbb-body" id="sc-gif-imgbb-body">
                        <div class="sc-gif-imgbb-input-row">
                            <input type="text" id="sc-gif-imgbb-key" class="sc-gif-cap-input sc-gif-imgbb-input"
                                placeholder="Paste ImgBB API key…" value="${_escHtml(getKey(LS_IMGBB))}" spellcheck="false" />
                            <button id="sc-gif-imgbb-test" class="sc-gif-imgbb-test-btn" type="button">Test</button>
                        </div>
                        <span id="sc-gif-imgbb-status" class="sc-gif-imgbb-status"></span>
                    </div>
                </div>
                <div class="sc-gif-optimize-row">
                    <input type="checkbox" id="sc-gif-optimize" ${gifOptimizeEnabled() ? 'checked' : ''} />
                    <label for="sc-gif-optimize">Optimize GIF before upload</label>
                </div>
                </div>
                <button id="sc-gif-go" type="button">● Make GIF</button>
                <div id="sc-gif-status"></div>
                <div id="sc-gif-result"></div>
            </div>`;
```
Replace with:
```js
                        </div>
                    </div>
                </div>
                <div id="sc-gif-status"></div>
                <div id="sc-gif-result"></div>
                <button id="sc-gif-go" type="button">● Make GIF</button>
                <div class="sc-gif-card">
                <div class="sc-gif-imgbb-row" id="sc-gif-imgbb-row">
                    <button type="button" class="sc-gif-imgbb-header" id="sc-gif-imgbb-header" aria-expanded="false">
                        <span class="sc-gif-imgbb-label">ImgBB key (for Upload)</span>
                        <span class="sc-gif-imgbb-toggle" id="sc-gif-imgbb-toggle">▸</span>
                    </button>
                    <div class="sc-gif-imgbb-body" id="sc-gif-imgbb-body">
                        <div class="sc-gif-imgbb-input-row">
                            <input type="text" id="sc-gif-imgbb-key" class="sc-gif-cap-input sc-gif-imgbb-input"
                                placeholder="Paste ImgBB API key…" value="${_escHtml(getKey(LS_IMGBB))}" spellcheck="false" />
                            <button id="sc-gif-imgbb-test" class="sc-gif-imgbb-test-btn" type="button">Test</button>
                        </div>
                        <span id="sc-gif-imgbb-status" class="sc-gif-imgbb-status"></span>
                    </div>
                </div>
                <div class="sc-gif-optimize-row">
                    <input type="checkbox" id="sc-gif-optimize" ${gifOptimizeEnabled() ? 'checked' : ''} />
                    <label for="sc-gif-optimize">Optimize GIF before upload</label>
                </div>
                </div>
            </div>`;
```

- [ ] **Step 4: Wire the new disclosure header's click listener**

Find this exact block:
```js
        const fxHeader = $('#sc-gif-fx-header');
        const fxToggle = $('#sc-gif-fx-toggle');
        const fxBodyEl = $('#sc-gif-fx-body');
        fxHeader.addEventListener('click', () => {
            const open = fxBodyEl.classList.toggle('sc-gif-fx-open');
            fxToggle.textContent = open ? '▾' : '▸';
            fxHeader.setAttribute('aria-expanded', String(open));
        });
```
Replace with:
```js
        const fxHeader = $('#sc-gif-fx-header');
        const fxToggle = $('#sc-gif-fx-toggle');
        const fxBodyEl = $('#sc-gif-fx-body');
        fxHeader.addEventListener('click', () => {
            const open = fxBodyEl.classList.toggle('sc-gif-fx-open');
            fxToggle.textContent = open ? '▾' : '▸';
            fxHeader.setAttribute('aria-expanded', String(open));
        });

        const midHeader = $('#sc-gif-mid-header');
        const midToggle = $('#sc-gif-mid-toggle');
        const midBody = $('#sc-gif-mid-body');
        midHeader.addEventListener('click', () => {
            const collapsed = midBody.classList.toggle('sc-gif-mid-collapsed');
            midToggle.textContent = collapsed ? '▸' : '▾';
            midHeader.setAttribute('aria-expanded', String(!collapsed));
        });
```

Note: `midBody`/`midHeader`/`midToggle` are new local names, distinct from `fxBodyEl`/`fxHeader`/`fxToggle` and `imgbbRow`/`imgbbHeader`/`imgbbToggle` — do not reuse or collide with those.

- [ ] **Step 5: Auto-collapse the middle section when Make GIF is clicked**

Find this exact block (the start of `goBtn`'s click handler):
```js
        goBtn.addEventListener('click', async () => {
            if (isBlob || !src) return;
```
Replace with:
```js
        goBtn.addEventListener('click', async () => {
            if (isBlob || !src) return;
            if (!midBody.classList.contains('sc-gif-mid-collapsed')) {
                midBody.classList.add('sc-gif-mid-collapsed');
                midToggle.textContent = '▸';
                midHeader.setAttribute('aria-expanded', 'false');
            }
```

- [ ] **Step 6: Verify syntax**

Run: `node --check cytube.gifmaker.user.js`
Expected: no output, exit code 0.

- [ ] **Step 7: Self-review**

Trace through and confirm:
1. `#sc-gif-body`'s scrollbar rules are additive to its existing `overflow-y: auto` rule — no existing property in that rule was changed or removed.
2. `.sc-gif-cols` (the collapsible body) keeps its existing `display: flex; flex-wrap: wrap; gap: 16px;` rule completely unchanged — `.sc-gif-cols.sc-gif-mid-collapsed` is a separate, more specific rule that only applies when the modifier class is present, and `!important` vs `!important` at higher specificity (two classes beats one) means it correctly wins when both would otherwise apply.
3. Every element ID referenced in Step 4/5's JS (`sc-gif-mid-header`, `sc-gif-mid-toggle`, `sc-gif-mid-body`) exists in the Step 3 HTML.
4. `#sc-gif-status`, `#sc-gif-result`, `#sc-gif-go`'s own opening tags are unchanged (only their position in the surrounding markup moved) — the `const goBtn = $('#sc-gif-go'), status = $('#sc-gif-status'), result = $('#sc-gif-result');` line elsewhere in the file (unrelated to this task, declared once when the panel opens) still resolves all three correctly regardless of DOM order.
5. The ImgBB row and Optimize row's own internal markup (inputs, buttons, checkbox) is byte-identical to before — only their wrapping wasn't touched, they were moved as one already-self-contained card.
6. `.sc-gif-cols` starts without the `sc-gif-mid-collapsed` class in the HTML (open by default), matching the `aria-expanded="true"` on its header.
7. The auto-collapse block in Step 5 only runs when the section isn't already collapsed (avoids redundantly re-adding a class that's already present, and correctly leaves an already-collapsed section alone on a second Make GIF click).
8. No unrelated line was touched — this diff should be exactly the 5 edits described (Steps 1-5).

- [ ] **Step 8: Manual browser verification**

Load the userscript in a Tampermonkey dev profile against a live CyTube video (`420Grindhouse` or `testing` room). Open the GIF Maker and confirm:
- The scrollbar (resize the browser short enough to trigger it, or expand Effects) renders as a thin black-track scrollbar with a visible gray thumb that highlights amber on hover — not the browser's default scrollbar.
- The "Captions & Format" section is visible (open) by default, with a chevron pointing down.
- Click Make GIF — the Captions & Format section collapses (chevron flips to ▸, content hides) as capture begins.
- After the GIF finishes, click the "Captions & Format" header again — it reopens, and you can change a setting and click Make GIF again, which re-collapses it.
- The rendered GIF (`#sc-gif-result`) appears above the Make GIF button, and the ImgBB key / Optimize checkbox now sit below the Make GIF button, at the very bottom of the panel.
- Confirm ImgBB Test and Upload still work correctly in their new position.

- [ ] **Step 9: Commit**

```bash
git add cytube.gifmaker.user.js
git commit -m "Make Captions/Format section collapsible, reorder panel so result/Make-GIF/ImgBB sit at the bottom, style the scrollbar"
```
