# GIF optimization pass (gifsicle-wasm) — design

## Goal

Generated GIFs currently go straight from gif.js's encoder to the result view
(Download/Upload) with no post-processing. gif.js has no cross-frame
optimization (no delta-frame encoding, no redundant-data removal), so its
output runs larger than the same clip run through `gifsicle -O3`. Add an
optional, default-on optimization pass — using `gifsicle` compiled to
WebAssembly — that shrinks the encoded GIF losslessly before it's shown in
the result view, in both `cytube.pc.user.js` and `cytube.gifmaker.user.js`.

## Library

[`gifsicle-wasm-browser`](https://github.com/renzhezhilu/gifsicle-wasm-browser),
loaded from jsDelivr:
`https://cdn.jsdelivr.net/npm/gifsicle-wasm-browser@1.5.19/dist/gifsicle.min.js`

Measured sizes (raw / gzip), for comparison against what's already loaded:

| | raw | gzip |
|---|---|---|
| gif.js (already `@require`'d) | 13 KB | ~4 KB |
| gif.js's worker (already lazy-fetched on first GIF) | 17 KB | ~5 KB |
| gifsicle-wasm-browser | 342 KB | ~146 KB |

At ~35x the weight of what's currently `@require`'d, this must NOT be
`@require`'d — see Loading Strategy below.

The bundle is a single self-contained classic-script file: the WASM binary
is embedded as base64 inline (no separate `.wasm` fetch), and it manages its
own internal Web Worker via an embedded source string (a `workerLocalUrl`
field, turned into a same-origin `blob:` URL at runtime) — the same
CSP-workaround pattern this codebase already uses for gif.js's own worker
(see `getGifWorkerUrl`, both scripts). That's a strong signal it'll load
under cytu.be's CSP the same way gif.js does, but this library is new to
this codebase — the first real optimized GIF after implementation is the
actual proof, which is why silent fallback (below) matters.

## Loading Strategy

Lazy-load on first use, not `@require`. A new function in both scripts,
`getGifsicleCtor()` (mirroring the existing `getGifWorkerUrl`/`getGifCtor`
pair), fetches the script text via `GM_xmlhttpRequest` the first time a GIF
is actually being optimized, executes it in a wrapper that captures its
`gifsicle` export, and caches the resulting object in a module-level
variable for reuse on subsequent GIFs in the same page session:

```js
let _gifsicleCtor = null;
function getGifsicleCtor() {
    if (_gifsicleCtor) return Promise.resolve(_gifsicleCtor);
    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: 'GET',
            url: 'https://cdn.jsdelivr.net/npm/gifsicle-wasm-browser@1.5.19/dist/gifsicle.min.js',
            onload: r => {
                if (r.status < 200 || r.status >= 300) { reject(new Error('gifsicle HTTP ' + r.status)); return; }
                try {
                    // The bundle assigns a bare top-level `let gifsicle = {...}`.
                    // Running it inside a Function body whose own last statement
                    // returns that binding captures the export without touching
                    // any outer/global scope.
                    _gifsicleCtor = new Function(r.responseText + '\n;return typeof gifsicle !== "undefined" ? gifsicle : null;')();
                    if (!_gifsicleCtor) { reject(new Error('gifsicle export not found')); return; }
                    resolve(_gifsicleCtor);
                } catch (e) { reject(e); }
            },
            onerror: () => reject(new Error('gifsicle fetch failed')),
        });
    });
}
```

Cost: zero for anyone who never opens the GIF maker with optimization
enabled; a one-time ~146KB fetch + eval the first time someone actually
generates an optimized GIF, cached in memory for the rest of that page
session (not persisted across reloads — re-fetched next session, same as
gif.js's worker blob today).

**New `@connect` entry required in both scripts:** `cdn.jsdelivr.net` (this
is a `GM_xmlhttpRequest` fetch, unlike gif.js's `@require`, so it needs the
allowlist entry the same way `cdnjs.cloudflare.com` is already allowlisted
for gif.js's worker fetch).

## Setting

Shared localStorage key across both scripts, matching the existing shared
`sc_imgbb_key` precedent:

```js
const LS_GIF_OPTIMIZE = 'sc_gif_optimize';
const gifOptimizeEnabled = () => getKey(LS_GIF_OPTIMIZE) !== 'off'; // default ON
```

(Follows this codebase's existing convention for default-on toggles —
`!== 'off'` rather than `=== 'on'` — same pattern as `spellCheckEnabled`/
`movieLinksEnabled`, both `cytube.pc.user.js:42-43`.)

- **`cytube.pc.user.js`:** a new checkbox row in the existing Settings
  Modal, styled identically to the existing toggle rows (`sc-settings-toggle-label`
  / `sc-toggle-row`, `cytube.pc.user.js:2749-2753` for the closest sibling
  example):
  ```html
  <label class="sc-settings-toggle-label">
      <span class="sc-toggle-row">
          <input type="checkbox" id="sc-input-gifoptimize" ${gifOptimizeEnabled() ? 'checked' : ''} />
          <span class="sc-toggle-text">Optimize GIFs before upload</span>
      </span>
  </label>
  ```
  Saved alongside the other toggles in the modal's save handler
  (`cytube.pc.user.js:2860-2862` is the sibling block this joins).
- **`cytube.gifmaker.user.js`:** this script deliberately has no settings
  modal ("no settings modal, no first-run onboarding flow" — see its
  original design doc), and has no existing checkbox-row CSS to borrow —
  it only has text-input/button controls (the ImgBB row) so far. A new
  inline checkbox row goes directly in the GIF panel, above the Make GIF
  button, with a small new CSS rule added to `injectPanelCss()` matching
  this script's existing visual language (12px `rgba(255,255,255,0.8)`
  label text, flex row layout — same values the ImgBB row already uses at
  `cytube.gifmaker.user.js:274-275`):
  ```css
  .sc-gif-optimize-row { display: flex !important; align-items: center !important; gap: 6px !important; }
  .sc-gif-optimize-row label { color: rgba(255,255,255,0.8) !important; font-size: 12px !important; }
  ```
  ```html
  <div class="sc-gif-optimize-row">
      <input type="checkbox" id="sc-gif-optimize" ${gifOptimizeEnabled() ? 'checked' : ''} />
      <label for="sc-gif-optimize">Optimize GIF before upload</label>
  </div>
  ```

## Pipeline Integration

Both scripts' flow is `captureGifFrames()` → `encodeGif()` → blob → result
view (Download link + Upload button). A new step slots in between,
conditional on the setting:

```js
async function maybeOptimizeGif(blob) {
    if (!gifOptimizeEnabled()) return blob;
    try {
        const gifsicle = await getGifsicleCtor();
        const out = await gifsicle.run({
            input: [{ file: blob, name: 'in.gif' }],
            command: ['-O3 in.gif -o /out/out.gif'],
        });
        return (out && out[0]) ? out[0] : blob; // File extends Blob — drop-in compatible
    } catch (e) {
        console.warn('[SC] GIF optimize failed, using unoptimized output:', e);
        return blob;
    }
}
```

Called right after `encodeGif()` resolves, before building the result view.
While it runs, the existing progress/spinner area shows "Optimizing…" (a
one-line status swap, not a new UI element) since `-O3` can take a couple
seconds on larger clips. The (possibly-swapped) blob is what both Download
and Upload use — there's no separate "optimized vs. original" choice
exposed in the result view; the setting is the only control point.

## Error Handling

Per the earlier design discussion: any failure in `maybeOptimizeGif` —
library fetch fails, `gifsicle.run()` throws or rejects, the returned output
array is empty — falls back to the original unoptimized blob silently, with
a `console.warn` for debugging. The core Make-GIF flow (capture → encode →
download/upload) never blocks on this step; optimization is strictly
additive and non-critical.

## Testing Plan

No automated test framework in this repo (same as the rest of the GIF
maker) — manual:

1. Generate a GIF with the toggle on (default). Confirm the resulting file
   is smaller than the same clip generated with the toggle off, and plays
   back correctly (no corrupted frames, correct duration/loop).
2. Toggle off, generate the same clip again, confirm no "Optimizing…" status
   appears and the flow is unchanged from before this feature existed.
3. Simulate a load failure (e.g. block `cdn.jsdelivr.net` at the OS/hosts
   level, or via browser devtools request blocking) with the toggle on;
   confirm the GIF still generates successfully using the unoptimized
   output, and a console warning appears.
4. Confirm the new Settings Modal checkbox (`cytube.pc.user.js`) persists
   across a page reload.
5. Confirm the new inline checkbox (`cytube.gifmaker.user.js`) persists
   across a page reload, and that toggling it in one script is reflected in
   the other if both are installed (shared `sc_gif_optimize` key, same as
   the existing shared ImgBB key behavior).
6. Confirm `node --check` passes on both scripts after implementation.
