# Chat-link Picture-in-Picture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `link-pip` module that puts a small 🗗 icon next to YouTube links and links to a curated list of image-hosting landing pages (postimg.cc, ibb.co, prnt.sc) in chat, opening a floating draggable preview window on click — muting the main CyTube player (best-effort) while a YouTube PiP plays, and restoring its exact previous state on close.

**Architecture:** One new module, `src/pc/modules/link-pip/` (`index.js` + `style.css`), registered in `src/pc/manifest.json` (mirrored into `docs/manifest.json`, currently byte-identical). Its own `MutationObserver` on `#messagebuffer` (mirroring `chatimages`) scans new chat messages, appends a click-to-open icon next to qualifying `<a>` tags without touching the link itself. A single shared floating panel (`#sc-pip-panel`, one at a time) renders either a YouTube iframe or a resolved image, reusing the emote-picker's draggable-panel pattern. Player mute/restore reuses `getPlayerVideoEl()`/`window.PLAYER` fallback-chain idiom already established in core.

**Tech Stack:** Vanilla JS (ES2017+, shared build IIFE — no imports/exports), `MutationObserver`, `GM_xmlhttpRequest` (image-page resolution only), plain `localStorage` via core's `getKey`/`setKey`.

**Spec:** `docs/superpowers/specs/2026-08-23-chat-link-pip-design.md`

## Global Constraints

- No automated test framework in this repo — verification is `node --check <file>` (syntax only) + `node scripts/build-dev-bundle.mjs` (rebuilds `cytube.pc.dev.user.js`) + manual testing in a live cytu.be room via Tampermonkey, same convention as every existing plan here.
- `getKey`/`setKey` are core's (`src/pc/core/02-keys-and-helpers.js`); `getPlayerVideoEl`/`isYouTubeMedia` are core's (`src/pc/core/12-playback-sync-and-seek.js`); `scRegisterSetting`/`injectCSS` are core's (`src/pc/core/10-registry.js`) — this module consumes all of them directly from the shared build IIFE scope, never redeclares them.
- localStorage keys, both private to this module: `sc_pip_enabled` (Settings Modal toggle, default on) and `sc_pip_panel_pos` (JSON `{left, top}` position persistence).
- The image-hosting host allowlist (`postimg.cc`, `ibb.co`, `prnt.sc`) is deliberately small and hardcoded — **do not** build a generic "try any link" fallback. This was an explicit product decision made during brainstorming (see spec's Non-goals): broader detection means a PiP icon next to ordinary webpage links that resolve to nothing, and a network request fired at an arbitrary third-party host for every non-YouTube link posted in chat.
- Icon behavior is strictly additive — never call `preventDefault()`/`stopPropagation()` on the underlying `<a>`, never hide or restyle it. Only the appended `.sc-pip-icon` triggers PiP; the link keeps opening normally in a new tab.
- One PiP window at a time — `openPip()` always calls `closePip()` first.
- Main-player mute is **best-effort**: `mutePlayer()` returning `null` (no reachable mechanism) is a normal, silent outcome — PiP still opens and plays, no user-facing error.
- **Open risk, not resolved by static reading:** whether `window.PLAYER`'s YouTube wrapper actually exposes `.mute()`/`.unMute()`/`.isMuted()` is unconfirmed — it's CyTube's own client object, not code in this repo. `getPlayerVideoEl()` only helps for direct/video.js file playback; a YouTube *main* stream's `<video>` lives in a cross-origin iframe (see the existing comment at `12-playback-sync-and-seek.js:14-19`), so the wrapper path is the *only* possible path for that case. Task 1's manual verification step (sub-step 4) must be run against a real YouTube main stream in cytu.be before this feature is considered done.
- `src/pc/manifest.json` and `docs/manifest.json` are currently byte-identical (confirmed via `diff` before writing this plan) — every task that edits one must mirror the identical edit into the other, and each such step starts by re-confirming they're still identical before overwriting.

---

### Task 1: Module scaffold, YouTube detection/PiP, panel chrome, mute/restore, settings toggle

**Files:**
- Create: `src/pc/modules/link-pip/index.js`
- Create: `src/pc/modules/link-pip/style.css`
- Modify: `src/pc/manifest.json` (new `link-pip` module entry)
- Modify: `docs/manifest.json` (mirror the same entry)

**Interfaces:**
- Consumes: `getKey`/`setKey` (core), `getPlayerVideoEl` (core), `scRegisterSetting` (core).
- Produces: `LS_PIP_ENABLED`, `LS_PIP_PANEL_POS`, `pipEnabled()`, `extractYouTubeId(url) → string|null`, `classifyLink(url) → 'youtube'|null` (Task 2 extends this to also return `'image-page'`), `findQualifyingLinks(msgEl)`, `renderIcon(a)`, `scanPipLinks(buf)`, `startPipObserver()`, `mutePlayer() → {kind,muted[,volume]}|null`, `restorePlayer(state)`, `clampPanelPos`, `makePanelDraggable`, `getSavedPipPanelPos`/`savePipPanelPos`, `buildPanelBody(kind, url) → Element` (Task 2 extends the non-YouTube branch), `openPip(kind, url)`, `closePip()`, `linkPipBoot()`.

- [ ] **Step 1: Create `src/pc/modules/link-pip/index.js`**

```js
    /* ==========================================================
       CHAT LINK PICTURE-IN-PICTURE — a floating preview window
       opened by clicking a small icon next to certain chat links:
       YouTube videos (this task) and image-hosting landing pages
       like postimg.cc (added in Task 2). getKey/setKey are core's
       (02-keys-and-helpers.js); getPlayerVideoEl is core's
       (12-playback-sync-and-seek.js) -- this module doesn't
       redeclare either.
    ========================================================== */
    const LS_PIP_ENABLED   = 'sc_pip_enabled';
    const LS_PIP_PANEL_POS = 'sc_pip_panel_pos';

    const pipEnabled = () => getKey(LS_PIP_ENABLED) !== 'off';

    /* ==========================================================
       LINK CLASSIFICATION
    ========================================================== */
    function extractYouTubeId(url) {
        try {
            const u = new URL(url);
            const host = u.hostname.replace(/^www\./, '');
            if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
            if (host === 'youtube.com' || host === 'm.youtube.com') {
                if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2] || null;
                if (u.pathname.startsWith('/embed/')) return u.pathname.split('/')[2] || null;
                if (u.pathname === '/watch' && u.searchParams.has('v')) return u.searchParams.get('v');
            }
            return null;
        } catch (e) { return null; }
    }

    function classifyLink(url) {
        if (extractYouTubeId(url)) return 'youtube';
        return null;
    }

    /* ==========================================================
       SCANNING / ICON INJECTION
       Mirrors chatimages' scanImageEmbeds/startImageEmbedObserver
       (src/pc/modules/chatimages/index.js) -- its own
       MutationObserver on #messagebuffer, idempotent via a dataset
       marker so re-scans from later mutations don't reprocess a
       link. The `.sc-img-embed` exclusion matches chatimages' own
       findImageLinks() filter -- defensive, since no current
       allowlisted image host overlaps a direct-image extension
       chatimages already embeds, but keeps the two modules from
       ever double-processing the same link if that changes.
    ========================================================== */
    function findQualifyingLinks(msgEl) {
        return [...msgEl.querySelectorAll('a[href]')]
            .filter(a => !a.dataset.scPipChecked && !a.closest('.sc-img-embed')
                && (a.protocol === 'http:' || a.protocol === 'https:'));
    }

    function renderIcon(a) {
        a.dataset.scPipChecked = '1';
        const kind = classifyLink(a.href);
        if (!kind) return;
        const icon = document.createElement('span');
        icon.className = 'sc-pip-icon';
        icon.title = kind === 'youtube' ? 'Open in floating player' : 'Open image preview';
        icon.textContent = '🗗';
        icon.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openPip(kind, a.href);
        });
        a.insertAdjacentElement('afterend', icon);
    }

    function scanPipLinks(buf) {
        if (!pipEnabled()) return;
        buf.querySelectorAll('[class*="chat-msg-"]').forEach(msgEl => {
            findQualifyingLinks(msgEl).forEach(renderIcon);
        });
    }

    let _pipObserverStarted = false;
    function startPipObserver() {
        const buf = document.getElementById('messagebuffer');
        if (!buf) { requestAnimationFrame(startPipObserver); return; }
        if (_pipObserverStarted) return;
        _pipObserverStarted = true;
        new MutationObserver(() => scanPipLinks(buf)).observe(buf, { childList: true, subtree: true });
        scanPipLinks(buf);
    }

    /* ==========================================================
       MAIN-PLAYER MUTE / RESTORE
       Mirrors the fallback-chain idiom seekPlayerTo() uses in
       src/pc/core/12-playback-sync-and-seek.js: try the real
       <video> element first (native, reliable for direct file
       playback), fall back to CyTube's PLAYER wrapper object --
       the only reachable path for a YouTube *main* stream, since
       its <video> lives in a cross-origin iframe (see that file's
       own comment at line ~14-19). Best-effort: a null return
       means PiP still opens/plays, just doesn't mute.
    ========================================================== */
    function mutePlayer() {
        const v = getPlayerVideoEl();
        if (v) {
            const state = { kind: 'video', muted: v.muted, volume: v.volume };
            try { v.muted = true; } catch (e) {}
            return state;
        }
        try {
            const p = window.PLAYER || window.player;
            if (p && typeof p.mute === 'function') {
                const wasMuted = typeof p.isMuted === 'function' ? !!p.isMuted() : false;
                p.mute();
                return { kind: 'wrapper', muted: wasMuted };
            }
        } catch (e) {}
        return null;
    }

    function restorePlayer(state) {
        if (!state) return;
        if (state.kind === 'video') {
            const v = getPlayerVideoEl();
            if (v) { try { v.muted = state.muted; v.volume = state.volume; } catch (e) {} }
            return;
        }
        try {
            const p = window.PLAYER || window.player;
            if (p && !state.muted && typeof p.unMute === 'function') p.unMute();
        } catch (e) {}
    }

    /* ==========================================================
       PANEL CHROME — draggable floating window, one at a time.
       Drag/clamp copied locally (not shared), matching this
       codebase's existing per-module convention -- see the
       comment on makePanelDraggable in
       src/pc/modules/emote-picker/index.js.
    ========================================================== */
    function clampPanelPos(left, top, width, height) {
        return {
            x: Math.min(Math.max(left, -(width - 40)), window.innerWidth - 40),
            y: Math.min(Math.max(top, 0), window.innerHeight - 32),
        };
    }

    function makePanelDraggable(panel, head, draggingClass, onDragEnd) {
        let dragging = false, dragDX = 0, dragDY = 0;
        const setPos = (prop, val) => panel.style.setProperty(prop, val, 'important');
        head.addEventListener('pointerdown', (e) => {
            if (e.target.closest('button')) return;
            const rect = panel.getBoundingClientRect();
            setPos('left', rect.left + 'px');
            setPos('top', rect.top + 'px');
            setPos('right', 'auto');
            setPos('bottom', 'auto');
            dragDX = e.clientX - rect.left;
            dragDY = e.clientY - rect.top;
            dragging = true;
            head.classList.add(draggingClass);
            head.setPointerCapture(e.pointerId);
        });
        head.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const rect = panel.getBoundingClientRect();
            const { x, y } = clampPanelPos(e.clientX - dragDX, e.clientY - dragDY, rect.width, rect.height);
            setPos('left', x + 'px');
            setPos('top', y + 'px');
        });
        const endDrag = (e) => {
            if (!dragging) return;
            dragging = false;
            head.classList.remove(draggingClass);
            try { head.releasePointerCapture(e.pointerId); } catch (err) {}
            if (onDragEnd) {
                const rect = panel.getBoundingClientRect();
                onDragEnd(rect.left, rect.top);
            }
        };
        head.addEventListener('pointerup', endDrag);
        head.addEventListener('pointercancel', endDrag);
    }

    function getSavedPipPanelPos() {
        try {
            const raw = getKey(LS_PIP_PANEL_POS);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed.left === 'number' && typeof parsed.top === 'number') return parsed;
        } catch (e) {}
        return null;
    }
    function savePipPanelPos(left, top) {
        try { setKey(LS_PIP_PANEL_POS, JSON.stringify({ left, top })); } catch (e) {}
    }

    function buildPanelBody(kind, url) {
        if (kind === 'youtube') {
            const id = extractYouTubeId(url);
            const iframe = document.createElement('iframe');
            iframe.src = `https://www.youtube.com/embed/${id}?autoplay=1`;
            iframe.allow = 'autoplay; encrypted-media';
            iframe.className = 'sc-pip-frame';
            iframe.setAttribute('frameborder', '0');
            return iframe;
        }
        const holder = document.createElement('div');
        holder.className = 'sc-pip-image-holder';
        holder.textContent = "Couldn't preview this link.";
        return holder;
    }

    let pipPanel = null;
    let pipMuteState = null;
    let _pipOutsideClick = null;

    function closePip() {
        if (!pipPanel) return;
        pipPanel.remove();
        pipPanel = null;
        document.removeEventListener('click', _pipOutsideClick, true);
        _pipOutsideClick = null;
        if (pipMuteState) { restorePlayer(pipMuteState); pipMuteState = null; }
    }

    function openPip(kind, url) {
        closePip(); // one window at a time
        pipPanel = document.createElement('div');
        pipPanel.id = 'sc-pip-panel';
        pipPanel.innerHTML = `
            <div id="sc-pip-head">
                <span>Preview</span>
                <button id="sc-pip-close" type="button">✕</button>
            </div>
            <div id="sc-pip-body"></div>`;
        document.body.appendChild(pipPanel);
        pipPanel.querySelector('#sc-pip-body').appendChild(buildPanelBody(kind, url));
        pipPanel.querySelector('#sc-pip-close').addEventListener('click', closePip);

        const saved = getSavedPipPanelPos();
        if (saved) {
            const rect = pipPanel.getBoundingClientRect();
            const { x, y } = clampPanelPos(saved.left, saved.top, rect.width, rect.height);
            pipPanel.style.setProperty('left', x + 'px', 'important');
            pipPanel.style.setProperty('top', y + 'px', 'important');
            pipPanel.style.setProperty('right', 'auto', 'important');
            pipPanel.style.setProperty('bottom', 'auto', 'important');
        }
        makePanelDraggable(pipPanel, pipPanel.querySelector('#sc-pip-head'), 'sc-pip-dragging', (left, top) => {
            savePipPanelPos(left, top);
        });

        _pipOutsideClick = (e) => { if (pipPanel && !pipPanel.contains(e.target)) closePip(); };
        setTimeout(() => document.addEventListener('click', _pipOutsideClick, true), 0);

        if (kind === 'youtube') pipMuteState = mutePlayer();
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closePip();
    });

    /* ==========================================================
       BOOT — called directly (not via scRegisterInit) so the
       observer starts watching #messagebuffer as soon as the DOM
       is ready, matching chatimages' own boot rationale
       (src/pc/modules/chatimages/index.js).
    ========================================================== */
    function linkPipBoot() {
        if (!document.body) { requestAnimationFrame(linkPipBoot); return; }
        startPipObserver();
    }
    linkPipBoot();

    scRegisterSetting({ id: 'sc-input-pip', group: 'link-pip', label: 'Picture-in-picture for chat links', note: 'Adds a 🗗 icon next to YouTube links in chat that opens a floating player. Auto-mutes the main player while it plays.', key: LS_PIP_ENABLED, defaultOn: true, order: 8 });
```

- [ ] **Step 2: Create `src/pc/modules/link-pip/style.css`**

```css
            .sc-pip-icon {
                cursor: pointer !important;
                margin-left: 4px !important;
                opacity: 0.65 !important;
                font-size: 12px !important;
            }
            .sc-pip-icon:hover { opacity: 1 !important; }

            #sc-pip-panel {
                position: fixed !important;
                z-index: 99999 !important;
                left: auto !important; top: auto !important;
                right: 16px !important; bottom: 16px !important;
                width: 340px !important; height: 220px !important;
                background: rgba(10,10,20,0.95) !important;
                border-radius: 8px !important;
                box-shadow: 0 8px 32px rgba(0,0,0,0.7) !important;
                overflow: hidden !important;
                resize: both !important;
                min-width: 240px !important; min-height: 160px !important;
                display: flex !important; flex-direction: column !important;
            }
            #sc-pip-head {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                padding: 6px 10px !important; cursor: grab !important;
                background: rgba(255,255,255,0.06) !important;
                color: rgba(244,244,242,0.85) !important;
                font-size: 12px !important; flex-shrink: 0 !important;
            }
            #sc-pip-head.sc-pip-dragging { cursor: grabbing !important; }
            #sc-pip-close {
                background: rgba(255,255,255,0.1) !important; border: none !important; color: #fff !important;
                width: 20px !important; height: 20px !important; border-radius: 50% !important;
                cursor: pointer !important; font-size: 11px !important;
                display: flex !important; align-items: center !important; justify-content: center !important;
            }
            #sc-pip-close:hover { background: rgba(255,255,255,0.2) !important; }
            #sc-pip-body { flex: 1 !important; position: relative !important; overflow: hidden !important; }
            #sc-pip-body .sc-pip-frame { width: 100% !important; height: 100% !important; border: 0 !important; display: block !important; }
            #sc-pip-body .sc-pip-image-holder {
                width: 100% !important; height: 100% !important;
                display: flex !important; align-items: center !important; justify-content: center !important;
                color: rgba(244,244,242,0.7) !important; font-size: 12px !important; text-align: center !important; padding: 12px !important;
            }
```

- [ ] **Step 3: Register the module in `src/pc/manifest.json`**

Find this exact block (the end of the `chatimages` entry):

```json
      "features": [
        "Auto-embeds inline image previews under chat messages linking directly to images",
        "Per-image toggle between thumbnail/link view",
        "Per-user \"hide\"/\"unban\" mute for specific image URLs",
        "Keeps chat scrolled to bottom as embeds load"
      ],
      "screenshot": "screenshots/chatimages.png"
    },
    {
      "id": "movie-lead-time",
```

Replace it with (inserting the new `link-pip` entry between them):

```json
      "features": [
        "Auto-embeds inline image previews under chat messages linking directly to images",
        "Per-image toggle between thumbnail/link view",
        "Per-user \"hide\"/\"unban\" mute for specific image URLs",
        "Keeps chat scrolled to bottom as embeds load"
      ],
      "screenshot": "screenshots/chatimages.png"
    },
    {
      "id": "link-pip",
      "name": "Chat Link Picture-in-Picture",
      "category": "Chat",
      "locked": false,
      "defaultOn": true,
      "files": [
        "src/pc/modules/link-pip/index.js"
      ],
      "cssFiles": [
        "src/pc/modules/link-pip/style.css"
      ],
      "dependsOn": ["core"],
      "features": [
        "Adds a 🗗 icon next to YouTube links in chat that opens a floating picture-in-picture player",
        "Auto-mutes the main player while a YouTube PiP plays, restoring its previous state on close"
      ]
    },
    {
      "id": "movie-lead-time",
```

- [ ] **Step 4: Mirror the same edit into `docs/manifest.json`**

Run `diff src/pc/manifest.json docs/manifest.json` first — if it reports any difference, stop and report it (the two have diverged from something outside this plan and need reconciling before blindly overwriting). If it reports no difference, apply the identical Step 3 edit to `docs/manifest.json` (same find/replace).

- [ ] **Step 5: Verify syntax**

Run:
```bash
node --check src/pc/modules/link-pip/index.js
node -e "JSON.parse(require('fs').readFileSync('src/pc/manifest.json','utf8')); JSON.parse(require('fs').readFileSync('docs/manifest.json','utf8')); console.log('manifests OK')"
```
Expected: no output from the first command, `manifests OK` from the second.

- [ ] **Step 6: Build the dev bundle**

Run: `node scripts/build-dev-bundle.mjs`
Expected output includes `link-pip` in the module list, e.g. `Wrote .../cytube.pc.dev.user.js (N modules: ..., link-pip, ...)`.

- [ ] **Step 7: Manual verification in Tampermonkey**

1. Update the installed dev script in Tampermonkey with the freshly-built `cytube.pc.dev.user.js` contents, save. Reload `https://cytu.be/r/testing`.
2. Open the ⚙ Settings Modal — confirm a "Picture-in-picture for chat links" checkbox is present, checked by default.
3. Post a YouTube link (e.g. `https://www.youtube.com/watch?v=dQw4w9WgXcQ`) in chat. Confirm a 🗗 icon appears right after the link, and clicking the **link itself** still opens YouTube in a new tab as normal (icon doesn't interfere).
4. Click the 🗗 icon. Confirm the floating panel opens bottom-right, the video autoplays.
5. **With the main stream currently set to a YouTube video** (the case that depends on `window.PLAYER`'s wrapper mute API — the open risk called out in Global Constraints): confirm the main player actually mutes when the PiP opens. If it does not mute, stop and report this back — it means the wrapper mute-API assumption in `mutePlayer()`/`restorePlayer()` needs revisiting before this task is considered complete.
6. Close the panel via the ✕ button. Confirm the main player's mute is restored to what it was before (unmuted, since it started unmuted).
7. Repeat open, then close via **Escape** and via **clicking outside the panel** — confirm both also restore mute correctly.
8. Drag the panel to a new position, close it, open a new YouTube PiP — confirm it reopens at the dragged position.
9. Resize the panel by dragging its bottom-right corner (native `resize: both`) — confirm the iframe fills the new size.
10. Manually mute the main player yourself first (before opening any PiP), then open a YouTube PiP and close it — confirm the main player is still muted afterward (restore puts back *muted*, not unmuted — PiP must never un-mute something the user muted themselves).
11. Turn the Settings Modal toggle off, save, post a new YouTube link — confirm no icon appears. Turn it back on, save, post another — confirm the icon appears again (and the toggle-off link stays without one, non-retroactive, matching every other toggle in this codebase).

- [ ] **Step 8: Commit**

```bash
git add src/pc/modules/link-pip/index.js src/pc/modules/link-pip/style.css src/pc/manifest.json docs/manifest.json cytube.pc.dev.user.js
git commit -m "Add link-pip module: YouTube picture-in-picture with main-player mute/restore"
```

---

### Task 2: Image-hosting landing pages (postimg.cc / ibb.co / prnt.sc)

**Files:**
- Modify: `src/pc/modules/link-pip/index.js` (edits to the file from Task 1)
- Modify: `src/pc/modules/link-pip/style.css` (edits to the file from Task 1)
- Modify: `src/pc/manifest.json` (add `grants`/`connects` to the `link-pip` entry)
- Modify: `docs/manifest.json` (mirror the same edit)

**Interfaces:**
- Consumes: `classifyLink(url)` (Task 1 — extended here), `buildPanelBody(kind, url)` (Task 1 — the non-YouTube branch is replaced here).
- Produces: `IMAGE_HOST_ALLOWLIST`, `isImageHostPage(url) → boolean`, `extractOgImage(html) → string|null`, `resolveOgImage(pageUrl) → Promise<string|null>`.

- [ ] **Step 1: Extend `classifyLink` with the image-host branch**

Find this exact block (from Task 1):

```js
    function classifyLink(url) {
        if (extractYouTubeId(url)) return 'youtube';
        return null;
    }
```

Replace it with:

```js
    const IMAGE_HOST_ALLOWLIST = ['postimg.cc', 'ibb.co', 'prnt.sc'];

    function isImageHostPage(url) {
        try {
            const host = new URL(url).hostname.replace(/^www\./, '');
            return IMAGE_HOST_ALLOWLIST.includes(host);
        } catch (e) { return false; }
    }

    function extractOgImage(html) {
        let m = html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
        if (!m) m = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
        return m ? m[1] : null;
    }

    function resolveOgImage(pageUrl) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: pageUrl,
                onload: (res) => {
                    if (res.status !== 200) { resolve(null); return; }
                    const raw = extractOgImage(res.responseText);
                    if (!raw) { resolve(null); return; }
                    try { resolve(new URL(raw, pageUrl).href); }
                    catch (e) { resolve(null); }
                },
                onerror: () => resolve(null),
                ontimeout: () => resolve(null),
                timeout: 8000,
            });
        });
    }

    function classifyLink(url) {
        if (extractYouTubeId(url)) return 'youtube';
        if (isImageHostPage(url)) return 'image-page';
        return null;
    }
```

- [ ] **Step 2: Replace `buildPanelBody`'s non-YouTube branch**

Find this exact block (from Task 1):

```js
    function buildPanelBody(kind, url) {
        if (kind === 'youtube') {
            const id = extractYouTubeId(url);
            const iframe = document.createElement('iframe');
            iframe.src = `https://www.youtube.com/embed/${id}?autoplay=1`;
            iframe.allow = 'autoplay; encrypted-media';
            iframe.className = 'sc-pip-frame';
            iframe.setAttribute('frameborder', '0');
            return iframe;
        }
        const holder = document.createElement('div');
        holder.className = 'sc-pip-image-holder';
        holder.textContent = "Couldn't preview this link.";
        return holder;
    }
```

Replace it with:

```js
    function buildPanelBody(kind, url) {
        if (kind === 'youtube') {
            const id = extractYouTubeId(url);
            const iframe = document.createElement('iframe');
            iframe.src = `https://www.youtube.com/embed/${id}?autoplay=1`;
            iframe.allow = 'autoplay; encrypted-media';
            iframe.className = 'sc-pip-frame';
            iframe.setAttribute('frameborder', '0');
            return iframe;
        }
        const holder = document.createElement('div');
        holder.className = 'sc-pip-image-holder';
        holder.textContent = 'Loading…';
        resolveOgImage(url).then(imgUrl => {
            if (!holder.isConnected) return; // panel closed before the fetch finished
            holder.innerHTML = '';
            if (!imgUrl) {
                holder.append("Couldn't find an image on this page. ");
                const link = document.createElement('a');
                link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
                link.textContent = 'Open page';
                holder.appendChild(link);
                return;
            }
            const img = document.createElement('img');
            img.src = imgUrl;
            holder.appendChild(img);
        });
        return holder;
    }
```

- [ ] **Step 3: Update the settings note to mention image links**

Find this exact line (from Task 1):

```js
    scRegisterSetting({ id: 'sc-input-pip', group: 'link-pip', label: 'Picture-in-picture for chat links', note: 'Adds a 🗗 icon next to YouTube links in chat that opens a floating player. Auto-mutes the main player while it plays.', key: LS_PIP_ENABLED, defaultOn: true, order: 8 });
```

Replace it with:

```js
    scRegisterSetting({ id: 'sc-input-pip', group: 'link-pip', label: 'Picture-in-picture for chat links', note: 'Adds a 🗗 icon next to YouTube links and postimg.cc/ibb.co/prnt.sc links in chat to open a floating preview. Auto-mutes the main player while a YouTube PiP plays.', key: LS_PIP_ENABLED, defaultOn: true, order: 8 });
```

- [ ] **Step 4: Add CSS for the resolved image and its fallback link**

Find this exact block (from Task 1):

```css
            #sc-pip-body .sc-pip-image-holder {
                width: 100% !important; height: 100% !important;
                display: flex !important; align-items: center !important; justify-content: center !important;
                color: rgba(244,244,242,0.7) !important; font-size: 12px !important; text-align: center !important; padding: 12px !important;
            }
```

Replace it with:

```css
            #sc-pip-body .sc-pip-image-holder {
                width: 100% !important; height: 100% !important;
                display: flex !important; align-items: center !important; justify-content: center !important;
                color: rgba(244,244,242,0.7) !important; font-size: 12px !important; text-align: center !important; padding: 12px !important;
            }
            #sc-pip-body .sc-pip-image-holder img { max-width: 100% !important; max-height: 100% !important; display: block !important; }
            #sc-pip-body .sc-pip-image-holder a { color: #7ec8ff !important; margin-left: 4px !important; }
```

- [ ] **Step 5: Add `grants`/`connects` to the `link-pip` entry in `src/pc/manifest.json`**

Find this exact block (the `link-pip` entry added in Task 1):

```json
      "dependsOn": ["core"],
      "features": [
        "Adds a 🗗 icon next to YouTube links in chat that opens a floating picture-in-picture player",
        "Auto-mutes the main player while a YouTube PiP plays, restoring its previous state on close"
      ]
    },
    {
      "id": "movie-lead-time",
```

Replace it with:

```json
      "dependsOn": ["core"],
      "grants": [
        "GM_xmlhttpRequest"
      ],
      "connects": [
        "postimg.cc",
        "i.postimg.cc",
        "ibb.co",
        "i.ibb.co",
        "prnt.sc"
      ],
      "features": [
        "Adds a 🗗 icon next to YouTube links in chat that opens a floating picture-in-picture player",
        "Also resolves image-hosting landing pages (postimg.cc, ibb.co, prnt.sc) that the auto-embed module can't match directly",
        "Auto-mutes the main player while a YouTube PiP plays, restoring its previous state on close"
      ]
    },
    {
      "id": "movie-lead-time",
```

- [ ] **Step 6: Mirror the same edit into `docs/manifest.json`**

Run `diff src/pc/manifest.json docs/manifest.json` first — if it reports any difference, stop and report it. If not, apply the identical Step 5 edit to `docs/manifest.json`.

- [ ] **Step 7: Verify syntax**

Run:
```bash
node --check src/pc/modules/link-pip/index.js
node -e "JSON.parse(require('fs').readFileSync('src/pc/manifest.json','utf8')); JSON.parse(require('fs').readFileSync('docs/manifest.json','utf8')); console.log('manifests OK')"
```
Expected: no output from the first command, `manifests OK` from the second.

- [ ] **Step 8: Build the dev bundle**

Run: `node scripts/build-dev-bundle.mjs`
Expected: succeeds, no errors.

- [ ] **Step 9: Manual verification in Tampermonkey**

1. Update the installed dev script with the freshly-built `cytube.pc.dev.user.js`, save. Reload `https://cytu.be/r/testing`.
2. Post a `postimg.cc` link to an actual image page (e.g. `https://postimg.cc/VSjkLzj1`) in chat. Confirm a 🗗 icon appears next to it.
3. Click the icon. Confirm the panel opens showing "Loading…" then swaps in the resolved image.
4. Post a link to an allowlisted host with no `og:image` (or a dead/removed page) and click its icon — confirm the "Couldn't find an image on this page. Open page" fallback appears, and clicking "Open page" opens the original URL in a new tab.
5. With a YouTube PiP open (from Task 1), click a `postimg.cc` icon — confirm the YouTube PiP closes (and the main player un-mutes) before the image PiP opens.
6. Post an `ibb.co` and a `prnt.sc` link — confirm both also get icons and resolve correctly (adjust to whatever real image pages are available for a quick smoke test).
7. Post a plain, non-allowlisted webpage link (e.g. a Wikipedia article) — confirm **no** icon appears next to it.

- [ ] **Step 10: Commit**

```bash
git add src/pc/modules/link-pip/index.js src/pc/modules/link-pip/style.css src/pc/manifest.json docs/manifest.json cytube.pc.dev.user.js
git commit -m "Add image-hosting landing page resolution (postimg.cc/ibb.co/prnt.sc) to link-pip"
```

---

### Task 3: Version bump, README documentation, final regression pass

**Files:**
- Modify: `src/pc/manifest.json` (`baseVersion`)
- Modify: `docs/manifest.json` (mirror)
- Modify: `src/pc/core/10-registry.js` (console.log version string)
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing new — documentation and version bump only.
- Produces: nothing new.

- [ ] **Step 1: Bump the version**

In `src/pc/manifest.json`, find:

```json
  "baseVersion": "4.10.4",
```

Replace with:

```json
  "baseVersion": "4.10.5",
```

Run `diff src/pc/manifest.json docs/manifest.json` first to confirm they're still otherwise identical, then apply the identical edit to `docs/manifest.json`.

In `src/pc/core/10-registry.js`, find:

```js
    console.log('[SC] cytube.pc v4.10.4 loaded');
```

Replace with:

```js
    console.log('[SC] cytube.pc v4.10.5 loaded');
```

- [ ] **Step 2: Add a "Chat Link Picture-in-Picture" section to `README.md`**

Find this exact block:

```markdown
### Subtitle Sync
```

Insert a new section immediately **before** it (so it lands right after "Chat Image Embeds" and before "Subtitle Sync"):

```markdown
### Chat Link Picture-in-Picture

Click the 🗗 icon next to a YouTube link in chat to open it in a small floating, draggable preview window without leaving the page — the main player auto-mutes while it plays and restores its previous mute/volume state when you close it. The same icon shows up next to links to a curated list of image-hosting pages (postimg.cc, ibb.co, prnt.sc) that link directly to a *page about* an image rather than the image itself, resolving and previewing the actual image inline.

> Chat Link Picture-in-Picture is an optional module — check it in the customizer (see Setup below) to include it in your build. Once included, it's governed by the Settings Modal's "Picture-in-picture for chat links" toggle.

- The link itself is left completely alone — it still opens normally in a new tab on click; only the 🗗 icon opens the floating preview
- One preview window at a time — opening a new one replaces whatever's already open
- Drag the header to reposition it (remembered for next time) or drag the bottom-right corner to resize
- Close with the **✕** button, **Escape**, or by clicking outside the panel

---

### Subtitle Sync
```

- [ ] **Step 3: Verify syntax**

Run:
```bash
node --check src/pc/modules/link-pip/index.js
node --check src/pc/core/10-registry.js
node -e "JSON.parse(require('fs').readFileSync('src/pc/manifest.json','utf8')); JSON.parse(require('fs').readFileSync('docs/manifest.json','utf8')); console.log('manifests OK')"
```
Expected: no output from the first two, `manifests OK` from the third.

- [ ] **Step 4: Build the dev bundle**

Run: `node scripts/build-dev-bundle.mjs`
Expected: succeeds; console.log line in the output bundle should read `v4.10.5`.

- [ ] **Step 5: Final end-to-end manual regression in Tampermonkey**

1. Update the installed dev script with the freshly-built `cytube.pc.dev.user.js`, save. Reload `https://cytu.be/r/testing`. Confirm the console shows `[SC] cytube.pc v4.10.5 loaded`.
2. Re-run Task 1 Step 7's checks 3–10 and Task 2 Step 9's checks 2–7 in one pass, back to back, to confirm nothing regressed from the version bump or from the two features coexisting.
3. Specifically re-confirm the Task 1 Step 7.5 mute check against a real YouTube main stream one more time — this is the one behavior this plan could not verify by reading code alone, so it must pass here before calling the feature done.
4. Confirm the Settings Modal's "Picture-in-picture for chat links" note now mentions both YouTube and the image-hosting hosts.

- [ ] **Step 6: Commit**

```bash
git add src/pc/manifest.json docs/manifest.json src/pc/core/10-registry.js README.md cytube.pc.dev.user.js
git commit -m "Document link-pip module, bump version to 4.10.5"
```
