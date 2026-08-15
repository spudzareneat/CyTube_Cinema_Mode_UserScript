    /* ==========================================================
       FLOATING BUTTONS
       Appended to document.body so they're never inside #leftcontrols
       and can't be accidentally hidden with it.
    ========================================================== */

    // NOTE: addFloatingButtons() itself lives much further down in the original
    // script (original ~line 1002, near the CHAT -> MOVIE SEEK section) rather
    // than right under this banner (original ~664-669, banner-only). Moved here
    // to keep the banner and its implementation together -- see task-4-report.md
    // for why this deviates from the brief's literal line range.
    function addFloatingButtons() {
        if (document.getElementById('fs-toggle-btn')) return;

        const fsBtn = document.createElement('button');
        fsBtn.id = 'fs-toggle-btn'; fsBtn.textContent = '⛶'; fsBtn.title = 'Toggle Fullscreen';
        fsBtn.addEventListener('click', () => {
            document.fullscreenElement
                ? document.exitFullscreen().catch(() => {})
                : document.documentElement.requestFullscreen().catch(() => {});
        });
        document.body.appendChild(fsBtn);

        document.addEventListener('fullscreenchange', () => {
            fsBtn.style.display = document.fullscreenElement ? 'none' : '';
        });
    }
