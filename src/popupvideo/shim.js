    /* Standalone Pop-up Video shim: the few helpers trivia-popup expects from the
       main script's core, nothing else. */
    const SC_POPUPVIDEO_STANDALONE = true;
    const getKey = id => { try { return localStorage.getItem(id) || ''; } catch (e) { return ''; } };
    function injectCSS(id, css) {
        const add = () => { if (document.getElementById(id)) return; const s = document.createElement('style'); s.id = id; s.textContent = css; (document.head || document.documentElement).appendChild(s); };
        if (document.head) add(); else document.addEventListener('DOMContentLoaded', add);
    }
    function scRegisterSetting() {} // no settings modal in the standalone
    const _pvInits = [];
    function scRegisterInit(fn) { _pvInits.push(fn); }
    // Stand down if the full Grindhouse script's pop-up module is on this page
    // (it marks <html> at document-start); otherwise run every registered init.
    window.addEventListener('load', () => {
        if (document.documentElement.getAttribute('data-sc-trivia-popup') === '1') return;
        for (const fn of _pvInits) { try { fn(); } catch (e) { console.error('[popupvideo]', e); } }
    });
    // Stock CyTube layout: keep bubbles over the video area.
    function scPopupUsableArea() {
        const w = document.getElementById('videowrap');
        const r = w && w.getBoundingClientRect();
        if (!r || r.width < 50 || r.height < 50) return null;
        return { left: r.left + 8, top: r.top + 8, right: r.right - 8, bottom: r.bottom - 8 };
    }
