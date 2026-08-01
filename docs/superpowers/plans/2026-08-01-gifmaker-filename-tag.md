# GIF Maker Filename Timestamp and Custom Tag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the epoch-millisecond timestamp in generated GIF filenames with the clip's actual position in the movie (hour/minute/second), and add an optional custom tag field that appends to the end of the filename.

**Architecture:** A new pure formatting function (`_fmtFilenameTimestamp`) alongside the existing `_fmtClockTenths`, a new small text input in the panel, and a one-line change to how `fnameBase` is built in the Make-GIF success path — all in `cytube.gifmaker.user.js`. No changes to capture/encode/upload logic itself, only to the string used for the downloaded/uploaded filename.

**Tech Stack:** Tampermonkey userscript (vanilla JS, no build step).

## Global Constraints

- No automated test framework in this repo — verification is `node --check cytube.gifmaker.user.js` (syntax only) plus a code-reading self-review.
- `_fmtClockTenths` (used for on-screen timecode display, e.g. `"1:23.4"`) is unchanged and not reused for the filename — colons and decimal points are legal in that context but the filename needs a distinct, filesystem-safe format.
- New format: `_fmtFilenameTimestamp(sec)` → zero-padded `HHhMMmSSs` (e.g. a clip starting at 1 hour 23 minutes 45 seconds into the video → `01h23m45s`), always includes the hours segment (even `00h`) for consistent, sortable filenames regardless of video length.
- The timestamp reflects the clip's **start** position (`startT`, the same variable already used throughout `openGifPanel()` for the trim start), not the time the GIF was generated.
- The custom tag field is optional (empty by default), sanitized with the same pattern `gifTitleSlug()` already uses (`replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '')`) before being appended, and — like the tag being about output naming rather than clip editing — lives outside the collapsible Captions & Format section so it stays visible and editable across repeated Make-GIF attempts without needing to reopen that section.
- Filename shape becomes: `<title-slug>-<HHhMMmSSs>[-<tag>].gif` (tag segment omitted entirely, no trailing dash, when the tag field is empty) — matches the existing fallback-to-`'gif'` behavior when there's no title slug.

---

### Task 1: Timestamp-based filename + custom tag field

**Files:**
- Modify: `cytube.gifmaker.user.js` (new helper function, CSS, HTML, and the `fnameBase` line in `openGifPanel()`)

**Interfaces:**
- Produces: `_fmtFilenameTimestamp(sec) → string`.
- Consumes: `startT` (existing, in scope inside `openGifPanel()`), `gifTitleSlug()` (existing, unchanged).

- [ ] **Step 1: Add the filename-timestamp formatter next to `_fmtClockTenths`**

Find this exact block:
```js
    function _fmtClockTenths(sec) {
        sec = Math.max(0, sec);
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
    }
```
Replace with:
```js
    function _fmtClockTenths(sec) {
        sec = Math.max(0, sec);
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
    }
    function _fmtFilenameTimestamp(sec) {
        sec = Math.max(0, Math.round(sec));
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        const pad = n => String(n).padStart(2, '0');
        return pad(h) + 'h' + pad(m) + 'm' + pad(s) + 's';
    }
```

- [ ] **Step 2: Add CSS for the tag row**

Find this exact block:
```js
            .sc-gif-cap-input {
```
Replace with:
```js
            .sc-gif-tag-row { display: flex !important; align-items: center !important; gap: 8px !important; }
            .sc-gif-tag-row label { color: rgba(244,244,242,0.62) !important; font-size: 12px !important; font-weight: 500 !important; flex: none !important; }
            .sc-gif-tag-input { flex: 1 1 auto !important; width: auto !important; }
            .sc-gif-cap-input {
```

- [ ] **Step 3: Add the tag input HTML, outside the collapsible section**

Find this exact block:
```js
                </div>
                <div id="sc-gif-status"></div>
                <div id="sc-gif-result"></div>
                <button id="sc-gif-go" type="button">● Make GIF</button>
```
Replace with:
```js
                </div>
                <div class="sc-gif-tag-row">
                    <label for="sc-gif-tag">Tag</label>
                    <input type="text" id="sc-gif-tag" class="sc-gif-cap-input sc-gif-tag-input" placeholder="optional, appended to filename" maxlength="40">
                </div>
                <div id="sc-gif-status"></div>
                <div id="sc-gif-result"></div>
                <button id="sc-gif-go" type="button">● Make GIF</button>
```

- [ ] **Step 4: Use the new timestamp and tag when building the filename**

Find this exact block:
```js
                const slug = gifTitleSlug();
                const fnameBase = (slug || 'gif') + '-' + Date.now();
                const fname = fnameBase + '.gif';
```
Replace with:
```js
                const slug = gifTitleSlug();
                const tag = $('#sc-gif-tag').value.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
                const fnameBase = (slug || 'gif') + '-' + _fmtFilenameTimestamp(startT) + (tag ? '-' + tag : '');
                const fname = fnameBase + '.gif';
```

- [ ] **Step 5: Verify syntax**

Run: `node --check cytube.gifmaker.user.js`
Expected: no output, exit code 0.

- [ ] **Step 6: Self-review**

Trace through and confirm:
1. `_fmtFilenameTimestamp(0)` → `"00h00m00s"`; `_fmtFilenameTimestamp(5025)` (1h 23m 45s) → `"01h23m45s"`; confirm the math by hand: `5025 / 3600 = 1` (floor), `5025 % 3600 = 1425`, `1425 / 60 = 23` (floor), `1425 % 60 = 45` — matches.
2. `_fmtClockTenths` itself is completely unchanged — only a new, separate function was added after it.
3. `$('#sc-gif-tag')` resolves correctly — `$` is the existing `panel.querySelector` helper already used throughout `openGifPanel()`, and `#sc-gif-tag` exists in the Step 3 HTML.
4. With the tag field left empty, `tag` evaluates to `''`, so `(tag ? '-' + tag : '')` contributes nothing — filenames are `<slug>-<timestamp>.gif`, no trailing dash or empty segment.
5. With a tag like `"my Cool Tag!!"` entered, sanitization produces `"my-cool-tag"` (same pattern as `gifTitleSlug`), appended as `<slug>-<timestamp>-my-cool-tag.gif`.
6. The tag input sits between the collapsible `.sc-gif-cols`/`#sc-gif-mid-body`'s closing `</div>` and `#sc-gif-status` — outside the collapsible section, so it stays visible and its value persists across multiple Make-GIF clicks without needing to reopen anything.
7. `fnameBase` (used for both the download filename and, unchanged, passed to `uploadToImgbb(blob, apiKey, fnameBase)`) picks up the new format for both download and upload — no separate fix needed for the upload path since it already reuses `fnameBase`.
8. No unrelated line was touched — this diff should be exactly the 4 edits above.

- [ ] **Step 7: Manual browser verification**

Load the userscript in a Tampermonkey dev profile against a live CyTube video (`420Grindhouse` or `testing` room). Open the GIF Maker, set the trim to a spot well into the video (e.g. past the 1-minute mark), leave the Tag field empty, click Make GIF, and confirm the Download link's filename encodes the clip's actual position in the video (not the current wall-clock time) in `HHhMMmSSs` form. Then enter a tag like "reaction" and generate again — confirm the filename now ends with `-reaction.gif`. If an ImgBB key is configured, Upload once with a tag set and confirm the uploaded image's name (visible in the ImgBB response/link, if shown) reflects the same base name.

- [ ] **Step 8: Commit**

```bash
git add cytube.gifmaker.user.js
git commit -m "Use clip position (not epoch time) and an optional custom tag in GIF filenames"
```
