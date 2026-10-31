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
    /* ==========================================================
       PROFILE PICTURE HOVER CARD
       CyTube's native userlist shows a user's profile image/text on
       hover, but we hide that list entirely. The profile still lives
       in jQuery's .data('profile') on each hidden .userlist_item (kept
       current by CyTube's own setUserProfile handler), so read it from
       there and show our own card when hovering a users-panel row.
    ========================================================== */
    function getUserProfile(username) {
        const $ = _uw.jQuery;
        if (!$ || !username) return null;
        const item = [...document.querySelectorAll('#userlist .userlist_item')]
            .find(el => $(el).data('name') === username);
        const profile = item && $(item).data('profile');
        if (!profile) return null;
        const image = /^https?:\/\//i.test(profile.image || '') ? profile.image : '';
        const text = (profile.text || '').trim();
        return (image || text) ? { image, text } : null;
    }

    let _profileCard = null;
    let _profileCardAnchor = null;
    function hideProfileCard() {
        if (_profileCard) _profileCard.style.display = 'none';
        _profileCardAnchor = null;
    }
    function showProfileCard(username, anchorEl) {
        // mouseover re-fires when crossing between a row's thumbnail and its
        // text; rebuilding then would restart the image load and flicker.
        if (anchorEl === _profileCardAnchor) return;
        const profile = getUserProfile(username);
        if (!profile || !profile.image) { hideProfileCard(); return; }
        if (!_profileCard) {
            _profileCard = document.createElement('div');
            _profileCard.id = 'sc-profile-card';
            document.body.appendChild(_profileCard);
        }
        _profileCard.innerHTML = '';
        const img = document.createElement('img');
        img.alt = '';
        // Size is unknown until the image loads, so re-place once it has
        img.addEventListener('load', () => placeProfileCard(anchorEl));
        img.addEventListener('error', hideProfileCard);
        img.src = profile.image;
        const name = document.createElement('div');
        name.className = 'sc-profile-card-name';
        name.style.color = resolveUserColor(username);
        name.textContent = username;
        _profileCard.append(img, name);
        if (profile.text) {
            const text = document.createElement('div');
            text.className = 'sc-profile-card-text';
            text.textContent = profile.text;
            _profileCard.appendChild(text);
        }
        _profileCard.style.display = 'block';
        _profileCardAnchor = anchorEl;
        placeProfileCard(anchorEl);
    }
    // Sit beside the hovered row, flipped/clamped to stay on screen
    // (the panel hugs the right edge in widescreen, the bottom in portrait).
    function placeProfileCard(anchorEl) {
        if (!_profileCard || _profileCard.style.display === 'none') return;
        const r = anchorEl.getBoundingClientRect();
        const cw = _profileCard.offsetWidth, ch = _profileCard.offsetHeight;
        let left = r.left - cw - 10;
        if (left < 6) left = Math.min(r.right + 10, window.innerWidth - cw - 6);
        let top = r.top + r.height / 2 - ch / 2;
        top = Math.max(6, Math.min(top, window.innerHeight - ch - 6));
        _profileCard.style.left = `${Math.max(6, left)}px`;
        _profileCard.style.top = `${top}px`;
    }

    // Users-panel rows only -- hovering chat usernames proved too distracting.
    function profileHoverTarget(el) {
        const panelRow = el.closest && el.closest('.sc-users-panel-name[data-username]');
        return panelRow ? { username: panelRow.dataset.username, anchor: panelRow } : null;
    }

    let _profileHoverInstalled = false;
    function installProfileHoverCard() {
        if (_profileHoverInstalled) return;
        _profileHoverInstalled = true;
        document.addEventListener('mouseover', e => {
            const t = profileHoverTarget(e.target);
            if (t) showProfileCard(t.username, t.anchor);
        });
        document.addEventListener('mouseout', e => {
            const t = profileHoverTarget(e.target);
            if (!t) return;
            // Moving between children of the same name isn't leaving it
            if (e.relatedTarget && t.anchor.contains(e.relatedTarget)) return;
            hideProfileCard();
        });
        // Only a scroll that actually moves the hovered row (the users panel
        // itself) should hide the card -- chat auto-scrolling on every new
        // message must not, or it vanishes until the cursor is wiggled.
        document.addEventListener('scroll', e => {
            if (!_profileCardAnchor) return;
            const t = e.target;
            if (t === document || (t.contains && t.contains(_profileCardAnchor))) hideProfileCard();
        }, true);
    }

    let _decorationObserverStarted = false;
    function startUserDecorationObserver() {
        const buf = document.getElementById('messagebuffer');
        if (!buf) return;
        if (_decorationObserverStarted) { applyUserDecorations(); return; }
        _decorationObserverStarted = true;
        installProfileHoverCard();
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
