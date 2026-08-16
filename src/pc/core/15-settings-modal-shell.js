    /* ==========================================================
       SETTINGS MODAL
       First-run: shown automatically if TMDB key is absent.
       Re-openable via the ⚙ button added to the floating buttons.
    ========================================================== */

    // Per-feature toggle rows, registered by the feature that owns them (all
    // still colocated in this file for now — see scRegisterInit above for why).
    // sc-input-spellcheck (grammar-check) moved to
    // src/pc/modules/grammar-check/index.js — see that file.
    // sc-input-autoembed (chatimages) moved to
    // src/pc/modules/chatimages/index.js — see that file.
    // sc-input-gifoptimize and sc-input-imgbb (gif-maker) moved to
    // src/pc/modules/gifmaker/index.js — see that file. `order` reproduces
    // the original shipped script's row sequence (spellcheck=1,
    // movielinks=2, autoembed=3, gifoptimize=4, lineuptiming=5, imgbb=6);
    // rows are sorted by it below rather than rendered in registration
    // order, since registration order depends on which optional modules a
    // build includes and in what order their files happen to load.

    // Renders one registered settings row, branching on `r.type` (defaulted to
    // 'checkbox' by scRegisterSetting). Dispatches to a per-type renderer below.
    function settingsRowHtml(r) {
        if (r.type === 'text') return textRowHtml(r);
        if (r.type === 'number') return numberRowHtml(r);
        return checkboxRowHtml(r);
    }

    // Same markup every hardcoded checkbox row used to use, now shared by any
    // row registered with type:'checkbox' (or no type at all). `defaultOn` rows
    // read as checked unless the stored key is explicitly 'off' (matches
    // spellCheckEnabled()/movieLinksEnabled()/etc.).
    function checkboxRowHtml(r) {
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

    // Text-input row, modeled on the hardcoded TMDB key field below
    // (input + optional Test button + status line). `r.testHandler`, if
    // present, is an async (value) => 'valid'|'invalid'|'error' function —
    // wireTextRowTestButton() below hooks it up once the row is in the DOM.
    function textRowHtml(r) {
        const val = getKey(r.key);
        return `
                <div class="sc-settings-group sc-settings-divider">
                    <label class="sc-settings-label">
                        ${r.label}
                        <span class="sc-settings-note">${r.note}</span>
                    </label>
                    <div class="sc-settings-input-row">
                        <input id="${r.id}" class="sc-settings-input" type="text"
                            placeholder="${r.placeholder || ''}" value="${val}" spellcheck="false" />
                        ${r.testHandler ? `<button id="${r.id}-test" class="sc-settings-test" type="button">Test</button>` : ''}
                    </div>
                    ${r.testHandler ? `<span id="${r.id}-test-status" class="sc-settings-test-status"></span>` : ''}
                </div>`;
    }

    // Number-input row, modeled on the hardcoded Movie Lead Time field below.
    // Stored value is clamped to [min, max], falling back to `defaultValue`
    // (or `min`) when unset/non-numeric — the exact clamping order the Movie
    // Lead Time field uses today: Math.min(max, Math.max(min, finite ? v : default)).
    function numberRowHtml(r) {
        const raw = parseInt(getKey(r.key), 10);
        const fallback = r.defaultValue ?? r.min;
        const val = Math.min(r.max, Math.max(r.min, Number.isFinite(raw) ? raw : fallback));
        return `
                <div class="sc-settings-group sc-settings-toggle-group">
                    <label class="sc-settings-label">
                        ${r.label}
                        <span class="sc-settings-note">${r.note}</span>
                    </label>
                    <input id="${r.id}" class="sc-settings-input" type="number"
                        min="${r.min}" max="${r.max}" step="${r.step ?? 1}" value="${val}" style="width:5em" />
                </div>`;
    }

    // Wires up the Test button for a rendered text row that declared a
    // testHandler, mirroring the TMDB Test button behavior below: disable
    // while checking, show a pending message, then a result message with
    // the matching status class. Messages are overridable per-row via
    // testEmptyMessage/testValidMessage/testInvalidMessage/testErrorMessage
    // so a registered row (e.g. gifmaker's ImgBB field) can match its own
    // pre-existing copy exactly.
    function wireTextRowTestButton(r) {
        if (r.type !== 'text' || !r.testHandler) return;
        const btn = document.getElementById(r.id + '-test');
        const status = document.getElementById(r.id + '-test-status');
        if (!btn || !status) return;
        btn.addEventListener('click', async () => {
            const value = document.getElementById(r.id).value.trim();
            if (!value) {
                status.textContent = r.testEmptyMessage || 'Enter a value first';
                status.className = 'sc-settings-test-status sc-test-bad';
                return;
            }
            btn.disabled = true;
            status.textContent = 'Checking…';
            status.className = 'sc-settings-test-status sc-test-pending';
            const result = await r.testHandler(value);
            btn.disabled = false;
            if (result === 'valid') {
                status.textContent = r.testValidMessage || '✓ Valid';
                status.className = 'sc-settings-test-status sc-test-ok';
            } else if (result === 'invalid') {
                status.textContent = r.testInvalidMessage || '✗ Invalid';
                status.className = 'sc-settings-test-status sc-test-bad';
            } else {
                status.textContent = r.testErrorMessage || '⚠ Couldn\'t verify';
                status.className = 'sc-settings-test-status sc-test-bad';
            }
        });
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

    function openSettingsModal() {
        const old = document.getElementById('sc-settings-overlay');
        if (old) old.remove();

        const tmdbVal  = getKey(LS_TMDB);
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
                    </div>
                </div>

                ${sortedSettingsRows().map(r => settingsRowHtml(r)).join('')}

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

        // Wire up Test buttons for any registered text rows that declared one.
        sortedSettingsRows().forEach(r => wireTextRowTestButton(r));

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

        document.getElementById('sc-settings-save').addEventListener('click', () => {
            const tmdb   = tmdbToggle.checked ? document.getElementById('sc-input-tmdb').value.trim() : '';
            const fontPx = parseInt(fontInput.value, 10);
            const leadSecInput = parseInt(document.getElementById('sc-input-leadsec').value, 10);
            const leadSec = Math.min(MOVIE_LEAD_MAX, Math.max(MOVIE_LEAD_MIN, Number.isFinite(leadSecInput) ? leadSecInput : MOVIE_LEAD_DEFAULT));
            setKey(LS_TMDB,        tmdb);
            SC_SETTINGS_ROWS.forEach(row => {
                const el = document.getElementById(row.id);
                if (!el) return;
                if (row.type === 'text') {
                    setKey(row.key, el.value.trim());
                } else if (row.type === 'number') {
                    const raw = parseInt(el.value, 10);
                    const fallback = row.defaultValue ?? row.min;
                    const clamped = Math.min(row.max, Math.max(row.min, Number.isFinite(raw) ? raw : fallback));
                    setKey(row.key, String(clamped));
                } else {
                    setKey(row.key, el.checked ? 'on' : 'off');
                }
            });
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
