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
                    if (res.status < 200 || res.status >= 300) { resolve(null); return; }
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

       getPlayerVideoEl() falls back to document.querySelector('video')
       when #ytapiplayer has no <video>, which can match gifmaker's
       offscreen preview/scrub <video> clones appended to
       document.body (src/pc/modules/gifmaker/index.js). Scoped here
       to #ytapiplayer to exclude those, mirroring the guard in
       src/pc/modules/playback-recovery/index.js (onNativeError).
    ========================================================== */
    function getScopedPlayerVideoEl() {
        const v = getPlayerVideoEl();
        if (v && v.closest && v.closest('#ytapiplayer')) return v;
        return null;
    }

    function mutePlayer() {
        const v = getScopedPlayerVideoEl();
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
            const v = getScopedPlayerVideoEl();
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
       src/pc/modules/emote-picker/index.js. Named with a Pip-
       specific suffix (clampPipPanelPos/makePipPanelDraggable)
       to avoid colliding with emote-picker's own local copies of
       clampPanelPos/makePanelDraggable -- all modules concatenate
       into one shared top-level scope at build time (see
       scripts/assemble.mjs), so identical top-level function
       names between modules would silently shadow one another.
    ========================================================== */
    function clampPipPanelPos(left, top, width, height) {
        return {
            x: Math.min(Math.max(left, -(width - 40)), window.innerWidth - 40),
            y: Math.min(Math.max(top, 0), window.innerHeight - 32),
        };
    }

    function makePipPanelDraggable(panel, head, draggingClass, onDragEnd) {
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
            const { x, y } = clampPipPanelPos(e.clientX - dragDX, e.clientY - dragDY, rect.width, rect.height);
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
            iframe.src = `https://www.youtube.com/embed/${encodeURIComponent(id)}?autoplay=1`;
            iframe.allow = 'autoplay; encrypted-media';
            iframe.className = 'sc-pip-frame';
            iframe.setAttribute('frameborder', '0');
            return iframe;
        }
        const holder = document.createElement('div');
        holder.className = 'sc-pip-image-holder';
        holder.textContent = 'Loading…';
        const showNoImageFallback = () => {
            holder.innerHTML = '';
            holder.append("Couldn't find an image on this page. ");
            const link = document.createElement('a');
            link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
            link.textContent = 'Open page';
            holder.appendChild(link);
        };
        resolveOgImage(url).then(imgUrl => {
            if (!holder.isConnected) return; // panel closed before the fetch finished
            if (imgUrl) {
                try {
                    const proto = new URL(imgUrl).protocol;
                    if (proto !== 'http:' && proto !== 'https:') imgUrl = null;
                } catch (e) { imgUrl = null; }
            }
            if (!imgUrl) { showNoImageFallback(); return; }
            holder.innerHTML = '';
            const img = document.createElement('img');
            img.referrerPolicy = 'no-referrer';
            img.onerror = showNoImageFallback;
            img.src = imgUrl;
            holder.appendChild(img);
        });
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
            const { x, y } = clampPipPanelPos(saved.left, saved.top, rect.width, rect.height);
            pipPanel.style.setProperty('left', x + 'px', 'important');
            pipPanel.style.setProperty('top', y + 'px', 'important');
            pipPanel.style.setProperty('right', 'auto', 'important');
            pipPanel.style.setProperty('bottom', 'auto', 'important');
        }
        makePipPanelDraggable(pipPanel, pipPanel.querySelector('#sc-pip-head'), 'sc-pip-dragging', (left, top) => {
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

    scRegisterSetting({ id: 'sc-input-pip', group: 'link-pip', label: 'Picture-in-picture for chat links', note: 'Adds a 🗗 icon next to YouTube links and postimg.cc/ibb.co/prnt.sc links in chat to open a floating preview. Auto-mutes the main player while a YouTube PiP plays.', key: LS_PIP_ENABLED, defaultOn: true, order: 8 });
