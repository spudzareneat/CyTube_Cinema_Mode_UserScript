// ==UserScript==
// @name         CyTube Fullscreen Video with Overlay Chat
// @namespace    http://tampermonkey.net/
// @version      4.10.2
// @description  Fullscreen layout, LanguageTool grammar, inline error editor, tab-complete, movie links, IMDb trivia & parent guide, right-click chat-to-movie seek, Tonight's Lineup schedule overlay, resizable chat panel, vertical monitor support, integrates with cytube.gifmaker.user.js, cytube.chatimages.user.js, and cytube.subtitles.user.js when installed
// @match        https://cytu.be/r/420Grindhouse
// @match        https://cytu.be/r/testing
// @grant        GM_xmlhttpRequest
// @connect      api.themoviedb.org
// @connect      en.wikipedia.org
// @connect      raw.githubusercontent.com
// @connect      api.languagetool.org
// @connect      caching.graphql.imdb.com
// @connect      api.imgbb.com
// @connect      www.reddit.com
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';
    console.log('[SC] cytube.pc v4.10.2 loaded');

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
    const LS_LINEUP_TIMING = 'sc_lineup_timing'; // Experimental: live NOW PLAYING/ETA tracking; off by default
    const LS_CHAT_PANEL_W = 'sc_chat_panel_w';   // vw — horizontal-layout chat panel width
    const LS_CHAT_PANEL_H = 'sc_chat_panel_h';   // vh — vertical-layout chat panel height
    const LS_CHAT_TEXTAREA_H = 'sc_chat_textarea_h'; // px — manually resized chat entry height
    const LS_GIF_OPTIMIZE = 'sc_gif_optimize'; // shared with cytube.gifmaker.user.js
    const LS_AUTOEMBED   = 'sc_autoembed_images';
    const LS_MOVIE_LEAD  = 'sc_movie_lead_sec'; // seconds to run ahead of sync during movies (not YouTube); 0 = off
    const getKey   = id => localStorage.getItem(id) || '';
    const setKey   = (id, v) => localStorage.setItem(id, v.trim());
    const hasKey   = id => !!getKey(id);
    const spellCheckEnabled  = () => getKey(LS_SPELLCHECK)  !== 'off';
    const movieLinksEnabled  = () => getKey(LS_MOVIE_LINKS) !== 'off';
    const lineupTimingEnabled = () => getKey(LS_LINEUP_TIMING) === 'on'; // opt-in, unlike the toggles above
    const gifOptimizeEnabled = () => getKey(LS_GIF_OPTIMIZE) !== 'off'; // default ON, like spellcheck/movielinks
    const autoEmbedEnabled  = () => getKey(LS_AUTOEMBED) !== 'off'; // default ON, like spellcheck/movielinks

    /* ==========================================================
       GIF MAKER INTEGRATION BRIDGE
       cytube.gifmaker.user.js owns the actual GIF capture/encode/
       panel implementation. This script exposes what gifmaker needs
       to adapt when both scripts are installed together: a
       TMDB-aware title slug, and a slot gifmaker fills in with its
       own openGifPanel once it boots. Two separate Tampermonkey
       sandboxes can't see each other's plain `window` properties,
       so this goes on unsafeWindow — the real, shared page window.
       Note: under Firefox's Xray vision, functions exposed via
       unsafeWindow from one userscript sandbox aren't directly
       callable from another sandbox without exportFunction/cloneInto,
       so in practice this bridge only works Chrome-family browsers —
       it degrades gracefully since both consumers null/type-check
       before calling.
    ========================================================== */
    const _uw = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    _uw.__SC_GIF_BRIDGE__ = {
        version: 1,
        getTitleSlug: () => _gifTitleSlug(),
        // Used by cytube.subtitles.user.js to build an OpenSubtitles search
        // link. title/year come from the same source getTitleSlug() uses
        // (always available once a video is playing); imdbId is only set
        // once the Now Playing card's TMDB lookup has resolved for this
        // video (requires a TMDB key -- null otherwise, caller falls back).
        getMovieInfo: () => {
            if (!lastMovieTitle) return null;
            const { title, year } = parseMovieFilename(lastMovieTitle);
            if (!title) return null;
            return { title, year: year || null, imdbId: (_npData && _npData.imdbId) || null };
        },
        openGifPanel: undefined, // filled in by cytube.gifmaker.user.js once it boots
    };

    function getChatFontSize() {
        const v = parseInt(getKey(LS_CHAT_FONT), 10);
        return (Number.isFinite(v) && v >= 10 && v <= 32) ? v : 14;
    }
    const MOVIE_LEAD_MIN = 0, MOVIE_LEAD_MAX = 10, MOVIE_LEAD_DEFAULT = 2;
    function getMovieLeadSec() {
        const v = parseInt(getKey(LS_MOVIE_LEAD), 10);
        return (Number.isFinite(v) && v >= MOVIE_LEAD_MIN && v <= MOVIE_LEAD_MAX) ? v : MOVIE_LEAD_DEFAULT;
    }
    function applyChatFontSize(px) {
        const buf = document.getElementById('messagebuffer');
        if (buf) buf.style.setProperty('font-size', px + 'px', 'important');
        const ta = document.getElementById('sc-chat-textarea');
        if (ta) ta.style.setProperty('font-size', px + 'px', 'important');
    }

    // Chat panel resize — width in horizontal layout, height in vertical layout.
    // Driven entirely through CSS custom properties (--sc-chat-w/--sc-chat-h) so every
    // dependent rule (header, users/poll/trivia panels, floating buttons) tracks the drag.
    const CHAT_PANEL_W_MIN = 12, CHAT_PANEL_W_MAX = 34, CHAT_PANEL_W_DEFAULT = 19;
    const CHAT_PANEL_H_MIN = 22, CHAT_PANEL_H_MAX = 62, CHAT_PANEL_H_DEFAULT = 42;
    function getChatPanelWidth() {
        const v = parseFloat(getKey(LS_CHAT_PANEL_W));
        return (Number.isFinite(v) && v >= CHAT_PANEL_W_MIN && v <= CHAT_PANEL_W_MAX) ? v : CHAT_PANEL_W_DEFAULT;
    }
    function getChatPanelHeight() {
        const v = parseFloat(getKey(LS_CHAT_PANEL_H));
        return (Number.isFinite(v) && v >= CHAT_PANEL_H_MIN && v <= CHAT_PANEL_H_MAX) ? v : CHAT_PANEL_H_DEFAULT;
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

    // If LanguageTool hasn't responded within this long, give up waiting
    // and send the message unchecked rather than block the user.
    const LT_TIMEOUT_MS = 3000;

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
        const ltMatches = await Promise.race([
            checkGrammar(text),
            new Promise(resolve => setTimeout(() => resolve(null), LT_TIMEOUT_MS)),
        ]);
        showCheckingIndicator(textarea, false);

        // Timed out waiting on LanguageTool — don't block sending on it.
        if (ltMatches === null) {
            doSend(textarea, originalInput, text);
            return;
        }

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

        textarea.value = '';
        // Clearing the value would otherwise leave the auto-grow height from the
        // sent message in place; restore the user's manually-resized height (if
        // any) instead of the default, rather than wiping it back to min-height.
        const savedTaH = parseFloat(getKey(LS_CHAT_TEXTAREA_H));
        textarea.style.height = (Number.isFinite(savedTaH) && savedTaH >= 44) ? savedTaH + 'px' : '';
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

        // Drag handle above the textarea — lets the user pick a fixed height,
        // which then overrides the auto-grow-while-typing behavior below.
        const taResizer = document.createElement('div');
        taResizer.id = 'sc-chat-ta-resizer';

        originalInput.parentElement.insertBefore(taResizer, originalInput.nextSibling);
        originalInput.parentElement.insertBefore(textarea, taResizer.nextSibling);

        const taHeightMax = () => window.innerHeight * 0.5;
        let manualHeight = null;
        const savedTaH = parseFloat(getKey(LS_CHAT_TEXTAREA_H));
        if (Number.isFinite(savedTaH) && savedTaH >= 44 && savedTaH <= taHeightMax()) {
            manualHeight = savedTaH;
            textarea.style.height = manualHeight + 'px';
        }

        textarea.addEventListener('input', () => {
            tabCandidates = [];
            lastChatlineValue = originalInput.value;
            if (manualHeight == null) {
                textarea.style.height = 'auto';
                textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
            }
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

        let taDragging = false, taStartY, taStartH;
        taResizer.addEventListener('mousedown', e => {
            e.preventDefault();
            taDragging = true;
            taStartY = e.clientY;
            taStartH = textarea.getBoundingClientRect().height;
            taResizer.classList.add('sc-resizing');
            document.body.style.userSelect = 'none';
        });
        window.addEventListener('mousemove', e => {
            if (!taDragging) return;
            const h = Math.min(taHeightMax(), Math.max(44, taStartH + (taStartY - e.clientY)));
            manualHeight = h;
            textarea.style.height = h + 'px';
        });
        window.addEventListener('mouseup', () => {
            if (!taDragging) return;
            taDragging = false;
            taResizer.classList.remove('sc-resizing');
            document.body.style.userSelect = '';
            setKey(LS_CHAT_TEXTAREA_H, String(manualHeight));
        });

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

    const _desync = { active: false, saved: null, btn: null, anchorPos: null, anchorWall: null, markerTimer: null };

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
        if (on) {
            // Anchor captured BEFORE freezing so it reflects the still-live position.
            _desync.anchorPos = getPlayerTimeSec();
            _desync.anchorWall = Date.now();
            _freezeSync();
        } else {
            _thawSync();
            _desync.anchorPos = null;
            _desync.anchorWall = null;
        }
        const btn = _desync.btn;
        if (btn) {
            btn.classList.toggle('sc-desync-active', on);
            btn.title = on ? 'Free watch ON — click to re-sync'
                           : 'Free watch — click to watch freely, click again to re-sync';
        }
        // Force the floating button row visible: immediately on entering desync (so
        // the active desync button is never hidden by idle-fade), and once more on
        // exit (gapHide's own guard stops re-hiding it early while still desynced).
        if (_gapShow) _gapShow();
        // Keep video.js's own control bar (the scrubber) from idle-fading while
        // desynced — see the body.sc-desynced override in the stylesheet.
        document.body.classList.toggle('sc-desynced', on);
        clearInterval(_desync.markerTimer);
        _desync.markerTimer = on ? setInterval(updateSyncMarker, 500) : null;
        updateSyncMarker();
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
       MOVIE LEAD TIME — run N seconds ahead of the group's synced
       position during movies (not YouTube). Cushions against the
       user's own buffering: if playback stalls, the next mediaUpdate
       correction pushes back up to "group position + lead" instead
       of merely "group position".

       Rather than nudging video.currentTime ourselves (which would
       fight CyTube's own drift correction), an interceptor is
       prepended to the same mediaUpdate listener array _freezeSync/
       _thawSync above already know how to locate — it adds the
       configured lead to the payload's currentTime before CyTube's
       own handler(s) see it, so CyTube's normal seek/smoothing logic
       settles the player the configured amount ahead. This composes
       with desync for free: _freezeSync freezes whatever's registered
       under the mediaUpdate key (the interceptor, wrapping CyTube's
       real handlers) as one unit, and _thawSync restores it as-is.
    ========================================================== */

    function installMovieLeadInterceptor() {
        const loc = _getMediaUpdateListeners();
        if (!loc) { console.log('[SC] movie-lead: mediaUpdate listeners not found yet, will retry'); return false; }
        const original = loc.store === '_callbacks' ? socket._callbacks[loc.key] : socket._events[loc.key];
        const originalList = Array.isArray(original) ? original : (original ? [original] : []);
        console.log(`[SC] movie-lead: installing interceptor via ${loc.store}, wrapping ${originalList.length} existing listener(s)`);

        function interceptor(data) {
            try {
                const lead = getMovieLeadSec();
                if (lead > 0 && !isYouTubeMedia() && typeof data?.currentTime === 'number') {
                    data.currentTime += lead;
                }
            } catch (e) {}
            for (const fn of originalList) fn(data);
        }

        if (loc.store === '_callbacks') socket._callbacks[loc.key] = [interceptor];
        else socket._events[loc.key] = interceptor;
        return true;
    }

    function initMovieLeadOffset() {
        let tries = 0;
        const poll = setInterval(() => {
            if (typeof socket === 'undefined' || !socket) {
                if (++tries >= 14) { console.log('[SC] movie-lead: gave up, socket never became available'); clearInterval(poll); }
                return;
            }
            const ok = installMovieLeadInterceptor();
            if (ok) { console.log('[SC] movie-lead: interceptor installed successfully'); }
            if (ok || ++tries >= 14) {
                if (!ok) console.log('[SC] movie-lead: gave up after max retries, interceptor not installed');
                clearInterval(poll);
            }
        }, 1500);
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

    // The group's live synced position, right now. When not desynced this IS the
    // player's own time (CyTube keeps it live). While desynced, CyTube's own
    // mediaUpdate listeners are frozen (see _freezeSync), so we extrapolate forward
    // from the position captured at the moment desync began, assuming uninterrupted
    // playback — same trade-off seekTargetForMsgTime() below already makes for the
    // chat-to-movie seek feature.
    function getSyncedTimeNow() {
        if (!_desync.active) return getPlayerTimeSec();
        if (_desync.anchorPos == null) return getPlayerTimeSec();
        return _desync.anchorPos + (Date.now() - _desync.anchorWall) / 1000;
    }

    // A marker on video.js's own seek bar showing where the live synced position is,
    // separate from the playhead (which shows wherever you've scrubbed to while
    // desynced). Only meaningful while desynced — hidden otherwise.
    function ensureSyncMarkerEl() {
        const holder = document.querySelector('.video-js .vjs-progress-holder');
        if (!holder) return null;
        let mark = holder.querySelector('#sc-sync-marker');
        if (!mark) {
            mark = document.createElement('div');
            mark.id = 'sc-sync-marker';
            holder.appendChild(mark);
        }
        return mark;
    }

    function updateSyncMarker() {
        const mark = ensureSyncMarkerEl();
        if (!mark) return;
        const duration = _desync.active ? getCurrentMediaSeconds() : 0;
        const syncedNow = _desync.active ? getSyncedTimeNow() : null;
        if (!duration || syncedNow == null) {
            mark.style.display = 'none';
            return;
        }
        mark.style.left = Math.max(0, Math.min(100, (syncedNow / duration) * 100)) + '%';
        mark.style.display = 'block';
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

        const jumpItem = document.createElement('button');
        jumpItem.type = 'button';
        jumpItem.className = 'sc-seek-item';
        jumpItem.innerHTML = `<span class="sc-seek-main">⤺ Jump movie to ${_fmtClock(targetSec)}</span>`;
        jumpItem.addEventListener('click', () => {
            setDesynced(true);
            seekPlayerTo(targetSec);
            hideChatSeekMenu();
        });
        menu.appendChild(jumpItem);

        const gifBridge = _uw.__SC_GIF_BRIDGE__;
        if (gifBridge && typeof gifBridge.openGifPanel === 'function') {
            const gifItem = document.createElement('button');
            gifItem.type = 'button';
            gifItem.className = 'sc-seek-item';
            gifItem.innerHTML = `<span class="sc-seek-main">◉ Create a GIF from here</span>`;
            gifItem.addEventListener('click', () => {
                hideChatSeekMenu();
                gifBridge.openGifPanel(targetSec);
            });
            menu.appendChild(gifItem);
        }

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
            if (e.target.closest && e.target.closest('.sc-img-embed')) return;
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

    // Filesystem/URL-safe slug of the currently playing movie, e.g. "Blade-Runner-1982".
    // Falls back to '' when no title has been detected yet.
    function _gifTitleSlug() {
        if (!lastMovieTitle) return '';
        const { title, year } = parseMovieFilename(lastMovieTitle);
        let slug = title.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
        if (year) slug += '-' + year;
        return slug;
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
        if (el) { const t = parseTimeToSeconds(el.textContent); if (t > 0) return t; }
        // Last resort: the actual <video> element's own reported duration -- real and accurate
        // (confirmed live 2026-07-19 against the true remaining runtime) whenever CyTube plays a
        // same-origin file directly, covering exactly what the two checks above miss: a page
        // loaded mid-movie, before any changeMedia event has arrived to populate
        // currentMediaSeconds. Doesn't help for YouTube embeds -- the player's <video> tag lives
        // inside a cross-origin iframe, unreachable from here -- those still fall through to 0.
        const v = getPlayerVideoEl();
        if (v && isFinite(v.duration) && v.duration > 0) return v.duration;
        return 0;
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
        const knownSeconds = getCurrentMediaSeconds();
        lineupObserveTitleChange(rawTitle, knownSeconds > 0 ? knownSeconds : null);
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
                    // Authoritative lineup match straight from the raw socket payload, ahead of
                    // (and independent from) the DOM-title path below -- see
                    // lineupObserveTitleChange's own comment for why this matters.
                    if (data && data.title) lineupObserveTitleChange(data.title, data.seconds);
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

    // 'T' = trivia, 'I' = movie info card, arrows/space = YouTube-style seek — from
    // anywhere when not typing.
    const ARROW_SEEK_STEP_SEC = 5;
    document.addEventListener('keydown', (e) => {
        const t = e.target;
        if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
        if (e.key === 't' || e.key === 'T') { toggleTriviaPanel(); return; }
        if (e.key === 'Escape') { hideTriviaCard(); hideNowPlayingCard(); hideLineupScreen(); return; }
        if (e.key === 'i' || e.key === 'I') {
            const card = document.getElementById('sc-np-card');
            if (card && card.classList.contains('sc-np-visible')) hideNowPlayingCard();
            else if (_npData) showNowPlayingCard(_npData, { autoHide: false });
            return;
        }
        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            const pos = getPlayerTimeSec();
            if (pos == null) return;
            if (!_desync.active) setDesynced(true);
            seekPlayerTo(Math.max(0, pos - ARROW_SEEK_STEP_SEC));
            return;
        }
        if (e.key === 'ArrowRight') {
            e.preventDefault();
            if (!_desync.active) return; // already at the live edge — nothing to catch up to
            const pos = getPlayerTimeSec();
            const syncedNow = getSyncedTimeNow();
            if (pos == null || syncedNow == null) return;
            const target = Math.min(pos + ARROW_SEEK_STEP_SEC, syncedNow);
            seekPlayerTo(target);
            if (target >= syncedNow - 0.15) setDesynced(false);
            return;
        }
        if (e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            if (!_desync.active) return;
            const syncedNow = getSyncedTimeNow();
            setDesynced(false);
            if (syncedNow != null) seekPlayerTo(syncedNow);
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
        if (_uw.CLIENT && _uw.CLIENT.name && u === _uw.CLIENT.name) {
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
            const u = cls.replace('chat-msg-', '');
            const span = el.querySelector('.username');
            if (span) { span.style.color = usernameToColor(u); span.style.fontWeight = '700'; }
            el.classList.toggle('sc-own-msg', !!(_uw.CLIENT && _uw.CLIENT.name && u === _uw.CLIENT.name));
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
        const leadSec  = getMovieLeadSec();

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

                        <label class="sc-settings-toggle-label sc-settings-divider">
                            <span class="sc-toggle-row">
                                <input type="checkbox" id="sc-input-lineuptiming" ${lineupTimingEnabled() ? 'checked' : ''} />
                                <span class="sc-toggle-text">Coming Attractions live timing (Experimental)</span>
                            </span>
                            <span class="sc-settings-note">Shows NOW PLAYING and estimated start times in Tonight's Lineup. Needs TMDB above for movie runtimes — without it, estimates can't guess well. Off by default, still being tuned.</span>
                        </label>
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

                <div class="sc-settings-group sc-settings-toggle-group">
                    <label class="sc-settings-toggle-label">
                        <span class="sc-toggle-row">
                            <input type="checkbox" id="sc-input-autoembed" ${autoEmbedEnabled() ? 'checked' : ''} />
                            <span class="sc-toggle-text">Auto-embed image links in chat</span>
                        </span>
                        <span class="sc-settings-note">Shows a thumbnail preview under messages that link directly to an image, marked "🖼 embedded" (requires cytube.chatimages.user.js)</span>
                    </label>
                </div>

                <div class="sc-settings-group sc-settings-toggle-group">
                    <label class="sc-settings-toggle-label">
                        <span class="sc-toggle-row">
                            <input type="checkbox" id="sc-input-gifoptimize" ${gifOptimizeEnabled() ? 'checked' : ''} />
                            <span class="sc-toggle-text">Optimize GIFs before upload</span>
                        </span>
                        <span class="sc-settings-note">Losslessly shrinks the file with gifsicle before Download/Upload — adds a couple seconds (requires cytube.gifmaker.user.js)</span>
                    </label>
                </div>

                <div class="sc-settings-group sc-settings-divider">
                    <label class="sc-settings-label">
                        ImgBB GIF upload
                        <span class="sc-settings-note">Optional — lets the ☁ Upload button in the GIF maker host a GIF and give you a shareable link (requires cytube.gifmaker.user.js)</span>
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

                <div class="sc-settings-group sc-settings-toggle-group">
                    <label class="sc-settings-label">
                        Movie lead time (seconds ahead of sync)
                        <span class="sc-settings-note">Keeps you a few seconds ahead of the group during movies (not YouTube) — cushions against your own buffering. 0 = off.</span>
                    </label>
                    <input id="sc-input-leadsec" class="sc-settings-input" type="number" min="${MOVIE_LEAD_MIN}" max="${MOVIE_LEAD_MAX}" step="1" value="${leadSec}" style="width:5em" />
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
            const lineupTiming = document.getElementById('sc-input-lineuptiming').checked;
            const gifOptimize = document.getElementById('sc-input-gifoptimize').checked;
            const autoEmbed = document.getElementById('sc-input-autoembed').checked;
            const imgbb  = document.getElementById('sc-input-imgbb').value.trim();
            const fontPx = parseInt(fontInput.value, 10);
            const leadSecInput = parseInt(document.getElementById('sc-input-leadsec').value, 10);
            const leadSec = Math.min(MOVIE_LEAD_MAX, Math.max(MOVIE_LEAD_MIN, Number.isFinite(leadSecInput) ? leadSecInput : MOVIE_LEAD_DEFAULT));
            setKey(LS_TMDB,        tmdb);
            setKey(LS_SPELLCHECK,  spell ? 'on' : 'off');
            setKey(LS_MOVIE_LINKS, links ? 'on' : 'off');
            setKey(LS_LINEUP_TIMING, lineupTiming ? 'on' : 'off');
            setKey(LS_GIF_OPTIMIZE, gifOptimize ? 'on' : 'off');
            setKey(LS_AUTOEMBED,   autoEmbed ? 'on' : 'off');
            setKey(LS_IMGBB,       imgbb);
            setKey(LS_CHAT_FONT,   String(fontPx));
            applyChatFontSize(fontPx);
            setKey(LS_MOVIE_LEAD,  String(leadSec));
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

    // Extracts every <entry> in the feed, in feed order. Reddit does NOT reliably sort
    // the current/pinned schedule post first -- confirmed live 2026-07-22: an already-
    // expired "Fri 7/17 - Sun 7/19" post sat in entry #0 all week while the brand-new
    // "Fri 7/24 - Sun 7/26" post (published same day) sat in entry #1 behind it,
    // apparently ordered by pin slot rather than recency/validity. lineupSelectCurrentEntry
    // (below) is what actually picks the right one; this just extracts every candidate.
    function lineupParseEntries(feedXml) {
        const entries = [];
        let searchFrom = 0;
        while (true) {
            const start = feedXml.indexOf('<entry>', searchFrom);
            if (start === -1) break;
            const end = feedXml.indexOf('</entry>', start);
            if (end === -1) break;
            const entry = feedXml.slice(start, end + '</entry>'.length);
            searchFrom = end + '</entry>'.length;
            const idM = entry.match(/<id>([^<]+)<\/id>/);
            const titleM = entry.match(/<title>([^<]+)<\/title>/);
            const contentM = entry.match(/<content type="html">([\s\S]*?)<\/content>/);
            if (!idM || !titleM || !contentM) continue;
            const pubM = entry.match(/<published>([^<]+)<\/published>/);
            entries.push({
                postId: idM[1],
                title: lineupDecodeHtmlEntities(titleM[1]),
                publishedAt: pubM ? pubM[1] : null,
                contentHtml: lineupDecodeHtmlEntities(contentM[1]),
            });
        }
        return entries;
    }

    // Kept for parity with the Android app's parseFirstEntry -- just the first extracted
    // entry, no attempt to pick the *right* one (see lineupSelectCurrentEntry for that).
    // Returns null if the feed has no entries or is missing a required field.
    function lineupParseFirstEntry(feedXml) {
        return lineupParseEntries(feedXml)[0] || null;
    }

    // The pinned schedule post is expected within the top 3 feed entries; scanning a
    // couple extra costs nothing and covers a mod re-pin landing it one slot further out.
    const LINEUP_CANDIDATE_SCAN_LIMIT = 5;

    // Picks the actual current schedule post out of the top of the feed: of the entries
    // whose title looks like a schedule post (lineupParseDateRange returns non-null --
    // filters out unrelated posts like "4 Days" or a single-film announcement), the one
    // published most recently wins. Confirmed live 2026-07-22: the correct post is always
    // the newest one, even when an older, already-expired schedule post happens to sort
    // ahead of it in raw feed order (seen that day -- last weekend's post stayed in entry
    // #0 while this weekend's, published same-day, sat in entry #1).
    function lineupSelectCurrentEntry(entries) {
        let best = null;
        for (const entry of entries.slice(0, LINEUP_CANDIDATE_SCAN_LIMIT)) {
            if (!lineupParseDateRange(entry.title, entry.publishedAt)) continue; // not a schedule post
            if (!best || new Date(entry.publishedAt) > new Date(best.publishedAt)) best = entry;
        }
        return best;
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
            if (!display) continue;
            const [primary, ...akaParts] = display.split(/\s+aka\s+/i);
            const akas = akaParts
                .map(a => a.replace(/\s*\(\d{4}\)\s*$/, '').trim())
                .filter(Boolean);
            // Non-greedy up to the FIRST "(YYYY)" -- tolerates trailing typos/garbage after
            // it (confirmed live 2026-08-07: a mod typo left "Decampitated (1998))" with an
            // extra closing paren, which the old exact-end-anchored regex rejected outright).
            const ym = primary.trim().match(/^(.*?)\s*\((\d{4})\)/);
            if (ym) {
                items.push({ title: ym[1].trim(), year: ym[2], display, akas });
            } else {
                // No parseable year at all (missing, or a format this parser doesn't
                // recognize) -- still show it instead of silently vanishing the film from
                // the lineup. TMDB lookup runs yearless off the raw text; the card just
                // won't have a poster/overview if that search comes up empty too.
                console.warn('[SC] lineup: could not parse title/year from schedule item, showing raw text:', display);
                items.push({ title: primary.trim(), year: null, display, akas });
            }
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
                // Mods sometimes wrap the day header in extra markdown emphasis inside the
                // bold ("==Friday=="), which survives entity-decoding as literal '=' characters
                // -- strip any leading/trailing non-letters before comparing so decoration
                // doesn't stop currentDay from ever being set (confirmed live 2026-08-07: an
                // "==Friday==" header silently produced zero parsed days). The cleaned name,
                // not the decorated text, is stored so dateByDay's Friday/Saturday/Sunday
                // lookup in fetchTonightsSchedule still matches.
                const dayName = text.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
                if (LINEUP_DAY_NAMES.includes(dayName)) {
                    currentDay = { day: dayName, sections: [] };
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
        const entries = lineupParseEntries(res.responseText);
        if (!entries.length) throw new Error('no entries found in feed');
        const entry = lineupSelectCurrentEntry(entries);
        if (!entry) throw new Error('no schedule post found in feed');
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
    //
    // The gap immediately before a film is section-aware: sectionOf[idx] is that film's
    // section index, and a transition where it differs from sectionOf[idx - 1] (crossing into
    // a new named block) uses crossSectionGapSeconds instead of sameSectionGapSeconds -- a
    // section break tends to run a whole separate bumper reel (several short clips back to
    // back), not one bumper's worth of gap, so a single pooled gap can badly underestimate
    // exactly those transitions. sectionOf is optional; omitting it treats every film as one
    // section (every gap is "same-section").
    function lineupMakeGapMsFor(sectionOf, sameSectionGapSeconds, crossSectionGapSeconds) {
        return (idx) => {
            const crossing = sectionOf && idx > 0 && idx < sectionOf.length
                && sectionOf[idx] !== sectionOf[idx - 1];
            return (crossing ? crossSectionGapSeconds : sameSectionGapSeconds) * 1000;
        };
    }

    function lineupEstimateDayItems({
        nowMs, anchorMs, runtimesMin, sectionOf, sameSectionGapSeconds, crossSectionGapSeconds,
        dayStatus, currentIndex, remainingSec, furthestPlayedIndex, bumperStartMs,
    }) {
        const gapMsFor = lineupMakeGapMsFor(sectionOf, sameSectionGapSeconds, crossSectionGapSeconds);
        const runtimeMs = (i) => (runtimesMin[i] ? runtimesMin[i] * 60000 : 0);
        // A film with no TMDB runtime match contributes zero minutes to the walk, which would
        // otherwise make the NEXT film's ETA silently identical to this one's. Once an
        // unknown-runtime film enters the walk, every ETA past it is built on a genuinely
        // unknown gap -- more honest to withhold those than show a confident-looking guess, so
        // `confident` latches false once tripped and every later film in this branch goes blank.
        const runtimeUnknown = (i) => runtimesMin[i] == null;
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
            cursor += runtimeMs(i) + gapMsFor(i + 1);
        });

        if (dayStatus === 'today' && currentIndex >= 0) {
            // Live anchor: walk forward from the current film's remaining runtime. remainingSec
            // is null when the duration isn't known yet (e.g. joined mid-film, before the next
            // changeMedia arrives) -- treat that as "no live data" rather than letting it read as
            // 0 (which would otherwise mean "wrapping up right now" and anchor the next film's ETA
            // to nowMs+gap, a confident-looking but bogus guess).
            let cumulative = remainingSec != null ? Math.max(0, remainingSec) * 1000 : 0;
            let confident = remainingSec != null;
            return runtimesMin.map((_, idx) => {
                if (idx === currentIndex) return { ...blank, isNowPlaying: true };
                if (idx < currentIndex || idx <= furthestPlayedIndex) return { ...blank, played: true };
                const offset = idx - currentIndex;
                cumulative += gapMsFor(idx);
                const withEta = offset <= LINEUP_MAX_ESTIMATED_AHEAD && confident
                    ? { ...blank, etaMs: nowMs + cumulative, precision: offset === 1 ? 'exact' : 'approx' }
                    : { ...blank };
                if (runtimeUnknown(idx)) confident = false;
                cumulative += runtimeMs(idx);
                return withEta;
            });
        }

        if (dayStatus === 'today' && furthestPlayedIndex >= 0) {
            // Bumper between films (or a title we failed to match): the furthest observed
            // film has finished; keep estimating from when the unmatched item started.
            let cumulative = (bumperStartMs != null ? bumperStartMs : nowMs) + gapMsFor(furthestPlayedIndex + 1);
            let confident = true; // the bumper/now anchor itself is live data, always trusted
            return runtimesMin.map((_, idx) => {
                if (idx <= furthestPlayedIndex) return { ...blank, played: true };
                const offset = idx - furthestPlayedIndex;
                const withEta = offset <= LINEUP_MAX_ESTIMATED_AHEAD && confident ? { ...blank, etaMs: cumulative } : { ...blank };
                if (runtimeUnknown(idx)) confident = false;
                cumulative += runtimeMs(idx) + gapMsFor(idx + 1);
                return withEta;
            });
        }

        // No observation at all: future day, today's pre-show, or joined-late today.
        // Gray by projected end; guess starts for the next LINEUP_MAX_PRE_SHOW unstarted
        // films. A film straddling `now` is left unmarked -- probably playing, unconfirmed.
        let guesses = 0;
        let confident = true;
        return runtimesMin.map((_, idx) => {
            const p = projected[idx];
            if (dayStatus === 'today') {
                if (p.endMs < nowMs) return { ...blank, played: true };
                if (p.startMs <= nowMs) return { ...blank };
            }
            if (guesses < LINEUP_MAX_PRE_SHOW && confident) {
                guesses++;
                if (runtimeUnknown(idx)) confident = false;
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

    // Bebas Neue isn't a section theme -- it's the ETA/"NOW PLAYING" caption face.
    // Alfa Slab One isn't a section theme either -- it's the day-tab ticket-stub face.
    const LINEUP_FONT_FAMILIES = ['Boogaloo', 'Chewy', 'Creepster', 'Rubik+Wet+Paint', 'Monoton', 'Vast+Shadow', 'Cinzel', 'Eater', 'Bungee+Shade', 'Bebas+Neue', 'Alfa+Slab+One'];
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

    // Chat/UI text face -- Inter, tuned for legibility at small sizes (tall x-height,
    // open counters). Loaded once up front since chat is visible from page load,
    // unlike the on-demand Lineup theme fonts above.
    const CHAT_FONT_LINK_ID = 'sc-chat-font';
    function ensureChatFontLoaded() {
        if (document.getElementById(CHAT_FONT_LINK_ID)) return;
        const link = document.createElement('link');
        link.id = CHAT_FONT_LINK_ID;
        link.rel = 'stylesheet';
        link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap';
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
       (lineupEstimateDayItems above) each day's TMDB runtimes, section boundaries, the
       learned same-section and cross-section median bumper gaps, the confirmed
       now-playing film, and the persisted furthest-played marker -- yielding per-film
       ETAs (live-anchored, bumper-anchored, or projected
       from that day's Noon-Pacific showtime start) plus a played flag that grays
       already-shown posters. Falls back to the current title plus the static
       admin-curated MOTD poster art if the fetch fails and no usable cache exists.
       Ported from the Android app's web/src/lineup/data.js.
    ========================================================== */

    const LS_LINEUP_CACHE = 'sc_lineup_cache_v1';
    const LS_LINEUP_PROGRESS = 'sc_lineup_progress_v1'; // furthest film observed playing today
    const LS_LINEUP_GAP_SAME_SECTION = 'sc_lineup_gap_same_v1';   // learned same-section bumper gaps (s), across nights
    const LS_LINEUP_GAP_CROSS_SECTION = 'sc_lineup_gap_cross_v1'; // learned cross-section bumper gaps (s), across nights
    const LS_LINEUP_LAST_SECTION = 'sc_lineup_last_section_v1';   // section of the most recently matched film today
    const LINEUP_GAP_SAMPLE_CAP = 40; // bound stored sample count; oldest drop off so habits can drift over time
    // A film whose title fails to match the schedule (e.g. an unusual acronym/punctuation the
    // filename parser mangles) plays out as "unmatched" for its entire runtime, same as a real
    // bumper. If the NEXT title does match, that whole runtime would get miscounted as one giant
    // "gap" and corrupt the learned median (confirmed live on the Android sibling app: a real
    // ~97-min movie became a persisted 119.6-min "gap" sample). Real observed gaps run a few
    // minutes to low teens, so anything past this is far more likely a match failure than
    // genuine bumper time -- discard it rather than learn from it.
    const LINEUP_MAX_PLAUSIBLE_GAP_SECONDS = 30 * 60;
    // Symmetric floor: a gap under a few seconds is far more likely a spurious title-observer
    // blip (the header's MutationObserver re-firing on an unrelated DOM change, briefly
    // re-processing the same or a transient title) than a real bumper block -- confirmed live
    // 2026-07-19: a 0.419s "gap" got learned and, being the only sample, poisoned both the
    // same-section median AND the cross-section estimate (which falls back to the same-section
    // one when it has no samples of its own), collapsing the ETA for everything past the current
    // film to roughly zero padding.
    const LINEUP_MIN_PLAUSIBLE_GAP_SECONDS = 15;
    // lineupItemMatchesTitle compares title text only (no year), so any unrelated content that
    // happens to share a scheduled item's exact title -- a trailer, promo, or bumper referencing
    // the same film -- false-positive matches it. A real feature presentation runs well past
    // this; a short clip doesn't, so reject the match instead of trusting it (confirmed live
    // 2026-07-19 on the sibling Android app: a stray title collision permanently corrupted the
    // played-progress marker, graying out films hours ahead of the real one playing). Checked
    // against the socket's own declared duration (d.seconds), available immediately -- no need
    // to wait and see how long it actually plays. Doesn't catch a coincidental FULL-length
    // rerun of unrelated content under the same title; only short-clip collisions.
    const LINEUP_MIN_PLAUSIBLE_FEATURE_SECONDS = 10 * 60;
    const LINEUP_CACHE_MAX_AGE_MS = 20 * 60 * 60 * 1000; // background-revalidate if older than this
    const LINEUP_FALLBACK_TITLE = 'Coming Attractions';
    const LINEUP_PROGRESS_CONFIRM_MS = 5 * 60 * 1000; // a match this brief was a queue jump, not a showing

    let _lineupScheduleCache = null;     // {postId, title, publishedAt, days, fetchedAt} or null
    let _lineupFetchFailed = false;      // sticky for the session once Reddit is unreachable AND no cache at all
    let _lineupRevalidating = false;
    let _lineupLastUnmatchedStart = null; // Date.now() when the current unmatched (bumper) BLOCK started
    let _lineupPendingProgress = null;   // {idx, since} -- a matched film not yet current long enough to count as played
    let _lineupCurrentMatchedFlatIndex = -1; // flat index of whatever's playing RIGHT NOW per the
                                              // socket-driven match below; -1 when unmatched
    let _lineupLastObservedRawTitle = null;  // self-dedup guard so lineupObserveTitleChange is safe
                                              // to call from both the socket handler (authoritative,
                                              // immediate) and the DOM-title fallback without double-processing

    // Learned bumper-gap samples (s), split by whether the gap crossed a section boundary --
    // a section break (e.g. "Funky Cheese Friday" -> "Grindhouse-A-Go-Go") tends to run a whole
    // separate bumper reel (several short clips back to back), not just one bumper's worth of
    // gap, so pooling them with ordinary same-section gaps can badly underestimate exactly those
    // transitions. Persisted to localStorage (uncapped by date, unlike the played-progress
    // marker) so the learned habit survives a page reload instead of resetting to empty.
    function lineupReadGapSamples(key) {
        try {
            const raw = JSON.parse(localStorage.getItem(key));
            return Array.isArray(raw) ? raw.filter(n => typeof n === 'number' && n >= 0) : [];
        } catch (e) { return []; }
    }
    function lineupPushGapSample(key, arr, sec) {
        arr.push(sec);
        if (arr.length > LINEUP_GAP_SAMPLE_CAP) arr.shift();
        try { localStorage.setItem(key, JSON.stringify(arr)); }
        catch (e) { /* storage full/unavailable -- in-memory sample for this session still works */ }
    }
    let _lineupObservedSameSectionGaps = lineupReadGapSamples(LS_LINEUP_GAP_SAME_SECTION);
    let _lineupObservedCrossSectionGaps = lineupReadGapSamples(LS_LINEUP_GAP_CROSS_SECTION);

    // Section index of the most recently matched film seen today -- the "coming from" context
    // a gap needs to be classified same- vs cross-section. Persisted (date-scoped, like the
    // played-progress marker) so a page reload landing mid-bumper-block doesn't lose it and
    // silently drop that gap sample entirely.
    function lineupReadLastMatchedSection() {
        try {
            const p = JSON.parse(localStorage.getItem(LS_LINEUP_LAST_SECTION));
            return p && p.date === lineupPacificDateString() && typeof p.section === 'number' ? p.section : -1;
        } catch (e) { return -1; }
    }
    function lineupWriteLastMatchedSection(section) {
        try { localStorage.setItem(LS_LINEUP_LAST_SECTION, JSON.stringify({ date: lineupPacificDateString(), section })); }
        catch (e) { /* storage full/unavailable -- gap classification just skips until the next real match */ }
    }
    let _lineupLastMatchedSection = lineupReadLastMatchedSection();

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

    // Today's items flattened WITH each one's section index attached -- needed both to
    // classify an observed gap as same-section vs cross-section, and to locate a matched
    // title's flat index for the played-progress marker.
    function lineupFlatTodayWithSection(sched) {
        const today = sched && sched.days.find(day => day.date === lineupPacificDateString());
        if (!today) return [];
        const flat = [];
        today.sections.forEach((section, si) => section.items.forEach(item => flat.push({ si, item })));
        return flat;
    }

    // Learn bumper-gap duration live: the time from the FIRST unmatched title change after
    // a feature to the next matched one is one observed gap sample -- the whole bumper
    // block, not just its last item (resetting per-item makes the median absurdly small on
    // multi-bumper blocks). Classified same-section vs cross-section by comparing the
    // newly-matched film's section to whatever section was last confirmed playing, and pushed
    // into the matching persisted sample list (gaps implausibly longer than any real bumper
    // block get discarded instead -- see LINEUP_MAX_PLAUSIBLE_GAP_SECONDS). Matched titles in
    // TODAY's day also advance the persisted played-progress marker (via the confirm-delay
    // above) and set _lineupCurrentMatchedFlatIndex, the authoritative "what's airing right
    // now" signal lineupBuildDaySections prefers over the DOM-title heuristic (see there for
    // why). Self-dedupes on rawTitle so it's safe to call both from the socket's changeMedia
    // handler (authoritative, immediate) and from injectMovieLinks's DOM-title path (fallback
    // for the brief window before the first changeMedia of a session arrives) without
    // double-processing the same real title change. Reads the localStorage cache directly
    // (without assigning _lineupScheduleCache, which stays lineupEnsureSchedule's job so
    // revalidation still happens) so all of this works before the lineup screen is first opened.
    function lineupObserveTitleChange(rawTitle, declaredSeconds) {
        // Deliberately NOT gated on lineupTimingEnabled() -- only the display
        // (lineupBuildDaySections) is. Tracking always runs in the background so the state
        // stays accurate; gating it here too seemed like a natural extension but actually broke
        // things: while the setting was off, changeMedia events were never observed at all, so
        // a film's entire runtime could pass with no confirmed-played marker -- confirmed live
        // 2026-07-19 on the sibling Android app, Shock Waves' whole ~90min run went untracked
        // while the setting was off, and turning it back on mid-next-film showed a bogus
        // "Shock Waves starts at 8:15" because the app still thought it hadn't happened yet.
        // Always tracking means flipping the setting on shows accurate state immediately
        // instead of waiting for the next real title change to self-correct.
        if (!rawTitle) return;
        // Bail WITHOUT marking rawTitle as observed if the schedule isn't loaded yet -- e.g. the
        // socket's changeMedia resync can fire on a fresh mid-movie page load before the cached
        // schedule has finished reading. If we dedup on a "no schedule yet" outcome, this title
        // would never be re-evaluated once the schedule DOES load (the movie's title isn't going
        // to change again), leaving _lineupCurrentMatchedFlatIndex stuck at -1 for its whole
        // runtime and the ETA anchored to a stale bumper timestamp instead of the real live
        // countdown. Letting a later call (the DOM-title fallback, or the next resync) retry
        // fixes it.
        const sched = _lineupScheduleCache || lineupReadCache();
        if (!sched) return;
        if (rawTitle === _lineupLastObservedRawTitle) return;
        _lineupLastObservedRawTitle = rawTitle;

        const title = parseMovieFilename(rawTitle).title;
        const matchesSchedule = !!(title &&
            (declaredSeconds == null || declaredSeconds >= LINEUP_MIN_PLAUSIBLE_FEATURE_SECONDS) &&
            lineupAllScheduleTitles(sched).some(s => lineupItemMatchesTitle(s, title)));

        const flatToday = lineupFlatTodayWithSection(sched);
        const idx = matchesSchedule ? flatToday.findIndex(f => lineupItemMatchesTitle(f.item, title)) : -1;
        const newSection = idx !== -1 ? flatToday[idx].si : -1;
        _lineupCurrentMatchedFlatIndex = idx;

        if (!matchesSchedule) {
            if (!_lineupLastUnmatchedStart) _lineupLastUnmatchedStart = Date.now();
        } else if (_lineupLastUnmatchedStart) {
            const gapSec = (Date.now() - _lineupLastUnmatchedStart) / 1000;
            if (_lineupLastMatchedSection !== -1 && newSection !== -1
                && gapSec >= LINEUP_MIN_PLAUSIBLE_GAP_SECONDS && gapSec <= LINEUP_MAX_PLAUSIBLE_GAP_SECONDS) {
                if (newSection === _lineupLastMatchedSection) {
                    lineupPushGapSample(LS_LINEUP_GAP_SAME_SECTION, _lineupObservedSameSectionGaps, gapSec);
                } else {
                    lineupPushGapSample(LS_LINEUP_GAP_CROSS_SECTION, _lineupObservedCrossSectionGaps, gapSec);
                }
            }
            _lineupLastUnmatchedStart = null;
        }
        lineupCommitConfirmedProgress();
        _lineupPendingProgress = null; // whatever was pending either just committed or was a jump
        if (matchesSchedule && idx !== -1) {
            _lineupLastMatchedSection = newSection;
            lineupWriteLastMatchedSection(newSection);
            if (idx > lineupReadProgress()) _lineupPendingProgress = { idx, since: Date.now() };
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
            // Logged (not swallowed silently) so a stale-cache report is diagnosable
            // after the fact instead of leaving zero trace of why it didn't update.
            console.warn('[SC] lineup refetch failed, keeping existing cache:', e && e.message);
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
                // Unlike routine revalidation (below), a still-expired cache here is known to be
                // wrong, not just possibly stale -- worth one immediate retry before accepting a
                // transient failure (rate limit, flaky network) as the final answer for however
                // long this tab stays open before the lineup screen is opened again.
                if (lineupScheduleExpired(_lineupScheduleCache)) {
                    await lineupRefetchAndCache();
                    if (lineupScheduleExpired(_lineupScheduleCache)) {
                        console.warn('[SC] lineup schedule still expired after refetch retry -- showing stale cached schedule:', _lineupScheduleCache.title);
                    }
                }
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
            console.warn('[SC] lineup initial fetch failed, falling back:', e && e.message);
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
        const infoFor = (f) => infosByKey.get(f.item.title + '|' + f.item.year) || {};

        // Experimental feature, off by default -- see lineupTimingEnabled(). Skip all live
        // matching/estimation and show the schedule as a plain, unstatused list instead: posters,
        // titles, section themes -- no NOW PLAYING, no played graying, no ETA guesses.
        if (!lineupTimingEnabled()) {
            const builtFlat = flat.map((f) => ({
                ...lineupBuildItem(infoFor(f), f.item.title, f.item.year),
                isNowPlaying: false,
                played: false,
                etaLabel: '',
            }));
            return day.sections.map((section, si) => ({
                name: section.name, slug: section.slug,
                items: builtFlat.filter((_, idx) => flat[idx].si === si),
            }));
        }

        const isToday = dayStatus === 'today';
        // Prefer the socket-driven match (_lineupCurrentMatchedFlatIndex, authoritative --
        // set straight from the raw changeMedia payload) over the DOM-title heuristic below
        // (lastMovieTitle, populated by injectMovieLinks/triggerTitleInject watching
        // #currenttitle). The DOM path can lag or land on a transient bumper/trailer title
        // right after a reload and then never update again until the next real title change,
        // while the socket payload self-heals on every real media change -- it's only ever
        // stale for the brief window before the first one arrives, which the DOM fallback covers.
        const domTitle = isToday && lastMovieTitle
            ? parseMovieFilename(lastMovieTitle).title : '';
        const domFlatIndex = domTitle
            ? flat.findIndex(f => lineupItemMatchesTitle(f.item, domTitle))
            : -1;
        const currentFlatIndex = isToday && _lineupCurrentMatchedFlatIndex !== -1
            ? _lineupCurrentMatchedFlatIndex : domFlatIndex;

        if (isToday) lineupCommitConfirmedProgress(); // a film past the confirm threshold counts as reached

        const nowMs = Date.now();
        // Cross-section falls back to the same-section median (better than a flat guess) if no
        // cross-section samples have been learned yet; same-section falls back to the original
        // 10-min cold-start default.
        const sameSectionGapSeconds = lineupMedianGapSeconds(_lineupObservedSameSectionGaps) ?? 600;
        const crossSectionGapSeconds = lineupMedianGapSeconds(_lineupObservedCrossSectionGaps) ?? sameSectionGapSeconds;
        const estimates = lineupEstimateDayItems({
            nowMs,
            anchorMs: lineupDayAnchorPacific(day.date).getTime(),
            runtimesMin: flat.map(f => infoFor(f).runtime ?? null),
            sectionOf: flat.map(f => f.si),
            sameSectionGapSeconds,
            crossSectionGapSeconds,
            dayStatus,
            currentIndex: currentFlatIndex,
            // null (not 0) when the movie's duration isn't known yet -- e.g. the page loaded
            // mid-movie, so no changeMedia carrying `seconds` has fired for it. Treating unknown
            // as 0 would make "no live data" look identical to "wrapping up right now," anchoring
            // the next film's ETA to nowMs+gap -- a confident-looking but bogus guess (seen live
            // 2026-07-19: showed ~10 min out with 15+ min actually remaining). The real value
            // arrives automatically once the next real changeMedia fires.
            remainingSec: currentFlatIndex !== -1 && getCurrentMediaSeconds() > 0
                ? Math.max(0, getCurrentMediaSeconds() - (getPlayerTimeSec() ?? 0))
                : (currentFlatIndex !== -1 ? null : 0),
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
            <div id="sc-lineup-body"></div>
            <svg width="0" height="0" style="position:absolute">
                <filter id="sc-ticket-grain">
                    <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" result="noise"/>
                    <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.08 0"/>
                </filter>
            </svg>`;
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
            // The label sits in its own stacked (z-index) span so it always paints above the
            // ticket-stub's ::before (tear-line/perforation) and ::after (paper-grain) pseudo-
            // elements -- those are position:absolute and would otherwise paint over plain text.
            btn.innerHTML = `<span class="sc-lineup-daytab-label">${d.day}</span>`;
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
    // Exposed so setDesynced() can force the floating buttons (fs/desync/gif/settings)
    // visible the moment desync starts, and re-poke them on resync.
    let _gapShow = null;

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
        const GAP_IDS = ['fs-toggle-btn', 'sc-desync-btn', 'sc-gif-btn', 'sc-settings-btn', 'scsub-trigger-btn'];
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
            if (_desync.active) return; // keep the desync button visible while desynced
            GAP_IDS.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.classList.add('sc-bar-dim');
            });
        };
        _gapShow = gapShow;

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

    /* ==========================================================
       CHAT PANEL RESIZER
       Drags --sc-chat-w (horizontal layout) / --sc-chat-h (vertical layout)
       live, then persists the result so it survives reload.
    ========================================================== */

    function initChatResizer() {
        if (document.getElementById('sc-chat-resizer')) return;
        const handle = document.createElement('div');
        handle.id = 'sc-chat-resizer';
        document.body.appendChild(handle);

        const root = document.documentElement;
        let dragging = false, mode, startX, startY, startW, startH;

        handle.addEventListener('mousedown', e => {
            e.preventDefault();
            dragging = true;
            mode = document.body.classList.contains('sc-vertical') ? 'vertical' : 'horizontal';
            startX = e.clientX; startY = e.clientY;
            startW = getChatPanelWidth();
            startH = getChatPanelHeight();
            handle.classList.add('sc-resizing');
            document.body.style.userSelect = 'none';
        });

        window.addEventListener('mousemove', e => {
            if (!dragging) return;
            if (mode === 'horizontal') {
                const deltaVw = (startX - e.clientX) / window.innerWidth * 100; // drag left = wider
                const w = Math.min(CHAT_PANEL_W_MAX, Math.max(CHAT_PANEL_W_MIN, startW + deltaVw));
                root.style.setProperty('--sc-chat-w', w + 'vw');
            } else {
                const deltaVh = (startY - e.clientY) / window.innerHeight * 100; // drag up = taller
                const h = Math.min(CHAT_PANEL_H_MAX, Math.max(CHAT_PANEL_H_MIN, startH + deltaVh));
                root.style.setProperty('--sc-chat-h', h + 'vh');
            }
        });

        window.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('sc-resizing');
            document.body.style.userSelect = '';
            if (mode === 'horizontal') {
                setKey(LS_CHAT_PANEL_W, String(parseFloat(root.style.getPropertyValue('--sc-chat-w')) || getChatPanelWidth()));
            } else {
                setKey(LS_CHAT_PANEL_H, String(parseFloat(root.style.getPropertyValue('--sc-chat-h')) || getChatPanelHeight()));
            }
        });
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
        ensureChatFontLoaded();

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
        initMovieLeadOffset();
        initChatSeekMenu();
        initChatHeader();
        initChatResizer();
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

            /* Resizable chat panel — width (horizontal layout) / height (vertical layout).
               Read from localStorage at boot; dragged live by #sc-chat-resizer. */
            :root {
                --sc-chat-w: ${getChatPanelWidth()}vw;
                --sc-chat-h: ${getChatPanelHeight()}vh;
            }

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
                width: calc(99vw - var(--sc-chat-w)) !important; height: 40px !important;
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
                width: calc(99vw - var(--sc-chat-w)) !important;
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
                width: calc(var(--sc-chat-w) - 5px) !important; height: 28px !important;
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
                bottom: calc(var(--sc-chat-h) - 20px) !important;
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
                width: calc(var(--sc-chat-w) - 5px) !important;
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
                bottom: var(--sc-chat-h) !important;
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
                right: calc(var(--sc-chat-w) + 1vw + 186px) !important;
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
                bottom: calc(var(--sc-chat-h) + 15px) !important;
                right: 196px !important;
                left: 4px !important;
            }
            /* Keep the scrubber/control bar on screen while desynced instead of
               letting video.js's own inactivity timer fade it out. */
            body.sc-desynced .video-js.vjs-user-inactive .vjs-control-bar {
                opacity: 1 !important;
                visibility: visible !important;
                pointer-events: auto !important;
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
                position: relative !important;
            }
            .video-js .vjs-progress-holder:hover { height: 6px !important; }
            /* Marks where the group's live synced position is while desynced —
               distinct from .vjs-play-progress, which tracks the scrubbed position. */
            #sc-sync-marker {
                display: none;
                position: absolute !important;
                top: -4px !important;
                bottom: -4px !important;
                width: 3px !important;
                margin-left: -1.5px !important;
                background: #ffcc00 !important;
                border-radius: 2px !important;
                box-shadow: 0 0 4px rgba(255,204,0,0.8) !important;
                pointer-events: none !important;
                z-index: 5 !important;
                /* left updates in discrete steps (updateSyncMarker's setInterval) —
                   glide between them at the same period instead of jumping. */
                transition: left 0.5s linear !important;
            }
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
            #sc-lineup-daytabs { display: flex !important; gap: 14px !important; margin-bottom: 24px !important; }
            /* Day tabs — torn-ticket-stub look: perforation edge, paper grain (the SVG
               filter defined once in lineupEnsureScreenDom's template), Alfa Slab One face. */
            .sc-lineup-daytab {
                position: relative !important; overflow: hidden !important;
                background: #c9c2b8 !important; border: 1px solid #b0a89c !important;
                color: #4a4238 !important; font-family: 'Alfa Slab One', serif !important; font-weight: 400 !important;
                font-size: 13px !important; letter-spacing: 0.01em !important;
                padding: 9px 16px 9px 24px !important; border-radius: 3px !important; cursor: pointer !important;
            }
            .sc-lineup-daytab-label { position: relative !important; z-index: 2 !important; }
            /* Perforation edge: a dashed tear-line plus a column of punch-holes just inside
               it, like the tab was torn off a longer ticket strip. The hole color is
               hardcoded to match #sc-lineup-screen's own near-opaque background
               (rgba(6,4,8,0.97)) since a real cutout isn't possible on an opaque button. */
            .sc-lineup-daytab::before {
                content: '' !important; position: absolute !important; z-index: 1 !important;
                left: 9px !important; top: 4px !important; bottom: 4px !important; width: 7px !important;
                border-left: 2px dashed rgba(0,0,0,0.2) !important;
                background-image: radial-gradient(circle, #060408 2.5px, transparent 2.6px) !important;
                background-size: 7px 12px !important; background-repeat: repeat-y !important;
            }
            /* Subtle paper-grain texture -- feTurbulence ignores the element's own pixels,
               so this pseudo-element just becomes translucent noise layered over the ticket. */
            .sc-lineup-daytab::after {
                content: '' !important; position: absolute !important; inset: 0 !important; z-index: 1 !important;
                filter: url(#sc-ticket-grain) !important; pointer-events: none !important;
            }
            /* Deep ticket-red + a torn edge for the selected day. The tear runs the full
               left edge (where the perforation implies it was ripped off the strip) plus
               small nicks at both right corners. */
            .sc-lineup-daytab-active {
                background: #7a1f1a !important; border: none !important; color: #f5e4c8 !important;
                clip-path: polygon(
                    6% 0%, 88% 0%, 94% 4%, 100% 9%, 95% 14%, 100% 19%,
                    100% 81%, 95% 86%, 100% 91%, 94% 96%, 88% 100%, 6% 100%,
                    2% 97%, 9% 92%, 5% 84%, 9% 76%, 6% 66%, 9% 56%, 5% 46%, 9% 36%, 6% 26%, 9% 16%, 2% 6%, 6% 0%
                ) !important;
            }
            .sc-lineup-daytab-active::before { border-left-color: rgba(245,228,200,0.3) !important; }
            .sc-lineup-daytab:hover:not(.sc-lineup-daytab-active) { background: #d6cfc4 !important; }
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
            /* Start-time estimate, overlaid directly on the poster art (a caption bar
               pinned to its bottom edge) instead of a separate line below -- readable over
               any art via the gradient backing, regardless of NOW PLAYING/estimated/blank
               state. Bebas Neue is a marquee-style condensed face; it runs visually small
               for its px size, hence 18px where a normal face would use ~13px. */
            .sc-lineup-eta {
                position: absolute !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
                padding: 18px 10px 6px !important; box-sizing: border-box !important;
                background: linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.75) 60%, rgba(0,0,0,0.85) 100%) !important;
                border-radius: 0 0 6px 6px !important;
                font-family: 'Bebas Neue', 'Inter', 'Roboto', system-ui, sans-serif !important;
                font-size: 18px !important; font-weight: 400 !important; letter-spacing: 0.06em !important;
                color: rgba(255,255,255,0.85) !important;
                text-align: center !important;
            }
            .sc-lineup-item-current .sc-lineup-eta { color: var(--np-accent, #ff5b73) !important; }

            /* Toggle button — right side of the header bar, same line as the title */
            #sc-poster-toggle {
                position: fixed !important;
                top: 0 !important;
                right: calc(var(--sc-chat-w) + 1vw) !important;  /* stops at the chat panel edge */
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
                right: calc(var(--sc-chat-w) + 1vw + 44px) !important;
            }
            body.sc-vertical #sc-desync-btn {
                bottom: calc(var(--sc-chat-h) + 1vh) !important;
                right: 44px !important;
            }

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
                width: calc(99vw - var(--sc-chat-w)) !important; height: 100vh !important;
                z-index: 9999 !important; background: black !important;
            }
            body.sc-horizontal #videowrap .embed-responsive,
            body.sc-horizontal #ytapiplayer {
                width: calc(99vw - var(--sc-chat-w)) !important; height: 100vh !important;
            }
            body.sc-horizontal #chatwrap {
                position: fixed !important; top: 28px !important; right: 0 !important;
                width: var(--sc-chat-w) !important; height: calc(100vh - 28px) !important;
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
                bottom: 6px !important; right: calc(var(--sc-chat-w) + 1vw + 8px) !important;
            }

            /* ===== VERTICAL LAYOUT (portrait monitor) ===== */
            body.sc-vertical #videowrap {
                position: fixed !important; top: 0 !important; left: 0 !important;
                width: 100vw !important; height: calc(97vh - var(--sc-chat-h)) !important;
                z-index: 9999 !important; background: black !important;
                border: none !important; outline: none !important;
                box-shadow: none !important;
            }
            body.sc-vertical #videowrap .embed-responsive,
            body.sc-vertical #ytapiplayer {
                width: 100vw !important; height: calc(97vh - var(--sc-chat-h)) !important;
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
                width: 100vw !important; height: calc(var(--sc-chat-h) - 28px) !important;
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
                bottom: calc(var(--sc-chat-h) + 1vh) !important;
                right: 8px !important; left: auto !important;
            }
            /* movie stats tags: float just above the video scrubber (bottom of the
               video, which shrinks as the chat panel grows) instead of down at the
               very bottom of the screen */
            body.sc-vertical #sc-movie-stats {
                bottom: calc(3vh + var(--sc-chat-h)) !important;
            }

            /* ===== SHARED CHAT ELEMENTS ===== */
            #messagebuffer {
                flex: 1 !important; height: auto !important;
                background: transparent !important; color: white !important;
                font-family: 'Inter', 'Roboto', system-ui, sans-serif !important;
                font-size: 14px !important; overflow-y: auto !important; padding-bottom: 5px !important;
            }
            #messagebuffer .sc-own-msg {
                background: rgba(125, 200, 255, 0.07) !important;
                margin: 0 -4px !important; padding: 1px 4px !important;
                border-radius: 3px !important;
            }
            /* Mention ping -- overrides CyTube's default flat-gray .nick-highlight */
            #messagebuffer .nick-highlight {
                background: rgba(185, 130, 255, 0.14) !important;
                border-left: 2px solid rgba(185, 130, 255, 0.75) !important;
                margin: 0 -4px 0 -6px !important; padding: 1px 4px 1px 4px !important;
                border-radius: 3px !important;
            }

            /* Chat panel resizer — thin drag strip on the panel's free edge:
               left edge (width) in horizontal layout, top edge (height) in vertical layout. */
            #sc-chat-resizer {
                position: fixed !important;
                z-index: 10004 !important;
                background: transparent !important;
                touch-action: none !important;
                transition: background 0.15s ease !important;
            }
            #sc-chat-resizer:hover, #sc-chat-resizer.sc-resizing {
                background: rgba(255,255,255,0.18) !important;
            }
            body.sc-horizontal #sc-chat-resizer {
                top: 28px !important; bottom: 0 !important;
                left: calc(100vw - var(--sc-chat-w) - 4px) !important;
                width: 8px !important;
                cursor: ew-resize !important;
            }
            body.sc-vertical #sc-chat-resizer {
                left: 0 !important; right: 0 !important;
                /* Align with #sc-chat-header's own TOP edge (bottom -20px + its 28px
                   height) so the handle sits flush above the users/poll bar itself,
                   not tucked below it. */
                bottom: calc(var(--sc-chat-h) + 4px) !important;
                height: 8px !important;
                cursor: ns-resize !important;
            }

            /* Chat textarea resizer — thin strip above the entry box, drag up/down */
            /* Sits directly on the textarea's own top edge — negative margin cancels
               its own flex height so it adds no gap, and z-index keeps it grabbable
               above the textarea underneath it. */
            #sc-chat-ta-resizer {
                width: 100% !important; height: 6px !important; flex-shrink: 0 !important;
                cursor: ns-resize !important; margin-bottom: -6px !important;
                position: relative !important; z-index: 2 !important;
                border-radius: 4px 4px 0 0 !important; background: transparent !important;
                transition: background 0.15s ease !important; touch-action: none !important;
            }
            #sc-chat-ta-resizer:hover, #sc-chat-ta-resizer.sc-resizing {
                background: rgba(255,255,255,0.18) !important;
            }

            #sc-chat-textarea {
                width: 100% !important; min-height: 44px !important; max-height: 50vh !important;
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
                bottom: 6px !important; right: calc(var(--sc-chat-w) + 1vw + 80px) !important;
            }
            body.sc-vertical #sc-settings-btn {
                bottom: calc(var(--sc-chat-h) + 1vh) !important; right: 80px !important;
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
                width: calc(var(--sc-chat-w) - 5px) !important;
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
                bottom: calc(var(--sc-chat-h) + 42px) !important;
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
                right: calc(var(--sc-chat-w) + 1vw + 150px) !important;
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
                right: calc(var(--sc-chat-w) + 1vw + 90px) !important;
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