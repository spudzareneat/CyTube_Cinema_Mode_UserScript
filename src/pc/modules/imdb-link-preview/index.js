    /* ==========================================================
       IMDB LINK PREVIEW — a floating hover-preview card for IMDb
       title links posted in chat (e.g. https://www.imdb.com/title/
       tt0259308/). Hovering one shows a small poster/title/rating/
       overview card, without leaving chat or opening a new tab.

       Detection/scanning mirrors link-pip's findQualifyingLinks/
       scanPipLinks/startPipObserver (src/pc/modules/link-pip/index.js):
       a MutationObserver on #messagebuffer, idempotent via the same
       dataset-marking convention so a link already scanned is never
       reprocessed.

       Hover-card mechanics mirror emote-picker's GIF hover preview
       (ensureEmotePreviewEl/positionEmotePreview/showEmotePreview/
       hideEmotePreview/wireEmotePreviewDelegation in
       src/pc/modules/emote-picker/index.js): a single lazily-created
       DOM node reused for every hover, delegated mouseover/mouseout
       (mouseenter/mouseleave don't bubble, so can't be delegated the
       same way), and a fade-in on the poster <img>'s own load/error
       event so a stale previous poster never flashes before the new
       one is ready.

       Data comes from fetchImdbTitleFields(tconst), already defined in
       src/pc/modules/movie-title-links/index.js -- called directly, no
       typeof-guard needed, since all modules concatenate into one
       top-level scope at build time (see scripts/assemble.mjs) and this
       module hard-depends on movie-title-links (manifest.json,
       dependsOn). Only titleText/releaseYear/rating/overview/poster are
       used here (explicit user choice -- no runtime/genres/parental-
       guide on this card, unlike the Now Playing card).

       getKey is core's (02-keys-and-helpers.js) -- this module doesn't
       redeclare it.
    ========================================================== */
    const LS_IMDB_CARD_ENABLED = 'sc_imdb_card_enabled';

    const imdbCardEnabled = () => getKey(LS_IMDB_CARD_ENABLED) !== 'off';

    /* ==========================================================
       LINK CLASSIFICATION — IMDb only has one URL shape worth
       matching (a /title/tt.../ page), so unlike link-pip's
       extractYouTubeId this needs no URL-parsing branches, just one
       regex. Exported to module scope (not nested) so
       scripts/test-imdb-link-preview.mjs can slice it out and eval it
       directly, same convention as movie-title-links' _fixMatchDetectTconst
       (see scripts/test-fix-match-helpers.mjs).
    ========================================================== */
    // ── test marker: extract-tconst slice start ──
    function extractImdbTconst(url) {
        if (!url) return null;
        // (?:www\.|m\.)? -- www. is the desktop site, m. is IMDb's own mobile
        // subdomain (what a phone browser's share sheet actually copies).
        const m = String(url).match(/^https?:\/\/(?:www\.|m\.)?imdb\.com\/title\/(tt\d{6,})/);
        return m ? m[1] : null;
    }
    // ── test marker: extract-tconst slice end ──

    /* ==========================================================
       SCANNING
       Mirrors link-pip's findQualifyingLinks/scanPipLinks -- its own
       MutationObserver on #messagebuffer, idempotent via a dataset
       marker so re-scans from later mutations don't reprocess a link.
       Every scanned link is marked scImdbChecked = '1' whether or not
       it turned out to be an IMDb title link, so it's never re-tested;
       only ones that DID resolve to a tconst additionally get
       scImdbTconst set, which is what the hover delegation below
       matches against.
    ========================================================== */
    function scanImdbLinks(buf) {
        if (!imdbCardEnabled()) return;
        buf.querySelectorAll('[class*="chat-msg-"]').forEach(msgEl => {
            msgEl.querySelectorAll('a[href]').forEach(a => {
                if (a.dataset.scImdbChecked) return;
                a.dataset.scImdbChecked = '1';
                const tconst = extractImdbTconst(a.href);
                if (tconst) a.dataset.scImdbTconst = tconst;
            });
        });
    }

    /* ==========================================================
       DATA FETCH — wraps fetchImdbTitleFields(tconst) (movie-title-
       links/index.js) with an in-memory cache (repeat hovers on the
       same title in a session don't re-hit the network) plus a
       failure-memoization Set, same pattern as emote-cache's
       _scEmoteCacheFailed (src/pc/modules/emote-cache/index.js) -- a
       dead/malformed tconst isn't retried on every subsequent hover.
       Only failure OR "no usable title at all" gets memoized as a
       failure; a result with no poster and/or no overview still
       resolves normally and is cached/shown with whatever fields it
       has (never treated as a failure).
    ========================================================== */
    const _scImdbCardCache = new Map();   // tconst -> resolved { titleText, releaseYear, rating, overview, poster }
    const _scImdbCardFailed = new Set();  // tconst that failed to fetch or had no usable title -- never retried this session

    async function getImdbCardData(tconst) {
        if (!tconst) return null;
        if (_scImdbCardCache.has(tconst)) return _scImdbCardCache.get(tconst);
        if (_scImdbCardFailed.has(tconst)) return null;
        const fields = await fetchImdbTitleFields(tconst);
        if (!fields || !fields.titleText) { _scImdbCardFailed.add(tconst); return null; }
        const data = {
            titleText:   fields.titleText,
            releaseYear: fields.releaseYear,
            rating:      fields.rating,
            overview:    fields.overview,
            poster:      fields.poster,
        };
        _scImdbCardCache.set(tconst, data);
        return data;
    }

    /* ==========================================================
       CARD RENDERING — one lazily-created #sc-imdb-card div appended
       to <body>, created once and reused for every hover (never
       re-created), same "single reused DOM node, wired once"
       convention as ensureEmotePreviewEl(). Its poster <img>'s load/
       error events toggle sc-imdb-card-loaded (identical trick to the
       emote preview's onDone) so a stale previous poster never flashes
       before the new one decodes. Text fields render as soon as the
       fetch resolves -- they don't wait on the image load event.
    ========================================================== */
    function ensureImdbCardEl() {
        let card = document.getElementById('sc-imdb-card');
        if (card) return card;
        card = document.createElement('div');
        card.id = 'sc-imdb-card';
        card.innerHTML =
            '<span class="sc-imdb-card-spinner" aria-hidden="true"></span>' +
            '<img class="sc-imdb-card-poster" alt="">' +
            '<div class="sc-imdb-card-body">' +
                '<div class="sc-imdb-card-title"></div>' +
                '<div class="sc-imdb-card-rating"></div>' +
                '<div class="sc-imdb-card-overview"></div>' +
            '</div>';
        const img = card.querySelector('.sc-imdb-card-poster');
        // Unlike emote-picker's fixed 176x176 preview image, the poster here
        // has no fixed height (style.css: width:100%, max-height:260px only)
        // -- at the instant positionImdbCard() first runs in showImdbCard(),
        // the just-assigned <img src> hasn't decoded yet, so the card
        // measures short and can get positioned near the bottom of the
        // viewport, then visibly jump ~270px taller once the poster loads
        // with nothing left to reposition it. So reposition again here, once
        // the image (or its error) actually settles -- but only against
        // whichever link is CURRENTLY hovered (_scImdbHoverLink), since the
        // load event can fire well after the mouse has moved to a different
        // link or off the card entirely.
        const onDone = () => {
            card.classList.add('sc-imdb-card-loaded');
            if (_scImdbHoverLink) positionImdbCard(card, _scImdbHoverLink);
        };
        img.addEventListener('load', onDone);
        img.addEventListener('error', onDone);
        document.body.appendChild(card);
        return card;
    }

    // Blanks the card back to its loading state (spinner visible, no
    // stale text/poster from whichever title was hovered previously) --
    // called the instant a new hover's intent timer fires, before the
    // network fetch even starts.
    function resetImdbCardLoading(card) {
        card.classList.remove('sc-imdb-card-loaded');
        const img = card.querySelector('.sc-imdb-card-poster');
        img.removeAttribute('src');
        img.style.display = '';
        card.querySelector('.sc-imdb-card-title').textContent = '';
        const ratingEl = card.querySelector('.sc-imdb-card-rating');
        ratingEl.textContent = '';
        ratingEl.style.display = 'none';
        card.querySelector('.sc-imdb-card-overview').textContent = '';
    }

    // Fills in the card once getImdbCardData() resolves. A missing
    // poster/overview/rating is simply omitted -- see getImdbCardData's
    // "never treat a partial result as a failure" contract above.
    function renderImdbCardData(card, data) {
        const img = card.querySelector('.sc-imdb-card-poster');
        if (data.poster) {
            if (img.src !== data.poster) {
                card.classList.remove('sc-imdb-card-loaded'); // re-fade-in for a genuinely new image
                img.src = data.poster;
            }
            img.style.display = '';
        } else {
            img.removeAttribute('src');
            // .sc-imdb-card-poster's `display: block` in style.css is
            // !important (every rule in this stylesheet is, to survive
            // CyTube's own sheets) -- a plain img.style.display = 'none'
            // assignment loses to it and silently has no effect, so this
            // needs the same setProperty(..., 'important') technique used
            // for the card's own show/hide and positioning below.
            img.style.setProperty('display', 'none', 'important');
            card.classList.add('sc-imdb-card-loaded'); // nothing to wait on -- don't leave the spinner spinning forever
        }
        const yearPart = data.releaseYear ? ` (${data.releaseYear})` : '';
        card.querySelector('.sc-imdb-card-title').textContent = (data.titleText || '') + yearPart;
        const ratingEl = card.querySelector('.sc-imdb-card-rating');
        if (data.rating) {
            ratingEl.textContent = `⭐ ${data.rating}`;
            ratingEl.style.display = '';
        } else {
            ratingEl.textContent = '';
            ratingEl.style.display = 'none';
        }
        card.querySelector('.sc-imdb-card-overview').textContent = data.overview || '';
    }

    // Anchored below the hovered <a> if there's room, otherwise above it;
    // clamped horizontally/vertically to stay fully on-screen -- same
    // clamping shape as positionEmotePreview.
    function positionImdbCard(card, linkEl) {
        const linkRect = linkEl.getBoundingClientRect();
        const cw = card.offsetWidth, ch = card.offsetHeight;
        const gap = 8;
        let top = linkRect.bottom + gap;
        if (top + ch > window.innerHeight) top = linkRect.top - gap - ch;
        top = Math.max(4, Math.min(top, window.innerHeight - ch - 4));
        let left = linkRect.left;
        left = Math.max(4, Math.min(left, window.innerWidth - cw - 4));
        card.style.setProperty('left', left + 'px', 'important');
        card.style.setProperty('top', top + 'px', 'important');
    }

    function hideImdbCard() {
        const card = document.getElementById('sc-imdb-card');
        if (card) card.style.setProperty('display', 'none', 'important');
    }

    // Shows (or updates) the card for a hovered link once the hover-
    // intent delay has elapsed. Re-checks _scImdbHoverLink after the
    // await -- the mouse may have already left this link (or moved to
    // another one) by the time the fetch resolves, and this must never
    // clobber whatever's now actually being hovered.
    async function showImdbCard(a) {
        const tconst = a.dataset.scImdbTconst;
        if (!tconst) return;
        const card = ensureImdbCardEl();

        // Cache hit -- this tconst was already resolved earlier this
        // session, so render straight from the cached data with no spinner/
        // fade reset at all (mirrors emote-picker's "re-entering the same
        // still-cached tile shouldn't re-hide an already-loaded preview").
        // Read the Map directly rather than going through getImdbCardData()
        // (an async function) so this branch never awaits anything.
        if (_scImdbCardCache.has(tconst)) {
            renderImdbCardData(card, _scImdbCardCache.get(tconst));
            card.style.setProperty('display', 'block', 'important');
            positionImdbCard(card, a);
            return;
        }

        resetImdbCardLoading(card);
        card.style.setProperty('display', 'block', 'important');
        positionImdbCard(card, a);
        const data = await getImdbCardData(tconst);
        if (_scImdbHoverLink !== a) return; // moved on while the fetch was in flight
        if (!data) { hideImdbCard(); return; }
        renderImdbCardData(card, data);
        positionImdbCard(card, a); // re-clamp now that content size may have changed
    }

    /* ==========================================================
       HOVER DELEGATION — delegated mouseover/mouseout on
       #messagebuffer (bubbling works there same as emote picker's
       delegation on body). _scImdbHoverLink tracks the currently-
       hovered link so re-entering the same link's own descendants
       doesn't redundantly re-show/reposition. A 200ms hover-intent
       delay (_scImdbHoverTimer) avoids firing a fetch for every link
       the mouse merely passes over while scrolling chat -- started on
       mouseover, cleared on mouseout if it hasn't fired yet.
    ========================================================== */
    let _scImdbHoverLink = null;
    let _scImdbHoverTimer = null;

    // Full reset shared by every hide trigger (mouseout-leaves-link, Escape,
    // #messagebuffer scroll) -- not just hideImdbCard() alone. Clearing
    // _scImdbHoverLink/_scImdbHoverTimer here, not just hiding the card
    // element, matters for two reasons: (1) a still-pending hover-intent
    // timer must be cancelled, or it fires 200ms later and re-shows the
    // card for a link the pointer is no longer over; (2) leaving
    // _scImdbHoverLink pointing at the old link would make the mouseover
    // dedup guard (`a === _scImdbHoverLink`) silently no-op on a genuine
    // re-hover of that same link, leaving the card stuck hidden.
    function resetImdbHover() {
        _scImdbHoverLink = null;
        if (_scImdbHoverTimer) { clearTimeout(_scImdbHoverTimer); _scImdbHoverTimer = null; }
        hideImdbCard();
    }

    function wireImdbHoverDelegation(buf) {
        buf.addEventListener('mouseover', (e) => {
            if (!imdbCardEnabled()) return;
            const a = e.target.closest('a[data-sc-imdb-tconst]');
            if (!a || a === _scImdbHoverLink) return;
            _scImdbHoverLink = a;
            if (_scImdbHoverTimer) clearTimeout(_scImdbHoverTimer);
            _scImdbHoverTimer = setTimeout(() => {
                _scImdbHoverTimer = null;
                // showImdbCard is async; nothing in this codebase currently
                // rejects out of it (fetchImdbTitleFields catches
                // internally), but that's an invisible coupling -- a future
                // change upstream could otherwise turn this into an
                // unhandled promise rejection in the page console.
                if (_scImdbHoverLink === a) showImdbCard(a).catch(() => {});
            }, 200);
        });
        buf.addEventListener('mouseout', (e) => {
            const a = e.target.closest('a[data-sc-imdb-tconst]');
            if (!a || a !== _scImdbHoverLink) return;
            if (a.contains(e.relatedTarget)) return; // still inside the same link
            resetImdbHover();
        });
    }

    // Escape hides the card from anywhere on the page, same as the
    // Now Playing card / trivia panel's own document-level Escape
    // handlers elsewhere in this codebase.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        resetImdbHover();
    });

    /* ==========================================================
       BOOT — mirrors link-pip's startPipObserver/linkPipBoot: called
       directly at module load (not scRegisterInit) via a
       requestAnimationFrame retry, so the observer is attached before
       the message backlog finishes painting. Also wires the hover
       delegation and a defensive scroll listener here, once #messagebuffer
       is known to exist -- chat auto-scrolls messages under a
       stationary cursor, which can silently strand the card next to a
       link the cursor no longer actually covers.
    ========================================================== */
    let _imdbObserverStarted = false;
    function startImdbObserver() {
        const buf = document.getElementById('messagebuffer');
        if (!buf) { requestAnimationFrame(startImdbObserver); return; }
        if (_imdbObserverStarted) return;
        _imdbObserverStarted = true;
        new MutationObserver(() => scanImdbLinks(buf)).observe(buf, { childList: true, subtree: true });
        scanImdbLinks(buf);
        wireImdbHoverDelegation(buf);
        // resetImdbHover(), not just hideImdbCard() -- see that function's
        // comment: a pending hover-intent timer or a stale _scImdbHoverLink
        // left behind here would either re-show the card 200ms after the
        // scroll (once the intent timer fires anyway) or leave the card
        // stuck hidden on the next hover of the same link.
        buf.addEventListener('scroll', resetImdbHover);
    }

    function imdbLinkPreviewBoot() {
        if (!document.body) { requestAnimationFrame(imdbLinkPreviewBoot); return; }
        startImdbObserver();
    }
    imdbLinkPreviewBoot();

    // order: 12 -- 9/10 are trivia-popup's own toggle+frequency pair, 11 is
    // subtitles'; keeping this row clear of both avoids ever splitting
    // trivia-popup's pair apart if manifest module emission order changes.
    scRegisterSetting({ id: 'sc-input-imdblinkpreview', group: 'imdb-link-preview', label: 'IMDb hover-preview cards for chat links', note: 'Hovering an imdb.com/title/ link posted in chat shows a floating poster/title/rating/description card.', key: LS_IMDB_CARD_ENABLED, defaultOn: true, order: 12 });
