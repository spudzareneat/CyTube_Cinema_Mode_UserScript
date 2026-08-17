    /* ==========================================================
       API KEYS — stored in localStorage, managed via settings modal.
       Keys are never hard-coded; the settings modal handles first-run.
    ========================================================== */
    const LS_SPELLCHECK  = 'sc_spellcheck';
    const LS_CHAT_FONT   = 'sc_chat_fontsize';
    const LS_MOVIE_LINKS = 'sc_movie_links';
    const LS_IMGBB       = 'sc_imgbb_key';
    const LS_MOVIE_CACHE = 'sc_movie_cache_v3'; // v3: Letterboxd switched from a TMDB-id redirect to an IMDb-id one --
                                                 // v2 entries can carry a permanently-null `links.letterboxd` from
                                                 // when that required the optional tmdb module/key; bump forces a
                                                 // clean slate so those don't shadow the fixed lookup forever.
                                                 // v2: IMDb-first rewrite -- v1 entries predate `resolved` and can carry
                                                 // permanently-null TMDB-only results from pre-upgrade builds; bump forced
                                                 // a clean slate so those didn't shadow the new IMDb lookup forever.
    const LS_LINEUP_TIMING = 'sc_lineup_timing'; // Experimental: live NOW PLAYING/ETA tracking; off by default
    const LS_CHAT_PANEL_W = 'sc_chat_panel_w';   // vw — horizontal-layout chat panel width
    const LS_CHAT_PANEL_H = 'sc_chat_panel_h';   // vh — vertical-layout chat panel height
    const LS_CHAT_TEXTAREA_H = 'sc_chat_textarea_h'; // px — manually resized chat entry height
    const LS_GIF_OPTIMIZE = 'sc_gif_optimize'; // shared with cytube.gifmaker.user.js
    const LS_AUTOEMBED   = 'sc_autoembed_images';
    const LS_MOVIE_LEAD  = 'sc_movie_lead_sec'; // seconds to run ahead of sync during movies (not YouTube); 0 = off
    const LS_EMOTE_PANEL_POS = 'sc_emote_panel_pos'; // JSON {left, top} -- dragged position of the custom emote picker panel
    const LS_EMOTE_FAVORITES = 'sc_emote_favorites'; // JSON array of favorited emote name strings (custom emote picker panel)
    const getKey   = id => localStorage.getItem(id) || '';
    const setKey   = (id, v) => localStorage.setItem(id, v.trim());
    const hasKey   = id => !!getKey(id);
    const spellCheckEnabled  = () => getKey(LS_SPELLCHECK)  !== 'off';
    const movieLinksEnabled  = () => getKey(LS_MOVIE_LINKS) !== 'off';
    const lineupTimingEnabled = () => getKey(LS_LINEUP_TIMING) === 'on'; // opt-in, unlike the toggles above
    const gifOptimizeEnabled = () => getKey(LS_GIF_OPTIMIZE) !== 'off'; // default ON, like spellcheck/movielinks
    const autoEmbedEnabled  = () => getKey(LS_AUTOEMBED) !== 'off'; // default ON, like spellcheck/movielinks
