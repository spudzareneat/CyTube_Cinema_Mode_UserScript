// ==UserScript==
// @name         CyTube Mobile — 420Grindhouse
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @description  Mobile-optimised layout for 420Grindhouse
// @match        https://cytu.be/r/420Grindhouse*
// @match        https://cytu.be/r/testing*
// @grant        GM_xmlhttpRequest
// @connect      api.themoviedb.org
// @connect      en.wikipedia.org
// @connect      raw.githubusercontent.com
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // Only run on touch devices under 1024px
    if (window.screen.width >= 1024 && window.screen.height >= 1024) return;
    if (!('ontouchstart' in window) && navigator.maxTouchPoints === 0) return;

    /* ==========================================================
       CONSTANTS
    ========================================================== */
    const LS_TMDB = 'sc_tmdb_key';
    const LS_DTDD = 'sc_dtdd_key';
    const getKey  = id => localStorage.getItem(id) || '';
    const setKey  = (id, v) => localStorage.setItem(id, v.trim());
    const hasKey  = id => !!getKey(id);

    let lastMovieTitle = '';
    let movieLinkCache = {};

    /* ==========================================================
       MINIMAL CSS — only what's necessary, don't touch video
    ========================================================== */
    function injectCSS() {
        const style = document.createElement('style');
        style.textContent = `
            /* ── Kill horizontal scroll + fix viewport ───────── */
            *, *::before, *::after { box-sizing: border-box !important; }
            html, body {
                width: 100vw !important; max-width: 100vw !important;
                overflow-x: hidden !important;
                margin: 0 !important; padding: 0 !important;
                background: #000 !important;
            }
            /* Kill Bootstrap grid min-widths */
            .container, .container-fluid, .row, [class*="col-"] {
                max-width: 100vw !important; min-width: 0 !important;
                padding-left: 0 !important; padding-right: 0 !important;
                margin-left: 0 !important; margin-right: 0 !important;
                width: 100% !important; float: none !important;
            }
            #main-row { display: flex !important; flex-direction: column !important; }

            /* ── Hide chrome ─────────────────────────────────── */
            nav.navbar, #drinkbarwrap, #announcements, #playlistrow,
            #resizewrap, footer, #userlisttoggle, #rightcontrols,
            #leftcontrols, #motdrow, #resize-video-smaller,
            #resize-video-larger, #announcements { display: none !important; }

            #userlist {
                visibility: hidden !important; position: absolute !important;
                pointer-events: none !important; height: auto !important;
            }

            /* ── Video on top ────────────────────────────────── */
            #videowrap-col, #videocol, [id*="video"][class*="col"],
            #videowrap { order: 0 !important; }
            #chatwrap-col, #chatcol, [id*="chat"][class*="col"],
            #chatwrap { order: 1 !important; }

            #videowrap {
                width: 100vw !important; max-width: 100vw !important;
                display: block !important;
            }
            #videowrap .embed-responsive {
                width: 100vw !important; max-width: 100vw !important;
            }

            /* ── Title bar ───────────────────────────────────── */
            #videowrap-header {
                font-size: 13px !important; padding: 2px 8px !important;
                white-space: nowrap !important; overflow: hidden !important;
                text-overflow: ellipsis !important;
                max-width: 100vw !important; width: 100vw !important;
                background: rgba(0,0,0,0.6) !important;
            }
            #videowrap-header b,
            #videowrap-header .pull-left > span:first-child { display: none !important; }

            /* ── Chat fills remaining space ──────────────────── */
            #chatwrap {
                width: 100vw !important; max-width: 100vw !important;
                padding: 0 !important; margin: 0 !important;
                display: flex !important; flex-direction: column !important;
            }

            #messagebuffer {
                font-size: 15px !important;
                padding: 4px 8px !important;
                -webkit-overflow-scrolling: touch !important;
            }

            /* Replace the chat input with our own */
            #chatline, #chatline-label, #chatline + *,
            .input-group, #chatwrap .form-group,
            #chatwrap .input-group { display: none !important; }

            /* Our chat input */
            #sc-chat-input-row {
                display: flex !important;
                align-items: flex-end !important;
                padding: 6px 8px !important;
                gap: 8px !important;
                background: rgba(0,0,0,0.4) !important;
                border-top: 1px solid rgba(255,255,255,0.1) !important;
                position: sticky !important;
                bottom: 0 !important;
                z-index: 100 !important;
            }
            #sc-chat-textarea {
                flex: 1 !important;
                background: rgba(255,255,255,0.1) !important;
                border: 1px solid rgba(255,255,255,0.2) !important;
                border-radius: 18px !important;
                color: white !important;
                font-size: 16px !important;
                padding: 8px 14px !important;
                resize: none !important;
                min-height: 38px !important;
                max-height: 100px !important;
                outline: none !important;
                font-family: inherit !important;
            }
            #sc-send-btn, #sc-menu-btn {
                background: rgba(255,255,255,0.12) !important;
                border: none !important;
                border-radius: 50% !important;
                width: 38px !important; height: 38px !important;
                color: rgba(255,255,255,0.8) !important;
                font-size: 16px !important;
                cursor: pointer !important;
                flex-shrink: 0 !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                -webkit-tap-highlight-color: transparent !important;
            }

            /* Bottom sheet */
            #sc-sheet-overlay {
                position: fixed !important; inset: 0 !important;
                background: rgba(0,0,0,0.5) !important;
                z-index: 9000 !important; display: none;
            }
            #sc-sheet {
                position: fixed !important;
                bottom: 0 !important; left: 0 !important; right: 0 !important;
                z-index: 9001 !important;
                background: rgba(15,15,25,0.98) !important;
                border-top: 1px solid rgba(255,255,255,0.12) !important;
                border-radius: 16px 16px 0 0 !important;
                padding: 0 0 32px !important;
                transform: translateY(100%) !important;
                transition: transform 0.28s cubic-bezier(0.22,1,0.36,1) !important;
            }
            #sc-sheet.open { transform: translateY(0) !important; }
            .sc-sheet-handle {
                width: 36px !important; height: 4px !important;
                background: rgba(255,255,255,0.25) !important;
                border-radius: 2px !important;
                margin: 12px auto 8px !important;
            }
            .sc-sheet-item {
                display: flex !important; align-items: center !important;
                padding: 14px 20px !important; gap: 14px !important;
                color: rgba(255,255,255,0.85) !important;
                font-size: 15px !important;
                cursor: pointer !important;
                -webkit-tap-highlight-color: transparent !important;
            }
            .sc-sheet-item:active { background: rgba(255,255,255,0.06) !important; }
            .sc-sheet-icon {
                width: 36px !important; height: 36px !important;
                background: rgba(255,255,255,0.1) !important;
                border-radius: 50% !important;
                display: flex !important; align-items: center !important;
                justify-content: center !important;
                font-size: 16px !important; flex-shrink: 0 !important;
            }
            .sc-sheet-icon.active {
                background: rgba(255,200,50,0.2) !important;
                color: #ffcc44 !important;
            }
            .sc-sheet-divider {
                height: 1px !important;
                background: rgba(255,255,255,0.08) !important;
                margin: 4px 16px !important;
            }

            /* Settings */
            #sc-settings-overlay {
                position: fixed !important; inset: 0 !important;
                background: rgba(0,0,0,0.7) !important;
                z-index: 9100 !important;
                display: flex !important; align-items: flex-end !important;
            }
            #sc-settings-box {
                background: #1a1a2e !important;
                border-radius: 16px 16px 0 0 !important;
                padding: 20px 16px 36px !important;
                width: 100% !important; box-sizing: border-box !important;
                color: rgba(255,255,255,0.88) !important;
            }
            .sc-field { margin-bottom: 14px !important; }
            .sc-field label {
                display: block !important; font-size: 11px !important;
                font-weight: 600 !important; text-transform: uppercase !important;
                letter-spacing: 0.06em !important;
                color: rgba(255,255,255,0.45) !important;
                margin-bottom: 5px !important;
            }
            .sc-field input {
                width: 100% !important; box-sizing: border-box !important;
                background: rgba(255,255,255,0.08) !important;
                border: 1px solid rgba(255,255,255,0.15) !important;
                border-radius: 8px !important; color: white !important;
                font-size: 16px !important; padding: 10px 12px !important;
                outline: none !important;
            }
            #sc-save-btn {
                width: 100% !important; padding: 13px !important;
                background: rgba(192,176,255,0.2) !important;
                color: #c0b0ff !important;
                border: 1px solid rgba(192,176,255,0.4) !important;
                border-radius: 10px !important; font-size: 15px !important;
                font-weight: 600 !important; cursor: pointer !important;
                margin-top: 4px !important;
            }
            #sc-cancel-btn {
                width: 100% !important; padding: 11px !important;
                background: transparent !important;
                color: rgba(255,255,255,0.45) !important;
                border: none !important; font-size: 14px !important;
                cursor: pointer !important;
            }

            /* Movie badges */
            #sc-movie-links {
                display: inline-flex !important; gap: 4px !important;
                margin-left: 6px !important; vertical-align: middle !important;
            }
            .sc-movie-link {
                display: inline-flex !important;
                align-items: center !important; justify-content: center !important;
                width: 20px !important; height: 20px !important;
                border-radius: 3px !important; font-size: 11px !important;
                font-weight: 900 !important; text-decoration: none !important;
                font-family: Georgia, serif !important;
            }

            /* Stats */
            #sc-movie-stats {
                position: fixed !important;
                bottom: 80px !important; left: 10px !important;
                z-index: 500 !important;
                background: rgba(0,0,0,0.8) !important;
                color: rgba(255,255,255,0.9) !important;
                font-size: 13px !important; padding: 6px 12px !important;
                border-radius: 6px !important;
                pointer-events: none !important;
                max-width: 90vw !important;
            }

            /* Users panel */
            #sc-users-panel {
                position: fixed !important;
                bottom: 60px !important; left: 0 !important; right: 0 !important;
                z-index: 8000 !important;
                background: rgba(10,10,20,0.97) !important;
                border-top: 1px solid rgba(255,255,255,0.12) !important;
                max-height: 50vh !important;
                overflow-y: auto !important;
                padding: 12px 16px !important;
                -webkit-overflow-scrolling: touch !important;
                display: none;
            }
            .sc-users-header {
                font-size: 10px !important; font-weight: 700 !important;
                letter-spacing: 0.06em !important; text-transform: uppercase !important;
                color: rgba(255,255,255,0.4) !important;
                margin-bottom: 8px !important; padding-bottom: 6px !important;
                border-bottom: 1px solid rgba(255,255,255,0.08) !important;
            }
            .sc-user-name { padding: 4px 0 !important; font-size: 14px !important; }

            /* Poll panel */
            #sc-poll-panel {
                position: fixed !important;
                bottom: 60px !important; left: 0 !important; right: 0 !important;
                z-index: 8000 !important;
                background: rgba(10,10,20,0.97) !important;
                border-top: 1px solid rgba(255,255,255,0.12) !important;
                max-height: 60vh !important;
                overflow-y: auto !important;
                padding: 14px 16px !important;
                display: none;
            }
            .sc-poll-title { font-size: 15px !important; font-weight: 600 !important; color: #f0c040 !important; margin-bottom: 10px !important; }
            .sc-poll-opt { font-size: 14px !important; color: rgba(255,255,255,0.82) !important; margin-bottom: 8px !important; line-height: 1.5 !important; }
            .sc-poll-opt a { color: #7eb8f7 !important; word-break: break-all !important; }
        `;
        document.head.appendChild(style);
    }

    /* ==========================================================
       CHAT INPUT
    ========================================================== */
    function installChatInput() {
        if (document.getElementById('sc-chat-input-row')) return;
        const originalInput = document.getElementById('chatline');
        if (!originalInput) return;

        const row = document.createElement('div');
        row.id = 'sc-chat-input-row';

        const textarea = document.createElement('textarea');
        textarea.id = 'sc-chat-textarea';
        textarea.placeholder = 'Type a message…';
        textarea.rows = 1;
        textarea.setAttribute('autocorrect', 'on');
        textarea.setAttribute('autocapitalize', 'sentences');
        textarea.setAttribute('inputmode', 'text');

        const sendBtn = document.createElement('button');
        sendBtn.id = 'sc-send-btn';
        sendBtn.textContent = '➤';

        const menuBtn = document.createElement('button');
        menuBtn.id = 'sc-menu-btn';
        menuBtn.textContent = '⋯';

        row.appendChild(textarea);
        row.appendChild(sendBtn);
        row.appendChild(menuBtn);

        const chatwrap = document.getElementById('chatwrap');
        if (chatwrap) chatwrap.appendChild(row);

        textarea.addEventListener('input', () => {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 100) + 'px';
        });

        let lastVal = '';
        const doSend = () => {
            const text = textarea.value.trim();
            if (!text) return;
            try { socket.emit('chatMsg', { msg: text, meta: {} }); }
            catch(e) {
                originalInput.value = text;
                originalInput.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', keyCode:13, bubbles:true }));
            }
            textarea.value = ''; textarea.style.height = '';
            lastVal = ''; originalInput.value = '';
            textarea.focus();
        };

        sendBtn.addEventListener('click', doSend);
        textarea.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
        });

        // Mirror emote insertions
        setInterval(() => {
            const v = originalInput.value;
            if (v !== lastVal && v !== textarea.value) { textarea.value = v; lastVal = v; }
        }, 80);

        menuBtn.addEventListener('click', openSheet);
    }

    /* ==========================================================
       KEYBOARD SLIDE
    ========================================================== */
    function initKeyboard() {
        if (!window.visualViewport) return;
        const update = () => {
            const kh = Math.max(0, window.innerHeight - window.visualViewport.height);
            document.documentElement.style.setProperty('--kb', kh + 'px');
            // Scroll chat to bottom when keyboard opens
            if (kh > 100) {
                const buf = document.getElementById('messagebuffer');
                if (buf) setTimeout(() => buf.scrollTop = buf.scrollHeight, 100);
            }
        };
        window.visualViewport.addEventListener('resize', update, { passive: true });
    }

    /* ==========================================================
       BOTTOM SHEET
    ========================================================== */
    let desynced = false, savedListeners = null;

    function buildSheet() {
        if (document.getElementById('sc-sheet')) return;

        const overlay = document.createElement('div');
        overlay.id = 'sc-sheet-overlay';
        document.body.appendChild(overlay);

        const sheet = document.createElement('div');
        sheet.id = 'sc-sheet';
        sheet.innerHTML = `
            <div class="sc-sheet-handle"></div>
            <div class="sc-sheet-item" id="sc-si-settings"><div class="sc-sheet-icon">⚙</div><span>Settings</span></div>
            <div class="sc-sheet-item" id="sc-si-emotes"><div class="sc-sheet-icon">▦</div><span>Emotes</span></div>
            <div class="sc-sheet-item" id="sc-si-fs"><div class="sc-sheet-icon">⛶</div><span>Fullscreen</span></div>
            <div class="sc-sheet-item" id="sc-si-desync"><div class="sc-sheet-icon" id="sc-desync-icon">⟳</div><span id="sc-desync-label">Free Watch</span></div>
            <div class="sc-sheet-divider"></div>
            <div class="sc-sheet-item" id="sc-si-users"><div class="sc-sheet-icon">👥</div><span>Users</span></div>
            <div class="sc-sheet-item" id="sc-si-poll" style="display:none"><div class="sc-sheet-icon">📢</div><span>Announcement</span></div>
        `;
        document.body.appendChild(sheet);

        overlay.addEventListener('click', closeSheet);

        let startY = 0;
        sheet.addEventListener('touchstart', e => startY = e.touches[0].clientY, { passive: true });
        sheet.addEventListener('touchend', e => { if (e.changedTouches[0].clientY - startY > 60) closeSheet(); }, { passive: true });

        sheet.querySelector('#sc-si-settings').addEventListener('click', () => { closeSheet(); setTimeout(openSettings, 300); });
        sheet.querySelector('#sc-si-emotes').addEventListener('click', () => { closeSheet(); document.getElementById('emotelistbtn')?.click(); });
        sheet.querySelector('#sc-si-fs').addEventListener('click', () => {
            closeSheet();
            document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {});
        });
        sheet.querySelector('#sc-si-desync').addEventListener('click', () => {
            if (typeof socket === 'undefined') return;
            desynced = !desynced;
            if (desynced) {
                const key = '$mediaUpdate';
                if (socket._callbacks?.[key]) { savedListeners = socket._callbacks[key].slice(); socket._callbacks[key] = []; }
                else if (socket._events?.mediaUpdate) { savedListeners = socket._events.mediaUpdate; delete socket._events.mediaUpdate; }
                document.getElementById('sc-desync-icon').className = 'sc-sheet-icon active';
                document.getElementById('sc-desync-label').textContent = 'Free Watch ON';
            } else {
                if (savedListeners) {
                    if (socket._callbacks) socket._callbacks['$mediaUpdate'] = savedListeners;
                    else if (socket._events) socket._events.mediaUpdate = savedListeners;
                    savedListeners = null;
                }
                document.getElementById('sc-desync-icon').className = 'sc-sheet-icon';
                document.getElementById('sc-desync-label').textContent = 'Free Watch';
                socket.emit?.('playerReady');
            }
            closeSheet();
        });

        sheet.querySelector('#sc-si-users').addEventListener('click', () => { closeSheet(); toggleUsers(); });
        sheet.querySelector('#sc-si-poll').addEventListener('click', () => { closeSheet(); togglePoll(); });
    }

    function openSheet() {
        const overlay = document.getElementById('sc-sheet-overlay');
        const sheet = document.getElementById('sc-sheet');
        if (!overlay || !sheet) { buildSheet(); return openSheet(); }
        overlay.style.display = 'block';
        sheet.style.display = 'block';
        requestAnimationFrame(() => sheet.classList.add('open'));
    }

    function closeSheet() {
        const sheet = document.getElementById('sc-sheet');
        const overlay = document.getElementById('sc-sheet-overlay');
        if (!sheet) return;
        sheet.classList.remove('open');
        setTimeout(() => { if (overlay) overlay.style.display = 'none'; if (sheet) sheet.style.display = 'none'; }, 300);
    }

    /* ==========================================================
       USERS PANEL
    ========================================================== */
    function getUsers() {
        return [...document.querySelectorAll('#userlist .userlist_item')]
            .map(item => { const spans = item.querySelectorAll('span'); return (spans[1] || spans[0])?.textContent?.trim() || ''; })
            .filter(Boolean)
            .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    }

    function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; } return Math.abs(h); }
    function nameColor(n) { return `hsl(${hashStr(n)%360},${55+hashStr(n+'s')%30}%,${55+hashStr(n+'l')%20}%)`; }

    function toggleUsers() {
        let panel = document.getElementById('sc-users-panel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'sc-users-panel';
            document.body.appendChild(panel);
        }
        if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
        const users = getUsers();
        panel.innerHTML = `<div class="sc-users-header">${users.length} connected</div>` +
            users.map(u => `<div class="sc-user-name" style="color:${nameColor(u)}">${u}</div>`).join('');
        panel.style.display = 'block';
        document.addEventListener('click', function hideUsers(e) {
            if (!panel.contains(e.target)) { panel.style.display = 'none'; document.removeEventListener('click', hideUsers); }
        }, { once: false });
    }

    /* ==========================================================
       POLL PANEL
    ========================================================== */
    function initPoll() {
        const pollwrap = document.getElementById('pollwrap');
        if (!pollwrap) return;

        const checkPoll = () => {
            const well = pollwrap.querySelector('.well.active') || pollwrap.querySelector('.well');
            const item = document.getElementById('sc-si-poll');
            if (item) item.style.display = well?.textContent?.trim().length > 10 ? '' : 'none';
        };
        new MutationObserver(checkPoll).observe(pollwrap, { childList: true, subtree: true, characterData: true });
        checkPoll();
    }

    function togglePoll() {
        let panel = document.getElementById('sc-poll-panel');
        if (!panel) { panel = document.createElement('div'); panel.id = 'sc-poll-panel'; document.body.appendChild(panel); }
        if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
        const pollwrap = document.getElementById('pollwrap');
        const well = pollwrap?.querySelector('.well.active') || pollwrap?.querySelector('.well');
        if (!well) return;
        const h = well.querySelector('h3')?.textContent?.trim() || '';
        const opts = [...well.querySelectorAll('.option')].map(o => {
            const html = o.innerHTML.replace(/<button[^>]*>.*?<\/button>/i, '').trim();
            return `<div class="sc-poll-opt">${html}</div>`;
        }).join('');
        panel.innerHTML = `<div class="sc-poll-title">${h}</div>${opts}`;
        panel.style.display = 'block';
        document.addEventListener('click', function hidePoll(e) {
            if (!panel.contains(e.target)) { panel.style.display = 'none'; document.removeEventListener('click', hidePoll); }
        });
    }

    /* ==========================================================
       MOVIE TITLE + LINKS
    ========================================================== */
    function parseFilename(raw) {
        let s = raw.replace(/\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|divx|xvid|ogv)$/i, '');
        let year = null;
        const ym = s.match(/[\[(](\d{4})[\])]/);
        if (ym) { year = ym[1]; s = s.slice(0, ym.index); }
        return { title: s.replace(/[._]+/g, ' ').replace(/[\[(][^\])]*/g, '').replace(/[\])]/g, '').replace(/\s+/g, ' ').trim(), year };
    }

    async function lookupAndInject(titleEl) {
        const raw = titleEl.textContent.trim().replace(/^currently\s+playing[:\s]*/i, '').replace(/^now\s+playing[:\s]*/i, '').trim();
        if (!raw || raw === lastMovieTitle || raw.length < 2) return;
        lastMovieTitle = raw;

        const old = document.getElementById('sc-movie-links');
        if (old) old.remove();

        if (!hasKey(LS_TMDB)) return;
        const { title, year } = parseFilename(raw);
        if (!title) return;

        const cacheKey = title + (year || '');
        if (movieLinkCache[cacheKey]) { applyLinks(titleEl, movieLinkCache[cacheKey]); return; }

        try {
            const params = new URLSearchParams({ api_key: getKey(LS_TMDB), query: title, language: 'en-US' });
            if (year) params.set('year', year);
            const res = await fetch(`https://api.themoviedb.org/3/search/movie?${params}`);
            if (!res.ok) return;
            const data = await res.json();
            if (!data.results?.length) return;
            let best = data.results[0];
            if (year) { const wy = data.results.find(r => r.release_date?.startsWith(year)); if (wy) best = wy; }
            const dr = await fetch(`https://api.themoviedb.org/3/movie/${best.id}?api_key=${getKey(LS_TMDB)}&append_to_response=external_ids`);
            if (!dr.ok) return;
            const d = await dr.json();
            const result = {
                imdb: d.imdb_id ? `https://www.imdb.com/title/${d.imdb_id}/` : null,
                letterboxd: `https://letterboxd.com/tmdb/${best.id}`,
                cleanTitle: d.title, cleanYear: d.release_date?.slice(0, 4) || year,
            };
            movieLinkCache[cacheKey] = result;
            applyLinks(titleEl, result);
        } catch(e) {}
    }

    function applyLinks(titleEl, result) {
        if (result.cleanTitle) {
            const newText = result.cleanTitle + (result.cleanYear ? ` (${result.cleanYear})` : '');
            const textNode = [...titleEl.childNodes].find(n => n.nodeType === 3 && n.textContent.trim());
            if (textNode) textNode.textContent = newText;
        }
        const row = document.createElement('span');
        row.id = 'sc-movie-links';
        const defs = [
            { url: result.imdb,       color: '#f5c518', fg: '#000', char: 'i', label: 'IMDb' },
            { url: result.letterboxd, color: '#2c4a2e', fg: '#00e054', char: 'L', label: 'Letterboxd' },
        ];
        defs.forEach(({ url, color, fg, char, label }) => {
            if (!url) return;
            const a = document.createElement('a');
            a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
            a.className = 'sc-movie-link'; a.title = label;
            a.style.background = color; a.style.color = fg;
            a.textContent = char;
            row.appendChild(a);
        });
        titleEl.appendChild(row);
    }

    function watchTitle() {
        const tryInject = () => {
            const el = document.getElementById('currenttitle')
                || document.querySelector('#videowrap-header span')
                || document.querySelector('#videowrap-header .pull-left');
            if (el) lookupAndInject(el);
        };
        const header = document.querySelector('#videowrap-header') || document.body;
        new MutationObserver(tryInject).observe(header, { childList: true, subtree: true, characterData: true });
        setTimeout(tryInject, 1000);
    }

    /* ==========================================================
       USER COLORS
    ========================================================== */
    function applyColors() {
        document.querySelectorAll('#messagebuffer .username').forEach(el => {
            if (!el.dataset.colored) {
                el.style.color = nameColor(el.textContent.replace(/:$/, '').trim());
                el.dataset.colored = '1';
            }
        });
    }

    /* ==========================================================
       SETTINGS
    ========================================================== */
    function openSettings() {
        if (document.getElementById('sc-settings-overlay')) return;
        const overlay = document.createElement('div');
        overlay.id = 'sc-settings-overlay';
        overlay.innerHTML = `
            <div id="sc-settings-box">
                <div style="font-size:17px;font-weight:700;color:white;margin-bottom:16px">Settings</div>
                <div class="sc-field"><label>TMDB API Key</label><input type="password" id="sc-tmdb-in" value="${getKey(LS_TMDB)}" autocomplete="off"></div>
                <div class="sc-field"><label>DoesTheDogDie Key</label><input type="password" id="sc-dtdd-in" value="${getKey(LS_DTDD)}" autocomplete="off"></div>
                <button id="sc-save-btn">Save</button>
                <button id="sc-cancel-btn">Cancel</button>
            </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('#sc-save-btn').addEventListener('click', () => {
            setKey(LS_TMDB, overlay.querySelector('#sc-tmdb-in').value);
            setKey(LS_DTDD, overlay.querySelector('#sc-dtdd-in').value);
            overlay.remove();
        });
        overlay.querySelector('#sc-cancel-btn').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    }

    /* ==========================================================
       BOOT
    ========================================================== */
    window.addEventListener('load', () => {
        injectCSS();
        buildSheet();

        // Physically move video above chat — CSS order doesn't work reliably
        // since CyTube's columns may not be direct flex children
        const reorder = () => {
            const video = document.getElementById('videowrap')
                || document.querySelector('[id*="video"]');
            const chat  = document.getElementById('chatwrap')
                || document.querySelector('[id*="chat"]');
            if (!video || !chat) return false;

            // Find the common parent
            const videoParent = video.parentElement;
            const chatParent  = chat.parentElement;

            if (videoParent === chatParent) {
                // Same parent — just move video before chat
                videoParent.insertBefore(video, chat);
            } else {
                // Different parents (Bootstrap cols) — move both cols
                const videoCol = videoParent;
                const chatCol  = chatParent;
                const commonParent = videoCol.parentElement;
                if (commonParent) {
                    // Ensure video col comes first
                    const firstChild = commonParent.firstElementChild;
                    if (firstChild !== videoCol) {
                        commonParent.insertBefore(videoCol, chatCol);
                    }
                }
            }
            return true;
        };

        if (!reorder()) {
            // DOM not ready yet — watch for it
            const obs = new MutationObserver(() => { if (reorder()) obs.disconnect(); });
            obs.observe(document.body, { childList: true, subtree: true });
        }

        if (!hasKey(LS_TMDB)) setTimeout(openSettings, 1500);

        const boot = new MutationObserver(() => {
            installChatInput();
            initKeyboard();
            applyColors();
            initPoll();
            if (document.getElementById('sc-chat-input-row')) boot.disconnect();
        });
        boot.observe(document.body, { childList: true, subtree: true });

        installChatInput();
        watchTitle();

        // Color observer
        const buf = document.getElementById('messagebuffer');
        if (buf) new MutationObserver(applyColors).observe(buf, { childList: true, subtree: true });

        setTimeout(initPoll, 2000);
    });

})();