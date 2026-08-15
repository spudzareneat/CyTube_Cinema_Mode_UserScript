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

        // Replace dots and underscores with spaces
        s = s.replace(/[._]+/g, ' ');

        // Strip leftover brackets and their contents (tags like [BluRay], [720p])
        s = s.replace(/[\[(][^\])]*/g, '').replace(/[\])]/, '');

        // Trim and collapse whitespace
        s = s.replace(/\s+/g, ' ').trim();

        return { title: s, year };
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
        [...YT_NOISE, ...YT_GENRES].forEach(n => {
            s = s.replace(new RegExp('\\b' + n + '\\b', 'gi'), ' ');
        });
        s = s.replace(/[^\w\s&':!.,-]/g, ' ');
        const segs = s.split(/\s[|–—•:_-]+\s/)
            .map(x => x.replace(/\s+/g, ' ').trim())
            .filter(x => x.length >= 2);
        let title = segs.sort((a, b) =>
            (b.match(/[a-z]/gi) || []).length - (a.match(/[a-z]/gi) || []).length
        )[0] || s;
        title = title.replace(/\s+/g, ' ').replace(/^[\s'":.,-]+|[\s'":.,-]+$/g, '').trim();
        return { title, year };
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
    // Playing card's TMDB lookup has resolved for this video (requires a TMDB
    // key -- null otherwise, caller falls back). Returns null when no title
    // has been detected yet.
    function getBridgeMovieInfo() {
        if (!lastMovieTitle) return null;
        const { title, year } = parseMovieFilename(lastMovieTitle);
        if (!title) return null;
        return { title, year: year || null, imdbId: (_npData && _npData.imdbId) || null };
    }
