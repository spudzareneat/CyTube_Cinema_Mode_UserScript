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

    function parseMovieFilename(raw) {
        // Remove file extension
        let s = raw.replace(/\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts|divx|xvid|ogv)$/i, '');

        // Extract year from brackets or parens: [1984] or (1984)
        let year = null;
        const yearMatch = s.match(/[\[(](\d{4})[\])]/);
        if (yearMatch) {
            year = yearMatch[1];
            s = s.slice(0, yearMatch.index); // strip everything from year onwards
        }

        // Extract season/episode (S01E10, Season 1 Episode 20, 1x22, Ep. 5, etc.)
        // and cut the title at the match, same convention as the year cut above --
        // keeps the series-name prefix, discards the episode-specific subtitle
        // scene/upload filenames often append after the marker.
        let season = null, episode = null;
        const epMatch = _matchEpisode(s);
        if (epMatch) {
            season = epMatch.season;
            episode = epMatch.episode;
            s = s.slice(0, epMatch.match.index);
        }

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
