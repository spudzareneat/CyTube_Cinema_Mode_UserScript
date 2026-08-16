    /* ==========================================================
       MOVIE LINKS — IMDb lookup (primary) + optional TMDB supplemental
       + Wikipedia. Populates the shared `_npData` (declared once in
       core's 01-movie-identity.js) with everything the Now Playing
       card and the floating stats bar render.

       This module owns its own IMDb GraphQL traffic to
       caching.graphql.imdb.com (free, no API key -- hence the
       `connects`/`grants` entries on this module in manifest.json) for
       the primary lookup: title resolution (fetchImdbMovieByTitle, via
       imdbSearchTitle + fetchImdbTitleFields) and the parental-guide
       chips (fetchImdbParentalGuide) that the Now Playing card renders
       unconditionally. Both are plain local functions defined below,
       not an external dependency, so lookupMovie() calls them directly
       with no typeof-guard.

       `imdb-trivia` is a separate, optional module for the trivia
       panel feature; it hard-depends on this module (`dependsOn:
       ["core", "movie-title-links"]` in manifest.json) since trivia
       inherently needs a movie to already be identified, and its own
       fetchImdbTrivia() reuses imdbQuery()/imdbGmFetch() defined below
       rather than duplicating them.

       TMDB is optional supplemental data only (poster/backdrop
       fallback + kill count), supplied by the `tmdb` module's
       fetchTmdbSupplemental(imdbId) — called through a typeof-guard so
       a build without it (or before that module exists) still resolves
       the rest of the lookup, just without TMDB's poster/backdrop/killCount.

       Same typeof-guard pattern applies to the "Trivia" button's click
       handler (toggleTriviaPanel), since imdb-trivia is a genuinely
       optional module — and, in the other direction, for this
       module's own calls into the optional tonights-lineup module's
       lineupObserveTitleChange (feeds its timing/ETA model; this
       module doesn't depend on tonights-lineup, so a build without it
       just skips those calls).
    ========================================================== */

    const IMDB_GQL = 'https://caching.graphql.imdb.com/';

    function imdbGmFetch(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers: {
                    'Accept': 'application/graphql+json, application/json',
                    'Content-Type': 'application/json',
                    'x-imdb-client-name': 'imdb-web-next-localized',
                    'x-imdb-user-language': 'en-US',
                    'x-imdb-user-country': 'US',
                },
                onload: r => {
                    if (r.status >= 200 && r.status < 300) {
                        try { resolve(JSON.parse(r.responseText)); }
                        catch (e) { reject(e); }
                    } else {
                        reject(new Error(`HTTP ${r.status}`));
                    }
                },
                onerror: reject,
            });
        });
    }

    async function imdbQuery(operationName, query, variables) {
        const url = IMDB_GQL +
            '?operationName=' + encodeURIComponent(operationName) +
            '&query='         + encodeURIComponent(query) +
            '&variables='     + encodeURIComponent(JSON.stringify(variables));
        return imdbGmFetch(url);
    }

    async function fetchImdbParentalGuide(tconst) {
        if (!tconst) return null;
        const q = 'query GHGuide($id: ID!){ title(id:$id){ parentsGuide{ categories{ category{ text } severity{ text } } } } }';
        try {
            const data = await imdbQuery('GHGuide', q, { id: tconst });
            const cats = data?.data?.title?.parentsGuide?.categories;
            if (!cats) return null;
            return cats
                .map(c => ({ category: c.category?.text, severity: c.severity?.text }))
                .filter(c => c.category && c.severity);
        } catch (e) { return null; }
    }

    /* ==========================================================
       PRIMARY LOOKUP — title+year -> tconst, plus rating/runtime/
       overview/poster/genres. Query text/field-paths/disambiguation
       logic ported verbatim from the discovery scripts
       working/imdb-search-test.mjs and working/imdb-title-fields-test.mjs
       (proven live against caching.graphql.imdb.com; not re-derived).
    ========================================================== */

    // Unfiltered search + client-side pick, NOT a server-side year filter.
    // IMDb's mainSearch(options.titleSearchOptions.releaseDateRange) IS a
    // real hard filter, but a naive off-by-one year silently returns
    // unrelated-but-plausible titles instead of zero results (confirmed
    // against "Whiplash", which has both a 2013 short and the 2014 feature
    // under the identical name) — worse than TMDB's zero-results failure
    // mode at movie-title-links/index.js:85-90. So: search title-only, then
    // prefer an edge whose releaseYear matches AND titleType.id === 'movie'
    // (the movie-type filter matters — a plain year match could otherwise
    // land on a same-named short/video instead of the real feature), falling
    // back to the first movie-typed edge (relevance order) if nothing
    // matches the year.
    const IMDB_MAIN_SEARCH_QUERY = 'query MainSearch($term: String!) { mainSearch(first: 5, options: { searchTerm: $term, type: TITLE }) { edges { node { entity { ... on Title { id titleText { text } releaseYear { year } titleType { text id isSeries isEpisode } } } } } } }';

    async function imdbSearchTitle(title, year) {
        if (!title) return null;
        try {
            const data = await imdbQuery('MainSearch', IMDB_MAIN_SEARCH_QUERY, { term: title });
            const edges = data?.data?.mainSearch?.edges || [];
            const results = edges.map(e => e?.node?.entity).filter(Boolean);
            const movies = results.filter(r => r.titleType?.id === 'movie');
            const pool = movies.length ? movies : results;
            let best = null;
            if (year) best = pool.find(r => String(r.releaseYear?.year) === String(year)) || null;
            if (!best) best = pool[0] || null;
            if (!best) return null;
            return {
                tconst: best.id,
                title: best.titleText?.text ?? null,
                year: best.releaseYear?.year ?? null,
                titleType: best.titleType?.id ?? null,
            };
        } catch (e) { return null; }
    }

    // All 5 fields confirmed working in Task 1's discovery (rating, runtime,
    // overview, poster, genres) — none omitted. Field paths and the
    // `titleGenres.genres[].genre.text` nesting are exactly as proven there.
    const IMDB_TITLE_FIELDS_QUERY = 'query GHCombined($id: ID!){ title(id:$id){ id ratingsSummary{ aggregateRating voteCount } runtime{ seconds } plot{ plotText{ plainText } } primaryImage{ url width height } titleGenres{ genres{ genre{ text } } } } }';

    async function fetchImdbTitleFields(tconst) {
        if (!tconst) return null;
        try {
            const data = await imdbQuery('GHCombined', IMDB_TITLE_FIELDS_QUERY, { id: tconst });
            const t = data?.data?.title;
            if (!t) return null;
            return {
                rating:       t.ratingsSummary?.aggregateRating ?? null,
                voteCount:    t.ratingsSummary?.voteCount ?? null,
                runtime:      t.runtime?.seconds != null ? Math.round(t.runtime.seconds / 60) : null,
                overview:     t.plot?.plotText?.plainText ?? null,
                poster:       t.primaryImage?.url ?? null,
                posterWidth:  t.primaryImage?.width ?? null,
                posterHeight: t.primaryImage?.height ?? null,
                genres:       t.titleGenres?.genres?.map(g => g.genre?.text).filter(Boolean) ?? null,
            };
        } catch (e) { return null; }
    }

    // Combined entry point for callers: resolves title+year to a tconst,
    // then pulls its fields, and returns a single merged object. Returns
    // null if the title can't be resolved at all; still returns the
    // tconst/title/year even if the field lookup itself fails (fields
    // spread in as {} in that case).
    async function fetchImdbMovieByTitle(title, year) {
        const match = await imdbSearchTitle(title, year);
        if (!match || !match.tconst) return null;
        const fields = await fetchImdbTitleFields(match.tconst);
        return {
            tconst: match.tconst,
            title:  match.title,
            year:   match.year,
            ...(fields || {}),
        };
    }

    const LINK_DEFS = [
        { key: 'imdb',       label: 'IMDb',       color: '#f5c518', fg: '#000', char: 'i' },
        { key: 'letterboxd', label: 'Letterboxd', color: '#2c4a2e', fg: '#00e054', char: 'L' },
        { key: 'wiki',       label: 'Wikipedia',  color: '#444',    fg: '#eee', char: 'W' },
    ];

    // Cache by raw title to avoid repeat lookups — persisted to localStorage so a page
    // reload doesn't re-hit IMDb/Wikipedia/TMDB for every title already looked up.
    let movieLinkCache = (() => {
        try {
            const raw = localStorage.getItem(LS_MOVIE_CACHE);
            return raw ? JSON.parse(raw) : {};
        } catch (e) { return {}; }
    })();

    async function lookupMovie(title, year) {
        const cacheKey = title + (year || '');
        if (movieLinkCache[cacheKey] !== undefined) return movieLinkCache[cacheKey];

        // ── IMDb (primary) + Wikipedia in parallel ───────────────────────────────
        // fetchImdbMovieByTitle is defined above in this same file -- a plain
        // local call, not an external dependency (unlike the typeof-guarded
        // optional calls below).
        let wikiUrl = null;

        const imdbPromise = fetchImdbMovieByTitle(title, year);

        // Wikipedia can start immediately with the raw title; we'll use the IMDb
        // result's title if available, but since it runs in parallel we use the
        // raw title — good enough for wiki search.
        const wikiPromise = (async () => {
            try {
                const searchTitle = title + (year ? ' ' + year : '') + ' film';
                const res = await fetch(
                    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${
                        encodeURIComponent(searchTitle)
                    }&srlimit=1&format=json&origin=*`
                );
                if (!res.ok) return;
                const data = await res.json();
                const hit = data?.query?.search?.[0];
                if (hit) wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`;
            } catch (e) {}
        })();

        const [imdbResult] = await Promise.all([imdbPromise, wikiPromise]);
        const imdbId = imdbResult?.tconst || null;

        // ── TMDB supplemental — poster/backdrop fallback + kill count. Defined in
        // the (optional) tmdb module; typeof-guarded so a build without it (or,
        // right now, before that module exists at all) still resolves the rest of
        // this lookup, just without TMDB's poster/backdrop/killCount. ────────────
        const tmdbSupplemental = (typeof fetchTmdbSupplemental === 'function')
            ? await fetchTmdbSupplemental(imdbId)
            : null;

        // ── IMDb Parent Guide — also defined above in this file; called
        // directly, same as fetchImdbMovieByTitle above. ─────────────────────────
        const parentalGuide = await fetchImdbParentalGuide(imdbId);

        const result = {
            links: {
                imdb:       imdbId ? `https://www.imdb.com/title/${imdbId}/` : null,
                // Letterboxd supports an /imdb/<id> redirect (same as its /tmdb/<id>
                // one), so this keys off imdbId directly -- available whenever the
                // primary IMDb lookup resolves, unlike tmdbSupplemental which needs
                // the optional tmdb module *and* a user-supplied TMDB API key.
                letterboxd: imdbId ? `https://letterboxd.com/imdb/${imdbId}` : null,
                wiki:       wikiUrl,
            },
            resolved:      !!imdbResult,
            killCount:     tmdbSupplemental?.killCount ?? null,
            parentalGuide,
            imdbId,
            cleanTitle: imdbResult?.title    || null,
            cleanYear:  imdbResult?.year     || null,
            rating:     imdbResult?.rating   ?? null,
            runtime:    imdbResult?.runtime  || null,
            genres:     imdbResult?.genres   || [],
            // TMDB's poster/backdrop overlay IMDb's when TMDB supplied one; otherwise
            // fall back to IMDb's primaryImage (if the lookup found one). IMDb has no
            // dedicated wide "backdrop" field, so its (usually portrait) primaryImage
            // is reused for both -- the card's CSS crops it to fill (`background-size:
            // cover`), same pattern apps use when no dedicated backdrop exists.
            poster:     tmdbSupplemental?.poster   || imdbResult?.poster || null,
            backdrop:   tmdbSupplemental?.backdrop || imdbResult?.poster || null,
            overview:   imdbResult?.overview || null,
        };

        // Only persist a resolved result -- caching an unresolved one (e.g. a
        // transient IMDb GraphQL failure) would permanently poison future
        // lookups for this title, the same trap the old TMDB-absent case fell
        // into pre-upgrade. An unresolved result still gets returned to the
        // caller this time, just not cached.
        if (result.resolved) {
            movieLinkCache[cacheKey] = result;
            try { localStorage.setItem(LS_MOVIE_CACHE, JSON.stringify(movieLinkCache)); }
            catch (e) { /* storage full/unavailable -- in-memory cache for this session still works */ }
        }
        return result;
    }

    // isYouTubeMedia() lives in core (12-playback-sync-and-seek.js) -- core is
    // always a dependency of every module, so it's called directly here with no
    // typeof-guard needed.

    // _currentImdbId is declared once in core's 01-movie-identity.js (shared
    // now-playing state, alongside lastMovieTitle/_npData), not here -- kept
    // there for consistency with those fields rather than moved here, even
    // though imdb-trivia's hard dependsOn on this module (manifest.json)
    // now guarantees this module is always present wherever imdb-trivia's
    // showTriviaCard() reads it.
    let _npHideTimer   = null;

    const NP_PG_SHORT = {
        'Sex & Nudity': 'Sex/Nudity', 'Violence & Gore': 'Violence',
        'Profanity': 'Profanity', 'Alcohol, Drugs & Smoking': 'Drugs',
        'Frightening & Intense Scenes': 'Frightening',
    };

    function showNowPlayingCard(data, opts = {}) {
        if (!data || (!data.cleanTitle && !data.backdrop)) return;
        let card = document.getElementById('sc-np-card');
        if (!card) {
            card = document.createElement('div');
            card.id = 'sc-np-card';
            card.innerHTML = `
                <div id="sc-np-backdrop"></div>
                <div id="sc-np-scrim"></div>
                <div id="sc-np-content">
                    <img id="sc-np-poster" alt="" />
                    <div id="sc-np-info">
                        <div id="sc-np-eyebrow">Now Playing</div>
                        <div id="sc-np-title"></div>
                        <div id="sc-np-meta"></div>
                        <div id="sc-np-overview"></div>
                        <div id="sc-np-chips"></div>
                        <div id="sc-np-links"></div>
                    </div>
                </div>`;
            document.body.appendChild(card);
            card.addEventListener('click', hideNowPlayingCard);
        }
        const title = data.cleanTitle || '';
        const year  = data.cleanYear ? ` (${data.cleanYear})` : '';
        card.querySelector('#sc-np-backdrop').style.backgroundImage = data.backdrop ? `url(${data.backdrop})` : 'none';
        const poster = card.querySelector('#sc-np-poster');
        if (data.poster) { poster.src = data.poster; poster.style.display = ''; }
        else poster.style.display = 'none';
        card.querySelector('#sc-np-title').textContent = title + year;
        card.querySelector('#sc-np-overview').textContent = data.overview || '';
        const metaParts = [];
        if (data.rating)  metaParts.push(`⭐ ${data.rating}`);
        if (data.runtime) metaParts.push(`${Math.floor(data.runtime / 60)}h ${data.runtime % 60}m`);
        if (data.genres && data.genres.length) metaParts.push(data.genres.slice(0, 3).join(' · '));
        card.querySelector('#sc-np-meta').textContent = metaParts.join('     ');
        const chipHtml = [];
        (data.parentalGuide || []).forEach(pg => {
            const sev = String(pg.severity || '').toLowerCase();
            const label = NP_PG_SHORT[pg.category] || pg.category;
            chipHtml.push(`<span class="sc-np-chip sc-sev-${sev}">${label}: ${pg.severity}</span>`);
        });
        if (data.killCount !== null && data.killCount !== undefined) {
            chipHtml.push(`<span class="sc-np-chip">💀 ${data.killCount} kills</span>`);
        }
        card.querySelector('#sc-np-chips').innerHTML = chipHtml.join('');

        // Render movie links badges
        const linksEl = card.querySelector('#sc-np-links');
        linksEl.innerHTML = '';
        if (movieLinksEnabled()) {
            LINK_DEFS.forEach(({ key, label, color, fg, char }) => {
                const url = (data.links || {})[key];
                if (!url) return;
                const a = document.createElement('a');
                a.href = url;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.title = label;
                a.className = 'sc-movie-link';
                a.style.background = color;
                a.style.color = fg;
                a.textContent = char;
                a.addEventListener('click', (e) => e.stopPropagation());
                linksEl.appendChild(a);
            });
        }

        card.classList.add('sc-np-visible');
        clearTimeout(_npHideTimer);
        if (opts.autoHide) _npHideTimer = setTimeout(hideNowPlayingCard, 7000);
    }

    function hideNowPlayingCard() {
        const card = document.getElementById('sc-np-card');
        if (card) card.classList.remove('sc-np-visible');
        clearTimeout(_npHideTimer);
    }

    function injectMovieLinks(titleEl) {
        const rawTitle = titleEl.textContent.trim()
            .replace(/^currently\s+playing[:\s]*/i, '')
            .replace(/^now\s+playing[:\s]*/i, '').trim();

        if (!rawTitle || rawTitle === lastMovieTitle || rawTitle.length < 2) return;
        lastMovieTitle = rawTitle;
        const knownSeconds = getCurrentMediaSeconds();
        // lineupObserveTitleChange lives in the optional tonights-lineup module --
        // typeof-guarded so a build without it (this module doesn't depend on
        // tonights-lineup) still injects links/stats normally, just without
        // feeding the lineup's timing/ETA model.
        if (typeof lineupObserveTitleChange === 'function') {
            lineupObserveTitleChange(rawTitle, knownSeconds > 0 ? knownSeconds : null);
        }
        _currentImdbId = null;

        // Clean up previous links/stats/trivia button
        ['sc-movie-links', 'sc-movie-stats', 'sc-trivia-btn'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.remove();
        });

        const isYt = isYouTubeMedia();
        let ytSeconds = 0;
        if (isYt) {
            ytSeconds = getCurrentMediaSeconds();
            if (ytSeconds < 3600) return; // short YouTube clip — skip
        }

        const { title, year } = isYt ? parseYouTubeTitle(rawTitle) : parseMovieFilename(rawTitle);
        if (!title || title.length < 2) return;

        lookupMovie(title, year).then(({ links, killCount, parentalGuide, imdbId, cleanTitle, cleanYear, rating, runtime, genres, poster, backdrop, overview }) => {
            if (isYt && !cleanTitle) {
                return;
            }
            if (isYt && runtime && ytSeconds) {
                const diff = Math.abs(runtime - ytSeconds / 60);
                if (diff > 30) { return; }
            }

            _currentImdbId = imdbId || null;
            _npData = { cleanTitle, cleanYear, poster, backdrop, overview, rating, runtime, genres: genres || [], parentalGuide, killCount, imdbId, links };

            // Update title with clean IMDb title, wrapped in a clickable span
            if (cleanTitle && titleEl) {
                const newText = cleanTitle + (cleanYear ? ` (${cleanYear})` : '');
                let span = document.getElementById('sc-title-text');
                if (!span) {
                    span = document.createElement('span');
                    span.id = 'sc-title-text';
                    span.style.cursor = 'pointer';
                    span.title = 'Movie info (I)';
                    span.addEventListener('click', (e) => { e.stopPropagation(); showNowPlayingCard(_npData, { autoHide: false }); });
                    const textNode = [...titleEl.childNodes].find(n => n.nodeType === 3 && n.textContent.trim());
                    if (textNode) textNode.parentNode.replaceChild(span, textNode);
                    else titleEl.insertBefore(span, titleEl.firstChild);
                }
                span.textContent = newText;
            }

            // Trivia button — only when we have an IMDb ID and the imdb-trivia module is
            // present (toggleTriviaPanel is defined there; typeof-guarded so a build
            // without it just skips the button instead of throwing on click-handler setup).
            if (imdbId && typeof toggleTriviaPanel === 'function') {
                const tb = document.createElement('button');
                tb.id = 'sc-trivia-btn';
                tb.textContent = 'Trivia';
                tb.title = 'IMDb trivia (press T)';
                tb.addEventListener('click', toggleTriviaPanel);
                document.body.appendChild(tb);
            }

            // Stats bar — rating, runtime, kill count, DtDD, parent guide
            const statParts = [];
            if (rating !== null) statParts.push(`⭐ ${rating}`);
            if (runtime)         statParts.push(`${runtime} min`);
            if (killCount !== null) statParts.push(`💀 ${killCount} kills`);
            if (parentalGuide && parentalGuide.length) {
                const SEV = { Severe: '🔴', Moderate: '🟡', Mild: '🟢', None: '' };
                parentalGuide.forEach(({ category, severity }) => {
                    const dot = SEV[severity] || '';
                    if (dot) statParts.push(`${dot} ${category}`);
                });
            }

            const old = document.getElementById('sc-movie-stats');
            if (old) old.remove();
            if (statParts.length) {
                const statsEl = document.createElement('div');
                statsEl.id = 'sc-movie-stats';
                statsEl.textContent = statParts.join('  ·  ');
                document.body.appendChild(statsEl);
                setTimeout(() => { if (statsEl.parentNode) statsEl.remove(); }, 12000);
            }
        });
    }

    function triggerTitleInject() {
        for (const el of [
            document.getElementById('currenttitle'),
            document.querySelector('#videowrap-header .pull-left'),
            document.querySelector('#videowrap-header span'),
            document.querySelector('.video-title'),
        ]) {
            if (el && el.textContent.trim()) { injectMovieLinks(el); return; }
        }
    }

    let _titleObsAttached = false;
    function attachHeaderObserver() {
        if (_titleObsAttached) return;
        const header = document.getElementById('videowrap-header');
        if (!header) return;
        _titleObsAttached = true;
        new MutationObserver(triggerTitleInject).observe(header, { childList: true, subtree: true, characterData: true });
    }

    function watchMovieTitle() {
        triggerTitleInject();
        attachHeaderObserver();
        // Poll for ~20s on cold load in case header isn't ready yet
        let tries = 0;
        const poll = setInterval(() => {
            attachHeaderObserver();
            triggerTitleInject();
            if (++tries >= 14) clearInterval(poll);
        }, 1500);
    }

    function initMediaWatcher() {
        const tryBind = () => {
            if (typeof socket === 'undefined' || !socket) return;
            socket.on('changeMedia', (data) => {
                try {
                    currentMediaSeconds = (data && typeof data.seconds === 'number') ? data.seconds : 0;
                    currentMediaType    = (data && data.type) ? data.type : '';
                    // Authoritative lineup match straight from the raw socket payload, ahead of
                    // (and independent from) the DOM-title path below -- see
                    // lineupObserveTitleChange's own comment for why this matters.
                    // typeof-guarded -- see the other call site above in injectMovieLinks.
                    if (data && data.title && typeof lineupObserveTitleChange === 'function') {
                        lineupObserveTitleChange(data.title, data.seconds);
                    }
                    setTimeout(triggerTitleInject, 350);
                } catch (e) {}
            });
        };
        // socket may not be ready at document-start; try at load then again after a short delay
        window.addEventListener('load', () => { tryBind(); setTimeout(tryBind, 2000); });
    }

    // 'I' = movie info card, from anywhere when not typing. Split out from the
    // original combined T/I/Escape/arrows keydown handler so this module's
    // hotkey only depends on functions this module itself defines — see
    // imdb-trivia/index.js for the 'T' half of that original handler.
    document.addEventListener('keydown', (e) => {
        const t = e.target;
        if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
        if (e.key === 'Escape') { hideNowPlayingCard(); return; }
        if (e.key === 'i' || e.key === 'I') {
            const card = document.getElementById('sc-np-card');
            if (card && card.classList.contains('sc-np-visible')) hideNowPlayingCard();
            else if (_npData) showNowPlayingCard(_npData, { autoHide: false });
            return;
        }
    });

    scRegisterInit(watchMovieTitle);
    scRegisterInit(initMediaWatcher);

    // order: 2 reproduces the original shipped script's settings-row sequence
    // (spellcheck, movielinks, autoembed, gifoptimize) — see
    // src/pc/core/15-settings-modal-shell.js, which sorts SC_SETTINGS_ROWS by
    // this field before rendering.
    scRegisterSetting({ id: 'sc-input-movielinks', group: 'movie-title-links', label: 'Show movie links (IMDb / Letterboxd / Wiki)', note: 'Adds clickable badge icons to the Now Playing card', key: LS_MOVIE_LINKS, defaultOn: true, order: 2 });
