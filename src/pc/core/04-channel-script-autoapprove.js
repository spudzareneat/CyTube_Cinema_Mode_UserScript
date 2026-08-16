    /* ==========================================================
       CHANNEL SCRIPT AUTO-APPROVE
       CyTube prompts once per channel (#chanjs-allow-prompt) before
       running channel-configured CSS/JS. Pre-seed the same
       localStorage key CyTube already trusts (channel_js_pref) plus
       a short-lived safety-net auto-click, so the prompt never
       blocks/interrupts the user.
    ========================================================== */
    function initChannelScriptAutoApprove() {
        const KEY = 'channel_js_pref';

        function seedPrefs() {
            const name = _uw.CHANNEL && _uw.CHANNEL.name && _uw.CHANNEL.name.toLowerCase();
            if (!name) return false;
            let prefs;
            try { prefs = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { prefs = {}; }
            prefs[name + '_embedded'] = 'ALLOW';
            localStorage.setItem(KEY, JSON.stringify(prefs));
            // CyTube's own script may have already read JSPREF from localStorage before
            // this ran -- patch the live copy too so a prompt already in flight resolves
            // to ALLOW instead of racing us. JSPREF is a `var` global, so _uw.JSPREF works.
            if (_uw.JSPREF && typeof _uw.JSPREF === 'object') {
                _uw.JSPREF[name + '_embedded'] = 'ALLOW';
                _uw.JSPREF[name + '_external'] = 'ALLOW';
            }
            return true;
        }

        function dismissPromptIfShown() {
            const allow = document.getElementById('chanjs-allow');
            if (!allow) return;
            const remember = document.getElementById('chanjs-save-pref');
            if (remember) remember.checked = true;
            allow.click();
        }

        // prompt renders before the seed takes effect.
        let tick = 0;
        const timer = setInterval(() => {
            seedPrefs();
            dismissPromptIfShown();
            if (++tick > 40) clearInterval(timer); // ~20s
        }, 500);
    }
    initChannelScriptAutoApprove();

    function getChatFontSize() {
        const v = parseInt(getKey(LS_CHAT_FONT), 10);
        return (Number.isFinite(v) && v >= 10 && v <= 32) ? v : 14;
    }
    // MOVIE_LEAD_MIN/MAX/DEFAULT + getMovieLeadSec() moved to
    // src/pc/modules/movie-lead-time/index.js — see that file.
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
