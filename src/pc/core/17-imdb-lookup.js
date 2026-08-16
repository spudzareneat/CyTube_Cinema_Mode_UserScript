    /* ==========================================================
       IMDB LOOKUP
       Owns all traffic to caching.graphql.imdb.com (free, no API
       key) used for the *primary* movie lookup -- title resolution
       (fetchImdbMovieByTitle, via imdbSearchTitle + fetchImdbTitleFields)
       and the parental-guide chips (fetchImdbParentalGuide) -- both of
       which movie-title-links calls unconditionally to populate the Now
       Playing card. Kept here in core -- rather than inside the
       imdb-trivia module these used to live in -- so a build can drop
       imdb-trivia (a genuinely optional, skippable feature: the trivia
       panel) without dragging it in just to satisfy movie-title-links'
       need for this data layer; core is always bundled regardless of
       module selection.

       imdb-trivia is the sibling module for the separate, genuinely-
       optional trivia panel feature; its own fetchImdbTrivia() calls
       imdbQuery()/imdbGmFetch() from this file rather than duplicating
       them.
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

    // Combined entry point for callers (movie-title-links, in a later task):
    // resolves title+year to a tconst, then pulls its fields, and returns a
    // single merged object. Returns null if the title can't be resolved at
    // all; still returns the tconst/title/year even if the field lookup
    // itself fails (fields spread in as {} in that case).
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
