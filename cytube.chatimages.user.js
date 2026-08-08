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
    const LS_BANNED    = 'sc_img_banned_urls';  // private to this script -- JSON array of exact banned URLs
    const getKey = id => localStorage.getItem(id) || '';
    const autoEmbedEnabled = () => getKey(LS_AUTOEMBED) !== 'off';

    function getBannedUrls() {
        try { return new Set(JSON.parse(getKey(LS_BANNED) || '[]')); }
        catch (e) { return new Set(); }
    }
    function saveBannedUrls(set) { localStorage.setItem(LS_BANNED, JSON.stringify([...set])); }
    function isBanned(url) { return getBannedUrls().has(url); }

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
        const banBtn = document.createElement('span');
        banBtn.className = 'sc-img-embed-ban';
        banBtn.textContent = '🚫';
        banBtn.title = "Hide this image everywhere and don't embed it again";
        banBtn.addEventListener('click', () => banUrl(a.href));
        badge.appendChild(badgeLabel);
        badge.appendChild(toggleBtn);
        badge.appendChild(banBtn);
        wrap.appendChild(link);
        wrap.appendChild(badge);
        msgEl.appendChild(wrap);
        a._scUi = wrap;
        rescrollChatIfNearBottom();
    }

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
