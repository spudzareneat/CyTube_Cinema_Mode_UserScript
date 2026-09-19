    /* ==========================================================
       TRAKT SCROBBLE — end-of-movie "log this on Trakt?" panel.

       When playback of a movie passes a configurable share of its
       runtime (default 90%), a dark, semi-transparent card appears at
       the bottom-right of the video for one minute offering to record
       the watch (and an optional 1-10 rating) on trakt.tv. Everything
       is configured in the Settings modal: an opt-in toggle, the
       user's own Trakt app Client ID + Secret, and the threshold.

       Movies only (matched by the IMDb id movie-title-links resolves:
       _currentImdbId / _npData); YouTube items are skipped. Auth is
       Trakt's device-code flow, done inline in the panel. The watch is
       sent as a one-shot POST /sync/history (not the live
       /scrobble/start|pause|stop session API -- we only ask after the
       fact), and the "already handled" state lives in localStorage
       (single slot, 12 h TTL) so reloads during the credits don't
       re-prompt.

       Like trivia-popup, settings here are poll-per-use: Save just
       writes localStorage, so the heartbeat re-reads them each tick.

       Layout of this file: LS keys -> helpers slice (pure, unit-tested)
       -> client slice (Trakt HTTP/token/device-auth, unit-tested with a
       fake GM_xmlhttpRequest) -> panel + heartbeat -> settings rows.
       scripts/test-trakt-scrobble.mjs slices the two test-marker
       regions out of this file.
    ========================================================== */

    // ── test marker: trakt-helpers slice start ──
    const LS_TRAKT_ENABLED   = 'sc_trakt_enabled';        // 'on' = opted in (off by default)
    const LS_TRAKT_CLIENT_ID = 'sc_trakt_client_id';
    const LS_TRAKT_SECRET    = 'sc_trakt_client_secret';
    const LS_TRAKT_THRESHOLD = 'sc_trakt_threshold';      // percent of runtime, 50-100
    const LS_TRAKT_TOKEN     = 'sc_trakt_token';          // JSON {access, refresh, expiresAt, clientId}
    const LS_TRAKT_PROMPTED  = 'sc_trakt_prompted';       // JSON {imdbId, ts, outcome} -- single slot

    const TRAKT_THRESHOLD_MIN     = 50;
    const TRAKT_THRESHOLD_MAX     = 100;
    const TRAKT_THRESHOLD_DEFAULT = 90;
    const TRAKT_MIN_DURATION_SEC  = 10 * 60;              // ignore shorts / bumpers
    const TRAKT_PROMPT_TTL_MS     = 12 * 60 * 60 * 1000;  // don't re-ask about the same movie within 12 h
    const TRAKT_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;  // refresh the token when < 1 day from expiry
    const TRAKT_PANEL_LIFETIME_MS = 60 * 1000;            // how long the prompt stays up
    const TRAKT_SUCCESS_MS        = 6 * 1000;             // how long the "Logged" confirmation stays up
    const TRAKT_PANEL_INSET       = { right: 16, bottom: 56 }; // px from the video's corner; bottom clears the control bar

    function traktClampThreshold(raw) {
        const n = parseInt(raw, 10);
        const v = Number.isFinite(n) ? n : TRAKT_THRESHOLD_DEFAULT;
        return Math.min(TRAKT_THRESHOLD_MAX, Math.max(TRAKT_THRESHOLD_MIN, v));
    }

    // s = { enabled, isYouTube, imdbId, duration, currentTime, thresholdPct, prompted, now }
    function traktShouldPrompt(s) {
        if (!s.enabled || s.isYouTube || !s.imdbId) return false;
        if (!Number.isFinite(s.duration) || s.duration < TRAKT_MIN_DURATION_SEC) return false;
        if (!Number.isFinite(s.currentTime) || s.currentTime < 0) return false;
        if (s.currentTime / s.duration < s.thresholdPct / 100) return false;
        const p = s.prompted;
        if (p && p.imdbId === s.imdbId && s.now - p.ts < TRAKT_PROMPT_TTL_MS) return false;
        return true;
    }

    function traktUsableToken(token, clientId) {
        return (token && token.access && clientId && token.clientId === clientId) ? token : null;
    }

    function traktTokenNeedsRefresh(token, nowMs) {
        return !!token && Number.isFinite(token.expiresAt) && nowMs >= token.expiresAt - TRAKT_REFRESH_WINDOW_MS;
    }

    // Trakt's token response: { access_token, refresh_token, expires_in (s), created_at (unix s), ... }
    function traktTokenFromResponse(json, clientId, nowMs) {
        const createdMs = Number.isFinite(json.created_at) ? json.created_at * 1000 : nowMs;
        return { access: json.access_token, refresh: json.refresh_token, expiresAt: createdMs + json.expires_in * 1000, clientId };
    }

    function traktBuildHistoryPayload(snap, nowIso) {
        return { movies: [{ watched_at: nowIso, ids: { imdb: snap.imdbId } }] };
    }

    function traktBuildRatingPayload(snap, rating, nowIso) {
        return { movies: [{ rated_at: nowIso, rating, ids: { imdb: snap.imdbId } }] };
    }

    // Trakt's /sync/* reply: { added: { movies: n }, not_found: { movies: [...] } }
    function traktInterpretSyncResponse(json) {
        const nf = json && json.not_found && json.not_found.movies;
        if (nf && nf.length) return 'not_found';
        const added = json && json.added && json.added.movies;
        return added > 0 ? 'added' : 'unknown';
    }

    function traktTickLifetime(remainingMs, dtMs, paused) {
        return paused ? remainingMs : Math.max(0, remainingMs - dtMs);
    }

    // rect = the video's getBoundingClientRect() (or null); viewport = { width, height } of the visible
    // viewport. Returns CSS `right`/`bottom` px for a position:fixed box so it hugs the rect's bottom-right.
    function traktPanelPosition(rect, viewport) {
        const right  = rect ? viewport.width  - rect.right  : 0;
        const bottom = rect ? viewport.height - rect.bottom : 0;
        return {
            right:  Math.max(0, Math.round(right))  + TRAKT_PANEL_INSET.right,
            bottom: Math.max(0, Math.round(bottom)) + TRAKT_PANEL_INSET.bottom,
        };
    }
    // ── test marker: trakt-helpers slice end ──
