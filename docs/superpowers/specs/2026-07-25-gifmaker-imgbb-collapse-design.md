# GIF Maker — collapsible ImgBB section + download-only when no key — design

## Goal

Two related UI changes to the GIF Maker panel's ImgBB integration:

1. The always-visible ImgBB key field/Test button/status row becomes
   collapsible — a clickable header toggles it. Always starts collapsed
   when the panel opens (no persisted state, no "configured" indicator —
   simplest version).
2. When a GIF finishes generating and no ImgBB key is saved, the result
   view shows **only** the Download button — no Upload button, no "add a
   key" hint. If a key *is* saved, both buttons render exactly as they do
   today.

This only touches `cytube.gifmaker.user.js` — specifically `openGifPanel`
and `injectPanelCss`. No other file changes.

## Collapsible ImgBB section

Markup changes from a flat label+input+status block to a header (a real
`<button>`, for native keyboard focusability, matching every other control
in this file) plus a collapsible body:

```html
<div class="sc-gif-imgbb-row" id="sc-gif-imgbb-row">
    <button type="button" class="sc-gif-imgbb-header" id="sc-gif-imgbb-header">
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
```

`.sc-gif-imgbb-label` keeps its existing styling (reused as-is inside the
new header). CSS additions:

```css
.sc-gif-imgbb-header {
    display: flex !important; align-items: center !important; justify-content: space-between !important;
    background: transparent !important; border: none !important; padding: 0 !important;
    cursor: pointer !important; width: 100% !important; text-align: left !important;
}
.sc-gif-imgbb-toggle { color: rgba(255,255,255,0.5) !important; font-size: 11px !important; }
.sc-gif-imgbb-body { display: none !important; flex-direction: column !important; gap: 4px !important; margin-top: 4px !important; }
.sc-gif-imgbb-row.sc-gif-imgbb-open .sc-gif-imgbb-body { display: flex !important; }
```

`.sc-gif-imgbb-body` is `display: none` by default (always-collapsed on
open, matching the approved design — no need to read any stored
"was it open last time" state). A single click handler toggles the open
class and swaps the glyph:

```js
const imgbbRow = $('#sc-gif-imgbb-row');
const imgbbHeader = $('#sc-gif-imgbb-header');
const imgbbToggle = $('#sc-gif-imgbb-toggle');
imgbbHeader.addEventListener('click', () => {
    const open = imgbbRow.classList.toggle('sc-gif-imgbb-open');
    imgbbToggle.textContent = open ? '▾' : '▸';
});
```

All existing key-input/Test-button wiring (`imgbbInput`'s `change`
listener, `imgbbTestBtn`'s `click` listener, `validateImgbbKey`) is
**unchanged** — those elements still exist in the DOM at all times, just
visually hidden via `display: none` when collapsed, so their event
listeners and the `change`-triggered `setKey` persistence keep working
exactly as before regardless of collapsed/expanded state.

## Download-only result when no key is saved

Currently the result view always renders both Download and Upload
buttons; clicking Upload without a key shows an inline hint. New
behavior: decide once, at the moment the GIF finishes encoding, whether a
key is saved — if not, omit the Upload button (and the link box below it)
entirely, and skip wiring its click handler:

```js
const hasImgbbKey = !!getKey(LS_IMGBB);
result.innerHTML =
    `<img src="${_gifResultUrl}" alt="GIF preview">` +
    `<div id="sc-gif-actions">` +
    `<a id="sc-gif-dl" href="${_gifResultUrl}" download="${fname}">⬇ Download</a>` +
    (hasImgbbKey ? `<button id="sc-gif-upload" type="button">☁ Upload</button>` : '') +
    `<span id="sc-gif-size">${kb} KB</span></div>` +
    (hasImgbbKey ? `<div id="sc-gif-link"></div>` : '');
setStatus('Done.');

if (hasImgbbKey) {
    const uploadBtn = $('#sc-gif-upload');
    if (uploadBtn) uploadBtn.addEventListener('click', async () => {
        // ...existing upload wiring, entirely unchanged...
    });
}
```

**Accepted tradeoff, decided during review:** `hasImgbbKey` is latched
once, at encode time, and never re-evaluated for that result. If a key is
added or saved *after* a GIF has already finished generating without one,
the Upload button does not retroactively appear on that result — the only
way to get it is to click "● Make GIF" again (a full re-encode). This was
raised during the final whole-branch review as a real usability
regression versus the prior always-visible-Upload-with-a-hint behavior,
and deliberately accepted as-is rather than fixed: the fix would require
hoisting the upload click handler out of the `goBtn` closure so it could
be reused/attached after the fact, which was judged not worth the added
complexity for this script. Do not re-litigate this in a future review —
it's a known, intentional limitation, not an oversight.

The existing `if (!apiKey) { linkBox.innerHTML = '...enable uploads.'; return; }`
check *inside* the upload click handler is left in place as a defensive
fallback (the key could theoretically be cleared in the collapsed section
between generation and clicking Upload) — harmless, and consistent with
not removing working code that costs nothing to keep. In the common case
this branch is now unreachable, since the button simply doesn't exist
when there's no key to begin with.

Nothing about `captureGifFrames`, `encodeGif`, or the Download link/blob
handling changes — this is purely about which buttons render in the
result view.

## Testing plan

No automated test framework exists in this repo — verification is
`node --check cytube.gifmaker.user.js` (syntax only) plus manual testing:

1. Open the panel with no ImgBB key saved; confirm the "ImgBB key (for
   Upload)" row shows a collapsed header (▸) with no visible input/Test
   button, and clicking the header expands it (▾) revealing them.
2. Type a key, blur the field (persists via the existing `change`
   listener); collapse the section again; reopen the panel — confirm it
   starts collapsed again regardless of the saved key (always-collapsed
   default, no memory).
3. With a key saved, generate a GIF; confirm the result view shows both
   Download and Upload, and Upload still works exactly as before.
4. Clear the saved key (empty the field, blur); generate a new GIF;
   confirm the result view shows **only** Download — no Upload button, no
   hint text of any kind.
5. Confirm the Download link/filename/KB size badge are unaffected in
   both the with-key and without-key cases.
6. `node --check cytube.gifmaker.user.js` passes.
