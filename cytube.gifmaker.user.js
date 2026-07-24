// ==UserScript==
// @name         CyTube GIF Maker
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Standalone scene-to-GIF capture with meme captions and ImgBB upload — a floating record button on the video itself, hidden during YouTube playback.
// @match        https://cytu.be/r/420Grindhouse
// @match        https://cytu.be/r/testing
// @grant        GM_xmlhttpRequest
// @require      https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.js
// @connect      cdnjs.cloudflare.com
// @connect      api.imgbb.com
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';
    console.log('[GIFMaker] cytube.gifmaker v1.0.0 loaded');

    /* ==========================================================
       STORAGE
    ========================================================== */
    const LS_IMGBB = 'sc_imgbb_key';
    const getKey = id => localStorage.getItem(id) || '';
    const setKey = (id, v) => localStorage.setItem(id, v.trim());

    /* ==========================================================
       PLAYER / MEDIA-TYPE DETECTION
    ========================================================== */
    function getPlayerVideoEl() {
        return document.querySelector('#ytapiplayer video') || document.querySelector('video');
    }

    function isYouTubeMedia() {
        try {
            const p = window.PLAYER || window.player;
            if (p && (p.type === 'yt' || p.mediaType === 'yt')) return true;
        } catch (e) {}
        if (document.querySelector('#ytapiplayer iframe[src*="youtube.com"]')) return true;
        if (document.querySelector('#ytapiplayer[src*="youtube.com"]')) return true;
        return false;
    }

    /* ==========================================================
       GIF PANEL (implemented in a later pass)
    ========================================================== */
    function openGifPanel(initialSec) {
        console.log('[GIFMaker] openGifPanel stub — panel not implemented yet', initialSec);
    }

    /* ==========================================================
       VIDEO-CORNER RECORD BUTTON
    ========================================================== */
    function ensureRecordButton() {
        const videowrap = document.getElementById('videowrap');
        if (!videowrap) return;
        let btn = document.getElementById('scgm-record-btn');
        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'scgm-record-btn';
            btn.type = 'button';
            btn.textContent = '◉';
            btn.title = 'Make a GIF of this scene';
            btn.addEventListener('click', () => openGifPanel());
            videowrap.appendChild(btn);
        } else if (btn.parentElement !== videowrap) {
            videowrap.appendChild(btn);
        }
    }

    function updateRecordButtonVisibility() {
        const btn = document.getElementById('scgm-record-btn');
        if (!btn) return;
        btn.style.display = isYouTubeMedia() ? 'none' : '';
    }

    /* ==========================================================
       BOOT
    ========================================================== */
    function waitForBody() {
        if (!document.body) { requestAnimationFrame(waitForBody); return; }

        ensureRecordButton();
        updateRecordButtonVisibility();

        new MutationObserver(() => {
            ensureRecordButton();
            updateRecordButtonVisibility();
        }).observe(document.body, { childList: true, subtree: true });

        setInterval(updateRecordButtonVisibility, 800);

        const style = document.createElement('style');
        style.textContent = `
            #videowrap { position: relative !important; }
            #scgm-record-btn {
                position: absolute !important;
                top: 8px !important; right: 8px !important;
                z-index: 20002 !important;
                background: rgba(255,255,255,0.08) !important;
                color: rgba(255,255,255,0.55) !important;
                border: 1px solid rgba(255,255,255,0.18) !important;
                border-radius: 50% !important;
                width: 28px !important; height: 28px !important;
                padding: 0 !important; font-size: 14px !important;
                cursor: pointer !important;
                display: flex !important; align-items: center !important; justify-content: center !important;
                transition: color 0.3s ease, background 0.3s ease !important;
            }
            #scgm-record-btn:hover { color: white !important; background: rgba(255,255,255,0.22) !important; }
        `;
        document.head.appendChild(style);
    }

    waitForBody();
})();
