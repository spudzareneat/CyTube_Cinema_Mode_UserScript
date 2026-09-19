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

    // s = { enabled, isYouTube, isEpisode, imdbId, duration, currentTime, thresholdPct, prompted, now }
    function traktShouldPrompt(s) {
        if (!s.enabled || s.isYouTube || s.isEpisode || !s.imdbId) return false;
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

    // ── test marker: trakt-client slice start ──
    const TRAKT_API          = 'https://api.trakt.tv';
    const TRAKT_OOB_REDIRECT = 'urn:ietf:wg:oauth:2.0:oob';

    const traktEnabled   = () => getKey(LS_TRAKT_ENABLED) === 'on';   // opt-in
    const traktThreshold = () => traktClampThreshold(getKey(LS_TRAKT_THRESHOLD));
    const traktClientId  = () => getKey(LS_TRAKT_CLIENT_ID);
    const traktSecret    = () => getKey(LS_TRAKT_SECRET);

    // Resolves { status, json } for any HTTP response (json is null when the body isn't JSON);
    // rejects only on a network error / timeout. `opts.clientId` overrides the saved Client ID
    // (used by the Settings "Test" button, which validates the value currently typed in the box).
    function traktRequest(method, path, opts = {}) {
        const { body, token, clientId } = opts;
        return new Promise((resolve, reject) => {
            const headers = {
                'Content-Type': 'application/json',
                'trakt-api-version': '2',
                'trakt-api-key': clientId || traktClientId(),
            };
            if (token && token.access) headers['Authorization'] = 'Bearer ' + token.access;
            GM_xmlhttpRequest({
                method,
                url: TRAKT_API + path,
                headers,
                data: body ? JSON.stringify(body) : undefined,
                timeout: 15000,
                onload: r => {
                    let json = null;
                    try { json = JSON.parse(r.responseText); } catch (e) {}
                    resolve({ status: r.status, json });
                },
                onerror: () => reject(new Error('network')),
                ontimeout: () => reject(new Error('timeout')),
            });
        });
    }

    // Settings "Test" button handler: an unauthenticated public endpoint that still requires a valid
    // trakt-api-key. 200 = key accepted, 401/403 = rejected, anything else = couldn't tell.
    async function validateTraktClientId(clientId) {
        try {
            const res = await traktRequest('GET', '/movies/trending?limit=1', { clientId });
            if (res.status === 200) return 'valid';
            if (res.status === 401 || res.status === 403) return 'invalid';
            return 'error';
        } catch (e) { return 'error'; }
    }

    function traktLoadToken() { try { return JSON.parse(localStorage.getItem(LS_TRAKT_TOKEN)); } catch (e) { return null; } }
    function traktSaveToken(t) { try { localStorage.setItem(LS_TRAKT_TOKEN, JSON.stringify(t)); } catch (e) {} }
    function traktClearToken() { try { localStorage.removeItem(LS_TRAKT_TOKEN); } catch (e) {} }

    function traktLoadPrompted() { try { return JSON.parse(localStorage.getItem(LS_TRAKT_PROMPTED)); } catch (e) { return null; } }
    // outcome: 'shown' (panel appeared -- also what an auto-dismiss leaves behind) | 'skipped' | 'scrobbled' | 'needsconfig' (card shown but keys missing; ignored once keys exist)
    function traktMarkPrompted(imdbId, outcome) {
        try { localStorage.setItem(LS_TRAKT_PROMPTED, JSON.stringify({ imdbId, ts: Date.now(), outcome })); } catch (e) {}
    }

    // Device flow step 1. Resolves { device_code, user_code, verification_url, expires_in, interval }; throws on failure.
    async function traktStartDeviceAuth() {
        const res = await traktRequest('POST', '/oauth/device/code', { body: { client_id: traktClientId() } });
        if (res.status !== 200 || !res.json || !res.json.device_code) throw new Error('device-code HTTP ' + res.status);
        return res.json;
    }

    // Device flow step 2: polls at Trakt's interval until approved / denied / expired / cancelled.
    // `handle` is { cancelled: boolean } -- set it true to stop. `sleep` is injectable for tests.
    // Saves the token and resolves 'ok' on success; else 'denied' | 'expired' | 'cancelled' | 'error'.
    async function traktPollDeviceToken(dev, handle, sleep = ms => new Promise(r => setTimeout(r, ms))) {
        let intervalMs = Math.max(1, dev.interval || 5) * 1000;
        const deadline = Date.now() + dev.expires_in * 1000;
        while (!handle.cancelled && Date.now() < deadline) {
            await sleep(intervalMs);
            if (handle.cancelled) break;
            let res;
            try {
                res = await traktRequest('POST', '/oauth/device/token',
                    { body: { code: dev.device_code, client_id: traktClientId(), client_secret: traktSecret() } });
            } catch (e) { continue; }                                   // transient network error: keep polling until expiry
            if (res.status === 200 && res.json && res.json.access_token) {
                traktSaveToken(traktTokenFromResponse(res.json, traktClientId(), Date.now()));
                return 'ok';
            }
            if (res.status === 400) continue;                            // pending: user hasn't approved yet
            if (res.status === 429) { intervalMs += 1000; continue; }    // polling too fast
            if (res.status === 418) return 'denied';
            if (res.status === 404 || res.status === 409 || res.status === 410) return 'expired';
            return 'error';                                              // e.g. 401 = wrong Client Secret
        }
        return handle.cancelled ? 'cancelled' : 'expired';
    }

    // Exchanges the refresh token. Saves + returns the fresh token, or null. A definitive rejection
    // (400/401/403) also clears the stored token so the next attempt goes through Connect.
    async function traktRefreshToken(token) {
        try {
            const res = await traktRequest('POST', '/oauth/token', {
                body: {
                    refresh_token: token.refresh, client_id: traktClientId(), client_secret: traktSecret(),
                    redirect_uri: TRAKT_OOB_REDIRECT, grant_type: 'refresh_token',
                },
            });
            if (res.status === 200 && res.json && res.json.access_token) {
                const fresh = traktTokenFromResponse(res.json, traktClientId(), Date.now());
                traktSaveToken(fresh);
                return fresh;
            }
            if (res.status === 400 || res.status === 401 || res.status === 403) traktClearToken();
        } catch (e) {}
        return null;
    }

    // A token that can be used right now, or null (=> the panel must run Connect).
    async function traktEnsureToken() {
        const token = traktUsableToken(traktLoadToken(), traktClientId());
        if (!token) return null;
        if (traktTokenNeedsRefresh(token, Date.now())) {
            const fresh = await traktRefreshToken(token);
            if (fresh) return fresh;
            if (!traktLoadToken()) return null;                 // refresh was rejected and the token was cleared
            if (Date.now() >= token.expiresAt) return null;     // hard-expired and couldn't refresh
        }
        return token;                                           // near expiry but refresh failed transiently: still valid
    }

    // 'auth' (=> Connect) only when no usable token remains stored; if one is still there the failed
    // token/refresh step was transient (network, timeout, 5xx), so report 'error' and let Retry work.
    const traktNoTokenResult = () => ({
        result: traktUsableToken(traktLoadToken(), traktClientId()) ? 'error' : 'auth',
        ratingFailed: false,
    });

    // Logs the watch (+ rating). Resolves { result, ratingFailed }; result is
    // 'added' | 'not_found' | 'auth' (needs Connect) | 'error'. A failed rating never fails the watch.
    // NOTE: a Retry after a lost *response* can log the watch twice -- Trakt doesn't dedupe history adds.
    async function traktSubmit(snap, rating) {
        let token = await traktEnsureToken();
        if (!token) return traktNoTokenResult();
        const nowIso = new Date().toISOString();
        const post = (path, body) => traktRequest('POST', path, { body, token });
        try {
            let res = await post('/sync/history', traktBuildHistoryPayload(snap, nowIso));
            if (res.status === 401) {                           // token rejected: one refresh, one retry
                token = await traktRefreshToken(token);
                if (!token) return traktNoTokenResult();
                res = await post('/sync/history', traktBuildHistoryPayload(snap, nowIso));
            }
            if (res.status !== 200 && res.status !== 201) return { result: 'error', ratingFailed: false };
            const verdict = traktInterpretSyncResponse(res.json);
            if (verdict === 'not_found') return { result: 'not_found', ratingFailed: false };
            if (verdict !== 'added') return { result: 'error', ratingFailed: false };
            let ratingFailed = false;
            if (rating) {
                try {
                    const rr = await post('/sync/ratings', traktBuildRatingPayload(snap, rating, nowIso));
                    ratingFailed = !((rr.status === 200 || rr.status === 201) && traktInterpretSyncResponse(rr.json) === 'added');
                } catch (e) { ratingFailed = true; }
            }
            return { result: 'added', ratingFailed };
        } catch (e) {
            return { result: 'error', ratingFailed: false };
        }
    }
    // ── test marker: trakt-client slice end ──

    /* ==========================================================
       PANEL — #sc-trakt-panel, a single card whose body is re-rendered
       per view: 'prompt' | 'submitting' | 'success' | 'notfound' |
       'error' | 'connect' | 'needsconfig'. Events are delegated from
       the card itself (data-act / data-r), so re-rendering the body
       never needs re-binding.
    ========================================================== */
    const TRAKT_POLL_MS = 3000;   // heartbeat: decides when the movie has reached the prompt point
    const TRAKT_LIFE_TICK_MS = 250;

    let _traktPanelEl    = null;  // live panel node, or null when closed
    let _traktCtx        = null;  // { snap, rating, view, message, remaining, lifeTotal, hover, dev, devExpiresAt, poll, ratingFailed }
    let _traktLifeTimer  = null;
    let _traktKeyHandler = null;

    function _traktEsc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Everything the panel needs about the movie, captured once at trigger time so a queue advance
    // while the card is open can't change what gets submitted.
    function traktSnapshot() {
        const np = (_npData && _npData.imdbId === _currentImdbId) ? _npData : null;
        const parsed = lastMovieTitle ? parseMovieFilename(lastMovieTitle) : { title: '', year: null };
        return {
            imdbId: _currentImdbId,
            title:  (np && np.cleanTitle) || parsed.title || 'this movie',
            year:   (np && np.cleanYear) || parsed.year || '',
            poster: (np && np.poster) || '',
        };
    }

    // Normally <body>; while something is fullscreened via the Fullscreen API the card must live
    // inside that element to stay visible (a <video> can't hold children, so that case is skipped).
    function _traktHost() {
        const fs = document.fullscreenElement;
        return (fs && fs.tagName !== 'VIDEO') ? fs : document.body;
    }

    // Pins the card to the bottom-right of the video (or #videowrap, else the viewport corner).
    // Runs every life tick, so window resizes / chat-panel drags / fullscreen changes are followed.
    function _traktReposition() {
        if (!_traktPanelEl) return;
        const host = _traktHost();
        if (_traktPanelEl.parentNode !== host) host.appendChild(_traktPanelEl);
        const v = document.querySelector('#ytapiplayer video');
        const wrap = document.getElementById('videowrap');
        let r = (v && v.getBoundingClientRect()) || null;
        if (!r || r.width <= 0 || r.height <= 0) r = (wrap && wrap.getBoundingClientRect()) || null;
        if (r && (r.width <= 0 || r.height <= 0)) r = null;
        const pos = traktPanelPosition(r, { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight });
        _traktPanelEl.style.setProperty('right', pos.right + 'px', 'important');
        _traktPanelEl.style.setProperty('bottom', pos.bottom + 'px', 'important');
    }

    function _traktStars(rating) {
        let out = '';
        for (let i = 1; i <= 10; i++) {
            out += `<button type="button" class="sc-trakt-star${i <= rating ? ' on' : ''}" data-r="${i}" aria-label="Rate ${i} out of 10">★</button>`;
        }
        return out;
    }

    function _traktPaintLife() {
        const bar = _traktPanelEl && _traktPanelEl.querySelector('.sc-trakt-life-bar');
        if (bar && _traktCtx) bar.style.setProperty('width', Math.max(0, Math.min(100, _traktCtx.remaining / _traktCtx.lifeTotal * 100)) + '%', 'important');
    }

    function _traktRender() {
        const c = _traktCtx, el = _traktPanelEl;
        if (!c || !el) return;
        const s = c.snap;
        const title = `${_traktEsc(s.title)}${s.year ? ` <span class="sc-trakt-year">(${_traktEsc(s.year)})</span>` : ''}`;
        const poster = s.poster
            ? `<img class="sc-trakt-poster" src="${_traktEsc(s.poster)}" alt="" />`
            : '<div class="sc-trakt-poster sc-trakt-noposter">🎬</div>';
        let body = '';
        switch (c.view) {
            case 'prompt':
                body = `
                    <div class="sc-trakt-q">You reached the end. Log it on Trakt?</div>
                    <div class="sc-trakt-stars" role="group" aria-label="Optional rating">${_traktStars(c.rating)}</div>
                    <div class="sc-trakt-rating-label">${c.rating ? c.rating + ' / 10' : 'Optional rating'}</div>
                    <div class="sc-trakt-actions">
                        <button type="button" class="sc-trakt-btn sc-trakt-primary" data-act="scrobble">Scrobble to Trakt</button>
                        <button type="button" class="sc-trakt-btn" data-act="skip">Not now</button>
                    </div>
                    ${traktLoadToken() ? '<a href="#" class="sc-trakt-link" data-act="disconnect">Disconnect Trakt</a>' : ''}`;
                break;
            case 'submitting':
                body = '<div class="sc-trakt-q">Logging to Trakt…</div>';
                break;
            case 'success':
                body = `
                    <div class="sc-trakt-q sc-trakt-ok">Logged ✓${c.ratingFailed ? ' <span class="sc-trakt-note">(rating didn\'t save)</span>' : ''}</div>
                    <a class="sc-trakt-link" href="https://trakt.tv/search/imdb/${_traktEsc(s.imdbId)}" target="_blank" rel="noopener">View on Trakt ↗</a>`;
                break;
            case 'notfound':
                body = `
                    <div class="sc-trakt-q sc-trakt-bad">Trakt couldn't match this movie.</div>
                    <div class="sc-trakt-actions"><button type="button" class="sc-trakt-btn" data-act="skip">Close</button></div>`;
                break;
            case 'error':
                body = `
                    <div class="sc-trakt-q sc-trakt-bad">${_traktEsc(c.message || 'Something went wrong.')}</div>
                    <div class="sc-trakt-actions">
                        <button type="button" class="sc-trakt-btn sc-trakt-primary" data-act="retry">Retry</button>
                        <button type="button" class="sc-trakt-btn" data-act="skip">Close</button>
                    </div>`;
                break;
            case 'connect':
                body = c.dev ? `
                    <div class="sc-trakt-q">Connect your Trakt account</div>
                    <div class="sc-trakt-help">Open <a class="sc-trakt-link" href="${_traktEsc(c.dev.verification_url)}" target="_blank" rel="noopener">${_traktEsc(String(c.dev.verification_url).replace(/^https?:\/\//, ''))}</a> and enter:</div>
                    <div class="sc-trakt-code">${_traktEsc(c.dev.user_code)}</div>
                    <div class="sc-trakt-help">Waiting for approval… <span class="sc-trakt-expiry"></span></div>
                    <div class="sc-trakt-actions"><button type="button" class="sc-trakt-btn" data-act="cancelconnect">Cancel</button></div>`
                : '<div class="sc-trakt-q">Contacting Trakt…</div>';
                break;
            case 'needsconfig':
                body = `
                    <div class="sc-trakt-q">Trakt isn't set up yet</div>
                    <div class="sc-trakt-help">Add your Trakt Client ID and Secret in Settings to log movies.</div>
                    <div class="sc-trakt-actions">
                        <button type="button" class="sc-trakt-btn sc-trakt-primary" data-act="settings">Open Settings</button>
                        <button type="button" class="sc-trakt-btn" data-act="skip">Dismiss</button>
                    </div>`;
                break;
        }
        el.innerHTML = `
            <div class="sc-trakt-row">
                ${poster}
                <div class="sc-trakt-main">
                    <div class="sc-trakt-title">${title}</div>
                    ${body}
                </div>
            </div>
            <div class="sc-trakt-life"><div class="sc-trakt-life-bar"></div></div>`;
        _traktPaintLife();
    }

    // opts.life (ms) restarts the countdown for the new view; opts.message feeds the 'error' view.
    function _traktSetView(view, opts = {}) {
        const c = _traktCtx;
        if (!c) return;
        c.view = view;
        c.message = opts.message || '';
        if (opts.life) { c.remaining = opts.life; c.lifeTotal = opts.life; }
        _traktRender();
    }

    function _traktLifeTick() {
        const c = _traktCtx;
        if (!c || !_traktPanelEl) return;
        const paused = (c.hover && c.view !== 'success') || c.view === 'submitting' || c.view === 'connect';
        c.remaining = traktTickLifetime(c.remaining, TRAKT_LIFE_TICK_MS, paused);
        _traktReposition();
        _traktPaintLife();
        const exp = _traktPanelEl.querySelector('.sc-trakt-expiry');
        if (exp && c.devExpiresAt) {
            const secs = Math.max(0, Math.round((c.devExpiresAt - Date.now()) / 1000));
            exp.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
        }
        if (c.remaining <= 0) traktClosePanel();   // auto-dismiss: the 'shown' outcome recorded at show time stands
    }

    function traktClosePanel() {
        const el = _traktPanelEl, c = _traktCtx;
        if (c && c.poll) c.poll.cancelled = true;
        clearInterval(_traktLifeTimer); _traktLifeTimer = null;
        if (_traktKeyHandler) { document.removeEventListener('keydown', _traktKeyHandler); _traktKeyHandler = null; }
        _traktCtx = null; _traktPanelEl = null;
        if (el) {
            el.classList.remove('sc-trakt-in');
            el.classList.add('sc-trakt-out');
            setTimeout(() => el.remove(), 350);
        }
    }

    async function _traktBeginConnect() {
        const c = _traktCtx;
        if (!c) return;
        _traktSetView('connect');                        // no c.dev yet -> "Contacting Trakt…"
        let dev;
        try { dev = await traktStartDeviceAuth(); }
        catch (e) {
            if (_traktCtx !== c) return;
            _traktSetView('error', { message: 'Couldn\'t start Trakt sign-in. Check your Client ID in Settings.', life: TRAKT_PANEL_LIFETIME_MS });
            return;
        }
        if (_traktCtx !== c) return;
        c.dev = dev;
        c.devExpiresAt = Date.now() + dev.expires_in * 1000;
        c.poll = { cancelled: false };
        _traktSetView('connect');
        const r = await traktPollDeviceToken(dev, c.poll);
        if (_traktCtx !== c || r === 'cancelled') return;
        c.dev = null; c.devExpiresAt = 0; c.poll = null;
        if (r === 'ok') { _traktBeginSubmit(); return; }
        const message = r === 'denied' ? 'Trakt sign-in was denied.'
            : r === 'expired' ? 'The code expired -- try again.'
            : 'Trakt sign-in failed. Check your Client Secret in Settings.';
        _traktSetView('error', { message, life: TRAKT_PANEL_LIFETIME_MS });
    }

    async function _traktBeginSubmit() {
        const c = _traktCtx;
        if (!c) return;
        if (!traktUsableToken(traktLoadToken(), traktClientId())) { _traktBeginConnect(); return; }
        _traktSetView('submitting');
        const out = await traktSubmit(c.snap, c.rating);
        if (_traktCtx !== c) return;                     // panel was closed while we waited
        if (out.result === 'added') {
            traktMarkPrompted(c.snap.imdbId, 'scrobbled');
            c.ratingFailed = out.ratingFailed;
            _traktSetView('success', { life: TRAKT_SUCCESS_MS });
        } else if (out.result === 'not_found') {
            _traktSetView('notfound', { life: TRAKT_PANEL_LIFETIME_MS });
        } else if (out.result === 'auth') {
            _traktBeginConnect();
        } else {
            _traktSetView('error', { message: 'Couldn\'t reach Trakt -- try again.', life: TRAKT_PANEL_LIFETIME_MS });
        }
    }

    function _traktOnAction(act) {
        const c = _traktCtx;
        if (!c) return;
        if (act === 'skip')          { traktMarkPrompted(c.snap.imdbId, 'skipped'); traktClosePanel(); return; }
        if (act === 'settings')      { traktClosePanel(); openSettingsModal(); return; }
        if (act === 'disconnect')    { traktClearToken(); _traktRender(); return; }
        if (act === 'cancelconnect') { if (c.poll) c.poll.cancelled = true; c.dev = null; c.devExpiresAt = 0; _traktSetView('prompt'); return; }
        if (act === 'scrobble' || act === 'retry') { _traktBeginSubmit(); }
    }

    function traktShowPanel(snap) {
        const configured = !!(traktClientId() && traktSecret());
        traktMarkPrompted(snap.imdbId, configured ? 'shown' : 'needsconfig');   // survives reloads: no re-prompt for this movie for 12 h (a needsconfig record stops counting once keys are added)
        const el = document.createElement('div');
        el.id = 'sc-trakt-panel';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', 'Log this movie on Trakt');
        _traktPanelEl = el;
        _traktCtx = {
            snap, rating: 0, view: configured ? 'prompt' : 'needsconfig', message: '',
            remaining: TRAKT_PANEL_LIFETIME_MS, lifeTotal: TRAKT_PANEL_LIFETIME_MS,
            hover: false, dev: null, devExpiresAt: 0, poll: null, ratingFailed: false,
        };
        el.addEventListener('mouseenter', () => { if (_traktCtx) _traktCtx.hover = true; });
        el.addEventListener('mouseleave', () => { if (_traktCtx) _traktCtx.hover = false; });
        el.addEventListener('click', e => {
            if (!_traktCtx) return;
            const star = e.target.closest('[data-r]');
            if (star) {
                const n = parseInt(star.dataset.r, 10);
                _traktCtx.rating = _traktCtx.rating === n ? 0 : n;   // click the selected star again to clear
                _traktRender();
                return;
            }
            const a = e.target.closest('[data-act]');
            if (a) { e.preventDefault(); _traktOnAction(a.dataset.act); }
        });
        _traktKeyHandler = e => {
            if (e.key !== 'Escape' || !_traktCtx || _traktCtx.view === 'submitting') return;
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;   // don't steal Esc from chat/settings
            _traktOnAction('skip');
        };
        document.addEventListener('keydown', _traktKeyHandler);
        _traktHost().appendChild(el);
        _traktRender();
        _traktReposition();
        requestAnimationFrame(() => el.classList.add('sc-trakt-in'));
        _traktLifeTimer = setInterval(_traktLifeTick, TRAKT_LIFE_TICK_MS);
    }

    /* ==========================================================
       HEARTBEAT — same idiom as trivia-popup: poll shared state,
       re-read the settings every time (Save only writes localStorage).
    ========================================================== */
    function traktTick() {
        if (_traktPanelEl) return;
        const v = document.querySelector('#ytapiplayer video');   // strictly the player's own <video> (not preview/gif clones)
        if (!v) return;
        const p = traktLoadPrompted();
        const configured = !!(traktClientId() && traktSecret());
        const eligible = traktShouldPrompt({
            enabled: traktEnabled(),
            isYouTube: isYouTubeMedia(),
            isEpisode: !!((_npData && _npData.imdbId === _currentImdbId && _npData.episode != null) || (lastMovieTitle && parseMovieFilename(lastMovieTitle).isEpisode)),
            imdbId: _currentImdbId,
            duration: v.duration,
            currentTime: v.currentTime,
            thresholdPct: traktThreshold(),
            prompted: (p && p.outcome === 'needsconfig' && configured) ? null : p,
            now: Date.now(),
        });
        if (eligible) traktShowPanel(traktSnapshot());
    }

    function traktBoot() { setInterval(traktTick, TRAKT_POLL_MS); }
    scRegisterInit(traktBoot);

    /* ==========================================================
       SETTINGS ROWS — order 13-16 (12 is imdb-link-preview).
    ========================================================== */
    scRegisterSetting({
        id: 'sc-input-trakt-enabled',
        group: 'trakt-scrobble',
        label: 'Trakt: offer to log movies at the end',
        note: 'When you reach the end of a movie, a small card appears at the bottom-right of the video for a minute asking if you want to log the watch (and an optional rating) on trakt.tv. Off by default. Needs your own Trakt app credentials below. Movies only -- not YouTube or TV episodes.',
        key: LS_TRAKT_ENABLED,
        defaultOn: false,
        order: 13,
    });
    scRegisterSetting({
        id: 'sc-input-trakt-clientid',
        group: 'trakt-scrobble',
        type: 'text',
        label: 'Trakt Client ID',
        note: 'Create a Trakt app (any name; set the Redirect URI to urn:ietf:wg:oauth:2.0:oob), then paste its Client ID here.',
        key: LS_TRAKT_CLIENT_ID,
        placeholder: 'Paste Trakt Client ID…',
        testHandler: validateTraktClientId,
        testEmptyMessage: 'Enter a Client ID first',
        testValidMessage: '✓ Valid Client ID',
        testInvalidMessage: '✗ Invalid Client ID',
        testErrorMessage: '⚠ Couldn\'t reach Trakt',
        link: 'https://trakt.tv/oauth/applications',
        linkText: 'Create a Trakt app ↗',
        order: 14,
    });
    scRegisterSetting({
        id: 'sc-input-trakt-secret',
        group: 'trakt-scrobble',
        type: 'text',
        mask: true,
        label: 'Trakt Client Secret',
        note: 'From the same Trakt app page. Stored in this browser only, like the other keys. You sign in to Trakt from the pop-up card the first time it appears.',
        key: LS_TRAKT_SECRET,
        placeholder: 'Paste Trakt Client Secret…',
        order: 15,
    });
    scRegisterSetting({
        id: 'sc-input-trakt-threshold',
        group: 'trakt-scrobble',
        type: 'number',
        label: 'Trakt prompt point (% of the movie)',
        note: 'How far into the movie the card appears. 90 leaves room for the end credits; 100 waits for the very last second.',
        key: LS_TRAKT_THRESHOLD,
        min: TRAKT_THRESHOLD_MIN, max: TRAKT_THRESHOLD_MAX, step: 1, defaultValue: TRAKT_THRESHOLD_DEFAULT,
        order: 16,
    });
