    /* ==========================================================
       TMDB — optional supplemental data for the Now Playing card:
       poster/backdrop images and kill-count chips. IMDb (imdb-trivia
       module) is the primary/required lookup now; this module only
       adds on top of an already-resolved `imdbId`, so movie-title-
       links calls fetchTmdbSupplemental(imdbId) through a typeof-guard
       (this module is optional — a build without it still resolves
       title/rating/runtime/overview/poster from IMDb alone, just
       without TMDB's backdrop/poster-upgrade/kill-count/Letterboxd
       link).

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
       - fetchTmdbSupplemental(imdbId): TMDB's /3/find/{imdb_id}
         endpoint to resolve a TMDB id from the IMDb id movie-title-
         links already found, then poster_path/backdrop_path (same
         image.tmdb.org/t/p/w342|w780 URL construction the old TMDB-
         first lookupMovie() used) plus a kill-count lookup. Returns
         { tmdbId, poster, backdrop, killCount } — null fields when
         there's no key set or no TMDB match — exactly the shape
         movie-title-links's lookupMovie() already destructures.
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
        note: 'Optional — adds movie posters, backdrops, kill-count chips, and a Letterboxd link to the Now Playing card',
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
