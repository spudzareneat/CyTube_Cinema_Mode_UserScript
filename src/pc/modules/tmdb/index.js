    /* ==========================================================
       TMDB — optional, dual-role metadata source for the Now Playing
       card. When a TMDB API key is configured, this module's
       fetchTmdbPrimary(title, year) becomes the *primary* movie/show
       lookup (better title/rating/overview matching than IMDb's
       GraphQL search) — movie-title-links's lookupMovie() tries it
       first, through a typeof-guard, and only falls through to its
       own IMDb-primary flow when no key is set, this module isn't in
       the build, or fetchTmdbPrimary can't find a confidently-linked
       match. Without a key, this module's role shrinks back to its
       original one: fetchTmdbSupplemental(imdbId) layers TMDB's
       poster/backdrop/kill-count on top of an already-resolved IMDb
       result. Either way this module is fully optional — a build
       without it still resolves title/rating/runtime/overview/poster
       from IMDb alone, just without TMDB's metadata upgrade, backdrop,
       kill-count, or Letterboxd link.

       Owns everything TMDB-related that used to live in core:
       - LS_TMDB key + validateTmdbKey() (moved verbatim from
         src/pc/core/15-settings-modal-shell.js) + the registered
         settings row for it (a plain type:'text' row now, like
         gifmaker's ImgBB field — no more hardcoded enable/disable
         toggle; the row's presence in the settings modal already
         doubles as "TMDB is available in this build").
       - The kill-count DB (raw.githubusercontent.com JSONL, keyed by
         tmdb_id) — written fresh here; movie-title-links's old copy
         was deleted outright in the prior task, not moved.
       - fetchTmdbPrimary(title, year): TMDB's /3/search/multi +
         /3/{movie|tv}/{id} (with external_ids appended) to resolve a
         title/year straight to full metadata *and* a linked IMDb id.
         Requires external_ids.imdb_id to be present — every
         downstream consumer (parental guide, .links.imdb/.links.
         letterboxd, imdb-trivia) needs a real IMDb id, so a TMDB match
         with no linked IMDb id is treated as a miss, not a partial
         success, and this returns null so the caller falls back to
         IMDb-primary.
       - fetchTmdbSupplemental(imdbId): TMDB's /3/find/{imdb_id}
         endpoint to resolve a TMDB id from the IMDb id movie-title-
         links already found (IMDb-primary path only — fetchTmdbPrimary
         already has its own tmdb id when it's the one that ran), then
         poster_path/backdrop_path (same image.tmdb.org/t/p/w342|w780
         URL construction fetchTmdbPrimary uses) plus a kill-count
         lookup. Returns { tmdbId, poster, backdrop, killCount } —
         null fields when there's no key set or no TMDB match — exactly
         the shape movie-title-links's lookupMovie() already
         destructures.
    ========================================================== */

    const LS_TMDB = 'sc_tmdb_key';

    async function validateTmdbKey(key) {
        try {
            const res = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: `https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(key)}`,
                    onload: r => resolve(r),
                    onerror: reject,
                });
            });
            if (res.status === 200) return 'valid';
            if (res.status === 401) return 'invalid';
            return 'error';
        } catch (e) { return 'error'; }
    }

    // ── Kill-Count JSONL (fetched once, keyed by tmdb_id) ───────────────────────
    let killCountDb = null; // null = not loaded yet, {} = loaded (may be empty)

    async function getKillCountDb() {
        if (killCountDb !== null) return killCountDb;
        killCountDb = {};
        try {
            // Use GM_xmlhttpRequest to bypass any CORS issues with raw.githubusercontent.com
            const text = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: 'https://raw.githubusercontent.com/lklynet/Kill-Count/main/killcounts.jsonl',
                    onload: r => r.status === 200 ? resolve(r.responseText) : reject(new Error(`HTTP ${r.status}`)),
                    onerror: reject,
                });
            });
            for (const line of text.split('\n')) {
                const s = line.trim();
                if (!s) continue;
                try {
                    const entry = JSON.parse(s);
                    // Field name confirmed from repo: tmdb_id and count
                    if (entry.tmdb_id != null) {
                        killCountDb[String(entry.tmdb_id)] = entry.count;
                    }
                } catch (e) {}
            }
        } catch (e) {
            console.warn('[CyTube SC] Kill count DB failed to load:', e);
        }
        return killCountDb;
    }

    // Given an already-resolved IMDb id, finds the matching TMDB movie (if a
    // key is set and TMDB has one) and returns its poster/backdrop/kill-count.
    // Called by movie-title-links's lookupMovie() through a typeof-guard.
    async function fetchTmdbSupplemental(imdbId) {
        const empty = { tmdbId: null, poster: null, backdrop: null, killCount: null };
        if (!imdbId || !hasKey(LS_TMDB)) return empty;
        try {
            const res = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}` +
                        `?external_source=imdb_id&api_key=${encodeURIComponent(getKey(LS_TMDB))}`,
                    onload: r => resolve(r),
                    onerror: reject,
                });
            });
            if (res.status !== 200) return empty;
            const data = JSON.parse(res.responseText);
            const movie = data?.movie_results?.[0];
            if (!movie) return empty;

            const tmdbId   = movie.id ?? null;
            const poster   = movie.poster_path   ? `https://image.tmdb.org/t/p/w342${movie.poster_path}`   : null;
            const backdrop = movie.backdrop_path ? `https://image.tmdb.org/t/p/w780${movie.backdrop_path}` : null;

            let killCount = null;
            if (tmdbId != null) {
                const db = await getKillCountDb();
                const count = db[String(tmdbId)];
                if (count !== undefined && count !== null) killCount = count;
            }

            return { tmdbId, poster, backdrop, killCount };
        } catch (e) {
            return empty;
        }
    }

    // Primary lookup: given a raw title (and optional year), searches TMDB
    // directly and returns full metadata plus the linked IMDb id. Called by
    // movie-title-links's lookupMovie() through a typeof-guard, ahead of (and,
    // when it succeeds, replacing) the IMDb-primary flow -- see this file's
    // header comment. Mirrors fetchTmdbSupplemental's shape: never throws,
    // resolves to null on any failure (no key, no title, network error, no
    // search results, or no linked imdb_id) so the caller can fall straight
    // through to its existing IMDb-primary path without a try/catch of its own.
    async function fetchTmdbPrimary(title, year) {
        // No key configured -- instant, no network. This is what keeps the
        // zero-key path exactly as fast as it is today.
        if (!title || !hasKey(LS_TMDB)) return null;
        try {
            const apiKey = getKey(LS_TMDB);

            // /search/multi covers both movies and TV shows in one call (mirrors
            // IMDb's own cross-type mainSearch, which also matches tvEpisode).
            // TMDB already relevance-ranks server-side, unlike IMDb's GraphQL
            // search, which needs titlesMatch()/Dice-coefficient scoring
            // client-side (see movie-title-links/index.js) -- so no client-side
            // fuzzy matching is needed here.
            const searchRes = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(title)}` +
                        `&include_adult=false&api_key=${encodeURIComponent(apiKey)}`,
                    onload: r => resolve(r),
                    onerror: reject,
                });
            });
            if (searchRes.status !== 200) return null;
            const searchData = JSON.parse(searchRes.responseText);
            const candidates = (searchData?.results || [])
                .filter(r => r.media_type === 'movie' || r.media_type === 'tv');
            if (!candidates.length) return null;

            // Year tiebreak: prefer the first candidate whose release/first-air
            // year matches, if a year was given; otherwise trust TMDB's own
            // top-ranked (first) result.
            let best = candidates[0];
            if (year) {
                const yearMatch = candidates.find(r => {
                    const date = r.release_date || r.first_air_date || '';
                    return date.slice(0, 4) === String(year);
                });
                if (yearMatch) best = yearMatch;
            }

            const mediaType = best.media_type;
            const detailsRes = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: `https://api.themoviedb.org/3/${mediaType}/${best.id}` +
                        `?append_to_response=external_ids&api_key=${encodeURIComponent(apiKey)}`,
                    onload: r => resolve(r),
                    onerror: reject,
                });
            });
            if (detailsRes.status !== 200) return null;
            const d = JSON.parse(detailsRes.responseText);

            // Every downstream consumer (parental guide, .links.imdb/.links.
            // letterboxd, _currentImdbId, imdb-trivia) depends on an IMDb id --
            // a TMDB match with no linked one is a miss, not a partial success,
            // so the caller falls back to IMDb-primary.
            const imdbId = d.external_ids?.imdb_id || null;
            if (!imdbId) return null;

            // Reuse the tmdb id already in hand rather than routing through
            // fetchTmdbSupplemental, which would redundantly re-resolve it from
            // the imdb id we just got.
            let killCount = null;
            if (best.id != null) {
                const db = await getKillCountDb();
                const count = db[String(best.id)];
                if (count !== undefined && count !== null) killCount = count;
            }

            // rating/runtime units already match IMDb's (both 0-10 scale, both
            // minutes) -- no conversion needed.
            return {
                imdbId,
                tmdbId:   best.id ?? null,
                title:    mediaType === 'movie' ? (d.title ?? null) : (d.name ?? null),
                year:     (d.release_date || d.first_air_date || '').slice(0, 4) || null,
                rating:   d.vote_average ?? null,
                runtime:  mediaType === 'movie' ? (d.runtime ?? null) : (d.episode_run_time?.[0] ?? null),
                genres:   (d.genres || []).map(g => g.name).filter(Boolean),
                overview: d.overview || null,
                poster:   d.poster_path   ? `https://image.tmdb.org/t/p/w342${d.poster_path}`   : null,
                backdrop: d.backdrop_path ? `https://image.tmdb.org/t/p/w780${d.backdrop_path}` : null,
                killCount,
            };
        } catch (e) {
            return null;
        }
    }

    scRegisterInit(getKillCountDb); // pre-fetch kill count DB

    // order: 0 — reproduces the original hardcoded field's position at the
    // very top of the settings modal, above every other registered row
    // (spellcheck=1, movielinks=2, autoembed=3, gifoptimize=4,
    // lineuptiming=5, imgbb=6, movie-lead-time=7 — see
    // src/pc/core/15-settings-modal-shell.js, which sorts SC_SETTINGS_ROWS
    // by this field before rendering). testEmptyMessage/testValidMessage/
    // testInvalidMessage/testErrorMessage carry over byte-for-byte from the
    // old hardcoded TMDB Test button in core/15-settings-modal-shell.js.
    scRegisterSetting({
        id: 'sc-input-tmdb', group: 'tmdb', type: 'text',
        label: 'TMDB API key',
        note: 'Optional — when set, TMDB becomes the primary movie/show lookup (better metadata); without a key the script uses IMDb (no key required)',
        key: LS_TMDB,
        placeholder: 'Paste TMDB v3 key…',
        testHandler: validateTmdbKey,
        testEmptyMessage: 'Enter a key first',
        testValidMessage: '✓ Valid key',
        testInvalidMessage: '✗ Invalid key',
        testErrorMessage: '⚠ Couldn\'t reach API',
        link: 'https://www.themoviedb.org/settings/api',
        linkText: 'Get a free TMDB key ↗',
        order: 0,
    });
