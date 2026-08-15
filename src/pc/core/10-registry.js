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
    function scRegisterSetting(row) { SC_SETTINGS_ROWS.push(row); }
    function injectCSS(id, css) {
        if (document.getElementById('sc-style-' + id)) return;
        const s = document.createElement('style');
        s.id = 'sc-style-' + id;
        s.textContent = css;
        document.head.appendChild(s);
    }
