    /* ==========================================================
       SETTINGS MODAL
       First-run: shown automatically if TMDB key is absent.
       Re-openable via the ⚙ button added to the floating buttons.
    ========================================================== */

    // Per-feature toggle rows, registered by the feature that owns them (all
    // still colocated in this file for now — see scRegisterInit above for why).
    // sc-input-spellcheck (grammar-check) moved to
    // src/pc/modules/grammar-check/index.js — see that file.
    // `order` reproduces the original shipped script's row sequence
    // (spellcheck=1, movielinks=2, autoembed=3, gifoptimize=4); rows are
    // sorted by it below rather than rendered in registration order, since
    // registration order depends on which optional modules a build includes
    // and in what order their files happen to load.
    scRegisterSetting({ id: 'sc-input-autoembed', group: 'chat-images', label: 'Auto-embed image links in chat', note: 'Shows a thumbnail preview under messages that link directly to an image, marked "🖼 embedded" (requires cytube.chatimages.user.js)', key: LS_AUTOEMBED, defaultOn: true, order: 3 });
    scRegisterSetting({ id: 'sc-input-gifoptimize', group: 'gif-maker', label: 'Optimize GIFs before upload', note: 'Losslessly shrinks the file with gifsicle before Download/Upload — adds a couple seconds (requires cytube.gifmaker.user.js)', key: LS_GIF_OPTIMIZE, defaultOn: true, order: 4 });

    // Renders one registered toggle row using the same markup every hardcoded
    // row used to use. `defaultOn` rows read as checked unless the stored key
    // is explicitly 'off' (matches spellCheckEnabled()/movieLinksEnabled()/etc.).
    function toggleRowHtml(r) {
        const checked = r.defaultOn ? getKey(r.key) !== 'off' : getKey(r.key) === 'on';
        return `
                <div class="sc-settings-group sc-settings-toggle-group">
                    <label class="sc-settings-toggle-label">
                        <span class="sc-toggle-row">
                            <input type="checkbox" id="${r.id}" ${checked ? 'checked' : ''} />
                            <span class="sc-toggle-text">${r.label}</span>
                        </span>
                        <span class="sc-settings-note">${r.note}</span>
                    </label>
                </div>`;
    }

    // Sorted view of SC_SETTINGS_ROWS used at render time -- doesn't mutate the
    // registry itself, since scRegisterSetting() may still be called by an
    // optional module's file after core has already loaded (same build, later
    // in emission order) but before the settings modal is ever opened.
    function sortedSettingsRows() {
        return SC_SETTINGS_ROWS.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }

    async function validateTmdbKey(key) {
        try {
            const res = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: `https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(key)}`,
                    onload: r => resolve(r),
                    onerror: reject,
                });
            });
            if (res.status === 200) return 'valid';
            if (res.status === 401) return 'invalid';
            return 'error';
        } catch (e) { return 'error'; }
    }

    async function validateImgbbKey(apiKey) {
        // ImgBB has no key-check endpoint, so probe with a tiny 1x1 PNG upload.
        const onePx = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
        try {
            const res = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    // expiration=60 so the throwaway test image self-deletes.
                    url: 'https://api.imgbb.com/1/upload?expiration=60&key=' + encodeURIComponent(apiKey),
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    data: 'image=' + encodeURIComponent(onePx),
                    onload: r => resolve(r),
                    onerror: reject,
                });
            });
            if (res.status >= 200 && res.status < 300) return 'valid';
            if (res.status === 400 || res.status === 403) return 'invalid';
            return 'error';
        } catch (e) { return 'error'; }
    }

    function openSettingsModal() {
        const old = document.getElementById('sc-settings-overlay');
        if (old) old.remove();

        const tmdbVal  = getKey(LS_TMDB);
        const imgbbVal = getKey(LS_IMGBB);
        const firstRun = !localStorage.getItem('sc_onboarded');
        try { localStorage.setItem('sc_onboarded', '1'); } catch (e) {}
        const fontSize = getChatFontSize();
        const leadSec  = getMovieLeadSec();

        const overlay = document.createElement('div');
        overlay.id = 'sc-settings-overlay';
        overlay.innerHTML = `
            <div id="sc-settings-modal">
                <div id="sc-settings-title">⚙ Grindhouse Settings</div>
                ${firstRun ? '<div class="sc-settings-intro">First-time setup — everything here is optional. Enable TMDB for richer movie info. Reopen any time with the ⚙ button.</div>' : ''}

                <div class="sc-settings-group sc-settings-divider">
                    <label class="sc-settings-toggle-label">
                        <span class="sc-toggle-row">
                            <input type="checkbox" id="sc-input-tmdb-enable" ${tmdbVal ? 'checked' : ''} />
                            <span class="sc-toggle-text">Enable TMDB features</span>
                        </span>
                        <span class="sc-settings-note">Movie posters, ratings, runtime, IMDb/Letterboxd links, trivia</span>
                    </label>
                    <div id="sc-tmdb-fields" class="${tmdbVal ? '' : 'sc-hidden'}">
                        <div class="sc-settings-input-row">
                            <input id="sc-input-tmdb" class="sc-settings-input" type="text"
                                placeholder="Paste TMDB v3 key…" value="${tmdbVal}" spellcheck="false" />
                            <button id="sc-test-tmdb" class="sc-settings-test" type="button">Test</button>
                        </div>
                        <span id="sc-test-tmdb-status" class="sc-settings-test-status"></span>
                        <a class="sc-settings-link" href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">
                            Get a free TMDB key ↗
                        </a>

                        <label class="sc-settings-toggle-label sc-settings-divider">
                            <span class="sc-toggle-row">
                                <input type="checkbox" id="sc-input-lineuptiming" ${lineupTimingEnabled() ? 'checked' : ''} />
                                <span class="sc-toggle-text">Coming Attractions live timing (Experimental)</span>
                            </span>
                            <span class="sc-settings-note">Shows NOW PLAYING and estimated start times in Tonight's Lineup. Needs TMDB above for movie runtimes — without it, estimates can't guess well. Off by default, still being tuned.</span>
                        </label>
                    </div>
                </div>

                ${sortedSettingsRows().map(r => toggleRowHtml(r)).join('')}

                <div class="sc-settings-group sc-settings-divider">
                    <label class="sc-settings-label">
                        ImgBB GIF upload
                        <span class="sc-settings-note">Optional — lets the ☁ Upload button in the GIF maker host a GIF and give you a shareable link (requires cytube.gifmaker.user.js)</span>
                    </label>
                    <div class="sc-settings-input-row">
                        <input id="sc-input-imgbb" class="sc-settings-input" type="text"
                            placeholder="Paste ImgBB API key…" value="${imgbbVal}" spellcheck="false" />
                        <button id="sc-test-imgbb" class="sc-settings-test" type="button">Test</button>
                    </div>
                    <span id="sc-test-imgbb-status" class="sc-settings-test-status"></span>
                    <a class="sc-settings-link" href="https://api.imgbb.com/" target="_blank" rel="noopener">
                        Get a free ImgBB API key ↗ (sign up, then "Add API key" — no app registration)
                    </a>
                </div>

                <div class="sc-settings-group sc-settings-toggle-group">
                    <label class="sc-settings-label">
                        Chat font size: <span id="sc-font-val">${fontSize}px</span>
                        <span class="sc-settings-note">Applies to message buffer and chat input</span>
                    </label>
                    <input id="sc-input-fontsize" class="sc-settings-range" type="range" min="10" max="32" value="${fontSize}" />
                    <div class="sc-font-sample" id="sc-font-sample" style="font-size:${fontSize}px">
                        The quick brown fox jumps over the lazy dog.
                    </div>
                </div>

                <div class="sc-settings-group sc-settings-toggle-group">
                    <label class="sc-settings-label">
                        Movie lead time (seconds ahead of sync)
                        <span class="sc-settings-note">Keeps you a few seconds ahead of the group during movies (not YouTube) — cushions against your own buffering. 0 = off.</span>
                    </label>
                    <input id="sc-input-leadsec" class="sc-settings-input" type="number" min="${MOVIE_LEAD_MIN}" max="${MOVIE_LEAD_MAX}" step="1" value="${leadSec}" style="width:5em" />
                </div>

                <div id="sc-settings-actions">
                    <button id="sc-settings-cancel">Cancel</button>
                    <button id="sc-settings-save">Save</button>
                </div>
                <div id="sc-settings-status"></div>
            </div>`;

        document.body.appendChild(overlay);
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
        document.getElementById('sc-settings-cancel').addEventListener('click', () => overlay.remove());

        // TMDB toggle shows/hides key fields
        const tmdbToggle = document.getElementById('sc-input-tmdb-enable');
        const tmdbFields = document.getElementById('sc-tmdb-fields');
        tmdbToggle.addEventListener('change', () => tmdbFields.classList.toggle('sc-hidden', !tmdbToggle.checked));

        // Font size live preview
        const fontInput  = document.getElementById('sc-input-fontsize');
        const fontVal    = document.getElementById('sc-font-val');
        const fontSample = document.getElementById('sc-font-sample');
        fontInput.addEventListener('input', () => {
            const px = parseInt(fontInput.value, 10);
            fontVal.textContent = px + 'px';
            fontSample.style.fontSize = px + 'px';
            applyChatFontSize(px);
        });

        // TMDB test button
        const testBtn    = document.getElementById('sc-test-tmdb');
        const testStatus = document.getElementById('sc-test-tmdb-status');
        testBtn.addEventListener('click', async () => {
            const key = document.getElementById('sc-input-tmdb').value.trim();
            if (!key) { testStatus.textContent = 'Enter a key first'; testStatus.className = 'sc-settings-test-status sc-test-bad'; return; }
            testBtn.disabled = true;
            testStatus.textContent = 'Checking…'; testStatus.className = 'sc-settings-test-status sc-test-pending';
            const result = await validateTmdbKey(key);
            testBtn.disabled = false;
            if (result === 'valid')        { testStatus.textContent = '✓ Valid key';           testStatus.className = 'sc-settings-test-status sc-test-ok'; }
            else if (result === 'invalid') { testStatus.textContent = '✗ Invalid key';         testStatus.className = 'sc-settings-test-status sc-test-bad'; }
            else                           { testStatus.textContent = '⚠ Couldn\'t reach API'; testStatus.className = 'sc-settings-test-status sc-test-bad'; }
        });

        // ImgBB API key test button
        const imgbbTestBtn    = document.getElementById('sc-test-imgbb');
        const imgbbTestStatus = document.getElementById('sc-test-imgbb-status');
        imgbbTestBtn.addEventListener('click', async () => {
            const id = document.getElementById('sc-input-imgbb').value.trim();
            if (!id) { imgbbTestStatus.textContent = 'Enter an API key first'; imgbbTestStatus.className = 'sc-settings-test-status sc-test-bad'; return; }
            imgbbTestBtn.disabled = true;
            imgbbTestStatus.textContent = 'Checking…'; imgbbTestStatus.className = 'sc-settings-test-status sc-test-pending';
            const result = await validateImgbbKey(id);
            imgbbTestBtn.disabled = false;
            if (result === 'valid')        { imgbbTestStatus.textContent = '✓ Valid API key';        imgbbTestStatus.className = 'sc-settings-test-status sc-test-ok'; }
            else if (result === 'invalid') { imgbbTestStatus.textContent = '✗ Invalid API key';      imgbbTestStatus.className = 'sc-settings-test-status sc-test-bad'; }
            else                           { imgbbTestStatus.textContent = '⚠ Couldn\'t reach ImgBB'; imgbbTestStatus.className = 'sc-settings-test-status sc-test-bad'; }
        });

        document.getElementById('sc-settings-save').addEventListener('click', () => {
            const tmdb   = tmdbToggle.checked ? document.getElementById('sc-input-tmdb').value.trim() : '';
            const lineupTiming = document.getElementById('sc-input-lineuptiming').checked;
            const imgbb  = document.getElementById('sc-input-imgbb').value.trim();
            const fontPx = parseInt(fontInput.value, 10);
            const leadSecInput = parseInt(document.getElementById('sc-input-leadsec').value, 10);
            const leadSec = Math.min(MOVIE_LEAD_MAX, Math.max(MOVIE_LEAD_MIN, Number.isFinite(leadSecInput) ? leadSecInput : MOVIE_LEAD_DEFAULT));
            setKey(LS_TMDB,        tmdb);
            SC_SETTINGS_ROWS.forEach(row => {
                const el = document.getElementById(row.id);
                if (el) setKey(row.key, el.checked ? 'on' : 'off');
            });
            setKey(LS_LINEUP_TIMING, lineupTiming ? 'on' : 'off');
            setKey(LS_IMGBB,       imgbb);
            setKey(LS_CHAT_FONT,   String(fontPx));
            applyChatFontSize(fontPx);
            setKey(LS_MOVIE_LEAD,  String(leadSec));
            if (typeof movieLinkCache !== 'undefined') { movieLinkCache = {}; }
            try { localStorage.removeItem(LS_MOVIE_CACHE); } catch (e) {}
            lastMovieTitle = '';
            if (typeof triggerTitleInject === 'function') triggerTitleInject();
            const status = document.getElementById('sc-settings-status');
            if (status) status.textContent = '✓ Saved';
            setTimeout(() => overlay.remove(), 800);
        });
    }

    function addSettingsButton() {
        if (document.getElementById('sc-settings-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'sc-settings-btn';
        btn.textContent = '⚙';
        btn.title = 'Script Settings (API keys)';
        btn.addEventListener('click', openSettingsModal);
        document.body.appendChild(btn);
    }
