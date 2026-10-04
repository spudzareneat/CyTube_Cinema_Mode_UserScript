    /* Standalone title watcher: CyTube media title -> IMDb id, the minimum the
       pop-up module needs (_currentImdbId, _npData.episode). Same parser
       (core/01-movie-identity.js) and IMDb search (shared/imdb-resolve.js) as
       the main script; none of its links/cards/TMDB. */
    const LS_PV_ID_CACHE = 'sc_popupvideo_ids_v2'; // { raw: { id, at } }; v1 ignored
    const PV_CACHE_MAX = 300;
    const PV_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
    const PV_RETRY_MS = 30000;
    let _pvIdCache = (() => {
        try { const c = JSON.parse(localStorage.getItem(LS_PV_ID_CACHE)); return c && typeof c === 'object' ? c : {}; } catch (e) { return {}; }
    })();
    let _pvSeq = 0;
    let _pvRetried = ''; // title that has already used its one failed-lookup retry

    function _pvRemember(raw, id) {
        delete _pvIdCache[raw]; // re-insert at the end so the cap evicts oldest first
        _pvIdCache[raw] = { id, at: Date.now() };
        const keys = Object.keys(_pvIdCache);
        if (keys.length > PV_CACHE_MAX) for (const k of keys.slice(0, keys.length - PV_CACHE_MAX)) delete _pvIdCache[k];
        try { localStorage.setItem(LS_PV_ID_CACHE, JSON.stringify(_pvIdCache)); } catch (e) {}
    }

    function _pvCachedId(raw) {
        if (!Object.prototype.hasOwnProperty.call(_pvIdCache, raw)) return null;
        const e = _pvIdCache[raw];
        if (!e || typeof e !== 'object' || !e.id || !(Date.now() - Number(e.at) < PV_CACHE_TTL_MS)) return null; // expired: re-resolve
        return e.id;
    }

    async function pvResolveImdbId(raw, parsed, knownSeconds) {
        const hit = _pvCachedId(raw);
        if (hit) return hit;
        if (!parsed || !parsed.title) return null;
        const m = await imdbSearchTitle(parsed.title, parsed.year, knownSeconds);
        if (!m || !m.tconst) return null; // not cached: a later visit may resolve
        let id = m.tconst;
        if (parsed.season != null && parsed.episode != null) {
            const ep = await fetchImdbEpisodeInfo(id, parsed.season, parsed.episode);
            if (!ep || !ep.tconst) return id; // series id for this session only -- not cached
            id = ep.tconst;
        }
        _pvRemember(raw, id);
        return id;
    }

    function _pvCleanTitle(t) {
        return String(t || '').replace(/^\s*(currently|now)\s+playing:\s*/i, '').trim();
    }

    // The mute toggle lives in CyTube's own video controls (#videocontrols,
    // next to reload / fullscreen / playlist / voteskip), styled like them.
    // trivia-popup calls these hooks instead of its own top-bar button code.
    // Own id, so the main module's #sc-trivia-popup-btn CSS never applies.
    // ── test marker: pv-button slice start ──
    const PV_BTN_ID = 'sc-pv-btn';
    function scPopupBtnMount(btn) {
        btn.id = PV_BTN_ID;
        btn.type = 'button';
        btn.className = 'btn btn-sm btn-default';
        const controls = document.getElementById('videocontrols');
        if (controls) controls.insertBefore(btn, controls.firstChild);
        else { btn.classList.add('sc-pv-floating'); document.body.appendChild(btn); }
    }
    function scPopupBtnPaint(btn, muted) {
        btn.innerHTML = '<span class="glyphicon glyphicon-info-sign"></span>';
        btn.title = muted ? 'Pop-up trivia muted — click to resume' : 'Pop-up trivia on — click to mute';
        btn.classList.toggle('active', !muted);
        btn.style.opacity = muted ? '0.55' : '';
    }
    // ── test marker: pv-button slice end ──

    // Opt-in diagnostics: localStorage.setItem('sc_popupvideo_debug', '1') and reload.
    const _pvDebug = (() => { try { return localStorage.getItem('sc_popupvideo_debug') === '1'; } catch (e) { return false; } })();
    function _pvLog(...args) { if (_pvDebug) console.log('[popupvideo]', ...args); }

    function _pvLookup(raw, seq) {
        const parsed = parseMovieFilename(raw);
        _pvLog('lookup start', { raw, seq, parsed });
        const failed = (err) => {
            _pvLog('lookup failed', { raw, seq, currentSeq: _pvSeq, retried: _pvRetried, err: err && String(err) });
            if (seq !== _pvSeq || _pvRetried === raw) return; // stale, or retry already used
            _pvRetried = raw;
            lastMovieTitle = ''; // let a fresh sighting of this title (DOM poll / socket) re-run it
            setTimeout(() => {
                // Only if nothing has happened since: same sequence, no new title recorded.
                if (seq !== _pvSeq || lastMovieTitle !== '') return;
                lastMovieTitle = raw;
                _pvLookup(raw, seq);
            }, PV_RETRY_MS);
        };
        pvResolveImdbId(raw, parsed, getCurrentMediaSeconds()).then(id => {
            _pvLog('lookup result', { raw, seq, currentSeq: _pvSeq, id });
            if (seq !== _pvSeq) return;
            if (!id) { failed(); return; }
            _npData = { episode: parsed && parsed.episode != null ? parsed.episode : null };
            _currentImdbId = id;
            if (typeof scRenderTriviaPopupBtn === 'function') {
                const btn = scRenderTriviaPopupBtn();
                _pvLog('button rendered', { id, inDom: !!(btn && btn.isConnected), parent: btn && btn.parentElement && btn.parentElement.id });
            }
        }).catch(err => failed(err));
    }

    // fromSocket: the changeMedia payload already set currentMediaType, so trust
    // it; only the DOM path has to ask isYouTubeMedia().
    function pvOnTitle(rawTitle, fromSocket) {
        const raw = _pvCleanTitle(rawTitle);
        if (!raw || /^nothing playing$/i.test(raw) || raw === lastMovieTitle) return;
        const youTube = fromSocket ? currentMediaType === 'yt' : isYouTubeMedia();
        _pvLog('title', { raw, fromSocket, youTube, mediaType: currentMediaType, previous: lastMovieTitle });
        lastMovieTitle = raw; // recorded even for YouTube so the DOM poll doesn't re-trigger it
        if (raw !== _pvRetried) _pvRetried = '';
        _currentImdbId = null;
        _npData = null;
        const old = document.getElementById(PV_BTN_ID);
        if (old) old.remove();
        const seq = ++_pvSeq;
        if (youTube) return; // bubbles never run on YouTube embeds
        _pvLookup(raw, seq);
    }

    // Selectors tried ONE AT A TIME in priority order. A single comma-list query
    // returns the first match in document order -- on stock CyTube that's the
    // empty "make video smaller" glyph <span> ahead of #currenttitle in
    // #videowrap-header, which left the DOM fallback always blank (found live).
    // ── test marker: pv-title slice start ──
    const PV_TITLE_SELECTORS = ['#currenttitle', '#videowrap-header .pull-left', '#videowrap-header span', '.video-title'];
    function _pvDomTitle() {
        for (const sel of PV_TITLE_SELECTORS) {
            const el = document.querySelector(sel);
            const text = el && el.textContent && el.textContent.trim();
            if (text) return text;
        }
        return '';
    }
    // ── test marker: pv-title slice end ──

    function pvWatcherBoot() {
        // Socket first (authoritative title + duration), DOM title as fallback / for
        // a page loaded mid-movie. Bound at load and again 2s later in case CyTube's
        // socket isn't up yet (same pattern as the main script's media watcher).
        let bound = false;
        const bind = () => {
            const s = (typeof socket !== 'undefined' && socket) || window.socket;
            if (bound || !s || typeof s.on !== 'function') { if (!bound) _pvLog('socket not available yet'); return; }
            bound = true;
            _pvLog('socket bound');
            s.on('changeMedia', data => {
                _pvLog('changeMedia', { type: data && data.type, title: data && data.title, seconds: data && data.seconds });
                currentMediaSeconds = Number(data && data.seconds) || 0;
                currentMediaType = (data && data.type) || '';
                if (data && data.title) pvOnTitle(data.title, true);
            });
        };
        _pvLog('boot', { readyState: document.readyState, domTitle: _pvDomTitle(), controls: !!document.getElementById('videocontrols') });
        // CyTube's socket can come up after `load`; keep trying (every 0.5s, up to
        // 20s) so we're listening for the NEXT media change. The current one is
        // covered by the DOM title poll below.
        bind();
        let bindTries = 0;
        const bindTimer = setInterval(() => { bind(); if (bound || ++bindTries >= 40) clearInterval(bindTimer); }, 500);
        // CyTube / channel scripts can re-render #videocontrols and drop the toggle
        // (seen live: present after a reload, gone later in the same session).
        // While a movie is identified, put it back if it's missing; the module's
        // own mute state carries over because scRenderTriviaPopupBtn repaints it.
        setInterval(() => {
            if (_currentImdbId && !document.getElementById(PV_BTN_ID) && typeof scRenderTriviaPopupBtn === 'function') {
                _pvLog('button missing — re-adding', { id: _currentImdbId });
                scRenderTriviaPopupBtn();
            }
        }, 3000);
        pvOnTitle(_pvDomTitle(), false);
        let polls = 0;
        const poll = setInterval(() => { pvOnTitle(_pvDomTitle(), false); if (++polls >= 14) clearInterval(poll); }, 1500);
    }
    scRegisterInit(pvWatcherBoot);
