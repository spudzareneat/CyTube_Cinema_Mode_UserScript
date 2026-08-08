# Standalone Chat Images Userscript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split chat image auto-embedding out of `cytube.pc.user.js` into a new, independent userscript, `cytube.chatimages.user.js`, that always embeds when run alone and defers to `cytube.pc.user.js`'s existing Settings Modal toggle when that script is also installed — plus two new behaviors that only make sense once this is its own script: a hover tooltip showing the image's filename, and a persistent per-image ban/unban.

**Architecture:** Single self-contained userscript file (matching this repo's existing pattern — see `cytube.gifmaker.user.js`). One IIFE. A `MutationObserver` on `#messagebuffer` scans new chat messages for direct image links and appends a thumbnail embed under each; a `readPcBridge()` presence check against `unsafeWindow.__SC_GIF_BRIDGE__` (already exposed by `cytube.pc.user.js`) decides whether the shared `sc_autoembed_images` localStorage toggle is honored or ignored. `cytube.pc.user.js` loses its own copy of this feature entirely but keeps the toggle and the localStorage key it writes.

**Tech Stack:** Vanilla JS (ES2017+, matches existing scripts — no build step, no bundler), `MutationObserver`, plain `localStorage` (no `GM_*` storage APIs — same-origin, shared across userscripts on the page).

## Global Constraints

- This repo has **no automated test framework** (no `package.json`, no test runner) — every existing userscript here is verified by `node --check <file>` (catches syntax errors only; the script itself only runs in a browser) plus manual verification in Tampermonkey. Every task below follows that pattern instead of a unit-test framework.
- New file path: `C:\Repos\cytube_tv_interface_script\cytube.chatimages.user.js`.
- `@match` exactly: `https://cytu.be/r/420Grindhouse` and `https://cytu.be/r/testing` (same two channels as the other scripts). No `@grant` needed.
- Presence detection reuses `unsafeWindow.__SC_GIF_BRIDGE__` (already exposed unconditionally by `cytube.pc.user.js` once it boots, currently consumed the same way by `cytube.gifmaker.user.js`) — do not add a second bridge object; a `getTitleSlug` function on it is enough to prove `cytube.pc.user.js` is present.
- Shared localStorage key name must be exactly `sc_autoembed_images` (`LS_AUTOEMBED`) — this is what `cytube.pc.user.js`'s Settings Modal already writes.
- The ban list's localStorage key (`sc_img_banned_urls` / `LS_BANNED`) is private to this new script — do not add it to, or reference it from, `cytube.pc.user.js`.
- Ban/unban matching is **exact URL**, not filename or a normalized form — this was an explicit decision, not an oversight.
- In `cytube.pc.user.js`, `initChatSeekMenu()`'s right-click guard `if (e.target.closest && e.target.closest('.sc-img-embed')) return;` (around line 921) must be **left untouched** — it stops the chat-to-movie right-click menu from firing when right-clicking an embedded image's thumbnail, and still works correctly once `cytube.chatimages.user.js` is the one creating `.sc-img-embed` elements, since it only checks a CSS class, not who created it.

---

### Task 1: Scaffold `cytube.chatimages.user.js` — PC-mode detection + core image embedding + filename tooltip

**Files:**
- Create: `C:\Repos\cytube_tv_interface_script\cytube.chatimages.user.js`

**Interfaces:**
- Consumes: nothing (first task) — reads `unsafeWindow.__SC_GIF_BRIDGE__` if present, which is produced by the existing, unmodified `cytube.pc.user.js`.
- Produces: `LS_AUTOEMBED` (string constant), `getKey(id)`/`autoEmbedEnabled()` (localStorage helpers), `PC_MODE` (boolean), `readPcBridge()`, `embeddingEnabled()`, `IMAGE_LINK_RE`, `findImageLinks(msgEl)`, `filenameFromUrl(url)`, `rescrollChatIfNearBottom()`, `applyEmbeddedState(a)` (sets `a._scUi` to the embed `<div>` it creates), `renderLink(a)`, `scanImageEmbeds(buf)`, `startImageEmbedObserver()`, `injectStyle()` — Task 2 modifies `applyEmbeddedState`, `renderLink`, and the CSS text inside `injectStyle`; Task 2 also adds new functions near them.

- [ ] **Step 1: Write the file**

```js
// ==UserScript==
// @name         CyTube Chat Images
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Standalone auto-embed for direct image links in chat, with hover filenames and a per-image ban/unban. Works alone, or defers to cytube.pc.user.js's Settings Modal toggle when that script is also installed.
// @match        https://cytu.be/r/420Grindhouse
// @match        https://cytu.be/r/testing
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';
    console.log('[ChatImages] cytube.chatimages v1.0.0 loaded');

    /* ==========================================================
       STORAGE
    ========================================================== */
    const LS_AUTOEMBED = 'sc_autoembed_images'; // shared key -- cytube.pc.user.js's Settings Modal writes this
    const getKey = id => localStorage.getItem(id) || '';
    const autoEmbedEnabled = () => getKey(LS_AUTOEMBED) !== 'off';

    /* ==========================================================
       PC-SCRIPT DETECTION
       cytube.pc.user.js (when installed) exposes a small object on
       the real page window (via unsafeWindow -- two separate
       Tampermonkey sandboxes can't see each other's plain `window`
       properties) once it boots. Reused here purely as a presence
       signal: when found, this script honors the Settings Modal's
       auto-embed toggle; standalone, it always embeds.
    ========================================================== */
    let PC_MODE = false;
    function readPcBridge() {
        const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const b = w.__SC_GIF_BRIDGE__;
        return (b && typeof b.getTitleSlug === 'function') ? b : null;
    }
    function embeddingEnabled() {
        return PC_MODE ? autoEmbedEnabled() : true;
    }

    /* ==========================================================
       CHAT IMAGE EMBEDS
       Direct image links posted in chat (postimg.cc, imgur, discord
       cdn, etc.) get a thumbnail preview appended under the message,
       reusing the <a> tags CyTube already auto-linkifies out of the
       raw message text.
    ========================================================== */
    const IMAGE_LINK_RE = /\.(jpe?g|png|gif|webp|bmp)(\?[^\s"']*)?$/i;

    function findImageLinks(msgEl) {
        return [...msgEl.querySelectorAll('a[href]')]
            .filter(a => !a.dataset.scEmbedded
                && (a.protocol === 'http:' || a.protocol === 'https:') && IMAGE_LINK_RE.test(a.href));
    }

    function filenameFromUrl(url) {
        try {
            const seg = new URL(url).pathname.split('/').filter(Boolean).pop();
            return seg ? decodeURIComponent(seg) : url;
        } catch (e) { return url; }
    }

    // CyTube auto-scrolls the message buffer synchronously when a message is
    // appended, and separately hooks `load` on any <img> present at that time.
    // Our thumbnail is appended asynchronously (via MutationObserver), so it
    // misses both mechanisms -- rescroll manually, but only if the user hadn't
    // scrolled up to read backlog.
    function rescrollChatIfNearBottom() {
        const b = document.getElementById('messagebuffer');
        if (b && b.scrollHeight - b.scrollTop - b.clientHeight < 60) b.scrollTop = b.scrollHeight;
    }

    function applyEmbeddedState(a) {
        const msgEl = a.closest('[class*="chat-msg-"]');
        if (!msgEl) return;
        a.style.display = 'none';
        const wrap = document.createElement('div');
        wrap.className = 'sc-img-embed';
        const link = document.createElement('a');
        link.href = a.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.title = filenameFromUrl(a.href);
        img.onerror = () => { wrap.remove(); a.style.display = ''; };
        img.onload = rescrollChatIfNearBottom;
        img.src = a.href;
        link.appendChild(img);
        const badge = document.createElement('span');
        badge.className = 'sc-img-embed-badge';
        const badgeLabel = document.createElement('span');
        badgeLabel.textContent = '🖼 embedded';
        const toggleBtn = document.createElement('span');
        toggleBtn.className = 'sc-img-embed-toggle';
        toggleBtn.textContent = '🔗';
        toggleBtn.title = 'Show link instead of image';
        toggleBtn.addEventListener('click', () => {
            const showingImage = link.style.display !== 'none';
            link.style.display = showingImage ? 'none' : '';
            a.style.display = showingImage ? '' : 'none';
            badgeLabel.textContent = showingImage ? '🔗 link only' : '🖼 embedded';
            toggleBtn.title = showingImage ? 'Show image instead of link' : 'Show link instead of image';
        });
        badge.appendChild(badgeLabel);
        badge.appendChild(toggleBtn);
        wrap.appendChild(link);
        wrap.appendChild(badge);
        msgEl.appendChild(wrap);
        a._scUi = wrap;
        rescrollChatIfNearBottom();
    }

    function renderLink(a) {
        a.dataset.scEmbedded = '1';
        applyEmbeddedState(a);
    }

    function scanImageEmbeds(buf) {
        if (!embeddingEnabled()) return;
        buf.querySelectorAll('[class*="chat-msg-"]').forEach(msgEl => {
            findImageLinks(msgEl).forEach(renderLink);
        });
    }

    let _observerStarted = false;
    function startImageEmbedObserver() {
        const buf = document.getElementById('messagebuffer');
        if (!buf) { requestAnimationFrame(startImageEmbedObserver); return; }
        if (_observerStarted) return;
        _observerStarted = true;
        new MutationObserver(() => scanImageEmbeds(buf)).observe(buf, { childList: true, subtree: true });
        scanImageEmbeds(buf);
    }

    /* ==========================================================
       CSS
    ========================================================== */
    function injectStyle() {
        const style = document.createElement('style');
        style.textContent = `
            .sc-img-embed { display: block !important; margin-top: 4px !important; }
            .sc-img-embed img {
                display: block !important;
                max-width: 100% !important;
                max-height: 150px !important;
                width: auto !important;
                height: auto !important;
                border-radius: 4px !important;
                cursor: pointer !important;
            }
            .sc-img-embed-badge {
                display: flex !important;
                align-items: center !important;
                gap: 5px !important;
                font-size: 10px !important;
                color: rgba(244,244,242,0.45) !important;
                margin-top: 2px !important;
            }
            .sc-img-embed-toggle {
                cursor: pointer !important;
                font-size: 11px !important;
                opacity: 0.6 !important;
                line-height: 1 !important;
            }
            .sc-img-embed-toggle:hover { opacity: 1 !important; }
        `;
        document.head.appendChild(style);
    }

    /* ==========================================================
       BOOT
    ========================================================== */
    const PC_BRIDGE_POLL_MS = 50;
    const PC_BRIDGE_POLL_TIMEOUT_MS = 1500;

    function waitForBody() {
        if (!document.body) { requestAnimationFrame(waitForBody); return; }

        injectStyle();
        if (readPcBridge()) PC_MODE = true;
        startImageEmbedObserver();

        if (!PC_MODE) {
            // cytube.pc.user.js may still be loading -- both scripts run at
            // document-start with no guaranteed order. Poll briefly; if it
            // shows up late, embeddingEnabled() just starts respecting its
            // toggle on the next scan (per-link idempotency via
            // dataset.scEmbedded makes this safe -- nothing already
            // rendered needs to be redone).
            let elapsed = 0;
            const pollTimer = setInterval(() => {
                elapsed += PC_BRIDGE_POLL_MS;
                if (readPcBridge()) { PC_MODE = true; clearInterval(pollTimer); }
                else if (elapsed >= PC_BRIDGE_POLL_TIMEOUT_MS) clearInterval(pollTimer);
            }, PC_BRIDGE_POLL_MS);
        }
    }

    waitForBody();
})();
```

- [ ] **Step 2: Verify syntax**

Run: `node --check cytube.chatimages.user.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Manual verification in Tampermonkey (standalone, no `cytube.pc.user.js`)**

1. In Tampermonkey, make sure `cytube.pc.user.js` is **disabled** (or not installed) for this check.
2. Open Tampermonkey's dashboard → **Create a new script** → replace the placeholder with the full contents of `cytube.chatimages.user.js` → save.
3. Navigate to `https://cytu.be/r/testing`.
4. Open the browser console, confirm you see `[ChatImages] cytube.chatimages v1.0.0 loaded`.
5. Post a direct image link in chat (any `.jpg`/`.png`/`.gif`/`.webp`/`.bmp` URL — the postimg.cc/imgur/discord-CDN kind this channel already gets). Confirm a thumbnail appears under the message with a "🖼 embedded" badge and a 🔗 toggle icon.
6. Hover the thumbnail — confirm the browser's native tooltip shows the image's filename (the last path segment of the URL).
7. Click the 🔗 icon — confirm it flips to showing the plain link instead of the image, and back again on a second click.
8. Reload the page with that message still in backlog — confirm it re-embeds on load, not just for new messages.
9. Post a broken/dead image URL (one that 404s) — confirm the embed silently reverts to a plain link (via `img.onerror`) instead of showing a broken-image icon.

- [ ] **Step 4: Commit**

```bash
git add cytube.chatimages.user.js
git commit -m "Scaffold standalone chat-images userscript with core embedding and filename tooltip"
```

---

### Task 2: Ban / unban with buffer-wide sweep

**Files:**
- Modify: `cytube.chatimages.user.js` (edits to the file from Task 1)

**Interfaces:**
- Consumes: `getKey` (Task 1), `applyEmbeddedState(a)` (Task 1 — gains a third badge icon and is now also called by `unbanUrl`), `renderLink(a)` (Task 1 — gains a banned-state branch).
- Produces: `LS_BANNED`, `getBannedUrls()`, `saveBannedUrls(set)`, `isBanned(url)`, `applyBannedState(a)` (sets `a._scUi` to the badge `<span>` it creates), `sweepUrl(url, applyFn)`, `banUrl(url)`, `unbanUrl(url)`.

- [ ] **Step 1: Add the ban-list storage helpers**

In `cytube.chatimages.user.js`, find this exact block (from Task 1):

```js
    const LS_AUTOEMBED = 'sc_autoembed_images'; // shared key -- cytube.pc.user.js's Settings Modal writes this
    const getKey = id => localStorage.getItem(id) || '';
    const autoEmbedEnabled = () => getKey(LS_AUTOEMBED) !== 'off';
```

Replace it with:

```js
    const LS_AUTOEMBED = 'sc_autoembed_images'; // shared key -- cytube.pc.user.js's Settings Modal writes this
    const LS_BANNED    = 'sc_img_banned_urls';  // private to this script -- JSON array of exact banned URLs
    const getKey = id => localStorage.getItem(id) || '';
    const autoEmbedEnabled = () => getKey(LS_AUTOEMBED) !== 'off';

    function getBannedUrls() {
        try { return new Set(JSON.parse(getKey(LS_BANNED) || '[]')); }
        catch (e) { return new Set(); }
    }
    function saveBannedUrls(set) { localStorage.setItem(LS_BANNED, JSON.stringify([...set])); }
    function isBanned(url) { return getBannedUrls().has(url); }
```

- [ ] **Step 2: Add the 🚫 ban icon to the embedded badge**

Find this exact block:

```js
        toggleBtn.addEventListener('click', () => {
            const showingImage = link.style.display !== 'none';
            link.style.display = showingImage ? 'none' : '';
            a.style.display = showingImage ? '' : 'none';
            badgeLabel.textContent = showingImage ? '🔗 link only' : '🖼 embedded';
            toggleBtn.title = showingImage ? 'Show image instead of link' : 'Show link instead of image';
        });
        badge.appendChild(badgeLabel);
        badge.appendChild(toggleBtn);
```

Replace it with:

```js
        toggleBtn.addEventListener('click', () => {
            const showingImage = link.style.display !== 'none';
            link.style.display = showingImage ? 'none' : '';
            a.style.display = showingImage ? '' : 'none';
            badgeLabel.textContent = showingImage ? '🔗 link only' : '🖼 embedded';
            toggleBtn.title = showingImage ? 'Show image instead of link' : 'Show link instead of image';
        });
        const banBtn = document.createElement('span');
        banBtn.className = 'sc-img-embed-ban';
        banBtn.textContent = '🚫';
        banBtn.title = "Hide this image everywhere and don't embed it again";
        banBtn.addEventListener('click', () => banUrl(a.href));
        badge.appendChild(badgeLabel);
        badge.appendChild(toggleBtn);
        badge.appendChild(banBtn);
```

- [ ] **Step 3: Add the banned-state renderer, sweep, and ban/unban functions; branch `renderLink` on ban state**

Find this exact block:

```js
    function renderLink(a) {
        a.dataset.scEmbedded = '1';
        applyEmbeddedState(a);
    }
```

Replace it with:

```js
    function applyBannedState(a) {
        const msgEl = a.closest('[class*="chat-msg-"]');
        if (!msgEl) return;
        a.style.display = '';
        const badge = document.createElement('span');
        badge.className = 'sc-img-embed-badge sc-img-embed-banned';
        const label = document.createElement('span');
        label.textContent = '🚫 image hidden';
        const unbanBtn = document.createElement('span');
        unbanBtn.className = 'sc-img-embed-unban';
        unbanBtn.textContent = '↩ unban';
        unbanBtn.title = 'Show this image again';
        unbanBtn.addEventListener('click', () => unbanUrl(a.href));
        badge.appendChild(label);
        badge.appendChild(unbanBtn);
        msgEl.appendChild(badge);
        a._scUi = badge;
    }

    function sweepUrl(url, applyFn) {
        const buf = document.getElementById('messagebuffer');
        if (!buf) return;
        buf.querySelectorAll('a[data-sc-embedded]').forEach(a => {
            if (a.href !== url) return;
            if (a._scUi) a._scUi.remove();
            applyFn(a);
        });
    }
    function banUrl(url) {
        const set = getBannedUrls();
        set.add(url);
        saveBannedUrls(set);
        sweepUrl(url, applyBannedState);
    }
    function unbanUrl(url) {
        const set = getBannedUrls();
        set.delete(url);
        saveBannedUrls(set);
        sweepUrl(url, applyEmbeddedState);
    }

    function renderLink(a) {
        a.dataset.scEmbedded = '1';
        if (isBanned(a.href)) applyBannedState(a);
        else applyEmbeddedState(a);
    }
```

- [ ] **Step 4: Add CSS for the ban icon and banned badge**

Find this exact line:

```js
            .sc-img-embed-toggle:hover { opacity: 1 !important; }
        `;
```

Replace it with:

```js
            .sc-img-embed-toggle:hover { opacity: 1 !important; }
            .sc-img-embed-ban {
                cursor: pointer !important;
                font-size: 11px !important;
                opacity: 0.6 !important;
                line-height: 1 !important;
            }
            .sc-img-embed-ban:hover { opacity: 1 !important; }
            .sc-img-embed-unban {
                cursor: pointer !important;
                opacity: 0.7 !important;
                text-decoration: underline !important;
            }
            .sc-img-embed-unban:hover { opacity: 1 !important; }
        `;
```

- [ ] **Step 5: Verify syntax**

Run: `node --check cytube.chatimages.user.js`
Expected: no output, exit code 0.

- [ ] **Step 6: Manual verification in Tampermonkey**

1. Update the installed script in Tampermonkey with the new file contents, save. Reload `https://cytu.be/r/testing`.
2. Post an image link twice, in two separate messages (so you have two copies of the same URL visible in the buffer).
3. Click 🚫 on one of them — confirm **both** copies immediately collapse to a "🚫 image hidden / ↩ unban" badge with the original link visible (not the thumbnail).
4. Scroll up if needed to confirm any older copy further up in scrollback also collapsed.
5. Post the same URL a third time in a brand-new message — confirm it comes in **already** banned (plain link + badge, never shows a thumbnail at all).
6. Click ↩ unban on any one of the banned badges — confirm **all** copies (including the one that never got a thumbnail in step 5) re-embed as images.
7. Reload the page with a banned URL still in backlog and the ban not yet reversed — confirm it loads in the banned state (persisted via localStorage), not embedded.
8. Post a **different** image URL, confirm it embeds normally and is unaffected by the other URL's ban state.

- [ ] **Step 7: Commit**

```bash
git add cytube.chatimages.user.js
git commit -m "Add per-image ban/unban with buffer-wide sweep to chat-images script"
```

---

### Task 3: Remove chat image embedding from `cytube.pc.user.js`

**Files:**
- Modify: `cytube.pc.user.js`

**Interfaces:**
- Consumes: nothing new — `cytube.chatimages.user.js` (Tasks 1–2) is a separate process; this task doesn't call into it.
- Produces: nothing new — `LS_AUTOEMBED`/`autoEmbedEnabled()` remain defined (still back the Settings Modal checkbox) but nothing in this file calls them anymore.

- [ ] **Step 1: Remove the "CHAT IMAGE EMBEDS" block**

In `cytube.pc.user.js`, find this exact block and delete it entirely (do not leave the comment header behind):

```js
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
        const el = document.querySelector('#messagebuffer .channel-emote, #messagebuffer .emote');
        const h = el && el.getBoundingClientRect().height;
        return (h && h > 4) ? Math.round(h) : 48; // fallback until a real emote has rendered
    }

    function findImageLinks(msgEl) {
        return [...msgEl.querySelectorAll('a[href]')]
            .filter(a => !a.dataset.scEmbedded && !a.closest('.sc-img-embed')
                && (a.protocol === 'http:' || a.protocol === 'https:') && IMAGE_LINK_RE.test(a.href));
    }

    // CyTube auto-scrolls the message buffer synchronously when a message is
    // appended, and separately hooks `load` on any <img> present at that time.
    // Our thumbnail is appended asynchronously (via MutationObserver), so it
    // misses both mechanisms — rescroll manually, but only if the user hadn't
    // scrolled up to read backlog.
    function rescrollChatIfNearBottom() {
        const b = document.getElementById('messagebuffer');
        if (b && b.scrollHeight - b.scrollTop - b.clientHeight < 60) b.scrollTop = b.scrollHeight;
    }

    function embedImagesIn(msgEl) {
        findImageLinks(msgEl).forEach(a => {
            a.dataset.scEmbedded = '1';
            a.style.display = 'none';
            const wrap = document.createElement('div');
            wrap.className = 'sc-img-embed';
            const link = document.createElement('a');
            link.href = a.href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            const img = document.createElement('img');
            img.loading = 'lazy';
            img.style.maxHeight = Math.round(emoteInlineHeight() * 1.25) + 'px';
            img.onerror = () => { wrap.remove(); a.style.display = ''; };
            img.onload = rescrollChatIfNearBottom;
            img.src = a.href;
            link.appendChild(img);
            const badge = document.createElement('span');
            badge.className = 'sc-img-embed-badge';
            const badgeLabel = document.createElement('span');
            badgeLabel.textContent = '🖼 embedded';
            const toggleBtn = document.createElement('span');
            toggleBtn.className = 'sc-img-embed-toggle';
            toggleBtn.textContent = '🔗';
            toggleBtn.title = 'Show link instead of image';
            toggleBtn.addEventListener('click', () => {
                const showingImage = link.style.display !== 'none';
                link.style.display = showingImage ? 'none' : '';
                a.style.display = showingImage ? '' : 'none';
                badgeLabel.textContent = showingImage ? '🔗 link only' : '🖼 embedded';
                toggleBtn.title = showingImage ? 'Show image instead of link' : 'Show link instead of image';
            });
            badge.appendChild(badgeLabel);
            badge.appendChild(toggleBtn);
            wrap.appendChild(link);
            wrap.appendChild(badge);
            msgEl.appendChild(wrap);
            rescrollChatIfNearBottom();
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
```

> **Note (added mid-implementation):** the block above includes `emoteInlineHeight()` and its dynamic-sizing line (`img.style.maxHeight = ...`), added by a commit (`5edb269`) that landed after this plan's Task 1/2 briefs were originally written from a stale local read of this file. Confirmed with the human partner: the standalone script intentionally does **not** carry this dynamic sizing forward — its static `max-height: 150px` cap (already built in Task 1) is the accepted final behavior, so this whole block, sizing line included, is deleted here with nothing to port.

Do **not** touch `LS_AUTOEMBED` or `autoEmbedEnabled()` near the top of the file (in the `LS_*` constants block) — those stay, since the Settings Modal checkbox still reads/writes them.

- [ ] **Step 2: Remove the two `startImageEmbedObserver()` call sites**

Find (inside the Settings Modal's Save handler):

```js
            setKey(LS_AUTOEMBED,   autoEmbed ? 'on' : 'off');
            startImageEmbedObserver();
            setKey(LS_IMGBB,       imgbb);
```

Replace with:

```js
            setKey(LS_AUTOEMBED,   autoEmbed ? 'on' : 'off');
            setKey(LS_IMGBB,       imgbb);
```

Find (inside the boot `MutationObserver` callback):

```js
            startUserColorObserver();
            startImageEmbedObserver();
            // Disconnect once all one-time elements are in place
```

Replace with:

```js
            startUserColorObserver();
            // Disconnect once all one-time elements are in place
```

- [ ] **Step 3: Update the Settings Modal checkbox note**

Find:

```js
                        <span class="sc-settings-note">Shows a thumbnail preview under messages that link directly to an image, marked "🖼 embedded"</span>
```

Replace with:

```js
                        <span class="sc-settings-note">Shows a thumbnail preview under messages that link directly to an image, marked "🖼 embedded" (requires cytube.chatimages.user.js)</span>
```

- [ ] **Step 4: Remove the `.sc-img-embed*` CSS rules**

Find this exact block and delete it entirely:

```css
            .sc-img-embed { display: block !important; margin-top: 4px !important; }
            .sc-img-embed img {
                display: block !important;
                max-width: 100% !important;
                border-radius: 4px !important;
                cursor: pointer !important;
            }
            .sc-img-embed-badge {
                display: flex !important;
                align-items: center !important;
                gap: 5px !important;
                font-size: 10px !important;
                color: rgba(244,244,242,0.45) !important;
                margin-top: 2px !important;
            }
            .sc-img-embed-toggle {
                cursor: pointer !important;
                font-size: 11px !important;
                opacity: 0.6 !important;
                line-height: 1 !important;
            }
            .sc-img-embed-toggle:hover { opacity: 1 !important; }
```

(Note: this committed CSS rule is missing `max-height`/`width`/`height` compared to earlier drafts of this plan — that's expected, since sizing moved to the JS `img.style.maxHeight` line above once `5edb269` landed. Delete exactly what's actually there; nothing here needs to be ported either.)

Leave every other CSS rule around it untouched.

- [ ] **Step 5: Update the `@description` line**

Find:

```js
// @description  Fullscreen layout, LanguageTool grammar, inline error editor, tab-complete, movie links, IMDb trivia & parent guide, right-click chat-to-movie seek, Tonight's Lineup schedule overlay, resizable chat panel, vertical monitor support, integrates with cytube.gifmaker.user.js when installed, auto-embedded chat image links
```

Replace with:

```js
// @description  Fullscreen layout, LanguageTool grammar, inline error editor, tab-complete, movie links, IMDb trivia & parent guide, right-click chat-to-movie seek, Tonight's Lineup schedule overlay, resizable chat panel, vertical monitor support, integrates with cytube.gifmaker.user.js and cytube.chatimages.user.js when installed
```

- [ ] **Step 6: Bump the version number**

Find the `@version` line near the top of `cytube.pc.user.js` and the matching `console.log('[SC] cytube.pc v...` line just inside the IIFE; bump both from their current value to the next patch version (e.g. `4.10.1` → `4.10.2`), keeping the two in sync as the rest of the file already does.

- [ ] **Step 7: Verify syntax**

Run: `node --check cytube.pc.user.js`
Expected: no output, exit code 0.

- [ ] **Step 8: Manual verification in Tampermonkey (both scripts installed)**

1. Make sure both `cytube.pc.user.js` (updated) and `cytube.chatimages.user.js` (from Tasks 1–2) are installed and enabled. Reload `https://cytu.be/r/testing`.
2. Open the console — confirm both `[SC] cytube.pc v...` and `[ChatImages] cytube.chatimages v1.0.0 loaded` appear.
3. Open the ⚙ Settings Modal — confirm the "Auto-embed image links in chat" checkbox is still there, still defaults to checked, and its note now mentions `cytube.chatimages.user.js`.
4. With the toggle on, post an image link — confirm it embeds (rendered by `cytube.chatimages.user.js`, not `cytube.pc.user.js` — check the console/Network if unsure, but visually it should be identical to before the split).
5. Turn the toggle off, save, post a new image link — confirm it stays a plain link, no embed.
6. Turn the toggle back on, save, post a new image link — confirm it embeds again, and the link from step 5 is still un-embedded (toggle changes are forward-only, matching pre-split behavior).
7. Right-click directly on an embedded thumbnail — confirm the chat-to-movie seek context menu does **not** appear (the `.sc-img-embed` guard in `cytube.pc.user.js` still works), and the browser's normal image context menu shows instead.
8. Right-click on a normal (non-image) chat message — confirm the seek menu still appears as before, unaffected by this change.
9. Reload the page with the toggle off and an image link already in the chat backlog — confirm it stays a plain link on load, not just when posted live after the toggle was already off.

- [ ] **Step 9: Commit**

```bash
git add cytube.pc.user.js
git commit -m "Remove chat image embedding (moved to cytube.chatimages.user.js)"
```

---

### Task 4: README updates

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: nothing (documentation only).

- [ ] **Step 1: Add a "Chat Image Embeds" feature section**

Find this exact block:

```markdown
### Chat-to-Movie Seek
```

Insert a new section immediately **before** it (so it lands right after the "GIF Maker" section and before "Chat-to-Movie Seek"):

```markdown
### Chat Image Embeds

Direct image links posted in chat (postimg.cc, imgur, Discord CDN, etc.) show up as an inline thumbnail instead of a bare link.

> Requires installing **`cytube.chatimages.user.js`** as a separate userscript (see Setup below) — it owns the embedding logic. Installed on its own, it always embeds. Installed alongside `cytube.pc.user.js`, it defers to that script's Settings Modal toggle ("Auto-embed image links in chat") instead.

- Hover a thumbnail to see the original filename as a tooltip
- Click **🔗** on an embed to flip that one instance between the thumbnail and the plain link, without affecting anything else
- Click **🚫** on an embed to ban that exact image — it collapses to a plain link everywhere it's already been posted, and never embeds again on future reposts of the same URL. A **↩ unban** link sits right next to a banned image's link if you change your mind
- Bans are personal — stored in your own browser, not shared with anyone else in the channel

---

### Chat-to-Movie Seek
```

- [ ] **Step 2: Add a "2c. Install Chat Images" setup step**

Find this exact block:

```markdown
It can run alone or alongside `cytube.pc.user.js`. With both installed, the GIF button becomes the floating **◉** button and the ImgBB key / Optimize toggle move into `cytube.pc.user.js`'s Settings Modal (see GIF Maker above).

### 3. Enter your API keys (first run)
```

Replace it with:

```markdown
It can run alone or alongside `cytube.pc.user.js`. With both installed, the GIF button becomes the floating **◉** button and the ImgBB key / Optimize toggle move into `cytube.pc.user.js`'s Settings Modal (see GIF Maker above).

### 2c. Install Chat Images (optional, recommended)

Chat image auto-embedding lives in its own userscript. Repeat the steps above with `cytube.chatimages.user.js` to add it:

1. Open Tampermonkey's dashboard and click **Create a new script**
2. Delete the placeholder content and paste in the full contents of `cytube.chatimages.user.js`
3. Save with **Ctrl+S** (or **Cmd+S**)

It can run alone (always embeds) or alongside `cytube.pc.user.js` (defers to its Settings Modal toggle — see Chat Image Embeds above).

### 3. Enter your API keys (first run)
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document the standalone chat-images userscript"
```
