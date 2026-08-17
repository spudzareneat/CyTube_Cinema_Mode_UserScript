    /* ==========================================================
       EMOTE PICKER — a fully custom draggable panel that replaces
       CyTube's native #emotelist popup. relocateEmoteButton() in core
       (11-chat-input-and-emotes.js) still owns the floating
       #sc-emote-proxy trigger button; it just toggles this module's
       panel now instead of forwarding clicks to CyTube's own button.
       #emotelistbtn/#emotelist themselves are left untouched in the
       DOM -- this module only reads from them as a data-source
       fallback (see EMOTE DATA below), never shows them.
       Star/pin favoriting (a later task) gets an obvious empty slot
       per tile (.sc-emotes-tile-actions) to drop its icon into --
       nothing about favorites is built here.
    ========================================================== */

    /* ==========================================================
       EMOTE DATA — hybrid sourcing.
       Primary: unsafeWindow.CHANNEL.emotes, the array CyTube's own
       client keeps in sync ({name, image, source, regex} per entry --
       confirmed against calzoneman/sync's callbacks.js/util.js). Only
       `name`/`image` are used here; `source`/`regex` are irrelevant to
       clicking a tile (insertion is a literal `emote.name` string, not
       a regex match).
       readChannelEmotes() returns `null` only when CHANNEL.emotes isn't
       a real array yet (not loaded / malformed) -- a genuinely-loaded
       empty array comes back as `[]`, distinct from `null`. This
       distinction matters: computeEmoteList() must never fall through
       to the DOM-scrape fallback for a channel that has confirmed zero
       emotes, only for one whose data truly isn't available.
       Fallback: scrape #emotelist img.channel-emote nodes directly
       (img.src/img.title, matching CyTube's own emoteToImg() output).
       CyTube renders #emotelist's contents once it has emote data,
       independent of whether the popup has ever been opened, but on
       the rare chance it hasn't rendered yet AND the caller is the
       user actually opening our panel (`allowForceRender` -- never
       true for a passive background socket event, see
       bindEmoteSocketEvents() below), force it open-then-closed via
       #emotelistbtn (the same element relocateEmoteButton() already
       references) so the DOM scrape has something to read -- the
       native popup is never left visible to the user, and never
       flashed unprompted while nobody has asked to see emotes at all.
       _uw is core's shared unsafeWindow/window fallback (see
       03-gif-bridge.js / 04-channel-script-autoapprove.js) -- this
       module doesn't redeclare it.
    ========================================================== */
    function readChannelEmotes() {
        try {
            const arr = _uw.CHANNEL && _uw.CHANNEL.emotes;
            if (!Array.isArray(arr)) return null; // not loaded yet / malformed
            const out = [];
            for (const e of arr) {
                if (e && typeof e.name === 'string' && e.name && typeof e.image === 'string' && e.image) {
                    out.push({ name: e.name, image: e.image });
                }
            }
            return out; // may legitimately be [] -- a real array means the channel truly has (or filtered down to) zero usable emotes
        } catch (e) { return null; }
    }

    function readEmotesFromDom() {
        const out = [];
        document.querySelectorAll('#emotelist img.channel-emote').forEach(img => {
            const name = img.title;
            const image = img.src;
            if (name && image) out.push({ name, image });
        });
        return out;
    }

    // The click-open-then-close dance is real UI disruption (it briefly
    // shows/hides CyTube's own popup), so `allowForceRender` gates it to
    // only ever run when the user actually opened our panel (never from
    // a background socket refresh), and even then only once per page
    // load via this flag. Plain DOM reads (no click) are cheap and still
    // attempted every call regardless of `allowForceRender`.
    let _scEmoteForceRenderAttempted = false;
    function scrapeEmotesFallback(allowForceRender) {
        let out = readEmotesFromDom();
        if (out.length || !allowForceRender || _scEmoteForceRenderAttempted) return out;
        _scEmoteForceRenderAttempted = true;
        const btn = document.getElementById('emotelistbtn');
        if (btn) {
            try {
                btn.click(); // force a native render if it hasn't happened yet
                out = readEmotesFromDom();
            } finally {
                btn.click(); // close it again -- our panel is what actually shows
            }
        }
        return out;
    }

    // `allowForceRender` must only be true when called in direct response
    // to the user opening the panel (see openEmotesPanel()) -- background
    // callers (the socket handler below) always pass false/omit it, so an
    // emote-less or not-yet-loaded channel never flashes CyTube's native
    // popup on its own.
    function computeEmoteList(allowForceRender) {
        const fromChannel = readChannelEmotes();
        if (fromChannel !== null) return fromChannel; // genuine data, even if empty
        return scrapeEmotesFallback(!!allowForceRender);
    }

    let _scEmoteData = [];

    // Re-derives the emote list and, if the panel is currently open,
    // re-renders its grid in place (preserving whatever search filter
    // is active). Called on first panel open (allowForceRender=true) and
    // whenever a live emote-list socket event fires (allowForceRender
    // omitted/false -- a background refresh never triggers the native-
    // popup force-render dance). Never throws -- worst case the list
    // just doesn't refresh.
    function refreshEmoteData(allowForceRender) {
        try {
            _scEmoteData = computeEmoteList(allowForceRender);
        } catch (e) {
            console.warn('[SC][emote-picker] failed to refresh emote data:', e);
            return;
        }
        const grid = document.getElementById('sc-emotes-grid');
        if (!grid) return;
        const search = document.getElementById('sc-emotes-search');
        renderEmoteGrid(grid, _scEmoteData, search ? search.value : '');
    }

    // Guarded/retried the same way core's initChatTimestamps guards its
    // own socket.on('chatMsg', ...) hookup (12-playback-sync-and-seek.js)
    // -- `socket` may not exist yet at script-load time (document-start),
    // so poll for it instead of assuming it's ready. If it never shows up,
    // the emote list simply never live-updates; nothing here throws.
    function bindEmoteSocketEvents() {
        let bound = false;
        const tryBind = () => {
            if (bound || typeof socket === 'undefined' || !socket || !socket.on) return;
            bound = true;
            // Background refresh only -- never force-renders the native
            // popup (see computeEmoteList()'s allowForceRender contract).
            const onEmoteUpdate = () => refreshEmoteData(false);
            // Registered after CyTube's own handlers for these events, so by
            // the time this fires CHANNEL.emotes already reflects the change.
            socket.on('emoteList', onEmoteUpdate);
            socket.on('updateEmote', onEmoteUpdate);
            socket.on('removeEmote', onEmoteUpdate);
        };
        tryBind();
        window.addEventListener('load', () => { tryBind(); setTimeout(tryBind, 2000); });
        const poll = setInterval(() => { tryBind(); if (bound) clearInterval(poll); }, 250);
        setTimeout(() => clearInterval(poll), 10000);
    }
    bindEmoteSocketEvents();

    /* ==========================================================
       PANEL CSS (lazily injected on first open, matching the
       gifmaker/subtitles convention)
    ========================================================== */
    function injectEmotesPanelCss() {
        if (document.getElementById('scemotes-panel-style')) return;
        const style = document.createElement('style');
        style.id = 'scemotes-panel-style';
        style.textContent = `
            #sc-emotes-panel {
                position: fixed !important;
                z-index: 30002 !important;
                width: 340px !important; max-width: 92vw !important;
                max-height: 56vh !important;
                display: flex !important; flex-direction: column !important;
                background: #0c0c0e !important;
                border: 1px solid rgba(244,244,242,0.14) !important;
                border-radius: 12px !important;
                box-shadow: 0 12px 40px rgba(0,0,0,0.6) !important;
                color: #f4f4f2 !important; font-size: 13px !important;
                font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif !important;
            }
            #sc-emotes-head {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                flex: none !important;
                padding: 10px 16px !important;
                border-bottom: 1px solid rgba(244,244,242,0.08) !important;
                font-weight: 700 !important; font-size: 14px !important; color: #ff5fa8 !important;
                letter-spacing: 0.01em !important;
                cursor: grab !important; user-select: none !important; touch-action: none !important;
            }
            #sc-emotes-head.sc-emotes-dragging { cursor: grabbing !important; }
            #sc-emotes-close {
                background: transparent !important; border: none !important; color: rgba(244,244,242,0.62) !important;
                font-size: 15px !important; cursor: pointer !important; padding: 0 4px !important;
                transition: color 120ms ease !important;
            }
            #sc-emotes-close:hover { color: #f4f4f2 !important; }
            #sc-emotes-body {
                padding: 10px 12px 12px !important;
                display: flex !important; flex-direction: column !important; gap: 8px !important;
                flex: 1 1 auto !important; min-height: 0 !important;
            }
            .sc-emotes-search {
                flex: none !important;
                background: rgba(255,255,255,0.06) !important; color: #f4f4f2 !important;
                border: 1px solid rgba(255,255,255,0.18) !important; border-radius: 6px !important;
                padding: 6px 10px !important; font-size: 13px !important;
                box-sizing: border-box !important; width: 100% !important;
                transition: border-color 120ms ease !important;
            }
            .sc-emotes-search:hover, .sc-emotes-search:focus { border-color: rgba(255,95,168,0.5) !important; }
            .sc-emotes-search::placeholder { color: rgba(244,244,242,0.34) !important; }
            .sc-emotes-grid {
                flex: 1 1 auto !important; min-height: 0 !important; overflow-y: auto !important;
                display: grid !important;
                grid-template-columns: repeat(auto-fill, minmax(48px, 1fr)) !important;
                gap: 6px !important;
                align-content: start !important;
                scrollbar-width: thin !important; scrollbar-color: rgba(244,244,242,0.2) #000 !important;
            }
            .sc-emotes-grid::-webkit-scrollbar { width: 10px !important; }
            .sc-emotes-grid::-webkit-scrollbar-track { background: #000 !important; }
            .sc-emotes-grid::-webkit-scrollbar-thumb {
                background: rgba(244,244,242,0.2) !important; border-radius: 6px !important; border: 2px solid #000 !important;
            }
            .sc-emotes-grid::-webkit-scrollbar-thumb:hover { background: #ff5fa8 !important; }
            .sc-emotes-tile {
                position: relative !important;
                display: flex !important; align-items: center !important; justify-content: center !important;
                background: rgba(244,244,242,0.04) !important;
                border: 1px solid rgba(244,244,242,0.08) !important; border-radius: 6px !important;
                padding: 4px !important; height: 44px !important; box-sizing: border-box !important;
                cursor: pointer !important;
                transition: background-color 120ms ease, border-color 120ms ease !important;
            }
            .sc-emotes-tile:hover, .sc-emotes-tile:focus-visible {
                background: rgba(255,95,168,0.14) !important; border-color: #ff5fa8 !important;
                outline: none !important;
            }
            .sc-emotes-tile img {
                max-width: 100% !important; max-height: 32px !important;
                display: block !important; pointer-events: none !important;
            }
            /* Empty for now -- Task 2 (star favoriting) drops its icon in here. */
            .sc-emotes-tile-actions {
                position: absolute !important; top: 2px !important; right: 2px !important;
                pointer-events: none !important;
            }
            .sc-emotes-empty {
                grid-column: 1 / -1 !important;
                padding: 18px 4px !important; text-align: center !important;
                color: rgba(244,244,242,0.4) !important; font-size: 12px !important;
            }

            /* Orientation-aware sizing/placement -- mirrors the pattern
               00-layout-core.css already uses for other panels/buttons
               (e.g. #sc-poll-panel, #sc-emote-proxy). Default spawn point
               anchors near #sc-emote-proxy's own corner per layout, not
               screen-center like the GIF/caption panels. Only applies
               while no saved position exists -- openEmotesPanel() sets
               explicit left/top inline (clearing right/bottom) once a
               drag has been saved. */
            body.sc-horizontal #sc-emotes-panel {
                bottom: 6px !important; right: 8px !important;
                width: 420px !important; max-height: 46vh !important;
            }
            body.sc-horizontal .sc-emotes-grid {
                grid-template-columns: repeat(auto-fill, minmax(52px, 1fr)) !important;
            }
            body.sc-vertical #sc-emotes-panel {
                bottom: 18px !important; right: 8px !important;
                width: 280px !important; max-height: 66vh !important;
            }
            body.sc-vertical .sc-emotes-grid {
                grid-template-columns: repeat(auto-fill, minmax(44px, 1fr)) !important;
            }
        `;
        document.head.appendChild(style);
    }

    /* ==========================================================
       DRAG + CLAMP HELPER
       Adapted from the (independently duplicated) pointer-drag logic
       in gifmaker's openGifPanel (src/pc/modules/gifmaker/index.js
       around line 1342) and subtitles' openSubtitlePanel
       (src/pc/modules/subtitles/index.js around line 490). Net-new
       here, local to this module, and used only by #sc-emotes-panel --
       gifmaker/subtitles keep their own copies untouched.
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
            if (e.target.closest('button')) return; // don't start a drag from the close button
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

    /* ==========================================================
       PERSISTED POSITION — LS_EMOTE_PANEL_POS / getKey / setKey are
       core's (02-keys-and-helpers.js). Missing or unparseable falls
       back to the smart default spawn point (the orientation-aware
       CSS bottom/right rules above), same as chatimages' LS_BANNED
       JSON-array convention (getKey(...) || fallback, wrapped in try).
    ========================================================== */
    function getSavedEmotePanelPos() {
        try {
            const raw = getKey(LS_EMOTE_PANEL_POS);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed.left === 'number' && typeof parsed.top === 'number') return parsed;
        } catch (e) {}
        return null;
    }
    function saveEmotePanelPos(left, top) {
        try { setKey(LS_EMOTE_PANEL_POS, JSON.stringify({ left, top })); } catch (e) {}
    }

    /* ==========================================================
       INSERTION — #sc-chat-textarea is the real send-source (doSend()
       in 11-chat-input-and-emotes.js reads its .value directly), so
       this writes there and nowhere else -- no round-trip through the
       native input or startEmoteWatcher().
    ========================================================== */
    function insertEmoteIntoChat(name) {
        const textarea = document.getElementById('sc-chat-textarea');
        if (!textarea || !name) return;
        const start = typeof textarea.selectionStart === 'number' ? textarea.selectionStart : textarea.value.length;
        const end = typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : textarea.value.length;
        textarea.value = textarea.value.slice(0, start) + name + textarea.value.slice(end);
        const newPos = start + name.length;
        textarea.selectionStart = textarea.selectionEnd = newPos;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
    }

    function _emoteEscHtml(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    // Live case-insensitive substring filter on emote.name, re-rendered
    // on every search keystroke and on data refresh.
    function renderEmoteGrid(grid, list, searchTerm) {
        const term = (searchTerm || '').trim().toLowerCase();
        const filtered = term ? list.filter(e => e.name.toLowerCase().includes(term)) : list;
        if (!filtered.length) {
            grid.innerHTML = `<div class="sc-emotes-empty">${list.length ? 'No matching emotes' : 'No emotes available'}</div>`;
            return;
        }
        grid.innerHTML = filtered.map(e => (
            `<button type="button" class="sc-emotes-tile" data-emote-name="${_emoteEscHtml(e.name)}">` +
                `<img src="${_emoteEscHtml(e.image)}" alt="${_emoteEscHtml(e.name)}" title="${_emoteEscHtml(e.name)}" loading="lazy">` +
                `<span class="sc-emotes-tile-actions"></span>` +
            `</button>`
        )).join('');
    }

    /* ==========================================================
       OPEN / CLOSE / TOGGLE — toggleEmotesPanel is what core's
       relocateEmoteButton() (11-chat-input-and-emotes.js) calls.
    ========================================================== */
    function openEmotesPanel() {
        if (document.getElementById('sc-emotes-panel')) return;
        injectEmotesPanelCss();
        // allowForceRender=true: only here, in direct response to the user
        // opening the panel, is the disruptive native-popup click-dance
        // permitted (see computeEmoteList()/scrapeEmotesFallback() above).
        if (!_scEmoteData.length) refreshEmoteData(true);

        const panel = document.createElement('div');
        panel.id = 'sc-emotes-panel';
        panel.innerHTML = `
            <div id="sc-emotes-head">
                <span>Emotes</span>
                <button id="sc-emotes-close" type="button">✕</button>
            </div>
            <div id="sc-emotes-body">
                <input type="text" id="sc-emotes-search" class="sc-emotes-search" placeholder="Search emotes…" autocomplete="off" inputmode="none">
                <div id="sc-emotes-grid" class="sc-emotes-grid"></div>
            </div>`;
        document.body.appendChild(panel);

        const search = panel.querySelector('#sc-emotes-search');
        const grid = panel.querySelector('#sc-emotes-grid');
        renderEmoteGrid(grid, _scEmoteData, '');

        search.addEventListener('input', () => renderEmoteGrid(grid, _scEmoteData, search.value));

        grid.addEventListener('click', (e) => {
            const tile = e.target.closest('.sc-emotes-tile');
            if (!tile) return;
            insertEmoteIntoChat(tile.dataset.emoteName);
            closeEmotesPanel();
        });

        panel.querySelector('#sc-emotes-close').addEventListener('click', closeEmotesPanel);

        // Apply a saved drag position (clamped against the panel's actual
        // rendered size, in case the viewport shrank since it was saved).
        // Otherwise leave the orientation-aware CSS bottom/right default
        // from injectEmotesPanelCss() alone.
        const saved = getSavedEmotePanelPos();
        if (saved) {
            const rect = panel.getBoundingClientRect();
            const { x, y } = clampPanelPos(saved.left, saved.top, rect.width, rect.height);
            panel.style.setProperty('left', x + 'px', 'important');
            panel.style.setProperty('top', y + 'px', 'important');
            panel.style.setProperty('right', 'auto', 'important');
            panel.style.setProperty('bottom', 'auto', 'important');
        }

        makePanelDraggable(panel, panel.querySelector('#sc-emotes-head'), 'sc-emotes-dragging', (left, top) => {
            saveEmotePanelPos(left, top);
        });
    }

    function closeEmotesPanel() {
        const panel = document.getElementById('sc-emotes-panel');
        if (panel) panel.remove();
    }

    function toggleEmotesPanel() {
        if (document.getElementById('sc-emotes-panel')) closeEmotesPanel();
        else openEmotesPanel();
    }
