# GIF Maker CORS Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the GIF maker's hidden `crossOrigin` clone can't load a video because the host omits CORS headers, say so clearly; and (opt-in) capture frames anyway by Range-fetching only the needed MP4 bytes through `GM_xmlhttpRequest` and decoding them with WebCodecs — memory only, auto-released.

**Architecture:** New fragment `src/pc/modules/gifmaker/remote-decode.js` (concatenated before `index.js` in the same IIFE) holds: pure helpers (box walking, span planning, byte cache, black-frame check), a network layer (`GM_xmlhttpRequest` range fetch / probe / CORS classification), and the MP4/WebCodecs layer (mp4box.js parses `moov`; `VideoDecoder` decodes planned spans). `index.js` gains `captureGifFramesRemote` / `grabPreviewFrameRemote` (same return shapes as the existing clone paths) and panel UI: an opt-in checkbox, a "host blocks capture" message with [Try via Tampermonkey] / [Always], blocked-thumbnail placeholders, and a black-frame warning.

**Tech Stack:** Tampermonkey userscript fragments (plain JS, no modules), `GM_xmlhttpRequest`, mp4box.js 0.5.4 (`@require`), WebCodecs `VideoDecoder`, Node 22 plain-script tests (no runner).

**Spec:** `docs/superpowers/specs/2026-10-08-gif-cors-fallback-design.md`

## Global Constraints

- **Uncommitted user WIP:** `src/pc/modules/gifmaker/index.js`, `src/pc/manifest.json`, `docs/manifest.json` (and other files) carry the user's uncommitted edits. NEVER `git add -A`, `git add .`, `git stash`, `git checkout -- <file>`, or `git add <those files>`. Tasks 1–3 commit only their NEW files. Edits to `index.js` / manifests stay uncommitted until Task 6's WIP-safe staging procedure.
- **Before any edit, verify location:** `pwd` is `C:\Repos\cytube_tv_interface_script` (or `/c/Repos/cytube_tv_interface_script`), branch `main`. Do not use worktrees (the WIP lives only in this checkout).
- **Fragment rules:** `src/pc/**` files are script fragments concatenated into one IIFE — no `import`/`export`, 4-space indent, top-level declarations are shared across all modules, so every new top-level name starts with `gif`/`Gif` (or `_gif`) to avoid collisions.
- **Test slices:** pure/testable code is wrapped in `// ── test marker: <name> slice start ──` / `// ── test marker: <name> slice end ──` comments (exact characters, copy them) and evaluated by `scripts/test-gif-remote.mjs` via `new Function`.
- **Limits (from spec):** span download cap **200 MB** (`200 * 1024 * 1024`), byte cache cap **~150 MB** (`150 * 1024 * 1024`), range coalesce gap **1 MB**, black-frame warning when **> 80%** of frames are near-black.
- **Setting:** default **off**; label text exactly: `Fetch CORS-blocked videos via Tampermonkey (partial download, memory only)`.
- **Blocked message text:** `This video's host (<hostname>) doesn't allow frame capture.` with buttons `Try via Tampermonkey` and `Always`.
- **No disk:** no IndexedDB, Cache API, `localStorage` for bytes, or downloads. Every `VideoFrame` closed after use; `VideoDecoder` closed after each span.
- **mp4box:** `https://cdn.jsdelivr.net/npm/mp4box@0.5.4/dist/mp4box.all.min.js` (defines globals `MP4Box`, `DataStream`).
- **Version:** bump `baseVersion` in BOTH `src/pc/manifest.json` and `docs/manifest.json` on every build the user will test (currently `4.13.58` → `4.13.59`).
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Open-GOP / B-frame files** — leading B-frames after a keyframe reference the previous GOP; decoder must not error out or emit garbage frames into the GIF (frames before `t0` are dropped; Task 1 planSpan B-frame test + Task 3 output filter).
2. **Edit-list offset** — sample `cts` vs. the player's `currentTime` differ by the `elst` media_time (this file: 3750/90000 s); without the shift the GIF is off by a frame or more (Task 3 live test asserts first `cts ≈ 0`).
3. **Host that ignores Range (HTTP 200)** — must abort quickly, never pull a multi-GB body into memory (Task 2 `gifProbeSize` 200 test + onprogress abort).
4. **Many filmstrip tiles hitting a blocked host at once** — classification memoized, message shown once, no request storm (Task 2 memo test; Task 5 idempotent `showCorsBlocked`).
5. **Panel closed mid-download / reopened on another movie** — caches released, stale promise results harmless (Task 4 `gifReleaseRemote` in `destroyScrubClone`; Task 3 cache tests).

---

### Task 1: Pure helpers in `remote-decode.js` + node tests

**Files:**
- Create: `src/pc/modules/gifmaker/remote-decode.js`
- Create: `scripts/test-gif-remote.mjs`

**Interfaces:**
- Produces (all top-level in the fragment, inside slice `gif-remote-pure`):
  - `class GifRemoteError extends Error { constructor(code: string, message: string) }` — `.code`
  - `GIF_REMOTE_MAX_SPAN_BYTES = 209715200`, `GIF_REMOTE_CACHE_BYTES = 157286400`, `GIF_REMOTE_MERGE_GAP = 1048576`, `GIF_REORDER_MARGIN = 2`
  - `async gifLocateTopBoxes(readHeader: (off:number)=>Promise<Uint8Array>, fileSize: number) → {ok:boolean, boxes:[{type,offset,size,headerLen}], ftyp?, moov?}`
  - `gifCoalesceRanges(list:[{offset,size}], gap:number) → [{start,end}]` (end exclusive)
  - `gifPlanSpan(samples:[{cts,dts,duration,offset,size,isSync}], t0:number, t1:number) → null | {samples, ranges, totalBytes}` (times in seconds, samples in decode order)
  - `gifKeyframeAtOrBefore(samples, t) → sample | null`
  - `class GifByteCache { constructor(cap); get(url,start,end) → Uint8Array|null; put(url,start,bytes); clear(); total }`
  - `gifSampleBytes(blocks:[{start,bytes:Uint8Array}], offset, size) → Uint8Array` (throws `GifRemoteError('internal', …)` if missing)
  - `gifFrameIsBlack(img:{data}) → boolean`, `gifMostlyBlack(frames:[{data}], frac=0.8) → boolean`

- [ ] **Step 1: Verify location**

Run: `cd /c/Repos/cytube_tv_interface_script && pwd && git branch --show-current`
Expected: `/c/Repos/cytube_tv_interface_script` and `main`.

- [ ] **Step 2: Write the failing test file**

Create `scripts/test-gif-remote.mjs`:

```js
// scripts/test-gif-remote.mjs
//
// Standalone assertions for the GIF maker's CORS fallback in
// src/pc/modules/gifmaker/remote-decode.js:
//   - "gif-remote-pure" slice -- box walking, span planning, byte cache, black-frame check
//   - "gif-remote-net"  slice -- GM range fetch / probe / CORS classification (fake GM + fetch)
//   - "gif-remote-mp4"  slice -- only with --live: parses the real archive.org file's moov
//
//   node scripts/test-gif-remote.mjs          (offline)
//   node scripts/test-gif-remote.mjs --live   (also hits archive.org, ~4 MB download)
//
// src/pc/** files are script fragments concatenated inside one IIFE, not ES modules, so this
// slices code out between "test marker" comments and evals it, same as test-simkl-scrobble.mjs.

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(__dirname, '..', 'src', 'pc', 'modules', 'gifmaker', 'remote-decode.js');
const src = fs.existsSync(srcPath) ? fs.readFileSync(srcPath, 'utf8') : '';
const LIVE = process.argv.includes('--live');

function slice(name) {
    const START = `// ── test marker: ${name} slice start ──`;
    const END = `// ── test marker: ${name} slice end ──`;
    const a = src.indexOf(START);
    const b = src.indexOf(END);
    if (a === -1 || b === -1 || b < a) {
        console.error(`FAIL: could not locate the "${name}" test-marker slice in gifmaker/remote-decode.js`);
        process.exit(1);
    }
    return src.slice(a, b);
}
const exportsOf = names => `{ ${names.map(n => `${n}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ')} }`;

let passed = 0;
async function test(name, fn) {
    try { await fn(); passed++; }
    catch (e) { console.error(`FAIL: ${name}`); console.error(e); process.exit(1); }
}

// ── pure slice ───────────────────────────────────────────────────────────────

const PURE_NAMES = [
    'GifRemoteError', 'GIF_REMOTE_MAX_SPAN_BYTES', 'GIF_REMOTE_CACHE_BYTES', 'GIF_REMOTE_MERGE_GAP',
    'GIF_REORDER_MARGIN', 'gifLocateTopBoxes', 'gifCoalesceRanges', 'gifPlanSpan',
    'gifKeyframeAtOrBefore', 'GifByteCache', 'gifSampleBytes', 'gifFrameIsBlack', 'gifMostlyBlack',
];
// eslint-disable-next-line no-new-func
const P = new Function(`${slice('gif-remote-pure')}\n;return ${exportsOf(PURE_NAMES)};`)();

// Virtual sparse file: boxes = [{type, size, large?}] laid end to end.
// readHeader(off) returns the 16 header bytes of the box starting at off.
function virtualFile(boxes, { garbageAt0 = false } = {}) {
    const starts = [];
    let off = 0;
    for (const b of boxes) { starts.push(off); off += b.size; }
    const fileSize = off;
    const calls = [];
    const readHeader = async (at) => {
        calls.push(at);
        const out = new Uint8Array(16);
        if (garbageAt0 && at === 0) { out.set([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]); return out; }
        const i = starts.indexOf(at);
        if (i === -1) return out; // zeros
        const b = boxes[i];
        const dv = new DataView(out.buffer);
        if (b.large) { dv.setUint32(0, 1); dv.setBigUint64(8, BigInt(b.size)); }
        else if (b.toEof) dv.setUint32(0, 0);
        else dv.setUint32(0, b.size);
        for (let k = 0; k < 4; k++) out[4 + k] = b.type.charCodeAt(k);
        return out;
    };
    return { readHeader, fileSize, calls };
}

await test('gifLocateTopBoxes: moov at tail behind a huge mdat (archive.org layout)', async () => {
    const vf = virtualFile([
        { type: 'ftyp', size: 32 }, { type: 'free', size: 8 },
        { type: 'mdat', size: 1937547730 }, { type: 'moov', size: 3803998 },
    ]);
    const r = await P.gifLocateTopBoxes(vf.readHeader, vf.fileSize);
    assert.equal(r.ok, true);
    assert.equal(r.moov.offset, 1937547770);
    assert.equal(r.moov.size, 3803998);
    assert.equal(r.ftyp.offset, 0);
    assert.deepEqual(vf.calls, [0, 32, 40, 1937547770]); // only headers read, mdat skipped
});

await test('gifLocateTopBoxes: moov at front (faststart)', async () => {
    const vf = virtualFile([{ type: 'ftyp', size: 24 }, { type: 'moov', size: 5000 }, { type: 'mdat', size: 900000 }]);
    const r = await P.gifLocateTopBoxes(vf.readHeader, vf.fileSize);
    assert.equal(r.ok, true);
    assert.equal(r.moov.offset, 24);
    assert.equal(r.boxes.length, 3);
});

await test('gifLocateTopBoxes: 64-bit largesize mdat', async () => {
    const vf = virtualFile([{ type: 'ftyp', size: 24 }, { type: 'mdat', size: 5_000_000_000, large: true }, { type: 'moov', size: 7000 }]);
    const r = await P.gifLocateTopBoxes(vf.readHeader, vf.fileSize);
    assert.equal(r.ok, true);
    assert.equal(r.moov.offset, 24 + 5_000_000_000);
    assert.equal(r.boxes[1].headerLen, 16);
});

await test('gifLocateTopBoxes: size-0 (to EOF) last box after moov', async () => {
    const vf = virtualFile([{ type: 'ftyp', size: 24 }, { type: 'moov', size: 900 }, { type: 'mdat', size: 50000, toEof: true }]);
    const r = await P.gifLocateTopBoxes(vf.readHeader, vf.fileSize);
    assert.equal(r.ok, true);
    assert.equal(r.boxes[2].size, 50000);
});

await test('gifLocateTopBoxes: non-MP4 (MKV/EBML) and missing moov are not ok', async () => {
    const mkv = virtualFile([{ type: 'xxxx', size: 1000 }], { garbageAt0: true });
    assert.equal((await P.gifLocateTopBoxes(mkv.readHeader, mkv.fileSize)).ok, false);
    const noMoov = virtualFile([{ type: 'ftyp', size: 24 }, { type: 'mdat', size: 1000 }]);
    assert.equal((await P.gifLocateTopBoxes(noMoov.readHeader, noMoov.fileSize)).ok, false);
});

// 25 fps, keyframe every 12 frames, no B-frames, 1000-byte video samples with a
// 200-byte audio chunk interleaved after each (so offsets step by 1200).
function linearSamples(n, fps = 25, gop = 12) {
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push({ cts: i / fps, dts: i / fps, duration: 1 / fps, offset: 48 + i * 1200, size: 1000, isSync: i % gop === 0 });
    }
    return out;
}

await test('gifPlanSpan: starts at keyframe at/before t0, ends at last frame before t1', () => {
    const s = linearSamples(250);
    const plan = P.gifPlanSpan(s, 1.0, 1.5);
    assert.equal(plan.samples[0].cts, 24 / 25);            // keyframe 24 @ 0.96 s
    assert.equal(plan.samples[0].isSync, true);
    assert.equal(plan.samples[plan.samples.length - 1].cts, 37 / 25); // 1.48 s
    assert.equal(plan.ranges.length, 1);                     // 200-byte audio gaps coalesce
    assert.equal(plan.ranges[0].start, 48 + 24 * 1200);
    assert.equal(plan.ranges[0].end, 48 + 37 * 1200 + 1000);
    assert.equal(plan.totalBytes, plan.ranges[0].end - plan.ranges[0].start);
});

await test('gifPlanSpan: t0 before the first keyframe uses the first keyframe; empty span is null', () => {
    const s = linearSamples(50);
    assert.equal(P.gifPlanSpan(s, 0, 0.2).samples[0].cts, 0);
    assert.equal(P.gifPlanSpan(s, 1.0, 1.0), null);
    assert.equal(P.gifPlanSpan([], 0, 1), null);
});

await test('gifPlanSpan: B-frames — includes the decode-order P frame the B frames depend on', () => {
    // decode order I0 P3 B1 B2 P6 B4 B5 (cts in frame units of 0.04 s)
    const d = 0.04;
    const order = [0, 3, 1, 2, 6, 4, 5];
    const s = order.map((c, i) => ({ cts: c * d, dts: i * d, duration: d, offset: 100 + i * 500, size: 500, isSync: i === 0 }));
    const plan = P.gifPlanSpan(s, 0, 2.5 * d); // want frames cts 0,1,2
    assert.deepEqual(plan.samples.map(x => Math.round(x.cts / d)), [0, 3, 1, 2]);
});

await test('gifCoalesceRanges: gap > 1 MB splits ranges', () => {
    const r = P.gifCoalesceRanges([{ offset: 0, size: 10 }, { offset: 10 + 2 * 1048576, size: 10 }], P.GIF_REMOTE_MERGE_GAP);
    assert.equal(r.length, 2);
    const m = P.gifCoalesceRanges([{ offset: 0, size: 10 }, { offset: 500, size: 10 }], P.GIF_REMOTE_MERGE_GAP);
    assert.deepEqual(m, [{ start: 0, end: 510 }]);
});

await test('gifKeyframeAtOrBefore', () => {
    const s = linearSamples(100);
    assert.equal(P.gifKeyframeAtOrBefore(s, 1.3).cts, 24 / 25);
    assert.equal(P.gifKeyframeAtOrBefore(s, 0).cts, 0);
});

await test('GifByteCache: containment hits, LRU eviction, clear', () => {
    const c = new P.GifByteCache(1000);
    c.put('u', 100, new Uint8Array(400).map((_, i) => i % 256));
    const hit = c.get('u', 150, 200);
    assert.equal(hit.length, 50);
    assert.equal(hit[0], 50);
    assert.equal(c.get('u', 50, 200), null);   // not fully contained
    assert.equal(c.get('other', 150, 200), null);
    c.put('u', 1000, new Uint8Array(400));
    c.get('u', 100, 110);                      // touch first block -> most recent
    c.put('u', 2000, new Uint8Array(400));     // total 1200 > 1000 -> evict LRU (block @1000)
    assert.equal(c.get('u', 1000, 1010), null);
    assert.ok(c.get('u', 100, 110));
    assert.ok(c.total <= 1000);
    c.clear();
    assert.equal(c.total, 0);
    assert.equal(c.get('u', 100, 110), null);
});

await test('gifSampleBytes: slices from the right block, throws when missing', () => {
    const blocks = [{ start: 1000, bytes: new Uint8Array([1, 2, 3, 4, 5]) }];
    assert.deepEqual([...P.gifSampleBytes(blocks, 1001, 3)], [2, 3, 4]);
    assert.throws(() => P.gifSampleBytes(blocks, 1003, 5), e => e.code === 'internal');
});

await test('gifMostlyBlack: threshold behaviour', () => {
    const frame = v => ({ data: new Uint8ClampedArray(64 * 36 * 4).fill(v) });
    assert.equal(P.gifFrameIsBlack(frame(0)), true);
    assert.equal(P.gifFrameIsBlack(frame(120)), false);
    assert.equal(P.gifMostlyBlack([frame(0), frame(0), frame(0), frame(0), frame(0)]), true);
    assert.equal(P.gifMostlyBlack([frame(0), frame(0), frame(0), frame(120), frame(120)]), false); // 60%
    assert.equal(P.gifMostlyBlack([]), false);
});

console.log(`ok - ${passed} test groups passed`);
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node scripts/test-gif-remote.mjs`
Expected: `FAIL: could not locate the "gif-remote-pure" test-marker slice` (file doesn't exist yet), exit 1.

- [ ] **Step 4: Write `remote-decode.js` with the pure slice**

Create `src/pc/modules/gifmaker/remote-decode.js`:

```js
    /* ==========================================================
       GIF MAKER — REMOTE DECODE (CORS fallback)
       Some hosts (archive.org storage nodes) send no
       Access-Control-Allow-Origin on media responses, so the hidden
       crossOrigin clone used for capture/previews can't load. When
       the user opts in, this file fetches ONLY the bytes needed via
       GM_xmlhttpRequest Range requests (not subject to CORS), reads
       the MP4 index with mp4box.js, and decodes frames with WebCodecs.
       Everything lives in memory and is dropped by gifReleaseRemote()
       (called from destroyScrubClone on panel close / source change).
       Spec: docs/superpowers/specs/2026-10-08-gif-cors-fallback-design.md
    ========================================================== */
    // ── test marker: gif-remote-pure slice start ──
    class GifRemoteError extends Error {
        constructor(code, message) { super(message); this.code = code; }
    }
    const GIF_REMOTE_MAX_SPAN_BYTES = 200 * 1024 * 1024;
    const GIF_REMOTE_CACHE_BYTES = 150 * 1024 * 1024;
    const GIF_REMOTE_MERGE_GAP = 1024 * 1024;   // audio is interleaved; fetch through small gaps
    const GIF_REORDER_MARGIN = 2;               // seconds of B-frame reorder lookahead

    // Walk top-level MP4 boxes reading only their 8/16-byte headers, so a
    // multi-GB mdat in front of a tail moov costs one 16-byte read.
    async function gifLocateTopBoxes(readHeader, fileSize) {
        const boxes = [];
        let off = 0, guard = 0;
        while (off < fileSize && guard++ < 64) {
            const h = await readHeader(off);
            if (!h || h.length < 8) break;
            const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
            let size = dv.getUint32(0);
            const type = String.fromCharCode(h[4], h[5], h[6], h[7]);
            let headerLen = 8;
            if (size === 1) {
                if (h.length < 16) break;
                size = Number(dv.getBigUint64(8));
                headerLen = 16;
            } else if (size === 0) {
                size = fileSize - off;
            }
            if (!/^[a-zA-Z0-9 ©]{4}$/.test(type) || size < headerLen || off + size > fileSize) break;
            boxes.push({ type, offset: off, size, headerLen });
            off += size;
        }
        const ftyp = boxes.find(b => b.type === 'ftyp');
        const moov = boxes.find(b => b.type === 'moov');
        return { ok: !!moov, boxes, ftyp, moov };
    }

    function gifCoalesceRanges(list, gap) {
        const sorted = list.map(s => [s.offset, s.offset + s.size]).sort((a, b) => a[0] - b[0]);
        const out = [];
        for (const [a, b] of sorted) {
            const last = out[out.length - 1];
            if (last && a - last.end <= gap) last.end = Math.max(last.end, b);
            else out.push({ start: a, end: b });
        }
        return out;
    }

    // samples are in decode order, times in seconds. Returns the decode-order
    // run from the keyframe at/before t0 through the last sample shown before
    // t1 (scanning a little past t1 in dts for reordered B-frames).
    function gifPlanSpan(samples, t0, t1) {
        if (!samples || !samples.length || !(t1 > t0)) return null;
        let k = -1;
        for (let i = 0; i < samples.length; i++) {
            const s = samples[i];
            if (s.isSync && s.cts <= t0 + 1e-6) k = i;
            else if (s.dts > t0 + GIF_REORDER_MARGIN) break;
        }
        if (k === -1) k = samples.findIndex(s => s.isSync);
        if (k === -1) return null;
        let e = -1;
        for (let i = k; i < samples.length; i++) {
            const s = samples[i];
            if (s.cts < t1 - 1e-6) e = i;
            if (s.dts > t1 + GIF_REORDER_MARGIN) break;
        }
        if (e < k) return null;
        const list = samples.slice(k, e + 1);
        const ranges = gifCoalesceRanges(list, GIF_REMOTE_MERGE_GAP);
        return { samples: list, ranges, totalBytes: ranges.reduce((a, r) => a + (r.end - r.start), 0) };
    }

    function gifKeyframeAtOrBefore(samples, t) {
        let best = null;
        for (const s of samples) {
            if (s.isSync && s.cts <= t + 1e-6 && (!best || s.cts > best.cts)) best = s;
            else if (s.dts > t + GIF_REORDER_MARGIN) break;
        }
        return best || samples.find(s => s.isSync) || null;
    }

    // In-memory LRU of fetched byte blocks; a get() hits when one block fully
    // contains [start, end).
    class GifByteCache {
        constructor(cap) { this.cap = cap; this.total = 0; this.map = new Map(); }
        get(url, start, end) {
            for (const [key, b] of this.map) {
                if (b.url === url && b.start <= start && b.start + b.bytes.length >= end) {
                    this.map.delete(key); this.map.set(key, b); // touch
                    return b.bytes.subarray(start - b.start, end - b.start);
                }
            }
            return null;
        }
        put(url, start, bytes) {
            const key = url + '|' + start + '|' + bytes.length;
            if (this.map.has(key)) return;
            this.map.set(key, { url, start, bytes });
            this.total += bytes.length;
            for (const [k, b] of this.map) {
                if (this.total <= this.cap || k === key) break;
                this.map.delete(k);
                this.total -= b.bytes.length;
            }
        }
        clear() { this.map.clear(); this.total = 0; }
    }

    function gifSampleBytes(blocks, offset, size) {
        for (const b of blocks) {
            if (b.start <= offset && offset + size <= b.start + b.bytes.length) {
                return b.bytes.subarray(offset - b.start, offset - b.start + size);
            }
        }
        throw new GifRemoteError('internal', 'sample bytes missing at offset ' + offset);
    }

    // Near-black = >= 85% of sampled pixels have luma < 16 (captions on a
    // black frame still count as black).
    function gifFrameIsBlack(img) {
        const d = img.data;
        let dark = 0, n = 0;
        for (let i = 0; i + 2 < d.length; i += 4 * 37) {
            const y = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
            if (y < 16) dark++;
            n++;
        }
        return n > 0 && dark / n >= 0.85;
    }
    function gifMostlyBlack(frames, frac = 0.8) {
        if (!frames || !frames.length) return false;
        let black = 0;
        for (const f of frames) if (gifFrameIsBlack(f)) black++;
        return black / frames.length > frac;
    }
    // ── test marker: gif-remote-pure slice end ──
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node scripts/test-gif-remote.mjs`
Expected: `ok - 13 test groups passed`

- [ ] **Step 6: Commit (new files only)**

```bash
git add src/pc/modules/gifmaker/remote-decode.js scripts/test-gif-remote.mjs
git commit -m "feat(gifmaker): pure helpers for CORS-fallback remote decode (box walk, span plan, byte cache, black check)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Network layer — range fetch, probe, CORS classification

**Files:**
- Modify: `src/pc/modules/gifmaker/remote-decode.js` (append after the pure slice)
- Modify: `scripts/test-gif-remote.mjs` (append net tests before the final `console.log`)

**Interfaces:**
- Consumes: `GifRemoteError` (Task 1).
- Produces (slice `gif-remote-net`; free identifiers `GM_xmlhttpRequest`, `fetch`):
  - `gifParseContentRangeTotal(headers: string) → number` (NaN if absent)
  - `gifRangeFetch(url, start, end /*inclusive*/, timeoutMs=30000) → Promise<ArrayBuffer>` — requires 206 and exact length; retries once; rejects `GifRemoteError('http', …)`
  - `gifProbeSize(url) → Promise<{size:number, url:string /*final, post-redirect*/}>` — rejects `GifRemoteError('no-range'|'http', …)`
  - `gifClassifyLoadFailure(src) → Promise<{kind:'cors'|'network'|'unsupported-src', finalUrl?:string}>` — memoized per src in `_gifLoadClass` (a `Map`)

- [ ] **Step 1: Append failing tests**

Insert before the final `console.log(...)` line in `scripts/test-gif-remote.mjs`:

```js
// ── net slice (fake GM_xmlhttpRequest + fetch) ───────────────────────────────

const NET_NAMES = ['gifParseContentRangeTotal', 'gifRangeFetch', 'gifProbeSize', 'gifClassifyLoadFailure', '_gifLoadClass'];
function loadNet({ gm, fetchFn }) {
    // eslint-disable-next-line no-new-func
    return new Function('GM_xmlhttpRequest', 'fetch',
        `${slice('gif-remote-pure')}\n${slice('gif-remote-net')}\n;return ${exportsOf(NET_NAMES)};`)(gm, fetchFn);
}
// gm responder: (details, callIndex) -> {status, response?, responseHeaders?, finalUrl?} | 'error' | 'timeout'
function fakeGm(responder) {
    const calls = [];
    const gm = (details) => {
        const i = calls.length;
        calls.push(details);
        const r = responder(details, i);
        setTimeout(() => {
            if (r === 'error') details.onerror && details.onerror({});
            else if (r === 'timeout') details.ontimeout && details.ontimeout({});
            else details.onload(r);
        }, 0);
        return { abort() {} };
    };
    gm.calls = calls;
    return gm;
}
const ab = n => new ArrayBuffer(n);

await test('gifParseContentRangeTotal', () => {
    const N = loadNet({ gm: fakeGm(() => 'error'), fetchFn: async () => ({}) });
    assert.equal(N.gifParseContentRangeTotal('Content-Type: video/mp4\r\nContent-Range: bytes 0-0/1941351768\r\n'), 1941351768);
    assert.ok(Number.isNaN(N.gifParseContentRangeTotal('Content-Type: video/mp4')));
});

await test('gifRangeFetch: 206 with exact length resolves; sends Range header', async () => {
    const gm = fakeGm(() => ({ status: 206, response: ab(10) }));
    const N = loadNet({ gm, fetchFn: null });
    const buf = await N.gifRangeFetch('https://h/x.mp4', 100, 109);
    assert.equal(buf.byteLength, 10);
    assert.equal(gm.calls[0].headers.Range, 'bytes=100-109');
    assert.equal(gm.calls[0].responseType, 'arraybuffer');
});

await test('gifRangeFetch: retries once, then rejects with code http', async () => {
    const gm1 = fakeGm((d, i) => (i === 0 ? { status: 500 } : { status: 206, response: ab(4) }));
    assert.equal((await loadNet({ gm: gm1, fetchFn: null }).gifRangeFetch('u', 0, 3)).byteLength, 4);
    const gm2 = fakeGm(() => ({ status: 200, response: ab(4) }));
    await assert.rejects(loadNet({ gm: gm2, fetchFn: null }).gifRangeFetch('u', 0, 3), e => e.code === 'http');
    assert.equal(gm2.calls.length, 2);
});

await test('gifProbeSize: 206 + Content-Range gives size and final URL; 200 is no-range', async () => {
    const ok = fakeGm(() => ({ status: 206, response: ab(1), responseHeaders: 'content-range: bytes 0-0/5000\r\n', finalUrl: 'https://node7/x.mp4' }));
    assert.deepEqual(await loadNet({ gm: ok, fetchFn: null }).gifProbeSize('https://h/x.mp4'), { size: 5000, url: 'https://node7/x.mp4' });
    const full = fakeGm(() => ({ status: 200, response: ab(1), responseHeaders: '' }));
    await assert.rejects(loadNet({ gm: full, fetchFn: null }).gifProbeSize('u'), e => e.code === 'no-range');
    const nf = fakeGm(() => ({ status: 404, responseHeaders: '' }));
    await assert.rejects(loadNet({ gm: nf, fetchFn: null }).gifProbeSize('u'), e => e.code === 'http');
});

await test('gifClassifyLoadFailure: cors / network / unsupported-src, memoized', async () => {
    const corsGm = fakeGm(() => ({ status: 206, response: ab(1), responseHeaders: 'Content-Range: bytes 0-0/99', finalUrl: 'https://ia600907.us.archive.org/f.mp4' }));
    let fetchCalls = 0;
    const blocked = async () => { fetchCalls++; throw new TypeError('NetworkError when attempting to fetch resource.'); };
    const N = loadNet({ gm: corsGm, fetchFn: blocked });
    assert.deepEqual(await N.gifClassifyLoadFailure('https://archive.org/download/a/f.mp4'),
        { kind: 'cors', finalUrl: 'https://ia600907.us.archive.org/f.mp4' });
    await N.gifClassifyLoadFailure('https://archive.org/download/a/f.mp4');
    assert.equal(fetchCalls, 1); // memoized

    const dead = loadNet({ gm: fakeGm(() => 'error'), fetchFn: blocked });
    assert.equal((await dead.gifClassifyLoadFailure('https://h/x.mp4')).kind, 'network');

    const corsOk = loadNet({ gm: corsGm, fetchFn: async () => ({ body: { cancel() {} } }) });
    assert.equal((await corsOk.gifClassifyLoadFailure('https://h/y.mp4')).kind, 'network');

    assert.equal((await N.gifClassifyLoadFailure('blob:https://cytu.be/123')).kind, 'unsupported-src');
    assert.equal((await N.gifClassifyLoadFailure('')).kind, 'unsupported-src');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node scripts/test-gif-remote.mjs`
Expected: `FAIL: could not locate the "gif-remote-net" test-marker slice`, exit 1.

- [ ] **Step 3: Append the net slice to `remote-decode.js`**

```js

    // ── test marker: gif-remote-net slice start ──
    function gifParseContentRangeTotal(headers) {
        const m = /content-range:\s*bytes\s+\d+-\d+\/(\d+)/i.exec(headers || '');
        return m ? Number(m[1]) : NaN;
    }

    // end is inclusive (HTTP Range semantics). Callers must clamp to size-1.
    function gifRangeFetch(url, start, end, timeoutMs) {
        const ms = timeoutMs || 30000;
        const once = () => new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url, responseType: 'arraybuffer', timeout: ms,
                headers: { Range: 'bytes=' + start + '-' + end },
                onload: r => {
                    if (r.status !== 206) { reject(new GifRemoteError('http', 'Download failed (HTTP ' + r.status + ')')); return; }
                    const buf = r.response;
                    if (!buf || buf.byteLength !== end - start + 1) { reject(new GifRemoteError('http', 'Download failed (short read)')); return; }
                    resolve(buf);
                },
                onerror: () => reject(new GifRemoteError('http', 'Download failed (network error)')),
                ontimeout: () => reject(new GifRemoteError('http', 'Download failed (timed out)')),
            });
        });
        return once().catch(() => once());
    }

    // One-byte probe: total size from Content-Range plus the post-redirect URL
    // (archive.org 302s to a storage node; later ranges go straight there).
    // A host that ignores Range answers 200 with the whole file — abort as
    // soon as more than 1 MB arrives so a multi-GB body never lands in memory.
    function gifProbeSize(url) {
        return new Promise((resolve, reject) => {
            let req = null, done = false;
            const fail = (code, msg) => { if (!done) { done = true; reject(new GifRemoteError(code, msg)); } };
            req = GM_xmlhttpRequest({
                method: 'GET', url, responseType: 'arraybuffer', timeout: 20000,
                headers: { Range: 'bytes=0-0' },
                onprogress: p => {
                    if (!done && p && p.loaded > 1048576) {
                        try { req && req.abort(); } catch (e) {}
                        fail('no-range', "This host doesn't support partial downloads");
                    }
                },
                onload: r => {
                    if (done) return;
                    const total = gifParseContentRangeTotal(r.responseHeaders);
                    if (r.status === 206 && total > 0) { done = true; resolve({ size: total, url: r.finalUrl || url }); return; }
                    if (r.status === 200 || r.status === 206) fail('no-range', "This host doesn't support partial downloads");
                    else fail('http', 'Download failed (HTTP ' + r.status + ')');
                },
                onerror: () => fail('http', 'Download failed (network error)'),
                ontimeout: () => fail('http', 'Download failed (timed out)'),
            });
        });
    }

    // Why did the crossOrigin clone fail? A CORS-mode fetch failing while the
    // same bytes come back fine through GM (which ignores CORS) means the host
    // just omits Access-Control-Allow-Origin. Memoized per src.
    const _gifLoadClass = new Map();
    function gifClassifyLoadFailure(src) {
        if (!/^https?:\/\//i.test(src || '')) return Promise.resolve({ kind: 'unsupported-src' });
        if (_gifLoadClass.has(src)) return _gifLoadClass.get(src);
        const p = (async () => {
            try {
                const r = await fetch(src, { mode: 'cors', cache: 'no-store', headers: { Range: 'bytes=0-0' } });
                try { r.body && r.body.cancel(); } catch (e) {}
                return { kind: 'network' };   // CORS is fine; the clone failed for another reason
            } catch (e) {
                try {
                    const probe = await gifProbeSize(src);
                    return { kind: 'cors', finalUrl: probe.url };
                } catch (e2) {
                    return { kind: 'network' };
                }
            }
        })();
        _gifLoadClass.set(src, p);
        return p;
    }
    // ── test marker: gif-remote-net slice end ──
```

- [ ] **Step 4: Run tests**

Run: `node scripts/test-gif-remote.mjs`
Expected: `ok - 18 test groups passed`

- [ ] **Step 5: Commit (new-file only — remote-decode.js and the test are ours)**

```bash
git add src/pc/modules/gifmaker/remote-decode.js scripts/test-gif-remote.mjs
git commit -m "feat(gifmaker): GM range fetch, size probe, and CORS-failure classification for remote decode

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: MP4 index + WebCodecs span decode, wired into the manifests

**Files:**
- Modify: `src/pc/modules/gifmaker/remote-decode.js` (append)
- Modify: `scripts/test-gif-remote.mjs` (append `--live` test before final `console.log`)
- Modify (DO NOT COMMIT — user WIP): `src/pc/manifest.json`, `docs/manifest.json` (gifmaker module entry)

**Interfaces:**
- Consumes: Task 1 (`gifLocateTopBoxes`, `gifPlanSpan`, `GifByteCache`, `gifSampleBytes`, `GifRemoteError`, constants), Task 2 (`gifProbeSize`, `gifRangeFetch`, `_gifLoadClass`). Free globals: `MP4Box`, `DataStream`, `VideoDecoder`, `EncodedVideoChunk`.
- Produces (slice `gif-remote-mp4`):
  - `gifOpenRemoteMp4(src) → Promise<RemoteMp4>` where `RemoteMp4 = {src, url, size, codec, samples:[{cts,dts,duration,offset,size,isSync}] (seconds, edit-list shifted), config:VideoDecoderConfig}`; memoized per src; rejects `GifRemoteError('not-mp4'|'unsupported'|'no-range'|'http', msg)`
  - `gifDecodeSpan(mp4, t0, t1, onFrame:(frame:VideoFrame, tSec:number)=>void, opts?:{skip?:[a,b], onFetchProgress?:(0..1)=>void}) → Promise<void>` — `onFrame` must draw synchronously; the frame is closed right after it returns. Rejects `GifRemoteError('too-big'|'no-samples'|'http'|'decode', msg)`.
  - `gifReleaseRemote() → void` — clears byte cache, opened-file memo, classification memo.

- [ ] **Step 1: Append the failing live test**

Insert before the final `console.log(...)` in `scripts/test-gif-remote.mjs`:

```js
// ── mp4 slice (--live only: real archive.org file, real mp4box.js) ───────────

if (LIVE) {
    const FRANK = 'https://archive.org/download/frankenstein-must-be-destroyed-1969/Frankenstein%20Must%20Be%20Destroyed%201969%201080P%20Bluray%20Rerip%20Opus%202%200%20X264-Retropeeps.mp4';
    const mp4boxSrc = await (await fetch('https://cdn.jsdelivr.net/npm/mp4box@0.5.4/dist/mp4box.all.min.js')).text();
    // eslint-disable-next-line no-new-func
    const { MP4Box, DataStream } = new Function(`${mp4boxSrc}\n;return { MP4Box, DataStream };`)();
    // GM_xmlhttpRequest on top of Node fetch (follows redirects, keeps Range).
    const nodeGm = (d) => {
        const ctl = new AbortController();
        (async () => {
            try {
                const res = await fetch(d.url, { headers: d.headers, signal: ctl.signal });
                const buf = await res.arrayBuffer();
                const headers = [...res.headers].map(([k, v]) => `${k}: ${v}`).join('\r\n');
                d.onload({ status: res.status, response: buf, responseHeaders: headers, finalUrl: res.url });
            } catch (e) { d.onerror && d.onerror(e); }
        })();
        return { abort: () => ctl.abort() };
    };
    const fakeVideoDecoder = { isConfigSupported: async cfg => ({ supported: /^avc1\./.test(cfg.codec) && cfg.description instanceof Uint8Array }) };
    // eslint-disable-next-line no-new-func
    const M = new Function('GM_xmlhttpRequest', 'fetch', 'MP4Box', 'DataStream', 'VideoDecoder', 'EncodedVideoChunk',
        `${slice('gif-remote-pure')}\n${slice('gif-remote-net')}\n${slice('gif-remote-mp4')}\n;return ${exportsOf(['gifOpenRemoteMp4', 'gifPlanSpan', 'gifReleaseRemote'])};`
    )(nodeGm, fetch, MP4Box, DataStream, fakeVideoDecoder, null);

    await test('LIVE gifOpenRemoteMp4: parses the tail moov of the archive.org file', async () => {
        const mp4 = await M.gifOpenRemoteMp4(FRANK);
        assert.equal(mp4.codec, 'avc1.4d401f');
        assert.equal(mp4.samples.length, 144888);
        assert.ok(/\.us\.archive\.org\//.test(mp4.url), 'uses post-redirect storage-node URL');
        assert.ok(Math.abs(mp4.samples[0].cts) < 0.001, 'edit-list shift puts first frame at ~0 s, got ' + mp4.samples[0].cts);
        assert.equal(mp4.samples[0].isSync, true);
        const plan = M.gifPlanSpan(mp4.samples, 600, 603);
        assert.ok(plan.totalBytes > 500_000 && plan.totalBytes < 20 * 1048576, 'span bytes ' + plan.totalBytes);
        assert.ok(await M.gifOpenRemoteMp4(FRANK) === mp4, 'memoized');
        M.gifReleaseRemote();
    });
}
```

- [ ] **Step 2: Run live to verify failure**

Run: `node scripts/test-gif-remote.mjs --live`
Expected: `FAIL: could not locate the "gif-remote-mp4" test-marker slice`, exit 1.

- [ ] **Step 3: Append the mp4 slice to `remote-decode.js`**

```js

    // ── test marker: gif-remote-mp4 slice start ──
    const _gifByteCache = new GifByteCache(GIF_REMOTE_CACHE_BYTES);
    const _gifRemoteFiles = new Map(); // src -> Promise<RemoteMp4>

    function gifReleaseRemote() {
        _gifByteCache.clear();
        _gifRemoteFiles.clear();
        _gifLoadClass.clear();
    }

    function gifOpenRemoteMp4(src) {
        if (_gifRemoteFiles.has(src)) return _gifRemoteFiles.get(src);
        const p = (async () => {
            const { size, url } = await gifProbeSize(src);
            const readHeader = off => gifRangeFetch(url, off, Math.min(size - 1, off + 15)).then(b => new Uint8Array(b));
            const loc = await gifLocateTopBoxes(readHeader, size);
            if (!loc.ok) throw new GifRemoteError('not-mp4', 'The Tampermonkey fallback only supports MP4 files');
            const file = MP4Box.createFile();
            let info = null, parseErr = null;
            file.onReady = i => { info = i; };
            file.onError = e => { parseErr = e; };
            // mp4box parses sequentially: feed every top-level box, but only the
            // header of mdat (it then skips to the next box by fileStart).
            for (const b of loc.boxes) {
                const isMdat = b.type === 'mdat';
                if (!isMdat && b.size > 64 * 1024 * 1024) throw new GifRemoteError('not-mp4', 'MP4 index is too large (' + b.type + ')');
                const end = isMdat ? b.offset + b.headerLen - 1 : b.offset + b.size - 1;
                const buf = await gifRangeFetch(url, b.offset, end);
                buf.fileStart = b.offset;
                file.appendBuffer(buf);
            }
            file.flush();
            if (!info) throw new GifRemoteError('not-mp4', "Couldn't read the MP4 index" + (parseErr ? ': ' + parseErr : ''));
            const vt = info.videoTracks && info.videoTracks[0];
            if (!vt) throw new GifRemoteError('not-mp4', 'No video track in this file');
            const trak = file.getTrackById(vt.id);
            const ts = vt.timescale;
            // Players apply the edit list (elst media_time) so the first shown
            // frame is t=0; shift sample times the same way to line up with
            // the CyTube player's currentTime.
            let shift = 0;
            try {
                const ents = trak.edts && trak.edts.elst && trak.edts.elst.entries;
                const ent = ents && ents.find(x => x.media_time >= 0);
                if (ent) shift = ent.media_time / ts;
            } catch (e) {}
            const samples = trak.samples.map(s => ({
                cts: s.cts / ts - shift, dts: s.dts / ts - shift, duration: s.duration / ts,
                offset: s.offset, size: s.size, isSync: !!s.is_sync,
            }));
            const entry = trak.mdia.minf.stbl.stsd.entries[0];
            const descBox = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
            let description;
            if (descBox) {
                const ds = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
                descBox.write(ds);
                description = new Uint8Array(ds.buffer, 8); // drop the box header
            }
            const config = { codec: vt.codec, codedWidth: vt.video.width, codedHeight: vt.video.height };
            if (description) config.description = description;
            if (typeof VideoDecoder === 'undefined') throw new GifRemoteError('unsupported', "This browser doesn't support WebCodecs video decoding");
            const sup = await VideoDecoder.isConfigSupported(config);
            if (!sup || !sup.supported) throw new GifRemoteError('unsupported', "This browser can't decode " + vt.codec);
            return { src, url, size, codec: vt.codec, samples, config };
        })();
        p.catch(() => { if (_gifRemoteFiles.get(src) === p) _gifRemoteFiles.delete(src); });
        _gifRemoteFiles.set(src, p);
        return p;
    }

    async function gifDecodeSpan(mp4, t0, t1, onFrame, opts) {
        const o = opts || {};
        const plan = gifPlanSpan(mp4.samples, t0, t1);
        if (!plan) throw new GifRemoteError('no-samples', 'No video frames in that range');
        if (plan.totalBytes > GIF_REMOTE_MAX_SPAN_BYTES) {
            throw new GifRemoteError('too-big', 'Clip needs ' + Math.round(plan.totalBytes / 1048576) + ' MB of download — shorten it');
        }
        const blocks = [];
        let got = 0;
        for (const r of plan.ranges) {
            let bytes = _gifByteCache.get(mp4.url, r.start, r.end);
            if (!bytes) {
                bytes = new Uint8Array(await gifRangeFetch(mp4.url, r.start, Math.min(mp4.size, r.end) - 1));
                _gifByteCache.put(mp4.url, r.start, bytes);
            }
            blocks.push({ start: r.start, bytes });
            got += r.end - r.start;
            if (o.onFetchProgress) o.onFetchProgress(got / plan.totalBytes);
        }
        await new Promise((resolve, reject) => {
            let failed = null;
            const dec = new VideoDecoder({
                output: frame => {
                    const t = frame.timestamp / 1e6;
                    const inSkip = o.skip && t >= o.skip[0] && t < o.skip[1];
                    if (failed || t < t0 - 1e-4 || t >= t1 || inSkip) { frame.close(); return; }
                    try { onFrame(frame, t); } catch (e) { failed = e; } finally { frame.close(); }
                },
                error: e => { failed = failed || new GifRemoteError('decode', 'Video decode failed: ' + (e && e.message || e)); },
            });
            const closeDec = () => { try { if (dec.state !== 'closed') dec.close(); } catch (e) {} };
            try {
                dec.configure(mp4.config);
                for (const s of plan.samples) {
                    dec.decode(new EncodedVideoChunk({
                        type: s.isSync ? 'key' : 'delta',
                        timestamp: Math.round(s.cts * 1e6),
                        duration: Math.round(s.duration * 1e6),
                        data: gifSampleBytes(blocks, s.offset, s.size),
                    }));
                }
            } catch (e) { closeDec(); reject(e); return; }
            dec.flush().then(
                () => { closeDec(); if (failed) reject(failed); else resolve(); },
                e => { closeDec(); reject(failed || new GifRemoteError('decode', 'Video decode failed: ' + (e && e.message || e))); });
        });
    }
    // ── test marker: gif-remote-mp4 slice end ──
```

- [ ] **Step 4: Run offline + live tests**

Run: `node scripts/test-gif-remote.mjs && node scripts/test-gif-remote.mjs --live`
Expected: `ok - 18 test groups passed` then `ok - 19 test groups passed`.
If the live run fails on `samples[0].cts`, print `mp4.samples.slice(0,3)` and `trak.edts`: if an `elst` entry with `media_time >= 0` exists, the shift code is wrong — fix it; only if the file has NO edit list is the raw first cts correct (players then use raw cts) — in that case change the assertion to `samples[0].cts === <raw first cts>` and note it in the commit message.

- [ ] **Step 5: Wire into both manifests (no commit)**

In the gifmaker module entry (`"id": "gifmaker"`) of BOTH `src/pc/manifest.json` and `docs/manifest.json`, change via Edit (exact JSON, keep formatting):
- `"files"`: `["src/pc/modules/gifmaker/remote-decode.js", "src/pc/modules/gifmaker/index.js"]` (remote-decode first)
- `"connects"`: append `"archive.org"`, `"us.archive.org"`, `"*"` after `"api.imgbb.com"`
- `"requires"`: append `"https://cdn.jsdelivr.net/npm/mp4box@0.5.4/dist/mp4box.all.min.js"` after the gif.js entry

If `docs/manifest.json`'s gifmaker entry has no `"files"` key, apply only connects/requires there.

- [ ] **Step 6: Build and syntax-check**

Run: `node scripts/build-dev-bundle.mjs && node --check cytube.pc.dev.user.js && grep -c "gifOpenRemoteMp4\|@require.*mp4box\|@connect      \*" cytube.pc.dev.user.js`
Expected: build message, no syntax error, count ≥ 3.

- [ ] **Step 7: Commit (remote-decode.js + test only; manifests stay uncommitted)**

```bash
git add src/pc/modules/gifmaker/remote-decode.js scripts/test-gif-remote.mjs
git commit -m "feat(gifmaker): mp4box index read + WebCodecs span decode for the CORS fallback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Capture + preview through the remote path (`index.js`)

**Files:**
- Modify (DO NOT COMMIT — user WIP): `src/pc/modules/gifmaker/index.js` — `captureGifFrames` (~933-1012), `destroyScrubClone` (~1458), `grabPreviewFrame` (~1466)

**Interfaces:**
- Consumes: `gifOpenRemoteMp4`, `gifDecodeSpan`, `gifKeyframeAtOrBefore`, `gifReleaseRemote` (Task 3); existing `computeFrameGeometry`, `drawCaptions`.
- Produces:
  - `drawCaptureFrame(ctx, source, geom, w, h, captions, capProgress, frameIndex) → ImageData`
  - `makeCaptureCanvas(w, h) → {canvas, ctx}`
  - `captureGifFramesRemote(args /* same as captureGifFrames */, onProgress) → Promise<{frames, w, h, delay}>`
  - `grabPreviewFrameRemote(src, time, w) → Promise<string /*jpeg data URL*/>` — `w <= 64` uses the keyframe at/before `time` (fast filmstrip); larger widths decode to the exact frame.
  - Clone load failures now reject with `err.code === 'clone-load'` (capture and preview).

- [ ] **Step 1: Verify location and snapshot the WIP**

Run: `cd /c/Repos/cytube_tv_interface_script && git branch --show-current && cp src/pc/modules/gifmaker/index.js "$TMP/gifmaker-index.before-task4.js"`
Expected: `main`. (The snapshot lets Task 6 isolate our hunks from the user's.)

- [ ] **Step 2: Extract shared frame drawing**

Insert directly above `function captureGifFrames(`:

```js
    function makeCaptureCanvas(w, h) {
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        // Default smoothing is a cheap bilinear pass that aliases badly
        // on big downscales (1080p -> 480px); 'high' is noticeably cleaner.
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        return { canvas, ctx };
    }
    // One output frame: letterbox fill, scaled/cropped source, captions.
    // `source` is a <video> (clone path) or a VideoFrame (remote path).
    function drawCaptureFrame(ctx, source, geom, w, h, captions, capProgress, frameIndex) {
        if (geom.letterbox) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); }
        if (geom.src) ctx.drawImage(source, geom.src[0], geom.src[1], geom.src[2], geom.src[3],
                                            geom.dst[0], geom.dst[1], geom.dst[2], geom.dst[3]);
        else ctx.drawImage(source, geom.dst[0], geom.dst[1], geom.dst[2], geom.dst[3]);
        drawCaptions(ctx, w, h, captions, capProgress, frameIndex);
        return ctx.getImageData(0, 0, w, h);
    }
```

In `captureGifFrames`'s `onFrame`, replace the block from `if (geom.letterbox) {` through `frames.push(ctx.getImageData(0, 0, w, h));` with:

```js
                    const capProgress = Math.min(1, Math.max(0, (t - startT) / span));
                    frames.push(drawCaptureFrame(ctx, vid, geom, w, h, captions, capProgress, frames.length));
```

In its `loadedmetadata` handler, replace the five lines from `canvas = document.createElement('canvas');` through `ctx.imageSmoothingQuality = 'high';` (and the comment between them) with:

```js
                ({ canvas, ctx } = makeCaptureCanvas(w, h));
```

- [ ] **Step 3: Tag clone load failures**

In `captureGifFrames`, change:
```js
                clearTimeout(timer); finish(new Error('clone load error (CORS/network)'));
```
to:
```js
                clearTimeout(timer); finish(Object.assign(new Error('clone load error (CORS/network)'), { code: 'clone-load' }));
```
In `getScrubClone`, change:
```js
            vid.addEventListener('error', () => reject(new Error('preview load error (CORS/network)')), { once: true });
```
to:
```js
            vid.addEventListener('error', () => reject(Object.assign(new Error('preview load error (CORS/network)'), { code: 'clone-load' })), { once: true });
```

- [ ] **Step 4: Add the remote capture function**

Insert directly after the closing `}` of `captureGifFrames`:

```js

    // CORS fallback twin of captureGifFrames: same args, same return shape,
    // frames come from gifDecodeSpan (remote-decode.js) instead of a clone.
    // Progress: first half = download, second half = decode/draw.
    async function captureGifFramesRemote({ src, startT, endT, fps, width, aspect, captions, skip }, onProgress) {
        const mp4 = await gifOpenRemoteMp4(src);
        const frames = [];
        const span = Math.max(0.1, endT - startT);
        const frameInterval = 1 / fps;
        let ctx, w, h, geom, lastCap = -Infinity;
        await gifDecodeSpan(mp4, startT, endT, (frame, t) => {
            if (t + 1e-4 < lastCap + frameInterval) return;
            if (!geom) {
                geom = computeFrameGeometry(frame.displayWidth, frame.displayHeight, width, aspect);
                w = geom.cw; h = geom.ch;
                ({ ctx } = makeCaptureCanvas(w, h));
            }
            lastCap = t;
            const capProgress = Math.min(1, Math.max(0, (t - startT) / span));
            frames.push(drawCaptureFrame(ctx, frame, geom, w, h, captions, capProgress, frames.length));
            if (onProgress) onProgress(Math.min(0.999, 0.5 + 0.5 * capProgress));
        }, { skip, onFetchProgress: p => { if (onProgress) onProgress(0.5 * p); } });
        if (!frames.length) throw new Error('no frames captured');
        return { frames, w, h, delay: Math.round(1000 / fps) };
    }
```

- [ ] **Step 5: Release remote state with the scrub clone, add remote preview**

Change `destroyScrubClone` to:
```js
    function destroyScrubClone() {
        if (_gifScrub) { try { _gifScrub.vid.remove(); } catch (e) {} _gifScrub = null; }
        gifReleaseRemote();
    }
```

Insert directly after the closing `}` of `grabPreviewFrame` (after its `return run;` / `}`):

```js

    // CORS fallback twin of grabPreviewFrame. Serialized like the clone path
    // so filmstrip bursts don't run parallel decoders. Small tiles (<= 64px)
    // show the keyframe at/before `time` — one sample to decode instead of a
    // whole GOP (up to 10 s on some files).
    let _gifRemoteBusy = Promise.resolve();
    function grabPreviewFrameRemote(src, time, w) {
        const run = _gifRemoteBusy.then(async () => {
            const mp4 = await gifOpenRemoteMp4(src);
            let t0 = Math.max(0, time), t1 = t0 + 0.25;
            if (w <= 64) {
                const k = gifKeyframeAtOrBefore(mp4.samples, t0);
                if (k) { t0 = k.cts; t1 = k.cts + 0.001; }
            }
            let url = null;
            await gifDecodeSpan(mp4, t0, t1, frame => {
                if (url) return;
                const h = Math.max(2, Math.round(w * frame.displayHeight / frame.displayWidth));
                const c = document.createElement('canvas');
                c.width = w; c.height = h;
                c.getContext('2d').drawImage(frame, 0, 0, w, h);
                url = c.toDataURL('image/jpeg', 0.72);
            });
            if (!url) throw new Error('no preview frame');
            return url;
        });
        _gifRemoteBusy = run.catch(() => {});
        return run;
    }
```

- [ ] **Step 6: Build + syntax check + existing tests**

Run: `node scripts/build-dev-bundle.mjs && node --check cytube.pc.dev.user.js && node scripts/test-gif-remote.mjs && grep -n "drawCaptureFrame\|captureGifFramesRemote\|grabPreviewFrameRemote\|code: 'clone-load'" src/pc/modules/gifmaker/index.js`
Expected: no syntax errors; `ok - 18 test groups passed`; grep shows the definitions, the two `clone-load` sites, and `drawCaptureFrame` used in both capture functions.

- [ ] **Step 7: Record our diff for Task 6 (no commit)**

Run: `diff -u "$TMP/gifmaker-index.before-task4.js" src/pc/modules/gifmaker/index.js > "$TMP/gifmaker-task4.patch"; wc -l "$TMP/gifmaker-task4.patch"`
Expected: a non-empty patch containing only this task's changes.

---

### Task 5: Panel UI — opt-in setting, blocked message, routing, placeholders, black warning

**Files:**
- Modify (DO NOT COMMIT — user WIP): `src/pc/modules/gifmaker/index.js` — CSS (~329 `.sc-gif-thumb-loading`, ~420 `#sc-gif-status`), `GIF_PREFS_FIELDS` (~617), panel HTML (Size & Quality ~1864-1888), panel state after `setStatus` (~1895), `restoreGifPrefs` (~2171), `refreshThumb` (~2259), `refetchFilmstripTiles` (~2390), Go handler (~2820-2830)

**Interfaces:**
- Consumes: Task 4 (`captureGifFramesRemote`, `grabPreviewFrameRemote`, `code: 'clone-load'`), Task 2 (`gifClassifyLoadFailure → {kind, finalUrl}`), Task 1 (`gifMostlyBlack`).
- Produces (panel-local inside `openGifPanel`): `remoteMode`, `fallbackAllowed()`, `routeAfterCloneFailure(err) → Promise<boolean>`, `showCorsBlocked(host)`, `enableRemote(persist)`, `grabThumb(t, w)`.

- [ ] **Step 1: Snapshot**

Run: `cp src/pc/modules/gifmaker/index.js "$TMP/gifmaker-index.before-task5.js"`

- [ ] **Step 2: CSS**

Immediately after the existing `#sc-gif-status { ... }` rule line, add:

```css
            #sc-gif-cors-msg { display: flex !important; flex-wrap: wrap !important; align-items: center !important; gap: 6px 8px !important; margin: 4px 0 6px !important; padding: 6px 8px !important; border: 1px solid rgba(255,176,32,0.45) !important; border-radius: 6px !important; background: rgba(255,176,32,0.08) !important; color: #f4f4f2 !important; font-size: 12px !important; }
            #sc-gif-cors-msg[hidden] { display: none !important; }
            #sc-gif-cors-msg button { padding: 2px 8px !important; border: 1px solid rgba(255,176,32,0.6) !important; border-radius: 4px !important; background: transparent !important; color: #ffb020 !important; cursor: pointer !important; font-size: 12px !important; }
            #sc-gif-cors-msg button:hover { background: rgba(255,176,32,0.14) !important; color: #f4f4f2 !important; }
            #sc-gif-remote-tag { margin-left: 8px !important; color: #ffb020 !important; font-size: 11px !important; }
            #sc-gif-remote-tag[hidden] { display: none !important; }
            .sc-gif-cors-opt { flex-basis: 100% !important; display: flex !important; align-items: center !important; gap: 6px !important; font-size: 12px !important; }
            .sc-gif-thumb-blocked { background-image: none !important; }
            .sc-gif-thumb-blocked::before { content: 'blocked by host'; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 9px; line-height: 1.1; color: rgba(244,244,242,0.55); }
```

Then check the thumb/tile elements are positioned: run `grep -n "sc-gif-filmstrip-tile {\|sc-gif-thumb {\|#sc-gif-thumb-start\|position: relative" src/pc/modules/gifmaker/index.js | head`. If neither `.sc-gif-filmstrip-tile` nor the start/end thumb rules contain `position: relative`, add `.sc-gif-thumb-blocked { position: relative !important; }` to the block above.

- [ ] **Step 3: Persisted pref**

Change:
```js
    const GIF_PREFS_FIELDS = ['color', 'font', 'topSize', 'bottomSize', 'fps', 'width', 'aspect', 'lossy'];
```
to:
```js
    const GIF_PREFS_FIELDS = ['color', 'font', 'topSize', 'bottomSize', 'fps', 'width', 'aspect', 'lossy', 'corsFallback'];
```

- [ ] **Step 4: Panel HTML**

Inside `<div class="sc-gif-sq" id="sc-gif-sq-body">`, after the closing `</label>` of the `Shape` select, add:
```html
                            <label class="sc-gif-cors-opt"><input type="checkbox" id="sc-gif-cors-fallback"> Fetch CORS-blocked videos via Tampermonkey (partial download, memory only)</label>
```
Replace:
```html
                <div id="sc-gif-status"></div>
                <button id="sc-gif-go" type="button">● Make GIF</button>
```
with:
```html
                <div id="sc-gif-status"></div>
                <div id="sc-gif-cors-msg" hidden>
                    <span id="sc-gif-cors-text"></span>
                    <button type="button" id="sc-gif-cors-try">Try via Tampermonkey</button>
                    <button type="button" id="sc-gif-cors-always">Always</button>
                </div>
                <button id="sc-gif-go" type="button">● Make GIF</button><span id="sc-gif-remote-tag" hidden>via Tampermonkey</span>
```

- [ ] **Step 5: Panel state + routing helpers**

Directly after `const setStatus = (txt) => { status.textContent = txt || ''; };` add:

```js

        /* --- CORS fallback routing (remote-decode.js) --- */
        let remoteMode = false;            // capture/previews go through GM + WebCodecs
        let allowRemoteThisPanel = false;  // [Try via Tampermonkey] for this panel session
        let pendingGo = false;             // Make GIF was blocked; re-run once allowed
        const corsChk = $('#sc-gif-cors-fallback');
        const corsMsg = $('#sc-gif-cors-msg');
        const fallbackAllowed = () => allowRemoteThisPanel || readGifPrefs().corsFallback === true;
        const showRemoteTag = () => { $('#sc-gif-remote-tag').hidden = false; };
        function showCorsBlocked(host) {
            $('#sc-gif-cors-text').textContent = "This video's host (" + host + ") doesn't allow frame capture.";
            corsMsg.hidden = false;
        }
        // Clone failed: classify, then either switch to the remote path (true),
        // show the blocked message (false), or throw a clear non-CORS error.
        async function routeAfterCloneFailure(err) {
            if (!err || err.code !== 'clone-load') throw err;
            const cls = await gifClassifyLoadFailure(src);
            if (cls.kind === 'unsupported-src') throw new Error("This video source can't be captured");
            if (cls.kind !== 'cors') throw new Error("Couldn't load the video (network or format error)");
            if (fallbackAllowed()) { remoteMode = true; showRemoteTag(); return true; }
            let host = '';
            try { host = new URL(cls.finalUrl || src).hostname; } catch (e) { host = 'this site'; }
            showCorsBlocked(host);
            return false;
        }
        function enableRemote(persist) {
            if (persist) { writeGifPrefs({ corsFallback: true }); corsChk.checked = true; }
            allowRemoteThisPanel = true;
            remoteMode = true;
            corsMsg.hidden = true;
            showRemoteTag();
            _tilesWindowKey = null;
            refetchFilmstripTiles();
            refreshThumb('start');
            refreshThumb('end');
            if (pendingGo) { pendingGo = false; goBtn.click(); }
        }
        $('#sc-gif-cors-try').addEventListener('click', () => enableRemote(false));
        $('#sc-gif-cors-always').addEventListener('click', () => enableRemote(true));
        corsChk.addEventListener('change', () => {
            writeGifPrefs({ corsFallback: corsChk.checked });
            if (corsChk.checked && !corsMsg.hidden) enableRemote(false);
        });
        const grabThumb = (t, w) => {
            if (remoteMode) return grabPreviewFrameRemote(src, t, w);
            return grabPreviewFrame(src, t, w).catch(async err => {
                if (await routeAfterCloneFailure(err)) return grabPreviewFrameRemote(src, t, w);
                throw Object.assign(new Error('blocked by host'), { code: 'cors-blocked' });
            });
        };
```

`refreshThumb`, `refetchFilmstripTiles`, `_tilesWindowKey` are declared later in the same function with `const`/`let`/`function`; `enableRemote` only runs on a click/change, after they're initialized, so the forward references are safe. If `refreshThumb` is a `const` arrow declared later, that is still fine at click time.

In `restoreGifPrefs` (first lines after `const p = readGifPrefs();`), add:
```js
            corsChk.checked = p.corsFallback === true;
```

- [ ] **Step 6: Thumbnails use `grabThumb` and show the placeholder**

In `refreshThumb`, replace:
```js
                grabPreviewFrame(src, t, 160).then(url => {
                    el.style.backgroundImage = `url("${url}")`;
                    el.classList.remove('sc-gif-thumb-loading');
                }).catch(() => el.classList.remove('sc-gif-thumb-loading'));
```
with:
```js
                grabThumb(t, 160).then(url => {
                    el.style.backgroundImage = `url("${url}")`;
                    el.classList.remove('sc-gif-thumb-loading', 'sc-gif-thumb-blocked');
                }).catch(err => {
                    el.classList.remove('sc-gif-thumb-loading');
                    el.classList.toggle('sc-gif-thumb-blocked', !!(err && err.code === 'cors-blocked'));
                });
```
In `refetchFilmstripTiles`, replace:
```js
                grabPreviewFrame(src, t, 64).then(url => {
                    tile.style.backgroundImage = `url("${url}")`;
                    tile.classList.remove('sc-gif-thumb-loading');
                }).catch(() => tile.classList.remove('sc-gif-thumb-loading'));
```
with:
```js
                grabThumb(t, 64).then(url => {
                    tile.style.backgroundImage = `url("${url}")`;
                    tile.classList.remove('sc-gif-thumb-loading', 'sc-gif-thumb-blocked');
                }).catch(err => {
                    tile.classList.remove('sc-gif-thumb-loading');
                    tile.classList.toggle('sc-gif-thumb-blocked', !!(err && err.code === 'cors-blocked'));
                });
```

- [ ] **Step 7: Go handler routing + black warning**

Replace:
```js
                const cap = await captureGifFrames(
                    { src, startT, endT, fps, width, aspect, captions, skip: cutSpan },
                    p => setWork('Capturing frames… ' + Math.round(p * 100) + '%'));
```
with:
```js
                const capArgs = { src, startT, endT, fps, width, aspect, captions, skip: cutSpan };
                const remoteProgress = p => setWork('Downloading + decoding via Tampermonkey… ' + Math.round(p * 100) + '%');
                let cap;
                if (remoteMode) {
                    cap = await captureGifFramesRemote(capArgs, remoteProgress);
                } else {
                    try {
                        cap = await captureGifFrames(capArgs, p => setWork('Capturing frames… ' + Math.round(p * 100) + '%'));
                    } catch (err) {
                        if (!(await routeAfterCloneFailure(err))) { pendingGo = true; result.innerHTML = ''; return; }
                        cap = await captureGifFramesRemote(capArgs, remoteProgress);
                    }
                }
                const blackWarn = gifMostlyBlack(cap.frames);
```
Then, directly after the line `result.innerHTML =` … statement that renders the `<img src="${_gifResultUrl}" …>` block completes (the statement ends with `;`), add:
```js
                if (blackWarn) setStatus("Most frames came out black. If the scene isn't actually dark, this browser couldn't read the video's pixels — try restarting the browser or using Chrome/Edge.");
```
(The `return` inside `try` still runs the existing `finally { goBtn.disabled = false; }`.)

- [ ] **Step 8: Build + checks**

Run: `node scripts/build-dev-bundle.mjs && node --check cytube.pc.dev.user.js && node scripts/test-gif-remote.mjs && grep -n "grabPreviewFrame(src" src/pc/modules/gifmaker/index.js`
Expected: no syntax errors; tests pass; the final grep returns only the line inside `grabThumb` (no other direct callers left).

- [ ] **Step 9: Record our diff (no commit)**

Run: `diff -u "$TMP/gifmaker-index.before-task5.js" src/pc/modules/gifmaker/index.js > "$TMP/gifmaker-task5.patch"; wc -l "$TMP/gifmaker-task5.patch"`

---

### Task 6: Version bump, full test run, live verification, WIP-safe commit

**Files:**
- Modify: `src/pc/manifest.json`, `docs/manifest.json` (`baseVersion`)
- Commit: our hunks only of `src/pc/modules/gifmaker/index.js`, `src/pc/manifest.json`, `docs/manifest.json`

- [ ] **Step 1: Bump + build + all tests**

```bash
cd /c/Repos/cytube_tv_interface_script
sed -i 's/"baseVersion": "4.13.58"/"baseVersion": "4.13.59"/' src/pc/manifest.json docs/manifest.json
grep -n '"baseVersion"' src/pc/manifest.json docs/manifest.json
node scripts/build-dev-bundle.mjs && node --check cytube.pc.dev.user.js
for t in scripts/test-*.mjs; do node "$t" || echo "FAILED: $t"; done
node scripts/test-gif-remote.mjs --live
```
Expected: both manifests show `4.13.59`; no `FAILED:` lines; live test passes. If `docs/manifest.json` wasn't at 4.13.58, set it to 4.13.59 by hand.

- [ ] **Step 2: Live test with the user (blocking — wait for their report)**

Tell the user to reload `cytube.pc.dev.user.js` in Tampermonkey (version **4.13.59**; accept the new `@connect`/`@require` prompts) and check:
1. Frankenstein (or any archive.org movie whose storage node lacks CORS), setting **off**: open GIF panel → filmstrip tiles say "blocked by host" and the amber message names the `ia…us.archive.org` host.
2. Click **Try via Tampermonkey** → thumbnails fill in, "via Tampermonkey" tag shows; Make GIF → correct, non-black GIF that matches the selected time range.
3. Close + reopen panel → message returns (session-only). Click **Always** → checkbox in Size & Quality is now ticked and persists after reload.
4. A movie from a CORS-friendly host → no message, no tag, GIF as before.
5. Repeat 2 in the other browser (Firefox and Chrome/Edge).

Fix any reported issue in the owning task's code, bump to the next patch version, rebuild, and re-test before continuing.

- [ ] **Step 3: WIP-safe staging of our hunks**

For each of `src/pc/modules/gifmaker/index.js`, `src/pc/manifest.json`, `docs/manifest.json`: build the blob = `HEAD` version + only our changes, without touching the worktree.

```bash
cd /c/Repos/cytube_tv_interface_script
f=src/pc/modules/gifmaker/index.js
git show HEAD:$f > "$TMP/base.js"
# apply ONLY our recorded patches onto HEAD's version (they were made on top of the user's WIP;
# use fuzz and check every hunk applied)
patch --no-backup-if-mismatch -F3 "$TMP/base.js" < "$TMP/gifmaker-task4.patch"
patch --no-backup-if-mismatch -F3 "$TMP/base.js" < "$TMP/gifmaker-task5.patch"
sha=$(git hash-object -w --no-filters "$TMP/base.js")
git update-index --cacheinfo 100644,$sha,$f
git diff --cached -U0 -- $f | grep '^@@'
```
Expected: every hunk applies (no `FAILED`/`.rej`); `git diff --cached` for the file contains only our functions/CSS/HTML (inspect it fully). If a hunk fails because it overlaps user WIP, STOP and ask the user whether to include their overlapping WIP in this commit.

For the manifests, write the HEAD version plus our edits (gifmaker `files`/`connects`/`requires`, `baseVersion` 4.13.59) with a small node script reading `git show HEAD:<path>` and applying those three key changes + version, then `hash-object -w --no-filters` / `update-index --cacheinfo` the same way. Line endings: repo blobs are LF; strip `\r` before hashing (`sed -i 's/\r$//'` on the temp file).

Verify: `git diff --cached --stat` lists only `docs/manifest.json`, `src/pc/manifest.json`, `src/pc/modules/gifmaker/index.js`; `git diff --cached` shows none of the user's WIP lines (e.g. the simkl feature string change in the manifest must NOT be staged); `git diff` (unstaged) still shows the user's WIP intact.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(gifmaker): detect CORS-blocked videos, opt-in Tampermonkey range-fetch + WebCodecs fallback; 4.13.59

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git status --short
```
Expected: commit succeeds; the user's original WIP files are still listed as modified.
Do NOT push — ask the user.
