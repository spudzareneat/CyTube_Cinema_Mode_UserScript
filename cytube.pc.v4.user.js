// ==UserScript==
// @name         CyTube Fullscreen Video with Overlay Chat
// @namespace    http://tampermonkey.net/
// @version      4.0.0
// @description  Fullscreen layout, LanguageTool grammar, inline error editor, tab-complete, movie links, IMDb trivia & parent guide, vertical monitor support
// @match        https://cytu.be/r/420Grindhouse
// @match        https://cytu.be/r/testing
// @grant        GM_xmlhttpRequest
// @connect      doesthedogdie.com
// @connect      api.themoviedb.org
// @connect      en.wikipedia.org
// @connect      raw.githubusercontent.com
// @connect      api.languagetool.org
// @connect      caching.graphql.imdb.com
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    /* ==========================================================
       API KEYS — stored in localStorage, managed via settings modal.
       Keys are never hard-coded; the settings modal handles first-run.
    ========================================================== */
    const LS_TMDB        = 'sc_tmdb_key';
    const LS_DTDD        = 'sc_dtdd_key';
    const LS_SPELLCHECK  = 'sc_spellcheck';
    const LS_CHAT_FONT   = 'sc_chat_fontsize';
    const LS_MOVIE_LINKS = 'sc_movie_links';
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
       DESYNC BUTTON — temporarily pause CyTube's sync
    ========================================================== */

    function initDesyncButton() {
        const btn = document.createElement('button');
        btn.id = 'sc-desync-btn';
        btn.textContent = '⟳';
        btn.title = 'Free watch — click to watch freely, click again to re-sync';
        document.body.appendChild(btn);

        let desynced = false;
        let savedListeners = null;

        const getMediaUpdateListeners = () => {
            // Socket.IO v2/v3 stores listeners under _callbacks['$eventName']
            // Socket.IO v4 stores them under _events or via listeners()
            const key = '$mediaUpdate';
            if (socket._callbacks?.[key]) return { store: '_callbacks', key };
            if (socket._events?.mediaUpdate) return { store: '_events', key: 'mediaUpdate' };
            return null;
        };

        const freezeSync = () => {
            const loc = getMediaUpdateListeners();
            if (!loc) {
                console.warn('[CyTube SC] Could not find mediaUpdate listeners to freeze');
                return;
            }
            if (loc.store === '_callbacks') {
                savedListeners = socket._callbacks[loc.key].slice();
                socket._callbacks[loc.key] = [];
            } else {
                savedListeners = socket._events[loc.key];
                delete socket._events[loc.key];
            }
            console.log('[CyTube SC] Sync frozen — removed', savedListeners?.length ?? 1, 'mediaUpdate listener(s)');
        };

        const thawSync = () => {
            if (!savedListeners) return;
            const loc = getMediaUpdateListeners();
            if (loc?.store === '_callbacks') {
                socket._callbacks[loc.key] = savedListeners;
            } else {
                socket._events = socket._events || {};
                socket._events['mediaUpdate'] = savedListeners;
            }
            savedListeners = null;
            console.log('[CyTube SC] Sync restored');
            // Trigger immediate resync
            if (typeof socket !== 'undefined' && socket) {
                socket.emit('playerReady');
            }
        };

        btn.addEventListener('click', () => {
            if (typeof socket === 'undefined' || !socket) return;
            desynced = !desynced;
            if (desynced) {
                freezeSync();
                btn.classList.add('sc-desync-active');
                btn.title = 'Free watch ON — click to re-sync';
            } else {
                thawSync();
                btn.classList.remove('sc-desync-active');
                btn.title = 'Free watch — click to watch freely';
            }
        });
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

    function relocateEmoteButton() {
        if (document.getElementById('sc-emote-proxy')) return;
        const original = document.getElementById('emotelistbtn');
        if (!original) return;

        const proxy = document.createElement('button');
        proxy.id = 'sc-emote-proxy';
        proxy.textContent = '▦';
        proxy.title = 'Emotes';
        proxy.setAttribute('aria-label', 'Emote Picker');

        proxy.addEventListener('click', e => {
            e.stopPropagation();
            original.click();
        });

        document.body.appendChild(proxy);

        // Style the original emotelistbtn to look like our proxy too
        if (!original.dataset.pickerApplied) {
            original.textContent = '▦';
            original.dataset.pickerApplied = 'true';
        }
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
    let movieLinkCache = {}; // cache by raw title to avoid repeat lookups

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


    // ── DoesTheDogDie: category/keyword filter ───────────────────────────────────
    // We read topic names directly from the API response (topic.name field)
    // rather than hardcoding IDs which change. We match against keywords
    // relevant for cult/exploitation/horror film chat.
    // Each entry: [matchString, emoji, displayLabel]
    // matchString is tested against topic.name (lowercase)
    const DTDD_FILTERS = [
        ['dog dies',          '🐕', 'Dog dies'],
        ['cat dies',          '🐱', 'Cat dies'],
        ['animal',            '🐾', 'Animal cruelty'],
        ['jump scare',        '😱', 'Jump scares'],
        ['sex scene',         '🔞', 'Sex scene'],
        ['nudity',            '🔞', 'Nudity'],
        ['rape',              '⚠️', 'Sexual violence'],
        ['suicide',           '💀', 'Suicide'],
        ['needle',            '💉', 'Needles'],
        ['spider',            '🕷', 'Spiders'],
        ['decapitat',         '🩸', 'Decapitation'],
        ['explod',            '💥', 'Explosions'],
        ['torture',           '⚠️', 'Torture'],
        ['child',             '⚠️', 'Child in peril'],
        ['pregnancy',         '🤰', 'Pregnancy'],
        ['clown',             '🤡', 'Clowns'],
        ['vomit',             '🤢', 'Vomiting'],
        ['eye',               '👁', 'Eye trauma'],
    ];

    // GM_xmlhttpRequest wrapped as a Promise — bypasses CORS restrictions
    function gmFetch(url, headers = {}) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers: { 'Accept': 'application/json', ...headers },
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

    async function getDtddStats(tmdbId, movieTitle, tmdbResult_year) {
        if (!hasKey(LS_DTDD) || !tmdbId || !movieTitle) return null;
        const key = getKey(LS_DTDD);
        try {
            // DTDD search takes a text query, not a numeric ID
            const searchData = await gmFetch(
                `https://www.doesthedogdie.com/dddsearch?q=${encodeURIComponent(movieTitle)}`,
                { 'X-API-KEY': key }
            );

            // DTDD search results don't include tmdbId — match by normalised title + year instead
            const normalise = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const targetTitle = normalise(movieTitle);
            const targetYear  = tmdbResult_year ? String(tmdbResult_year) : null;

            let match = null;

            // 1st pass: exact normalised title + year match
            if (targetYear) {
                match = (searchData.items || []).find(i =>
                    normalise(i.name) === targetTitle &&
                    i.release_date && String(i.release_date).startsWith(targetYear)
                );
            }
            // 2nd pass: exact normalised title only
            if (!match) {
                match = (searchData.items || []).find(i => normalise(i.name) === targetTitle);
            }
            // 3rd pass: first result whose normalised title contains our title (partial)
            if (!match) {
                match = (searchData.items || []).find(i => normalise(i.name).includes(targetTitle));
            }

            if (!match) {
                return null;
            }

            const detail = await gmFetch(
                `https://www.doesthedogdie.com/media/${match.id}`,
                { 'X-API-KEY': key }
            );

            // Build stats from topic names rather than brittle hardcoded IDs.
            // Use a Set to avoid duplicate labels (e.g. both 'nudity' and 'sex scene' → '🔞')
            const seenLabels = new Set();
            const stats = [];

            for (const stat of (detail.topicItemStats || [])) {
                const yesSum = stat.yesSum ?? 0;
                if (yesSum < 1) continue;
                const topicName = (stat.topic?.name ?? '').toLowerCase();
                if (!topicName) continue;

                for (const [keyword, emoji, label] of DTDD_FILTERS) {
                    if (topicName.includes(keyword) && !seenLabels.has(label)) {
                        seenLabels.add(label);
                        stats.push(`${emoji} ${label}`);
                        break;
                    }
                }
            }
            return stats.length ? stats : null;
        } catch (e) {
            console.error('[CyTube SC] DtDD error:', e);
            return null;
        }
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
                const res = await fetch(`https://api.themoviedb.org/3/search/movie?${params}`);
                if (!res.ok) return;
                const data = await res.json();
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

        // ── DoesTheDogDie ────────────────────────────────────────────────────────
        const dtddStats = await getDtddStats(tmdbResult?.tmdbId, tmdbResult?.title || title, tmdbResult?.year || year);

        // ── IMDb Parent Guide ─────────────────────────────────────────────────────
        const parentalGuide = await fetchImdbParentalGuide(tmdbResult?.imdbId);

        const result = {
            links: {
                imdb:       tmdbResult?.imdbId  ? `https://www.imdb.com/title/${tmdbResult.imdbId}/` : null,
                letterboxd: tmdbResult?.tmdbId  ? `https://letterboxd.com/tmdb/${tmdbResult.tmdbId}` : null,
                wiki:       wikiUrl,
            },
            killCount,
            dtddStats,
            parentalGuide,
            imdbId:     tmdbResult?.imdbId   || null,
            cleanTitle: tmdbResult?.title    || null,
            cleanYear:  tmdbResult?.year     || null,
            rating:     tmdbResult?.rating   ?? null,
            runtime:    tmdbResult?.runtime  || null,
            genres:     tmdbResult?.genres   || [],
        };

        movieLinkCache[cacheKey] = result;
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

    function injectMovieLinks(titleEl) {
        const rawTitle = titleEl.textContent.trim()
            .replace(/^currently\s+playing[:\s]*/i, '')
            .replace(/^now\s+playing[:\s]*/i, '').trim();

        if (!rawTitle || rawTitle === lastMovieTitle || rawTitle.length < 2) return;
        lastMovieTitle = rawTitle;
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

        lookupMovie(title, year).then(({ links, killCount, dtddStats, parentalGuide, imdbId, cleanTitle, cleanYear, rating, runtime }) => {
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

            // Update title with clean TMDB title
            if (cleanTitle && titleEl) {
                const newText = cleanTitle + (cleanYear ? ` (${cleanYear})` : '');
                const textNode = [...titleEl.childNodes].find(n => n.nodeType === 3 && n.textContent.trim());
                if (textNode) textNode.textContent = newText;
                else if (titleEl.firstChild) titleEl.firstChild.textContent = newText;
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
            if (dtddStats && dtddStats.length) statParts.push(...dtddStats);
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
       TRIVIA PANEL
    ========================================================== */

    let _triviaPanelOpen = false;

    async function toggleTriviaPanel() {
        const existing = document.getElementById('sc-trivia-panel');
        if (existing) { existing.remove(); _triviaPanelOpen = false; return; }
        if (!_currentImdbId) return;
        _triviaPanelOpen = true;

        const panel = document.createElement('div');
        panel.id = 'sc-trivia-panel';
        panel.innerHTML = '<div class="sc-trivia-loading">Loading trivia…</div>';
        document.body.appendChild(panel);

        const items = await fetchImdbTrivia(_currentImdbId);
        if (!document.getElementById('sc-trivia-panel')) return; // closed while loading
        if (!items || !items.length) {
            panel.innerHTML = '<div class="sc-trivia-loading">No trivia found.</div>';
            return;
        }
        panel.innerHTML = items.map(t => `<div class="sc-trivia-item">${t}</div>`).join('');

        // Keyboard T or Escape closes
        const keyClose = (e) => {
            if (e.key === 'Escape' || e.key === 't' || e.key === 'T') {
                const t = e.target;
                if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
                panel.remove();
                _triviaPanelOpen = false;
                document.removeEventListener('keydown', keyClose);
            }
        };
        document.addEventListener('keydown', keyClose);
    }

    // 'T' key toggles trivia from anywhere (when not typing)
    document.addEventListener('keydown', (e) => {
        if (e.key !== 't' && e.key !== 'T') return;
        const t = e.target;
        if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
        toggleTriviaPanel();
    });

    /* ==========================================================
       USER COLOR SYSTEM
    ========================================================== */

    function hashString(str) {
        let h = 0;
        for (let i = 0; i < str.length; i++) { h = str.charCodeAt(i) + ((h << 5) - h); h |= 0; }
        return Math.abs(h);
    }
    function usernameToColor(u) {
        const h = hashString(u);
        return `hsl(${h % 360}, ${75 + (h % 15)}%, ${60 + (h % 10)}%)`;
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

    function openSettingsModal() {
        const old = document.getElementById('sc-settings-overlay');
        if (old) old.remove();

        const tmdbVal  = getKey(LS_TMDB);
        const dtddVal  = getKey(LS_DTDD);
        const firstRun = !tmdbVal && !dtddVal;
        const fontSize = getChatFontSize();

        const overlay = document.createElement('div');
        overlay.id = 'sc-settings-overlay';
        overlay.innerHTML = `
            <div id="sc-settings-modal">
                <div id="sc-settings-title">⚙ CyTube Script Settings</div>
                ${firstRun ? '<div class="sc-settings-intro">First time setup — enter your API keys below. Both are optional but unlock extra features. You can update them any time via the ⚙ button.</div>' : ''}

                <div class="sc-settings-group">
                    <label class="sc-settings-label">
                        TMDB API Key
                        <span class="sc-settings-note">Unlocks: IMDb/Letterboxd links, rating, runtime, kill counts</span>
                    </label>
                    <div style="display:flex;gap:6px;align-items:center">
                        <input id="sc-input-tmdb" class="sc-settings-input" type="text"
                            placeholder="Paste TMDB v3 key…" value="${tmdbVal}" spellcheck="false" style="flex:1" />
                        <button id="sc-test-tmdb" class="sc-settings-test" type="button">Test</button>
                    </div>
                    <span id="sc-test-tmdb-status" class="sc-settings-test-status"></span>
                    <a class="sc-settings-link" href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">
                        Get a free TMDB key ↗
                    </a>
                </div>

                <div class="sc-settings-group">
                    <label class="sc-settings-label">
                        DoesTheDogDie API Key
                        <span class="sc-settings-note">Unlocks: content warnings (dogs, jump scares, etc.)</span>
                    </label>
                    <input id="sc-input-dtdd" class="sc-settings-input" type="text"
                        placeholder="Paste DTDD key…" value="${dtddVal}" spellcheck="false" />
                    <a class="sc-settings-link" href="https://www.doesthedogdie.com/profile" target="_blank" rel="noopener">
                        Get a free DTDD key ↗
                    </a>
                </div>

                <div class="sc-settings-group sc-settings-toggle-group">
                    <label class="sc-settings-toggle-label">
                        <input type="checkbox" id="sc-input-spellcheck" ${spellCheckEnabled() ? 'checked' : ''} />
                        <span>Grammar &amp; spell check popup</span>
                        <span class="sc-settings-note">When off, messages send immediately without review</span>
                    </label>
                </div>

                <div class="sc-settings-group sc-settings-toggle-group">
                    <label class="sc-settings-toggle-label">
                        <input type="checkbox" id="sc-input-movielinks" ${movieLinksEnabled() ? 'checked' : ''} />
                        <span>Show movie links (IMDb, Letterboxd, Wikipedia)</span>
                        <span class="sc-settings-note">When off, stats bar still shows but link badges are hidden</span>
                    </label>
                </div>

                <div class="sc-settings-group">
                    <label class="sc-settings-label">
                        Chat font size: <span id="sc-font-val">${fontSize}px</span>
                    </label>
                    <input id="sc-input-fontsize" type="range" min="10" max="32" value="${fontSize}"
                        style="width:100%;accent-color:#c0b0ff" />
                </div>

                <div id="sc-settings-actions">
                    ${!firstRun ? '<button id="sc-settings-cancel">Cancel</button>' : ''}
                    <button id="sc-settings-save">Save</button>
                </div>
                <div id="sc-settings-status"></div>
            </div>`;

        document.body.appendChild(overlay);

        if (!firstRun) {
            overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
            document.getElementById('sc-settings-cancel').addEventListener('click', () => overlay.remove());
        }

        // Font size live preview
        const fontInput = document.getElementById('sc-input-fontsize');
        const fontVal   = document.getElementById('sc-font-val');
        fontInput.addEventListener('input', () => {
            const px = parseInt(fontInput.value, 10);
            fontVal.textContent = px + 'px';
            applyChatFontSize(px);
        });

        // TMDB key test button
        const testBtn    = document.getElementById('sc-test-tmdb');
        const testStatus = document.getElementById('sc-test-tmdb-status');
        testBtn.addEventListener('click', async () => {
            const key = document.getElementById('sc-input-tmdb').value.trim();
            if (!key) { testStatus.textContent = 'Enter a key first'; testStatus.className = 'sc-settings-test-status sc-test-bad'; return; }
            testBtn.disabled = true;
            testStatus.textContent = 'Checking…'; testStatus.className = 'sc-settings-test-status sc-test-pending';
            const result = await validateTmdbKey(key);
            testBtn.disabled = false;
            if (result === 'valid')   { testStatus.textContent = '✓ Valid key';          testStatus.className = 'sc-settings-test-status sc-test-ok'; }
            else if (result === 'invalid') { testStatus.textContent = '✗ Invalid key';   testStatus.className = 'sc-settings-test-status sc-test-bad'; }
            else                           { testStatus.textContent = '⚠ Couldn\'t reach API'; testStatus.className = 'sc-settings-test-status sc-test-bad'; }
        });

        document.getElementById('sc-settings-save').addEventListener('click', () => {
            const tmdb      = document.getElementById('sc-input-tmdb').value.trim();
            const dtdd      = document.getElementById('sc-input-dtdd').value.trim();
            const spell     = document.getElementById('sc-input-spellcheck').checked;
            const links     = document.getElementById('sc-input-movielinks').checked;
            const fontPx    = parseInt(fontInput.value, 10);
            setKey(LS_TMDB,        tmdb);
            setKey(LS_DTDD,        dtdd);
            setKey(LS_SPELLCHECK,  spell ? 'on' : 'off');
            setKey(LS_MOVIE_LINKS, links ? 'on' : 'off');
            setKey(LS_CHAT_FONT,   String(fontPx));
            applyChatFontSize(fontPx);
            movieLinkCache = {};
            lastMovieTitle = '';      // force re-lookup for current title with new key
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
       POSTER STRIP — toggle show/hide the MOTD poster images
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

    function initPosterStrip() {
        const motd = document.getElementById('motdrow');
        if (!motd) return;

        // Build the poster strip container from MOTD images
        const imgs = [...motd.querySelectorAll('img')].filter(img => {
            // Read HTML attributes (not rendered dimensions — motdrow is hidden so rendered = 0)
            const w = parseInt(img.getAttribute('width') || 0);
            const h = parseInt(img.getAttribute('height') || 0);
            // Poster images in the MOTD are 125x175 — keep portrait-ish images, skip wide banners
            return h >= 100 && w <= 200;
        });
        if (!imgs.length) return;

        // Create our strip outside of #motdrow so we control it fully
        const strip = document.createElement('div');
        strip.id = 'sc-poster-strip';
        // Single shared zoom element — lives on body, above everything
        let zoomEl = document.getElementById('sc-poster-zoom');
        if (!zoomEl) {
            zoomEl = document.createElement('img');
            zoomEl.id = 'sc-poster-zoom';
            document.body.appendChild(zoomEl);
        }

        const ZOOM_H = 300;

        const calcZoomTarget = (thumb) => {
            const rect  = thumb.getBoundingClientRect();
            const attrW = parseInt(thumb.getAttribute('width')  || 125);
            const attrH = parseInt(thumb.getAttribute('height') || 175);
            const zoomW = Math.round(ZOOM_H * (attrW / attrH));

            // Always centre horizontally over the thumb, clamped to viewport
            let left = rect.left + rect.width / 2 - zoomW / 2;
            left = Math.max(8, Math.min(left, window.innerWidth - zoomW - 8));

            // Anchor to the top of the thumb — expand upward from there
            // If not enough room above, expand downward instead
            let top;
            if (rect.top >= ZOOM_H + 8) {
                top = rect.top - ZOOM_H;          // expands upward, bottom edge at thumb top
            } else {
                top = rect.bottom - ZOOM_H;        // anchor bottom to thumb bottom, grows up into video
                top = Math.max(8, top);
            }

            return { left, top, width: zoomW, height: ZOOM_H };
        };

        const positionZoom = (thumb) => {
            const rect   = thumb.getBoundingClientRect();
            const target = calcZoomTarget(thumb);

            // Immediately place at thumb position/size (no transition yet)
            zoomEl.classList.remove('sc-zoom-expanded');
            zoomEl.style.transition = 'none';
            zoomEl.style.left   = rect.left   + 'px';
            zoomEl.style.top    = rect.top    + 'px';
            zoomEl.style.width  = rect.width  + 'px';
            zoomEl.style.height = rect.height + 'px';
            zoomEl.style.display = 'block';

            // Force a reflow so the browser registers the start state
            zoomEl.getBoundingClientRect();

            // Re-enable transition and animate to final size/position
            zoomEl._collapsing = false;
            zoomEl.style.transition = '';
            zoomEl.style.left   = target.left   + 'px';
            zoomEl.style.top    = target.top    + 'px';
            zoomEl.style.width  = target.width  + 'px';
            zoomEl.style.height = target.height + 'px';
            zoomEl.classList.add('sc-zoom-expanded');
        };

        imgs.forEach(img => {
            const thumb = document.createElement('img');
            thumb.src = img.src;
            thumb.className = 'sc-poster-thumb';
            thumb.title = img.title || img.alt || '';
            thumb.setAttribute('width',  img.getAttribute('width')  || '125');
            thumb.setAttribute('height', img.getAttribute('height') || '175');

            thumb.addEventListener('mouseenter', () => {
                // Cancel any in-progress collapse
                zoomEl._collapsing = false;
                zoomEl.src = thumb.src;
                positionZoom(thumb);
            });
            thumb.addEventListener('mouseleave', () => {
                zoomEl._collapsing = true;
                // Animate back to thumb size then hide
                const rect = thumb.getBoundingClientRect();
                zoomEl.classList.remove('sc-zoom-expanded');
                zoomEl.style.left   = rect.left   + 'px';
                zoomEl.style.top    = rect.top    + 'px';
                zoomEl.style.width  = rect.width  + 'px';
                zoomEl.style.height = rect.height + 'px';
                // Hide only if still collapsing when transition ends
                const onEnd = () => {
                    zoomEl.removeEventListener('transitionend', onEnd);
                    if (zoomEl._collapsing) {
                        zoomEl.style.display = 'none';
                        zoomEl.src = '';
                        zoomEl._collapsing = false;
                    }
                };
                zoomEl.addEventListener('transitionend', onEnd);
            });

            const wrap = document.createElement('a');
            wrap.href = img.src;
            wrap.target = '_blank';
            wrap.rel = 'noopener noreferrer';
            wrap.appendChild(thumb);
            strip.appendChild(wrap);
        });
        document.body.appendChild(strip);

        // Toggle button — injected below the video title
        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'sc-poster-toggle';
        toggleBtn.textContent = "Coming Attractions";
        toggleBtn.title = 'Show/hide weekend lineup';
        toggleBtn.addEventListener('click', () => {
            const visible = strip.classList.toggle('sc-poster-visible');
            toggleBtn.classList.toggle('sc-poster-toggle-active', visible);
            // Tell the top bar system whether strip is open
            _topBarIsOpen = visible;
            if (visible && _topBarWake) {
                _topBarWake(); // wake and keep awake
            }
            // If closing, restart the idle timer via a mousemove wake
            // (the next mousemove in the zone will restart it naturally)
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
        initTopBar();
        initDesyncButton();
        initChatHeader();
        initUserCount();
        initPollWatcher();
        applyChatFontSize(getChatFontSize());

        // First-run settings modal
        if (!hasKey(LS_TMDB) && !hasKey(LS_DTDD)) {
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
                if (!document.getElementById('sc-poster-strip')) initPosterStrip();
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

            /* ===== POSTER STRIP ===== */
            #sc-poster-strip {
                display: none !important; /* hidden by default */
                position: fixed !important;
                top: 20px !important;   /* drops down from the header bar */
                left: 0 !important;
                z-index: 19500 !important;
                width: 80vw !important;
                background: rgba(0,0,0,0.93) !important;
                padding: 8px 12px !important;
                overflow-x: auto !important;
                overflow-y: hidden !important;
                white-space: nowrap !important;
                border-bottom: 1px solid rgba(255,255,255,0.12) !important;
                scrollbar-width: thin !important;
                scrollbar-color: rgba(255,255,255,0.2) transparent !important;
            }
            body.sc-vertical #sc-poster-strip {
                width: 100vw !important;
                top: 20px !important;
                bottom: auto !important;
            }
            #sc-poster-strip.sc-poster-visible {
                display: block !important;
            }
            .sc-poster-thumb {
                height: 110px !important;
                width: auto !important;
                border-radius: 4px !important;
                margin-right: 6px !important;
                opacity: 0.82 !important;
                transition: opacity 0.15s !important;
                vertical-align: top !important;
                cursor: pointer !important;
                display: inline-block !important;
                flex-shrink: 0 !important;
            }
            .sc-poster-thumb:hover { opacity: 1 !important; }

            #sc-poster-zoom {
                display: none;
                position: fixed !important;
                z-index: 99990 !important;
                pointer-events: none !important;
                border-radius: 4px !important;
                box-shadow: 0 0 0 rgba(0,0,0,0) !important;
                border: 1px solid rgba(255,255,255,0.0) !important;
                /* transition animates position, size, shadow, border together */
                transition:
                    top 0.22s cubic-bezier(0.22, 1, 0.36, 1),
                    left 0.22s cubic-bezier(0.22, 1, 0.36, 1),
                    width 0.22s cubic-bezier(0.22, 1, 0.36, 1),
                    height 0.22s cubic-bezier(0.22, 1, 0.36, 1),
                    box-shadow 0.22s ease,
                    border-color 0.22s ease,
                    border-radius 0.22s ease !important;
            }
            #sc-poster-zoom.sc-zoom-expanded {
                box-shadow: 0 12px 48px rgba(0,0,0,0.92) !important;
                border-color: rgba(255,255,255,0.2) !important;
                border-radius: 6px !important;
            }


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
                border: none !important;
                border-radius: 50% !important;
                width: 28px !important; height: 28px !important;
                padding: 0 !important;
                font-size: 15px !important;
                cursor: pointer !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                transition: color 0.3s ease, background 0.3s ease !important;
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
                right: calc(20vw + 38px) !important;
            }
            body.sc-vertical #sc-desync-btn {
                bottom: 43vh !important;
                right: 46px !important;
            }

            #fs-toggle-btn, #sc-emote-proxy {
                position: fixed !important;
                z-index: 20002 !important;
                background: rgba(255,255,255,0.08) !important;
                color: rgba(255,255,255,0.55) !important;
                border: none !important;
                border-radius: 50% !important;
                width: 28px !important;
                height: 28px !important;
                padding: 0 !important;
                font-size: 15px !important;
                cursor: pointer !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                transition: color 0.3s ease, background 0.3s ease !important;
            }
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
                bottom: 6px !important; right: calc(20vw + 6px) !important;
            }
            body.sc-horizontal #fs-toggle-btn {
                bottom: 6px !important; right: calc(20vw + 70px) !important;
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

            /* fs + emote buttons: right-pinned, sitting exactly on the chat top edge */
            body.sc-vertical #sc-emote-proxy {
                bottom: 43vh !important;
                right: 8px !important; left: auto !important;
            }
            body.sc-vertical #fs-toggle-btn {
                bottom: 43vh !important;
                right: 84px !important; left: auto !important;
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
                padding: 6px 8px !important; font-size: 14px !important; font-family: inherit !important;
                resize: none !important; overflow-y: auto !important;
                box-sizing: border-box !important; line-height: 1.4 !important;
                outline: none !important; transition: border-color 0.2s !important; flex-shrink: 0 !important;
            }
            #sc-chat-textarea:focus {
                border-color: rgba(255,255,255,0.7) !important;
                background: rgba(255,255,255,0.15) !important;
            }
            #sc-chat-textarea::placeholder { color: rgba(255,255,255,0.4) !important; }
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
                border: none !important;
                border-radius: 50% !important;
                width: 28px !important;
                height: 28px !important;
                padding: 0 !important;
                font-size: 13px !important;
                cursor: pointer !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                transition: color 0.3s ease, background 0.3s ease !important;
                line-height: 1 !important;
            }
            #sc-settings-btn:hover {
                color: white !important;
                background: rgba(255,255,255,0.22) !important;
            }

            body.sc-horizontal #sc-settings-btn {
                bottom: 6px !important; right: calc(20vw + 102px) !important;
            }
            body.sc-vertical #sc-settings-btn {
                bottom: 43vh !important; right: 122px !important;
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
            }
            #sc-settings-title {
                font-size: 17px !important; font-weight: 700 !important;
                color: #c0b0ff !important;
            }
            .sc-settings-intro {
                font-size: 13px !important; color: rgba(255,255,255,0.6) !important;
                line-height: 1.5 !important;
                background: rgba(255,255,255,0.04) !important;
                border-radius: 6px !important; padding: 8px 10px !important;
            }
            .sc-settings-group {
                display: flex !important; flex-direction: column !important; gap: 5px !important;
            }
            .sc-settings-label {
                font-size: 13px !important; font-weight: 600 !important;
                color: rgba(255,255,255,0.85) !important;
                display: flex !important; flex-direction: column !important; gap: 2px !important;
            }
            .sc-settings-note {
                font-weight: 400 !important; font-size: 11px !important;
                color: rgba(255,255,255,0.4) !important;
            }
            .sc-settings-input {
                background: rgba(255,255,255,0.07) !important;
                border: 1px solid rgba(255,255,255,0.2) !important;
                border-radius: 6px !important;
                color: white !important;
                padding: 8px 10px !important;
                font-size: 13px !important;
                font-family: monospace !important;
                outline: none !important;
                width: 100% !important; box-sizing: border-box !important;
            }
            .sc-settings-input:focus {
                border-color: rgba(192,176,255,0.6) !important;
                background: rgba(255,255,255,0.1) !important;
            }
            .sc-settings-link {
                font-size: 11px !important; color: rgba(192,176,255,0.7) !important;
                text-decoration: none !important; align-self: flex-start !important;
            }
            .sc-settings-link:hover { color: #c0b0ff !important; text-decoration: underline !important; }
            .sc-settings-toggle-group { border-top: 1px solid rgba(255,255,255,0.08) !important; padding-top: 12px !important; }
            .sc-settings-toggle-label {
                display: flex !important; flex-direction: column !important; gap: 3px !important;
                cursor: pointer !important; font-size: 13px !important;
                font-weight: 600 !important; color: rgba(255,255,255,0.85) !important;
            }
            .sc-settings-toggle-label input[type="checkbox"] {
                width: 16px !important; height: 16px !important;
                margin: 0 8px 0 0 !important; cursor: pointer !important;
                accent-color: #c0b0ff !important;
            }
            .sc-settings-toggle-label > span:first-of-type {
                display: flex !important; align-items: center !important;
            }
            #sc-settings-actions {
                display: flex !important; gap: 10px !important; justify-content: flex-end !important;
                margin-top: 4px !important;
            }
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

            /* ===== TRIVIA BUTTON ===== */
            #sc-trivia-btn {
                position: fixed !important;
                z-index: 10003 !important;
                top: 0 !important;
                right: calc(20vw + 150px) !important;
                background: transparent !important;
                border: none !important;
                color: rgba(255,255,255,0.55) !important;
                font-size: 10px !important;
                font-weight: 700 !important;
                letter-spacing: 0.06em !important;
                text-transform: uppercase !important;
                cursor: pointer !important;
                padding: 2px 8px !important;
                height: 20px !important;
                display: flex !important;
                align-items: center !important;
                transition: color 0.2s !important;
            }
            #sc-trivia-btn:hover { color: rgba(255,255,255,0.9) !important; }
            body.sc-vertical #sc-trivia-btn { display: none !important; }

            /* ===== TRIVIA PANEL ===== */
            #sc-trivia-panel {
                position: fixed !important;
                top: 24px !important; left: 0 !important;
                width: 78vw !important;
                max-height: 60vh !important;
                overflow-y: auto !important;
                z-index: 19500 !important;
                background: rgba(10,8,20,0.97) !important;
                border-bottom: 1px solid rgba(255,255,255,0.1) !important;
                padding: 12px 16px !important;
                scrollbar-width: thin !important;
                scrollbar-color: rgba(255,255,255,0.15) transparent !important;
            }
            .sc-trivia-item {
                font-size: 13px !important;
                color: rgba(255,255,255,0.82) !important;
                line-height: 1.55 !important;
                padding: 8px 0 !important;
                border-bottom: 1px solid rgba(255,255,255,0.06) !important;
            }
            .sc-trivia-item:last-child { border-bottom: none !important; }
            .sc-trivia-loading {
                font-size: 12px !important;
                color: rgba(255,255,255,0.4) !important;
                padding: 8px 0 !important;
            }

            /* ===== SETTINGS TEST BUTTON ===== */
            .sc-settings-test {
                background: rgba(255,255,255,0.07) !important;
                border: 1px solid rgba(255,255,255,0.2) !important;
                color: rgba(255,255,255,0.7) !important;
                border-radius: 6px !important;
                padding: 6px 12px !important;
                font-size: 12px !important;
                cursor: pointer !important;
                white-space: nowrap !important;
                flex-shrink: 0 !important;
            }
            .sc-settings-test:hover { background: rgba(255,255,255,0.14) !important; }
            .sc-settings-test-status { font-size: 11px !important; min-height: 14px !important; }
            .sc-test-ok  { color: #90ffa0 !important; }
            .sc-test-bad { color: #ff8888 !important; }
            .sc-test-pending { color: rgba(255,255,255,0.5) !important; }
        `;
        document.head.appendChild(style);
    });

})();