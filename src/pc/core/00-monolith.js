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
                if (lead > 0 && typeof isYouTubeMedia === 'function' && !isYouTubeMedia() && typeof data?.currentTime === 'number') {
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
    // optional module is present in a given build. hideLineupScreen -- tonights-lineup
    // module -- is typeof-guarded below for the same reason.)
    const ARROW_SEEK_STEP_SEC = 5;
    document.addEventListener('keydown', (e) => {
        const t = e.target;
        if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
        // hideLineupScreen lives in the optional tonights-lineup module -- typeof-guarded
        // so a build without it doesn't throw here (same pattern movie-title-links and
        // imdb-trivia use for calls into each other).
        if (e.key === 'Escape') { if (typeof hideLineupScreen === 'function') hideLineupScreen(); return; }
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
            if (typeof movieLinkCache !== 'undefined') { movieLinkCache = {}; }
            try { localStorage.removeItem(LS_MOVIE_CACHE); } catch (e) {}
            lastMovieTitle = '';
            if (typeof triggerTitleInject === 'function') triggerTitleInject();
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
       TOP-BAR / GAP-BUTTON DIM-ON-IDLE — generic chrome-dimming shared by
       every floating button (poster toggle, movie links, trivia, fs/desync/
       gif/settings), not specific to any one optional feature. Stays here
       in core rather than moving with any of them: 08-desync.js reads
       _gapShow directly, and the tonights-lineup module's initPosterStrip
       reads _topBarWake/_topBarIsOpen (both safe -- core always loads).
    ========================================================== */

    // Global wake/dim control — exposed so initPosterStrip (tonights-lineup
    // module) can call wake()
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

    // Chat/UI text face -- Inter, tuned for legibility at small sizes (tall x-height,
    // open counters). Loaded once up front since chat is visible from page load,
    // unlike the tonights-lineup module's own on-demand section-theme fonts
    // (lineupEnsureThemeFontsLoaded). Core, not lineup-specific -- waitForBody below
    // calls this unconditionally, so it must exist in every build regardless of which
    // optional modules are selected.
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

        const style = document.createElement('style');
        style.textContent = `

            /* Resizable chat panel — width (horizontal layout) / height (vertical layout).
               Read from localStorage at boot; dragged live by #sc-chat-resizer. */
            :root {
                --sc-chat-w: ${getChatPanelWidth()}vw;
                --sc-chat-h: ${getChatPanelHeight()}vh;
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
