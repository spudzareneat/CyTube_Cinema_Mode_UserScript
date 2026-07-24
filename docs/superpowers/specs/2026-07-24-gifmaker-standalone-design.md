# Standalone GIF Maker userscript — design

## Goal

Split the scene-to-GIF feature out of `cytube.pc.user.js` into a new, independent,
lighter userscript: `cytube.gifmaker.user.js`. `cytube.pc.user.js` is not modified.

The new script does exactly one thing: lets you capture a GIF of the last few
seconds of the movie, with meme captions, and optionally upload it to ImgBB.
It works standalone on CyTube's normal (non-fullscreen-overlay) layout, via a
small floating record button drawn in the corner of the video player itself.

## Non-goals

Everything else in `cytube.pc.user.js` is out of scope: TMDB lookups, movie
links, Tonight's Lineup, chat overlay/spellcheck/tab-complete, fullscreen
layout, desync/sync-offset, emote relocation, poster strip, top-bar dimming.
None of that code, or its localStorage keys, is touched or ported.

## Script metadata

```
// @name         CyTube GIF Maker
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @match        https://cytu.be/r/420Grindhouse
// @match        https://cytu.be/r/testing
// @grant        GM_xmlhttpRequest
// @require      https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.js
// @connect      cdnjs.cloudflare.com
// @connect      api.imgbb.com
// @run-at       document-start
```

Same `@match` list as `cytube.pc.user.js` (same two channels), so the two
scripts can be installed side by side.

## Storage

Single localStorage key, same name pc.user.js already uses:

```
const LS_IMGBB = 'sc_imgbb_key';   // shared key name — same origin, so if
                                     // both scripts are installed the key
                                     // entered in either one is visible to both
```

No other persisted state. No settings modal, no first-run onboarding flow.

## Components

### 1. Video-corner record button

- On load (and via a ~800ms poll, matching pc.user.js's existing monitor-watcher
  cadence, since `#videowrap`'s children can be replaced by CyTube's own JS),
  ensure a `◉` button exists as the last child of `#videowrap`.
- CSS forces `#videowrap { position: relative !important; }` (harmless on
  CyTube's default layout) so the button can be `position: absolute; top: 8px;
  right: 8px;` — anchored to the video frame itself, not the viewport.
- Click opens the GIF panel (see below), same as pc.user.js's `sc-gif-btn`.
- Visibility: hidden whenever `isYouTubeMedia()` is true (see below) — YouTube
  embeds have no directly-capturable `<video crossOrigin>` source, so the whole
  feature is inapplicable there. Same disqualification logic as
  `captureGifFrames`'s existing "streaming/blob source" guard, just applied
  earlier (hide the entry point instead of showing an error after the fact).

```js
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

### 2. GIF panel — ported from `cytube.pc.user.js` almost verbatim

Carries over these functions essentially unchanged (same behavior, same CSS
classes/ids so existing panel styling just works):

- `getPlayerVideoEl`, `getScrubClone`/`destroyScrubClone`/`grabPreviewFrame`
  (live scrub-bar thumbnails)
- `computeFrameGeometry`, `captureGifFrames` (hidden crossOrigin clone →
  `requestVideoFrameCallback` → canvas sampling)
- `wrapCaptionAtSize`, `applyCaptionCtxStyle`, `drawCaptionBlockAdvanced`,
  `drawCaptions`, `getCaptionMeasureCtx` (meme caption rendering, shared by
  live CSS preview and final per-frame canvas render)
- `getGifWorkerUrl`, `getGifCtor`, `encodeGif` (gif.js via same-origin blob
  worker)
- `blobToBase64`, `uploadToImgbb`, `validateImgbbKey` (ImgBB upload/test)
- `_fmtClockTenths`, `_escHtml`
- `openGifPanel` and its full body: draggable panel, start/end scrub marks
  with live thumbnails, ±.5/⤓Now buttons, caption inputs + drag-handles +
  color/size controls, FPS/width/aspect selects, Make GIF → capture → encode
  → result (download link + Upload button) flow.
- All `#sc-gif-*` / `.sc-gif-*` CSS rules copied as-is from pc.user.js
  (lines ~4784–4990), since class/id names are unchanged.

Not carried over: `_gifTitleSlug()`'s dependency on `lastMovieTitle` +
`parseMovieFilename` (TMDB-adjacent title-cleaning machinery). Replaced by a
one-shot raw-title read, see below.

### 3. Filename slug — raw title, no cleaning

At the moment the panel opens (not continuously tracked — no MutationObserver,
no header-watcher), read whatever CyTube's own title element currently shows,
using the same fallback chain pc.user.js already relies on for the same
element (these are CyTube's own DOM nodes, not something either script
creates):

```js
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
    return raw.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
}
```

Filename: `(gifTitleSlug() || 'gif') + '-' + Date.now() + '.gif'` — e.g.
`White-Fire-1984-mkv-1721838223.gif` for a local file, or a slugified video
title for a YouTube-style "Now Playing" string (moot in practice since the
button is hidden for YouTube sources, but harmless if reached via some other
path).

### 4. ImgBB key — inline in the panel, no separate settings UI

A compact row inside `#sc-gif-body`, placed directly above the "● Make GIF"
button:

```
ImgBB key (for Upload): [___________________] [Test]
                         ✓ Valid key / ✗ Invalid / (blank)
```

- Pre-filled from `getKey(LS_IMGBB)` when the panel opens.
- Auto-persists on the input's `change` (blur) event — `setKey(LS_IMGBB,
  value)` — no separate Save button, since it's the only persisted field in
  this whole script.
- `Test` button reuses `validateImgbbKey` (1×1 PNG probe against
  `api.imgbb.com/1/upload?expiration=60`), same status text/classes as
  pc.user.js's settings modal (`✓ Valid API key` / `✗ Invalid API key` / `⚠
  Couldn't reach ImgBB`).
- The existing Upload-button behavior in the result view is unchanged: if
  `getKey(LS_IMGBB)` is empty when Upload is clicked, show the hint text
  ("Add an ImgBB API key above to enable uploads.") instead of attempting the
  request — just reworded since there's no "⚙ Settings" to point to anymore.

## Data flow

1. Page loads → boot waits for `document.body`, then:
   - a `MutationObserver` on `document.body` re-ensures the `◉` button exists
     as `#videowrap`'s last child whenever CyTube's own JS replaces that
     subtree (mirrors pc.user.js's `bootObserver` pattern for its own
     floating buttons);
   - a `setInterval(..., 800)` (matching the existing monitor-watcher
     cadence) calls `isYouTubeMedia()` and toggles the button's
     `display`, since a media-type change doesn't necessarily mutate
     `#videowrap` itself.
2. User clicks `◉` → `openGifPanel()` — identical control flow to
   pc.user.js's version, minus the title-tracking/TMDB bits already covered
   above.
3. User trims start/end, optionally adds captions, clicks Make GIF →
   `captureGifFrames` → `encodeGif` → result shown with Download + Upload.
4. Upload → `uploadToImgbb` using whatever key is currently saved (entered
   inline in this same panel if not already set).

## Error handling

Unchanged from pc.user.js's existing behavior for all ported code paths:
blob/streaming source → inline message instead of a crash; capture timeout
(60s) → rejected promise → panel shows "Failed: …"; ImgBB upload failure →
inline red message in the link box, Upload button re-enabled for retry.

## Testing plan

Manual, since this is a Tampermonkey userscript with no test harness:

1. Install `cytube.gifmaker.user.js` (and, for the side-by-side case, also
   `cytube.pc.user.js`) in Tampermonkey, load `https://cytu.be/r/testing`.
2. Confirm the `◉` button appears pinned to the video's top-right corner and
   survives CyTube re-rendering the video wrapper (e.g. on media change).
3. Play a local (non-YouTube) media file; confirm the button is visible,
   open the panel, trim a clip, add a top+bottom caption, generate a GIF,
   confirm download works and the filename reflects the movie title.
4. Switch to a YouTube-sourced video in the playlist; confirm the `◉` button
   disappears while it's playing, and reappears once a local file resumes.
5. With no ImgBB key saved, click Upload on a generated GIF; confirm the
   inline hint appears and no request fires.
6. Enter an ImgBB key inline, click Test, confirm valid/invalid/unreachable
   states render correctly; save (blur), regenerate a GIF, click Upload,
   confirm it uploads and the link/copy button work.
7. With both scripts installed together, confirm an ImgBB key saved in one
   script's UI is immediately visible/usable in the other (shared
   localStorage key).
