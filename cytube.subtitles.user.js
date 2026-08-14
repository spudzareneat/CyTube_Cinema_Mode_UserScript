// ==UserScript==
// @name         CyTube Subtitle Sync
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Load a local .srt/.vtt subtitle file and sync it to native <video> playback, with a live offset control for imperfectly-aligned files. Not available for YouTube playback. Integrates with cytube.pc.user.js when installed.
// @match        https://cytu.be/r/420Grindhouse
// @match        https://cytu.be/r/testing
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';
    console.log('[SC] cytube.subtitles v1.0.0 loaded');

    /* ==========================================================
       PC-SCRIPT INTEGRATION BRIDGE
       cytube.pc.user.js (when installed) exposes a small object on
       the real page window (via unsafeWindow) that cytube.gifmaker.user.js
       and cytube.chatimages.user.js already use purely as a presence
       signal. Reused the same way here — PC_MODE only changes how the
       trigger button anchors (see TRIGGER BUTTON below).
    ========================================================== */
    let PC_MODE = false;
    function readPcBridge() {
        const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const b = w.__SC_GIF_BRIDGE__;
        return (b && typeof b.getTitleSlug === 'function') ? b : null;
    }

    /* ==========================================================
       PLAYER / MEDIA-TYPE DETECTION
       (matches cytube.gifmaker.user.js:57-69 exactly)
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
       SUBTITLE PANEL (stub — replaced in Task 2)
    ========================================================== */
    function openSubtitlePanel() {
        console.log('[SC] cytube.subtitles: panel not yet implemented');
    }

    /* ==========================================================
       TRIGGER BUTTON
       Standalone: attached into CyTube's own #videocontrols .btn-group,
       styled with CyTube's native .btn.btn-sm.btn-default. PC mode: a
       floating #scsub-trigger-btn, positioned to the left of
       cytube.gifmaker.user.js's floating button (152px vs its 116px from
       the chat edge) so they don't overlap when both are installed.
    ========================================================== */
    function injectFloatingButtonCss() {
        if (document.getElementById('scsub-floatbtn-style')) return;
        const style = document.createElement('style');
        style.id = 'scsub-floatbtn-style';
        style.textContent = `
            #scsub-trigger-btn {
                position: fixed !important;
                z-index: 20002 !important;
                background: rgba(255,255,255,0.08) !important;
                color: rgba(255,255,255,0.55) !important;
                border: 1px solid rgba(255,255,255,0.18) !important;
                border-radius: 50% !important;
                width: 28px !important; height: 28px !important;
                padding: 0 !important; font-size: 11px !important; font-weight: 700 !important;
                cursor: pointer !important;
                display: flex !important; align-items: center !important; justify-content: center !important;
                transition: color 0.3s ease, background 0.3s ease, transform 0.3s ease, opacity 0.3s ease !important;
            }
            #scsub-trigger-btn.sc-bar-dim {
                transform: translateX(60px) !important; opacity: 0 !important; pointer-events: none !important;
            }
            #scsub-trigger-btn:hover { color: white !important; background: rgba(255,255,255,0.22) !important; }
            body.sc-horizontal #scsub-trigger-btn {
                bottom: 6px !important;
                right: calc(var(--sc-chat-w) + 1vw + 152px) !important;
            }
            body.sc-vertical #scsub-trigger-btn {
                bottom: calc(var(--sc-chat-h) + 1vh) !important;
                right: 152px !important;
            }
            #scsub-trigger-btn:disabled {
                opacity: 0.35 !important; cursor: default !important; pointer-events: none !important;
            }
            #scsub-trigger-btn.sc-bar-dim:disabled {
                opacity: 0 !important;
            }
        `;
        document.head.appendChild(style);
    }

    function ensureTriggerButton() {
        if (PC_MODE) {
            if (document.getElementById('scsub-trigger-btn')) return;
            injectFloatingButtonCss();
            const btn = document.createElement('button');
            btn.id = 'scsub-trigger-btn';
            btn.textContent = 'CC';
            btn.title = 'Load subtitles';
            btn.addEventListener('click', () => openSubtitlePanel());
            document.body.appendChild(btn);
            return;
        }
        const group = document.getElementById('videocontrols');
        if (!group) return;
        let btn = document.getElementById('scsub-standalone-btn');
        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'scsub-standalone-btn';
            btn.type = 'button';
            btn.className = 'btn btn-sm btn-default';
            btn.title = 'Load subtitles';
            btn.textContent = 'CC'; // no built-in Bootstrap glyphicon for subtitles/captions
            btn.addEventListener('click', () => openSubtitlePanel());
            group.appendChild(btn);
        } else if (btn.parentElement !== group) {
            group.appendChild(btn);
        }
    }

    function updateTriggerButtonState() {
        const btn = document.getElementById(PC_MODE ? 'scsub-trigger-btn' : 'scsub-standalone-btn');
        if (!btn) return;
        const yt = isYouTubeMedia();
        btn.disabled = yt;
        btn.title = yt ? 'Not available for YouTube videos' : 'Load subtitles';
    }

    /* ==========================================================
       BOOT
    ========================================================== */
    const PC_BRIDGE_POLL_MS = 50;
    const PC_BRIDGE_POLL_TIMEOUT_MS = 1500;

    function waitForBody() {
        if (!document.body) { requestAnimationFrame(waitForBody); return; }

        if (readPcBridge()) PC_MODE = true;
        ensureTriggerButton();
        updateTriggerButtonState();

        if (!PC_MODE) {
            let elapsed = 0;
            const pollTimer = setInterval(() => {
                elapsed += PC_BRIDGE_POLL_MS;
                if (readPcBridge()) {
                    PC_MODE = true;
                    const oldBtn = document.getElementById('scsub-standalone-btn');
                    if (oldBtn) oldBtn.remove();
                    ensureTriggerButton();
                    updateTriggerButtonState();
                    clearInterval(pollTimer);
                } else if (elapsed >= PC_BRIDGE_POLL_TIMEOUT_MS) {
                    clearInterval(pollTimer);
                }
            }, PC_BRIDGE_POLL_MS);
        }

        new MutationObserver(() => {
            ensureTriggerButton();
            updateTriggerButtonState();
        }).observe(document.body, { childList: true, subtree: true });

        setInterval(updateTriggerButtonState, 800);
    }
    waitForBody();
})();
