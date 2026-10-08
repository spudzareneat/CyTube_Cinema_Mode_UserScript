# GIF Maker: CORS-blocked video detection + opt-in Tampermonkey fallback

Date: 2026-10-08
Module: `gifmaker` (`src/pc/modules/gifmaker/`)

## Problem

The GIF maker never draws the on-page CyTube `<video>` (it has no `crossOrigin`, so its canvas
is tainted). Capture (`captureGifFrames`) and filmstrip/scrub previews (`getScrubClone` /
`grabPreviewFrame`) instead load a hidden `crossOrigin='anonymous'` clone of the same URL.

Some hosts don't send `Access-Control-Allow-Origin` on the final media response. Confirmed case:
`archive.org/download/frankenstein-must-be-destroyed-1969/...X264-Retropeeps.mp4` — the
`archive.org/download` 302 carries `ACAO: *`, but the storage nodes it redirects to
(`ia600907` / `ia800907.us.archive.org`) return `206` with no ACAO. The clone fails to load, so
previews come out black/missing and capture fails with the vague `clone load error (CORS/network)`.

It is not a codec problem: that file is plain H.264 (`avc1`), 1.94 GB, `mdat` at offset 44 with
`moov` at the tail (not faststart).

## Goals

1. **Detect & explain** (#1): when a video can't be captured because of CORS, say so clearly,
   naming the host — never a silent black GIF or vague error.
2. **Opt-in fallback** (#2): fetch the media via `GM_xmlhttpRequest` (not subject to CORS), using
   HTTP Range requests for only the bytes needed, and decode with WebCodecs.
3. **Leave nothing behind**: no disk writes; all fetched data is in-memory and released
   automatically.
4. Fallback powers **both** final capture and filmstrip/scrub previews.

Success: on the Frankenstein movie, setting OFF → clear message with a one-click retry; retry or
setting ON → correct GIF and working thumbnails. A CORS-friendly video still uses the existing path
unchanged.

## Non-goals

- Non-MP4/MOV containers (MKV, WebM), HLS/DASH, YouTube, `blob:` sources — these get a clear
  "unsupported for fallback" message only.
- Downloading whole files.
- Changing encoding, effects, captions, or upload — they consume the same `{frames, w, h, delay}`.

## User-facing behavior

### Setting

Checkbox in the GIF panel options, stored in `localStorage` like the module's other settings,
**default off**:

> Fetch CORS-blocked videos via Tampermonkey (partial download, memory only)

### Flow

- Clone loads fine → existing path, unchanged.
- Clone fails and classification says **CORS**:
  - Setting **ON** → use the fallback automatically; panel status shows a small
    "via Tampermonkey" tag.
  - Setting **OFF** → status message:
    *"This video's host (`<hostname>`) doesn't allow frame capture."* with buttons
    **[Try via Tampermonkey]** (this video, this panel session only) and **[Always]**
    (turns the setting on, then proceeds). Filmstrip/scrub thumbnails show a
    "blocked by host" placeholder instead of black.
- Clone fails for a non-CORS reason → existing error, worded as a network/file error.

### Error states (fallback active), all as panel status text

| Condition | Message gist |
|---|---|
| Not an MP4/MOV (no `ftyp`/`moov` found) | "Fallback only supports MP4 files" |
| `VideoDecoder.isConfigSupported` false / no WebCodecs | "This browser can't decode `<codec>`" |
| Byte span for the clip > 200 MB | "Clip needs N MB of download — shorten it" (refuse, don't fetch) |
| Range fetch fails / times out | retry once, then "Download failed (`<status>`)" |
| > 80% of captured frames pure black (either path) | warning instead of silently returning a black GIF |

The black-frame guard applies to the existing clone path too (covers Firefox HW-decode readback
failures seen in the Failure Log).

## Architecture

New file `src/pc/modules/gifmaker/remote-decode.js`, listed **before** `index.js` in the gifmaker
module's `files` in `src/pc/manifest.json` (fragments are concatenated inside one IIFE). Pure
helpers are wrapped in `// ── test marker: <name> slice start/end ──` comments for node tests,
matching existing convention.

### Components

1. **`rangeFetch(url, start, end)`** → `Promise<ArrayBuffer>`
   `GM_xmlhttpRequest` with `responseType: 'arraybuffer'` and `Range: bytes=start-end`; follows
   redirects; validates `206`/`Content-Range`; 30 s timeout; one retry.
   **`probeSize(url)`** — `Range: bytes=0-0`, reads total from `Content-Range`.

2. **`locateMoov(readHeader, fileSize)`** (pure, test-marked) — walks top-level boxes reading only
   8/16-byte headers (handles 64-bit `largesize` and size 0 = to-EOF); returns `{ftyp, moov}`
   offsets/sizes or a "not MP4" result. Lets us skip a 1.9 GB `mdat` and fetch `moov` from the tail.

3. **`RemoteMp4.open(url)`** — `probeSize` → `locateMoov` → fetch `ftyp`+`moov` → feed to
   **mp4box.js** with correct `fileStart` → pick first video track. Exposes:
   - `codec`, `width`, `height`, `timescale`, `description` (avcC/hvcC/av1C/vpcC bytes for
     `VideoDecoder.configure`)
   - `samples[]`: `{cts, dts, duration, offset, size, isSync}` (seconds-converted times)

4. **`planSpan(samples, t0, t1, skip?)`** (pure, test-marked) — keyframe at or before `t0` through
   last sample with `cts < t1`; returns decode-order sample list plus coalesced byte ranges
   (merge when the gap ≤ 1 MB, since audio is interleaved) and total bytes for the cap check.

5. **`decodeSpan(mp4, t0, t1, onFrame, opts)`** — `planSpan` → fetch ranges (via cache) →
   `VideoDecoder` configured from the track → `EncodedVideoChunk` per sample (`key` = `isSync`) →
   `flush()`. Output frames with timestamp < `t0` (or inside `skip`) are closed immediately; others
   go to `onFrame(frame, tSeconds)`, which must draw then `frame.close()`. Decoder is closed after
   each span.

6. **Byte cache** — per-URL map of fetched `[start, end) → Uint8Array`, LRU-capped at ~150 MB.
   `RemoteMp4` instances cached per URL. Both dropped by `releaseRemote()`, called wherever
   `destroyScrubClone()` runs (panel close, source change).

7. **`classifyLoadFailure(src)`** → `'cors' | 'network' | 'unsupported-src'`
   `blob:`/non-http → `unsupported-src`. Otherwise `fetch(src, {mode:'cors', headers:{Range:'bytes=0-0'}})`:
   if it rejects (TypeError) but `rangeFetch(src, 0, 0)` succeeds → `cors`; else `network`.
   Memoized per URL for the panel session.

### Integration in `index.js`

- **`captureGifFramesRemote(args, onProgress)`** — same args/return as `captureGifFrames`.
  `decodeSpan(startT, endT, skip)`; samples to `fps` with the same `lastCap + frameInterval` rule;
  draws via `computeFrameGeometry` (letterbox/crop/fit) + `drawCaptions`; progress from frame time.
- **Capture call site** (~line 2824) — on clone failure, `classifyLoadFailure`; on `cors` follow the
  flow above (auto, or message + buttons that re-run capture through `captureGifFramesRemote`).
- **`grabPreviewFrame`** — on CORS (and fallback permitted): `decodeSpan(time, time + 1 frame)`,
  first frame ≥ `time` → scaled JPEG data URL. Serialized through the existing `busy` chain. When not
  permitted: placeholder thumbnail.
- **Black-frame guard** — after capture (both paths), sample luminance of each frame at low
  resolution; if > 80% are near-black, show the warning (GIF still available).

### Manifest

gifmaker module:
- `requires` += mp4box.js from jsdelivr (pinned version, `dist/mp4box.all.min.js`).
- `connects` += `archive.org`, `us.archive.org`, `*` (Tampermonkey asks once per new domain).
- `files` += `src/pc/modules/gifmaker/remote-decode.js` before `index.js`.
- Bump `baseVersion` in both `src/pc/manifest.json` and `docs/manifest.json` every testing rebuild.

## Cleanup guarantees

- No disk writes, no IndexedDB/Cache API.
- Every `VideoFrame` closed after drawing; `VideoDecoder` closed per span.
- Byte cache + `RemoteMp4` released on panel close / source change; cache capped at ~150 MB while open.

## Testing

**Node** — `scripts/test-gif-remote.mjs` (slice-and-eval convention, no runner):
- `locateMoov`: moov-at-front, moov-at-tail behind huge `mdat`, 64-bit largesize, size-0 box, non-MP4.
- `planSpan`: keyframe selection before `t0`, end boundary, jump-cut `skip`, range coalescing with
  interleaved gaps, byte total for the 200 MB cap.
- `classifyLoadFailure`: stubbed `fetch` / `GM_xmlhttpRequest` → cors / network / unsupported-src.

**Live** (Firefox and Chrome):
- Frankenstein movie, setting off → host message + placeholders; [Try] → correct GIF + thumbnails;
  [Always] persists.
- A CORS-friendly video → existing path, no regression.
- Panel close → memory released (DevTools memory snapshot shows no retained cache buffers).

## Constraints / notes

- `src/pc/modules/gifmaker/index.js` currently has ~280 lines of uncommitted WIP; implementation
  must build on it and must not stage unrelated changes (stage hunks selectively).
- WebCodecs: Chrome 94+, Firefox 130+. H.264 decode available in both on Windows.
