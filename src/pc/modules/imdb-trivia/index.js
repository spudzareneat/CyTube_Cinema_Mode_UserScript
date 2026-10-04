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

    /* ==========================================================
       TRIVIA CARD
    ========================================================== */

    // _episodeTag lives in movie-title-links/index.js (this module hard-depends
    // on it, so it's always present in any build that includes this file) --
    // reused here so the trivia panel's header makes clear which episode the
    // (now episode-specific) trivia below actually belongs to.
    function _triviaHeaderTitle() {
        if (!_npData || !_npData.cleanTitle) return 'Trivia';
        const epTag = _episodeTag(_npData.season, _npData.episode);
        const epPart = epTag ? ` · ${epTag}` : '';
        const namePart = _npData.episodeName ? ` — ${_npData.episodeName}` : '';
        return `${_npData.cleanTitle}${epPart}${namePart} — Trivia`;
    }

    let _triviaOutsideClick = null;

    function showTriviaCard() {
        if (!_currentImdbId) return;
        hideTriviaCard(); // clears any existing panel + listener
        const panel = document.createElement('div');
        panel.id = 'sc-trivia-panel';
        panel.innerHTML = `
            <div id="sc-trivia-head">
                <span id="sc-trivia-title">${_escHtml(_triviaHeaderTitle())}</span>
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

        // Curated Pop-up Video facts (trivia-popup module, optional in a custom
        // build -- hence the typeof guard) go above IMDb's own trivia. Same
        // cached fetch the bubbles use, so opening the panel costs nothing extra.
        const curatedP = typeof fetchCuratedTrivia === 'function'
            ? fetchCuratedTrivia(_currentImdbId).catch(() => null)
            : Promise.resolve(null);
        Promise.all([curatedP, fetchImdbTrivia(_currentImdbId)]).then(([curated, items]) => {
            const list = panel.querySelector('#sc-trivia-list');
            if (!list) return;
            let html = '';
            if (curated && curated.length) {
                html += `<div class="sc-trivia-section">Pop-up Video trivia (${curated.length})</div>`
                    + curated.map(_triviaCuratedItemHtml).join('');
            }
            if (items && items.length) {
                if (html) html += `<div class="sc-trivia-section">IMDb trivia (${items.length})</div>`;
                html += items.map(t => `<div class="sc-trivia-item">${_escHtml(t)}</div>`).join('');
            }
            list.innerHTML = html || '<div class="sc-trivia-item">No trivia found.</div>';
            list.querySelectorAll('img.sc-trivia-face').forEach(img => img.addEventListener('error', () => img.remove()));
            list.scrollTop = 0;
        });
    }

    function _triviaFmtTime(sec) {
        const s = Math.max(0, Math.round(sec));
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, '0');
        return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
    }

    // image / sourceUrl were already allowlisted by trivia-popup's
    // tpValidateCurated (IMDb CDN only / plain http(s) with no quotes or
    // brackets); quotes are escaped here as well for the attributes.
    function _triviaCuratedItemHtml(f) {
        const attr = s => _escHtml(s).replace(/"/g, '&quot;');
        const face = f.image ? `<img class="sc-trivia-face" src="${attr(f.image)}" alt="">` : '';
        const by = f.byline ? ` <span class="sc-trivia-by">— ${_escHtml(f.byline)}</span>` : '';
        const src = f.sourceUrl ? ` <a class="sc-trivia-src" href="${attr(f.sourceUrl)}" target="_blank" rel="noopener noreferrer">source</a>` : '';
        return `<div class="sc-trivia-item sc-trivia-curated"><span class="sc-trivia-time">${_triviaFmtTime(f.t)}</span>${face}${_escHtml(f.text)}${by}${src}</div>`;
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
