# GIF Maker ImgBB Collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the GIF Maker panel's ImgBB key section collapsible (always starts collapsed), and make the result view show only a Download button — no Upload button, no hint — when no ImgBB key is saved.

**Architecture:** Both changes live inside the existing `openGifPanel()` function and `injectPanelCss()` in `cytube.gifmaker.user.js`. The key input/Test button/status elements and their event wiring are unchanged — only visually hidden via CSS when collapsed. The result-view change is a single conditional around markup that already exists.

**Tech Stack:** Vanilla JS, CSS `!important` throughout (matching this file's established convention).

## Global Constraints

- No automated test framework — verification is `node --check cytube.gifmaker.user.js` (syntax only) plus manual browser testing, unavailable to implementer/reviewer subagents. Test steps are `node --check` plus a code-reading self-review, matching every prior task on this branch.
- Only `cytube.gifmaker.user.js` is touched.
- The ImgBB section always starts **collapsed** when the panel opens — no persisted open/closed state, no "key already configured" indicator in the collapsed header. This is the approved, simplest version.
- The key input, Test button, and status span keep their existing ids, classes, and event listeners entirely unchanged — this task only wraps them in a new collapsible container and toggles `display` via a CSS class, it does not touch `imgbbInput`'s `change` listener, `imgbbTestBtn`'s `click` listener, or `validateImgbbKey`.
- The Upload button and its `<div id="sc-gif-link">` link box are omitted from the result view's HTML entirely (not rendered, not just disabled) when `!getKey(LS_IMGBB)` at the moment the GIF finishes encoding. When a key is present, both buttons render exactly as they already do today — no change to that path.

---

### Task 1: Collapsible ImgBB section + download-only result

**Files:**
- Modify: `cytube.gifmaker.user.js` (inside `openGifPanel()` and `injectPanelCss()`)

**Interfaces:**
- Consumes: `getKey(LS_IMGBB)`, `$` (panel query helper), `_escHtml` — all pre-existing, unchanged.
- Produces: a `click` listener on `#sc-gif-imgbb-header` toggling `.sc-gif-imgbb-open` on `#sc-gif-imgbb-row`, and a `hasImgbbKey`-gated result-view branch.

- [ ] **Step 1: Restructure the ImgBB row into header + collapsible body**

Find this exact block:

```js
                <div class="sc-gif-imgbb-row">
                    <label class="sc-gif-imgbb-label">ImgBB key (for Upload)</label>
                    <div class="sc-gif-imgbb-input-row">
                        <input type="text" id="sc-gif-imgbb-key" class="sc-gif-cap-input sc-gif-imgbb-input"
                            placeholder="Paste ImgBB API key…" value="${_escHtml(getKey(LS_IMGBB))}" spellcheck="false" />
                        <button id="sc-gif-imgbb-test" class="sc-gif-imgbb-test-btn" type="button">Test</button>
                    </div>
                    <span id="sc-gif-imgbb-status" class="sc-gif-imgbb-status"></span>
                </div>
```

Replace with:

```js
                <div class="sc-gif-imgbb-row" id="sc-gif-imgbb-row">
                    <button type="button" class="sc-gif-imgbb-header" id="sc-gif-imgbb-header">
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
```

- [ ] **Step 2: Add the collapse/expand CSS**

In `injectPanelCss()`'s template string, find this exact block:

```js
            .sc-gif-imgbb-row { display: flex !important; flex-direction: column !important; gap: 4px !important; }
            .sc-gif-imgbb-label { color: rgba(255,255,255,0.8) !important; font-size: 12px !important; font-weight: 500 !important; }
            .sc-gif-imgbb-input-row { display: flex !important; gap: 6px !important; }
```

Replace with:

```js
            .sc-gif-imgbb-row { display: flex !important; flex-direction: column !important; gap: 4px !important; }
            .sc-gif-imgbb-label { color: rgba(255,255,255,0.8) !important; font-size: 12px !important; font-weight: 500 !important; }
            .sc-gif-imgbb-header {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                background: transparent !important; border: none !important; padding: 0 !important;
                cursor: pointer !important; width: 100% !important; text-align: left !important;
            }
            .sc-gif-imgbb-toggle { color: rgba(255,255,255,0.5) !important; font-size: 11px !important; }
            .sc-gif-imgbb-body { display: none !important; flex-direction: column !important; gap: 4px !important; margin-top: 4px !important; }
            .sc-gif-imgbb-row.sc-gif-imgbb-open .sc-gif-imgbb-body { display: flex !important; }
            .sc-gif-imgbb-input-row { display: flex !important; gap: 6px !important; }
```

- [ ] **Step 3: Wire the collapse toggle**

Find this exact block:

```js
        const imgbbInput = $('#sc-gif-imgbb-key');
        const imgbbStatus = $('#sc-gif-imgbb-status');
        const imgbbTestBtn = $('#sc-gif-imgbb-test');
        imgbbInput.addEventListener('change', () => setKey(LS_IMGBB, imgbbInput.value.trim()));
```

Replace with:

```js
        const imgbbRow = $('#sc-gif-imgbb-row');
        const imgbbHeader = $('#sc-gif-imgbb-header');
        const imgbbToggle = $('#sc-gif-imgbb-toggle');
        imgbbHeader.addEventListener('click', () => {
            const open = imgbbRow.classList.toggle('sc-gif-imgbb-open');
            imgbbToggle.textContent = open ? '▾' : '▸';
        });

        const imgbbInput = $('#sc-gif-imgbb-key');
        const imgbbStatus = $('#sc-gif-imgbb-status');
        const imgbbTestBtn = $('#sc-gif-imgbb-test');
        imgbbInput.addEventListener('change', () => setKey(LS_IMGBB, imgbbInput.value.trim()));
```

- [ ] **Step 4: Make the result view omit Upload when no key is saved**

Find this exact block:

```js
                result.innerHTML =
                    `<img src="${_gifResultUrl}" alt="GIF preview">` +
                    `<div id="sc-gif-actions">` +
                    `<a id="sc-gif-dl" href="${_gifResultUrl}" download="${fname}">⬇ Download</a>` +
                    `<button id="sc-gif-upload" type="button">☁ Upload</button>` +
                    `<span id="sc-gif-size">${kb} KB</span></div>` +
                    `<div id="sc-gif-link"></div>`;
                setStatus('Done.');

                const uploadBtn = $('#sc-gif-upload');
                if (uploadBtn) uploadBtn.addEventListener('click', async () => {
```

Replace with:

```js
                const hasImgbbKey = !!getKey(LS_IMGBB);
                result.innerHTML =
                    `<img src="${_gifResultUrl}" alt="GIF preview">` +
                    `<div id="sc-gif-actions">` +
                    `<a id="sc-gif-dl" href="${_gifResultUrl}" download="${fname}">⬇ Download</a>` +
                    (hasImgbbKey ? `<button id="sc-gif-upload" type="button">☁ Upload</button>` : '') +
                    `<span id="sc-gif-size">${kb} KB</span></div>` +
                    (hasImgbbKey ? `<div id="sc-gif-link"></div>` : '');
                setStatus('Done.');

                const uploadBtn = hasImgbbKey ? $('#sc-gif-upload') : null;
                if (uploadBtn) uploadBtn.addEventListener('click', async () => {
```

- [ ] **Step 5: Verify syntax**

Run: `node --check cytube.gifmaker.user.js`
Expected: no output, exit code 0.

- [ ] **Step 6: Self-review (no browser available — trace the code instead)**

For each point, read the relevant code and confirm, noting what you traced:

1. Confirm `.sc-gif-imgbb-body` starts hidden (`display: none`) and only becomes visible via the `.sc-gif-imgbb-row.sc-gif-imgbb-open .sc-gif-imgbb-body` rule — trace that no other code path adds `sc-gif-imgbb-open` on panel open, so every panel open starts collapsed regardless of whether a key is saved.
2. Confirm `imgbbInput`/`imgbbStatus`/`imgbbTestBtn`'s existing `change`/`click` listeners are completely untouched by this diff — the only thing that changed is that their parent container can be hidden via CSS; the elements and their ids are unchanged.
3. Confirm the toggle handler only touches `imgbbRow`'s class list and `imgbbToggle`'s text — it must not touch `startT`/`endT`/`render`/anything trim-related; this is a pure UI-visibility toggle with zero interaction with the rest of the panel's state.
4. Confirm `hasImgbbKey` is computed once, at the moment the GIF finishes encoding (right where `_gifResultUrl`/`kb`/`slug`/`fnameBase`/`fname` are also computed) — not read again later in a way that could go stale within the same result render.
5. Trace both branches of the result HTML: with `hasImgbbKey = true`, confirm the output is byte-identical to what this file produced before this change (Upload button + link box both present). With `hasImgbbKey = false`, confirm neither `#sc-gif-upload` nor `#sc-gif-link` appear anywhere in the rendered HTML.
6. Confirm `uploadBtn` is `null` (not a `document.querySelector` miss on a real element) when `hasImgbbKey` is false, so `if (uploadBtn)` correctly skips wiring a click listener that has nothing to attach to.
7. Confirm the untouched inner `if (!apiKey) { ... return; }` check inside the upload click handler body is still present and unreachable-but-harmless in the common case (defensive fallback, not dead code that breaks anything) — grep to confirm that block wasn't accidentally deleted or altered.

- [ ] **Step 7: Commit**

```bash
git add cytube.gifmaker.user.js
git commit -m "Make the ImgBB key section collapsible and hide Upload when no key is saved"
```
