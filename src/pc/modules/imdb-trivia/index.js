    /* ==========================================================
       IMDb TRIVIA
       Owns only the trivia panel feature: the GraphQL query
       (fetchImdbTrivia), its floating UI (showTriviaCard /
       hideTriviaCard / toggleTriviaPanel), CSS, and the 'T' hotkey.
       The primary title lookup (fetchImdbMovieByTitle) and the
       parental guide (fetchImdbParentalGuide) live in
       movie-title-links, which this module hard-depends on
       (`dependsOn: ["core", "movie-title-links"]` in manifest.json) --
       trivia inherently needs a movie to already be identified, so
       forcing that dependency is honest rather than incidental. This
       module builds on top of movie-title-links' imdbQuery()/
       imdbGmFetch(), which it does not redeclare.

       No user-facing on/off toggle exists for this feature in the
       original script; it simply runs whenever an IMDb ID is
       available, so this module registers no scRegisterSetting row
       (it's still excludable from a custom build via the customizer's
       module checkboxes — a separate mechanism from an in-script
       settings toggle).
    ========================================================== */

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

    /* ==========================================================
       TRIVIA CARD
    ========================================================== */

    function _escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    let _triviaOutsideClick = null;

    function showTriviaCard() {
        if (!_currentImdbId) return;
        hideTriviaCard(); // clears any existing panel + listener
        const panel = document.createElement('div');
        panel.id = 'sc-trivia-panel';
        panel.innerHTML = `
            <div id="sc-trivia-head">
                <span id="sc-trivia-title">${_escHtml(_npData && _npData.cleanTitle ? _npData.cleanTitle + ' — Trivia' : 'Trivia')}</span>
                <button id="sc-trivia-close" type="button">✕</button>
            </div>
            <div id="sc-trivia-list"><div class="sc-trivia-item">Loading…</div></div>`;
        document.body.appendChild(panel);
        panel.querySelector('#sc-trivia-close').addEventListener('click', hideTriviaCard);

        _triviaOutsideClick = (e) => {
            const btn = document.getElementById('sc-trivia-btn');
            if (!panel.contains(e.target) && e.target !== btn) hideTriviaCard();
        };
        setTimeout(() => document.addEventListener('click', _triviaOutsideClick, true), 0);

        fetchImdbTrivia(_currentImdbId).then(items => {
            const list = panel.querySelector('#sc-trivia-list');
            if (!list) return;
            if (!items || !items.length) { list.innerHTML = '<div class="sc-trivia-item">No trivia found.</div>'; return; }
            list.innerHTML = items.map(t => `<div class="sc-trivia-item">${_escHtml(t)}</div>`).join('');
            list.scrollTop = 0;
        });
    }

    function hideTriviaCard() {
        const p = document.getElementById('sc-trivia-panel');
        if (p) p.remove();
        if (_triviaOutsideClick) {
            document.removeEventListener('click', _triviaOutsideClick, true);
            _triviaOutsideClick = null;
        }
    }

    function toggleTriviaPanel() {
        if (document.getElementById('sc-trivia-panel')) hideTriviaCard();
        else showTriviaCard();
    }

    // 'T' = trivia, from anywhere when not typing. Split out from the original
    // combined T/I/Escape/arrows keydown handler so this module's hotkey only
    // depends on functions this module itself defines — see
    // movie-title-links/index.js for the 'I' half of that original handler,
    // and src/pc/core/12-playback-sync-and-seek.js for the Escape (lineup) /
    // arrows / space half.
    document.addEventListener('keydown', (e) => {
        const t = e.target;
        if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
        if (e.key === 't' || e.key === 'T') { toggleTriviaPanel(); return; }
        if (e.key === 'Escape') { hideTriviaCard(); return; }
    });
