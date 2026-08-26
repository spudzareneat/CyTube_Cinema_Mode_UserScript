    /* ==========================================================
       LAST AIRED — optional module that surfaces "when did this last
       play on the channel?" next to the IMDb rating/parental-guide
       info movie-title-links already renders.

       Source of truth is the host's public Google Sheet (no auth
       needed, published as CSV):
       https://docs.google.com/spreadsheets/d/1B1iL2tX7BC-RnABPnR2G8k0KsrTFyY_WBsF9PFW37Do/export?format=csv&gid=0
       Rows are `Movie Title & Year, Last Played (M/D/YY), Movie Block`
       (~1470 rows). A handful of titles have more than one row (played
       more than once) -- "last aired" is whichever date is
       chronologically latest for that title, no past/future filtering.

       The whole sheet is fetched once at script init (scRegisterInit),
       parsed into an in-memory Map, and cached in localStorage for 6h
       (same shape as movieLinkCache/LS_MOVIE_CACHE in
       movie-title-links/index.js, just one blob for the whole sheet
       instead of per-title entries). scGetLastAired() is a synchronous
       lookup against that map -- deliberately not async, since both
       call sites in movie-title-links/index.js are themselves
       synchronous callbacks that fire well after this module's much
       smaller fetch has had time to resolve. A miss (map not loaded
       yet, or no matching title) silently returns null; the call
       sites just skip rendering the line, no placeholder/error.
    ========================================================== */

    const LAST_AIRED_CSV_URL = 'https://docs.google.com/spreadsheets/d/1B1iL2tX7BC-RnABPnR2G8k0KsrTFyY_WBsF9PFW37Do/export?format=csv&gid=0';
    const LS_LAST_AIRED_CACHE = 'sc_last_aired_cache_v1';
    const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

    // In-memory Map<normalizedKey, { dateStr, block }>. null until the first
    // load (cache or fetch) completes -- scGetLastAired treats that as a miss.
    let lastAiredMap = null;

    // Trim/lowercase/collapse-whitespace, used identically when building the
    // map (from the sheet's "Title (Year)" cell) and when looking it up (from
    // the caller's separate title/year), so matching is resilient to minor
    // casing/spacing differences between the two sources.
    function normalizeKey(title, year) {
        const t = String(title || '').trim().toLowerCase().replace(/\s+/g, ' ');
        const y = year ? String(year).trim() : '';
        return y ? `${t} (${y})` : t;
    }

    // Quote-aware CSV line splitter -- some sheet titles contain commas
    // (e.g. "Silent Night, Deadly Night" style entries), which a plain
    // .split(',') would break apart. Handles "" as an escaped quote inside a
    // quoted field. Assumes one row per line (the sheet has no embedded
    // newlines inside fields).
    function parseCsvLine(line) {
        const fields = [];
        let field = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (inQuotes) {
                if (c === '"') {
                    if (line[i + 1] === '"') { field += '"'; i++; }
                    else { inQuotes = false; }
                } else {
                    field += c;
                }
            } else if (c === '"') {
                inQuotes = true;
            } else if (c === ',') {
                fields.push(field);
                field = '';
            } else {
                field += c;
            }
        }
        fields.push(field);
        return fields;
    }

    // Sheet dates are M/D/YY (e.g. "1/30/26") -- two-digit year assumed to be
    // 20xx, which holds for every row in this sheet. Returns null on anything
    // that doesn't match instead of throwing, so a malformed row is just
    // skipped rather than corrupting the whole parse.
    function parseSheetDate(str) {
        const m = String(str || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
        if (!m) return null;
        const month = parseInt(m[1], 10);
        const day = parseInt(m[2], 10);
        const year = 2000 + parseInt(m[3], 10);
        const date = new Date(year, month - 1, day);
        return isNaN(date.getTime()) ? null : date;
    }

    function formatLastAiredDate(date) {
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    // Parses the full CSV text into a Map<normalizedKey, { dateStr, block }>.
    // When a title has more than one row, keeps whichever row's date is
    // chronologically latest.
    function buildLastAiredMap(csvText) {
        const map = new Map();
        const lines = String(csvText || '').split(/\r\n|\n/);
        for (let i = 1; i < lines.length; i++) { // skip header row
            const line = lines[i];
            if (!line || !line.trim()) continue;
            const cols = parseCsvLine(line);
            const rawTitleYear = (cols[0] || '').trim();
            if (!rawTitleYear) continue;
            const date = parseSheetDate(cols[1]);
            if (!date) continue;
            const block = (cols[2] || '').trim() || null;

            // Sheet's first column is already "Title (Year)" -- split it so
            // normalizeKey() runs on the same (title, year) shape here as it
            // does at lookup time in scGetLastAired().
            const m = rawTitleYear.match(/^(.*)\s\((\d{4})\)\s*$/);
            const title = m ? m[1].trim() : rawTitleYear;
            const year = m ? m[2] : '';
            const key = normalizeKey(title, year);

            const existing = map.get(key);
            if (!existing || date.getTime() > existing._ts) {
                map.set(key, { dateStr: formatLastAiredDate(date), block, _ts: date.getTime() });
            }
        }
        // Strip the internal _ts comparison field -- consumers only need
        // { dateStr, block }.
        for (const [key, val] of map) map.set(key, { dateStr: val.dateStr, block: val.block });
        return map;
    }

    // On cache hit (fresh, <6h old), uses the persisted map with no network
    // call. On miss/stale, serves the stale map immediately (if any) while
    // fetching a fresh copy in the background, so a temporary fetch failure
    // doesn't wipe out otherwise-usable data.
    async function loadLastAiredSheet() {
        let isFresh = false;
        try {
            const cached = localStorage.getItem(LS_LAST_AIRED_CACHE);
            if (cached) {
                const parsed = JSON.parse(cached);
                if (parsed && parsed.map) {
                    lastAiredMap = new Map(Object.entries(parsed.map));
                    isFresh = !!parsed.ts && (Date.now() - parsed.ts) < CACHE_TTL_MS;
                }
            }
        } catch (e) {}

        if (isFresh) return;

        try {
            const csvText = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: LAST_AIRED_CSV_URL,
                    onload: r => (r.status >= 200 && r.status < 300) ? resolve(r.responseText) : reject(new Error(`HTTP ${r.status}`)),
                    onerror: reject,
                });
            });
            lastAiredMap = buildLastAiredMap(csvText);
            try {
                localStorage.setItem(LS_LAST_AIRED_CACHE, JSON.stringify({
                    ts: Date.now(),
                    map: Object.fromEntries(lastAiredMap),
                }));
            } catch (e) {}
        } catch (e) {
            console.warn('[CyTube SC] Last Aired sheet failed to load:', e);
            // lastAiredMap keeps whatever the stale-cache read above set (or
            // stays null if there wasn't one) -- no rethrow, this is a
            // background init call with nothing awaiting it.
        }
    }

    // Synchronous lookup -- called from movie-title-links/index.js's
    // lookupMovie().then() callback and showNowPlayingCard(), neither of
    // which is async. Returns null (not a rejected/pending promise) when the
    // sheet hasn't loaded yet or the title has no match, so callers can just
    // skip rendering rather than handling a miss specially.
    function scGetLastAired(title, year) {
        if (!lastAiredMap) return null;
        return lastAiredMap.get(normalizeKey(title, year)) || null;
    }

    scRegisterInit(loadLastAiredSheet);
