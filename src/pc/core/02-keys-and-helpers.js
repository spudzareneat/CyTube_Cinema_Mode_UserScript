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
