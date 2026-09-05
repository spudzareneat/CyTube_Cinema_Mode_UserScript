    /* ==========================================================
       SUBTITLES — load a local .srt/.vtt subtitle file and sync it to
       native <video> playback, with a persistent font-size setting, a
       draggable/steppable position pad for on-screen caption placement,
       a short-lived per-movie cache that survives a page refresh, and
       an OpenSubtitles search link for the currently playing movie. Not
       available for YouTube playback. Originally a standalone companion
       script (cytube.subtitles.user.js) that detected cytube.pc.user.js
       at runtime via a polled bridge object and offered two UI modes (a
       control-bar-docked button when standalone, a floating button when
       the bridge was present); now always bundled alongside core, so
       that detection/poll loop and the control-bar-docked UI path are
       gone -- only the floating trigger button remains.
       getPlayerVideoEl/isYouTubeMedia are core's
       (12-playback-sync-and-seek.js) -- this module doesn't redeclare
       them. getBridgeMovieInfo() (01-movie-identity.js) is called
       directly in place of the old `_pcBridge.getMovieInfo()` bridge
       call -- core's GIF bridge (03-gif-bridge.js) exposes that exact
       same function under `getMovieInfo` on the page-level bridge
       object (`getMovieInfo: () => getBridgeMovieInfo()`), so this is
       the identical derivation, just called directly instead of through
       the bridge indirection.
    ========================================================== */

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
       Uses core's getBridgeMovieInfo() (01-movie-identity.js) to
       identify the currently playing movie. Prefers an IMDb-ID deep
       link (precise, only available once movie-title-links' TMDB
       lookup has resolved for this video) and falls back to a plain
       title+year search.
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
       IN-PANEL OPENSUBTITLES SEARCH + LOAD
       Wires the Task-1 API client (opensubtitles.js — same bundle
       scope after assembly: LS_OPENSUBTITLES, osSearchSubtitles,
       osDownloadSubtitle, osFetchSrtText, _osResultsMemo) into the
       "Find online" panel section. Degrades gracefully with no key /
       no IMDb match / YouTube — no hard dependency on movie-title-links.
       These are module-scope (called from openSubtitlePanel's wiring)
       and touch the panel purely by id, null-safe if it's been closed
       mid-request. Named escOsText / runOnlineSearch / selectOsResult
       (not esc/…) — the assembled bundle is one shared scope.
    ========================================================== */
    // HTML-escape for interpolation into the results-list HTML string
    // ONLY (never cue text — cues go through VTTCue / the native parser,
    // same as the local-file path).
    function escOsText(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    async function runOnlineSearch(imdbId) {
        const searchBtn = document.getElementById('sc-sub-os-search');
        const note = document.getElementById('sc-sub-os-note');
        const results = document.getElementById('sc-sub-os-results');
        if (searchBtn) searchBtn.disabled = true;
        if (note) note.textContent = 'Searching OpenSubtitles…';
        if (results) results.innerHTML = '';
        clearPanelError();

        let list;
        if (_osResultsMemo.imdbId === imdbId && _osResultsMemo.list) {
            list = _osResultsMemo.list;
        } else {
            list = await osSearchSubtitles(imdbId);
            // Only memoize a non-empty list: an empty result may be a
            // transient network/API failure, not a real "none". Searches
            // cost no quota, so let "Search again" retry.
            if (list.length) _osResultsMemo = { imdbId, list };
        }

        if (searchBtn) { searchBtn.disabled = false; searchBtn.textContent = 'Search again'; }

        if (!list.length) {
            if (note) note.textContent = 'No English subtitles found for this movie.';
            return;
        }
        if (note) note.textContent = '';

        // Single quotes are intentionally not escaped — every interpolation site here uses double-quoted attributes.
        const html = list.map((s) => {
            const rel = escOsText(s.release);
            const badges = (s.fromTrusted ? '<span class="sc-sub-os-badge b-trust">Trusted</span>' : '')
                + (s.hearingImpaired ? '<span class="sc-sub-os-badge b-sdh">SDH</span>' : '')
                + (s.machineTranslated ? '<span class="sc-sub-os-badge b-mt">Machine</span>' : '');
            return '<button class="sc-sub-os-item" type="button" data-file-id="' + escOsText(s.fileId) + '" data-release="' + rel + '">'
                + '<span class="sc-sub-os-rel" title="' + rel + '">' + rel + '</span>'
                + '<span class="sc-sub-os-meta">' + escOsText(s.uploader) + ' · ' + s.downloadCount.toLocaleString() + ' downloads</span>'
                + '<span class="sc-sub-os-badges">' + badges + '</span>'
                + '</button>';
        }).join('');
        if (results) results.innerHTML = html;
    }

    async function selectOsResult(fileId, release) {
        const results = document.getElementById('sc-sub-os-results');
        if (!results) return;
        const items = results.querySelectorAll('.sc-sub-os-item');
        const item = results.querySelector('.sc-sub-os-item[data-file-id="' + fileId + '"]');
        const rel = item && item.querySelector('.sc-sub-os-rel');
        const restore = () => {
            items.forEach((b) => { b.disabled = false; });
            if (item) item.classList.remove('busy');
            if (rel) rel.textContent = release;
        };

        if (item) item.classList.add('busy');
        if (rel) rel.textContent = 'Downloading…';
        items.forEach((b) => { b.disabled = true; });
        clearPanelError();

        const dl = await osDownloadSubtitle(fileId);
        if (!dl) { restore(); showPanelError('Download failed — the daily limit (free keys: 5/day) may be used up, or the key is invalid.'); return; }

        const srt = await osFetchSrtText(dl.link);
        if (!srt) { restore(); showPanelError('Couldn’t fetch the subtitle file from OpenSubtitles.'); return; }

        const cues = parseSubtitleFile(srt);
        if (!cues.length) { restore(); showPanelError('That subtitle file couldn’t be parsed.'); return; }

        const video = getPlayerVideoEl();
        if (!video) { restore(); showPanelError('No video found to attach subtitles to.'); return; }

        applySubtitles(video, cues, release + '.srt');
        clearPanelError();
        results.innerHTML = ''; // collapse the list
        const note = document.getElementById('sc-sub-os-note');
        if (note) note.textContent = '✓ Loaded: ' + release;
        // Remaining daily quota shows in its own line under the footer, not
        // in the section note.
        const quota = document.getElementById('sc-sub-os-quota');
        if (quota) quota.textContent = dl.remaining != null ? dl.remaining + ' downloads left today' : '';
        const searchBtn = document.getElementById('sc-sub-os-search');
        if (searchBtn) searchBtn.textContent = 'Find different subtitles';
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
            .sc-sub-footer .sc-sub-btn { flex: 1 1 0 !important; }
            .sc-sub-collapse {
                display: flex !important; align-items: center !important; gap: 6px !important;
                background: transparent !important; border: none !important; padding: 0 !important;
                cursor: pointer !important; font-family: inherit !important; text-align: left !important;
            }
            .sc-sub-caret { font-size: 9px !important; line-height: 1 !important; color: rgba(77,208,225,0.75) !important; }
            #sc-sub-appearance-body {
                display: flex !important; flex-direction: column !important; gap: 8px !important;
            }
            #sc-sub-appearance-body.sc-collapsed { display: none !important; }
            #sc-sub-os-quota { font-size: 11px !important; text-align: center !important; color: rgba(244,244,242,0.62) !important; }
            #sc-sub-os-quota:empty { display: none !important; }
            #sc-sub-error { font-size: 12px !important; color: #ff6b6b !important; min-height: 14px !important; }
            #sc-sub-os-results:empty { display: none !important; }
            #sc-sub-os-results:not(:empty) {
                display: flex !important; flex-direction: column !important; gap: 6px !important;
                max-height: 200px !important; overflow-y: auto !important;
            }
            .sc-sub-os-item {
                display: flex !important; flex-direction: column !important; gap: 3px !important;
                width: 100% !important; text-align: left !important; align-items: flex-start !important;
                padding: 7px 9px !important;
                background: rgba(255,255,255,0.08) !important;
                border: 1px solid rgba(255,255,255,0.18) !important;
                border-radius: 6px !important;
                color: #f4f4f2 !important; cursor: pointer !important;
                transition: background 120ms ease !important;
            }
            .sc-sub-os-item:hover { background: rgba(255,255,255,0.22) !important; }
            .sc-sub-os-item:disabled { opacity: 0.5 !important; cursor: default !important; }
            .sc-sub-os-item.busy { opacity: 0.7 !important; }
            .sc-sub-os-rel {
                font-size: 12px !important; color: #f4f4f2 !important;
                white-space: nowrap !important; overflow: hidden !important;
                text-overflow: ellipsis !important; max-width: 100% !important;
            }
            .sc-sub-os-meta { font-size: 11px !important; color: rgba(244,244,242,0.62) !important; }
            .sc-sub-os-badges {
                display: flex !important; flex-wrap: wrap !important; gap: 4px !important; margin-top: 2px !important;
            }
            .sc-sub-os-badge {
                font-size: 9px !important; text-transform: uppercase !important; letter-spacing: 0.06em !important;
                padding: 1px 5px !important; border-radius: 4px !important; font-weight: 700 !important;
            }
            .sc-sub-os-badge.b-trust { background: rgba(77,208,225,0.14) !important; color: #4dd0e1 !important; }
            .sc-sub-os-badge.b-sdh { background: rgba(255,255,255,0.12) !important; color: rgba(244,244,242,0.85) !important; }
            .sc-sub-os-badge.b-mt { background: rgba(224,162,77,0.16) !important; color: #e0a24d !important; }
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

        const movieInfo = getBridgeMovieInfo();
        const osUrl = buildOpenSubtitlesUrl(movieInfo);
        const osLinkHtml = osUrl
            ? `<a id="sc-sub-opensubs" class="sc-sub-btn-accent" href="${osUrl}" target="_blank" rel="noopener noreferrer">Search OpenSubtitles</a>`
            : '';

        // "Find online" section state (see task brief state table). imdbId
        // is filled asynchronously by movie-title-links — can be null early
        // (req 5 poll) or forever if that module isn't in the build.
        const hasOsKey  = hasKey(LS_OPENSUBTITLES);
        const osImdbId  = (movieInfo && movieInfo.imdbId) || null;
        const onYouTube = isYouTubeMedia();
        const osSearchBtnHtml = (disabled) =>
            `<button id="sc-sub-os-search" class="sc-sub-btn-accent" type="button"${disabled ? ' disabled' : ''}>Find subtitles online</button>`;
        const osNoteResultsHtml = (note) =>
            `<div id="sc-sub-os-note" class="sc-sub-label">${note}</div><div id="sc-sub-os-results"></div>`;
        let osSectionInner;
        if (!hasOsKey) {
            osSectionInner = osLinkHtml
                + `<div class="sc-sub-label">Add an OpenSubtitles API key in ⚙ Settings to search &amp; load here.</div>`;
        } else if (onYouTube) {
            osSectionInner = `<div class="sc-sub-label">Online search isn't available for YouTube.</div>`;
        } else if (!movieInfo) {
            osSectionInner = osSearchBtnHtml(true) + osNoteResultsHtml('No movie identified yet.') + osLinkHtml;
        } else if (!osImdbId) {
            osSectionInner = osSearchBtnHtml(true) + osNoteResultsHtml('Waiting for an IMDb match for this movie…') + osLinkHtml;
        } else {
            osSectionInner = osSearchBtnHtml(false) + osNoteResultsHtml('');
        }

        const panel = document.createElement('div');
        panel.id = 'sc-sub-panel';
        panel.innerHTML = `
            <div id="sc-sub-head">Subtitles <button id="sc-sub-close" type="button">✕</button></div>
            <div id="sc-sub-body">
                <div class="sc-sub-section" id="sc-sub-os-section">
                    <div class="sc-sub-eyebrow">Find online</div>
                    ${osSectionInner}
                </div>
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
                    <button class="sc-sub-eyebrow sc-sub-collapse" id="sc-sub-appearance-toggle" type="button" aria-expanded="false"><span class="sc-sub-caret">▸</span> Appearance</button>
                    <div id="sc-sub-appearance-body" class="sc-collapsed">
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
                </div>
                <div class="sc-sub-footer">
                    <button id="sc-sub-clear" class="sc-sub-btn" type="button">Clear subtitles</button>
                </div>
                <div id="sc-sub-os-quota" class="sc-sub-label"></div>
                <div id="sc-sub-error"></div>
            </div>`;
        document.body.appendChild(panel);

        const $ = id => panel.querySelector(id);
        updateOffsetDisplay();
        updateFontSizeDisplay();
        updatePositionDisplay();

        /* ---- "Find online" (OpenSubtitles) wiring ---------------------- */
        // Panel-scoped (function scope — safe from bundle name collisions).
        // osImdbIdNow starts at panel-open's id and is upgraded by the poll.
        let osImdbIdNow = osImdbId;
        let osPollId = null;
        const clearOsPoll = () => { if (osPollId) { clearInterval(osPollId); osPollId = null; } };

        // req 5: bounded poll only while "key set, movie identified, no
        // imdbId yet, not YouTube" — mirrors watchMovieTitleForCache()'s
        // ~1500ms / 14-try budget.
        if (hasOsKey && movieInfo && !osImdbId && !onYouTube) {
            let osTries = 0;
            osPollId = setInterval(() => {
                if (!document.getElementById('sc-sub-panel')) { clearOsPoll(); return; }
                const info = getBridgeMovieInfo();
                if (info && info.imdbId) {
                    osImdbIdNow = info.imdbId;
                    const sb = $('#sc-sub-os-search');
                    if (sb) sb.disabled = false;
                    const nt = $('#sc-sub-os-note');
                    if (nt) nt.textContent = '';
                    clearOsPoll();
                    return;
                }
                if (++osTries >= 14) clearOsPoll();
            }, 1500);
        }

        const osSearchBtn = $('#sc-sub-os-search');
        if (osSearchBtn) {
            osSearchBtn.addEventListener('click', () => {
                // Read the current movie fresh at click time — the movie can
                // change while the panel is open (resetSubtitles() clears the
                // track but not osImdbIdNow / _osResultsMemo), and searching
                // or downloading for the previous film wastes a free key's
                // 5 daily downloads. runOnlineSearch's memo is keyed on
                // imdbId, so a fresh id naturally bypasses a stale memo.
                const info = getBridgeMovieInfo();
                const id = (info && info.imdbId) || osImdbIdNow;
                if (id) runOnlineSearch(id);
            });
        }
        // One delegated listener, attached once at panel build (not per-render).
        const osResultsEl = $('#sc-sub-os-results');
        if (osResultsEl) {
            osResultsEl.addEventListener('click', (e) => {
                const item = e.target.closest('.sc-sub-os-item');
                if (!item || item.disabled) return;
                selectOsResult(Number(item.dataset.fileId), item.dataset.release);
            });
        }

        $('#sc-sub-close').addEventListener('click', () => { clearOsPoll(); panel.remove(); });

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

        // Appearance section is collapsible, collapsed on every panel open
        // (not persisted). Caret ▸ collapsed / ▾ expanded.
        const apToggle = $('#sc-sub-appearance-toggle');
        const apBody = $('#sc-sub-appearance-body');
        if (apToggle && apBody) {
            apToggle.addEventListener('click', () => {
                const collapsed = apBody.classList.toggle('sc-collapsed');
                apToggle.setAttribute('aria-expanded', String(!collapsed));
                const caret = apToggle.querySelector('.sc-sub-caret');
                if (caret) caret.textContent = collapsed ? '▸' : '▾';
            });
        }

        $('#sc-sub-clear').addEventListener('click', () => {
            resetSubtitles();
            clearSubCache();
            // Also reset the online-search UI (req 7).
            _osResultsMemo = { imdbId: null, list: null };
            const r = $('#sc-sub-os-results');
            if (r) r.innerHTML = '';
            const n = $('#sc-sub-os-note');
            if (n) n.textContent = '';
            const q = $('#sc-sub-os-quota');
            if (q) q.textContent = '';
            const sb = $('#sc-sub-os-search'); // only present when a key is set
            if (sb) sb.textContent = 'Find subtitles online';
        });

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
       Floating #scsub-trigger-btn, positioned to the left of
       cytube.gifmaker.user.js's floating button (152px vs its 116px from
       the chat edge) so they don't overlap when both are installed.
       (The original standalone script also had a control-bar-docked
       mode for when cytube.pc.user.js wasn't installed -- gone here
       since this module is only ever built alongside core.)
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
            #scsub-trigger-btn .vjs-icon-captions { font-size: 15px !important; line-height: 1 !important; }
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
        if (document.getElementById('scsub-trigger-btn')) return;
        injectFloatingButtonCss();
        const btn = document.createElement('button');
        btn.id = 'scsub-trigger-btn';
        btn.innerHTML = '<span class="vjs-icon-captions" aria-hidden="true"></span>';
        btn.title = 'Load subtitles';
        btn.addEventListener('click', () => openSubtitlePanel());
        document.body.appendChild(btn);
    }

    function updateTriggerButtonState() {
        const btn = document.getElementById('scsub-trigger-btn');
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
        if (_subTrack) return; // don't stomp on subtitles already loaded/restored
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
       DOM-TITLE FALLBACK FOR THE CACHE
       changeMedia's resync "can fire" on a fresh/refreshed page load per
       cytube.pc.user.js's own comment (see src/pc/modules/tonights-lineup/index.js,
       lineupObserveTitleChange) -- it isn't guaranteed to. Without a second
       source for the movie title, _currentMovieKey stays null after a
       refresh and tryRestoreSubCache() never even gets called. cytube.pc.user.js
       solves this exact problem for its own "now playing" title by watching
       #currenttitle directly instead of only the socket (see
       src/pc/modules/movie-title-links/index.js, watchMovieTitle/
       attachHeaderObserver) -- same fix applied here, scoped to just updating the cache key and
       attempting a restore (never resetSubtitles(): on an actual movie
       change changeMedia already owns the reset, and this path racing it
       could wipe subtitles changeMedia's own restore just applied).
    ========================================================== */
    function getDomMovieTitle() {
        const el = document.getElementById('currenttitle')
            || document.querySelector('#videowrap-header .pull-left')
            || document.querySelector('#videowrap-header span')
            || document.querySelector('.video-title');
        if (!el) return '';
        return el.textContent.trim()
            .replace(/^currently\s+playing[:\s]*/i, '')
            .replace(/^now\s+playing[:\s]*/i, '').trim();
    }

    function updateMovieKeyFromDom() {
        const raw = getDomMovieTitle();
        if (!raw || raw.length < 2) return;
        _currentMovieKey = raw;
        // Always re-attempt (not just on a key change): the title can be
        // known before the <video> element exists yet on a cold load, and
        // tryRestoreSubCache() itself bails out silently if there's no
        // video to attach to (see its `if (!video) return;`), with no
        // retry of its own -- so if the *only* trigger were "key changed",
        // that one early miss would be permanent. This call is cheap and
        // already double-guarded (no-ops once something is loaded, or if
        // the key hasn't resolved yet).
        tryRestoreSubCache();
    }

    // Named _subCacheTitleObsAttached (not _titleObsAttached) -- movie-title-links
    // (src/pc/modules/movie-title-links/index.js) declares its own module-scope
    // `_titleObsAttached` for the *same purpose* against a *different* observer
    // (its own now-playing title injection), and both modules share one outer
    // scope once concatenated into a bundle -- an unqualified name here would
    // collide with a duplicate `let` declaration.
    let _subCacheTitleObsAttached = false;
    function attachTitleObserver() {
        if (_subCacheTitleObsAttached) return;
        const header = document.getElementById('videowrap-header');
        if (!header) return;
        _subCacheTitleObsAttached = true;
        new MutationObserver(updateMovieKeyFromDom).observe(header, { childList: true, subtree: true, characterData: true });
    }

    function watchMovieTitleForCache() {
        updateMovieKeyFromDom();
        attachTitleObserver();
        // Poll for ~20s on cold load in case the header isn't ready yet
        // (same pattern/budget as watchMovieTitle() in
        // src/pc/modules/movie-title-links/index.js).
        let tries = 0;
        const poll = setInterval(() => {
            attachTitleObserver();
            updateMovieKeyFromDom();
            if (++tries >= 14) clearInterval(poll);
        }, 1500);
    }

    /* ==========================================================
       MOVIE-CHANGE RESET
       movie-title-links' own initMediaWatcher() (src/pc/modules/movie-title-links/index.js)
       establishes the reliable signal for this: CyTube's own changeMedia
       socket event fires on every movie change (reused/queued video or a
       fresh one), whether or not the underlying <video> DOM node is
       actually replaced. That's the PRIMARY reset trigger here too --
       renamed to watchVideoSwapForSubtitleCache() (rather than the
       original script's identically-named initMediaWatcher) since both
       modules share one outer scope once concatenated into a bundle,
       and a duplicate function declaration would silently shadow one of
       the two. A video-element-identity poll (same 800ms cadence as the
       trigger-button-state poll) is a defensive backstop for the case
       where the socket hasn't bound yet -- it only resets (no
       cache-restore attempt, since it has no title to key against). Both
       paths call the same idempotent resetSubtitles(), so double-firing
       on an actual movie change is harmless.
    ========================================================== */
    let _lastVideoEl = null;
    function checkVideoSwap() {
        const video = getPlayerVideoEl();
        if (video !== _lastVideoEl) {
            _lastVideoEl = video;
            if (_subTrack) resetSubtitles();
            // The <video> element itself can appear after the DOM-title
            // watcher has already resolved _currentMovieKey (cold load:
            // title text shows before the player finishes attaching) --
            // covers the reverse ordering of the race handled above in
            // updateMovieKeyFromDom(). No-ops via tryRestoreSubCache()'s
            // own guards if there's nothing to restore.
            else if (video) tryRestoreSubCache();
        }
    }

    function watchVideoSwapForSubtitleCache() {
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
       the arrow-key seeking listener in
       src/pc/core/12-playback-sync-and-seek.js uses
       (a second, independent listener; no conflict since the
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
       Named subtitlesBoot (not waitForBody) — core's own 16-boot.js
       declares a generic waitForBody in the same shared scope; this
       module's boot routine has always been distinct code, so it gets
       its own name here to avoid the collision now that both files
       share one IIFE. Called directly here (not via scRegisterInit) to
       preserve the original script's document-start timing --
       scRegisterInit's queue only runs on the page's 'load' event, and
       the trigger-button MutationObserver below needs to be attached
       well before that to catch early DOM mutations.
    ========================================================== */
    function subtitlesBoot() {
        if (!document.body) { requestAnimationFrame(subtitlesBoot); return; }

        ensureTriggerButton();
        updateTriggerButtonState();
        applyCueStyle();
        watchVideoSwapForSubtitleCache();
        watchMovieTitleForCache();
        setInterval(checkVideoSwap, 800);

        new MutationObserver(() => {
            ensureTriggerButton();
            updateTriggerButtonState();
        }).observe(document.body, { childList: true, subtree: true });

        setInterval(updateTriggerButtonState, 800);
    }
    subtitlesBoot();
