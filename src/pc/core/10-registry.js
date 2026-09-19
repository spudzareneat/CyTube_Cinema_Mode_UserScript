    console.log('[SC] cytube.pc v4.13.6 loaded');

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
    //               Set `mask: true` to render it as a password field (e.g. secrets).
    //   'number'  — <input type="number"> using `min`/`max`/`step` from the row.
    //   'section' — non-persisted header (`label`, optional `note`) that visually
    //               groups the rows ordered after it.
    //   'action'  — non-persisted button (`buttonLabel`) + status line + detail
    //               area; `actionHandler(ctx)` runs on click, optional
    //               `cancelHandler`/`cancelLabel` make the button a cancel toggle.
    // Existing callers that omit `type` keep rendering as checkboxes unchanged.
    function scRegisterSetting(row) { SC_SETTINGS_ROWS.push({ type: 'checkbox', ...row }); }
    function injectCSS(id, css) {
        if (document.getElementById('sc-style-' + id)) return;
        const s = document.createElement('style');
        s.id = 'sc-style-' + id;
        s.textContent = css;
        (document.head || document.documentElement).appendChild(s);
    }
