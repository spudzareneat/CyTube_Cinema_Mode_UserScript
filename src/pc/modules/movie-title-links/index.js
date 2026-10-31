    /* ==========================================================
       MOVIE LINKS — title/metadata lookup, TMDB-primary when the
       optional `tmdb` module is present and a key is configured, else
       IMDb-primary (the always-available fallback) — + Wikipedia.
       Populates the shared `_npData` (declared once in core's
       01-movie-identity.js) with everything the Now Playing card and
       the floating stats bar render.

       This module owns its own IMDb GraphQL traffic to
       caching.graphql.imdb.com (free, no API key -- hence the
       `connects`/`grants` entries on this module in manifest.json):
       title resolution (fetchImdbMovieByTitle, via imdbSearchTitle +
       fetchImdbTitleFields) and the parental-guide chips
       (fetchImdbParentalGuide) that the Now Playing card renders
       unconditionally regardless of which lookup path resolved the
       title. Both are plain local functions defined below, not an
       external dependency, so lookupMovie() calls them directly with
       no typeof-guard.

       `imdb-trivia` is a separate, optional module for the trivia
       panel feature; it hard-depends on this module (`dependsOn:
       ["core", "movie-title-links"]` in manifest.json) since trivia
       inherently needs a movie to already be identified, and its own
       fetchImdbTrivia() reuses imdbQuery()/imdbGmFetch() defined below
       rather than duplicating them.

       TMDB now plays a dual role, both supplied by the optional `tmdb`
       module and both reached through the same typeof-guard pattern so
       a build without that module (or before it exists) still resolves
       the rest of the lookup via IMDb alone:
       - Primary: when a TMDB API key is configured, fetchTmdbPrimary
         (title, year) is tried first (better title/rating/overview
         matching than IMDb's GraphQL search); when it finds a
         confidently-linked match (a real external_ids.imdb_id), its
         result is used directly and the IMDb-primary lookup is skipped
         entirely.
       - Fallback/supplemental: whenever TMDB-primary doesn't run (no
         key, module absent) or comes back empty (no match, no linked
         IMDb id), lookupMovie() falls through to exactly the original
         IMDb-primary flow, with fetchTmdbSupplemental(imdbId) layering
         TMDB's poster/backdrop/kill-count on top if a key is set.

       Same typeof-guard pattern applies to the "Trivia" button's click
       handler (toggleTriviaPanel), since imdb-trivia is a genuinely
       optional module — and, in the other direction, for this
       module's own calls into the optional tonights-lineup module's
       lineupObserveTitleChange (feeds its timing/ETA model; this
       module doesn't depend on tonights-lineup, so a build without it
       just skips those calls).
    ========================================================== */

    // Fallback when changeMedia hasn't fired yet this session (e.g. a
    // fresh/refreshed page load) -- reads the video id straight from the
    // YouTube iframe's src, the same element isYouTubeMedia() (core) checks.
    function _domYtVideoId() {
        const el = document.querySelector('#ytapiplayer iframe[src*="youtube.com"]');
        if (!el) return '';
        const src = el.getAttribute('src') || '';
        const m = src.match(/[?&]v=([\w-]{11})/) || src.match(/\/embed\/([\w-]{11})/);
        return m ? m[1] : '';
    }

    // Free, no-key YouTube oEmbed lookup -- title/channel/thumbnail only, no
    // year/plot/rating/imdbId. Used only as a fallback for short clips that
    // injectMovieLinks() otherwise skips entirely (trailers/bumpers/ads).
    // Resolves null on any failure instead of rejecting, so the call site
    // needs no .catch().
    function fetchYtOembed(videoId) {
        if (!videoId) return Promise.resolve(null);
        const watchUrl = 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId);
        const url = 'https://www.youtube.com/oembed?url=' + encodeURIComponent(watchUrl) + '&format=json';
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                onload: r => {
                    if (r.status >= 200 && r.status < 300) {
                        try { resolve(JSON.parse(r.responseText)); }
                        catch (e) { resolve(null); }
                    } else {
                        resolve(null);
                    }
                },
                onerror: () => resolve(null),
            });
        });
    }

    // One call per lookup, keyed off the final resolved imdbId (episode tconst
    // when episode-refined) -- runs on every path (tmdb / imdb / pinned), so it's
    // the cheapest place to also pull the MPAA/IMDb certificate. Returns
    // { guide, certificate }: `guide` is the parental-guide severity array (or
    // null, unchanged from the old bare-array return -- see the one caller in
    // lookupMovie), `certificate` is the rating string ("R", "PG-13",
    // "Not Rated", "X", "Approved", ...) or null. Also rides along the top 3
    // billed cast with headshots for the card's "Starring" row -- `cast` is
    // [{ name, character, photo, knownFor }] (any but name may be null);
    // knownFor is the actor's most-voted IMDb "known for" title { title, year }
    // other than the one playing (or, for an episode, its parent series --
    // IMDb's knownFor only lists series-level titles). Whole call
    // fails soft to { guide: null, certificate: null, cast: null } on any error.
    // `characters` only exists on the Cast implementation, hence the inline
    // fragment (same shape as trivia-popup's fetchCastAndDirector).
    //
    // Cast comes from principalCredits (IMDb's "Stars" line = top billing)
    // first. The full `credits` list is NOT reliably in billing order -- for
    // some titles (e.g. Candyman: Farewell to the Flesh) it's alphabetical,
    // which dropped Tony Todd off the card. `credits` stays as a fallback for
    // titles with no principal cast.
    async function fetchImdbTitleGuide(tconst) {
        if (!tconst) return { guide: null, certificate: null, cast: null };
        const P = 'name{ id nameText{ text } primaryImage{ url } knownFor(first: 4){ edges{ node{ title{ id titleText{ text } releaseYear{ year } ratingsSummary{ voteCount } } } } } } ... on Cast { characters{ name } }';
        const q = 'query GHGuide($id: ID!){ title(id:$id){ series{ series{ id } } certificate{ rating } parentsGuide{ categories{ category{ text } severity{ text } } } '
            + 'stars: principalCredits(filter: { categories: ["cast"] }) { credits{ ' + P + ' } } '
            + 'cast: credits(first: 3, filter: { categories: ["cast"] }) { edges{ node{ ' + P + ' } } } } }';
        try {
            const data = await imdbQuery('GHGuide', q, { id: tconst });
            const t = data?.data?.title;
            const cats = t?.parentsGuide?.categories;
            const guide = cats
                ? cats.map(c => ({ category: c.category?.text, severity: c.severity?.text }))
                      .filter(c => c.category && c.severity)
                : null;
            const stars = (t?.stars || []).flatMap(g => g?.credits || []);
            const credits = stars.length ? stars : (t?.cast?.edges || []).map(e => e?.node);
            const cast = credits.map(c => ({
                name: c?.name?.nameText?.text ?? null,
                nconst: c?.name?.id ?? null,
                character: c?.characters?.[0]?.name ?? null,
                photo: _imdbThumb(c?.name?.primaryImage?.url),
                knownFor: _topKnownFor(c?.name?.knownFor, [tconst, t?.series?.series?.id]),
            })).filter(c => c.name).slice(0, 3);
            return { guide, certificate: t?.certificate?.rating ?? null, cast };
        } catch (e) { return { guide: null, certificate: null, cast: null }; }
    }

    // Highest-vote-count knownFor title not in `excludeIds`, as { title, year },
    // else null -- same pick rule as trivia-popup's fetchPersonKnownFor.
    function _topKnownFor(knownFor, excludeIds) {
        const titles = (knownFor?.edges || [])
            .map(e => e?.node?.title)
            .filter(t => t && t.id && !excludeIds.includes(t.id) && t.titleText?.text);
        if (!titles.length) return null;
        titles.sort((a, b) => (b.ratingsSummary?.voteCount ?? 0) - (a.ratingsSummary?.voteCount ?? 0));
        return { title: titles[0].titleText.text, year: titles[0].releaseYear?.year ?? null, tconst: titles[0].id };
    }

    // Bump when the cached `cast` shape/source changes so lookupMovie's cache
    // hit path refetches it (2 = principalCredits billing order + knownFor,
    // 3 = + actor nconst / knownFor tconst for the IMDb links).
    const CAST_VER = 3;

    // IMDb image URLs are full-size originals (some headshots are 6000px wide);
    // the `._V1_UX120_` suffix asks the CDN for a 120px-wide resize instead.
    function _imdbThumb(url) {
        return url ? url.replace(/\._V1_[^/]*\.jpg$/, '._V1_UX120_.jpg') : null;
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

    // ── test marker: override store slice start ──
    /* ==========================================================
       MATCH-OVERRIDE STORE (Layer 3c) — per-raw-filename pins.

       When the auto-match resolves the wrong TMDB/IMDb entry for the
       playing file, the Settings "Fix match" modal (Task 5) writes the
       correct ids here, keyed by the EXACT raw #currenttitle text
       (pre-parse, e.g. "The.Crippled.Masters.[1979].mp4"). lookupMovie()
       below then bypasses both search steps for that filename and enriches
       the pinned imdbId directly.

       Loaded once into a `let`, exactly like movieLinkCache above. The
       three accessors keep the in-memory copy and localStorage in sync and
       never throw on an absent key or malformed JSON — same defensive
       pattern as the movieLinkCache loader.

       Value shape: { "<rawFilename>": { imdbId: "tt…", tmdbId: <number|null>, ts: <epoch ms> } }
    ========================================================== */
    let movieOverrides = (() => {
        try {
            const raw = localStorage.getItem(LS_MOVIE_OVERRIDE);
            const parsed = raw ? JSON.parse(raw) : {};
            return (parsed && typeof parsed === 'object') ? parsed : {};
        } catch (e) { return {}; }
    })();

    function _persistMovieOverrides() {
        try { localStorage.setItem(LS_MOVIE_OVERRIDE, JSON.stringify(movieOverrides)); }
        catch (e) { /* storage full/unavailable -- session in-memory copy still works */ }
    }

    // The pinned entry for this raw filename, or undefined when there's no
    // usable pin (missing filename, no entry, or a malformed entry with no
    // imdbId). Never throws.
    function getMovieOverride(rawFilename) {
        try {
            if (!rawFilename) return undefined;
            const entry = movieOverrides[rawFilename];
            return (entry && typeof entry === 'object' && entry.imdbId) ? entry : undefined;
        } catch (e) { return undefined; }
    }

    // Pin rawFilename to a specific IMDb id (+ optional TMDB id). tmdbId is
    // normalized to null when absent; ts is a plain epoch-ms stamp for
    // Task 5's "pinned <date>" line. A call with no imdbId is a no-op.
    function setMovieOverride(rawFilename, { imdbId, tmdbId } = {}) {
        try {
            if (!rawFilename || !imdbId) return;
            movieOverrides[rawFilename] = { imdbId, tmdbId: tmdbId ?? null, ts: Date.now() };
            _persistMovieOverrides();
        } catch (e) { /* ignore -- nothing pinned this session */ }
    }

    function clearMovieOverride(rawFilename) {
        try {
            if (!rawFilename || !(rawFilename in movieOverrides)) return;
            delete movieOverrides[rawFilename];
            _persistMovieOverrides();
        } catch (e) { /* ignore */ }
    }
    // ── test marker: override store slice end ──

    // The parsed-title cache key used by lookupMovie(). Factored out (was an
    // inline expression) so the override re-render plumbing below can
    // recompute and drop a stale entry for a filename without duplicating —
    // and silently drifting from — the expression. Behaviour is byte-
    // identical to the old inline form: title + year + optional SxxExx tag.
    function _parsedCacheKey(title, year, season, episode) {
        return title + (year || '') + (episode != null ? `S${season ?? ''}E${episode}` : '');
    }

    // knownSeconds: the playing file's duration (getCurrentMediaSeconds) when
    // it's known and > 0, else undefined. Optional TRAILING param -- every
    // pre-existing behaviour is byte-identical when it's omitted. Kept at
    // position 5 exactly; later tasks stack another positional arg after it.
    async function lookupMovie(title, year, season, episode, knownSeconds, rawFilename) {
        // ── User-pinned match override (Layer 3c) ────────────────────────────
        // rawFilename is the exact raw #currenttitle text; only injectMovieLinks
        // passes it. Any other caller (tonights-lineup passes just title+year)
        // omits it -> override is null -> everything below is byte-identical to
        // before. When a pin exists for this filename, the parsed cacheKey is
        // replaced by a distinct `override:<rawFilename>` namespace: that keeps
        // pinned and auto-matched results in separate cache slots, so clearing a
        // pin cleanly re-exposes / recomputes the normal parsed-key entry and a
        // stale wrong parsed-key entry can never shadow a live pin.
        const override = rawFilename ? getMovieOverride(rawFilename) : null;

        // Extend the key with season/episode so two episodes sharing an
        // identical cleaned title (e.g. two differently-numbered episodes
        // that both parsed down to "The Tomorrow People") don't collide in
        // the cache. Additive-only: when episode is null (the movie case),
        // the key is byte-identical to before, so existing cached movie
        // entries stay valid with no migration needed.
        const cacheKey = override
            ? ('override:' + rawFilename)
            : _parsedCacheKey(title, year, season, episode);
        if (movieLinkCache[cacheKey] !== undefined) {
            const hit = movieLinkCache[cacheKey];
            // Entries cached before the current "Starring" row shape have an
            // older (or no) castVer -- missing cast, no knownFor, or cast taken
            // in IMDb's non-billing order. Backfill once from the same GHGuide
            // query and re-persist.
            if (hit && hit.imdbId && hit.castVer !== CAST_VER) {
                const { cast } = await fetchImdbTitleGuide(hit.imdbId);
                if (cast) {
                    hit.cast = cast;
                    hit.castVer = CAST_VER;
                    try { localStorage.setItem(LS_MOVIE_CACHE, JSON.stringify(movieLinkCache)); }
                    catch (e) { /* in-memory cache still has it */ }
                }
            }
            return hit;
        }

        // ── TMDB-primary attempt + Wikipedia, kicked off together ─────────────────
        // TMDB-primary doesn't depend on Wikipedia's result (or vice versa), so
        // both start together rather than waterfalling. Only tmdbPrimaryPromise is
        // awaited here, though -- awaiting Promise.all([tmdbPrimaryPromise,
        // wikiPromise]) before branching would make the IMDb-fallback branch below
        // wait on Wikipedia's full round-trip before even starting
        // fetchImdbMovieByTitle, serializing two calls that ran concurrently
        // before this change. wikiPromise is instead left running in the
        // background and only awaited once, right before it's needed to build
        // `result` -- by then it has been in flight for the same amount of time
        // either branch took, so this doesn't add latency, it just moves the
        // await to where it belongs.
        let wikiUrl = null;

        // Override path skips the TMDB-primary *search* entirely -- the pinned
        // id is authoritative. Non-override path is unchanged.
        const tmdbPrimaryPromise = (!override && typeof fetchTmdbPrimary === 'function')
            ? fetchTmdbPrimary(title, year, knownSeconds, episode != null)
            : Promise.resolve(null);

        // Wikipedia can start immediately with the raw title; we'll use the
        // resolved title if available, but since it runs in parallel we use the
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

        // fetchTmdbPrimary trusts TMDB's own server-side relevance ranking with
        // no client-side fuzzy check of its own (see that function's comment) --
        // but titlesMatch() exists precisely because "top-ranked result" isn't
        // the same as "actually the right title" (the IMDb path above hit this
        // exact bug class: an unrelated popular/plausible-looking title getting
        // picked when nothing in the fuzzy results truly matched). Since a TMDB
        // hit now short-circuits the IMDb path entirely whenever it carries a
        // linked imdb_id, skipping this guard here would mean keyed users lose
        // the title-match safety net on every lookup, not just the IMDb one --
        // so re-apply the same already-tuned titlesMatch() (Dice coefficient
        // >= 0.7) at this call site rather than reimplementing it in the tmdb
        // module, which only depends on core and has no access to it directly.
        const rawTmdbPrimary = await tmdbPrimaryPromise;
        const tmdbPrimary = (rawTmdbPrimary && titlesMatch(rawTmdbPrimary.title, title))
            ? rawTmdbPrimary
            : null;

        let imdbResult = null;
        let tmdbSupplemental = null;
        let imdbId;

        if (override) {
            // ── Pinned-match fork (Layer 3c) ────────────────────────────────
            // The user corrected a wrong auto-match for this exact raw
            // filename. Trust override.imdbId verbatim: skip BOTH search steps
            // (fetchTmdbPrimary above is already gated off, and
            // fetchImdbMovieByTitle / imdbSearchTitle are simply not called
            // here) and their fuzzy-title guards. Then fall through into the
            // identical enrichment tail below (episode refinement, parental
            // guide, Wikipedia, TMDB art/kills, `result` assembly) so a pin
            // yields the same card an auto-match would. fetchImdbTitleFields is
            // the very call the non-override IMDb branch makes inside
            // fetchImdbMovieByTitle; assigning it to imdbResult lets the
            // `??` merge chain below pick up rating/runtime/overview/poster/
            // genres with no other change. fetchTmdbSupplemental(imdbId) is the
            // same supplemental path the non-override IMDb branch uses.
            imdbId = override.imdbId;
            imdbResult = await fetchImdbTitleFields(imdbId);
            tmdbSupplemental = (typeof fetchTmdbSupplemental === 'function')
                ? await fetchTmdbSupplemental(imdbId)
                : null;
        } else if (tmdbPrimary) {
            // TMDB found a confidently-linked match (a real external_ids.imdb_id)
            // -- use it directly and skip the IMDb-primary lookup (and its
            // TMDB-supplemental enrichment, which fetchTmdbPrimary already made
            // redundant by resolving its own tmdb id) entirely.
            imdbId = tmdbPrimary.imdbId;
        } else {
            // ── Exactly today's flow: IMDb (primary) + TMDB supplemental ─────────
            // Reached whenever TMDB-primary didn't run at all (no key configured,
            // or the tmdb module isn't in this build) or came back empty (no
            // search results, or a match with no linked IMDb id). fetchImdbMovieByTitle
            // starts right here, running concurrently with wikiPromise (which has
            // been in flight since before the tmdbPrimaryPromise await above) --
            // restoring the original IMDb/Wikipedia parallelism byte-for-byte, just
            // with fetchTmdbPrimary's near-instant no-key check now also racing
            // alongside both.
            imdbResult = await fetchImdbMovieByTitle(title, year, knownSeconds, episode != null);
            imdbId = imdbResult?.tconst || null;
            tmdbSupplemental = (typeof fetchTmdbSupplemental === 'function')
                ? await fetchTmdbSupplemental(imdbId)
                : null;
        }

        // ── Episode-specific refinement — resolves this exact episode's own
        // IMDb tconst/plot/rating/still via the series tconst just resolved
        // above (whichever path found it), independent of TMDB entirely (see
        // fetchImdbEpisodeInfo's header comment for the confirmed query
        // shape). Only overrides fields when a match is actually found — an
        // unaired/absolute-numbering-mismatched episode just leaves the
        // series-level data from above untouched, same graceful-fallback
        // shape as the rest of this function. Switching imdbId to the
        // episode's own tconst here (before the parental-guide fetch and the
        // `links`/`resolved` fields below) is what makes the parental guide,
        // trivia panel (keyed off _currentImdbId, itself set from
        // result.imdbId), and .links.imdb/.links.letterboxd all become
        // episode-specific for free — no changes needed in imdb-trivia at all.
        const episodeInfo = (season != null && episode != null)
            ? await fetchImdbEpisodeInfo(imdbId, season, episode)
            : null;
        if (episodeInfo) imdbId = episodeInfo.tconst;

        // ── IMDb Parent Guide + MPAA certificate — also defined above in this
        // file; called directly, same as fetchImdbMovieByTitle above. No TMDB
        // equivalent exists, so this always runs off whichever path resolved
        // imdbId. ───────
        const { guide: parentalGuide, certificate, cast } = await fetchImdbTitleGuide(imdbId);

        // wikiPromise has been running in the background this whole time; awaited
        // here (rather than up front via Promise.all) so it never blocks the
        // branch above from starting fetchImdbMovieByTitle. By this point it has
        // had at least as long to resolve as either branch took, so this rarely
        // adds any real wait.
        await wikiPromise;

        // `??` is used consistently through this whole merge chain (never mixed
        // with `||`) -- safe here since every source field is either a real
        // value or null/undefined (fetchImdbTitleFields already normalizes this
        // way), and necessary for fields like `rating`, where a legitimate 0.0
        // must not be treated as "missing" the way `||` would.
        const result = {
            season:  season ?? null,
            episode: episode ?? null,
            links: {
                imdb:       imdbId ? `https://www.imdb.com/title/${imdbId}/` : null,
                // Letterboxd supports an /imdb/<id> redirect (same as its /tmdb/<id>
                // one), so this keys off imdbId directly -- available whenever
                // either lookup path resolved one, regardless of which source it
                // came from.
                letterboxd: imdbId ? `https://letterboxd.com/imdb/${imdbId}` : null,
                wiki:       wikiUrl,
            },
            // A pinned lookup resolves as soon as we have the user's imdbId,
            // even if fetchImdbTitleFields came back null (transient failure) --
            // the pin itself is the answer, so `(override && imdbId)` keeps it
            // out of the "unresolved, don't cache" bucket.
            resolved:   !!(tmdbPrimary || imdbResult || (override && imdbId)),
            killCount:  tmdbPrimary?.killCount ?? tmdbSupplemental?.killCount ?? null,
            parentalGuide,
            // MPAA/IMDb certificate string ("R", "PG-13", "Not Rated", ...) or
            // null. IMDb-only -- fetchImdbTitleGuide above runs on every path.
            certificate: certificate ?? null,
            // Top-billed cast for the "Starring" row (IMDb-only, same call as
            // the certificate). null on a fetch failure, [] when IMDb lists none.
            cast:        cast ?? null,
            castVer:     CAST_VER,
            imdbId,
            // episodeName has no series-level equivalent to fall back to -- null
            // for movies and for episodes fetchImdbEpisodeInfo couldn't match.
            episodeName: episodeInfo?.title ?? null,
            cleanTitle: tmdbPrimary?.title    ?? imdbResult?.title    ?? null,
            cleanYear:  tmdbPrimary?.year     ?? imdbResult?.year     ?? null,
            // Episode-specific rating/runtime/overview take priority over the
            // show-level values above -- an episode's own rating routinely
            // differs a lot from the show's aggregate (e.g. a finale vs. a
            // filler episode), and its plot is the actual episode synopsis
            // rather than the show's overall premise.
            rating:     episodeInfo?.rating   ?? tmdbPrimary?.rating   ?? imdbResult?.rating   ?? null,
            runtime:    episodeInfo?.runtime  ?? tmdbPrimary?.runtime  ?? imdbResult?.runtime  ?? null,
            genres:     tmdbPrimary?.genres   ?? imdbResult?.genres   ?? [],
            // TMDB's poster/backdrop take priority (from either the primary match
            // or the supplemental enrichment) over IMDb's; IMDb has no dedicated
            // wide "backdrop" field, so its (usually portrait) primaryImage is
            // reused for both -- the card's CSS crops it to fill (`background-size:
            // cover`), same pattern apps use when no dedicated backdrop exists.
            // The episode's own still image (when found) beats all of that --
            // it's the one image actually specific to what's playing right now.
            poster:     tmdbPrimary?.poster   ?? tmdbSupplemental?.poster   ?? imdbResult?.poster ?? null,
            backdrop:   episodeInfo?.image    ?? tmdbPrimary?.backdrop ?? tmdbSupplemental?.backdrop ?? imdbResult?.poster ?? null,
            overview:   episodeInfo?.overview ?? tmdbPrimary?.overview ?? imdbResult?.overview ?? null,
        };

        // ── Which lookup path resolved this entry (Task 5's modal renders it
        // as the "Matched via" line). 'pinned' when the user override drove it,
        // else 'tmdb' / 'imdb' for whichever auto-source was used, else null
        // (unresolved). Inert here -- nothing in this module branches on it. ──
        result.matchSource = override
            ? 'pinned'
            : (tmdbPrimary ? 'tmdb' : (imdbResult ? 'imdb' : null));

        // On a pin, cleanTitle/cleanYear from the `??` chain above are null
        // (tmdbPrimary is null and fetchImdbTitleFields' title/year live under
        // titleText/releaseYear, not title/year). Prefer IMDb's canonical
        // title/year for the pinned tconst so the Now Playing bar shows the
        // corrected title next to Task 5's "pinned" badge -- not the original
        // garbage parse. Falls back to the chain result, then the parsed
        // title/year. Override path only; the auto paths are untouched.
        if (override) {
            result.cleanTitle = imdbResult?.titleText   ?? result.cleanTitle ?? (title || null);
            result.cleanYear  = imdbResult?.releaseYear  ?? result.cleanYear  ?? (year || null);
        }

        // ── Runtime delta for Task 5's "Matched as" line ─────────────────────
        // Whole-minute gap between the resolved title's runtime and the playing
        // file's duration -- the same signal demoteByRuntime() ranked on above,
        // surfaced for display. An explicit `!= null` guard (not `??`/`||`)
        // because "unknown" here depends on TWO inputs, not one nullable value:
        // null only when this title has no runtime (no key + IMDb lacks one) OR
        // changeMedia hasn't reported a duration yet -- a genuine 0-minute delta
        // (runtime matches to the minute) must survive as 0, same reasoning as
        // fetchImdbEpisodeInfo's runtime guard. Uses result.runtime, so the
        // delta always matches whatever runtime the card actually shows
        // (episode-specific when episode refinement found one, else the film's).
        const _targetMin = knownSeconds > 0 ? knownSeconds / 60 : null;
        result.runtimeDelta = (_targetMin != null && result.runtime != null)
            ? Math.round(Math.abs(result.runtime - _targetMin))
            : null;

        // Only persist a resolved result -- caching an unresolved one (e.g. a
        // transient IMDb GraphQL failure) would permanently poison future
        // lookups for this title, the same trap the old TMDB-absent case fell
        // into pre-upgrade. An unresolved result still gets returned to the
        // caller this time, just not cached.
        //
        // The `!(override && !imdbResult)` half closes the same hole on the
        // PINNED fork. There, resolved is forced true by `(override && imdbId)`
        // above -- deliberately, so the card shows the user's pin instantly --
        // which means a pin whose fetchImdbTitleFields() came back null
        // (network blip, IMDb 5xx, dead tconst) would otherwise persist a
        // sparse entry under `override:<rawFilename>`: no poster, rating,
        // runtime or genres, and cleanTitle degraded to the parsed garbage
        // title. Being cached, it would then be served forever -- only
        // re-pinning or a full Settings->Save cache wipe could dislodge it.
        // So such a result is shown once but NOT written; the next play of the
        // file retries the enrichment fetch. A pin whose fetch SUCCEEDED has a
        // truthy imdbResult -> caches normally, and the auto path has a null
        // override -> `!(null && ...)` -> true, so it is untouched.
        if (result.resolved && !(override && !imdbResult)) {
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

    // e.g. (1, 10) -> "S01E10"; (null, 5) -> "E05" (bare "Ep. 5" pattern has
    // no season group); (null, null) -> '' for movies (isEpisode false).
    function _episodeTag(season, episode) {
        if (episode == null) return '';
        const ep = String(episode).padStart(2, '0');
        return season != null ? `S${String(season).padStart(2, '0')}E${ep}` : `E${ep}`;
    }

    /* ==========================================================
       "MATCHED AS" PURE HELPERS (Layer 3a) — no DOM, no network,
       no globals, so scripts/test-fix-match-helpers.mjs can slice
       this block out between the markers and eval it directly.

       _fixMatchDetectTconst: given whatever the user typed into the
       Fix-match search box, returns a bare tt-id when the input is an
       IMDb title id or a full imdb.com/title/ URL, else null (meaning
       "treat this as a free-text search term").

       _fixRuntimeIndicator: computes the runtime ✓/✗/unknown verdict
       for a match (result.runtimeDelta -- whole-minute |runtime -
       knownDuration| gap, or null -- the resolved title's runtime in
       minutes, and the playing file's duration in whole minutes). 15%
       tolerance mirrors demoteByRuntime(). No longer surfaced on the
       Now Playing card itself (that debug line was removed as
       unhelpful noise); kept here, tested, for any future diagnostic
       UI that wants it.
    ========================================================== */
    // ── test marker: fix-match helpers slice start ──
    function _fixMatchDetectTconst(input) {
        const m = String(input == null ? '' : input).match(/(?:imdb\.com\/title\/)?(tt\d{6,})/i);
        return m ? m[1].toLowerCase() : null;
    }

    function _fixRuntimeIndicator(runtimeDelta, runtimeMin, knownMin) {
        // Nothing to say if the resolved title has no runtime at all.
        if (runtimeMin == null) return '';
        // Have a runtime but can't compare it (no reported file duration, or
        // the delta was never computed) -> flag it as unverified rather than
        // silently implying a match.
        if (knownMin == null || knownMin <= 0 || runtimeDelta == null) return 'runtime unknown';
        const within = (runtimeDelta / knownMin) <= 0.15;
        return within
            ? `runtime ✓ IMDb ${runtimeMin}m ≈ file ${knownMin}m`
            : `runtime ✗ IMDb ${runtimeMin}m vs file ${knownMin}m`;
    }
    // ── test marker: fix-match helpers slice end ──

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
                        <div id="sc-np-match"></div>
                        <div id="sc-np-actions">
                            <button id="sc-np-fix" type="button" title="Pin the correct movie for this file">✎ Wrong match?</button>
                            <button id="sc-np-simkl" type="button" title="Open the Simkl scrobble card (Alt+Shift+S)">✓ Log on Simkl</button>
                        </div>
                        <div id="sc-np-overview"></div>
                        <div id="sc-np-cast"></div>
                        <div id="sc-np-mpaa"></div>
                        <div id="sc-np-chips"></div>
                        <div id="sc-np-links"></div>
                    </div>
                </div>`;
            document.body.appendChild(card);
            card.addEventListener('click', hideNowPlayingCard);
            // The button lives inside the card, whose click closes it -- so the
            // handler must stopPropagation. Attached once; it reads the live
            // _npData (every call site passes exactly that object as `data`).
            card.querySelector('#sc-np-fix').addEventListener('click', (e) => {
                e.stopPropagation();
                if (_npData && _npData.rawFilename && _npData.parsedTitle) {
                    openFixMatchModal(_npData.rawFilename, _npData.parsedTitle, _npData.parsedYear);
                }
            });
            // Optional simkl-scrobble module: typeof-guarded so a build without it
            // just never shows (or wires up) a working button.
            card.querySelector('#sc-np-simkl').addEventListener('click', (e) => {
                e.stopPropagation();
                hideNowPlayingCard();
                if (typeof simklOpenFromInfoCard === 'function') simklOpenFromInfoCard();
            });
        }
        const title = data.cleanTitle || '';
        const year  = data.cleanYear ? ` (${data.cleanYear})` : '';
        const epTag = _episodeTag(data.season, data.episode);
        card.querySelector('#sc-np-backdrop').style.backgroundImage = data.backdrop ? `url(${data.backdrop})` : 'none';
        const poster = card.querySelector('#sc-np-poster');
        if (data.poster) { poster.src = data.poster; poster.style.display = ''; }
        else poster.style.display = 'none';
        card.querySelector('#sc-np-title').textContent = title + year + (epTag ? ` · ${epTag}` : '')
            + (data.episodeName ? ` · ${data.episodeName}` : '');
        card.querySelector('#sc-np-overview').textContent = data.overview || '';

        // ── "Starring" row: top-billed cast with round headshots. Built with
        // textContent (names come from IMDb, never trust them as HTML); a
        // missing/broken photo falls back to the actor's initials.
        const castEl = card.querySelector('#sc-np-cast');
        castEl.textContent = '';
        const cast = (data.cast || []).slice(0, 3);
        if (cast.length) {
            const lbl = document.createElement('div');
            lbl.className = 'sc-np-cast-label';
            lbl.textContent = 'Starring';
            castEl.appendChild(lbl);
            const row = document.createElement('div');
            row.className = 'sc-np-cast-row';
            // The actor's photo + name link to their IMDb page and the
            // "Known for" line to that title's -- <a> when we have an id
            // (cache entries older than CAST_VER 3 don't), plain <div> otherwise.
            // stopPropagation keeps the click from also closing the card.
            const linkOrDiv = (url) => {
                if (!url) return document.createElement('div');
                const a = document.createElement('a');
                a.href = url;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.addEventListener('click', (e) => e.stopPropagation());
                return a;
            };
            cast.forEach(c => {
                const personUrl = c.nconst ? `https://www.imdb.com/name/${c.nconst}/` : null;
                const item = document.createElement('div');
                item.className = 'sc-np-cast-item';
                const pic = linkOrDiv(personUrl);
                pic.className = 'sc-np-cast-pic';
                pic.textContent = c.name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
                if (c.photo) {
                    const img = document.createElement('img');
                    img.alt = '';
                    img.src = c.photo;
                    img.addEventListener('error', () => img.remove());
                    pic.appendChild(img);
                }
                const txt = document.createElement('div');
                txt.className = 'sc-np-cast-text';
                const nm = linkOrDiv(personUrl);
                nm.className = 'sc-np-cast-name';
                nm.textContent = c.name;
                if (personUrl) nm.title = `${c.name} on IMDb`;
                txt.appendChild(nm);
                if (c.character) {
                    const ch = document.createElement('div');
                    ch.className = 'sc-np-cast-char';
                    ch.textContent = c.character;
                    txt.appendChild(ch);
                }
                if (c.knownFor) {
                    const kf = linkOrDiv(c.knownFor.tconst ? `https://www.imdb.com/title/${c.knownFor.tconst}/` : null);
                    kf.className = 'sc-np-cast-known';
                    kf.textContent = c.knownFor.title + (c.knownFor.year ? ` (${c.knownFor.year})` : '');
                    kf.title = `Best known for ${kf.textContent}`;
                    txt.appendChild(kf);
                }
                item.appendChild(pic);
                item.appendChild(txt);
                row.appendChild(item);
            });
            castEl.appendChild(row);
            castEl.style.display = '';
        } else {
            castEl.style.display = 'none';
        }
        const metaParts = [];
        if (data.rating)  metaParts.push(`⭐ ${data.rating}`);
        if (data.runtime) metaParts.push(`${Math.floor(data.runtime / 60)}h ${data.runtime % 60}m`);
        if (data.genres && data.genres.length) metaParts.push(data.genres.slice(0, 3).join(' · '));
        if (typeof scGetLastAired === 'function') {
            const la = scGetLastAired(title, data.cleanYear);
            if (la) metaParts.push(`📅 Last aired ${la.dateStr}`);
        }
        card.querySelector('#sc-np-meta').textContent = metaParts.join('     ');

        // ── "Matched as" diagnostic + "Wrong match?" button (Layer 3a) ───────
        // Shown only for a real parsed movie match: hidden entirely for YouTube
        // clips (parsedTitle null) and while a card still lacks parse data. The
        // dim block itself additionally needs a resolved imdbId; the button
        // shows without one so a total match failure can still be corrected.
        const fixBtn  = card.querySelector('#sc-np-fix');
        const matchEl = card.querySelector('#sc-np-match');
        // setProperty(..., 'important') -- NOT a plain `.style.display =`. The
        // #sc-np-fix rule in style.css declares `display: inline-flex !important`
        // (every rule in this module is !important to survive CyTube's own
        // sheets), and a normal inline declaration LOSES to an author
        // !important one. So a plain assignment of 'none' here was a silent
        // no-op and the button rendered on every card -- including YouTube
        // clips (where it's a dead no-op) and tonights-lineup's per-item
        // cards (where clicking it opened the fix modal keyed to the wrong
        // file). An important inline declaration outranks the sheet, so both
        // the show and the hide branch now actually take effect; 'inline-flex'
        // (not '') is restored on the show branch since '' would drop back to
        // the sheet's value and we no longer rely on the cascade for it.
        // Gate is deliberately rawFilename && parsedTitle, NOT imdbId -- a
        // total match failure is exactly when the user most needs this.
        fixBtn.style.setProperty('display', (data.rawFilename && data.parsedTitle) ? 'inline-flex' : 'none', 'important');
        // "Log on Simkl": only for the live now-playing movie (not tonights-lineup's
        // per-item cards -- the scrobble card always targets _currentImdbId), only
        // when the Simkl module is built in and opted into, and never for episodes.
        const simklOk = typeof simklOpenFromInfoCard === 'function' && typeof simklEnabled === 'function' && simklEnabled()
            && data === _npData && data.imdbId && data.imdbId === _currentImdbId && data.episode == null;
        card.querySelector('#sc-np-simkl').style.setProperty('display', simklOk ? 'inline-flex' : 'none', 'important');
        if (data.imdbId && data.parsedTitle) {
            const SRC_LABEL = { tmdb: 'TMDB', imdb: 'IMDb search', pinned: 'pinned' };
            const srcLabel = SRC_LABEL[data.matchSource] || '';
            let line1 = `Matched: ${title}${data.cleanYear ? ` (${data.cleanYear})` : ''} · ${data.imdbId}`;
            if (srcLabel) line1 += ` — ${srcLabel}`;
            matchEl.textContent = '';
            const d1 = document.createElement('div');
            d1.textContent = line1;
            matchEl.appendChild(d1);
            // Raw #currenttitle text that was fed to the parser -- the actual
            // input behind line1, so a wrong auto-match can be diagnosed at a
            // glance. textContent, never innerHTML: filenames are untrusted.
            if (data.rawFilename) {
                const d3 = document.createElement('div');
                d3.className = 'sc-np-match-parsed';
                d3.textContent = `file: ${data.rawFilename}`;
                matchEl.appendChild(d3);
            }
            matchEl.style.display = '';
        } else {
            matchEl.textContent = '';
            matchEl.style.display = 'none';
        }

        // ── MPAA / IMDb certificate badge — sits between the description and the
        // parental-guide chips (see #sc-np-mpaa in the template). Rendered for any
        // non-empty certificate string, including "Not Rated"/"Unrated"/"Approved"
        // (all meaningful on a grindhouse channel); hidden only when null.
        const mpaaEl = card.querySelector('#sc-np-mpaa');
        const cert = data.certificate;
        if (cert) {
            mpaaEl.textContent = '';
            const box = document.createElement('span');
            box.className = 'sc-np-mpaa-box sc-mpaa-' + String(cert).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            const rl = document.createElement('span');
            rl.className = 'sc-np-mpaa-label';
            rl.textContent = 'RATED';
            const rv = document.createElement('span');
            rv.className = 'sc-np-mpaa-value';
            rv.textContent = cert;
            box.appendChild(rl);
            box.appendChild(rv);
            mpaaEl.appendChild(box);
            mpaaEl.style.display = '';
        } else {
            mpaaEl.textContent = '';
            mpaaEl.style.display = 'none';
        }

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

    // Incremented once per injectMovieLinks() call that passes the dedup/idle
    // guards and reaches a real lookupMovie() call. mySeq is captured locally
    // at that point; the lookupMovie().then() callback checks it against the
    // current value before applying anything, so an out-of-order-resolving
    // (e.g. cache-hit-fast) stale lookup can never overwrite what a
    // more-recently-started lookup already applied.
    let _titleRequestSeq = 0;

    // The exact string this module last wrote into #sc-title-text. The header
    // MutationObserver watches characterData, so every one of our own title
    // rewrites bounces straight back as a triggerTitleInject() -> a SECOND,
    // redundant lookup, this time keyed by the CLEANED title rather than the
    // raw filename. That was always wasteful; with match-overrides it is also
    // destructive (see the guard in injectMovieLinks below). Recording what we
    // wrote lets the reaction to our own write be recognised and dropped.
    let _lastInjectedTitleText = '';

    // Writes the resolved title into #sc-title-text (creating the span the
    // first time), from whatever `data` object currently holds cleanTitle/
    // cleanYear/season/episode/episodeName -- shared by the normal lookup
    // success path and the DOM-repair branch below, which re-renders from
    // cached _npData with no new network call.
    //
    // An UNRESOLVED lookup (no cleanTitle) still gets the span, showing the raw
    // filename: with no match there's no Now Playing card, so its "Wrong match?"
    // pencil -- the only other way into the Fix match modal -- is unreachable.
    // Clicking the unmatched title opens that modal directly instead.
    function _renderTitleSpan(titleEl, data) {
        if (!data || !titleEl) return;
        const unmatched = !data.cleanTitle;
        if (unmatched && !(data.rawFilename && data.parsedTitle)) return;
        const epTag = _episodeTag(data.season, data.episode);
        const newText = unmatched ? data.rawFilename
            : data.cleanTitle + (data.cleanYear ? ` (${data.cleanYear})` : '') + (epTag ? ` · ${epTag}` : '')
            + (data.episodeName ? ` · ${data.episodeName}` : '');
        let span = document.getElementById('sc-title-text');
        if (!span) {
            span = document.createElement('span');
            span.id = 'sc-title-text';
            span.style.cursor = 'pointer';
            // Reads the live _npData, so the one handler serves both states.
            span.addEventListener('click', (e) => {
                e.stopPropagation();
                if (_npData && _npData.cleanTitle) showNowPlayingCard(_npData, { autoHide: false });
                else if (_npData && _npData.rawFilename && _npData.parsedTitle) openFixMatchModal(_npData.rawFilename, _npData.parsedTitle, _npData.parsedYear);
            });
            const textNode = [...titleEl.childNodes].find(n => n.nodeType === 3 && n.textContent.trim());
            if (textNode) textNode.parentNode.replaceChild(span, textNode);
            else titleEl.insertBefore(span, titleEl.firstChild);
        }
        span.title = unmatched ? 'No match found -- click to search for the right title' : 'Movie info (I)';
        span.textContent = newText;
        // Remember exactly what we wrote so the header MutationObserver's
        // echo of this very mutation is recognised and dropped by the guard
        // at the top of injectMovieLinks.
        _lastInjectedTitleText = newText;
    }

    // overrideRawTitle, when given, is trusted verbatim instead of re-deriving
    // the title from titleEl's live text -- used by the changeMedia socket
    // handler below, which has an authoritative title straight from the
    // server. titleEl is still needed for the visible title-bar rewrite.
    function injectMovieLinks(titleEl, overrideRawTitle) {
        const rawTitle = overrideRawTitle !== undefined ? overrideRawTitle : titleEl.textContent.trim()
            .replace(/^currently\s+playing[:\s]*/i, '')
            .replace(/^now\s+playing[:\s]*/i, '').trim();

        // CyTube shows this literal placeholder in #currenttitle when nothing is
        // queued. It's not a real title, but real enough that IMDb's fuzzy search
        // can return a plausible-looking (real, unrelated) movie for it -- confirmed
        // live, it matched "Double or Nothing with Your Life (2018)". Bail before
        // any lookup; don't touch lastMovieTitle so a later real title never gets
        // deduped against this placeholder.
        if (/^nothing\s+playing$/i.test(rawTitle)) return;

        // Don't react to our own title rewrite. When this runs off the header
        // MutationObserver (overrideRawTitle undefined -> the title came from
        // the DOM) and the text we just read is verbatim the text we ourselves
        // last wrote into #sc-title-text, there is nothing new to look up: the
        // lookup that produced that text already completed. Without this the
        // observer fires a full second lookup for every title change, keyed by
        // the cleaned display title ("Class of 1984 (1984)") instead of the raw
        // filename -- which for a PINNED file overwrites _npData with a plain
        // auto-match (matchSource 'pinned' -> 'imdb', rawFilename becoming the
        // clean title), so the pencil then targets a nonexistent override key
        // and "Reset to automatic match" is never offered for the real pin.
        // watchMovieTitle's ~1.5s poll re-triggers for ~21s after a cold load,
        // so a cold load of a pinned file hit this too, well after any lock
        // window expired. Only DOM-sourced calls bail: an explicit
        // injectMovieLinks(el, rawFilename) always proceeds.
        if (overrideRawTitle === undefined && _lastInjectedTitleText && rawTitle === _lastInjectedTitleText) return;

        if (!rawTitle || rawTitle.length < 2) return;
        if (rawTitle === lastMovieTitle) {
            // Same identity as the title already resolved for -- normally
            // nothing to do. But CyTube's own header re-render can wipe our
            // injected #sc-title-text span back to plain raw-filename text
            // mid-playback (confirmed live: a title that matched fine at
            // media-change reverted to "Currently Playing: <raw>.mp4" and
            // stayed stuck that way for the rest of the play -- only a full
            // page reload, which resets lastMovieTitle to '', brought the
            // match back). Since rawTitle here is unchanged, this dedup guard
            // used to swallow every subsequent trigger unconditionally, so
            // the wiped span was never restored. Detect the wipe (span
            // missing from the DOM) and repair it straight from the cached
            // _npData -- no new network lookup needed, movieLinkCache already
            // holds this title's data and _npData is exactly what the
            // original successful lookup produced.
            if (titleEl && _npData && _npData.rawFilename === rawTitle && !document.getElementById('sc-title-text')) {
                _renderTitleSpan(titleEl, _npData);
            }
            return;
        }
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

        // Clean up previous links/stats/trivia buttons
        ['sc-movie-links', 'sc-movie-stats', 'sc-trivia-btn', 'sc-trivia-popup-btn'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.remove();
        });

        const isYt = isYouTubeMedia();
        let ytSeconds = 0;
        if (isYt) {
            ytSeconds = getCurrentMediaSeconds();
            if (ytSeconds < 3600) {
                // Short clip — no real IMDb match likely (trailer/bumper/ad),
                // but oEmbed is free and beats showing nothing.
                const videoId = currentYtVideoId || _domYtVideoId();
                if (videoId) {
                    const mySeq = ++_titleRequestSeq;
                    fetchYtOembed(videoId).then((info) => {
                        if (mySeq !== _titleRequestSeq) return; // superseded by a newer title
                        if (!info || !info.title) return; // no data — leave _npData untouched
                        _npData = {
                            cleanTitle: info.title,
                            cleanYear: null,
                            poster: info.thumbnail_url || null,
                            backdrop: info.thumbnail_url || null,
                            overview: info.author_name ? `Uploaded by ${info.author_name}` : null,
                            rating: null, runtime: null, genres: [], parentalGuide: null,
                            certificate: null,
                            killCount: null, imdbId: null, links: {}, season: null, episode: null,
                            // Symmetry with the real-match _npData below. A YT clip has
                            // no IMDb/parsed match, so the "Matched as" line and the
                            // pencil both stay hidden (gated on imdbId / parsedTitle).
                            parsedTitle: null, parsedYear: null, runtimeDelta: null,
                            rawFilename: rawTitle, matchSource: null,
                        };
                    });
                }
                return;
            }
        }

        const { title, year, season, episode, isEpisode } = isYt ? parseYouTubeTitle(rawTitle) : parseMovieFilename(rawTitle);
        if (!title || title.length < 2) return;

        const mySeq = ++_titleRequestSeq;
        // knownSeconds threaded only when > 0 (a real reported duration) --
        // otherwise undefined, so lookupMovie's ranking stays byte-identical to
        // pre-Task-3. This is the movie path; the YT-clip runtime check below
        // (isYt && runtime && ytSeconds) is a separate, untouched mechanism.
        // rawTitle (the exact, unparsed #currenttitle text) is threaded as the
        // 6th arg so lookupMovie can consult the per-filename match-override
        // store. Every other caller omits it -> no-op.
        lookupMovie(title, year, season, episode, knownSeconds > 0 ? knownSeconds : undefined, rawTitle).then(({ links, killCount, parentalGuide, certificate, cast, imdbId, cleanTitle, cleanYear, episodeName, rating, runtime, genres, poster, backdrop, overview, matchSource, runtimeDelta, season, episode }) => {
            if (mySeq !== _titleRequestSeq) return; // a newer title lookup has since superseded this one — discard

            if (isYt && !cleanTitle) {
                return;
            }
            if (isYt && runtime && ytSeconds) {
                const diff = Math.abs(runtime - ytSeconds / 60);
                if (diff > 30) { return; }
            }

            _currentImdbId = imdbId || null;
            // parsedTitle/parsedYear/runtimeDelta/rawFilename feed Task 5's
            // "Matched as" diagnostic line + the "Fix match" pencil on the card.
            // title/year here are the outer parseMovieFilename() values (the
            // .then destructure shadows only season/episode, never title/year).
            _npData = { cleanTitle, cleanYear, episodeName, poster, backdrop, overview, rating, runtime, genres: genres || [], parentalGuide, certificate, cast, killCount, imdbId, links, matchSource, season, episode,
                        parsedTitle: title, parsedYear: year, runtimeDelta, rawFilename: rawTitle };

            // Update title with clean IMDb title, wrapped in a clickable span
            _renderTitleSpan(titleEl, _npData);

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

            // Pop-up trivia quick mute/resume toggle — sits just left of the
            // Trivia button. Only rendered when the trivia-popup module is
            // present AND the user has opted into it in Settings (that gate
            // lives inside scRenderTriviaPopupBtn). typeof-guarded so a build
            // without the module just skips it.
            if (imdbId && typeof scRenderTriviaPopupBtn === 'function') {
                scRenderTriviaPopupBtn();
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
            if (typeof scGetLastAired === 'function') {
                const la = scGetLastAired(cleanTitle || title, cleanYear || year);
                if (la) statParts.push(`📅 Last aired ${la.dateStr}`);
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

    function findTitleEl() {
        for (const el of [
            document.getElementById('currenttitle'),
            document.querySelector('#videowrap-header .pull-left'),
            document.querySelector('#videowrap-header span'),
            document.querySelector('.video-title'),
        ]) {
            if (el && el.textContent.trim()) return el;
        }
        return null;
    }

    // Right after a real media change, CyTube's title element (and/or a
    // third-party player script sharing it) can flicker through a transient
    // bumper/trailer title before settling -- confirmed via debug logging: a
    // reload showed "Currently Playing: The.Crippled.Masters.[1979].mp4" then
    // "Playing Double or Nothing with Your Life (2018)" (a different, real
    // IMDb title -- not garbage, so nothing in the parse/lookup layer could
    // have caught it) then back to the correct title, then the bumper again,
    // where it stuck. tonights-lineup already learned this exact lesson (see
    // its lineupBuildDaySections comment) and prefers the socket's changeMedia
    // payload over DOM observation for that reason. _socketTitleLockUntil
    // mirrors that here: while set, DOM-triggered triggerTitleInject() calls
    // are ignored so this flicker window can't clobber the authoritative
    // title the socket handler below just committed.
    let _socketTitleLockUntil = 0;

    function triggerTitleInject() {
        if (_socketTitleLockUntil && Date.now() < _socketTitleLockUntil) return;
        const el = findTitleEl();
        if (el) injectMovieLinks(el);
    }

    /* ==========================================================
       MATCH-OVERRIDE RE-RENDER PLUMBING (Layer 3d).

       Task 5's "Fix match" modal calls applyMovieOverride /
       removeMovieOverride after the user pins or unpins a match. Both
       mutate the store (accessors above), drop the now-stale cache
       entry, then force an immediate re-render of the current title so
       the corrected card shows without waiting for the next changeMedia.
    ========================================================== */

    // Drop cached lookup entries for a raw filename so the next lookupMovie()
    // genuinely re-fetches. Always clears the `override:` namespace slot; also
    // clears the parsed-title slot when parseMovieFilename can reconstruct its
    // key cheaply -- so *removing* a pin re-runs a real auto-lookup instead of
    // surfacing the wrong pre-pin match straight from cache.
    function _dropCachedEntriesFor(rawFilename) {
        if (!rawFilename) return;
        const keys = ['override:' + rawFilename];
        try {
            const p = (typeof parseMovieFilename === 'function') ? parseMovieFilename(rawFilename) : null;
            if (p && p.title) keys.push(_parsedCacheKey(p.title, p.year, p.season, p.episode));
        } catch (e) { /* parser failure -> just clear the override slot */ }
        let changed = false;
        for (const k of keys) {
            if (movieLinkCache[k] !== undefined) { delete movieLinkCache[k]; changed = true; }
        }
        if (changed) {
            try { localStorage.setItem(LS_MOVIE_CACHE, JSON.stringify(movieLinkCache)); }
            catch (e) { /* storage unavailable -- in-memory drop still took effect */ }
        }
    }

    // Re-run the lookup/inject pipeline for the current title right now,
    // forcing rawFilename as the title (bypasses the DOM read) so the parse
    // and the override consult the exact filename the pin is keyed by. Mirrors
    // triggerTitleInject minus the _socketTitleLockUntil gate -- an explicit
    // user action should always re-render, even inside the post-changeMedia
    // lock window. It does not READ that lock, but it does SET it (below).
    function rerenderCurrentTitle(rawFilename) {
        lastMovieTitle = '';        // clear the dedup guard (injectMovieLinks)
        _titleRequestSeq++;         // invalidate any in-flight lookup's .then
        // An explicit user re-render must not be clobbered by the DOM mutation
        // it itself causes: the lookup below rewrites #sc-title-text, the
        // header MutationObserver sees that characterData change and calls
        // triggerTitleInject(), which would run a fresh NON-override lookup on
        // the cleaned title and overwrite _npData -- turning the just-pinned
        // match back into a plain auto-match. Take the same 8s lock the
        // changeMedia handler uses so DOM-triggered injects stay suppressed
        // while this pin's lookup and its .then complete. (injectMovieLinks'
        // _lastInjectedTitleText guard covers the same echo and outlives this
        // window; the lock additionally covers the flicker/poll traffic that
        // is not our own text.)
        _socketTitleLockUntil = Date.now() + 8000;
        const el = findTitleEl();
        if (el) injectMovieLinks(el, rawFilename);
    }

    function applyMovieOverride(rawFilename, { imdbId, tmdbId } = {}) {
        if (!rawFilename || !imdbId) return;
        setMovieOverride(rawFilename, { imdbId, tmdbId });
        _dropCachedEntriesFor(rawFilename);
        rerenderCurrentTitle(rawFilename);
    }

    function removeMovieOverride(rawFilename) {
        if (!rawFilename) return;
        clearMovieOverride(rawFilename);
        _dropCachedEntriesFor(rawFilename);
        rerenderCurrentTitle(rawFilename);
    }

    /* ==========================================================
       "FIX MATCH" MODAL (Layers 3b / 3e) — search-and-pin UI.

       Opened from the pencil button on the Now Playing card. Lets the
       user search IMDb (by title, or by pasting a tt-id / imdb.com/title
       URL) and pin the correct entry for THIS exact raw filename via
       applyMovieOverride() -- or, when a pin already exists, drop it with
       removeMovieOverride(). Both of those trigger their own re-render
       (rerenderCurrentTitle), so this function never calls it directly.

       Structure cribbed from grammar-check's showReviewModal: an
       #sc-fix-overlay fixed full-screen dim, one #sc-fix-modal panel,
       outside-click + Escape close, and a MutationObserver that
       disconnects the keydown listener if the overlay is removed by any
       other path. Strictly inline UI -- no alert/confirm/prompt anywhere.

       Multi-result search: IMDB_MAIN_SEARCH_QUERY already returns the top
       20 edges with id/titleText/releaseYear/titleType/voteCount/runtime
       -- everything a result row needs except the poster -- so this
       reuses it verbatim rather than defining a second query, then lazily
       fetches posters for the visible rows via fetchImdbTitleFields
       (cached per-tconst for the session). TMDB search is deliberately
       NOT wired in: LS_TMDB / the TMDB search endpoint live in the
       optional `tmdb` module's scope, not reachable cleanly from here,
       and IMDb search alone already resolves the pin.
    ========================================================== */
    const IMDB_FIX_ROW_LIMIT = 8;
    let _fixMatchPosterCache = {};

    async function _fixMatchSearch(term) {
        try {
            const data = await imdbQuery('MainSearch', IMDB_MAIN_SEARCH_QUERY, { term });
            const edges = data?.data?.mainSearch?.edges || [];
            return edges
                .map(e => e?.node?.entity)
                .filter(r => r && r.id && r.titleText?.text)
                .slice(0, IMDB_FIX_ROW_LIMIT)
                .map(r => ({
                    tconst:  r.id,
                    title:   r.titleText.text,
                    year:    r.releaseYear?.year ?? null,
                    type:    r.titleType?.text ?? null,
                    votes:   r.ratingsSummary?.voteCount ?? null,
                    runtime: r.runtime?.seconds != null ? Math.round(r.runtime.seconds / 60) : null,
                    poster:  null,
                }));
        } catch (e) { return []; }
    }

    function openFixMatchModal(rawFilename, seedTitle, seedYear) {
        const old = document.getElementById('sc-fix-overlay');
        if (old) old.remove();

        const esc = s => String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');

        const overlay = document.createElement('div');
        overlay.id = 'sc-fix-overlay';
        overlay.innerHTML = `
            <div id="sc-fix-modal">
                <div id="sc-fix-header">Fix match — <span id="sc-fix-file"></span></div>
                <input id="sc-fix-search" type="text" autocomplete="off" spellcheck="false"
                       placeholder="Search a title, or paste an IMDb link / tt-id" />
                <div id="sc-fix-results"></div>
                <div id="sc-fix-foot"></div>
                <div id="sc-fix-actions"></div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('#sc-fix-file').textContent = rawFilename || '(unknown file)';

        const input     = overlay.querySelector('#sc-fix-search');
        const resultsEl = overlay.querySelector('#sc-fix-results');
        const footEl    = overlay.querySelector('#sc-fix-foot');
        const actionsEl = overlay.querySelector('#sc-fix-actions');
        input.value = seedTitle || '';

        let rows = [];          // current candidate list: [{ tconst, title, ... }]
        let selIdx = -1;        // highlighted row index, -1 = none
        let searchSeq = 0;      // guards against an older search resolving last
        let debounceTimer = null;

        function close() {
            clearTimeout(debounceTimer);
            overlay.removeEventListener('keydown', keyHandler);
            cleanupObserver.disconnect();
            overlay.remove();
        }

        // Pin the chosen tconst for this exact filename, then close. The card
        // sitting behind the modal still shows the OLD match; applyMovieOverride
        // kicks off an async re-render that updates _npData / the title bar but
        // not the already-open card, so hide it -- the user reopens with `I` to
        // see the corrected card.
        function confirmTconst(tconst) {
            if (!tconst) return;
            applyMovieOverride(rawFilename, { imdbId: tconst, tmdbId: null });
            hideNowPlayingCard();
            close();
        }

        function renderRows() {
            resultsEl.innerHTML = '';
            rows.forEach((r, i) => {
                const row = document.createElement('div');
                row.className = 'sc-fix-row' + (i === selIdx ? ' sel' : '');
                row.dataset.tconst = r.tconst;
                const metaBits = [
                    r.year || null,
                    r.type || null,
                    r.runtime ? `${r.runtime}m` : null,
                    (r.votes != null) ? `${r.votes.toLocaleString()} votes` : null,
                ].filter(Boolean);
                row.innerHTML = `
                    <div class="sc-fix-thumb"${r.poster ? ` style="background-image:url(${esc(r.poster)})"` : ''}></div>
                    <div class="sc-fix-rowtext">
                        <div class="sc-fix-rowtitle">${esc(r.title)}</div>
                        <div class="sc-fix-rowmeta">${esc(metaBits.join(' · '))}${metaBits.length ? ' · ' : ''}${esc(r.tconst)}</div>
                    </div>`;
                row.addEventListener('click', () => confirmTconst(r.tconst));
                resultsEl.appendChild(row);
            });
            const sel = resultsEl.querySelector('.sc-fix-row.sel');
            if (sel) sel.scrollIntoView({ block: 'nearest' });
        }

        function runSearch() {
            const raw = input.value.trim();

            // Pasted a tt-id / IMDb URL -> a single confirm row, no search.
            const pastedTconst = _fixMatchDetectTconst(raw);
            if (pastedTconst) {
                rows = [{ tconst: pastedTconst, title: `Use ${pastedTconst}`, year: null,
                          type: null, votes: null, runtime: null, poster: null }];
                selIdx = 0;
                renderRows();
                footEl.textContent = 'Press Enter (or click) to pin this IMDb id.';
                return;
            }

            if (raw.length < 2) {
                rows = []; selIdx = -1; renderRows();
                footEl.textContent = '';
                return;
            }

            const mySeq = ++searchSeq;
            footEl.textContent = 'Searching…';
            _fixMatchSearch(raw).then(res => {
                if (mySeq !== searchSeq) return;   // a newer keystroke already superseded this
                rows = res;
                selIdx = res.length ? 0 : -1;
                renderRows();
                footEl.textContent = res.length ? '' : 'No matches — try a different spelling, or paste a tt-id.';

                // Lazy poster fetch for the visible rows. Cached per tconst so
                // re-searching the same term is free; each patch guards on the
                // search seq so a stale result can't paint over a newer list.
                res.forEach(r => {
                    if (_fixMatchPosterCache[r.tconst] !== undefined) {
                        r.poster = _fixMatchPosterCache[r.tconst];
                        if (r.poster) _patchThumb(r.tconst, r.poster);
                        return;
                    }
                    fetchImdbTitleFields(r.tconst).then(f => {
                        const p = (f && f.poster) || null;
                        _fixMatchPosterCache[r.tconst] = p;
                        if (mySeq !== searchSeq) return;
                        r.poster = p;
                        if (p) _patchThumb(r.tconst, p);
                    });
                });
            });
        }

        function _patchThumb(tconst, url) {
            const el = resultsEl.querySelector(`.sc-fix-row[data-tconst="${tconst}"] .sc-fix-thumb`);
            if (el) el.style.backgroundImage = `url(${url})`;
        }

        function keyHandler(e) {
            if (e.key === 'Escape') {
                e.preventDefault(); e.stopPropagation();
                close();
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (rows.length) { selIdx = (selIdx + 1) % rows.length; renderRows(); }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (rows.length) { selIdx = (selIdx - 1 + rows.length) % rows.length; renderRows(); }
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (selIdx >= 0 && rows[selIdx]) confirmTconst(rows[selIdx].tconst);
            }
        }

        input.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(runSearch, 350);
        });
        overlay.addEventListener('keydown', keyHandler);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

        // Disconnect the keydown listener if the overlay leaves the DOM by any
        // path other than close() (mirrors grammar-check's cleanup observer).
        const cleanupObserver = new MutationObserver(() => {
            if (!document.getElementById('sc-fix-overlay')) {
                overlay.removeEventListener('keydown', keyHandler);
                cleanupObserver.disconnect();
            }
        });
        cleanupObserver.observe(document.body, { childList: true });

        // "Reset to automatic match" -- only when a pin currently exists.
        if (getMovieOverride(rawFilename)) {
            const resetBtn = document.createElement('button');
            resetBtn.id = 'sc-fix-reset';
            resetBtn.type = 'button';
            resetBtn.textContent = 'Reset to automatic match';
            resetBtn.addEventListener('click', () => {
                removeMovieOverride(rawFilename);
                hideNowPlayingCard();
                close();
            });
            actionsEl.appendChild(resetBtn);
        }

        setTimeout(() => { input.focus(); input.select(); }, 0);
        if (input.value.trim()) runSearch();
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
                    currentYtVideoId    = (data && data.type === 'yt' && data.id) ? data.id : '';
                    // Authoritative lineup match straight from the raw socket payload, ahead of
                    // (and independent from) the DOM-title path below -- see
                    // lineupObserveTitleChange's own comment for why this matters.
                    // typeof-guarded -- see the other call site above in injectMovieLinks.
                    if (data && data.title && typeof lineupObserveTitleChange === 'function') {
                        lineupObserveTitleChange(data.title, data.seconds);
                    }
                    if (data && data.title) {
                        // Authoritative straight from the server -- process it directly
                        // instead of trusting the DOM, and hold off DOM-triggered
                        // re-processing for a few seconds so a transient bumper/trailer
                        // title flicker (see findTitleEl/triggerTitleInject comment)
                        // can't overwrite it before things settle. Only lock once we've
                        // actually processed it -- if the title element genuinely isn't
                        // in the DOM yet, leave the DOM path free to pick things up.
                        const el = findTitleEl();
                        if (el) {
                            _socketTitleLockUntil = Date.now() + 8000;
                            injectMovieLinks(el, data.title);
                        }
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
