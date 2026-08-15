// ==UserScript==
// @name         CyTube Subtitle Sync
// @namespace    http://tampermonkey.net/
// @version      1.4.0
// @description  Load a local .srt/.vtt subtitle file and sync it to native <video> playback, with a persistent font-size setting, a draggable/steppable position pad for on-screen caption placement, and a short-lived per-movie cache that survives a page refresh. Not available for YouTube playback. Integrates with cytube.pc.user.js when installed, including an OpenSubtitles search link for the currently playing movie.
// @match        https://cytu.be/r/420Grindhouse
// @match        https://cytu.be/r/testing
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';
    console.log('[SC] cytube.subtitles v1.4.0 loaded');

    /* ==========================================================
       PC-SCRIPT INTEGRATION BRIDGE
       cytube.pc.user.js (when installed) exposes a small object on
       the real page window (via unsafeWindow) that cytube.gifmaker.user.js
       and cytube.chatimages.user.js already use purely as a presence
       signal. Reused the same way here — PC_MODE only changes how the
       trigger button anchors (see TRIGGER BUTTON below).
    ========================================================== */
    let PC_MODE = false;
    let _pcBridge = null;
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
       SETTINGS
       Font size is a personal display preference (like pc.user.js's
       LS_CHAT_FONT), so unlike the loaded file/offset below it persists
       across sessions.
    ========================================================== */
    const LS_SUB_FONT_SIZE = 'sc_sub_fontsize'; // px
    const SUB_FONT_SIZE_DEFAULT = 28;
    const SUB_FONT_SIZE_MIN = 16;
    const SUB_FONT_SIZE_MAX = 48;
    const SUB_FONT_SIZE_STEP = 2;
    function getSubFontSize() {
        const v = parseInt(localStorage.getItem(LS_SUB_FONT_SIZE), 10);
        return (Number.isFinite(v) && v >= SUB_FONT_SIZE_MIN && v <= SUB_FONT_SIZE_MAX) ? v : SUB_FONT_SIZE_DEFAULT;
    }
    let _subFontSizePx = getSubFontSize();

    // Caption position on the video, as a percentage (X from left, Y from
    // top) -- also a persisted display preference, adjustable via the
    // panel's position pad.
    const LS_SUB_POS_X = 'sc_sub_posx';
    const LS_SUB_POS_Y = 'sc_sub_posy';
    const SUB_POS_X_DEFAULT = 50;
    const SUB_POS_Y_DEFAULT = 85; // leaves clearance below for CyTube's control bar/scrubber
    const SUB_POS_STEP = 2;
    function getSubPos(key, def) {
        const v = parseInt(localStorage.getItem(key), 10);
        return (Number.isFinite(v) && v >= 0 && v <= 100) ? v : def;
    }
    let _subPosX = getSubPos(LS_SUB_POS_X, SUB_POS_X_DEFAULT);
    let _subPosY = getSubPos(LS_SUB_POS_Y, SUB_POS_Y_DEFAULT);

    /* ==========================================================
       SUBTITLE STATE (session-only — no localStorage persistence)
    ========================================================== */
    let _subTrack = null;          // the TextTrack we created via addTextTrack
    let _subCuesOriginal = [];     // [{start, end, text}] as parsed, unmodified by offset
    let _subOffsetMs = 0;
    let _loadedFilename = '';

    /* ==========================================================
       PARSING
       Accepts SRT (00:00:20,000 --> 00:00:23,400, optional leading
       numeric index line) and VTT (00:00:20.000 --> 00:00:23.400,
       WEBVTT header) in one pass.
    ========================================================== */
    function parseSubtitleFile(text) {
        const body = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/^WEBVTT[^\n]*\n/, '');
        const blocks = body.split(/\n\s*\n/);
        const timeRe = /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/;
        const cues = [];
        for (const block of blocks) {
            const lines = block.split('\n').filter(l => l.trim() !== '');
            if (!lines.length) continue;
            let idx = 0;
            if (/^\d+$/.test(lines[0].trim())) idx = 1; // SRT numeric index line
            const m = timeRe.exec(lines[idx] || '');
            if (!m) continue;
            const start = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
            const end   = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
            const cueText = lines.slice(idx + 1).join('\n').trim();
            if (cueText && end > start) cues.push({ start, end, text: cueText });
        }
        return cues;
    }

    /* ==========================================================
       TRACK APPLICATION & OFFSET
       Cues are added to a native TextTrack via addTextTrack/VTTCue --
       the browser owns rendering and sync to video.currentTime, this
       script never touches timeupdate. Offset changes rebuild every
       cue from its ORIGINAL parsed time plus the current offset (never
       an incremental delta), so repeated nudges never drift.
    ========================================================== */
    function clearSubtitleTrack() {
        if (_subTrack) {
            try { _subTrack.mode = 'disabled'; } catch (e) {}
            try { while (_subTrack.cues && _subTrack.cues.length) _subTrack.removeCue(_subTrack.cues[0]); } catch (e) {}
        }
        _subTrack = null;
        _subCuesOriginal = [];
        _subOffsetMs = 0;
        _loadedFilename = '';
    }

    function applySubtitles(video, cues, filename) {
        clearSubtitleTrack();
        _subCuesOriginal = cues;
        _loadedFilename = filename;
        _subTrack = video.addTextTrack('subtitles', 'Loaded subtitles', 'en');
        _subTrack.mode = 'showing'; // addTextTrack defaults to 'hidden'
        rebuildCues();
        updateOffsetDisplay();
        saveSubCache();
    }

    function rebuildCues() {
        if (!_subTrack) return;
        while (_subTrack.cues && _subTrack.cues.length) _subTrack.removeCue(_subTrack.cues[0]);
        const offsetSec = _subOffsetMs / 1000;
        for (const c of _subCuesOriginal) {
            const start = Math.max(0, c.start + offsetSec);
            const end = Math.max(start + 0.01, c.end + offsetSec);
            const cue = new VTTCue(start, end, c.text);
            try {
                // snapToLines=false makes line/position percentages of the
                // video frame (not line counts) -- lets the pad set both
                // axes freely instead of only snapping to text-line rows.
                cue.snapToLines = false;
                cue.line = _subPosY;
                cue.position = _subPosX;
                cue.align = 'center';
                cue.size = 90; // leaves a small margin so centered text doesn't clip at the edges
            } catch (e) {}
            try { _subTrack.addCue(cue); } catch (e) {}
        }
    }

    function updatePositionDisplay() {
        const readout = document.getElementById('sc-sub-pos-readout');
        if (readout) readout.textContent = _subPosX + '%, ' + _subPosY + '%';
        const dot = document.getElementById('sc-sub-pospad-dot');
        if (dot) { dot.style.left = _subPosX + '%'; dot.style.top = _subPosY + '%'; }
    }

    function setSubPosition(x, y) {
        _subPosX = Math.max(0, Math.min(100, Math.round(x)));
        _subPosY = Math.max(0, Math.min(100, Math.round(y)));
        localStorage.setItem(LS_SUB_POS_X, String(_subPosX));
        localStorage.setItem(LS_SUB_POS_Y, String(_subPosY));
        rebuildCues();
        updatePositionDisplay();
    }
    function resetSubPosition() { setSubPosition(SUB_POS_X_DEFAULT, SUB_POS_Y_DEFAULT); }

    function setOffsetMs(ms) {
        _subOffsetMs = ms;
        rebuildCues();
        updateOffsetDisplay();
        saveSubCache();
    }
    function nudgeOffsetMs(deltaMs) { setOffsetMs(_subOffsetMs + deltaMs); }

    /* ==========================================================
       PANEL STATE HELPERS (null-safe — panel may not be open)
    ========================================================== */
    function updateOffsetDisplay() {
        const val = document.getElementById('sc-sub-offset-value');
        if (val) val.textContent = _subOffsetMs + 'ms';
        const fname = document.getElementById('sc-sub-filename');
        if (fname) fname.textContent = _loadedFilename || 'No file loaded';
    }
    function showPanelError(msg) {
        const el = document.getElementById('sc-sub-error');
        if (el) el.textContent = msg;
    }
    function clearPanelError() { showPanelError(''); }

    function resetSubtitles() {
        clearSubtitleTrack();
        updateOffsetDisplay();
        clearPanelError();
    }

    function updateFontSizeDisplay() {
        const el = document.getElementById('sc-sub-fontsize-value');
        if (el) el.textContent = _subFontSizePx + 'px';
    }

    function setFontSizePx(px) {
        _subFontSizePx = Math.max(SUB_FONT_SIZE_MIN, Math.min(SUB_FONT_SIZE_MAX, px));
        localStorage.setItem(LS_SUB_FONT_SIZE, String(_subFontSizePx));
        applyCueStyle();
        updateFontSizeDisplay();
    }
    function nudgeFontSizePx(deltaPx) { setFontSizePx(_subFontSizePx + deltaPx); }

    /* ==========================================================
       OPENSUBTITLES SEARCH LINK
       PC-mode only -- uses cytube.pc.user.js's bridge to identify the
       currently playing movie. Prefers an IMDb-ID deep link (precise,
       only available once that script's TMDB lookup has resolved for
       this video) and falls back to a plain title+year search.
    ========================================================== */
    function buildOpenSubtitlesUrl(info) {
        if (!info || !info.title) return null;
        if (info.imdbId) {
            const numericId = String(info.imdbId).replace(/^tt/, '');
            return 'https://www.opensubtitles.org/en/search/imdbid-' + encodeURIComponent(numericId) + '/sublanguageid-eng';
        }
        const query = info.title + (info.year ? ' ' + info.year : '');
        return 'https://www.opensubtitles.org/en/search2/sublanguageid-eng/moviename-' + encodeURIComponent(query);
    }

    /* ==========================================================
       SUBTITLE PANEL
    ========================================================== */
    function injectPanelCss() {
        if (document.getElementById('scsub-panel-style')) return;
        const style = document.createElement('style');
        style.id = 'scsub-panel-style';
        style.textContent = `
            #sc-sub-panel {
                position: fixed !important;
                top: 50% !important; left: 50% !important; transform: translate(-50%, -50%) !important;
                z-index: 30002 !important;
                width: 360px !important; max-width: 92vw !important;
                display: flex !important; flex-direction: column !important;
                background: #0c0c0e !important;
                border: 1px solid rgba(244,244,242,0.14) !important;
                border-radius: 12px !important;
                box-shadow: 0 12px 40px rgba(0,0,0,0.6) !important;
                color: #f4f4f2 !important; font-size: 13px !important;
                font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif !important;
            }
            #sc-sub-head {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                padding: 10px 16px !important;
                border-bottom: 1px solid rgba(244,244,242,0.08) !important;
                font-weight: 700 !important; font-size: 14px !important; color: #4dd0e1 !important;
                letter-spacing: 0.01em !important;
                cursor: grab !important; user-select: none !important; touch-action: none !important;
            }
            #sc-sub-head.sc-sub-dragging { cursor: grabbing !important; }
            #sc-sub-close {
                background: transparent !important; border: none !important; color: rgba(244,244,242,0.62) !important;
                font-size: 15px !important; cursor: pointer !important; padding: 0 4px !important;
                transition: color 120ms ease !important;
            }
            #sc-sub-close:hover { color: #f4f4f2 !important; }
            #sc-sub-body {
                padding: 16px !important; display: flex !important; flex-direction: column !important; gap: 14px !important;
            }
            .sc-sub-section {
                display: flex !important; flex-direction: column !important; gap: 8px !important;
                padding-top: 14px !important; border-top: 1px solid rgba(244,244,242,0.08) !important;
            }
            .sc-sub-section:first-child { padding-top: 0 !important; border-top: none !important; }
            .sc-sub-eyebrow {
                font-size: 10px !important; font-weight: 700 !important; letter-spacing: 0.08em !important;
                text-transform: uppercase !important; color: rgba(77,208,225,0.75) !important;
            }
            #sc-sub-filename { font-size: 12px !important; color: rgba(244,244,242,0.62) !important; }
            .sc-sub-row { display: flex !important; align-items: center !important; gap: 8px !important; }
            .sc-sub-label { font-size: 12px !important; color: rgba(244,244,242,0.62) !important; flex: none !important; }
            .sc-sub-readout {
                font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace !important;
                font-size: 12px !important; min-width: 48px !important; text-align: center !important;
            }
            .sc-sub-btn {
                background: rgba(255,255,255,0.08) !important; color: #f4f4f2 !important;
                border: 1px solid rgba(255,255,255,0.18) !important; border-radius: 6px !important;
                padding: 6px 10px !important; cursor: pointer !important; font-size: 12px !important;
                text-decoration: none !important; text-align: center !important;
                transition: background 120ms ease !important;
            }
            .sc-sub-btn:hover { background: rgba(255,255,255,0.22) !important; }
            .sc-sub-btn-icon {
                width: 26px !important; height: 26px !important; padding: 0 !important; flex: none !important;
                display: inline-flex !important; align-items: center !important; justify-content: center !important;
                font-weight: 700 !important; line-height: 1 !important;
            }
            .sc-sub-btn-accent {
                background: rgba(77,208,225,0.14) !important; color: #4dd0e1 !important;
                border: 1px solid rgba(77,208,225,0.4) !important; font-weight: 600 !important;
                border-radius: 6px !important; padding: 6px 10px !important; font-size: 12px !important;
                text-decoration: none !important; text-align: center !important;
                display: inline-flex !important; align-items: center !important; justify-content: center !important;
                transition: background 120ms ease !important;
            }
            .sc-sub-btn-accent:hover { background: rgba(77,208,225,0.24) !important; }
            #sc-sub-offset-input {
                width: 64px !important; flex: none !important; background: rgba(255,255,255,0.06) !important; color: #f4f4f2 !important;
                border: 1px solid rgba(255,255,255,0.18) !important; border-radius: 6px !important; padding: 4px 6px !important;
                font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace !important; font-size: 12px !important;
            }
            .sc-sub-posrow { display: flex !important; align-items: center !important; gap: 12px !important; }
            #sc-sub-pospad {
                position: relative !important; width: 96px !important; height: 54px !important; flex: none !important;
                background: linear-gradient(160deg, rgba(77,208,225,0.10), rgba(255,255,255,0.03)) !important;
                border: 1px solid rgba(244,244,242,0.16) !important; border-radius: 6px !important;
                cursor: crosshair !important; touch-action: none !important;
            }
            #sc-sub-pospad-dot {
                position: absolute !important; width: 10px !important; height: 10px !important;
                background: #4dd0e1 !important; border: 1.5px solid #0c0c0e !important; border-radius: 50% !important;
                transform: translate(-50%, -50%) !important; box-shadow: 0 0 6px rgba(77,208,225,0.7) !important;
                pointer-events: none !important;
            }
            .sc-sub-poscol { display: flex !important; flex-direction: column !important; gap: 6px !important; align-items: flex-start !important; }
            .sc-sub-dpad {
                display: grid !important; grid-template-columns: repeat(3, 26px) !important;
                grid-template-rows: repeat(3, 26px) !important; gap: 2px !important;
            }
            .sc-sub-dpad .sc-sub-btn-icon { width: 26px !important; height: 26px !important; }
            .sc-sub-footer { display: flex !important; gap: 8px !important; }
            .sc-sub-footer .sc-sub-btn, .sc-sub-footer .sc-sub-btn-accent { flex: 1 1 0 !important; }
            #sc-sub-error { font-size: 12px !important; color: #ff6b6b !important; min-height: 14px !important; }
        `;
        document.head.appendChild(style);
    }

    /* ==========================================================
       CUE STYLE (block lettering: bold white text with a black
       outline, no background box, so captions stay legible over any
       video frame without covering the picture). Regenerated whenever
       the font-size setting changes, not just injected once.
    ========================================================== */
    function applyCueStyle() {
        let style = document.getElementById('scsub-cue-style');
        if (!style) {
            style = document.createElement('style');
            style.id = 'scsub-cue-style';
            document.head.appendChild(style);
        }
        style.textContent = `
            video::cue {
                background: transparent;
                color: #ffffff;
                font-family: "Arial Black", Impact, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
                font-weight: 900;
                font-size: ${_subFontSizePx}px;
                text-shadow:
                    -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000,
                    0 -2px 0 #000, 0 2px 0 #000, -2px 0 0 #000, 2px 0 0 #000;
            }
        `;
    }

    function openSubtitlePanel() {
        if (document.getElementById('sc-sub-panel')) return;
        injectPanelCss();

        const movieInfo = (PC_MODE && _pcBridge && typeof _pcBridge.getMovieInfo === 'function')
            ? _pcBridge.getMovieInfo() : null;
        const osUrl = buildOpenSubtitlesUrl(movieInfo);
        const osLinkHtml = osUrl
            ? `<a id="sc-sub-opensubs" class="sc-sub-btn-accent" href="${osUrl}" target="_blank" rel="noopener noreferrer">Search OpenSubtitles</a>`
            : '';

        const panel = document.createElement('div');
        panel.id = 'sc-sub-panel';
        panel.innerHTML = `
            <div id="sc-sub-head">Subtitles <button id="sc-sub-close" type="button">✕</button></div>
            <div id="sc-sub-body">
                <div class="sc-sub-section">
                    <div class="sc-sub-eyebrow">File</div>
                    <input type="file" id="sc-sub-file" accept=".srt,.vtt">
                    <div id="sc-sub-filename">No file loaded</div>
                </div>
                <div class="sc-sub-section">
                    <div class="sc-sub-eyebrow">Sync</div>
                    <div class="sc-sub-row">
                        <button id="sc-sub-offset-minus" class="sc-sub-btn sc-sub-btn-icon" type="button">−</button>
                        <span id="sc-sub-offset-value" class="sc-sub-readout">0ms</span>
                        <button id="sc-sub-offset-plus" class="sc-sub-btn sc-sub-btn-icon" type="button">+</button>
                        <input type="number" id="sc-sub-offset-input" step="100" placeholder="ms">
                        <button id="sc-sub-offset-set" class="sc-sub-btn" type="button">Set</button>
                    </div>
                </div>
                <div class="sc-sub-section">
                    <div class="sc-sub-eyebrow">Appearance</div>
                    <div class="sc-sub-row">
                        <span class="sc-sub-label">Size</span>
                        <button id="sc-sub-fontsize-minus" class="sc-sub-btn sc-sub-btn-icon" type="button">−</button>
                        <span id="sc-sub-fontsize-value" class="sc-sub-readout">${_subFontSizePx}px</span>
                        <button id="sc-sub-fontsize-plus" class="sc-sub-btn sc-sub-btn-icon" type="button">+</button>
                    </div>
                    <div class="sc-sub-posrow">
                        <div id="sc-sub-pospad" title="Drag to position captions"><div id="sc-sub-pospad-dot"></div></div>
                        <div class="sc-sub-dpad">
                            <span></span>
                            <button id="sc-sub-posy-minus" class="sc-sub-btn sc-sub-btn-icon" type="button" title="Move up">▲</button>
                            <span></span>
                            <button id="sc-sub-posx-minus" class="sc-sub-btn sc-sub-btn-icon" type="button" title="Move left">◀</button>
                            <span></span>
                            <button id="sc-sub-posx-plus" class="sc-sub-btn sc-sub-btn-icon" type="button" title="Move right">▶</button>
                            <span></span>
                            <button id="sc-sub-posy-plus" class="sc-sub-btn sc-sub-btn-icon" type="button" title="Move down">▼</button>
                            <span></span>
                        </div>
                        <div class="sc-sub-poscol">
                            <span class="sc-sub-label">Position</span>
                            <span id="sc-sub-pos-readout" class="sc-sub-readout">${_subPosX}%, ${_subPosY}%</span>
                            <button id="sc-sub-pos-reset" class="sc-sub-btn" type="button">Reset</button>
                        </div>
                    </div>
                </div>
                <div class="sc-sub-footer">
                    <button id="sc-sub-clear" class="sc-sub-btn" type="button">Clear subtitles</button>
                    ${osLinkHtml}
                </div>
                <div id="sc-sub-error"></div>
            </div>`;
        document.body.appendChild(panel);

        const $ = id => panel.querySelector(id);
        updateOffsetDisplay();
        updateFontSizeDisplay();
        updatePositionDisplay();

        $('#sc-sub-close').addEventListener('click', () => panel.remove());

        $('#sc-sub-file').addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const cues = parseSubtitleFile(reader.result);
                    if (!cues.length) { showPanelError('No subtitle cues found in this file.'); return; }
                    const video = getPlayerVideoEl();
                    if (!video) { showPanelError('No video found to attach subtitles to.'); return; }
                    applySubtitles(video, cues, file.name);
                    clearPanelError();
                } catch (err) {
                    showPanelError('Could not parse this file: ' + (err.message || err));
                }
            };
            reader.onerror = () => showPanelError('Could not read this file.');
            reader.readAsText(file);
        });

        $('#sc-sub-offset-minus').addEventListener('click', () => nudgeOffsetMs(-100));
        $('#sc-sub-offset-plus').addEventListener('click', () => nudgeOffsetMs(100));
        $('#sc-sub-offset-set').addEventListener('click', () => {
            const v = parseInt($('#sc-sub-offset-input').value, 10);
            if (!isNaN(v)) setOffsetMs(v);
        });
        $('#sc-sub-fontsize-minus').addEventListener('click', () => nudgeFontSizePx(-SUB_FONT_SIZE_STEP));
        $('#sc-sub-fontsize-plus').addEventListener('click', () => nudgeFontSizePx(SUB_FONT_SIZE_STEP));
        $('#sc-sub-posx-minus').addEventListener('click', () => setSubPosition(_subPosX - SUB_POS_STEP, _subPosY));
        $('#sc-sub-posx-plus').addEventListener('click', () => setSubPosition(_subPosX + SUB_POS_STEP, _subPosY));
        $('#sc-sub-posy-minus').addEventListener('click', () => setSubPosition(_subPosX, _subPosY - SUB_POS_STEP));
        $('#sc-sub-posy-plus').addEventListener('click', () => setSubPosition(_subPosX, _subPosY + SUB_POS_STEP));
        $('#sc-sub-pos-reset').addEventListener('click', () => resetSubPosition());
        $('#sc-sub-clear').addEventListener('click', () => { resetSubtitles(); clearSubCache(); });

        const pad = $('#sc-sub-pospad');
        let posDragging = false;
        const posFromEvent = (e) => {
            const rect = pad.getBoundingClientRect();
            return {
                x: ((e.clientX - rect.left) / rect.width) * 100,
                y: ((e.clientY - rect.top) / rect.height) * 100,
            };
        };
        pad.addEventListener('pointerdown', (e) => {
            posDragging = true;
            pad.setPointerCapture(e.pointerId);
            const { x, y } = posFromEvent(e);
            setSubPosition(x, y);
        });
        pad.addEventListener('pointermove', (e) => {
            if (!posDragging) return;
            const { x, y } = posFromEvent(e);
            setSubPosition(x, y);
        });
        const endPosDrag = (e) => {
            posDragging = false;
            try { pad.releasePointerCapture(e.pointerId); } catch (err) {}
        };
        pad.addEventListener('pointerup', endPosDrag);
        pad.addEventListener('pointercancel', endPosDrag);

        const head = $('#sc-sub-head');
        let dragging = false, dragDX = 0, dragDY = 0;
        const setPanelPos = (prop, val) => panel.style.setProperty(prop, val, 'important');
        head.addEventListener('pointerdown', (e) => {
            if (e.target.closest('#sc-sub-close')) return;
            const rect = panel.getBoundingClientRect();
            setPanelPos('left', rect.left + 'px');
            setPanelPos('top', rect.top + 'px');
            setPanelPos('transform', 'none');
            dragDX = e.clientX - rect.left;
            dragDY = e.clientY - rect.top;
            dragging = true;
            head.classList.add('sc-sub-dragging');
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
            head.classList.remove('sc-sub-dragging');
            try { head.releasePointerCapture(e.pointerId); } catch (err) {}
        };
        head.addEventListener('pointerup', endDrag);
        head.addEventListener('pointercancel', endDrag);
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
       SHORT-LIVED PER-MOVIE SUBTITLE CACHE
       Remembers the loaded file (parsed cues + offset) against the
       movie it was loaded for, so a page refresh -- or that same movie
       coming back around shortly after -- restores it automatically.
       Deliberately short-lived (a few hours, not indefinite like the
       font-size/position settings) and holds only the single
       most-recently-loaded movie, not a per-movie history. Restoring
       refreshes savedAt (a sliding window: still-in-use stays cached,
       untouched entries expire).
    ========================================================== */
    const LS_SUB_CACHE = 'sc_sub_cache';
    const SUB_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
    let _currentMovieKey = null; // raw title from the most recent changeMedia payload

    function saveSubCache() {
        if (!_subTrack || !_currentMovieKey) return;
        try {
            localStorage.setItem(LS_SUB_CACHE, JSON.stringify({
                key: _currentMovieKey,
                filename: _loadedFilename,
                cues: _subCuesOriginal,
                offsetMs: _subOffsetMs,
                savedAt: Date.now(),
            }));
        } catch (e) {}
    }

    function clearSubCache() {
        try { localStorage.removeItem(LS_SUB_CACHE); } catch (e) {}
    }

    function tryRestoreSubCache() {
        if (!_currentMovieKey) return;
        let raw;
        try { raw = JSON.parse(localStorage.getItem(LS_SUB_CACHE)); } catch (e) { return; }
        if (!raw || raw.key !== _currentMovieKey) return;
        if (!raw.savedAt || Date.now() - raw.savedAt > SUB_CACHE_TTL_MS) { clearSubCache(); return; }
        if (!Array.isArray(raw.cues) || !raw.cues.length) return;
        const video = getPlayerVideoEl();
        if (!video) return;
        applySubtitles(video, raw.cues, raw.filename || '');
        if (Number.isFinite(raw.offsetMs) && raw.offsetMs !== 0) setOffsetMs(raw.offsetMs);
    }

    /* ==========================================================
       MOVIE-CHANGE RESET
       cytube.pc.user.js:1605-1622 establishes the reliable signal for
       this: CyTube's own changeMedia socket event fires on every movie
       change (reused/queued video or a fresh one), whether or not the
       underlying <video> DOM node is actually replaced. That's the
       PRIMARY reset trigger. A video-element-identity poll (same 800ms
       cadence as the trigger-button-state poll) is a defensive backstop
       for the case where the socket hasn't bound yet -- it only resets
       (no cache-restore attempt, since it has no title to key against).
       Both paths call the same idempotent resetSubtitles(), so
       double-firing on an actual movie change is harmless.
    ========================================================== */
    let _lastVideoEl = null;
    function checkVideoSwap() {
        const video = getPlayerVideoEl();
        if (video !== _lastVideoEl) {
            _lastVideoEl = video;
            if (_subTrack) resetSubtitles();
        }
    }

    function initMediaWatcher() {
        const tryBind = () => {
            if (typeof socket === 'undefined' || !socket || !socket.on) return;
            socket.on('changeMedia', (data) => {
                _currentMovieKey = (data && data.title) ? String(data.title).trim() : null;
                resetSubtitles();
                tryRestoreSubCache();
            });
        };
        // socket may not be ready at document-start; try at load then again after a short delay
        window.addEventListener('load', () => { tryBind(); setTimeout(tryBind, 2000); });
    }

    /* ==========================================================
       OFFSET KEYBINDS
       [ / ] nudge by 100ms, Shift+[ / Shift+] nudge by 1000ms. Guarded
       against firing while chat/any input is focused -- same guard
       cytube.pc.user.js:1719-1721 uses for its own arrow-key seeking
       listener (a second, independent listener; no conflict since the
       key sets don't overlap). No-op while nothing is loaded.
    ========================================================== */
    document.addEventListener('keydown', (e) => {
        const t = e.target;
        if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
        if (!_subTrack) return;
        if (e.key === '[') { nudgeOffsetMs(e.shiftKey ? -1000 : -100); return; }
        if (e.key === ']') { nudgeOffsetMs(e.shiftKey ?  1000 :  100); return; }
    });

    /* ==========================================================
       BOOT
    ========================================================== */
    const PC_BRIDGE_POLL_MS = 50;
    const PC_BRIDGE_POLL_TIMEOUT_MS = 1500;

    function waitForBody() {
        if (!document.body) { requestAnimationFrame(waitForBody); return; }

        const bridge = readPcBridge();
        if (bridge) { PC_MODE = true; _pcBridge = bridge; }
        ensureTriggerButton();
        updateTriggerButtonState();
        applyCueStyle();
        initMediaWatcher();
        setInterval(checkVideoSwap, 800);

        if (!PC_MODE) {
            let elapsed = 0;
            const pollTimer = setInterval(() => {
                elapsed += PC_BRIDGE_POLL_MS;
                const lateBridge = readPcBridge();
                if (lateBridge) {
                    PC_MODE = true;
                    _pcBridge = lateBridge;
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
