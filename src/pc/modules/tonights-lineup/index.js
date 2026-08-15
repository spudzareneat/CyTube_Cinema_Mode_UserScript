    /* ==========================================================
       TONIGHT'S LINEUP — Reddit schedule fetch/parse, timing/ETA model,
       per-section theme, data interface, full-screen overlay UI, and the
       Coming Attractions toggle button that opens it (at the bottom of
       this file). Five internally-sequential sub-sections kept together
       as one module since none of them is independently useful on its
       own.

       Depends on movie-title-links for lookupMovie()/showNowPlayingCard()
       (poster art, ratings, runtime, parental-guide chips) -- Tonight's
       Lineup's whole point is showing what's playing, so a build without
       movie-title-links wouldn't be a usable feature anyway (see this
       module's `dependsOn` in manifest.json). movie-title-links itself
       calls back into this module's lineupObserveTitleChange() through a
       typeof-guard (see movie-title-links/index.js), since from its side
       this module is optional even though the reverse isn't true.
    ========================================================== */

    /* ==========================================================
       TONIGHT'S LINEUP -- Reddit schedule fetch + parse.
       r/420Grindhouse's Atom feed (https://www.reddit.com/r/420Grindhouse/.rss) is
       reachable with a browser UA and no login (the .json endpoints 403 the same
       way generic bots get blocked elsewhere; .rss doesn't). The pinned schedule
       post sorts FIRST in the feed regardless of nominal sort order -- "find this
       week's post" is just "take entry #1", no slug/title matching needed.

       The post body is a fixed markdown->HTML shape: an intro paragraph, then
       repeating <p><strong>Day</strong></p> headers (Friday/Saturday/Sunday, a
       closed 3-name set) each followed by 2-4 <p><strong>Section Name</strong>
       </p> + <ul><li>Title (Year)</li>...</ul> pairs. Two independent layers of
       HTML-entity escaping are present: the Atom feed XML-escapes the whole
       content blob, and Reddit's own markdown renderer separately entity-encodes
       special characters (apostrophes, etc.) within it -- lineupDecodeHtmlEntities
       is applied once, up front, so everything downstream works on plain text/tags.
       Ported from the Android Grindhouse app's web/src/lineup/{reddit,timing}.js.
    ========================================================== */

    const LINEUP_FEED_URL = 'https://www.reddit.com/r/420Grindhouse/.rss';
    const LINEUP_DAY_NAMES = ['Friday', 'Saturday', 'Sunday'];

    function lineupSlugify(name) {
        return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    }

    function lineupDecodeHtmlEntities(s) {
        return s
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
            .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
            .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
    }

    // Extracts every <entry> in the feed, in feed order. Reddit does NOT reliably sort
    // the current/pinned schedule post first -- confirmed live 2026-07-22: an already-
    // expired "Fri 7/17 - Sun 7/19" post sat in entry #0 all week while the brand-new
    // "Fri 7/24 - Sun 7/26" post (published same day) sat in entry #1 behind it,
    // apparently ordered by pin slot rather than recency/validity. lineupSelectCurrentEntry
    // (below) is what actually picks the right one; this just extracts every candidate.
    function lineupParseEntries(feedXml) {
        const entries = [];
        let searchFrom = 0;
        while (true) {
            const start = feedXml.indexOf('<entry>', searchFrom);
            if (start === -1) break;
            const end = feedXml.indexOf('</entry>', start);
            if (end === -1) break;
            const entry = feedXml.slice(start, end + '</entry>'.length);
            searchFrom = end + '</entry>'.length;
            const idM = entry.match(/<id>([^<]+)<\/id>/);
            const titleM = entry.match(/<title>([^<]+)<\/title>/);
            const contentM = entry.match(/<content type="html">([\s\S]*?)<\/content>/);
            if (!idM || !titleM || !contentM) continue;
            const pubM = entry.match(/<published>([^<]+)<\/published>/);
            entries.push({
                postId: idM[1],
                title: lineupDecodeHtmlEntities(titleM[1]),
                publishedAt: pubM ? pubM[1] : null,
                contentHtml: lineupDecodeHtmlEntities(contentM[1]),
            });
        }
        return entries;
    }

    // Kept for parity with the Android app's parseFirstEntry -- just the first extracted
    // entry, no attempt to pick the *right* one (see lineupSelectCurrentEntry for that).
    // Returns null if the feed has no entries or is missing a required field.
    function lineupParseFirstEntry(feedXml) {
        return lineupParseEntries(feedXml)[0] || null;
    }

    // The pinned schedule post is expected within the top 3 feed entries; scanning a
    // couple extra costs nothing and covers a mod re-pin landing it one slot further out.
    const LINEUP_CANDIDATE_SCAN_LIMIT = 5;

    // Picks the actual current schedule post out of the top of the feed: of the entries
    // whose title looks like a schedule post (lineupParseDateRange returns non-null --
    // filters out unrelated posts like "4 Days" or a single-film announcement), the one
    // published most recently wins. Confirmed live 2026-07-22: the correct post is always
    // the newest one, even when an older, already-expired schedule post happens to sort
    // ahead of it in raw feed order (seen that day -- last weekend's post stayed in entry
    // #0 while this weekend's, published same-day, sat in entry #1).
    function lineupSelectCurrentEntry(entries) {
        let best = null;
        for (const entry of entries.slice(0, LINEUP_CANDIDATE_SCAN_LIMIT)) {
            if (!lineupParseDateRange(entry.title, entry.publishedAt)) continue; // not a schedule post
            if (!best || new Date(entry.publishedAt) > new Date(best.publishedAt)) best = entry;
        }
        return best;
    }

    // Parses "Weekend Grindhouse Schedule - Fri 7/10 - Sun 7/12" into real calendar
    // dates. Only Friday's month/day is read from the title -- Saturday and Sunday are
    // always +1/+2 days from Friday. The year comes from the post's own publishedAt
    // timestamp, not system "now" -- except a December post for a January weekend,
    // where the weekend is next year.
    function lineupParseDateRange(title, publishedAt) {
        const m = title && title.match(/Fri\D*(\d{1,2})\/(\d{1,2})/i);
        if (!m || !publishedAt) return null;
        const pub = new Date(publishedAt);
        if (isNaN(pub.getTime())) return null;
        const friMonth = parseInt(m[1], 10), friDay = parseInt(m[2], 10);
        const pubMonth = pub.getMonth() + 1;
        const year = (pubMonth === 12 && friMonth === 1) ? pub.getFullYear() + 1 : pub.getFullYear();
        const fri = Date.UTC(year, friMonth - 1, friDay);
        const toStr = (ms) => new Date(ms).toISOString().slice(0, 10);
        return { fri: toStr(fri), sat: toStr(fri + 86400000), sun: toStr(fri + 2 * 86400000) };
    }

    // Each <li> is "Title (Year)", sometimes with a leading bold label or trailing
    // "aka Other Title" name(s). The primary (title, year) pair drives the TMDB lookup;
    // akas become extra MATCH aliases (the stream sometimes plays a film under the
    // file's aka name); `display` keeps the full original text.
    function lineupParseListItems(ulInnerHtml) {
        const items = [];
        const liRe = /<li>([\s\S]*?)<\/li>/g;
        let lm;
        while ((lm = liRe.exec(ulInnerHtml))) {
            const display = lm[1].replace(/<strong>[^<]*<\/strong>\s*/, '').replace(/<[^>]+>/g, '').trim();
            if (!display) continue;
            const [primary, ...akaParts] = display.split(/\s+aka\s+/i);
            const akas = akaParts
                .map(a => a.replace(/\s*\(\d{4}\)\s*$/, '').trim())
                .filter(Boolean);
            // Non-greedy up to the FIRST "(YYYY)" -- tolerates trailing typos/garbage after
            // it (confirmed live 2026-08-07: a mod typo left "Decampitated (1998))" with an
            // extra closing paren, which the old exact-end-anchored regex rejected outright).
            const ym = primary.trim().match(/^(.*?)\s*\((\d{4})\)/);
            if (ym) {
                items.push({ title: ym[1].trim(), year: ym[2], display, akas });
            } else {
                // No parseable year at all (missing, or a format this parser doesn't
                // recognize) -- still show it instead of silently vanishing the film from
                // the lineup. TMDB lookup runs yearless off the raw text; the card just
                // won't have a poster/overview if that search comes up empty too.
                console.warn('[SC] lineup: could not parse title/year from schedule item, showing raw text:', display);
                items.push({ title: primary.trim(), year: null, display, akas });
            }
        }
        return items;
    }

    // Case-insensitive "is this schedule item the film called `title`?" -- checks the
    // primary title and every post-provided aka. Tolerates cached schedules written
    // before akas existed (no `akas` field).
    function lineupItemMatchesTitle(item, title) {
        const t = (title || '').toLowerCase();
        if (item.title.toLowerCase() === t) return true;
        return (item.akas || []).some(a => a.toLowerCase() === t);
    }

    // Walks the post body in document order, assigning each <ul> of films to the most
    // recently seen section name, and each section to the most recently seen day.
    function lineupParseSchedule(contentHtml) {
        const days = [];
        let currentDay = null;
        let pendingSectionName = null;
        const re = /<strong>([^<]*)<\/strong>|<ul>([\s\S]*?)<\/ul>/g;
        let m;
        while ((m = re.exec(contentHtml))) {
            if (m[1] !== undefined) {
                const text = m[1].trim();
                // Mods sometimes wrap the day header in extra markdown emphasis inside the
                // bold ("==Friday=="), which survives entity-decoding as literal '=' characters
                // -- strip any leading/trailing non-letters before comparing so decoration
                // doesn't stop currentDay from ever being set (confirmed live 2026-08-07: an
                // "==Friday==" header silently produced zero parsed days). The cleaned name,
                // not the decorated text, is stored so dateByDay's Friday/Saturday/Sunday
                // lookup in fetchTonightsSchedule still matches.
                const dayName = text.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
                if (LINEUP_DAY_NAMES.includes(dayName)) {
                    currentDay = { day: dayName, sections: [] };
                    days.push(currentDay);
                    pendingSectionName = null;
                } else {
                    pendingSectionName = text;
                }
            } else if (currentDay && pendingSectionName) {
                const items = lineupParseListItems(m[2]);
                if (items.length) currentDay.sections.push({ name: pendingSectionName, slug: lineupSlugify(pendingSectionName), items });
                pendingSectionName = null;
            }
        }
        return days;
    }

    function lineupGmFetch(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
                onload: resolve,
                onerror: reject,
            });
        });
    }

    // Fetches and fully parses the current schedule post. Throws on any failure
    // (network, missing entry, unparseable date range, zero days/sections parsed) --
    // the caller (lineupEnsureSchedule, Task 3) catches this and falls back to the
    // Now/Next-only view built from live changeMedia data.
    async function fetchTonightsSchedule() {
        const res = await lineupGmFetch(LINEUP_FEED_URL);
        if (!res || res.status !== 200) throw new Error('Reddit feed HTTP ' + (res && res.status));
        const entries = lineupParseEntries(res.responseText);
        if (!entries.length) throw new Error('no entries found in feed');
        const entry = lineupSelectCurrentEntry(entries);
        if (!entry) throw new Error('no schedule post found in feed');
        const dateRange = lineupParseDateRange(entry.title, entry.publishedAt);
        if (!dateRange) throw new Error('could not parse weekend date range from title: ' + entry.title);
        const days = lineupParseSchedule(entry.contentHtml);
        if (!days.length) throw new Error('no days parsed from schedule post');
        const dateByDay = { Friday: dateRange.fri, Saturday: dateRange.sat, Sunday: dateRange.sun };
        return {
            postId: entry.postId,
            title: entry.title,
            publishedAt: entry.publishedAt,
            days: days.map(d => ({ ...d, date: dateByDay[d.day] || null })),
        };
    }

    /* ==========================================================
       TONIGHT'S LINEUP -- timing/ETA model.
       Precision decays honestly the further out an estimate is: 'exact' (current
       feature's remaining runtime + one learned bumper gap), 'approx' (further out,
       compounding uncertainty), 'late' (tail of the night -- running order only).
    ========================================================== */

    function lineupFormatEta(hour24, minute, precision) {
        if (precision === 'late') return 'LATE';
        const period = hour24 >= 12 ? 'PM' : 'AM';
        let h = hour24 % 12;
        if (h === 0) h = 12;
        const mm = String(minute).padStart(2, '0');
        const prefix = precision === 'approx' ? '~' : '≈';
        return `${prefix} ${h}:${mm} ${period}`;
    }

    // Running median of observed bumper-gap durations (seconds) between features.
    function lineupMedianGapSeconds(observedGaps) {
        if (!observedGaps.length) return null;
        const sorted = [...observedGaps].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    // Friendly display rounding for an ETA instant: these are guesses, so don't show
    // oddly-specific minutes. 'approx' floors to the previous quarter-hour (4:39 -> 4:30);
    // 'exact' has a real live anchor behind it, so it only snaps to the nearest 5 minutes.
    // A displayed time must never already be in the past (it reads as broken -- e.g. a long
    // bumper block pushed the walk behind the clock), so anything that rounds to before
    // `nowMs` clamps up to the next grid point at-or-after now instead. Epoch flooring lands
    // on local :00/:15/:30/:45 because real UTC offsets are 15-min multiples.
    function lineupRoundEtaMs(etaMs, precision, nowMs) {
        const grid = precision === 'exact' ? 5 * 60000 : 15 * 60000;
        const round = precision === 'exact' ? Math.round : Math.floor;
        const rounded = round(etaMs / grid) * grid;
        if (nowMs != null && rounded < nowMs) return Math.ceil(nowMs / grid) * grid;
        return rounded;
    }

    const LINEUP_MAX_ESTIMATED_AHEAD = 4; // live-anchored: how many upcoming films past "now" get ETAs
    const LINEUP_MAX_PRE_SHOW = 3;        // projection-only: how many films get a "starts around then" guess

    // Per-film played/now-playing/ETA model for one day of the lineup. Pure -- every
    // input is a number/array so the whole branch tree is easy to reason about without
    // the socket/DOM state the data layer feeds it from. Returns one entry per film
    // (same order): { played, isNowPlaying, etaMs: epoch-ms | null, precision: 'exact' | 'approx' }
    // Estimates degrade honestly by evidence quality: a confirmed now-playing film gives
    // the next film an 'exact' ETA; a bumper anchor or the noon-Pacific clock projection
    // only ever supports 'approx'.
    //
    // The gap immediately before a film is section-aware: sectionOf[idx] is that film's
    // section index, and a transition where it differs from sectionOf[idx - 1] (crossing into
    // a new named block) uses crossSectionGapSeconds instead of sameSectionGapSeconds -- a
    // section break tends to run a whole separate bumper reel (several short clips back to
    // back), not one bumper's worth of gap, so a single pooled gap can badly underestimate
    // exactly those transitions. sectionOf is optional; omitting it treats every film as one
    // section (every gap is "same-section").
    function lineupMakeGapMsFor(sectionOf, sameSectionGapSeconds, crossSectionGapSeconds) {
        return (idx) => {
            const crossing = sectionOf && idx > 0 && idx < sectionOf.length
                && sectionOf[idx] !== sectionOf[idx - 1];
            return (crossing ? crossSectionGapSeconds : sameSectionGapSeconds) * 1000;
        };
    }

    function lineupEstimateDayItems({
        nowMs, anchorMs, runtimesMin, sectionOf, sameSectionGapSeconds, crossSectionGapSeconds,
        dayStatus, currentIndex, remainingSec, furthestPlayedIndex, bumperStartMs,
    }) {
        const gapMsFor = lineupMakeGapMsFor(sectionOf, sameSectionGapSeconds, crossSectionGapSeconds);
        const runtimeMs = (i) => (runtimesMin[i] ? runtimesMin[i] * 60000 : 0);
        // A film with no TMDB runtime match contributes zero minutes to the walk, which would
        // otherwise make the NEXT film's ETA silently identical to this one's. Once an
        // unknown-runtime film enters the walk, every ETA past it is built on a genuinely
        // unknown gap -- more honest to withhold those than show a confident-looking guess, so
        // `confident` latches false once tripped and every later film in this branch goes blank.
        const runtimeUnknown = (i) => runtimesMin[i] == null;
        const blank = { played: false, isNowPlaying: false, etaMs: null, precision: 'approx' };

        if (dayStatus === 'past') {
            return runtimesMin.map(() => ({ ...blank, played: true }));
        }

        // Clock projection from the noon anchor: each film's start/end if the night ran
        // exactly to schedule. Used for future days, today's pre-show, and joined-late.
        const projected = [];
        let cursor = anchorMs;
        runtimesMin.forEach((_, i) => {
            projected.push({ startMs: cursor, endMs: cursor + runtimeMs(i) });
            cursor += runtimeMs(i) + gapMsFor(i + 1);
        });

        if (dayStatus === 'today' && currentIndex >= 0) {
            // Live anchor: walk forward from the current film's remaining runtime. remainingSec
            // is null when the duration isn't known yet (e.g. joined mid-film, before the next
            // changeMedia arrives) -- treat that as "no live data" rather than letting it read as
            // 0 (which would otherwise mean "wrapping up right now" and anchor the next film's ETA
            // to nowMs+gap, a confident-looking but bogus guess).
            let cumulative = remainingSec != null ? Math.max(0, remainingSec) * 1000 : 0;
            let confident = remainingSec != null;
            return runtimesMin.map((_, idx) => {
                if (idx === currentIndex) return { ...blank, isNowPlaying: true };
                if (idx < currentIndex || idx <= furthestPlayedIndex) return { ...blank, played: true };
                const offset = idx - currentIndex;
                cumulative += gapMsFor(idx);
                const withEta = offset <= LINEUP_MAX_ESTIMATED_AHEAD && confident
                    ? { ...blank, etaMs: nowMs + cumulative, precision: offset === 1 ? 'exact' : 'approx' }
                    : { ...blank };
                if (runtimeUnknown(idx)) confident = false;
                cumulative += runtimeMs(idx);
                return withEta;
            });
        }

        if (dayStatus === 'today' && furthestPlayedIndex >= 0) {
            // Bumper between films (or a title we failed to match): the furthest observed
            // film has finished; keep estimating from when the unmatched item started.
            let cumulative = (bumperStartMs != null ? bumperStartMs : nowMs) + gapMsFor(furthestPlayedIndex + 1);
            let confident = true; // the bumper/now anchor itself is live data, always trusted
            return runtimesMin.map((_, idx) => {
                if (idx <= furthestPlayedIndex) return { ...blank, played: true };
                const offset = idx - furthestPlayedIndex;
                const withEta = offset <= LINEUP_MAX_ESTIMATED_AHEAD && confident ? { ...blank, etaMs: cumulative } : { ...blank };
                if (runtimeUnknown(idx)) confident = false;
                cumulative += runtimeMs(idx) + gapMsFor(idx + 1);
                return withEta;
            });
        }

        // No observation at all: future day, today's pre-show, or joined-late today.
        // Gray by projected end; guess starts for the next LINEUP_MAX_PRE_SHOW unstarted
        // films. A film straddling `now` is left unmarked -- probably playing, unconfirmed.
        let guesses = 0;
        let confident = true;
        return runtimesMin.map((_, idx) => {
            const p = projected[idx];
            if (dayStatus === 'today') {
                if (p.endMs < nowMs) return { ...blank, played: true };
                if (p.startMs <= nowMs) return { ...blank };
            }
            if (guesses < LINEUP_MAX_PRE_SHOW && confident) {
                guesses++;
                if (runtimeUnknown(idx)) confident = false;
                return { ...blank, etaMs: p.startMs };
            }
            return { ...blank };
        });
    }

    // Pacific-timezone offset (minutes) of the UTC instant `d`. Noon is never within a
    // couple hours of a DST transition (those happen at 2am local), so a single
    // read-back is safe -- no iteration needed.
    function lineupPacificOffsetMinutes(d) {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Los_Angeles', hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).formatToParts(d);
        const get = (t) => parts.find(p => p.type === t).value;
        const hour = parseInt(get('hour'), 10) % 24;
        const asUTC = Date.UTC(+get('year'), +get('month') - 1, +get('day'), hour, +get('minute'), +get('second'));
        return (asUTC - d.getTime()) / 60000;
    }

    // The UTC instant that is Noon Pacific on the given 'YYYY-MM-DD' calendar date --
    // the per-day showtime anchor, used as the walk-forward start point for whichever
    // day is selected, not just Friday.
    function lineupDayAnchorPacific(dateStr) {
        const [y, m, d] = dateStr.split('-').map(Number);
        const guess = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
        const offsetMinutes = lineupPacificOffsetMinutes(guess);
        return new Date(guess.getTime() - offsetMinutes * 60000);
    }

    // Today's Pacific calendar date as 'YYYY-MM-DD' -- used to pick the default day
    // tab (isToday) and to decide whether "now playing" should even be searched for.
    function lineupPacificDateString(now = new Date()) {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(now);
        const get = (t) => parts.find(p => p.type === t).value;
        return `${get('year')}-${get('month')}-${get('day')}`;
    }

    // True once a cached schedule's own weekend has fully elapsed. The pinned Reddit post
    // always describes the upcoming Fri-Sun, so once Sunday's date is in the past there is
    // definitely a newer post live -- a harder, date-driven signal than a fetch-age timer,
    // used by lineupEnsureSchedule to guarantee a rolled-over post gets picked up rather
    // than relying on however long it's been since the last fetch.
    function lineupScheduleExpired(sched, todayStr = lineupPacificDateString()) {
        const lastDate = sched.days.reduce((max, d) => (d.date && d.date > max ? d.date : max), '');
        return !lastDate || todayStr > lastDate;
    }

    /* ==========================================================
       TONIGHT'S LINEUP -- per-section font + color theme.
       Each of the 9 recurring section names (a slow-changing, closed set) gets its
       own Google Font + accent color, tying a grouping's header and its background
       wash together. Fonts are loaded once via a single combined Google Fonts CSS2
       request. Ported from the Android app's web/src/lineup/sectionThemes.js.
    ========================================================== */

    const LINEUP_THEMES = {
        'funky-cheese-friday':          { font: 'Boogaloo',           color: '#e0a92a', wash: '#2b210a' },
        'friday-grindhouse-a-go-go':    { font: 'Chewy',               color: '#ec4899', wash: '#2a0e1c' },
        'friday-night-freak-show':      { font: 'Creepster',           color: '#52c41a', wash: '#0f2109' },
        'psychedelic-saturday':         { font: "'Rubik Wet Paint'",   color: '#a855f7', wash: '#200c2b' },
        'saturday-prime-time-drive-in': { font: 'Monoton',             color: '#22d3ee', wash: '#06232a' },
        'red-light-saturday-night':     { font: "'Vast Shadow'",       color: '#ef4444', wash: '#2b0a0a' },
        'the-sunday-classics':          { font: 'Cinzel',              color: '#b8b8b8', wash: '#1c1c1c' },
        'sunday-slop-o-rama':           { font: 'Eater',               color: '#a3b125', wash: '#1c1f08' },
        'last-call-sunday-night':       { font: "'Bungee Shade'",      color: '#6366f1', wash: '#12102b' },
    };
    // Any future/unrecognized section name falls back to the script's normal font and
    // a neutral wash, rather than an unstyled or broken-looking block.
    const LINEUP_DEFAULT_THEME = { font: null, color: '#9aa0a8', wash: '#14141a' };

    function getSectionTheme(slug) {
        return LINEUP_THEMES[slug] || LINEUP_DEFAULT_THEME;
    }

    // Bebas Neue isn't a section theme -- it's the ETA/"NOW PLAYING" caption face.
    // Alfa Slab One isn't a section theme either -- it's the day-tab ticket-stub face.
    const LINEUP_FONT_FAMILIES = ['Boogaloo', 'Chewy', 'Creepster', 'Rubik+Wet+Paint', 'Monoton', 'Vast+Shadow', 'Cinzel', 'Eater', 'Bungee+Shade', 'Bebas+Neue', 'Alfa+Slab+One'];
    const LINEUP_FONTS_LINK_ID = 'sc-lineup-theme-fonts';

    // Idempotent -- safe to call on every showLineupScreen(); only injects the <link>
    // once per page load (checked by id).
    function lineupEnsureThemeFontsLoaded() {
        if (document.getElementById(LINEUP_FONTS_LINK_ID)) return;
        const link = document.createElement('link');
        link.id = LINEUP_FONTS_LINK_ID;
        link.rel = 'stylesheet';
        link.href = `https://fonts.googleapis.com/css2?${LINEUP_FONT_FAMILIES.map(f => `family=${f}`).join('&')}&display=swap`;
        document.head.appendChild(link);
    }

    /* ==========================================================
       TONIGHT'S LINEUP -- data interface consumed by the lineup screen (below).
       Fetches + caches the Reddit schedule post, persisted to localStorage and
       re-checked every time the lineup screen opens: a background revalidate past
       LINEUP_CACHE_MAX_AGE_MS, or an awaited one once the cached weekend's own dates
       are in the past (lineupScheduleExpired) -- the latter guarantees a new pinned
       post gets picked up even if this tab has sat open since before it rolled over.
       Locates "now" within TODAY's day only, and feeds the pure timing model
       (lineupEstimateDayItems above) each day's TMDB runtimes, section boundaries, the
       learned same-section and cross-section median bumper gaps, the confirmed
       now-playing film, and the persisted furthest-played marker -- yielding per-film
       ETAs (live-anchored, bumper-anchored, or projected
       from that day's Noon-Pacific showtime start) plus a played flag that grays
       already-shown posters. Falls back to the current title plus the static
       admin-curated MOTD poster art if the fetch fails and no usable cache exists.
       Ported from the Android app's web/src/lineup/data.js.
    ========================================================== */

    const LS_LINEUP_CACHE = 'sc_lineup_cache_v1';
    const LS_LINEUP_PROGRESS = 'sc_lineup_progress_v1'; // furthest film observed playing today
    const LS_LINEUP_GAP_SAME_SECTION = 'sc_lineup_gap_same_v1';   // learned same-section bumper gaps (s), across nights
    const LS_LINEUP_GAP_CROSS_SECTION = 'sc_lineup_gap_cross_v1'; // learned cross-section bumper gaps (s), across nights
    const LS_LINEUP_LAST_SECTION = 'sc_lineup_last_section_v1';   // section of the most recently matched film today
    const LINEUP_GAP_SAMPLE_CAP = 40; // bound stored sample count; oldest drop off so habits can drift over time
    // A film whose title fails to match the schedule (e.g. an unusual acronym/punctuation the
    // filename parser mangles) plays out as "unmatched" for its entire runtime, same as a real
    // bumper. If the NEXT title does match, that whole runtime would get miscounted as one giant
    // "gap" and corrupt the learned median (confirmed live on the Android sibling app: a real
    // ~97-min movie became a persisted 119.6-min "gap" sample). Real observed gaps run a few
    // minutes to low teens, so anything past this is far more likely a match failure than
    // genuine bumper time -- discard it rather than learn from it.
    const LINEUP_MAX_PLAUSIBLE_GAP_SECONDS = 30 * 60;
    // Symmetric floor: a gap under a few seconds is far more likely a spurious title-observer
    // blip (the header's MutationObserver re-firing on an unrelated DOM change, briefly
    // re-processing the same or a transient title) than a real bumper block -- confirmed live
    // 2026-07-19: a 0.419s "gap" got learned and, being the only sample, poisoned both the
    // same-section median AND the cross-section estimate (which falls back to the same-section
    // one when it has no samples of its own), collapsing the ETA for everything past the current
    // film to roughly zero padding.
    const LINEUP_MIN_PLAUSIBLE_GAP_SECONDS = 15;
    // lineupItemMatchesTitle compares title text only (no year), so any unrelated content that
    // happens to share a scheduled item's exact title -- a trailer, promo, or bumper referencing
    // the same film -- false-positive matches it. A real feature presentation runs well past
    // this; a short clip doesn't, so reject the match instead of trusting it (confirmed live
    // 2026-07-19 on the sibling Android app: a stray title collision permanently corrupted the
    // played-progress marker, graying out films hours ahead of the real one playing). Checked
    // against the socket's own declared duration (d.seconds), available immediately -- no need
    // to wait and see how long it actually plays. Doesn't catch a coincidental FULL-length
    // rerun of unrelated content under the same title; only short-clip collisions.
    const LINEUP_MIN_PLAUSIBLE_FEATURE_SECONDS = 10 * 60;
    const LINEUP_CACHE_MAX_AGE_MS = 20 * 60 * 60 * 1000; // background-revalidate if older than this
    const LINEUP_FALLBACK_TITLE = 'Coming Attractions';
    const LINEUP_PROGRESS_CONFIRM_MS = 5 * 60 * 1000; // a match this brief was a queue jump, not a showing

    let _lineupScheduleCache = null;     // {postId, title, publishedAt, days, fetchedAt} or null
    let _lineupFetchFailed = false;      // sticky for the session once Reddit is unreachable AND no cache at all
    let _lineupRevalidating = false;
    let _lineupLastUnmatchedStart = null; // Date.now() when the current unmatched (bumper) BLOCK started
    let _lineupPendingProgress = null;   // {idx, since} -- a matched film not yet current long enough to count as played
    let _lineupCurrentMatchedFlatIndex = -1; // flat index of whatever's playing RIGHT NOW per the
                                              // socket-driven match below; -1 when unmatched
    let _lineupLastObservedRawTitle = null;  // self-dedup guard so lineupObserveTitleChange is safe
                                              // to call from both the socket handler (authoritative,
                                              // immediate) and the DOM-title fallback without double-processing

    // Learned bumper-gap samples (s), split by whether the gap crossed a section boundary --
    // a section break (e.g. "Funky Cheese Friday" -> "Grindhouse-A-Go-Go") tends to run a whole
    // separate bumper reel (several short clips back to back), not just one bumper's worth of
    // gap, so pooling them with ordinary same-section gaps can badly underestimate exactly those
    // transitions. Persisted to localStorage (uncapped by date, unlike the played-progress
    // marker) so the learned habit survives a page reload instead of resetting to empty.
    function lineupReadGapSamples(key) {
        try {
            const raw = JSON.parse(localStorage.getItem(key));
            return Array.isArray(raw) ? raw.filter(n => typeof n === 'number' && n >= 0) : [];
        } catch (e) { return []; }
    }
    function lineupPushGapSample(key, arr, sec) {
        arr.push(sec);
        if (arr.length > LINEUP_GAP_SAMPLE_CAP) arr.shift();
        try { localStorage.setItem(key, JSON.stringify(arr)); }
        catch (e) { /* storage full/unavailable -- in-memory sample for this session still works */ }
    }
    let _lineupObservedSameSectionGaps = lineupReadGapSamples(LS_LINEUP_GAP_SAME_SECTION);
    let _lineupObservedCrossSectionGaps = lineupReadGapSamples(LS_LINEUP_GAP_CROSS_SECTION);

    // Section index of the most recently matched film seen today -- the "coming from" context
    // a gap needs to be classified same- vs cross-section. Persisted (date-scoped, like the
    // played-progress marker) so a page reload landing mid-bumper-block doesn't lose it and
    // silently drop that gap sample entirely.
    function lineupReadLastMatchedSection() {
        try {
            const p = JSON.parse(localStorage.getItem(LS_LINEUP_LAST_SECTION));
            return p && p.date === lineupPacificDateString() && typeof p.section === 'number' ? p.section : -1;
        } catch (e) { return -1; }
    }
    function lineupWriteLastMatchedSection(section) {
        try { localStorage.setItem(LS_LINEUP_LAST_SECTION, JSON.stringify({ date: lineupPacificDateString(), section })); }
        catch (e) { /* storage full/unavailable -- gap classification just skips until the next real match */ }
    }
    let _lineupLastMatchedSection = lineupReadLastMatchedSection();

    function lineupReadCache() {
        try {
            const raw = localStorage.getItem(LS_LINEUP_CACHE);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }
    function lineupWriteCache(schedule) {
        try { localStorage.setItem(LS_LINEUP_CACHE, JSON.stringify({ ...schedule, fetchedAt: Date.now() })); }
        catch (e) { /* storage full/unavailable -- in-memory cache for this session still works */ }
    }

    function lineupAllScheduleTitles(sched = _lineupScheduleCache) {
        if (!sched) return [];
        return sched.days.flatMap(d => d.sections.flatMap(s => s.items));
    }

    // Furthest flat index within TODAY's day ever observed playing, persisted so grayed
    // "already played" posters survive a page reload mid-night. Self-resets when the
    // stored Pacific date isn't today's.
    function lineupReadProgress() {
        try {
            const p = JSON.parse(localStorage.getItem(LS_LINEUP_PROGRESS));
            return p && p.date === lineupPacificDateString() && p.furthestIndex >= 0 ? p.furthestIndex : -1;
        } catch (e) { return -1; }
    }
    function lineupWriteProgress(furthestIndex) {
        try { localStorage.setItem(LS_LINEUP_PROGRESS, JSON.stringify({ date: lineupPacificDateString(), furthestIndex })); }
        catch (e) { /* storage full/unavailable -- graying just degrades to clock projection */ }
    }

    // If a matched film has now been current long enough to be a real showing (not a
    // momentary queue jump), commit it to the persisted marker. Called when the next
    // title change arrives AND from lineupBuildDaySections, so a still-playing film
    // past the threshold counts even before it ends.
    function lineupCommitConfirmedProgress() {
        if (!_lineupPendingProgress) return;
        if (Date.now() - _lineupPendingProgress.since >= LINEUP_PROGRESS_CONFIRM_MS) {
            if (_lineupPendingProgress.idx > lineupReadProgress()) lineupWriteProgress(_lineupPendingProgress.idx);
            _lineupPendingProgress = null;
        }
    }

    // Today's items flattened WITH each one's section index attached -- needed both to
    // classify an observed gap as same-section vs cross-section, and to locate a matched
    // title's flat index for the played-progress marker.
    function lineupFlatTodayWithSection(sched) {
        const today = sched && sched.days.find(day => day.date === lineupPacificDateString());
        if (!today) return [];
        const flat = [];
        today.sections.forEach((section, si) => section.items.forEach(item => flat.push({ si, item })));
        return flat;
    }

    // Learn bumper-gap duration live: the time from the FIRST unmatched title change after
    // a feature to the next matched one is one observed gap sample -- the whole bumper
    // block, not just its last item (resetting per-item makes the median absurdly small on
    // multi-bumper blocks). Classified same-section vs cross-section by comparing the
    // newly-matched film's section to whatever section was last confirmed playing, and pushed
    // into the matching persisted sample list (gaps implausibly longer than any real bumper
    // block get discarded instead -- see LINEUP_MAX_PLAUSIBLE_GAP_SECONDS). Matched titles in
    // TODAY's day also advance the persisted played-progress marker (via the confirm-delay
    // above) and set _lineupCurrentMatchedFlatIndex, the authoritative "what's airing right
    // now" signal lineupBuildDaySections prefers over the DOM-title heuristic (see there for
    // why). Self-dedupes on rawTitle so it's safe to call both from the socket's changeMedia
    // handler (authoritative, immediate) and from injectMovieLinks's DOM-title path (fallback
    // for the brief window before the first changeMedia of a session arrives) without
    // double-processing the same real title change. Reads the localStorage cache directly
    // (without assigning _lineupScheduleCache, which stays lineupEnsureSchedule's job so
    // revalidation still happens) so all of this works before the lineup screen is first opened.
    function lineupObserveTitleChange(rawTitle, declaredSeconds) {
        // Deliberately NOT gated on lineupTimingEnabled() -- only the display
        // (lineupBuildDaySections) is. Tracking always runs in the background so the state
        // stays accurate; gating it here too seemed like a natural extension but actually broke
        // things: while the setting was off, changeMedia events were never observed at all, so
        // a film's entire runtime could pass with no confirmed-played marker -- confirmed live
        // 2026-07-19 on the sibling Android app, Shock Waves' whole ~90min run went untracked
        // while the setting was off, and turning it back on mid-next-film showed a bogus
        // "Shock Waves starts at 8:15" because the app still thought it hadn't happened yet.
        // Always tracking means flipping the setting on shows accurate state immediately
        // instead of waiting for the next real title change to self-correct.
        if (!rawTitle) return;
        // Bail WITHOUT marking rawTitle as observed if the schedule isn't loaded yet -- e.g. the
        // socket's changeMedia resync can fire on a fresh mid-movie page load before the cached
        // schedule has finished reading. If we dedup on a "no schedule yet" outcome, this title
        // would never be re-evaluated once the schedule DOES load (the movie's title isn't going
        // to change again), leaving _lineupCurrentMatchedFlatIndex stuck at -1 for its whole
        // runtime and the ETA anchored to a stale bumper timestamp instead of the real live
        // countdown. Letting a later call (the DOM-title fallback, or the next resync) retry
        // fixes it.
        const sched = _lineupScheduleCache || lineupReadCache();
        if (!sched) return;
        if (rawTitle === _lineupLastObservedRawTitle) return;
        _lineupLastObservedRawTitle = rawTitle;

        const title = parseMovieFilename(rawTitle).title;
        const matchesSchedule = !!(title &&
            (declaredSeconds == null || declaredSeconds >= LINEUP_MIN_PLAUSIBLE_FEATURE_SECONDS) &&
            lineupAllScheduleTitles(sched).some(s => lineupItemMatchesTitle(s, title)));

        const flatToday = lineupFlatTodayWithSection(sched);
        const idx = matchesSchedule ? flatToday.findIndex(f => lineupItemMatchesTitle(f.item, title)) : -1;
        const newSection = idx !== -1 ? flatToday[idx].si : -1;
        _lineupCurrentMatchedFlatIndex = idx;

        if (!matchesSchedule) {
            if (!_lineupLastUnmatchedStart) _lineupLastUnmatchedStart = Date.now();
        } else if (_lineupLastUnmatchedStart) {
            const gapSec = (Date.now() - _lineupLastUnmatchedStart) / 1000;
            if (_lineupLastMatchedSection !== -1 && newSection !== -1
                && gapSec >= LINEUP_MIN_PLAUSIBLE_GAP_SECONDS && gapSec <= LINEUP_MAX_PLAUSIBLE_GAP_SECONDS) {
                if (newSection === _lineupLastMatchedSection) {
                    lineupPushGapSample(LS_LINEUP_GAP_SAME_SECTION, _lineupObservedSameSectionGaps, gapSec);
                } else {
                    lineupPushGapSample(LS_LINEUP_GAP_CROSS_SECTION, _lineupObservedCrossSectionGaps, gapSec);
                }
            }
            _lineupLastUnmatchedStart = null;
        }
        lineupCommitConfirmedProgress();
        _lineupPendingProgress = null; // whatever was pending either just committed or was a jump
        if (matchesSchedule && idx !== -1) {
            _lineupLastMatchedSection = newSection;
            lineupWriteLastMatchedSection(newSection);
            if (idx > lineupReadProgress()) _lineupPendingProgress = { idx, since: Date.now() };
        }
    }

    async function lineupRefetchAndCache() {
        if (_lineupRevalidating) return;
        _lineupRevalidating = true;
        try {
            const result = await fetchTonightsSchedule();
            _lineupScheduleCache = result;
            lineupWriteCache(result);
        } catch (e) {
            // Keep whatever we already had -- a failed background revalidation is
            // silent; _lineupFetchFailed only matters when we have nothing at all.
            // Logged (not swallowed silently) so a stale-cache report is diagnosable
            // after the fact instead of leaving zero trace of why it didn't update.
            console.warn('[SC] lineup refetch failed, keeping existing cache:', e && e.message);
        } finally {
            _lineupRevalidating = false;
        }
    }

    // Populates the in-memory cache from localStorage on the first call, but unlike a
    // once-only check, THIS FUNCTION RUNS AGAIN every time the lineup screen is opened --
    // a userscript's page can sit open for days without a reload, so a one-time-only check
    // here would mean the schedule, once loaded, is NEVER re-fetched again for the rest of
    // that session even after the pinned post rolls over.
    async function lineupEnsureSchedule() {
        if (!_lineupScheduleCache && !_lineupFetchFailed) {
            const cached = lineupReadCache();
            if (cached) _lineupScheduleCache = cached;
        }
        if (_lineupScheduleCache) {
            if (lineupScheduleExpired(_lineupScheduleCache)) {
                await lineupRefetchAndCache(); // the cached weekend is over -- there IS a new post, wait for it
                // Unlike routine revalidation (below), a still-expired cache here is known to be
                // wrong, not just possibly stale -- worth one immediate retry before accepting a
                // transient failure (rate limit, flaky network) as the final answer for however
                // long this tab stays open before the lineup screen is opened again.
                if (lineupScheduleExpired(_lineupScheduleCache)) {
                    await lineupRefetchAndCache();
                    if (lineupScheduleExpired(_lineupScheduleCache)) {
                        console.warn('[SC] lineup schedule still expired after refetch retry -- showing stale cached schedule:', _lineupScheduleCache.title);
                    }
                }
            } else if (Date.now() - (_lineupScheduleCache.fetchedAt || 0) > LINEUP_CACHE_MAX_AGE_MS) {
                lineupRefetchAndCache(); // just routine revalidation (e.g. a same-weekend post edit) -- fire-and-forget
            }
            return;
        }
        if (_lineupFetchFailed) return;
        try {
            const result = await fetchTonightsSchedule();
            _lineupScheduleCache = result;
            lineupWriteCache(result);
        } catch (e) {
            _lineupFetchFailed = true;
            console.warn('[SC] lineup initial fetch failed, falling back:', e && e.message);
        }
    }

    // Poster images in the MOTD are 125x175 -- keep portrait-ish images, skip wide
    // banners. Used both by the fallback view below and by the Coming Attractions
    // toggle button's "is there anything to show" check (Task 5).
    function getMotdPosterImages() {
        const motd = document.getElementById('motdrow');
        if (!motd) return [];
        return [...motd.querySelectorAll('img')].filter(img => {
            const w = parseInt(img.getAttribute('width') || 0);
            const h = parseInt(img.getAttribute('height') || 0);
            return h >= 100 && w <= 200;
        }).map(img => ({ src: img.src, title: img.title || img.alt || '' }));
    }

    // Every item's TMDB/IMDb-enriched fields, in the exact shape showNowPlayingCard
    // (line ~1566) already consumes.
    function lineupBuildItem(info, title, year) {
        return {
            cleanTitle: info.cleanTitle || title,
            cleanYear: info.cleanYear || year,
            poster: info.poster || null,
            backdrop: info.backdrop || null,
            overview: info.overview || '',
            rating: info.rating ?? null,
            runtime: info.runtime ?? null,
            genres: info.genres || [],
            parentalGuide: info.parentalGuide || null,
            killCount: info.killCount ?? null,
            imdbId: info.imdbId || null,
        };
    }

    // Fallback when Reddit is unreachable and no cache exists at all: the current item
    // (if known and it looks like a real feature, not a short/bumper) plus the same
    // admin-curated MOTD poster art the old strip showed (display-only -- no real
    // title/overview to show for those, so clicking does nothing). Shaped as a single
    // pseudo-day/section so the screen's fallback renderer doesn't need to know this
    // differs from the real day/section structure.
    async function lineupFallbackView() {
        const items = [];
        if (lastMovieTitle) {
            const { title, year } = parseMovieFilename(lastMovieTitle);
            const info = await lookupMovie(title, year);
            // Skip likely bumpers/shorts: if TMDB is configured and confidently found
            // nothing for this exact title, it's probably not a real feature. Without a
            // TMDB key at all there's no way to tell, so default to showing it.
            if (!hasKey(LS_TMDB) || info.cleanTitle) {
                items.push({ ...lineupBuildItem(info, title, year), isNowPlaying: true, etaLabel: '' });
            }
        }
        getMotdPosterImages().forEach((img) => {
            items.push({
                cleanTitle: img.title, cleanYear: null,
                poster: img.src, backdrop: null, overview: '',
                isNowPlaying: false, etaLabel: '', clickable: false,
            });
        });
        return {
            listTitle: LINEUP_FALLBACK_TITLE, fallback: true,
            days: [{ day: 'Tonight', date: null, isToday: true, sections: [{ name: '', slug: null, items }] }],
        };
    }

    // Flattens a day's sections into one ordered list (for locating "now" and walking ETAs
    // across section boundaries), hands the timing model (lineupEstimateDayItems) the flat
    // facts -- runtimes, learned gap, confirmed now-playing, persisted played-progress,
    // bumper start -- then re-nests the built items back into their sections.
    function lineupBuildDaySections(day, dayStatus, infosByKey) {
        const flat = [];
        day.sections.forEach((section, si) => {
            section.items.forEach(item => flat.push({ section, si, item }));
        });
        const infoFor = (f) => infosByKey.get(f.item.title + '|' + f.item.year) || {};

        // Experimental feature, off by default -- see lineupTimingEnabled(). Skip all live
        // matching/estimation and show the schedule as a plain, unstatused list instead: posters,
        // titles, section themes -- no NOW PLAYING, no played graying, no ETA guesses.
        if (!lineupTimingEnabled()) {
            const builtFlat = flat.map((f) => ({
                ...lineupBuildItem(infoFor(f), f.item.title, f.item.year),
                isNowPlaying: false,
                played: false,
                etaLabel: '',
            }));
            return day.sections.map((section, si) => ({
                name: section.name, slug: section.slug,
                items: builtFlat.filter((_, idx) => flat[idx].si === si),
            }));
        }

        const isToday = dayStatus === 'today';
        // Prefer the socket-driven match (_lineupCurrentMatchedFlatIndex, authoritative --
        // set straight from the raw changeMedia payload) over the DOM-title heuristic below
        // (lastMovieTitle, populated by injectMovieLinks/triggerTitleInject watching
        // #currenttitle). The DOM path can lag or land on a transient bumper/trailer title
        // right after a reload and then never update again until the next real title change,
        // while the socket payload self-heals on every real media change -- it's only ever
        // stale for the brief window before the first one arrives, which the DOM fallback covers.
        const domTitle = isToday && lastMovieTitle
            ? parseMovieFilename(lastMovieTitle).title : '';
        const domFlatIndex = domTitle
            ? flat.findIndex(f => lineupItemMatchesTitle(f.item, domTitle))
            : -1;
        const currentFlatIndex = isToday && _lineupCurrentMatchedFlatIndex !== -1
            ? _lineupCurrentMatchedFlatIndex : domFlatIndex;

        if (isToday) lineupCommitConfirmedProgress(); // a film past the confirm threshold counts as reached

        const nowMs = Date.now();
        // Cross-section falls back to the same-section median (better than a flat guess) if no
        // cross-section samples have been learned yet; same-section falls back to the original
        // 10-min cold-start default.
        const sameSectionGapSeconds = lineupMedianGapSeconds(_lineupObservedSameSectionGaps) ?? 600;
        const crossSectionGapSeconds = lineupMedianGapSeconds(_lineupObservedCrossSectionGaps) ?? sameSectionGapSeconds;
        const estimates = lineupEstimateDayItems({
            nowMs,
            anchorMs: lineupDayAnchorPacific(day.date).getTime(),
            runtimesMin: flat.map(f => infoFor(f).runtime ?? null),
            sectionOf: flat.map(f => f.si),
            sameSectionGapSeconds,
            crossSectionGapSeconds,
            dayStatus,
            currentIndex: currentFlatIndex,
            // null (not 0) when the movie's duration isn't known yet -- e.g. the page loaded
            // mid-movie, so no changeMedia carrying `seconds` has fired for it. Treating unknown
            // as 0 would make "no live data" look identical to "wrapping up right now," anchoring
            // the next film's ETA to nowMs+gap -- a confident-looking but bogus guess (seen live
            // 2026-07-19: showed ~10 min out with 15+ min actually remaining). The real value
            // arrives automatically once the next real changeMedia fires.
            remainingSec: currentFlatIndex !== -1 && getCurrentMediaSeconds() > 0
                ? Math.max(0, getCurrentMediaSeconds() - (getPlayerTimeSec() ?? 0))
                : (currentFlatIndex !== -1 ? null : 0),
            furthestPlayedIndex: isToday ? lineupReadProgress() : -1,
            bumperStartMs: _lineupLastUnmatchedStart,
        });

        const builtFlat = flat.map((f, idx) => {
            const est = estimates[idx];
            const eta = est.etaMs != null ? new Date(lineupRoundEtaMs(est.etaMs, est.precision, nowMs)) : null;
            return {
                ...lineupBuildItem(infoFor(f), f.item.title, f.item.year),
                isNowPlaying: est.isNowPlaying,
                played: est.played,
                etaLabel: eta ? lineupFormatEta(eta.getHours(), eta.getMinutes(), est.precision) : '',
            };
        });

        return day.sections.map((section, si) => ({
            name: section.name, slug: section.slug,
            items: builtFlat.filter((_, idx) => flat[idx].si === si),
        }));
    }

    // TMDB is searched under the post's primary title first; if that comes up empty, retry
    // under each aka in turn -- the stream sometimes plays (and the post lists) a film under
    // a retitle TMDB doesn't recognize (e.g. "Alien Predators" has no TMDB entry, but its
    // stated aka "The Falling" does) that lineupItemMatchesTitle already treats as the same film.
    async function lineupLookupItem(item) {
        const primary = await lookupMovie(item.title, item.year);
        if (primary.cleanTitle || !item.akas?.length) return primary;
        for (const aka of item.akas) {
            const info = await lookupMovie(aka, item.year);
            if (info.cleanTitle) return info;
        }
        return primary;
    }

    async function getTonightsLineup() {
        await lineupEnsureSchedule();
        if (!_lineupScheduleCache) return lineupFallbackView();

        const allItems = lineupAllScheduleTitles();
        const infos = await Promise.all(allItems.map(lineupLookupItem));
        const infosByKey = new Map(allItems.map((item, i) => [item.title + '|' + item.year, infos[i]]));

        const todayStr = lineupPacificDateString(); // ISO date strings order lexicographically
        const days = _lineupScheduleCache.days.map((day) => ({
            day: day.day, date: day.date, isToday: day.date === todayStr,
            sections: lineupBuildDaySections(
                day,
                day.date < todayStr ? 'past' : day.date === todayStr ? 'today' : 'future',
                infosByKey),
        }));
        return { listTitle: _lineupScheduleCache.title || LINEUP_FALLBACK_TITLE, fallback: false, days };
    }

    /* ==========================================================
       TONIGHT'S LINEUP -- full-screen schedule overlay, opened from the Coming
       Attractions toggle (Task 5). Friday/Saturday/Sunday day tabs switch which day
       is shown; within a day, every section renders stacked and native page-scroll
       moves between them (no D-pad paging -- this is mouse/keyboard, unlike the
       Android TV build this was ported from). OK/click on a film opens the existing
       Now-Playing card in browse mode. Ported from the Android app's
       web/src/lineup/screen.js, with the TV-only paging path removed.
    ========================================================== */

    let _lineupLastData = null;   // most recent getTonightsLineup() result, so tab switches don't refetch
    let _lineupActiveDay = null;  // currently selected day name

    function lineupEnsureScreenDom() {
        lineupEnsureThemeFontsLoaded();
        let screen = document.getElementById('sc-lineup-screen');
        if (screen) return screen;
        screen = document.createElement('div');
        screen.id = 'sc-lineup-screen';
        screen.innerHTML = `
            <button id="sc-lineup-close" type="button">✕</button>
            <div id="sc-lineup-header"></div>
            <div id="sc-lineup-subtitle">Titles/times may be subject to change.</div>
            <nav id="sc-lineup-daytabs"></nav>
            <div id="sc-lineup-body"></div>
            <svg width="0" height="0" style="position:absolute">
                <filter id="sc-ticket-grain">
                    <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" result="noise"/>
                    <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.08 0"/>
                </filter>
            </svg>`;
        screen.querySelector('#sc-lineup-close').addEventListener('click', hideLineupScreen);
        // Clicking the screen's own background (the side gutters, or any empty space
        // below the last section) closes it -- only fires when the click lands on the
        // screen element itself, not a descendant (header/tabs/section/poster/close button).
        screen.addEventListener('click', (e) => { if (e.target === screen) hideLineupScreen(); });
        document.body.appendChild(screen);
        return screen;
    }

    function lineupRenderLoading(screen) {
        screen.querySelector('#sc-lineup-daytabs').innerHTML = '';
        screen.querySelector('#sc-lineup-body').innerHTML =
            '<div id="sc-lineup-loading">Fetching tonight’s lineup…</div>';
    }

    // The fallback title (no TMDB poster match) sits in a fixed 200x280 box -- long
    // titles shrink to fit rather than overflowing past the poster's rounded corners.
    // Three tiers tuned against that box; .sc-lineup-poster-fallback also has
    // overflow:hidden as a hard backstop for the rare title still too long even at the
    // smallest tier.
    function lineupFallbackTitleFontSize(text) {
        if (text.length > 55) return 10;
        if (text.length > 38) return 12;
        return 14;
    }

    function lineupItemButton(item) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sc-lineup-item'
            + (item.isNowPlaying ? ' sc-lineup-item-current' : '')
            + (item.played ? ' sc-lineup-item-played' : '')
            + (item.clickable === false ? ' sc-lineup-item-static' : '');
        const titleText = `${item.cleanTitle}${item.cleanYear ? ` (${item.cleanYear})` : ''}`;
        const etaText = item.isNowPlaying ? 'NOW PLAYING' : (item.etaLabel || '');
        // Titles are shown IN the poster box only when there's no art to identify the
        // film by -- when real poster art is present, no title text is shown at all;
        // click still opens the Now-Playing card with the full title if needed.
        btn.innerHTML = `
            <div class="sc-lineup-poster" style="${item.poster ? `background-image:url(${item.poster})` : ''}">
                ${!item.poster ? `<div class="sc-lineup-poster-fallback" style="font-size:${lineupFallbackTitleFontSize(titleText)}px">${titleText}</div>` : ''}
                ${etaText ? `<div class="sc-lineup-eta">${etaText}</div>` : ''}
            </div>`;
        // Static fallback posters are display-only (item.clickable === false) -- they
        // have no real title/overview to show, so click does nothing for them.
        if (item.clickable !== false) {
            btn.addEventListener('click', () => showNowPlayingCard(item, { autoHide: false }));
        }
        return btn;
    }

    // One section's grouping. Named theme sections repeat every week (a slow-changing,
    // closed set), so each gets its own Google Font + accent color tying its header
    // and background together.
    function lineupSectionEl(section) {
        const el = document.createElement('div');
        el.className = 'sc-lineup-section';
        const theme = getSectionTheme(section.slug);
        el.style.setProperty('--sc-lineup-wash', theme.wash);
        if (section.name) {
            const name = document.createElement('div');
            name.className = 'sc-lineup-section-name';
            name.style.setProperty('color', theme.color, 'important');
            if (theme.font) name.style.setProperty('font-family', `${theme.font}, cursive`, 'important');
            name.textContent = section.name;
            el.appendChild(name);
        }
        const rail = document.createElement('div');
        rail.className = 'sc-lineup-rail';
        section.items.forEach(item => rail.appendChild(lineupItemButton(item)));
        el.appendChild(rail);
        return el;
    }

    function lineupRenderDayTabs(screen, days) {
        const tabs = screen.querySelector('#sc-lineup-daytabs');
        tabs.innerHTML = '';
        days.forEach((d) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sc-lineup-daytab' + (d.day === _lineupActiveDay ? ' sc-lineup-daytab-active' : '');
            // The label sits in its own stacked (z-index) span so it always paints above the
            // ticket-stub's ::before (tear-line/perforation) and ::after (paper-grain) pseudo-
            // elements -- those are position:absolute and would otherwise paint over plain text.
            btn.innerHTML = `<span class="sc-lineup-daytab-label">${d.day}</span>`;
            btn.addEventListener('click', () => lineupShowDay(screen, d.day));
            tabs.appendChild(btn);
        });
    }

    function lineupRenderBody(screen, days) {
        const body = screen.querySelector('#sc-lineup-body');
        body.innerHTML = '';
        const day = days.find(d => d.day === _lineupActiveDay) || days[0];
        if (!day || !day.sections.length) {
            body.innerHTML = '<div id="sc-lineup-loading">No lineup available right now.</div>';
            return;
        }
        day.sections.forEach((section) => body.appendChild(lineupSectionEl(section)));
    }

    function lineupShowDay(screen, day) {
        _lineupActiveDay = day;
        const tabs = [...screen.querySelectorAll('.sc-lineup-daytab')];
        tabs.forEach(t => t.classList.toggle('sc-lineup-daytab-active', t.textContent === day));
        lineupRenderBody(screen, _lineupLastData.days);
    }

    // Degraded view when Reddit is unreachable: the current title (if known) plus the
    // static Coming Attractions art, as one flat rail -- no tabs, no sections, since
    // there's no real day/section structure to show in this mode.
    function lineupRenderFallback(screen, data) {
        screen.querySelector('#sc-lineup-daytabs').innerHTML = '';
        const body = screen.querySelector('#sc-lineup-body');
        body.innerHTML = '';
        const items = (data.days && data.days[0] && data.days[0].sections[0] && data.days[0].sections[0].items) || [];
        if (!items.length) {
            body.innerHTML = '<div id="sc-lineup-loading">No lineup available right now.</div>';
            return;
        }
        const section = document.createElement('div');
        section.className = 'sc-lineup-section sc-lineup-section-fallback';
        const rail = document.createElement('div');
        rail.className = 'sc-lineup-rail';
        items.forEach(item => rail.appendChild(lineupItemButton(item)));
        section.appendChild(rail);
        body.appendChild(section);
    }

    function lineupRenderItems(screen, data) {
        const header = screen.querySelector('#sc-lineup-header');
        if (header) header.textContent = (data && data.listTitle) || 'Grindhouse Lineup';
        _lineupLastData = data;
        if (!data || data.fallback) { lineupRenderFallback(screen, data || { days: [] }); return; }
        const days = data.days || [];
        // Recomputed fresh on every open so a manual tab switch from a PRIOR open
        // doesn't linger -- opening the screen always starts back on today's day (or
        // the first day, before the weekend starts).
        _lineupActiveDay = (days.find(d => d.isToday) || days[0] || {}).day || null;
        lineupRenderDayTabs(screen, days);
        lineupRenderBody(screen, days);
    }

    function showLineupScreen() {
        const screen = lineupEnsureScreenDom();
        screen.classList.add('sc-lineup-visible');
        lineupRenderLoading(screen);
        getTonightsLineup()
            .then(data => lineupRenderItems(screen, data))
            .catch(() => { lineupRenderItems(screen, { fallback: true, days: [] }); });
    }

    function hideLineupScreen() {
        const screen = document.getElementById('sc-lineup-screen');
        if (screen) screen.classList.remove('sc-lineup-visible');
        _topBarIsOpen = false;
        const toggleBtn = document.getElementById('sc-poster-toggle');
        if (toggleBtn) toggleBtn.classList.remove('sc-poster-toggle-active');
    }

    /* ==========================================================
       COMING ATTRACTIONS — toggle button that opens the Tonight's Lineup
       screen above. (Top-bar/gap-button dim/wake infrastructure --
       initTopBar, initGapButtonDim, _topBarWake, _topBarIsOpen, _gapShow
       -- stays in 00-monolith.js/core: it's generic chrome-dimming shared
       by every floating button, not lineup-specific, and 08-desync.js
       reads _gapShow directly.)
    ========================================================== */

    function initPosterStrip() {
        if (document.getElementById('sc-poster-toggle')) return;

        // Toggle button — injected below the video title
        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'sc-poster-toggle';
        toggleBtn.textContent = "Coming Attractions";
        toggleBtn.title = 'Show/hide weekend lineup';
        toggleBtn.addEventListener('click', () => {
            const isOpen = document.getElementById('sc-lineup-screen')?.classList.contains('sc-lineup-visible');
            if (isOpen) {
                hideLineupScreen();
            } else {
                showLineupScreen();
                toggleBtn.classList.add('sc-poster-toggle-active');
                _topBarIsOpen = true;
                if (_topBarWake) _topBarWake();
            }
        });
        document.body.appendChild(toggleBtn);
    }

    // initPosterStrip() needs #motdrow to already have its images (CyTube injects
    // them asynchronously after the channel loads) -- wrapped in a named function and
    // registered via scRegisterInit (same pattern Task 2 used for
    // scApplyInitialChatFontSize: a named function so fn.name prints usefully from the
    // registry's try/catch). Moved here (out of 00-monolith.js's bare 'load' handler)
    // so a build without this module simply doesn't register or call initPosterStrip
    // at all, instead of leaving a dangling bare call in core that would throw and --
    // because it used to run before the CSS-injection block in that same handler --
    // take the whole layout CSS injection down with it.
    function scInitPosterStripWhenReady() {
        // Run immediately if #motdrow already has images, otherwise watch for it
        if (document.querySelector('#motdrow img')) {
            initPosterStrip();
        } else {
            const motdObserver = new MutationObserver(() => {
                if (document.querySelector('#motdrow img')) {
                    motdObserver.disconnect();
                    initPosterStrip();
                }
            });
            motdObserver.observe(document.body, { childList: true, subtree: true });
            // Hard fallback — if observer never fires, try once after 2s
            setTimeout(() => {
                if (!document.getElementById('sc-poster-toggle')) initPosterStrip();
            }, 2000);
        }
    }

    scRegisterInit(scInitPosterStripWhenReady);
