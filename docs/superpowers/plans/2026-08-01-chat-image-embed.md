# Chat Image Link Auto-Embed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a chat message contains a direct image link (e.g. `https://i.postimg.cc/bJ0Q40QG/Twins-Said-No.gif`), show a clickable thumbnail of the actual image under the message, labeled "🖼 embedded" so it's clear it was auto-generated rather than part of the original message.

**Architecture:** A `MutationObserver` on `#messagebuffer` (mirroring the existing `startUserColorObserver` pattern) scans each chat message div for `<a>` tags CyTube already auto-linkifies, and appends a thumbnail block for any that end in an image extension. A new Settings Modal checkbox gates whether new embeds are created. Everything lives in `cytube.pc.user.js` — no changes to `cytube.androidTV.user.js` or `cytube.gifmaker.user.js`.

**Tech Stack:** Tampermonkey userscript (vanilla JS, no build step, no bundler).

## Global Constraints

- No automated test framework in this repo — verification is `node --check cytube.pc.user.js` (syntax only) plus a code-reading self-review plus manual browser verification.
- Detection regex: `/\.(jpe?g|png|gif|webp|bmp)(\?[^\s"']*)?$/i` — anchored to end-of-string (optionally followed by a `?query`), case-insensitive.
- Detection works only off `<a href>` tags already present inside the rendered message div (CyTube auto-linkifies `http(s)://` URLs before the div is appended) — no separate raw-text URL scanning.
- Each processed `<a>` gets `dataset.scEmbedded = '1'` so it's never re-processed (the observer's `subtree: true` means appending our own embed div re-fires it — this flag is what keeps that safe/idempotent, same tradeoff `applyUserColors` already accepts by re-running on every buffer mutation).
- Thumbnail height is read live from `document.querySelector('#messagebuffer .emote')`'s rendered `getBoundingClientRect().height`, falling back to `48px` if no emote is present yet in the buffer. `.emote` is CyTube's own class for rendered inline emote images; if a future CyTube version renders emotes under a different class, this silently falls back to the 48px default rather than erroring — sizing is a visual nicety, not a correctness requirement.
- New localStorage key `sc_autoembed_images`, default **on** (`getKey(...) !== 'off'`), matching the existing default-on toggles (`spellCheckEnabled`, `movieLinksEnabled`, `gifOptimizeEnabled`).
- Turning the toggle off only stops new embeds; already-rendered embeds are left in place (same non-retroactive behavior as every other toggle in this settings modal).
- On failed image load (`img.onerror`), the whole embed block is removed — no broken-image icon, original message text is untouched.
- Follow the file's existing CSS convention of `!important` on every declaration inside the injected `<style>` block (used throughout to override CyTube's own stylesheet).

---

### Task 1: Add auto-embed detection, rendering, settings toggle, and wiring

**Files:**
- Modify: `cytube.pc.user.js` (constants, new "CHAT IMAGE EMBEDS" section, CSS, Settings Modal HTML, Settings Modal save handler, boot wiring)

**Interfaces:**
- Produces: `autoEmbedEnabled() → boolean`, `emoteInlineHeight() → number`, `findImageLinks(msgEl) → HTMLAnchorElement[]`, `embedImagesIn(msgEl) → void`, `scanImageEmbeds(buf) → void`, `startImageEmbedObserver() → void`.
- Consumes: `getKey`/`setKey` (existing, `cytube.pc.user.js:38-39`), the existing `#messagebuffer` DOM element and `[class*="chat-msg-"]` message-row convention already used by `applyUserColors` (`cytube.pc.user.js:1652-1659`).

- [ ] **Step 1: Add the `LS_AUTOEMBED` constant and `autoEmbedEnabled()` helper**

Find this exact block:
```js
    const LS_GIF_OPTIMIZE = 'sc_gif_optimize'; // shared with cytube.gifmaker.user.js
    const getKey   = id => localStorage.getItem(id) || '';
    const setKey   = (id, v) => localStorage.setItem(id, v.trim());
    const hasKey   = id => !!getKey(id);
    const spellCheckEnabled  = () => getKey(LS_SPELLCHECK)  !== 'off';
    const movieLinksEnabled  = () => getKey(LS_MOVIE_LINKS) !== 'off';
    const lineupTimingEnabled = () => getKey(LS_LINEUP_TIMING) === 'on'; // opt-in, unlike the toggles above
    const gifOptimizeEnabled = () => getKey(LS_GIF_OPTIMIZE) !== 'off'; // default ON, like spellcheck/movielinks
```
Replace with:
```js
    const LS_GIF_OPTIMIZE = 'sc_gif_optimize'; // shared with cytube.gifmaker.user.js
    const LS_AUTOEMBED   = 'sc_autoembed_images';
    const getKey   = id => localStorage.getItem(id) || '';
    const setKey   = (id, v) => localStorage.setItem(id, v.trim());
    const hasKey   = id => !!getKey(id);
    const spellCheckEnabled  = () => getKey(LS_SPELLCHECK)  !== 'off';
    const movieLinksEnabled  = () => getKey(LS_MOVIE_LINKS) !== 'off';
    const lineupTimingEnabled = () => getKey(LS_LINEUP_TIMING) === 'on'; // opt-in, unlike the toggles above
    const gifOptimizeEnabled = () => getKey(LS_GIF_OPTIMIZE) !== 'off'; // default ON, like spellcheck/movielinks
    const autoEmbedEnabled  = () => getKey(LS_AUTOEMBED) !== 'off'; // default ON, like spellcheck/movielinks
```

- [ ] **Step 2: Add the CHAT IMAGE EMBEDS section, right after the USER COLOR SYSTEM section**

Find this exact block:
```js
    let _colorObserverStarted = false;
    function startUserColorObserver() {
        const buf = document.getElementById('messagebuffer');
        if (!buf) return;
        if (_colorObserverStarted) { applyUserColors(); return; }
        _colorObserverStarted = true;
        new MutationObserver(applyUserColors).observe(buf, { childList: true, subtree: true });
        applyUserColors();
    }

    /* ==========================================================
       SETTINGS MODAL
```
Replace with:
```js
    let _colorObserverStarted = false;
    function startUserColorObserver() {
        const buf = document.getElementById('messagebuffer');
        if (!buf) return;
        if (_colorObserverStarted) { applyUserColors(); return; }
        _colorObserverStarted = true;
        new MutationObserver(applyUserColors).observe(buf, { childList: true, subtree: true });
        applyUserColors();
    }

    /* ==========================================================
       CHAT IMAGE EMBEDS
       Direct image links posted in chat (postimg.cc, imgur, discord
       cdn, etc.) get a thumbnail preview appended under the message,
       reusing the <a> tags CyTube already auto-linkifies out of the
       raw message text. Sized to match the channel's own emote
       height so it doesn't dominate the narrow chat column.
    ========================================================== */
    const IMAGE_LINK_RE = /\.(jpe?g|png|gif|webp|bmp)(\?[^\s"']*)?$/i;

    function emoteInlineHeight() {
        const el = document.querySelector('#messagebuffer .emote');
        const h = el && el.getBoundingClientRect().height;
        return (h && h > 4) ? Math.round(h) : 48; // fallback until a real emote has rendered
    }

    function findImageLinks(msgEl) {
        return [...msgEl.querySelectorAll('a[href]')]
            .filter(a => !a.dataset.scEmbedded && !a.closest('.sc-img-embed') && IMAGE_LINK_RE.test(a.href));
    }

    function embedImagesIn(msgEl) {
        findImageLinks(msgEl).forEach(a => {
            a.dataset.scEmbedded = '1';
            const wrap = document.createElement('div');
            wrap.className = 'sc-img-embed';
            const link = document.createElement('a');
            link.href = a.href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            const img = document.createElement('img');
            img.loading = 'lazy';
            img.style.maxHeight = emoteInlineHeight() + 'px';
            img.onerror = () => wrap.remove();
            img.src = a.href;
            link.appendChild(img);
            const badge = document.createElement('span');
            badge.className = 'sc-img-embed-badge';
            badge.textContent = '🖼 embedded';
            wrap.appendChild(link);
            wrap.appendChild(badge);
            msgEl.appendChild(wrap);
        });
    }

    function scanImageEmbeds(buf) {
        if (!autoEmbedEnabled()) return;
        buf.querySelectorAll('[class*="chat-msg-"]').forEach(embedImagesIn);
    }

    let _imageEmbedObserverStarted = false;
    function startImageEmbedObserver() {
        const buf = document.getElementById('messagebuffer');
        if (!buf) return;
        if (_imageEmbedObserverStarted) { scanImageEmbeds(buf); return; }
        _imageEmbedObserverStarted = true;
        new MutationObserver(() => scanImageEmbeds(buf)).observe(buf, { childList: true, subtree: true });
        scanImageEmbeds(buf);
    }

    /* ==========================================================
       SETTINGS MODAL
```

- [ ] **Step 3: Add CSS for the embed block, right after `#messagebuffer`'s rule**

Find this exact block:
```js
            /* ===== SHARED CHAT ELEMENTS ===== */
            #messagebuffer {
                flex: 1 !important; height: auto !important;
                background: transparent !important; color: white !important;
                font-size: 14px !important; overflow-y: auto !important; padding-bottom: 5px !important;
            }
```
Replace with:
```js
            /* ===== SHARED CHAT ELEMENTS ===== */
            #messagebuffer {
                flex: 1 !important; height: auto !important;
                background: transparent !important; color: white !important;
                font-size: 14px !important; overflow-y: auto !important; padding-bottom: 5px !important;
            }
            .sc-img-embed { display: block !important; margin-top: 4px !important; }
            .sc-img-embed img {
                display: block !important;
                max-width: 100% !important;
                border-radius: 4px !important;
                cursor: pointer !important;
            }
            .sc-img-embed-badge {
                display: block !important;
                font-size: 10px !important;
                color: rgba(244,244,242,0.45) !important;
                margin-top: 2px !important;
            }
```

- [ ] **Step 4: Add the Settings Modal checkbox**

Find this exact block:
```js
                <div class="sc-settings-group sc-settings-toggle-group">
                    <label class="sc-settings-toggle-label">
                        <span class="sc-toggle-row">
                            <input type="checkbox" id="sc-input-movielinks" ${movieLinksEnabled() ? 'checked' : ''} />
                            <span class="sc-toggle-text">Show movie links (IMDb / Letterboxd / Wiki)</span>
                        </span>
                        <span class="sc-settings-note">Adds clickable badge icons next to the title</span>
                    </label>
                </div>

                <div class="sc-settings-group sc-settings-toggle-group">
                    <label class="sc-settings-toggle-label">
                        <span class="sc-toggle-row">
                            <input type="checkbox" id="sc-input-gifoptimize" ${gifOptimizeEnabled() ? 'checked' : ''} />
```
Replace with:
```js
                <div class="sc-settings-group sc-settings-toggle-group">
                    <label class="sc-settings-toggle-label">
                        <span class="sc-toggle-row">
                            <input type="checkbox" id="sc-input-movielinks" ${movieLinksEnabled() ? 'checked' : ''} />
                            <span class="sc-toggle-text">Show movie links (IMDb / Letterboxd / Wiki)</span>
                        </span>
                        <span class="sc-settings-note">Adds clickable badge icons next to the title</span>
                    </label>
                </div>

                <div class="sc-settings-group sc-settings-toggle-group">
                    <label class="sc-settings-toggle-label">
                        <span class="sc-toggle-row">
                            <input type="checkbox" id="sc-input-autoembed" ${autoEmbedEnabled() ? 'checked' : ''} />
                            <span class="sc-toggle-text">Auto-embed image links in chat</span>
                        </span>
                        <span class="sc-settings-note">Shows a thumbnail preview under messages that link directly to an image, marked "🖼 embedded"</span>
                    </label>
                </div>

                <div class="sc-settings-group sc-settings-toggle-group">
                    <label class="sc-settings-toggle-label">
                        <span class="sc-toggle-row">
                            <input type="checkbox" id="sc-input-gifoptimize" ${gifOptimizeEnabled() ? 'checked' : ''} />
```

- [ ] **Step 5: Wire the checkbox into the Settings Modal save handler**

Find this exact block:
```js
            const gifOptimize = document.getElementById('sc-input-gifoptimize').checked;
            const imgbb  = document.getElementById('sc-input-imgbb').value.trim();
            const fontPx = parseInt(fontInput.value, 10);
            setKey(LS_TMDB,        tmdb);
            setKey(LS_SPELLCHECK,  spell ? 'on' : 'off');
            setKey(LS_MOVIE_LINKS, links ? 'on' : 'off');
            setKey(LS_LINEUP_TIMING, lineupTiming ? 'on' : 'off');
            setKey(LS_GIF_OPTIMIZE, gifOptimize ? 'on' : 'off');
            setKey(LS_IMGBB,       imgbb);
```
Replace with:
```js
            const gifOptimize = document.getElementById('sc-input-gifoptimize').checked;
            const autoEmbed = document.getElementById('sc-input-autoembed').checked;
            const imgbb  = document.getElementById('sc-input-imgbb').value.trim();
            const fontPx = parseInt(fontInput.value, 10);
            setKey(LS_TMDB,        tmdb);
            setKey(LS_SPELLCHECK,  spell ? 'on' : 'off');
            setKey(LS_MOVIE_LINKS, links ? 'on' : 'off');
            setKey(LS_LINEUP_TIMING, lineupTiming ? 'on' : 'off');
            setKey(LS_GIF_OPTIMIZE, gifOptimize ? 'on' : 'off');
            setKey(LS_AUTOEMBED,   autoEmbed ? 'on' : 'off');
            setKey(LS_IMGBB,       imgbb);
```

- [ ] **Step 6: Start the observer from the boot sequence**

Find this exact block:
```js
            applyInputMode();
            installChatTextarea();
            relocateEmoteButton();
            addFloatingButtons();
            addSettingsButton();
            startUserColorObserver();
```
Replace with:
```js
            applyInputMode();
            installChatTextarea();
            relocateEmoteButton();
            addFloatingButtons();
            addSettingsButton();
            startUserColorObserver();
            startImageEmbedObserver();
```

- [ ] **Step 7: Verify syntax**

Run: `node --check cytube.pc.user.js`
Expected: no output, exit code 0.

- [ ] **Step 8: Self-review**

Trace through and confirm:
1. `IMAGE_LINK_RE` matches `https://i.postimg.cc/bJ0Q40QG/Twins-Said-No.gif` (ends in `.gif`, no query string) and `https://example.com/x.PNG?foo=bar` (case-insensitive, `?query` allowed), but not `https://example.com/page?ref=photo.png.html` (string ends in `.html`, not `.png` or `.png?...`).
2. `findImageLinks` only returns anchors without `dataset.scEmbedded` set — so re-running `scanImageEmbeds` (e.g. triggered by the observer firing again when `embedImagesIn` appends `wrap` into the observed subtree) is a no-op for already-processed links, not an infinite loop or duplicate-embed bug.
3. `embedImagesIn` appends the new `.sc-img-embed` block as a sibling structure inside `msgEl`, alongside (not replacing) the originally matched `<a>`. That embed contains its own `<a href>` pointing at the same image URL — without the `!a.closest('.sc-img-embed')` clause in `findImageLinks`, the next `scanImageEmbeds` pass (re-triggered by the observer firing on the very mutation that appended the embed) would match that inner anchor too and nest a duplicate embed inside it. The clause in Step 2's `findImageLinks` excludes any anchor already inside a `.sc-img-embed`, so this can't happen — confirm it's present in the code as written, not just described here.
4. `emoteInlineHeight()` never throws when no `.emote` element exists yet (`el` is `null`, `el && ...` short-circuits to `undefined`, falls to the `48` fallback).
5. `img.onerror` is assigned before `img.src` in Step 2's actual code — confirm the written code keeps that order (it does: `img.loading`, then `img.style.maxHeight`, then `img.onerror`, then `img.src` last) so a synchronously-failing `src` (e.g. malformed URL) can't fire before the handler exists.
6. `scanImageEmbeds` checks `autoEmbedEnabled()` once per call — toggling the setting off mid-session stops future scans (new messages) but doesn't touch embeds already appended, matching the spec.
7. `startImageEmbedObserver` follows `startUserColorObserver`'s exact idempotency guard shape (`_imageEmbedObserverStarted` flag), so calling it repeatedly from the `bootObserver` callback (which re-fires on every body mutation until disconnected) is safe.
8. No unrelated line was touched — this diff should be exactly the 6 edits described in Steps 1-6.

- [ ] **Step 9: Manual browser verification**

Load the userscript in a Tampermonkey dev profile against a live CyTube room (`420Grindhouse` or `testing`).
1. Post `https://i.postimg.cc/bJ0Q40QG/Twins-Said-No.gif` in chat — within a moment, a thumbnail appears under the message with the "🖼 embedded" caption underneath it, roughly the same height as an emote in the chat.
2. Click the thumbnail — the full image opens in a new tab.
3. Post a link to a URL that returns a 404 or isn't actually an image (e.g. mistype the postimg path) — no broken-image icon appears; the embed silently doesn't show, and the original message/link text is unaffected.
4. Reload the page so the message above is now backlog (already in `#messagebuffer` on load, not a freshly-arriving `chatMsg`) — confirm it's still shown embedded after reload, proving the initial `scanImageEmbeds(buf)` call (not just the observer) picks up backlog.
5. Open Settings (⚙), uncheck "Auto-embed image links in chat", Save. Post a new image link — no embed appears. Confirm the embed from step 1 is still visible (toggling off doesn't remove existing embeds). Re-check the setting, Save, post another image link — it embeds again.
6. Post a message containing two different image links — confirm both get their own thumbnail + badge, in order.

- [ ] **Step 10: Commit**

```bash
git add cytube.pc.user.js
git commit -m "Auto-embed direct image links posted in chat, with an embedded-image toggle in Settings"
```
