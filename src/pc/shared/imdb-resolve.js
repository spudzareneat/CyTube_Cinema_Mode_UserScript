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

    // Given a TV series' own tconst plus a season/episode number, resolves
    // that specific episode's tconst/title/plot/rating/runtime/still image
    // via IMDb's episodes-by-season connection -- confirmed live against
    // caching.graphql.imdb.com via schema introspection (open on this
    // endpoint, same as every other query in this file): EpisodesFilter.
    // includeSeasons takes [String], and each edge's node is a plain Title
    // (same shape IMDB_TITLE_FIELDS_QUERY already reads from), just with an
    // added `series.displayableEpisodeNumber` for matching the episode
    // number. first:100 covers even long anime seasons in one page. Returns
    // null on no match (unaired episode, absolute-numbering mismatch, or any
    // request failure) so callers can just keep whatever series-level data
    // they already have -- this only ever supplements, never overrides nor
    // throws.
    async function fetchImdbEpisodeInfo(seriesTconst, season, episode) {
        if (!seriesTconst || season == null || episode == null) return null;
        const q = 'query GHEpisodesBySeason($id: ID!, $season: [String!]!){ title(id:$id){ episodes{ episodes(first: 100, filter: { includeSeasons: $season }){ edges{ node{ id titleText{ text } plot{ plotText{ plainText } } ratingsSummary{ aggregateRating voteCount } runtime{ seconds } primaryImage{ url } series{ displayableEpisodeNumber{ episodeNumber{ episodeNumber } } } } } } } } }';
        try {
            const data = await imdbQuery('GHEpisodesBySeason', q, { id: seriesTconst, season: [String(season)] });
            const edges = data?.data?.title?.episodes?.episodes?.edges || [];
            const node = edges.find(e =>
                Number(e?.node?.series?.displayableEpisodeNumber?.episodeNumber?.episodeNumber) === Number(episode)
            )?.node;
            if (!node) return null;
            return {
                tconst:   node.id,
                title:    node.titleText?.text ?? null,
                overview: node.plot?.plotText?.plainText ?? null,
                rating:   node.ratingsSummary?.aggregateRating ?? null,
                runtime:  node.runtime?.seconds != null ? Math.round(node.runtime.seconds / 60) : null,
                image:    node.primaryImage?.url ?? null,
            };
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
    // mode at movie-title-links/index.js:85-90. So: search title-only
    // (first: 20 — franchises with heavy fan-video/short/podcast coverage
    // can bury the real film past the first handful of IMDb's relevance-
    // ordered results; confirmed live for "Friday the 13th Part 3", where
    // the 1982 film only appears at position 7), then narrow to
    // titleType.id === 'movie' (matters — a plain year match could
    // otherwise land on a same-named short/video instead of the real
    // feature; NOTE this alone isn't sufficient either, since IMDb tags
    // some fan-made shorts/compilations as titleType "movie" too), then
    // among the movie-typed pool prefer an edge whose releaseYear matches,
    // breaking ties (or falling back, if no edge or no year matches) by
    // highest ratingsSummary.voteCount rather than raw relevance order —
    // real theatrical releases outvote fan content by orders of magnitude,
    // which also resolves the "Whiplash" short-vs-feature case above without
    // needing the year filter to be exact.
    //
    // Edge case: when a channel plays a TV episode (rare here, but it
    // happens), there's no 'movie'-typed result to fall back on, so the
    // old code fell straight through to the raw `results` pool and could
    // land on a podcastEpisode *about* that episode (rewatch/recap shows
    // often reuse the episode's exact title and can out-vote the real
    // tvEpisode entry). Give titleType.id === 'tvEpisode' its own
    // second-priority pool -- ahead of anything else -- so a genuine
    // episode match always wins over commentary/podcast content with the
    // same title. Only once neither a movie nor a tvEpisode is found do we
    // fall back to the full pool, and even then podcastEpisode entries are
    // deprioritized rather than allowed to win by vote count.
    //
    // Follow-up fix: the above tiebreak-by-votes logic had no title check at
    // all, so an obscure title with no same-year candidate in the top-20
    // would fall back to picking the whole pool's most-voted entry regardless
    // of title -- confirmed live for "Island of the Living Dead (2007)"
    // resolving to "Pirates of the Caribbean: Dead Man's Chest (2006)" and
    // "Star Crystal (1984)" resolving to "Indiana Jones and the Kingdom of
    // the Crystal Skull (2008)". imdbSearchTitle now requires titlesMatch()
    // (normalized word-set similarity, roman/arabic tolerant) before a
    // candidate is eligible at all; year is still only a tiebreaker among
    // title matches, never a filter dropped in favor of an unrelated title.
    // Also confirmed live: IMDb tags some direct-to-video genre titles (e.g.
    // "Island of the Living Dead" itself) as titleType 'video', not 'movie'
    // -- so tier fallthrough (movie -> tvEpisode -> nonPodcast -> results) now
    // advances based on whether a tier has a title-matching candidate, not
    // merely whether the tier is non-empty; otherwise an unrelated same-tier
    // 'movie' result (e.g. "Night of the Living Dead", which shares enough
    // generic words to no longer be a risk post-titlesMatch, but was before
    // stopword-stripping was added) could still block the loop from ever
    // reaching the tier holding the real title.
    // `runtime { seconds }` in the `... on Title` fragment: confirmed live
    // against caching.graphql.imdb.com (this endpoint accepts arbitrary field
    // selection, no persisted-hash restriction) -- a MainSearch for "Collision
    // Course" returns runtime.seconds for every real title, undefined only for
    // the odd entry IMDb genuinely lacks one for. It's the zero-extra-call way
    // to feed the runtime cross-check below (demoteByRuntime); the alternative
    // was an extra fetchImdbTitleFields round-trip per top candidate.
    const IMDB_MAIN_SEARCH_QUERY = 'query MainSearch($term: String!) { mainSearch(first: 20, options: { searchTerm: $term, type: TITLE }) { edges { node { entity { ... on Title { id titleText { text } releaseYear { year } titleType { text id isSeries isEpisode } ratingsSummary { voteCount } runtime { seconds } } } } } } }';

    function byVoteCountDesc(a, b) {
        return (b.ratingsSummary?.voteCount ?? 0) - (a.ratingsSummary?.voteCount ?? 0);
    }

    /* ==========================================================
       RUNTIME CROSS-CHECK (Layer 1c) — demote, don't exclude.

       When the parsed title is ambiguous ("Collision Course" -> a
       dozen unrelated films), imdbSearchTitle picks whichever title
       match has the most IMDb votes. The file actually playing has a
       duration (getCurrentMediaSeconds), and that's a strong
       disambiguator the vote-count sort ignores entirely: a candidate
       whose runtime is nowhere near the playing file almost certainly
       isn't what's on screen.

       15% tolerance, and DEMOTE rather than EXCLUDE, both deliberate:
       a runtime mismatch has too many innocent causes to hard-filter
       on -- distributor idents / channel bumpers baked into the file,
       the classic PAL 4% speedup on older transfers, theatrical vs.
       extended/unrated/director's cuts, and multi-part files that
       concatenate a whole miniseries into one entry. Excluding on a
       threshold would just trade the vote-count failure mode for a
       worse one (drop the real match, resolve to nothing or to
       something even further off). So a far-off candidate only loses
       its priority; if it was the only title match, it still wins.

       A candidate with no runtime data is NEVER demoted -- IMDb
       genuinely lacks a runtime for some obscure titles, and absence
       of evidence isn't evidence of a mismatch.

       Stable partition: within "kept" and within "demoted" the
       incoming order is preserved, so whatever the caller already
       ranked first in each group still leads it. Caller applies this
       AFTER its vote-count / relevance sort.

       Pure function (no network, no globals) -- exercised directly by
       scripts/test-runtime-demote.mjs. `getRuntimeMin(candidate)`
       returns the candidate's runtime in whole minutes, or null.
    ========================================================== */
    // ── test marker: slice start ──
    function demoteByRuntime(candidates, knownSeconds, getRuntimeMin) {
        // No known duration -> no-op, same array reference and order.
        if (!knownSeconds) return candidates;
        const targetMin = knownSeconds / 60;
        const kept = [];
        const demoted = [];
        for (const c of candidates) {
            const runtimeMin = getRuntimeMin(c);
            // null runtime is never demoted (see header).
            if (runtimeMin == null) { kept.push(c); continue; }
            const deltaFrac = Math.abs(runtimeMin - targetMin) / targetMin;
            (deltaFrac > 0.15 ? demoted : kept).push(c);
        }
        return kept.concat(demoted);
    }
    // ── test marker: slice end ──

    function imdbCandidateRuntimeMin(c) {
        return c?.runtime?.seconds != null ? Math.round(c.runtime.seconds / 60) : null;
    }

    // Sequel numbering swaps freely between roman and arabic ("Part III" vs
    // "Part 3") between how the stream/schedule names a title and how IMDb's
    // own titleText spells it -- normalize both to arabic so they compare
    // equal. Deliberately excludes bare I/V/X: those collide with the pronoun
    // "I", rating-board "V"/"X", etc. far too often in real titles to treat
    // as numerals.
    const ROMAN_NUMERALS = {
        ii: 2, iii: 3, iv: 4, vi: 6, vii: 7, viii: 8, ix: 9,
        xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15,
        xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20,
    };

    function normalizeTitle(s) {
        return (s || '')
            .toLowerCase()
            .replace(/^(the|a|an)\s+/, '')
            .split(/[^a-z0-9]+/)
            .filter(Boolean)
            .map(w => ROMAN_NUMERALS[w] !== undefined ? String(ROMAN_NUMERALS[w]) : w)
            .join(' ');
    }

    // Excluded from the token sets before comparing -- otherwise formulaic
    // genre titles that share only connector words (e.g. "Island of the
    // Living Dead" vs "Night of the Living Dead") clear the similarity bar on
    // "of"/"the"/"living"/"dead" alone despite being unrelated films.
    const TITLE_STOPWORDS = new Set(['a', 'an', 'the', 'of', 'and']);

    function titleTokens(s) {
        return new Set(normalizeTitle(s).split(' ').filter(w => w && !TITLE_STOPWORDS.has(w)));
    }

    // Dice coefficient over normalized, stopword-stripped word sets --
    // tolerant of punctuation, subtitle, and roman/arabic differences, but
    // still confidently rejects an unrelated title (near-zero token overlap).
    function titlesMatch(a, b) {
        const setA = titleTokens(a);
        const setB = titleTokens(b);
        if (!setA.size || !setB.size) return false;
        let intersection = 0;
        for (const w of setA) if (setB.has(w)) intersection++;
        return (2 * intersection) / (setA.size + setB.size) >= 0.7;
    }

    async function imdbSearchTitle(title, year, knownSeconds) {
        if (!title) return null;
        // One MainSearch for `term`, then the titleType tier walk, returning
        // the candidates whose own title actually resembles `term`. Factored
        // out of the body below so the bare-year recovery pass can re-run the
        // identical selection against a second search term without
        // duplicating (and drifting from) the tier logic.
        const searchAndMatch = async (term) => {
            const data = await imdbQuery('MainSearch', IMDB_MAIN_SEARCH_QUERY, { term });
            const edges = data?.data?.mainSearch?.edges || [];
            const results = edges.map(e => e?.node?.entity).filter(Boolean);
            const movies = results.filter(r => r.titleType?.id === 'movie');
            const tvEpisodes = results.filter(r => r.titleType?.id === 'tvEpisode');
            const nonPodcast = results.filter(r => r.titleType?.id !== 'podcastEpisode');
            // A candidate must actually resemble the query title before it's
            // eligible at all -- year is only a tiebreaker among title
            // matches, never a filter we fall back off of onto an unrelated
            // popular title (that was the bug: an obscure title with no
            // same-year candidate in the fuzzy top-20 would silently fall
            // back to picking the whole pool's most-voted entry, regardless
            // of title).
            //
            // Advance to the next tier only when the current one has no
            // title-matching candidate at all (not merely when it's empty) --
            // some genre titles (e.g. direct-to-video releases) are tagged a
            // titleType other than 'movie' on IMDb, so a same-named-but-wrong
            // 'movie' entry must not block the loop from ever reaching the
            // tier that actually holds the real title.
            const tiers = [movies, tvEpisodes, nonPodcast, results];
            for (const tier of tiers) {
                const matches = tier.filter(r => titlesMatch(r.titleText?.text, term));
                if (matches.length) return matches;
            }
            return [];
        };
        try {
            let titleMatches = await searchAndMatch(title);

            // ── Bare-year recovery ───────────────────────────────────────────
            // parseMovieFilename's bare-year fallback correctly reads the
            // trailing year off "Blade.Runner.1982" -- but it can't know that
            // for a title which legitimately ENDS in a year ("Class of 1984",
            // "Airport 1975", "Death Race 2000", "Summer of 1984" -- staples
            // on this channel) that trailing number is part of the name. Those
            // parse to { title: "Class of", year: "1984" }, and titlesMatch
            // then rejects IMDb's real "Class of 1984" against the truncated
            // query: tokens {class, 1984} vs {class} (`of` is a stopword) =
            // 0.667, under the 0.7 Dice floor -- every tier misses and the
            // whole lookup returns null.
            //
            // So when the tier walk found nothing at all AND we have a year,
            // fold the year back into the term and search once more:
            // "Class of 1984" vs "Class of 1984" scores 1.0. Strictly a
            // recovery step -- gated on an empty match set, so the happy paths
            // (Blade Runner, Collision Course) issue zero extra requests, and
            // gated on `year`, so a yearless parse can't double-search either.
            if (!titleMatches.length && year) {
                titleMatches = await searchAndMatch(`${title} ${year}`);
            }

            if (!titleMatches.length) return null;
            const yearMatches = year ? titleMatches.filter(r => String(r.releaseYear?.year) === String(year)) : [];
            const candidates = yearMatches.length ? yearMatches : titleMatches;
            // Vote-count / relevance sort first, THEN demote candidates whose
            // runtime is far from the playing file's duration -- so within the
            // kept group the most-voted real release still leads, and a
            // wrong-but-popular same-name title only loses when its runtime
            // gives it away. knownSeconds undefined (no call site passed one,
            // or changeMedia hasn't reported a duration) -> demoteByRuntime is
            // a pure no-op and this is byte-identical to the old pick.
            const ranked = candidates.slice().sort(byVoteCountDesc);
            const best = demoteByRuntime(ranked, knownSeconds, imdbCandidateRuntimeMin)[0] || null;
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
    // titleText/releaseYear added later (same shape as IMDB_MAIN_SEARCH_QUERY):
    // the by-title path already has canonical title/year from imdbSearchTitle's
    // `match`, but the pinned-override path in lookupMovie() resolves straight
    // from a tconst with no search step, so this is its only source of a
    // display title/year. Returned under distinct `titleText`/`releaseYear`
    // keys (NOT title/year) so fetchImdbMovieByTitle's `...(fields || {})`
    // spread can't collide with `match.title`/`match.year` -- the by-title path
    // stays byte-identical, these two keys just ride along unused there.
    const IMDB_TITLE_FIELDS_QUERY = 'query GHCombined($id: ID!){ title(id:$id){ id titleText{ text } releaseYear{ year } ratingsSummary{ aggregateRating voteCount } runtime{ seconds } plot{ plotText{ plainText } } primaryImage{ url width height } titleGenres{ genres{ genre{ text } } } } }';

    async function fetchImdbTitleFields(tconst) {
        if (!tconst) return null;
        try {
            const data = await imdbQuery('GHCombined', IMDB_TITLE_FIELDS_QUERY, { id: tconst });
            const t = data?.data?.title;
            if (!t) return null;
            return {
                titleText:    t.titleText?.text ?? null,
                releaseYear:  t.releaseYear?.year ?? null,
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
    // spread in as {} in that case). `match.title`/`match.year` win over the
    // spread -- fetchImdbTitleFields deliberately returns its own title/year
    // under titleText/releaseYear, so there's no key collision here.
    async function fetchImdbMovieByTitle(title, year, knownSeconds) {
        const match = await imdbSearchTitle(title, year, knownSeconds);
        if (!match || !match.tconst) return null;
        const fields = await fetchImdbTitleFields(match.tconst);
        return {
            tconst: match.tconst,
            title:  match.title,
            year:   match.year,
            ...(fields || {}),
        };
    }
