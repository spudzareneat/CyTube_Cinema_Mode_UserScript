    /* ==========================================================
       CHAT LINK PICTURE-IN-PICTURE — a floating preview window for
       YouTube links posted in chat. Image-hosting landing pages
       (postimg.cc etc.) used to be handled here too via a click, but
       moved to chatimages' zero-click auto-embed instead -- see that
       module's IMAGE-HOSTING LANDING PAGES section. getKey/setKey are
       core's (02-keys-and-helpers.js); getPlayerVideoEl is core's
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

    function isPipLink(url) {
        return !!extractYouTubeId(url);
    }

    /* ==========================================================
       SCANNING / ICON INJECTION
       Mirrors chatimages' scanImageEmbeds/startImageEmbedObserver
       (src/pc/modules/chatimages/index.js) -- its own
       MutationObserver on #messagebuffer, idempotent via a dataset
       marker so re-scans from later mutations don't reprocess a
       link. The `.sc-img-embed` exclusion is defensive -- keeps this
       module from ever touching a link chatimages has already turned
       into an embed, even though nothing currently produces that
       overlap.
    ========================================================== */
    function findQualifyingLinks(msgEl) {
        return [...msgEl.querySelectorAll('a[href]')]
            .filter(a => !a.dataset.scPipChecked && !a.closest('.sc-img-embed')
                && !a.classList.contains('sc-pip-icon')
                && (a.protocol === 'http:' || a.protocol === 'https:'));
    }

    function renderIcon(a) {
        a.dataset.scPipChecked = '1';
        if (!isPipLink(a.href)) return;
        a.title = 'Click to open in floating player';
        a.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openPip(a.href);
        });
        const newTabLink = document.createElement('a');
        newTabLink.className = 'sc-pip-icon';
        newTabLink.dataset.scPipChecked = '1'; // it's an <a href>, would otherwise re-match findQualifyingLinks and cascade
        newTabLink.href = a.href;
        newTabLink.target = '_blank';
        newTabLink.rel = 'noopener noreferrer';
        newTabLink.title = 'Open in new tab';
        newTabLink.textContent = '↗';
        a.insertAdjacentElement('afterend', newTabLink);
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

    function buildPanelBody(url) {
        const id = extractYouTubeId(url);
        const iframe = document.createElement('iframe');
        iframe.src = `https://www.youtube.com/embed/${encodeURIComponent(id)}?autoplay=1`;
        iframe.allow = 'autoplay; encrypted-media';
        iframe.className = 'sc-pip-frame';
        iframe.setAttribute('frameborder', '0');
        return iframe;
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

    function openPip(url) {
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
        pipPanel.querySelector('#sc-pip-body').appendChild(buildPanelBody(url));
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

        pipMuteState = mutePlayer();
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

    scRegisterSetting({ id: 'sc-input-pip', group: 'link-pip', label: 'Picture-in-picture for YouTube links in chat', note: 'Clicking a YouTube link opens it in a floating player instead of a new tab (a ↗ icon still opens it normally). Auto-mutes the main player while it plays.', key: LS_PIP_ENABLED, defaultOn: true, order: 8 });
