# Standalone chat-image-embed userscript — design

## Goal

Split chat image auto-embedding out of `cytube.pc.user.js` into a new,
independent userscript: `cytube.chatimages.user.js`. It works fully standalone
(always embeds) or, when `cytube.pc.user.js` is also installed, defers to that
script's existing Settings Modal on/off toggle — the same "standalone but
upgrades when the other script is present" relationship
`cytube.gifmaker.user.js` already has with `cytube.pc.user.js`.

Two new behaviors ride along with the split, since they only make sense once
this becomes its own dedicated script:

- Hovering an embedded image shows its filename as a native tooltip.
- Each embed gets a persistent per-image "ban" — hide this image (as a plain
  link) everywhere, including scrollback, and don't embed it again on future
  reposts of the same URL, with an inline "unban" to reverse it.

## Non-goals

Everything else in `cytube.pc.user.js` is untouched: TMDB lookups, movie
links, Tonight's Lineup, spellcheck/tab-complete, layout, GIF integration,
etc. `cytube.androidTV.user.js` has no equivalent message-buffer hook
infrastructure and stays out of scope, same as the original embed feature.

## Script metadata

```
// @name         CyTube Chat Images
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @match        https://cytu.be/r/420Grindhouse
// @match        https://cytu.be/r/testing
// @run-at       document-start
```

Same `@match` list as the other scripts. No `@grant` needed — this feature is
pure DOM manipulation and `localStorage`, no cross-origin requests.

## Storage

```js
const LS_AUTOEMBED = 'sc_autoembed_images'; // shared key — cytube.pc.user.js's
                                             // Settings Modal toggle writes this;
                                             // only consulted in PC_MODE (see below)
const LS_BANNED    = 'sc_img_banned_urls';  // private to this script — JSON array
                                             // of exact banned URLs
```

`LS_BANNED` is not shared with `cytube.pc.user.js` — banning is a personal
per-browser hide-list for this feature, not a moderation action, and
`cytube.pc.user.js` no longer has any embed rendering code to consult it.

## PC-script detection (mirrors `cytube.gifmaker.user.js`)

`cytube.pc.user.js` already exposes `unsafeWindow.__SC_GIF_BRIDGE__` once it
boots (used today by the GIF maker script). Reused here purely as a presence
signal — no changes to that bridge object are needed:

```js
let PC_MODE = false;
function readPcBridge() {
    const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const b = w.__SC_GIF_BRIDGE__;
    return (b && typeof b.getTitleSlug === 'function') ? b : null;
}
const getKey = id => localStorage.getItem(id) || '';
const autoEmbedEnabled = () => getKey(LS_AUTOEMBED) !== 'off';
function embeddingEnabled() {
    return PC_MODE ? autoEmbedEnabled() : true; // standalone: always on, no toggle
}
```

Boot detection, same poll-then-settle shape as gifmaker's `waitForBody`:

```js
const PC_BRIDGE_POLL_MS = 50;
const PC_BRIDGE_POLL_TIMEOUT_MS = 1500;

function waitForBody() {
    if (!document.body) { requestAnimationFrame(waitForBody); return; }

    if (readPcBridge()) PC_MODE = true;
    startImageEmbedObserver();

    if (!PC_MODE) {
        // cytube.pc.user.js may still be loading -- both scripts run at
        // document-start with no guaranteed order. Poll briefly; if it
        // shows up late, embeddingEnabled() just starts respecting its
        // toggle on the next scan (per-link idempotency makes this safe,
        // no need to redo anything already rendered).
        let elapsed = 0;
        const pollTimer = setInterval(() => {
            elapsed += PC_BRIDGE_POLL_MS;
            if (readPcBridge()) { PC_MODE = true; clearInterval(pollTimer); }
            else if (elapsed >= PC_BRIDGE_POLL_TIMEOUT_MS) clearInterval(pollTimer);
        }, PC_BRIDGE_POLL_MS);
    }
}
waitForBody();
```

Starting the observer immediately (rather than waiting out the full poll)
keeps the feature responsive when running standalone — the only cost of a
late-detected bridge is that a handful of messages seen in the first ~1.5s
might embed before a since-loaded `cytube.pc.user.js`'s toggle (if off) takes
effect, which matches the existing "toggle only affects new embeds" behavior
this feature already had before the split.

## Components

### 1. Detection (unchanged from the current implementation)

```js
const IMAGE_LINK_RE = /\.(jpe?g|png|gif|webp|bmp)(\?[^\s"']*)?$/i;

function findImageLinks(msgEl) {
    return [...msgEl.querySelectorAll('a[href]')]
        .filter(a => !a.dataset.scEmbedded
            && (a.protocol === 'http:' || a.protocol === 'https:')
            && IMAGE_LINK_RE.test(a.href));
}
```

### 2. Filename tooltip

```js
function filenameFromUrl(url) {
    try {
        const seg = new URL(url).pathname.split('/').filter(Boolean).pop();
        return seg ? decodeURIComponent(seg) : url;
    } catch (e) { return url; }
}
```

Set as `img.title` when building the embed (§3) — a native browser tooltip,
no extra DOM.

### 3. Rendering — two states per link

Every image link ends up in exactly one of two states, tracked via
`a._scUi` (a plain JS property holding the appended wrap/badge element, so
either state can be torn down and swapped for the other):

**Embedded** (`applyEmbeddedState(a)`) — same markup as today's
implementation, plus `img.title` from §2 and a third badge icon:

```html
<div class="sc-img-embed">
    <a href="<url>" target="_blank" rel="noopener noreferrer">
        <img src="<url>" loading="lazy" title="<filename>">
    </a>
    <span class="sc-img-embed-badge">
        <span>🖼 embedded</span>
        <span class="sc-img-embed-toggle" title="Show link instead of image">🔗</span>
        <span class="sc-img-embed-ban" title="Hide this image everywhere and don't embed it again">🚫</span>
    </span>
</div>
```

- `🔗` toggle: unchanged existing behavior — ephemeral per-instance
  show-image/show-link flip, not persisted.
- `🚫` ban: calls `banUrl(a.href)`.
- `img.onerror` still removes the whole block and restores the plain link
  (dead/expired image), same as today.

**Banned** (`applyBannedState(a)`) — link left visible, small badge appended
instead of an embed:

```html
<span class="sc-img-embed-badge sc-img-embed-banned">
    <span>🚫 image hidden</span>
    <span class="sc-img-embed-unban" title="Show this image again">↩ unban</span>
</span>
```

`↩ unban` calls `unbanUrl(a.href)`.

Both `applyEmbeddedState(a)` and `applyBannedState(a)` end by assigning the
element they just built/appended to `a._scUi` (`wrap` and `badge`
respectively) — that's what lets `sweepUrl` (§4) tear either one down cleanly
when flipping a link between states.

`renderLink(a)` picks the state when a link is first seen:

```js
function renderLink(a) {
    a.dataset.scEmbedded = '1';
    if (isBanned(a.href)) applyBannedState(a);
    else applyEmbeddedState(a);
}
```

### 4. Ban / unban with buffer-wide sweep

```js
function getBannedUrls() {
    try { return new Set(JSON.parse(getKey(LS_BANNED) || '[]')); }
    catch (e) { return new Set(); }
}
function saveBannedUrls(set) { localStorage.setItem(LS_BANNED, JSON.stringify([...set])); }
function isBanned(url) { return getBannedUrls().has(url); }

function sweepUrl(url, applyFn) {
    const buf = document.getElementById('messagebuffer');
    if (!buf) return;
    buf.querySelectorAll('a[data-sc-embedded]').forEach(a => {
        if (a.href !== url) return;
        if (a._scUi) a._scUi.remove();
        applyFn(a);
    });
}
function banUrl(url) {
    const set = getBannedUrls(); set.add(url); saveBannedUrls(set);
    sweepUrl(url, applyBannedState);
}
function unbanUrl(url) {
    const set = getBannedUrls(); set.delete(url); saveBannedUrls(set);
    sweepUrl(url, applyEmbeddedState);
}
```

Matching is exact-URL, per your call — simple and precise for most hosts, at
the cost of not catching reposts through hosts that mint fresh signed URLs
per upload (e.g. Discord CDN's `?ex=...&hm=...` params) for what's otherwise
the same picture. Banning and unbanning both sweep the whole
`#messagebuffer`, so the effect is immediately visible on every existing copy
in scrollback, not just future messages.

### 5. Wiring

```js
function scanImageEmbeds(buf) {
    if (!embeddingEnabled()) return;
    buf.querySelectorAll('[class*="chat-msg-"]').forEach(msgEl => {
        findImageLinks(msgEl).forEach(renderLink);
    });
}
let _observerStarted = false;
function startImageEmbedObserver() {
    const buf = document.getElementById('messagebuffer');
    if (!buf) { requestAnimationFrame(startImageEmbedObserver); return; }
    if (_observerStarted) return;
    _observerStarted = true;
    new MutationObserver(() => scanImageEmbeds(buf)).observe(buf, { childList: true, subtree: true });
    scanImageEmbeds(buf);
}
```

While `embeddingEnabled()` is false (PC_MODE with the toggle off), links are
left completely alone — same as the original implementation, nothing is
marked processed, so re-enabling the toggle picks up existing backlog on the
next scan.

`rescrollChatIfNearBottom()` is carried over unchanged (same near-bottom
auto-scroll nudge on image load, since the async-appended embed misses
CyTube's own scroll-on-append hook).

### 6. CSS

Own injected `<style>` block (this script no longer relies on
`cytube.pc.user.js` injecting anything):

```css
.sc-img-embed { display: block; margin-top: 4px; }
.sc-img-embed img {
    display: block; max-width: 100%; max-height: 150px;
    width: auto; height: auto; border-radius: 4px; cursor: pointer;
}
.sc-img-embed-badge {
    display: flex; align-items: center; gap: 5px;
    font-size: 10px; color: rgba(244,244,242,0.45); margin-top: 2px;
}
.sc-img-embed-toggle, .sc-img-embed-ban {
    cursor: pointer; font-size: 11px; opacity: 0.6; line-height: 1;
}
.sc-img-embed-toggle:hover, .sc-img-embed-ban:hover { opacity: 1; }
.sc-img-embed-unban { cursor: pointer; opacity: 0.7; text-decoration: underline; }
.sc-img-embed-unban:hover { opacity: 1; }
```

## Changes to `cytube.pc.user.js`

Remove entirely:
- `IMAGE_LINK_RE`, `findImageLinks`, `rescrollChatIfNearBottom`,
  `embedImagesIn`, `scanImageEmbeds`, `startImageEmbedObserver` (the whole
  "CHAT IMAGE EMBEDS" block).
- The two `startImageEmbedObserver()` call sites (boot observer, settings
  Save handler).
- The `.sc-img-embed*` CSS rules.

Keep, repurposed:
- `LS_AUTOEMBED` / `autoEmbedEnabled()` — still backs the Settings Modal
  checkbox, which still writes the same `localStorage` key. It just no
  longer has any local effect by itself; `cytube.chatimages.user.js` is what
  reads it now, same "requires the other script" convention as the existing
  GIF-optimize toggle and ImgBB key. Update the checkbox's note text to
  "(requires `cytube.chatimages.user.js`)".

Update the `@description` line to mention the new script alongside the
existing gifmaker mention.

## Edge cases

- Multiple image links in one message: each tracked/rendered independently,
  same as today.
- Same URL posted in multiple messages: each `<a>` has its own `_scUi` and
  ban state is looked up fresh per link, so they stay in sync with each
  other via the sweep.
- Banning an image that's mid-toggle (currently showing "🔗 link only" via
  the ephemeral toggle, not banned): banning still applies — the embedded
  block is removed outright and replaced with the banned badge.
- Non-image link matching the regex only inside a query string: unchanged
  existing regex behavior (anchored to end-of-string).
- `cytube.pc.user.js` installed but boots after `cytube.chatimages.user.js`
  finishes its 1.5s poll window: falls back to permanent standalone mode
  (always-on), since the toggle can never be un-ignored once the poll gives
  up. Consistent with how `cytube.gifmaker.user.js` already handles a
  same-timing miss.

## Testing plan

Manual, in a live cytu.be room (no automated test suite exists for these
userscripts):

1. Install `cytube.chatimages.user.js` alone (no `cytube.pc.user.js`). Post
   an image link — it embeds. Confirm there is no settings toggle affecting
   it (it should always embed).
2. Hover the embedded thumbnail — confirm the tooltip shows the image's
   filename.
3. Click 🚫 on an embed — confirm it collapses to a plain link with a "🚫
   image hidden / ↩ unban" badge, and that re-posting the same URL in a new
   message also comes in banned (no embed at all).
4. Post the same image URL twice before banning, then ban one of them —
   confirm both copies (including the one further up in scrollback) collapse
   to the banned state.
5. Click ↩ unban — confirm both copies re-embed.
6. Install `cytube.pc.user.js` alongside it. Open its Settings Modal, turn
   "Auto-embed image links in chat" off, post a new image link — confirm it
   stays a plain link (no embed) and no ban badge appears (this is the
   toggle-off state, not a ban). Turn the toggle back on — confirm new links
   embed again, and previously-skipped links remain plain (not retroactively
   embedded), matching the pre-split behavior.
7. With both scripts installed, reload with backlog present — confirm
   existing banned URLs still render as banned on load, not just for new
   messages.
