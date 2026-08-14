# Local subtitle loader/sync userscript — design

## Goal

A new standalone userscript, `cytube.subtitles.user.js`, that lets a viewer
load a local `.srt`/`.vtt` subtitle file and have it render synced to
playback, for movies played via a direct video link (native `<video>`
element). A live sync-offset control (keybinds + panel) compensates for
subtitle files that aren't perfectly time-aligned to the specific rip being
played — the common case for community-sourced subtitles.

Follows the same "works alone, upgrades when `cytube.pc.user.js` is
installed" relationship `cytube.gifmaker.user.js` and
`cytube.chatimages.user.js` already have with the main script.

## Non-goals

- **YouTube playback is explicitly out of scope.** Cross-origin restrictions
  mean this script cannot read a YouTube iframe's play position or inject
  anything synced to it. The trigger button is disabled (with a tooltip)
  whenever YouTube is the active media, using the same detection
  `cytube.gifmaker.user.js` already uses.
- No persistence. Per the product decision, the loaded file and offset are
  session-only (in-memory) — nothing is written to `localStorage`, and
  nothing here touches the shared Settings Modal in `cytube.pc.user.js`.
- No changes to any existing script. This is a pure addition; it only reads
  the existing PC bridge object.

## Script metadata

```
// ==UserScript==
// @name         CyTube Subtitle Sync
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Load a local .srt/.vtt subtitle file and sync it to native <video> playback, with a live offset control for imperfectly-aligned files. Not available for YouTube playback. Integrates with cytube.pc.user.js when installed.
// @match        https://cytu.be/r/420Grindhouse
// @match        https://cytu.be/r/testing
// @run-at       document-start
// ==/UserScript==
```

No `@grant` — pure client-side DOM/file manipulation, no network calls, no
`localStorage`.

## Player / media-type detection (reused verbatim from `cytube.gifmaker.user.js`)

```js
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
```

(Source: `cytube.gifmaker.user.js:57-69`.)

## PC-script bridge (reused verbatim pattern)

```js
let PC_MODE = false;
function readPcBridge() {
    const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const b = w.__SC_GIF_BRIDGE__;
    return (b && typeof b.getTitleSlug === 'function') ? b : null;
}

const PC_BRIDGE_POLL_MS = 50;
const PC_BRIDGE_POLL_TIMEOUT_MS = 1500;

function waitForBody() {
    if (!document.body) { requestAnimationFrame(waitForBody); return; }

    if (readPcBridge()) PC_MODE = true;
    ensureTriggerButton();
    updateTriggerButtonState();
    injectCueCss();
    initMediaWatcher();
    setInterval(checkVideoSwap, 800);

    if (!PC_MODE) {
        let elapsed = 0;
        const pollTimer = setInterval(() => {
            elapsed += PC_BRIDGE_POLL_MS;
            if (readPcBridge()) {
                PC_MODE = true;
                const oldBtn = document.getElementById('scsub-trigger-btn');
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
```

This script doesn't need anything *from* the bridge object — `PC_MODE` only
decides how the trigger button anchors (see UI below). No new bridge fields
are added to `cytube.pc.user.js`.

## Subtitle state & parsing

Module-level state (session-only, no persistence):

```js
let _subTrack = null;          // the TextTrack we created via addTextTrack
let _subCuesOriginal = [];     // [{start, end, text}] as parsed, unmodified by offset
let _subOffsetMs = 0;
let _loadedFilename = '';
```

Parser — accepts SRT (`00:00:20,000 --> 00:00:23,400`, optional leading
numeric index line) and VTT (`00:00:20.000 --> 00:00:23.400`, `WEBVTT`
header) in one pass, since the only structural differences are the header
line and the `,`/`.` millisecond separator:

```js
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
```

Worked example for self-review: `"00:01:02,500"` → `1*3600? no — 0*3600 +
1*60 + 2 + 500/1000 = 62.5`. A block `"1\n00:00:20,000 --> 00:00:23,400\nHello\nworld"`
→ index line `"1"` matches `/^\d+$/` so `idx=1`, time line at `lines[1]`
matches, `cueText = "Hello\nworld"`, `start=20`, `end=23.4`.

## Track application & offset

Cues are added to a native `TextTrack` via `addTextTrack`/`VTTCue` — the
browser owns rendering and sync to `video.currentTime`, this script never
touches `timeupdate`. Offset changes rebuild every cue from its **original**
parsed time plus the current offset (not incremental deltas), so repeated
nudges never accumulate floating-point drift:

```js
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
```

## Movie-change reset (authoritative signal + defensive backstop)

`cytube.pc.user.js:1605-1622` establishes the reliable pattern: CyTube's own
`changeMedia` socket event fires on every movie change (reused/queued video
or a fresh one), whether or not the underlying `<video>` DOM node is
actually replaced. This is the **primary** reset trigger:

```js
function resetSubtitles() {
    clearSubtitleTrack();
    updateOffsetDisplay();
    clearPanelError();
}

function initMediaWatcher() {
    const tryBind = () => {
        if (typeof socket === 'undefined' || !socket || !socket.on) return;
        socket.on('changeMedia', () => resetSubtitles());
    };
    window.addEventListener('load', () => { tryBind(); setTimeout(tryBind, 2000); });
}
```

A lightweight defensive backstop (video-element identity check, polled the
same 800ms cadence as the button-state poll) covers the case where the
socket hasn't bound yet:

```js
let _lastVideoEl = null;
function checkVideoSwap() {
    const video = getPlayerVideoEl();
    if (video !== _lastVideoEl) {
        _lastVideoEl = video;
        if (_subTrack) resetSubtitles(); // no-op if nothing was loaded yet
    }
}
```

Both paths call the same idempotent `resetSubtitles()`, so double-firing on
an actual movie change is harmless.

## UI

### Trigger button (dual anchor, mirrors `cytube.gifmaker.user.js:2026-2113`)

Standalone: a native-styled button (`.btn.btn-sm.btn-default`) appended into
`#videocontrols`'s button group. PC mode: a floating `#scsub-trigger-btn`
circular button positioned via the existing `--sc-chat-w`/`--sc-chat-h` CSS
vars, participating in the shared `.sc-bar-dim` auto-dim system:

```js
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
            padding: 0 !important; font-size: 13px !important;
            cursor: pointer !important;
            display: flex !important; align-items: center !important; justify-content: center !important;
            transition: color 0.3s ease, background 0.3s ease, transform 0.3s ease, opacity 0.3s ease !important;
        }
        #scsub-trigger-btn.sc-bar-dim { transform: translateX(60px) !important; opacity: 0 !important; pointer-events: none !important; }
        #scsub-trigger-btn:hover { color: white !important; background: rgba(255,255,255,0.22) !important; }
        body.sc-horizontal #scsub-trigger-btn {
            bottom: 6px !important;
            right: calc(var(--sc-chat-w) + 1vw + 152px) !important;
        }
        body.sc-vertical #scsub-trigger-btn {
            bottom: calc(var(--sc-chat-h) + 1vh) !important;
            right: 152px !important;
        }
        #scsub-trigger-btn:disabled { opacity: 0.35 !important; cursor: default !important; pointer-events: none !important; }
        #scsub-trigger-btn.sc-bar-dim:disabled { opacity: 0 !important; }
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
```

`right: calc(var(--sc-chat-w) + 1vw + 152px)` / `right: 152px` leaves room
to the left of `cytube.gifmaker.user.js`'s floating button (`+116px`) so
the two don't overlap when both are installed — 36px of clearance between
28px-wide circular buttons.

### Panel

Draggable, styled like the GIF/Settings panels (`#0c0c0e` background,
`#f4f4f2` text, `rgba(244,244,242,0.08-0.14)` hairline borders,
`rgba(255,255,255,0.08)`→`rgba(255,255,255,0.22)` button hover — same
values as `cytube.gifmaker.user.js:78-107`). Contents:

```html
<div id="sc-sub-panel">
  <div id="sc-sub-head">Subtitles <button id="sc-sub-close">✕</button></div>
  <div id="sc-sub-body">
    <input type="file" id="sc-sub-file" accept=".srt,.vtt">
    <div id="sc-sub-filename"></div>
    <div id="sc-sub-offset-row">
      <button id="sc-sub-offset-minus">−100ms</button>
      <span id="sc-sub-offset-value">0ms</span>
      <button id="sc-sub-offset-plus">+100ms</button>
      <input type="number" id="sc-sub-offset-input" step="100">
      <button id="sc-sub-offset-set">Set</button>
    </div>
    <button id="sc-sub-clear">Clear subtitles</button>
    <div id="sc-sub-error"></div>
  </div>
</div>
```

Wiring: the file input's `change` handler reads the picked `File` via
`FileReader.readAsText`, calls `parseSubtitleFile`, and on success calls
`applySubtitles(getPlayerVideoEl(), cues, file.name)`; on empty/parse
failure it writes to `#sc-sub-error` instead of throwing. `−100ms`/`+100ms`
call `nudgeOffsetMs(±100)`. `Set` parses `#sc-sub-offset-input` and calls
`setOffsetMs`. `Clear subtitles` calls `resetSubtitles()`.
`updateOffsetDisplay()` writes `_subOffsetMs + 'ms'` into
`#sc-sub-offset-value` and `_loadedFilename` (or `"No file loaded"`) into
`#sc-sub-filename`.

### Keybinds

Global `keydown` listener, guarded against firing while chat/any input is
focused — same guard `cytube.pc.user.js:1719-1721` already uses for its own
arrow-key seeking listener (a second, independent listener; no conflict
since the key sets don't overlap):

```js
document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
    if (!_subTrack) return;
    if (e.key === '[') { nudgeOffsetMs(e.shiftKey ? -1000 : -100); return; }
    if (e.key === ']') { nudgeOffsetMs(e.shiftKey ?  1000 :  100); return; }
});
```

### `::cue` styling

```js
function injectCueCss() {
    if (document.getElementById('scsub-cue-style')) return;
    const style = document.createElement('style');
    style.id = 'scsub-cue-style';
    style.textContent = `
        video::cue {
            background: rgba(0,0,0,0.6);
            color: #f4f4f2;
            font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
            font-size: 1.05em;
        }
    `;
    document.head.appendChild(style);
}
```

## Edge cases

- File with zero parsed cues (empty/garbage content): `#sc-sub-error` shows
  "No subtitle cues found in this file", nothing is applied, previous
  subtitles (if any) stay loaded.
- Picking a new file while one is already loaded: `applySubtitles` calls
  `clearSubtitleTrack()` first, so the old `TextTrack`'s cues are fully
  removed before the new ones are added — no leftover stale cues.
- No native `<video>` present when a file is picked (e.g. between videos, or
  YouTube active): `#sc-sub-error` shows "No video found to attach
  subtitles to."; the button itself is already disabled during YouTube
  playback so this mainly covers the brief gap between videos.
- `changeMedia` fires but nothing was loaded yet: `resetSubtitles()` is a
  no-op past `clearSubtitleTrack()`'s already-empty state — safe to call
  unconditionally.
- Both `cytube.gifmaker.user.js` and this script installed in PC mode: the
  floating buttons are horizontally spaced (152px vs 116px from the chat
  edge) so they don't overlap.

## Testing plan

Manual, in a live cytu.be room (no automated test suite exists for these
userscripts, per repo convention — `node --check` for syntax plus
hand-worked self-review of the parser math, same as the filename-tag and
chat-images features):

1. Install standalone (no `cytube.pc.user.js`). Load a direct-link video,
   confirm the subtitle button appears in the native control bar.
2. Pick a `.srt` file — confirm cues render synced to playback, styled per
   `::cue` (dark translucent background, not the browser default).
3. Nudge offset with `[`/`]` during playback — confirm the displayed text's
   timing visibly shifts; confirm `Shift+[`/`Shift+]` shifts by 1s instead
   of 100ms.
4. Confirm keybinds do nothing while the chat textbox is focused.
5. Open a `.vtt` file instead — confirm it also parses and renders.
6. Queue/advance to a new movie — confirm subtitles and the offset display
   reset automatically (no stale text or leftover offset).
7. Switch to a YouTube video — confirm the button is disabled with the
   "Not available for YouTube videos" tooltip, and re-enables when a
   direct-link video plays again.
8. Install `cytube.pc.user.js` alongside it — confirm the floating themed
   button appears instead of the control-bar button, and that it doesn't
   overlap `cytube.gifmaker.user.js`'s floating button if that's installed
   too.
9. Load a subtitle file, then click "Clear subtitles" — confirm cues
   disappear and the panel resets to "No file loaded" / `0ms`.
