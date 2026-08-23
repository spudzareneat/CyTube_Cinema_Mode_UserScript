# Chat-link picture-in-picture (PiP) — design

## Goal

Add a new module, `src/pc/modules/link-pip/`, that lets a viewer open a small
floating preview window for two categories of chat links the existing
auto-embed module (`src/pc/modules/chatimages/`) can't handle:

1. **YouTube links** — currently just open YouTube in a new tab.
2. **Image-hosting landing pages** (e.g. `https://postimg.cc/VSjkLzj1`) — a
   page *about* an image, not a direct image URL, so `chatimages`'
   extension-based `IMAGE_LINK_RE` never matches it.

When a YouTube video plays in the PiP window, the main CyTube player
auto-mutes for as long as the PiP is open, then restores its exact previous
mute/volume state when the PiP closes.

## Non-goals

- No generic "try to embed any link" fallback. Only YouTube (regex, no
  network) and a small curated host allowlist for image-landing pages get a
  PiP affordance. Rejected during brainstorming: broader detection means a
  PiP icon appearing next to ordinary webpage links that resolve to nothing,
  and a network request fired at an arbitrary third-party host for every
  non-YouTube link posted in chat.
- No changes to `chatimages` — direct image links keep auto-embedding as
  today; this module only covers what that one leaves as a plain link.
- No multi-window PiP. One window at a time (see §5).
- No custom resize handles — native CSS `resize: both` is enough; not
  building a drag-to-resize UI.

## 1. Detection

Two independent checks, both purely against `a.href` — no DOM text parsing,
matching `chatimages`' convention of only looking at already-linkified `<a>`
elements CyTube itself produced.

```js
const YT_LINK_RE = /^https?:\/\/(www\.)?(youtube\.com\/(watch\?.*\bv=|shorts\/|embed\/)|youtu\.be\/)/i;

const IMAGE_HOST_ALLOWLIST = ['postimg.cc', 'ibb.co', 'prnt.sc'];

function isImageHostPage(url) {
    try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        return IMAGE_HOST_ALLOWLIST.includes(host);
    } catch (e) { return false; }
}

function classifyLink(a) {
    if (YT_LINK_RE.test(a.href)) return 'youtube';
    if (isImageHostPage(a.href)) return 'image-page';
    return null;
}
```

`IMAGE_HOST_ALLOWLIST` is deliberately a flat array a future edit can extend
by adding a hostname — no config UI for it.

## 2. Scanning / icon injection

Same shape as `chatimages`' `scanImageEmbeds` / `startImageEmbedObserver`
(`src/pc/modules/chatimages/index.js:159-249`): its own `MutationObserver` on
`#messagebuffer`, immediate boot (not `scRegisterInit`, so it starts
watching before `window.load`), idempotent via a `dataset` marker.

```js
function findQualifyingLinks(msgEl) {
    return [...msgEl.querySelectorAll('a[href]')]
        .filter(a => !a.dataset.scPipChecked
            && (a.protocol === 'http:' || a.protocol === 'https:'));
}

function renderIcon(a) {
    a.dataset.scPipChecked = '1';
    const kind = classifyLink(a);
    if (!kind) return;
    const icon = document.createElement('span');
    icon.className = 'sc-pip-icon';
    icon.title = kind === 'youtube' ? 'Open in floating player' : 'Open image preview';
    icon.textContent = '🗗';
    icon.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPip(kind, a.href);
    });
    a.insertAdjacentElement('afterend', icon);
}

function scanPipLinks(buf) {
    if (!pipEnabled()) return;
    buf.querySelectorAll('[class*="chat-msg-"]').forEach(msgEl => {
        findQualifyingLinks(msgEl).forEach(renderIcon);
    });
}
```

The link itself is untouched — no `preventDefault` on the `<a>`, no
`display:none`. Clicking the link still opens a new tab exactly like today;
only the appended icon opens PiP. This was an explicit user decision during
brainstorming (non-destructive over replacing link-click behavior).

`pipEnabled()` mirrors `chatimages`' `autoEmbedEnabled()` — reads a
`localStorage` toggle, `true` unless explicitly turned off.

## 3. PiP panel

Reuses the draggable-panel pattern from
`src/pc/modules/emote-picker/index.js:390-432` (`clampPanelPos`,
`makePanelDraggable`) — per that file's own comment, this pattern is already
independently duplicated per-module in this codebase (gifmaker, subtitles,
emote-picker each keep their own copy), so `link-pip` does the same rather
than extracting a shared helper.

```js
let pipPanel = null;
let pipMuteState = null; // captured before-mute state, or null if not muting

function closePip() {
    if (!pipPanel) return;
    pipPanel.remove();
    pipPanel = null;
    if (pipMuteState) { restorePlayer(pipMuteState); pipMuteState = null; }
}

function openPip(kind, url) {
    closePip(); // one window at a time
    pipPanel = buildPanel(kind, url);
    document.body.appendChild(pipPanel);
    if (kind === 'youtube') pipMuteState = mutePlayer();
}
```

Panel chrome: header (drag handle + × close button), body (iframe or img),
position persisted to `localStorage` under `sc_pip_panel_pos` the same way
emote-picker persists `LS_EMOTE_PANEL_POS`, falling back to a default
bottom-right spawn point when unset/unparseable. Escape key and
outside-click both call `closePip()`, matching
`src/pc/modules/imdb-trivia/index.js:45-99`'s dismiss handling.

Body content per kind:

```js
function buildPanelBody(kind, url) {
    if (kind === 'youtube') {
        const id = extractYouTubeId(url); // parses v=, youtu.be/, /shorts/, /embed/
        const iframe = document.createElement('iframe');
        iframe.src = `https://www.youtube.com/embed/${id}?autoplay=1`;
        iframe.allow = 'autoplay; encrypted-media';
        iframe.className = 'sc-pip-frame';
        return iframe;
    }
    // image-page: async — starts a placeholder, swaps in the resolved <img>
    // or an error message once resolveOgImage() settles.
    const holder = document.createElement('div');
    holder.className = 'sc-pip-image-holder';
    holder.textContent = 'Loading…';
    resolveOgImage(url).then(imgUrl => {
        if (!imgUrl) {
            holder.innerHTML = '';
            holder.textContent = "Couldn't find an image on this page. ";
            const link = document.createElement('a');
            link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
            link.textContent = 'Open page';
            holder.appendChild(link);
            return;
        }
        holder.innerHTML = '';
        const img = document.createElement('img');
        img.src = imgUrl;
        holder.appendChild(img);
    });
    return holder;
}
```

## 4. Image-page resolution

Only fired on click (never eagerly per-message — see Non-goals). Uses the
same `GM_xmlhttpRequest`-wrapped-in-a-Promise idiom already established in
`src/pc/modules/tmdb/index.js:51-65`:

```js
function resolveOgImage(pageUrl) {
    return new Promise((resolve) => {
        GM_xmlhttpRequest({
            method: 'GET',
            url: pageUrl,
            onload: (res) => {
                if (res.status !== 200) return resolve(null);
                const m = res.responseText.match(
                    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
                );
                resolve(m ? m[1] : null);
            },
            onerror: () => resolve(null),
            ontimeout: () => resolve(null),
            timeout: 8000,
        });
    });
}
```

Regex also needs to match the reversed attribute order
(`content="..." property="og:image"`) — the real implementation should try
both attribute orders or use a tolerant single regex; noted here so it isn't
missed, not prescribing exact regex syntax.

## 5. Main-player mute/restore

Mirrors the fallback-chain idiom `seekPlayerTo()` already uses in
`src/pc/core/12-playback-sync-and-seek.js:111-122`: try the real `<video>`
element first (native, reliable), fall back to CyTube's `PLAYER` wrapper
object if present.

```js
function mutePlayer() {
    const v = getPlayerVideoEl(); // src/pc/core/12-playback-sync-and-seek.js:61
    if (v) {
        const state = { kind: 'video', muted: v.muted, volume: v.volume };
        try { v.muted = true; } catch (e) {}
        return state;
    }
    try {
        const p = window.PLAYER || window.player;
        if (p && typeof p.mute === 'function') {
            const wasMuted = typeof p.isMuted === 'function' ? p.isMuted() : false;
            p.mute();
            return { kind: 'wrapper', muted: wasMuted };
        }
    } catch (e) {}
    return null; // no reachable mute mechanism -- PiP still opens, just doesn't mute
}

function restorePlayer(state) {
    if (!state) return;
    if (state.kind === 'video') {
        const v = getPlayerVideoEl();
        if (v) { try { v.muted = state.muted; v.volume = state.volume; } catch (e) {} }
        return;
    }
    try {
        const p = window.PLAYER || window.player;
        if (p && !state.muted && typeof p.unMute === 'function') p.unMute();
    } catch (e) {}
}
```

**Open risk, explicitly not resolved by static reading:** whether CyTube's
`PLAYER` wrapper for YouTube actually exposes `.mute()` / `.unMute()` /
`.isMuted()` isn't confirmed anywhere in this repo (`window.PLAYER` is
CyTube's own client object, not code we own). The `<video>`-element path
above only helps for direct/video.js file playback — YouTube's actual
`<video>` lives in a cross-origin iframe CyTube embeds, per the existing
comment at `12-playback-sync-and-seek.js:14-19`, so **for a YouTube *main*
stream, the wrapper path is the only possible path and must be verified
live in a real cytu.be room before this is considered done.** If the wrapper
turns out not to expose mute methods, this feature still degrades
gracefully (PiP opens, main player just doesn't mute) — matching the
"best-effort, not a hard requirement" call made during brainstorming — but
the primary use case (someone playing a YouTube PiP over a YouTube main
stream) is exactly the case that needs this to work, so treat the
verification step as required before shipping, not optional polish.

## 6. Settings toggle

One checkbox row via `scRegisterSetting`, same shape as `chatimages`'
(`src/pc/modules/chatimages/index.js:242`):

```js
scRegisterSetting({
    id: 'sc-input-pip', group: 'link-pip',
    label: 'Picture-in-picture for YouTube & image links in chat',
    note: 'Adds a 🗗 icon next to YouTube links and postimg.cc/ibb.co/prnt.sc links to open a floating preview',
    key: LS_PIP_ENABLED, defaultOn: true, order: 1,
});
```

## 7. CSS

Own `injectCSS` block, following the `!important`, `sc-`-prefixed,
dark-translucent convention shared by `#sc-poll-panel` / `#sc-trivia-panel`
/ `#sc-emotes-panel`:

```css
.sc-pip-icon { cursor: pointer !important; margin-left: 4px !important; opacity: 0.65 !important; font-size: 12px !important; }
.sc-pip-icon:hover { opacity: 1 !important; }
#sc-pip-panel {
    position: fixed !important; z-index: 99999 !important;
    background: rgba(10,10,20,0.95) !important; border-radius: 8px !important;
    box-shadow: 0 8px 32px rgba(0,0,0,0.7) !important; overflow: hidden !important;
    resize: both !important; min-width: 240px !important; min-height: 160px !important;
}
#sc-pip-panel .sc-pip-frame { width: 100% !important; height: 100% !important; border: 0 !important; }
#sc-pip-panel .sc-pip-image-holder img { max-width: 100% !important; max-height: 100% !important; display: block !important; }
```

## 8. Manifest changes

`src/pc/manifest.json` new entry (and the same fields mirrored by hand into
`docs/manifest.json` / `docs/customizer.js` per the existing sync comment in
`scripts/assemble.mjs:12-17`):

```json
{
  "id": "link-pip",
  "name": "Chat Link Picture-in-Picture",
  "category": "Chat",
  "locked": false,
  "defaultOn": true,
  "files": ["src/pc/modules/link-pip/index.js"],
  "dependsOn": ["core"],
  "grants": ["GM_xmlhttpRequest"],
  "connects": ["postimg.cc", "i.postimg.cc", "ibb.co", "i.ibb.co", "prnt.sc"],
  "features": [
    "Adds a floating picture-in-picture window for YouTube links posted in chat",
    "Also resolves image-hosting landing pages (postimg.cc, ibb.co, prnt.sc) that the auto-embed module can't match directly",
    "Auto-mutes the main player while a YouTube PiP plays, restoring its previous state on close"
  ]
}
```

`connects` includes both the landing-page host and its typical CDN
subdomain (`i.postimg.cc` etc.) since the `og:image` URL resolved from the
page usually lives on the CDN host, not the landing-page host, and the
`<img>` tag itself doesn't need a `connect` grant (only `GM_xmlhttpRequest`
calls do) — listed for documentation completeness even though the image
`<img src>` fetch itself is a normal browser request, not a `GM_*` call.

## Edge cases

- Same YouTube/image link posted multiple times in chat: each `<a>` gets its
  own icon independently (`dataset.scPipChecked` is per-element), consistent
  with `chatimages`' per-link approach. No cross-message state.
- User clicks a second PiP icon while one is already open: `openPip` calls
  `closePip()` first, which restores mute before the new one mutes again —
  no double-mute, no leaked "muted" state if the two clicks are both
  YouTube.
- Main player was already muted by the user before opening a YouTube PiP:
  `mutePlayer()` captures `muted: true`, so `restorePlayer` puts it back to
  muted on close — PiP never accidentally un-mutes something the user muted
  themselves.
- `og:image` resolves to a relative URL: real implementation must resolve it
  against the page's own URL (`new URL(m[1], pageUrl).href`) before using it
  as an `<img src>`.
- Toggling the Settings checkbox off mid-session: mirrors `chatimages`
  exactly — `pipEnabled()` gates `scanPipLinks`, so no new icons appear on
  subsequent messages, and already-rendered icons on old messages are left
  alone (not retroactively removed), matching the settings-toggle behavior
  precedent.
- Panel dragged partially off-screen: `clampPanelPos` (copied from
  emote-picker) keeps at least ~40px of the header on-screen so it's always
  re-grabbable.

## Testing plan

Manual, in a live cytu.be room (no automated test suite exists for these
userscripts):

1. Post a YouTube link. Confirm the 🗗 icon appears next to it and the link
   itself still opens normally in a new tab on click.
2. Click the icon. Confirm the panel opens, the video autoplays, and the
   main player mutes.
3. Close the panel (×, Escape, and outside-click — test all three
   separately). Confirm the main player's mute/volume is restored to
   exactly what it was before.
4. Repeat with the main stream itself set to a YouTube video (not a direct
   file) — this is the case that depends on `window.PLAYER`'s wrapper mute
   API (§5's open risk). Confirm it actually mutes; if it doesn't, that's
   the signal the wrapper API assumption needs revisiting before shipping.
5. Post a `postimg.cc` link. Confirm the icon appears; click it; confirm the
   resolved image renders in the panel.
6. Post a link to an allowlisted host with no `og:image` meta tag (or a
   dead page). Confirm the "couldn't find an image" fallback with its
   "Open page" link.
7. With a YouTube PiP open, click a different qualifying link's icon.
   Confirm the first PiP closes (and un-mutes) before the new one opens and
   mutes again.
8. Drag the panel to a new position, close it, open another PiP. Confirm it
   reopens at the dragged position (position persistence).
9. Turn the new Settings Modal checkbox off. Post a new qualifying link.
   Confirm no icon appears. Turn it back on — confirm new links get icons
   again, and the previously-skipped link stays without one (matching the
   `chatimages` toggle-off precedent, not retroactive).
