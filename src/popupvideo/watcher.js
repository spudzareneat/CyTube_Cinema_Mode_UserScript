    /* Standalone title watcher: CyTube media title -> IMDb id, the minimum the
       pop-up module needs (_currentImdbId, _npData.episode). Same parser
       (core/01-movie-identity.js) and IMDb search (shared/imdb-resolve.js) as
       the main script; none of its links/cards/TMDB. */
    const LS_PV_ID_CACHE = 'sc_popupvideo_ids_v1';
    const PV_CACHE_MAX = 300;
    let _pvIdCache = (() => { try { return JSON.parse(localStorage.getItem(LS_PV_ID_CACHE)) || {}; } catch (e) { return {}; } })();
    let _pvSeq = 0;

    function _pvRemember(raw, id) {
        _pvIdCache[raw] = id;
        const keys = Object.keys(_pvIdCache);
        if (keys.length > PV_CACHE_MAX) for (const k of keys.slice(0, keys.length - PV_CACHE_MAX)) delete _pvIdCache[k];
        try { localStorage.setItem(LS_PV_ID_CACHE, JSON.stringify(_pvIdCache)); } catch (e) {}
    }

    async function pvResolveImdbId(raw, parsed, knownSeconds) {
        if (Object.prototype.hasOwnProperty.call(_pvIdCache, raw)) return _pvIdCache[raw];
        if (!parsed || !parsed.title) return null;
        const m = await imdbSearchTitle(parsed.title, parsed.year, knownSeconds);
        if (!m || !m.tconst) return null; // not cached: a later visit may resolve
        let id = m.tconst;
        if (parsed.season != null && parsed.episode != null) {
            const ep = await fetchImdbEpisodeInfo(id, parsed.season, parsed.episode);
            if (ep && ep.tconst) id = ep.tconst;
        }
        _pvRemember(raw, id);
        return id;
    }

    function _pvCleanTitle(t) {
        return String(t || '').replace(/^\s*(currently|now)\s+playing:\s*/i, '').trim();
    }

    function pvOnTitle(rawTitle) {
        const raw = _pvCleanTitle(rawTitle);
        if (!raw || /^nothing playing$/i.test(raw) || raw === lastMovieTitle) return;
        lastMovieTitle = raw;
        _currentImdbId = null;
        _npData = null;
        const old = document.getElementById('sc-trivia-popup-btn');
        if (old) old.remove();
        const seq = ++_pvSeq;
        if (isYouTubeMedia()) return; // bubbles never run on YouTube embeds
        const parsed = parseMovieFilename(raw);
        pvResolveImdbId(raw, parsed, getCurrentMediaSeconds()).then(id => {
            if (seq !== _pvSeq || !id) return;
            _npData = { episode: parsed && parsed.episode != null ? parsed.episode : null };
            _currentImdbId = id;
            if (typeof scRenderTriviaPopupBtn === 'function') scRenderTriviaPopupBtn();
        }).catch(() => {});
    }

    function _pvDomTitle() {
        const el = document.querySelector('#currenttitle, #videowrap-header .pull-left, #videowrap-header span, .video-title');
        return el ? el.textContent : '';
    }

    function pvWatcherBoot() {
        // Socket first (authoritative title + duration), DOM title as fallback / for
        // a page loaded mid-movie. Bound at load and again 2s later in case CyTube's
        // socket isn't up yet (same pattern as the main script's media watcher).
        let bound = false;
        const bind = () => {
            const s = (typeof socket !== 'undefined' && socket) || window.socket;
            if (bound || !s || typeof s.on !== 'function') return;
            bound = true;
            s.on('changeMedia', data => {
                currentMediaSeconds = Number(data && data.seconds) || 0;
                currentMediaType = (data && data.type) || '';
                if (data && data.title) pvOnTitle(data.title);
            });
        };
        bind();
        setTimeout(bind, 2000);
        pvOnTitle(_pvDomTitle());
        let polls = 0;
        const poll = setInterval(() => { pvOnTitle(_pvDomTitle()); if (++polls >= 14) clearInterval(poll); }, 1500);
    }
    scRegisterInit(pvWatcherBoot);
