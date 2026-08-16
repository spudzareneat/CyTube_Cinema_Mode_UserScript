// ==UserScript==
// @name         CyTube Fullscreen Video with Overlay Chat
// @namespace    http://tampermonkey.net/
// @version      4.10.4
// @description  Fullscreen layout with selectable optional modules (GIF maker, chat image embeds, subtitle sync, and more) built to order via the customizer — LanguageTool grammar, inline error editor, tab-complete, movie links, IMDb trivia & parent guide, right-click chat-to-movie seek, Tonight's Lineup schedule overlay, resizable chat panel, vertical monitor support
// @match        https://cytu.be/r/420Grindhouse
// @match        https://cytu.be/r/testing
// @grant        GM_xmlhttpRequest
// @connect      api.themoviedb.org
// @connect      en.wikipedia.org
// @connect      raw.githubusercontent.com
// @connect      api.languagetool.org
// @connect      cdnjs.cloudflare.com
// @connect      cdn.jsdelivr.net
// @connect      api.imgbb.com
// @connect      caching.graphql.imdb.com
// @connect      www.reddit.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.js
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

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
    // `type` selects the rendering/persistence behavior in the settings modal:
    //   'checkbox' (default) — <input type="checkbox">, persisted 'on'/'off'.
    //   'text'    — <input type="text">, optional Test button when `testHandler`
    //               (async (value) => 'valid'|'invalid'|'error') is provided.
    //   'number'  — <input type="number"> using `min`/`max`/`step` from the row.
    // Existing callers that omit `type` keep rendering as checkboxes unchanged.
    function scRegisterSetting(row) { SC_SETTINGS_ROWS.push({ type: 'checkbox', ...row }); }
    function injectCSS(id, css) {
        if (document.getElementById('sc-style-' + id)) return;
        const s = document.createElement('style');
        s.id = 'sc-style-' + id;
        s.textContent = css;
        (document.head || document.documentElement).appendChild(s);
    }
    /* ==========================================================
       MOVIE IDENTITY
       Title parsing + now-playing state shared across several
       optional modules (Movie Links, Chat → Movie Seek, IMDb Trivia)
       and read by the always-on GIF MAKER INTEGRATION BRIDGE in
       03-gif-bridge.js. Kept here in core -- rather than inside
       whichever optional module happens to own title-change
       detection or TMDB/IMDb lookups -- so the bridge never has to
       guess whether a build that excluded those modules still
       declared these; they're always present.
    ========================================================== */

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

    /* ==========================================================
       NOW-PLAYING STATE
       lastMovieTitle is kept in sync by whichever optional module
       currently owns title-change detection (normally Movie Links'
       injectMovieLinks()); _npData is populated by IMDb Trivia's/
       Movie Links' TMDB+IMDb lookup once it resolves for the current
       title. Both start empty/null and simply stay that way in a
       build that excludes those modules -- consumers (the GIF
       bridge, Tonight's Lineup, etc.) must treat '' / null as "no
       data yet" rather than assume a module populated them.
    ========================================================== */

    let lastMovieTitle = '';
    let _npData         = null;

    // Filesystem/URL-safe slug of the currently playing movie, e.g. "Blade-Runner-1982".
    // Falls back to '' when no title has been detected yet.
    function _gifTitleSlug() {
        if (!lastMovieTitle) return '';
        const { title, year } = parseMovieFilename(lastMovieTitle);
        let slug = title.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
        if (year) slug += '-' + year;
        return slug;
    }

    // {title, year, imdbId} for the currently playing movie, used by the GIF
    // bridge (03-gif-bridge.js) so legacy standalone scripts (e.g.
    // cytube.subtitles.user.js) can build lookups without re-deriving this
    // themselves. title/year come from the same source _gifTitleSlug() uses
    // (available once a video is playing); imdbId is only set once the Now
    // Playing card's TMDB lookup has resolved for this video (requires a TMDB
    // key -- null otherwise, caller falls back). Returns null when no title
    // has been detected yet.
    function getBridgeMovieInfo() {
        if (!lastMovieTitle) return null;
        const { title, year } = parseMovieFilename(lastMovieTitle);
        if (!title) return null;
        return { title, year: year || null, imdbId: (_npData && _npData.imdbId) || null };
    }
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
       _gifTitleSlug(), lastMovieTitle, _npData, and getBridgeMovieInfo()
       referenced below live in 01-movie-identity.js (core, always
       bundled) precisely so this always-on bridge can never be built
       without them -- see that file's MOVIE IDENTITY section header.
       getTitleSlug/getMovieInfo below already null-guard the *values*
       (empty title / no _npData yet); that's independent of, and
       doesn't change with, where the declarations themselves live.
    ========================================================== */
    const _uw = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    _uw.__SC_GIF_BRIDGE__ = {
        version: 1,
        getTitleSlug: () => _gifTitleSlug(),
        // Used by cytube.subtitles.user.js to build an OpenSubtitles search
        // link. See getBridgeMovieInfo() in 01-movie-identity.js for the
        // derivation.
        getMovieInfo: () => getBridgeMovieInfo(),
        openGifPanel: undefined, // filled in by the gifmaker module once it boots
    };
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
       SEND FLOW — doSend() is the actual "put the message on the
       wire" mechanics, needed by every build whether or not the
       optional grammar-check module is present. The higher-level
       decision of whether to review a message first (attemptSend,
       LanguageTool check, readability checks, the review modal) lives
       in that module now; core's 06-chat-textarea-install.js
       typeof-guards its call to attemptSend and falls straight to
       doSend when the module is excluded, so chat still sends
       immediately with no review step in that build.
    ========================================================== */

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
                    // attemptSend lives in the optional grammar-check module -- typeof-guarded
                    // so a build without it sends immediately via doSend instead of throwing
                    // (same pattern core uses for other optional-module calls, e.g. the
                    // hideLineupScreen guard in 12-playback-sync-and-seek.js).
                    if (typeof attemptSend === 'function') {
                        attemptSend(textarea, originalInput);
                    } else {
                        const text = textarea.value.trim();
                        if (text) doSend(textarea, originalInput, text);
                    }
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

    // NOTE: addFloatingButtons() itself lives much further down in the original
    // script (original ~line 1002, near the CHAT -> MOVIE SEEK section) rather
    // than right under this banner (original ~664-669, banner-only). Moved here
    // to keep the banner and its implementation together -- see task-4-report.md
    // for why this deviates from the brief's literal line range.
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
       USER COLOR SYSTEM
    ========================================================== */

    function hashString(str) {
        let h = 5381;
        for (let i = 0; i < str.length; i++) { h = ((h << 5) + h) ^ str.charCodeAt(i); h |= 0; }
        return Math.abs(h);
    }
    function usernameToColor(u) {
        // Golden angle multiplication spreads hues maximally apart so
        // no two nearby hash values share a similar colour.
        const hue = (hashString(u) * 137.508) % 360;
        return `hsl(${hue.toFixed(1)}, 72%, 70%)`;
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

    // Lives in core (not movie-title-links) because it's needed unconditionally by
    // the Movie Lead Time interceptor below, which core always ships regardless of
    // which optional modules are included. movie-title-links also calls this (it
    // depends on core, so it's always available there too) to decide whether to
    // parse a title as a YouTube video vs. a movie filename.
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

    // installMovieLeadInterceptor()/initMovieLeadOffset() (and the
    // MOVIE_LEAD_MIN/MAX/DEFAULT + getMovieLeadSec() they use) moved to
    // src/pc/modules/movie-lead-time/index.js — see that file. That module
    // depends on core (not the other way around): it reaches into
    // _getMediaUpdateListeners()/socket/_desync (core/08-desync.js) and
    // isYouTubeMedia() (below, unchanged) but nothing here calls back into
    // it, so excluding the module leaves no dangling reference.

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
            const connected = getUsers().length;
            // Prefer CyTube's own count (accurate, socket-driven)
            const cytubCount = document.getElementById('usercount');
            const raw = cytubCount?.textContent?.match(/\d+/)?.[0];
            const total = raw ? parseInt(raw) : connected;
            btn.innerHTML =
                `<span class="sc-usercount-part" title="Connected">🗨 ${connected}</span>` +
                `<span class="sc-usercount-part" title="Total users">👁 ${total}</span>`;
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
       SETTINGS MODAL
       First-run: shown automatically if TMDB key is absent.
       Re-openable via the ⚙ button added to the floating buttons.
    ========================================================== */

    // Per-feature toggle rows, registered by the feature that owns them (all
    // still colocated in this file for now — see scRegisterInit above for why).
    // sc-input-spellcheck (grammar-check) moved to
    // src/pc/modules/grammar-check/index.js — see that file.
    // sc-input-autoembed (chatimages) moved to
    // src/pc/modules/chatimages/index.js — see that file.
    // sc-input-gifoptimize and sc-input-imgbb (gif-maker) moved to
    // src/pc/modules/gifmaker/index.js — see that file. `order` reproduces
    // the original shipped script's row sequence (spellcheck=1,
    // movielinks=2, autoembed=3, gifoptimize=4, lineuptiming=5, imgbb=6);
    // rows are sorted by it below rather than rendered in registration
    // order, since registration order depends on which optional modules a
    // build includes and in what order their files happen to load.

    // Renders one registered settings row, branching on `r.type` (defaulted to
    // 'checkbox' by scRegisterSetting). Dispatches to a per-type renderer below.
    function settingsRowHtml(r) {
        if (r.type === 'text') return textRowHtml(r);
        if (r.type === 'number') return numberRowHtml(r);
        return checkboxRowHtml(r);
    }

    // Same markup every hardcoded checkbox row used to use, now shared by any
    // row registered with type:'checkbox' (or no type at all). `defaultOn` rows
    // read as checked unless the stored key is explicitly 'off' (matches
    // spellCheckEnabled()/movieLinksEnabled()/etc.).
    function checkboxRowHtml(r) {
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

    // Text-input row, modeled on the hardcoded TMDB key field below
    // (input + optional Test button + status line + optional "get a key"
    // link). `r.testHandler`, if present, is an async (value) =>
    // 'valid'|'invalid'|'error' function — wireTextRowTestButton() below
    // hooks it up once the row is in the DOM. `r.link`/`r.linkText`, if
    // both present, render an <a target="_blank" rel="noopener"> below the
    // status line, matching the hardcoded TMDB field's own "Get a free TMDB
    // key ↗" link — lets a registered row (e.g. gifmaker's ImgBB field)
    // carry the same kind of sign-up instructions/link the TMDB field has
    // without smuggling markup through `note`.
    function textRowHtml(r) {
        const val = getKey(r.key);
        return `
                <div class="sc-settings-group sc-settings-divider">
                    <label class="sc-settings-label">
                        ${r.label}
                        <span class="sc-settings-note">${r.note}</span>
                    </label>
                    <div class="sc-settings-input-row">
                        <input id="${r.id}" class="sc-settings-input" type="text"
                            placeholder="${r.placeholder || ''}" value="${val}" spellcheck="false" />
                        ${r.testHandler ? `<button id="${r.id}-test" class="sc-settings-test" type="button">Test</button>` : ''}
                    </div>
                    ${r.testHandler ? `<span id="${r.id}-test-status" class="sc-settings-test-status"></span>` : ''}
                    ${r.link && r.linkText ? `<a class="sc-settings-link" href="${r.link}" target="_blank" rel="noopener">${r.linkText}</a>` : ''}
                </div>`;
    }

    // Number-input row, modeled on the hardcoded Movie Lead Time field below.
    // Stored value is clamped to [min, max], falling back to `defaultValue`
    // (or `min`) when unset/non-numeric — the exact clamping order the Movie
    // Lead Time field uses today: Math.min(max, Math.max(min, finite ? v : default)).
    function numberRowHtml(r) {
        const raw = parseInt(getKey(r.key), 10);
        const fallback = r.defaultValue ?? r.min;
        const val = Math.min(r.max, Math.max(r.min, Number.isFinite(raw) ? raw : fallback));
        return `
                <div class="sc-settings-group sc-settings-toggle-group">
                    <label class="sc-settings-label">
                        ${r.label}
                        <span class="sc-settings-note">${r.note}</span>
                    </label>
                    <input id="${r.id}" class="sc-settings-input" type="number"
                        min="${r.min}" max="${r.max}" step="${r.step ?? 1}" value="${val}" style="width:5em" />
                </div>`;
    }

    // Wires up the Test button for a rendered text row that declared a
    // testHandler, mirroring the TMDB Test button behavior below: disable
    // while checking, show a pending message, then a result message with
    // the matching status class. Messages are overridable per-row via
    // testEmptyMessage/testValidMessage/testInvalidMessage/testErrorMessage
    // so a registered row (e.g. gifmaker's ImgBB field) can match its own
    // pre-existing copy exactly.
    function wireTextRowTestButton(r) {
        if (r.type !== 'text' || !r.testHandler) return;
        const btn = document.getElementById(r.id + '-test');
        const status = document.getElementById(r.id + '-test-status');
        if (!btn || !status) return;
        btn.addEventListener('click', async () => {
            const value = document.getElementById(r.id).value.trim();
            if (!value) {
                status.textContent = r.testEmptyMessage || 'Enter a value first';
                status.className = 'sc-settings-test-status sc-test-bad';
                return;
            }
            btn.disabled = true;
            status.textContent = 'Checking…';
            status.className = 'sc-settings-test-status sc-test-pending';
            const result = await r.testHandler(value);
            btn.disabled = false;
            if (result === 'valid') {
                status.textContent = r.testValidMessage || '✓ Valid';
                status.className = 'sc-settings-test-status sc-test-ok';
            } else if (result === 'invalid') {
                status.textContent = r.testInvalidMessage || '✗ Invalid';
                status.className = 'sc-settings-test-status sc-test-bad';
            } else {
                status.textContent = r.testErrorMessage || '⚠ Couldn\'t verify';
                status.className = 'sc-settings-test-status sc-test-bad';
            }
        });
    }

    // Sorted view of SC_SETTINGS_ROWS used at render time -- doesn't mutate the
    // registry itself, since scRegisterSetting() may still be called by an
    // optional module's file after core has already loaded (same build, later
    // in emission order) but before the settings modal is ever opened.
    function sortedSettingsRows() {
        return SC_SETTINGS_ROWS.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
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

    function openSettingsModal() {
        const old = document.getElementById('sc-settings-overlay');
        if (old) old.remove();

        const tmdbVal  = getKey(LS_TMDB);
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

                ${sortedSettingsRows().map(r => settingsRowHtml(r)).join('')}

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

        // Wire up Test buttons for any registered text rows that declared one.
        sortedSettingsRows().forEach(r => wireTextRowTestButton(r));

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

        document.getElementById('sc-settings-save').addEventListener('click', () => {
            const tmdb   = tmdbToggle.checked ? document.getElementById('sc-input-tmdb').value.trim() : '';
            const fontPx = parseInt(fontInput.value, 10);
            setKey(LS_TMDB,        tmdb);
            SC_SETTINGS_ROWS.forEach(row => {
                const el = document.getElementById(row.id);
                if (!el) return;
                if (row.type === 'text') {
                    setKey(row.key, el.value.trim());
                } else if (row.type === 'number') {
                    const raw = parseInt(el.value, 10);
                    const fallback = row.defaultValue ?? row.min;
                    const clamped = Math.min(row.max, Math.max(row.min, Number.isFinite(raw) ? raw : fallback));
                    setKey(row.key, String(clamped));
                } else {
                    setKey(row.key, el.checked ? 'on' : 'off');
                }
            });
            setKey(LS_CHAT_FONT,   String(fontPx));
            applyChatFontSize(fontPx);
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
    // initMovieLeadOffset moved to src/pc/modules/movie-lead-time/index.js,
    // which self-registers via its own scRegisterInit call — see that file.
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
            /* Moved to src/pc/modules/grammar-check/style.css — see that file. */

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
injectCSS('core', `            /* ===== SHARED HIDDEN ELEMENTS ===== */
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
            .sc-usercount-part { margin: 0 3px !important; }

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
            /* Emoji sourced live from the channel's own userStyles map — see
               getExternalUserEmoji(). Fixed-width slot so names all start
               at the same x position regardless of glyph width. */
            #messagebuffer .username[data-emoji]::before {
                content: attr(data-emoji);
                display: inline-block;
                width: 1.3em;
                margin-right: 0.15em;
                text-align: center;
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
`);
    /* ==========================================================
       MOVIE LINKS — TMDB lookup → confirmed IMDb + Letterboxd + Wikipedia
       Populates the shared `_npData` (declared once in core's
       01-movie-identity.js) with everything the Now Playing card and
       the floating stats bar render. `fetchImdbParentalGuide` lives
       in the imdb-trivia module (it shares that module's IMDb GraphQL
       connect grant) — this module only calls it through a
       typeof-guard so a build without imdb-trivia still works, just
       without parental-guide chips. Same pattern for the "Trivia"
       button's click handler (toggleTriviaPanel), and — in the other
       direction — for this module's own calls into the optional
       tonights-lineup module's lineupObserveTitleChange (feeds its
       timing/ETA model; this module doesn't depend on tonights-lineup,
       so a build without it just skips those calls).
    ========================================================== */

    const LINK_DEFS = [
        { key: 'imdb',       label: 'IMDb',       color: '#f5c518', fg: '#000', char: 'i' },
        { key: 'letterboxd', label: 'Letterboxd', color: '#2c4a2e', fg: '#00e054', char: 'L' },
        { key: 'wiki',       label: 'Wikipedia',  color: '#444',    fg: '#eee', char: 'W' },
    ];

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

        // ── IMDb Parent Guide — defined in the imdb-trivia module (shares its IMDb
        // GraphQL connect grant); typeof-guarded so a build without imdb-trivia still
        // resolves the rest of this lookup instead of throwing. ──────────────────────
        const parentalGuide = (typeof fetchImdbParentalGuide === 'function')
            ? await fetchImdbParentalGuide(tmdbResult?.imdbId)
            : null;

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

    // isYouTubeMedia() lives in core (12-playback-sync-and-seek.js) -- core is
    // always a dependency of every module, so it's called directly here with no
    // typeof-guard needed.

    // _currentImdbId is also read by the imdb-trivia module (which depends on this
    // one, so it's guaranteed to exist whenever imdb-trivia is present).
    let _currentImdbId = null;
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
                        <div id="sc-np-links"></div>
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

        // Render movie links badges
        if (movieLinksEnabled()) {
            const linksEl = card.querySelector('#sc-np-links');
            linksEl.innerHTML = '';
            LINK_DEFS.forEach(({ key, label, color, fg, char }) => {
                const url = data.links[key];
                if (!url) return;
                const a = document.createElement('a');
                a.href = url;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.title = label;
                a.className = 'sc-movie-link';
                a.style.background = color;
                a.style.color = fg;
                a.textContent = char;
                a.addEventListener('click', (e) => e.stopPropagation());
                linksEl.appendChild(a);
            });
        }

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
        // lineupObserveTitleChange lives in the optional tonights-lineup module --
        // typeof-guarded so a build without it (this module only depends on core)
        // still injects links/stats normally, just without feeding the lineup's
        // timing/ETA model.
        if (typeof lineupObserveTitleChange === 'function') {
            lineupObserveTitleChange(rawTitle, knownSeconds > 0 ? knownSeconds : null);
        }
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
            _npData = { cleanTitle, cleanYear, poster, backdrop, overview, rating, runtime, genres: genres || [], parentalGuide, killCount, imdbId, links };

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

            // Trivia button — only when we have an IMDb ID and the imdb-trivia module is
            // present (toggleTriviaPanel is defined there; typeof-guarded so a build
            // without it just skips the button instead of throwing on click-handler setup).
            if (imdbId && typeof toggleTriviaPanel === 'function') {
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
                    // typeof-guarded -- see the other call site above in injectMovieLinks.
                    if (data && data.title && typeof lineupObserveTitleChange === 'function') {
                        lineupObserveTitleChange(data.title, data.seconds);
                    }
                    setTimeout(triggerTitleInject, 350);
                } catch (e) {}
            });
        };
        // socket may not be ready at document-start; try at load then again after a short delay
        window.addEventListener('load', () => { tryBind(); setTimeout(tryBind, 2000); });
    }

    // 'I' = movie info card, from anywhere when not typing. Split out from the
    // original combined T/I/Escape/arrows keydown handler so this module's
    // hotkey only depends on functions this module itself defines — see
    // imdb-trivia/index.js for the 'T' half of that original handler.
    document.addEventListener('keydown', (e) => {
        const t = e.target;
        if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
        if (e.key === 'Escape') { hideNowPlayingCard(); return; }
        if (e.key === 'i' || e.key === 'I') {
            const card = document.getElementById('sc-np-card');
            if (card && card.classList.contains('sc-np-visible')) hideNowPlayingCard();
            else if (_npData) showNowPlayingCard(_npData, { autoHide: false });
            return;
        }
    });

    scRegisterInit(getKillCountDb); // pre-fetch kill count DB
    scRegisterInit(watchMovieTitle);
    scRegisterInit(initMediaWatcher);

    // order: 2 reproduces the original shipped script's settings-row sequence
    // (spellcheck, movielinks, autoembed, gifoptimize) — see
    // src/pc/core/15-settings-modal-shell.js, which sorts SC_SETTINGS_ROWS by
    // this field before rendering.
    scRegisterSetting({ id: 'sc-input-movielinks', group: 'movie-title-links', label: 'Show movie links (IMDb / Letterboxd / Wiki)', note: 'Adds clickable badge icons next to the title', key: LS_MOVIE_LINKS, defaultOn: true, order: 2 });
injectCSS('movie-title-links', `            /* ===== MOVIE LINKS ===== */
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
            #sc-np-links { display: flex !important; gap: 6px !important; margin-top: 10px !important; }
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
`);
    /* ==========================================================
       GRAMMAR CHECK — LanguageTool check + readability checks, the
       inline error review modal, and the send-flow glue that invokes
       the review before allowing a chat message to send. Kept as one
       module: none of the three is independently toggleable or useful
       without the others (this is why the existing "grammar/spell-check
       popup on/off" setting below is the single on/off switch for all
       of it).

       Tab-autocomplete (@Name completion on Tab) and its
       getChatUsernames() helper deliberately stayed OUT of this module
       and remain in core (src/pc/core/11-chat-input-and-emotes.js) even
       though buildAnnotation() below also calls
       getChatUsernames() to build its LT-ignore mask -- investigated at
       extraction time (Task 7) and confirmed tab-autocomplete has real
       standalone value (it completes @mentions generally, for any
       chat message, regardless of grammar-check) AND core's
       06-chat-textarea-install.js calls handleTabComplete() directly,
       unconditionally, on every keydown -- moving it here would leave a
       bare reference to an optional module's function in core, exactly
       the coupling bug Task 5 introduced and Task 6 had to fix. So
       buildAnnotation() calls back into core's getChatUsernames() the
       same direction every other module calls into core (an ordinary,
       unguarded call -- core is a mandatory dependency, always present
       in any build that includes this module).

       Send-flow glue works the other direction: attemptSend() (this
       module) is what 06-chat-textarea-install.js's Enter-key handler
       calls to decide whether a message needs review before sending,
       but the actual "send it" mechanics (doSend()) is core, general
       chat-sending machinery needed by every build whether or not this
       module is present. core's call site typeof-guards attemptSend
       and falls back to calling doSend directly when this module is
       excluded, so chat still sends immediately with no review step
       and no ReferenceError -- see 06-chat-textarea-install.js.

       No scRegisterInit here: unlike most modules, none of this code
       needs to run at page-init time -- it's purely reactive, invoked
       through that same typeof-guarded call from core's Enter-key
       handler.
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
       SEND FLOW — invoked from core's 06-chat-textarea-install.js
       Enter-key handler through a typeof-guard (see that file); the
       actual message-sending mechanics (doSend) stay in core so a
       build without this module can still send chat at all.
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

    // order: 1 reproduces the original shipped script's settings-row sequence
    // (spellcheck, movielinks, autoembed, gifoptimize) — see
    // src/pc/core/15-settings-modal-shell.js, which sorts SC_SETTINGS_ROWS by
    // this field before rendering.
    scRegisterSetting({ id: 'sc-input-spellcheck', group: 'grammar-check', label: 'Grammar &amp; spell check popup', note: 'When off, messages send immediately without review', key: LS_SPELLCHECK, defaultOn: true, order: 1 });
injectCSS('grammar-check', `            /* ===== REVIEW MODAL ===== */
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

            /* Produced by showCheckingIndicator() -- sits inline in the chat
               textarea's flex column while a LanguageTool check is in flight. */
            #sc-checking {
                font-size: 11px !important; color: rgba(255,255,200,0.6) !important;
                padding: 2px 4px !important; flex-shrink: 0 !important;
            }
`);
    /* ==========================================================
       CHAT IMAGES — auto-embed for direct image links in chat, with
       hover filenames and a per-image ban/unban. Originally a
       standalone companion script (cytube.chatimages.user.js) that
       detected cytube.pc.user.js at runtime via a polled bridge
       object; now always bundled alongside core, so that detection
       is gone and embeddingEnabled() always honors the Settings
       Modal's toggle directly. `getKey`/`autoEmbedEnabled`/
       `LS_AUTOEMBED` are core's (02-keys-and-helpers.js) — this
       module doesn't redeclare them.
    ========================================================== */
    const LS_BANNED = 'sc_img_banned_urls'; // private to this module -- JSON array of exact banned URLs

    function getBannedUrls() {
        try { return new Set(JSON.parse(getKey(LS_BANNED) || '[]')); }
        catch (e) { return new Set(); }
    }
    function saveBannedUrls(set) { localStorage.setItem(LS_BANNED, JSON.stringify([...set])); }
    function isBanned(url) { return getBannedUrls().has(url); }

    function embeddingEnabled() {
        return autoEmbedEnabled();
    }

    /* ==========================================================
       CHAT IMAGE EMBEDS
       Direct image links posted in chat (postimg.cc, imgur, discord
       cdn, etc.) get a thumbnail preview appended under the message,
       reusing the <a> tags CyTube already auto-linkifies out of the
       raw message text.
    ========================================================== */
    const IMAGE_LINK_RE = /\.(jpe?g|png|gif|webp|bmp)(\?[^\s"']*)?$/i;

    function findImageLinks(msgEl) {
        return [...msgEl.querySelectorAll('a[href]')]
            .filter(a => !a.dataset.scEmbedded && !a.closest('.sc-img-embed')
                && (a.protocol === 'http:' || a.protocol === 'https:') && IMAGE_LINK_RE.test(a.href));
    }

    function filenameFromUrl(url) {
        try {
            const seg = new URL(url).pathname.split('/').filter(Boolean).pop();
            return seg ? decodeURIComponent(seg) : url;
        } catch (e) { return url; }
    }

    // CyTube auto-scrolls the message buffer synchronously when a message is
    // appended, and separately hooks `load` on any <img> present at that time.
    // Our thumbnail is appended asynchronously (via MutationObserver), so it
    // misses both mechanisms -- rescroll manually, but only if the user hadn't
    // scrolled up to read backlog.
    function rescrollChatIfNearBottom() {
        const b = document.getElementById('messagebuffer');
        if (b && b.scrollHeight - b.scrollTop - b.clientHeight < 60) b.scrollTop = b.scrollHeight;
    }

    function applyEmbeddedState(a) {
        const msgEl = a.closest('[class*="chat-msg-"]');
        if (!msgEl) return;
        a.style.display = 'none';
        const wrap = document.createElement('div');
        wrap.className = 'sc-img-embed';
        const link = document.createElement('a');
        link.href = a.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.title = filenameFromUrl(a.href);
        img.onerror = () => { wrap.remove(); a.style.display = ''; };
        img.onload = rescrollChatIfNearBottom;
        img.src = a.href;
        link.appendChild(img);
        const badge = document.createElement('span');
        badge.className = 'sc-img-embed-badge';
        const badgeLabel = document.createElement('span');
        badgeLabel.textContent = '🖼 embedded';
        const toggleBtn = document.createElement('span');
        toggleBtn.className = 'sc-img-embed-toggle';
        toggleBtn.textContent = '🔗';
        toggleBtn.title = 'Show link instead of image';
        toggleBtn.addEventListener('click', () => {
            const showingImage = link.style.display !== 'none';
            link.style.display = showingImage ? 'none' : '';
            a.style.display = showingImage ? '' : 'none';
            badgeLabel.textContent = showingImage ? '🔗 link only' : '🖼 embedded';
            toggleBtn.title = showingImage ? 'Show image instead of link' : 'Show link instead of image';
        });
        const banBtn = document.createElement('span');
        banBtn.className = 'sc-img-embed-ban';
        banBtn.textContent = '🚫';
        banBtn.title = "Hide this image everywhere and don't embed it again";
        banBtn.addEventListener('click', () => banUrl(a.href));
        badge.appendChild(badgeLabel);
        badge.appendChild(toggleBtn);
        badge.appendChild(banBtn);
        wrap.appendChild(link);
        wrap.appendChild(badge);
        msgEl.appendChild(wrap);
        a._scUi = wrap;
        rescrollChatIfNearBottom();
    }

    function applyBannedState(a) {
        const msgEl = a.closest('[class*="chat-msg-"]');
        if (!msgEl) return;
        a.style.display = '';
        const badge = document.createElement('span');
        badge.className = 'sc-img-embed-badge sc-img-embed-banned';
        const label = document.createElement('span');
        label.textContent = '🚫 image hidden';
        const unbanBtn = document.createElement('span');
        unbanBtn.className = 'sc-img-embed-unban';
        unbanBtn.textContent = '↩ unban';
        unbanBtn.title = 'Show this image again';
        unbanBtn.addEventListener('click', () => unbanUrl(a.href));
        badge.appendChild(label);
        badge.appendChild(unbanBtn);
        msgEl.appendChild(badge);
        a._scUi = badge;
    }

    function sweepUrl(url, applyFn) {
        const buf = document.getElementById('messagebuffer');
        if (!buf) return;
        buf.querySelectorAll('a[data-sc-embedded]').forEach(a => {
            if (a.href !== url) return;
            if (a._scUi) a._scUi.remove();
            applyFn(a);
        });
    }
    function banUrl(url) {
        const set = getBannedUrls();
        set.add(url);
        saveBannedUrls(set);
        sweepUrl(url, applyBannedState);
    }
    function unbanUrl(url) {
        const set = getBannedUrls();
        set.delete(url);
        saveBannedUrls(set);
        sweepUrl(url, applyEmbeddedState);
    }

    function renderLink(a) {
        a.dataset.scEmbedded = '1';
        if (isBanned(a.href)) applyBannedState(a);
        else applyEmbeddedState(a);
    }

    function scanImageEmbeds(buf) {
        if (!embeddingEnabled()) return;
        buf.querySelectorAll('[class*="chat-msg-"]').forEach(msgEl => {
            findImageLinks(msgEl).forEach(renderLink);
        });
    }

    let _observerStarted = false;
    function startImageEmbedObserver() {
        const buf = document.getElementById('messagebuffer');
        if (!buf) { requestAnimationFrame(startImageEmbedObserver); return; }
        if (_observerStarted) return;
        _observerStarted = true;
        new MutationObserver(() => scanImageEmbeds(buf)).observe(buf, { childList: true, subtree: true });
        scanImageEmbeds(buf);
    }

    /* ==========================================================
       CSS
    ========================================================== */
    function injectStyle() {
        const style = document.createElement('style');
        style.textContent = `
            .sc-img-embed { display: block !important; margin-top: 4px !important; }
            .sc-img-embed img {
                display: block !important;
                max-width: 100% !important;
                max-height: 150px !important;
                width: auto !important;
                height: auto !important;
                border-radius: 4px !important;
                cursor: pointer !important;
            }
            .sc-img-embed-badge {
                display: flex !important;
                align-items: center !important;
                gap: 5px !important;
                font-size: 10px !important;
                color: rgba(244,244,242,0.45) !important;
                margin-top: 2px !important;
            }
            .sc-img-embed-toggle {
                cursor: pointer !important;
                font-size: 11px !important;
                opacity: 0.6 !important;
                line-height: 1 !important;
            }
            .sc-img-embed-toggle:hover { opacity: 1 !important; }
            .sc-img-embed-ban {
                cursor: pointer !important;
                font-size: 11px !important;
                opacity: 0.6 !important;
                line-height: 1 !important;
            }
            .sc-img-embed-ban:hover { opacity: 1 !important; }
            .sc-img-embed-unban {
                cursor: pointer !important;
                opacity: 0.7 !important;
                text-decoration: underline !important;
            }
            .sc-img-embed-unban:hover { opacity: 1 !important; }
        `;
        document.head.appendChild(style);
    }

    /* ==========================================================
       BOOT
    ========================================================== */
    // Named chatimagesBoot (not waitForBody) — core's own 16-boot.js declares
    // a generic waitForBody in the same shared scope; this module's boot
    // routine has always been distinct code (it only injects this module's
    // style and starts its own observer), so it gets its own name here to
    // avoid the collision now that both files share one IIFE. Called
    // directly here (not via scRegisterInit) to preserve the original
    // script's document-start timing -- scRegisterInit's queue only runs on
    // the page's 'load' event, much later than this module wants to start
    // watching the message buffer.
    function chatimagesBoot() {
        if (!document.body) { requestAnimationFrame(chatimagesBoot); return; }
        injectStyle();
        startImageEmbedObserver();
    }

    chatimagesBoot();

    // order: 3 reproduces the original shipped script's settings-row sequence
    // (spellcheck, movielinks, autoembed, gifoptimize) — see
    // src/pc/core/15-settings-modal-shell.js, which sorts SC_SETTINGS_ROWS by
    // this field before rendering. Row relocated here from core per Task 4 of
    // the companion-scripts-to-modules plan (was previously hardcoded in core
    // since this module didn't exist yet).
    scRegisterSetting({ id: 'sc-input-autoembed', group: 'chat-images', label: 'Auto-embed image links in chat', note: 'Shows a thumbnail preview under messages that link directly to an image, marked "🖼 embedded"', key: LS_AUTOEMBED, defaultOn: true, order: 3 });
    /* ==========================================================
       MOVIE LEAD TIME — run N seconds ahead of the group's synced
       position during movies (not YouTube). Cushions against the
       user's own buffering: if playback stalls, the next mediaUpdate
       correction pushes back up to "group position + lead" instead
       of merely "group position".

       Moved out of core (was core/04-channel-script-autoapprove.js for
       the MOVIE_LEAD_MIN/MAX/DEFAULT constants + getMovieLeadSec(), and
       core/12-playback-sync-and-seek.js for installMovieLeadInterceptor()/
       initMovieLeadOffset()) into this optional module per Task 9 of the
       companion-scripts-to-modules plan. isYouTubeMedia() stays in core
       (core/12-playback-sync-and-seek.js) unchanged -- it's also used by
       movie-title-links, so it's a shared core utility, not something
       this module owns.

       Rather than nudging video.currentTime ourselves (which would
       fight CyTube's own drift correction), an interceptor is
       prepended to the same mediaUpdate listener array _freezeSync/
       _thawSync (core/08-desync.js) already know how to locate — it
       adds the configured lead to the payload's currentTime before
       CyTube's own handler(s) see it, so CyTube's normal seek/smoothing
       logic settles the player the configured amount ahead. This
       composes with desync for free: _freezeSync freezes whatever's
       registered under the mediaUpdate key (the interceptor, wrapping
       CyTube's real handlers) as one unit, and _thawSync restores it
       as-is.
    ========================================================== */

    const MOVIE_LEAD_MIN = 0, MOVIE_LEAD_MAX = 10, MOVIE_LEAD_DEFAULT = 2;
    function getMovieLeadSec() {
        const v = parseInt(getKey(LS_MOVIE_LEAD), 10);
        return (Number.isFinite(v) && v >= MOVIE_LEAD_MIN && v <= MOVIE_LEAD_MAX) ? v : MOVIE_LEAD_DEFAULT;
    }

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

    scRegisterInit(initMovieLeadOffset);

    // Row relocated here from core per Task 9 of the companion-scripts-to-
    // modules plan (was previously hardcoded in core since this module
    // didn't exist yet). order: 7 places it right after the ImgBB row
    // (gifmaker, order: 6) -- the last of the registered feature rows --
    // matching this row's old position as the last hardcoded settings-modal
    // field before the always-present chat-font-size row. min/max/step/
    // defaultValue are carried over byte-for-byte from the old hardcoded
    // core/15-settings-modal-shell.js Movie Lead Time field.
    scRegisterSetting({
        id: 'sc-input-leadsec', group: 'movie-lead-time', type: 'number',
        label: 'Movie lead time (seconds ahead of sync)',
        note: 'Keeps you a few seconds ahead of the group during movies (not YouTube) — cushions against your own buffering. 0 = off.',
        key: LS_MOVIE_LEAD,
        min: MOVIE_LEAD_MIN, max: MOVIE_LEAD_MAX, step: 1, defaultValue: MOVIE_LEAD_DEFAULT,
        order: 7,
    });
    /* ==========================================================
       SUBTITLES — load a local .srt/.vtt subtitle file and sync it to
       native <video> playback, with a persistent font-size setting, a
       draggable/steppable position pad for on-screen caption placement,
       a short-lived per-movie cache that survives a page refresh, and
       an OpenSubtitles search link for the currently playing movie. Not
       available for YouTube playback. Originally a standalone companion
       script (cytube.subtitles.user.js) that detected cytube.pc.user.js
       at runtime via a polled bridge object and offered two UI modes (a
       control-bar-docked button when standalone, a floating button when
       the bridge was present); now always bundled alongside core, so
       that detection/poll loop and the control-bar-docked UI path are
       gone -- only the floating trigger button remains.
       getPlayerVideoEl/isYouTubeMedia are core's
       (12-playback-sync-and-seek.js) -- this module doesn't redeclare
       them. getBridgeMovieInfo() (01-movie-identity.js) is called
       directly in place of the old `_pcBridge.getMovieInfo()` bridge
       call -- core's GIF bridge (03-gif-bridge.js) exposes that exact
       same function under `getMovieInfo` on the page-level bridge
       object (`getMovieInfo: () => getBridgeMovieInfo()`), so this is
       the identical derivation, just called directly instead of through
       the bridge indirection.
    ========================================================== */

    /* ==========================================================
       SETTINGS
       Font size is a personal display preference (like pc.user.js's
       LS_CHAT_FONT), so unlike the loaded file/offset below it persists
       across sessions.
    ========================================================== */
    const LS_SUB_FONT_SIZE = 'sc_sub_fontsize'; // px
    const SUB_FONT_SIZE_DEFAULT = 28;
    const SUB_FONT_SIZE_MIN = 16;
    const SUB_FONT_SIZE_MAX = 48;
    const SUB_FONT_SIZE_STEP = 2;
    function getSubFontSize() {
        const v = parseInt(localStorage.getItem(LS_SUB_FONT_SIZE), 10);
        return (Number.isFinite(v) && v >= SUB_FONT_SIZE_MIN && v <= SUB_FONT_SIZE_MAX) ? v : SUB_FONT_SIZE_DEFAULT;
    }
    let _subFontSizePx = getSubFontSize();

    // Caption position on the video, as a percentage (X from left, Y from
    // top) -- also a persisted display preference, adjustable via the
    // panel's position pad.
    const LS_SUB_POS_X = 'sc_sub_posx';
    const LS_SUB_POS_Y = 'sc_sub_posy';
    const SUB_POS_X_DEFAULT = 50;
    const SUB_POS_Y_DEFAULT = 85; // leaves clearance below for CyTube's control bar/scrubber
    const SUB_POS_STEP = 2;
    function getSubPos(key, def) {
        const v = parseInt(localStorage.getItem(key), 10);
        return (Number.isFinite(v) && v >= 0 && v <= 100) ? v : def;
    }
    let _subPosX = getSubPos(LS_SUB_POS_X, SUB_POS_X_DEFAULT);
    let _subPosY = getSubPos(LS_SUB_POS_Y, SUB_POS_Y_DEFAULT);

    /* ==========================================================
       SUBTITLE STATE (session-only — no localStorage persistence)
    ========================================================== */
    let _subTrack = null;          // the TextTrack we created via addTextTrack
    let _subCuesOriginal = [];     // [{start, end, text}] as parsed, unmodified by offset
    let _subOffsetMs = 0;
    let _loadedFilename = '';

    /* ==========================================================
       PARSING
       Accepts SRT (00:00:20,000 --> 00:00:23,400, optional leading
       numeric index line) and VTT (00:00:20.000 --> 00:00:23.400,
       WEBVTT header) in one pass.
    ========================================================== */
    function parseSubtitleFile(text) {
        const body = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/^WEBVTT[^\n]*\n/, '');
        const blocks = body.split(/\n\s*\n/);
        const timeRe = /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/;
        const cues = [];
        for (const block of blocks) {
            const lines = block.split('\n').filter(l => l.trim() !== '');
            if (!lines.length) continue;
            let idx = 0;
            if (/^\d+$/.test(lines[0].trim())) idx = 1; // SRT numeric index line
            const m = timeRe.exec(lines[idx] || '');
            if (!m) continue;
            const start = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
            const end   = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
            const cueText = lines.slice(idx + 1).join('\n').trim();
            if (cueText && end > start) cues.push({ start, end, text: cueText });
        }
        return cues;
    }

    /* ==========================================================
       TRACK APPLICATION & OFFSET
       Cues are added to a native TextTrack via addTextTrack/VTTCue --
       the browser owns rendering and sync to video.currentTime, this
       script never touches timeupdate. Offset changes rebuild every
       cue from its ORIGINAL parsed time plus the current offset (never
       an incremental delta), so repeated nudges never drift.
    ========================================================== */
    function clearSubtitleTrack() {
        if (_subTrack) {
            try { _subTrack.mode = 'disabled'; } catch (e) {}
            try { while (_subTrack.cues && _subTrack.cues.length) _subTrack.removeCue(_subTrack.cues[0]); } catch (e) {}
        }
        _subTrack = null;
        _subCuesOriginal = [];
        _subOffsetMs = 0;
        _loadedFilename = '';
    }

    function applySubtitles(video, cues, filename) {
        clearSubtitleTrack();
        _subCuesOriginal = cues;
        _loadedFilename = filename;
        _subTrack = video.addTextTrack('subtitles', 'Loaded subtitles', 'en');
        _subTrack.mode = 'showing'; // addTextTrack defaults to 'hidden'
        rebuildCues();
        updateOffsetDisplay();
        saveSubCache();
    }

    function rebuildCues() {
        if (!_subTrack) return;
        while (_subTrack.cues && _subTrack.cues.length) _subTrack.removeCue(_subTrack.cues[0]);
        const offsetSec = _subOffsetMs / 1000;
        for (const c of _subCuesOriginal) {
            const start = Math.max(0, c.start + offsetSec);
            const end = Math.max(start + 0.01, c.end + offsetSec);
            const cue = new VTTCue(start, end, c.text);
            try {
                // snapToLines=false makes line/position percentages of the
                // video frame (not line counts) -- lets the pad set both
                // axes freely instead of only snapping to text-line rows.
                cue.snapToLines = false;
                cue.line = _subPosY;
                cue.position = _subPosX;
                cue.align = 'center';
                cue.size = 90; // leaves a small margin so centered text doesn't clip at the edges
            } catch (e) {}
            try { _subTrack.addCue(cue); } catch (e) {}
        }
    }

    function updatePositionDisplay() {
        const readout = document.getElementById('sc-sub-pos-readout');
        if (readout) readout.textContent = _subPosX + '%, ' + _subPosY + '%';
        const dot = document.getElementById('sc-sub-pospad-dot');
        if (dot) { dot.style.left = _subPosX + '%'; dot.style.top = _subPosY + '%'; }
    }

    function setSubPosition(x, y) {
        _subPosX = Math.max(0, Math.min(100, Math.round(x)));
        _subPosY = Math.max(0, Math.min(100, Math.round(y)));
        localStorage.setItem(LS_SUB_POS_X, String(_subPosX));
        localStorage.setItem(LS_SUB_POS_Y, String(_subPosY));
        rebuildCues();
        updatePositionDisplay();
    }
    function resetSubPosition() { setSubPosition(SUB_POS_X_DEFAULT, SUB_POS_Y_DEFAULT); }

    function setOffsetMs(ms) {
        _subOffsetMs = ms;
        rebuildCues();
        updateOffsetDisplay();
        saveSubCache();
    }
    function nudgeOffsetMs(deltaMs) { setOffsetMs(_subOffsetMs + deltaMs); }

    /* ==========================================================
       PANEL STATE HELPERS (null-safe — panel may not be open)
    ========================================================== */
    function updateOffsetDisplay() {
        const val = document.getElementById('sc-sub-offset-value');
        if (val) val.textContent = _subOffsetMs + 'ms';
        const fname = document.getElementById('sc-sub-filename');
        if (fname) fname.textContent = _loadedFilename || 'No file loaded';
    }
    function showPanelError(msg) {
        const el = document.getElementById('sc-sub-error');
        if (el) el.textContent = msg;
    }
    function clearPanelError() { showPanelError(''); }

    function resetSubtitles() {
        clearSubtitleTrack();
        updateOffsetDisplay();
        clearPanelError();
    }

    function updateFontSizeDisplay() {
        const el = document.getElementById('sc-sub-fontsize-value');
        if (el) el.textContent = _subFontSizePx + 'px';
    }

    function setFontSizePx(px) {
        _subFontSizePx = Math.max(SUB_FONT_SIZE_MIN, Math.min(SUB_FONT_SIZE_MAX, px));
        localStorage.setItem(LS_SUB_FONT_SIZE, String(_subFontSizePx));
        applyCueStyle();
        updateFontSizeDisplay();
    }
    function nudgeFontSizePx(deltaPx) { setFontSizePx(_subFontSizePx + deltaPx); }

    /* ==========================================================
       OPENSUBTITLES SEARCH LINK
       Uses core's getBridgeMovieInfo() (01-movie-identity.js) to
       identify the currently playing movie. Prefers an IMDb-ID deep
       link (precise, only available once movie-title-links' TMDB
       lookup has resolved for this video) and falls back to a plain
       title+year search.
    ========================================================== */
    function buildOpenSubtitlesUrl(info) {
        if (!info || !info.title) return null;
        if (info.imdbId) {
            const numericId = String(info.imdbId).replace(/^tt/, '');
            return 'https://www.opensubtitles.org/en/search/imdbid-' + encodeURIComponent(numericId) + '/sublanguageid-eng';
        }
        const query = info.title + (info.year ? ' ' + info.year : '');
        return 'https://www.opensubtitles.org/en/search2/sublanguageid-eng/moviename-' + encodeURIComponent(query);
    }

    /* ==========================================================
       SUBTITLE PANEL
    ========================================================== */
    function injectPanelCss() {
        if (document.getElementById('scsub-panel-style')) return;
        const style = document.createElement('style');
        style.id = 'scsub-panel-style';
        style.textContent = `
            #sc-sub-panel {
                position: fixed !important;
                top: 50% !important; left: 50% !important; transform: translate(-50%, -50%) !important;
                z-index: 30002 !important;
                width: 360px !important; max-width: 92vw !important;
                display: flex !important; flex-direction: column !important;
                background: #0c0c0e !important;
                border: 1px solid rgba(244,244,242,0.14) !important;
                border-radius: 12px !important;
                box-shadow: 0 12px 40px rgba(0,0,0,0.6) !important;
                color: #f4f4f2 !important; font-size: 13px !important;
                font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif !important;
            }
            #sc-sub-head {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                padding: 10px 16px !important;
                border-bottom: 1px solid rgba(244,244,242,0.08) !important;
                font-weight: 700 !important; font-size: 14px !important; color: #4dd0e1 !important;
                letter-spacing: 0.01em !important;
                cursor: grab !important; user-select: none !important; touch-action: none !important;
            }
            #sc-sub-head.sc-sub-dragging { cursor: grabbing !important; }
            #sc-sub-close {
                background: transparent !important; border: none !important; color: rgba(244,244,242,0.62) !important;
                font-size: 15px !important; cursor: pointer !important; padding: 0 4px !important;
                transition: color 120ms ease !important;
            }
            #sc-sub-close:hover { color: #f4f4f2 !important; }
            #sc-sub-body {
                padding: 16px !important; display: flex !important; flex-direction: column !important; gap: 14px !important;
            }
            .sc-sub-section {
                display: flex !important; flex-direction: column !important; gap: 8px !important;
                padding-top: 14px !important; border-top: 1px solid rgba(244,244,242,0.08) !important;
            }
            .sc-sub-section:first-child { padding-top: 0 !important; border-top: none !important; }
            .sc-sub-eyebrow {
                font-size: 10px !important; font-weight: 700 !important; letter-spacing: 0.08em !important;
                text-transform: uppercase !important; color: rgba(77,208,225,0.75) !important;
            }
            #sc-sub-filename { font-size: 12px !important; color: rgba(244,244,242,0.62) !important; }
            .sc-sub-row { display: flex !important; align-items: center !important; gap: 8px !important; }
            .sc-sub-label { font-size: 12px !important; color: rgba(244,244,242,0.62) !important; flex: none !important; }
            .sc-sub-readout {
                font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace !important;
                font-size: 12px !important; min-width: 48px !important; text-align: center !important;
            }
            .sc-sub-btn {
                background: rgba(255,255,255,0.08) !important; color: #f4f4f2 !important;
                border: 1px solid rgba(255,255,255,0.18) !important; border-radius: 6px !important;
                padding: 6px 10px !important; cursor: pointer !important; font-size: 12px !important;
                text-decoration: none !important; text-align: center !important;
                transition: background 120ms ease !important;
            }
            .sc-sub-btn:hover { background: rgba(255,255,255,0.22) !important; }
            .sc-sub-btn-icon {
                width: 26px !important; height: 26px !important; padding: 0 !important; flex: none !important;
                display: inline-flex !important; align-items: center !important; justify-content: center !important;
                font-weight: 700 !important; line-height: 1 !important;
            }
            .sc-sub-btn-accent {
                background: rgba(77,208,225,0.14) !important; color: #4dd0e1 !important;
                border: 1px solid rgba(77,208,225,0.4) !important; font-weight: 600 !important;
                border-radius: 6px !important; padding: 6px 10px !important; font-size: 12px !important;
                text-decoration: none !important; text-align: center !important;
                display: inline-flex !important; align-items: center !important; justify-content: center !important;
                transition: background 120ms ease !important;
            }
            .sc-sub-btn-accent:hover { background: rgba(77,208,225,0.24) !important; }
            #sc-sub-offset-input {
                width: 64px !important; flex: none !important; background: rgba(255,255,255,0.06) !important; color: #f4f4f2 !important;
                border: 1px solid rgba(255,255,255,0.18) !important; border-radius: 6px !important; padding: 4px 6px !important;
                font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace !important; font-size: 12px !important;
            }
            .sc-sub-posrow { display: flex !important; align-items: center !important; gap: 12px !important; }
            #sc-sub-pospad {
                position: relative !important; width: 96px !important; height: 54px !important; flex: none !important;
                background: linear-gradient(160deg, rgba(77,208,225,0.10), rgba(255,255,255,0.03)) !important;
                border: 1px solid rgba(244,244,242,0.16) !important; border-radius: 6px !important;
                cursor: crosshair !important; touch-action: none !important;
            }
            #sc-sub-pospad-dot {
                position: absolute !important; width: 10px !important; height: 10px !important;
                background: #4dd0e1 !important; border: 1.5px solid #0c0c0e !important; border-radius: 50% !important;
                transform: translate(-50%, -50%) !important; box-shadow: 0 0 6px rgba(77,208,225,0.7) !important;
                pointer-events: none !important;
            }
            .sc-sub-poscol { display: flex !important; flex-direction: column !important; gap: 6px !important; align-items: flex-start !important; }
            .sc-sub-dpad {
                display: grid !important; grid-template-columns: repeat(3, 26px) !important;
                grid-template-rows: repeat(3, 26px) !important; gap: 2px !important;
            }
            .sc-sub-dpad .sc-sub-btn-icon { width: 26px !important; height: 26px !important; }
            .sc-sub-footer { display: flex !important; gap: 8px !important; }
            .sc-sub-footer .sc-sub-btn, .sc-sub-footer .sc-sub-btn-accent { flex: 1 1 0 !important; }
            #sc-sub-error { font-size: 12px !important; color: #ff6b6b !important; min-height: 14px !important; }
        `;
        document.head.appendChild(style);
    }

    /* ==========================================================
       CUE STYLE (block lettering: bold white text with a black
       outline, no background box, so captions stay legible over any
       video frame without covering the picture). Regenerated whenever
       the font-size setting changes, not just injected once.
    ========================================================== */
    function applyCueStyle() {
        let style = document.getElementById('scsub-cue-style');
        if (!style) {
            style = document.createElement('style');
            style.id = 'scsub-cue-style';
            document.head.appendChild(style);
        }
        style.textContent = `
            video::cue {
                background: transparent;
                color: #ffffff;
                font-family: "Arial Black", Impact, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
                font-weight: 900;
                font-size: ${_subFontSizePx}px;
                text-shadow:
                    -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000,
                    0 -2px 0 #000, 0 2px 0 #000, -2px 0 0 #000, 2px 0 0 #000;
            }
        `;
    }

    function openSubtitlePanel() {
        if (document.getElementById('sc-sub-panel')) return;
        injectPanelCss();

        const movieInfo = getBridgeMovieInfo();
        const osUrl = buildOpenSubtitlesUrl(movieInfo);
        const osLinkHtml = osUrl
            ? `<a id="sc-sub-opensubs" class="sc-sub-btn-accent" href="${osUrl}" target="_blank" rel="noopener noreferrer">Search OpenSubtitles</a>`
            : '';

        const panel = document.createElement('div');
        panel.id = 'sc-sub-panel';
        panel.innerHTML = `
            <div id="sc-sub-head">Subtitles <button id="sc-sub-close" type="button">✕</button></div>
            <div id="sc-sub-body">
                <div class="sc-sub-section">
                    <div class="sc-sub-eyebrow">File</div>
                    <input type="file" id="sc-sub-file" accept=".srt,.vtt">
                    <div id="sc-sub-filename">No file loaded</div>
                </div>
                <div class="sc-sub-section">
                    <div class="sc-sub-eyebrow">Sync</div>
                    <div class="sc-sub-row">
                        <button id="sc-sub-offset-minus" class="sc-sub-btn sc-sub-btn-icon" type="button">−</button>
                        <span id="sc-sub-offset-value" class="sc-sub-readout">0ms</span>
                        <button id="sc-sub-offset-plus" class="sc-sub-btn sc-sub-btn-icon" type="button">+</button>
                        <input type="number" id="sc-sub-offset-input" step="100" placeholder="ms">
                        <button id="sc-sub-offset-set" class="sc-sub-btn" type="button">Set</button>
                    </div>
                </div>
                <div class="sc-sub-section">
                    <div class="sc-sub-eyebrow">Appearance</div>
                    <div class="sc-sub-row">
                        <span class="sc-sub-label">Size</span>
                        <button id="sc-sub-fontsize-minus" class="sc-sub-btn sc-sub-btn-icon" type="button">−</button>
                        <span id="sc-sub-fontsize-value" class="sc-sub-readout">${_subFontSizePx}px</span>
                        <button id="sc-sub-fontsize-plus" class="sc-sub-btn sc-sub-btn-icon" type="button">+</button>
                    </div>
                    <div class="sc-sub-posrow">
                        <div id="sc-sub-pospad" title="Drag to position captions"><div id="sc-sub-pospad-dot"></div></div>
                        <div class="sc-sub-dpad">
                            <span></span>
                            <button id="sc-sub-posy-minus" class="sc-sub-btn sc-sub-btn-icon" type="button" title="Move up">▲</button>
                            <span></span>
                            <button id="sc-sub-posx-minus" class="sc-sub-btn sc-sub-btn-icon" type="button" title="Move left">◀</button>
                            <span></span>
                            <button id="sc-sub-posx-plus" class="sc-sub-btn sc-sub-btn-icon" type="button" title="Move right">▶</button>
                            <span></span>
                            <button id="sc-sub-posy-plus" class="sc-sub-btn sc-sub-btn-icon" type="button" title="Move down">▼</button>
                            <span></span>
                        </div>
                        <div class="sc-sub-poscol">
                            <span class="sc-sub-label">Position</span>
                            <span id="sc-sub-pos-readout" class="sc-sub-readout">${_subPosX}%, ${_subPosY}%</span>
                            <button id="sc-sub-pos-reset" class="sc-sub-btn" type="button">Reset</button>
                        </div>
                    </div>
                </div>
                <div class="sc-sub-footer">
                    <button id="sc-sub-clear" class="sc-sub-btn" type="button">Clear subtitles</button>
                    ${osLinkHtml}
                </div>
                <div id="sc-sub-error"></div>
            </div>`;
        document.body.appendChild(panel);

        const $ = id => panel.querySelector(id);
        updateOffsetDisplay();
        updateFontSizeDisplay();
        updatePositionDisplay();

        $('#sc-sub-close').addEventListener('click', () => panel.remove());

        $('#sc-sub-file').addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const cues = parseSubtitleFile(reader.result);
                    if (!cues.length) { showPanelError('No subtitle cues found in this file.'); return; }
                    const video = getPlayerVideoEl();
                    if (!video) { showPanelError('No video found to attach subtitles to.'); return; }
                    applySubtitles(video, cues, file.name);
                    clearPanelError();
                } catch (err) {
                    showPanelError('Could not parse this file: ' + (err.message || err));
                }
            };
            reader.onerror = () => showPanelError('Could not read this file.');
            reader.readAsText(file);
        });

        $('#sc-sub-offset-minus').addEventListener('click', () => nudgeOffsetMs(-100));
        $('#sc-sub-offset-plus').addEventListener('click', () => nudgeOffsetMs(100));
        $('#sc-sub-offset-set').addEventListener('click', () => {
            const v = parseInt($('#sc-sub-offset-input').value, 10);
            if (!isNaN(v)) setOffsetMs(v);
        });
        $('#sc-sub-fontsize-minus').addEventListener('click', () => nudgeFontSizePx(-SUB_FONT_SIZE_STEP));
        $('#sc-sub-fontsize-plus').addEventListener('click', () => nudgeFontSizePx(SUB_FONT_SIZE_STEP));
        $('#sc-sub-posx-minus').addEventListener('click', () => setSubPosition(_subPosX - SUB_POS_STEP, _subPosY));
        $('#sc-sub-posx-plus').addEventListener('click', () => setSubPosition(_subPosX + SUB_POS_STEP, _subPosY));
        $('#sc-sub-posy-minus').addEventListener('click', () => setSubPosition(_subPosX, _subPosY - SUB_POS_STEP));
        $('#sc-sub-posy-plus').addEventListener('click', () => setSubPosition(_subPosX, _subPosY + SUB_POS_STEP));
        $('#sc-sub-pos-reset').addEventListener('click', () => resetSubPosition());
        $('#sc-sub-clear').addEventListener('click', () => { resetSubtitles(); clearSubCache(); });

        const pad = $('#sc-sub-pospad');
        let posDragging = false;
        const posFromEvent = (e) => {
            const rect = pad.getBoundingClientRect();
            return {
                x: ((e.clientX - rect.left) / rect.width) * 100,
                y: ((e.clientY - rect.top) / rect.height) * 100,
            };
        };
        pad.addEventListener('pointerdown', (e) => {
            posDragging = true;
            pad.setPointerCapture(e.pointerId);
            const { x, y } = posFromEvent(e);
            setSubPosition(x, y);
        });
        pad.addEventListener('pointermove', (e) => {
            if (!posDragging) return;
            const { x, y } = posFromEvent(e);
            setSubPosition(x, y);
        });
        const endPosDrag = (e) => {
            posDragging = false;
            try { pad.releasePointerCapture(e.pointerId); } catch (err) {}
        };
        pad.addEventListener('pointerup', endPosDrag);
        pad.addEventListener('pointercancel', endPosDrag);

        const head = $('#sc-sub-head');
        let dragging = false, dragDX = 0, dragDY = 0;
        const setPanelPos = (prop, val) => panel.style.setProperty(prop, val, 'important');
        head.addEventListener('pointerdown', (e) => {
            if (e.target.closest('#sc-sub-close')) return;
            const rect = panel.getBoundingClientRect();
            setPanelPos('left', rect.left + 'px');
            setPanelPos('top', rect.top + 'px');
            setPanelPos('transform', 'none');
            dragDX = e.clientX - rect.left;
            dragDY = e.clientY - rect.top;
            dragging = true;
            head.classList.add('sc-sub-dragging');
            head.setPointerCapture(e.pointerId);
        });
        head.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const rect = panel.getBoundingClientRect();
            const x = Math.min(Math.max(e.clientX - dragDX, -(rect.width - 40)), window.innerWidth - 40);
            const y = Math.min(Math.max(e.clientY - dragDY, 0), window.innerHeight - 32);
            setPanelPos('left', x + 'px');
            setPanelPos('top', y + 'px');
        });
        const endDrag = (e) => {
            dragging = false;
            head.classList.remove('sc-sub-dragging');
            try { head.releasePointerCapture(e.pointerId); } catch (err) {}
        };
        head.addEventListener('pointerup', endDrag);
        head.addEventListener('pointercancel', endDrag);
    }

    /* ==========================================================
       TRIGGER BUTTON
       Floating #scsub-trigger-btn, positioned to the left of
       cytube.gifmaker.user.js's floating button (152px vs its 116px from
       the chat edge) so they don't overlap when both are installed.
       (The original standalone script also had a control-bar-docked
       mode for when cytube.pc.user.js wasn't installed -- gone here
       since this module is only ever built alongside core.)
    ========================================================== */
    function injectFloatingButtonCss() {
        if (document.getElementById('scsub-floatbtn-style')) return;
        const style = document.createElement('style');
        style.id = 'scsub-floatbtn-style';
        style.textContent = `
            #scsub-trigger-btn {
                position: fixed !important;
                z-index: 20002 !important;
                background: rgba(255,255,255,0.08) !important;
                color: rgba(255,255,255,0.55) !important;
                border: 1px solid rgba(255,255,255,0.18) !important;
                border-radius: 50% !important;
                width: 28px !important; height: 28px !important;
                padding: 0 !important; font-size: 11px !important; font-weight: 700 !important;
                cursor: pointer !important;
                display: flex !important; align-items: center !important; justify-content: center !important;
                transition: color 0.3s ease, background 0.3s ease, transform 0.3s ease, opacity 0.3s ease !important;
            }
            #scsub-trigger-btn.sc-bar-dim {
                transform: translateX(60px) !important; opacity: 0 !important; pointer-events: none !important;
            }
            #scsub-trigger-btn:hover { color: white !important; background: rgba(255,255,255,0.22) !important; }
            #scsub-trigger-btn .vjs-icon-captions { font-size: 15px !important; line-height: 1 !important; }
            body.sc-horizontal #scsub-trigger-btn {
                bottom: 6px !important;
                right: calc(var(--sc-chat-w) + 1vw + 152px) !important;
            }
            body.sc-vertical #scsub-trigger-btn {
                bottom: calc(var(--sc-chat-h) + 1vh) !important;
                right: 152px !important;
            }
            #scsub-trigger-btn:disabled {
                opacity: 0.35 !important; cursor: default !important; pointer-events: none !important;
            }
            #scsub-trigger-btn.sc-bar-dim:disabled {
                opacity: 0 !important;
            }
        `;
        document.head.appendChild(style);
    }

    function ensureTriggerButton() {
        if (document.getElementById('scsub-trigger-btn')) return;
        injectFloatingButtonCss();
        const btn = document.createElement('button');
        btn.id = 'scsub-trigger-btn';
        btn.innerHTML = '<span class="vjs-icon-captions" aria-hidden="true"></span>';
        btn.title = 'Load subtitles';
        btn.addEventListener('click', () => openSubtitlePanel());
        document.body.appendChild(btn);
    }

    function updateTriggerButtonState() {
        const btn = document.getElementById('scsub-trigger-btn');
        if (!btn) return;
        const yt = isYouTubeMedia();
        btn.disabled = yt;
        btn.title = yt ? 'Not available for YouTube videos' : 'Load subtitles';
    }

    /* ==========================================================
       SHORT-LIVED PER-MOVIE SUBTITLE CACHE
       Remembers the loaded file (parsed cues + offset) against the
       movie it was loaded for, so a page refresh -- or that same movie
       coming back around shortly after -- restores it automatically.
       Deliberately short-lived (a few hours, not indefinite like the
       font-size/position settings) and holds only the single
       most-recently-loaded movie, not a per-movie history. Restoring
       refreshes savedAt (a sliding window: still-in-use stays cached,
       untouched entries expire).
    ========================================================== */
    const LS_SUB_CACHE = 'sc_sub_cache';
    const SUB_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
    let _currentMovieKey = null; // raw title from the most recent changeMedia payload

    function saveSubCache() {
        if (!_subTrack || !_currentMovieKey) return;
        try {
            localStorage.setItem(LS_SUB_CACHE, JSON.stringify({
                key: _currentMovieKey,
                filename: _loadedFilename,
                cues: _subCuesOriginal,
                offsetMs: _subOffsetMs,
                savedAt: Date.now(),
            }));
        } catch (e) {}
    }

    function clearSubCache() {
        try { localStorage.removeItem(LS_SUB_CACHE); } catch (e) {}
    }

    function tryRestoreSubCache() {
        if (_subTrack) return; // don't stomp on subtitles already loaded/restored
        if (!_currentMovieKey) return;
        let raw;
        try { raw = JSON.parse(localStorage.getItem(LS_SUB_CACHE)); } catch (e) { return; }
        if (!raw || raw.key !== _currentMovieKey) return;
        if (!raw.savedAt || Date.now() - raw.savedAt > SUB_CACHE_TTL_MS) { clearSubCache(); return; }
        if (!Array.isArray(raw.cues) || !raw.cues.length) return;
        const video = getPlayerVideoEl();
        if (!video) return;
        applySubtitles(video, raw.cues, raw.filename || '');
        if (Number.isFinite(raw.offsetMs) && raw.offsetMs !== 0) setOffsetMs(raw.offsetMs);
    }

    /* ==========================================================
       DOM-TITLE FALLBACK FOR THE CACHE
       changeMedia's resync "can fire" on a fresh/refreshed page load per
       cytube.pc.user.js's own comment (see src/pc/modules/tonights-lineup/index.js,
       lineupObserveTitleChange) -- it isn't guaranteed to. Without a second
       source for the movie title, _currentMovieKey stays null after a
       refresh and tryRestoreSubCache() never even gets called. cytube.pc.user.js
       solves this exact problem for its own "now playing" title by watching
       #currenttitle directly instead of only the socket (see
       src/pc/modules/movie-title-links/index.js, watchMovieTitle/
       attachHeaderObserver) -- same fix applied here, scoped to just updating the cache key and
       attempting a restore (never resetSubtitles(): on an actual movie
       change changeMedia already owns the reset, and this path racing it
       could wipe subtitles changeMedia's own restore just applied).
    ========================================================== */
    function getDomMovieTitle() {
        const el = document.getElementById('currenttitle')
            || document.querySelector('#videowrap-header .pull-left')
            || document.querySelector('#videowrap-header span')
            || document.querySelector('.video-title');
        if (!el) return '';
        return el.textContent.trim()
            .replace(/^currently\s+playing[:\s]*/i, '')
            .replace(/^now\s+playing[:\s]*/i, '').trim();
    }

    function updateMovieKeyFromDom() {
        const raw = getDomMovieTitle();
        if (!raw || raw.length < 2) return;
        _currentMovieKey = raw;
        // Always re-attempt (not just on a key change): the title can be
        // known before the <video> element exists yet on a cold load, and
        // tryRestoreSubCache() itself bails out silently if there's no
        // video to attach to (see its `if (!video) return;`), with no
        // retry of its own -- so if the *only* trigger were "key changed",
        // that one early miss would be permanent. This call is cheap and
        // already double-guarded (no-ops once something is loaded, or if
        // the key hasn't resolved yet).
        tryRestoreSubCache();
    }

    // Named _subCacheTitleObsAttached (not _titleObsAttached) -- movie-title-links
    // (src/pc/modules/movie-title-links/index.js) declares its own module-scope
    // `_titleObsAttached` for the *same purpose* against a *different* observer
    // (its own now-playing title injection), and both modules share one outer
    // scope once concatenated into a bundle -- an unqualified name here would
    // collide with a duplicate `let` declaration.
    let _subCacheTitleObsAttached = false;
    function attachTitleObserver() {
        if (_subCacheTitleObsAttached) return;
        const header = document.getElementById('videowrap-header');
        if (!header) return;
        _subCacheTitleObsAttached = true;
        new MutationObserver(updateMovieKeyFromDom).observe(header, { childList: true, subtree: true, characterData: true });
    }

    function watchMovieTitleForCache() {
        updateMovieKeyFromDom();
        attachTitleObserver();
        // Poll for ~20s on cold load in case the header isn't ready yet
        // (same pattern/budget as watchMovieTitle() in
        // src/pc/modules/movie-title-links/index.js).
        let tries = 0;
        const poll = setInterval(() => {
            attachTitleObserver();
            updateMovieKeyFromDom();
            if (++tries >= 14) clearInterval(poll);
        }, 1500);
    }

    /* ==========================================================
       MOVIE-CHANGE RESET
       movie-title-links' own initMediaWatcher() (src/pc/modules/movie-title-links/index.js)
       establishes the reliable signal for this: CyTube's own changeMedia
       socket event fires on every movie change (reused/queued video or a
       fresh one), whether or not the underlying <video> DOM node is
       actually replaced. That's the PRIMARY reset trigger here too --
       renamed to watchVideoSwapForSubtitleCache() (rather than the
       original script's identically-named initMediaWatcher) since both
       modules share one outer scope once concatenated into a bundle,
       and a duplicate function declaration would silently shadow one of
       the two. A video-element-identity poll (same 800ms cadence as the
       trigger-button-state poll) is a defensive backstop for the case
       where the socket hasn't bound yet -- it only resets (no
       cache-restore attempt, since it has no title to key against). Both
       paths call the same idempotent resetSubtitles(), so double-firing
       on an actual movie change is harmless.
    ========================================================== */
    let _lastVideoEl = null;
    function checkVideoSwap() {
        const video = getPlayerVideoEl();
        if (video !== _lastVideoEl) {
            _lastVideoEl = video;
            if (_subTrack) resetSubtitles();
            // The <video> element itself can appear after the DOM-title
            // watcher has already resolved _currentMovieKey (cold load:
            // title text shows before the player finishes attaching) --
            // covers the reverse ordering of the race handled above in
            // updateMovieKeyFromDom(). No-ops via tryRestoreSubCache()'s
            // own guards if there's nothing to restore.
            else if (video) tryRestoreSubCache();
        }
    }

    function watchVideoSwapForSubtitleCache() {
        const tryBind = () => {
            if (typeof socket === 'undefined' || !socket || !socket.on) return;
            socket.on('changeMedia', (data) => {
                _currentMovieKey = (data && data.title) ? String(data.title).trim() : null;
                resetSubtitles();
                tryRestoreSubCache();
            });
        };
        // socket may not be ready at document-start; try at load then again after a short delay
        window.addEventListener('load', () => { tryBind(); setTimeout(tryBind, 2000); });
    }

    /* ==========================================================
       OFFSET KEYBINDS
       [ / ] nudge by 100ms, Shift+[ / Shift+] nudge by 1000ms. Guarded
       against firing while chat/any input is focused -- same guard
       the arrow-key seeking listener in
       src/pc/core/12-playback-sync-and-seek.js uses
       (a second, independent listener; no conflict since the
       key sets don't overlap). No-op while nothing is loaded.
    ========================================================== */
    document.addEventListener('keydown', (e) => {
        const t = e.target;
        if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
        if (!_subTrack) return;
        if (e.key === '[') { nudgeOffsetMs(e.shiftKey ? -1000 : -100); return; }
        if (e.key === ']') { nudgeOffsetMs(e.shiftKey ?  1000 :  100); return; }
    });

    /* ==========================================================
       BOOT
       Named subtitlesBoot (not waitForBody) — core's own 16-boot.js
       declares a generic waitForBody in the same shared scope; this
       module's boot routine has always been distinct code, so it gets
       its own name here to avoid the collision now that both files
       share one IIFE. Called directly here (not via scRegisterInit) to
       preserve the original script's document-start timing --
       scRegisterInit's queue only runs on the page's 'load' event, and
       the trigger-button MutationObserver below needs to be attached
       well before that to catch early DOM mutations.
    ========================================================== */
    function subtitlesBoot() {
        if (!document.body) { requestAnimationFrame(subtitlesBoot); return; }

        ensureTriggerButton();
        updateTriggerButtonState();
        applyCueStyle();
        watchVideoSwapForSubtitleCache();
        watchMovieTitleForCache();
        setInterval(checkVideoSwap, 800);

        new MutationObserver(() => {
            ensureTriggerButton();
            updateTriggerButtonState();
        }).observe(document.body, { childList: true, subtree: true });

        setInterval(updateTriggerButtonState, 800);
    }
    subtitlesBoot();
    /* ==========================================================
       GIF MAKER — scene-to-GIF capture with meme captions and ImgBB
       upload. Originally a standalone companion script
       (cytube.gifmaker.user.js) that detected cytube.pc.user.js at
       runtime via a polled bridge object (`__SC_GIF_BRIDGE__` on
       unsafeWindow) and offered two UI modes (a control-bar-docked
       button when standalone, a floating button when the bridge was
       present); now always bundled alongside core, so that
       detection/poll loop, upgradeToPcMode(), and the control-bar-
       docked UI path are all gone — only the floating `#sc-gif-btn`
       trigger remains.
       getKey/LS_IMGBB/LS_GIF_OPTIMIZE/gifOptimizeEnabled/
       getPlayerVideoEl/isYouTubeMedia are core's
       (02-keys-and-helpers.js / 12-playback-sync-and-seek.js) — this
       module doesn't redeclare them. activeTitleSlug() calls core's
       _gifTitleSlug() (01-movie-identity.js) directly in place of the
       old `_pcBridge.getTitleSlug()` bridge call, keeping the same
       local-fallback try/catch pattern the original had.
       The reverse-injection assignment (`bridge.openGifPanel =
       openGifPanel`) is KEPT, not deleted: core's own chat-to-movie
       seek menu (12-playback-sync-and-seek.js, showChatSeekMenu) reads
       `__SC_GIF_BRIDGE__.openGifPanel` to offer a "Create a GIF from
       here" item, so this module still fills that slot in on boot —
       it's just no longer gated behind bridge detection, since core
       (and therefore the bridge object created by 03-gif-bridge.js)
       is now an unconditional dependency of this module.
       `_escHtml` was renamed to `_gifEscHtml` (collides with
       imdb-trivia's own `_escHtml`). `injectPanelCss` and
       `injectFloatingButtonCss` were renamed to `injectGifPanelCss`/
       `injectGifFloatingButtonCss` (both names collide with same-named
       functions the subtitles module independently declares) — found
       during the exhaustive top-level-identifier sweep, not called out
       by name in this task's brief.
    ========================================================== */
    function activeTitleSlug() {
        try { return _gifTitleSlug() || gifTitleSlug(); } catch (e) { return gifTitleSlug(); }
    }

    /* ==========================================================
       GIF PANEL — CSS (lazily injected on first open)
    ========================================================== */
    function injectGifPanelCss() {
        if (document.getElementById('scgm-panel-style')) return;
        const style = document.createElement('style');
        style.id = 'scgm-panel-style';
        style.textContent = `
            #sc-gif-panel {
                position: fixed !important;
                top: 50% !important; left: 50% !important; transform: translate(-50%, -50%) !important;
                z-index: 30002 !important;
                width: 600px !important; max-width: 92vw !important;
                max-height: 88vh !important;
                display: flex !important; flex-direction: column !important;
                background: #0c0c0e !important;
                border: 1px solid rgba(244,244,242,0.14) !important;
                border-radius: 12px !important;
                box-shadow: 0 12px 40px rgba(0,0,0,0.6) !important;
                color: #f4f4f2 !important; font-size: 13px !important;
                font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif !important;
            }
            #sc-gif-head {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                flex: none !important;
                padding: 10px 16px !important;
                border-bottom: 1px solid rgba(244,244,242,0.08) !important;
                font-weight: 600 !important; font-size: 14px !important; color: #ffb020 !important;
                cursor: grab !important; user-select: none !important; touch-action: none !important;
            }
            #sc-gif-head.sc-gif-dragging { cursor: grabbing !important; }
            #sc-gif-close {
                background: transparent !important; border: none !important; color: rgba(244,244,242,0.62) !important;
                font-size: 15px !important; cursor: pointer !important; padding: 0 4px !important;
                transition: color 120ms ease !important;
            }
            #sc-gif-close:hover { color: #f4f4f2 !important; }
            #sc-gif-body {
                padding: 16px !important; display: flex !important; flex-direction: column !important; gap: 16px !important;
                flex: 1 1 auto !important; min-height: 0 !important; overflow-y: auto !important;
                scrollbar-width: thin !important; scrollbar-color: rgba(244,244,242,0.2) #000 !important;
            }
            #sc-gif-body::-webkit-scrollbar { width: 10px !important; }
            #sc-gif-body::-webkit-scrollbar-track { background: #000 !important; }
            #sc-gif-body::-webkit-scrollbar-thumb {
                background: rgba(244,244,242,0.2) !important; border-radius: 6px !important; border: 2px solid #000 !important;
            }
            #sc-gif-body::-webkit-scrollbar-thumb:hover { background: #ffb020 !important; }
            #sc-gif-body label {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                color: rgba(244,244,242,0.62) !important; font-weight: 500 !important;
            }
            #sc-gif-body select {
                background: #1f1f22 !important; color: #f4f4f2 !important;
                border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 4px !important;
                padding: 3px 8px !important; font-size: 13px !important;
                transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important;
            }
            #sc-gif-body select:hover, #sc-gif-body select:focus { border-color: rgba(255,176,32,0.5) !important; }
            #sc-gif-body select option {
                background-color: #1f1f22 !important; color: #f4f4f2 !important;
            }
            .sc-gif-card {
                background: rgba(244,244,242,0.02) !important;
                border: 1px solid rgba(244,244,242,0.06) !important;
                border-radius: 8px !important;
                padding: 12px !important;
                display: flex !important; flex-direction: column !important; gap: 8px !important;
            }
            .sc-gif-mono, #sc-gif-time-start, #sc-gif-time-end, #sc-gif-dur-line b,
            #sc-gif-overview-total, #sc-gif-filmstrip-range, .sc-gif-fx-row input[type=number] {
                font-family: "SF Mono", "Cascadia Code", Consolas, monospace !important;
            }
            .sc-gif-marks { display: flex !important; gap: 10px !important; }
            .sc-gif-mark {
                flex: 1 1 0 !important; min-width: 0 !important;
                display: flex !important; flex-direction: column !important; gap: 6px !important;
            }
            .sc-gif-thumb {
                width: 100% !important; aspect-ratio: 16 / 9 !important;
                background-color: #000 !important;
                background-position: center !important;
                background-size: cover !important;
                background-repeat: no-repeat !important;
                border: 1px solid rgba(244,244,242,0.08) !important; border-radius: 8px !important;
                position: relative !important;
            }
            .sc-gif-thumb-43 { aspect-ratio: 4 / 3 !important; }
            .sc-gif-thumb-fit { background-size: contain !important; }
            .sc-gif-thumb-readonly { border-style: dashed !important; opacity: 0.92 !important; }
            .sc-gif-cap {
                position: absolute !important;
                width: 92% !important;
                text-align: center !important; white-space: pre-line !important;
                font-family: Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif !important;
                font-weight: bold !important; color: #fff !important;
                -webkit-text-stroke: 1.5px #000 !important;
                text-shadow: -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000 !important;
                pointer-events: none !important; transform: translate(-50%, -50%) !important;
            }
            .sc-gif-cap-top { left: var(--cx-top, 50%) !important; top: var(--cy-top, 10%) !important; }
            .sc-gif-cap-bottom { left: var(--cx-bottom, 50%) !important; top: var(--cy-bottom, 90%) !important; }
            .sc-gif-cap-yellow { color: #ffe135 !important; }
            .sc-gif-cap-rainbow { animation: sc-gif-cap-rainbow-cycle 3s linear infinite !important; }
            @keyframes sc-gif-cap-rainbow-cycle {
                0%   { -webkit-text-fill-color: hsl(0, 90%, 60%); }
                25%  { -webkit-text-fill-color: hsl(90, 90%, 60%); }
                50%  { -webkit-text-fill-color: hsl(180, 90%, 60%); }
                75%  { -webkit-text-fill-color: hsl(270, 90%, 60%); }
                100% { -webkit-text-fill-color: hsl(360, 90%, 60%); }
            }
            .sc-gif-cap-shadow { filter: drop-shadow(3px 4px 3px rgba(0,0,0,0.75)) !important; }
            .sc-gif-cap-wiggle { animation: sc-gif-cap-wiggle-cycle 1.4s ease-in-out infinite !important; }
            .sc-gif-cap-rainbow.sc-gif-cap-wiggle {
                animation: sc-gif-cap-rainbow-cycle 3s linear infinite, sc-gif-cap-wiggle-cycle 1.4s ease-in-out infinite !important;
            }
            @keyframes sc-gif-cap-wiggle-cycle {
                0%   { translate: 0 0; }
                25%  { translate: 4px -3px; }
                50%  { translate: -3px 3px; }
                75%  { translate: 3px 2px; }
                100% { translate: 0 0; }
            }
            .sc-gif-cap-handle {
                position: absolute !important; width: 14px !important; height: 14px !important;
                border-radius: 50% !important; background: rgba(255,176,32,0.9) !important;
                border: 2px solid #000 !important; transform: translate(-50%, -50%) !important;
                cursor: grab !important; pointer-events: auto !important; touch-action: none !important;
            }
            .sc-gif-cap-handle:active { cursor: grabbing !important; }
            .sc-gif-cap-handle-top { left: var(--cx-top, 50%) !important; top: var(--cy-top, 10%) !important; }
            .sc-gif-cap-handle-bottom { left: var(--cx-bottom, 50%) !important; top: var(--cy-bottom, 90%) !important; }
            .sc-gif-cap-sizes { display: flex !important; flex-wrap: nowrap !important; gap: 10px !important; justify-content: center !important; }
            .sc-gif-cap-sizes label {
                display: flex !important; align-items: center !important; gap: 4px !important; white-space: nowrap !important;
                color: rgba(244,244,242,0.62) !important; font-size: 12px !important;
            }
            .sc-gif-cap-sizes input[type=number] {
                width: 40px !important; min-width: 0 !important; background: #1f1f22 !important; color: #f4f4f2 !important;
                border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 4px !important; padding: 2px 4px !important;
                transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important;
                -moz-appearance: textfield !important;
            }
            .sc-gif-cap-sizes input[type=number]::-webkit-inner-spin-button,
            .sc-gif-cap-sizes input[type=number]::-webkit-outer-spin-button {
                -webkit-appearance: none !important; margin: 0 !important;
            }
            .sc-gif-cap-sizes input[type=number]:hover, .sc-gif-cap-sizes input[type=number]:focus { border-color: rgba(255,176,32,0.5) !important; }
            .sc-gif-cap-hint { text-align: center !important; color: rgba(244,244,242,0.34) !important; font-size: 11px !important; }
            .sc-gif-overview { display: flex !important; flex-direction: column !important; gap: 2px !important; }
            .sc-gif-overview-track {
                position: relative !important; height: 16px !important; border-radius: 4px !important;
                background: #17171a !important; border: 1px solid rgba(244,244,242,0.14) !important;
                cursor: pointer !important; user-select: none !important; touch-action: none !important;
            }
            .sc-gif-overview-track:focus {
                outline: 2px solid #ffb020 !important; outline-offset: 1px !important;
            }
            .sc-gif-overview-viewport {
                position: absolute !important; top: 0 !important; bottom: 0 !important;
                background: rgba(255,176,32,0.55) !important;
                border-left: 1px solid #ffb020 !important; border-right: 1px solid #ffb020 !important;
                border-radius: 2px !important; pointer-events: none !important;
            }
            .sc-gif-overview-ghost {
                position: absolute !important; top: -3px !important; bottom: -3px !important; width: 2px !important;
                background: #f4f4f2 !important; box-shadow: 0 0 4px rgba(244,244,242,0.8) !important;
                display: none !important; pointer-events: none !important;
            }
            .sc-gif-overview-labels {
                display: flex !important; justify-content: space-between !important;
                color: rgba(244,244,242,0.34) !important; font-size: 11px !important;
            }
            .sc-gif-overview-current { color: rgba(255,176,32,0.85) !important; font-weight: 600 !important; }
            .sc-gif-filmstrip { display: flex !important; flex-direction: column !important; gap: 6px !important; }
            .sc-gif-filmstrip-strip {
                position: relative !important; height: 64px !important; border-radius: 8px !important;
                overflow: hidden !important; border: 1px solid rgba(244,244,242,0.08) !important; user-select: none !important;
            }
            .sc-gif-filmstrip-tiles { position: absolute !important; inset: 0 !important; display: flex !important; }
            .sc-gif-filmstrip-tile {
                flex: 1 1 0 !important;
                background-color: #1a1a1e !important;
                background-position: center !important; background-size: cover !important; background-repeat: no-repeat !important;
                border-right: 1px solid rgba(244,244,242,0.06) !important;
                position: relative !important;
            }
            .sc-gif-filmstrip-tile:last-child { border-right: 0 !important; }
            .sc-gif-filmstrip-dim-left, .sc-gif-filmstrip-dim-right {
                position: absolute !important; top: 0 !important; bottom: 0 !important;
                background: rgba(0,0,0,0.55) !important; pointer-events: none !important;
            }
            .sc-gif-filmstrip-dim-left { left: 0 !important; }
            .sc-gif-filmstrip-dim-right { right: 0 !important; }
            .sc-gif-filmstrip-selection {
                position: absolute !important; top: 0 !important; bottom: 0 !important;
                background: rgba(255,176,32,0.08) !important;
                border-left: 2px solid #ffb020 !important; border-right: 2px solid #ffb020 !important;
                pointer-events: auto !important; cursor: grab !important; touch-action: none !important;
            }
            .sc-gif-filmstrip-selection:active { cursor: grabbing !important; }
            .sc-gif-filmstrip-handle {
                position: absolute !important; top: 0 !important; bottom: 0 !important; width: 14px !important; margin-left: -7px !important;
                cursor: ew-resize !important; display: flex !important; align-items: center !important; justify-content: center !important;
                z-index: 3 !important; touch-action: none !important;
            }
            .sc-gif-filmstrip-handle-grip {
                width: 6px !important; height: 28px !important; border-radius: 3px !important;
                background: #ffb020 !important; border: 1px solid #000 !important;
                box-shadow: 0 0 0 3px rgba(255,176,32,0.15) !important;
            }
            .sc-gif-captions { display: flex !important; flex-direction: column !important; gap: 8px !important; }
            .sc-gif-tag-input {
                width: 90px !important; min-width: 0 !important;
                background: #1f1f22 !important; color: #f4f4f2 !important;
                border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 4px !important;
                padding: 4px 8px !important; font-size: 12px !important;
                transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important;
            }
            .sc-gif-tag-input:hover, .sc-gif-tag-input:focus { border-color: rgba(255,176,32,0.5) !important; }
            .sc-gif-tag-input::placeholder { color: rgba(244,244,242,0.34) !important; }
            .sc-gif-cap-input {
                background: #1f1f22 !important; color: #f4f4f2 !important;
                border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 4px !important;
                padding: 6px 8px !important; font-size: 13px !important; width: 100% !important;
                box-sizing: border-box !important;
                transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important;
            }
            .sc-gif-cap-input:hover, .sc-gif-cap-input:focus { border-color: rgba(255,176,32,0.5) !important; }
            .sc-gif-cap-bottom-input { margin-bottom: 4px !important; }
            .sc-gif-cap-input::placeholder { color: rgba(244,244,242,0.34) !important; }
            .sc-gif-cap-color {
                display: flex !important; align-items: center !important; gap: 14px !important; justify-content: center !important;
                color: rgba(244,244,242,0.62) !important; font-size: 12px !important;
            }
            .sc-gif-cap-color label { display: flex !important; align-items: center !important; gap: 4px !important; cursor: pointer !important; }
            .sc-gif-thumb-loading::after {
                content: '' !important;
                position: absolute !important;
                top: 50% !important; left: 50% !important;
                width: 22px !important; height: 22px !important;
                margin: -11px 0 0 -11px !important;
                border: 2px solid rgba(244,244,242,0.25) !important;
                border-top-color: #ffb020 !important;
                border-radius: 50% !important;
                animation: sc-gif-spin 0.8s linear infinite !important;
            }
            @keyframes sc-gif-spin { to { transform: rotate(360deg); } }
            .sc-gif-spinner {
                display: inline-block !important;
                width: 18px !important; height: 18px !important;
                border: 2px solid rgba(244,244,242,0.25) !important;
                border-top-color: #ffb020 !important;
                border-radius: 50% !important;
                animation: sc-gif-spin 0.8s linear infinite !important;
                flex: none !important;
            }
            .sc-gif-spinner-sm { width: 13px !important; height: 13px !important; }
            .sc-gif-working {
                display: flex !important; align-items: center !important; gap: 10px !important;
                padding: 14px 4px !important; color: rgba(244,244,242,0.62) !important; font-size: 13px !important;
            }
            .sc-gif-mark-label {
                color: #ffb020 !important; font-size: 11px !important; font-weight: 700 !important;
                letter-spacing: 0.06em !important; text-align: center !important;
            }
            .sc-gif-mark-btns { display: flex !important; gap: 4px !important; }
            .sc-gif-mark-btns button {
                flex: 1 1 0 !important; min-width: 0 !important;
                background: transparent !important; color: rgba(244,244,242,0.62) !important;
                border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 4px !important;
                padding: 4px 0 !important; font-size: 11px !important; cursor: pointer !important;
                transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important;
            }
            .sc-gif-mark-btns button:hover {
                background: rgba(255,176,32,0.14) !important; border-color: #ffb020 !important; color: #f4f4f2 !important;
            }
            #sc-gif-dur-line {
                text-align: center !important; color: rgba(244,244,242,0.62) !important; font-size: 12px !important;
            }
            #sc-gif-dur-line b { color: #f4f4f2 !important; }
            .sc-gif-col-right .sc-gif-fx-row { flex-direction: column !important; align-items: stretch !important; gap: 6px !important; }
            #sc-gif-go {
                background: #ffb020 !important; color: #0c0c0e !important;
                border: none !important; border-radius: 8px !important;
                padding: 8px 16px !important; font-size: 13px !important; font-weight: 600 !important;
                cursor: pointer !important;
                transition: box-shadow 120ms ease, opacity 120ms ease !important;
            }
            #sc-gif-go:hover:not(:disabled), #sc-gif-go:focus-visible:not(:disabled) {
                box-shadow: 0 0 0 3px rgba(255,176,32,0.14) !important;
            }
            #sc-gif-go:disabled { opacity: 0.5 !important; cursor: default !important; }
            #sc-gif-status { color: rgba(244,244,242,0.62) !important; font-size: 12px !important; min-height: 14px !important; }
            #sc-gif-result img { width: 100% !important; border-radius: 8px !important; display: block !important; }
            #sc-gif-actions { display: flex !important; align-items: center !important; gap: 10px !important; margin-top: 8px !important; }
            #sc-gif-dl { background: transparent !important; color: rgba(244,244,242,0.62) !important;
                         border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 8px !important;
                         padding: 5px 12px !important; font-size: 12px !important; cursor: pointer !important;
                         text-decoration: none !important;
                         transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important; }
            #sc-gif-dl:hover { background: rgba(255,176,32,0.14) !important; border-color: #ffb020 !important; color: #f4f4f2 !important; }
            #sc-gif-size { color: rgba(244,244,242,0.34) !important; font-size: 11px !important; margin-left: auto !important; }
            .sc-gif-mid-header {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                background: transparent !important; border: none !important; padding: 0 !important;
                cursor: pointer !important; width: 100% !important; text-align: left !important;
                color: rgba(244,244,242,0.62) !important; font-size: 12px !important; font-weight: 500 !important;
                text-transform: uppercase !important; letter-spacing: 0.06em !important;
                transition: color 120ms ease !important;
            }
            .sc-gif-mid-header:hover { color: #f4f4f2 !important; }
            .sc-gif-mid-header:hover .sc-gif-mid-toggle { color: #f4f4f2 !important; }
            .sc-gif-mid-header:focus-visible { outline: 2px solid #ffb020 !important; outline-offset: 1px !important; }
            .sc-gif-mid-toggle { color: rgba(244,244,242,0.34) !important; font-size: 11px !important; }
            .sc-gif-cols { display: flex !important; flex-wrap: wrap !important; gap: 16px !important; margin-top: -8px !important; }
            .sc-gif-cols.sc-gif-mid-collapsed { display: none !important; }
            .sc-gif-col-left, .sc-gif-col-right {
                flex: 1 1 260px !important; min-width: 0 !important;
                display: flex !important; flex-direction: column !important; gap: 8px !important;
                background: rgba(244,244,242,0.02) !important;
                border: 1px solid rgba(244,244,242,0.06) !important;
                border-radius: 8px !important;
                padding: 12px !important;
            }
            .sc-gif-fx-header {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                background: transparent !important; border: none !important; padding: 0 !important;
                cursor: pointer !important; width: 100% !important; text-align: left !important;
                color: rgba(244,244,242,0.62) !important; font-size: 12px !important; font-weight: 500 !important;
                text-transform: uppercase !important; letter-spacing: 0.06em !important;
                transition: color 120ms ease !important;
            }
            .sc-gif-fx-header:hover { color: #f4f4f2 !important; }
            .sc-gif-fx-header:hover .sc-gif-fx-toggle { color: #f4f4f2 !important; }
            .sc-gif-fx-header:focus-visible { outline: 2px solid #ffb020 !important; outline-offset: 1px !important; }
            .sc-gif-fx-toggle { color: rgba(244,244,242,0.34) !important; font-size: 11px !important; }
            .sc-gif-fx { display: none !important; flex-direction: column !important; gap: 8px !important; }
            .sc-gif-fx.sc-gif-fx-open { display: flex !important; }
            .sc-gif-sq-header {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                background: transparent !important; border: none !important; padding: 0 !important;
                cursor: pointer !important; width: 100% !important; text-align: left !important;
                color: rgba(244,244,242,0.62) !important; font-size: 12px !important; font-weight: 500 !important;
                text-transform: uppercase !important; letter-spacing: 0.06em !important;
                transition: color 120ms ease !important;
            }
            .sc-gif-sq-header:hover { color: #f4f4f2 !important; }
            .sc-gif-sq-header:hover .sc-gif-sq-toggle { color: #f4f4f2 !important; }
            .sc-gif-sq-header:focus-visible { outline: 2px solid #ffb020 !important; outline-offset: 1px !important; }
            .sc-gif-sq-toggle { color: rgba(244,244,242,0.34) !important; font-size: 11px !important; }
            .sc-gif-sq { display: none !important; flex-direction: column !important; gap: 6px !important; }
            .sc-gif-sq.sc-gif-sq-open { display: flex !important; }
            .sc-gif-sq label { flex: 1 1 0 !important; }
            .sc-gif-fx-row { display: flex !important; align-items: center !important; gap: 10px !important; }
            .sc-gif-fx-row label { flex: 1 1 0 !important; }
            .sc-gif-fx-row input[type=number] {
                width: 64px !important; background: #1f1f22 !important; color: #f4f4f2 !important;
                border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 4px !important; padding: 2px 4px !important;
                transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important;
            }
            .sc-gif-fx-row input[type=number]:hover, .sc-gif-fx-row input[type=number]:focus { border-color: rgba(255,176,32,0.5) !important; }
            .sc-gif-fx-filters { display: flex !important; flex-direction: column !important; gap: 6px !important; }
            .sc-gif-fx-filter { display: flex !important; align-items: center !important; gap: 8px !important; }
            .sc-gif-fx-filter label { flex: 0 0 auto !important; white-space: nowrap !important; color: rgba(244,244,242,0.62) !important; font-size: 12px !important; }
            .sc-gif-fx-filter input[type=range] { flex: 1 1 auto !important; min-width: 0 !important; accent-color: #ffb020 !important; }
            .sc-test-ok      { color: #7dffa0 !important; }
            .sc-test-bad     { color: #ff8080 !important; }
            .sc-test-pending { color: rgba(244,244,242,0.34) !important; }
            #sc-gif-link {
                display: flex !important; align-items: center !important; gap: 8px !important;
                flex-wrap: wrap !important; margin-top: 8px !important;
            }
            .sc-gif-link-url {
                color: #8ab4ff !important; font-size: 12px !important; word-break: break-all !important;
                text-decoration: none !important;
            }
            .sc-gif-link-url:hover { text-decoration: underline !important; }
            .sc-gif-link-msg { color: rgba(244,244,242,0.62) !important; font-size: 12px !important; }
            #sc-gif-copylink, #sc-gif-upload {
                background: transparent !important; color: rgba(244,244,242,0.62) !important;
                border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 8px !important;
                padding: 5px 12px !important; font-size: 12px !important; cursor: pointer !important;
                transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important;
            }
            #sc-gif-copylink:hover, #sc-gif-upload:hover:not(:disabled) {
                background: rgba(255,176,32,0.14) !important; border-color: #ffb020 !important; color: #f4f4f2 !important;
            }
            #sc-gif-upload:disabled { opacity: 0.5 !important; cursor: default !important; }
        `;
        document.head.appendChild(style);
    }

    /* ==========================================================
       TITLE SLUG — filename naming, no TMDB cleanup.
       Reads whatever CyTube's own title element currently shows —
       these are CyTube's DOM nodes, not something this script creates.
    ========================================================== */
    function currentRawTitle() {
        for (const el of [
            document.getElementById('currenttitle'),
            document.querySelector('#videowrap-header .pull-left'),
            document.querySelector('#videowrap-header span'),
            document.querySelector('.video-title'),
        ]) {
            if (el && el.textContent.trim()) return el.textContent.trim();
        }
        return '';
    }
    function gifTitleSlug() {
        const raw = currentRawTitle();
        if (!raw) return '';
        return raw.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    }

    function _fmtClockTenths(sec) {
        sec = Math.max(0, sec);
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
    }
    function _fmtFilenameTimestamp(sec) {
        sec = Math.max(0, Math.round(sec));
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        const pad = n => String(n).padStart(2, '0');
        return pad(h) + 'h' + pad(m) + 'm' + pad(s) + 's';
    }
    function _gifEscHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

    /* ==========================================================
       MEME CAPTION RENDERING — shared by the live CSS preview and
       the actual per-frame canvas render, so what you see in the
       panel is what gets baked into the GIF.
    ========================================================== */
    const CAPTION_FONT_STACK = 'Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif';
    let _captionMeasureCtx = null;
    function getCaptionMeasureCtx() {
        if (!_captionMeasureCtx) {
            const c = document.createElement('canvas');
            _captionMeasureCtx = c.getContext('2d');
        }
        return _captionMeasureCtx;
    }
    function wrapCaptionAtSize(ctx, text, fontPx, maxWidth) {
        ctx.font = 'bold ' + fontPx + 'px ' + CAPTION_FONT_STACK;
        const words = text.split(/\s+/).filter(Boolean);
        const lines = [];
        let line = '';
        for (const w of words) {
            const trial = line ? line + ' ' + w : w;
            if (line && ctx.measureText(trial).width > maxWidth) {
                lines.push(line);
                line = w;
            } else {
                line = trial;
            }
        }
        if (line) lines.push(line);
        const widest = lines.reduce((m, l) => Math.max(m, ctx.measureText(l).width), 0);
        return { lines, widest };
    }
    function applyCaptionCtxStyle(ctx, fontPx, color, progress) {
        ctx.font = 'bold ' + fontPx + 'px ' + CAPTION_FONT_STACK;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        if (color === 'rainbow') {
            ctx.fillStyle = 'hsl(' + Math.round((progress || 0) * 360) + ', 90%, 60%)';
        } else {
            ctx.fillStyle = color === 'yellow' ? '#ffe135' : '#ffffff';
        }
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = Math.max(2, Math.round(fontPx / 14));
    }
    // Wiggle offsets the block center with a progress-driven sine wobble
    // (not per-frame random jitter) because GIF capture runs at low fps
    // (8-15) — random jitter at that rate reads as flicker, not motion.
    // Different x/y frequencies avoid a simple circular path.
    function drawCaptionBlockAdvanced(ctx, w, h, text, color, sizePct, xPct, yPct, progress, fx) {
        if (!text) return;
        const fontPx = Math.max(4, Math.round(h * (sizePct || 16) / 100));
        const { lines } = wrapCaptionAtSize(getCaptionMeasureCtx(), text.toUpperCase(), fontPx, w * 0.92);
        const lineHeight = Math.round(fontPx * 1.15);
        ctx.save();
        applyCaptionCtxStyle(ctx, fontPx, color, progress);
        let cx = w * ((xPct == null ? 50 : xPct) / 100);
        let cy = h * ((yPct == null ? 50 : yPct) / 100);
        if (fx && fx.wiggle && fx.wiggle.enabled) {
            const amp = Math.max(0, Math.min(100, fx.wiggle.intensity || 0)) / 100 * fontPx * 0.35;
            cx += Math.sin((progress || 0) * Math.PI * 2 * 3) * amp;
            cy += Math.sin((progress || 0) * Math.PI * 2 * 2) * amp;
        }
        const blockH = lines.length * lineHeight;
        const firstBaselineY = cy - blockH / 2 + fontPx * 0.8;
        const shadowOn = !!(fx && fx.shadow && fx.shadow.enabled);
        if (shadowOn) {
            // Shadow is applied under the stroke pass only, then cleared
            // before the fill pass — canvas shadow would otherwise render
            // twice (once per draw call) and look doubled/blurred. This
            // requires two separate passes (all strokes, then all fills)
            // instead of the original interleaved per-line loop, so this
            // split only happens when shadow is actually on — with it off,
            // the original single interleaved loop runs unchanged, keeping
            // draw order (and therefore pixel output) identical to before
            // this feature existed.
            const amt = Math.max(0, Math.min(100, fx.shadow.intensity || 0)) / 100;
            ctx.shadowColor = 'rgba(0,0,0,0.7)';
            ctx.shadowBlur = amt * 14;
            ctx.shadowOffsetX = amt * 5;
            ctx.shadowOffsetY = amt * 5;
            lines.forEach((line, i) => {
                const ly = firstBaselineY + i * lineHeight;
                ctx.strokeText(line, cx, ly);
            });
            ctx.shadowColor = 'transparent';
            lines.forEach((line, i) => {
                const ly = firstBaselineY + i * lineHeight;
                ctx.fillText(line, cx, ly);
            });
        } else {
            lines.forEach((line, i) => {
                const ly = firstBaselineY + i * lineHeight;
                ctx.strokeText(line, cx, ly);
                ctx.fillText(line, cx, ly);
            });
        }
        ctx.restore();
    }
    function drawCaptions(ctx, w, h, captions, progress) {
        if (!captions) return;
        ['top', 'bottom'].forEach(key => {
            const line = captions[key];
            if (!line || !line.text) return;
            drawCaptionBlockAdvanced(ctx, w, h, line.text, captions.color, line.size, line.x, line.y, progress, captions.fx);
        });
    }

    /* ==========================================================
       FRAME CAPTURE + GIF ENCODE
       CyTube's on-page <video> has no crossOrigin attribute, so its
       canvas is tainted. Spin up a hidden crossOrigin clone of the
       same source, seek/play it, sample frames to a canvas, hand
       them to gif.js (Web-Worker encoder). The on-page video is
       never touched.
    ========================================================== */
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

    function captureGifFrames({ src, startT, endT, fps, width, aspect, captions }, onProgress) {
        return new Promise((resolve, reject) => {
            const vid = document.createElement('video');
            vid.crossOrigin = 'anonymous';
            vid.muted = true;
            vid.preload = 'auto';
            vid.playsInline = true;
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
                    const capProgress = Math.min(1, Math.max(0, (t - startT) / span));
                    drawCaptions(ctx, w, h, captions, capProgress);
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

    /* ==========================================================
       REACTION EFFECTS — playback sequencing + visual filters.
       sourceFrames captured above is never mutated: buildPlaybackSequence
       only computes which frame index plays at each output position, and
       renderSequenceFrame (added later) clones before filtering so a
       frame reused by boomerang/freeze-hold is never double-filtered.
    ========================================================== */
    const MAX_SEQ_FRAMES = 400;
    function buildPlaybackSequence(frameCount, playback) {
        if (!frameCount || frameCount <= 0) return [];
        const mode = (playback && playback.mode) || 'normal';
        const speed = (playback && playback.speed) || 1;
        const freezeHoldMs = (playback && playback.freezeHoldMs) || 0;
        const fps = (playback && playback.fps) || 12;

        let seq;
        if (mode === 'reverse') {
            seq = [];
            for (let i = frameCount - 1; i >= 0; i--) seq.push(i);
        } else if (mode === 'boomerang') {
            const forward = [];
            for (let i = 0; i < frameCount; i++) forward.push(i);
            const middle = forward.slice(1, -1).reverse();
            seq = forward.concat(middle);
        } else {
            seq = [];
            for (let i = 0; i < frameCount; i++) seq.push(i);
        }

        if (speed > 1) {
            const sped = [];
            for (let i = 0; i * speed < seq.length; i++) sped.push(seq[Math.floor(i * speed)]);
            seq = sped.length ? sped : [seq[seq.length - 1]];
        } else if (speed < 1 && speed > 0) {
            const repeatCount = Math.max(1, Math.round(1 / speed));
            const slowed = [];
            seq.forEach(idx => { for (let r = 0; r < repeatCount; r++) slowed.push(idx); });
            seq = slowed;
        }

        if (freezeHoldMs > 0 && seq.length) {
            const holdFrames = Math.round((freezeHoldMs / 1000) * fps);
            const lastIdx = seq[seq.length - 1];
            for (let r = 0; r < holdFrames; r++) seq.push(lastIdx);
        }

        if (seq.length > MAX_SEQ_FRAMES) seq = seq.slice(0, MAX_SEQ_FRAMES);

        return seq.length ? seq : [0];
    }

    // Deterministic pseudo-random 0..1, never Math.random() — the same
    // frame at the same sequence position must always get the same
    // noise/jitter, so re-encoding a clip reproduces byte-identical effects.
    function _seededNoise(seed) {
        const x = Math.sin(seed) * 10000;
        return x - Math.floor(x);
    }

    function cloneImageData(imageData) {
        return new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
    }

    function applyDeepFry(imageData, intensity) {
        const amt = Math.max(0, Math.min(100, intensity || 0)) / 100;
        if (amt <= 0) return imageData;
        const d = imageData.data;
        const contrast = 1 + amt * 1.5;
        const satBoost = 1 + amt * 1.2;
        const noiseAmt = amt * 40;
        for (let i = 0; i < d.length; i += 4) {
            let r = d[i], g = d[i + 1], b = d[i + 2];
            r = (r - 128) * contrast + 128;
            g = (g - 128) * contrast + 128;
            b = (b - 128) * contrast + 128;
            const gray = 0.299 * r + 0.587 * g + 0.114 * b;
            r = gray + (r - gray) * satBoost;
            g = gray + (g - gray) * satBoost;
            b = gray + (b - gray) * satBoost;
            const n = (_seededNoise(i * 0.9973 + 1) - 0.5) * noiseAmt;
            d[i]     = Math.max(0, Math.min(255, r + n));
            d[i + 1] = Math.max(0, Math.min(255, g + n));
            d[i + 2] = Math.max(0, Math.min(255, b + n));
        }
        return imageData;
    }

    function applyVhs(imageData, intensity, seqPosition) {
        const amt = Math.max(0, Math.min(100, intensity || 0)) / 100;
        if (amt <= 0) return imageData;
        const d = imageData.data, w = imageData.width, h = imageData.height;
        const shift = Math.round(amt * 4);
        const scanlineDark = amt * 0.35;
        const srcCopy = new Uint8ClampedArray(d);
        for (let y = 0; y < h; y++) {
            const rowJitter = shift > 0
                ? Math.round((_seededNoise(y * 12.9898 + seqPosition * 78.233) - 0.5) * amt * 6) : 0;
            for (let x = 0; x < w; x++) {
                const di = (y * w + x) * 4;
                const rx = Math.max(0, Math.min(w - 1, x - shift + rowJitter));
                const bx = Math.max(0, Math.min(w - 1, x + shift + rowJitter));
                const ri = (y * w + rx) * 4, bi = (y * w + bx) * 4;
                d[di]     = srcCopy[ri];
                d[di + 1] = srcCopy[di + 1];
                d[di + 2] = srcCopy[bi + 2];
                if (y % 2 === 0) {
                    d[di]     *= (1 - scanlineDark);
                    d[di + 1] *= (1 - scanlineDark);
                    d[di + 2] *= (1 - scanlineDark);
                }
            }
        }
        return imageData;
    }

    let _fxScratchCanvas = null;
    function getFxScratchCanvas(w, h) {
        if (!_fxScratchCanvas) _fxScratchCanvas = document.createElement('canvas');
        _fxScratchCanvas.width = w; _fxScratchCanvas.height = h;
        return _fxScratchCanvas;
    }
    let _fxOutCanvas = null;
    function getFxOutCanvas(w, h) {
        if (!_fxOutCanvas) _fxOutCanvas = document.createElement('canvas');
        _fxOutCanvas.width = w; _fxOutCanvas.height = h;
        return _fxOutCanvas;
    }
    function applyZoomShake(imageData, w, h, mode, intensity, seqPosition, seqLength) {
        const amt = Math.max(0, Math.min(100, intensity || 0)) / 100;
        if (amt <= 0) return imageData;
        const srcCanvas = getFxScratchCanvas(w, h);
        const sctx = srcCanvas.getContext('2d');
        sctx.putImageData(imageData, 0, 0);
        const out = getFxOutCanvas(w, h);
        const octx = out.getContext('2d');
        octx.clearRect(0, 0, w, h);
        if (mode === 'shake') {
            const dx = (_seededNoise(seqPosition * 17.23 + 3) - 0.5) * amt * 0.08 * w;
            const dy = (_seededNoise(seqPosition * 41.11 + 7) - 0.5) * amt * 0.08 * h;
            octx.drawImage(srcCanvas, dx, dy);
        } else {
            const progress = seqLength > 1 ? seqPosition / (seqLength - 1) : 0;
            const scale = 1 + progress * amt * 0.35;
            const sw = w / scale, sh = h / scale;
            const sx = (w - sw) / 2, sy = (h - sh) / 2;
            octx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, w, h);
        }
        return octx.getImageData(0, 0, w, h);
    }

    function applyFilters(imageData, w, h, filters, seqPosition, seqLength) {
        let out = imageData;
        if (filters && filters.zoomShake && filters.zoomShake.enabled) {
            out = applyZoomShake(out, w, h, filters.zoomShake.mode, filters.zoomShake.intensity, seqPosition, seqLength);
        }
        if (filters && filters.deepFry && filters.deepFry.enabled) {
            out = applyDeepFry(out, filters.deepFry.intensity);
        }
        if (filters && filters.vhs && filters.vhs.enabled) {
            out = applyVhs(out, filters.vhs.intensity, seqPosition);
        }
        return out;
    }

    const GIF_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js';
    let _gifWorkerBlobUrl = null;
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

    // gifsicle-wasm-browser is ~35x the size of gif.js — lazy-fetch it only
    // when a GIF is actually being optimized, never @require it. It assigns
    // a bare top-level `let gifsicle = {...}`; running its source inside a
    // Function body whose own last statement returns that binding captures
    // the export without touching any outer/global scope.
    const GIFSICLE_URL = 'https://cdn.jsdelivr.net/npm/gifsicle-wasm-browser@1.5.19/dist/gifsicle.min.js';
    let _gifsicleCtor = null;
    function getGifsicleCtor() {
        if (_gifsicleCtor) return Promise.resolve(_gifsicleCtor);
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url: GIFSICLE_URL,
                onload: r => {
                    if (r.status < 200 || r.status >= 300) { reject(new Error('gifsicle HTTP ' + r.status)); return; }
                    try {
                        // The bundle ends with a literal ES-module `export default gifsicle;`,
                        // which is a syntax error inside a Function body — strip it before
                        // executing; the preceding `let gifsicle = {...}` is plain classic-script
                        // code and is what our appended return statement actually captures.
                        const src = r.responseText.replace(/export\s+default\s+gifsicle\s*;?\s*$/, '');
                        _gifsicleCtor = new Function(src + '\n;return typeof gifsicle !== "undefined" ? gifsicle : null;')();
                        if (!_gifsicleCtor) { reject(new Error('gifsicle export not found')); return; }
                        resolve(_gifsicleCtor);
                    } catch (e) { reject(e); }
                },
                onerror: () => reject(new Error('gifsicle fetch failed')),
            });
        });
    }

    // Resolves one output position to a filtered frame. Clones the source
    // before filtering (only when a filter is actually enabled) because
    // boomerang/freeze-hold reuse the same sourceFrames[i] entry at
    // multiple sequence positions, and applyDeepFry/applyVhs mutate their
    // input in place — without the clone, a repeated frame would be
    // filtered again every time it recurs.
    function renderSequenceFrame(sourceFrames, sequence, i, w, h, filters) {
        const frameIndex = sequence[i];
        const source = sourceFrames[frameIndex];
        const hasAnyFilter = !!(filters && (
            (filters.zoomShake && filters.zoomShake.enabled) ||
            (filters.deepFry && filters.deepFry.enabled) ||
            (filters.vhs && filters.vhs.enabled)));
        if (!hasAnyFilter) return source;
        // applyZoomShake never mutates its input — it reads it via putImageData
        // and always returns a brand-new ImageData from a separate canvas — so
        // when zoom/shake is enabled it already guarantees a fresh, non-shared
        // buffer for the mutate-in-place filters (deepFry/vhs) that may run
        // after it. Only clone here when zoom/shake will NOT run, since in
        // that case the first filter to touch the frame would otherwise
        // mutate the shared sourceFrames[frameIndex] entry in place.
        const zoomShakeWillRun = !!(filters.zoomShake && filters.zoomShake.enabled && filters.zoomShake.intensity > 0);
        const input = zoomShakeWillRun ? source : cloneImageData(source);
        return applyFilters(input, w, h, filters, i, sequence.length);
    }

    function encodeGif({ frames, w, h, delay, playback, filters }, onProgress) {
        return getGifWorkerUrl().then(workerScript => new Promise((resolve, reject) => {
            const Ctor = getGifCtor();
            if (!Ctor) { reject(new Error('gif.js not loaded (@require missing?)')); return; }
            const repeat = (playback && playback.mode === 'stop') ? -1 : 0;
            const gif = new Ctor({ workers: 2, quality: 10, width: w, height: h, workerScript, repeat });
            const sequence = buildPlaybackSequence(frames.length, playback || {});
            for (let i = 0; i < sequence.length; i++) {
                gif.addFrame(renderSequenceFrame(frames, sequence, i, w, h, filters || {}), { delay });
            }
            gif.on('progress', p => onProgress && onProgress(p));
            gif.on('finished', blob => resolve(blob));
            gif.on('abort', () => reject(new Error('encode aborted')));
            gif.render();
        }));
    }

    // Optional lossless size-shrink via gifsicle -O3, run after encodeGif().
    // Any failure anywhere in here falls back to the original blob silently
    // — this step is strictly additive and must never break Make GIF.
    async function maybeOptimizeGif(blob) {
        if (!gifOptimizeEnabled()) return blob;
        try {
            const gifsicle = await getGifsicleCtor();
            const out = await gifsicle.run({
                input: [{ file: blob, name: 'in.gif' }],
                command: ['-O3 in.gif -o /out/out.gif'],
            });
            return (out && out[0]) ? out[0] : blob;
        } catch (e) {
            console.warn('[GIFMaker] GIF optimize failed, using unoptimized output:', e);
            return blob;
        }
    }

    let _gifResultUrl = null;
    function _revokeGifResult() {
        if (_gifResultUrl) { URL.revokeObjectURL(_gifResultUrl); _gifResultUrl = null; }
    }

    /* ==========================================================
       SCRUB-BAR PREVIEW THUMBNAILS
       A persistent hidden clone, kept loaded while the panel is
       open so seeking start/end preview frames is fast (one
       decode, many seeks).
    ========================================================== */
    let _gifScrub = null;
    function getScrubClone(src) {
        if (_gifScrub && _gifScrub.src === src) return _gifScrub;
        destroyScrubClone();
        const vid = document.createElement('video');
        vid.crossOrigin = 'anonymous'; vid.muted = true; vid.preload = 'auto'; vid.playsInline = true;
        vid.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
        document.body.appendChild(vid);
        const ready = new Promise((resolve, reject) => {
            vid.addEventListener('loadedmetadata', () => resolve(), { once: true });
            vid.addEventListener('error', () => reject(new Error('preview load error (CORS/network)')), { once: true });
        });
        vid.src = src;
        _gifScrub = { vid, src, ready, busy: Promise.resolve() };
        return _gifScrub;
    }
    function destroyScrubClone() {
        if (_gifScrub) { try { _gifScrub.vid.remove(); } catch (e) {} _gifScrub = null; }
    }
    // Seeks are serialized through the clone's `busy` chain so rapid
    // nudges don't collide. A *paused* video usually hasn't painted the
    // seeked frame by the time 'seeked' fires (drawImage -> black), so
    // this briefly plays muted and captures the first presented frame
    // via requestVideoFrameCallback.
    function grabPreviewFrame(src, time, w) {
        const sc = getScrubClone(src);
        const run = sc.busy.then(() => sc.ready).then(() => new Promise((resolve, reject) => {
            const vid = sc.vid;
            let settled = false;
            const draw = () => {
                if (settled) return;
                settled = true;
                try {
                    const h = Math.max(2, Math.round(w * vid.videoHeight / vid.videoWidth));
                    const c = document.createElement('canvas');
                    c.width = w; c.height = h;
                    const ctx = c.getContext('2d');
                    ctx.drawImage(vid, 0, 0, w, h);
                    const url = c.toDataURL('image/jpeg', 0.72);
                    try { vid.pause(); } catch (e) {}
                    resolve(url);
                } catch (e) { try { vid.pause(); } catch (e2) {} reject(e); }
            };
            const onSeeked = () => {
                let ticks = 0;
                const onFrame = () => {
                    if (settled) return;
                    ticks++;
                    if (ticks < 2) { vid.requestVideoFrameCallback(onFrame); return; }
                    draw();
                };
                if ('requestVideoFrameCallback' in vid) vid.requestVideoFrameCallback(onFrame);
                vid.play().catch(() => {});
                setTimeout(() => { if (!settled) draw(); }, 1500);
            };
            vid.addEventListener('seeked', onSeeked, { once: true });
            setTimeout(() => { if (!settled) onSeeked(); }, 800);
            try { vid.currentTime = Math.max(0, time); } catch (e) { reject(e); }
        }));
        sc.busy = run.catch(() => {});
        return run;
    }

    /* ==========================================================
       IMGBB — upload/test
    ========================================================== */
    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result).split(',', 2)[1] || '');
            r.onerror = () => reject(new Error('read failed'));
            r.readAsDataURL(blob);
        });
    }

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

    // Also used directly as the `testHandler` for the ImgBB settings row
    // registered near the bottom of this file — its signature already
    // matches scRegisterSetting's `async (value) => 'valid'|'invalid'|'error'`
    // contract exactly, so no adapter is needed.
    async function validateImgbbKey(apiKey) {
        // ImgBB has no key-check endpoint, so probe with a tiny 1x1 PNG upload.
        const onePx = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
        try {
            const res = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'POST',
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

    /* ==========================================================
       GIF PANEL
    ========================================================== */
    const MIN_CLIP_GAP = 0.1;
    const MAX_CLIP_LEN = 10;
    const FILMSTRIP_MARGIN = 3;
    const FILMSTRIP_MIN_WINDOW = 12;
    const FILMSTRIP_EDGE_PAD = 1;
    const FILMSTRIP_TILES = 10;
    const OVERVIEW_NUDGE_SEC = 1;
    const OVERVIEW_NUDGE_SEC_FAST = 10;
    const SELECTION_EDGE_ZONE_PX = 20;
    const SELECTION_AUTOSCROLL_STEP = 0.2;
    const SELECTION_AUTOSCROLL_INTERVAL_MS = 100;

    function openGifPanel(initialSec) {
        if (document.getElementById('sc-gif-panel')) return;
        injectGifPanelCss();

        const v0 = getPlayerVideoEl();
        const src = v0 && (v0.currentSrc || v0.src) || '';
        const isBlob = src.startsWith('blob:');
        const vidDur = (v0 && isFinite(v0.duration)) ? v0.duration : Infinity;
        const now = (typeof initialSec === 'number' && isFinite(initialSec))
            ? initialSec
            : (v0 ? v0.currentTime : 0);

        const DEFAULT_CLIP_LEN = 2;
        let startT = Math.max(0, now - DEFAULT_CLIP_LEN);
        let endT = Math.min(vidDur, startT + DEFAULT_CLIP_LEN);
        let _filmstripWindow = null; // { windowStart, windowEnd } — sticky across renders

        const panel = document.createElement('div');
        panel.id = 'sc-gif-panel';
        panel.innerHTML = `
            <div id="sc-gif-head">
                <span>Make GIF</span>
                <button id="sc-gif-close" type="button">✕</button>
            </div>
            <div id="sc-gif-body">
                <div class="sc-gif-card">
                <div class="sc-gif-overview">
                    <div class="sc-gif-overview-track" id="sc-gif-overview-track" tabindex="0">
                        <div class="sc-gif-overview-viewport" id="sc-gif-overview-viewport"></div>
                        <div class="sc-gif-overview-ghost" id="sc-gif-overview-ghost"></div>
                    </div>
                    <div class="sc-gif-overview-labels">
                        <span>0:00</span>
                        <span class="sc-gif-overview-current"><span id="sc-gif-overview-label">Currently editing:</span> <span id="sc-gif-overview-current" class="sc-gif-mono"></span><span id="sc-gif-overview-hint"></span></span>
                        <span>Window: <span id="sc-gif-filmstrip-range"></span></span>
                        <span id="sc-gif-overview-total"></span>
                    </div>
                </div>
                <div class="sc-gif-filmstrip">
                    <div class="sc-gif-filmstrip-strip" id="sc-gif-filmstrip-strip">
                        <div class="sc-gif-filmstrip-tiles" id="sc-gif-filmstrip-tiles"></div>
                        <div class="sc-gif-filmstrip-dim-left" id="sc-gif-filmstrip-dim-left"></div>
                        <div class="sc-gif-filmstrip-dim-right" id="sc-gif-filmstrip-dim-right"></div>
                        <div class="sc-gif-filmstrip-selection" id="sc-gif-filmstrip-selection"></div>
                        <div class="sc-gif-filmstrip-handle" id="sc-gif-filmstrip-handle-start" data-handle="start" title="Drag: start"><div class="sc-gif-filmstrip-handle-grip"></div></div>
                        <div class="sc-gif-filmstrip-handle" id="sc-gif-filmstrip-handle-end" data-handle="end" title="Drag: end"><div class="sc-gif-filmstrip-handle-grip"></div></div>
                    </div>
                </div>
                <div class="sc-gif-marks">
                    <div class="sc-gif-mark">
                        <div class="sc-gif-thumb" id="sc-gif-thumb-start">
                            <div class="sc-gif-cap sc-gif-cap-top" id="sc-gif-cap-top-start"></div>
                            <div class="sc-gif-cap sc-gif-cap-bottom" id="sc-gif-cap-bottom-start"></div>
                            <div class="sc-gif-cap-handle sc-gif-cap-handle-top" id="sc-gif-cap-handle-top-start" title="Drag top caption"></div>
                            <div class="sc-gif-cap-handle sc-gif-cap-handle-bottom" id="sc-gif-cap-handle-bottom-start" title="Drag bottom caption"></div>
                        </div>
                        <div class="sc-gif-mark-label">START · <span id="sc-gif-time-start"></span></div>
                        <div class="sc-gif-mark-btns">
                            <button type="button" data-act="start-current" title="Set start to current playback position">⤓ Now</button>
                            <button type="button" data-act="start-minus">−.5</button>
                            <button type="button" data-act="start-plus">+.5</button>
                        </div>
                    </div>
                    <div class="sc-gif-mark">
                        <div class="sc-gif-thumb sc-gif-thumb-readonly" id="sc-gif-thumb-end">
                            <div class="sc-gif-cap sc-gif-cap-top" id="sc-gif-cap-top-end"></div>
                            <div class="sc-gif-cap sc-gif-cap-bottom" id="sc-gif-cap-bottom-end"></div>
                        </div>
                        <div class="sc-gif-mark-label">END · <span id="sc-gif-time-end"></span></div>
                        <div class="sc-gif-mark-btns">
                            <button type="button" data-act="end-minus">−.5</button>
                            <button type="button" data-act="end-plus">+.5</button>
                        </div>
                    </div>
                </div>
                <div id="sc-gif-dur-line">Duration <b id="sc-gif-dur-val"></b></div>
                </div>
                <button type="button" class="sc-gif-mid-header" id="sc-gif-mid-header" aria-expanded="true">
                    <span>Captions &amp; Format</span>
                    <span class="sc-gif-mid-toggle" id="sc-gif-mid-toggle">▾</span>
                </button>
                <div class="sc-gif-cols" id="sc-gif-mid-body">
                    <div class="sc-gif-col-left">
                        <div class="sc-gif-captions">
                            <input type="text" id="sc-gif-cap-top" class="sc-gif-cap-input" placeholder="TOP TEXT (optional)" maxlength="120">
                            <input type="text" id="sc-gif-cap-bottom" class="sc-gif-cap-input sc-gif-cap-bottom-input" placeholder="BOTTOM TEXT (optional)" maxlength="120">
                            <div class="sc-gif-cap-color">
                                <label><input type="radio" name="sc-gif-cap-color" value="white" checked> White</label>
                                <label><input type="radio" name="sc-gif-cap-color" value="yellow"> Yellow</label>
                                <label><input type="radio" name="sc-gif-cap-color" value="rainbow"> Rainbow</label>
                            </div>
                            <div class="sc-gif-cap-sizes">
                                <label>Top <input type="number" id="sc-gif-cap-top-size" min="4" max="40" step="1" value="16">%</label>
                                <label>Bottom <input type="number" id="sc-gif-cap-bottom-size" min="4" max="40" step="1" value="16">%</label>
                            </div>
                            <div class="sc-gif-fx-filter">
                                <input type="checkbox" id="sc-gif-fx-shadow-on">
                                <label for="sc-gif-fx-shadow-on">Drop shadow</label>
                                <input type="range" id="sc-gif-fx-shadow-amt" min="0" max="100" value="60">
                            </div>
                            <div class="sc-gif-fx-filter">
                                <input type="checkbox" id="sc-gif-fx-wiggle-on">
                                <label for="sc-gif-fx-wiggle-on">Wiggle</label>
                                <input type="range" id="sc-gif-fx-wiggle-amt" min="0" max="100" value="60">
                            </div>
                            <div class="sc-gif-cap-hint">Drag the dots on the START preview to position each caption.</div>
                        </div>
                    </div>
                    <div class="sc-gif-col-right">
                        <button type="button" class="sc-gif-fx-header" id="sc-gif-fx-header" aria-expanded="true">
                            <span>Effects</span>
                            <span class="sc-gif-fx-toggle" id="sc-gif-fx-toggle">▾</span>
                        </button>
                        <div class="sc-gif-fx sc-gif-fx-open" id="sc-gif-fx-body">
                            <div class="sc-gif-fx-row">
                                <label>Playback
                                    <select id="sc-gif-fx-mode">
                                        <option value="normal" selected>Normal</option>
                                        <option value="reverse">Reverse</option>
                                        <option value="boomerang">Boomerang</option>
                                        <option value="stop">Stop</option>
                                    </select>
                                </label>
                                <label>Speed
                                    <select id="sc-gif-fx-speed">
                                        <option value="0.5">0.5x</option>
                                        <option value="1" selected>1x</option>
                                        <option value="1.5">1.5x</option>
                                        <option value="2">2x</option>
                                    </select>
                                </label>
                            </div>
                            <div class="sc-gif-fx-row">
                                <label>Freeze hold (ms)
                                    <input type="number" id="sc-gif-fx-freeze" min="0" max="3000" step="100" value="0">
                                </label>
                            </div>
                            <div class="sc-gif-fx-filters">
                                <div class="sc-gif-fx-filter">
                                    <input type="checkbox" id="sc-gif-fx-deepfry-on">
                                    <label for="sc-gif-fx-deepfry-on">Deep-fry</label>
                                    <input type="range" id="sc-gif-fx-deepfry-amt" min="0" max="100" value="60">
                                </div>
                                <div class="sc-gif-fx-filter">
                                    <input type="checkbox" id="sc-gif-fx-vhs-on">
                                    <label for="sc-gif-fx-vhs-on">VHS / glitch</label>
                                    <input type="range" id="sc-gif-fx-vhs-amt" min="0" max="100" value="60">
                                </div>
                                <div class="sc-gif-fx-filter">
                                    <input type="checkbox" id="sc-gif-fx-zoomshake-on">
                                    <label for="sc-gif-fx-zoomshake-on">Zoom/Shake</label>
                                    <select id="sc-gif-fx-zoomshake-mode">
                                        <option value="zoom" selected>Zoom-in</option>
                                        <option value="shake">Shake</option>
                                    </select>
                                    <input type="range" id="sc-gif-fx-zoomshake-amt" min="0" max="100" value="60">
                                </div>
                            </div>
                        </div>
                        <button type="button" class="sc-gif-sq-header" id="sc-gif-sq-header" aria-expanded="false">
                            <span>Size &amp; Quality</span>
                            <span class="sc-gif-sq-toggle" id="sc-gif-sq-toggle">▸</span>
                        </button>
                        <div class="sc-gif-sq" id="sc-gif-sq-body">
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
                    </div>
                </div>
                <div id="sc-gif-status"></div>
                <div id="sc-gif-result"></div>
                <button id="sc-gif-go" type="button">● Make GIF</button>
            </div>`;
        document.body.appendChild(panel);

        const $ = id => panel.querySelector(id);
        const goBtn = $('#sc-gif-go'), status = $('#sc-gif-status'), result = $('#sc-gif-result');
        $('#sc-gif-overview-total').textContent = isFinite(vidDur) ? _fmtClockTenths(vidDur) : '';
        const setStatus = (txt) => { status.textContent = txt || ''; };

        const close = () => {
            clearTimeout(_filmstripTimer);
            Object.values(thumbTimers).forEach(clearTimeout);
            stopSelectionAutoScroll();
            _revokeGifResult(); destroyScrubClone(); panel.remove();
        };
        $('#sc-gif-close').addEventListener('click', close);

        const fxHeader = $('#sc-gif-fx-header');
        const fxToggle = $('#sc-gif-fx-toggle');
        const fxBodyEl = $('#sc-gif-fx-body');
        fxHeader.addEventListener('click', () => {
            const open = fxBodyEl.classList.toggle('sc-gif-fx-open');
            fxToggle.textContent = open ? '▾' : '▸';
            fxHeader.setAttribute('aria-expanded', String(open));
        });

        const sqHeader = $('#sc-gif-sq-header');
        const sqToggle = $('#sc-gif-sq-toggle');
        const sqBodyEl = $('#sc-gif-sq-body');
        sqHeader.addEventListener('click', () => {
            const open = sqBodyEl.classList.toggle('sc-gif-sq-open');
            sqToggle.textContent = open ? '▾' : '▸';
            sqHeader.setAttribute('aria-expanded', String(open));
        });

        const midHeader = $('#sc-gif-mid-header');
        const midToggle = $('#sc-gif-mid-toggle');
        const midBody = $('#sc-gif-mid-body');
        midHeader.addEventListener('click', () => {
            const collapsed = midBody.classList.toggle('sc-gif-mid-collapsed');
            midToggle.textContent = collapsed ? '▸' : '▾';
            midHeader.setAttribute('aria-expanded', String(!collapsed));
        });

        const head = $('#sc-gif-head');
        let dragging = false, dragDX = 0, dragDY = 0;
        const setPanelPos = (prop, val) => panel.style.setProperty(prop, val, 'important');
        head.addEventListener('pointerdown', (e) => {
            if (e.target.closest('#sc-gif-close')) return;
            const rect = panel.getBoundingClientRect();
            setPanelPos('left', rect.left + 'px');
            setPanelPos('top', rect.top + 'px');
            setPanelPos('transform', 'none');
            dragDX = e.clientX - rect.left;
            dragDY = e.clientY - rect.top;
            dragging = true;
            head.classList.add('sc-gif-dragging');
            head.setPointerCapture(e.pointerId);
        });
        head.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const rect = panel.getBoundingClientRect();
            const x = Math.min(Math.max(e.clientX - dragDX, -(rect.width - 40)), window.innerWidth - 40);
            const y = Math.min(Math.max(e.clientY - dragDY, 0), window.innerHeight - 32);
            setPanelPos('left', x + 'px');
            setPanelPos('top', y + 'px');
        });
        const endDrag = (e) => {
            dragging = false;
            head.classList.remove('sc-gif-dragging');
            try { head.releasePointerCapture(e.pointerId); } catch (err) {}
        };
        head.addEventListener('pointerup', endDrag);
        head.addEventListener('pointercancel', endDrag);

        if (isBlob || !src) {
            setStatus(isBlob
                ? 'This source is a streaming (HLS/MSE) blob — frame capture not supported.'
                : 'No video source found.');
        }

        const aspectSel = $('#sc-gif-aspect');
        const applyThumbAspect = () => {
            const mode = aspectSel.value;
            ['start', 'end'].forEach(which => {
                const el = $('#sc-gif-thumb-' + which);
                el.classList.toggle('sc-gif-thumb-43', mode !== 'native');
                el.classList.toggle('sc-gif-thumb-fit', mode === 'fit');
            });
        };
        aspectSel.addEventListener('change', () => { applyThumbAspect(); renderCaptionPreviews(); });
        applyThumbAspect();

        const fx = {
            mode: 'normal', speed: 1, freezeHoldMs: 0,
            deepFry: { enabled: false, intensity: 60 },
            vhs: { enabled: false, intensity: 60 },
            zoomShake: { enabled: false, mode: 'zoom', intensity: 60 },
            shadow: { enabled: false, intensity: 60 },
            wiggle: { enabled: false, intensity: 60 },
        };
        const fxModeSel = $('#sc-gif-fx-mode'), fxSpeedSel = $('#sc-gif-fx-speed'), fxFreezeInput = $('#sc-gif-fx-freeze');
        const fxDeepFryOn = $('#sc-gif-fx-deepfry-on'), fxDeepFryAmt = $('#sc-gif-fx-deepfry-amt');
        const fxVhsOn = $('#sc-gif-fx-vhs-on'), fxVhsAmt = $('#sc-gif-fx-vhs-amt');
        const fxZsOn = $('#sc-gif-fx-zoomshake-on'), fxZsMode = $('#sc-gif-fx-zoomshake-mode'), fxZsAmt = $('#sc-gif-fx-zoomshake-amt');
        const fxShadowOn = $('#sc-gif-fx-shadow-on'), fxShadowAmt = $('#sc-gif-fx-shadow-amt');
        const fxWiggleOn = $('#sc-gif-fx-wiggle-on'), fxWiggleAmt = $('#sc-gif-fx-wiggle-amt');

        function syncFxState() {
            fx.mode = fxModeSel.value;
            fx.speed = parseFloat(fxSpeedSel.value) || 1;
            fx.freezeHoldMs = Math.max(0, parseInt(fxFreezeInput.value, 10) || 0);
            fx.deepFry.enabled = fxDeepFryOn.checked;
            fx.deepFry.intensity = parseInt(fxDeepFryAmt.value, 10) || 0;
            fx.vhs.enabled = fxVhsOn.checked;
            fx.vhs.intensity = parseInt(fxVhsAmt.value, 10) || 0;
            fx.zoomShake.enabled = fxZsOn.checked;
            fx.zoomShake.mode = fxZsMode.value;
            fx.zoomShake.intensity = parseInt(fxZsAmt.value, 10) || 0;
            fx.shadow.enabled = fxShadowOn.checked;
            fx.shadow.intensity = parseInt(fxShadowAmt.value, 10) || 0;
            fx.wiggle.enabled = fxWiggleOn.checked;
            fx.wiggle.intensity = parseInt(fxWiggleAmt.value, 10) || 0;
        }
        [fxModeSel, fxSpeedSel, fxFreezeInput, fxDeepFryOn, fxDeepFryAmt, fxVhsOn, fxVhsAmt, fxZsOn, fxZsMode, fxZsAmt]
            .forEach(el => el.addEventListener('input', syncFxState));
        [fxShadowOn, fxShadowAmt, fxWiggleOn, fxWiggleAmt]
            .forEach(el => el.addEventListener('input', () => { syncFxState(); renderCaptionPreviews(); }));
        syncFxState();

        const capTopInput = $('#sc-gif-cap-top');
        const capBottomInput = $('#sc-gif-cap-bottom');
        const capSizeInputs = { top: $('#sc-gif-cap-top-size'), bottom: $('#sc-gif-cap-bottom-size') };
        const getCapColor = () => (panel.querySelector('input[name="sc-gif-cap-color"]:checked') || {}).value || 'white';
        const getCapSizePct = (key) => Math.max(1, parseFloat(capSizeInputs[key].value) || 16);
        const clampPct = (n) => Math.min(100, Math.max(0, isFinite(n) ? n : 50));
        const capPos = { top: { x: 50, y: 10 }, bottom: { x: 50, y: 90 } };

        function renderCaptionPreview(which) {
            const thumb = $('#sc-gif-thumb-' + which);
            const w = thumb.clientWidth, h = thumb.clientHeight;
            const color = getCapColor();
            ['top', 'bottom'].forEach(key => {
                const el = $('#sc-gif-cap-' + key + '-' + which);
                const text = (key === 'top' ? capTopInput : capBottomInput).value.trim();
                const pos = capPos[key];
                thumb.style.setProperty('--cx-' + key, pos.x + '%');
                thumb.style.setProperty('--cy-' + key, pos.y + '%');
                el.classList.toggle('sc-gif-cap-yellow', color === 'yellow');
                el.classList.toggle('sc-gif-cap-rainbow', color === 'rainbow');
                el.classList.toggle('sc-gif-cap-shadow', fx.shadow.enabled);
                el.classList.toggle('sc-gif-cap-wiggle', fx.wiggle.enabled);
                if (!text || !w || !h) { el.textContent = ''; return; }
                const fontPx = Math.max(4, Math.round(h * getCapSizePct(key) / 100));
                const { lines } = wrapCaptionAtSize(getCaptionMeasureCtx(), text.toUpperCase(), fontPx, w * 0.92);
                el.style.fontSize = fontPx + 'px';
                el.style.lineHeight = Math.round(fontPx * 1.15) + 'px';
                el.textContent = lines.join('\n');
            });
        }
        function renderCaptionPreviews() { renderCaptionPreview('start'); renderCaptionPreview('end'); }
        capTopInput.addEventListener('input', renderCaptionPreviews);
        capBottomInput.addEventListener('input', renderCaptionPreviews);
        capSizeInputs.top.addEventListener('input', renderCaptionPreviews);
        capSizeInputs.bottom.addEventListener('input', renderCaptionPreviews);
        panel.querySelectorAll('input[name="sc-gif-cap-color"]').forEach(r => r.addEventListener('change', renderCaptionPreviews));

        function wireCapHandle(handleEl, thumbEl, key) {
            let dragging = false;
            const move = (e) => {
                if (!dragging) return;
                const rect = thumbEl.getBoundingClientRect();
                capPos[key].x = clampPct(((e.clientX - rect.left) / rect.width) * 100);
                capPos[key].y = clampPct(((e.clientY - rect.top) / rect.height) * 100);
                renderCaptionPreviews();
            };
            handleEl.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                dragging = true;
                handleEl.setPointerCapture(e.pointerId);
            });
            handleEl.addEventListener('pointermove', move);
            const endHandleDrag = (e) => {
                dragging = false;
                try { handleEl.releasePointerCapture(e.pointerId); } catch (err) {}
            };
            handleEl.addEventListener('pointerup', endHandleDrag);
            handleEl.addEventListener('pointercancel', endHandleDrag);
        }
        ['top', 'bottom'].forEach(key => {
            wireCapHandle($('#sc-gif-cap-handle-' + key + '-start'), $('#sc-gif-thumb-start'), key);
        });

        renderCaptionPreviews();

        const thumbTimers = {};
        const refreshThumb = (which) => {
            if (isBlob || !src) return;
            const t = which === 'start' ? startT : endT;
            const el = $('#sc-gif-thumb-' + which);
            clearTimeout(thumbTimers[which]);
            el.classList.add('sc-gif-thumb-loading');
            thumbTimers[which] = setTimeout(() => {
                grabPreviewFrame(src, t, 160).then(url => {
                    el.style.backgroundImage = `url("${url}")`;
                    el.classList.remove('sc-gif-thumb-loading');
                }).catch(() => el.classList.remove('sc-gif-thumb-loading'));
            }, 180);
        };

        const filmstripStrip = $('#sc-gif-filmstrip-strip');
        const filmstripHandleStart = $('#sc-gif-filmstrip-handle-start');
        const filmstripHandleEnd = $('#sc-gif-filmstrip-handle-end');
        let _filmstripTimer = null;
        let _tilesWindowKey = null; // the window the on-screen tiles currently show

        const overviewTrack = $('#sc-gif-overview-track');
        const overviewViewport = $('#sc-gif-overview-viewport');
        const overviewGhost = $('#sc-gif-overview-ghost');
        const overviewCurrent = $('#sc-gif-overview-current');
        const overviewLabel = $('#sc-gif-overview-label');
        const overviewHint = $('#sc-gif-overview-hint');
        let overviewDragging = false;

        for (let i = 0; i < FILMSTRIP_TILES; i++) {
            const tile = document.createElement('div');
            tile.className = 'sc-gif-filmstrip-tile';
            $('#sc-gif-filmstrip-tiles').appendChild(tile);
        }

        // Return value is advisory only — tile refetching is decided by
        // refetchFilmstripTiles() via _tilesWindowKey, not by this return value.
        function ensureFilmstripWindow() {
            const needsReframe = !_filmstripWindow ||
                startT < _filmstripWindow.windowStart + FILMSTRIP_EDGE_PAD ||
                endT   > _filmstripWindow.windowEnd   - FILMSTRIP_EDGE_PAD;
            if (!needsReframe) return false;

            const span = Math.max(FILMSTRIP_MIN_WINDOW, (endT - startT) + FILMSTRIP_MARGIN * 2);
            let windowStart = Math.max(0, startT - FILMSTRIP_MARGIN);
            if (isFinite(vidDur)) windowStart = Math.min(windowStart, Math.max(0, vidDur - span));
            const windowEnd = isFinite(vidDur) ? Math.min(vidDur, windowStart + span) : windowStart + span;

            const changed = !_filmstripWindow ||
                _filmstripWindow.windowStart !== windowStart ||
                _filmstripWindow.windowEnd   !== windowEnd;
            _filmstripWindow = { windowStart, windowEnd };
            return changed;
        }

        function renderFilmstripHandles() {
            const win = _filmstripWindow;
            if (!win) return;
            const pctFor = t => Math.max(0, Math.min(100,
                ((t - win.windowStart) / (win.windowEnd - win.windowStart)) * 100));
            const sp = pctFor(startT), ep = pctFor(endT);
            filmstripHandleStart.style.left = sp + '%';
            filmstripHandleEnd.style.left = ep + '%';
            $('#sc-gif-filmstrip-dim-left').style.width = sp + '%';
            $('#sc-gif-filmstrip-dim-right').style.width = (100 - ep) + '%';
            const selection = $('#sc-gif-filmstrip-selection');
            selection.style.left = sp + '%';
            selection.style.width = (ep - sp) + '%';
            $('#sc-gif-filmstrip-range').textContent =
                _fmtClockTenths(win.windowStart) + ' – ' + _fmtClockTenths(win.windowEnd);

            if (isFinite(vidDur) && vidDur > 0) {
                const ovStart = (win.windowStart / vidDur) * 100;
                const ovEnd = (win.windowEnd / vidDur) * 100;
                overviewViewport.style.left = ovStart + '%';
                overviewViewport.style.width = Math.max(0.5, ovEnd - ovStart) + '%';
            }
            if (!overviewDragging) {
                overviewLabel.textContent = 'Currently editing:';
                overviewCurrent.textContent = _fmtClockTenths(startT);
                overviewHint.textContent = '';
            }
        }

        function refetchFilmstripTiles() {
            const win = _filmstripWindow;
            if (!win || isBlob || !src) return;
            const key = win.windowStart + '|' + win.windowEnd;
            if (key === _tilesWindowKey) return; // tiles already match this window
            _tilesWindowKey = key;
            const tiles = [...panel.querySelectorAll('.sc-gif-filmstrip-tile')];
            const span = win.windowEnd - win.windowStart;
            tiles.forEach((tile, i) => {
                const t = win.windowStart + (i + 0.5) * span / FILMSTRIP_TILES;
                tile.classList.add('sc-gif-thumb-loading');
                grabPreviewFrame(src, t, 64).then(url => {
                    tile.style.backgroundImage = `url("${url}")`;
                    tile.classList.remove('sc-gif-thumb-loading');
                }).catch(() => tile.classList.remove('sc-gif-thumb-loading'));
            });
        }

        function scheduleFilmstripRefresh() {
            renderFilmstripHandles(); // cheap; keep the handles live even mid-debounce
            clearTimeout(_filmstripTimer);
            _filmstripTimer = setTimeout(() => {
                ensureFilmstripWindow();
                renderFilmstripHandles();
                refetchFilmstripTiles();
            }, 220);
        }

        function wireFilmstripDrag(handleEl, which) {
            let dragging = false;
            handleEl.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                dragging = true;
                handleEl.setPointerCapture(e.pointerId);
            });
            handleEl.addEventListener('pointermove', (e) => {
                if (!dragging || !_filmstripWindow) return;
                const win = _filmstripWindow;
                const rect = filmstripStrip.getBoundingClientRect();
                const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                const t = win.windowStart + pct * (win.windowEnd - win.windowStart);
                if (which === 'start') { startT = t; clampStart(); render('start'); }
                else { endT = t; clampEnd(); render('end'); }
            });
            const endDrag = (e) => {
                dragging = false;
                try { handleEl.releasePointerCapture(e.pointerId); } catch (err) {}
            };
            handleEl.addEventListener('pointerup', endDrag);
            handleEl.addEventListener('pointercancel', endDrag);
        }
        wireFilmstripDrag(filmstripHandleStart, 'start');
        wireFilmstripDrag(filmstripHandleEnd, 'end');

        let selectionDragging = false;
        let selectionDragStartX = 0;
        let selectionDragStartT0 = 0; // startT captured at pointerdown
        let selectionAutoScrollTimer = null;
        let selectionAutoScrollDir = 0; // -1 (backward), 0 (idle), 1 (forward)

        function selectionShiftTo(newStart) {
            const dur = endT - startT;
            newStart = Math.max(0, Math.min(newStart, Math.max(0, vidDur - dur)));
            startT = newStart;
            endT = startT + dur;
            render('both');
        }
        function stopSelectionAutoScroll() {
            if (selectionAutoScrollTimer) { clearInterval(selectionAutoScrollTimer); selectionAutoScrollTimer = null; }
            selectionAutoScrollDir = 0;
        }
        function startSelectionAutoScroll(dir) {
            if (selectionAutoScrollDir === dir) return;
            stopSelectionAutoScroll();
            selectionAutoScrollDir = dir;
            selectionAutoScrollTimer = setInterval(() => {
                selectionShiftTo(startT + dir * SELECTION_AUTOSCROLL_STEP);
                // render('both') above only re-arms the 220ms tile-refetch
                // debounce, which this 100ms tick perpetually resets, so the
                // filmstrip window itself would never reframe during a
                // sustained hold. Force the cheap (no-network) reframe/
                // reposition every tick so the visible window actually pans;
                // tile thumbnails stay on the existing debounce and catch up
                // shortly after the hold ends, same as they already do for a
                // fast handle drag.
                ensureFilmstripWindow();
                renderFilmstripHandles();
            }, SELECTION_AUTOSCROLL_INTERVAL_MS);
        }

        const selectionEl = $('#sc-gif-filmstrip-selection');
        selectionEl.addEventListener('pointerdown', (e) => {
            if (isBlob || !src || !isFinite(vidDur)) return;
            if (e.button !== 0) return;
            e.stopPropagation();
            selectionDragging = true;
            selectionDragStartX = e.clientX;
            selectionDragStartT0 = startT;
            selectionEl.setPointerCapture(e.pointerId);
        });
        selectionEl.addEventListener('pointermove', (e) => {
            if (!selectionDragging || !_filmstripWindow) return;
            const rect = filmstripStrip.getBoundingClientRect();
            if (e.clientX <= rect.left + SELECTION_EDGE_ZONE_PX) { startSelectionAutoScroll(-1); return; }
            if (e.clientX >= rect.right - SELECTION_EDGE_ZONE_PX) { startSelectionAutoScroll(1); return; }
            if (selectionAutoScrollDir !== 0) {
                // Leaving the edge zone after auto-scrolling -- resync the drag
                // anchor to the current pointer position/time. Without this,
                // the delta below would be computed against the position the
                // drag originally started at, snapping the clip back to
                // wherever it was before auto-scroll ran and discarding all
                // of that movement.
                selectionDragStartX = e.clientX;
                selectionDragStartT0 = startT;
            }
            stopSelectionAutoScroll();
            const win = _filmstripWindow;
            const deltaPx = e.clientX - selectionDragStartX;
            const deltaSec = deltaPx / rect.width * (win.windowEnd - win.windowStart);
            selectionShiftTo(selectionDragStartT0 + deltaSec);
        });
        function endSelectionDrag(e) {
            selectionDragging = false;
            stopSelectionAutoScroll();
            try { selectionEl.releasePointerCapture(e.pointerId); } catch (err) {}
        }
        selectionEl.addEventListener('pointerup', endSelectionDrag);
        selectionEl.addEventListener('pointercancel', endSelectionDrag);
        selectionEl.addEventListener('lostpointercapture', endSelectionDrag);

        function overviewTimeFromEvent(e) {
            const rect = overviewTrack.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            return pct * vidDur;
        }
        overviewTrack.addEventListener('pointerdown', (e) => {
            if (isBlob || !src || !isFinite(vidDur)) return;
            if (e.button !== 0) return; // ignore right-click/middle-click; pen and touch report button 0 on pointerdown
            e.stopPropagation();
            overviewDragging = true;
            overviewTrack.setPointerCapture(e.pointerId);
            overviewGhost.style.setProperty('display', 'block', 'important');
            overviewGhost.style.left = (overviewTimeFromEvent(e) / vidDur * 100) + '%';
        });
        overviewTrack.addEventListener('pointermove', (e) => {
            if (!overviewDragging) return;
            const t = overviewTimeFromEvent(e);
            overviewGhost.style.left = (t / vidDur * 100) + '%';
            overviewLabel.textContent = 'Jump to:';
            overviewCurrent.textContent = _fmtClockTenths(t);
            overviewHint.textContent = ' (release to commit)';
        });
        function overviewCommit(e) {
            if (!overviewDragging) return;
            overviewDragging = false;
            overviewGhost.style.setProperty('display', 'none', 'important');
            try { overviewTrack.releasePointerCapture(e.pointerId); } catch (err) {}
            const t = overviewTimeFromEvent(e);
            startT = Math.max(0, t - DEFAULT_CLIP_LEN / 2);
            endT = Math.min(vidDur, startT + DEFAULT_CLIP_LEN);
            clampStart();
            clampEnd();
            render('both');
        }
        overviewTrack.addEventListener('pointerup', overviewCommit);
        overviewTrack.addEventListener('pointercancel', (e) => {
            overviewDragging = false;
            overviewGhost.style.setProperty('display', 'none', 'important');
            try { overviewTrack.releasePointerCapture(e.pointerId); } catch (err) {}
            renderFilmstripHandles(); // restore the "Currently editing" label, no jump
        });
        overviewTrack.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault(); // arrows would otherwise scroll the page/chat behind the panel
            e.stopPropagation(); // stop cytube.pc.user.js's document-level arrow-key video-seek handler from also firing, even in the disabled-state branch below
            if (isBlob || !src || !isFinite(vidDur)) return;
            const step = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? OVERVIEW_NUDGE_SEC_FAST : OVERVIEW_NUDGE_SEC);
            const dur = endT - startT;
            // Deliberately bypasses clampStart()/clampEnd() -- those can change
            // dur (MAX_CLIP_LEN/MIN_CLIP_GAP), but a nudge must never alter the
            // clip's length, only its position.
            let newStart = startT + step;
            newStart = Math.max(0, Math.min(newStart, Math.max(0, vidDur - dur)));
            startT = newStart;
            endT = startT + dur;
            render('both');
        });

        const render = (changed) => {
            $('#sc-gif-time-start').textContent = _fmtClockTenths(startT);
            $('#sc-gif-time-end').textContent = _fmtClockTenths(endT);
            const dur = Math.max(0, endT - startT);
            $('#sc-gif-dur-val').textContent = dur.toFixed(1) + 's';
            goBtn.disabled = isBlob || !src || dur < MIN_CLIP_GAP;
            if (changed === 'start' || changed === 'both') refreshThumb('start');
            if (changed === 'end' || changed === 'both') refreshThumb('end');
            scheduleFilmstripRefresh();
        };

        const clampStart = () => {
            startT = Math.max(0, startT);
            if (isFinite(vidDur)) startT = Math.min(startT, vidDur - MIN_CLIP_GAP);
            if (endT - startT < MIN_CLIP_GAP) startT = Math.max(0, endT - MIN_CLIP_GAP);
            if (endT - startT > MAX_CLIP_LEN) startT = endT - MAX_CLIP_LEN;
        };
        const clampEnd = () => {
            endT = Math.max(endT, startT + MIN_CLIP_GAP);
            if (isFinite(vidDur)) endT = Math.min(endT, vidDur);
            if (endT - startT > MAX_CLIP_LEN) endT = startT + MAX_CLIP_LEN;
        };

        panel.querySelector('.sc-gif-marks').addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-act]');
            if (!btn) return;
            const live = getPlayerVideoEl();
            const cur = live ? live.currentTime : 0;
            switch (btn.dataset.act) {
                case 'start-current': startT = cur; clampStart(); render('start'); break;
                case 'start-minus':   startT -= 0.5; clampStart(); render('start'); break;
                case 'start-plus':    startT += 0.5; clampStart(); render('start'); break;
                case 'end-minus':     endT -= 0.5; clampEnd(); render('end'); break;
                case 'end-plus':      endT += 0.5; clampEnd(); render('end'); break;
            }
        });

        goBtn.addEventListener('click', async () => {
            if (isBlob || !src) return;
            const fps    = parseInt($('#sc-gif-fps').value, 10);
            const width  = parseInt($('#sc-gif-width').value, 10);
            const aspect = $('#sc-gif-aspect').value;
            syncFxState();
            const captions = {
                color: getCapColor(),
                top: { text: capTopInput.value.trim(), size: getCapSizePct('top'), x: capPos.top.x, y: capPos.top.y },
                bottom: { text: capBottomInput.value.trim(), size: getCapSizePct('bottom'), x: capPos.bottom.x, y: capPos.bottom.y },
                fx: { shadow: fx.shadow, wiggle: fx.wiggle },
            };
            if (endT - startT < MIN_CLIP_GAP) { setStatus('End must be after start.'); return; }
            const clipStartForName = startT;
            if (!midBody.classList.contains('sc-gif-mid-collapsed')) {
                midBody.classList.add('sc-gif-mid-collapsed');
                midToggle.textContent = '▸';
                midHeader.setAttribute('aria-expanded', 'false');
            }

            _revokeGifResult();
            result.innerHTML = '<div class="sc-gif-working"><span class="sc-gif-spinner"></span><span id="sc-gif-working-txt">Capturing frames…</span></div>';
            const workTxt = $('#sc-gif-working-txt');
            const setWork = (t) => { if (workTxt) workTxt.textContent = t; };
            goBtn.disabled = true;
            try {
                setStatus('');
                const cap = await captureGifFrames(
                    { src, startT, endT, fps, width, aspect, captions },
                    p => setWork('Capturing frames… ' + Math.round(p * 100) + '%'));
                const playback = { mode: fx.mode, speed: fx.speed, freezeHoldMs: fx.freezeHoldMs, fps };
                const filters = { deepFry: fx.deepFry, vhs: fx.vhs, zoomShake: fx.zoomShake };
                setWork('Encoding GIF… (' + cap.frames.length + ' frames)');
                let blob = await encodeGif({ ...cap, playback, filters }, p => setWork('Encoding GIF… ' + Math.round(p * 100) + '%'));
                if (gifOptimizeEnabled()) setWork('Optimizing…');
                blob = await maybeOptimizeGif(blob);
                _gifResultUrl = URL.createObjectURL(blob);
                const kb = Math.round(blob.size / 1024);
                const slug = activeTitleSlug();
                const fnameBaseNoTag = (slug || 'gif') + '-' + _fmtFilenameTimestamp(clipStartForName);
                const sanitizeTag = (raw) => raw.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
                const fnameBaseFor = (tag) => fnameBaseNoTag + (tag ? '-' + tag : '');
                const hasImgbbKey = !!getKey(LS_IMGBB);
                result.innerHTML =
                    `<img src="${_gifResultUrl}" alt="GIF preview">` +
                    `<div id="sc-gif-actions">` +
                    `<a id="sc-gif-dl" href="${_gifResultUrl}" download="${_gifEscHtml(fnameBaseFor('') + '.gif')}">⬇ Download</a>` +
                    (hasImgbbKey ? `<button id="sc-gif-upload" type="button">☁ Upload</button>` : '') +
                    `<input type="text" id="sc-gif-tag" class="sc-gif-tag-input" placeholder="tag" maxlength="40">` +
                    `<span id="sc-gif-size">${kb} KB</span></div>` +
                    (hasImgbbKey ? `<div id="sc-gif-link"></div>` : '');
                setStatus('Done.');
                result.scrollIntoView({ block: 'nearest' });

                const dlLink = $('#sc-gif-dl');
                const tagEl = $('#sc-gif-tag');
                if (tagEl && dlLink) {
                    tagEl.addEventListener('input', () => {
                        dlLink.setAttribute('download', fnameBaseFor(sanitizeTag(tagEl.value)) + '.gif');
                    });
                }

                const uploadBtn = hasImgbbKey ? $('#sc-gif-upload') : null;
                if (uploadBtn) uploadBtn.addEventListener('click', async () => {
                    const linkBox = $('#sc-gif-link');
                    const apiKey = getKey(LS_IMGBB);
                    if (!apiKey) {
                        linkBox.innerHTML = '<span class="sc-gif-link-msg">Add an ImgBB API key above to enable uploads.</span>';
                        return;
                    }
                    uploadBtn.disabled = true;
                    linkBox.innerHTML = '<span class="sc-gif-spinner sc-gif-spinner-sm"></span><span class="sc-gif-link-msg">Uploading to ImgBB…</span>';
                    try {
                        const uploadName = fnameBaseFor(tagEl ? sanitizeTag(tagEl.value) : '');
                        const link = await uploadToImgbb(blob, apiKey, uploadName);
                        linkBox.innerHTML =
                            `<a class="sc-gif-link-url" href="${_gifEscHtml(link)}" target="_blank" rel="noopener">${_gifEscHtml(link)}</a>` +
                            `<button id="sc-gif-copylink" type="button">⧉ Copy link</button>`;
                        uploadBtn.textContent = '✓ Uploaded';
                        try { await navigator.clipboard.writeText(link); } catch (e) {}
                        const cl = $('#sc-gif-copylink');
                        if (cl) cl.addEventListener('click', async () => {
                            try { await navigator.clipboard.writeText(link); cl.textContent = '✓ Copied'; }
                            catch (e) { cl.textContent = '✗'; }
                        });
                    } catch (e) {
                        linkBox.innerHTML = '<span class="sc-gif-link-msg sc-test-bad">Upload failed: ' + _gifEscHtml(e.message || String(e)) + '</span>';
                        uploadBtn.disabled = false;
                    }
                });
            } catch (e) {
                console.error('[GIFMaker] GIF capture failed:', e);
                result.innerHTML = '';
                setStatus('Failed: ' + (e.message || e));
            } finally {
                goBtn.disabled = false;
            }
        });

        ensureFilmstripWindow();
        render('both');
    }

    /* ==========================================================
       RECORD BUTTON
       Always a floating #sc-gif-btn, matching core's own floating
       button styling/positioning exactly, so it participates in
       core's existing auto-dim-on-inactivity system with no changes
       needed there. The original standalone script's alternate
       control-bar-docked `#scgm-record-btn` path (used when
       cytube.pc.user.js wasn't detected) is gone -- this module now
       always ships alongside core, so that path never ran anyway.
    ========================================================== */
    function injectGifFloatingButtonCss() {
        if (document.getElementById('scgm-floatbtn-style')) return;
        const style = document.createElement('style');
        style.id = 'scgm-floatbtn-style';
        style.textContent = `
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
                right: calc(var(--sc-chat-w) + 1vw + 116px) !important;
            }
            body.sc-vertical #sc-gif-btn {
                bottom: calc(var(--sc-chat-h) + 1vh) !important;
                right: 116px !important;
            }
            #sc-gif-btn:disabled {
                opacity: 0.35 !important; cursor: default !important; pointer-events: none !important;
            }
            #sc-gif-btn.sc-bar-dim:disabled {
                opacity: 0 !important;
            }
        `;
        document.head.appendChild(style);
    }

    function ensureRecordButton() {
        if (document.getElementById('sc-gif-btn')) return;
        injectGifFloatingButtonCss();
        const btn = document.createElement('button');
        btn.id = 'sc-gif-btn';
        btn.textContent = '◉';
        btn.title = 'Make a GIF of this scene';
        btn.addEventListener('click', () => openGifPanel());
        document.body.appendChild(btn);
    }

    function updateRecordButtonState() {
        const btn = document.getElementById('sc-gif-btn');
        if (!btn) return;
        btn.disabled = isYouTubeMedia();
    }

    /* ==========================================================
       BOOT
       Named gifmakerBoot (not waitForBody) — core's own 16-boot.js
       declares a generic waitForBody in the same shared scope; this
       module's boot routine has always been distinct code, so it gets
       its own name here to avoid the collision now that both files
       share one IIFE. Called directly here (not via scRegisterInit) to
       preserve the original script's document-start timing --
       scRegisterInit's queue only runs on the page's 'load' event, and
       the record-button MutationObserver below needs to be attached
       well before that to catch early DOM mutations. Collapsed
       substantially now that the bridge-detection poll loop is gone --
       just fills in the bridge's openGifPanel slot (see the header
       comment at the top of this file), ensures the button, and starts
       the same MutationObserver/interval pair every other converted
       module uses to watch for CyTube re-rendering its video controls.
    ========================================================== */
    function gifmakerBoot() {
        if (!document.body) { requestAnimationFrame(gifmakerBoot); return; }

        _uw.__SC_GIF_BRIDGE__.openGifPanel = openGifPanel;

        ensureRecordButton();
        updateRecordButtonState();

        new MutationObserver(() => {
            ensureRecordButton();
            updateRecordButtonState();
        }).observe(document.body, { childList: true, subtree: true });

        setInterval(updateRecordButtonState, 800);
    }

    gifmakerBoot();

    // order: 6 places this after the checkbox toggle rows (spellcheck=1,
    // movielinks=2, autoembed=3, gifoptimize=4, lineuptiming=5) — the same
    // position the hardcoded ImgBB block used to render in, immediately
    // after sortedSettingsRows() and before the (still-hardcoded) chat font
    // size / movie lead time rows. Status-message copy
    // (testEmptyMessage/testValidMessage/testInvalidMessage/
    // testErrorMessage) and the link/linkText (rendered via the `link`/
    // `linkText` row fields textRowHtml() now supports) are both carried
    // over byte-for-byte from the old hardcoded
    // core/15-settings-modal-shell.js ImgBB field.
    scRegisterSetting({
        id: 'sc-input-imgbb', group: 'gif-maker', type: 'text',
        label: 'ImgBB GIF upload',
        note: 'Optional — lets the ☁ Upload button in the GIF maker host a GIF and give you a shareable link',
        key: LS_IMGBB,
        placeholder: 'Paste ImgBB API key…',
        testHandler: validateImgbbKey,
        testEmptyMessage: 'Enter an API key first',
        testValidMessage: '✓ Valid API key',
        testInvalidMessage: '✗ Invalid API key',
        testErrorMessage: '⚠ Couldn\'t reach ImgBB',
        link: 'https://api.imgbb.com/',
        linkText: 'Get a free ImgBB API key ↗ (sign up, then "Add API key" — no app registration)',
        order: 6,
    });

    // Row relocated here from core per Task 8 of the companion-scripts-to-
    // modules plan (was previously hardcoded in core since this module
    // didn't exist yet). order: 4 reproduces the original shipped script's
    // settings-row sequence (spellcheck=1, movielinks=2, autoembed=3,
    // gifoptimize=4, lineuptiming=5).
    scRegisterSetting({ id: 'sc-input-gifoptimize', group: 'gif-maker', label: 'Optimize GIFs before upload', note: 'Losslessly shrinks the file with gifsicle before Download/Upload — adds a couple seconds', key: LS_GIF_OPTIMIZE, defaultOn: true, order: 4 });
    /* ==========================================================
       IMDb GraphQL — parent guide + trivia (free, no API key)
       Owns all traffic to caching.graphql.imdb.com (hence this
       module's `connects` grant), including fetchImdbParentalGuide,
       which movie-title-links calls through a typeof-guard to
       populate the Now Playing card's/stats bar's parental-guide
       chips — see movie-title-links/index.js's lookupMovie(). No
       user-facing on/off toggle exists for this feature in the
       original script; it simply runs whenever an IMDb ID is
       available, so this module registers no scRegisterSetting row
       (it's still excludable from a custom build via the customizer's
       module checkboxes — a separate mechanism from an in-script
       settings toggle).
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

    // 'T' = trivia, from anywhere when not typing. Split out from the original
    // combined T/I/Escape/arrows keydown handler so this module's hotkey only
    // depends on functions this module itself defines — see
    // movie-title-links/index.js for the 'I' half of that original handler,
    // and src/pc/core/12-playback-sync-and-seek.js for the Escape (lineup) /
    // arrows / space half.
    document.addEventListener('keydown', (e) => {
        const t = e.target;
        if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
        if (e.key === 't' || e.key === 'T') { toggleTriviaPanel(); return; }
        if (e.key === 'Escape') { hideTriviaCard(); return; }
    });
injectCSS('imdb-trivia', `            /* ===== TRIVIA BUTTON ===== */
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
`);
    /* ==========================================================
       TONIGHT'S LINEUP — Reddit schedule fetch/parse, timing/ETA model,
       per-section theme, data interface, full-screen overlay UI, and the
       Coming Attractions toggle button that opens it (at the bottom of
       this file). Five internally-sequential sub-sections kept together
       as one module since none of them is independently useful on its
       own.

       Depends on movie-title-links for lookupMovie()/showNowPlayingCard()
       (poster art, ratings, runtime, parental-guide chips) -- Tonight's
       Lineup's whole point is showing what's playing, so a build without
       movie-title-links wouldn't be a usable feature anyway (see this
       module's `dependsOn` in manifest.json). movie-title-links itself
       calls back into this module's lineupObserveTitleChange() through a
       typeof-guard (see movie-title-links/index.js), since from its side
       this module is optional even though the reverse isn't true.
    ========================================================== */

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
       COMING ATTRACTIONS — toggle button that opens the Tonight's Lineup
       screen above. (Top-bar/gap-button dim/wake infrastructure --
       initTopBar, initGapButtonDim, _topBarWake, _topBarIsOpen, _gapShow
       -- stays in src/pc/core/14-chat-panel-chrome.js: it's generic
       chrome-dimming shared by every floating button, not lineup-specific,
       and 08-desync.js reads _gapShow directly.)
    ========================================================== */

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

    // initPosterStrip() needs #motdrow to already have its images (CyTube injects
    // them asynchronously after the channel loads) -- wrapped in a named function and
    // registered via scRegisterInit (same pattern Task 2 used for
    // scApplyInitialChatFontSize: a named function so fn.name prints usefully from the
    // registry's try/catch). Moved here (out of core's bare 'load' handler in
    // src/pc/core/16-boot.js) so a build without this module simply doesn't
    // register or call initPosterStrip
    // at all, instead of leaving a dangling bare call in core that would throw and --
    // because it used to run before the CSS-injection block in that same handler --
    // take the whole layout CSS injection down with it.
    function scInitPosterStripWhenReady() {
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
    }

    scRegisterInit(scInitPosterStripWhenReady);

    // order: 5 -- next in the established row sequence (spellcheck=1, movielinks=2,
    // autoembed=3, gifoptimize=4; see src/pc/core/15-settings-modal-shell.js, which
    // sorts SC_SETTINGS_ROWS by this field before rendering). defaultOn: false
    // because this toggle is opt-in (LS_LINEUP_TIMING defaults off -- see
    // lineupTimingEnabled() in core/02-keys-and-helpers.js), unlike the other rows'
    // opt-out default.
    scRegisterSetting({ id: 'sc-input-lineuptiming', group: 'tonights-lineup', label: 'Coming Attractions live timing (Experimental)', note: 'Shows NOW PLAYING and estimated start times in Tonight\'s Lineup. Needs TMDB above for movie runtimes — without it, estimates can\'t guess well. Off by default, still being tuned.', key: LS_LINEUP_TIMING, defaultOn: false, order: 5 });
injectCSS('tonights-lineup', `            /* ===== TONIGHT'S LINEUP SCREEN ===== */
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
`);

})();
