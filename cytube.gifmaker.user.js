// ==UserScript==
// @name         CyTube GIF Maker
// @namespace    http://tampermonkey.net/
// @version      1.4.1
// @description  Standalone scene-to-GIF capture with meme captions and ImgBB upload — a record button (in the video's own control bar, or floating if cytube.pc.user.js is also installed), disabled during YouTube playback. Integrates with cytube.pc.user.js when installed.
// @match        https://cytu.be/r/420Grindhouse
// @match        https://cytu.be/r/testing
// @grant        GM_xmlhttpRequest
// @require      https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.js
// @connect      cdnjs.cloudflare.com
// @connect      cdn.jsdelivr.net
// @connect      api.imgbb.com
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';
    console.log('[GIFMaker] cytube.gifmaker v1.4.1 loaded');

    /* ==========================================================
       STORAGE
    ========================================================== */
    const LS_IMGBB = 'sc_imgbb_key';
    const LS_GIF_OPTIMIZE = 'sc_gif_optimize'; // shared with cytube.pc.user.js
    const getKey = id => localStorage.getItem(id) || '';
    const setKey = (id, v) => localStorage.setItem(id, v.trim());
    const gifOptimizeEnabled = () => getKey(LS_GIF_OPTIMIZE) !== 'off'; // default ON

    /* ==========================================================
       PC-SCRIPT INTEGRATION BRIDGE
       cytube.pc.user.js (when installed) exposes a small object on
       the real page window (via unsafeWindow — two separate
       Tampermonkey sandboxes can't see each other's plain `window`
       properties) so this script can defer to its TMDB-aware title
       logic and match its floating-button placement instead of
       duplicating that functionality. Detection happens in
       waitForBody() at the bottom of this file; PC_MODE and
       _pcBridge are set there.
    ========================================================== */
    let PC_MODE = false;
    let _pcBridge = null;
    function readPcBridge() {
        const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const b = w.__SC_GIF_BRIDGE__;
        return (b && typeof b.getTitleSlug === 'function') ? b : null;
    }
    function activeTitleSlug() {
        if (PC_MODE && _pcBridge) {
            try { return _pcBridge.getTitleSlug() || gifTitleSlug(); } catch (e) { return gifTitleSlug(); }
        }
        return gifTitleSlug();
    }

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
       GIF PANEL — CSS (lazily injected on first open)
    ========================================================== */
    function injectPanelCss() {
        if (document.getElementById('scgm-panel-style')) return;
        const style = document.createElement('style');
        style.id = 'scgm-panel-style';
        style.textContent = `
            #sc-gif-panel {
                position: fixed !important;
                top: 50% !important; left: 50% !important; transform: translate(-50%, -50%) !important;
                z-index: 30002 !important;
                width: 600px !important; max-width: 92vw !important;
                max-height: 88vh !important;
                display: flex !important; flex-direction: column !important;
                background: #0c0c0e !important;
                border: 1px solid rgba(244,244,242,0.14) !important;
                border-radius: 12px !important;
                box-shadow: 0 12px 40px rgba(0,0,0,0.6) !important;
                color: #f4f4f2 !important; font-size: 13px !important;
                font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif !important;
            }
            #sc-gif-head {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                flex: none !important;
                padding: 10px 16px !important;
                border-bottom: 1px solid rgba(244,244,242,0.08) !important;
                font-weight: 600 !important; font-size: 14px !important; color: #ffb020 !important;
                cursor: grab !important; user-select: none !important; touch-action: none !important;
            }
            #sc-gif-head.sc-gif-dragging { cursor: grabbing !important; }
            #sc-gif-close {
                background: transparent !important; border: none !important; color: rgba(244,244,242,0.62) !important;
                font-size: 15px !important; cursor: pointer !important; padding: 0 4px !important;
                transition: color 120ms ease !important;
            }
            #sc-gif-close:hover { color: #f4f4f2 !important; }
            #sc-gif-body {
                padding: 16px !important; display: flex !important; flex-direction: column !important; gap: 16px !important;
                flex: 1 1 auto !important; min-height: 0 !important; overflow-y: auto !important;
                scrollbar-width: thin !important; scrollbar-color: rgba(244,244,242,0.2) #000 !important;
            }
            #sc-gif-body::-webkit-scrollbar { width: 10px !important; }
            #sc-gif-body::-webkit-scrollbar-track { background: #000 !important; }
            #sc-gif-body::-webkit-scrollbar-thumb {
                background: rgba(244,244,242,0.2) !important; border-radius: 6px !important; border: 2px solid #000 !important;
            }
            #sc-gif-body::-webkit-scrollbar-thumb:hover { background: #ffb020 !important; }
            #sc-gif-body label {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                color: rgba(244,244,242,0.62) !important; font-weight: 500 !important;
            }
            #sc-gif-body select {
                background: #1f1f22 !important; color: #f4f4f2 !important;
                border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 4px !important;
                padding: 3px 8px !important; font-size: 13px !important;
                transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important;
            }
            #sc-gif-body select:hover, #sc-gif-body select:focus { border-color: rgba(255,176,32,0.5) !important; }
            #sc-gif-body select option {
                background-color: #1f1f22 !important; color: #f4f4f2 !important;
            }
            .sc-gif-card {
                background: rgba(244,244,242,0.02) !important;
                border: 1px solid rgba(244,244,242,0.06) !important;
                border-radius: 8px !important;
                padding: 12px !important;
                display: flex !important; flex-direction: column !important; gap: 8px !important;
            }
            .sc-gif-mono, #sc-gif-time-start, #sc-gif-time-end, #sc-gif-dur-line b,
            #sc-gif-overview-total, #sc-gif-filmstrip-range, .sc-gif-fx-row input[type=number] {
                font-family: "SF Mono", "Cascadia Code", Consolas, monospace !important;
            }
            .sc-gif-marks { display: flex !important; gap: 10px !important; }
            .sc-gif-mark {
                flex: 1 1 0 !important; min-width: 0 !important;
                display: flex !important; flex-direction: column !important; gap: 6px !important;
            }
            .sc-gif-thumb {
                width: 100% !important; aspect-ratio: 16 / 9 !important;
                background-color: #000 !important;
                background-position: center !important;
                background-size: cover !important;
                background-repeat: no-repeat !important;
                border: 1px solid rgba(244,244,242,0.08) !important; border-radius: 8px !important;
                position: relative !important;
            }
            .sc-gif-thumb-43 { aspect-ratio: 4 / 3 !important; }
            .sc-gif-thumb-fit { background-size: contain !important; }
            .sc-gif-thumb-readonly { border-style: dashed !important; opacity: 0.92 !important; }
            .sc-gif-cap {
                position: absolute !important;
                width: 92% !important;
                text-align: center !important; white-space: pre-line !important;
                font-family: Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif !important;
                font-weight: bold !important; color: #fff !important;
                -webkit-text-stroke: 1.5px #000 !important;
                text-shadow: -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000 !important;
                pointer-events: none !important; transform: translate(-50%, -50%) !important;
            }
            .sc-gif-cap-top { left: var(--cx-top, 50%) !important; top: var(--cy-top, 10%) !important; }
            .sc-gif-cap-bottom { left: var(--cx-bottom, 50%) !important; top: var(--cy-bottom, 90%) !important; }
            .sc-gif-cap-yellow { color: #ffe135 !important; }
            .sc-gif-cap-handle {
                position: absolute !important; width: 14px !important; height: 14px !important;
                border-radius: 50% !important; background: rgba(255,176,32,0.9) !important;
                border: 2px solid #000 !important; transform: translate(-50%, -50%) !important;
                cursor: grab !important; pointer-events: auto !important; touch-action: none !important;
            }
            .sc-gif-cap-handle:active { cursor: grabbing !important; }
            .sc-gif-cap-handle-top { left: var(--cx-top, 50%) !important; top: var(--cy-top, 10%) !important; }
            .sc-gif-cap-handle-bottom { left: var(--cx-bottom, 50%) !important; top: var(--cy-bottom, 90%) !important; }
            .sc-gif-cap-sizes { display: flex !important; flex-wrap: wrap !important; gap: 14px !important; justify-content: center !important; }
            .sc-gif-cap-sizes label {
                display: flex !important; align-items: center !important; gap: 4px !important;
                color: rgba(244,244,242,0.62) !important; font-size: 12px !important;
            }
            .sc-gif-cap-sizes input[type=number] {
                width: 48px !important; background: #1f1f22 !important; color: #f4f4f2 !important;
                border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 4px !important; padding: 2px 4px !important;
                transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important;
            }
            .sc-gif-cap-sizes input[type=number]:hover, .sc-gif-cap-sizes input[type=number]:focus { border-color: rgba(255,176,32,0.5) !important; }
            .sc-gif-cap-hint { text-align: center !important; color: rgba(244,244,242,0.34) !important; font-size: 11px !important; }
            .sc-gif-overview { display: flex !important; flex-direction: column !important; gap: 2px !important; }
            .sc-gif-overview-track {
                position: relative !important; height: 16px !important; border-radius: 4px !important;
                background: #17171a !important; border: 1px solid rgba(244,244,242,0.14) !important;
                cursor: pointer !important; user-select: none !important; touch-action: none !important;
            }
            .sc-gif-overview-track:focus {
                outline: 2px solid #ffb020 !important; outline-offset: 1px !important;
            }
            .sc-gif-overview-viewport {
                position: absolute !important; top: 0 !important; bottom: 0 !important;
                background: rgba(255,176,32,0.55) !important;
                border-left: 1px solid #ffb020 !important; border-right: 1px solid #ffb020 !important;
                border-radius: 2px !important; pointer-events: none !important;
            }
            .sc-gif-overview-ghost {
                position: absolute !important; top: -3px !important; bottom: -3px !important; width: 2px !important;
                background: #f4f4f2 !important; box-shadow: 0 0 4px rgba(244,244,242,0.8) !important;
                display: none !important; pointer-events: none !important;
            }
            .sc-gif-overview-labels {
                display: flex !important; justify-content: space-between !important;
                color: rgba(244,244,242,0.34) !important; font-size: 11px !important;
            }
            .sc-gif-overview-current { color: rgba(255,176,32,0.85) !important; font-weight: 600 !important; }
            .sc-gif-filmstrip { display: flex !important; flex-direction: column !important; gap: 6px !important; }
            .sc-gif-filmstrip-strip {
                position: relative !important; height: 64px !important; border-radius: 8px !important;
                overflow: hidden !important; border: 1px solid rgba(244,244,242,0.08) !important; user-select: none !important;
            }
            .sc-gif-filmstrip-tiles { position: absolute !important; inset: 0 !important; display: flex !important; }
            .sc-gif-filmstrip-tile {
                flex: 1 1 0 !important;
                background-color: #1a1a1e !important;
                background-position: center !important; background-size: cover !important; background-repeat: no-repeat !important;
                border-right: 1px solid rgba(244,244,242,0.06) !important;
                position: relative !important;
            }
            .sc-gif-filmstrip-tile:last-child { border-right: 0 !important; }
            .sc-gif-filmstrip-dim-left, .sc-gif-filmstrip-dim-right {
                position: absolute !important; top: 0 !important; bottom: 0 !important;
                background: rgba(0,0,0,0.55) !important; pointer-events: none !important;
            }
            .sc-gif-filmstrip-dim-left { left: 0 !important; }
            .sc-gif-filmstrip-dim-right { right: 0 !important; }
            .sc-gif-filmstrip-selection {
                position: absolute !important; top: 0 !important; bottom: 0 !important;
                background: rgba(255,176,32,0.08) !important;
                border-left: 2px solid #ffb020 !important; border-right: 2px solid #ffb020 !important;
                pointer-events: auto !important; cursor: grab !important; touch-action: none !important;
            }
            .sc-gif-filmstrip-selection:active { cursor: grabbing !important; }
            .sc-gif-filmstrip-handle {
                position: absolute !important; top: 0 !important; bottom: 0 !important; width: 14px !important; margin-left: -7px !important;
                cursor: ew-resize !important; display: flex !important; align-items: center !important; justify-content: center !important;
                z-index: 3 !important; touch-action: none !important;
            }
            .sc-gif-filmstrip-handle-grip {
                width: 6px !important; height: 28px !important; border-radius: 3px !important;
                background: #ffb020 !important; border: 1px solid #000 !important;
                box-shadow: 0 0 0 3px rgba(255,176,32,0.15) !important;
            }
            .sc-gif-captions { display: flex !important; flex-direction: column !important; gap: 8px !important; }
            .sc-gif-tag-input {
                width: 90px !important; min-width: 0 !important;
                background: #1f1f22 !important; color: #f4f4f2 !important;
                border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 4px !important;
                padding: 4px 8px !important; font-size: 12px !important;
                transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important;
            }
            .sc-gif-tag-input:hover, .sc-gif-tag-input:focus { border-color: rgba(255,176,32,0.5) !important; }
            .sc-gif-tag-input::placeholder { color: rgba(244,244,242,0.34) !important; }
            .sc-gif-cap-input {
                background: #1f1f22 !important; color: #f4f4f2 !important;
                border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 4px !important;
                padding: 6px 8px !important; font-size: 13px !important; width: 100% !important;
                box-sizing: border-box !important;
                transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important;
            }
            .sc-gif-cap-input:hover, .sc-gif-cap-input:focus { border-color: rgba(255,176,32,0.5) !important; }
            .sc-gif-cap-bottom-input { margin-bottom: 4px !important; }
            .sc-gif-cap-input::placeholder { color: rgba(244,244,242,0.34) !important; }
            .sc-gif-cap-color {
                display: flex !important; align-items: center !important; gap: 14px !important; justify-content: center !important;
                color: rgba(244,244,242,0.62) !important; font-size: 12px !important;
            }
            .sc-gif-cap-color label { display: flex !important; align-items: center !important; gap: 4px !important; cursor: pointer !important; }
            .sc-gif-thumb-loading::after {
                content: '' !important;
                position: absolute !important;
                top: 50% !important; left: 50% !important;
                width: 22px !important; height: 22px !important;
                margin: -11px 0 0 -11px !important;
                border: 2px solid rgba(244,244,242,0.25) !important;
                border-top-color: #ffb020 !important;
                border-radius: 50% !important;
                animation: sc-gif-spin 0.8s linear infinite !important;
            }
            @keyframes sc-gif-spin { to { transform: rotate(360deg); } }
            .sc-gif-spinner {
                display: inline-block !important;
                width: 18px !important; height: 18px !important;
                border: 2px solid rgba(244,244,242,0.25) !important;
                border-top-color: #ffb020 !important;
                border-radius: 50% !important;
                animation: sc-gif-spin 0.8s linear infinite !important;
                flex: none !important;
            }
            .sc-gif-spinner-sm { width: 13px !important; height: 13px !important; }
            .sc-gif-working {
                display: flex !important; align-items: center !important; gap: 10px !important;
                padding: 14px 4px !important; color: rgba(244,244,242,0.62) !important; font-size: 13px !important;
            }
            .sc-gif-mark-label {
                color: #ffb020 !important; font-size: 11px !important; font-weight: 700 !important;
                letter-spacing: 0.06em !important; text-align: center !important;
            }
            .sc-gif-mark-btns { display: flex !important; gap: 4px !important; }
            .sc-gif-mark-btns button {
                flex: 1 1 0 !important; min-width: 0 !important;
                background: transparent !important; color: rgba(244,244,242,0.62) !important;
                border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 4px !important;
                padding: 4px 0 !important; font-size: 11px !important; cursor: pointer !important;
                transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important;
            }
            .sc-gif-mark-btns button:hover {
                background: rgba(255,176,32,0.14) !important; border-color: #ffb020 !important; color: #f4f4f2 !important;
            }
            #sc-gif-dur-line {
                text-align: center !important; color: rgba(244,244,242,0.62) !important; font-size: 12px !important;
            }
            #sc-gif-dur-line b { color: #f4f4f2 !important; }
            .sc-gif-opts { display: flex !important; gap: 12px !important; }
            .sc-gif-col-right .sc-gif-opts { flex-direction: column !important; gap: 6px !important; }
            .sc-gif-col-right .sc-gif-fx-row { flex-direction: column !important; align-items: stretch !important; gap: 6px !important; }
            .sc-gif-opts label { flex: 1 1 0 !important; }
            #sc-gif-go {
                background: #ffb020 !important; color: #0c0c0e !important;
                border: none !important; border-radius: 8px !important;
                padding: 8px 16px !important; font-size: 13px !important; font-weight: 600 !important;
                cursor: pointer !important;
                transition: box-shadow 120ms ease, opacity 120ms ease !important;
            }
            #sc-gif-go:hover:not(:disabled), #sc-gif-go:focus-visible:not(:disabled) {
                box-shadow: 0 0 0 3px rgba(255,176,32,0.14) !important;
            }
            #sc-gif-go:disabled { opacity: 0.5 !important; cursor: default !important; }
            #sc-gif-status { color: rgba(244,244,242,0.62) !important; font-size: 12px !important; min-height: 14px !important; }
            #sc-gif-result img { width: 100% !important; border-radius: 8px !important; display: block !important; }
            #sc-gif-actions { display: flex !important; align-items: center !important; gap: 10px !important; margin-top: 8px !important; }
            #sc-gif-dl { background: transparent !important; color: rgba(244,244,242,0.62) !important;
                         border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 8px !important;
                         padding: 5px 12px !important; font-size: 12px !important; cursor: pointer !important;
                         text-decoration: none !important;
                         transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important; }
            #sc-gif-dl:hover { background: rgba(255,176,32,0.14) !important; border-color: #ffb020 !important; color: #f4f4f2 !important; }
            #sc-gif-size { color: rgba(244,244,242,0.34) !important; font-size: 11px !important; margin-left: auto !important; }
            .sc-gif-imgbb-row { display: flex !important; flex-direction: column !important; gap: 4px !important; }
            .sc-gif-imgbb-label {
                color: rgba(244,244,242,0.62) !important; font-size: 12px !important; font-weight: 500 !important;
                text-transform: uppercase !important; letter-spacing: 0.06em !important;
            }
            .sc-gif-imgbb-header {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                background: transparent !important; border: none !important; padding: 0 !important;
                cursor: pointer !important; width: 100% !important; text-align: left !important;
                transition: color 120ms ease !important;
            }
            .sc-gif-imgbb-header:hover .sc-gif-imgbb-label,
            .sc-gif-imgbb-header:hover .sc-gif-imgbb-toggle { color: #f4f4f2 !important; }
            .sc-gif-imgbb-header:focus-visible { outline: 2px solid #ffb020 !important; outline-offset: 1px !important; }
            .sc-gif-imgbb-toggle { color: rgba(244,244,242,0.34) !important; font-size: 11px !important; }
            .sc-gif-imgbb-body { display: none !important; flex-direction: column !important; gap: 8px !important; margin-top: 4px !important; }
            .sc-gif-imgbb-row.sc-gif-imgbb-open .sc-gif-imgbb-body { display: flex !important; }
            .sc-gif-imgbb-input-row { display: flex !important; gap: 6px !important; }
            .sc-gif-imgbb-input { flex: 1 1 auto !important; }
            .sc-gif-imgbb-test-btn {
                background: transparent !important; color: rgba(244,244,242,0.62) !important;
                border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 8px !important;
                padding: 5px 12px !important; font-size: 12px !important; cursor: pointer !important;
                transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important;
            }
            .sc-gif-imgbb-test-btn:hover:not(:disabled) {
                background: rgba(255,176,32,0.14) !important; border-color: #ffb020 !important; color: #f4f4f2 !important;
            }
            .sc-gif-imgbb-status { font-size: 11px !important; min-height: 13px !important; }
            .sc-gif-optimize-row { display: flex !important; align-items: center !important; gap: 6px !important; }
            .sc-gif-optimize-row label { color: rgba(244,244,242,0.62) !important; font-size: 12px !important; }
            .sc-gif-mid-header {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                background: transparent !important; border: none !important; padding: 0 !important;
                cursor: pointer !important; width: 100% !important; text-align: left !important;
                color: rgba(244,244,242,0.62) !important; font-size: 12px !important; font-weight: 500 !important;
                text-transform: uppercase !important; letter-spacing: 0.06em !important;
                transition: color 120ms ease !important;
            }
            .sc-gif-mid-header:hover { color: #f4f4f2 !important; }
            .sc-gif-mid-header:hover .sc-gif-mid-toggle { color: #f4f4f2 !important; }
            .sc-gif-mid-header:focus-visible { outline: 2px solid #ffb020 !important; outline-offset: 1px !important; }
            .sc-gif-mid-toggle { color: rgba(244,244,242,0.34) !important; font-size: 11px !important; }
            .sc-gif-cols { display: flex !important; flex-wrap: wrap !important; gap: 16px !important; margin-top: -8px !important; }
            .sc-gif-cols.sc-gif-mid-collapsed { display: none !important; }
            .sc-gif-col-left, .sc-gif-col-right {
                flex: 1 1 260px !important; min-width: 0 !important;
                display: flex !important; flex-direction: column !important; gap: 8px !important;
                background: rgba(244,244,242,0.02) !important;
                border: 1px solid rgba(244,244,242,0.06) !important;
                border-radius: 8px !important;
                padding: 12px !important;
            }
            .sc-gif-fx-header {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                background: transparent !important; border: none !important; padding: 0 !important;
                cursor: pointer !important; width: 100% !important; text-align: left !important;
                color: rgba(244,244,242,0.62) !important; font-size: 12px !important; font-weight: 500 !important;
                text-transform: uppercase !important; letter-spacing: 0.06em !important;
                transition: color 120ms ease !important;
            }
            .sc-gif-fx-header:hover { color: #f4f4f2 !important; }
            .sc-gif-fx-header:hover .sc-gif-fx-toggle { color: #f4f4f2 !important; }
            .sc-gif-fx-header:focus-visible { outline: 2px solid #ffb020 !important; outline-offset: 1px !important; }
            .sc-gif-fx-toggle { color: rgba(244,244,242,0.34) !important; font-size: 11px !important; }
            .sc-gif-fx { display: none !important; flex-direction: column !important; gap: 8px !important; }
            .sc-gif-fx.sc-gif-fx-open { display: flex !important; }
            .sc-gif-fx-row { display: flex !important; align-items: center !important; gap: 10px !important; }
            .sc-gif-fx-row label { flex: 1 1 0 !important; }
            .sc-gif-fx-row input[type=number] {
                width: 64px !important; background: #1f1f22 !important; color: #f4f4f2 !important;
                border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 4px !important; padding: 2px 4px !important;
                transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important;
            }
            .sc-gif-fx-row input[type=number]:hover, .sc-gif-fx-row input[type=number]:focus { border-color: rgba(255,176,32,0.5) !important; }
            .sc-gif-fx-filters { display: flex !important; flex-direction: column !important; gap: 6px !important; }
            .sc-gif-fx-filter { display: flex !important; align-items: center !important; gap: 8px !important; }
            .sc-gif-fx-filter label { flex: 1 1 auto !important; color: rgba(244,244,242,0.62) !important; font-size: 12px !important; }
            .sc-gif-fx-filter input[type=range] { flex: 1 1 auto !important; accent-color: #ffb020 !important; }
            .sc-test-ok      { color: #7dffa0 !important; }
            .sc-test-bad     { color: #ff8080 !important; }
            .sc-test-pending { color: rgba(244,244,242,0.34) !important; }
            #sc-gif-link {
                display: flex !important; align-items: center !important; gap: 8px !important;
                flex-wrap: wrap !important; margin-top: 8px !important;
            }
            .sc-gif-link-url {
                color: #8ab4ff !important; font-size: 12px !important; word-break: break-all !important;
                text-decoration: none !important;
            }
            .sc-gif-link-url:hover { text-decoration: underline !important; }
            .sc-gif-link-msg { color: rgba(244,244,242,0.62) !important; font-size: 12px !important; }
            #sc-gif-copylink, #sc-gif-upload {
                background: transparent !important; color: rgba(244,244,242,0.62) !important;
                border: 1px solid rgba(244,244,242,0.14) !important; border-radius: 8px !important;
                padding: 5px 12px !important; font-size: 12px !important; cursor: pointer !important;
                transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease !important;
            }
            #sc-gif-copylink:hover, #sc-gif-upload:hover:not(:disabled) {
                background: rgba(255,176,32,0.14) !important; border-color: #ffb020 !important; color: #f4f4f2 !important;
            }
            #sc-gif-upload:disabled { opacity: 0.5 !important; cursor: default !important; }
        `;
        document.head.appendChild(style);
    }

    /* ==========================================================
       TITLE SLUG — filename naming, no TMDB cleanup.
       Reads whatever CyTube's own title element currently shows —
       these are CyTube's DOM nodes, not something this script creates.
    ========================================================== */
    function currentRawTitle() {
        for (const el of [
            document.getElementById('currenttitle'),
            document.querySelector('#videowrap-header .pull-left'),
            document.querySelector('#videowrap-header span'),
            document.querySelector('.video-title'),
        ]) {
            if (el && el.textContent.trim()) return el.textContent.trim();
        }
        return '';
    }
    function gifTitleSlug() {
        const raw = currentRawTitle();
        if (!raw) return '';
        return raw.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    }

    function _fmtClockTenths(sec) {
        sec = Math.max(0, sec);
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
    }
    function _fmtFilenameTimestamp(sec) {
        sec = Math.max(0, Math.round(sec));
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        const pad = n => String(n).padStart(2, '0');
        return pad(h) + 'h' + pad(m) + 'm' + pad(s) + 's';
    }
    function _escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

    /* ==========================================================
       MEME CAPTION RENDERING — shared by the live CSS preview and
       the actual per-frame canvas render, so what you see in the
       panel is what gets baked into the GIF.
    ========================================================== */
    const CAPTION_FONT_STACK = 'Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif';
    let _captionMeasureCtx = null;
    function getCaptionMeasureCtx() {
        if (!_captionMeasureCtx) {
            const c = document.createElement('canvas');
            _captionMeasureCtx = c.getContext('2d');
        }
        return _captionMeasureCtx;
    }
    function wrapCaptionAtSize(ctx, text, fontPx, maxWidth) {
        ctx.font = 'bold ' + fontPx + 'px ' + CAPTION_FONT_STACK;
        const words = text.split(/\s+/).filter(Boolean);
        const lines = [];
        let line = '';
        for (const w of words) {
            const trial = line ? line + ' ' + w : w;
            if (line && ctx.measureText(trial).width > maxWidth) {
                lines.push(line);
                line = w;
            } else {
                line = trial;
            }
        }
        if (line) lines.push(line);
        const widest = lines.reduce((m, l) => Math.max(m, ctx.measureText(l).width), 0);
        return { lines, widest };
    }
    function applyCaptionCtxStyle(ctx, fontPx, color) {
        ctx.font = 'bold ' + fontPx + 'px ' + CAPTION_FONT_STACK;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        ctx.fillStyle = color === 'yellow' ? '#ffe135' : '#ffffff';
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = Math.max(2, Math.round(fontPx / 14));
    }
    function drawCaptionBlockAdvanced(ctx, w, h, text, color, sizePct, xPct, yPct) {
        if (!text) return;
        const fontPx = Math.max(4, Math.round(h * (sizePct || 16) / 100));
        const { lines } = wrapCaptionAtSize(getCaptionMeasureCtx(), text.toUpperCase(), fontPx, w * 0.92);
        const lineHeight = Math.round(fontPx * 1.15);
        ctx.save();
        applyCaptionCtxStyle(ctx, fontPx, color);
        const cx = w * ((xPct == null ? 50 : xPct) / 100);
        const cy = h * ((yPct == null ? 50 : yPct) / 100);
        const blockH = lines.length * lineHeight;
        const firstBaselineY = cy - blockH / 2 + fontPx * 0.8;
        lines.forEach((line, i) => {
            const ly = firstBaselineY + i * lineHeight;
            ctx.strokeText(line, cx, ly);
            ctx.fillText(line, cx, ly);
        });
        ctx.restore();
    }
    function drawCaptions(ctx, w, h, captions) {
        if (!captions) return;
        ['top', 'bottom'].forEach(key => {
            const line = captions[key];
            if (!line || !line.text) return;
            drawCaptionBlockAdvanced(ctx, w, h, line.text, captions.color, line.size, line.x, line.y);
        });
    }

    /* ==========================================================
       FRAME CAPTURE + GIF ENCODE
       CyTube's on-page <video> has no crossOrigin attribute, so its
       canvas is tainted. Spin up a hidden crossOrigin clone of the
       same source, seek/play it, sample frames to a canvas, hand
       them to gif.js (Web-Worker encoder). The on-page video is
       never touched.
    ========================================================== */
    function computeFrameGeometry(vw, vh, width, aspect) {
        const even = n => Math.max(2, Math.round(n / 2) * 2);
        if (aspect === 'crop' || aspect === 'fit') {
            const cw = even(width), ch = even(width * 3 / 4);
            const targetAR = cw / ch, srcAR = vw / vh;
            if (aspect === 'crop') {
                let sw, sh, sx, sy;
                if (srcAR > targetAR) { sh = vh; sw = vh * targetAR; sx = (vw - sw) / 2; sy = 0; }
                else                  { sw = vw; sh = vw / targetAR; sx = 0; sy = (vh - sh) / 2; }
                return { cw, ch, letterbox: false, src: [sx, sy, sw, sh], dst: [0, 0, cw, ch] };
            }
            let dw, dh, dx, dy;
            if (srcAR > targetAR) { dw = cw; dh = cw / srcAR; dx = 0; dy = (ch - dh) / 2; }
            else                  { dh = ch; dw = ch * srcAR; dx = (cw - dw) / 2; dy = 0; }
            return { cw, ch, letterbox: true, src: [0, 0, vw, vh], dst: [dx, dy, dw, dh] };
        }
        const cw = even(width), ch = even(width * vh / vw);
        return { cw, ch, letterbox: false, src: null, dst: [0, 0, cw, ch] };
    }

    function captureGifFrames({ src, startT, endT, fps, width, aspect, captions }, onProgress) {
        return new Promise((resolve, reject) => {
            const vid = document.createElement('video');
            vid.crossOrigin = 'anonymous';
            vid.muted = true;
            vid.preload = 'auto';
            vid.playsInline = true;
            vid.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
            document.body.appendChild(vid);

            const frames = [];
            const span = Math.max(0.1, endT - startT);
            const frameInterval = 1 / fps;
            let canvas, ctx, w, h, geom, lastCap = -Infinity, done = false;

            const finish = (err) => {
                if (done) return;
                done = true;
                try { vid.pause(); } catch (e) {}
                try { vid.removeAttribute('src'); vid.load(); } catch (e) {}
                try { vid.remove(); } catch (e) {}
                if (err) reject(err);
                else if (!frames.length) reject(new Error('no frames captured'));
                else resolve({ frames, w, h, delay: Math.round(1000 / fps) });
            };
            const timer = setTimeout(() => finish(new Error('capture timeout')), 60000);

            const onFrame = (now, metadata) => {
                if (done) return;
                const t = metadata ? metadata.mediaTime : vid.currentTime;
                if (t + 1e-4 >= lastCap + frameInterval) {
                    lastCap = t;
                    if (geom.letterbox) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); }
                    if (geom.src) ctx.drawImage(vid, geom.src[0], geom.src[1], geom.src[2], geom.src[3],
                                                     geom.dst[0], geom.dst[1], geom.dst[2], geom.dst[3]);
                    else ctx.drawImage(vid, geom.dst[0], geom.dst[1], geom.dst[2], geom.dst[3]);
                    drawCaptions(ctx, w, h, captions);
                    frames.push(ctx.getImageData(0, 0, w, h));
                    if (onProgress) onProgress(Math.min(0.999, (t - startT) / span));
                }
                if (t >= endT || vid.ended) { clearTimeout(timer); finish(null); return; }
                if ('requestVideoFrameCallback' in vid) vid.requestVideoFrameCallback(onFrame);
            };

            vid.addEventListener('error', () => {
                clearTimeout(timer); finish(new Error('clone load error (CORS/network)'));
            });
            vid.addEventListener('loadedmetadata', () => {
                geom = computeFrameGeometry(vid.videoWidth, vid.videoHeight, width, aspect);
                w = geom.cw; h = geom.ch;
                canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                ctx = canvas.getContext('2d');
                try { vid.currentTime = startT; } catch (e) {}
            });
            vid.addEventListener('seeked', function onSeek() {
                vid.removeEventListener('seeked', onSeek);
                if ('requestVideoFrameCallback' in vid) vid.requestVideoFrameCallback(onFrame);
                else {
                    const iv = setInterval(() => {
                        if (done) { clearInterval(iv); return; }
                        onFrame();
                        if (vid.currentTime >= endT) clearInterval(iv);
                    }, 1000 / fps);
                }
                const p = vid.play();
                if (p && p.catch) p.catch(e => { clearTimeout(timer); finish(new Error('playback blocked: ' + e.message)); });
            });

            vid.src = src;
        });
    }

    /* ==========================================================
       REACTION EFFECTS — playback sequencing + visual filters.
       sourceFrames captured above is never mutated: buildPlaybackSequence
       only computes which frame index plays at each output position, and
       renderSequenceFrame (added later) clones before filtering so a
       frame reused by boomerang/freeze-hold is never double-filtered.
    ========================================================== */
    const MAX_SEQ_FRAMES = 400;
    function buildPlaybackSequence(frameCount, playback) {
        if (!frameCount || frameCount <= 0) return [];
        const mode = (playback && playback.mode) || 'normal';
        const speed = (playback && playback.speed) || 1;
        const freezeHoldMs = (playback && playback.freezeHoldMs) || 0;
        const fps = (playback && playback.fps) || 12;

        let seq;
        if (mode === 'reverse') {
            seq = [];
            for (let i = frameCount - 1; i >= 0; i--) seq.push(i);
        } else if (mode === 'boomerang') {
            const forward = [];
            for (let i = 0; i < frameCount; i++) forward.push(i);
            const middle = forward.slice(1, -1).reverse();
            seq = forward.concat(middle);
        } else {
            seq = [];
            for (let i = 0; i < frameCount; i++) seq.push(i);
        }

        if (speed > 1) {
            const sped = [];
            for (let i = 0; i * speed < seq.length; i++) sped.push(seq[Math.floor(i * speed)]);
            seq = sped.length ? sped : [seq[seq.length - 1]];
        } else if (speed < 1 && speed > 0) {
            const repeatCount = Math.max(1, Math.round(1 / speed));
            const slowed = [];
            seq.forEach(idx => { for (let r = 0; r < repeatCount; r++) slowed.push(idx); });
            seq = slowed;
        }

        if (freezeHoldMs > 0 && seq.length) {
            const holdFrames = Math.round((freezeHoldMs / 1000) * fps);
            const lastIdx = seq[seq.length - 1];
            for (let r = 0; r < holdFrames; r++) seq.push(lastIdx);
        }

        if (seq.length > MAX_SEQ_FRAMES) seq = seq.slice(0, MAX_SEQ_FRAMES);

        return seq.length ? seq : [0];
    }

    // Deterministic pseudo-random 0..1, never Math.random() — the same
    // frame at the same sequence position must always get the same
    // noise/jitter, so re-encoding a clip reproduces byte-identical effects.
    function _seededNoise(seed) {
        const x = Math.sin(seed) * 10000;
        return x - Math.floor(x);
    }

    function cloneImageData(imageData) {
        return new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
    }

    function applyDeepFry(imageData, intensity) {
        const amt = Math.max(0, Math.min(100, intensity || 0)) / 100;
        if (amt <= 0) return imageData;
        const d = imageData.data;
        const contrast = 1 + amt * 1.5;
        const satBoost = 1 + amt * 1.2;
        const noiseAmt = amt * 40;
        for (let i = 0; i < d.length; i += 4) {
            let r = d[i], g = d[i + 1], b = d[i + 2];
            r = (r - 128) * contrast + 128;
            g = (g - 128) * contrast + 128;
            b = (b - 128) * contrast + 128;
            const gray = 0.299 * r + 0.587 * g + 0.114 * b;
            r = gray + (r - gray) * satBoost;
            g = gray + (g - gray) * satBoost;
            b = gray + (b - gray) * satBoost;
            const n = (_seededNoise(i * 0.9973 + 1) - 0.5) * noiseAmt;
            d[i]     = Math.max(0, Math.min(255, r + n));
            d[i + 1] = Math.max(0, Math.min(255, g + n));
            d[i + 2] = Math.max(0, Math.min(255, b + n));
        }
        return imageData;
    }

    function applyVhs(imageData, intensity, seqPosition) {
        const amt = Math.max(0, Math.min(100, intensity || 0)) / 100;
        if (amt <= 0) return imageData;
        const d = imageData.data, w = imageData.width, h = imageData.height;
        const shift = Math.round(amt * 4);
        const scanlineDark = amt * 0.35;
        const srcCopy = new Uint8ClampedArray(d);
        for (let y = 0; y < h; y++) {
            const rowJitter = shift > 0
                ? Math.round((_seededNoise(y * 12.9898 + seqPosition * 78.233) - 0.5) * amt * 6) : 0;
            for (let x = 0; x < w; x++) {
                const di = (y * w + x) * 4;
                const rx = Math.max(0, Math.min(w - 1, x - shift + rowJitter));
                const bx = Math.max(0, Math.min(w - 1, x + shift + rowJitter));
                const ri = (y * w + rx) * 4, bi = (y * w + bx) * 4;
                d[di]     = srcCopy[ri];
                d[di + 1] = srcCopy[di + 1];
                d[di + 2] = srcCopy[bi + 2];
                if (y % 2 === 0) {
                    d[di]     *= (1 - scanlineDark);
                    d[di + 1] *= (1 - scanlineDark);
                    d[di + 2] *= (1 - scanlineDark);
                }
            }
        }
        return imageData;
    }

    let _fxScratchCanvas = null;
    function getFxScratchCanvas(w, h) {
        if (!_fxScratchCanvas) _fxScratchCanvas = document.createElement('canvas');
        _fxScratchCanvas.width = w; _fxScratchCanvas.height = h;
        return _fxScratchCanvas;
    }
    let _fxOutCanvas = null;
    function getFxOutCanvas(w, h) {
        if (!_fxOutCanvas) _fxOutCanvas = document.createElement('canvas');
        _fxOutCanvas.width = w; _fxOutCanvas.height = h;
        return _fxOutCanvas;
    }
    function applyZoomShake(imageData, w, h, mode, intensity, seqPosition, seqLength) {
        const amt = Math.max(0, Math.min(100, intensity || 0)) / 100;
        if (amt <= 0) return imageData;
        const srcCanvas = getFxScratchCanvas(w, h);
        const sctx = srcCanvas.getContext('2d');
        sctx.putImageData(imageData, 0, 0);
        const out = getFxOutCanvas(w, h);
        const octx = out.getContext('2d');
        octx.clearRect(0, 0, w, h);
        if (mode === 'shake') {
            const dx = (_seededNoise(seqPosition * 17.23 + 3) - 0.5) * amt * 0.08 * w;
            const dy = (_seededNoise(seqPosition * 41.11 + 7) - 0.5) * amt * 0.08 * h;
            octx.drawImage(srcCanvas, dx, dy);
        } else {
            const progress = seqLength > 1 ? seqPosition / (seqLength - 1) : 0;
            const scale = 1 + progress * amt * 0.35;
            const sw = w / scale, sh = h / scale;
            const sx = (w - sw) / 2, sy = (h - sh) / 2;
            octx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, w, h);
        }
        return octx.getImageData(0, 0, w, h);
    }

    function applyFilters(imageData, w, h, filters, seqPosition, seqLength) {
        let out = imageData;
        if (filters && filters.zoomShake && filters.zoomShake.enabled) {
            out = applyZoomShake(out, w, h, filters.zoomShake.mode, filters.zoomShake.intensity, seqPosition, seqLength);
        }
        if (filters && filters.deepFry && filters.deepFry.enabled) {
            out = applyDeepFry(out, filters.deepFry.intensity);
        }
        if (filters && filters.vhs && filters.vhs.enabled) {
            out = applyVhs(out, filters.vhs.intensity, seqPosition);
        }
        return out;
    }

    const GIF_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js';
    let _gifWorkerBlobUrl = null;
    function getGifWorkerUrl() {
        if (_gifWorkerBlobUrl) return Promise.resolve(_gifWorkerBlobUrl);
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url: GIF_WORKER_URL,
                onload: r => {
                    if (r.status >= 200 && r.status < 300) {
                        _gifWorkerBlobUrl = URL.createObjectURL(
                            new Blob([r.responseText], { type: 'application/javascript' }));
                        resolve(_gifWorkerBlobUrl);
                    } else reject(new Error('worker HTTP ' + r.status));
                },
                onerror: () => reject(new Error('worker fetch failed')),
            });
        });
    }
    function getGifCtor() {
        if (typeof GIF !== 'undefined') return GIF;
        if (typeof window !== 'undefined' && window.GIF) return window.GIF;
        return null;
    }

    // gifsicle-wasm-browser is ~35x the size of gif.js — lazy-fetch it only
    // when a GIF is actually being optimized, never @require it. It assigns
    // a bare top-level `let gifsicle = {...}`; running its source inside a
    // Function body whose own last statement returns that binding captures
    // the export without touching any outer/global scope.
    const GIFSICLE_URL = 'https://cdn.jsdelivr.net/npm/gifsicle-wasm-browser@1.5.19/dist/gifsicle.min.js';
    let _gifsicleCtor = null;
    function getGifsicleCtor() {
        if (_gifsicleCtor) return Promise.resolve(_gifsicleCtor);
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url: GIFSICLE_URL,
                onload: r => {
                    if (r.status < 200 || r.status >= 300) { reject(new Error('gifsicle HTTP ' + r.status)); return; }
                    try {
                        // The bundle ends with a literal ES-module `export default gifsicle;`,
                        // which is a syntax error inside a Function body — strip it before
                        // executing; the preceding `let gifsicle = {...}` is plain classic-script
                        // code and is what our appended return statement actually captures.
                        const src = r.responseText.replace(/export\s+default\s+gifsicle\s*;?\s*$/, '');
                        _gifsicleCtor = new Function(src + '\n;return typeof gifsicle !== "undefined" ? gifsicle : null;')();
                        if (!_gifsicleCtor) { reject(new Error('gifsicle export not found')); return; }
                        resolve(_gifsicleCtor);
                    } catch (e) { reject(e); }
                },
                onerror: () => reject(new Error('gifsicle fetch failed')),
            });
        });
    }

    // Resolves one output position to a filtered frame. Clones the source
    // before filtering (only when a filter is actually enabled) because
    // boomerang/freeze-hold reuse the same sourceFrames[i] entry at
    // multiple sequence positions, and applyDeepFry/applyVhs mutate their
    // input in place — without the clone, a repeated frame would be
    // filtered again every time it recurs.
    function renderSequenceFrame(sourceFrames, sequence, i, w, h, filters) {
        const frameIndex = sequence[i];
        const source = sourceFrames[frameIndex];
        const hasAnyFilter = !!(filters && (
            (filters.zoomShake && filters.zoomShake.enabled) ||
            (filters.deepFry && filters.deepFry.enabled) ||
            (filters.vhs && filters.vhs.enabled)));
        if (!hasAnyFilter) return source;
        // applyZoomShake never mutates its input — it reads it via putImageData
        // and always returns a brand-new ImageData from a separate canvas — so
        // when zoom/shake is enabled it already guarantees a fresh, non-shared
        // buffer for the mutate-in-place filters (deepFry/vhs) that may run
        // after it. Only clone here when zoom/shake will NOT run, since in
        // that case the first filter to touch the frame would otherwise
        // mutate the shared sourceFrames[frameIndex] entry in place.
        const zoomShakeWillRun = !!(filters.zoomShake && filters.zoomShake.enabled && filters.zoomShake.intensity > 0);
        const input = zoomShakeWillRun ? source : cloneImageData(source);
        return applyFilters(input, w, h, filters, i, sequence.length);
    }

    function encodeGif({ frames, w, h, delay, playback, filters }, onProgress) {
        return getGifWorkerUrl().then(workerScript => new Promise((resolve, reject) => {
            const Ctor = getGifCtor();
            if (!Ctor) { reject(new Error('gif.js not loaded (@require missing?)')); return; }
            const gif = new Ctor({ workers: 2, quality: 10, width: w, height: h, workerScript, repeat: 0 });
            const sequence = buildPlaybackSequence(frames.length, playback || {});
            for (let i = 0; i < sequence.length; i++) {
                gif.addFrame(renderSequenceFrame(frames, sequence, i, w, h, filters || {}), { delay });
            }
            gif.on('progress', p => onProgress && onProgress(p));
            gif.on('finished', blob => resolve(blob));
            gif.on('abort', () => reject(new Error('encode aborted')));
            gif.render();
        }));
    }

    // Optional lossless size-shrink via gifsicle -O3, run after encodeGif().
    // Any failure anywhere in here falls back to the original blob silently
    // — this step is strictly additive and must never break Make GIF.
    async function maybeOptimizeGif(blob) {
        if (!gifOptimizeEnabled()) return blob;
        try {
            const gifsicle = await getGifsicleCtor();
            const out = await gifsicle.run({
                input: [{ file: blob, name: 'in.gif' }],
                command: ['-O3 in.gif -o /out/out.gif'],
            });
            return (out && out[0]) ? out[0] : blob;
        } catch (e) {
            console.warn('[GIFMaker] GIF optimize failed, using unoptimized output:', e);
            return blob;
        }
    }

    let _gifResultUrl = null;
    function _revokeGifResult() {
        if (_gifResultUrl) { URL.revokeObjectURL(_gifResultUrl); _gifResultUrl = null; }
    }

    /* ==========================================================
       SCRUB-BAR PREVIEW THUMBNAILS
       A persistent hidden clone, kept loaded while the panel is
       open so seeking start/end preview frames is fast (one
       decode, many seeks).
    ========================================================== */
    let _gifScrub = null;
    function getScrubClone(src) {
        if (_gifScrub && _gifScrub.src === src) return _gifScrub;
        destroyScrubClone();
        const vid = document.createElement('video');
        vid.crossOrigin = 'anonymous'; vid.muted = true; vid.preload = 'auto'; vid.playsInline = true;
        vid.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
        document.body.appendChild(vid);
        const ready = new Promise((resolve, reject) => {
            vid.addEventListener('loadedmetadata', () => resolve(), { once: true });
            vid.addEventListener('error', () => reject(new Error('preview load error (CORS/network)')), { once: true });
        });
        vid.src = src;
        _gifScrub = { vid, src, ready, busy: Promise.resolve() };
        return _gifScrub;
    }
    function destroyScrubClone() {
        if (_gifScrub) { try { _gifScrub.vid.remove(); } catch (e) {} _gifScrub = null; }
    }
    // Seeks are serialized through the clone's `busy` chain so rapid
    // nudges don't collide. A *paused* video usually hasn't painted the
    // seeked frame by the time 'seeked' fires (drawImage -> black), so
    // this briefly plays muted and captures the first presented frame
    // via requestVideoFrameCallback.
    function grabPreviewFrame(src, time, w) {
        const sc = getScrubClone(src);
        const run = sc.busy.then(() => sc.ready).then(() => new Promise((resolve, reject) => {
            const vid = sc.vid;
            let settled = false;
            const draw = () => {
                if (settled) return;
                settled = true;
                try {
                    const h = Math.max(2, Math.round(w * vid.videoHeight / vid.videoWidth));
                    const c = document.createElement('canvas');
                    c.width = w; c.height = h;
                    const ctx = c.getContext('2d');
                    ctx.drawImage(vid, 0, 0, w, h);
                    const url = c.toDataURL('image/jpeg', 0.72);
                    try { vid.pause(); } catch (e) {}
                    resolve(url);
                } catch (e) { try { vid.pause(); } catch (e2) {} reject(e); }
            };
            const onSeeked = () => {
                let ticks = 0;
                const onFrame = () => {
                    if (settled) return;
                    ticks++;
                    if (ticks < 2) { vid.requestVideoFrameCallback(onFrame); return; }
                    draw();
                };
                if ('requestVideoFrameCallback' in vid) vid.requestVideoFrameCallback(onFrame);
                vid.play().catch(() => {});
                setTimeout(() => { if (!settled) draw(); }, 1500);
            };
            vid.addEventListener('seeked', onSeeked, { once: true });
            setTimeout(() => { if (!settled) onSeeked(); }, 800);
            try { vid.currentTime = Math.max(0, time); } catch (e) { reject(e); }
        }));
        sc.busy = run.catch(() => {});
        return run;
    }

    /* ==========================================================
       IMGBB — upload/test
    ========================================================== */
    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result).split(',', 2)[1] || '');
            r.onerror = () => reject(new Error('read failed'));
            r.readAsDataURL(blob);
        });
    }

    async function uploadToImgbb(blob, apiKey, name) {
        const b64 = await blobToBase64(blob);
        let data = 'image=' + encodeURIComponent(b64);
        if (name) data += '&name=' + encodeURIComponent(name);
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://api.imgbb.com/1/upload?key=' + encodeURIComponent(apiKey),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                data,
                onload: r => {
                    let json = null;
                    try { json = JSON.parse(r.responseText); } catch (e) {}
                    if (r.status >= 200 && r.status < 300 && json && json.success && json.data && json.data.url) {
                        resolve(json.data.url);
                    } else {
                        const msg = (json && json.error && json.error.message)
                            ? json.error.message : ('HTTP ' + r.status);
                        reject(new Error(msg));
                    }
                },
                onerror: () => reject(new Error('network error')),
            });
        });
    }

    async function validateImgbbKey(apiKey) {
        // ImgBB has no key-check endpoint, so probe with a tiny 1x1 PNG upload.
        const onePx = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
        try {
            const res = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'POST',
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

    /* ==========================================================
       GIF PANEL
    ========================================================== */
    const MIN_CLIP_GAP = 0.1;
    const MAX_CLIP_LEN = 10;
    const FILMSTRIP_MARGIN = 3;
    const FILMSTRIP_MIN_WINDOW = 12;
    const FILMSTRIP_EDGE_PAD = 1;
    const FILMSTRIP_TILES = 10;
    const OVERVIEW_NUDGE_SEC = 1;
    const OVERVIEW_NUDGE_SEC_FAST = 10;
    const SELECTION_EDGE_ZONE_PX = 20;
    const SELECTION_AUTOSCROLL_STEP = 0.2;
    const SELECTION_AUTOSCROLL_INTERVAL_MS = 100;

    function openGifPanel(initialSec) {
        if (document.getElementById('sc-gif-panel')) return;
        injectPanelCss();

        const v0 = getPlayerVideoEl();
        const src = v0 && (v0.currentSrc || v0.src) || '';
        const isBlob = src.startsWith('blob:');
        const vidDur = (v0 && isFinite(v0.duration)) ? v0.duration : Infinity;
        const now = (typeof initialSec === 'number' && isFinite(initialSec))
            ? initialSec
            : (v0 ? v0.currentTime : 0);

        const DEFAULT_CLIP_LEN = 2;
        let startT = Math.max(0, now - DEFAULT_CLIP_LEN);
        let endT = Math.min(vidDur, startT + DEFAULT_CLIP_LEN);
        let _filmstripWindow = null; // { windowStart, windowEnd } — sticky across renders

        const panel = document.createElement('div');
        panel.id = 'sc-gif-panel';
        panel.innerHTML = `
            <div id="sc-gif-head">
                <span>Make GIF</span>
                <button id="sc-gif-close" type="button">✕</button>
            </div>
            <div id="sc-gif-body">
                <div class="sc-gif-card">
                <div class="sc-gif-overview">
                    <div class="sc-gif-overview-track" id="sc-gif-overview-track" tabindex="0">
                        <div class="sc-gif-overview-viewport" id="sc-gif-overview-viewport"></div>
                        <div class="sc-gif-overview-ghost" id="sc-gif-overview-ghost"></div>
                    </div>
                    <div class="sc-gif-overview-labels">
                        <span>0:00</span>
                        <span class="sc-gif-overview-current"><span id="sc-gif-overview-label">Currently editing:</span> <span id="sc-gif-overview-current" class="sc-gif-mono"></span><span id="sc-gif-overview-hint"></span></span>
                        <span>Window: <span id="sc-gif-filmstrip-range"></span></span>
                        <span id="sc-gif-overview-total"></span>
                    </div>
                </div>
                <div class="sc-gif-filmstrip">
                    <div class="sc-gif-filmstrip-strip" id="sc-gif-filmstrip-strip">
                        <div class="sc-gif-filmstrip-tiles" id="sc-gif-filmstrip-tiles"></div>
                        <div class="sc-gif-filmstrip-dim-left" id="sc-gif-filmstrip-dim-left"></div>
                        <div class="sc-gif-filmstrip-dim-right" id="sc-gif-filmstrip-dim-right"></div>
                        <div class="sc-gif-filmstrip-selection" id="sc-gif-filmstrip-selection"></div>
                        <div class="sc-gif-filmstrip-handle" id="sc-gif-filmstrip-handle-start" data-handle="start" title="Drag: start"><div class="sc-gif-filmstrip-handle-grip"></div></div>
                        <div class="sc-gif-filmstrip-handle" id="sc-gif-filmstrip-handle-end" data-handle="end" title="Drag: end"><div class="sc-gif-filmstrip-handle-grip"></div></div>
                    </div>
                </div>
                <div class="sc-gif-marks">
                    <div class="sc-gif-mark">
                        <div class="sc-gif-thumb" id="sc-gif-thumb-start">
                            <div class="sc-gif-cap sc-gif-cap-top" id="sc-gif-cap-top-start"></div>
                            <div class="sc-gif-cap sc-gif-cap-bottom" id="sc-gif-cap-bottom-start"></div>
                            <div class="sc-gif-cap-handle sc-gif-cap-handle-top" id="sc-gif-cap-handle-top-start" title="Drag top caption"></div>
                            <div class="sc-gif-cap-handle sc-gif-cap-handle-bottom" id="sc-gif-cap-handle-bottom-start" title="Drag bottom caption"></div>
                        </div>
                        <div class="sc-gif-mark-label">START · <span id="sc-gif-time-start"></span></div>
                        <div class="sc-gif-mark-btns">
                            <button type="button" data-act="start-current" title="Set start to current playback position">⤓ Now</button>
                            <button type="button" data-act="start-minus">−.5</button>
                            <button type="button" data-act="start-plus">+.5</button>
                        </div>
                    </div>
                    <div class="sc-gif-mark">
                        <div class="sc-gif-thumb sc-gif-thumb-readonly" id="sc-gif-thumb-end">
                            <div class="sc-gif-cap sc-gif-cap-top" id="sc-gif-cap-top-end"></div>
                            <div class="sc-gif-cap sc-gif-cap-bottom" id="sc-gif-cap-bottom-end"></div>
                        </div>
                        <div class="sc-gif-mark-label">END · <span id="sc-gif-time-end"></span></div>
                        <div class="sc-gif-mark-btns">
                            <button type="button" data-act="end-minus">−.5</button>
                            <button type="button" data-act="end-plus">+.5</button>
                        </div>
                    </div>
                </div>
                <div id="sc-gif-dur-line">Duration <b id="sc-gif-dur-val"></b></div>
                </div>
                <button type="button" class="sc-gif-mid-header" id="sc-gif-mid-header" aria-expanded="true">
                    <span>Captions &amp; Format</span>
                    <span class="sc-gif-mid-toggle" id="sc-gif-mid-toggle">▾</span>
                </button>
                <div class="sc-gif-cols" id="sc-gif-mid-body">
                    <div class="sc-gif-col-left">
                        <div class="sc-gif-captions">
                            <input type="text" id="sc-gif-cap-top" class="sc-gif-cap-input" placeholder="TOP TEXT (optional)" maxlength="120">
                            <input type="text" id="sc-gif-cap-bottom" class="sc-gif-cap-input sc-gif-cap-bottom-input" placeholder="BOTTOM TEXT (optional)" maxlength="120">
                            <div class="sc-gif-cap-color">
                                <label><input type="radio" name="sc-gif-cap-color" value="white" checked> White</label>
                                <label><input type="radio" name="sc-gif-cap-color" value="yellow"> Yellow</label>
                            </div>
                            <div class="sc-gif-cap-sizes">
                                <label>Top size <input type="number" id="sc-gif-cap-top-size" min="4" max="40" step="1" value="16">%</label>
                                <label>Bottom size <input type="number" id="sc-gif-cap-bottom-size" min="4" max="40" step="1" value="16">%</label>
                            </div>
                            <div class="sc-gif-cap-hint">Drag the dots on the START preview to position each caption.</div>
                        </div>
                    </div>
                    <div class="sc-gif-col-right">
                        <div class="sc-gif-opts">
                            <label>FPS
                                <select id="sc-gif-fps">
                                    <option value="8">8</option><option value="10">10</option>
                                    <option value="12" selected>12</option><option value="15">15</option>
                                </select>
                            </label>
                            <label>Width
                                <select id="sc-gif-width">
                                    <option value="320">320</option><option value="480" selected>480</option><option value="640">640</option>
                                </select>
                            </label>
                            <label>Shape
                                <select id="sc-gif-aspect">
                                    <option value="native">Native</option>
                                    <option value="crop" selected>4:3 Crop</option>
                                    <option value="fit">4:3 Bars</option>
                                </select>
                            </label>
                        </div>
                        <button type="button" class="sc-gif-fx-header" id="sc-gif-fx-header" aria-expanded="false">
                            <span>Effects</span>
                            <span class="sc-gif-fx-toggle" id="sc-gif-fx-toggle">▸</span>
                        </button>
                        <div class="sc-gif-fx" id="sc-gif-fx-body">
                            <div class="sc-gif-fx-row">
                                <label>Playback
                                    <select id="sc-gif-fx-mode">
                                        <option value="normal" selected>Normal</option>
                                        <option value="reverse">Reverse</option>
                                        <option value="boomerang">Boomerang</option>
                                    </select>
                                </label>
                                <label>Speed
                                    <select id="sc-gif-fx-speed">
                                        <option value="0.5">0.5x</option>
                                        <option value="1" selected>1x</option>
                                        <option value="1.5">1.5x</option>
                                        <option value="2">2x</option>
                                    </select>
                                </label>
                            </div>
                            <div class="sc-gif-fx-row">
                                <label>Freeze hold (ms)
                                    <input type="number" id="sc-gif-fx-freeze" min="0" max="3000" step="100" value="0">
                                </label>
                            </div>
                            <div class="sc-gif-fx-filters">
                                <div class="sc-gif-fx-filter">
                                    <input type="checkbox" id="sc-gif-fx-deepfry-on">
                                    <label for="sc-gif-fx-deepfry-on">Deep-fry</label>
                                    <input type="range" id="sc-gif-fx-deepfry-amt" min="0" max="100" value="60">
                                </div>
                                <div class="sc-gif-fx-filter">
                                    <input type="checkbox" id="sc-gif-fx-vhs-on">
                                    <label for="sc-gif-fx-vhs-on">VHS / glitch</label>
                                    <input type="range" id="sc-gif-fx-vhs-amt" min="0" max="100" value="60">
                                </div>
                                <div class="sc-gif-fx-filter">
                                    <input type="checkbox" id="sc-gif-fx-zoomshake-on">
                                    <label for="sc-gif-fx-zoomshake-on">Zoom/Shake</label>
                                    <select id="sc-gif-fx-zoomshake-mode">
                                        <option value="zoom" selected>Zoom-in</option>
                                        <option value="shake">Shake</option>
                                    </select>
                                    <input type="range" id="sc-gif-fx-zoomshake-amt" min="0" max="100" value="60">
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div id="sc-gif-status"></div>
                <div id="sc-gif-result"></div>
                <button id="sc-gif-go" type="button">● Make GIF</button>
                ${PC_MODE ? '' : `
                <div class="sc-gif-card">
                <div class="sc-gif-imgbb-row" id="sc-gif-imgbb-row">
                    <button type="button" class="sc-gif-imgbb-header" id="sc-gif-imgbb-header" aria-expanded="false">
                        <span class="sc-gif-imgbb-label">ImgBB key (for Upload)</span>
                        <span class="sc-gif-imgbb-toggle" id="sc-gif-imgbb-toggle">▸</span>
                    </button>
                    <div class="sc-gif-imgbb-body" id="sc-gif-imgbb-body">
                        <div class="sc-gif-imgbb-input-row">
                            <input type="text" id="sc-gif-imgbb-key" class="sc-gif-cap-input sc-gif-imgbb-input"
                                placeholder="Paste ImgBB API key…" value="${_escHtml(getKey(LS_IMGBB))}" spellcheck="false" />
                            <button id="sc-gif-imgbb-test" class="sc-gif-imgbb-test-btn" type="button">Test</button>
                        </div>
                        <span id="sc-gif-imgbb-status" class="sc-gif-imgbb-status"></span>
                    </div>
                </div>
                <div class="sc-gif-optimize-row">
                    <input type="checkbox" id="sc-gif-optimize" ${gifOptimizeEnabled() ? 'checked' : ''} />
                    <label for="sc-gif-optimize">Optimize GIF before upload</label>
                </div>
                </div>
                `}
            </div>`;
        document.body.appendChild(panel);

        const $ = id => panel.querySelector(id);
        const goBtn = $('#sc-gif-go'), status = $('#sc-gif-status'), result = $('#sc-gif-result');
        $('#sc-gif-overview-total').textContent = isFinite(vidDur) ? _fmtClockTenths(vidDur) : '';
        const optimizeCheckbox = $('#sc-gif-optimize');
        if (optimizeCheckbox) {
            optimizeCheckbox.addEventListener('change', () => {
                setKey(LS_GIF_OPTIMIZE, optimizeCheckbox.checked ? 'on' : 'off');
            });
        }
        const setStatus = (txt) => { status.textContent = txt || ''; };

        const close = () => {
            clearTimeout(_filmstripTimer);
            Object.values(thumbTimers).forEach(clearTimeout);
            stopSelectionAutoScroll();
            _revokeGifResult(); destroyScrubClone(); panel.remove();
        };
        $('#sc-gif-close').addEventListener('click', close);

        const imgbbRow = $('#sc-gif-imgbb-row');
        const imgbbHeader = $('#sc-gif-imgbb-header');
        const imgbbToggle = $('#sc-gif-imgbb-toggle');
        if (imgbbHeader) {
            imgbbHeader.addEventListener('click', () => {
                const open = imgbbRow.classList.toggle('sc-gif-imgbb-open');
                imgbbToggle.textContent = open ? '▾' : '▸';
                imgbbHeader.setAttribute('aria-expanded', String(open));
            });
        }

        const fxHeader = $('#sc-gif-fx-header');
        const fxToggle = $('#sc-gif-fx-toggle');
        const fxBodyEl = $('#sc-gif-fx-body');
        fxHeader.addEventListener('click', () => {
            const open = fxBodyEl.classList.toggle('sc-gif-fx-open');
            fxToggle.textContent = open ? '▾' : '▸';
            fxHeader.setAttribute('aria-expanded', String(open));
        });

        const midHeader = $('#sc-gif-mid-header');
        const midToggle = $('#sc-gif-mid-toggle');
        const midBody = $('#sc-gif-mid-body');
        midHeader.addEventListener('click', () => {
            const collapsed = midBody.classList.toggle('sc-gif-mid-collapsed');
            midToggle.textContent = collapsed ? '▸' : '▾';
            midHeader.setAttribute('aria-expanded', String(!collapsed));
        });

        const imgbbInput = $('#sc-gif-imgbb-key');
        const imgbbStatus = $('#sc-gif-imgbb-status');
        const imgbbTestBtn = $('#sc-gif-imgbb-test');
        if (imgbbInput) {
            imgbbInput.addEventListener('change', () => setKey(LS_IMGBB, imgbbInput.value.trim()));
            imgbbTestBtn.addEventListener('click', async () => {
                const key = imgbbInput.value.trim();
                if (!key) { imgbbStatus.textContent = 'Enter an API key first'; imgbbStatus.className = 'sc-gif-imgbb-status sc-test-bad'; return; }
                imgbbTestBtn.disabled = true;
                imgbbStatus.textContent = 'Checking…'; imgbbStatus.className = 'sc-gif-imgbb-status sc-test-pending';
                const verdict = await validateImgbbKey(key);
                imgbbTestBtn.disabled = false;
                if (verdict === 'valid') {
                    imgbbStatus.textContent = '✓ Valid API key'; imgbbStatus.className = 'sc-gif-imgbb-status sc-test-ok';
                    setKey(LS_IMGBB, key);
                } else if (verdict === 'invalid') {
                    imgbbStatus.textContent = '✗ Invalid API key'; imgbbStatus.className = 'sc-gif-imgbb-status sc-test-bad';
                } else {
                    imgbbStatus.textContent = '⚠ Couldn\'t reach ImgBB'; imgbbStatus.className = 'sc-gif-imgbb-status sc-test-bad';
                }
            });
        }

        const head = $('#sc-gif-head');
        let dragging = false, dragDX = 0, dragDY = 0;
        const setPanelPos = (prop, val) => panel.style.setProperty(prop, val, 'important');
        head.addEventListener('pointerdown', (e) => {
            if (e.target.closest('#sc-gif-close')) return;
            const rect = panel.getBoundingClientRect();
            setPanelPos('left', rect.left + 'px');
            setPanelPos('top', rect.top + 'px');
            setPanelPos('transform', 'none');
            dragDX = e.clientX - rect.left;
            dragDY = e.clientY - rect.top;
            dragging = true;
            head.classList.add('sc-gif-dragging');
            head.setPointerCapture(e.pointerId);
        });
        head.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const rect = panel.getBoundingClientRect();
            const x = Math.min(Math.max(e.clientX - dragDX, -(rect.width - 40)), window.innerWidth - 40);
            const y = Math.min(Math.max(e.clientY - dragDY, 0), window.innerHeight - 32);
            setPanelPos('left', x + 'px');
            setPanelPos('top', y + 'px');
        });
        const endDrag = (e) => {
            dragging = false;
            head.classList.remove('sc-gif-dragging');
            try { head.releasePointerCapture(e.pointerId); } catch (err) {}
        };
        head.addEventListener('pointerup', endDrag);
        head.addEventListener('pointercancel', endDrag);

        if (isBlob || !src) {
            setStatus(isBlob
                ? 'This source is a streaming (HLS/MSE) blob — frame capture not supported.'
                : 'No video source found.');
        }

        const aspectSel = $('#sc-gif-aspect');
        const applyThumbAspect = () => {
            const mode = aspectSel.value;
            ['start', 'end'].forEach(which => {
                const el = $('#sc-gif-thumb-' + which);
                el.classList.toggle('sc-gif-thumb-43', mode !== 'native');
                el.classList.toggle('sc-gif-thumb-fit', mode === 'fit');
            });
        };
        aspectSel.addEventListener('change', () => { applyThumbAspect(); renderCaptionPreviews(); });
        applyThumbAspect();

        const capTopInput = $('#sc-gif-cap-top');
        const capBottomInput = $('#sc-gif-cap-bottom');
        const capSizeInputs = { top: $('#sc-gif-cap-top-size'), bottom: $('#sc-gif-cap-bottom-size') };
        const getCapColor = () => (panel.querySelector('input[name="sc-gif-cap-color"]:checked') || {}).value || 'white';
        const getCapSizePct = (key) => Math.max(1, parseFloat(capSizeInputs[key].value) || 16);
        const clampPct = (n) => Math.min(100, Math.max(0, isFinite(n) ? n : 50));
        const capPos = { top: { x: 50, y: 10 }, bottom: { x: 50, y: 90 } };

        function renderCaptionPreview(which) {
            const thumb = $('#sc-gif-thumb-' + which);
            const w = thumb.clientWidth, h = thumb.clientHeight;
            const color = getCapColor();
            ['top', 'bottom'].forEach(key => {
                const el = $('#sc-gif-cap-' + key + '-' + which);
                const text = (key === 'top' ? capTopInput : capBottomInput).value.trim();
                const pos = capPos[key];
                thumb.style.setProperty('--cx-' + key, pos.x + '%');
                thumb.style.setProperty('--cy-' + key, pos.y + '%');
                el.classList.toggle('sc-gif-cap-yellow', color === 'yellow');
                if (!text || !w || !h) { el.textContent = ''; return; }
                const fontPx = Math.max(4, Math.round(h * getCapSizePct(key) / 100));
                const { lines } = wrapCaptionAtSize(getCaptionMeasureCtx(), text.toUpperCase(), fontPx, w * 0.92);
                el.style.fontSize = fontPx + 'px';
                el.style.lineHeight = Math.round(fontPx * 1.15) + 'px';
                el.textContent = lines.join('\n');
            });
        }
        function renderCaptionPreviews() { renderCaptionPreview('start'); renderCaptionPreview('end'); }
        capTopInput.addEventListener('input', renderCaptionPreviews);
        capBottomInput.addEventListener('input', renderCaptionPreviews);
        capSizeInputs.top.addEventListener('input', renderCaptionPreviews);
        capSizeInputs.bottom.addEventListener('input', renderCaptionPreviews);
        panel.querySelectorAll('input[name="sc-gif-cap-color"]').forEach(r => r.addEventListener('change', renderCaptionPreviews));

        function wireCapHandle(handleEl, thumbEl, key) {
            let dragging = false;
            const move = (e) => {
                if (!dragging) return;
                const rect = thumbEl.getBoundingClientRect();
                capPos[key].x = clampPct(((e.clientX - rect.left) / rect.width) * 100);
                capPos[key].y = clampPct(((e.clientY - rect.top) / rect.height) * 100);
                renderCaptionPreviews();
            };
            handleEl.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                dragging = true;
                handleEl.setPointerCapture(e.pointerId);
            });
            handleEl.addEventListener('pointermove', move);
            const endHandleDrag = (e) => {
                dragging = false;
                try { handleEl.releasePointerCapture(e.pointerId); } catch (err) {}
            };
            handleEl.addEventListener('pointerup', endHandleDrag);
            handleEl.addEventListener('pointercancel', endHandleDrag);
        }
        ['top', 'bottom'].forEach(key => {
            wireCapHandle($('#sc-gif-cap-handle-' + key + '-start'), $('#sc-gif-thumb-start'), key);
        });

        renderCaptionPreviews();

        const fx = {
            mode: 'normal', speed: 1, freezeHoldMs: 0,
            deepFry: { enabled: false, intensity: 60 },
            vhs: { enabled: false, intensity: 60 },
            zoomShake: { enabled: false, mode: 'zoom', intensity: 60 },
        };
        const fxModeSel = $('#sc-gif-fx-mode'), fxSpeedSel = $('#sc-gif-fx-speed'), fxFreezeInput = $('#sc-gif-fx-freeze');
        const fxDeepFryOn = $('#sc-gif-fx-deepfry-on'), fxDeepFryAmt = $('#sc-gif-fx-deepfry-amt');
        const fxVhsOn = $('#sc-gif-fx-vhs-on'), fxVhsAmt = $('#sc-gif-fx-vhs-amt');
        const fxZsOn = $('#sc-gif-fx-zoomshake-on'), fxZsMode = $('#sc-gif-fx-zoomshake-mode'), fxZsAmt = $('#sc-gif-fx-zoomshake-amt');

        function syncFxState() {
            fx.mode = fxModeSel.value;
            fx.speed = parseFloat(fxSpeedSel.value) || 1;
            fx.freezeHoldMs = Math.max(0, parseInt(fxFreezeInput.value, 10) || 0);
            fx.deepFry.enabled = fxDeepFryOn.checked;
            fx.deepFry.intensity = parseInt(fxDeepFryAmt.value, 10) || 0;
            fx.vhs.enabled = fxVhsOn.checked;
            fx.vhs.intensity = parseInt(fxVhsAmt.value, 10) || 0;
            fx.zoomShake.enabled = fxZsOn.checked;
            fx.zoomShake.mode = fxZsMode.value;
            fx.zoomShake.intensity = parseInt(fxZsAmt.value, 10) || 0;
        }
        [fxModeSel, fxSpeedSel, fxFreezeInput, fxDeepFryOn, fxDeepFryAmt, fxVhsOn, fxVhsAmt, fxZsOn, fxZsMode, fxZsAmt]
            .forEach(el => el.addEventListener('input', syncFxState));
        syncFxState();

        const thumbTimers = {};
        const refreshThumb = (which) => {
            if (isBlob || !src) return;
            const t = which === 'start' ? startT : endT;
            const el = $('#sc-gif-thumb-' + which);
            clearTimeout(thumbTimers[which]);
            el.classList.add('sc-gif-thumb-loading');
            thumbTimers[which] = setTimeout(() => {
                grabPreviewFrame(src, t, 160).then(url => {
                    el.style.backgroundImage = `url("${url}")`;
                    el.classList.remove('sc-gif-thumb-loading');
                }).catch(() => el.classList.remove('sc-gif-thumb-loading'));
            }, 180);
        };

        const filmstripStrip = $('#sc-gif-filmstrip-strip');
        const filmstripHandleStart = $('#sc-gif-filmstrip-handle-start');
        const filmstripHandleEnd = $('#sc-gif-filmstrip-handle-end');
        let _filmstripTimer = null;
        let _tilesWindowKey = null; // the window the on-screen tiles currently show

        const overviewTrack = $('#sc-gif-overview-track');
        const overviewViewport = $('#sc-gif-overview-viewport');
        const overviewGhost = $('#sc-gif-overview-ghost');
        const overviewCurrent = $('#sc-gif-overview-current');
        const overviewLabel = $('#sc-gif-overview-label');
        const overviewHint = $('#sc-gif-overview-hint');
        let overviewDragging = false;

        for (let i = 0; i < FILMSTRIP_TILES; i++) {
            const tile = document.createElement('div');
            tile.className = 'sc-gif-filmstrip-tile';
            $('#sc-gif-filmstrip-tiles').appendChild(tile);
        }

        // Return value is advisory only — tile refetching is decided by
        // refetchFilmstripTiles() via _tilesWindowKey, not by this return value.
        function ensureFilmstripWindow() {
            const needsReframe = !_filmstripWindow ||
                startT < _filmstripWindow.windowStart + FILMSTRIP_EDGE_PAD ||
                endT   > _filmstripWindow.windowEnd   - FILMSTRIP_EDGE_PAD;
            if (!needsReframe) return false;

            const span = Math.max(FILMSTRIP_MIN_WINDOW, (endT - startT) + FILMSTRIP_MARGIN * 2);
            let windowStart = Math.max(0, startT - FILMSTRIP_MARGIN);
            if (isFinite(vidDur)) windowStart = Math.min(windowStart, Math.max(0, vidDur - span));
            const windowEnd = isFinite(vidDur) ? Math.min(vidDur, windowStart + span) : windowStart + span;

            const changed = !_filmstripWindow ||
                _filmstripWindow.windowStart !== windowStart ||
                _filmstripWindow.windowEnd   !== windowEnd;
            _filmstripWindow = { windowStart, windowEnd };
            return changed;
        }

        function renderFilmstripHandles() {
            const win = _filmstripWindow;
            if (!win) return;
            const pctFor = t => Math.max(0, Math.min(100,
                ((t - win.windowStart) / (win.windowEnd - win.windowStart)) * 100));
            const sp = pctFor(startT), ep = pctFor(endT);
            filmstripHandleStart.style.left = sp + '%';
            filmstripHandleEnd.style.left = ep + '%';
            $('#sc-gif-filmstrip-dim-left').style.width = sp + '%';
            $('#sc-gif-filmstrip-dim-right').style.width = (100 - ep) + '%';
            const selection = $('#sc-gif-filmstrip-selection');
            selection.style.left = sp + '%';
            selection.style.width = (ep - sp) + '%';
            $('#sc-gif-filmstrip-range').textContent =
                _fmtClockTenths(win.windowStart) + ' – ' + _fmtClockTenths(win.windowEnd);

            if (isFinite(vidDur) && vidDur > 0) {
                const ovStart = (win.windowStart / vidDur) * 100;
                const ovEnd = (win.windowEnd / vidDur) * 100;
                overviewViewport.style.left = ovStart + '%';
                overviewViewport.style.width = Math.max(0.5, ovEnd - ovStart) + '%';
            }
            if (!overviewDragging) {
                overviewLabel.textContent = 'Currently editing:';
                overviewCurrent.textContent = _fmtClockTenths(startT);
                overviewHint.textContent = '';
            }
        }

        function refetchFilmstripTiles() {
            const win = _filmstripWindow;
            if (!win || isBlob || !src) return;
            const key = win.windowStart + '|' + win.windowEnd;
            if (key === _tilesWindowKey) return; // tiles already match this window
            _tilesWindowKey = key;
            const tiles = [...panel.querySelectorAll('.sc-gif-filmstrip-tile')];
            const span = win.windowEnd - win.windowStart;
            tiles.forEach((tile, i) => {
                const t = win.windowStart + (i + 0.5) * span / FILMSTRIP_TILES;
                tile.classList.add('sc-gif-thumb-loading');
                grabPreviewFrame(src, t, 64).then(url => {
                    tile.style.backgroundImage = `url("${url}")`;
                    tile.classList.remove('sc-gif-thumb-loading');
                }).catch(() => tile.classList.remove('sc-gif-thumb-loading'));
            });
        }

        function scheduleFilmstripRefresh() {
            renderFilmstripHandles(); // cheap; keep the handles live even mid-debounce
            clearTimeout(_filmstripTimer);
            _filmstripTimer = setTimeout(() => {
                ensureFilmstripWindow();
                renderFilmstripHandles();
                refetchFilmstripTiles();
            }, 220);
        }

        function wireFilmstripDrag(handleEl, which) {
            let dragging = false;
            handleEl.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                dragging = true;
                handleEl.setPointerCapture(e.pointerId);
            });
            handleEl.addEventListener('pointermove', (e) => {
                if (!dragging || !_filmstripWindow) return;
                const win = _filmstripWindow;
                const rect = filmstripStrip.getBoundingClientRect();
                const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                const t = win.windowStart + pct * (win.windowEnd - win.windowStart);
                if (which === 'start') { startT = t; clampStart(); render('start'); }
                else { endT = t; clampEnd(); render('end'); }
            });
            const endDrag = (e) => {
                dragging = false;
                try { handleEl.releasePointerCapture(e.pointerId); } catch (err) {}
            };
            handleEl.addEventListener('pointerup', endDrag);
            handleEl.addEventListener('pointercancel', endDrag);
        }
        wireFilmstripDrag(filmstripHandleStart, 'start');
        wireFilmstripDrag(filmstripHandleEnd, 'end');

        let selectionDragging = false;
        let selectionDragStartX = 0;
        let selectionDragStartT0 = 0; // startT captured at pointerdown
        let selectionAutoScrollTimer = null;
        let selectionAutoScrollDir = 0; // -1 (backward), 0 (idle), 1 (forward)

        function selectionShiftTo(newStart) {
            const dur = endT - startT;
            newStart = Math.max(0, Math.min(newStart, Math.max(0, vidDur - dur)));
            startT = newStart;
            endT = startT + dur;
            render('both');
        }
        function stopSelectionAutoScroll() {
            if (selectionAutoScrollTimer) { clearInterval(selectionAutoScrollTimer); selectionAutoScrollTimer = null; }
            selectionAutoScrollDir = 0;
        }
        function startSelectionAutoScroll(dir) {
            if (selectionAutoScrollDir === dir) return;
            stopSelectionAutoScroll();
            selectionAutoScrollDir = dir;
            selectionAutoScrollTimer = setInterval(() => {
                selectionShiftTo(startT + dir * SELECTION_AUTOSCROLL_STEP);
                // render('both') above only re-arms the 220ms tile-refetch
                // debounce, which this 100ms tick perpetually resets, so the
                // filmstrip window itself would never reframe during a
                // sustained hold. Force the cheap (no-network) reframe/
                // reposition every tick so the visible window actually pans;
                // tile thumbnails stay on the existing debounce and catch up
                // shortly after the hold ends, same as they already do for a
                // fast handle drag.
                ensureFilmstripWindow();
                renderFilmstripHandles();
            }, SELECTION_AUTOSCROLL_INTERVAL_MS);
        }

        const selectionEl = $('#sc-gif-filmstrip-selection');
        selectionEl.addEventListener('pointerdown', (e) => {
            if (isBlob || !src || !isFinite(vidDur)) return;
            if (e.button !== 0) return;
            e.stopPropagation();
            selectionDragging = true;
            selectionDragStartX = e.clientX;
            selectionDragStartT0 = startT;
            selectionEl.setPointerCapture(e.pointerId);
        });
        selectionEl.addEventListener('pointermove', (e) => {
            if (!selectionDragging || !_filmstripWindow) return;
            const rect = filmstripStrip.getBoundingClientRect();
            if (e.clientX <= rect.left + SELECTION_EDGE_ZONE_PX) { startSelectionAutoScroll(-1); return; }
            if (e.clientX >= rect.right - SELECTION_EDGE_ZONE_PX) { startSelectionAutoScroll(1); return; }
            if (selectionAutoScrollDir !== 0) {
                // Leaving the edge zone after auto-scrolling -- resync the drag
                // anchor to the current pointer position/time. Without this,
                // the delta below would be computed against the position the
                // drag originally started at, snapping the clip back to
                // wherever it was before auto-scroll ran and discarding all
                // of that movement.
                selectionDragStartX = e.clientX;
                selectionDragStartT0 = startT;
            }
            stopSelectionAutoScroll();
            const win = _filmstripWindow;
            const deltaPx = e.clientX - selectionDragStartX;
            const deltaSec = deltaPx / rect.width * (win.windowEnd - win.windowStart);
            selectionShiftTo(selectionDragStartT0 + deltaSec);
        });
        function endSelectionDrag(e) {
            selectionDragging = false;
            stopSelectionAutoScroll();
            try { selectionEl.releasePointerCapture(e.pointerId); } catch (err) {}
        }
        selectionEl.addEventListener('pointerup', endSelectionDrag);
        selectionEl.addEventListener('pointercancel', endSelectionDrag);
        selectionEl.addEventListener('lostpointercapture', endSelectionDrag);

        function overviewTimeFromEvent(e) {
            const rect = overviewTrack.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            return pct * vidDur;
        }
        overviewTrack.addEventListener('pointerdown', (e) => {
            if (isBlob || !src || !isFinite(vidDur)) return;
            if (e.button !== 0) return; // ignore right-click/middle-click; pen and touch report button 0 on pointerdown
            e.stopPropagation();
            overviewDragging = true;
            overviewTrack.setPointerCapture(e.pointerId);
            overviewGhost.style.setProperty('display', 'block', 'important');
            overviewGhost.style.left = (overviewTimeFromEvent(e) / vidDur * 100) + '%';
        });
        overviewTrack.addEventListener('pointermove', (e) => {
            if (!overviewDragging) return;
            const t = overviewTimeFromEvent(e);
            overviewGhost.style.left = (t / vidDur * 100) + '%';
            overviewLabel.textContent = 'Jump to:';
            overviewCurrent.textContent = _fmtClockTenths(t);
            overviewHint.textContent = ' (release to commit)';
        });
        function overviewCommit(e) {
            if (!overviewDragging) return;
            overviewDragging = false;
            overviewGhost.style.setProperty('display', 'none', 'important');
            try { overviewTrack.releasePointerCapture(e.pointerId); } catch (err) {}
            const t = overviewTimeFromEvent(e);
            startT = Math.max(0, t - DEFAULT_CLIP_LEN / 2);
            endT = Math.min(vidDur, startT + DEFAULT_CLIP_LEN);
            clampStart();
            clampEnd();
            render('both');
        }
        overviewTrack.addEventListener('pointerup', overviewCommit);
        overviewTrack.addEventListener('pointercancel', (e) => {
            overviewDragging = false;
            overviewGhost.style.setProperty('display', 'none', 'important');
            try { overviewTrack.releasePointerCapture(e.pointerId); } catch (err) {}
            renderFilmstripHandles(); // restore the "Currently editing" label, no jump
        });
        overviewTrack.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault(); // arrows would otherwise scroll the page/chat behind the panel
            e.stopPropagation(); // stop cytube.pc.user.js's document-level arrow-key video-seek handler from also firing, even in the disabled-state branch below
            if (isBlob || !src || !isFinite(vidDur)) return;
            const step = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? OVERVIEW_NUDGE_SEC_FAST : OVERVIEW_NUDGE_SEC);
            const dur = endT - startT;
            // Deliberately bypasses clampStart()/clampEnd() -- those can change
            // dur (MAX_CLIP_LEN/MIN_CLIP_GAP), but a nudge must never alter the
            // clip's length, only its position.
            let newStart = startT + step;
            newStart = Math.max(0, Math.min(newStart, Math.max(0, vidDur - dur)));
            startT = newStart;
            endT = startT + dur;
            render('both');
        });

        const render = (changed) => {
            $('#sc-gif-time-start').textContent = _fmtClockTenths(startT);
            $('#sc-gif-time-end').textContent = _fmtClockTenths(endT);
            const dur = Math.max(0, endT - startT);
            $('#sc-gif-dur-val').textContent = dur.toFixed(1) + 's';
            goBtn.disabled = isBlob || !src || dur < MIN_CLIP_GAP;
            if (changed === 'start' || changed === 'both') refreshThumb('start');
            if (changed === 'end' || changed === 'both') refreshThumb('end');
            scheduleFilmstripRefresh();
        };

        const clampStart = () => {
            startT = Math.max(0, startT);
            if (isFinite(vidDur)) startT = Math.min(startT, vidDur - MIN_CLIP_GAP);
            if (endT - startT < MIN_CLIP_GAP) startT = Math.max(0, endT - MIN_CLIP_GAP);
            if (endT - startT > MAX_CLIP_LEN) startT = endT - MAX_CLIP_LEN;
        };
        const clampEnd = () => {
            endT = Math.max(endT, startT + MIN_CLIP_GAP);
            if (isFinite(vidDur)) endT = Math.min(endT, vidDur);
            if (endT - startT > MAX_CLIP_LEN) endT = startT + MAX_CLIP_LEN;
        };

        panel.querySelector('.sc-gif-marks').addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-act]');
            if (!btn) return;
            const live = getPlayerVideoEl();
            const cur = live ? live.currentTime : 0;
            switch (btn.dataset.act) {
                case 'start-current': startT = cur; clampStart(); render('start'); break;
                case 'start-minus':   startT -= 0.5; clampStart(); render('start'); break;
                case 'start-plus':    startT += 0.5; clampStart(); render('start'); break;
                case 'end-minus':     endT -= 0.5; clampEnd(); render('end'); break;
                case 'end-plus':      endT += 0.5; clampEnd(); render('end'); break;
            }
        });

        goBtn.addEventListener('click', async () => {
            if (isBlob || !src) return;
            const fps    = parseInt($('#sc-gif-fps').value, 10);
            const width  = parseInt($('#sc-gif-width').value, 10);
            const aspect = $('#sc-gif-aspect').value;
            const captions = {
                color: getCapColor(),
                top: { text: capTopInput.value.trim(), size: getCapSizePct('top'), x: capPos.top.x, y: capPos.top.y },
                bottom: { text: capBottomInput.value.trim(), size: getCapSizePct('bottom'), x: capPos.bottom.x, y: capPos.bottom.y },
            };
            if (endT - startT < MIN_CLIP_GAP) { setStatus('End must be after start.'); return; }
            const clipStartForName = startT;
            const tagEl = $('#sc-gif-tag');
            const clipTagForName = tagEl ? tagEl.value.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') : '';
            if (!midBody.classList.contains('sc-gif-mid-collapsed')) {
                midBody.classList.add('sc-gif-mid-collapsed');
                midToggle.textContent = '▸';
                midHeader.setAttribute('aria-expanded', 'false');
            }

            _revokeGifResult();
            result.innerHTML = '<div class="sc-gif-working"><span class="sc-gif-spinner"></span><span id="sc-gif-working-txt">Capturing frames…</span></div>';
            const workTxt = $('#sc-gif-working-txt');
            const setWork = (t) => { if (workTxt) workTxt.textContent = t; };
            goBtn.disabled = true;
            try {
                setStatus('');
                const cap = await captureGifFrames(
                    { src, startT, endT, fps, width, aspect, captions },
                    p => setWork('Capturing frames… ' + Math.round(p * 100) + '%'));
                syncFxState();
                const playback = { mode: fx.mode, speed: fx.speed, freezeHoldMs: fx.freezeHoldMs, fps };
                const filters = { deepFry: fx.deepFry, vhs: fx.vhs, zoomShake: fx.zoomShake };
                setWork('Encoding GIF… (' + cap.frames.length + ' frames)');
                let blob = await encodeGif({ ...cap, playback, filters }, p => setWork('Encoding GIF… ' + Math.round(p * 100) + '%'));
                if (gifOptimizeEnabled()) setWork('Optimizing…');
                blob = await maybeOptimizeGif(blob);
                _gifResultUrl = URL.createObjectURL(blob);
                const kb = Math.round(blob.size / 1024);
                const slug = activeTitleSlug();
                const fnameBase = (slug || 'gif') + '-' + _fmtFilenameTimestamp(clipStartForName) + (clipTagForName ? '-' + clipTagForName : '');
                const fname = fnameBase + '.gif';
                const hasImgbbKey = !!getKey(LS_IMGBB);
                result.innerHTML =
                    `<img src="${_gifResultUrl}" alt="GIF preview">` +
                    `<div id="sc-gif-actions">` +
                    `<a id="sc-gif-dl" href="${_gifResultUrl}" download="${_escHtml(fname)}">⬇ Download</a>` +
                    (hasImgbbKey ? `<button id="sc-gif-upload" type="button">☁ Upload</button>` : '') +
                    `<input type="text" id="sc-gif-tag" class="sc-gif-tag-input" placeholder="tag" maxlength="40">` +
                    `<span id="sc-gif-size">${kb} KB</span></div>` +
                    (hasImgbbKey ? `<div id="sc-gif-link"></div>` : '');
                setStatus('Done.');
                result.scrollIntoView({ block: 'nearest' });

                const uploadBtn = hasImgbbKey ? $('#sc-gif-upload') : null;
                if (uploadBtn) uploadBtn.addEventListener('click', async () => {
                    const linkBox = $('#sc-gif-link');
                    const apiKey = getKey(LS_IMGBB);
                    if (!apiKey) {
                        linkBox.innerHTML = '<span class="sc-gif-link-msg">Add an ImgBB API key above to enable uploads.</span>';
                        return;
                    }
                    uploadBtn.disabled = true;
                    linkBox.innerHTML = '<span class="sc-gif-spinner sc-gif-spinner-sm"></span><span class="sc-gif-link-msg">Uploading to ImgBB…</span>';
                    try {
                        const link = await uploadToImgbb(blob, apiKey, fnameBase);
                        linkBox.innerHTML =
                            `<a class="sc-gif-link-url" href="${_escHtml(link)}" target="_blank" rel="noopener">${_escHtml(link)}</a>` +
                            `<button id="sc-gif-copylink" type="button">⧉ Copy link</button>`;
                        uploadBtn.textContent = '✓ Uploaded';
                        try { await navigator.clipboard.writeText(link); } catch (e) {}
                        const cl = $('#sc-gif-copylink');
                        if (cl) cl.addEventListener('click', async () => {
                            try { await navigator.clipboard.writeText(link); cl.textContent = '✓ Copied'; }
                            catch (e) { cl.textContent = '✗'; }
                        });
                    } catch (e) {
                        linkBox.innerHTML = '<span class="sc-gif-link-msg sc-test-bad">Upload failed: ' + _escHtml(e.message || String(e)) + '</span>';
                        uploadBtn.disabled = false;
                    }
                });
            } catch (e) {
                console.error('[GIFMaker] GIF capture failed:', e);
                result.innerHTML = '';
                setStatus('Failed: ' + (e.message || e));
            } finally {
                goBtn.disabled = false;
            }
        });

        ensureFilmstripWindow();
        render('both');
    }

    /* ==========================================================
       RECORD BUTTON
       Standalone (no cytube.pc.user.js detected): attached into
       CyTube's own #videocontrols .btn-group (the reload/fullscreen/
       voteskip row under the player), styled with CyTube's native
       .btn.btn-sm.btn-default so it reads as one of the built-in
       controls rather than an overlay.

       PC mode (cytube.pc.user.js detected): a floating #sc-gif-btn,
       matching cytube.pc.user.js's own former floating GIF button
       exactly (same id/style/position), so it participates in that
       script's existing auto-dim-on-inactivity system with no
       changes needed there.
    ========================================================== */
    function injectFloatingButtonCss() {
        if (document.getElementById('scgm-floatbtn-style')) return;
        const style = document.createElement('style');
        style.id = 'scgm-floatbtn-style';
        style.textContent = `
            #sc-gif-btn {
                position: fixed !important;
                z-index: 20002 !important;
                background: rgba(255,255,255,0.08) !important;
                color: rgba(255,255,255,0.55) !important;
                border: 1px solid rgba(255,255,255,0.18) !important;
                border-radius: 50% !important;
                width: 28px !important; height: 28px !important;
                padding: 0 !important; font-size: 14px !important;
                cursor: pointer !important;
                display: flex !important; align-items: center !important; justify-content: center !important;
                transition: color 0.3s ease, background 0.3s ease, transform 0.3s ease, opacity 0.3s ease !important;
            }
            #sc-gif-btn.sc-bar-dim {
                transform: translateX(60px) !important; opacity: 0 !important; pointer-events: none !important;
            }
            #sc-gif-btn:hover { color: white !important; background: rgba(255,255,255,0.22) !important; }
            body.sc-horizontal #sc-gif-btn {
                bottom: 6px !important;
                right: calc(var(--sc-chat-w) + 1vw + 116px) !important;
            }
            body.sc-vertical #sc-gif-btn {
                bottom: calc(var(--sc-chat-h) + 1vh) !important;
                right: 116px !important;
            }
            #sc-gif-btn:disabled {
                opacity: 0.35 !important; cursor: default !important; pointer-events: none !important;
            }
        `;
        document.head.appendChild(style);
    }

    function ensureRecordButton() {
        if (PC_MODE) {
            if (document.getElementById('sc-gif-btn')) return;
            injectFloatingButtonCss();
            const btn = document.createElement('button');
            btn.id = 'sc-gif-btn';
            btn.textContent = '◉';
            btn.title = 'Make a GIF of this scene';
            btn.addEventListener('click', () => openGifPanel());
            document.body.appendChild(btn);
            return;
        }
        const group = document.getElementById('videocontrols');
        if (!group) return;
        let btn = document.getElementById('scgm-record-btn');
        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'scgm-record-btn';
            btn.type = 'button';
            btn.className = 'btn btn-sm btn-default';
            btn.title = 'Make a GIF of this scene';
            btn.innerHTML = '<span class="glyphicon glyphicon-camera"></span>';
            btn.addEventListener('click', () => openGifPanel());
            group.appendChild(btn);
        } else if (btn.parentElement !== group) {
            group.appendChild(btn);
        }
    }

    function updateRecordButtonState() {
        const btn = document.getElementById(PC_MODE ? 'sc-gif-btn' : 'scgm-record-btn');
        if (!btn) return;
        btn.disabled = isYouTubeMedia();
    }

    /* ==========================================================
       BOOT
    ========================================================== */
    const PC_BRIDGE_POLL_MS = 50;
    const PC_BRIDGE_POLL_TIMEOUT_MS = 1500;

    function upgradeToPcMode(bridge) {
        if (PC_MODE) return;
        if (document.getElementById('sc-gif-panel')) return; // don't rip the DOM out from under an open panel
        const oldBtn = document.getElementById('scgm-record-btn');
        if (oldBtn) oldBtn.remove();
        PC_MODE = true;
        _pcBridge = bridge;
        bridge.openGifPanel = openGifPanel;
        ensureRecordButton();
        updateRecordButtonState();
    }

    function waitForBody() {
        if (!document.body) { requestAnimationFrame(waitForBody); return; }

        const bridge = readPcBridge();
        if (bridge) {
            PC_MODE = true;
            _pcBridge = bridge;
            bridge.openGifPanel = openGifPanel;
        }

        ensureRecordButton();
        updateRecordButtonState();

        if (!PC_MODE) {
            // cytube.pc.user.js may still be loading (both scripts run at
            // document-start with no guaranteed order) — poll briefly for
            // its bridge before settling permanently into standalone mode.
            let elapsed = 0;
            const pollTimer = setInterval(() => {
                elapsed += PC_BRIDGE_POLL_MS;
                const lateBridge = readPcBridge();
                if (lateBridge) {
                    upgradeToPcMode(lateBridge);
                    if (PC_MODE || elapsed >= PC_BRIDGE_POLL_TIMEOUT_MS) clearInterval(pollTimer);
                } else if (elapsed >= PC_BRIDGE_POLL_TIMEOUT_MS) {
                    clearInterval(pollTimer);
                }
            }, PC_BRIDGE_POLL_MS);
        }

        new MutationObserver(() => {
            ensureRecordButton();
            updateRecordButtonState();
        }).observe(document.body, { childList: true, subtree: true });

        setInterval(updateRecordButtonState, 800);
    }

    waitForBody();
})();
