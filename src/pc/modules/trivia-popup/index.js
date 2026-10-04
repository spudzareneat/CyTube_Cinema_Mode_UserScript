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
