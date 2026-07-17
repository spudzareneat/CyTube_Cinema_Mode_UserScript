// ==UserScript==
// @name         CyTube Fullscreen Video with Overlay Chat
// @namespace    http://tampermonkey.net/
// @version      4.6.3
// @description  Fullscreen layout, LanguageTool grammar, inline error editor, tab-complete, movie links, IMDb trivia & parent guide, right-click chat-to-movie seek, scene-to-GIF capture + ImgBB upload, vertical monitor support
// @match        https://cytu.be/r/420Grindhouse
// @match        https://cytu.be/r/testing
// @grant        GM_xmlhttpRequest
// @require      https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.js
// @connect      api.themoviedb.org
// @connect      en.wikipedia.org
// @connect      raw.githubusercontent.com
// @connect      api.languagetool.org
// @connect      caching.graphql.imdb.com
// @connect      cdnjs.cloudflare.com
// @connect      api.imgbb.com
// @connect      www.reddit.com
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';
    console.log('[SC] cytube.pc v4.6.2 loaded');

    /* ==========================================================
       API KEYS — stored in localStorage, managed via settings modal.
       Keys are never hard-coded; the settings modal handles first-run.
    ========================================================== */
    const LS_TMDB        = 'sc_tmdb_key';
    const LS_SPELLCHECK  = 'sc_spellcheck';
    const LS_CHAT_FONT   = 'sc_chat_fontsize';
    const LS_MOVIE_LINKS = 'sc_movie_links';
    const LS_IMGBB       = 'sc_imgbb_key';
    const LS_MOVIE_CACHE = 'sc_movie_cache_v1';
    const getKey   = id => localStorage.getItem(id) || '';
    const setKey   = (id, v) => localStorage.setItem(id, v.trim());
    const hasKey   = id => !!getKey(id);
    const spellCheckEnabled  = () => getKey(LS_SPELLCHECK)  !== 'off';
    const movieLinksEnabled  = () => getKey(LS_MOVIE_LINKS) !== 'off';

    function getChatFontSize() {
        const v = parseInt(getKey(LS_CHAT_FONT), 10);
        return (Number.isFinite(v) && v >= 10 && v <= 32) ? v : 14;
    }
    function applyChatFontSize(px) {
        const buf = document.getElementById('messagebuffer');
        if (buf) buf.style.setProperty('font-size', px + 'px', 'important');
        const ta = document.getElementById('sc-chat-textarea');
        if (ta) ta.style.setProperty('font-size', px + 'px', 'important');
    }

    /* ==========================================================
       MONITOR / ORIENTATION DETECTION
    ========================================================== */

    function isVerticalMonitor() {
        return window.screen.height > window.screen.width;
    }
    function applyMonitorLayout() {
        const wasVert = document.body.classList.contains('sc-vertical');
        const isVert  = isVerticalMonitor();
        document.body.classList.toggle('sc-vertical',   isVert);
        document.body.classList.toggle('sc-horizontal', !isVert);
        if (wasVert !== isVert) {
            const buf = document.getElementById('messagebuffer');
            if (buf) setTimeout(() => { buf.scrollTop = buf.scrollHeight; }, 200);
        }
    }
    function startMonitorWatcher() {
        applyMonitorLayout();
        setInterval(applyMonitorLayout, 800);
    }

    /* ==========================================================
       CHAT USERNAMES — autocomplete + LT ignore list
    ========================================================== */

    function getChatUsernames() {
        const names = new Set();
        document.querySelectorAll('#userlist .userlist_item').forEach(item => {
            const spans = item.querySelectorAll('span');
            const nameSpan = spans.length >= 2 ? spans[1] : spans[0];
            const n = nameSpan?.textContent?.trim();
            if (n) names.add(n);
        });
        document.querySelectorAll('#messagebuffer .username').forEach(el => {
            const n = el.textContent.replace(/[:\s]+$/, '').trim();
            if (n) names.add(n);
        });
        return [...names];
    }

    /* ==========================================================
       TAB AUTOCOMPLETE
    ========================================================== */

    let tabCandidates = [];
    let tabIndex = 0;
    let tabStart = 0;

    function handleTabComplete(textarea, e) {
        if (e.key !== 'Tab') { tabCandidates = []; return; }
        e.preventDefault();

        const val = textarea.value;
        const cursor = textarea.selectionStart;

        if (tabCandidates.length === 0) {
            let i = cursor - 1;
            while (i >= 0 && /\S/.test(val[i])) i--;
            tabStart = i + 1;
            const prefix = val.slice(tabStart, cursor).replace(/^@/, '');
            tabCandidates = getChatUsernames().filter(n =>
                n.toLowerCase().startsWith(prefix.toLowerCase())
            );
            tabIndex = 0;
        } else {
            tabIndex = (tabIndex + 1) % tabCandidates.length;
        }

        if (tabCandidates.length === 0) return;

        const completion = tabCandidates[tabIndex];
        const atPrefix = tabStart === 0 ? '@' : '';
        const insert = atPrefix + completion + ' ';
        const after = val.slice(cursor);
        textarea.value = val.slice(0, tabStart) + insert + after;
        const newCursor = tabStart + insert.length;
        textarea.selectionStart = textarea.selectionEnd = newCursor;
    }

    /* ==========================================================
       LANGUAGETOOL GRAMMAR CHECK
    ========================================================== */

    const LT_API = 'https://api.languagetool.org/v2/check';

    // Rules that fire constantly on casual chat and add no value
    const LT_DISABLED_RULES = [
        'UPPERCASE_SENTENCE_START',
        'PUNCTUATION_PARAGRAPH_END',
        'EN_QUOTES',
        'COMMA_PARENTHESIS_WHITESPACE',
        'WHITESPACE_RULE',
        'CONSECUTIVE_SPACES',
    ].join(',');

    // Explicitly enable these categories so they're always active
    // regardless of LT's default on/off state.
    // CONFUSED_WORDS is the one that catches there/their/they're,
    // your/you're, its/it's, to/too/two etc.
    const LT_ENABLED_CATEGORIES = [
        'GRAMMAR',
        'TYPOS',
        'CONFUSED_WORDS',
    ].join(',');

    // Pad short messages with a neutral sentence so LT has enough
    // context to fire confused-word rules. The pad is stripped from
    // results by subtracting its length from match offsets.
    const LT_PREFIX = 'I am writing this message. ';

    function buildAnnotation(text) {
        const names = getChatUsernames();

        // Build a sorted-longest-first list so longer names match before shorter prefixes
        const sorted = [...names].sort((a, b) => b.length - a.length);
        const escaped = sorted.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

        // Tokens to mask as markup (LT skips these entirely):
        //   @Name or Name — followed by any non-alpha char or end of string
        //   #hashtag
        //   URLs
        const parts = [];
        if (escaped.length) {
            // Match @Name or bare Name at a word boundary / after space / at start
            parts.push(`@(?:${escaped.join('|')})`);
            parts.push(`(?<![\\w])(?:${escaped.join('|')})(?![\\w])`);
        }
        parts.push('#\\S+');                          // #hashtag
        parts.push('https?://\\S+');                  // URLs

        const tokenRe = new RegExp(parts.join('|'), 'gi');
        const annotation = [];
        let last = 0, match;

        // Prefix for context (helps LT with confused-word rules on short messages)
        annotation.push({ text: LT_PREFIX });

        while ((match = tokenRe.exec(text)) !== null) {
            if (match.index > last) annotation.push({ text: text.slice(last, match.index) });
            annotation.push({ markup: match[0] });
            last = match.index + match[0].length;
        }
        if (last < text.length) annotation.push({ text: text.slice(last) });

        return annotation;
    }

    async function checkGrammar(text) {
        try {
            const body = new URLSearchParams({
                data: JSON.stringify({ annotation: buildAnnotation(text) }),
                language: 'en-US',
                disabledRules: LT_DISABLED_RULES,
                enabledCategories: LT_ENABLED_CATEGORIES,
            });
            const res = await fetch(LT_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
            });
            if (!res.ok) return [];
            const data = await res.json();
            const prefixLen = LT_PREFIX.length;
            return (data.matches || [])
                // Drop any matches that fired inside the prefix padding itself
                .filter(m => m.offset >= prefixLen)
                .map(m => ({
                    offset: m.offset - prefixLen,  // re-anchor to original text
                    length: m.length,
                    message: m.message,
                    shortMessage: m.shortMessage || '',
                    replacements: (m.replacements || []).slice(0, 5).map(r => r.value),
                }));
        } catch (e) { return []; }
    }

    /* ==========================================================
       READABILITY CHECKS
    ========================================================== */

    function detectReadabilityIssues(text) {
        const issues = [];
        const allCaps = text.match(/\b[A-Z]{3,}\b/g);
        if (allCaps) issues.push(`ALL CAPS: "${allCaps.join('", "')}" — hard to read`);
        const repeated = text.match(/(.)\1{4,}/g);
        if (repeated) issues.push(`Repeated characters: "${repeated.join('", "')}" — hard to read`);
        const excessPunct = text.match(/[!?]{3,}/g);
        if (excessPunct) issues.push(`Excessive punctuation: "${excessPunct.join('", "')}"`);
        return issues;
    }

    /* ==========================================================
       INLINE ERROR REVIEW MODAL
    ========================================================== */

    function showReviewModal(text, ltMatches, readabilityIssues, onSend, onCancel) {
        const old = document.getElementById('sc-modal-overlay');
        if (old) old.remove();

        let workingText = text;
        let workingMatches = ltMatches.slice();

        const overlay = document.createElement('div');
        overlay.id = 'sc-modal-overlay';
        overlay.innerHTML = `
            <div id="sc-modal">
                <div id="sc-modal-title">⚠️ Review Before Sending</div>
                ${readabilityIssues.length ? `<div id="sc-readability">${
                    readabilityIssues.map(i => `<div class="sc-readability-issue">⚠️ ${i}</div>`).join('')
                }</div>` : ''}
                <div id="sc-preview-wrap"><div id="sc-preview"></div></div>
                <div id="sc-error-detail"></div>
                <div id="sc-modal-actions">
                    <button id="sc-btn-cancel">✏️ Edit in Chat</button>
                    <button id="sc-btn-send">✅ Send</button>
                </div>
                <div id="sc-lt-credit">Grammar by <a href="https://languagetool.org" target="_blank" rel="noopener">LanguageTool</a></div>
            </div>`;

        document.body.appendChild(overlay);

        // Focus the Send button so keyboard events target the modal, not the textarea
        setTimeout(() => document.getElementById('sc-btn-send')?.focus(), 0);

        overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); onCancel(); } });
        document.getElementById('sc-btn-cancel').addEventListener('click', () => { overlay.remove(); onCancel(); });
        document.getElementById('sc-btn-send').addEventListener('click', () => { overlay.remove(); onSend(workingText); });

        // Enter on the modal triggers Send, Escape triggers Cancel.
        // Use keyup so the key is fully released before focus returns to
        // the textarea — prevents the Enter from re-firing attemptSend.
        const modalKeyHandler = e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                overlay.removeEventListener('keydown', modalKeyHandler);
                overlay.remove();
                setTimeout(() => onSend(workingText), 50);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                overlay.removeEventListener('keydown', modalKeyHandler);
                overlay.remove();
                onCancel();
            }
        };
        overlay.addEventListener('keydown', modalKeyHandler);

        // Clean up listener if modal is removed any other way
        const cleanupObserver = new MutationObserver(() => {
            if (!document.getElementById('sc-modal-overlay')) {
                cleanupObserver.disconnect();
            }
        });
        cleanupObserver.observe(document.body, { childList: true });

        function renderPreview() {
            const preview = document.getElementById('sc-preview');
            const detail = document.getElementById('sc-error-detail');
            if (!preview) return;

            const sorted = workingMatches.slice().sort((a, b) => a.offset - b.offset);
            const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            let html = '', pos = 0;

            sorted.forEach((m, i) => {
                if (m.offset > pos) html += esc(workingText.slice(pos, m.offset));
                html += `<span class="sc-error-span" data-idx="${i}" title="${esc(m.shortMessage || m.message)}">${esc(workingText.slice(m.offset, m.offset + m.length))}</span>`;
                pos = m.offset + m.length;
            });
            html += esc(workingText.slice(pos));
            preview.innerHTML = html;

            preview.querySelectorAll('.sc-error-span').forEach(span => {
                span.addEventListener('click', () => showErrorDetail(sorted[parseInt(span.dataset.idx)]));
            });
            detail.innerHTML = '';
        }

        function showErrorDetail(match) {
            const detail = document.getElementById('sc-error-detail');
            if (!detail) return;
            const sugs = match.replacements;
            detail.innerHTML = `
                <div class="sc-detail-msg">💬 ${match.message}</div>
                <div class="sc-detail-actions">
                    ${sugs.length ? sugs.map(s =>
                        `<button class="sc-sug-btn" data-sug="${s.replace(/"/g,'&quot;')}">✔ ${s}</button>`
                    ).join('') : '<em>No suggestions</em>'}
                    <button class="sc-reject-btn">✖ Ignore</button>
                </div>`;

            detail.querySelectorAll('.sc-sug-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const sug = btn.dataset.sug;
                    const delta = sug.length - match.length;
                    workingText = workingText.slice(0, match.offset) + sug + workingText.slice(match.offset + match.length);
                    workingMatches = workingMatches.filter(m => m !== match);
                    workingMatches.forEach(m => { if (m.offset > match.offset) m.offset += delta; });
                    renderPreview();
                });
            });
            detail.querySelector('.sc-reject-btn').addEventListener('click', () => {
                workingMatches = workingMatches.filter(m => m !== match);
                renderPreview();
            });
        }

        renderPreview();
    }

    /* ==========================================================
       SEND FLOW
    ========================================================== */

    async function attemptSend(textarea, originalInput) {
        const text = textarea.value.trim();
        if (!text) return;

        // Skip all checking if spellcheck is disabled in settings
        if (!spellCheckEnabled()) {
            doSend(textarea, originalInput, text);
            return;
        }

        const readabilityIssues = detectReadabilityIssues(text);
        showCheckingIndicator(textarea, true);
        const ltMatches = await checkGrammar(text);
        showCheckingIndicator(textarea, false);

        if (ltMatches.length > 0 || readabilityIssues.length > 0) {
            showReviewModal(text, ltMatches, readabilityIssues,
                finalText => { textarea.value = finalText; doSend(textarea, originalInput, finalText); },
                () => textarea.focus()
            );
        } else {
            doSend(textarea, originalInput, text);
        }
    }

    function showCheckingIndicator(textarea, show) {
        let el = document.getElementById('sc-checking');
        if (show && !el) {
            el = document.createElement('div');
            el.id = 'sc-checking'; el.textContent = '🔍 Checking…';
            textarea.parentElement.insertBefore(el, textarea.nextSibling);
        } else if (!show && el) el.remove();
    }

    function doSend(textarea, originalInput, msg) {
        if (!msg) return;
        let sent = false;
        try {
            if (typeof socket !== 'undefined' && socket && socket.emit) {
                socket.emit('chatMsg', { msg, meta: {} });
                sent = true;
            }
        } catch (e) {}

        if (!sent) {
            originalInput.value = msg; lastChatlineValue = msg;
            originalInput.dispatchEvent(new KeyboardEvent('keydown', {
                bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13
            }));
            try {
                if (typeof $ !== 'undefined')
                    $(originalInput).trigger($.Event('keydown', { which: 13, keyCode: 13, key: 'Enter' }));
            } catch (e) {}
        }

        textarea.value = ''; textarea.style.height = '';
        lastChatlineValue = ''; originalInput.value = '';
        // Return focus to the chat input so user can keep typing immediately
        textarea.focus();
    }

    /* ==========================================================
       EMOTE MIRROR
    ========================================================== */

    let emoteWatchInterval = null;
    let lastChatlineValue = '';

    function startEmoteWatcher(originalInput, textarea) {
        if (emoteWatchInterval) return;
        emoteWatchInterval = setInterval(() => {
            const current = originalInput.value;
            if (current !== lastChatlineValue) {
                textarea.value = current; lastChatlineValue = current;
                textarea.focus();
                textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
                textarea.dispatchEvent(new Event('input'));
            }
        }, 80);
    }

    /* ==========================================================
       CHAT TEXTAREA INSTALLATION
    ========================================================== */

    function installChatTextarea() {
        const originalInput = document.getElementById('chatline');
        if (!originalInput) return false;
        if (document.getElementById('sc-chat-textarea')) return true;

        originalInput.style.cssText = `
            position: absolute !important; width: 1px !important; height: 1px !important;
            opacity: 0 !important; pointer-events: none !important; top: -9999px !important;`;

        const textarea = document.createElement('textarea');
        textarea.id = 'sc-chat-textarea';
        textarea.placeholder = 'Type a message…';
        textarea.spellcheck = true; textarea.lang = 'en'; textarea.rows = 2;
        textarea.setAttribute('autocorrect', 'on');
        textarea.setAttribute('autocapitalize', 'sentences');

        originalInput.parentElement.insertBefore(textarea, originalInput.nextSibling);

        textarea.addEventListener('input', () => {
            tabCandidates = [];
            lastChatlineValue = originalInput.value;
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
        });
        textarea.addEventListener('keydown', e => {
            handleTabComplete(textarea, e);
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                // Don't fire if a review modal is already open
                if (!document.getElementById('sc-modal-overlay')) {
                    attemptSend(textarea, originalInput);
                }
            }
        });
        originalInput.addEventListener('focus', () => textarea.focus());

        const chatwrap = document.getElementById('chatwrap');
        if (chatwrap) {
            chatwrap.addEventListener('click', e => {
                if (e.target === chatwrap || e.target.id === 'messagebuffer') textarea.focus();
            });
        }

        startEmoteWatcher(originalInput, textarea);
        return true;
    }

    /* ==========================================================
       FLOATING BUTTONS
       Appended to document.body so they're never inside #leftcontrols
       and can't be accidentally hidden with it.
    ========================================================== */

    /* ==========================================================
       DESYNC — temporarily pause CyTube's sync (shared state)
       Used by the floating "free watch" button AND the chat
       right-click "jump movie to this message" menu.
    ========================================================== */

    const _desync = { active: false, saved: null, btn: null };

    function _getMediaUpdateListeners() {
        // Socket.IO v2/v3 stores listeners under _callbacks['$eventName']
        // Socket.IO v4 stores them under _events or via listeners()
        const key = '$mediaUpdate';
        if (socket._callbacks?.[key]) return { store: '_callbacks', key };
        if (socket._events?.mediaUpdate) return { store: '_events', key: 'mediaUpdate' };
        return null;
    }

    function _freezeSync() {
        const loc = _getMediaUpdateListeners();
        if (!loc) {
            console.warn('[CyTube SC] Could not find mediaUpdate listeners to freeze');
            return;
        }
        if (loc.store === '_callbacks') {
            _desync.saved = socket._callbacks[loc.key].slice();
            socket._callbacks[loc.key] = [];
        } else {
            _desync.saved = socket._events[loc.key];
            delete socket._events[loc.key];
        }
        console.log('[CyTube SC] Sync frozen — removed', _desync.saved?.length ?? 1, 'mediaUpdate listener(s)');
    }

    function _thawSync() {
        if (!_desync.saved) return;
        const loc = _getMediaUpdateListeners();
        if (loc?.store === '_callbacks') {
            socket._callbacks[loc.key] = _desync.saved;
        } else {
            socket._events = socket._events || {};
            socket._events['mediaUpdate'] = _desync.saved;
        }
        _desync.saved = null;
        console.log('[CyTube SC] Sync restored');
        // Trigger immediate resync
        if (typeof socket !== 'undefined' && socket) {
            socket.emit('playerReady');
        }
    }

    // Single entry point for changing desync state — keeps the button UI in sync
    // whether the toggle came from the button or the chat seek menu.
    function setDesynced(on) {
        if (typeof socket === 'undefined' || !socket) return;
        if (on === _desync.active) return;
        _desync.active = on;
        if (on) _freezeSync(); else _thawSync();
        const btn = _desync.btn;
        if (btn) {
            btn.classList.toggle('sc-desync-active', on);
            btn.title = on ? 'Free watch ON — click to re-sync'
                           : 'Free watch — click to watch freely, click again to re-sync';
        }
    }

    function initDesyncButton() {
        const btn = document.createElement('button');
        btn.id = 'sc-desync-btn';
        btn.textContent = '⟳';
        btn.title = 'Free watch — click to watch freely, click again to re-sync';
        document.body.appendChild(btn);
        _desync.btn = btn;
        btn.addEventListener('click', () => setDesynced(!_desync.active));
    }

    /* ==========================================================
       CHAT → MOVIE SEEK
       Right-click a chat message to desync and rewind the movie to
       roughly when that message was sent (minus a 5s lead-in).

       Each message div carries `dataset.scTime` (absolute Unix-ms,
       set by initChatTimestamps). Assuming uninterrupted playback,
       the movie position when a message was posted is:
           pos_now - (now - msgTime)
       Equivalently the video began (wall-clock) at now - pos_now, so
       any message older than that start is from a *previous* video and
       gets no seek option.
    ========================================================== */

    const SEEK_LEAD_SEC = 5;     // jump to 5s before the message
    const SEEK_START_GRACE_MS = 2000; // tolerance for clock jitter at video start

    function getPlayerVideoEl() {
        return document.querySelector('#ytapiplayer video') || document.querySelector('video');
    }

    function getPlayerTimeSec() {
        const v = getPlayerVideoEl();
        if (v && isFinite(v.currentTime)) return v.currentTime;
        return null;
    }

    function seekPlayerTo(sec) {
        const target = Math.max(0, sec);
        const v = getPlayerVideoEl();
        if (v) {
            try { v.currentTime = target; return true; } catch (e) {}
        }
        try {
            const p = window.PLAYER || window.player;
            if (p && typeof p.seekTo === 'function') { p.seekTo(target); return true; }
        } catch (e) {}
        return false;
    }

    // Returns { target } in seconds, or null if the message predates the
    // current video (different movie) or playback time is unavailable.
    function seekTargetForMsgTime(msgTimeMs) {
        const pos = getPlayerTimeSec();
        if (pos == null) return null;
        const videoStartWall = Date.now() - pos * 1000;
        if (msgTimeMs < videoStartWall - SEEK_START_GRACE_MS) return null; // earlier video
        const target = (msgTimeMs - videoStartWall) / 1000 - SEEK_LEAD_SEC;
        return { target: Math.max(0, target) };
    }

    let _seekMenuEl = null;
    function _seekMenuOutside(e) { if (_seekMenuEl && !_seekMenuEl.contains(e.target)) hideChatSeekMenu(); }
    function _seekMenuKey(e) { if (e.key === 'Escape') hideChatSeekMenu(); }

    function hideChatSeekMenu() {
        if (_seekMenuEl) { _seekMenuEl.remove(); _seekMenuEl = null; }
        document.removeEventListener('mousedown', _seekMenuOutside, true);
        document.removeEventListener('keydown', _seekMenuKey, true);
        window.removeEventListener('scroll', hideChatSeekMenu, true);
    }

    function _fmtClock(sec) {
        sec = Math.max(0, Math.floor(sec));
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        const pad = n => String(n).padStart(2, '0');
        return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    }

    function showChatSeekMenu(x, y, targetSec) {
        hideChatSeekMenu();
        const menu = document.createElement('div');
        menu.className = 'sc-seek-menu';
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'sc-seek-item';
        item.innerHTML = `<span class="sc-seek-main">⤺ Jump movie to ${_fmtClock(targetSec)}</span>`;
        item.addEventListener('click', () => {
            setDesynced(true);
            seekPlayerTo(targetSec);
            hideChatSeekMenu();
        });
        menu.appendChild(item);
        document.body.appendChild(menu);
        _seekMenuEl = menu;

        // Keep on-screen
        const r = menu.getBoundingClientRect();
        menu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
        menu.style.top  = Math.max(4, Math.min(y, window.innerHeight - r.height - 8)) + 'px';

        setTimeout(() => {
            document.addEventListener('mousedown', _seekMenuOutside, true);
            document.addEventListener('keydown', _seekMenuKey, true);
            window.addEventListener('scroll', hideChatSeekMenu, true);
        }, 0);
    }

    function initChatSeekMenu() {
        document.addEventListener('contextmenu', (e) => {
            const buf = document.getElementById('messagebuffer');
            if (!buf) return;
            const msgEl = e.target.closest && e.target.closest('[class*="chat-msg-"]');
            if (!msgEl || !buf.contains(msgEl)) return;
            const t = Number(msgEl.dataset.scTime);
            if (!t) return; // no timestamp captured (e.g. server/system line)
            const info = seekTargetForMsgTime(t);
            if (!info) return; // different movie / no playback → fall through to native menu
            e.preventDefault();
            showChatSeekMenu(e.clientX, e.clientY, info.target);
        });
    }

    /* ==========================================================
       GIF CAPTURE
       Grab the last N seconds of the scene as an animated GIF.

       CyTube's on-page <video> has no crossOrigin attribute, so its
       canvas is tainted. Instead we spin up a hidden crossOrigin clone
       of the same mp4 URL (the server sends permissive CORS), seek it to
       the window start, play it through, sample frames to a canvas, and
       hand the frames to gif.js (Web-Worker encoder). The on-page video
       is never touched — the user keeps watching while it encodes.
    ========================================================== */

    const GIF_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js';
    let _gifWorkerBlobUrl = null;

    // gif.js needs its worker as a separate URL. cytu.be's CSP won't load a
    // cross-origin worker directly, so fetch the source via GM and wrap it in
    // a same-origin blob: URL.
    function getGifWorkerUrl() {
        if (_gifWorkerBlobUrl) return Promise.resolve(_gifWorkerBlobUrl);
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url: GIF_WORKER_URL,
                onload: r => {
                    if (r.status >= 200 && r.status < 300) {
                        _gifWorkerBlobUrl = URL.createObjectURL(
                            new Blob([r.responseText], { type: 'application/javascript' }));
                        resolve(_gifWorkerBlobUrl);
                    } else reject(new Error('worker HTTP ' + r.status));
                },
                onerror: () => reject(new Error('worker fetch failed')),
            });
        });
    }

    function getGifCtor() {
        if (typeof GIF !== 'undefined') return GIF;
        if (typeof window !== 'undefined' && window.GIF) return window.GIF;
        return null;
    }

    // Compute canvas size + how to blit the video frame for a given aspect mode.
    //   native — keep the video's own ratio
    //   crop   — 4:3, center-crop (cover, fills the box, trims overflow)
    //   fit    — 4:3, letterbox (contain, whole frame with black bars)
    function computeFrameGeometry(vw, vh, width, aspect) {
        const even = n => Math.max(2, Math.round(n / 2) * 2);
        if (aspect === 'crop' || aspect === 'fit') {
            const cw = even(width), ch = even(width * 3 / 4);
            const targetAR = cw / ch, srcAR = vw / vh;
            if (aspect === 'crop') {
                let sw, sh, sx, sy;
                if (srcAR > targetAR) { sh = vh; sw = vh * targetAR; sx = (vw - sw) / 2; sy = 0; }
                else                  { sw = vw; sh = vw / targetAR; sx = 0; sy = (vh - sh) / 2; }
                return { cw, ch, letterbox: false, src: [sx, sy, sw, sh], dst: [0, 0, cw, ch] };
            }
            let dw, dh, dx, dy;
            if (srcAR > targetAR) { dw = cw; dh = cw / srcAR; dx = 0; dy = (ch - dh) / 2; }
            else                  { dh = ch; dw = ch * srcAR; dx = (cw - dw) / 2; dy = 0; }
            return { cw, ch, letterbox: true, src: [0, 0, vw, vh], dst: [dx, dy, dw, dh] };
        }
        const cw = even(width), ch = even(width * vh / vw);
        return { cw, ch, letterbox: false, src: null, dst: [0, 0, cw, ch] };
    }

    // Sample frames from a hidden crossOrigin clone across [startT, endT].
    function captureGifFrames({ src, startT, endT, fps, width, aspect }, onProgress) {
        return new Promise((resolve, reject) => {
            const vid = document.createElement('video');
            vid.crossOrigin = 'anonymous';
            vid.muted = true;
            vid.preload = 'auto';
            vid.playsInline = true;
            // Kept in the DOM but visually hidden — a detached/offscreen video can
            // get frame-throttled, which would starve requestVideoFrameCallback.
            vid.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
            document.body.appendChild(vid);

            const frames = [];
            const span = Math.max(0.1, endT - startT);
            const frameInterval = 1 / fps;
            let canvas, ctx, w, h, geom, lastCap = -Infinity, done = false;

            const finish = (err) => {
                if (done) return;
                done = true;
                try { vid.pause(); } catch (e) {}
                try { vid.removeAttribute('src'); vid.load(); } catch (e) {}
                try { vid.remove(); } catch (e) {}
                if (err) reject(err);
                else if (!frames.length) reject(new Error('no frames captured'));
                else resolve({ frames, w, h, delay: Math.round(1000 / fps) });
            };
            const timer = setTimeout(() => finish(new Error('capture timeout')), 60000);

            const onFrame = (now, metadata) => {
                if (done) return;
                const t = metadata ? metadata.mediaTime : vid.currentTime;
                if (t + 1e-4 >= lastCap + frameInterval) {
                    lastCap = t;
                    if (geom.letterbox) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); }
                    if (geom.src) ctx.drawImage(vid, geom.src[0], geom.src[1], geom.src[2], geom.src[3],
                                                     geom.dst[0], geom.dst[1], geom.dst[2], geom.dst[3]);
                    else ctx.drawImage(vid, geom.dst[0], geom.dst[1], geom.dst[2], geom.dst[3]);
                    frames.push(ctx.getImageData(0, 0, w, h));
                    if (onProgress) onProgress(Math.min(0.999, (t - startT) / span));
                }
                if (t >= endT || vid.ended) { clearTimeout(timer); finish(null); return; }
                if ('requestVideoFrameCallback' in vid) vid.requestVideoFrameCallback(onFrame);
            };

            vid.addEventListener('error', () => {
                clearTimeout(timer); finish(new Error('clone load error (CORS/network)'));
            });
            vid.addEventListener('loadedmetadata', () => {
                geom = computeFrameGeometry(vid.videoWidth, vid.videoHeight, width, aspect);
                w = geom.cw; h = geom.ch;
                canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                ctx = canvas.getContext('2d');
                try { vid.currentTime = startT; } catch (e) {}
            });
            vid.addEventListener('seeked', function onSeek() {
                vid.removeEventListener('seeked', onSeek);
                if ('requestVideoFrameCallback' in vid) vid.requestVideoFrameCallback(onFrame);
                else {
                    const iv = setInterval(() => {
                        if (done) { clearInterval(iv); return; }
                        onFrame();
                        if (vid.currentTime >= endT) clearInterval(iv);
                    }, 1000 / fps);
                }
                const p = vid.play();
                if (p && p.catch) p.catch(e => { clearTimeout(timer); finish(new Error('playback blocked: ' + e.message)); });
            });

            vid.src = src;
        });
    }

    function encodeGif({ frames, w, h, delay }, onProgress) {
        return getGifWorkerUrl().then(workerScript => new Promise((resolve, reject) => {
            const Ctor = getGifCtor();
            if (!Ctor) { reject(new Error('gif.js not loaded (@require missing?)')); return; }
            const gif = new Ctor({ workers: 2, quality: 10, width: w, height: h, workerScript, repeat: 0 });
            frames.forEach(f => gif.addFrame(f, { delay }));
            gif.on('progress', p => onProgress && onProgress(p));
            gif.on('finished', blob => resolve(blob));
            gif.on('abort', () => reject(new Error('encode aborted')));
            gif.render();
        }));
    }

    let _gifResultUrl = null;
    function _revokeGifResult() {
        if (_gifResultUrl) { URL.revokeObjectURL(_gifResultUrl); _gifResultUrl = null; }
    }

    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result).split(',', 2)[1] || '');
            r.onerror = () => reject(new Error('read failed'));
            r.readAsDataURL(blob);
        });
    }

    // Upload to ImgBB with a free API key. Returns the direct image URL.
    // ImgBB accepts a base64 payload on /1/upload. `name` (optional) sets the
    // image's display name/filename on ImgBB, e.g. a movie title slug.
    async function uploadToImgbb(blob, apiKey, name) {
        const b64 = await blobToBase64(blob);
        let data = 'image=' + encodeURIComponent(b64);
        if (name) data += '&name=' + encodeURIComponent(name);
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://api.imgbb.com/1/upload?key=' + encodeURIComponent(apiKey),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                data,
                onload: r => {
                    let json = null;
                    try { json = JSON.parse(r.responseText); } catch (e) {}
                    if (r.status >= 200 && r.status < 300 && json && json.success && json.data && json.data.url) {
                        resolve(json.data.url);
                    } else {
                        const msg = (json && json.error && json.error.message)
                            ? json.error.message : ('HTTP ' + r.status);
                        reject(new Error(msg));
                    }
                },
                onerror: () => reject(new Error('network error')),
            });
        });
    }

    // Persistent hidden clone, kept loaded while the panel is open so scrubbing
    // start/end preview frames is fast (one decode, many seeks).
    let _gifScrub = null;
    function getScrubClone(src) {
        if (_gifScrub && _gifScrub.src === src) return _gifScrub;
        destroyScrubClone();
        const vid = document.createElement('video');
        vid.crossOrigin = 'anonymous'; vid.muted = true; vid.preload = 'auto'; vid.playsInline = true;
        vid.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
        document.body.appendChild(vid);
        const ready = new Promise((resolve, reject) => {
            vid.addEventListener('loadedmetadata', () => { _glog('scrub clone loadedmetadata', { vw: vid.videoWidth, vh: vid.videoHeight, dur: vid.duration }); resolve(); }, { once: true });
            vid.addEventListener('error', () => { _glog('scrub clone ERROR', vid.error && vid.error.code, vid.error && vid.error.message); reject(new Error('preview load error (CORS/network)')); }, { once: true });
        });
        _glog('scrub clone created, loading', src && src.slice(0, 80));
        vid.src = src;
        _gifScrub = { vid, src, ready, busy: Promise.resolve() };
        return _gifScrub;
    }
    function destroyScrubClone() {
        if (_gifScrub) { try { _gifScrub.vid.remove(); } catch (e) {} _gifScrub = null; }
    }

    // Seek the scrub clone to `time`, return a small JPEG dataURL. Seeks are
    // serialized through the clone's `busy` chain so rapid nudges don't collide.
    // A *paused* video usually hasn't painted the seeked frame by the time the
    // 'seeked' event fires (drawImage → black), so we briefly play muted and
    // capture the first presented frame via requestVideoFrameCallback.
    const GIF_DEBUG = false;
    const _glog = (...a) => { if (GIF_DEBUG) console.log('[SC GIF]', ...a); };

    function grabPreviewFrame(src, time, w) {
        const sc = getScrubClone(src);
        _glog('grabPreviewFrame request', { time: +time.toFixed(2), w, sameClone: sc.src === src });
        const run = sc.busy.then(() => sc.ready).then(() => new Promise((resolve, reject) => {
            const vid = sc.vid;
            _glog('clone ready', {
                currentSrc: vid.currentSrc && vid.currentSrc.slice(0, 80),
                readyState: vid.readyState, vw: vid.videoWidth, vh: vid.videoHeight,
                duration: vid.duration, error: vid.error && vid.error.code,
                hasRVFC: 'requestVideoFrameCallback' in vid,
            });
            let settled = false;
            const draw = (via) => {
                if (settled) return;
                settled = true;
                try {
                    const h = Math.max(2, Math.round(w * vid.videoHeight / vid.videoWidth));
                    const c = document.createElement('canvas');
                    c.width = w; c.height = h;
                    const ctx = c.getContext('2d');
                    ctx.drawImage(vid, 0, 0, w, h);
                    if (GIF_DEBUG) _glog('draw', { via, readyState: vid.readyState, paused: vid.paused,
                        currentTime: +vid.currentTime.toFixed(2), vw: vid.videoWidth, vh: vid.videoHeight,
                        canvas: w + 'x' + h });
                    const url = c.toDataURL('image/jpeg', 0.72);
                    try { vid.pause(); } catch (e) {}
                    resolve(url);
                } catch (e) { _glog('draw ERROR', e); try { vid.pause(); } catch (e2) {} reject(e); }
            };
            const onSeeked = (viaSafety) => {
                _glog('onSeeked', { viaSafety: !!viaSafety, currentTime: +vid.currentTime.toFixed(2), readyState: vid.readyState });
                let ticks = 0;
                const onFrame = (now, meta) => {
                    if (settled) return;
                    _glog('rVFC tick', ++ticks, meta ? { mediaTime: +meta.mediaTime.toFixed(2) } : '');
                    if (ticks < 2) { vid.requestVideoFrameCallback(onFrame); return; }
                    draw('rVFC#' + ticks);
                };
                if ('requestVideoFrameCallback' in vid) vid.requestVideoFrameCallback(onFrame);
                vid.play().then(() => _glog('play() resolved')).catch(e => _glog('play() rejected', e && e.name, e && e.message));
                setTimeout(() => { if (!settled) draw('timeout1500'); }, 1500);
            };
            vid.addEventListener('seeked', () => onSeeked(false), { once: true });
            setTimeout(() => { if (!settled) onSeeked(true); }, 800);
            try { vid.currentTime = Math.max(0, time); } catch (e) { _glog('set currentTime threw', e); reject(e); }
        }));
        sc.busy = run.catch((e) => { _glog('grab chain error', e && e.message); });
        return run;
    }

    // Filesystem/URL-safe slug of the currently playing movie, e.g. "Blade-Runner-1982".
    // Falls back to '' when no title has been detected yet.
    function _gifTitleSlug() {
        if (!lastMovieTitle) return '';
        const { title, year } = parseMovieFilename(lastMovieTitle);
        let slug = title.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
        if (year) slug += '-' + year;
        return slug;
    }

    function _fmtClockTenths(sec) {
        sec = Math.max(0, sec);
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
    }

    function openGifPanel() {
        if (document.getElementById('sc-gif-panel')) return;
        const v0 = getPlayerVideoEl();
        const src = v0 && (v0.currentSrc || v0.src) || '';
        const isBlob = src.startsWith('blob:');
        const vidDur = (v0 && isFinite(v0.duration)) ? v0.duration : Infinity;
        const now = v0 ? v0.currentTime : 0;

        // Default: a 4s window ending at the current frame.
        let endT = now;
        let startT = Math.max(0, endT - 4);

        const panel = document.createElement('div');
        panel.id = 'sc-gif-panel';
        panel.innerHTML = `
            <div id="sc-gif-head">
                <span>Make GIF</span>
                <button id="sc-gif-close" type="button">✕</button>
            </div>
            <div id="sc-gif-body">
                <div class="sc-gif-marks">
                    <div class="sc-gif-mark">
                        <div class="sc-gif-thumb" id="sc-gif-thumb-start"></div>
                        <div class="sc-gif-mark-label">START · <span id="sc-gif-time-start"></span></div>
                        <div class="sc-gif-mark-btns">
                            <button type="button" data-act="start-current" title="Set start to current playback position">⤓ Now</button>
                            <button type="button" data-act="start-minus">−.5</button>
                            <button type="button" data-act="start-plus">+.5</button>
                        </div>
                    </div>
                    <div class="sc-gif-mark">
                        <div class="sc-gif-thumb" id="sc-gif-thumb-end"></div>
                        <div class="sc-gif-mark-label">END · <span id="sc-gif-time-end"></span></div>
                        <div class="sc-gif-mark-btns">
                            <button type="button" data-act="end-current" title="Set end to current playback position">⤓ Now</button>
                            <button type="button" data-act="end-minus">−.5</button>
                            <button type="button" data-act="end-plus">+.5</button>
                        </div>
                    </div>
                </div>
                <div id="sc-gif-dur-line">Duration <b id="sc-gif-dur-val"></b></div>
                <div class="sc-gif-opts">
                    <label>FPS
                        <select id="sc-gif-fps">
                            <option value="8">8</option><option value="10">10</option>
                            <option value="12" selected>12</option><option value="15">15</option>
                        </select>
                    </label>
                    <label>Width
                        <select id="sc-gif-width">
                            <option value="320">320</option><option value="480" selected>480</option><option value="640">640</option>
                        </select>
                    </label>
                    <label>Shape
                        <select id="sc-gif-aspect">
                            <option value="native">Native</option>
                            <option value="crop" selected>4:3 Crop</option>
                            <option value="fit">4:3 Bars</option>
                        </select>
                    </label>
                </div>
                <button id="sc-gif-go" type="button">● Make GIF</button>
                <div id="sc-gif-status"></div>
                <div id="sc-gif-result"></div>
            </div>`;
        document.body.appendChild(panel);

        const $ = id => panel.querySelector(id);
        const goBtn = $('#sc-gif-go'), status = $('#sc-gif-status'), result = $('#sc-gif-result');
        const setStatus = (txt) => { status.textContent = txt || ''; };

        const close = () => { _revokeGifResult(); destroyScrubClone(); panel.remove(); };
        $('#sc-gif-close').addEventListener('click', close);

        if (isBlob || !src) {
            setStatus(isBlob
                ? 'This source is a streaming (HLS/MSE) blob — frame capture not supported.'
                : 'No video source found.');
        }

        // Reframe the preview thumbnails to match the chosen output shape so
        // the START/END frames show exactly what the GIF will look like.
        const aspectSel = $('#sc-gif-aspect');
        const applyThumbAspect = () => {
            const mode = aspectSel.value;
            ['start', 'end'].forEach(which => {
                const el = $('#sc-gif-thumb-' + which);
                el.classList.toggle('sc-gif-thumb-43', mode !== 'native');
                el.classList.toggle('sc-gif-thumb-fit', mode === 'fit');
            });
        };
        aspectSel.addEventListener('change', applyThumbAspect);
        applyThumbAspect();

        // Debounced per-mark thumbnail refresh.
        const thumbTimers = {};
        const refreshThumb = (which) => {
            if (isBlob || !src) return;
            const t = which === 'start' ? startT : endT;
            const el = $('#sc-gif-thumb-' + which);
            clearTimeout(thumbTimers[which]);
            el.classList.add('sc-gif-thumb-loading');
            thumbTimers[which] = setTimeout(() => {
                grabPreviewFrame(src, t, 160).then(url => {
                    _glog('thumb', which, 'dataURL length', url.length);
                    el.style.backgroundImage = `url("${url}")`;
                    el.classList.remove('sc-gif-thumb-loading');
                }).catch(() => el.classList.remove('sc-gif-thumb-loading'));
            }, 180);
        };

        const render = (changed) => {
            $('#sc-gif-time-start').textContent = _fmtClockTenths(startT);
            $('#sc-gif-time-end').textContent = _fmtClockTenths(endT);
            const dur = Math.max(0, endT - startT);
            $('#sc-gif-dur-val').textContent = dur.toFixed(1) + 's';
            goBtn.disabled = isBlob || !src || dur < 0.1;
            if (changed === 'start' || changed === 'both') refreshThumb('start');
            if (changed === 'end' || changed === 'both') refreshThumb('end');
        };

        const clampStart = () => { startT = Math.min(Math.max(0, startT), endT - 0.1); };
        const clampEnd   = () => { endT = Math.min(Math.max(endT, startT + 0.1), vidDur); };

        panel.querySelector('.sc-gif-marks').addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-act]');
            if (!btn) return;
            const live = getPlayerVideoEl();
            const cur = live ? live.currentTime : 0;
            switch (btn.dataset.act) {
                case 'start-current': startT = cur; clampStart(); render('start'); break;
                case 'start-minus':   startT -= 0.5; clampStart(); render('start'); break;
                case 'start-plus':    startT += 0.5; clampStart(); render('start'); break;
                case 'end-current':   endT = cur; clampEnd(); render('end'); break;
                case 'end-minus':     endT -= 0.5; clampEnd(); render('end'); break;
                case 'end-plus':      endT += 0.5; clampEnd(); render('end'); break;
            }
        });

        goBtn.addEventListener('click', async () => {
            if (isBlob || !src) return;
            const fps    = parseInt($('#sc-gif-fps').value, 10);
            const width  = parseInt($('#sc-gif-width').value, 10);
            const aspect = $('#sc-gif-aspect').value;
            if (endT - startT < 0.1) { setStatus('End must be after start.'); return; }

            _revokeGifResult();
            result.innerHTML = '<div class="sc-gif-working"><span class="sc-gif-spinner"></span><span id="sc-gif-working-txt">Capturing frames…</span></div>';
            const workTxt = $('#sc-gif-working-txt');
            const setWork = (t) => { if (workTxt) workTxt.textContent = t; };
            goBtn.disabled = true;
            try {
                setStatus('');
                const cap = await captureGifFrames(
                    { src, startT, endT, fps, width, aspect },
                    p => setWork('Capturing frames… ' + Math.round(p * 100) + '%'));
                setWork('Encoding GIF… (' + cap.frames.length + ' frames)');
                const blob = await encodeGif(cap, p => setWork('Encoding GIF… ' + Math.round(p * 100) + '%'));
                _gifResultUrl = URL.createObjectURL(blob);
                const kb = Math.round(blob.size / 1024);
                const slug = _gifTitleSlug();
                const fnameBase = (slug || 'grindhouse') + '-' + Date.now();
                const fname = fnameBase + '.gif';
                result.innerHTML =
                    `<img src="${_gifResultUrl}" alt="GIF preview">` +
                    `<div id="sc-gif-actions">` +
                    `<a id="sc-gif-dl" href="${_gifResultUrl}" download="${fname}">⬇ Download</a>` +
                    `<button id="sc-gif-upload" type="button">☁ Upload</button>` +
                    `<span id="sc-gif-size">${kb} KB</span></div>` +
                    `<div id="sc-gif-link"></div>`;
                setStatus('Done.');

                const uploadBtn = $('#sc-gif-upload');
                if (uploadBtn) uploadBtn.addEventListener('click', async () => {
                    const linkBox = $('#sc-gif-link');
                    const apiKey = getKey(LS_IMGBB);
                    if (!apiKey) {
                        linkBox.innerHTML = '<span class="sc-gif-link-msg">Add an ImgBB API key in ⚙ Settings to enable uploads.</span>';
                        return;
                    }
                    uploadBtn.disabled = true;
                    linkBox.innerHTML = '<span class="sc-gif-spinner sc-gif-spinner-sm"></span><span class="sc-gif-link-msg">Uploading to ImgBB…</span>';
                    try {
                        const link = await uploadToImgbb(blob, apiKey, fnameBase);
                        linkBox.innerHTML =
                            `<a class="sc-gif-link-url" href="${link}" target="_blank" rel="noopener">${_escHtml(link)}</a>` +
                            `<button id="sc-gif-copylink" type="button">⧉ Copy link</button>`;
                        uploadBtn.textContent = '✓ Uploaded';
                        try { await navigator.clipboard.writeText(link); } catch (e) {}
                        const cl = $('#sc-gif-copylink');
                        if (cl) cl.addEventListener('click', async () => {
                            try { await navigator.clipboard.writeText(link); cl.textContent = '✓ Copied'; }
                            catch (e) { cl.textContent = '✗'; }
                        });
                    } catch (e) {
                        linkBox.innerHTML = '<span class="sc-gif-link-msg sc-test-bad">Upload failed: ' + _escHtml(e.message || String(e)) + '</span>';
                        uploadBtn.disabled = false;
                    }
                });
            } catch (e) {
                console.error('[SC] GIF capture failed:', e);
                result.innerHTML = '';
                setStatus('Failed: ' + (e.message || e));
            } finally {
                goBtn.disabled = false;
            }
        });

        render('both');
    }

    function addFloatingButtons() {
        if (document.getElementById('fs-toggle-btn')) return;

        const fsBtn = document.createElement('button');
        fsBtn.id = 'fs-toggle-btn'; fsBtn.textContent = '⛶'; fsBtn.title = 'Toggle Fullscreen';
        fsBtn.addEventListener('click', () => {
            document.fullscreenElement
                ? document.exitFullscreen().catch(() => {})
                : document.documentElement.requestFullscreen().catch(() => {});
        });
        document.body.appendChild(fsBtn);

        document.addEventListener('fullscreenchange', () => {
            fsBtn.style.display = document.fullscreenElement ? 'none' : '';
        });

        const gifBtn = document.createElement('button');
        gifBtn.id = 'sc-gif-btn'; gifBtn.textContent = '◉'; gifBtn.title = 'Make a GIF of this scene';
        gifBtn.addEventListener('click', openGifPanel);
        document.body.appendChild(gifBtn);
    }

    /* ==========================================================
       EMOTE BUTTON RELOCATION
       CyTube's #emotelistbtn lives inside #leftcontrols which we
       hide in horizontal mode. Clone it outside so it's always visible,
       and forward clicks to the original so CyTube's picker still opens.
    ========================================================== */

    const _VHS_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5628 3728" fill="currentColor" aria-hidden="true"><g transform="matrix(1.3333333,0,0,-1.3333333,0,3728)"><g transform="scale(0.1)"><g transform="scale(2.31715)"><path d="m 16300,9657.36 v -335.45 c -157.2,180.66 -390.4,294.66 -648.5,294.66 H 2567.81 c -260.88,0 -494.75,-115.91 -651.51,-298.23 v 339.02 c 0,353.34 291.56,640.74 649.98,640.74 H 15650 c 358.5,0 650,-287.4 650,-640.74"/></g><g transform="scale(1.06574)"><path d="m 11418,14609.4 h 187.4 V 16300 c -2170.61,-146.3 -3886.11,-1953.4 -3886.11,-4161.2 0,-2207.82 1715.5,-4015.03 3886.11,-4161.31 v 1924.59 c -132.5,17.26 -261.1,46.72 -384.9,86.79 -79.8,26.13 -165.5,-18.86 -189.4,-99.46 l -34.2,-114.57 c -29.3,-98.71 -147.7,-138.87 -231.1,-78.26 l -763.8,555.02 c -83.41,60.6 -81.81,185.5 3.1,244.1 l 98.6,68 c 69.3,47.7 85.5,143.1 36.1,211 -260.06,357.1 -413.47,796.9 -413.47,1272.5 v 1.6 c 0,83.3 -68.31,150.7 -151.73,148.6 l -121.51,-3.1 c -103.15,-2.5 -177.72,97.6 -145.84,195.6 l 291.75,898 c 31.81,98.1 151.07,135.2 232.89,72.5 l 95.24,-72.8 c 66.71,-51.1 162.37,-37.3 211.77,30.6 265.9,366 643.9,645.2 1083.3,787.6 79.8,25.9 122.4,112.7 94.5,191.8 l -39.7,112.8 c -34.3,97.1 37.8,199 141,199"/></g><g transform="scale(2.08529)"><path d="m 14313.8,8330.5 v -864 h 95.9 c 52.6,0 89.5,-52.03 71.9,-101.72 l -20.2,-57.59 c -14.3,-40.47 7.4,-84.83 48.2,-98.07 224.6,-72.79 417.8,-215.46 553.8,-402.53 25.2,-34.67 74,-41.72 108.2,-15.63 l 48.6,37.26 c 41.8,31.98 102.8,12.99 119.1,-37.12 l 149.1,-458.88 c 16.3,-50.11 -21.9,-101.33 -74.6,-100.04 l -62.1,1.63 c -42.6,1.01 -77.6,-33.37 -77.5,-76 v -0.82 c 0,-243.04 -78.5,-467.75 -211.3,-650.32 -25.3,-34.67 -17,-83.49 18.4,-107.85 l 50.5,-34.76 c 43.3,-29.88 44.1,-93.76 1.5,-124.74 l -390.4,-283.6 c -42.6,-31.03 -103.1,-10.5 -118.1,39.99 l -17.4,58.51 c -12.3,41.19 -56.1,64.16 -96.9,50.88 -63.2,-20.53 -129,-35.58 -196.7,-44.41 v -983.6 c 1109.4,74.76 1986.2,998.37 1986.2,2126.75 0,1128.34 -876.8,2051.9 -1986.2,2126.66"/></g><g transform="scale(2.31715)"><path d="m 15169.1,3729.71 c 0,-505.24 -409.6,-914.79 -914.8,-914.79 h -1098.8 c -277.4,0 -502.4,224.93 -502.4,502.38 v 4531.45 c 0,277.42 225,502.4 502.4,502.4 h 1098.9 c 487.9,0 886.5,-381.98 913.3,-863.17 0.9,-17.09 1.4,-34.26 1.4,-51.57 z m -3232.9,-341.07 c 0,-340.98 -276.4,-617.4 -617.4,-617.4 H 6900.45 c -340.98,0 -617.4,276.42 -617.4,617.4 v 4388.71 c 0,340.99 276.42,617.41 617.4,617.41 h 4418.35 c 341,0 617.4,-276.42 617.4,-617.41 z M 5566.1,3317.3 c 0,-277.45 -224.93,-502.38 -502.39,-502.38 H 3964.9 c -505.22,0 -914.78,409.55 -914.78,914.79 v 3706.7 c 0,505.18 409.56,914.74 914.73,914.74 h 1098.86 c 264.47,0 481.2,-204.38 500.96,-463.77 0.95,-12.76 1.43,-25.62 1.43,-38.63 z m 10732.5,5385.84 c -24.1,387.6 -346.1,694.52 -739.8,694.52 H 2660.51 c -409.41,0 -741.25,-331.89 -741.25,-741.25 V 2509.63 c 0,-409.38 331.84,-741.21 741.25,-741.21 H 15558.8 c 409.4,0 741.2,331.83 741.2,741.21 v 6146.78 c 0,15.73 -0.5,31.3 -1.4,46.73"/></g></g></g></svg>';

    function relocateEmoteButton() {
        const existing = document.getElementById('sc-emote-proxy');
        if (existing) {
            if (!existing.querySelector('svg')) existing.innerHTML = _VHS_SVG;
            return;
        }
        const original = document.getElementById('emotelistbtn');
        if (!original) return;

        const proxy = document.createElement('button');
        proxy.id = 'sc-emote-proxy';
        proxy.innerHTML = _VHS_SVG;
        proxy.title = 'Emotes';
        proxy.setAttribute('aria-label', 'Emote Picker');

        proxy.addEventListener('click', e => {
            e.stopPropagation();
            original.click();
        });

        document.body.appendChild(proxy);
    }

    const applyInputMode = () => {
        const inputs = document.getElementsByClassName('emotelist-search');
        if (!inputs.length) return;
        for (const input of inputs) {
            if (input.getAttribute('inputmode') !== 'none') input.setAttribute('inputmode', 'none');
        }
    };

    /* ==========================================================
       MOVIE TITLE CLEANING
       Handles filenames like: White.Fire.[1984].mkv
       → returns { title: "White Fire", year: "1984" }
    ========================================================== */

    function parseMovieFilename(raw) {
        // Remove file extension
        let s = raw.replace(/\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts|divx|xvid|ogv)$/i, '');

        // Extract year from brackets or parens: [1984] or (1984)
        let year = null;
        const yearMatch = s.match(/[\[(](\d{4})[\])]/);
        if (yearMatch) {
            year = yearMatch[1];
            s = s.slice(0, yearMatch.index); // strip everything from year onwards
        }

        // Replace dots and underscores with spaces
        s = s.replace(/[._]+/g, ' ');

        // Strip leftover brackets and their contents (tags like [BluRay], [720p])
        s = s.replace(/[\[(][^\])]*/g, '').replace(/[\])]/, '');

        // Trim and collapse whitespace
        s = s.replace(/\s+/g, ' ').trim();

        return { title: s, year };
    }

    /* ==========================================================
       YOUTUBE TITLE CLEANING
       Aggressively strips noise from YT "full movie" titles so TMDB
       can find the actual film name.
    ========================================================== */

    const YT_NOISE = [
        'full movie', 'full length movie', 'full length feature', 'full length film', 'full length',
        'complete movie', 'complete film', 'the complete movie', 'entire movie',
        'free movie', 'free film', 'free online', 'free to watch', 'watch online', 'watch free',
        'watch now', 'online free', 'free with ads', 'with ads', 'no ads', 'ad free',
        'official movie', 'official film', 'official', 'exclusive', 'premiere', 'world premiere',
        'remastered', 'restored', 'colou?ri[sz]ed', 'subtitle[sd]?', 'subbed', 'dubbed', 'eng sub',
        'hd', 'fhd', 'uhd', '4k', '2k', '1080p', '720p', '480p', 'high definition',
        'blu-?ray', 'dvd', 'web-?dl', 'uncut', 'extended', 'director.?s cut', 'special edition',
        'classic movie', 'classic film', 'cult classic', 'b-?movie', 'feature film', 'feature',
        'cinema', 'blockbuster', 'must watch', 'in english', 'english movie',
    ];
    const YT_GENRES = ['action', 'thriller', 'horror', 'comedy', 'drama', 'sci-?fi', 'science fiction',
        'western', 'romance', 'crime', 'mystery', 'adventure', 'fantasy', 'war', 'noir', 'slasher',
        'martial arts', 'kung fu', 'documentary', 'family', 'musical', 'animation'];

    function parseYouTubeTitle(raw) {
        let s = ' ' + raw + ' ';
        let year = null;
        const ym = s.match(/\b(19\d{2}|20\d{2})\b/);
        if (ym) year = ym[1];
        s = s.replace(/[\[({][^\])}]*[\])}]/g, ' ');
        if (year) s = s.replace(new RegExp('\\b' + year + '\\b', 'g'), ' ');
        [...YT_NOISE, ...YT_GENRES].forEach(n => {
            s = s.replace(new RegExp('\\b' + n + '\\b', 'gi'), ' ');
        });
        s = s.replace(/[^\w\s&':!.,-]/g, ' ');
        const segs = s.split(/\s[|–—•:_-]+\s/)
            .map(x => x.replace(/\s+/g, ' ').trim())
            .filter(x => x.length >= 2);
        let title = segs.sort((a, b) =>
            (b.match(/[a-z]/gi) || []).length - (a.match(/[a-z]/gi) || []).length
        )[0] || s;
        title = title.replace(/\s+/g, ' ').replace(/^[\s'":.,-]+|[\s'":.,-]+$/g, '').trim();
        return { title, year };
    }

    // Current media duration/type — updated by the changeMedia socket event.
    let currentMediaSeconds = 0;
    let currentMediaType    = '';
    function parseTimeToSeconds(t) {
        const parts = String(t).trim().split(':').map(Number);
        if (!parts.length || parts.some(isNaN)) return 0;
        return parts.reduce((acc, v) => acc * 60 + v, 0);
    }
    function getCurrentMediaSeconds() {
        if (currentMediaSeconds > 0) return currentMediaSeconds;
        const el = document.querySelector('#queue .queue_active .qe_time, #queue .queue_entry.active .qe_time');
        return el ? parseTimeToSeconds(el.textContent) : 0;
    }

    /* ==========================================================
       MOVIE LINKS — TMDB lookup → confirmed IMDb + Letterboxd + Wikipedia
    ========================================================== */

    const LINK_DEFS = [
        { key: 'imdb',       label: 'IMDb',       color: '#f5c518', fg: '#000', char: 'i' },
        { key: 'letterboxd', label: 'Letterboxd', color: '#2c4a2e', fg: '#00e054', char: 'L' },
        { key: 'wiki',       label: 'Wikipedia',  color: '#444',    fg: '#eee', char: 'W' },
    ];

    let lastMovieTitle = '';
    // Cache by raw title to avoid repeat lookups — persisted to localStorage so a page
    // reload doesn't re-hit TMDB/Wikipedia/IMDb for every title already looked up.
    let movieLinkCache = (() => {
        try {
            const raw = localStorage.getItem(LS_MOVIE_CACHE);
            return raw ? JSON.parse(raw) : {};
        } catch (e) { return {}; }
    })();

    // ── Kill-Count JSONL (fetched once, keyed by tmdbId) ───────────────────────
    let killCountDb = null; // null = not loaded yet, {} = loaded (may be empty)

    async function getKillCountDb() {
        if (killCountDb !== null) return killCountDb;
        killCountDb = {};
        try {
            // Use GM_xmlhttpRequest to bypass any CORS issues with raw.githubusercontent.com
            const text = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: 'https://raw.githubusercontent.com/lklynet/Kill-Count/main/killcounts.jsonl',
                    onload: r => r.status === 200 ? resolve(r.responseText) : reject(new Error(`HTTP ${r.status}`)),
                    onerror: reject,
                });
            });
            let loaded = 0;
            for (const line of text.split('\n')) {
                const s = line.trim();
                if (!s) continue;
                try {
                    const entry = JSON.parse(s);
                    // Field name confirmed from repo: tmdb_id and count
                    if (entry.tmdb_id != null) {
                        killCountDb[String(entry.tmdb_id)] = entry.count;
                        loaded++;
                    }
                } catch (e) {}
            }
        } catch (e) {
            console.warn('[CyTube SC] Kill count DB failed to load:', e);
        }
        return killCountDb;
    }


    /* ==========================================================
       IMDb GraphQL — parent guide + trivia (free, no API key)
    ========================================================== */

    const IMDB_GQL = 'https://caching.graphql.imdb.com/';

    function imdbGmFetch(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers: {
                    'Accept': 'application/graphql+json, application/json',
                    'Content-Type': 'application/json',
                    'x-imdb-client-name': 'imdb-web-next-localized',
                    'x-imdb-user-language': 'en-US',
                    'x-imdb-user-country': 'US',
                },
                onload: r => {
                    if (r.status >= 200 && r.status < 300) {
                        try { resolve(JSON.parse(r.responseText)); }
                        catch (e) { reject(e); }
                    } else {
                        reject(new Error(`HTTP ${r.status}`));
                    }
                },
                onerror: reject,
            });
        });
    }

    async function imdbQuery(operationName, query, variables) {
        const url = IMDB_GQL +
            '?operationName=' + encodeURIComponent(operationName) +
            '&query='         + encodeURIComponent(query) +
            '&variables='     + encodeURIComponent(JSON.stringify(variables));
        return imdbGmFetch(url);
    }

    async function fetchImdbParentalGuide(tconst) {
        if (!tconst) return null;
        const q = 'query GHGuide($id: ID!){ title(id:$id){ parentsGuide{ categories{ category{ text } severity{ text } } } } }';
        try {
            const data = await imdbQuery('GHGuide', q, { id: tconst });
            const cats = data?.data?.title?.parentsGuide?.categories;
            if (!cats) return null;
            return cats
                .map(c => ({ category: c.category?.text, severity: c.severity?.text }))
                .filter(c => c.category && c.severity);
        } catch (e) { return null; }
    }

    const _triviaCache = {};
    async function fetchImdbTrivia(tconst) {
        if (!tconst) return null;
        if (_triviaCache[tconst]) return _triviaCache[tconst];
        const q = 'query GHTrivia($id: ID!){ title(id:$id){ trivia(first: 30){ edges{ node{ text{ plainText } } } } } }';
        try {
            const data = await imdbQuery('GHTrivia', q, { id: tconst });
            const edges = data?.data?.title?.trivia?.edges || [];
            const items = edges.map(e => e?.node?.text?.plainText).filter(Boolean);
            _triviaCache[tconst] = items;
            return items;
        } catch (e) { return null; }
    }

    async function lookupMovie(title, year) {
        const cacheKey = title + (year || '');
        if (movieLinkCache[cacheKey] !== undefined) return movieLinkCache[cacheKey];

        // ── TMDB + Wikipedia in parallel ─────────────────────────────────────────
        let tmdbResult = null;
        let wikiUrl    = null;

        const tmdbPromise = hasKey(LS_TMDB) ? (async () => {
            try {
                const params = new URLSearchParams({ api_key: getKey(LS_TMDB), query: title, language: 'en-US' });
                if (year) params.set('year', year);
                let res = await fetch(`https://api.themoviedb.org/3/search/movie?${params}`);
                if (!res.ok) return;
                let data = await res.json();
                // TMDB's `year` param is a hard filter, not a ranking hint -- a schedule's
                // listed year one off from TMDB's own release date returns zero results even
                // though the film is right there under a yearless search. Retry once without it.
                if (!data.results?.length && year) {
                    params.delete('year');
                    res = await fetch(`https://api.themoviedb.org/3/search/movie?${params}`);
                    if (!res.ok) return;
                    data = await res.json();
                }
                if (!data.results?.length) return;
                let best = data.results[0];
                if (year) {
                    const withYear = data.results.find(r => r.release_date?.startsWith(year));
                    if (withYear) best = withYear;
                }
                const detailRes = await fetch(
                    `https://api.themoviedb.org/3/movie/${best.id}?api_key=${getKey(LS_TMDB)}&append_to_response=external_ids`
                );
                if (!detailRes.ok) return;
                const detail = await detailRes.json();
                tmdbResult = {
                    tmdbId:   best.id,
                    imdbId:   detail.imdb_id || detail.external_ids?.imdb_id || null,
                    title:    detail.title,
                    year:     detail.release_date ? detail.release_date.slice(0, 4) : year,
                    rating:   detail.vote_average  ? Math.round(detail.vote_average * 10) / 10 : null,
                    runtime:  detail.runtime || null,
                    genres:   (detail.genres || []).map(g => g.name),
                    poster:   detail.poster_path   ? `https://image.tmdb.org/t/p/w342${detail.poster_path}` : null,
                    backdrop: detail.backdrop_path ? `https://image.tmdb.org/t/p/w780${detail.backdrop_path}` : null,
                    overview: detail.overview || null,
                };
            } catch (e) {}
        })() : Promise.resolve();

        // Wikipedia can start immediately with the raw title; we'll use tmdbResult.title if available
        // but since it runs in parallel we use the raw title — good enough for wiki search
        const wikiPromise = (async () => {
            try {
                const searchTitle = title + (year ? ' ' + year : '') + ' film';
                const res = await fetch(
                    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${
                        encodeURIComponent(searchTitle)
                    }&srlimit=1&format=json&origin=*`
                );
                if (!res.ok) return;
                const data = await res.json();
                const hit = data?.query?.search?.[0];
                if (hit) wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`;
            } catch (e) {}
        })();

        await Promise.all([tmdbPromise, wikiPromise]);

        // ── Kill count (from cached JSONL) ───────────────────────────────────────
        let killCount = null;
        if (tmdbResult?.tmdbId) {
            const db = await getKillCountDb();
            const count = db[String(tmdbResult.tmdbId)];
            if (count !== undefined && count !== null) killCount = count;
        }

        // ── IMDb Parent Guide ─────────────────────────────────────────────────────
        const parentalGuide = await fetchImdbParentalGuide(tmdbResult?.imdbId);

        const result = {
            links: {
                imdb:       tmdbResult?.imdbId  ? `https://www.imdb.com/title/${tmdbResult.imdbId}/` : null,
                letterboxd: tmdbResult?.tmdbId  ? `https://letterboxd.com/tmdb/${tmdbResult.tmdbId}` : null,
                wiki:       wikiUrl,
            },
            killCount,
            parentalGuide,
            imdbId:     tmdbResult?.imdbId   || null,
            cleanTitle: tmdbResult?.title    || null,
            cleanYear:  tmdbResult?.year     || null,
            rating:     tmdbResult?.rating   ?? null,
            runtime:    tmdbResult?.runtime  || null,
            genres:     tmdbResult?.genres   || [],
            poster:     tmdbResult?.poster   || null,
            backdrop:   tmdbResult?.backdrop || null,
            overview:   tmdbResult?.overview || null,
        };

        movieLinkCache[cacheKey] = result;
        try { localStorage.setItem(LS_MOVIE_CACHE, JSON.stringify(movieLinkCache)); }
        catch (e) { /* storage full/unavailable -- in-memory cache for this session still works */ }
        return result;
    }

    function isYouTubeMedia() {
        // CyTube exposes current media on the global PLAYER or window.player object.
        // The type field is 'yt' for YouTube. Also check for the YouTube iframe directly.
        try {
            const p = window.PLAYER || window.player;
            if (p && p.type === 'yt') return true;
            if (p && p.mediaType === 'yt') return true;
        } catch (e) {}
        // Fallback: check if a YouTube iframe is present in the video wrapper
        if (document.querySelector('#ytapiplayer iframe[src*="youtube.com"]')) return true;
        if (document.querySelector('#ytapiplayer[src*="youtube.com"]')) return true;
        return false;
    }

    let _currentImdbId = null;
    let _npData        = null;
    let _npHideTimer   = null;

    const NP_PG_SHORT = {
        'Sex & Nudity': 'Sex/Nudity', 'Violence & Gore': 'Violence',
        'Profanity': 'Profanity', 'Alcohol, Drugs & Smoking': 'Drugs',
        'Frightening & Intense Scenes': 'Frightening',
    };

    function showNowPlayingCard(data, opts = {}) {
        if (!data || (!data.cleanTitle && !data.backdrop)) return;
        let card = document.getElementById('sc-np-card');
        if (!card) {
            card = document.createElement('div');
            card.id = 'sc-np-card';
            card.innerHTML = `
                <div id="sc-np-backdrop"></div>
                <div id="sc-np-scrim"></div>
                <div id="sc-np-content">
                    <img id="sc-np-poster" alt="" />
                    <div id="sc-np-info">
                        <div id="sc-np-eyebrow">Now Playing</div>
                        <div id="sc-np-title"></div>
                        <div id="sc-np-meta"></div>
                        <div id="sc-np-overview"></div>
                        <div id="sc-np-chips"></div>
                    </div>
                </div>`;
            document.body.appendChild(card);
            card.addEventListener('click', hideNowPlayingCard);
        }
        const title = data.cleanTitle || '';
        const year  = data.cleanYear ? ` (${data.cleanYear})` : '';
        card.querySelector('#sc-np-backdrop').style.backgroundImage = data.backdrop ? `url(${data.backdrop})` : 'none';
        const poster = card.querySelector('#sc-np-poster');
        if (data.poster) { poster.src = data.poster; poster.style.display = ''; }
        else poster.style.display = 'none';
        card.querySelector('#sc-np-title').textContent = title + year;
        card.querySelector('#sc-np-overview').textContent = data.overview || '';
        const metaParts = [];
        if (data.rating)  metaParts.push(`⭐ ${data.rating}`);
        if (data.runtime) metaParts.push(`${Math.floor(data.runtime / 60)}h ${data.runtime % 60}m`);
        if (data.genres && data.genres.length) metaParts.push(data.genres.slice(0, 3).join(' · '));
        card.querySelector('#sc-np-meta').textContent = metaParts.join('     ');
        const chipHtml = [];
        (data.parentalGuide || []).forEach(pg => {
            const sev = String(pg.severity || '').toLowerCase();
            const label = NP_PG_SHORT[pg.category] || pg.category;
            chipHtml.push(`<span class="sc-np-chip sc-sev-${sev}">${label}: ${pg.severity}</span>`);
        });
        if (data.killCount !== null && data.killCount !== undefined) {
            chipHtml.push(`<span class="sc-np-chip">💀 ${data.killCount} kills</span>`);
        }
        card.querySelector('#sc-np-chips').innerHTML = chipHtml.join('');
        card.classList.add('sc-np-visible');
        clearTimeout(_npHideTimer);
        if (opts.autoHide) _npHideTimer = setTimeout(hideNowPlayingCard, 7000);
    }

    function hideNowPlayingCard() {
        const card = document.getElementById('sc-np-card');
        if (card) card.classList.remove('sc-np-visible');
        clearTimeout(_npHideTimer);
    }

    function injectMovieLinks(titleEl) {
        const rawTitle = titleEl.textContent.trim()
            .replace(/^currently\s+playing[:\s]*/i, '')
            .replace(/^now\s+playing[:\s]*/i, '').trim();

        if (!rawTitle || rawTitle === lastMovieTitle || rawTitle.length < 2) return;
        lastMovieTitle = rawTitle;
        lineupObserveTitleChange(rawTitle);
        _currentImdbId = null;

        // Clean up previous links/stats/trivia button
        ['sc-movie-links', 'sc-movie-stats', 'sc-trivia-btn'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.remove();
        });

        const isYt = isYouTubeMedia();
        let ytSeconds = 0;
        if (isYt) {
            ytSeconds = getCurrentMediaSeconds();
            if (ytSeconds < 3600) return; // short YouTube clip — skip
        }

        const { title, year } = isYt ? parseYouTubeTitle(rawTitle) : parseMovieFilename(rawTitle);
        if (!title || title.length < 2) return;

        if (movieLinksEnabled()) {
            const linkRow = document.createElement('span');
            linkRow.id = 'sc-movie-links';
            linkRow.innerHTML = '<span class="sc-movie-loading">…</span>';
            titleEl.parentElement.insertBefore(linkRow, titleEl.nextSibling);
        }

        lookupMovie(title, year).then(({ links, killCount, parentalGuide, imdbId, cleanTitle, cleanYear, rating, runtime, genres, poster, backdrop, overview }) => {
            if (isYt && !cleanTitle) {
                const r = document.getElementById('sc-movie-links');
                if (r) r.remove();
                return;
            }
            if (isYt && runtime && ytSeconds) {
                const diff = Math.abs(runtime - ytSeconds / 60);
                if (diff > 30) { const r = document.getElementById('sc-movie-links'); if (r) r.remove(); return; }
            }

            _currentImdbId = imdbId || null;
            _npData = { cleanTitle, cleanYear, poster, backdrop, overview, rating, runtime, genres: genres || [], parentalGuide, killCount, imdbId };

            // Update title with clean TMDB title, wrapped in a clickable span
            if (cleanTitle && titleEl) {
                const newText = cleanTitle + (cleanYear ? ` (${cleanYear})` : '');
                let span = document.getElementById('sc-title-text');
                if (!span) {
                    span = document.createElement('span');
                    span.id = 'sc-title-text';
                    span.style.cursor = 'pointer';
                    span.title = 'Movie info (I)';
                    span.addEventListener('click', (e) => { e.stopPropagation(); showNowPlayingCard(_npData, { autoHide: false }); });
                    const textNode = [...titleEl.childNodes].find(n => n.nodeType === 3 && n.textContent.trim());
                    if (textNode) textNode.parentNode.replaceChild(span, textNode);
                    else titleEl.insertBefore(span, titleEl.firstChild);
                }
                span.textContent = newText;
            }

            // Icon links row
            if (movieLinksEnabled()) {
                const currentRow = document.getElementById('sc-movie-links');
                if (currentRow) {
                    currentRow.innerHTML = '';
                    let anyLink = false;
                    LINK_DEFS.forEach(({ key, label, color, fg, char }) => {
                        const url = links[key];
                        if (!url) return;
                        anyLink = true;
                        const a = document.createElement('a');
                        a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
                        a.title = `${label}: "${cleanTitle || title}"${cleanYear ? ` (${cleanYear})` : ''}`;
                        a.className = 'sc-movie-link';
                        a.style.background = color; a.style.color = fg;
                        a.textContent = char;
                        currentRow.appendChild(a);
                    });
                    if (!anyLink) currentRow.remove();
                }
            }

            // Trivia button — only when we have an IMDb ID
            if (imdbId) {
                const tb = document.createElement('button');
                tb.id = 'sc-trivia-btn';
                tb.textContent = 'Trivia';
                tb.title = 'IMDb trivia (press T)';
                tb.addEventListener('click', toggleTriviaPanel);
                document.body.appendChild(tb);
            }

            // Stats bar — rating, runtime, kill count, DtDD, parent guide
            const statParts = [];
            if (rating !== null) statParts.push(`⭐ ${rating}`);
            if (runtime)         statParts.push(`${runtime} min`);
            if (killCount !== null) statParts.push(`💀 ${killCount} kills`);
            if (parentalGuide && parentalGuide.length) {
                const SEV = { Severe: '🔴', Moderate: '🟡', Mild: '🟢', None: '' };
                parentalGuide.forEach(({ category, severity }) => {
                    const dot = SEV[severity] || '';
                    if (dot) statParts.push(`${dot} ${category}`);
                });
            }

            const old = document.getElementById('sc-movie-stats');
            if (old) old.remove();
            if (statParts.length) {
                const statsEl = document.createElement('div');
                statsEl.id = 'sc-movie-stats';
                statsEl.textContent = statParts.join('  ·  ');
                document.body.appendChild(statsEl);
                setTimeout(() => { if (statsEl.parentNode) statsEl.remove(); }, 12000);
            }
        });
    }

    function triggerTitleInject() {
        for (const el of [
            document.getElementById('currenttitle'),
            document.querySelector('#videowrap-header .pull-left'),
            document.querySelector('#videowrap-header span'),
            document.querySelector('.video-title'),
        ]) {
            if (el && el.textContent.trim()) { injectMovieLinks(el); return; }
        }
    }

    let _titleObsAttached = false;
    function attachHeaderObserver() {
        if (_titleObsAttached) return;
        const header = document.getElementById('videowrap-header');
        if (!header) return;
        _titleObsAttached = true;
        new MutationObserver(triggerTitleInject).observe(header, { childList: true, subtree: true, characterData: true });
    }

    function watchMovieTitle() {
        triggerTitleInject();
        attachHeaderObserver();
        // Poll for ~20s on cold load in case header isn't ready yet
        let tries = 0;
        const poll = setInterval(() => {
            attachHeaderObserver();
            triggerTitleInject();
            if (++tries >= 14) clearInterval(poll);
        }, 1500);
    }

    function initMediaWatcher() {
        const tryBind = () => {
            if (typeof socket === 'undefined' || !socket) return;
            socket.on('changeMedia', (data) => {
                try {
                    currentMediaSeconds = (data && typeof data.seconds === 'number') ? data.seconds : 0;
                    currentMediaType    = (data && data.type) ? data.type : '';
                    setTimeout(triggerTitleInject, 350);
                } catch (e) {}
            });
        };
        // socket may not be ready at document-start; try at load then again after a short delay
        window.addEventListener('load', () => { tryBind(); setTimeout(tryBind, 2000); });
    }

    /* ==========================================================
       CHAT TIMESTAMP TOOLTIPS
       Each chatMsg carries an absolute Unix-ms `time`. We stamp the
       rendered message div with a `title` so hovering shows the time
       in the viewer's own timezone (new Date renders in local tz).
    ========================================================== */
    function formatChatTime(ms) {
        try {
            return new Date(ms).toLocaleString(undefined, {
                weekday: 'short', month: 'short', day: 'numeric',
                hour: 'numeric', minute: '2-digit', second: '2-digit'
            });
        } catch (e) { return ''; }
    }

    function initChatTimestamps() {
        let bound = false;
        const tryBind = () => {
            if (bound || typeof socket === 'undefined' || !socket || !socket.on) return;
            bound = true;
            // Registered after CyTube's own handler, so by the time this runs
            // the message div is already appended — it's the last child.
            socket.on('chatMsg', (data) => {
                try {
                    if (!data || typeof data.time !== 'number') return;
                    const buf = document.getElementById('messagebuffer');
                    const el = buf && buf.lastElementChild;
                    if (el && !el.dataset.scTime) {
                        el.dataset.scTime = String(data.time);
                        el.title = formatChatTime(data.time);
                    }
                } catch (e) {}
            });
        };
        // Bind as early as possible to catch join backlog, then retry.
        tryBind();
        window.addEventListener('load', () => { tryBind(); setTimeout(tryBind, 2000); });
        const poll = setInterval(() => { tryBind(); if (bound) clearInterval(poll); }, 250);
        setTimeout(() => clearInterval(poll), 10000);
    }

    /* ==========================================================
       TRIVIA CARD
    ========================================================== */

    function _escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    let _triviaOutsideClick = null;

    function showTriviaCard() {
        if (!_currentImdbId) return;
        hideTriviaCard(); // clears any existing panel + listener
        const panel = document.createElement('div');
        panel.id = 'sc-trivia-panel';
        panel.innerHTML = `
            <div id="sc-trivia-head">
                <span id="sc-trivia-title">${_escHtml(_npData && _npData.cleanTitle ? _npData.cleanTitle + ' — Trivia' : 'Trivia')}</span>
                <button id="sc-trivia-close" type="button">✕</button>
            </div>
            <div id="sc-trivia-list"><div class="sc-trivia-item">Loading…</div></div>`;
        document.body.appendChild(panel);
        panel.querySelector('#sc-trivia-close').addEventListener('click', hideTriviaCard);

        _triviaOutsideClick = (e) => {
            const btn = document.getElementById('sc-trivia-btn');
            if (!panel.contains(e.target) && e.target !== btn) hideTriviaCard();
        };
        setTimeout(() => document.addEventListener('click', _triviaOutsideClick, true), 0);

        fetchImdbTrivia(_currentImdbId).then(items => {
            const list = panel.querySelector('#sc-trivia-list');
            if (!list) return;
            if (!items || !items.length) { list.innerHTML = '<div class="sc-trivia-item">No trivia found.</div>'; return; }
            list.innerHTML = items.map(t => `<div class="sc-trivia-item">${_escHtml(t)}</div>`).join('');
            list.scrollTop = 0;
        });
    }

    function hideTriviaCard() {
        const p = document.getElementById('sc-trivia-panel');
        if (p) p.remove();
        if (_triviaOutsideClick) {
            document.removeEventListener('click', _triviaOutsideClick, true);
            _triviaOutsideClick = null;
        }
    }

    function toggleTriviaPanel() {
        if (document.getElementById('sc-trivia-panel')) hideTriviaCard();
        else showTriviaCard();
    }

    // 'T' = trivia, 'I' = movie info card — from anywhere when not typing
    document.addEventListener('keydown', (e) => {
        const t = e.target;
        if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
        if (e.key === 't' || e.key === 'T') { toggleTriviaPanel(); return; }
        if (e.key === 'Escape') { hideTriviaCard(); hideNowPlayingCard(); hideLineupScreen(); return; }
        if (e.key === 'i' || e.key === 'I') {
            const card = document.getElementById('sc-np-card');
            if (card && card.classList.contains('sc-np-visible')) hideNowPlayingCard();
            else if (_npData) showNowPlayingCard(_npData, { autoHide: false });
        }
    });

    /* ==========================================================
       USER COLOR SYSTEM
    ========================================================== */

    function hashString(str) {
        let h = 5381;
        for (let i = 0; i < str.length; i++) { h = ((h << 5) + h) ^ str.charCodeAt(i); h |= 0; }
        return Math.abs(h);
    }
    function usernameToColor(u) {
        // Own username gets a fixed standout colour rather than the hash.
        if (window.CLIENT && window.CLIENT.name && u === window.CLIENT.name) {
            return 'hsl(197, 90%, 78%)'; // baby blue
        }
        // Golden angle multiplication spreads hues maximally apart so
        // no two nearby hash values share a similar colour.
        const hue = (hashString(u) * 137.508) % 360;
        return `hsl(${hue.toFixed(1)}, 72%, 70%)`;
    }
    function applyUserColors() {
        document.querySelectorAll('#messagebuffer [class*="chat-msg-"]').forEach(el => {
            const cls = [...el.classList].find(c => c.startsWith('chat-msg-'));
            if (!cls) return;
            const span = el.querySelector('.username');
            if (span) { span.style.color = usernameToColor(cls.replace('chat-msg-', '')); span.style.fontWeight = '700'; }
        });
    }
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
       First-run: shown automatically if TMDB key is absent.
       Re-openable via the ⚙ button added to the floating buttons.
    ========================================================== */

    async function validateTmdbKey(key) {
        try {
            const res = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: `https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(key)}`,
                    onload: r => resolve(r),
                    onerror: reject,
                });
            });
            if (res.status === 200) return 'valid';
            if (res.status === 401) return 'invalid';
            return 'error';
        } catch (e) { return 'error'; }
    }

    async function validateImgbbKey(apiKey) {
        // ImgBB has no key-check endpoint, so probe with a tiny 1x1 PNG upload.
        const onePx = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
        try {
            const res = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    // expiration=60 so the throwaway test image self-deletes.
                    url: 'https://api.imgbb.com/1/upload?expiration=60&key=' + encodeURIComponent(apiKey),
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    data: 'image=' + encodeURIComponent(onePx),
                    onload: r => resolve(r),
                    onerror: reject,
                });
            });
            if (res.status >= 200 && res.status < 300) return 'valid';
            if (res.status === 400 || res.status === 403) return 'invalid';
            return 'error';
        } catch (e) { return 'error'; }
    }

    function openSettingsModal() {
        const old = document.getElementById('sc-settings-overlay');
        if (old) old.remove();

        const tmdbVal  = getKey(LS_TMDB);
        const imgbbVal = getKey(LS_IMGBB);
        const firstRun = !localStorage.getItem('sc_onboarded');
        try { localStorage.setItem('sc_onboarded', '1'); } catch (e) {}
        const fontSize = getChatFontSize();

        const overlay = document.createElement('div');
        overlay.id = 'sc-settings-overlay';
        overlay.innerHTML = `
            <div id="sc-settings-modal">
                <div id="sc-settings-title">⚙ Grindhouse Settings</div>
                ${firstRun ? '<div class="sc-settings-intro">First-time setup — everything here is optional. Enable TMDB for richer movie info. Reopen any time with the ⚙ button.</div>' : ''}

                <div class="sc-settings-group sc-settings-divider">
                    <label class="sc-settings-toggle-label">
                        <span class="sc-toggle-row">
                            <input type="checkbox" id="sc-input-tmdb-enable" ${tmdbVal ? 'checked' : ''} />
                            <span class="sc-toggle-text">Enable TMDB features</span>
                        </span>
                        <span class="sc-settings-note">Movie posters, ratings, runtime, IMDb/Letterboxd links, trivia</span>
                    </label>
                    <div id="sc-tmdb-fields" class="${tmdbVal ? '' : 'sc-hidden'}">
                        <div class="sc-settings-input-row">
                            <input id="sc-input-tmdb" class="sc-settings-input" type="text"
                                placeholder="Paste TMDB v3 key…" value="${tmdbVal}" spellcheck="false" />
                            <button id="sc-test-tmdb" class="sc-settings-test" type="button">Test</button>
                        </div>
                        <span id="sc-test-tmdb-status" class="sc-settings-test-status"></span>
                        <a class="sc-settings-link" href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">
                            Get a free TMDB key ↗
                        </a>
                    </div>
                </div>

                <div class="sc-settings-group sc-settings-toggle-group">
                    <label class="sc-settings-toggle-label">
                        <span class="sc-toggle-row">
                            <input type="checkbox" id="sc-input-spellcheck" ${spellCheckEnabled() ? 'checked' : ''} />
                            <span class="sc-toggle-text">Grammar &amp; spell check popup</span>
                        </span>
                        <span class="sc-settings-note">When off, messages send immediately without review</span>
                    </label>
                </div>

                <div class="sc-settings-group sc-settings-toggle-group">
                    <label class="sc-settings-toggle-label">
                        <span class="sc-toggle-row">
                            <input type="checkbox" id="sc-input-movielinks" ${movieLinksEnabled() ? 'checked' : ''} />
                            <span class="sc-toggle-text">Show movie links (IMDb / Letterboxd / Wiki)</span>
                        </span>
                        <span class="sc-settings-note">Adds clickable badge icons next to the title</span>
                    </label>
                </div>

                <div class="sc-settings-group sc-settings-divider">
                    <label class="sc-settings-label">
                        ImgBB GIF upload
                        <span class="sc-settings-note">Optional — lets the ☁ Upload button in the GIF maker host a GIF and give you a shareable link</span>
                    </label>
                    <div class="sc-settings-input-row">
                        <input id="sc-input-imgbb" class="sc-settings-input" type="text"
                            placeholder="Paste ImgBB API key…" value="${imgbbVal}" spellcheck="false" />
                        <button id="sc-test-imgbb" class="sc-settings-test" type="button">Test</button>
                    </div>
                    <span id="sc-test-imgbb-status" class="sc-settings-test-status"></span>
                    <a class="sc-settings-link" href="https://api.imgbb.com/" target="_blank" rel="noopener">
                        Get a free ImgBB API key ↗ (sign up, then "Add API key" — no app registration)
                    </a>
                </div>

                <div class="sc-settings-group sc-settings-toggle-group">
                    <label class="sc-settings-label">
                        Chat font size: <span id="sc-font-val">${fontSize}px</span>
                        <span class="sc-settings-note">Applies to message buffer and chat input</span>
                    </label>
                    <input id="sc-input-fontsize" class="sc-settings-range" type="range" min="10" max="32" value="${fontSize}" />
                    <div class="sc-font-sample" id="sc-font-sample" style="font-size:${fontSize}px">
                        The quick brown fox jumps over the lazy dog.
                    </div>
                </div>

                <div id="sc-settings-actions">
                    <button id="sc-settings-cancel">Cancel</button>
                    <button id="sc-settings-save">Save</button>
                </div>
                <div id="sc-settings-status"></div>
            </div>`;

        document.body.appendChild(overlay);
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
        document.getElementById('sc-settings-cancel').addEventListener('click', () => overlay.remove());

        // TMDB toggle shows/hides key fields
        const tmdbToggle = document.getElementById('sc-input-tmdb-enable');
        const tmdbFields = document.getElementById('sc-tmdb-fields');
        tmdbToggle.addEventListener('change', () => tmdbFields.classList.toggle('sc-hidden', !tmdbToggle.checked));

        // Font size live preview
        const fontInput  = document.getElementById('sc-input-fontsize');
        const fontVal    = document.getElementById('sc-font-val');
        const fontSample = document.getElementById('sc-font-sample');
        fontInput.addEventListener('input', () => {
            const px = parseInt(fontInput.value, 10);
            fontVal.textContent = px + 'px';
            fontSample.style.fontSize = px + 'px';
            applyChatFontSize(px);
        });

        // TMDB test button
        const testBtn    = document.getElementById('sc-test-tmdb');
        const testStatus = document.getElementById('sc-test-tmdb-status');
        testBtn.addEventListener('click', async () => {
            const key = document.getElementById('sc-input-tmdb').value.trim();
            if (!key) { testStatus.textContent = 'Enter a key first'; testStatus.className = 'sc-settings-test-status sc-test-bad'; return; }
            testBtn.disabled = true;
            testStatus.textContent = 'Checking…'; testStatus.className = 'sc-settings-test-status sc-test-pending';
            const result = await validateTmdbKey(key);
            testBtn.disabled = false;
            if (result === 'valid')        { testStatus.textContent = '✓ Valid key';           testStatus.className = 'sc-settings-test-status sc-test-ok'; }
            else if (result === 'invalid') { testStatus.textContent = '✗ Invalid key';         testStatus.className = 'sc-settings-test-status sc-test-bad'; }
            else                           { testStatus.textContent = '⚠ Couldn\'t reach API'; testStatus.className = 'sc-settings-test-status sc-test-bad'; }
        });

        // ImgBB API key test button
        const imgbbTestBtn    = document.getElementById('sc-test-imgbb');
        const imgbbTestStatus = document.getElementById('sc-test-imgbb-status');
        imgbbTestBtn.addEventListener('click', async () => {
            const id = document.getElementById('sc-input-imgbb').value.trim();
            if (!id) { imgbbTestStatus.textContent = 'Enter an API key first'; imgbbTestStatus.className = 'sc-settings-test-status sc-test-bad'; return; }
            imgbbTestBtn.disabled = true;
            imgbbTestStatus.textContent = 'Checking…'; imgbbTestStatus.className = 'sc-settings-test-status sc-test-pending';
            const result = await validateImgbbKey(id);
            imgbbTestBtn.disabled = false;
            if (result === 'valid')        { imgbbTestStatus.textContent = '✓ Valid API key';        imgbbTestStatus.className = 'sc-settings-test-status sc-test-ok'; }
            else if (result === 'invalid') { imgbbTestStatus.textContent = '✗ Invalid API key';      imgbbTestStatus.className = 'sc-settings-test-status sc-test-bad'; }
            else                           { imgbbTestStatus.textContent = '⚠ Couldn\'t reach ImgBB'; imgbbTestStatus.className = 'sc-settings-test-status sc-test-bad'; }
        });

        document.getElementById('sc-settings-save').addEventListener('click', () => {
            const tmdb   = tmdbToggle.checked ? document.getElementById('sc-input-tmdb').value.trim() : '';
            const spell  = document.getElementById('sc-input-spellcheck').checked;
            const links  = document.getElementById('sc-input-movielinks').checked;
            const imgbb  = document.getElementById('sc-input-imgbb').value.trim();
            const fontPx = parseInt(fontInput.value, 10);
            setKey(LS_TMDB,        tmdb);
            setKey(LS_SPELLCHECK,  spell ? 'on' : 'off');
            setKey(LS_MOVIE_LINKS, links ? 'on' : 'off');
            setKey(LS_IMGBB,       imgbb);
            setKey(LS_CHAT_FONT,   String(fontPx));
            applyChatFontSize(fontPx);
            movieLinkCache = {};
            try { localStorage.removeItem(LS_MOVIE_CACHE); } catch (e) {}
            lastMovieTitle = '';
            triggerTitleInject();
            const status = document.getElementById('sc-settings-status');
            if (status) status.textContent = '✓ Saved';
            setTimeout(() => overlay.remove(), 800);
        });
    }

    function addSettingsButton() {
        if (document.getElementById('sc-settings-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'sc-settings-btn';
        btn.textContent = '⚙';
        btn.title = 'Script Settings (API keys)';
        btn.addEventListener('click', openSettingsModal);
        document.body.appendChild(btn);
    }

    /* ==========================================================
       TONIGHT'S LINEUP -- Reddit schedule fetch + parse.
       r/420Grindhouse's Atom feed (https://www.reddit.com/r/420Grindhouse/.rss) is
       reachable with a browser UA and no login (the .json endpoints 403 the same
       way generic bots get blocked elsewhere; .rss doesn't). The pinned schedule
       post sorts FIRST in the feed regardless of nominal sort order -- "find this
       week's post" is just "take entry #1", no slug/title matching needed.

       The post body is a fixed markdown->HTML shape: an intro paragraph, then
       repeating <p><strong>Day</strong></p> headers (Friday/Saturday/Sunday, a
       closed 3-name set) each followed by 2-4 <p><strong>Section Name</strong>
       </p> + <ul><li>Title (Year)</li>...</ul> pairs. Two independent layers of
       HTML-entity escaping are present: the Atom feed XML-escapes the whole
       content blob, and Reddit's own markdown renderer separately entity-encodes
       special characters (apostrophes, etc.) within it -- lineupDecodeHtmlEntities
       is applied once, up front, so everything downstream works on plain text/tags.
       Ported from the Android Grindhouse app's web/src/lineup/{reddit,timing}.js.
    ========================================================== */

    const LINEUP_FEED_URL = 'https://www.reddit.com/r/420Grindhouse/.rss';
    const LINEUP_DAY_NAMES = ['Friday', 'Saturday', 'Sunday'];

    function lineupSlugify(name) {
        return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    }

    function lineupDecodeHtmlEntities(s) {
        return s
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
            .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
            .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
    }

    // The first <entry> in the feed is the pinned post. Returns null if the feed has
    // no entries or is missing a required field.
    function lineupParseFirstEntry(feedXml) {
        const start = feedXml.indexOf('<entry>');
        if (start === -1) return null;
        const end = feedXml.indexOf('</entry>', start);
        if (end === -1) return null;
        const entry = feedXml.slice(start, end + '</entry>'.length);
        const idM = entry.match(/<id>([^<]+)<\/id>/);
        const titleM = entry.match(/<title>([^<]+)<\/title>/);
        const contentM = entry.match(/<content type="html">([\s\S]*?)<\/content>/);
        if (!idM || !titleM || !contentM) return null;
        const pubM = entry.match(/<published>([^<]+)<\/published>/);
        return {
            postId: idM[1],
            title: lineupDecodeHtmlEntities(titleM[1]),
            publishedAt: pubM ? pubM[1] : null,
            contentHtml: lineupDecodeHtmlEntities(contentM[1]),
        };
    }

    // Parses "Weekend Grindhouse Schedule - Fri 7/10 - Sun 7/12" into real calendar
    // dates. Only Friday's month/day is read from the title -- Saturday and Sunday are
    // always +1/+2 days from Friday. The year comes from the post's own publishedAt
    // timestamp, not system "now" -- except a December post for a January weekend,
    // where the weekend is next year.
    function lineupParseDateRange(title, publishedAt) {
        const m = title && title.match(/Fri\D*(\d{1,2})\/(\d{1,2})/i);
        if (!m || !publishedAt) return null;
        const pub = new Date(publishedAt);
        if (isNaN(pub.getTime())) return null;
        const friMonth = parseInt(m[1], 10), friDay = parseInt(m[2], 10);
        const pubMonth = pub.getMonth() + 1;
        const year = (pubMonth === 12 && friMonth === 1) ? pub.getFullYear() + 1 : pub.getFullYear();
        const fri = Date.UTC(year, friMonth - 1, friDay);
        const toStr = (ms) => new Date(ms).toISOString().slice(0, 10);
        return { fri: toStr(fri), sat: toStr(fri + 86400000), sun: toStr(fri + 2 * 86400000) };
    }

    // Each <li> is "Title (Year)", sometimes with a leading bold label or trailing
    // "aka Other Title" name(s). The primary (title, year) pair drives the TMDB lookup;
    // akas become extra MATCH aliases (the stream sometimes plays a film under the
    // file's aka name); `display` keeps the full original text.
    function lineupParseListItems(ulInnerHtml) {
        const items = [];
        const liRe = /<li>([\s\S]*?)<\/li>/g;
        let lm;
        while ((lm = liRe.exec(ulInnerHtml))) {
            const display = lm[1].replace(/<strong>[^<]*<\/strong>\s*/, '').replace(/<[^>]+>/g, '').trim();
            const [primary, ...akaParts] = display.split(/\s+aka\s+/i);
            const ym = primary.trim().match(/^(.*)\s\((\d{4})\)$/);
            if (!ym) continue;
            const akas = akaParts
                .map(a => a.replace(/\s*\(\d{4}\)\s*$/, '').trim())
                .filter(Boolean);
            items.push({ title: ym[1].trim(), year: ym[2], display, akas });
        }
        return items;
    }

    // Case-insensitive "is this schedule item the film called `title`?" -- checks the
    // primary title and every post-provided aka. Tolerates cached schedules written
    // before akas existed (no `akas` field).
    function lineupItemMatchesTitle(item, title) {
        const t = (title || '').toLowerCase();
        if (item.title.toLowerCase() === t) return true;
        return (item.akas || []).some(a => a.toLowerCase() === t);
    }

    // Walks the post body in document order, assigning each <ul> of films to the most
    // recently seen section name, and each section to the most recently seen day.
    function lineupParseSchedule(contentHtml) {
        const days = [];
        let currentDay = null;
        let pendingSectionName = null;
        const re = /<strong>([^<]*)<\/strong>|<ul>([\s\S]*?)<\/ul>/g;
        let m;
        while ((m = re.exec(contentHtml))) {
            if (m[1] !== undefined) {
                const text = m[1].trim();
                if (LINEUP_DAY_NAMES.includes(text)) {
                    currentDay = { day: text, sections: [] };
                    days.push(currentDay);
                    pendingSectionName = null;
                } else {
                    pendingSectionName = text;
                }
            } else if (currentDay && pendingSectionName) {
                const items = lineupParseListItems(m[2]);
                if (items.length) currentDay.sections.push({ name: pendingSectionName, slug: lineupSlugify(pendingSectionName), items });
                pendingSectionName = null;
            }
        }
        return days;
    }

    function lineupGmFetch(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
                onload: resolve,
                onerror: reject,
            });
        });
    }

    // Fetches and fully parses the current schedule post. Throws on any failure
    // (network, missing entry, unparseable date range, zero days/sections parsed) --
    // the caller (lineupEnsureSchedule, Task 3) catches this and falls back to the
    // Now/Next-only view built from live changeMedia data.
    async function fetchTonightsSchedule() {
        const res = await lineupGmFetch(LINEUP_FEED_URL);
        if (!res || res.status !== 200) throw new Error('Reddit feed HTTP ' + (res && res.status));
        const entry = lineupParseFirstEntry(res.responseText);
        if (!entry) throw new Error('no entries found in feed');
        const dateRange = lineupParseDateRange(entry.title, entry.publishedAt);
        if (!dateRange) throw new Error('could not parse weekend date range from title: ' + entry.title);
        const days = lineupParseSchedule(entry.contentHtml);
        if (!days.length) throw new Error('no days parsed from schedule post');
        const dateByDay = { Friday: dateRange.fri, Saturday: dateRange.sat, Sunday: dateRange.sun };
        return {
            postId: entry.postId,
            title: entry.title,
            publishedAt: entry.publishedAt,
            days: days.map(d => ({ ...d, date: dateByDay[d.day] || null })),
        };
    }

    /* ==========================================================
       TONIGHT'S LINEUP -- timing/ETA model.
       Precision decays honestly the further out an estimate is: 'exact' (current
       feature's remaining runtime + one learned bumper gap), 'approx' (further out,
       compounding uncertainty), 'late' (tail of the night -- running order only).
    ========================================================== */

    function lineupFormatEta(hour24, minute, precision) {
        if (precision === 'late') return 'LATE';
        const period = hour24 >= 12 ? 'PM' : 'AM';
        let h = hour24 % 12;
        if (h === 0) h = 12;
        const mm = String(minute).padStart(2, '0');
        const prefix = precision === 'approx' ? '~' : '≈';
        return `${prefix} ${h}:${mm} ${period}`;
    }

    // Running median of observed bumper-gap durations (seconds) between features.
    function lineupMedianGapSeconds(observedGaps) {
        if (!observedGaps.length) return null;
        const sorted = [...observedGaps].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    // Friendly display rounding for an ETA instant: these are guesses, so don't show
    // oddly-specific minutes. 'approx' floors to the previous quarter-hour (4:39 -> 4:30);
    // 'exact' has a real live anchor behind it, so it only snaps to the nearest 5 minutes.
    // A displayed time must never already be in the past (it reads as broken -- e.g. a long
    // bumper block pushed the walk behind the clock), so anything that rounds to before
    // `nowMs` clamps up to the next grid point at-or-after now instead. Epoch flooring lands
    // on local :00/:15/:30/:45 because real UTC offsets are 15-min multiples.
    function lineupRoundEtaMs(etaMs, precision, nowMs) {
        const grid = precision === 'exact' ? 5 * 60000 : 15 * 60000;
        const round = precision === 'exact' ? Math.round : Math.floor;
        const rounded = round(etaMs / grid) * grid;
        if (nowMs != null && rounded < nowMs) return Math.ceil(nowMs / grid) * grid;
        return rounded;
    }

    const LINEUP_MAX_ESTIMATED_AHEAD = 4; // live-anchored: how many upcoming films past "now" get ETAs
    const LINEUP_MAX_PRE_SHOW = 3;        // projection-only: how many films get a "starts around then" guess

    // Per-film played/now-playing/ETA model for one day of the lineup. Pure -- every
    // input is a number/array so the whole branch tree is easy to reason about without
    // the socket/DOM state the data layer feeds it from. Returns one entry per film
    // (same order): { played, isNowPlaying, etaMs: epoch-ms | null, precision: 'exact' | 'approx' }
    // Estimates degrade honestly by evidence quality: a confirmed now-playing film gives
    // the next film an 'exact' ETA; a bumper anchor or the noon-Pacific clock projection
    // only ever supports 'approx'.
    function lineupEstimateDayItems({
        nowMs, anchorMs, runtimesMin, gapSeconds, dayStatus,
        currentIndex, remainingSec, furthestPlayedIndex, bumperStartMs,
    }) {
        const gapMs = gapSeconds * 1000;
        const runtimeMs = (i) => (runtimesMin[i] ? runtimesMin[i] * 60000 : 0);
        const blank = { played: false, isNowPlaying: false, etaMs: null, precision: 'approx' };

        if (dayStatus === 'past') {
            return runtimesMin.map(() => ({ ...blank, played: true }));
        }

        // Clock projection from the noon anchor: each film's start/end if the night ran
        // exactly to schedule. Used for future days, today's pre-show, and joined-late.
        const projected = [];
        let cursor = anchorMs;
        runtimesMin.forEach((_, i) => {
            projected.push({ startMs: cursor, endMs: cursor + runtimeMs(i) });
            cursor += runtimeMs(i) + gapMs;
        });

        if (dayStatus === 'today' && currentIndex >= 0) {
            // Live anchor: walk forward from the current film's remaining runtime.
            let cumulative = Math.max(0, remainingSec) * 1000;
            return runtimesMin.map((_, idx) => {
                if (idx === currentIndex) return { ...blank, isNowPlaying: true };
                if (idx < currentIndex || idx <= furthestPlayedIndex) return { ...blank, played: true };
                const offset = idx - currentIndex;
                cumulative += gapMs;
                const withEta = offset <= LINEUP_MAX_ESTIMATED_AHEAD
                    ? { ...blank, etaMs: nowMs + cumulative, precision: offset === 1 ? 'exact' : 'approx' }
                    : { ...blank };
                cumulative += runtimeMs(idx);
                return withEta;
            });
        }

        if (dayStatus === 'today' && furthestPlayedIndex >= 0) {
            // Bumper between films (or a title we failed to match): the furthest observed
            // film has finished; keep estimating from when the unmatched item started.
            let cumulative = (bumperStartMs != null ? bumperStartMs : nowMs) + gapMs;
            return runtimesMin.map((_, idx) => {
                if (idx <= furthestPlayedIndex) return { ...blank, played: true };
                const offset = idx - furthestPlayedIndex;
                const withEta = offset <= LINEUP_MAX_ESTIMATED_AHEAD ? { ...blank, etaMs: cumulative } : { ...blank };
                cumulative += runtimeMs(idx) + gapMs;
                return withEta;
            });
        }

        // No observation at all: future day, today's pre-show, or joined-late today.
        // Gray by projected end; guess starts for the next LINEUP_MAX_PRE_SHOW unstarted
        // films. A film straddling `now` is left unmarked -- probably playing, unconfirmed.
        let guesses = 0;
        return runtimesMin.map((_, idx) => {
            const p = projected[idx];
            if (dayStatus === 'today') {
                if (p.endMs < nowMs) return { ...blank, played: true };
                if (p.startMs <= nowMs) return { ...blank };
            }
            if (guesses < LINEUP_MAX_PRE_SHOW) {
                guesses++;
                return { ...blank, etaMs: p.startMs };
            }
            return { ...blank };
        });
    }

    // Pacific-timezone offset (minutes) of the UTC instant `d`. Noon is never within a
    // couple hours of a DST transition (those happen at 2am local), so a single
    // read-back is safe -- no iteration needed.
    function lineupPacificOffsetMinutes(d) {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Los_Angeles', hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).formatToParts(d);
        const get = (t) => parts.find(p => p.type === t).value;
        const hour = parseInt(get('hour'), 10) % 24;
        const asUTC = Date.UTC(+get('year'), +get('month') - 1, +get('day'), hour, +get('minute'), +get('second'));
        return (asUTC - d.getTime()) / 60000;
    }

    // The UTC instant that is Noon Pacific on the given 'YYYY-MM-DD' calendar date --
    // the per-day showtime anchor, used as the walk-forward start point for whichever
    // day is selected, not just Friday.
    function lineupDayAnchorPacific(dateStr) {
        const [y, m, d] = dateStr.split('-').map(Number);
        const guess = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
        const offsetMinutes = lineupPacificOffsetMinutes(guess);
        return new Date(guess.getTime() - offsetMinutes * 60000);
    }

    // Today's Pacific calendar date as 'YYYY-MM-DD' -- used to pick the default day
    // tab (isToday) and to decide whether "now playing" should even be searched for.
    function lineupPacificDateString(now = new Date()) {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(now);
        const get = (t) => parts.find(p => p.type === t).value;
        return `${get('year')}-${get('month')}-${get('day')}`;
    }

    // True once a cached schedule's own weekend has fully elapsed. The pinned Reddit post
    // always describes the upcoming Fri-Sun, so once Sunday's date is in the past there is
    // definitely a newer post live -- a harder, date-driven signal than a fetch-age timer,
    // used by lineupEnsureSchedule to guarantee a rolled-over post gets picked up rather
    // than relying on however long it's been since the last fetch.
    function lineupScheduleExpired(sched, todayStr = lineupPacificDateString()) {
        const lastDate = sched.days.reduce((max, d) => (d.date && d.date > max ? d.date : max), '');
        return !lastDate || todayStr > lastDate;
    }

    /* ==========================================================
       TONIGHT'S LINEUP -- per-section font + color theme.
       Each of the 9 recurring section names (a slow-changing, closed set) gets its
       own Google Font + accent color, tying a grouping's header and its background
       wash together. Fonts are loaded once via a single combined Google Fonts CSS2
       request. Ported from the Android app's web/src/lineup/sectionThemes.js.
    ========================================================== */

    const LINEUP_THEMES = {
        'funky-cheese-friday':          { font: 'Boogaloo',           color: '#e0a92a', wash: '#2b210a' },
        'friday-grindhouse-a-go-go':    { font: 'Chewy',               color: '#ec4899', wash: '#2a0e1c' },
        'friday-night-freak-show':      { font: 'Creepster',           color: '#52c41a', wash: '#0f2109' },
        'psychedelic-saturday':         { font: "'Rubik Wet Paint'",   color: '#a855f7', wash: '#200c2b' },
        'saturday-prime-time-drive-in': { font: 'Monoton',             color: '#22d3ee', wash: '#06232a' },
        'red-light-saturday-night':     { font: "'Vast Shadow'",       color: '#ef4444', wash: '#2b0a0a' },
        'the-sunday-classics':          { font: 'Cinzel',              color: '#b8b8b8', wash: '#1c1c1c' },
        'sunday-slop-o-rama':           { font: 'Eater',               color: '#a3b125', wash: '#1c1f08' },
        'last-call-sunday-night':       { font: "'Bungee Shade'",      color: '#6366f1', wash: '#12102b' },
    };
    // Any future/unrecognized section name falls back to the script's normal font and
    // a neutral wash, rather than an unstyled or broken-looking block.
    const LINEUP_DEFAULT_THEME = { font: null, color: '#9aa0a8', wash: '#14141a' };

    function getSectionTheme(slug) {
        return LINEUP_THEMES[slug] || LINEUP_DEFAULT_THEME;
    }

    const LINEUP_FONT_FAMILIES = ['Boogaloo', 'Chewy', 'Creepster', 'Rubik+Wet+Paint', 'Monoton', 'Vast+Shadow', 'Cinzel', 'Eater', 'Bungee+Shade'];
    const LINEUP_FONTS_LINK_ID = 'sc-lineup-theme-fonts';

    // Idempotent -- safe to call on every showLineupScreen(); only injects the <link>
    // once per page load (checked by id).
    function lineupEnsureThemeFontsLoaded() {
        if (document.getElementById(LINEUP_FONTS_LINK_ID)) return;
        const link = document.createElement('link');
        link.id = LINEUP_FONTS_LINK_ID;
        link.rel = 'stylesheet';
        link.href = `https://fonts.googleapis.com/css2?${LINEUP_FONT_FAMILIES.map(f => `family=${f}`).join('&')}&display=swap`;
        document.head.appendChild(link);
    }

    /* ==========================================================
       TONIGHT'S LINEUP -- data interface consumed by the lineup screen (below).
       Fetches + caches the Reddit schedule post, persisted to localStorage and
       re-checked every time the lineup screen opens: a background revalidate past
       LINEUP_CACHE_MAX_AGE_MS, or an awaited one once the cached weekend's own dates
       are in the past (lineupScheduleExpired) -- the latter guarantees a new pinned
       post gets picked up even if this tab has sat open since before it rolled over.
       Locates "now" within TODAY's day only, and feeds the pure timing model
       (lineupEstimateDayItems above) each day's TMDB runtimes, the learned median
       bumper-gap, the confirmed now-playing film, and the persisted furthest-played
       marker -- yielding per-film ETAs (live-anchored, bumper-anchored, or projected
       from that day's Noon-Pacific showtime start) plus a played flag that grays
       already-shown posters. Falls back to the current title plus the static
       admin-curated MOTD poster art if the fetch fails and no usable cache exists.
       Ported from the Android app's web/src/lineup/data.js.
    ========================================================== */

    const LS_LINEUP_CACHE = 'sc_lineup_cache_v1';
    const LS_LINEUP_PROGRESS = 'sc_lineup_progress_v1'; // furthest film observed playing today
    const LINEUP_CACHE_MAX_AGE_MS = 20 * 60 * 60 * 1000; // background-revalidate if older than this
    const LINEUP_FALLBACK_TITLE = 'Coming Attractions';
    const LINEUP_PROGRESS_CONFIRM_MS = 5 * 60 * 1000; // a match this brief was a queue jump, not a showing

    let _lineupScheduleCache = null;     // {postId, title, publishedAt, days, fetchedAt} or null
    let _lineupFetchFailed = false;      // sticky for the session once Reddit is unreachable AND no cache at all
    let _lineupRevalidating = false;
    let _lineupObservedGaps = [];        // durations (s) of unmatched blocks between scheduled features
    let _lineupLastUnmatchedStart = null; // Date.now() when the current unmatched (bumper) BLOCK started
    let _lineupPendingProgress = null;   // {idx, since} -- a matched film not yet current long enough to count as played

    function lineupReadCache() {
        try {
            const raw = localStorage.getItem(LS_LINEUP_CACHE);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }
    function lineupWriteCache(schedule) {
        try { localStorage.setItem(LS_LINEUP_CACHE, JSON.stringify({ ...schedule, fetchedAt: Date.now() })); }
        catch (e) { /* storage full/unavailable -- in-memory cache for this session still works */ }
    }

    function lineupAllScheduleTitles(sched = _lineupScheduleCache) {
        if (!sched) return [];
        return sched.days.flatMap(d => d.sections.flatMap(s => s.items));
    }

    // Furthest flat index within TODAY's day ever observed playing, persisted so grayed
    // "already played" posters survive a page reload mid-night. Self-resets when the
    // stored Pacific date isn't today's.
    function lineupReadProgress() {
        try {
            const p = JSON.parse(localStorage.getItem(LS_LINEUP_PROGRESS));
            return p && p.date === lineupPacificDateString() && p.furthestIndex >= 0 ? p.furthestIndex : -1;
        } catch (e) { return -1; }
    }
    function lineupWriteProgress(furthestIndex) {
        try { localStorage.setItem(LS_LINEUP_PROGRESS, JSON.stringify({ date: lineupPacificDateString(), furthestIndex })); }
        catch (e) { /* storage full/unavailable -- graying just degrades to clock projection */ }
    }

    // If a matched film has now been current long enough to be a real showing (not a
    // momentary queue jump), commit it to the persisted marker. Called when the next
    // title change arrives AND from lineupBuildDaySections, so a still-playing film
    // past the threshold counts even before it ends.
    function lineupCommitConfirmedProgress() {
        if (!_lineupPendingProgress) return;
        if (Date.now() - _lineupPendingProgress.since >= LINEUP_PROGRESS_CONFIRM_MS) {
            if (_lineupPendingProgress.idx > lineupReadProgress()) lineupWriteProgress(_lineupPendingProgress.idx);
            _lineupPendingProgress = null;
        }
    }

    // Learn bumper-gap duration live: the time from the FIRST unmatched title change after
    // a feature to the next matched one is one observed gap sample -- the whole bumper
    // block, not just its last item (resetting per-item makes the median absurdly small on
    // multi-bumper blocks). Matched titles in TODAY's day also advance the persisted
    // played-progress marker, via the confirm-delay above. Called from injectMovieLinks
    // (Step 2 below) with the same deduped rawTitle that function already tracks in
    // lastMovieTitle, reading the localStorage cache directly if the schedule hasn't been
    // loaded into memory yet (without assigning _lineupScheduleCache, which stays
    // lineupEnsureSchedule's job so revalidation still happens).
    function lineupObserveTitleChange(rawTitle) {
        const title = rawTitle ? parseMovieFilename(rawTitle).title : null;
        const sched = _lineupScheduleCache || lineupReadCache();
        const matchesSchedule = !!(title && sched &&
            lineupAllScheduleTitles(sched).some(s => lineupItemMatchesTitle(s, title)));
        if (rawTitle && !matchesSchedule && sched) {
            if (!_lineupLastUnmatchedStart) _lineupLastUnmatchedStart = Date.now();
        } else if (_lineupLastUnmatchedStart) {
            _lineupObservedGaps.push((Date.now() - _lineupLastUnmatchedStart) / 1000);
            _lineupLastUnmatchedStart = null;
        }
        lineupCommitConfirmedProgress();
        _lineupPendingProgress = null; // whatever was pending either just committed or was a jump
        if (matchesSchedule) {
            const today = sched.days.find(day => day.date === lineupPacificDateString());
            const flatItems = today ? today.sections.flatMap(s => s.items) : [];
            const idx = flatItems.findIndex(s => lineupItemMatchesTitle(s, title));
            if (idx !== -1 && idx > lineupReadProgress()) _lineupPendingProgress = { idx, since: Date.now() };
        }
    }

    async function lineupRefetchAndCache() {
        if (_lineupRevalidating) return;
        _lineupRevalidating = true;
        try {
            const result = await fetchTonightsSchedule();
            _lineupScheduleCache = result;
            lineupWriteCache(result);
        } catch (e) {
            // Keep whatever we already had -- a failed background revalidation is
            // silent; _lineupFetchFailed only matters when we have nothing at all.
        } finally {
            _lineupRevalidating = false;
        }
    }

    // Populates the in-memory cache from localStorage on the first call, but unlike a
    // once-only check, THIS FUNCTION RUNS AGAIN every time the lineup screen is opened --
    // a userscript's page can sit open for days without a reload, so a one-time-only check
    // here would mean the schedule, once loaded, is NEVER re-fetched again for the rest of
    // that session even after the pinned post rolls over.
    async function lineupEnsureSchedule() {
        if (!_lineupScheduleCache && !_lineupFetchFailed) {
            const cached = lineupReadCache();
            if (cached) _lineupScheduleCache = cached;
        }
        if (_lineupScheduleCache) {
            if (lineupScheduleExpired(_lineupScheduleCache)) {
                await lineupRefetchAndCache(); // the cached weekend is over -- there IS a new post, wait for it
            } else if (Date.now() - (_lineupScheduleCache.fetchedAt || 0) > LINEUP_CACHE_MAX_AGE_MS) {
                lineupRefetchAndCache(); // just routine revalidation (e.g. a same-weekend post edit) -- fire-and-forget
            }
            return;
        }
        if (_lineupFetchFailed) return;
        try {
            const result = await fetchTonightsSchedule();
            _lineupScheduleCache = result;
            lineupWriteCache(result);
        } catch (e) {
            _lineupFetchFailed = true;
        }
    }

    // Poster images in the MOTD are 125x175 -- keep portrait-ish images, skip wide
    // banners. Used both by the fallback view below and by the Coming Attractions
    // toggle button's "is there anything to show" check (Task 5).
    function getMotdPosterImages() {
        const motd = document.getElementById('motdrow');
        if (!motd) return [];
        return [...motd.querySelectorAll('img')].filter(img => {
            const w = parseInt(img.getAttribute('width') || 0);
            const h = parseInt(img.getAttribute('height') || 0);
            return h >= 100 && w <= 200;
        }).map(img => ({ src: img.src, title: img.title || img.alt || '' }));
    }

    // Every item's TMDB/IMDb-enriched fields, in the exact shape showNowPlayingCard
    // (line ~1566) already consumes.
    function lineupBuildItem(info, title, year) {
        return {
            cleanTitle: info.cleanTitle || title,
            cleanYear: info.cleanYear || year,
            poster: info.poster || null,
            backdrop: info.backdrop || null,
            overview: info.overview || '',
            rating: info.rating ?? null,
            runtime: info.runtime ?? null,
            genres: info.genres || [],
            parentalGuide: info.parentalGuide || null,
            killCount: info.killCount ?? null,
            imdbId: info.imdbId || null,
        };
    }

    // Fallback when Reddit is unreachable and no cache exists at all: the current item
    // (if known and it looks like a real feature, not a short/bumper) plus the same
    // admin-curated MOTD poster art the old strip showed (display-only -- no real
    // title/overview to show for those, so clicking does nothing). Shaped as a single
    // pseudo-day/section so the screen's fallback renderer doesn't need to know this
    // differs from the real day/section structure.
    async function lineupFallbackView() {
        const items = [];
        if (lastMovieTitle) {
            const { title, year } = parseMovieFilename(lastMovieTitle);
            const info = await lookupMovie(title, year);
            // Skip likely bumpers/shorts: if TMDB is configured and confidently found
            // nothing for this exact title, it's probably not a real feature. Without a
            // TMDB key at all there's no way to tell, so default to showing it.
            if (!hasKey(LS_TMDB) || info.cleanTitle) {
                items.push({ ...lineupBuildItem(info, title, year), isNowPlaying: true, etaLabel: '' });
            }
        }
        getMotdPosterImages().forEach((img) => {
            items.push({
                cleanTitle: img.title, cleanYear: null,
                poster: img.src, backdrop: null, overview: '',
                isNowPlaying: false, etaLabel: '', clickable: false,
            });
        });
        return {
            listTitle: LINEUP_FALLBACK_TITLE, fallback: true,
            days: [{ day: 'Tonight', date: null, isToday: true, sections: [{ name: '', slug: null, items }] }],
        };
    }

    // Flattens a day's sections into one ordered list (for locating "now" and walking ETAs
    // across section boundaries), hands the timing model (lineupEstimateDayItems) the flat
    // facts -- runtimes, learned gap, confirmed now-playing, persisted played-progress,
    // bumper start -- then re-nests the built items back into their sections.
    function lineupBuildDaySections(day, dayStatus, infosByKey) {
        const flat = [];
        day.sections.forEach((section, si) => {
            section.items.forEach(item => flat.push({ section, si, item }));
        });

        const isToday = dayStatus === 'today';
        const currentTitle = isToday && lastMovieTitle
            ? parseMovieFilename(lastMovieTitle).title : '';
        const currentFlatIndex = currentTitle
            ? flat.findIndex(f => lineupItemMatchesTitle(f.item, currentTitle))
            : -1;

        if (isToday) lineupCommitConfirmedProgress(); // a film past the confirm threshold counts as reached

        const nowMs = Date.now();
        const infoFor = (f) => infosByKey.get(f.item.title + '|' + f.item.year) || {};
        const estimates = lineupEstimateDayItems({
            nowMs,
            anchorMs: lineupDayAnchorPacific(day.date).getTime(),
            runtimesMin: flat.map(f => infoFor(f).runtime ?? null),
            gapSeconds: lineupMedianGapSeconds(_lineupObservedGaps) ?? 600, // 10-min cold-start default
            dayStatus,
            currentIndex: currentFlatIndex,
            remainingSec: currentFlatIndex !== -1
                ? Math.max(0, getCurrentMediaSeconds() - getPlayerTimeSec()) : 0,
            furthestPlayedIndex: isToday ? lineupReadProgress() : -1,
            bumperStartMs: _lineupLastUnmatchedStart,
        });

        const builtFlat = flat.map((f, idx) => {
            const est = estimates[idx];
            const eta = est.etaMs != null ? new Date(lineupRoundEtaMs(est.etaMs, est.precision, nowMs)) : null;
            return {
                ...lineupBuildItem(infoFor(f), f.item.title, f.item.year),
                isNowPlaying: est.isNowPlaying,
                played: est.played,
                etaLabel: eta ? lineupFormatEta(eta.getHours(), eta.getMinutes(), est.precision) : '',
            };
        });

        return day.sections.map((section, si) => ({
            name: section.name, slug: section.slug,
            items: builtFlat.filter((_, idx) => flat[idx].si === si),
        }));
    }

    // TMDB is searched under the post's primary title first; if that comes up empty, retry
    // under each aka in turn -- the stream sometimes plays (and the post lists) a film under
    // a retitle TMDB doesn't recognize (e.g. "Alien Predators" has no TMDB entry, but its
    // stated aka "The Falling" does) that lineupItemMatchesTitle already treats as the same film.
    async function lineupLookupItem(item) {
        const primary = await lookupMovie(item.title, item.year);
        if (primary.cleanTitle || !item.akas?.length) return primary;
        for (const aka of item.akas) {
            const info = await lookupMovie(aka, item.year);
            if (info.cleanTitle) return info;
        }
        return primary;
    }

    async function getTonightsLineup() {
        await lineupEnsureSchedule();
        if (!_lineupScheduleCache) return lineupFallbackView();

        const allItems = lineupAllScheduleTitles();
        const infos = await Promise.all(allItems.map(lineupLookupItem));
        const infosByKey = new Map(allItems.map((item, i) => [item.title + '|' + item.year, infos[i]]));

        const todayStr = lineupPacificDateString(); // ISO date strings order lexicographically
        const days = _lineupScheduleCache.days.map((day) => ({
            day: day.day, date: day.date, isToday: day.date === todayStr,
            sections: lineupBuildDaySections(
                day,
                day.date < todayStr ? 'past' : day.date === todayStr ? 'today' : 'future',
                infosByKey),
        }));
        return { listTitle: _lineupScheduleCache.title || LINEUP_FALLBACK_TITLE, fallback: false, days };
    }

    /* ==========================================================
       TONIGHT'S LINEUP -- full-screen schedule overlay, opened from the Coming
       Attractions toggle (Task 5). Friday/Saturday/Sunday day tabs switch which day
       is shown; within a day, every section renders stacked and native page-scroll
       moves between them (no D-pad paging -- this is mouse/keyboard, unlike the
       Android TV build this was ported from). OK/click on a film opens the existing
       Now-Playing card in browse mode. Ported from the Android app's
       web/src/lineup/screen.js, with the TV-only paging path removed.
    ========================================================== */

    let _lineupLastData = null;   // most recent getTonightsLineup() result, so tab switches don't refetch
    let _lineupActiveDay = null;  // currently selected day name

    function lineupEnsureScreenDom() {
        lineupEnsureThemeFontsLoaded();
        let screen = document.getElementById('sc-lineup-screen');
        if (screen) return screen;
        screen = document.createElement('div');
        screen.id = 'sc-lineup-screen';
        screen.innerHTML = `
            <button id="sc-lineup-close" type="button">✕</button>
            <div id="sc-lineup-header"></div>
            <div id="sc-lineup-subtitle">Titles/times may be subject to change.</div>
            <nav id="sc-lineup-daytabs"></nav>
            <div id="sc-lineup-body"></div>`;
        screen.querySelector('#sc-lineup-close').addEventListener('click', hideLineupScreen);
        // Clicking the screen's own background (the side gutters, or any empty space
        // below the last section) closes it -- only fires when the click lands on the
        // screen element itself, not a descendant (header/tabs/section/poster/close button).
        screen.addEventListener('click', (e) => { if (e.target === screen) hideLineupScreen(); });
        document.body.appendChild(screen);
        return screen;
    }

    function lineupRenderLoading(screen) {
        screen.querySelector('#sc-lineup-daytabs').innerHTML = '';
        screen.querySelector('#sc-lineup-body').innerHTML =
            '<div id="sc-lineup-loading">Fetching tonight’s lineup…</div>';
    }

    // The fallback title (no TMDB poster match) sits in a fixed 200x280 box -- long
    // titles shrink to fit rather than overflowing past the poster's rounded corners.
    // Three tiers tuned against that box; .sc-lineup-poster-fallback also has
    // overflow:hidden as a hard backstop for the rare title still too long even at the
    // smallest tier.
    function lineupFallbackTitleFontSize(text) {
        if (text.length > 55) return 10;
        if (text.length > 38) return 12;
        return 14;
    }

    function lineupItemButton(item) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sc-lineup-item'
            + (item.isNowPlaying ? ' sc-lineup-item-current' : '')
            + (item.played ? ' sc-lineup-item-played' : '')
            + (item.clickable === false ? ' sc-lineup-item-static' : '');
        const titleText = `${item.cleanTitle}${item.cleanYear ? ` (${item.cleanYear})` : ''}`;
        const etaText = item.isNowPlaying ? 'NOW PLAYING' : (item.etaLabel || '');
        // Titles are shown IN the poster box only when there's no art to identify the
        // film by -- when real poster art is present, no title text is shown at all;
        // click still opens the Now-Playing card with the full title if needed.
        btn.innerHTML = `
            <div class="sc-lineup-poster" style="${item.poster ? `background-image:url(${item.poster})` : ''}">
                ${!item.poster ? `<div class="sc-lineup-poster-fallback" style="font-size:${lineupFallbackTitleFontSize(titleText)}px">${titleText}</div>` : ''}
                ${etaText ? `<div class="sc-lineup-eta">${etaText}</div>` : ''}
            </div>`;
        // Static fallback posters are display-only (item.clickable === false) -- they
        // have no real title/overview to show, so click does nothing for them.
        if (item.clickable !== false) {
            btn.addEventListener('click', () => showNowPlayingCard(item, { autoHide: false }));
        }
        return btn;
    }

    // One section's grouping. Named theme sections repeat every week (a slow-changing,
    // closed set), so each gets its own Google Font + accent color tying its header
    // and background together.
    function lineupSectionEl(section) {
        const el = document.createElement('div');
        el.className = 'sc-lineup-section';
        const theme = getSectionTheme(section.slug);
        el.style.setProperty('--sc-lineup-wash', theme.wash);
        if (section.name) {
            const name = document.createElement('div');
            name.className = 'sc-lineup-section-name';
            name.style.setProperty('color', theme.color, 'important');
            if (theme.font) name.style.setProperty('font-family', `${theme.font}, cursive`, 'important');
            name.textContent = section.name;
            el.appendChild(name);
        }
        const rail = document.createElement('div');
        rail.className = 'sc-lineup-rail';
        section.items.forEach(item => rail.appendChild(lineupItemButton(item)));
        el.appendChild(rail);
        return el;
    }

    function lineupRenderDayTabs(screen, days) {
        const tabs = screen.querySelector('#sc-lineup-daytabs');
        tabs.innerHTML = '';
        days.forEach((d) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sc-lineup-daytab' + (d.day === _lineupActiveDay ? ' sc-lineup-daytab-active' : '');
            btn.textContent = d.day;
            btn.addEventListener('click', () => lineupShowDay(screen, d.day));
            tabs.appendChild(btn);
        });
    }

    function lineupRenderBody(screen, days) {
        const body = screen.querySelector('#sc-lineup-body');
        body.innerHTML = '';
        const day = days.find(d => d.day === _lineupActiveDay) || days[0];
        if (!day || !day.sections.length) {
            body.innerHTML = '<div id="sc-lineup-loading">No lineup available right now.</div>';
            return;
        }
        day.sections.forEach((section) => body.appendChild(lineupSectionEl(section)));
    }

    function lineupShowDay(screen, day) {
        _lineupActiveDay = day;
        const tabs = [...screen.querySelectorAll('.sc-lineup-daytab')];
        tabs.forEach(t => t.classList.toggle('sc-lineup-daytab-active', t.textContent === day));
        lineupRenderBody(screen, _lineupLastData.days);
    }

    // Degraded view when Reddit is unreachable: the current title (if known) plus the
    // static Coming Attractions art, as one flat rail -- no tabs, no sections, since
    // there's no real day/section structure to show in this mode.
    function lineupRenderFallback(screen, data) {
        screen.querySelector('#sc-lineup-daytabs').innerHTML = '';
        const body = screen.querySelector('#sc-lineup-body');
        body.innerHTML = '';
        const items = (data.days && data.days[0] && data.days[0].sections[0] && data.days[0].sections[0].items) || [];
        if (!items.length) {
            body.innerHTML = '<div id="sc-lineup-loading">No lineup available right now.</div>';
            return;
        }
        const section = document.createElement('div');
        section.className = 'sc-lineup-section sc-lineup-section-fallback';
        const rail = document.createElement('div');
        rail.className = 'sc-lineup-rail';
        items.forEach(item => rail.appendChild(lineupItemButton(item)));
        section.appendChild(rail);
        body.appendChild(section);
    }

    function lineupRenderItems(screen, data) {
        const header = screen.querySelector('#sc-lineup-header');
        if (header) header.textContent = (data && data.listTitle) || 'Grindhouse Lineup';
        _lineupLastData = data;
        if (!data || data.fallback) { lineupRenderFallback(screen, data || { days: [] }); return; }
        const days = data.days || [];
        // Recomputed fresh on every open so a manual tab switch from a PRIOR open
        // doesn't linger -- opening the screen always starts back on today's day (or
        // the first day, before the weekend starts).
        _lineupActiveDay = (days.find(d => d.isToday) || days[0] || {}).day || null;
        lineupRenderDayTabs(screen, days);
        lineupRenderBody(screen, days);
    }

    function showLineupScreen() {
        const screen = lineupEnsureScreenDom();
        screen.classList.add('sc-lineup-visible');
        lineupRenderLoading(screen);
        getTonightsLineup()
            .then(data => lineupRenderItems(screen, data))
            .catch(() => { lineupRenderItems(screen, { fallback: true, days: [] }); });
    }

    function hideLineupScreen() {
        const screen = document.getElementById('sc-lineup-screen');
        if (screen) screen.classList.remove('sc-lineup-visible');
        _topBarIsOpen = false;
        const toggleBtn = document.getElementById('sc-poster-toggle');
        if (toggleBtn) toggleBtn.classList.remove('sc-poster-toggle-active');
    }

    /* ==========================================================
       COMING ATTRACTIONS — toggle button for the Tonight's Lineup screen
       (the full lineup screen and its data layer live in the "TONIGHT'S LINEUP"
       sections above).
    ========================================================== */

    // Global wake/dim control — exposed so initPosterStrip can call wake()
    let _topBarWake = null;
    let _topBarIsOpen = false;

    function initTopBar() {
        // Gradient overlay — pointer-events:none so it never blocks clicks
        const bar = document.createElement('div');
        bar.id = 'sc-top-bar';
        document.body.appendChild(bar);

        let idleTimer  = null;
        let playing    = false; // true once the video has actually started

        // All elements that get .sc-bar-dim when the bar fades
        const getDimEls = () => [
            bar,
            document.getElementById('videowrap-header'),
            document.getElementById('sc-poster-toggle'),
            document.getElementById('sc-movie-links'),
            document.getElementById('sc-trivia-btn'),
        ].filter(Boolean);

        const dim = () => {
            if (_topBarIsOpen || !playing) return;
            getDimEls().forEach(el => el.classList.add('sc-bar-dim'));
        };

        const wake = () => {
            getDimEls().forEach(el => el.classList.remove('sc-bar-dim'));
            clearTimeout(idleTimer);
            if (!_topBarIsOpen && playing) idleTimer = setTimeout(dim, 3500);
        };
        _topBarWake = wake;

        // Start the countdown only when a video element starts playing
        const onVideoPlay = () => {
            if (playing) return; // already started once
            playing = true;
            clearTimeout(idleTimer);
            idleTimer = setTimeout(dim, 4000); // 4s after play starts
        };

        // Watch for video play events — video element may not exist yet at init
        const bindVideoEvents = () => {
            document.querySelectorAll('video').forEach(v => {
                if (!v._scPlayBound) {
                    v._scPlayBound = true;
                    v.addEventListener('play', onVideoPlay);
                }
            });
        };

        // Re-check whenever DOM changes (video element may be injected later)
        bindVideoEvents();
        new MutationObserver(bindVideoEvents)
            .observe(document.body, { childList: true, subtree: true });

        // Mouse near top of video area wakes the bar
        document.addEventListener('mousemove', (e) => {
            if (e.clientY < 60 && e.clientX < window.innerWidth * (isVerticalMonitor() ? 1 : 0.8)) {
                wake();
            }
        });
    }

    function initGapButtonDim() {
        const GAP_IDS = ['fs-toggle-btn', 'sc-desync-btn', 'sc-gif-btn', 'sc-settings-btn'];
        let gapTimer = null;

        const gapShow = () => {
            clearTimeout(gapTimer);
            GAP_IDS.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.classList.remove('sc-bar-dim');
            });
            gapTimer = setTimeout(gapHide, 2500);
        };

        const gapHide = () => {
            GAP_IDS.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.classList.add('sc-bar-dim');
            });
        };

        document.addEventListener('mousemove', (e) => {
            const vw = document.getElementById('videowrap');
            if (!vw) return;
            const r = vw.getBoundingClientRect();
            const overVideo = e.clientX >= r.left && e.clientX <= r.right &&
                              e.clientY >= r.top  && e.clientY <= r.bottom;
            // Also keep visible when hovering the buttons themselves
            const overBtn = GAP_IDS.some(id => e.target.closest && e.target.closest('#' + id));
            if (overVideo || overBtn) gapShow();
        });

        // Start visible, hide after 4s of no video-area activity
        gapTimer = setTimeout(gapHide, 4000);
    }

    function initPosterStrip() {
        if (document.getElementById('sc-poster-toggle')) return;

        // Toggle button — injected below the video title
        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'sc-poster-toggle';
        toggleBtn.textContent = "Coming Attractions";
        toggleBtn.title = 'Show/hide weekend lineup';
        toggleBtn.addEventListener('click', () => {
            const isOpen = document.getElementById('sc-lineup-screen')?.classList.contains('sc-lineup-visible');
            if (isOpen) {
                hideLineupScreen();
            } else {
                showLineupScreen();
                toggleBtn.classList.add('sc-poster-toggle-active');
                _topBarIsOpen = true;
                if (_topBarWake) _topBarWake();
            }
        });
        document.body.appendChild(toggleBtn);
    }

    /* ==========================================================
       POLL / ANNOUNCEMENT WATCHER
    ========================================================== */

    function initPollWatcher() {
        // pollwrap may not exist yet or may be empty — watch for it
        const tryInit = () => {
            const pollwrap = document.getElementById('pollwrap');
            if (!pollwrap) {
                // Not in DOM yet, watch body
                const bodyObs = new MutationObserver(() => {
                    if (document.getElementById('pollwrap')) {
                        bodyObs.disconnect();
                        tryInit();
                    }
                });
                bodyObs.observe(document.body, { childList: true, subtree: true });
                return;
            }
            _initPollWatcher(pollwrap);
        };
        tryInit();
    }

    function _initPollWatcher(pollwrap) {

        // Create the notification button — only shown when poll has content
        const header = document.getElementById('sc-chat-header');
        if (!header) return;
        const btn = document.createElement('button');
        btn.id = 'sc-poll-btn';
        btn.title = 'Channel announcement / poll';
        btn.textContent = 'POLL';
        header.appendChild(btn);

        // Create the floating panel
        const panel = document.createElement('div');
        panel.id = 'sc-poll-panel';
        panel.style.display = 'none';
        document.body.appendChild(panel);

        let panelOpen = false;

        const renderPanel = () => {
            // Clone pollwrap content so we can restyle without affecting original
            const well = pollwrap.querySelector('.well.active') || pollwrap.querySelector('.well');
            if (!well) { panel.innerHTML = ''; return; }

            // Extract just the useful parts: heading + options
            const h = well.querySelector('h3')?.textContent?.trim() || '';
            const opts = [...well.querySelectorAll('.option')].map(o => {
                // Get text without the vote count button text
                const btn = o.querySelector('button');
                const text = o.textContent.replace(btn?.textContent || '', '').trim();
                // Preserve links
                const links = [...o.querySelectorAll('a')].map(a =>
                    `<a href="${a.href}" target="_blank" rel="noopener noreferrer">${a.textContent}</a>`
                );
                let html = o.innerHTML.replace(/<button[^>]*>.*?<\/button>/i, '').trim();
                return `<div class="sc-poll-option">${html}</div>`;
            });

            // Time/author label
            const label = well.querySelector('.label')?.textContent?.trim() || '';
            const author = well.querySelector('.label')?.getAttribute('title') || '';

            panel.innerHTML = `
                <div class="sc-poll-header">${h}</div>
                <div class="sc-poll-options">${opts.join('')}</div>
                ${label ? `<div class="sc-poll-meta">${author ? author + ' · ' : ''}${label}</div>` : ''}
            `;
        };

        const hasPollContent = () => {
            // CyTube marks open polls with .well.active
            // Fall back to any .well with content if no active class
            const activeWell = pollwrap.querySelector('.well.active') || pollwrap.querySelector('.well');
            return !!(activeWell && activeWell.textContent.trim().length > 10);
        };

        const updateBtn = () => {
            const hasContent = hasPollContent();
            btn.style.display = hasContent ? '' : 'none';
            if (!hasContent && panelOpen) {
                panel.style.display = 'none';
                panelOpen = false;
                btn.classList.remove('sc-poll-btn-active');
            }
        };

        btn.addEventListener('click', () => {
            panelOpen = !panelOpen;
            if (panelOpen) {
                renderPanel();
                panel.style.display = 'block';
                btn.classList.add('sc-poll-btn-active');
            } else {
                panel.style.display = 'none';
                btn.classList.remove('sc-poll-btn-active');
            }
        });

        // Close on outside click
        document.addEventListener('click', e => {
            if (panelOpen && !btn.contains(e.target) && !panel.contains(e.target)) {
                panel.style.display = 'none';
                panelOpen = false;
                btn.classList.remove('sc-poll-btn-active');
            }
        });

        // Watch for poll changes
        new MutationObserver(() => {
            updateBtn();
            if (panelOpen) renderPanel();
        }).observe(pollwrap, { childList: true, subtree: true, characterData: true });

        updateBtn();
    } // end _initPollWatcher

    /* ==========================================================
       USER COUNT PANEL
    ========================================================== */

    function initChatHeader() {
        if (document.getElementById('sc-chat-header')) return;
        const header = document.createElement('div');
        header.id = 'sc-chat-header';
        document.body.appendChild(header);
    }

    function initUserCount() {
        const header = document.getElementById('sc-chat-header');
        if (!header) return;
        const btn = document.createElement('button');
        btn.id = 'sc-usercount-btn';
        header.appendChild(btn);

        // Create users panel
        const panel = document.createElement('div');
        panel.id = 'sc-users-panel';
        document.body.appendChild(panel);

        let open = false;

        const getUsers = () => {
            const items = [...document.querySelectorAll('#userlist .userlist_item')];
            return items
                .map(item => {
                    // CyTube structure: <span>(rank icon)</span><span (optional class)>Name</span>
                    // Get the second span which always contains the username
                    const spans = item.querySelectorAll('span');
                    const nameSpan = spans.length >= 2 ? spans[1] : spans[0];
                    return nameSpan?.textContent?.trim() || '';
                })
                .filter(Boolean)
                .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        };

        const updateCount = () => {
            // Prefer CyTube's own count (accurate, socket-driven)
            const cytubCount = document.getElementById('usercount');
            const raw = cytubCount?.textContent?.match(/\d+/)?.[0];
            const count = raw ? parseInt(raw) : getUsers().length;
            btn.textContent = count + ' USERS';
        };

        const renderPanel = () => {
            const users = getUsers();
            panel.innerHTML = `
                <div class="sc-users-panel-header">${users.length} connected</div>
                ${users.map(u => {
                    const color = usernameToColor(u);
                    return `<div class="sc-users-panel-name" style="color:${color}">${u}</div>`;
                }).join('')}
            `;
        };

        const closePanel = () => {
            panel.style.display = 'none';
            btn.classList.remove('sc-users-active');
            open = false;
        };

        btn.addEventListener('click', e => {
            e.stopPropagation();
            open = !open;
            if (open) {
                renderPanel();
                panel.style.display = 'block';
                btn.classList.add('sc-users-active');
            } else {
                closePanel();
            }
        });

        document.addEventListener('click', e => {
            if (open && !panel.contains(e.target) && e.target !== btn) closePanel();
        });

        // Update count and panel when userlist changes
        const ul = document.getElementById('userlist');
        if (ul) {
            new MutationObserver(() => {
                updateCount();
                if (open) renderPanel();
            }).observe(ul, { childList: true, subtree: true });
        }

        // Also watch CyTube's usercount element for socket-driven updates
        const uc = document.getElementById('usercount');
        if (uc) {
            new MutationObserver(updateCount)
                .observe(uc, { childList: true, subtree: true, characterData: true });
        }

        updateCount();
    }

    /* ==========================================================
       BOOT
    ========================================================== */

    const waitForBody = () => {
        if (!document.body) { requestAnimationFrame(waitForBody); return; }

        startMonitorWatcher();
        applyInputMode();

        const bootObserver = new MutationObserver(() => {
            applyInputMode();
            installChatTextarea();
            relocateEmoteButton();
            addFloatingButtons();
            addSettingsButton();
            startUserColorObserver();
            // Disconnect once all one-time elements are in place
            if (
                document.getElementById('sc-chat-textarea') &&
                document.getElementById('sc-emote-proxy') &&
                document.getElementById('fs-toggle-btn') &&
                document.getElementById('sc-settings-btn')
            ) {
                bootObserver.disconnect();
            }
        });
        bootObserver.observe(document.body, { childList: true, subtree: true });
    };

    waitForBody();

    /* ==========================================================
       CSS + LOAD INIT
    ========================================================== */

    window.addEventListener('load', () => {
        getKillCountDb(); // pre-fetch kill count DB
        installChatTextarea();
        relocateEmoteButton();
        addFloatingButtons();
        addSettingsButton();
        watchMovieTitle();
        initMediaWatcher();
        initChatTimestamps();
        initTopBar();
        initGapButtonDim();
        initDesyncButton();
        initChatSeekMenu();
        initChatHeader();
        initUserCount();
        initPollWatcher();
        applyChatFontSize(getChatFontSize());

        // First-run settings modal
        if (!hasKey(LS_TMDB)) {
            setTimeout(openSettingsModal, 1200);
        }

        // Run immediately if #motdrow already has images, otherwise watch for it
        if (document.querySelector('#motdrow img')) {
            initPosterStrip();
        } else {
            const motdObserver = new MutationObserver(() => {
                if (document.querySelector('#motdrow img')) {
                    motdObserver.disconnect();
                    initPosterStrip();
                }
            });
            motdObserver.observe(document.body, { childList: true, subtree: true });
            // Hard fallback — if observer never fires, try once after 2s
            setTimeout(() => {
                if (!document.getElementById('sc-poster-toggle')) initPosterStrip();
            }, 2000);
        }

        const style = document.createElement('style');
        style.textContent = `

            /* ===== SHARED HIDDEN ELEMENTS ===== */
            nav.navbar, #drinkbarwrap, #announcements, #playlistrow,
            #resizewrap, footer, #userlisttoggle, #rightcontrols,
            .modal-header, .timestamp, .modal-footer { display: none !important; }
            body { background-image: none !important; background: #000 !important; }
            .modal, .popover, .dropdown-menu { z-index: 20001 !important; }
            .modal-dialog { margin: 0 auto !important; }
            #resize-video-smaller, #resize-video-larger { display: none !important; }
            /* Remove pause and fullscreen from video.js control bar */
            .video-js .vjs-play-control { display: none !important; }
            .video-js .vjs-fullscreen-control { display: none !important; }
            /* Userlist — hidden but fully rendered so all users appear in DOM */
            #userlist {
                visibility: hidden !important;
                position: absolute !important;
                pointer-events: none !important;
                height: auto !important;
                overflow: hidden !important;
            }
            #userlisttoggle { display: none !important; }
            /* ── TOP BAR SYSTEM ────────────────────────────────────────────────────
               A single gradient band overlays the top of the video.
               After a few seconds the gradient, icons and Coming Attractions
               fade out leaving only the title. Mouse-over restores everything.
               If the poster strip is open nothing fades.

               States driven by .sc-bar-dim on #sc-top-bar:
                 (no class)    = fully visible
                 .sc-bar-dim   = gradient/icons/toggle faded, title stays
            ─────────────────────────────────────────────────────────────────── */

            /* Gradient overlay behind the whole bar */
            /* Gradient starts below the header row so it never alpha-composites
               over the title/pills/toggle — those have their own background */
            #sc-top-bar {
                position: fixed !important;
                top: 20px !important; /* start below the header bar */
                left: 0 !important;
                width: 80vw !important; height: 40px !important;
                z-index: 10001 !important; /* above video */
                pointer-events: none !important;
                background: linear-gradient(
                    to bottom,
                    rgba(0,0,0,0.35) 0%,
                    rgba(0,0,0,0)    100%
                ) !important;
                transition: opacity 1.5s ease !important;
                opacity: 1 !important;
            }
            body.sc-vertical #sc-top-bar { width: 100vw !important; }
            #sc-top-bar.sc-bar-dim { opacity: 0 !important; }

            /* Header — dark background fades out with gradient when dimmed */
            #videowrap-header {
                border: 0 !important;
                background: rgba(0,0,0,0.55) !important;
                padding: 3px 8px !important;
                font-size: 12px !important;
                font-weight: 500 !important;
                color: #fff !important;
                text-shadow: 0 1px 4px rgba(0,0,0,1), 0 0 10px rgba(0,0,0,0.9) !important;
                letter-spacing: 0.01em !important;
                white-space: nowrap !important;
                overflow: hidden !important;
                text-overflow: ellipsis !important;
                width: 80vw !important;
                box-sizing: border-box !important;
                position: fixed !important;
                top: 0 !important; left: 0 !important;
                z-index: 10002 !important;
                pointer-events: auto !important;
                transition: background 1.5s ease !important;
            }
            /* When dimmed: background fades away, title stays via text-shadow */
            #videowrap-header.sc-bar-dim {
                background: transparent !important;
            }
            body.sc-vertical #videowrap-header { width: 100vw !important; }
            /* Hide the "Currently Playing:" prefix label */
            /* Hide CyTube's original usercount */
            #usercount { display: none !important; }

            /* Chat header bar — sits above #chatwrap */
            #sc-chat-header {
                position: fixed !important;
                top: 0 !important; right: 5px !important;
                width: calc(19vw - 5px) !important; height: 28px !important;
                z-index: 10003 !important;
                background: rgba(0,0,0,0.7) !important;
                border: 1px solid #aaaaaa !important;
                border-bottom-color: #444 !important;
                display: flex !important;
                align-items: center !important;
                justify-content: space-between !important;
                padding: 0 8px !important;
                box-sizing: border-box !important;
            }
            body.sc-vertical #sc-chat-header {
                left: 5px !important;
                right: 5px !important;
                width: auto !important;
                bottom: calc(42vh - 20px) !important;
                top: auto !important;
            }
            #sc-usercount-btn, #sc-poll-btn {
                background: transparent !important;
                border: none !important;
                font-size: 10px !important;
                font-weight: 700 !important;
                letter-spacing: 0.06em !important;
                text-transform: uppercase !important;
                color: rgba(255,255,255,0.5) !important;
                cursor: pointer !important;
                padding: 0 4px !important;
                font-family: inherit !important;
                transition: color 0.2s !important;
                line-height: 28px !important;
            }
            #sc-usercount-btn:hover, #sc-poll-btn:hover { color: rgba(255,255,255,0.9) !important; }
            #sc-usercount-btn.sc-users-active,
            #sc-poll-btn.sc-poll-btn-active { color: white !important; }

            /* Users panel — drops down from usercount, same style as poll panel */
            #sc-users-panel {
                position: fixed !important;
                top: 28px !important;
                right: 5px !important;
                width: calc(19vw - 5px) !important;
                z-index: 19000 !important;
                background: rgba(10,10,20,0.95) !important;
                border: 1px solid #aaaaaa !important;
                border-top: none !important;
                border-radius: 0 0 0 8px !important;
                padding: 10px 12px !important;
                color: rgba(255,255,255,0.88) !important;
                font-size: 12px !important;
                line-height: 1.6 !important;
                box-shadow: 0 8px 32px rgba(0,0,0,0.7) !important;
                max-height: 60vh !important;
                overflow-y: auto !important;
                scrollbar-width: thin !important;
                scrollbar-color: rgba(255,255,255,0.15) transparent !important;
                display: none;
            }
            body.sc-vertical #sc-users-panel {
                top: auto !important;
                bottom: calc(42vh) !important;
                right: 5px !important;
                width: calc(100vw - 5px) !important;
                max-height: 40vh !important;
            }
            .sc-users-panel-header {
                font-size: 10px !important;
                font-weight: 700 !important;
                letter-spacing: 0.06em !important;
                text-transform: uppercase !important;
                color: rgba(255,255,255,0.4) !important;
                margin-bottom: 8px !important;
                padding-bottom: 6px !important;
                border-bottom: 1px solid rgba(255,255,255,0.08) !important;
            }
            .sc-users-panel-name {
                padding: 1px 0 !important;
                white-space: nowrap !important;
                overflow: hidden !important;
                text-overflow: ellipsis !important;
            }

            #videowrap-header .pull-left > span:first-child,
            #videowrap-header .label,
            #videowrap-header b { display: none !important; }
            #videowrap-header strong { font-weight: 500 !important; }

            /* Movie link icons — background fades to transparent when dimmed,
               /* Coming Attractions button — fades with gradient */
            #sc-poster-toggle {
                color: rgba(255,255,255,0.55) !important;
                transition: opacity 1.5s ease, color 0.2s ease !important;
                opacity: 1 !important;
                pointer-events: auto !important;
                cursor: pointer !important;
            }
            #sc-poster-toggle.sc-bar-dim {
                opacity: 0 !important;
                pointer-events: none !important;
            }
            #sc-poster-toggle:hover { color: rgba(255,255,255,0.9) !important; }
            #sc-poster-toggle.sc-poster-toggle-active {
                color: rgba(255,255,255,0.9) !important;
            }
            /* Pull the control bar out of embed-responsive's constrained box
               and pin it as a fixed element flush to the bottom of the screen.
               Right edge stops just before the settings button. */
            /* ===== VIDEO.JS CONTROL BAR — pill style matching our UI buttons ===== */
            .video-js .vjs-control-bar {
                position: fixed !important;
                bottom: 4px !important;
                left: 4px !important;
                right: calc(20vw + 150px) !important;
                width: auto !important;
                margin: 0 !important;
                z-index: 10001 !important;
                /* Pill-style bar */
                background: rgba(255,255,255,0.08) !important;
                border-radius: 999px !important;
                padding: 0 8px !important;
                height: 32px !important;
                display: flex !important;
                align-items: center !important;
                backdrop-filter: blur(4px) !important;
            }
            body.sc-vertical .video-js .vjs-control-bar {
                bottom: calc(42vh + 15px) !important;
                right: 160px !important;
                left: 4px !important;
            }

            /* Individual control buttons — match pill button style */
            .video-js .vjs-control {
                color: rgba(255,255,255,0.55) !important;
                transition: color 0.3s ease, background 0.3s ease !important;
                border-radius: 999px !important;
            }
            .video-js .vjs-control:hover {
                color: white !important;
                background: rgba(255,255,255,0.12) !important;
            }

            /* Progress / seek bar */
            .video-js .vjs-progress-control {
                border-radius: 999px !important;
                overflow: visible !important;
            }
            .video-js .vjs-progress-holder {
                background: rgba(255,255,255,0.15) !important;
                border-radius: 999px !important;
                height: 4px !important;
                transition: height 0.15s !important;
            }
            .video-js .vjs-progress-holder:hover { height: 6px !important; }
            .video-js .vjs-play-progress {
                background: rgba(255,255,255,0.75) !important;
                border-radius: 999px !important;
            }
            .video-js .vjs-play-progress::before {
                color: white !important;
                font-size: 10px !important;
                top: -3px !important;
            }
            .video-js .vjs-load-progress {
                background: rgba(255,255,255,0.1) !important;
                border-radius: 999px !important;
            }

            /* Volume slider */
            .video-js .vjs-volume-bar {
                background: rgba(255,255,255,0.15) !important;
                border-radius: 999px !important;
            }
            .video-js .vjs-volume-level {
                background: rgba(255,255,255,0.75) !important;
                border-radius: 999px !important;
            }
            .video-js .vjs-volume-level::before {
                color: white !important;
                font-size: 10px !important;
            }

            /* Time display */
            .video-js .vjs-time-control {
                color: rgba(255,255,255,0.55) !important;
                font-size: 11px !important;
                line-height: 32px !important;
                padding: 0 4px !important;
                min-width: 0 !important;
            }

            /* Big play button — pill style */
            .video-js .vjs-big-play-button {
                top: 50% !important;
                left: 50% !important;
                transform: translate(-50%, -50%) !important;
                margin: 0 !important;
                background: rgba(255,255,255,0.08) !important;
                border: 1px solid rgba(255,255,255,0.2) !important;
                border-radius: 999px !important;
                width: 60px !important;
                height: 60px !important;
                line-height: 60px !important;
                font-size: 24px !important;
                color: rgba(255,255,255,0.8) !important;
                transition: background 0.3s ease, color 0.3s ease !important;
                backdrop-filter: blur(4px) !important;
            }
            .video-js .vjs-big-play-button:hover {
                background: rgba(255,255,255,0.18) !important;
                color: white !important;
            }
            .video-js:hover .vjs-big-play-button { opacity: 1 !important; }

            /* ===== MOTD — keep hidden, we extract images ourselves ===== */
            #motdrow { display: none !important; }

            /* ===== TONIGHT'S LINEUP SCREEN ===== */
            #sc-lineup-screen {
                position: fixed !important; inset: 0 !important;
                z-index: 20500 !important;
                background: rgba(6,4,8,0.97) !important;
                opacity: 0 !important; pointer-events: none !important;
                transition: opacity 0.25s ease !important;
                overflow-y: auto !important;
                font-family: system-ui, sans-serif !important;
                padding: 40px 6% 60px !important;
            }
            #sc-lineup-screen.sc-lineup-visible { opacity: 1 !important; pointer-events: auto !important; }
            #sc-lineup-close {
                position: fixed !important; top: 20px !important; right: 24px !important;
                z-index: 20600 !important;
                background: rgba(255,255,255,0.08) !important; border: none !important;
                color: #fff !important; width: 34px !important; height: 34px !important;
                border-radius: 50% !important; font-size: 16px !important; cursor: pointer !important;
            }
            #sc-lineup-close:hover { background: rgba(255,255,255,0.18) !important; }
            #sc-lineup-header {
                color: #fff !important; font-size: 28px !important; font-weight: 800 !important;
                margin-bottom: 4px !important;
            }
            #sc-lineup-subtitle {
                color: rgba(255,255,255,0.45) !important; font-size: 12px !important;
                margin-bottom: 20px !important;
            }
            #sc-lineup-daytabs { display: flex !important; gap: 10px !important; margin-bottom: 24px !important; }
            .sc-lineup-daytab {
                background: rgba(255,255,255,0.08) !important; border: 1px solid rgba(255,255,255,0.14) !important;
                color: rgba(255,255,255,0.7) !important; padding: 6px 18px !important;
                border-radius: 999px !important; font-size: 13px !important; cursor: pointer !important;
                text-transform: uppercase !important; letter-spacing: 0.06em !important;
            }
            .sc-lineup-daytab-active { background: rgba(255,255,255,0.9) !important; color: #111 !important; font-weight: 700 !important; }
            #sc-lineup-loading { color: rgba(255,255,255,0.5) !important; font-size: 15px !important; padding: 40px 0 !important; }
            .sc-lineup-section {
                background: var(--sc-lineup-wash, #14141a) !important;
                border-radius: 12px !important; padding: 18px 20px !important; margin-bottom: 18px !important;
            }
            .sc-lineup-section-name {
                font-size: 20px !important; font-weight: 700 !important; color: #fff !important;
                margin-bottom: 12px !important;
            }
            .sc-lineup-rail { display: flex !important; gap: 16px !important; flex-wrap: wrap !important; }
            .sc-lineup-item {
                background: none !important; border: none !important; padding: 0 !important; cursor: pointer !important;
                width: 200px !important; flex-shrink: 0 !important;
            }
            .sc-lineup-poster {
                width: 200px !important; height: 280px !important; border-radius: 6px !important;
                background-size: cover !important; background-position: center !important;
                background-color: #222 !important; position: relative !important;
                box-shadow: 0 6px 20px rgba(0,0,0,0.5) !important;
                transition: transform 0.15s ease !important;
            }
            .sc-lineup-item:hover .sc-lineup-poster { transform: scale(1.04) !important; }
            .sc-lineup-item-current .sc-lineup-poster { outline: 2px solid var(--np-accent, #ff5b73) !important; }
            /* Already-shown films tonight (and every film on a past day's tab) dim to
               grayscale so it's obvious at a glance what's left to watch. */
            .sc-lineup-item-played .sc-lineup-poster { filter: grayscale(1) !important; opacity: 0.45 !important; }
            .sc-lineup-item-static { cursor: default !important; }
            .sc-lineup-poster-fallback {
                position: absolute !important; inset: 0 !important; display: flex !important;
                align-items: center !important; justify-content: center !important; text-align: center !important;
                color: rgba(255,255,255,0.8) !important; padding: 8px !important; overflow: hidden !important;
            }
            .sc-lineup-eta {
                position: absolute !important; left: 4px !important; right: 4px !important; bottom: 4px !important;
                background: rgba(0,0,0,0.75) !important; color: #fff !important; font-size: 10px !important;
                text-align: center !important; border-radius: 3px !important; padding: 2px 0 !important;
                letter-spacing: 0.04em !important;
            }
            .sc-lineup-item-current .sc-lineup-eta { background: var(--np-accent, #ff5b73) !important; }

            /* Toggle button — right side of the header bar, same line as the title */
            #sc-poster-toggle {
                position: fixed !important;
                top: 0 !important;
                right: 20vw !important;  /* stops at the chat panel edge */
                left: auto !important;
                z-index: 10003 !important;
                background: transparent !important;
                border: none !important;
                border-radius: 0 !important;
                padding: 2px 8px !important;
                font-size: 10px !important;
                cursor: pointer !important;
                letter-spacing: 0.06em !important;
                text-transform: uppercase !important;
                white-space: nowrap !important;
                line-height: 1 !important;
                height: 20px !important;
                display: flex !important;
                align-items: center !important;
            }
            body.sc-vertical #sc-poster-toggle {
                top: 0 !important;
                right: 0 !important;
                left: auto !important;
                bottom: auto !important;
            }

            /* ===== MOVIE LINKS ===== */
            #sc-movie-links {
                display: inline-flex !important;
                gap: 3px !important;
                margin-left: 8px !important;
                vertical-align: middle !important;
            }
            /* Dim: override inline background with transparent, fade text to ghost */
            #sc-movie-links.sc-bar-dim .sc-movie-link {
                background: transparent !important;
                color: rgba(255,255,255,0.3) !important;
                box-shadow: inset 0 0 0 1px rgba(255,255,255,0.15) !important;
            }
            .sc-movie-link {
                display: inline-flex !important;
                align-items: center !important; justify-content: center !important;
                width: 17px !important; height: 17px !important;
                border-radius: 3px !important;
                font-size: 10px !important; font-weight: 900 !important;
                text-decoration: none !important;
                line-height: 1 !important; font-family: Georgia, serif !important;
                flex-shrink: 0 !important; cursor: pointer !important;
                transition: background 2s ease, color 2s ease, box-shadow 2s ease, filter 0.2s ease !important;
            }
            .sc-movie-link:hover { filter: brightness(1.3) !important; }
            .sc-movie-loading { font-size: 11px !important; color: rgba(255,255,255,0.3) !important; margin-left: 6px !important; }
            /* Stats bar — floats over bottom-left of video, auto-hides after 12s */
            #sc-movie-stats {
                position: fixed !important;
                bottom: 40px !important;
                left: 12px !important;
                z-index: 19000 !important;
                background: rgba(0,0,0,0.75) !important;
                color: rgba(255,255,255,0.9) !important;
                font-size: 13px !important;
                padding: 6px 12px !important;
                border-radius: 6px !important;
                letter-spacing: 0.03em !important;
                line-height: 1.4 !important;
                pointer-events: none !important;
                max-width: 75vw !important;
                animation: sc-stats-fadein 0.4s ease !important;
            }
            @keyframes sc-stats-fadein {
                from { opacity: 0; transform: translateY(6px); }
                to   { opacity: 1; transform: translateY(0); }
            }


            /* ===== FLOATING BUTTONS (body-level, always visible) ===== */
            #sc-desync-btn {
                position: fixed !important;
                z-index: 20002 !important;
                background: rgba(255,255,255,0.08) !important;
                color: rgba(255,255,255,0.55) !important;
                border: 1px solid rgba(255,255,255,0.18) !important;
                border-radius: 50% !important;
                width: 28px !important; height: 28px !important;
                padding: 0 !important;
                font-size: 15px !important;
                cursor: pointer !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                transition: color 0.3s ease, background 0.3s ease, transform 0.3s ease, opacity 0.3s ease !important;
            }
            #sc-desync-btn.sc-bar-dim {
                transform: translateX(60px) !important; opacity: 0 !important; pointer-events: none !important;
            }
            #sc-desync-btn:hover {
                color: white !important;
                background: rgba(255,255,255,0.22) !important;
            }
            #sc-desync-btn.sc-desync-active {
                color: #ffcc44 !important;
                background: rgba(255,200,50,0.18) !important;
            }
            body.sc-horizontal #sc-desync-btn {
                bottom: 6px !important;
                right: calc(20vw + 44px) !important;
            }
            body.sc-vertical #sc-desync-btn {
                bottom: 43vh !important;
                right: 44px !important;
            }

            /* ===== GIF BUTTON (matches desync/fs circular style) ===== */
            #sc-gif-btn {
                position: fixed !important;
                z-index: 20002 !important;
                background: rgba(255,255,255,0.08) !important;
                color: rgba(255,255,255,0.55) !important;
                border: 1px solid rgba(255,255,255,0.18) !important;
                border-radius: 50% !important;
                width: 28px !important; height: 28px !important;
                padding: 0 !important; font-size: 14px !important;
                cursor: pointer !important;
                display: flex !important; align-items: center !important; justify-content: center !important;
                transition: color 0.3s ease, background 0.3s ease, transform 0.3s ease, opacity 0.3s ease !important;
            }
            #sc-gif-btn.sc-bar-dim {
                transform: translateX(60px) !important; opacity: 0 !important; pointer-events: none !important;
            }
            #sc-gif-btn:hover { color: white !important; background: rgba(255,255,255,0.22) !important; }
            body.sc-horizontal #sc-gif-btn {
                bottom: 6px !important;
                right: calc(20vw + 80px) !important;
            }
            body.sc-vertical #sc-gif-btn {
                bottom: 43vh !important;
                right: 80px !important;
            }

            /* ===== GIF PANEL ===== */
            #sc-gif-panel {
                position: fixed !important;
                top: 50% !important; left: 50% !important; transform: translate(-50%, -50%) !important;
                z-index: 30002 !important;
                width: 420px !important; max-width: 92vw !important;
                background: rgba(18,18,20,0.98) !important;
                border: 1px solid rgba(255,255,255,0.16) !important;
                border-radius: 10px !important;
                box-shadow: 0 12px 40px rgba(0,0,0,0.6) !important;
                color: #eee !important; font-size: 13px !important;
            }
            #sc-gif-head {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                padding: 10px 14px !important;
                border-bottom: 1px solid rgba(255,255,255,0.1) !important;
                font-weight: 600 !important; color: #ffcc44 !important;
            }
            #sc-gif-close {
                background: transparent !important; border: none !important; color: rgba(255,255,255,0.6) !important;
                font-size: 15px !important; cursor: pointer !important; padding: 0 4px !important;
            }
            #sc-gif-close:hover { color: white !important; }
            #sc-gif-body { padding: 12px 14px !important; display: flex !important; flex-direction: column !important; gap: 10px !important; }
            #sc-gif-body label {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                color: rgba(255,255,255,0.8) !important; font-weight: 500 !important;
            }
            #sc-gif-body select {
                background: #1f1f22 !important; color: white !important;
                border: 1px solid rgba(255,255,255,0.2) !important; border-radius: 5px !important;
                padding: 3px 8px !important; font-size: 13px !important;
            }
            /* The popup option list — dark so white text stays readable */
            #sc-gif-body select option {
                background-color: #1f1f22 !important; color: white !important;
            }
            /* Start / end mark cards with preview thumbnails */
            .sc-gif-marks { display: flex !important; gap: 10px !important; }
            .sc-gif-mark {
                flex: 1 1 0 !important; min-width: 0 !important;
                display: flex !important; flex-direction: column !important; gap: 6px !important;
            }
            .sc-gif-thumb {
                width: 100% !important; aspect-ratio: 16 / 9 !important;
                /* Longhands only — a background shorthand with !important would
                   override the inline background-image we set from JS. */
                background-color: #000 !important;
                background-position: center !important;
                background-size: cover !important;
                background-repeat: no-repeat !important;
                border: 1px solid rgba(255,255,255,0.18) !important; border-radius: 6px !important;
                position: relative !important;
            }
            /* Preview reframing to match the chosen output shape */
            .sc-gif-thumb-43 { aspect-ratio: 4 / 3 !important; }
            .sc-gif-thumb-fit { background-size: contain !important; }
            .sc-gif-thumb-loading::after {
                content: '' !important;
                position: absolute !important;
                top: 50% !important; left: 50% !important;
                width: 22px !important; height: 22px !important;
                margin: -11px 0 0 -11px !important;
                border: 2px solid rgba(255,255,255,0.25) !important;
                border-top-color: #ffcc44 !important;
                border-radius: 50% !important;
                animation: sc-gif-spin 0.8s linear infinite !important;
            }
            @keyframes sc-gif-spin { to { transform: rotate(360deg); } }
            .sc-gif-spinner {
                display: inline-block !important;
                width: 18px !important; height: 18px !important;
                border: 2px solid rgba(255,255,255,0.25) !important;
                border-top-color: #ffcc44 !important;
                border-radius: 50% !important;
                animation: sc-gif-spin 0.8s linear infinite !important;
                flex: none !important;
            }
            .sc-gif-spinner-sm { width: 13px !important; height: 13px !important; }
            .sc-gif-working {
                display: flex !important; align-items: center !important; gap: 10px !important;
                padding: 14px 4px !important; color: rgba(255,255,255,0.75) !important; font-size: 13px !important;
            }
            #sc-gif-link {
                display: flex !important; align-items: center !important; gap: 8px !important;
                flex-wrap: wrap !important; margin-top: 8px !important;
            }
            .sc-gif-link-url {
                color: #8ab4ff !important; font-size: 12px !important; word-break: break-all !important;
                text-decoration: none !important;
            }
            .sc-gif-link-url:hover { text-decoration: underline !important; }
            .sc-gif-link-msg { color: rgba(255,255,255,0.6) !important; font-size: 12px !important; }
            #sc-gif-copylink, #sc-gif-upload {
                background: rgba(255,255,255,0.1) !important; color: white !important;
                border: 1px solid rgba(255,255,255,0.2) !important; border-radius: 5px !important;
                padding: 5px 12px !important; font-size: 12px !important; cursor: pointer !important;
            }
            #sc-gif-copylink:hover, #sc-gif-upload:hover:not(:disabled) { background: rgba(255,255,255,0.2) !important; }
            #sc-gif-upload:disabled { opacity: 0.5 !important; cursor: default !important; }
            .sc-gif-mark-label {
                color: #ffcc44 !important; font-size: 11px !important; font-weight: 700 !important;
                letter-spacing: 0.04em !important; text-align: center !important;
            }
            .sc-gif-mark-btns { display: flex !important; gap: 4px !important; }
            .sc-gif-mark-btns button {
                flex: 1 1 0 !important; min-width: 0 !important;
                background: rgba(255,255,255,0.1) !important; color: white !important;
                border: 1px solid rgba(255,255,255,0.2) !important; border-radius: 5px !important;
                padding: 4px 0 !important; font-size: 11px !important; cursor: pointer !important;
            }
            .sc-gif-mark-btns button:hover { background: rgba(255,255,255,0.22) !important; }
            #sc-gif-dur-line {
                text-align: center !important; color: rgba(255,255,255,0.7) !important; font-size: 12px !important;
            }
            #sc-gif-dur-line b { color: #fff !important; }
            .sc-gif-opts { display: flex !important; gap: 12px !important; }
            .sc-gif-opts label { flex: 1 1 0 !important; }
            #sc-gif-note { color: rgba(255,255,255,0.45) !important; font-size: 11px !important; }
            #sc-gif-go {
                background: rgba(255,200,50,0.18) !important; color: #ffcc44 !important;
                border: 1px solid rgba(255,200,50,0.45) !important; border-radius: 6px !important;
                padding: 8px 12px !important; font-size: 13px !important; font-weight: 600 !important;
                cursor: pointer !important;
            }
            #sc-gif-go:hover:not(:disabled) { background: rgba(255,200,50,0.28) !important; }
            #sc-gif-go:disabled { opacity: 0.5 !important; cursor: default !important; }
            #sc-gif-status { color: rgba(255,255,255,0.65) !important; font-size: 12px !important; min-height: 14px !important; }
            #sc-gif-result img { width: 100% !important; border-radius: 6px !important; display: block !important; }
            #sc-gif-actions {
                display: flex !important; align-items: center !important; gap: 10px !important; margin-top: 8px !important;
            }
            #sc-gif-dl {
                background: rgba(255,255,255,0.1) !important; color: white !important;
                border: 1px solid rgba(255,255,255,0.2) !important; border-radius: 5px !important;
                padding: 5px 12px !important; font-size: 12px !important; cursor: pointer !important;
                text-decoration: none !important;
            }
            #sc-gif-dl:hover { background: rgba(255,255,255,0.2) !important; }
            #sc-gif-size { color: rgba(255,255,255,0.45) !important; font-size: 11px !important; margin-left: auto !important; }

            #fs-toggle-btn, #sc-emote-proxy {
                position: fixed !important;
                z-index: 20002 !important;
                background: rgba(255,255,255,0.08) !important;
                color: rgba(255,255,255,0.55) !important;
                border: 1px solid rgba(255,255,255,0.18) !important;
                border-radius: 50% !important;
                width: 28px !important; height: 28px !important;
                padding: 0 !important; font-size: 15px !important;
                cursor: pointer !important;
                display: flex !important; align-items: center !important; justify-content: center !important;
                transition: color 0.3s ease, background 0.3s ease !important;
            }
            /* Gap buttons slide out to the right on idle */
            #fs-toggle-btn {
                transition: color 0.3s ease, background 0.3s ease, transform 0.3s ease, opacity 0.3s ease !important;
            }
            #fs-toggle-btn.sc-bar-dim {
                transform: translateX(60px) !important; opacity: 0 !important; pointer-events: none !important;
            }
            #sc-emote-proxy svg { width: 20px !important; height: auto !important; display: block !important; }
            #fs-toggle-btn:hover, #sc-emote-proxy:hover {
                color: white !important;
                background: rgba(255,255,255,0.22) !important;
            }
            #fs-toggle-btn:focus { outline: none !important; }

            /* ===== HORIZONTAL LAYOUT (widescreen) ===== */
            body.sc-horizontal #videowrap {
                position: fixed !important; top: 0 !important; left: 0 !important;
                width: 80vw !important; height: 100vh !important;
                z-index: 9999 !important; background: black !important;
            }
            body.sc-horizontal #videowrap .embed-responsive,
            body.sc-horizontal #ytapiplayer {
                width: 80vw !important; height: 100vh !important;
            }
            body.sc-horizontal #chatwrap {
                position: fixed !important; top: 28px !important; right: 0 !important;
                width: 19vw !important; height: calc(100vh - 28px) !important;
                z-index: 9999 !important; background: rgba(0,0,0,0.7) !important;
                overflow: hidden !important; padding: 0 5px 0 0 !important;
                display: flex !important; flex-direction: column !important;
            }
            body.sc-horizontal #leftcontrols { display: none !important; }
            /* Horizontal: buttons bottom-right of video */
            body.sc-horizontal #sc-emote-proxy {
                bottom: 6px !important; right: 8px !important;
            }
            body.sc-horizontal #fs-toggle-btn {
                bottom: 6px !important; right: calc(20vw + 8px) !important;
            }

            /* ===== VERTICAL LAYOUT (portrait monitor) ===== */
            body.sc-vertical #videowrap {
                position: fixed !important; top: 0 !important; left: 0 !important;
                width: 100vw !important; height: 55vh !important;
                z-index: 9999 !important; background: black !important;
                border: none !important; outline: none !important;
                box-shadow: none !important;
            }
            body.sc-vertical #videowrap .embed-responsive,
            body.sc-vertical #ytapiplayer {
                width: 100vw !important; height: 55vh !important;
                border: none !important;
                margin: 0 !important;
                padding: 0 !important;
            }
            body.sc-vertical .video-js {
                margin: 0 !important;
                padding: 0 !important;
                left: 0 !important;
            }
            body.sc-vertical .vjs-tech {
                left: 0 !important;
                margin: 0 !important;
            }
            body.sc-vertical #chatwrap {
                position: fixed !important; bottom: 0 !important; left: 0 !important;
                width: 100vw !important; height: calc(42vh - 28px) !important;
                z-index: 9999 !important; background: rgba(0,0,0,0.85) !important;
                overflow: hidden !important; padding: 0 5px !important;
                display: flex !important; flex-direction: column !important;
            }
            body.sc-vertical #messagebuffer { font-size: 15px !important; }

            /* Vertical: all buttons in one right-pinned row flush on top of the chat panel.
               leftcontrols hides its own internal layout; we show a proxy row instead. */
            body.sc-vertical #leftcontrols { display: none !important; }

            /* emote button: inside the textarea area, bottom-right corner */
            body.sc-vertical #sc-emote-proxy {
                bottom: 18px !important;
                right: 8px !important; left: auto !important;
            }
            /* fs button: sits in the gap between video and chat */
            body.sc-vertical #fs-toggle-btn {
                bottom: 43vh !important;
                right: 8px !important; left: auto !important;
            }
            /* movie stats tags: float just above the video scrubber (bottom of the
               55vh video) instead of down at the very bottom of the screen */
            body.sc-vertical #sc-movie-stats {
                bottom: 45vh !important;
            }

            /* ===== SHARED CHAT ELEMENTS ===== */
            #messagebuffer {
                flex: 1 !important; height: auto !important;
                background: transparent !important; color: white !important;
                font-size: 14px !important; overflow-y: auto !important; padding-bottom: 5px !important;
            }
            #sc-chat-textarea {
                width: 100% !important; min-height: 44px !important; max-height: 120px !important;
                background: rgba(255,255,255,0.1) !important; color: white !important;
                border: 1px solid rgba(255,255,255,0.3) !important; border-radius: 4px !important;
                padding: 6px 38px 6px 8px !important; font-size: 14px !important; font-family: inherit !important;
                resize: none !important; overflow-y: auto !important;
                box-sizing: border-box !important; line-height: 1.4 !important;
                outline: none !important; transition: border-color 0.2s !important; flex-shrink: 0 !important;
            }
            #sc-chat-textarea:focus {
                border-color: rgba(255,255,255,0.7) !important;
                background: rgba(255,255,255,0.15) !important;
            }
            #sc-chat-textarea::placeholder { color: rgba(255,255,255,0.4) !important; }
            #sc-chat-textarea {
                scrollbar-width: thin !important;
                scrollbar-color: #000 transparent !important;
            }
            #sc-chat-textarea::-webkit-scrollbar { width: 6px !important; }
            #sc-chat-textarea::-webkit-scrollbar-track { background: transparent !important; }
            #sc-chat-textarea::-webkit-scrollbar-thumb { background: #000 !important; border-radius: 6px !important; }
            #sc-checking {
                font-size: 11px !important; color: rgba(255,255,200,0.6) !important;
                padding: 2px 4px !important; flex-shrink: 0 !important;
            }

            /* ===== REVIEW MODAL ===== */
            #sc-modal-overlay {
                position: fixed !important; inset: 0 !important;
                background: rgba(0,0,0,0.8) !important; z-index: 99999 !important;
                display: flex !important; align-items: center !important;
                justify-content: center !important; font-family: system-ui, sans-serif !important;
            }
            #sc-modal {
                background: #13131f !important; border: 1px solid rgba(255,255,255,0.15) !important;
                border-radius: 12px !important; padding: 20px !important;
                max-width: 520px !important; width: 94vw !important; color: white !important;
                box-shadow: 0 12px 40px rgba(0,0,0,0.7) !important; max-height: 85vh !important;
                overflow-y: auto !important; display: flex !important; flex-direction: column !important; gap: 12px !important;
            }
            #sc-modal-title { font-size: 16px !important; font-weight: 700 !important; color: #f0c040 !important; margin: 0 !important; }
            #sc-readability { display: flex !important; flex-direction: column !important; gap: 4px !important; }
            .sc-readability-issue {
                font-size: 12px !important; color: #ffd080 !important;
                background: rgba(255,200,80,0.08) !important; border-radius: 4px !important; padding: 4px 8px !important;
            }
            #sc-preview-wrap {
                background: rgba(255,255,255,0.05) !important; border: 1px solid rgba(255,255,255,0.1) !important;
                border-radius: 6px !important; padding: 10px 12px !important;
                line-height: 1.6 !important; font-size: 14px !important; color: #e0e0e0 !important; word-break: break-word !important;
            }
            .sc-error-span {
                background: rgba(255,80,80,0.25) !important; border-bottom: 2px solid #ff5555 !important;
                border-radius: 2px !important; cursor: pointer !important; padding: 0 1px !important; transition: background 0.15s !important;
            }
            .sc-error-span:hover { background: rgba(255,80,80,0.45) !important; }
            #sc-error-detail {
                background: rgba(255,255,255,0.04) !important; border-radius: 6px !important;
                padding: 8px 10px !important; font-size: 13px !important; min-height: 36px !important; color: #ccc !important;
            }
            #sc-error-detail:empty { display: none !important; }
            .sc-detail-msg { margin-bottom: 8px !important; color: #ffcccc !important; }
            .sc-detail-actions { display: flex !important; flex-wrap: wrap !important; gap: 6px !important; }
            .sc-sug-btn {
                background: rgba(60,180,100,0.2) !important; color: #90ffa0 !important;
                border: 1px solid rgba(60,200,100,0.4) !important; border-radius: 5px !important;
                padding: 4px 10px !important; cursor: pointer !important; font-size: 12px !important;
            }
            .sc-sug-btn:hover { background: rgba(60,180,100,0.4) !important; }
            .sc-reject-btn {
                background: rgba(255,255,255,0.07) !important; color: #aaa !important;
                border: 1px solid rgba(255,255,255,0.15) !important; border-radius: 5px !important;
                padding: 4px 10px !important; cursor: pointer !important; font-size: 12px !important;
            }
            .sc-reject-btn:hover { background: rgba(255,255,255,0.14) !important; }
            #sc-modal-actions { display: flex !important; gap: 10px !important; justify-content: flex-end !important; }
            #sc-btn-cancel {
                background: rgba(255,255,255,0.08) !important; color: #ccc !important;
                border: 1px solid rgba(255,255,255,0.2) !important; border-radius: 6px !important;
                padding: 7px 16px !important; cursor: pointer !important; font-size: 13px !important;
            }
            #sc-btn-cancel:hover { background: rgba(255,255,255,0.16) !important; }
            #sc-btn-send {
                background: rgba(60,180,100,0.25) !important; color: #90ffa0 !important;
                border: 1px solid rgba(60,200,100,0.5) !important; border-radius: 6px !important;
                padding: 7px 16px !important; cursor: pointer !important; font-size: 13px !important; font-weight: 600 !important;
            }
            #sc-btn-send:hover { background: rgba(60,180,100,0.4) !important; }
            #sc-lt-credit { font-size: 10px !important; color: rgba(255,255,255,0.25) !important; text-align: right !important; }
            #sc-lt-credit a { color: rgba(255,255,255,0.35) !important; }

            /* ===== SETTINGS BUTTON ===== */
            #sc-settings-btn {
                position: fixed !important;
                z-index: 20002 !important;
                background: rgba(255,255,255,0.08) !important;
                color: rgba(255,255,255,0.55) !important;
                border: 1px solid rgba(255,255,255,0.18) !important;
                border-radius: 50% !important;
                width: 28px !important; height: 28px !important;
                padding: 0 !important; font-size: 13px !important;
                cursor: pointer !important;
                display: flex !important; align-items: center !important; justify-content: center !important;
                line-height: 1 !important;
                transition: color 0.3s ease, background 0.3s ease, transform 0.3s ease, opacity 0.3s ease !important;
            }
            #sc-settings-btn:hover {
                color: white !important;
                background: rgba(255,255,255,0.22) !important;
            }
            #sc-settings-btn.sc-bar-dim {
                transform: translateX(60px) !important; opacity: 0 !important; pointer-events: none !important;
            }

            body.sc-horizontal #sc-settings-btn {
                bottom: 6px !important; right: calc(20vw + 116px) !important;
            }
            body.sc-vertical #sc-settings-btn {
                bottom: 43vh !important; right: 116px !important;
            }

            /* ===== SETTINGS MODAL ===== */
            #sc-settings-overlay {
                position: fixed !important; inset: 0 !important;
                background: rgba(0,0,0,0.85) !important;
                z-index: 99998 !important;
                display: flex !important;
                align-items: center !important; justify-content: center !important;
                font-family: system-ui, sans-serif !important;
            }
            #sc-settings-modal {
                background: #0e0e1a !important;
                border: 1px solid rgba(255,255,255,0.15) !important;
                border-radius: 12px !important;
                padding: 24px !important;
                width: min(480px, 94vw) !important;
                color: white !important;
                box-shadow: 0 16px 48px rgba(0,0,0,0.8) !important;
                display: flex !important; flex-direction: column !important; gap: 16px !important;
                max-height: 90vh !important; overflow-y: auto !important;
            }
            #sc-settings-title { font-size: 17px !important; font-weight: 700 !important; color: #c0b0ff !important; }
            .sc-settings-intro {
                font-size: 13px !important; color: rgba(255,255,255,0.6) !important;
                line-height: 1.5 !important;
                background: rgba(255,255,255,0.04) !important;
                border-radius: 6px !important; padding: 8px 10px !important;
            }
            .sc-settings-group { display: flex !important; flex-direction: column !important; gap: 5px !important; }
            .sc-settings-label {
                font-size: 13px !important; font-weight: 600 !important;
                color: rgba(255,255,255,0.85) !important;
                display: flex !important; flex-direction: column !important; gap: 2px !important;
            }
            .sc-settings-note { font-weight: 400 !important; font-size: 11px !important; color: rgba(255,255,255,0.4) !important; }
            .sc-settings-input {
                background: rgba(255,255,255,0.07) !important;
                border: 1px solid rgba(255,255,255,0.2) !important;
                border-radius: 6px !important; color: white !important;
                padding: 8px 10px !important; font-size: 13px !important;
                font-family: monospace !important; outline: none !important;
                width: 100% !important; box-sizing: border-box !important;
            }
            .sc-settings-input:focus { border-color: rgba(192,176,255,0.6) !important; background: rgba(255,255,255,0.1) !important; }
            .sc-settings-input-row { display: flex !important; gap: 8px !important; align-items: stretch !important; }
            .sc-settings-input-row .sc-settings-input { flex: 1 !important; }
            .sc-settings-link { font-size: 11px !important; color: rgba(192,176,255,0.7) !important; text-decoration: none !important; align-self: flex-start !important; }
            .sc-settings-link:hover { color: #c0b0ff !important; text-decoration: underline !important; }
            .sc-settings-toggle-group, .sc-settings-divider { border-top: 1px solid rgba(255,255,255,0.08) !important; padding-top: 12px !important; }
            .sc-settings-toggle-label {
                display: flex !important; flex-direction: column !important; gap: 4px !important;
                cursor: pointer !important; font-size: 13px !important;
                font-weight: 600 !important; color: rgba(255,255,255,0.85) !important;
            }
            .sc-toggle-row { display: flex !important; align-items: center !important; gap: 9px !important; }
            .sc-toggle-row input[type="checkbox"] {
                width: 17px !important; height: 17px !important; margin: 0 !important;
                flex: 0 0 auto !important; cursor: pointer !important; accent-color: #c0b0ff !important;
            }
            .sc-toggle-text { line-height: 1.2 !important; }
            #sc-tmdb-fields { display: flex !important; flex-direction: column !important; gap: 6px !important; margin: 8px 0 0 26px !important; }
            #sc-tmdb-fields.sc-hidden { display: none !important; }
            .sc-settings-range { width: 100% !important; accent-color: #c0b0ff !important; cursor: pointer !important; }
            .sc-font-sample {
                margin-top: 6px !important; padding: 8px 12px !important;
                background: rgba(255,255,255,0.05) !important;
                border: 1px solid rgba(255,255,255,0.1) !important;
                border-radius: 6px !important; color: rgba(255,255,255,0.88) !important;
                line-height: 1.4 !important;
            }
            #sc-settings-actions { display: flex !important; gap: 10px !important; justify-content: flex-end !important; margin-top: 4px !important; }
            #sc-settings-cancel {
                background: rgba(255,255,255,0.08) !important; color: #aaa !important;
                border: 1px solid rgba(255,255,255,0.15) !important;
                border-radius: 6px !important; padding: 8px 18px !important;
                cursor: pointer !important; font-size: 13px !important;
            }
            #sc-settings-cancel:hover { background: rgba(255,255,255,0.14) !important; }
            #sc-settings-save {
                background: rgba(192,176,255,0.2) !important; color: #c0b0ff !important;
                border: 1px solid rgba(192,176,255,0.4) !important;
                border-radius: 6px !important; padding: 8px 18px !important;
                cursor: pointer !important; font-size: 13px !important; font-weight: 600 !important;
            }
            #sc-settings-save:hover { background: rgba(192,176,255,0.35) !important; }
            #sc-settings-status { font-size: 12px !important; color: #7dffa0 !important; text-align: right !important; min-height: 14px !important; }


            /* Poll panel */
            #sc-poll-panel {
                position: fixed !important;
                top: 28px !important;
                right: 5px !important;
                width: calc(19vw - 5px) !important;
                z-index: 19000 !important;
                background: rgba(10,10,20,0.95) !important;
                border: 1px solid rgba(255,255,255,0.12) !important;
                border-radius: 8px !important;
                padding: 12px 14px !important;
                max-width: 100% !important;
                color: rgba(255,255,255,0.88) !important;
                font-size: 13px !important;
                line-height: 1.5 !important;
                box-shadow: 0 8px 32px rgba(0,0,0,0.7) !important;
                font-family: system-ui, sans-serif !important;
            }
            body.sc-vertical #sc-poll-panel {
                right: 0 !important;
                top: auto !important;
                bottom: calc(42vh + 42px) !important;
                max-width: 98vw !important;
            }
            .sc-poll-header {
                font-weight: 600 !important;
                font-size: 14px !important;
                color: #f0c040 !important;
                margin-bottom: 8px !important;
                padding-bottom: 6px !important;
                border-bottom: 1px solid rgba(255,255,255,0.1) !important;
            }
            .sc-poll-option {
                margin-bottom: 6px !important;
                color: rgba(255,255,255,0.82) !important;
                font-size: 13px !important;
            }
            .sc-poll-option a {
                color: #7eb8f7 !important;
                word-break: break-all !important;
            }
            .sc-poll-meta {
                margin-top: 8px !important;
                font-size: 11px !important;
                color: rgba(255,255,255,0.35) !important;
                text-align: right !important;
            }

            #sc-settings-status {
                font-size: 12px !important; color: #90ffa0 !important;
                text-align: center !important; min-height: 16px !important;
            }

            /* ===== NOW PLAYING CARD ===== */
            :root { --np-accent: #ff5b73; }
            #sc-np-card {
                position: fixed !important; inset: 0 !important;
                z-index: 21000 !important;
                background: #000 !important;
                opacity: 0 !important; pointer-events: none !important;
                transition: opacity 0.5s ease !important;
                overflow: hidden !important;
                font-family: system-ui, sans-serif !important;
            }
            #sc-np-card.sc-np-visible { opacity: 1 !important; pointer-events: auto !important; }
            #sc-np-backdrop {
                position: absolute !important; inset: 0 !important;
                background-size: cover !important; background-position: center !important;
                transform: scale(1.05) !important;
                filter: saturate(1.1) !important;
            }
            #sc-np-scrim {
                position: absolute !important; inset: 0 !important;
                background:
                    linear-gradient(90deg, rgba(8,3,6,0.97) 0%, rgba(8,3,6,0.82) 40%, rgba(8,3,6,0.45) 100%),
                    linear-gradient(0deg, rgba(8,3,6,0.95) 0%, rgba(8,3,6,0) 45%) !important;
            }
            #sc-np-content {
                position: absolute !important;
                left: 6% !important; bottom: 12% !important; right: 6% !important;
                display: flex !important; gap: 32px !important; align-items: flex-end !important;
            }
            #sc-np-poster {
                width: 180px !important; border-radius: 10px !important;
                box-shadow: 0 16px 48px rgba(0,0,0,0.8) !important;
                flex-shrink: 0 !important;
            }
            #sc-np-info { color: #fff !important; max-width: 60% !important; }
            #sc-np-eyebrow {
                font-size: 12px !important; font-weight: 700 !important;
                letter-spacing: 0.18em !important; text-transform: uppercase !important;
                color: var(--np-accent, #ff5b73) !important; margin-bottom: 10px !important;
            }
            #sc-np-title {
                font-size: 40px !important; font-weight: 800 !important; line-height: 1.05 !important;
                text-shadow: 0 2px 16px rgba(0,0,0,0.8) !important; margin-bottom: 14px !important;
            }
            #sc-np-meta {
                font-size: 15px !important; color: rgba(255,255,255,0.82) !important;
                margin-bottom: 16px !important; font-weight: 500 !important;
            }
            #sc-np-overview {
                font-size: 14px !important; line-height: 1.5 !important;
                color: rgba(255,255,255,0.72) !important; margin-bottom: 16px !important;
                display: -webkit-box !important; -webkit-line-clamp: 3 !important;
                -webkit-box-orient: vertical !important; overflow: hidden !important;
            }
            #sc-np-chips { display: flex !important; flex-wrap: wrap !important; gap: 8px !important; }
            .sc-np-chip {
                font-size: 12px !important; color: rgba(255,255,255,0.9) !important;
                background: rgba(255,255,255,0.12) !important;
                border: 1px solid rgba(255,255,255,0.18) !important;
                border-radius: 999px !important; padding: 4px 11px !important;
                backdrop-filter: blur(4px) !important;
            }
            .sc-np-chip.sc-sev-none     { background: rgba(120,120,130,0.30) !important; border-color: rgba(160,160,170,0.4) !important; }
            .sc-np-chip.sc-sev-mild     { background: rgba(60,160,80,0.32)  !important; border-color: rgba(90,200,110,0.5) !important; color: #c9ffd4 !important; }
            .sc-np-chip.sc-sev-moderate { background: rgba(200,150,40,0.34)  !important; border-color: rgba(230,180,60,0.55) !important; color: #ffe9b8 !important; }
            .sc-np-chip.sc-sev-severe   { background: rgba(200,60,50,0.38)   !important; border-color: rgba(235,90,80,0.6) !important; color: #ffd2cc !important; }

            /* ===== TRIVIA BUTTON ===== */
            #sc-trivia-btn {
                position: fixed !important;
                z-index: 10003 !important;
                top: 0 !important;
                right: calc(20vw + 150px) !important;
                background: transparent !important;
                border: none !important;
                border-radius: 0 !important;
                color: rgba(255,255,255,0.55) !important;
                font-size: 10px !important;
                letter-spacing: 0.06em !important;
                text-transform: uppercase !important;
                white-space: nowrap !important;
                line-height: 1 !important;
                cursor: pointer !important;
                padding: 2px 8px !important;
                height: 20px !important;
                display: flex !important;
                align-items: center !important;
                transition: opacity 1.5s ease, color 0.2s ease !important;
                opacity: 1 !important;
                pointer-events: auto !important;
            }
            #sc-trivia-btn.sc-bar-dim { opacity: 0 !important; pointer-events: none !important; }
            #sc-trivia-btn:hover { color: rgba(255,255,255,0.9) !important; }
            /* Sit to the left of the Coming Attractions button (which is at right:0),
               same top edge, so the two line up instead of overlapping. */
            body.sc-vertical #sc-trivia-btn { right: 150px !important; top: 0 !important; }

            /* ===== TRIVIA DROPDOWN ===== */
            #sc-trivia-panel {
                position: fixed !important;
                top: 22px !important;
                right: calc(20vw + 90px) !important;
                width: 420px !important;
                max-height: 62vh !important;
                z-index: 21800 !important;
                background: rgba(14,10,18,0.97) !important;
                border: 1px solid rgba(255,255,255,0.14) !important;
                border-radius: 10px !important;
                overflow: hidden !important;
                display: flex !important; flex-direction: column !important;
                box-shadow: 0 12px 40px rgba(0,0,0,0.8) !important;
                font-family: 'Inter','Roboto',system-ui,sans-serif !important;
                animation: sc-trivia-in 0.18s ease !important;
            }
            @keyframes sc-trivia-in {
                from { opacity: 0; transform: translateY(-6px); }
                to   { opacity: 1; transform: translateY(0); }
            }
            #sc-trivia-head {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                padding: 12px 16px !important; border-bottom: 1px solid rgba(255,255,255,0.1) !important;
                flex-shrink: 0 !important;
            }
            #sc-trivia-title { font-size: 13px !important; font-weight: 700 !important; color: var(--np-accent,#ff5b73) !important; }
            #sc-trivia-close {
                background: rgba(255,255,255,0.1) !important; border: none !important; color: #fff !important;
                width: 24px !important; height: 24px !important; border-radius: 50% !important;
                cursor: pointer !important; font-size: 11px !important; flex-shrink: 0 !important;
                display: flex !important; align-items: center !important; justify-content: center !important;
            }
            #sc-trivia-close:hover { background: rgba(255,255,255,0.2) !important; }
            #sc-trivia-list {
                overflow-y: auto !important; padding: 4px 16px 16px !important;
                scrollbar-width: thin !important;
                scrollbar-color: rgba(255,255,255,0.28) transparent !important;
            }
            #sc-trivia-list::-webkit-scrollbar { width: 6px !important; }
            #sc-trivia-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.28) !important; border-radius: 6px !important; }
            .sc-trivia-item {
                color: rgba(255,255,255,0.86) !important; font-size: 13px !important; line-height: 1.5 !important;
                padding: 10px 0 !important; border-bottom: 1px solid rgba(255,255,255,0.07) !important;
            }
            .sc-trivia-item:last-child { border-bottom: none !important; }
            body.sc-vertical #sc-trivia-panel { right: 4px !important; width: min(420px, 95vw) !important; }

            /* ===== SETTINGS TEST BUTTON ===== */
            .sc-settings-test {
                flex-shrink: 0 !important;
                background: rgba(192,176,255,0.15) !important;
                color: #c0b0ff !important;
                border: 1px solid rgba(192,176,255,0.35) !important;
                border-radius: 6px !important;
                padding: 0 16px !important; font-size: 13px !important; font-weight: 600 !important;
                cursor: pointer !important;
            }
            .sc-settings-test:disabled { opacity: 0.5 !important; cursor: default !important; }
            .sc-settings-test-status { font-size: 12px !important; min-height: 14px !important; }
            .sc-test-ok      { color: #7dffa0 !important; }
            .sc-test-bad     { color: #ff8080 !important; }
            .sc-test-pending { color: rgba(255,255,255,0.55) !important; }

            /* ===== CHAT → MOVIE SEEK MENU ===== */
            .sc-seek-menu {
                position: fixed !important;
                z-index: 30000 !important;
                background: rgba(18,18,20,0.97) !important;
                border: 1px solid rgba(255,255,255,0.16) !important;
                border-radius: 8px !important;
                box-shadow: 0 8px 28px rgba(0,0,0,0.55) !important;
                padding: 4px !important;
                min-width: 200px !important;
            }
            .sc-seek-item {
                display: flex !important;
                flex-direction: column !important;
                align-items: flex-start !important;
                gap: 2px !important;
                width: 100% !important;
                background: transparent !important;
                border: none !important;
                border-radius: 6px !important;
                padding: 8px 12px !important;
                cursor: pointer !important;
                text-align: left !important;
            }
            .sc-seek-item:hover { background: rgba(255,200,50,0.15) !important; }
            .sc-seek-main {
                color: #ffcc44 !important;
                font-size: 13px !important; font-weight: 600 !important;
            }
        `;
        document.head.appendChild(style);
    });

})();