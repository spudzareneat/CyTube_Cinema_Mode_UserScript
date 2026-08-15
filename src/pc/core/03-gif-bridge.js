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
       _gifTitleSlug(), lastMovieTitle, and _npData referenced below
       live in 01-movie-identity.js (core, always bundled) precisely
       so this always-on bridge can never be built without them --
       see that file's MOVIE IDENTITY section header. getTitleSlug/
       getMovieInfo below already null-guard the *values* (empty
       title / no _npData yet); that's independent of, and doesn't
       change with, where the declarations themselves live.
    ========================================================== */
    const _uw = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    _uw.__SC_GIF_BRIDGE__ = {
        version: 1,
        getTitleSlug: () => _gifTitleSlug(),
        // Used by cytube.subtitles.user.js to build an OpenSubtitles search
        // link. title/year come from the same source getTitleSlug() uses
        // (always available once a video is playing); imdbId is only set
        // once the Now Playing card's TMDB lookup has resolved for this
        // video (requires a TMDB key -- null otherwise, caller falls back).
        getMovieInfo: () => {
            if (!lastMovieTitle) return null;
            const { title, year } = parseMovieFilename(lastMovieTitle);
            if (!title) return null;
            return { title, year: year || null, imdbId: (_npData && _npData.imdbId) || null };
        },
        openGifPanel: undefined, // filled in by cytube.gifmaker.user.js once it boots
    };
