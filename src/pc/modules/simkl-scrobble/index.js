    /* ==========================================================
       SIMKL SCROBBLE — end-of-movie "log this on Simkl?" panel.

       When playback of a movie passes a configurable share of its
       runtime (default 90%), a dark, semi-transparent card appears at
       the bottom-right of the video for one minute offering to record
       the watch (and an optional 1-10 rating) on trakt.tv. Everything
       is configured in the Settings modal: an opt-in toggle, the
       user's own Simkl app Client ID + Secret, and the threshold, all
       under one "Simkl" section. Its "Test connection" button saves the
       typed credentials, validates the Client ID and runs the Simkl
       sign-in (device code) inline, ending in "Connected as <user>".
       Alt+S opens the card for the current movie at any time (handy for
       testing; pressing it again closes it) -- a "manual" card, which
       doesn't touch the already-handled slot unless it scrobbles.

       Movies only (matched by the IMDb id movie-title-links resolves:
       _currentImdbId / _npData); YouTube items are skipped. Auth is
       Simkl's device-code flow, done inline in the panel. The watch is
       sent as a one-shot POST /sync/history (not the live
       /scrobble/start|pause|stop session API -- we only ask after the
       fact), and the "already handled" state lives in localStorage
       (single slot, 12 h TTL) so reloads during the credits don't
       re-prompt.

       Like trivia-popup, settings here are poll-per-use: Save just
       writes localStorage, so the heartbeat re-reads them each tick.

       Layout of this file: LS keys -> helpers slice (pure, unit-tested)
       -> client slice (Simkl HTTP/token/device-auth, unit-tested with a
       fake GM_xmlhttpRequest) -> panel + heartbeat -> settings rows.
       scripts/test-simkl-scrobble.mjs slices the two test-marker
       regions out of this file.
    ========================================================== */

    // ── test marker: simkl-helpers slice start ──
    const LS_SIMKL_ENABLED   = 'sc_simkl_enabled';        // 'on' = opted in (off by default)
    const LS_SIMKL_CLIENT_ID = 'sc_simkl_client_id';
    const LS_SIMKL_SECRET    = 'sc_simkl_client_secret';
    const LS_SIMKL_THRESHOLD = 'sc_simkl_threshold';      // percent of runtime, 50-100
    const LS_SIMKL_TOKEN     = 'sc_simkl_token';          // JSON {access, refresh, expiresAt, clientId}
    const LS_SIMKL_PROMPTED  = 'sc_simkl_prompted';       // JSON {imdbId, ts, outcome} -- single slot

    const SIMKL_THRESHOLD_MIN     = 50;
    const SIMKL_THRESHOLD_MAX     = 100;
    const SIMKL_THRESHOLD_DEFAULT = 90;
    const SIMKL_MIN_DURATION_SEC  = 10 * 60;              // ignore shorts / bumpers
    const SIMKL_PROMPT_TTL_MS     = 12 * 60 * 60 * 1000;  // don't re-ask about the same movie within 12 h
    const SIMKL_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;  // refresh the token when < 1 day from expiry
    const SIMKL_PANEL_LIFETIME_MS = 60 * 1000;            // how long the prompt stays up
    const SIMKL_SUCCESS_MS        = 6 * 1000;             // how long the "Logged" confirmation stays up
    const SIMKL_PANEL_INSET       = { right: 16, bottom: 56 }; // px from the video's corner; bottom clears the control bar

    function simklClampThreshold(raw) {
        const n = parseInt(raw, 10);
        const v = Number.isFinite(n) ? n : SIMKL_THRESHOLD_DEFAULT;
        return Math.min(SIMKL_THRESHOLD_MAX, Math.max(SIMKL_THRESHOLD_MIN, v));
    }

    function _simklEsc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // True once playback has reached thresholdPct % of a known, positive duration.
    function simklPastThreshold(currentTime, duration, thresholdPct) {
        return Number.isFinite(duration) && duration > 0 && Number.isFinite(currentTime) && currentTime >= 0
            && currentTime / duration >= thresholdPct / 100;
    }

    // The manual-card hotkey: a bare Alt+S (physical key, so layouts / Alt-composed characters don't matter).
    function simklIsHotkey(e) {
        return !!e && e.altKey === true && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyS';
    }

    // s = { enabled, isYouTube, isEpisode, imdbId, duration, currentTime, thresholdPct, prompted, now }
    function simklShouldPrompt(s) {
        if (!s.enabled || s.isYouTube || s.isEpisode || !s.imdbId) return false;
        if (!Number.isFinite(s.duration) || s.duration < SIMKL_MIN_DURATION_SEC) return false;
        if (!simklPastThreshold(s.currentTime, s.duration, s.thresholdPct)) return false;
        const p = s.prompted;
        if (p && p.imdbId === s.imdbId && s.now - p.ts < SIMKL_PROMPT_TTL_MS) return false;
        return true;
    }

    function simklUsableToken(token, clientId) {
        return (token && token.access && clientId && token.clientId === clientId) ? token : null;
    }

    function simklTokenNeedsRefresh(token, nowMs) {
        return !!token && Number.isFinite(token.expiresAt) && nowMs >= token.expiresAt - SIMKL_REFRESH_WINDOW_MS;
    }

    // Simkl's token response: { access_token, refresh_token, expires_in (s), created_at (unix s), ... }
    function simklTokenFromResponse(json, clientId, nowMs) {
        const createdMs = Number.isFinite(json.created_at) ? json.created_at * 1000 : nowMs;
        return { access: json.access_token, refresh: json.refresh_token, expiresAt: createdMs + json.expires_in * 1000, clientId };
    }

    function simklBuildHistoryPayload(snap, nowIso) {
        return { movies: [{ watched_at: nowIso, ids: { imdb: snap.imdbId } }] };
    }

    function simklBuildRatingPayload(snap, rating, nowIso) {
        return { movies: [{ rated_at: nowIso, rating, ids: { imdb: snap.imdbId } }] };
    }

    // Simkl's /sync/* reply: { added: { movies: n }, not_found: { movies: [...] } }
    function simklInterpretSyncResponse(json) {
        const nf = json && json.not_found && json.not_found.movies;
        if (nf && nf.length) return 'not_found';
        const added = json && json.added && json.added.movies;
        return added > 0 ? 'added' : 'unknown';
    }

    function simklTickLifetime(remainingMs, dtMs, paused) {
        return paused ? remainingMs : Math.max(0, remainingMs - dtMs);
    }

    // rect = the video's getBoundingClientRect() (or null); viewport = { width, height } of the visible
    // viewport. Returns CSS `right`/`bottom` px for a position:fixed box so it hugs the rect's bottom-right.
    function simklPanelPosition(rect, viewport) {
        const right  = rect ? viewport.width  - rect.right  : 0;
        const bottom = rect ? viewport.height - rect.bottom : 0;
        return {
            right:  Math.max(0, Math.round(right))  + SIMKL_PANEL_INSET.right,
            bottom: Math.max(0, Math.round(bottom)) + SIMKL_PANEL_INSET.bottom,
        };
    }
    // ── test marker: simkl-helpers slice end ──

    // ── test marker: simkl-client slice start ──
    const SIMKL_API          = 'https://api.trakt.tv';
    const SIMKL_OOB_REDIRECT = 'urn:ietf:wg:oauth:2.0:oob';

    const simklEnabled   = () => getKey(LS_SIMKL_ENABLED) === 'on';   // opt-in
    const simklThreshold = () => simklClampThreshold(getKey(LS_SIMKL_THRESHOLD));
    const simklClientId  = () => getKey(LS_SIMKL_CLIENT_ID);
    const simklSecret    = () => getKey(LS_SIMKL_SECRET);

    // Resolves { status, json } for any HTTP response (json is null when the body isn't JSON);
    // rejects only on a network error / timeout. `opts.clientId` overrides the saved Client ID
    // (used by the Settings "Test" button, which validates the value currently typed in the box).
    function simklRequest(method, path, opts = {}) {
        const { body, token, clientId } = opts;
        return new Promise((resolve, reject) => {
            const headers = {
                'Content-Type': 'application/json',
                'simkl-api-version': '2',
                'simkl-api-key': clientId || simklClientId(),
            };
            if (token && token.access) headers['Authorization'] = 'Bearer ' + token.access;
            GM_xmlhttpRequest({
                method,
                url: SIMKL_API + path,
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
    // simkl-api-key. 200 = key accepted, 401/403 = rejected, anything else = couldn't tell.
    async function validateSimklClientId(clientId) {
        try {
            const res = await simklRequest('GET', '/movies/trending?limit=1', { clientId });
            if (res.status === 200) return 'valid';
            if (res.status === 401 || res.status === 403) return 'invalid';
            return 'error';
        } catch (e) { return 'error'; }
    }

    function simklLoadToken() { try { return JSON.parse(localStorage.getItem(LS_SIMKL_TOKEN)); } catch (e) { return null; } }
    function simklSaveToken(t) { try { localStorage.setItem(LS_SIMKL_TOKEN, JSON.stringify(t)); } catch (e) {} }
    function simklClearToken() { try { localStorage.removeItem(LS_SIMKL_TOKEN); } catch (e) {} }

    function simklLoadPrompted() { try { return JSON.parse(localStorage.getItem(LS_SIMKL_PROMPTED)); } catch (e) { return null; } }
    // outcome: 'shown' (panel appeared -- also what an auto-dismiss leaves behind) | 'skipped' | 'scrobbled' | 'needsconfig' (card shown but keys missing; ignored once keys exist)
    function simklMarkPrompted(imdbId, outcome) {
        try { localStorage.setItem(LS_SIMKL_PROMPTED, JSON.stringify({ imdbId, ts: Date.now(), outcome })); } catch (e) {}
    }

    // Device flow step 1. Resolves { device_code, user_code, verification_url, expires_in, interval }; throws on failure.
    async function simklStartDeviceAuth() {
        const res = await simklRequest('POST', '/oauth/device/code', { body: { client_id: simklClientId() } });
        if (res.status !== 200 || !res.json || !res.json.device_code) throw new Error('device-code HTTP ' + res.status);
        return res.json;
    }

    // Device flow step 2: polls at Simkl's interval until approved / denied / expired / cancelled.
    // `handle` is { cancelled: boolean } -- set it true to stop. `sleep` is injectable for tests.
    // Saves the token and resolves 'ok' on success; else 'denied' | 'expired' | 'cancelled' | 'error'.
    async function simklPollDeviceToken(dev, handle, sleep = ms => new Promise(r => setTimeout(r, ms))) {
        let intervalMs = Math.max(1, dev.interval || 5) * 1000;
        const deadline = Date.now() + dev.expires_in * 1000;
        while (!handle.cancelled && Date.now() < deadline) {
            await sleep(intervalMs);
            if (handle.cancelled) break;
            let res;
            try {
                res = await simklRequest('POST', '/oauth/device/token',
                    { body: { code: dev.device_code, client_id: simklClientId(), client_secret: simklSecret() } });
            } catch (e) { continue; }                                   // transient network error: keep polling until expiry
            if (res.status === 200 && res.json && res.json.access_token) {
                simklSaveToken(simklTokenFromResponse(res.json, simklClientId(), Date.now()));
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
    async function simklRefreshToken(token) {
        try {
            const res = await simklRequest('POST', '/oauth/token', {
                body: {
                    refresh_token: token.refresh, client_id: simklClientId(), client_secret: simklSecret(),
                    redirect_uri: SIMKL_OOB_REDIRECT, grant_type: 'refresh_token',
                },
            });
            if (res.status === 200 && res.json && res.json.access_token) {
                const fresh = simklTokenFromResponse(res.json, simklClientId(), Date.now());
                simklSaveToken(fresh);
                return fresh;
            }
            if (res.status === 400 || res.status === 401 || res.status === 403) simklClearToken();
        } catch (e) {}
        return null;
    }

    // A token that can be used right now, or null (=> the panel must run Connect).
    async function simklEnsureToken() {
        const token = simklUsableToken(simklLoadToken(), simklClientId());
        if (!token) return null;
        if (simklTokenNeedsRefresh(token, Date.now())) {
            const fresh = await simklRefreshToken(token);
            if (fresh) return fresh;
            if (!simklLoadToken()) return null;                 // refresh was rejected and the token was cleared
            if (Date.now() >= token.expiresAt) return null;     // hard-expired and couldn't refresh
        }
        return token;                                           // near expiry but refresh failed transiently: still valid
    }

    // 'auth' (=> Connect) only when no usable token remains stored; if one is still there the failed
    // token/refresh step was transient (network, timeout, 5xx), so report 'error' and let Retry work.
    const simklNoTokenResult = () => ({
        result: simklUsableToken(simklLoadToken(), simklClientId()) ? 'error' : 'auth',
        ratingFailed: false,
    });

    // Logs the watch (+ rating). Resolves { result, ratingFailed }; result is
    // 'added' | 'not_found' | 'auth' (needs Connect) | 'error'. A failed rating never fails the watch.
    // NOTE: a Retry after a lost *response* can log the watch twice -- Simkl doesn't dedupe history adds.
    async function simklSubmit(snap, rating) {
        let token = await simklEnsureToken();
        if (!token) return simklNoTokenResult();
        const nowIso = new Date().toISOString();
        const post = (path, body) => simklRequest('POST', path, { body, token });
        try {
            let res = await post('/sync/history', simklBuildHistoryPayload(snap, nowIso));
            if (res.status === 401) {                           // token rejected: one refresh, one retry
                token = await simklRefreshToken(token);
                if (!token) return simklNoTokenResult();
                res = await post('/sync/history', simklBuildHistoryPayload(snap, nowIso));
            }
            if (res.status !== 200 && res.status !== 201) return { result: 'error', ratingFailed: false };
            const verdict = simklInterpretSyncResponse(res.json);
            if (verdict === 'not_found') return { result: 'not_found', ratingFailed: false };
            if (verdict !== 'added') return { result: 'error', ratingFailed: false };
            let ratingFailed = false;
            if (rating) {
                try {
                    const rr = await post('/sync/ratings', simklBuildRatingPayload(snap, rating, nowIso));
                    ratingFailed = !((rr.status === 200 || rr.status === 201) && simklInterpretSyncResponse(rr.json) === 'added');
                } catch (e) { ratingFailed = true; }
            }
            return { result: 'added', ratingFailed };
        } catch (e) {
            return { result: 'error', ratingFailed: false };
        }
    }

    // The signed-in account's username (proves the token works end to end), or null on any failure.
    async function simklFetchUsername(token) {
        try {
            const res = await simklRequest('GET', '/users/settings', { token });
            const name = res.status === 200 && res.json && res.json.user && res.json.user.username;
            return (typeof name === 'string' && name) ? name : null;
        } catch (e) { return null; }
    }

    // The Settings "Test connection" flow: saves the typed credentials, validates the Client ID, then
    // either confirms the stored token or runs a device sign-in right in the row. `ctx` is the settings
    // shell's action context ({ getValue, setStatus, setDetail, isOpen }); `handle` is { cancelled };
    // `sleep` is injectable for tests and forwarded to the poll.
    async function simklConnectAndVerify(ctx, handle, sleep) {
        const clientId = ctx.getValue('sc-input-simkl-clientid');
        const secret = ctx.getValue('sc-input-simkl-secret');
        if (!clientId || !secret) { ctx.setStatus('Enter your Client ID and Client Secret first', 'bad'); return; }
        setKey(LS_SIMKL_CLIENT_ID, clientId);
        setKey(LS_SIMKL_SECRET, secret);
        ctx.setDetail('');
        ctx.setStatus('Checking Client ID…', 'pending');
        const v = await validateSimklClientId(clientId);
        if (v === 'invalid') { ctx.setStatus('✗ Client ID rejected by Simkl', 'bad'); return; }
        if (v === 'error')   { ctx.setStatus('⚠ Couldn\'t reach Simkl', 'bad'); return; }

        ctx.setStatus('Checking sign-in…', 'pending');
        const token = await simklEnsureToken();
        if (token) {
            const name = await simklFetchUsername(token);
            if (name) { ctx.setStatus('✓ Connected as ' + name, 'ok'); return; }
        }

        let dev;
        try { dev = await simklStartDeviceAuth(); }
        catch (e) { ctx.setStatus('✗ Couldn\'t start sign-in — check the Client ID', 'bad'); return; }
        const url = /^https?:\/\//.test(dev.verification_url) ? dev.verification_url : 'https://trakt.tv/activate';
        const shown = url.replace(/^https?:\/\//, '');
        ctx.setDetail(`<div class="sc-simkl-set-code">${_simklEsc(dev.user_code)}</div><div>Open <a class="sc-settings-link" href="${_simklEsc(url)}" target="_blank" rel="noopener">${_simklEsc(shown)}</a> and enter the code above.</div>`);

        const expiresAt = Date.now() + dev.expires_in * 1000;
        const tick = () => {
            const secs = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
            const m = Math.floor(secs / 60);
            const ss = String(secs % 60).padStart(2, '0');
            ctx.setStatus('Waiting for approval… ' + m + ':' + ss, 'pending');
        };
        tick();
        const iv = setInterval(tick, 1000);
        let r;
        try {
            const wrappedSleep = ms => {
                if (!ctx.isOpen()) { handle.cancelled = true; return Promise.resolve(); }   // Settings closed mid-wait: stop polling
                return sleep ? sleep(ms) : new Promise(res => setTimeout(res, ms));
            };
            r = await simklPollDeviceToken(dev, handle, wrappedSleep);
        } finally { clearInterval(iv); }

        ctx.setDetail('');
        if (r === 'cancelled')    ctx.setStatus('Cancelled');
        else if (r === 'denied')  ctx.setStatus('✗ Sign-in was denied', 'bad');
        else if (r === 'expired') ctx.setStatus('✗ Code expired — click Test again', 'bad');
        else if (r === 'error')   ctx.setStatus('✗ Sign-in failed — check the Client Secret', 'bad');
        else if (r === 'ok') {
            const name = await simklFetchUsername(simklLoadToken());
            ctx.setStatus(name ? '✓ Connected as ' + name : '✓ Connected', 'ok');
        }
    }
    // ── test marker: simkl-client slice end ──

    /* ==========================================================
       PANEL — #sc-simkl-panel, a single card whose body is re-rendered
       per view: 'prompt' | 'submitting' | 'success' | 'notfound' |
       'error' | 'connect' | 'needsconfig' | 'nomatch' (manual Alt+S card
       with no IMDb match yet). Events are delegated from
       the card itself (data-act / data-r), so re-rendering the body
       never needs re-binding.
    ========================================================== */
    const SIMKL_POLL_MS = 3000;   // heartbeat: decides when the movie has reached the prompt point
    const SIMKL_LIFE_TICK_MS = 250;

    let _simklPanelEl    = null;  // live panel node, or null when closed
    let _simklCtx        = null;  // { snap, manual, rating, view, message, remaining, lifeTotal, hover, dev, devExpiresAt, poll, ratingFailed }
    let _simklLifeTimer  = null;
    let _simklKeyHandler = null;

    // Everything the panel needs about the movie, captured once at trigger time so a queue advance
    // while the card is open can't change what gets submitted.
    function simklSnapshot() {
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
    function _simklHost() {
        const fs = document.fullscreenElement;
        return (fs && fs.tagName !== 'VIDEO') ? fs : document.body;
    }

    // Pins the card to the bottom-right of the video (or #videowrap, else the viewport corner).
    // Runs every life tick, so window resizes / chat-panel drags / fullscreen changes are followed.
    function _simklReposition() {
        if (!_simklPanelEl) return;
        const host = _simklHost();
        if (_simklPanelEl.parentNode !== host) host.appendChild(_simklPanelEl);
        const v = document.querySelector('#ytapiplayer video');
        const wrap = document.getElementById('videowrap');
        let r = (v && v.getBoundingClientRect()) || null;
        if (!r || r.width <= 0 || r.height <= 0) r = (wrap && wrap.getBoundingClientRect()) || null;
        if (r && (r.width <= 0 || r.height <= 0)) r = null;
        const pos = simklPanelPosition(r, { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight });
        _simklPanelEl.style.setProperty('right', pos.right + 'px', 'important');
        _simklPanelEl.style.setProperty('bottom', pos.bottom + 'px', 'important');
    }

    function _simklStars(rating) {
        let out = '';
        for (let i = 1; i <= 10; i++) {
            out += `<button type="button" class="sc-simkl-star${i <= rating ? ' on' : ''}" data-r="${i}" aria-label="Rate ${i} out of 10">★</button>`;
        }
        return out;
    }

    function _simklPaintLife() {
        const bar = _simklPanelEl && _simklPanelEl.querySelector('.sc-simkl-life-bar');
        if (bar && _simklCtx) bar.style.setProperty('width', Math.max(0, Math.min(100, _simklCtx.remaining / _simklCtx.lifeTotal * 100)) + '%', 'important');
    }

    function _simklRender() {
        const c = _simklCtx, el = _simklPanelEl;
        if (!c || !el) return;
        const s = c.snap;
        const title = `${_simklEsc(s.title)}${s.year ? ` <span class="sc-simkl-year">(${_simklEsc(s.year)})</span>` : ''}`;
        const poster = s.poster
            ? `<img class="sc-simkl-poster" src="${_simklEsc(s.poster)}" alt="" />`
            : '<div class="sc-simkl-poster sc-simkl-noposter">🎬</div>';
        let body = '';
        switch (c.view) {
            case 'prompt':
                body = `
                    <div class="sc-simkl-q">${c.manual ? 'Log this movie on Simkl?' : 'You reached the end. Log it on Simkl?'}</div>
                    <div class="sc-simkl-stars" role="group" aria-label="Optional rating">${_simklStars(c.rating)}</div>
                    <div class="sc-simkl-rating-label">${c.rating ? c.rating + ' / 10' : 'Optional rating'}</div>
                    <div class="sc-simkl-actions">
                        <button type="button" class="sc-simkl-btn sc-simkl-primary" data-act="scrobble">Scrobble to Simkl</button>
                        <button type="button" class="sc-simkl-btn" data-act="skip">Not now</button>
                    </div>
                    ${simklLoadToken() ? '<a href="#" class="sc-simkl-link" data-act="disconnect">Disconnect Simkl</a>' : ''}`;
                break;
            case 'submitting':
                body = '<div class="sc-simkl-q">Logging to Simkl…</div>';
                break;
            case 'success':
                body = `
                    <div class="sc-simkl-q sc-simkl-ok">Logged ✓${c.ratingFailed ? ' <span class="sc-simkl-note">(rating didn\'t save)</span>' : ''}</div>
                    <a class="sc-simkl-link" href="https://trakt.tv/search/imdb/${_simklEsc(s.imdbId)}" target="_blank" rel="noopener">View on Simkl ↗</a>`;
                break;
            case 'notfound':
                body = `
                    <div class="sc-simkl-q sc-simkl-bad">Simkl couldn't match this movie.</div>
                    <div class="sc-simkl-actions"><button type="button" class="sc-simkl-btn" data-act="skip">Close</button></div>`;
                break;
            case 'error':
                body = `
                    <div class="sc-simkl-q sc-simkl-bad">${_simklEsc(c.message || 'Something went wrong.')}</div>
                    <div class="sc-simkl-actions">
                        <button type="button" class="sc-simkl-btn sc-simkl-primary" data-act="retry">Retry</button>
                        <button type="button" class="sc-simkl-btn" data-act="skip">Close</button>
                    </div>`;
                break;
            case 'connect':
                body = c.dev ? `
                    <div class="sc-simkl-q">Connect your Simkl account</div>
                    <div class="sc-simkl-help">Open <a class="sc-simkl-link" href="${_simklEsc(c.dev.verification_url)}" target="_blank" rel="noopener">${_simklEsc(String(c.dev.verification_url).replace(/^https?:\/\//, ''))}</a> and enter:</div>
                    <div class="sc-simkl-code">${_simklEsc(c.dev.user_code)}</div>
                    <div class="sc-simkl-help">Waiting for approval… <span class="sc-simkl-expiry"></span></div>
                    <div class="sc-simkl-actions"><button type="button" class="sc-simkl-btn" data-act="cancelconnect">Cancel</button></div>`
                : '<div class="sc-simkl-q">Contacting Simkl…</div>';
                break;
            case 'needsconfig':
                body = `
                    <div class="sc-simkl-q">Simkl isn't set up yet</div>
                    <div class="sc-simkl-help">Add your Simkl Client ID and Secret in Settings to log movies.</div>
                    <div class="sc-simkl-actions">
                        <button type="button" class="sc-simkl-btn sc-simkl-primary" data-act="settings">Open Settings</button>
                        <button type="button" class="sc-simkl-btn" data-act="skip">Dismiss</button>
                    </div>`;
                break;
            case 'nomatch':
                body = '<div class="sc-simkl-q">No movie matched yet</div><div class="sc-simkl-help">Nothing to log yet — wait for the Now Playing card to identify the movie (YouTube videos can\'t be logged).</div><div class="sc-simkl-actions"><button type="button" class="sc-simkl-btn" data-act="skip">Close</button></div>';
                break;
        }
        el.innerHTML = `
            <div class="sc-simkl-row">
                ${poster}
                <div class="sc-simkl-main">
                    <div class="sc-simkl-title">${title}</div>
                    ${body}
                </div>
            </div>
            <div class="sc-simkl-life"><div class="sc-simkl-life-bar"></div></div>`;
        _simklPaintLife();
    }

    // opts.life (ms) restarts the countdown for the new view; opts.message feeds the 'error' view.
    function _simklSetView(view, opts = {}) {
        const c = _simklCtx;
        if (!c) return;
        c.view = view;
        c.message = opts.message || '';
        if (opts.life) { c.remaining = opts.life; c.lifeTotal = opts.life; }
        _simklRender();
    }

    function _simklLifeTick() {
        const c = _simklCtx;
        if (!c || !_simklPanelEl) return;
        const paused = (c.hover && c.view !== 'success') || c.view === 'submitting' || c.view === 'connect';
        c.remaining = simklTickLifetime(c.remaining, SIMKL_LIFE_TICK_MS, paused);
        _simklReposition();
        _simklPaintLife();
        const exp = _simklPanelEl.querySelector('.sc-simkl-expiry');
        if (exp && c.devExpiresAt) {
            const secs = Math.max(0, Math.round((c.devExpiresAt - Date.now()) / 1000));
            exp.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
        }
        if (c.remaining <= 0) simklClosePanel();   // auto-dismiss: the 'shown' outcome recorded at show time stands
    }

    function simklClosePanel() {
        const el = _simklPanelEl, c = _simklCtx;
        if (c && c.poll) c.poll.cancelled = true;
        clearInterval(_simklLifeTimer); _simklLifeTimer = null;
        if (_simklKeyHandler) { document.removeEventListener('keydown', _simklKeyHandler); _simklKeyHandler = null; }
        _simklCtx = null; _simklPanelEl = null;
        if (el) {
            el.classList.remove('sc-simkl-in');
            el.classList.add('sc-simkl-out');
            setTimeout(() => el.remove(), 350);
        }
    }

    async function _simklBeginConnect() {
        const c = _simklCtx;
        if (!c) return;
        _simklSetView('connect');                        // no c.dev yet -> "Contacting Simkl…"
        let dev;
        try { dev = await simklStartDeviceAuth(); }
        catch (e) {
            if (_simklCtx !== c) return;
            _simklSetView('error', { message: 'Couldn\'t start Simkl sign-in. Check your Client ID in Settings.', life: SIMKL_PANEL_LIFETIME_MS });
            return;
        }
        if (_simklCtx !== c) return;
        c.dev = dev;
        c.devExpiresAt = Date.now() + dev.expires_in * 1000;
        c.poll = { cancelled: false };
        _simklSetView('connect');
        const r = await simklPollDeviceToken(dev, c.poll);
        if (_simklCtx !== c || r === 'cancelled') return;
        c.dev = null; c.devExpiresAt = 0; c.poll = null;
        if (r === 'ok') { _simklBeginSubmit(); return; }
        const message = r === 'denied' ? 'Simkl sign-in was denied.'
            : r === 'expired' ? 'The code expired -- try again.'
            : 'Simkl sign-in failed. Check your Client Secret in Settings.';
        _simklSetView('error', { message, life: SIMKL_PANEL_LIFETIME_MS });
    }

    async function _simklBeginSubmit() {
        const c = _simklCtx;
        if (!c) return;
        if (!simklUsableToken(simklLoadToken(), simklClientId())) { _simklBeginConnect(); return; }
        _simklSetView('submitting');
        const out = await simklSubmit(c.snap, c.rating);
        if (_simklCtx !== c) return;                     // panel was closed while we waited
        if (out.result === 'added') {
            simklMarkPrompted(c.snap.imdbId, 'scrobbled');
            c.ratingFailed = out.ratingFailed;
            _simklSetView('success', { life: SIMKL_SUCCESS_MS });
        } else if (out.result === 'not_found') {
            _simklSetView('notfound', { life: SIMKL_PANEL_LIFETIME_MS });
        } else if (out.result === 'auth') {
            _simklBeginConnect();
        } else {
            _simklSetView('error', { message: 'Couldn\'t reach Simkl -- try again.', life: SIMKL_PANEL_LIFETIME_MS });
        }
    }

    function _simklOnAction(act) {
        const c = _simklCtx;
        if (!c) return;
        if (act === 'skip')          { if (!c.manual) simklMarkPrompted(c.snap.imdbId, 'skipped'); simklClosePanel(); return; }
        if (act === 'settings')      { simklClosePanel(); openSettingsModal(); return; }
        if (act === 'disconnect')    { simklClearToken(); _simklRender(); return; }
        if (act === 'cancelconnect') { if (c.poll) c.poll.cancelled = true; c.dev = null; c.devExpiresAt = 0; _simklSetView('prompt'); return; }
        if (act === 'scrobble' || act === 'retry') { _simklBeginSubmit(); }
    }

    // opts.manual = opened by the Alt+S hotkey (any time, any progress). A manual card records nothing in the
    // prompted slot -- except when the movie is already past the prompt point, where it records 'shown' (or
    // 'needsconfig' when the keys are missing, which stops counting once keys exist) so the auto card doesn't
    // re-pop 3 s after a manual Esc. A successful scrobble still records 'scrobbled'.
    function simklShowPanel(snap, opts = {}) {
        const manual = !!(opts && opts.manual);
        const configured = !!(simklClientId() && simklSecret());
        if (!manual) {
            simklMarkPrompted(snap.imdbId, configured ? 'shown' : 'needsconfig');   // survives reloads: no re-prompt for this movie for 12 h (a needsconfig record stops counting once keys are added)
        } else if (snap.imdbId) {
            const v = document.querySelector('#ytapiplayer video');
            if (v && simklPastThreshold(v.currentTime, v.duration, simklThreshold())) simklMarkPrompted(snap.imdbId, configured ? 'shown' : 'needsconfig');
        }
        const el = document.createElement('div');
        el.id = 'sc-simkl-panel';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', 'Log this movie on Simkl');
        _simklPanelEl = el;
        _simklCtx = {
            snap, manual, rating: 0,
            view: !configured ? 'needsconfig' : (manual && !snap.imdbId) ? 'nomatch' : 'prompt', message: '',
            remaining: SIMKL_PANEL_LIFETIME_MS, lifeTotal: SIMKL_PANEL_LIFETIME_MS,
            hover: false, dev: null, devExpiresAt: 0, poll: null, ratingFailed: false,
        };
        el.addEventListener('mouseenter', () => { if (_simklCtx) _simklCtx.hover = true; });
        el.addEventListener('mouseleave', () => { if (_simklCtx) _simklCtx.hover = false; });
        el.addEventListener('click', e => {
            if (!_simklCtx) return;
            const star = e.target.closest('[data-r]');
            if (star) {
                const n = parseInt(star.dataset.r, 10);
                _simklCtx.rating = _simklCtx.rating === n ? 0 : n;   // click the selected star again to clear
                _simklRender();
                return;
            }
            const a = e.target.closest('[data-act]');
            if (a) { e.preventDefault(); _simklOnAction(a.dataset.act); }
        });
        _simklKeyHandler = e => {
            if (e.key !== 'Escape' || !_simklCtx || _simklCtx.view === 'submitting') return;
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;   // don't steal Esc from chat/settings
            _simklOnAction('skip');
        };
        document.addEventListener('keydown', _simklKeyHandler);
        _simklHost().appendChild(el);
        _simklRender();
        _simklReposition();
        requestAnimationFrame(() => el.classList.add('sc-simkl-in'));
        _simklLifeTimer = setInterval(_simklLifeTick, SIMKL_LIFE_TICK_MS);
    }

    /* ==========================================================
       HEARTBEAT — same idiom as trivia-popup: poll shared state,
       re-read the settings every time (Save only writes localStorage).
    ========================================================== */
    function simklTick() {
        if (_simklPanelEl) return;
        const v = document.querySelector('#ytapiplayer video');   // strictly the player's own <video> (not preview/gif clones)
        if (!v) return;
        const p = simklLoadPrompted();
        const configured = !!(simklClientId() && simklSecret());
        const eligible = simklShouldPrompt({
            enabled: simklEnabled(),
            isYouTube: isYouTubeMedia(),
            isEpisode: !!((_npData && _npData.imdbId === _currentImdbId && _npData.episode != null) || (lastMovieTitle && parseMovieFilename(lastMovieTitle).isEpisode)),
            imdbId: _currentImdbId,
            duration: v.duration,
            currentTime: v.currentTime,
            thresholdPct: simklThreshold(),
            prompted: (p && p.outcome === 'needsconfig' && configured) ? null : p,
            now: Date.now(),
        });
        if (eligible) simklShowPanel(simklSnapshot());
    }

    // Alt+S: opens the card for the current movie right now (handy for testing) or closes it if it's open.
    function simklManualTrigger() {
        if (_simklPanelEl) { simklClosePanel(); return; }
        simklShowPanel(simklSnapshot(), { manual: true });
    }

    function simklBoot() {
        setInterval(simklTick, SIMKL_POLL_MS);
        // Capture phase, and deliberately not ignored while typing in chat: Alt+S types nothing on Windows/Linux.
        document.addEventListener('keydown', e => {
            if (!simklIsHotkey(e) || e.repeat) return;
            if (!simklEnabled()) return;
            e.preventDefault();
            simklManualTrigger();
        }, true);
    }
    scRegisterInit(simklBoot);

    /* ==========================================================
       SETTINGS ROWS — order 13-18 (12 is imdb-link-preview): one Simkl
       section (header, enable toggle, Client ID, Client Secret, the
       "Test connection" action row, prompt-point threshold).
    ========================================================== */
    let _simklConnectHandle = null;   // { cancelled } of the in-flight Test connection run, or null

    scRegisterSetting({
        id: 'sc-section-simkl',
        group: 'simkl-scrobble',
        type: 'section',
        label: 'Simkl',
        note: 'Log movies you finish on trakt.tv. Uses your own Simkl app (Client ID + Secret). Press <b>Alt+S</b> any time to open the scrobble card for the current movie — handy for testing.',
        order: 13,
    });
    scRegisterSetting({
        id: 'sc-input-simkl-enabled',
        group: 'simkl-scrobble',
        label: 'Simkl: offer to log movies at the end',
        note: 'When you reach the end of a movie, a small card appears at the bottom-right of the video for a minute asking if you want to log the watch (and an optional rating) on trakt.tv. Off by default. Needs your own Simkl app credentials (fields below). Movies only -- not YouTube or TV episodes.',
        key: LS_SIMKL_ENABLED,
        defaultOn: false,
        order: 14,
    });
    scRegisterSetting({
        id: 'sc-input-simkl-clientid',
        group: 'simkl-scrobble',
        type: 'text',
        label: 'Simkl Client ID',
        note: 'Create a Simkl app (any name; set the Redirect URI to urn:ietf:wg:oauth:2.0:oob), then paste its Client ID here.',
        key: LS_SIMKL_CLIENT_ID,
        placeholder: 'Paste Simkl Client ID…',
        link: 'https://trakt.tv/oauth/applications',
        linkText: 'Create a Simkl app ↗',
        order: 15,
    });
    scRegisterSetting({
        id: 'sc-input-simkl-secret',
        group: 'simkl-scrobble',
        type: 'text',
        mask: true,
        label: 'Simkl Client Secret',
        note: 'From the same Simkl app page. Stored in this browser only, like the other keys. Press Test connection below to sign in to Simkl and verify it all works.',
        key: LS_SIMKL_SECRET,
        placeholder: 'Paste Simkl Client Secret…',
        order: 16,
    });
    scRegisterSetting({
        id: 'sc-action-simkl-test',
        group: 'simkl-scrobble',
        type: 'action',
        buttonLabel: 'Test connection',
        cancelLabel: 'Cancel',
        actionHandler: async (ctx) => {
            _simklConnectHandle = { cancelled: false };
            try { await simklConnectAndVerify(ctx, _simklConnectHandle); }
            finally { _simklConnectHandle = null; }
        },
        cancelHandler: () => { if (_simklConnectHandle) _simklConnectHandle.cancelled = true; },
        order: 17,
    });
    scRegisterSetting({
        id: 'sc-input-simkl-threshold',
        group: 'simkl-scrobble',
        type: 'number',
        label: 'Scrobble prompt point (% of the movie)',
        note: 'How far into the movie the card appears. 90 leaves room for the end credits; 100 waits for the very last second.',
        key: LS_SIMKL_THRESHOLD,
        min: SIMKL_THRESHOLD_MIN, max: SIMKL_THRESHOLD_MAX, step: 1, defaultValue: SIMKL_THRESHOLD_DEFAULT,
        order: 18,
    });
