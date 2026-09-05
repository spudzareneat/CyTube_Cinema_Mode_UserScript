    /* ==========================================================
       OPENSUBTITLES API CLIENT — the REST client behind the Subtitles
       panel's in-panel search + one-click load, ported almost verbatim
       from the Android app (web/src/subtitles/opensubtitles.js). English
       only (languages=en is hardcoded — no language picker, per the
       brainstorming design note). Free OpenSubtitles keys allow just 5
       downloads/day, so the module leans hard on index.js's existing
       short-lived per-movie cache and the in-memory _osResultsMemo below
       to avoid spending that quota twice on the same movie.

       Owns everything OpenSubtitles-API-related: the LS_OPENSUBTITLES
       localStorage key constant, the raw GM_xmlhttpRequest wrapper, the
       settings-modal Test-button validator, and the bottom-of-file
       scRegisterSetting() row. No UI, DOM, player or <video> code —
       index.js (same bundle scope, after assembly) owns all of that and
       calls these functions. getKey/hasKey (core 02-keys-and-helpers.js)
       and scRegisterSetting (core 10-registry.js) are already in scope.

       Every network function is non-throwing by contract: any failure
       (no key, no match, non-2xx, bad JSON, transport error) resolves to
       a safe sentinel ([] or null), never an exception — index.js relies
       on that.
    ========================================================== */

    const LS_OPENSUBTITLES = 'sc_opensubtitles_key';
    const OS_API_BASE      = 'https://api.opensubtitles.com/api/v1';
    const OS_USER_AGENT    = 'GrindhouseTV v1.0';

    function osAuthHeaders(key) {
        return { 'Api-Key': key, 'User-Agent': OS_USER_AGENT, 'Content-Type': 'application/json' };
    }

    // Module-private wrapper over GM_xmlhttpRequest. Resolves the RAW
    // response object (callers read r.status / r.responseText directly).
    function osRequest({ method, url, headers, data }) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method,
                url,
                headers,
                data,
                timeout: 15000,
                onload: r => resolve(r),
                onerror: () => reject(new Error('network error')),
                ontimeout: () => reject(new Error('timeout')),
            });
        });
    }

    // Test-button validator (settings row below), same contract as
    // validateTmdbKey: resolves 'valid' | 'invalid' | 'error'.
    //
    // OpenSubtitles has no cheap key-check endpoint: /infos/user needs a
    // full login token (not just an Api-Key), and /subtitles search
    // ignores the Api-Key entirely. What works (confirmed live against the
    // real API in the Android port): POST /download with a deliberately
    // invalid file_id. OpenSubtitles checks the Api-Key before it looks at
    // file_id, and its failure mode for a bad/missing key on this endpoint
    // is (oddly) a generic 503 rather than 401/403. A real key sails past
    // that check and gets a 4xx on the bogus file_id itself — it never
    // resolves to a real signed link, so no quota is spent.
    async function validateOpensubtitlesKey(key) {
        if (!key) return 'invalid';
        try {
            const r = await osRequest({
                method: 'POST',
                url: `${OS_API_BASE}/download`,
                headers: osAuthHeaders(key),
                data: JSON.stringify({ file_id: 0 }),
            });
            if (r.status === 503) return 'invalid';
            if (r.status >= 400 && r.status < 500) return 'valid'; // rejected the bogus file_id, not the key
            return 'error';
        } catch (e) {
            return 'error';
        }
    }

    // Searches English subtitles for a resolved IMDb id ("tt1234567" or a
    // bare number — the v1 API wants the numeric id). Never throws: no
    // key, no imdbId, a network error or a bad response all resolve to []
    // so index.js can show a plain empty-state. Sorted by download count
    // (a decent "most likely a good release" proxy) and capped to a
    // manageable picker list.
    async function osSearchSubtitles(imdbId) {
        if (!imdbId || !hasKey(LS_OPENSUBTITLES)) return [];
        const numericId = String(imdbId).replace(/^tt/i, '');
        try {
            const r = await osRequest({
                method: 'GET',
                url: `${OS_API_BASE}/subtitles?imdb_id=${encodeURIComponent(numericId)}&languages=en`,
                headers: osAuthHeaders(getKey(LS_OPENSUBTITLES)),
            });
            if (r.status !== 200) return [];
            const data = JSON.parse(r.responseText);
            return (data.data || [])
                .map((entry) => {
                    const a = entry.attributes || {};
                    const file = (a.files || [])[0];
                    if (!file || !file.file_id) return null;
                    return {
                        fileId: file.file_id,
                        release: a.release || 'Unknown release',
                        uploader: (a.uploader && a.uploader.name) || 'Unknown',
                        downloadCount: a.download_count || 0,
                        fromTrusted: !!a.from_trusted,
                        hearingImpaired: !!a.hearing_impaired,
                        machineTranslated: !!(a.machine_translated || a.ai_translated),
                    };
                })
                .filter(Boolean)
                .sort((a, b) => b.downloadCount - a.downloadCount)
                .slice(0, 8);
        } catch (e) {
            return [];
        }
    }

    // Exchanges a file_id for a temporary signed download link. Resolves
    // null on any failure (bad/missing key, daily quota exhausted, network
    // error). `remaining` is OpenSubtitles' daily-quota counter from the
    // /download response body — index.js surfaces it as a "N downloads
    // left today" note; null when the response carries no numeric value.
    async function osDownloadSubtitle(fileId) {
        if (!fileId || !hasKey(LS_OPENSUBTITLES)) return null;
        try {
            const r = await osRequest({
                method: 'POST',
                url: `${OS_API_BASE}/download`,
                headers: osAuthHeaders(getKey(LS_OPENSUBTITLES)),
                data: JSON.stringify({ file_id: fileId }),
            });
            if (r.status !== 200) return null;
            const data = JSON.parse(r.responseText);
            if (!data.link) return null;
            return {
                link: data.link,
                remaining: (typeof data.remaining === 'number' ? data.remaining : null),
            };
        } catch (e) {
            return null;
        }
    }

    // Plain GET of the signed link OpenSubtitles handed back — no API key
    // and NO headers here, the signed link itself is the credential (and
    // it expires). Adding Api-Key/User-Agent/Content-Type can break the
    // signed request. Resolves the raw SRT text, or null on any failure.
    async function osFetchSrtText(link) {
        if (!link) return null;
        try {
            const r = await osRequest({ method: 'GET', url: link });
            return r.status === 200 ? r.responseText : null;
        } catch (e) {
            return null;
        }
    }

    // In-memory only (NOT localStorage): the last IMDb id searched and its
    // result list, so re-opening the panel for the same movie doesn't
    // re-hit the API. Declared here; index.js (Task 2, same bundle scope)
    // reads and writes it, the same way the rest of this module shares
    // state across its concatenated files.
    let _osResultsMemo = { imdbId: null, list: null };

    // order: 8 — places this after every existing settings row
    // (tmdb=0 … movie-lead-time=7). type:'text' rows with a testHandler
    // are already fully handled by core/15-settings-modal-shell.js
    // (textRowHtml / wireTextRowTestButton / Save handler) — nothing to
    // add there.
    scRegisterSetting({
        id: 'sc-input-opensubtitles', group: 'subtitles', type: 'text',
        label: 'OpenSubtitles API key',
        note: 'Optional — search & load real subtitles for the movie playing now, right in the Subtitles panel (needs an IMDb match). Free keys allow 5 downloads/day. Without a key the panel keeps its external OpenSubtitles search link.',
        key: LS_OPENSUBTITLES,
        placeholder: 'Paste OpenSubtitles API key…',
        testHandler: validateOpensubtitlesKey,
        testEmptyMessage: 'Enter a key first',
        testValidMessage: '✓ Valid key',
        testInvalidMessage: '✗ Invalid key',
        testErrorMessage: '⚠ Couldn’t reach API',
        link: 'https://www.opensubtitles.com/en/consumers',
        linkText: 'Get a free OpenSubtitles API key ↗',
        order: 8,
    });
