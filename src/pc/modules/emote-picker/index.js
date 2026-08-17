    /* ==========================================================
       EMOTE PICKER — a fully custom draggable panel that replaces
       CyTube's native #emotelist popup. relocateEmoteButton() in core
       (11-chat-input-and-emotes.js) still owns the floating
       #sc-emote-proxy trigger button; it just toggles this module's
       panel now instead of forwarding clicks to CyTube's own button.
       #emotelistbtn/#emotelist themselves are left untouched in the
       DOM -- this module only reads from them as a data-source
       fallback (see EMOTE DATA below), never shows them.
       Star/pin favoriting lives in the FAVORITES sections below --
       the star toggle sits inside each tile's .sc-emotes-tile-actions
       slot (originally left empty), and LS_EMOTE_FAVORITES persists
       the favorited name list.
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
        const favRow = document.getElementById('sc-emotes-favorites');
        if (favRow) renderFavoritesRow(favRow, _scEmoteData);
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
            /* Holds the star favorite-toggle. pointer-events:none here so
               the container itself never swallows clicks meant for
               anything else in the tile; .sc-emotes-star below overrides
               back to pointer-events:auto on itself so it still receives
               its own clicks. */
            .sc-emotes-tile-actions {
                position: absolute !important; top: 2px !important; right: 2px !important;
                pointer-events: none !important;
            }
            .sc-emotes-star {
                pointer-events: auto !important;
                display: flex !important; align-items: center !important; justify-content: center !important;
                width: 16px !important; height: 16px !important;
                font-size: 12px !important; line-height: 1 !important;
                color: rgba(244,244,242,0.5) !important;
                background: rgba(0,0,0,0.4) !important;
                border-radius: 4px !important;
                cursor: pointer !important;
                transition: color 120ms ease, transform 120ms ease !important;
            }
            .sc-emotes-star:hover, .sc-emotes-star:focus-visible {
                color: #f4f4f2 !important; outline: none !important; transform: scale(1.12) !important;
            }
            .sc-emotes-star-active {
                color: #ffd24a !important;
            }
            .sc-emotes-star-active:hover, .sc-emotes-star-active:focus-visible { color: #ffdd70 !important; }
            .sc-emotes-empty {
                grid-column: 1 / -1 !important;
                padding: 18px 4px !important; text-align: center !important;
                color: rgba(244,244,242,0.4) !important; font-size: 12px !important;
            }
            /* Pinned favorites row -- lives between the search input and
               the main grid, only occupying space when non-empty (see
               renderFavoritesRow()). Same tile size as the grid, just
               wrapped in a flex row instead of a grid so a handful of
               favorites don't stretch to fill the panel's full width. */
            .sc-emotes-favorites {
                display: flex !important; flex-wrap: wrap !important; gap: 6px !important;
                flex: none !important; max-height: 100px !important; overflow-y: auto !important;
                padding-bottom: 8px !important; margin-bottom: 2px !important;
                border-bottom: 1px solid rgba(244,244,242,0.1) !important;
            }
            .sc-emotes-favorites:empty {
                display: none !important; padding: 0 !important; margin: 0 !important; border: none !important;
            }
            .sc-emotes-favorites .sc-emotes-tile {
                flex: 0 0 44px !important; width: 44px !important;
            }

            /* Orientation-aware sizing/placement -- mirrors the pattern
               00-layout-core.css already uses for other panels/buttons
               (e.g. #sc-poll-panel, #sc-emote-proxy). Default spawn point
               anchors near #sc-emote-proxy's own corner per layout, not
               screen-center like the GIF/caption panels -- but offset
               *past* the button's own footprint (00-layout-core.css:
               #fs-toggle-btn, #sc-emote-proxy is a 28px circle, 1px
               border) rather than directly on top of it, so the trigger
               stays clickable (and therefore closeable) once the panel
               is open instead of being buried under it (z-index 30002
               vs. the proxy's 20002). Only applies while no saved
               position exists -- openEmotesPanel() sets explicit
               left/top inline (clearing right/bottom) once a drag has
               been saved. */
            body.sc-horizontal #sc-emotes-panel {
                /* proxy: bottom 6px, 28px + 1px border tall -> top edge
                   sits ~36px up; clear it with a bit of breathing room */
                bottom: 44px !important; right: 8px !important;
                width: 420px !important; max-height: 46vh !important;
            }
            body.sc-horizontal .sc-emotes-grid {
                grid-template-columns: repeat(auto-fill, minmax(52px, 1fr)) !important;
            }
            body.sc-vertical #sc-emotes-panel {
                /* proxy: bottom 18px, ~30px tall -> top edge ~48px up */
                bottom: 56px !important; right: 8px !important;
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
       PERSISTED FAVORITES — LS_EMOTE_FAVORITES / getKey / setKey are
       core's (02-keys-and-helpers.js), same JSON-array convention as
       chatimages' LS_BANNED (src/pc/modules/chatimages/index.js).
       _scEmoteFavorites is the in-memory Set of favorited emote
       `name` strings; loadFavorites() (re)reads it from storage on
       every panel open so the star states/pinned row start accurate,
       and saveFavorites() persists it on every toggle. A favorited
       name that no longer resolves to a current channel emote (e.g.
       it was removed) is never pruned here -- renderFavoritesRow()
       below just skips rendering it, storage keeps the name in case
       the emote comes back.
    ========================================================== */
    let _scEmoteFavorites = new Set();
    function loadFavorites() {
        try {
            const arr = JSON.parse(getKey(LS_EMOTE_FAVORITES) || '[]');
            if (Array.isArray(arr)) return new Set(arr.filter(n => typeof n === 'string' && n));
        } catch (e) {}
        return new Set();
    }
    function saveFavorites() {
        try { setKey(LS_EMOTE_FAVORITES, JSON.stringify([..._scEmoteFavorites])); } catch (e) {}
    }
    function toggleFavorite(name) {
        if (!name) return;
        const isFav = !_scEmoteFavorites.has(name);
        if (isFav) _scEmoteFavorites.add(name);
        else _scEmoteFavorites.delete(name);
        saveFavorites();
        refreshFavoritesUI(name, isFav);
    }
    // Updates the UI after a toggle WITHOUT rebuilding the main grid --
    // rebuilding it (grid.innerHTML = ...) used to reset its scrollTop
    // to 0 and destroy/recreate whatever tile currently held keyboard
    // focus, so starring an emote after scrolling down (or starring
    // several in a row via keyboard/D-pad) threw the user back to the
    // top and dropped focus to <body> every time. A tile's presence in
    // the main grid never depends on favorite status, so its star is
    // just mutated in place (there may be a second matching star in the
    // pinned favorites row too -- both get updated, neither destroyed).
    // The pinned row's *tile membership* does change on every toggle
    // (the emote needs to appear/disappear there), so that row alone is
    // still fully re-rendered here.
    function refreshFavoritesUI(name, isFav) {
        document.querySelectorAll('#sc-emotes-panel .sc-emotes-star').forEach(star => {
            if (star.dataset.emoteName === name) setEmoteStarState(star, isFav);
        });
        const favRow = document.getElementById('sc-emotes-favorites');
        if (favRow) renderFavoritesRow(favRow, _scEmoteData);
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

    // Shared between renderEmoteTile() (initial markup) and
    // setEmoteStarState() (in-place toggle update, see refreshFavoritesUI()
    // above) so the two never drift on wording.
    function _emoteStarLabel(isFav) {
        return isFav ? 'Remove from favorites' : 'Add to favorites';
    }

    // Mutates an already-rendered star in place -- glyph, active class,
    // aria-pressed/aria-label/title -- without touching the tile/button
    // it lives in. Used by refreshFavoritesUI() so toggling a favorite
    // never has to destroy and recreate the grid (or favorites row) DOM.
    function setEmoteStarState(star, isFav) {
        star.classList.toggle('sc-emotes-star-active', isFav);
        star.setAttribute('aria-pressed', isFav ? 'true' : 'false');
        const label = _emoteStarLabel(isFav);
        star.setAttribute('aria-label', label);
        star.title = label;
        star.textContent = isFav ? '★' : '☆';
    }

    // Shared tile markup for both the main grid and the pinned favorites
    // row -- keeps the two renderers from carrying near-duplicate copies
    // of this template. The tile itself is a <button> (click = insert),
    // so the star toggle inside it is deliberately NOT a <button> --
    // nested buttons get silently mangled/reparented by the browser.
    // isFav drives the filled/outline glyph and aria-pressed state; the
    // star sets its own pointer-events:auto to override the container's
    // pointer-events:none (see .sc-emotes-tile-actions in
    // injectEmotesPanelCss()) so it actually receives clicks.
    function renderEmoteTile(e, isFav) {
        const name = _emoteEscHtml(e.name);
        const starLabel = _emoteStarLabel(isFav);
        return `<button type="button" class="sc-emotes-tile" data-emote-name="${name}">` +
                `<img src="${_emoteEscHtml(e.image)}" alt="${name}" title="${name}" loading="lazy">` +
                `<span class="sc-emotes-tile-actions">` +
                    `<span class="sc-emotes-star${isFav ? ' sc-emotes-star-active' : ''}" role="button" tabindex="0" ` +
                        `data-emote-name="${name}" aria-pressed="${isFav ? 'true' : 'false'}" ` +
                        `aria-label="${starLabel}" title="${starLabel}">${isFav ? '★' : '☆'}</span>` +
                `</span>` +
            `</button>`;
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
        grid.innerHTML = filtered.map(e => renderEmoteTile(e, _scEmoteFavorites.has(e.name))).join('');
    }

    // Pinned row directly under the search input, above the main grid.
    // Same tile markup/star as the main grid -- favorited emotes still
    // also render in their normal spot below, they aren't removed from
    // that list. A favorited name no longer present in `list` (channel
    // emote removed) is simply skipped -- see LS_EMOTE_FAVORITES above.
    // Left empty (and hidden via the :empty CSS rule) when there are no
    // favorites, or none of them currently resolve.
    function renderFavoritesRow(row, list) {
        if (!_scEmoteFavorites.size) { row.innerHTML = ''; return; }
        const favTiles = list.filter(e => _scEmoteFavorites.has(e.name));
        row.innerHTML = favTiles.map(e => renderEmoteTile(e, true)).join('');
    }

    /* ==========================================================
       OPEN / CLOSE / TOGGLE — toggleEmotesPanel is what core's
       relocateEmoteButton() (11-chat-input-and-emotes.js) calls.
    ========================================================== */
    function openEmotesPanel() {
        if (document.getElementById('sc-emotes-panel')) return;
        injectEmotesPanelCss();
        // Read on every open so star states / the pinned row reflect
        // whatever was last saved (see PERSISTED FAVORITES above).
        _scEmoteFavorites = loadFavorites();
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
                <div id="sc-emotes-favorites" class="sc-emotes-favorites"></div>
                <div id="sc-emotes-grid" class="sc-emotes-grid"></div>
            </div>`;
        document.body.appendChild(panel);

        const body = panel.querySelector('#sc-emotes-body');
        const search = panel.querySelector('#sc-emotes-search');
        const favRow = panel.querySelector('#sc-emotes-favorites');
        const grid = panel.querySelector('#sc-emotes-grid');
        renderEmoteGrid(grid, _scEmoteData, '');
        renderFavoritesRow(favRow, _scEmoteData);

        search.addEventListener('input', () => {
            renderEmoteGrid(grid, _scEmoteData, search.value);
            // The pinned row is never search-filtered -- leave it alone.
        });

        // Delegated at the body level so one pair of listeners covers
        // both the pinned favorites row and the main grid. Star clicks
        // are checked first and stopPropagation()'d so they never also
        // match .sc-emotes-tile and trigger an insert+close.
        body.addEventListener('click', (e) => {
            const star = e.target.closest('.sc-emotes-star');
            if (star) {
                e.stopPropagation();
                toggleFavorite(star.dataset.emoteName);
                return;
            }
            const tile = e.target.closest('.sc-emotes-tile');
            if (!tile) return;
            insertEmoteIntoChat(tile.dataset.emoteName);
            closeEmotesPanel();
        });
        // Keyboard equivalent for the star (a <span role="button">, not a
        // real <button>, so Enter/Space activation isn't native).
        body.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const star = e.target.closest('.sc-emotes-star');
            if (!star) return;
            e.preventDefault();
            e.stopPropagation();
            toggleFavorite(star.dataset.emoteName);
        });

        panel.querySelector('#sc-emotes-close').addEventListener('click', closeEmotesPanel);

        // Core's document-level keydown listener (12-playback-sync-and-
        // seek.js, ~line 229) only bails out for TEXTAREA/INPUT/
        // contenteditable targets -- a focused emote tile or star
        // (<button>/<span role="button">) isn't excluded, so without this
        // it preventDefault()'s Space before the tile's own click/
        // activation happens (no insert, plus a desync-catchup seek) and
        // preventDefault()'s ArrowLeft/ArrowRight anywhere in the panel
        // for its YouTube-style seek, which also kills the browser's
        // native arrow-key focus movement between grid tiles. Capturing
        // at the panel level (not just #sc-emotes-body) covers the
        // header/close button too. stopPropagation() only -- never
        // preventDefault() -- so native behavior (button activation,
        // focus movement, typing/spacebar in #sc-emotes-search) is left
        // completely alone; this only keeps the event from bubbling up
        // to core's document listener. Same pattern as gifmaker's
        // overviewTrack keydown guard (src/pc/modules/gifmaker/index.js
        // ~line 1748).
        const CORE_SEEK_KEYS = new Set(['Escape', 'ArrowLeft', 'ArrowRight', ' ', 'Spacebar']);
        panel.addEventListener('keydown', (e) => {
            if (CORE_SEEK_KEYS.has(e.key)) e.stopPropagation();
        });

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
