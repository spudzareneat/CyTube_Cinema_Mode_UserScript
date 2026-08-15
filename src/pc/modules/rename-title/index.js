    /* ==========================================================
       RENAME TITLE — renames the page title on the 420Grindhouse room to
       "The Grindhouse". Originally a standalone companion script
       (cytube.rename-title.user.js) whose own `@match` targeted only
       https://cytu.be/r/420Grindhouse. The shared bundle's `@match` covers
       both /r/420Grindhouse and /r/testing (manifest.json is bundle-wide),
       so this module wraps itself in its own scope and no-ops immediately
       on any channel other than 420Grindhouse, preserving the original
       script's exact scope. Runs immediately at module-load time (not via
       scRegisterInit) to preserve the original document-start timing --
       scRegisterInit's queue only runs on the page's 'load' event, much
       later than this module wants to start observing the title.
    ========================================================== */
    (function renameTitleInit() {
        if (!location.pathname.includes('420Grindhouse')) return;

        const TITLE = 'The Grindhouse';

        // CyTube JS keeps overwriting document.title (e.g. on now-playing changes).
        // Observing documentElement from document-start (before <head> exists yet)
        // catches both the title element being added and later text changes.
        new MutationObserver(() => {
            if (document.title !== TITLE) {
                document.title = TITLE;
            }
        }).observe(document.documentElement, {
            childList: true,
            characterData: true,
            subtree: true,
        });
    })();
