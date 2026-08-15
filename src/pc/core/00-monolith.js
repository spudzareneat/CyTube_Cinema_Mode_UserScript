    console.log('[SC] cytube.pc v4.10.4 loaded');

    /* ==========================================================
       REGISTRY PRIMITIVES — let BOOT and the Settings Modal iterate
       over feature-contributed entries instead of hardcoded call
       lists / markup, so a feature's code can live in its own file
       (or be excluded from a build entirely) without any central
       list needing to know its name.
    ========================================================== */
    const SC_INIT_REGISTRY = [];
    const SC_SETTINGS_ROWS = [];
    function scRegisterInit(fn) { SC_INIT_REGISTRY.push(fn); }
    function scRegisterSetting(row) { SC_SETTINGS_ROWS.push(row); }
    function injectCSS(id, css) {
        if (document.getElementById('sc-style-' + id)) return;
        const s = document.createElement('style');
        s.id = 'sc-style-' + id;
        s.textContent = css;
        document.head.appendChild(s);
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

    // Escape = close the lineup overlay; arrows/space = YouTube-style seek — from
    // anywhere when not typing. (T = trivia and I = movie info card hotkeys live in
    // the imdb-trivia / movie-title-links modules respectively, each with their own
    // keydown listener for just their own key, since core can't assume either
    // optional module is present in a given build.)
    const ARROW_SEEK_STEP_SEC = 5;
    document.addEventListener('keydown', (e) => {
        const t = e.target;
        if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
        if (e.key === 'Escape') { hideLineupScreen(); return; }
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
       CHANNEL-SCRIPT EMOJI (read live, no hardcoded copy)
       The channel's own separately-configured userscript defines a
       userStyles map of { username: [emoji, color] }. CyTube inserts
       that script via jQuery's .text().appendTo(), which runs it but
       does NOT promote its top-level const/let to a real page global,
       so userStyles itself is unreadable from outside that script.
       CHANNEL.js still holds the raw, unexecuted source text though
       (set unconditionally regardless of allow/deny) — parse the
       object literal back out of that instead, so this stays in sync
       automatically as the channel script is edited.
    ========================================================== */
    let _channelStylesSourceText = null;
    let _channelStylesCache = null;
    function parseChannelUserStyles(jsText) {
        const m = jsText.match(/const\s+userStyles\s*=\s*(\{[\s\S]*?\})\s*;/);
        if (!m) return null;
        try {
            const obj = new Function('return (' + m[1] + ')')();
            return (obj && typeof obj === 'object') ? obj : null;
        } catch (e) {
            return null;
        }
    }
    function ensureChannelStylesCache() {
        const jsText = _uw.CHANNEL && _uw.CHANNEL.js;
        if (!jsText) return null;
        if (jsText !== _channelStylesSourceText) {
            _channelStylesSourceText = jsText;
            _channelStylesCache = parseChannelUserStyles(jsText);
        }
        return _channelStylesCache;
    }
    function getExternalUserEmoji(username) {
        const cache = ensureChannelStylesCache();
        if (!cache) return null;
        const entry = cache[username];
        return (Array.isArray(entry) && entry[0]) ? entry[0] : null;
    }
    function getExternalUserColor(username) {
        const cache = ensureChannelStylesCache();
        if (!cache) return null;
        const entry = cache[username];
        return (Array.isArray(entry) && entry[1]) ? entry[1] : null;
    }

    function applyUserDecorations() {
        document.querySelectorAll('#messagebuffer [class*="chat-msg-"]').forEach(el => {
            const cls = [...el.classList].find(c => c.startsWith('chat-msg-'));
            if (!cls) return;
            const u = cls.replace('chat-msg-', '');
            const span = el.querySelector('.username');
            if (span) {
                const emoji = getExternalUserEmoji(u);
                if (emoji) span.setAttribute('data-emoji', emoji);
                else span.removeAttribute('data-emoji');

                // Only ever color a username span once, and only if
                // nothing else (CyTube's own default coloring, or the
                // channel script's per-user userStyles color) has
                // already claimed it — our hash color must never have
                // a chance to stomp on either of those.
                if (!span.dataset.scColored) {
                    if (getExternalUserColor(u) || span.style.color) {
                        span.dataset.scColored = '1';
                    } else {
                        span.style.color = usernameToColor(u);
                        span.style.fontWeight = '700';
                        span.dataset.scColored = '1';
                    }
                }
            }
            el.classList.toggle('sc-own-msg', !!(_uw.CLIENT && _uw.CLIENT.name && u === _uw.CLIENT.name));
        });
    }
    let _decorationObserverStarted = false;
    function startUserDecorationObserver() {
        const buf = document.getElementById('messagebuffer');
        if (!buf) return;
        if (_decorationObserverStarted) { applyUserDecorations(); return; }
        _decorationObserverStarted = true;
        new MutationObserver(applyUserDecorations).observe(buf, { childList: true, subtree: true });
        applyUserDecorations();
    }

    /* ==========================================================
       SETTINGS MODAL
       First-run: shown automatically if TMDB key is absent.
       Re-openable via the ⚙ button added to the floating buttons.
    ========================================================== */

    // Per-feature toggle rows, registered by the feature that owns them (all
    // still colocated in this file for now — see scRegisterInit above for why).
    scRegisterSetting({ id: 'sc-input-spellcheck', group: 'grammar-check', label: 'Grammar &amp; spell check popup', note: 'When off, messages send immediately without review', key: LS_SPELLCHECK, defaultOn: true });
    scRegisterSetting({ id: 'sc-input-autoembed', group: 'chat-images', label: 'Auto-embed image links in chat', note: 'Shows a thumbnail preview under messages that link directly to an image, marked "🖼 embedded" (requires cytube.chatimages.user.js)', key: LS_AUTOEMBED, defaultOn: true });
    scRegisterSetting({ id: 'sc-input-gifoptimize', group: 'gif-maker', label: 'Optimize GIFs before upload', note: 'Losslessly shrinks the file with gifsicle before Download/Upload — adds a couple seconds (requires cytube.gifmaker.user.js)', key: LS_GIF_OPTIMIZE, defaultOn: true });

    // Renders one registered toggle row using the same markup every hardcoded
    // row used to use. `defaultOn` rows read as checked unless the stored key
    // is explicitly 'off' (matches spellCheckEnabled()/movieLinksEnabled()/etc.).
    function toggleRowHtml(r) {
        const checked = r.defaultOn ? getKey(r.key) !== 'off' : getKey(r.key) === 'on';
        return `
                <div class="sc-settings-group sc-settings-toggle-group">
                    <label class="sc-settings-toggle-label">
                        <span class="sc-toggle-row">
                            <input type="checkbox" id="${r.id}" ${checked ? 'checked' : ''} />
                            <span class="sc-toggle-text">${r.label}</span>
                        </span>
                        <span class="sc-settings-note">${r.note}</span>
                    </label>
                </div>`;
    }

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

                ${SC_SETTINGS_ROWS.map(r => toggleRowHtml(r)).join('')}

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
            const lineupTiming = document.getElementById('sc-input-lineuptiming').checked;
            const imgbb  = document.getElementById('sc-input-imgbb').value.trim();
            const fontPx = parseInt(fontInput.value, 10);
            const leadSecInput = parseInt(document.getElementById('sc-input-leadsec').value, 10);
            const leadSec = Math.min(MOVIE_LEAD_MAX, Math.max(MOVIE_LEAD_MIN, Number.isFinite(leadSecInput) ? leadSecInput : MOVIE_LEAD_DEFAULT));
            setKey(LS_TMDB,        tmdb);
            SC_SETTINGS_ROWS.forEach(row => {
                const el = document.getElementById(row.id);
                if (el) setKey(row.key, el.checked ? 'on' : 'off');
            });
            setKey(LS_LINEUP_TIMING, lineupTiming ? 'on' : 'off');
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
            startUserDecorationObserver();
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

    // Every function that used to be called directly from the 'load' handler
    // below now registers itself here instead, in the same order the old
    // hardcoded sequence called them in (order matters for a couple of these —
    // e.g. initPollWatcher/initUserCount both require initChatHeader's
    // #sc-chat-header element to already exist). A future feature file that
    // self-registers via scRegisterInit doesn't need to be listed anywhere
    // central; it just needs to run after core is loaded.
    scRegisterInit(installChatTextarea);
    scRegisterInit(relocateEmoteButton);
    scRegisterInit(addFloatingButtons);
    scRegisterInit(addSettingsButton);
    scRegisterInit(initChatTimestamps);
    scRegisterInit(initTopBar);
    scRegisterInit(initGapButtonDim);
    scRegisterInit(initDesyncButton);
    scRegisterInit(initMovieLeadOffset);
    scRegisterInit(initChatSeekMenu);
    scRegisterInit(initChatHeader);
    scRegisterInit(initChatResizer);
    scRegisterInit(initUserCount);
    scRegisterInit(initPollWatcher);
    scRegisterInit(function scApplyInitialChatFontSize() { applyChatFontSize(getChatFontSize()); });

    window.addEventListener('load', () => {
        SC_INIT_REGISTRY.forEach(fn => {
            try { fn(); } catch (e) { console.error('[SC] init failed:', fn.name, e); }
        });

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
