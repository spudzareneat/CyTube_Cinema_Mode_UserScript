    console.log('[SC] cytube.pc v4.10.4 loaded');

    /* ==========================================================
       REGISTRY PRIMITIVES — let BOOT and the Settings Modal iterate
       over feature-contributed entries instead of hardcoded call
       lists / markup, so a feature's code can live in its own file
       (or be excluded from a build entirely) without any central
       list needing to know its name.
    ========================================================== */
    const SC_INIT_REGISTRY = [];
    const SC_SETTINGS_ROWS = [];
    function scRegisterInit(fn) { SC_INIT_REGISTRY.push(fn); }
    // `type` selects the rendering/persistence behavior in the settings modal:
    //   'checkbox' (default) — <input type="checkbox">, persisted 'on'/'off'.
    //   'text'    — <input type="text">, optional Test button when `testHandler`
    //               (async (value) => 'valid'|'invalid'|'error') is provided.
    //   'number'  — <input type="number"> using `min`/`max`/`step` from the row.
    // Existing callers that omit `type` keep rendering as checkboxes unchanged.
    function scRegisterSetting(row) { SC_SETTINGS_ROWS.push({ type: 'checkbox', ...row }); }
    function injectCSS(id, css) {
        if (document.getElementById('sc-style-' + id)) return;
        const s = document.createElement('style');
        s.id = 'sc-style-' + id;
        s.textContent = css;
        (document.head || document.documentElement).appendChild(s);
    }
