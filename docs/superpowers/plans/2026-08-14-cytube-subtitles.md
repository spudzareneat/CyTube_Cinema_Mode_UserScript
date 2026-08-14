# Local Subtitle Loader/Sync Userscript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a new standalone userscript, `cytube.subtitles.user.js`, that lets a viewer load a local `.srt`/`.vtt` file and see it rendered synced to native `<video>` playback, with a live offset control (keybinds + panel) to compensate for imperfectly time-aligned subtitle files.

**Architecture:** One new file, three build-up stages: (1) player/media detection, PC-script bridge, and a dual-anchor trigger button; (2) the SRT/VTT parser, a native `TextTrack`/`VTTCue`-based sync engine with offset support, and the file-picker panel; (3) `[`/`]` offset keybinds and automatic reset on every movie change via CyTube's `changeMedia` socket event (plus a defensive video-swap poll). No other file in the repo is touched.

**Tech Stack:** Tampermonkey userscript (vanilla JS, no build step, no dependencies).

**Spec:** `docs/superpowers/specs/2026-08-14-cytube-subtitles-design.md`

## Global Constraints

- No automated test framework in this repo — verification is `node --check cytube.subtitles.user.js` (syntax only) plus hand-worked self-review, same convention as every other plan in this repo.
- YouTube playback is explicitly out of scope. The trigger button must be `disabled` (not hidden) whenever `isYouTubeMedia()` is true, with a tooltip explaining why.
- No `localStorage` persistence anywhere in this script — loaded file and offset are session-only in-memory state (`_subTrack`, `_subCuesOriginal`, `_subOffsetMs`, `_loadedFilename`), per the spec's explicit product decision.
- Detection/bridge code (`getPlayerVideoEl`, `isYouTubeMedia`, `readPcBridge`, the `PC_BRIDGE_POLL_MS`/`PC_BRIDGE_POLL_TIMEOUT_MS` poll shape) must match `cytube.gifmaker.user.js:42-69,2118-2169` exactly — these are proven, load-bearing patterns, not to be redesigned.
- Offset math always recomputes each cue's `startTime`/`endTime` from its **original** parsed value plus the current `_subOffsetMs` (never an incremental delta applied to already-adjusted cues) — this is what prevents floating-point drift across repeated nudges.
- `resetSubtitles()` must be safe to call unconditionally (idempotent no-op when nothing is loaded) — both the `changeMedia` handler and the video-swap backstop call it without checking state first.
- Element IDs use the `sc-sub-*` / `scsub-*` prefix (mirroring `sc-gif-*` / `scgm-*` in `cytube.gifmaker.user.js`) so they can never collide with IDs from the other companion scripts.

---

### Task 1: Detection, PC bridge, and trigger button

**Files:**
- Create: `cytube.subtitles.user.js`

**Interfaces:**
- Produces: `getPlayerVideoEl() → Element|null`, `isYouTubeMedia() → boolean`, `readPcBridge() → object|null`, `PC_MODE` (module-level `let`), `openSubtitlePanel()` (stub, replaced in Task 2), `ensureTriggerButton()`, `updateTriggerButtonState()`.
- Consumes: nothing (first task).

- [ ] **Step 1: Create the file with header, detection, bridge, stub panel, trigger button, and boot sequence**

Create `cytube.subtitles.user.js` with this exact content:

```js
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
```

- [ ] **Step 2: Verify syntax**

Run: `node --check cytube.subtitles.user.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Self-review**

Trace through and confirm:
1. `isYouTubeMedia()` and `getPlayerVideoEl()` are byte-identical to `cytube.gifmaker.user.js:57-69` — no accidental drift.
2. In PC mode, `ensureTriggerButton()` creates `#scsub-trigger-btn` once (guarded by the `getElementById` check) and never duplicates it on repeated `MutationObserver`/`waitForBody` calls.
3. In standalone mode, if `#videocontrols` doesn't exist yet (page still loading), `ensureTriggerButton()` returns early without throwing — the `MutationObserver` and the 800ms poll both retry it.
4. `updateTriggerButtonState()` looks up the button by the ID matching the current `PC_MODE`, so it never silently no-ops after a standalone→PC upgrade mid-session.
5. The late-bridge poll branch removes `#scsub-standalone-btn` before calling `ensureTriggerButton()` again in PC mode — no leftover duplicate button after a late-loading `cytube.pc.user.js`.
6. Clicking the button before Task 2 lands only logs to console — no thrown error.

- [ ] **Step 4: Manual browser verification**

Load the userscript in a Tampermonkey dev profile against a live CyTube room (`420Grindhouse` or `testing`), standalone first (no `cytube.pc.user.js` installed):
1. Confirm a "CC" button appears in the native video control bar.
2. Play a direct-link (non-YouTube) video — confirm the button is enabled.
3. Play a YouTube video — confirm the button becomes disabled with tooltip "Not available for YouTube videos".
4. Click the enabled button — confirm only a console log appears, no error.

Then install `cytube.pc.user.js` alongside it and reload — confirm a floating circular "CC" button appears instead (positioned left of `cytube.gifmaker.user.js`'s floating button if that script is also installed, with visible gap between them), and repeat the enable/disable check.

- [ ] **Step 5: Commit**

```bash
git add cytube.subtitles.user.js
git commit -m "Add subtitle sync script scaffold: detection, PC bridge, trigger button"
```

---

### Task 2: SRT/VTT parsing, sync engine, and panel UI

**Files:**
- Modify: `cytube.subtitles.user.js`

**Interfaces:**
- Consumes: `getPlayerVideoEl()`, `PC_MODE` (Task 1).
- Produces: `parseSubtitleFile(text) → [{start, end, text}]`, `applySubtitles(video, cues, filename)`, `clearSubtitleTrack()`, `rebuildCues()`, `setOffsetMs(ms)`, `nudgeOffsetMs(deltaMs)`, `resetSubtitles()`, `updateOffsetDisplay()`, `showPanelError(msg)`, `clearPanelError()`, module state `_subTrack`, `_subCuesOriginal`, `_subOffsetMs`, `_loadedFilename` — all consumed by Task 3's keybinds and movie-change reset.

- [ ] **Step 1: Replace the stub panel with the full parsing/sync/panel implementation**

Find this exact block:
```js
    /* ==========================================================
       SUBTITLE PANEL (stub — replaced in Task 2)
    ========================================================== */
    function openSubtitlePanel() {
        console.log('[SC] cytube.subtitles: panel not yet implemented');
    }
```
Replace with:
```js
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
    }

    function rebuildCues() {
        if (!_subTrack) return;
        while (_subTrack.cues && _subTrack.cues.length) _subTrack.removeCue(_subTrack.cues[0]);
        const offsetSec = _subOffsetMs / 1000;
        for (const c of _subCuesOriginal) {
            const start = Math.max(0, c.start + offsetSec);
            const end = Math.max(start + 0.01, c.end + offsetSec);
            try { _subTrack.addCue(new VTTCue(start, end, c.text)); } catch (e) {}
        }
    }

    function setOffsetMs(ms) {
        _subOffsetMs = ms;
        rebuildCues();
        updateOffsetDisplay();
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
                font-weight: 600 !important; font-size: 14px !important; color: #f4f4f2 !important;
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
                padding: 16px !important; display: flex !important; flex-direction: column !important; gap: 12px !important;
            }
            #sc-sub-filename { font-size: 12px !important; color: rgba(244,244,242,0.62) !important; }
            #sc-sub-offset-row {
                display: flex !important; align-items: center !important; gap: 8px !important; flex-wrap: wrap !important;
            }
            #sc-sub-offset-row button {
                background: rgba(255,255,255,0.08) !important; color: #f4f4f2 !important;
                border: 1px solid rgba(255,255,255,0.18) !important; border-radius: 6px !important;
                padding: 4px 8px !important; cursor: pointer !important; font-size: 12px !important;
                transition: background 120ms ease !important;
            }
            #sc-sub-offset-row button:hover { background: rgba(255,255,255,0.22) !important; }
            #sc-sub-offset-value { font-size: 12px !important; min-width: 56px !important; text-align: center !important; }
            #sc-sub-offset-input {
                width: 70px !important; background: rgba(255,255,255,0.06) !important; color: #f4f4f2 !important;
                border: 1px solid rgba(255,255,255,0.18) !important; border-radius: 6px !important; padding: 4px 6px !important;
            }
            #sc-sub-clear {
                background: rgba(255,255,255,0.08) !important; color: #f4f4f2 !important;
                border: 1px solid rgba(255,255,255,0.18) !important; border-radius: 6px !important;
                padding: 6px 10px !important; cursor: pointer !important; font-size: 12px !important;
                align-self: flex-start !important;
            }
            #sc-sub-clear:hover { background: rgba(255,255,255,0.22) !important; }
            #sc-sub-error { font-size: 12px !important; color: #ff6b6b !important; min-height: 14px !important; }
            video::cue {
                background: rgba(0,0,0,0.6);
                color: #f4f4f2;
                font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
                font-size: 1.05em;
            }
        `;
        document.head.appendChild(style);
    }

    function openSubtitlePanel() {
        if (document.getElementById('sc-sub-panel')) return;
        injectPanelCss();

        const panel = document.createElement('div');
        panel.id = 'sc-sub-panel';
        panel.innerHTML = `
            <div id="sc-sub-head">Subtitles <button id="sc-sub-close" type="button">✕</button></div>
            <div id="sc-sub-body">
                <input type="file" id="sc-sub-file" accept=".srt,.vtt">
                <div id="sc-sub-filename">No file loaded</div>
                <div id="sc-sub-offset-row">
                    <button id="sc-sub-offset-minus" type="button">−100ms</button>
                    <span id="sc-sub-offset-value">0ms</span>
                    <button id="sc-sub-offset-plus" type="button">+100ms</button>
                    <input type="number" id="sc-sub-offset-input" step="100">
                    <button id="sc-sub-offset-set" type="button">Set</button>
                </div>
                <button id="sc-sub-clear" type="button">Clear subtitles</button>
                <div id="sc-sub-error"></div>
            </div>`;
        document.body.appendChild(panel);

        const $ = id => panel.querySelector(id);
        updateOffsetDisplay();

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
        $('#sc-sub-clear').addEventListener('click', () => resetSubtitles());

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
```

- [ ] **Step 2: Verify syntax**

Run: `node --check cytube.subtitles.user.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Self-review**

Trace through and confirm:
1. `parseSubtitleFile` worked example: block `"1\n00:00:20,000 --> 00:00:23,400\nHello\nworld"` — `lines[0]` is `"1"`, matches `/^\d+$/` so `idx=1`; `timeRe.exec(lines[1])` matches with `m[1..4] = 00,00,20,000` and `m[5..8] = 00,00,23,400`; `start = 0*3600 + 0*60 + 20 + 0 = 20`, `end = 0*3600 + 0*60 + 23 + 400/1000 = 23.4`; `cueText = "Hello\nworld"`; pushed since `cueText` truthy and `23.4 > 20`.
2. A VTT block with no index line — `"00:01:02.500 --> 00:01:05.000\nText"` — `lines[0]` is the time line itself (doesn't match `/^\d+$/` because of the colons), so `idx` stays `0` and `timeRe.exec(lines[0])` still matches (the `[.,]` alternation accepts the period separator). Correctly handled without the `WEBVTT` header even being present in this block, since the header strip only removes the first line of the whole file, not per-block.
3. `rebuildCues()` always recomputes from `_subCuesOriginal`, never from the currently-live `_subTrack.cues` — confirms repeated `nudgeOffsetMs` calls can't accumulate drift.
4. `applySubtitles` calls `clearSubtitleTrack()` first — picking a second file fully removes the first `TextTrack`'s cues (via `while (...) removeCue(...)`) before adding new ones, no leftover stale cues, and `_subTrack` is reassigned to the fresh track object addTextTrack returns.
5. `resetSubtitles()` is safe to call with nothing loaded: `clearSubtitleTrack()` on an already-`null` `_subTrack` just skips its `if (_subTrack)` body and resets already-default state; `updateOffsetDisplay()`/`clearPanelError()` are null-guarded against the panel not being open.
6. Every panel-DOM-touching helper (`updateOffsetDisplay`, `showPanelError`) uses `document.getElementById` with a null check, not the panel-scoped `$` — safe to call whether or not `openSubtitlePanel()` has ever run.
7. `openSubtitlePanel()` guards re-entry via `if (document.getElementById('sc-sub-panel')) return;` — clicking the trigger button twice doesn't create a duplicate panel.
8. The drag handlers are structurally identical to `cytube.gifmaker.user.js:1466-1492` (pointerdown/pointermove/pointerup/pointercancel, `setPointerCapture`/`releasePointerCapture`, `important`-flagged inline style overrides) — proven pattern, no modification.

- [ ] **Step 4: Manual browser verification**

In the same dev profile, on a direct-link video:
1. Click the trigger button — confirm the panel opens, centered, showing "No file loaded" and "0ms".
2. Drag the panel by its header — confirm it moves and the cursor shows grabbing while held.
3. Pick a real `.srt` file (any downloaded movie/show subtitle file) — confirm the filename appears, and subtitle text renders over the video in sync with dialogue, styled with a dark translucent background (not the browser's default subtitle styling).
4. Click `+100ms` and `−100ms` a few times — confirm the displayed offset value updates and subtitle timing visibly shifts.
5. Type a value like `-2000` into the offset number field and click `Set` — confirm subtitles jump to a 2-second-early offset immediately.
6. Convert (or find) the same file as `.vtt` and load it — confirm it also parses and renders correctly.
7. Click `Clear subtitles` — confirm captions disappear and the panel resets to "No file loaded" / "0ms".
8. Try loading a garbage `.txt` file renamed to `.srt` — confirm `#sc-sub-error` shows "No subtitle cues found in this file." instead of throwing a console error.

- [ ] **Step 5: Commit**

```bash
git add cytube.subtitles.user.js
git commit -m "Add SRT/VTT parsing, native TextTrack sync engine, and subtitle panel"
```

---

### Task 3: Offset keybinds and movie-change auto-reset

**Files:**
- Modify: `cytube.subtitles.user.js`

**Interfaces:**
- Consumes: `nudgeOffsetMs(deltaMs)`, `resetSubtitles()`, `_subTrack`, `getPlayerVideoEl()` (Tasks 1-2).
- Produces: `checkVideoSwap()`, `initMediaWatcher()`, `_lastVideoEl` — plus the boot wiring that calls them.

- [ ] **Step 1: Add movie-change reset and offset keybinds**

Find this exact block:
```js
    /* ==========================================================
       BOOT
    ========================================================== */
    const PC_BRIDGE_POLL_MS = 50;
```
Replace with:
```js
    /* ==========================================================
       MOVIE-CHANGE RESET
       cytube.pc.user.js:1605-1622 establishes the reliable signal for
       this: CyTube's own changeMedia socket event fires on every movie
       change (reused/queued video or a fresh one), whether or not the
       underlying <video> DOM node is actually replaced. That's the
       PRIMARY reset trigger. A video-element-identity poll (same 800ms
       cadence as the trigger-button-state poll) is a defensive backstop
       for the case where the socket hasn't bound yet. Both paths call
       the same idempotent resetSubtitles(), so double-firing on an
       actual movie change is harmless.
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
            socket.on('changeMedia', () => resetSubtitles());
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
```

- [ ] **Step 2: Wire the media watcher and swap poll into boot**

Find this exact block:
```js
        if (readPcBridge()) PC_MODE = true;
        ensureTriggerButton();
        updateTriggerButtonState();

        if (!PC_MODE) {
```
Replace with:
```js
        if (readPcBridge()) PC_MODE = true;
        ensureTriggerButton();
        updateTriggerButtonState();
        initMediaWatcher();
        setInterval(checkVideoSwap, 800);

        if (!PC_MODE) {
```

- [ ] **Step 3: Verify syntax**

Run: `node --check cytube.subtitles.user.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Self-review**

Trace through and confirm:
1. `checkVideoSwap()` on its very first call has `_lastVideoEl === null`; if a video element already exists, `video !== _lastVideoEl` is true, `_lastVideoEl` is set, but `resetSubtitles()` is skipped because `_subTrack` is still `null` at that point (nothing loaded yet) — no spurious reset/log on boot.
2. `initMediaWatcher()`'s `tryBind` no-ops silently (`return`) if `socket` isn't defined yet or has no `.on` — matches `cytube.pc.user.js:1607` exactly, and the `setTimeout(tryBind, 2000)` retry covers the case where `socket` appears shortly after `load`.
3. Both `checkVideoSwap` and the `changeMedia` handler call the same `resetSubtitles()` — confirms double-firing on a real movie change (both paths noticing) is harmless, per the Global Constraints note.
4. The keybind handler's input-focus guard is checked before the `!_subTrack` check and before either key branch — typing `[` or `]` in chat never nudges the offset.
5. `Shift+[`/`Shift+]` produce `-1000`/`1000` respectively (`e.shiftKey ? -1000 : -100` and `e.shiftKey ? 1000 : 100`) — confirm this isn't inverted.
6. The Step 2 boot edit places `initMediaWatcher()`/`setInterval(checkVideoSwap, 800)` calls unconditionally (before the `if (!PC_MODE)` branch), so both standalone and PC mode get movie-change reset — not just one.

- [ ] **Step 5: Manual browser verification**

On a direct-link video with a subtitle file loaded and playing:
1. Press `[` a few times — confirm the panel's offset value (open the panel to check) decreases by 100ms each press and the on-screen caption timing visibly shifts earlier.
2. Press `Shift+[` once — confirm the offset drops by 1000ms in one press.
3. Press `]`/`Shift+]` — confirm offset increases correctly (inverse of steps 1-2).
4. Click into the chat textbox and press `[`/`]` — confirm nothing happens to the offset and the characters type normally into chat.
5. With a subtitle file loaded, queue and advance to a new video (or have another user in the room change the video) — confirm subtitles disappear and, if you reopen the panel, it shows "No file loaded" / "0ms" again.
6. Reload the page mid-movie (so the socket's `changeMedia` resync fires on load) with no subtitles loaded — confirm no console error from `resetSubtitles()` running against empty state.

- [ ] **Step 6: Commit**

```bash
git add cytube.subtitles.user.js
git commit -m "Add offset keybinds and automatic reset on movie change"
```
