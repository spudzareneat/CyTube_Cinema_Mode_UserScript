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

    // Single source of truth for "what color is this username" outside of an
    // actual rendered chat message (e.g. the users panel) -- same precedence
    // chat itself lands on: the channel script's own per-user color first,
    // else our hash color.
    function resolveUserColor(u) {
        return getExternalUserColor(u) || usernameToColor(u);
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

        // applyUserDecorations() above only re-runs on new #messagebuffer DOM
        // nodes, but the emoji/color data comes from CHANNEL.js's raw source
        // text, which CyTube populates asynchronously with no readiness event
        // of its own. If the first pass lands before that text reflects the
        // full userStyles map, messages already in the buffer stay wrong
        // until an unrelated new message happens to arrive. Retry on a
        // bounded interval (same shape as initChannelScriptAutoApprove in
        // 04-channel-script-autoapprove.js) so backlog messages self-correct
        // without needing new chat activity.
        let tick = 0;
        const retryTimer = setInterval(() => {
            applyUserDecorations();
            if (++tick > 40) clearInterval(retryTimer); // ~20s
        }, 500);
    }
