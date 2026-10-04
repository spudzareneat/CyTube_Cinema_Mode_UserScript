// ==UserScript==
// @name         Grindhouse Pop-up Video
// @namespace    http://tampermonkey.net/
// @version      1.0.2
// @description  VH1 Pop-up Video style trivia bubbles for movies on the r/420Grindhouse CyTube channel — curated timed facts when available, IMDb trivia otherwise.
// @match        https://cytu.be/r/420Grindhouse
// @match        https://cytu.be/r/testing
// @grant        GM_xmlhttpRequest
// @connect      caching.graphql.imdb.com
// @connect      raw.githubusercontent.com
// @updateURL    https://raw.githubusercontent.com/spudzareneat/CyTube_Cinema_Mode_UserScript/main/cytube.popupvideo.user.js
// @downloadURL  https://raw.githubusercontent.com/spudzareneat/CyTube_Cinema_Mode_UserScript/main/cytube.popupvideo.user.js
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    /* Standalone Pop-up Video shim: the few helpers trivia-popup expects from the
       main script's core, nothing else. */
    const SC_POPUPVIDEO_STANDALONE = true;
    const getKey = id => { try { return localStorage.getItem(id) || ''; } catch (e) { return ''; } };
    // Styles are queued, not injected: they only go in once we know we're
    // actually running (see the load handler below).
    const _pvStyles = [];
    function injectCSS(id, css) { _pvStyles.push([id, css]); }
    function scRegisterSetting() {} // no settings modal in the standalone
    const _pvInits = [];
    function scRegisterInit(fn) { _pvInits.push(fn); }
    // Stand down if the full Grindhouse script's pop-up module is on this page
    // (it marks <html> at document-start); otherwise inject the queued styles
    // and run every registered init.
    window.addEventListener('load', () => {
        if (document.documentElement.getAttribute('data-sc-trivia-popup') === '1') {
            console.info('[popupvideo] Full Grindhouse script detected — Pop-up Video standing down. Turn on "Pop-up trivia bubbles" in its Settings to get bubbles.');
            return;
        }
        for (const [id, css] of _pvStyles) {
            if (document.getElementById(id)) continue;
            const s = document.createElement('style');
            s.id = id;
            s.textContent = css;
            (document.head || document.documentElement).appendChild(s);
        }
        for (const fn of _pvInits) { try { fn(); } catch (e) { console.error('[popupvideo]', e); } }
    });
    // Stock CyTube layout: keep bubbles over the video area.
    function scPopupUsableArea() {
        const w = document.getElementById('videowrap');
        const r = w && w.getBoundingClientRect();
        if (!r || r.width < 50 || r.height < 50) return null;
        return { left: r.left + 8, top: r.top + 8, right: r.right - 8, bottom: r.bottom - 8 };
    }
    /* ==========================================================
       MOVIE IDENTITY
       Title parsing + now-playing state shared across several
       optional modules (Movie Links, Chat → Movie Seek, IMDb Trivia)
       and read by the always-on GIF MAKER INTEGRATION BRIDGE in
       03-gif-bridge.js. Kept here in core -- rather than inside
       whichever optional module happens to own title-change
       detection or TMDB/IMDb lookups -- so the bridge never has to
       guess whether a build that excluded those modules still
       declared these; they're always present.
    ========================================================== */

    /* ==========================================================
       MOVIE TITLE CLEANING
       Handles filenames like: White.Fire.[1984].mkv
       → returns { title: "White Fire", year: "1984" }
    ========================================================== */

    // Ordered season/episode detectors. Order matters -- more specific/anchored
    // patterns are tried first so e.g. "S01E10" can't get partially re-matched
    // by the looser bare-episode pattern below it. `season: null` means the
    // pattern has no season group at all.
    const EPISODE_PATTERNS = [
        { re: /\bS(\d{1,2})[\s._-]?E(\d{1,3})\b/i, season: 1, episode: 2 },                              // S01E10
        { re: /\bSeason[\s._-]?(\d{1,2})[\s._-]+Episode[\s._-]?(\d{1,3})\b/i, season: 1, episode: 2 },    // Season 1 Episode 20
        { re: /\bEpisode[\s._-]?(\d{1,3})[\s._-]+Season[\s._-]?(\d{1,2})\b/i, season: 2, episode: 1 },    // Episode 20 Season 1
        { re: /\b(\d{1,2})x(\d{1,3})\b/i, season: 1, episode: 2 },                                        // 1x22
        { re: /\bEp(?:isode)?\.?[\s._-]?(\d{1,3})\b/i, season: null, episode: 1 },                        // Ep. 5 / Episode 5 (no season)
    ];

    // Runs EPISODE_PATTERNS in order; returns { match, season, episode } for the
    // first hit, or null. season/episode are numbers (or season: null), never strings.
    function _matchEpisode(s) {
        for (const p of EPISODE_PATTERNS) {
            const m = s.match(p.re);
            if (m) {
                return {
                    match: m,
                    season: p.season !== null ? parseInt(m[p.season], 10) : null,
                    episode: parseInt(m[p.episode], 10),
                };
            }
        }
        return null;
    }

    // Scene-release quality/codec tags stripped from filename titles just
    // before the dot/underscore -> space cleanup, so they never survive into
    // the TMDB query. parseYouTubeTitle does the same job for YT titles via
    // YT_NOISE (which already folds in the handful that overlap --
    // 1080p/720p/480p/4k/blu-ray/web-dl); this is the filename-side list for
    // the tokens YT_NOISE doesn't carry. Entries are regex fragments
    // (word-boundaried, case-insensitive at the call site).
    const RELEASE_TOKENS = [
        '2160p', '1080p', '720p', '480p', '4k',
        'x264', 'x265', 'h264', 'h265', 'hevc',
        'bluray', 'brrip', 'bdrip', 'web-?dl', 'webrip', 'hdrip', 'dvdrip', 'dvdscr',
        'xvid', 'divx', 'aac', 'ac3', 'dts', 'remux', 'hdr',
    ];

    function parseMovieFilename(raw) {
        // Remove file extension
        let s = raw.replace(/\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts|divx|xvid|ogv)$/i, '');

        const nowYear = new Date().getFullYear();

        // Digit-bracket repair: a stray bracket sometimes splits a 4-digit
        // year run ("1[989]", "[19]89", "19(89)", "199[0]") so neither the
        // bracketed-year regex nor the bare-year fallback below can see it.
        // Collapse the bracket ONLY when the digits on each side concatenate
        // to exactly four and form a plausible release year -- real tags like
        // "[720p]" / "[BluRay]", and an already-valid fully-bracketed
        // "[1984]" (no digits spilling outside the brackets), are left alone.
        s = s.replace(/(\d*)[\[(](\d+)[\])](\d*)/g, (m, pre, mid, post) => {
            if (!pre && !post) return m;                          // nothing split -- leave [1984] etc. intact
            const digits = pre + mid + post;
            if (digits.length !== 4 || !/^(?:19|20)\d{2}$/.test(digits)) return m;
            if (parseInt(digits, 10) > nowYear + 2) return m;
            return digits;
        });

        // Locate the year and the season/episode marker (S01E10, Season 1
        // Episode 20, 1x22, Ep. 5, etc.) against the same untouched string
        // before cutting anything. Checking one and slicing before checking
        // the other would silently discard whichever marker comes second --
        // e.g. "Show Name (1984) S01E05" has the episode marker AFTER the
        // year bracket, so cutting at the year first (as this used to)
        // threw the episode marker away before it was ever searched for,
        // leaving season/episode null even though the marker was right
        // there in the original string.
        let year = null;
        let yearCutIndex = Infinity;
        const yearMatch = s.match(/[\[(](\d{4})[\])]/);
        if (yearMatch) {
            year = yearMatch[1];
            yearCutIndex = yearMatch.index;
        }

        // Bare 4-digit year fallback -- only when no bracketed year was found.
        // A release year trails the scene name ("Blade.Runner.1982"), so take
        // the LAST plausible match; a number at the very START of the string
        // is part of the title ("2001.A.Space.Odyssey"), never a year, so a
        // match anchored at index 0 is ignored.
        if (!year) {
            const bareYearRe = /(?:^|[.\s_\-([])((?:19|20)\d{2})(?:$|[.\s_\-)\]])/g;
            let bm, last = null;
            while ((bm = bareYearRe.exec(s)) !== null) {
                last = bm;
                bareYearRe.lastIndex = bm.index + 1; // let a shared delimiter start the next match too
            }
            if (last) {
                const yearIndex = last.index + last[0].indexOf(last[1]);
                const y = parseInt(last[1], 10);
                if (yearIndex > 0 && y >= 1900 && y <= nowYear + 2) {
                    year = last[1];
                    yearCutIndex = yearIndex;
                }
            }
        }

        let season = null, episode = null;
        const epMatch = _matchEpisode(s);
        if (epMatch) {
            season = epMatch.season;
            episode = epMatch.episode;
        }

        // Cut the title at whichever marker starts first -- keeps the
        // series-name prefix, discards the episode-specific subtitle
        // scene/upload filenames often append after the marker.
        const cutIndex = Math.min(
            yearCutIndex,
            epMatch ? epMatch.match.index : Infinity
        );
        if (cutIndex !== Infinity) s = s.slice(0, cutIndex);

        // Acronym-style titles (R.O.T.O.R., S.W.A.T.) use dots as part of the actual
        // name, not as filename word-separators -- protect runs of 2+ single-letter-dot
        // groups from the dot/underscore-to-space cleanup below, which is tuned for
        // scene-release filenames like White.Fire.mkv, not acronyms. Confirmed live:
        // without this, "R.O.T.O.R." came out as "R O T O R".
        const acronyms = [];
        s = s.replace(/\b(?:[A-Za-z]\.){2,}/g, (m) => {
            acronyms.push(m);
            return ` @@${acronyms.length - 1}@@ `;
        });

        // Strip scene-release quality/codec tags ("1080p", "x264", "BluRay",
        // "WEB-DL", ...) while dots still delimit them. Word-boundaried and
        // case-insensitive; the protected-acronym placeholders (@@n@@) hold
        // no digits/letters these fragments match, and episode markers were
        // already sliced off above, so both are safe.
        RELEASE_TOKENS.forEach((tok) => {
            s = s.replace(new RegExp('\\b' + tok + '\\b', 'gi'), ' ');
        });

        // Replace dots and underscores with spaces
        s = s.replace(/[._]+/g, ' ');

        // Strip leftover brackets and their contents (tags like [BluRay], [720p])
        s = s.replace(/[\[(][^\])]*/g, '').replace(/[\])]/, '');

        // Restore protected acronyms
        s = s.replace(/@@(\d+)@@/g, (_, i) => acronyms[i]);

        // Trim and collapse whitespace
        s = s.replace(/\s+/g, ' ').trim();

        return { title: s, year, season, episode, isEpisode: episode !== null };
    }

    /* ==========================================================
       YOUTUBE TITLE CLEANING
       Aggressively strips noise from YT "full movie" titles so TMDB
       can find the actual film name.
    ========================================================== */

    const YT_NOISE = [
        'full movie', 'full length movie', 'full length feature', 'full length film', 'full length',
        'complete movie', 'complete film', 'the complete movie', 'entire movie',
        'free movie', 'free film', 'free online', 'free to watch', 'watch online', 'watch free',
        'watch now', 'online free', 'free with ads', 'with ads', 'no ads', 'ad free',
        'official movie', 'official film', 'official', 'exclusive', 'premiere', 'world premiere',
        'remastered', 'restored', 'colou?ri[sz]ed', 'subtitle[sd]?', 'subbed', 'dubbed', 'eng sub',
        'hd', 'fhd', 'uhd', '4k', '2k', '1080p', '720p', '480p', 'high definition',
        'blu-?ray', 'dvd', 'web-?dl', 'uncut', 'extended', 'director.?s cut', 'special edition',
        'classic movie', 'classic film', 'cult classic', 'b-?movie', 'feature film', 'feature',
        'cinema', 'blockbuster', 'must watch', 'in english', 'english movie',
    ];
    const YT_GENRES = ['action', 'thriller', 'horror', 'comedy', 'drama', 'sci-?fi', 'science fiction',
        'western', 'romance', 'crime', 'mystery', 'adventure', 'fantasy', 'war', 'noir', 'slasher',
        'martial arts', 'kung fu', 'documentary', 'family', 'musical', 'animation'];

    function parseYouTubeTitle(raw) {
        let s = ' ' + raw + ' ';
        let year = null;
        const ym = s.match(/\b(19\d{2}|20\d{2})\b/);
        if (ym) year = ym[1];
        s = s.replace(/[\[({][^\])}]*[\])}]/g, ' ');
        if (year) s = s.replace(new RegExp('\\b' + year + '\\b', 'g'), ' ');

        // Extract season/episode and cut at the match, same convention as
        // parseMovieFilename.
        let season = null, episode = null;
        const epMatch = _matchEpisode(s);
        if (epMatch) {
            season = epMatch.season;
            episode = epMatch.episode;
            s = s.slice(0, epMatch.match.index);
        }
        const isEpisode = episode !== null;

        [...YT_NOISE, ...YT_GENRES].forEach(n => {
            s = s.replace(new RegExp('\\b' + n + '\\b', 'gi'), ' ');
        });
        // Preserve the segment-separator characters the split below relies on
        // (|–—•) -- stripping them here first, before they can be used as
        // delimiters, silently merged every pipe/em-dash/bullet-separated
        // title into one blob (only plain "-" survived, since it's in this
        // allowed set already, which is why dash-separated titles "worked"
        // while pipe-separated ones never actually split).
        s = s.replace(/[^\w\s&':!.,|–—•-]/g, ' ');
        const segs = s.split(/\s[|–—•:_-]+\s/)
            .map(x => x.replace(/\s+/g, ' ').trim())
            .filter(x => x.length >= 2);
        // When an episode marker was found, the channel's series-name-first
        // convention means the correct segment is the FIRST one, not the
        // longest-alpha one -- an episode subtitle (e.g. "The Rameses
        // Connection") routinely has more alpha characters than the actual
        // series name (e.g. "The Tomorrow People") that precedes it, so the
        // longest-wins heuristic below would silently pick the wrong segment
        // for every episodic title.
        let title = isEpisode
            ? (segs[0] || s)
            : (segs.sort((a, b) =>
                (b.match(/[a-z]/gi) || []).length - (a.match(/[a-z]/gi) || []).length
              )[0] || s);
        title = title.replace(/\s+/g, ' ').replace(/^[\s'":.,-]+|[\s'":.,-]+$/g, '').trim();
        return { title, year, season, episode, isEpisode };
    }

    /* ==========================================================
       NOW-PLAYING STATE
       lastMovieTitle is kept in sync by whichever optional module
       currently owns title-change detection (normally Movie Links'
       injectMovieLinks()); _npData is populated by IMDb Trivia's/
       Movie Links' TMDB+IMDb lookup once it resolves for the current
       title. Both start empty/null and simply stay that way in a
       build that excludes those modules -- consumers (the GIF
       bridge, Tonight's Lineup, etc.) must treat '' / null as "no
       data yet" rather than assume a module populated them.
    ========================================================== */

    let lastMovieTitle = '';
    let _npData         = null;
    // Set by Movie Links' lookupMovie() once it resolves an IMDb id for the
    // current title; read by IMDb Trivia's showTriviaCard() (and its 'T'
    // hotkey handler). Declared here alongside lastMovieTitle/_npData for
    // consistency with the rest of this shared now-playing state block --
    // not because it's needed to cover a build combination that no longer
    // exists (imdb-trivia now hard-depends on movie-title-links, see
    // imdb-trivia's manifest.json).
    let _currentImdbId  = null;

    // Filesystem/URL-safe slug of the currently playing movie, e.g. "Blade-Runner-1982".
    // Falls back to '' when no title has been detected yet.
    function _gifTitleSlug() {
        if (!lastMovieTitle) return '';
        const { title, year } = parseMovieFilename(lastMovieTitle);
        let slug = title.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
        if (year) slug += '-' + year;
        return slug;
    }

    // {title, year, imdbId} for the currently playing movie, used by the GIF
    // bridge (03-gif-bridge.js) so legacy standalone scripts (e.g.
    // cytube.subtitles.user.js) can build lookups without re-deriving this
    // themselves. title/year come from the same source _gifTitleSlug() uses
    // (available once a video is playing); imdbId is only set once the Now
    // Playing card's IMDb lookup has resolved for this video (no key
    // required -- null until then, caller falls back). Returns null when no
    // title has been detected yet.
    function getBridgeMovieInfo() {
        if (!lastMovieTitle) return null;
        const { title, year, season, episode } = parseMovieFilename(lastMovieTitle);
        if (!title) return null;
        return { title, year: year || null, season: season || null, episode: episode || null, imdbId: (_npData && _npData.imdbId) || null };
    }
    // Player/media helpers shared by core and the standalone Pop-up Video build.

    // Current media duration/type/YouTube-video-id — updated by the changeMedia socket event.
    let currentMediaSeconds = 0;
    let currentMediaType    = '';
    let currentYtVideoId    = '';
    function parseTimeToSeconds(t) {
        const parts = String(t).trim().split(':').map(Number);
        if (!parts.length || parts.some(isNaN)) return 0;
        return parts.reduce((acc, v) => acc * 60 + v, 0);
    }
    function getCurrentMediaSeconds() {
        if (currentMediaSeconds > 0) return currentMediaSeconds;
        const el = document.querySelector('#queue .queue_active .qe_time, #queue .queue_entry.active .qe_time');
        if (el) { const t = parseTimeToSeconds(el.textContent); if (t > 0) return t; }
        // Last resort: the actual <video> element's own reported duration -- real and accurate
        // (confirmed live 2026-07-19 against the true remaining runtime) whenever CyTube plays a
        // same-origin file directly, covering exactly what the two checks above miss: a page
        // loaded mid-movie, before any changeMedia event has arrived to populate
        // currentMediaSeconds. Doesn't help for YouTube embeds -- the player's <video> tag lives
        // inside a cross-origin iframe, unreachable from here -- those still fall through to 0.
        const v = getPlayerVideoEl();
        if (v && isFinite(v.duration) && v.duration > 0) return v.duration;
        return 0;
    }

    // Lives in core (not movie-title-links) because it's needed unconditionally by
    // the Movie Lead Time interceptor below, which core always ships regardless of
    // which optional modules are included. movie-title-links also calls this (it
    // depends on core, so it's always available there too) to decide whether to
    // parse a title as a YouTube video vs. a movie filename.
    function isYouTubeMedia() {
        // CyTube exposes current media on the global PLAYER or window.player object.
        // The type field is 'yt' for YouTube. Also check for the YouTube iframe directly.
        try {
            const p = window.PLAYER || window.player;
            if (p && p.type === 'yt') return true;
            if (p && p.mediaType === 'yt') return true;
        } catch (e) {}
        // Fallback: check if a YouTube iframe is present in the video wrapper
        if (document.querySelector('#ytapiplayer iframe[src*="youtube.com"]')) return true;
        if (document.querySelector('#ytapiplayer[src*="youtube.com"]')) return true;
        return false;
    }

    function getPlayerVideoEl() {
        return document.querySelector('#ytapiplayer video') || document.querySelector('video');
    }
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
    const _triviaCache = {};
    async function fetchImdbTrivia(tconst) {
        if (!tconst) return null;
        if (_triviaCache[tconst]) return _triviaCache[tconst];
        const q = 'query GHTrivia($id: ID!){ title(id:$id){ trivia(first: 30){ edges{ node{ text{ plainText } } } } } }';
        try {
            const data = await imdbQuery('GHTrivia', q, { id: tconst });
            const edges = data?.data?.title?.trivia?.edges || [];
            const items = edges.map(e => e?.node?.text?.plainText).filter(Boolean);
            _triviaCache[tconst] = items;
            return items;
        } catch (e) { return null; }
    }

    function _escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    /* ==========================================================
       POP-UP TRIVIA BUBBLES — "VH1 Pop-up Video" style ambient
       trivia. Reuses the same fetchImdbTrivia()/_triviaCache and
       _escHtml() the imdb-trivia module already owns (hard dependency
       via manifest.json's dependsOn, so this file always loads after
       it) rather than re-fetching or re-declaring either. Also reuses
       _currentImdbId (core/01-movie-identity.js) and isYouTubeMedia()/
       getPlayerVideoEl() (core/12-playback-sync-and-seek.js).

       No pub/sub exists in this codebase for "movie changed" -- every
       module that cares just polls the shared _currentImdbId and
       diffs against its own last-seen value (same idiom imdb-trivia
       and last-aired already use). This module does the same on a
       lightweight heartbeat, which also doubles as the scheduler that
       decides when the next bubble is due.

       Settings here are poll-per-use, not event-driven (see
       core/15-settings-modal-shell.js -- Save just writes
       localStorage, nothing notifies running code), so
       popupTriviaEnabled(), the playback-eligibility check and the
       window-focus check (document.hasFocus()) are all re-read every
       time a pop is attempted, not just once at boot -- otherwise
       turning the toggle off mid-movie wouldn't stop already-scheduled
       popups, and a pop could fire while the user is in another window.
    ========================================================== */

    // True only inside the standalone Pop-up Video build (its shim declares the
    // const before this module). typeof on an undeclared name is safe.
    const TP_STANDALONE = typeof SC_POPUPVIDEO_STANDALONE !== 'undefined' && SC_POPUPVIDEO_STANDALONE === true;
    // Mark the page as soon as the main script's module loads (document-start),
    // so a standalone Pop-up Video script checking at its own `load` stands down.
    if (!TP_STANDALONE) document.documentElement.setAttribute('data-sc-trivia-popup', '1');

    const LS_TRIVIA_POPUP_ENABLED = 'sc_trivia_popup_enabled';
    // Master opt-in (Settings modal). Ignores the session mute below -- used
    // for deciding whether the top-bar quick-toggle button should show at all.
    const popupTriviaConfigured = () => TP_STANDALONE || getKey(LS_TRIVIA_POPUP_ENABLED) === 'on'; // opt-in, off by default

    // Session-only quick mute, driven by the #sc-trivia-popup-btn top-bar
    // button (see scRenderTriviaPopupBtn below). Deliberately NOT persisted:
    // it's a "not right now" control, so a page reload brings the bubbles
    // back if the master setting is still on. Folded into the same
    // poll-per-use gate every pop attempt already re-reads.
    let _tpMuted = false;
    const popupTriviaEnabled = () => popupTriviaConfigured() && !_tpMuted;

    const LS_TRIVIA_POPUP_FREQUENCY = 'sc_trivia_popup_frequency';
    const TP_FREQUENCY_DEFAULT = TP_STANDALONE ? 'frequent' : 'occasional';
    // Gap-between-pops ranges per tier -- read live (poll-per-use, like
    // popupTriviaEnabled()) each time a pop is scheduled, so changing the
    // setting mid-movie takes effect on the very next pop instead of
    // requiring a reload.
    const TP_FREQUENCY_TIERS = {
        frequent:   { min: 45 * 1000,     max: 90 * 1000 },
        occasional: { min: 3 * 60 * 1000, max: 6 * 60 * 1000 },
        rare:       { min: 8 * 60 * 1000, max: 15 * 60 * 1000 },
    };
    const _tpFrequencyTier = () => TP_FREQUENCY_TIERS[getKey(LS_TRIVIA_POPUP_FREQUENCY)] || TP_FREQUENCY_TIERS[TP_FREQUENCY_DEFAULT];

    const TP_POLL_MS     = 3000;            // heartbeat: detect movie change + drive the scheduler
    const TP_RETRY_MS    = 20 * 1000;       // recheck delay when blocked (paused/YouTube/setting off)
    const TP_VISIBLE_MS  = 15 * 1000;       // how long a bubble stays up before auto-dismissing
    const TP_EXIT_ANIM_MS = 300;             // must match style.css's .sc-tp-out transition-duration
    const TP_MAX_FACT_LEN = 280;             // skip trivia entries longer than this -- too much text to pop up legibly

    // Short-lived, single-slot record of trivia texts already popped for the
    // current movie -- survives a page reload (buffering, script updates,
    // etc.) so the queue rebuild in _tpResetForNewMovie() doesn't immediately
    // re-show what was already seen. Sliding TTL (like subtitles' LS_SUB_CACHE):
    // a still-in-progress movie keeps refreshing savedAt and stays remembered,
    // an untouched one expires and stops mattering. One slot, not a per-movie
    // map -- switching movies naturally invalidates the old entry via the id
    // mismatch check below, no separate pruning needed.
    const LS_TRIVIA_SEEN = 'sc_trivia_popup_seen';
    const TRIVIA_SEEN_TTL_MS = 3 * 60 * 60 * 1000; // 3h, sliding

    // undefined (not null) so "no movie identified yet" (_currentImdbId === null)
    // still counts as a change exactly once, on the very first tick.
    let _tpLastImdbId = undefined;
    let _tpQueue = [];       // shuffled remaining { text, byline } items for the current movie
    let _tpExhausted = false; // true once _tpQueue has been fully consumed for this movie -- no reshuffle/repeat
    let _tpPopTimer = null;
    let _tpBubbleEl = null;
    let _tpDismissTimer = null;
    let _tpTimeline = null;  // curated facts (sorted by t) for the current movie; null = IMDb random-gap mode
    let _tpLastPopAt = 0;    // Date.now() of the last timeline bubble -- spaces out catch-up pops
    let _tpCuratedRecheckAt = 0; // when to look for a curated file again while the movie has none

    const TP_PERSON_TRIVIA_CAP = 3; // per person, after the TP_MAX_FACT_LEN length filter -- keeps 4 people's trivia from drowning out the movie's own facts

    /* ==========================================================
       CURATED TIMELINE -- pure helpers for movies that have a
       generated Pop-up Video file (see
       docs/superpowers/specs/2026-10-03-curated-popup-trivia-design.md).
       Facts carry a playback time `t`, so every viewer (CyTube keeps
       them in sync) sees the same bubble at the same moment. No DOM,
       no globals -- scripts/test-trivia-timeline.mjs slices this
       block out between the markers and evals it.
    ========================================================== */

    // ── test marker: curated-timeline slice start ──
    const TP_CURATED_SCHEMA = 1;
    // A fact is still "due" up to this many seconds after its t -- covers the
    // 3s heartbeat and brief blocks (paused, window unfocused). Anything older
    // counts as missed (seek / late join) and is skipped, never burst-fired.
    const TP_TIMELINE_WINDOW_S = 20;
    const TP_CURATED_MAX_LEN = 280; // same legibility cap as TP_MAX_FACT_LEN; the generator itself targets 200

    // Person facts may carry an IMDb headshot (generator-attached, from its own
    // IMDb lookup). Only ever load images from IMDb's image CDN, and only URLs
    // made of plain path characters -- the file is public data, so a hand edit
    // or a bad commit must not be able to point the badge anywhere else.
    const TP_IMAGE_URL_RE = /^https:\/\/m\.media-amazon\.com\/images\/[A-Za-z0-9@._,%\/-]+$/;
    function tpSafeImageUrl(url) {
        return typeof url === 'string' && url.length < 500 && TP_IMAGE_URL_RE.test(url);
    }

    // Citation link shown in the Trivia panel: plain http(s) only, and no
    // characters that could break out of an attribute even if escaping were
    // ever missed.
    const TP_LINK_URL_RE = /^https?:\/\/[^\s"'<>`]+$/;
    function tpSafeLinkUrl(url) {
        return typeof url === 'string' && url.length < 1000 && TP_LINK_URL_RE.test(url);
    }

    // Returns the doc's usable facts, normalized and sorted by t, or null when
    // the doc is unusable (wrong schema / wrong movie / nothing valid) so the
    // caller falls back to IMDb trivia. expectedId null skips the id check
    // (dev override, which applies to whatever is playing).
    function tpValidateCurated(doc, expectedId) {
        if (!doc || typeof doc !== 'object' || doc.schema !== TP_CURATED_SCHEMA) return null;
        if (expectedId && doc.imdbId !== expectedId) return null;
        if (!Array.isArray(doc.facts)) return null;
        const facts = [];
        for (const f of doc.facts) {
            if (!f || typeof f !== 'object') continue;
            if (typeof f.t !== 'number' || !Number.isFinite(f.t) || f.t < 0) continue;
            if (typeof f.text !== 'string') continue;
            const text = f.text.trim();
            if (!text || text.length > TP_CURATED_MAX_LEN) continue;
            facts.push({
                t: f.t,
                rank: [1, 2, 3].includes(f.rank) ? f.rank : 2,
                anchor: f.anchor === 'scene' ? 'scene' : 'spread',
                text,
                icon: typeof f.icon === 'string' ? f.icon : null,
                byline: typeof f.byline === 'string' && f.byline.trim() ? f.byline.trim() : null,
                ...(tpSafeImageUrl(f.image) ? { image: f.image } : {}),
                ...(tpSafeLinkUrl(f.source && f.source.url) ? { sourceUrl: f.source.url } : {}),
            });
        }
        if (!facts.length) return null;
        facts.sort((a, b) => a.t - b.t);
        return facts;
    }

    // Frequency setting -> highest rank shown. Deterministic, so viewers on
    // the same setting see exactly the same bubbles.
    const TP_RANK_CUTOFF = { frequent: 3, occasional: 2, rare: 1 };
    function tpRankAllowed(rank, tierName) {
        return rank <= (TP_RANK_CUTOFF[tierName] || TP_RANK_CUTOFF.occasional);
    }

    // The earliest unseen, rank-allowed fact whose t has been reached but is
    // no more than TP_TIMELINE_WINDOW_S behind currentTime -- or null.
    function tpDueFact(facts, currentTime, tierName, seenTexts) {
        if (!Array.isArray(facts) || typeof currentTime !== 'number' || !Number.isFinite(currentTime)) return null;
        for (const f of facts) {
            if (f.t > currentTime) break; // sorted by t
            if (currentTime - f.t > TP_TIMELINE_WINDOW_S) continue;
            if (!tpRankAllowed(f.rank, tierName)) continue;
            if (seenTexts.includes(f.text)) continue;
            return f;
        }
        return null;
    }

    // Catch-up for viewers who joined late or skipped ahead: facts whose due
    // window has already passed are shown in the quiet gaps between timed
    // facts, instead of being lost. Never crowds the synced timeline -- only
    // when the last bubble was >= TP_CATCHUP_MIN_GAP_S ago and the next timed
    // fact this viewer will actually see is >= TP_CATCHUP_CLEAR_S away.
    // "scene" facts are excluded (they point at something on screen at that
    // moment, meaningless later). Best rank first, then earliest. Missed facts
    // are always from earlier in the movie, so this can't spoil anything.
    const TP_CATCHUP_MIN_GAP_S = 45;
    const TP_CATCHUP_CLEAR_S = 60;
    function tpCatchUpFact(facts, currentTime, tierName, seenTexts, secsSinceLastPop) {
        if (!Array.isArray(facts) || typeof currentTime !== 'number' || !Number.isFinite(currentTime)) return null;
        if (!(secsSinceLastPop >= TP_CATCHUP_MIN_GAP_S)) return null;
        const shows = f => tpRankAllowed(f.rank, tierName) && !seenTexts.includes(f.text);
        const next = facts.find(f => f.t + TP_TIMELINE_WINDOW_S >= currentTime && shows(f));
        if (next && next.t - currentTime < TP_CATCHUP_CLEAR_S) return null;
        const missed = facts.filter(f => f.t + TP_TIMELINE_WINDOW_S < currentTime && f.anchor !== 'scene' && shows(f));
        if (!missed.length) return null;
        return missed.slice().sort((a, b) => a.rank - b.rank || a.t - b.t)[0];
    }
    // ── test marker: curated-timeline slice end ──

    const TP_CURATED_BASE = 'https://raw.githubusercontent.com/spudzareneat/grindhouse-popup-trivia/main/data/';
    // Dev/testing override: paste a whole curated JSON doc into this
    // localStorage key (DevTools) and it's used for WHATEVER movie is playing
    // (id check skipped). Sample: docs/popup-trivia-sample.json. Remove the
    // key to go back to normal.
    const LS_TRIVIA_CURATED_DEV = 'sc_trivia_curated_dev';
    // Session cache keyed by tconst: { facts, at }. A found file is kept for
    // the session; "not curated" (404 / invalid) expires after
    // TP_CURATED_RECHECK_MS, because the generator publishes files during the
    // weekend and a movie that started before its file landed should pick it
    // up (see _tpRecheckCurated). Transient failures (network error, timeout,
    // 5xx) are not cached at all.
    const TP_CURATED_RECHECK_MS = 10 * 60 * 1000;
    const _tpCuratedCache = {};

    function fetchCuratedTrivia(id) {
        if (!id) return Promise.resolve(null);
        let devRaw = null;
        try { devRaw = localStorage.getItem(LS_TRIVIA_CURATED_DEV); } catch (e) {}
        if (devRaw) {
            console.warn('[trivia-popup] curated dev override active (localStorage sc_trivia_curated_dev) -- applies to every movie');
            try { return Promise.resolve(tpValidateCurated(JSON.parse(devRaw), null)); }
            catch (e) { return Promise.resolve(null); }
        }
        const cached = _tpCuratedCache[id];
        if (cached && (cached.facts || Date.now() - cached.at < TP_CURATED_RECHECK_MS)) return Promise.resolve(cached.facts);
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: TP_CURATED_BASE + encodeURIComponent(id) + '.json',
                timeout: 10000,
                onload: r => {
                    const ok = r.status >= 200 && r.status < 300;
                    let facts = null;
                    if (ok) { try { facts = tpValidateCurated(JSON.parse(r.responseText), id); } catch (e) {} }
                    if (ok || r.status === 404) _tpCuratedCache[id] = { facts, at: Date.now() };
                    resolve(facts);
                },
                onerror: () => resolve(null),
                ontimeout: () => resolve(null),
            });
        });
    }

    // Session-only, in-memory caches -- mirrors imdb-trivia's _triviaCache
    // pattern. Not persisted to localStorage; naturally reused across movies
    // that share an actor/director within the same page session.
    // _personTriviaCache is keyed by nconst alone (a person's trivia doesn't
    // depend on which movie is currently playing). _personKnownForCache is
    // keyed by `${nconst}|${excludeTconst}` -- the "known for" pick DOES
    // depend on which title is being excluded, so it must be cached per
    // exclusion-context, not globally per-person (see fetchPersonKnownFor).
    const _personTriviaCache = {};
    const _personKnownForCache = {};

    // Combined cast+director query -- one request per movie instead of two,
    // confirmed live against caching.graphql.imdb.com: the bare `characters`
    // field on Credit fails GraphQL validation, it only exists on the `Cast`
    // interface implementation, hence the inline fragment.
    async function fetchCastAndDirector(tconst) {
        if (!tconst) return null;
        const q = 'query GHCastAndDirector($id: ID!){ title(id:$id){ series{ series{ id } } cast: credits(first: 3, filter: { categories: ["cast"] }) { edges{ node{ name{ id nameText{ text } } ... on Cast { characters{ name } } } } } directors: credits(first: 1, filter: { categories: ["director"] }) { edges{ node{ name{ id nameText{ text } } } } } } }';
        try {
            const data = await imdbQuery('GHCastAndDirector', q, { id: tconst });
            const t = data?.data?.title;
            if (!t) return null;
            const cast = (t.cast?.edges || []).map(e => ({
                nconst: e?.node?.name?.id ?? null,
                name: e?.node?.name?.nameText?.text ?? null,
                character: e?.node?.characters?.[0]?.name ?? null,
                role: 'cast',
            })).filter(p => p.nconst && p.name);
            const directors = (t.directors?.edges || []).map(e => ({
                nconst: e?.node?.name?.id ?? null,
                name: e?.node?.name?.nameText?.text ?? null,
                character: null,
                role: 'director',
            })).filter(p => p.nconst && p.name);
            // Dedup by nconst, keeping the FIRST occurrence -- cast is
            // concatenated before directors, so an actor-director (credited
            // as both) keeps their character-name byline instead of being
            // double-counted under a second, generic "Director" byline.
            const seen = new Set();
            return {
                people: cast.concat(directors).filter(p => !seen.has(p.nconst) && seen.add(p.nconst)),
                seriesTconst: t.series?.series?.id ?? null,
            };
        } catch (e) { return null; }
    }

    async function fetchPersonTrivia(nconst) {
        if (!nconst) return [];
        if (_personTriviaCache[nconst]) return _personTriviaCache[nconst];
        const q = 'query GHPersonTrivia($id: ID!){ name(id:$id){ trivia(first: 10){ edges{ node{ text{ plainText } } } } } }';
        try {
            const data = await imdbQuery('GHPersonTrivia', q, { id: nconst });
            const edges = data?.data?.name?.trivia?.edges || [];
            const items = edges.map(e => e?.node?.text?.plainText).filter(Boolean);
            _personTriviaCache[nconst] = items;
            return items;
        } catch (e) { return []; }
    }

    // Picks the person's highest-vote-count "known for" title other than the
    // one currently playing, and synthesizes one self-contained fact sentence.
    //
    // Cached per (nconst, excludeTconst, excludeSeriesTconst) triple, not
    // per-nconst alone: the same person's "known for" pick depends on which
    // title(s) are being excluded (the one currently playing), so a cache
    // keyed only by nconst could serve a stale pick made under a different
    // exclusion -- one that names the movie now playing as their "known for"
    // title, which reads as self-referential nonsense in the popup. The
    // series exclusion is a separate parameter (not just excludeTconst)
    // because for TV content excludeTconst is the EPISODE's own tconst, but
    // IMDb's knownFor query only ever returns SERIES-level titles -- so
    // without also excluding the parent series id, a series regular's
    // "known for" pick could be the very series currently airing.
    async function fetchPersonKnownFor(nconst, excludeTconst, excludeSeriesTconst) {
        if (!nconst) return null;
        const cacheKey = `${nconst}|${excludeTconst}|${excludeSeriesTconst || ''}`;
        if (_personKnownForCache[cacheKey] !== undefined) return _personKnownForCache[cacheKey];
        const q = 'query GHKnownFor($id: ID!){ name(id:$id){ knownFor(first: 6){ edges{ node{ title{ id titleText{ text } releaseYear{ year } ratingsSummary{ voteCount } } } } } } }';
        try {
            const data = await imdbQuery('GHKnownFor', q, { id: nconst });
            const edges = data?.data?.name?.knownFor?.edges || [];
            const titles = edges
                .map(e => e?.node?.title)
                .filter(t => t && t.id && t.id !== excludeTconst && t.id !== excludeSeriesTconst && t.titleText?.text);
            if (!titles.length) { _personKnownForCache[cacheKey] = null; return null; }
            titles.sort((a, b) => (b.ratingsSummary?.voteCount ?? 0) - (a.ratingsSummary?.voteCount ?? 0));
            const best = titles[0];
            const result = { title: best.titleText.text, year: best.releaseYear?.year ?? null };
            _personKnownForCache[cacheKey] = result;
            return result;
        } catch (e) { return null; }
    }

    function _tpKnownForFact(person, knownFor) {
        if (!knownFor) return null;
        const titleYear = knownFor.year ? `${knownFor.title} (${knownFor.year})` : knownFor.title;
        if (person.role === 'director') return `${person.name} is also known for ${titleYear}.`;
        const charPart = person.character ? ` (${person.character})` : '';
        return `${person.name}${charPart} also starred in ${titleYear}.`;
    }

    // Fetches per-person trivia + known-for for cast/director concurrently,
    // and folds it all into { text, byline } queue items. Never throws --
    // every fetch it calls already resolves to null/[] on failure.
    async function _tpBuildCastCrewItems(people, excludeTconst, excludeSeriesTconst) {
        const items = [];
        await Promise.all(people.map(async (person) => {
            const [trivia, knownFor] = await Promise.all([
                fetchPersonTrivia(person.nconst),
                fetchPersonKnownFor(person.nconst, excludeTconst, excludeSeriesTconst),
            ]);
            const byline = `${person.name} — ${person.role === 'director' ? 'Director' : (person.character || 'Cast')}`;
            trivia
                .filter(t => t.length <= TP_MAX_FACT_LEN)
                .slice(0, TP_PERSON_TRIVIA_CAP)
                .forEach(t => items.push({ text: t, byline }));
            const knownForFact = _tpKnownForFact(person, knownFor);
            if (knownForFact) items.push({ text: knownForFact, byline: null });
        }));
        return items;
    }

    function _tpLoadSeenTexts(id) {
        let raw;
        try { raw = JSON.parse(localStorage.getItem(LS_TRIVIA_SEEN)); } catch (e) { return []; }
        if (!raw || raw.id !== id) return [];
        if (!raw.savedAt || Date.now() - raw.savedAt > TRIVIA_SEEN_TTL_MS) return [];
        return Array.isArray(raw.texts) ? raw.texts : [];
    }

    function _tpMarkSeen(id, text) {
        if (!id) return;
        const texts = _tpLoadSeenTexts(id);
        if (!texts.includes(text)) texts.push(text);
        try {
            localStorage.setItem(LS_TRIVIA_SEEN, JSON.stringify({ id, texts, savedAt: Date.now() }));
        } catch (e) {}
    }

    function _tpShuffle(arr) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    /* ==========================================================
       SCHEDULER
    ========================================================== */

    function _tpResetForNewMovie(id) {
        clearTimeout(_tpPopTimer); _tpPopTimer = null;
        _tpDismissBubble(true); // hard-remove instantly -- stale trivia, no exit animation
        _tpQueue = [];
        _tpExhausted = false;
        _tpTimeline = null;
        // First catch-up no sooner than TP_CATCHUP_MIN_GAP_S after the movie is
        // identified, so a late joiner isn't greeted by a bubble instantly.
        _tpLastPopAt = Date.now();
        _tpCuratedRecheckAt = Date.now() + TP_CURATED_RECHECK_MS;
        if (!id) return; // not identified yet; next poll tick will retry

        // Curated file first. If there is one, the movie runs in timeline
        // mode (_tpTimelineTick on the heartbeat) and none of the IMDb /
        // cast / known-for fetching below happens -- the generator already
        // folded those sources in. No file / bad file -> the IMDb path,
        // unchanged.
        fetchCuratedTrivia(id).then(facts => {
            if (id !== _tpLastImdbId) return; // movie changed again while this was in flight
            if (facts) { _tpTimeline = facts; return; }
            _tpStartImdbQueue(id);
        });
    }

    // The original (pre-curated) behavior: shuffled IMDb movie trivia plus
    // cast/crew enrichment, popped at random per-viewer gaps.
    function _tpStartImdbQueue(id) {
        fetchImdbTrivia(id).then(async items => {
            if (id !== _tpLastImdbId) return; // movie changed again while this was in flight
            const seenTexts = _tpLoadSeenTexts(id);
            const movieItems = (items || [])
                .filter(text => !seenTexts.includes(text))
                .map(text => ({ text, byline: null }));

            // Queue + schedule off the movie's own trivia immediately -- so a
            // slow or failed cast/crew enrichment burst below (up to ~9 extra
            // network calls, no request timeout on imdbGmFetch) can never
            // block the base feature. Enrichment items, if any land, are
            // merged into whatever's left in the queue afterward, not waited
            // on up front.
            _tpQueue = _tpShuffle(movieItems);
            _tpScheduleNextPop(); // safe on an empty queue too -- it just marks _tpExhausted

            // Cast/crew enrichment is gated on the setting being on *right
            // now* -- an intentional tradeoff that avoids ~9 extra network
            // calls per movie for users who leave this off. The movie's own
            // trivia above stays unconditional since it's shared with the
            // T-panel and cheap either way.
            if (!popupTriviaEnabled()) return;

            // Movies only. For a TV episode the "top cast"/"director" credits
            // are the series regulars and the episode's director; their
            // per-person trivia and "also known for" facts swamp the episode's
            // own trivia and rarely relate to what's on screen. Episodes fall
            // through to just their own IMDb trivia (already queued above),
            // matching the T-panel. _npData is guaranteed populated by now:
            // movie-title-links sets _currentImdbId and _npData in one
            // synchronous block, and this module hard-depends on it.
            if (_npData && _npData.episode != null) return;

            const result = await fetchCastAndDirector(id);
            if (id !== _tpLastImdbId) return; // movie changed again while this was in flight
            if (!result || !result.people.length) return;
            // Belt-and-suspenders episode guard for when the filename parser
            // missed the season/episode marker: IMDb itself says this title
            // has a parent series, so treat it as an episode (movies only).
            if (result.seriesTconst) return;

            const castCrewItems = await _tpBuildCastCrewItems(result.people, id, result.seriesTconst);
            if (id !== _tpLastImdbId) return; // movie changed again while this was in flight
            // Re-read seen texts (not the snapshot from above) -- a pop may
            // have already fired for this movie while this fetch was in
            // flight, and this guards a cast/crew fact that happens to
            // duplicate movie trivia already shown from slipping through.
            const seenTextsNow = _tpLoadSeenTexts(id);
            const freshCastCrewItems = castCrewItems.filter(it => !seenTextsNow.includes(it.text));
            if (!freshCastCrewItems.length) return;

            // Merge into whatever's left unconsumed (some movie trivia may
            // already have been popped by now) and reshuffle. If the queue
            // had already run dry (marked exhausted above, or drained by a
            // pop while this was in flight), un-exhaust and (re)start
            // scheduling -- otherwise a pop timer is already ticking and
            // will simply pick up these items when it fires.
            _tpQueue = _tpShuffle(_tpQueue.concat(freshCastCrewItems));
            if (_tpExhausted) { _tpExhausted = false; _tpScheduleNextPop(); }
        });
    }

    function _tpScheduleNextPop() {
        clearTimeout(_tpPopTimer);
        // A curated file can arrive mid-movie (_tpRecheckCurated) while an IMDb
        // enrichment fetch is still in flight -- the timeline owns the movie then.
        if (_tpTimeline || _tpExhausted || !_tpQueue.length) { _tpExhausted = true; return; }
        const tier = _tpFrequencyTier();
        const gap = tier.min + Math.random() * (tier.max - tier.min);
        _tpPopTimer = setTimeout(_tpAttemptPop, gap);
    }

    function _tpMovieIsPlaying() {
        if (isYouTubeMedia()) return false;
        const v = getPlayerVideoEl();
        return !!v && !v.paused;
    }

    function _tpAttemptPop() {
        if (_currentImdbId !== _tpLastImdbId) return; // stale timer from a since-reset movie
        if (_tpTimeline) return; // switched to a curated timeline since this timer was armed

        if (!popupTriviaEnabled() || !_tpMovieIsPlaying() || !document.hasFocus()) {
            // Blocked (paused / YouTube / setting off / window not focused),
            // not exhausted -- recheck soon without consuming a queue item.
            _tpPopTimer = setTimeout(_tpAttemptPop, TP_RETRY_MS);
            return;
        }

        // Skip (don't display, don't wait out a gap for) any entry too long to
        // read comfortably in a small popup -- keep pulling from the queue
        // until a short-enough one turns up or the queue runs dry.
        let fact = null;
        while (_tpQueue.length) {
            const candidate = _tpQueue.shift();
            if (candidate.text.length <= TP_MAX_FACT_LEN) { fact = candidate; break; }
        }
        if (!fact) { _tpExhausted = true; return; } // ran out (including all-too-long) -- no more for this movie

        showTriviaBubble(fact);
        _tpMarkSeen(_tpLastImdbId, fact.text);
        _tpScheduleNextPop(); // arms the next pop, or flips _tpExhausted if that was the last one
    }

    // Timeline mode's whole scheduler: every heartbeat, pop whichever curated
    // fact is due at the current playback position (synced for everyone);
    // otherwise, in the gaps, catch up on a fact this viewer missed by joining
    // late, skipping ahead, or being paused/unfocused past its window
    // (tpCatchUpFact). Frequency tier and the seen-set are re-read every tick
    // (poll-per-use, like everything else here), so a mid-movie setting change
    // applies on the next tick.
    function _tpTimelineTick() {
        if (!_tpTimeline || _currentImdbId !== _tpLastImdbId) return;
        if (!popupTriviaEnabled() || !_tpMovieIsPlaying() || !document.hasFocus()) return;
        if (_tpBubbleEl) return; // let the current bubble finish; the next fact's 20s window usually outlasts it
        const v = getPlayerVideoEl();
        const tier = getKey(LS_TRIVIA_POPUP_FREQUENCY) || TP_FREQUENCY_DEFAULT;
        const seen = _tpLoadSeenTexts(_tpLastImdbId);
        const fact = tpDueFact(_tpTimeline, v.currentTime, tier, seen)
            || tpCatchUpFact(_tpTimeline, v.currentTime, tier, seen, (Date.now() - _tpLastPopAt) / 1000);
        if (!fact) return;
        showTriviaBubble(fact);
        _tpMarkSeen(_tpLastImdbId, fact.text);
        _tpLastPopAt = Date.now();
    }

    // The movie has no curated file (yet). The generator publishes during the
    // weekend, so look again every TP_CURATED_RECHECK_MS; when one appears,
    // switch from IMDb random gaps to the timeline -- facts already passed
    // then surface through catch-up.
    function _tpRecheckCurated(id) {
        _tpCuratedRecheckAt = Date.now() + TP_CURATED_RECHECK_MS;
        fetchCuratedTrivia(id).then(facts => {
            if (!facts || id !== _tpLastImdbId || _tpTimeline) return;
            clearTimeout(_tpPopTimer); _tpPopTimer = null;
            _tpQueue = [];
            _tpExhausted = true;
            _tpTimeline = facts;
        });
    }

    function _tpMoviePollTick() {
        if (_currentImdbId !== _tpLastImdbId) {
            _tpLastImdbId = _currentImdbId;
            _tpResetForNewMovie(_tpLastImdbId);
        }
        if (!_tpTimeline && _tpLastImdbId && Date.now() >= _tpCuratedRecheckAt) _tpRecheckCurated(_tpLastImdbId);
        _tpTimelineTick();
    }

    function triviaPopupBoot() {
        _tpMoviePollTick();
        setInterval(_tpMoviePollTick, TP_POLL_MS);
    }

    /* ==========================================================
       BUBBLE UI
    ========================================================== */

    // Corner-badge glyphs -- grindhouse-flavored, drawn from scratch (no
    // copied assets), black/red/bone palette. Each entry is just the glyph
    // markup; showTriviaBubble() wraps it in the shared black-circle-plus-
    // red-ring backdrop. Keyed by name because curated facts pick their own
    // icon (`fact.icon`) -- the key set is a contract with the generator repo
    // (pinned by scripts/test-trivia-icons.mjs), so only ever ADD keys.
    // IMDb-fallback facts carry no icon and get a random one.
    // ── test marker: icon-map slice start ──
    const TP_ICON_SVGS = {
        // Skull + blood drip
        skull: `<path d="M30 10 C19 10 12 18 12 27 C12 33 15 38 19 41 L19 47 L24 47 L24 43 L27 43 L27 47 L33 47 L33 43 L36 43 L36 47 L41 47 L41 41 C45 38 48 33 48 27 C48 18 41 10 30 10 Z"
              fill="#f4f1ea" stroke="#000" stroke-width="2.5" stroke-linejoin="round"/>
         <circle cx="22" cy="26" r="5" fill="#000"/>
         <circle cx="38" cy="26" r="5" fill="#000"/>
         <polygon points="30,30 27,36 33,36" fill="#000"/>
         <path d="M39 16 C39 16 43 22 41 27 C40 30 36 30 35 27 C33 23 39 16 39 16 Z"
              fill="#c81d25" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/>`,
        // Cracked tombstone
        tombstone: `<path d="M14 54 V30 C14 16 22 8 30 8 C38 8 46 16 46 30 V54 Z"
              fill="#f4f1ea" stroke="#000" stroke-width="2.5" stroke-linejoin="round"/>
         <path d="M30 12 L26 26 L34 30 L28 44 L33 54" stroke="#000" stroke-width="2" fill="none"/>
         <line x1="30" y1="18" x2="30" y2="26" stroke="#000" stroke-width="2"/>
         <line x1="26" y1="21" x2="34" y2="21" stroke="#000" stroke-width="2"/>`,
        // Film reel
        reel: `<circle cx="30" cy="30" r="18" fill="#f4f1ea" stroke="#000" stroke-width="2.5"/>
         <circle cx="30" cy="30" r="4" fill="#000"/>
         <circle cx="30" cy="16" r="4.5" fill="#000"/>
         <circle cx="30" cy="44" r="4.5" fill="#000"/>
         <circle cx="18" cy="23" r="4.5" fill="#000"/>
         <circle cx="18" cy="37" r="4.5" fill="#000"/>
         <circle cx="42" cy="23" r="4.5" fill="#000"/>
         <circle cx="42" cy="37" r="4.5" fill="#000"/>`,

        // --- Sci-fi (toxic-green #39d98a accent) ---

        // Flying saucer
        saucer: `<ellipse cx="30" cy="33" rx="22" ry="8" fill="#d8d8d8" stroke="#000" stroke-width="2.5"/>
         <ellipse cx="30" cy="24" rx="11" ry="9" fill="#f4f1ea" stroke="#000" stroke-width="2.5"/>
         <circle cx="18" cy="36" r="2.2" fill="#39d98a" stroke="#000" stroke-width="1.2"/>
         <circle cx="30" cy="38" r="2.2" fill="#39d98a" stroke="#000" stroke-width="1.2"/>
         <circle cx="42" cy="36" r="2.2" fill="#39d98a" stroke="#000" stroke-width="1.2"/>`,
        // Bug-eyed alien head
        alien: `<path d="M30 6 C14 6 6 20 8 32 C10 44 20 54 30 54 C40 54 50 44 52 32 C54 20 46 6 30 6 Z"
              fill="#f4f1ea" stroke="#000" stroke-width="2.5" stroke-linejoin="round"/>
         <ellipse cx="20" cy="27" rx="7" ry="10" fill="#000" transform="rotate(-15 20 27)"/>
         <ellipse cx="40" cy="27" rx="7" ry="10" fill="#000" transform="rotate(15 40 27)"/>
         <circle cx="20" cy="27" r="1.8" fill="#39d98a"/>
         <circle cx="40" cy="27" r="1.8" fill="#39d98a"/>`,
        // Rocket ship
        rocket: `<path d="M30 6 C24 6 20 14 20 24 V44 H40 V24 C40 14 36 6 30 6 Z"
              fill="#f4f1ea" stroke="#000" stroke-width="2.5" stroke-linejoin="round"/>
         <circle cx="30" cy="20" r="5" fill="#39d98a" stroke="#000" stroke-width="2"/>
         <polygon points="20,38 10,50 20,50" fill="#d8d8d8" stroke="#000" stroke-width="2" stroke-linejoin="round"/>
         <polygon points="40,38 50,50 40,50" fill="#d8d8d8" stroke="#000" stroke-width="2" stroke-linejoin="round"/>
         <path d="M24 44 C24 44 22 54 30 58 C38 54 36 44 36 44 Z"
              fill="#39d98a" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/>`,
        // Robot head
        robot: `<rect x="14" y="16" width="32" height="28" rx="4" fill="#d8d8d8" stroke="#000" stroke-width="2.5"/>
         <line x1="30" y1="16" x2="30" y2="6" stroke="#000" stroke-width="2.5"/>
         <circle cx="30" cy="5" r="3" fill="#39d98a" stroke="#000" stroke-width="1.5"/>
         <circle cx="30" cy="28" r="7" fill="#000"/>
         <circle cx="30" cy="28" r="3" fill="#39d98a"/>
         <rect x="20" y="38" width="20" height="4" fill="#000"/>
         <circle cx="16" cy="20" r="2" fill="#3a2a1a"/>
         <circle cx="44" cy="20" r="2" fill="#3a2a1a"/>`,
        // Radioactive trefoil
        radioactive: `<circle cx="30" cy="30" r="20" fill="#f4f1ea" stroke="#000" stroke-width="2.5"/>
         <path d="M30 30 L23 15 L37 15 Z" fill="#39d98a" stroke="#000" stroke-width="1.5" stroke-linejoin="round" transform="rotate(0 30 30)"/>
         <path d="M30 30 L23 15 L37 15 Z" fill="#39d98a" stroke="#000" stroke-width="1.5" stroke-linejoin="round" transform="rotate(120 30 30)"/>
         <path d="M30 30 L23 15 L37 15 Z" fill="#39d98a" stroke="#000" stroke-width="1.5" stroke-linejoin="round" transform="rotate(240 30 30)"/>
         <circle cx="30" cy="30" r="5" fill="#000"/>`,

        // --- Action (marquee-gold #e8b923 accent) ---

        // Explosion burst
        explosion: `<polygon points="30,4 35,19 48,12 41,25 56,30 41,35 48,48 35,41 30,56 25,41 12,48 19,35 4,30 19,25 12,12 25,19"
                 fill="#e8b923" stroke="#000" stroke-width="2.5" stroke-linejoin="round"/>
         <polygon points="30,16 33,24 40,20 36,27 44,30 36,33 40,40 33,36 30,44 27,36 20,40 25,33 16,30 25,27 20,20 27,25"
                 fill="#c81d25" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/>`,
        // Crosshair scope
        crosshair: `<circle cx="30" cy="30" r="21" fill="#f4f1ea" stroke="#c81d25" stroke-width="4"/>
         <rect x="6" y="28" width="15" height="4" fill="#000"/>
         <rect x="39" y="28" width="15" height="4" fill="#000"/>
         <rect x="28" y="6" width="4" height="15" fill="#000"/>
         <rect x="28" y="39" width="4" height="15" fill="#000"/>
         <circle cx="30" cy="30" r="4" fill="#e8b923" stroke="#000" stroke-width="1.5"/>`,
        // Brass knuckles
        knuckles: `<circle cx="14" cy="20" r="8" fill="#d8d8d8" stroke="#000" stroke-width="2.5"/>
         <circle cx="26" cy="18" r="8" fill="#d8d8d8" stroke="#000" stroke-width="2.5"/>
         <circle cx="38" cy="18" r="8" fill="#d8d8d8" stroke="#000" stroke-width="2.5"/>
         <circle cx="50" cy="20" r="8" fill="#d8d8d8" stroke="#000" stroke-width="2.5"/>
         <rect x="10" y="26" width="44" height="8" rx="3" fill="#3a2a1a" stroke="#000" stroke-width="2.5"/>`,

        // --- Comedy (marquee-gold #e8b923 accent) ---

        // Disco ball
        disco: `<circle cx="30" cy="30" r="20" fill="#d8d8d8" stroke="#000" stroke-width="2.5"/>
         <path d="M12 30 H48 M13 20 H47 M13 40 H47 M20 12 V48 M30 10 V50 M40 12 V48"
              stroke="#000" stroke-width="1.5" fill="none"/>
         <polyline points="46,10 50,6" stroke="#e8b923" stroke-width="2.5" stroke-linecap="round"/>
         <polyline points="50,14 55,12" stroke="#e8b923" stroke-width="2.5" stroke-linecap="round"/>
         <polyline points="44,6 47,2" stroke="#e8b923" stroke-width="2.5" stroke-linecap="round"/>`,
        // Boombox
        boombox: `<rect x="6" y="18" width="48" height="30" rx="5" fill="#3a2a1a" stroke="#000" stroke-width="2.5"/>
         <circle cx="18" cy="33" r="10" fill="#f4f1ea" stroke="#000" stroke-width="2.5"/>
         <circle cx="18" cy="33" r="4" fill="#000"/>
         <circle cx="42" cy="33" r="10" fill="#f4f1ea" stroke="#000" stroke-width="2.5"/>
         <circle cx="42" cy="33" r="4" fill="#000"/>
         <rect x="24" y="10" width="12" height="8" rx="2" fill="#e8b923" stroke="#000" stroke-width="2"/>`,
        // Aviator sunglasses
        sunglasses: `<ellipse cx="18" cy="30" rx="12" ry="10" fill="#d8d8d8" stroke="#000" stroke-width="2.5"/>
         <ellipse cx="42" cy="30" rx="12" ry="10" fill="#d8d8d8" stroke="#000" stroke-width="2.5"/>
         <rect x="27" y="27" width="6" height="4" fill="#000"/>
         <line x1="6" y1="27" x2="0" y2="21" stroke="#000" stroke-width="3" stroke-linecap="round"/>
         <line x1="54" y1="27" x2="60" y2="21" stroke="#000" stroke-width="3" stroke-linecap="round"/>
         <polyline points="12,26 18,23" stroke="#e8b923" stroke-width="2.5" stroke-linecap="round"/>`,

        // --- Curated-fact topics (named by the generator, not random-picked by genre) ---

        // Drive-in window speaker -- Joe Bob / Drive-In Totals
        joebob: `<path d="M22 14 V8 H38 V14" fill="none" stroke="#000" stroke-width="2.5"/>
         <rect x="14" y="14" width="32" height="34" rx="5" fill="#d8d8d8" stroke="#000" stroke-width="2.5"/>
         <circle cx="30" cy="31" r="10" fill="#3a2a1a" stroke="#000" stroke-width="2"/>
         <path d="M22 31 H38 M24 26 H36 M24 36 H36" stroke="#000" stroke-width="1.5"/>
         <rect x="24" y="48" width="12" height="5" fill="#c81d25" stroke="#000" stroke-width="1.5"/>`,
        // Banknote -- budget / box office
        money: `<rect x="8" y="16" width="44" height="28" rx="3" fill="#f4f1ea" stroke="#000" stroke-width="2.5"/>
         <rect x="12" y="20" width="36" height="20" rx="2" fill="none" stroke="#000" stroke-width="1"/>
         <circle cx="30" cy="30" r="9" fill="#e8b923" stroke="#000" stroke-width="2"/>
         <text x="30" y="35" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="14" font-weight="900" fill="#000">$</text>`,
        // Two-reel movie camera -- production / behind the scenes
        camera: `<circle cx="20" cy="18" r="9" fill="#f4f1ea" stroke="#000" stroke-width="2.5"/>
         <circle cx="38" cy="18" r="9" fill="#f4f1ea" stroke="#000" stroke-width="2.5"/>
         <circle cx="20" cy="18" r="2.5" fill="#000"/>
         <circle cx="38" cy="18" r="2.5" fill="#000"/>
         <rect x="10" y="28" width="34" height="20" rx="3" fill="#3a2a1a" stroke="#000" stroke-width="2.5"/>
         <polygon points="44,32 54,26 54,50 44,44" fill="#d8d8d8" stroke="#000" stroke-width="2.5" stroke-linejoin="round"/>
         <circle cx="20" cy="38" r="3" fill="#c81d25"/>`,
        // Walk-of-fame star -- cast
        star: `<polygon points="30,6 36,22 53,22 39,32 44,49 30,39 16,49 21,32 7,22 24,22"
                 fill="#e8b923" stroke="#000" stroke-width="2.5" stroke-linejoin="round"/>
         <circle cx="30" cy="28" r="4" fill="#c81d25" stroke="#000" stroke-width="1.5"/>`,
        // Chain links -- ties to other movies
        link: `<rect x="6" y="22" width="28" height="16" rx="8" fill="none" stroke="#000" stroke-width="7"/>
         <rect x="6" y="22" width="28" height="16" rx="8" fill="none" stroke="#d8d8d8" stroke-width="3.5"/>
         <rect x="26" y="22" width="28" height="16" rx="8" fill="none" stroke="#000" stroke-width="7"/>
         <rect x="26" y="22" width="28" height="16" rx="8" fill="none" stroke="#e8b923" stroke-width="3.5"/>`,
        // Ribbon microphone -- interview quotes
        mic: `<rect x="20" y="6" width="20" height="28" rx="10" fill="#d8d8d8" stroke="#000" stroke-width="2.5"/>
         <path d="M24 14 H36 M24 20 H36 M24 26 H36" stroke="#000" stroke-width="1.5"/>
         <path d="M14 26 C14 38 22 42 30 42 C38 42 46 38 46 26" fill="none" stroke="#000" stroke-width="2.5"/>
         <line x1="30" y1="42" x2="30" y2="52" stroke="#000" stroke-width="3"/>
         <rect x="20" y="51" width="20" height="4" rx="1" fill="#c81d25" stroke="#000" stroke-width="1.5"/>`,
        // "CUT" stamp -- censorship / banned / alternate versions
        censor: `<g transform="rotate(-12 30 30)">
           <rect x="7" y="17" width="46" height="26" rx="3" fill="#f4f1ea" stroke="#c81d25" stroke-width="3"/>
           <text x="30" y="36" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="15" font-weight="900" fill="#c81d25">CUT</text>
         </g>`,
        // Trophy -- awards
        trophy: `<path d="M18 12 H10 C10 22 14 24 18 24 M42 12 H50 C50 22 46 24 42 24" fill="none" stroke="#000" stroke-width="2.5"/>
         <path d="M18 8 H42 V22 C42 30 36 36 30 36 C24 36 18 30 18 22 Z" fill="#e8b923" stroke="#000" stroke-width="2.5" stroke-linejoin="round"/>
         <rect x="27" y="36" width="6" height="8" fill="#e8b923" stroke="#000" stroke-width="2"/>
         <rect x="18" y="44" width="24" height="8" rx="1" fill="#3a2a1a" stroke="#000" stroke-width="2.5"/>`,
    };
    const TP_ICON_KEYS = Object.keys(TP_ICON_SVGS);

    // Curated facts name their icon; anything unknown (a key added by a newer
    // generator, a typo) or missing falls back to a random one rather than
    // breaking. rnd injected for testability.
    function tpPickIconKey(iconKey, keys, rnd) {
        if (iconKey && keys.includes(iconKey)) return iconKey;
        return keys[Math.floor(rnd() * keys.length)];
    }
    // ── test marker: icon-map slice end ──

    // The rectangle a bubble is allowed to land in: the viewport inset by a
    // small edge margin, minus the chat panel. Read live on every pop
    // (poll-per-use) so a mid-session chat-panel drag or window resize is
    // always honoured. getChatPanelWidth()/getChatPanelHeight() are core's
    // (04-channel-script-autoapprove.js -- drag-resizable, default 19vw /
    // 42vh); in horizontal layout the chat is a right sidebar, in vertical
    // it's stacked under the video whose wrap is 97vh - --sc-chat-h tall
    // (css/00-layout-core.css), so the usable floor there is the video-area
    // bottom, not the viewport bottom.
    function _tpUsableArea() {
        // The standalone build defines scPopupUsableArea() for stock CyTube's layout.
        if (typeof scPopupUsableArea === 'function') { const a = scPopupUsableArea(); if (a) return a; }
        const vw = window.innerWidth, vh = window.innerHeight;
        const m = 14;
        const topInset = 44; // clear the fixed #videowrap-header title strip
        const vertical = document.body.classList.contains('sc-vertical');
        const chatWpx = vertical ? 0 : vw * (typeof getChatPanelWidth === 'function' ? getChatPanelWidth() : 19) / 100;
        const chatHpx = !vertical ? 0
            : vh * 0.03 + vh * (typeof getChatPanelHeight === 'function' ? getChatPanelHeight() : 42) / 100;
        return { left: m, top: topInset, right: vw - chatWpx - m, bottom: vh - chatHpx - m };
    }

    // The on-screen rectangle the actual movie picture occupies, letterbox
    // bars excluded -- computed from the <video>'s intrinsic size vs. its
    // rendered box (object-fit: contain). Lets _tpRandomPosition() steer
    // bubbles into the bars / corners and off the centre of frame. Falls back
    // to #videowrap, then the usable area, before the intrinsic size is known.
    function _tpPictureRect(usable) {
        const v = getPlayerVideoEl();
        const r = v && v.getBoundingClientRect();
        if (r && r.width > 0 && r.height > 0 && v.videoWidth > 0 && v.videoHeight > 0) {
            const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
            const picW = v.videoWidth * scale, picH = v.videoHeight * scale;
            return { left: r.left + (r.width - picW) / 2, top: r.top + (r.height - picH) / 2, width: picW, height: picH };
        }
        const wrap = document.getElementById('videowrap');
        const wr = wrap && wrap.getBoundingClientRect();
        if (wr && wr.width > 0 && wr.height > 0) return { left: wr.left, top: wr.top, width: wr.width, height: wr.height };
        return { left: usable.left, top: usable.top, width: usable.right - usable.left, height: usable.bottom - usable.top };
    }

    // Picks where the bubble lands, using its own *measured* rendered size
    // (boxW/boxH -- see showTriviaBubble, which appends it invisibly and
    // measures before calling this). Returns viewport px: centerXPx (CSS
    // centres the box on it via translateX(-50%), see style.css) and topPx.
    //
    // Deliberately biased away from the middle of the movie: candidate zones
    // are the letterbox bars above / below / beside the picture and its four
    // corners. Each zone is a rectangle of allowed box-top-left coordinates.
    // Bar zones only qualify when there's genuinely room for the whole box in
    // that bar; they carry 3x a corner's weight so the big vertical-layout
    // bars get used most. The four corner zones always qualify (their ranges
    // are clamped into the usable area) and are the guaranteed fallback -- a
    // corner bubble straddles the picture edge, clipping only the corner.
    function _tpRandomPosition(boxW, boxH) {
        const U = _tpUsableArea();
        const P = _tpPictureRect(U);
        const gap = 12;
        const pRight = P.left + P.width, pBottom = P.top + P.height;

        const xLo = U.left + gap, xHi = U.right - boxW - gap;
        const yLo = U.top + gap, yHi = U.bottom - boxH - gap;
        const xFull = [xLo, xHi], yFull = [yLo, yHi];

        const zones = [];
        if (P.top - U.top >= boxH + 2 * gap)      zones.push({ w: 3, x: xFull, y: [yLo, P.top - boxH - gap] });
        if (U.bottom - pBottom >= boxH + 2 * gap) zones.push({ w: 3, x: xFull, y: [pBottom + gap, yHi] });
        if (P.left - U.left >= boxW + 2 * gap)    zones.push({ w: 3, x: [xLo, P.left - boxW - gap], y: yFull });
        if (U.right - pRight >= boxW + 2 * gap)   zones.push({ w: 3, x: [pRight + gap, xHi], y: yFull });
        for (const [cx, cy] of [[P.left, P.top], [pRight, P.top], [P.left, pBottom], [pRight, pBottom]]) {
            zones.push({ w: 1, x: [cx - boxW * 0.6, cx - boxW * 0.4], y: [cy - boxH * 0.6, cy - boxH * 0.4] });
        }

        // Clamp a range's endpoints into [lo, hi] then pick uniformly within
        // it; if the box is wider/taller than the usable area (hi < lo), fall
        // back to the midpoint so it stays centred in whatever space there is.
        const pick = (range, lo, hi) => {
            if (hi < lo) return (lo + hi) / 2;
            const a = Math.min(hi, Math.max(lo, range[0]));
            const b = Math.min(hi, Math.max(lo, range[1]));
            return a + Math.random() * (b - a);
        };

        const totalW = zones.reduce((s, z) => s + z.w, 0);
        let roll = Math.random() * totalW;
        let chosen = zones[zones.length - 1];
        for (const z of zones) { roll -= z.w; if (roll <= 0) { chosen = z; break; } }

        return {
            centerXPx: pick(chosen.x, xLo, xHi) + boxW / 2,
            topPx: pick(chosen.y, yLo, yHi),
        };
    }

    /* ==========================================================
       POP SOUND -- synthesized (no audio file) via Web Audio API, so this
       adds a function, not a shipped asset. A single AudioContext is
       created lazily on first pop and reused after that (creating a fresh
       one per pop would be wasteful and can hit browser limits on
       concurrent contexts). Wrapped in try/catch since AudioContext can be
       unavailable/blocked in some environments -- silently skipping the
       sound is preferable to breaking the popup over it.
    ========================================================== */

    let _tpAudioCtx = null;
    function _tpGetAudioCtx() {
        if (!_tpAudioCtx) {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            _tpAudioCtx = new Ctor();
        }
        if (_tpAudioCtx.state === 'suspended') _tpAudioCtx.resume();
        return _tpAudioCtx;
    }

    // Short burst of filtered white noise -- the sharp "click" transient a
    // real pop needs at its onset, which a pure oscillator can't produce.
    function _tpNoiseBurst(ac, { start, dur, freq, q, peak }) {
        const size = Math.max(1, Math.floor(ac.sampleRate * dur));
        const buffer = ac.createBuffer(1, size, ac.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;
        const src = ac.createBufferSource();
        src.buffer = buffer;
        const bp = ac.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = freq;
        bp.Q.value = q;
        const gain = ac.createGain();
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(peak, start + 0.003);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        src.connect(bp).connect(gain).connect(ac.destination);
        src.start(start);
        src.stop(start + dur + 0.01);
    }

    // The squishy body after the click -- pitch bends up then settles back
    // down (a membrane snapping, not a straight sweep), through a lowpass
    // filter whose cutoff falls at the same time for a rubbery, muffled tail.
    function _tpBubbleTone(ac, { start, dur, freqStart, freqPeak, freqEnd, lpStart, lpEnd, q, peak }) {
        const osc = ac.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freqStart, start);
        osc.frequency.exponentialRampToValueAtTime(freqPeak, start + dur * 0.4);
        osc.frequency.exponentialRampToValueAtTime(freqEnd, start + dur);
        const lp = ac.createBiquadFilter();
        lp.type = 'lowpass';
        lp.Q.value = q;
        lp.frequency.setValueAtTime(lpStart, start);
        lp.frequency.exponentialRampToValueAtTime(lpEnd, start + dur);
        const gain = ac.createGain();
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(peak, start + 0.006);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        osc.connect(lp).connect(gain).connect(ac.destination);
        osc.start(start);
        osc.stop(start + dur + 0.02);
    }

    function _tpPlayPopSound() {
        try {
            const ac = _tpGetAudioCtx();
            const t = ac.currentTime;
            _tpNoiseBurst(ac, { start: t, dur: 0.02, freq: 1800, q: 2.5, peak: 0.55 });
            _tpBubbleTone(ac, { start: t, dur: 0.13, freqStart: 220, freqPeak: 600, freqEnd: 380, lpStart: 2600, lpEnd: 600, q: 8, peak: 0.3 });
        } catch (e) {}
    }

    // Lays a circle-cropped IMDb headshot over the badge's icon, then moves the
    // red ring back on top. Built with DOM APIs (URL via setAttribute, never
    // interpolated into markup). If the image fails to load it removes itself,
    // and the icon underneath is what shows -- no separate fallback path.
    function _tpAddHeadshot(svg, url) {
        if (!svg) return;
        const NS = 'http://www.w3.org/2000/svg';
        const clip = document.createElementNS(NS, 'clipPath');
        clip.setAttribute('id', 'sc-tp-headshot-clip');
        const disc = document.createElementNS(NS, 'circle');
        disc.setAttribute('cx', '30'); disc.setAttribute('cy', '30'); disc.setAttribute('r', '25.5');
        clip.appendChild(disc);
        const img = document.createElementNS(NS, 'image');
        img.setAttribute('href', url);
        img.setAttribute('x', '4.5'); img.setAttribute('y', '4.5');
        img.setAttribute('width', '51'); img.setAttribute('height', '51');
        img.setAttribute('preserveAspectRatio', 'xMidYMid slice');
        img.setAttribute('clip-path', 'url(#sc-tp-headshot-clip)');
        img.addEventListener('error', () => img.remove());
        svg.insertBefore(clip, svg.firstChild);
        svg.appendChild(img);
        const ring = svg.querySelector('circle[stroke]');
        if (ring) svg.appendChild(ring); // ring above the photo
    }

    function showTriviaBubble(fact) {
        _tpDismissBubble(true); // no double-stacking if one was somehow still up
        _tpPlayPopSound();

        _tpBubbleEl = document.createElement('div');
        _tpBubbleEl.id = 'sc-tp-bubble';
        const icon = TP_ICON_SVGS[tpPickIconKey(fact.icon, TP_ICON_KEYS, Math.random)];
        const bylineHtml = fact.byline ? `<div id="sc-tp-byline">${_escHtml(fact.byline)}</div>` : '';
        _tpBubbleEl.innerHTML = `
            <svg id="sc-tp-tail" viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">
                <circle cx="30" cy="30" r="27" fill="#000"/>
                <circle cx="30" cy="30" r="27" fill="none" stroke="#c81d25" stroke-width="3"/>
                ${icon}
            </svg>
            <div id="sc-tp-text">${_escHtml(fact.text)}${bylineHtml}</div>`;
        if (tpSafeImageUrl(fact.image)) _tpAddHeadshot(_tpBubbleEl.querySelector('#sc-tp-tail'), fact.image);

        // Append first (still invisible -- opacity:0 until .sc-tp-in below)
        // so its real rendered width/height can be measured, then use that
        // to pick a position guaranteed to fit on-screen -- see
        // _tpRandomPosition()'s comment for exactly what it guarantees.
        document.body.appendChild(_tpBubbleEl);

        const pos = _tpRandomPosition(_tpBubbleEl.offsetWidth, _tpBubbleEl.offsetHeight);
        _tpBubbleEl.style.setProperty('left', pos.centerXPx + 'px', 'important');
        _tpBubbleEl.style.setProperty('top', pos.topPx + 'px', 'important');

        requestAnimationFrame(() => _tpBubbleEl && _tpBubbleEl.classList.add('sc-tp-in'));

        _tpBubbleEl.addEventListener('click', () => _tpDismissBubble(false));
        _tpBubbleEl.addEventListener('mouseenter', () => clearTimeout(_tpDismissTimer));
        _tpBubbleEl.addEventListener('mouseleave', _tpArmDismissTimer);
        _tpArmDismissTimer();
    }

    function _tpArmDismissTimer() {
        clearTimeout(_tpDismissTimer);
        _tpDismissTimer = setTimeout(() => _tpDismissBubble(false), TP_VISIBLE_MS);
    }

    function _tpDismissBubble(instant) {
        clearTimeout(_tpDismissTimer); _tpDismissTimer = null;
        if (!_tpBubbleEl) return;
        const el = _tpBubbleEl;
        _tpBubbleEl = null;
        if (instant) { el.remove(); return; }
        el.classList.add('sc-tp-out');
        setTimeout(() => el.remove(), TP_EXIT_ANIM_MS);
    }

    /* ==========================================================
       QUICK-TOGGLE BUTTON -- a small top-bar button that mutes/resumes
       the bubbles for the session without opening Settings. Created by
       movie-title-links/index.js alongside #sc-trivia-btn (same lifecycle:
       removed and recreated on every title change, only while a movie with
       a matched IMDb id is playing). All the DOM/state logic lives here so
       that module just calls scRenderTriviaPopupBtn().
    ========================================================== */

    // Live reference to the current button node (recreated per title change),
    // so _tpSetMuted can repaint it. On unmute mid-movie the movie's own
    // trivia resumes right away, but cast/crew enrichment is only fetched
    // when popupTriviaEnabled() is true at movie-change time (see
    // _tpResetForNewMovie): a movie that started while muted shows only its
    // base facts even after unmute, until the next movie -- same as toggling
    // the Settings checkbox off then on mid-movie already behaves.
    let _tpBtnEl = null;

    function _tpPaintPopupBtn() {
        if (!_tpBtnEl) return;
        // The standalone Pop-up Video build draws its own toggle (a CyTube
        // #videocontrols button); the main script never defines this hook.
        if (typeof scPopupBtnPaint === 'function') { scPopupBtnPaint(_tpBtnEl, _tpMuted); return; }
        // Filled vs hollow dot -- same glyph width either way, so the button
        // never changes size (which would leave #sc-upnext-btn's live-measured
        // position stale until the next title change).
        _tpBtnEl.textContent = (_tpMuted ? '○' : '●') + ' Pop-ups';
        _tpBtnEl.title = _tpMuted
            ? 'Pop-up trivia muted — click to resume'
            : 'Pop-up trivia on — click to mute';
        _tpBtnEl.classList.toggle('sc-tp-btn-on', !_tpMuted);
    }

    function _tpSetMuted(muted) {
        _tpMuted = !!muted;
        clearTimeout(_tpPopTimer); _tpPopTimer = null;
        if (_tpMuted) {
            _tpDismissBubble(true); // yank any bubble that's currently up
        } else if (!_tpTimeline) {
            // Resume promptly rather than waiting out a full frequency gap.
            // (Timeline mode needs nothing -- the heartbeat picks up the next due fact.)
            _tpPopTimer = setTimeout(_tpAttemptPop, 1500);
        }
        _tpPaintPopupBtn();
    }

    function scRenderTriviaPopupBtn() {
        _tpBtnEl = null; // the previous node (if any) is being recreated by the caller
        if (!popupTriviaConfigured()) return; // feature not opted into -- no button
        const btn = document.createElement('button');
        btn.id = 'sc-trivia-popup-btn';
        btn.addEventListener('click', () => _tpSetMuted(!_tpMuted));
        _tpBtnEl = btn;
        _tpPaintPopupBtn();
        // Standalone hook: mount the toggle in CyTube's own video controls.
        if (typeof scPopupBtnMount === 'function') scPopupBtnMount(btn);
        else document.body.appendChild(btn);
        return btn;
    }

    scRegisterSetting({
        id: 'sc-input-triviapopup',
        group: 'trivia-popup',
        label: 'Pop-up trivia bubbles during movies (Experimental)',
        note: 'Every few minutes, shows a small trivia fact for about 15 seconds, VH1 Pop-up Video style, then fades out. Off by default. Movies with curated Pop-up Video trivia get hand-picked, sourced facts timed to the movie -- everyone in the channel sees each one at the same moment; join late and the ones you missed show up in the gaps. Other movies fall back to IMDb trivia at random intervals. Facts never repeat, and this is remembered for a few hours so a page reload won\'t re-show ones you already saw. While a movie is playing, a "Pop-ups" button in the top bar mutes or resumes the bubbles for the session.',
        key: LS_TRIVIA_POPUP_ENABLED,
        defaultOn: false,
        order: 9,
    });
    scRegisterSetting({
        id: 'sc-input-triviapopupfreq',
        type: 'select',
        group: 'trivia-popup',
        label: 'Pop-up trivia frequency',
        note: 'How often a trivia bubble pops up. For movies with curated trivia (timed for everyone), this picks how many of the timed facts you see: Frequent = all, Occasional = the better ones, Rare = only the best.',
        key: LS_TRIVIA_POPUP_FREQUENCY,
        options: [
            { value: 'frequent', label: 'Frequent (all timed facts / 45s – 90s)' },
            { value: 'occasional', label: 'Occasional (better timed facts / 3 – 6 min, default)' },
            { value: 'rare', label: 'Rare (best timed facts only / 8 – 15 min)' },
        ],
        defaultValue: TP_FREQUENCY_DEFAULT,
        order: 10,
    });
    scRegisterInit(triviaPopupBoot);
injectCSS('pv-popup', `            /* ===== POP-UP TRIVIA BUBBLE ===== */
            /* Styled after the classic VH1 Pop-up Video caption bubble:
               plain white card, thick black outline, bold black text, no
               close button -- it just times out on its own. */
            #sc-tp-bubble {
                position: fixed !important;
                left: 50% !important;
                top: 60% !important;
                z-index: 15500 !important; /* above video chrome (~10001-10004), below dropdowns/modals (~19000/20001) */
                max-width: min(460px, 88vw) !important;
                display: flex !important;
                align-items: center !important;
                padding: 30px 20px 16px 36px !important;
                background: #ffffff !important;
                border: 5px solid #000 !important;
                border-radius: 20px !important;
                box-shadow: 0 6px 18px rgba(0,0,0,0.55) !important;
                font-family: 'Arial Rounded MT Bold','Comic Sans MS',sans-serif !important;
                opacity: 0 !important;
                transform: translateX(-50%) scale(0.001) !important;
                transition: transform 0.28s cubic-bezier(.34,1.56,.64,1), opacity 0.2s ease !important;
                pointer-events: auto !important;
                cursor: pointer !important;
            }
            /* left/top above are just pre-JS fallbacks -- showTriviaBubble()
               overrides both inline (with !important) every time, to a
               measured px position picked by _tpRandomPosition(): a letterbox
               bar or picture corner, biased away from the centre of frame and
               kept clear of the chat panel. */
            #sc-tp-bubble.sc-tp-in {
                opacity: 0.9 !important;
                transform: translateX(-50%) scale(1) !important;
            }
            #sc-tp-bubble.sc-tp-out {
                opacity: 0 !important;
                transform: translateX(-50%) scale(0.85) !important;
                transition-duration: 0.3s !important;
            }
            #sc-tp-tail {
                position: absolute !important;
                top: -18px !important;
                left: -22px !important;
                width: 48px !important;
                height: 48px !important;
                overflow: visible !important;
                filter: drop-shadow(0 2px 3px rgba(0,0,0,0.4)) !important;
            }
            #sc-tp-text {
                color: #0a0a0a !important;
                font-size: 15px !important;
                font-weight: 700 !important;
                line-height: 1.35 !important;
            }
            #sc-tp-byline {
                color: #4a4a4a !important;
                font-family: 'Arial Rounded MT Bold','Comic Sans MS',sans-serif !important;
                font-size: 12px !important;
                font-weight: 400 !important;
                line-height: 1.3 !important;
                margin-top: 6px !important;
            }

            /* ===== QUICK-TOGGLE BUTTON =====
               Near-duplicate of #sc-trivia-btn (imdb-trivia/style.css), one
               slot to its left in the floating top-bar row
               ([Pop-ups] [Trivia] [UP NEXT] [Coming Attractions]). The fixed
               offset below is #sc-trivia-btn's own 232px slot plus roughly
               the rendered width of its "Trivia" label, so the two sit
               flush. Biased a little wide -- a small gap only shows as a
               hairline space; overlapping text does not. Tune live. */
            #sc-trivia-popup-btn {
                position: fixed !important;
                z-index: 10003 !important;
                top: 0 !important;
                right: calc(var(--sc-chat-w) + 1vw + 298px) !important;
                background: transparent !important;
                border: none !important;
                border-radius: 0 !important;
                color: rgba(255,255,255,0.55) !important;
                font-size: 10px !important;
                letter-spacing: 0.06em !important;
                text-transform: uppercase !important;
                white-space: nowrap !important;
                line-height: 1 !important;
                cursor: pointer !important;
                padding: 2px 8px !important;
                height: 20px !important;
                display: flex !important;
                align-items: center !important;
                transition: opacity 1.5s ease, color 0.2s ease !important;
                opacity: 1 !important;
                pointer-events: auto !important;
            }
            #sc-trivia-popup-btn.sc-bar-dim { opacity: 0 !important; pointer-events: none !important; }
            #sc-trivia-popup-btn:hover { color: rgba(255,255,255,0.9) !important; }
            #sc-trivia-popup-btn.sc-tp-btn-on { color: rgba(255,255,255,0.9) !important; }
            body.sc-vertical #sc-trivia-popup-btn { right: 298px !important; top: 0 !important; }
`);
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
        btn.innerHTML = '<span class="glyphicon glyphicon-comment"></span>';
        btn.title = muted ? 'Pop-up trivia muted — click to resume' : 'Pop-up trivia on — click to mute';
        btn.classList.toggle('active', !muted);
        btn.style.opacity = muted ? '0.55' : '';
    }
    // ── test marker: pv-button slice end ──

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
            if (typeof scRenderTriviaPopupBtn === 'function') scRenderTriviaPopupBtn();
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
        const old = document.getElementById(PV_BTN_ID);
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
        pvOnTitle(_pvDomTitle(), false);
        let polls = 0;
        const poll = setInterval(() => { pvOnTitle(_pvDomTitle(), false); if (++polls >= 14) clearInterval(poll); }, 1500);
    }
    scRegisterInit(pvWatcherBoot);
injectCSS('pv-watcher', `            /* Standalone: the mute toggle normally sits in CyTube's #videocontrols
               as a plain Bootstrap .btn (see watcher.js scPopupBtnMount). Only if
               that bar is missing does it float -- below the fixed navbar (whose
               right side holds login/logout) and under Bootstrap modals (1050). */
            #sc-pv-btn.sc-pv-floating {
                position: fixed !important; top: 60px !important; right: 12px !important;
                z-index: 1040 !important;
            }
`);

})();
