    /* ==========================================================
       CHAT IMAGES — auto-embed for direct image links in chat, with
       hover filenames and a per-image ban/unban. Originally a
       standalone companion script (cytube.chatimages.user.js) that
       detected cytube.pc.user.js at runtime via a polled bridge
       object; now always bundled alongside core, so that detection
       is gone and embeddingEnabled() always honors the Settings
       Modal's toggle directly. `getKey`/`autoEmbedEnabled`/
       `LS_AUTOEMBED` are core's (02-keys-and-helpers.js) — this
       module doesn't redeclare them.
    ========================================================== */
    const LS_BANNED = 'sc_img_banned_urls'; // private to this module -- JSON array of exact banned URLs

    function getBannedUrls() {
        try { return new Set(JSON.parse(getKey(LS_BANNED) || '[]')); }
        catch (e) { return new Set(); }
    }
    function saveBannedUrls(set) { localStorage.setItem(LS_BANNED, JSON.stringify([...set])); }
    function isBanned(url) { return getBannedUrls().has(url); }

    function embeddingEnabled() {
        return autoEmbedEnabled();
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
            .filter(a => !a.dataset.scEmbedded && !a.closest('.sc-img-embed')
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

    /* ==========================================================
       IMAGE-HOSTING LANDING PAGES
       Some chat links point at a page *about* an image (postimg.cc,
       ibb.co, prnt.sc) rather than a direct image URL, so IMAGE_LINK_RE
       above never matches them. For a small curated host allowlist,
       fetch the page and read its og:image meta tag instead. Moved
       here from link-pip (which used to require a click to open these
       in a floating preview) so they get the exact same zero-click
       auto-embed, ban/unban, and toggle as direct image links.
    ========================================================== */
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

    // Memoizes the in-flight Promise itself (not just its resolved value) so
    // two near-simultaneous reposts of the same URL share one fetch instead
    // of firing two. A failed resolution (null) evicts its own cache entry
    // once settled, so a later repost gets a fresh attempt instead of being
    // permanently poisoned by one bad fetch/timeout.
    const ogImageCache = new Map(); // url -> Promise<string|null>
    function resolveOgImageCached(url) {
        if (!ogImageCache.has(url)) {
            const p = resolveOgImage(url);
            p.then(result => { if (result === null) ogImageCache.delete(url); });
            ogImageCache.set(url, p);
        }
        return ogImageCache.get(url);
    }

    function findImageHostPageLinks(msgEl) {
        return [...msgEl.querySelectorAll('a[href]')]
            .filter(a => !a.dataset.scEmbedded && !a.closest('.sc-img-embed')
                && (a.protocol === 'http:' || a.protocol === 'https:') && isImageHostPage(a.href));
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

    // Self-contained (not sharing DOM-building code with applyEmbeddedState
    // above) -- applyEmbeddedState is proven, shipped code with no automated
    // test coverage, and this path is new/async/racy enough to want
    // reviewing and testing in isolation rather than refactoring the one
    // that already works.
    function applyResolvedEmbedState(a) {
        const msgEl = a.closest('[class*="chat-msg-"]');
        if (!msgEl) return;
        a.style.display = 'none';
        const wrap = document.createElement('div');
        wrap.className = 'sc-img-embed';
        const link = document.createElement('a');
        link.href = a.href; // landing page until resolution replaces it below
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        // No img.src yet -- an empty string is treated by some browsers as a
        // request to the current page and fires onerror immediately. Left
        // unset until the fetch resolves.
        link.appendChild(img);
        const badge = document.createElement('span');
        badge.className = 'sc-img-embed-badge';
        const badgeLabel = document.createElement('span');
        badgeLabel.textContent = '🖼 loading…';
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

        resolveOgImageCached(a.href).then(imgUrl => {
            if (!wrap.isConnected) return; // removed (banned, toggled, etc.) before the fetch settled
            if (!imgUrl) { wrap.remove(); a.style.display = ''; if (a._scUi === wrap) a._scUi = null; return; }
            link.href = imgUrl;
            img.title = filenameFromUrl(imgUrl);
            img.onerror = () => { wrap.remove(); a.style.display = ''; };
            img.onload = rescrollChatIfNearBottom;
            img.src = imgUrl;
            badgeLabel.textContent = '🖼 embedded';
            rescrollChatIfNearBottom();
        });
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
        // The two URL categories are mutually exclusive by construction
        // (extension-based direct image vs. bare landing-page hostname), so
        // this dispatch is unambiguous.
        sweepUrl(url, isImageHostPage(url) ? applyResolvedEmbedState : applyEmbeddedState);
    }

    function renderLink(a) {
        a.dataset.scEmbedded = '1';
        if (isBanned(a.href)) applyBannedState(a);
        else applyEmbeddedState(a);
    }

    function renderHostPageLink(a) {
        a.dataset.scEmbedded = '1';
        if (isBanned(a.href)) applyBannedState(a);
        else applyResolvedEmbedState(a);
    }

    function scanImageEmbeds(buf) {
        if (!embeddingEnabled()) return;
        buf.querySelectorAll('[class*="chat-msg-"]').forEach(msgEl => {
            findImageLinks(msgEl).forEach(renderLink);
            findImageHostPageLinks(msgEl).forEach(renderHostPageLink);
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
    // Named chatimagesBoot (not waitForBody) — core's own 16-boot.js declares
    // a generic waitForBody in the same shared scope; this module's boot
    // routine has always been distinct code (it only injects this module's
    // style and starts its own observer), so it gets its own name here to
    // avoid the collision now that both files share one IIFE. Called
    // directly here (not via scRegisterInit) to preserve the original
    // script's document-start timing -- scRegisterInit's queue only runs on
    // the page's 'load' event, much later than this module wants to start
    // watching the message buffer.
    function chatimagesBoot() {
        if (!document.body) { requestAnimationFrame(chatimagesBoot); return; }
        injectStyle();
        startImageEmbedObserver();
    }

    chatimagesBoot();

    // order: 3 reproduces the original shipped script's settings-row sequence
    // (spellcheck, movielinks, autoembed, gifoptimize) — see
    // src/pc/core/15-settings-modal-shell.js, which sorts SC_SETTINGS_ROWS by
    // this field before rendering. Row relocated here from core per Task 4 of
    // the companion-scripts-to-modules plan (was previously hardcoded in core
    // since this module didn't exist yet).
    scRegisterSetting({ id: 'sc-input-autoembed', group: 'chat-images', label: 'Auto-embed image links in chat', note: 'Shows a thumbnail preview under messages that link directly to an image, or to a supported image-hosting page (postimg.cc, ibb.co, prnt.sc), marked "🖼 embedded"', key: LS_AUTOEMBED, defaultOn: true, order: 3 });
