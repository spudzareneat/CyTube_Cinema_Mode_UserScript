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
