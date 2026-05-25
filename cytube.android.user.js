// ==UserScript==
// @name         CyTube Mobile — 420Grindhouse
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Mobile-optimised layout for 420Grindhouse: chat slides with keyboard, touch-friendly controls, movie info
// @match        https://cytu.be/r/*
// @match        https://cytu.be/r/testing
// @grant        GM_xmlhttpRequest
// @connect      doesthedogdie.com
// @connect      api.themoviedb.org
// @connect      en.wikipedia.org
// @connect      raw.githubusercontent.com
// @connect      api.languagetool.org
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ── Only run on touch devices ─────────────────────────────────────────────
    if (!('ontouchstart' in window) && !navigator.maxTouchPoints) return;

    /* ==========================================================
       CONSTANTS + SHARED STATE
    ========================================================== */
    const LS_TMDB       = 'sc_tmdb_key';
    const LS_DTDD       = 'sc_dtdd_key';
    const LS_SPELLCHECK = 'sc_spellcheck';
    const getKey        = id => localStorage.getItem(id) || '';
    const setKey        = (id, v) => localStorage.setItem(id, v.trim());
    const hasKey        = id => !!getKey(id);
    const spellCheckEnabled = () => getKey(LS_SPELLCHECK) !== 'off';

    // Video height as % of viewport — user can adjust
    const VIDEO_VH = 42;
    const CHAT_HEADER_H = 36; // px — taller than desktop for touch

    let lastMovieTitle = '';
    let movieLinkCache = {};
    let killCountDb    = null;

    /* ==========================================================
       SHARED LOGIC — identical to desktop script
    ========================================================== */

    function parseMovieFilename(raw) {
        let s = raw.replace(/\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|divx|xvid|ogv)$/i, '');
        let year = null;
        const yearMatch = s.match(/[\[(](\d{4})[\])]/);
        if (yearMatch) { year = yearMatch[1]; s = s.slice(0, yearMatch.index); }
        s = s.replace(/[._]+/g, ' ').replace(/[\[(][^\])]*/g, '').replace(/[\])]/, '');
        return { title: s.replace(/\s+/g, ' ').trim(), year };
    }

    function hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = (hash << 5) - hash + str.charCodeAt(i);
            hash |= 0;
        }
        return Math.abs(hash);
    }

    function usernameToColor(name) {
        const h = hashString(name) % 360;
        const s = 55 + (hashString(name + 'sat') % 30);
        const l = 55 + (hashString(name + 'lit') % 20);
        return `hsl(${h},${s}%,${l}%)`;
    }

    function gmFetch(url, headers = {}) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url,
                headers: { 'Accept': 'application/json', ...headers },
                onload: r => {
                    if (r.status >= 200 && r.status < 300) {
                        try { resolve(JSON.parse(r.responseText)); }
                        catch (e) { reject(e); }
                    } else { reject(new Error(`HTTP ${r.status}`)); }
                },
                onerror: reject,
            });
        });
    }

    async function getKillCountDb() {
        if (killCountDb !== null) return killCountDb;
        killCountDb = {};
        try {
            const text = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: 'https://raw.githubusercontent.com/lklynet/Kill-Count/main/killcounts.jsonl',
                    onload: r => r.status === 200 ? resolve(r.responseText) : reject(new Error(`HTTP ${r.status}`)),
                    onerror: reject,
                });
            });
            for (const line of text.split('\n')) {
                const s = line.trim(); if (!s) continue;
                try { const e = JSON.parse(s); if (e.tmdb_id != null) killCountDb[String(e.tmdb_id)] = e.count; } catch(e) {}
            }
        } catch (e) {}
        return killCountDb;
    }

    const DTDD_FILTERS = [
        ['dog dies','🐕','Dog dies'],['cat dies','🐱','Cat dies'],['animal','🐾','Animal cruelty'],
        ['jump scare','😱','Jump scares'],['sex scene','🔞','Sex scene'],['nudity','🔞','Nudity'],
        ['rape','⚠️','Sexual violence'],['suicide','💀','Suicide'],['needle','💉','Needles'],
        ['spider','🕷','Spiders'],['decapitat','🩸','Decapitation'],['explod','💥','Explosions'],
        ['torture','⚠️','Torture'],['child','⚠️','Child in peril'],['clown','🤡','Clowns'],
    ];

    const LINK_DEFS = [
        { key:'imdb',       label:'IMDb',       color:'#f5c518', fg:'#000', char:'i' },
        { key:'letterboxd', label:'Letterboxd', color:'#2c4a2e', fg:'#00e054', char:'L' },
        { key:'wiki',       label:'Wikipedia',  color:'#444',    fg:'#eee', char:'W' },
    ];

    async function lookupMovie(title, year) {
        const cacheKey = title + (year || '');
        if (movieLinkCache[cacheKey] !== undefined) return movieLinkCache[cacheKey];

        let tmdbResult = null, wikiUrl = null;

        const tmdbPromise = hasKey(LS_TMDB) ? (async () => {
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
                tmdbResult = { tmdbId: best.id, imdbId: d.imdb_id || d.external_ids?.imdb_id || null, title: d.title, year: d.release_date?.slice(0,4) || year };
            } catch(e) {}
        })() : Promise.resolve();

        const wikiPromise = (async () => {
            try {
                const res = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(title+(year?' '+year:'')+ ' film')}&srlimit=1&format=json&origin=*`);
                if (!res.ok) return;
                const data = await res.json();
                const hit = data?.query?.search?.[0];
                if (hit) wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g,'_'))}`;
            } catch(e) {}
        })();

        await Promise.all([tmdbPromise, wikiPromise]);

        let killCount = null;
        if (tmdbResult?.tmdbId) {
            const db = await getKillCountDb();
            const c = db[String(tmdbResult.tmdbId)];
            if (c != null) killCount = c;
        }

        const result = {
            links: {
                imdb:       tmdbResult?.imdbId  ? `https://www.imdb.com/title/${tmdbResult.imdbId}/` : null,
                letterboxd: tmdbResult?.tmdbId  ? `https://letterboxd.com/tmdb/${tmdbResult.tmdbId}` : null,
                wiki:       wikiUrl,
            },
            killCount,
            cleanTitle: tmdbResult?.title || null,
            cleanYear:  tmdbResult?.year  || null,
        };

        movieLinkCache[cacheKey] = result;
        return result;
    }

    /* ==========================================================
       CSS INJECTION
    ========================================================== */

    function injectCSS() {
        const style = document.createElement('style');
        style.textContent = `
            /* ── Reset CyTube chrome ─────────────────────────────── */
            nav.navbar, #motdrow, #drinkbarwrap, #announcements,
            #playlistrow, #resizewrap, footer, #userlisttoggle,
            #rightcontrols, #leftcontrols, .modal-header,
            .modal-footer, #usercount, #pollwrap,
            #resize-video-smaller, #resize-video-larger { display: none !important; }

            #userlist {
                visibility: hidden !important;
                position: absolute !important;
                pointer-events: none !important;
                height: auto !important;
            }

            body { background: #000 !important; overflow: hidden !important; padding: 0 !important; margin: 0 !important; }
            .container, .container-fluid, .row, #main-row { padding: 0 !important; margin: 0 !important; width: 100% !important; max-width: 100% !important; }

            /* ── Video area ──────────────────────────────────────── */
            #videowrap {
                position: fixed !important; top: 0 !important; left: 0 !important;
                width: 100vw !important; width: 100dvw !important;
                height: ${VIDEO_VH}vh !important; height: ${VIDEO_VH}dvh !important;
                background: #000 !important; z-index: 100 !important;
                border: none !important;
            }
            #videowrap .embed-responsive, #ytapiplayer {
                width: 100% !important; height: 100% !important;
            }

            /* ── Movie title bar ─────────────────────────────────── */
            #videowrap-header {
                position: fixed !important; top: 0 !important; left: 0 !important;
                width: 100vw !important; z-index: 200 !important;
                background: transparent !important;
                color: #fff !important; font-size: 13px !important; font-weight: 500 !important;
                padding: 4px 10px !important;
                text-shadow: 0 1px 4px rgba(0,0,0,1), 0 0 10px rgba(0,0,0,0.9) !important;
                white-space: nowrap !important; overflow: hidden !important;
                text-overflow: ellipsis !important; pointer-events: none !important;
                transition: opacity 1.5s ease !important;
            }
            #videowrap-header.sc-bar-dim { opacity: 0 !important; }
            #videowrap-header b, #videowrap-header .pull-left > span:first-child,
            #videowrap-header .label { display: none !important; }

            /* ── Top gradient ────────────────────────────────────── */
            #sc-top-bar {
                position: fixed !important; top: 0 !important; left: 0 !important;
                width: 100vw !important; height: 48px !important;
                z-index: 150 !important; pointer-events: none !important;
                background: linear-gradient(to bottom, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0) 100%) !important;
                transition: opacity 1.5s ease !important;
            }
            #sc-top-bar.sc-bar-dim { opacity: 0 !important; }

            /* ── Movie link badges ───────────────────────────────── */
            #sc-movie-links {
                display: inline-flex !important; gap: 4px !important;
                margin-left: 6px !important; vertical-align: middle !important;
                transition: opacity 1.5s ease !important;
            }
            #sc-movie-links.sc-bar-dim { opacity: 0 !important; }
            .sc-movie-link {
                display: inline-flex !important;
                align-items: center !important; justify-content: center !important;
                width: 20px !important; height: 20px !important;
                border-radius: 3px !important; font-size: 11px !important;
                font-weight: 900 !important; text-decoration: none !important;
                font-family: Georgia, serif !important; cursor: pointer !important;
                transition: background 2s ease, color 2s ease !important;
            }
            #sc-movie-links.sc-bar-dim .sc-movie-link {
                background: transparent !important;
                color: rgba(255,255,255,0.2) !important;
            }

            /* ── Chat header bar ─────────────────────────────────── */
            #sc-chat-header {
                position: fixed !important;
                top: ${VIDEO_VH}vh !important; top: ${VIDEO_VH}dvh !important;
                left: 5px !important; right: 5px !important;
                height: ${CHAT_HEADER_H}px !important;
                z-index: 300 !important;
                background: rgba(0,0,0,0.7) !important;
                border: 1px solid #aaaaaa !important;
                border-bottom-color: #444 !important;
                display: flex !important;
                align-items: center !important;
                justify-content: space-between !important;
                padding: 0 12px !important;
                box-sizing: border-box !important;
            }
            #sc-usercount-btn, #sc-poll-btn {
                background: transparent !important; border: none !important;
                font-size: 11px !important; font-weight: 700 !important;
                letter-spacing: 0.06em !important; text-transform: uppercase !important;
                color: rgba(255,255,255,0.6) !important;
                cursor: pointer !important; padding: 0 !important;
                font-family: inherit !important;
                transition: color 0.2s !important;
                -webkit-tap-highlight-color: transparent !important;
            }
            #sc-usercount-btn:active, #sc-poll-btn:active { color: white !important; }
            #sc-poll-btn.sc-poll-btn-active { color: white !important; }
            #sc-usercount-btn.sc-users-active { color: white !important; }

            /* ── Chat wrap ───────────────────────────────────────── */
            #chatwrap {
                position: fixed !important;
                top: calc(${VIDEO_VH}vh + ${CHAT_HEADER_H}px) !important;
                top: calc(${VIDEO_VH}dvh + ${CHAT_HEADER_H}px) !important;
                left: 0 !important; right: 0 !important;
                bottom: 0 !important; width: 100vw !important;
                z-index: 200 !important;
                background: rgba(0,0,0,0.85) !important;
                display: flex !important; flex-direction: column !important;
                overflow: hidden !important;
                border-left: 1px solid #aaaaaa !important;
                border-right: 1px solid #aaaaaa !important;
                transition: bottom 0.3s ease !important;
            }

            /* Keyboard open: chatwrap shrinks to avoid keyboard */
            #chatwrap.sc-keyboard-open {
                bottom: var(--sc-keyboard-height, 0px) !important;
            }

            #messagebuffer {
                flex: 1 !important; overflow-y: auto !important;
                padding: 6px 8px !important;
                font-size: 15px !important;
                -webkit-overflow-scrolling: touch !important;
            }

            /* ── Chat input area ─────────────────────────────────── */
            #sc-chat-input-row {
                display: flex !important;
                align-items: flex-end !important;
                padding: 6px 8px !important;
                gap: 6px !important;
                border-top: 1px solid rgba(255,255,255,0.08) !important;
                background: rgba(0,0,0,0.4) !important;
                flex-shrink: 0 !important;
            }
            #sc-chat-textarea {
                flex: 1 !important;
                background: rgba(255,255,255,0.08) !important;
                border: 1px solid rgba(255,255,255,0.15) !important;
                border-radius: 18px !important;
                color: white !important;
                font-size: 16px !important; /* prevents iOS auto-zoom */
                padding: 8px 14px !important;
                resize: none !important;
                min-height: 36px !important;
                max-height: 100px !important;
                line-height: 1.4 !important;
                outline: none !important;
                font-family: inherit !important;
                -webkit-appearance: none !important;
            }
            #sc-send-btn {
                background: rgba(255,255,255,0.12) !important;
                border: none !important; border-radius: 50% !important;
                width: 36px !important; height: 36px !important;
                color: rgba(255,255,255,0.7) !important;
                font-size: 16px !important; cursor: pointer !important;
                flex-shrink: 0 !important;
                display: flex !important; align-items: center !important; justify-content: center !important;
                transition: background 0.2s, color 0.2s !important;
                -webkit-tap-highlight-color: transparent !important;
            }
            #sc-send-btn:active { background: rgba(255,255,255,0.25) !important; color: white !important; }

            /* ── Bottom sheet menu ───────────────────────────────── */
            #sc-menu-btn {
                position: fixed !important;
                bottom: calc(var(--sc-keyboard-height, 0px) + 8px) !important;
                right: 8px !important;
                z-index: 400 !important;
                width: 40px !important; height: 40px !important;
                background: rgba(255,255,255,0.1) !important;
                border: none !important; border-radius: 50% !important;
                color: rgba(255,255,255,0.6) !important;
                font-size: 18px !important; cursor: pointer !important;
                display: flex !important; align-items: center !important; justify-content: center !important;
                transition: background 0.3s, color 0.3s !important;
                -webkit-tap-highlight-color: transparent !important;
            }
            #sc-menu-btn:active { background: rgba(255,255,255,0.22) !important; color: white !important; }

            /* ── Bottom sheet overlay ────────────────────────────── */
            #sc-bottom-sheet-overlay {
                position: fixed !important; inset: 0 !important;
                background: rgba(0,0,0,0.5) !important;
                z-index: 500 !important; display: none;
            }
            #sc-bottom-sheet {
                position: fixed !important;
                bottom: 0 !important; left: 0 !important; right: 0 !important;
                z-index: 501 !important;
                background: rgba(15,15,25,0.97) !important;
                border-top: 1px solid rgba(255,255,255,0.12) !important;
                border-radius: 16px 16px 0 0 !important;
                padding: 16px 0 32px !important;
                display: none;
                transform: translateY(100%) !important;
                transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1) !important;
            }
            #sc-bottom-sheet.sc-sheet-open {
                transform: translateY(0) !important;
            }
            .sc-sheet-row {
                display: flex !important;
                align-items: center !important;
                padding: 14px 20px !important;
                gap: 14px !important;
                color: rgba(255,255,255,0.82) !important;
                font-size: 15px !important;
                cursor: pointer !important;
                -webkit-tap-highlight-color: transparent !important;
            }
            .sc-sheet-row:active { background: rgba(255,255,255,0.06) !important; }
            .sc-sheet-row-icon {
                width: 36px !important; height: 36px !important;
                background: rgba(255,255,255,0.1) !important;
                border-radius: 50% !important;
                display: flex !important; align-items: center !important; justify-content: center !important;
                font-size: 18px !important; flex-shrink: 0 !important;
            }
            .sc-sheet-row-label { font-size: 15px !important; }
            .sc-sheet-divider {
                height: 1px !important;
                background: rgba(255,255,255,0.08) !important;
                margin: 4px 0 !important;
            }
            .sc-sheet-handle {
                width: 36px !important; height: 4px !important;
                background: rgba(255,255,255,0.2) !important;
                border-radius: 2px !important;
                margin: 0 auto 12px !important;
            }

            /* ── Users panel ─────────────────────────────────────── */
            #sc-users-panel, #sc-poll-panel {
                position: fixed !important;
                top: calc(${VIDEO_VH}vh + ${CHAT_HEADER_H}px) !important;
                top: calc(${VIDEO_VH}dvh + ${CHAT_HEADER_H}px) !important;
                left: 5px !important; right: 5px !important;
                z-index: 350 !important;
                background: rgba(10,10,20,0.97) !important;
                border: 1px solid rgba(255,255,255,0.12) !important;
                border-top: none !important;
                max-height: 55vh !important;
                overflow-y: auto !important;
                padding: 10px 14px !important;
                display: none;
                -webkit-overflow-scrolling: touch !important;
            }
            .sc-users-panel-header {
                font-size: 10px !important; font-weight: 700 !important;
                letter-spacing: 0.06em !important; text-transform: uppercase !important;
                color: rgba(255,255,255,0.4) !important;
                margin-bottom: 8px !important; padding-bottom: 6px !important;
                border-bottom: 1px solid rgba(255,255,255,0.08) !important;
            }
            .sc-users-panel-name {
                padding: 3px 0 !important; font-size: 14px !important;
            }
            .sc-poll-header {
                font-weight: 600 !important; font-size: 15px !important;
                color: #f0c040 !important; margin-bottom: 10px !important;
                padding-bottom: 8px !important;
                border-bottom: 1px solid rgba(255,255,255,0.1) !important;
            }
            .sc-poll-option {
                margin-bottom: 8px !important; font-size: 14px !important;
                color: rgba(255,255,255,0.82) !important; line-height: 1.5 !important;
            }
            .sc-poll-option a { color: #7eb8f7 !important; word-break: break-all !important; }
            .sc-poll-meta {
                margin-top: 10px !important; font-size: 11px !important;
                color: rgba(255,255,255,0.35) !important;
            }

            /* ── VJS overrides ───────────────────────────────────── */
            .video-js .vjs-control-bar {
                position: fixed !important;
                bottom: calc(${100 - VIDEO_VH}vh + 4px) !important;
                bottom: calc(${100 - VIDEO_VH}dvh + 4px) !important;
                left: 4px !important; right: 4px !important; width: auto !important;
                background: rgba(255,255,255,0.08) !important;
                border-radius: 999px !important; height: 36px !important;
                padding: 0 8px !important; display: flex !important;
                align-items: center !important;
                backdrop-filter: blur(4px) !important;
                z-index: 250 !important;
            }
            .video-js .vjs-play-control { display: none !important; }
            .video-js .vjs-fullscreen-control { display: none !important; }
            .video-js .vjs-control { color: rgba(255,255,255,0.6) !important; border-radius: 999px !important; }
            .video-js .vjs-progress-holder {
                background: rgba(255,255,255,0.15) !important;
                border-radius: 999px !important; height: 5px !important;
            }
            .video-js .vjs-play-progress {
                background: rgba(255,255,255,0.75) !important; border-radius: 999px !important;
            }
            .video-js .vjs-play-progress::before { color: white !important; font-size: 10px !important; }
            .video-js .vjs-time-control {
                color: rgba(255,255,255,0.55) !important;
                font-size: 11px !important; line-height: 36px !important;
                padding: 0 4px !important; min-width: 0 !important;
            }
            .video-js .vjs-big-play-button {
                top: 50% !important; left: 50% !important;
                transform: translate(-50%, -50%) !important; margin: 0 !important;
                background: rgba(255,255,255,0.08) !important;
                border: 1px solid rgba(255,255,255,0.2) !important;
                border-radius: 999px !important;
                width: 60px !important; height: 60px !important; line-height: 60px !important;
                backdrop-filter: blur(4px) !important;
            }
            .video-js .vjs-volume-bar { background: rgba(255,255,255,0.15) !important; border-radius: 999px !important; }
            .video-js .vjs-volume-level { background: rgba(255,255,255,0.75) !important; border-radius: 999px !important; }
            .video-js .vjs-volume-level::before { color: white !important; font-size: 10px !important; }

            /* ── Stats overlay ───────────────────────────────────── */
            #sc-movie-stats {
                position: fixed !important;
                bottom: calc(${100 - VIDEO_VH}vh + 48px) !important;
                bottom: calc(${100 - VIDEO_VH}dvh + 48px) !important;
                left: 10px !important; z-index: 260 !important;
                background: rgba(0,0,0,0.75) !important;
                color: rgba(255,255,255,0.9) !important;
                font-size: 13px !important; padding: 6px 12px !important;
                border-radius: 6px !important; pointer-events: none !important;
                max-width: 90vw !important;
            }

            /* ── Settings modal ──────────────────────────────────── */
            #sc-settings-overlay {
                position: fixed !important; inset: 0 !important;
                background: rgba(0,0,0,0.7) !important;
                z-index: 600 !important; display: flex !important;
                align-items: flex-end !important;
            }
            #sc-settings-modal {
                background: #1a1a2e !important;
                border-radius: 16px 16px 0 0 !important;
                padding: 20px !important;
                width: 100% !important; box-sizing: border-box !important;
                max-height: 85vh !important; overflow-y: auto !important;
                color: rgba(255,255,255,0.88) !important;
                font-family: system-ui, sans-serif !important;
            }
            .sc-settings-group { margin-bottom: 18px !important; }
            .sc-settings-group label {
                display: block !important; font-size: 11px !important;
                font-weight: 600 !important; text-transform: uppercase !important;
                letter-spacing: 0.06em !important; color: rgba(255,255,255,0.45) !important;
                margin-bottom: 6px !important;
            }
            .sc-settings-group input[type="text"], .sc-settings-group input[type="password"] {
                width: 100% !important; box-sizing: border-box !important;
                background: rgba(255,255,255,0.08) !important;
                border: 1px solid rgba(255,255,255,0.15) !important;
                border-radius: 8px !important; color: white !important;
                font-size: 16px !important; padding: 10px 12px !important;
                outline: none !important;
            }
            #sc-settings-save {
                width: 100% !important; padding: 14px !important;
                background: rgba(192,176,255,0.2) !important; color: #c0b0ff !important;
                border: 1px solid rgba(192,176,255,0.4) !important;
                border-radius: 10px !important; font-size: 15px !important;
                font-weight: 600 !important; cursor: pointer !important;
                margin-top: 8px !important;
            }
            #sc-settings-cancel {
                width: 100% !important; padding: 12px !important;
                background: transparent !important;
                color: rgba(255,255,255,0.5) !important;
                border: none !important; font-size: 14px !important;
                cursor: pointer !important; margin-top: 4px !important;
            }
        `;
        document.head.appendChild(style);
    }

    /* ==========================================================
       CHAT TEXTAREA
    ========================================================== */

    function installChatTextarea() {
        if (document.getElementById('sc-chat-textarea')) return;
        const originalInput = document.getElementById('chatline');
        if (!originalInput) return;

        // Hide original
        originalInput.style.cssText = `
            position: absolute !important; width: 1px !important; height: 1px !important;
            opacity: 0 !important; pointer-events: none !important; top: -9999px !important;`;

        // Build input row
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
        sendBtn.title = 'Send';

        row.appendChild(textarea);
        row.appendChild(sendBtn);

        const chatwrap = document.getElementById('chatwrap');
        if (chatwrap) chatwrap.appendChild(row);

        // Auto-resize textarea
        textarea.addEventListener('input', () => {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 100) + 'px';
        });

        // Send functions
        let lastChatlineValue = '';
        const doSend = (text) => {
            if (!text.trim()) return;
            try {
                socket.emit('chatMsg', { msg: text, meta: {} });
            } catch(e) {
                originalInput.value = text;
                const ev = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true });
                originalInput.dispatchEvent(ev);
            }
            textarea.value = '';
            textarea.style.height = '';
            lastChatlineValue = '';
            originalInput.value = '';
            textarea.focus();
        };

        sendBtn.addEventListener('click', () => doSend(textarea.value.trim()));
        textarea.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(textarea.value.trim()); }
        });

        // Mirror to original for CyTube emote injections
        setInterval(() => {
            const current = originalInput.value;
            if (current !== lastChatlineValue && current !== textarea.value) {
                textarea.value = current;
                lastChatlineValue = current;
            }
        }, 80);
    }

    /* ==========================================================
       KEYBOARD HANDLING — visualViewport API
    ========================================================== */

    function initKeyboardHandler() {
        const chatwrap = document.getElementById('chatwrap');
        if (!chatwrap || !window.visualViewport) return;

        const updateForKeyboard = () => {
            const keyboardHeight = window.innerHeight - window.visualViewport.height;
            if (keyboardHeight > 100) {
                document.documentElement.style.setProperty('--sc-keyboard-height', keyboardHeight + 'px');
                chatwrap.classList.add('sc-keyboard-open');
                // Scroll messagebuffer to bottom so latest messages are visible
                const buf = document.getElementById('messagebuffer');
                if (buf) buf.scrollTop = buf.scrollHeight;
            } else {
                document.documentElement.style.setProperty('--sc-keyboard-height', '0px');
                chatwrap.classList.remove('sc-keyboard-open');
            }
        };

        window.visualViewport.addEventListener('resize', updateForKeyboard);
        window.visualViewport.addEventListener('scroll', updateForKeyboard);
    }

    /* ==========================================================
       MOVIE TITLE WATCHER
    ========================================================== */

    function isYouTubeMedia() {
        try { const p = window.PLAYER || window.player; if (p?.type === 'yt' || p?.mediaType === 'yt') return true; } catch(e) {}
        return !!document.querySelector('#ytapiplayer iframe[src*="youtube.com"]');
    }

    function injectMovieLinks(titleEl) {
        const rawTitle = titleEl.textContent.trim()
            .replace(/^currently\s+playing[:\s]*/i, '')
            .replace(/^now\s+playing[:\s]*/i, '').trim();

        if (!rawTitle || rawTitle === lastMovieTitle || rawTitle.length < 2) return;
        lastMovieTitle = rawTitle;

        ['sc-movie-links','sc-movie-stats'].forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });

        if (isYouTubeMedia()) return;

        const { title, year } = parseMovieFilename(rawTitle);
        if (!title) return;

        const linkRow = document.createElement('span');
        linkRow.id = 'sc-movie-links';

        lookupMovie(title, year).then(({ links, killCount, cleanTitle, cleanYear }) => {
            if (cleanTitle && titleEl) {
                const newText = cleanTitle + (cleanYear ? ` (${cleanYear})` : '');
                const textNode = [...titleEl.childNodes].find(n => n.nodeType === 3 && n.textContent.trim());
                if (textNode) textNode.textContent = newText;
            }

            LINK_DEFS.forEach(({ key, label, color, fg, char }) => {
                const url = links[key];
                if (!url) return;
                const a = document.createElement('a');
                a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
                a.title = `${label}: "${cleanTitle || title}"`;
                a.className = 'sc-movie-link';
                a.style.background = color; a.style.color = fg;
                a.textContent = char;
                linkRow.appendChild(a);
            });

            // Stats
            if (killCount !== null || links.imdb) {
                const old = document.getElementById('sc-movie-stats');
                if (old) old.remove();
                const statParts = [];
                if (killCount !== null) statParts.push(`💀 ${killCount} on-screen kills`);
                if (statParts.length) {
                    const statsEl = document.createElement('div');
                    statsEl.id = 'sc-movie-stats';
                    statsEl.textContent = statParts.join('  ·  ');
                    document.body.appendChild(statsEl);
                    setTimeout(() => { if (statsEl.parentNode) statsEl.remove(); }, 12000);
                }
            }
        });

        titleEl.appendChild(linkRow);
    }

    function watchMovieTitle() {
        const tryInject = () => {
            const titleEl = document.getElementById('currenttitle')
                || document.querySelector('#videowrap-header .pull-left')
                || document.querySelector('#videowrap-header span');
            if (titleEl) injectMovieLinks(titleEl);
        };

        new MutationObserver(tryInject)
            .observe(document.querySelector('#videowrap-header') || document.body,
                { childList: true, subtree: true, characterData: true });

        setTimeout(tryInject, 1000);
    }

    /* ==========================================================
       CHAT HEADER — users + poll
    ========================================================== */

    function initChatHeader() {
        if (document.getElementById('sc-chat-header')) return;
        const chatwrap = document.getElementById('chatwrap');
        if (!chatwrap) return;
        const header = document.createElement('div');
        header.id = 'sc-chat-header';
        document.body.appendChild(header);
    }

    function initUserCount() {
        initChatHeader();
        const header = document.getElementById('sc-chat-header');
        if (!header) return;

        const btn = document.createElement('button');
        btn.id = 'sc-usercount-btn';
        header.appendChild(btn);

        const panel = document.createElement('div');
        panel.id = 'sc-users-panel';
        document.body.appendChild(panel);

        let open = false;

        const getUsers = () => {
            const items = [...document.querySelectorAll('#userlist .userlist_item')];
            return items.map(item => {
                const spans = item.querySelectorAll('span');
                const nameSpan = spans.length >= 2 ? spans[1] : spans[0];
                return nameSpan?.textContent?.trim() || '';
            }).filter(Boolean).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        };

        const updateCount = () => {
            const cytubCount = document.getElementById('usercount');
            const raw = cytubCount?.textContent?.match(/\d+/)?.[0];
            const count = raw ? parseInt(raw) : getUsers().length;
            btn.textContent = count + ' USERS';
        };

        const renderPanel = () => {
            const users = getUsers();
            panel.innerHTML = `
                <div class="sc-users-panel-header">${users.length} connected</div>
                ${users.map(u => `<div class="sc-users-panel-name" style="color:${usernameToColor(u)}">${u}</div>`).join('')}
            `;
        };

        const closePanel = () => { panel.style.display = 'none'; btn.classList.remove('sc-users-active'); open = false; };

        btn.addEventListener('click', e => {
            e.stopPropagation();
            open = !open;
            if (open) { renderPanel(); panel.style.display = 'block'; btn.classList.add('sc-users-active'); }
            else closePanel();
        });

        document.addEventListener('click', e => { if (open && !panel.contains(e.target) && e.target !== btn) closePanel(); });

        const ul = document.getElementById('userlist');
        if (ul) new MutationObserver(() => { updateCount(); if (open) renderPanel(); }).observe(ul, { childList: true, subtree: true });

        const uc = document.getElementById('usercount');
        if (uc) new MutationObserver(updateCount).observe(uc, { childList: true, subtree: true, characterData: true });

        updateCount();
    }

    function initPollWatcher() {
        const tryInit = () => {
            const pollwrap = document.getElementById('pollwrap');
            if (!pollwrap) { const o = new MutationObserver(() => { if (document.getElementById('pollwrap')) { o.disconnect(); tryInit(); } }); o.observe(document.body, { childList: true, subtree: true }); return; }
            _initPollWatcher(pollwrap);
        };
        tryInit();
    }

    function _initPollWatcher(pollwrap) {
        initChatHeader();
        const header = document.getElementById('sc-chat-header');
        if (!header) return;

        const btn = document.createElement('button');
        btn.id = 'sc-poll-btn';
        btn.textContent = 'POLL';
        header.appendChild(btn);

        const panel = document.createElement('div');
        panel.id = 'sc-poll-panel';
        document.body.appendChild(panel);

        let open = false;

        const hasPollContent = () => {
            const well = pollwrap.querySelector('.well.active') || pollwrap.querySelector('.well');
            return !!(well && well.textContent.trim().length > 10);
        };

        const renderPanel = () => {
            const well = pollwrap.querySelector('.well.active') || pollwrap.querySelector('.well');
            if (!well) { panel.innerHTML = ''; return; }
            const h = well.querySelector('h3')?.textContent?.trim() || '';
            const opts = [...well.querySelectorAll('.option')].map(o => {
                let html = o.innerHTML.replace(/<button[^>]*>.*?<\/button>/i, '').trim();
                return `<div class="sc-poll-option">${html}</div>`;
            });
            const label = well.querySelector('.label')?.textContent?.trim() || '';
            const author = well.querySelector('.label')?.getAttribute('title') || '';
            panel.innerHTML = `
                <div class="sc-poll-header">${h}</div>
                <div class="sc-poll-options">${opts.join('')}</div>
                ${label ? `<div class="sc-poll-meta">${author ? author + ' · ' : ''}${label}</div>` : ''}
            `;
        };

        const updateBtn = () => {
            const has = hasPollContent();
            btn.style.display = has ? '' : 'none';
            if (!has && open) { panel.style.display = 'none'; open = false; btn.classList.remove('sc-poll-btn-active'); }
        };

        btn.addEventListener('click', () => {
            open = !open;
            if (open) { renderPanel(); panel.style.display = 'block'; btn.classList.add('sc-poll-btn-active'); }
            else { panel.style.display = 'none'; btn.classList.remove('sc-poll-btn-active'); }
        });

        document.addEventListener('click', e => {
            if (open && !btn.contains(e.target) && !panel.contains(e.target)) { panel.style.display = 'none'; open = false; btn.classList.remove('sc-poll-btn-active'); }
        });

        new MutationObserver(() => { updateBtn(); if (open) renderPanel(); })
            .observe(pollwrap, { childList: true, subtree: true, characterData: true });

        updateBtn();
    }

    /* ==========================================================
       BOTTOM SHEET MENU
    ========================================================== */

    function initBottomSheet() {
        const overlay = document.createElement('div');
        overlay.id = 'sc-bottom-sheet-overlay';
        document.body.appendChild(overlay);

        const sheet = document.createElement('div');
        sheet.id = 'sc-bottom-sheet';
        sheet.innerHTML = `
            <div class="sc-sheet-handle"></div>
            <div class="sc-sheet-row" id="sc-sheet-settings">
                <div class="sc-sheet-row-icon">⚙</div>
                <div class="sc-sheet-row-label">Settings</div>
            </div>
            <div class="sc-sheet-row" id="sc-sheet-emotes">
                <div class="sc-sheet-row-icon">▦</div>
                <div class="sc-sheet-row-label">Emotes</div>
            </div>
            <div class="sc-sheet-row" id="sc-sheet-fullscreen">
                <div class="sc-sheet-row-icon">⛶</div>
                <div class="sc-sheet-row-label">Fullscreen</div>
            </div>
            <div class="sc-sheet-row" id="sc-sheet-desync">
                <div class="sc-sheet-row-icon" id="sc-sheet-desync-icon">⟳</div>
                <div class="sc-sheet-row-label" id="sc-sheet-desync-label">Free Watch</div>
            </div>
            <div class="sc-sheet-divider"></div>
            <div class="sc-sheet-row" id="sc-sheet-coming">
                <div class="sc-sheet-row-icon">🎬</div>
                <div class="sc-sheet-row-label">Coming Attractions</div>
            </div>
        `;
        document.body.appendChild(sheet);

        const menuBtn = document.createElement('button');
        menuBtn.id = 'sc-menu-btn';
        menuBtn.textContent = '⋯';
        document.body.appendChild(menuBtn);

        const openSheet = () => {
            overlay.style.display = 'block';
            sheet.style.display = 'block';
            requestAnimationFrame(() => sheet.classList.add('sc-sheet-open'));
        };
        const closeSheet = () => {
            sheet.classList.remove('sc-sheet-open');
            setTimeout(() => { overlay.style.display = 'none'; sheet.style.display = 'none'; }, 300);
        };

        menuBtn.addEventListener('click', openSheet);
        overlay.addEventListener('click', closeSheet);

        // Swipe down to close
        let startY = 0;
        sheet.addEventListener('touchstart', e => { startY = e.touches[0].clientY; }, { passive: true });
        sheet.addEventListener('touchend', e => { if (e.changedTouches[0].clientY - startY > 60) closeSheet(); }, { passive: true });

        // Wire up actions
        sheet.querySelector('#sc-sheet-settings').addEventListener('click', () => { closeSheet(); setTimeout(openSettingsModal, 300); });
        sheet.querySelector('#sc-sheet-fullscreen').addEventListener('click', () => { closeSheet(); document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); });
        sheet.querySelector('#sc-sheet-emotes').addEventListener('click', () => { closeSheet(); document.getElementById('emotelistbtn')?.click(); });

        // Desync
        let desynced = false, savedListeners = null;
        sheet.querySelector('#sc-sheet-desync').addEventListener('click', () => {
            if (typeof socket === 'undefined') return;
            desynced = !desynced;
            if (desynced) {
                const key = '$mediaUpdate';
                if (socket._callbacks?.[key]) { savedListeners = socket._callbacks[key].slice(); socket._callbacks[key] = []; }
                else if (socket._events?.mediaUpdate) { savedListeners = socket._events.mediaUpdate; delete socket._events.mediaUpdate; }
                sheet.querySelector('#sc-sheet-desync-icon').textContent = '⟳';
                sheet.querySelector('#sc-sheet-desync-icon').style.background = 'rgba(255,200,50,0.18)';
                sheet.querySelector('#sc-sheet-desync-icon').style.color = '#ffcc44';
                sheet.querySelector('#sc-sheet-desync-label').textContent = 'Free Watch ON';
            } else {
                if (savedListeners) {
                    if (socket._callbacks) socket._callbacks['$mediaUpdate'] = savedListeners;
                    else if (socket._events) socket._events.mediaUpdate = savedListeners;
                    savedListeners = null;
                }
                sheet.querySelector('#sc-sheet-desync-icon').textContent = '⟳';
                sheet.querySelector('#sc-sheet-desync-icon').style.background = '';
                sheet.querySelector('#sc-sheet-desync-icon').style.color = '';
                sheet.querySelector('#sc-sheet-desync-label').textContent = 'Free Watch';
                socket.emit('playerReady');
            }
            closeSheet();
        });

        // Coming Attractions
        sheet.querySelector('#sc-sheet-coming').addEventListener('click', () => {
            closeSheet();
            setTimeout(() => { const t = document.getElementById('sc-poster-toggle'); if (t) t.click(); }, 300);
        });
    }

    /* ==========================================================
       POSTER STRIP (reused from desktop)
    ========================================================== */

    function initPosterStrip() {
        const motd = document.getElementById('motdrow');
        if (!motd) return;
        const imgs = [...motd.querySelectorAll('img')].filter(img => {
            const w = parseInt(img.getAttribute('width') || 0);
            const h = parseInt(img.getAttribute('height') || 0);
            return h >= 100 && w <= 200;
        });
        if (!imgs.length) return;

        const strip = document.createElement('div');
        strip.id = 'sc-poster-strip';
        strip.style.cssText = `
            display: none; position: fixed; top: 0; left: 0; right: 0;
            z-index: 450; background: rgba(0,0,0,0.95);
            padding: 8px 10px; overflow-x: auto; white-space: nowrap;
            border-bottom: 1px solid rgba(255,255,255,0.12);
            -webkit-overflow-scrolling: touch;
        `;

        let zoomEl = document.getElementById('sc-poster-zoom-m');
        if (!zoomEl) {
            zoomEl = document.createElement('img');
            zoomEl.id = 'sc-poster-zoom-m';
            zoomEl.style.cssText = 'display:none; position:fixed; z-index:460; pointer-events:none; border-radius:6px; box-shadow:0 8px 32px rgba(0,0,0,0.9); height:200px; width:auto; top:50%; left:50%; transform:translate(-50%,-50%);';
            document.body.appendChild(zoomEl);
        }

        imgs.forEach(img => {
            const thumb = document.createElement('img');
            thumb.src = img.src;
            thumb.style.cssText = 'height:80px; width:auto; border-radius:4px; margin-right:6px; opacity:0.85; display:inline-block;';
            thumb.addEventListener('click', () => {
                if (zoomEl.style.display === 'block' && zoomEl.src === thumb.src) { zoomEl.style.display = 'none'; zoomEl.src = ''; }
                else { zoomEl.src = thumb.src; zoomEl.style.display = 'block'; }
            });
            strip.appendChild(thumb);
        });

        document.body.appendChild(strip);

        document.addEventListener('click', e => {
            if (zoomEl.style.display === 'block' && !e.target.closest('#sc-poster-strip')) {
                zoomEl.style.display = 'none'; zoomEl.src = '';
            }
        });

        // Toggle via bottom sheet "Coming Attractions"
        const toggle = document.createElement('button');
        toggle.id = 'sc-poster-toggle';
        toggle.style.display = 'none'; // triggered via bottom sheet
        toggle.addEventListener('click', () => {
            strip.style.display = strip.style.display === 'none' ? 'block' : 'none';
        });
        document.body.appendChild(toggle);
    }

    /* ==========================================================
       TOP BAR FADE
    ========================================================== */

    function initTopBar() {
        const bar = document.createElement('div');
        bar.id = 'sc-top-bar';
        document.body.appendChild(bar);

        let idleTimer = null, playing = false;

        const getDimEls = () => [
            bar,
            document.getElementById('videowrap-header'),
            document.getElementById('sc-movie-links'),
        ].filter(Boolean);

        const dim = () => { if (!playing) return; getDimEls().forEach(el => el.classList.add('sc-bar-dim')); };
        const wake = () => { getDimEls().forEach(el => el.classList.remove('sc-bar-dim')); clearTimeout(idleTimer); if (playing) idleTimer = setTimeout(dim, 4000); };

        const onVideoPlay = () => { if (playing) return; playing = true; idleTimer = setTimeout(dim, 5000); };
        const bindVideo = () => document.querySelectorAll('video').forEach(v => { if (!v._scMobilePlayBound) { v._scMobilePlayBound = true; v.addEventListener('play', onVideoPlay); } });
        bindVideo();
        new MutationObserver(bindVideo).observe(document.body, { childList: true, subtree: true });

        // Touch top of screen to wake
        document.addEventListener('touchstart', e => { if (e.touches[0].clientY < 60) wake(); }, { passive: true });
    }

    /* ==========================================================
       SETTINGS MODAL
    ========================================================== */

    function openSettingsModal(firstRun = false) {
        const overlay = document.createElement('div');
        overlay.id = 'sc-settings-overlay';
        overlay.innerHTML = `
            <div id="sc-settings-modal">
                <div style="font-size:17px;font-weight:700;margin-bottom:18px;color:white">
                    ${firstRun ? 'Welcome — Set Up Your Keys' : 'Settings'}
                </div>
                <div class="sc-settings-group">
                    <label>TMDB API Key</label>
                    <input type="password" id="sc-input-tmdb" value="${getKey(LS_TMDB)}" placeholder="paste key here" autocomplete="off">
                </div>
                <div class="sc-settings-group">
                    <label>DoesTheDogDie API Key</label>
                    <input type="password" id="sc-input-dtdd" value="${getKey(LS_DTDD)}" placeholder="paste key here" autocomplete="off">
                </div>
                <div class="sc-settings-group" style="display:flex;align-items:center;gap:10px">
                    <input type="checkbox" id="sc-input-spellcheck" ${spellCheckEnabled() ? 'checked' : ''} style="width:20px;height:20px">
                    <label style="text-transform:none;font-size:14px;letter-spacing:0;color:rgba(255,255,255,0.82)">Grammar &amp; spell check</label>
                </div>
                <button id="sc-settings-save">Save</button>
                ${!firstRun ? '<button id="sc-settings-cancel">Cancel</button>' : ''}
            </div>
        `;
        document.body.appendChild(overlay);

        overlay.querySelector('#sc-settings-save').addEventListener('click', () => {
            setKey(LS_TMDB, overlay.querySelector('#sc-input-tmdb').value);
            setKey(LS_DTDD, overlay.querySelector('#sc-input-dtdd').value);
            setKey(LS_SPELLCHECK, overlay.querySelector('#sc-input-spellcheck').checked ? 'on' : 'off');
            overlay.remove();
        });

        overlay.querySelector('#sc-settings-cancel')?.addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    }

    /* ==========================================================
       USER COLORS
    ========================================================== */

    let _colorObserverStarted = false;
    function startUserColorObserver() {
        const buf = document.getElementById('messagebuffer');
        if (!buf) return;
        if (_colorObserverStarted) { applyUserColors(); return; }
        _colorObserverStarted = true;
        new MutationObserver(applyUserColors).observe(buf, { childList: true, subtree: true });
        applyUserColors();
    }

    function applyUserColors() {
        document.querySelectorAll('#messagebuffer .username').forEach(el => {
            const name = el.textContent.replace(/:$/, '').trim();
            if (name && !el.dataset.colored) {
                el.style.color = usernameToColor(name);
                el.dataset.colored = '1';
            }
        });
    }

    /* ==========================================================
       BOOT
    ========================================================== */

    window.addEventListener('load', () => {
        injectCSS();
        getKillCountDb();
        installChatTextarea();
        initTopBar();
        watchMovieTitle();
        initBottomSheet();

        if (!hasKey(LS_TMDB) && !hasKey(LS_DTDD)) setTimeout(() => openSettingsModal(true), 1200);

        // Run when DOM elements become available
        const bootObserver = new MutationObserver(() => {
            installChatTextarea();
            initKeyboardHandler();
            initChatHeader();
            initUserCount();
            startUserColorObserver();

            if (
                document.getElementById('sc-chat-textarea') &&
                document.getElementById('sc-chat-header')
            ) bootObserver.disconnect();
        });
        bootObserver.observe(document.body, { childList: true, subtree: true });

        // Poster strip — wait for motdrow
        if (document.querySelector('#motdrow img')) { initPosterStrip(); }
        else {
            const mo = new MutationObserver(() => { if (document.querySelector('#motdrow img')) { mo.disconnect(); initPosterStrip(); } });
            mo.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => { if (!document.getElementById('sc-poster-strip')) initPosterStrip(); }, 3000);
        }

        setTimeout(() => {
            initPollWatcher();
            startUserColorObserver();
        }, 1500);
    });

})();