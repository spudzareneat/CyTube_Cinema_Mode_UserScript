# Auto-embed image links in chat

Date: 2026-08-01

## Goal

When someone posts a direct image link in chat (e.g. `https://i.postimg.cc/bJ0Q40QG/Twins-Said-No.gif`), show the actual image inline in the chat buffer instead of leaving it as a plain text link, with a small caption denoting that it was auto-embedded (to distinguish it from an image that's part of the channel's own UI).

Applies to `cytube.pc.user.js` only — `cytube.androidTV.user.js` has a simpler chat view with no equivalent hook infrastructure and is out of scope.

## 1. Detection

New constant near the other `LS_*`/regex constants:

```js
const IMAGE_LINK_RE = /\.(jpe?g|png|gif|webp|bmp)(\?[^\s"']*)?$/i;
```

CyTube auto-linkifies any `http(s)://` URL in a chat message into an `<a href="...">` before the message div is appended to `#messagebuffer`. Detection works purely off those anchors — no separate URL-in-text scanning is needed:

```js
function findImageLinks(msgEl) {
    return [...msgEl.querySelectorAll('a[href]')]
        .filter(a => !a.dataset.scEmbedded && IMAGE_LINK_RE.test(a.href));
}
```

The `dataset.scEmbedded` flag is set on the anchor once processed, so a message is never scanned twice (the buffer's `MutationObserver`, see below, can otherwise re-fire on unrelated sibling mutations).

## 2. Rendering

For each matching anchor, build and append (inside the message element, after the existing text) an embed block:

```html
<div class="sc-img-embed">
    <a href="<url>" target="_blank" rel="noopener noreferrer">
        <img src="<url>" loading="lazy" style="max-height:<Npx>">
    </a>
    <span class="sc-img-embed-badge">🖼 embedded</span>
</div>
```

- The `<a>` wrapper means the click-to-open-full-size behavior needs no JS handler.
- `img.onerror` removes the whole `.sc-img-embed` div (dead/expired link — fail silently, no broken-image icon).
- Appending inside the existing message `<div class="chat-msg-*">` (rather than as a new sibling row in `#messagebuffer`) keeps it part of that message for the existing right-click "Jump movie to.../Create a GIF from here" handler, which does `e.target.closest('[class*="chat-msg-"]')` (`cytube.pc.user.js:845`) — this still resolves correctly since the embed is a descendant.

## 3. Sizing — matching emote size

No fixed pixel value is hardcoded. At render time:

```js
function emoteInlineHeight() {
    const el = document.querySelector('#messagebuffer .emote');
    const h = el && el.getBoundingClientRect().height;
    return (h && h > 4) ? Math.round(h) : 48; // fallback until a real emote has rendered
}
```

This is read fresh for each embed (cheap DOM query, chat isn't a hot loop), so it self-corrects once a real emote has appeared in the buffer, and stays correct if the user changes the chat font-size slider (emotes in this channel appear to scale with it).

## 4. Wiring — detecting new and existing messages

Mirrors the existing `startUserColorObserver()` pattern (`cytube.pc.user.js:1660-1668`):

```js
function initImageEmbeds() {
    const buf = document.getElementById('messagebuffer');
    if (!buf) return;
    const scan = (root) => {
        if (!autoEmbedEnabled()) return;
        root.querySelectorAll('[class*="chat-msg-"]').forEach(embedImagesIn);
    };
    new MutationObserver(() => scan(buf)).observe(buf, { childList: true, subtree: true });
    scan(buf); // backlog already present on load/join
}
```

`embedImagesIn(msgEl)` runs `findImageLinks`, and for each result: sets `a.dataset.scEmbedded = '1'`, builds the embed block from §2, appends it to `msgEl`.

Bound the same way other buffer-dependent features are (`initChatTimestamps`-style retry): call once, then on `window load` and a short poll, since `#messagebuffer` may not exist yet at `document-start`.

## 5. Settings toggle

New localStorage key next to the other feature toggles:

```js
const LS_AUTOEMBED = 'sc_autoembed_images';
const autoEmbedEnabled = () => getKey(LS_AUTOEMBED) !== 'off'; // default ON, like spellcheck/movielinks
```

New checkbox in the Settings Modal, placed with the other toggle-style rows (spellcheck/movie-links group), same markup pattern as the existing GIF-optimize toggle:

```html
<label class="sc-settings-toggle-label">
    <span class="sc-toggle-row">
        <input type="checkbox" id="sc-input-autoembed" ${autoEmbedEnabled() ? 'checked' : ''} />
        <span class="sc-toggle-text">Auto-embed image links in chat</span>
    </span>
    <span class="sc-settings-note">Shows a thumbnail preview under messages that link directly to an image, marked "🖼 embedded"</span>
</label>
```

Wired into the existing Save handler alongside `spell`/`links`/etc.:
```js
const autoEmbed = document.getElementById('sc-input-autoembed').checked;
setKey(LS_AUTOEMBED, autoEmbed ? 'on' : 'off');
```

Turning the toggle off only stops *new* embeds (`scan()` checks `autoEmbedEnabled()` before processing); embeds already rendered are left in place, matching how the other toggles in this script don't retroactively undo already-applied effects.

## 6. CSS

Added to the script's existing injected `<style>` block:

```css
.sc-img-embed { display: block; margin-top: 4px; }
.sc-img-embed img {
    display: block;
    max-width: 100%;
    border-radius: 4px;
    cursor: pointer;
}
.sc-img-embed-badge {
    display: block;
    font-size: 10px;
    color: rgba(244,244,242,0.45);
    margin-top: 2px;
}
```

## Edge cases

- Multiple image links in one message: each gets its own embed block, in order.
- Same URL posted in two different messages: each message embeds independently (expected, like Discord/Slack).
- A non-image link that happens to end in something matching the regex inside a query string but not the path (e.g. `.../page?ref=photo.png.html`) — the regex anchors to end-of-string (optionally followed by a `?query`), so this correctly does *not* match since `.html` is what actually terminates the string.
- Link posted with uppercase extension (`.JPG`) — regex is case-insensitive.
- Image genuinely fails to load (deleted, host down) — embed silently removed via `onerror`, original message text/link untouched.

## Testing

Manual, in a live cytu.be room (no automated test suite exists for this userscript):
1. Post a direct image link (e.g. the postimg.cc GIF link from the bug report) — a thumbnail appears under the message with the "🖼 embedded" caption, sized to match emote height.
2. Click the thumbnail — opens the full image in a new tab.
3. Post a link to a dead/incorrect image URL — no broken-image icon appears, embed silently omitted.
4. Reload the page while backlog messages containing image links are present — they get embedded on load, not just new messages.
5. Turn the Settings Modal toggle off, post a new image link — no embed appears. Turn it back on — new links embed again; embeds created while it was on remain untouched throughout.
