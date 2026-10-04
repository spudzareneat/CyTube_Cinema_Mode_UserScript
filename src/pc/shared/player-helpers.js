    // Player/media helpers shared by core and the standalone Pop-up Video build.

    // Current media duration/type/YouTube-video-id — updated by the changeMedia socket event.
    let currentMediaSeconds = 0;
    let currentMediaType    = '';
    let currentYtVideoId    = '';
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

    function getPlayerVideoEl() {
        return document.querySelector('#ytapiplayer video') || document.querySelector('video');
    }
