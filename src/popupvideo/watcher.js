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

    // Pin the mute pill inside the video's top-right corner (stock CyTube's
    // fixed navbar holds login/logout at the page's top-right).
    function _pvPlaceBtn() {
        const btn = document.getElementById('sc-trivia-popup-btn');
        if (!btn) return;
        const w = document.getElementById('videowrap');
        const r = w && w.getBoundingClientRect();
        if (r && r.width > 0 && r.height > 0) {
            btn.style.setProperty('top', (r.top + 8) + 'px', 'important');
            btn.style.setProperty('left', (r.right - btn.offsetWidth - 8) + 'px', 'important');
            btn.style.setProperty('right', 'auto', 'important');
        } else {
            btn.style.setProperty('top', '60px', 'important');
            btn.style.setProperty('right', '12px', 'important');
            btn.style.setProperty('left', 'auto', 'important');
        }
    }
    let _pvPlaceQueued = false;
    function _pvSchedulePlace() {
        if (_pvPlaceQueued) return;
        _pvPlaceQueued = true;
        const raf = window.requestAnimationFrame ? f => window.requestAnimationFrame(f) : f => setTimeout(f, 16);
        raf(() => { _pvPlaceQueued = false; _pvPlaceBtn(); });
    }

    function _pvLookup(raw, seq) {
        const parsed = parseMovieFilename(raw);
        const failed = () => {
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
            if (seq !== _pvSeq) return;
            if (!id) { failed(); return; }
            _npData = { episode: parsed && parsed.episode != null ? parsed.episode : null };
            _currentImdbId = id;
            if (typeof scRenderTriviaPopupBtn === 'function') {
                const btn = scRenderTriviaPopupBtn();
                if (btn) {
                    btn.addEventListener('click', _pvSchedulePlace); // label width may change
                    _pvPlaceBtn();
                }
            }
        }).catch(() => failed());
    }

    // fromSocket: the changeMedia payload already set currentMediaType, so trust
    // it; only the DOM path has to ask isYouTubeMedia().
    function pvOnTitle(rawTitle, fromSocket) {
        const raw = _pvCleanTitle(rawTitle);
        if (!raw || /^nothing playing$/i.test(raw) || raw === lastMovieTitle) return;
        const youTube = fromSocket ? currentMediaType === 'yt' : isYouTubeMedia();
        lastMovieTitle = raw; // recorded even for YouTube so the DOM poll doesn't re-trigger it
        if (raw !== _pvRetried) _pvRetried = '';
        _currentImdbId = null;
        _npData = null;
        const old = document.getElementById('sc-trivia-popup-btn');
        if (old) old.remove();
        const seq = ++_pvSeq;
        if (youTube) return; // bubbles never run on YouTube embeds
        _pvLookup(raw, seq);
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
                if (data && data.title) pvOnTitle(data.title, true);
            });
        };
        bind();
        setTimeout(bind, 2000);
        window.addEventListener('resize', _pvSchedulePlace);
        window.addEventListener('scroll', _pvSchedulePlace, { passive: true });
        pvOnTitle(_pvDomTitle(), false);
        let polls = 0;
        const poll = setInterval(() => { pvOnTitle(_pvDomTitle(), false); if (++polls >= 14) clearInterval(poll); }, 1500);
    }
    scRegisterInit(pvWatcherBoot);
