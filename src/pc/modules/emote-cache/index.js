    /* ==========================================================
       EMOTE CACHE -- a Cache Storage-backed image cache for every
       channel emote, not just favorites. Without this, emote
       images only ever ride the browser's ordinary HTTP cache: a
       single shared LRU across everything the page loads (every
       gif/image anyone posts in chat competes for the same slots),
       so a channel with a few hundred MB of emotes gets them
       evicted and re-downloaded constantly -- showing up as CDN
       rate-limiting and slower and slower loads scrolling the
       emote picker or viewing emotes in chat. Storing bytes here
       instead means an emote is only ever evicted by us (see
       pruneEmoteCache() below) or by the browser's own storage
       eviction under genuine disk-space pressure, far rarer than
       ordinary HTTP cache churn.

       Freshness: rather than a timer, this hooks the channel's own
       live 'emoteList'/'updateEmote'/'removeEmote' socket events
       (the same events emote-picker listens for) so a newly-added
       or edited emote gets primed the instant the channel
       announces it, and a removed/renamed one gets evicted so the
       cache never just grows forever. Also primes on-demand
       whenever the emote-picker panel opens (see that module's
       openEmotesPanel()/refreshEmoteData(), Task 2) as a
       self-healing safety net -- catches anything a missed/late
       socket event or browser storage eviction left uncached,
       without waiting for another channel-side change.

       Deliberately independent of the emote-picker module: chat
       renders channel emotes via CyTube's own code regardless of
       whether the custom picker panel is even included in a given
       build (see README's "Emote Picker is an optional module"),
       so this module reads CHANNEL.emotes / #emotelist itself
       rather than depending on emote-picker's copy of that same
       logic -- small, self-contained duplication, matching this
       codebase's existing per-module convention of copying rather
       than sharing tiny logic like this.

       Cross-origin emote CDNs without CORS headers make fetch()
       below throw -- caught and swallowed like every other
       best-effort path here; that particular emote just falls back
       to the plain live-URL/browser-cache behavior, exactly as if
       this module didn't exist for it.

       _uw is core's shared unsafeWindow/window fallback (see
       03-gif-bridge.js) -- this module doesn't redeclare it.
       getKey/setKey are core's (02-keys-and-helpers.js).
    ========================================================== */
    const EMOTE_IMAGE_CACHE = 'sc-emote-image-cache-v1';

    function openEmoteCache() {
        if (!('caches' in window)) return Promise.resolve(null);
        return caches.open(EMOTE_IMAGE_CACHE).catch(() => null);
    }

    // name -> object URL, resolved lazily as each emote's bytes come back
    // from cache or network. Read synchronously by any renderer (picker
    // tiles, chat images) via getEmoteBlobUrl() -- nothing ever blocks on
    // a cache lookup.
    const _scEmoteBlobUrls = new Map();

    function getEmoteBlobUrl(name) {
        return _scEmoteBlobUrls.get(name) || null;
    }

    // Swaps the now-resolved cached src into every currently-rendered copy
    // of this emote -- both the emote-picker panel's tiles (if that module
    // is included in this build) and every matching <img class="channel-
    // emote"> already sitting in the chat backlog. First paint of either
    // surface always uses the live URL; this only ever patches in place
    // afterward, so nothing ever blocks on a cache lookup.
    function patchEmoteImageNodes(name, src) {
        document.querySelectorAll('#sc-emotes-panel .sc-emotes-tile').forEach(tile => {
            if (tile.dataset.emoteName !== name) return;
            const img = tile.querySelector('img');
            if (img && img.src !== src) img.src = src;
        });
        const buf = document.getElementById('messagebuffer');
        if (buf) {
            buf.querySelectorAll('img.channel-emote').forEach(img => {
                if (img.title === name && img.src !== src) img.src = src;
            });
        }
    }

    function setEmoteBlobUrl(name, blob) {
        const objUrl = URL.createObjectURL(blob);
        const prev = _scEmoteBlobUrls.get(name);
        _scEmoteBlobUrls.set(name, objUrl);
        if (prev) URL.revokeObjectURL(prev);
        patchEmoteImageNodes(name, objUrl);
    }

    function evictEmoteBlobUrl(name) {
        const prev = _scEmoteBlobUrls.get(name);
        if (prev) { URL.revokeObjectURL(prev); _scEmoteBlobUrls.delete(name); }
    }

    // Fetches+persists one emote's bytes. Best-effort: a CORS-less CDN
    // throws here and is silently skipped (see block comment above).
    async function cacheEmoteImage(cache, name, url) {
        try {
            const res = await fetch(url);
            if (!res.ok) { _scEmoteCacheFailed.add(name); return; }
            await cache.put(url, res.clone());
            setEmoteBlobUrl(name, await res.blob());
        } catch (e) { _scEmoteCacheFailed.add(name); }
    }

    /* ==========================================================
       PRIMING -- checks Cache Storage (no network) before ever
       fetching, and limits how many emotes fetch at once so warming
       a cold cache of a few hundred MB doesn't itself hammer the
       CDN the way this feature exists to prevent. _scEmotePriming
       tracks in-flight names so a socket-event prime and a
       panel-open prime running back-to-back never double-fetch the
       same emote.
    ========================================================== */
    const EMOTE_PRIME_CONCURRENCY = 4;
    const _scEmotePriming = new Set();
    // Names that have already failed to fetch/cache this session (bad
    // HTTP status, CORS throw, cache.put quota error, etc.) -- checked
    // (never populated except on actual failure) by primeEmoteCache()'s
    // filter below so a permanently-failing emote isn't re-fetched in
    // full on every panel open / socket event, which is exactly the CDN
    // hammering this whole feature exists to prevent. Deliberately never
    // expires/retries within a session -- only a page reload clears it.
    const _scEmoteCacheFailed = new Set();

    async function runWithConcurrency(items, limit, worker) {
        let i = 0;
        async function next() {
            while (i < items.length) {
                const item = items[i++];
                await worker(item);
            }
        }
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
    }

    async function primeEmoteCache(emotes) {
        if (!emotes || !emotes.length) return;
        const cache = await openEmoteCache();
        if (!cache) return;
        const todo = emotes.filter(e => e && e.name && e.image && !_scEmoteBlobUrls.has(e.name) && !_scEmotePriming.has(e.name) && !_scEmoteCacheFailed.has(e.name));
        if (!todo.length) return;
        todo.forEach(e => _scEmotePriming.add(e.name));
        try {
            await runWithConcurrency(todo, EMOTE_PRIME_CONCURRENCY, async (e) => {
                try {
                    const hit = await cache.match(e.image);
                    if (hit) { setEmoteBlobUrl(e.name, await hit.blob()); return; }
                    await cacheEmoteImage(cache, e.name, e.image);
                } catch (err) {}
            });
        } finally {
            todo.forEach(e => _scEmotePriming.delete(e.name));
        }
    }

    /* ==========================================================
       PRUNING -- LS_EMOTE_CACHE_MANIFEST (core's
       02-keys-and-helpers.js) persists the last-seen {name: image}
       map across page loads. A name that disappeared, or whose
       image URL changed (an admin swapped an emote's picture under
       the same name), gets its old cache entry evicted here --
       otherwise the old bytes would sit in Cache Storage forever
       with nothing to ever clean them up as emotes get swapped
       over time.
    ========================================================== */
    function loadKnownEmoteManifest() {
        try {
            const raw = JSON.parse(getKey(LS_EMOTE_CACHE_MANIFEST) || '{}');
            if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
        } catch (e) {}
        return {};
    }
    function saveKnownEmoteManifest(map) {
        try { setKey(LS_EMOTE_CACHE_MANIFEST, JSON.stringify(map)); } catch (e) {}
    }

    async function pruneEmoteCache(emotes) {
        const known = loadKnownEmoteManifest();
        const current = {};
        (emotes || []).forEach(e => { if (e && e.name && e.image) current[e.name] = e.image; });

        const cache = await openEmoteCache();
        for (const [name, oldUrl] of Object.entries(known)) {
            if (current[name] === oldUrl) continue; // unchanged, nothing to evict
            evictEmoteBlobUrl(name);
            if (cache && oldUrl) { try { await cache.delete(oldUrl); } catch (e) {} }
        }
        saveKnownEmoteManifest(current);
    }

    async function refreshEmoteCache(emotes) {
        await pruneEmoteCache(emotes);
        await primeEmoteCache(emotes);
    }

    /* ==========================================================
       EMOTE DATA -- a small, self-contained copy of emote-picker's
       readChannelEmotes()/readEmotesFromDom() (see that module's
       own EMOTE DATA comment for the full CHANNEL.emotes/#emotelist
       rationale). No force-render dance here -- this module is a
       background service, not something the user is actively
       looking at, so it simply takes whatever's available and
       tries again later (boot poll below, or the next socket
       event) rather than ever flashing CyTube's native popup.
    ========================================================== */
    function computeEmoteListForCache() {
        try {
            const arr = _uw.CHANNEL && _uw.CHANNEL.emotes;
            if (Array.isArray(arr)) {
                const out = [];
                for (const e of arr) {
                    if (e && typeof e.name === 'string' && e.name && typeof e.image === 'string' && e.image) {
                        out.push({ name: e.name, image: e.image });
                    }
                }
                return out;
            }
        } catch (e) {}
        const out = [];
        document.querySelectorAll('#emotelist img.channel-emote').forEach(img => {
            if (img.title && img.src) out.push({ name: img.title, image: img.src });
        });
        return out;
    }

    /* ==========================================================
       LIVE UPDATES -- same socket-poll pattern as emote-picker's
       bindEmoteSocketEvents() (socket may not exist yet this early
       at document-start, so poll for it instead of assuming it's
       ready). Registered after CyTube's own handlers for these
       events, so CHANNEL.emotes already reflects the change by the
       time this fires.
    ========================================================== */
    function bindEmoteCacheSocketEvents() {
        let bound = false;
        const tryBind = () => {
            if (bound || typeof socket === 'undefined' || !socket || !socket.on) return;
            bound = true;
            const onEmoteUpdate = () => refreshEmoteCache(computeEmoteListForCache());
            socket.on('emoteList', onEmoteUpdate);
            socket.on('updateEmote', onEmoteUpdate);
            socket.on('removeEmote', onEmoteUpdate);
        };
        tryBind();
        window.addEventListener('load', () => { tryBind(); setTimeout(tryBind, 2000); });
        const poll = setInterval(() => { tryBind(); if (bound) clearInterval(poll); }, 250);
        setTimeout(() => clearInterval(poll), 10000);
    }
    bindEmoteCacheSocketEvents();

    /* ==========================================================
       BOOT PRIME -- warms the cache once on page load without
       waiting for a socket event (covers an already-open
       reconnect, or any timing where CHANNEL.emotes populates
       before this module's socket handlers bind). Gives up after
       ~20 tries so a channel that genuinely has zero emotes doesn't
       poll forever -- live socket events still catch any later
       real change.
    ========================================================== */
    let _scEmoteCacheBootTries = 0;
    function emoteCacheBoot() {
        const list = computeEmoteListForCache();
        if (list.length) { refreshEmoteCache(list); return; }
        if (++_scEmoteCacheBootTries > 20) return;
        setTimeout(emoteCacheBoot, 1000);
    }
    setTimeout(emoteCacheBoot, 500);

    /* ==========================================================
       CHAT OBSERVER -- patches already-resolved cached emotes into
       chat's <img class="channel-emote"> nodes as they appear
       (backlog on load, and every new message after), independent
       of whether primeEmoteCache() finishes before or after a given
       message renders. Boots at module top-level (not via
       scRegisterInit, which only drains on 'load') so it's watching
       before the message backlog finishes painting, matching the
       timing rationale on emote-picker's own #messagebuffer
       observer (initEmoteBans()).
    ========================================================== */
    function applyCachedSrcToChatEmotes(root) {
        if (!root || root.nodeType !== 1) return;
        const imgs = [...root.querySelectorAll('img.channel-emote')];
        if (root.matches && root.matches('img.channel-emote')) imgs.push(root);
        imgs.forEach(img => {
            const cached = _scEmoteBlobUrls.get(img.title);
            if (cached && img.src !== cached) img.src = cached;
        });
    }

    function startEmoteCacheChatObserver() {
        const start = () => {
            const buf = document.getElementById('messagebuffer');
            if (!buf) { requestAnimationFrame(start); return; }
            new MutationObserver((mutations) => {
                mutations.forEach(m => m.addedNodes.forEach(node => applyCachedSrcToChatEmotes(node)));
            }).observe(buf, { childList: true, subtree: true });
            applyCachedSrcToChatEmotes(buf);
        };
        start();
    }
    startEmoteCacheChatObserver();
