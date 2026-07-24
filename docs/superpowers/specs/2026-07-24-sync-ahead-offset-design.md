# Sync ~0.5s ahead of the group during movies

Date: 2026-07-24

## Goal

Let the local player run about 0.5 seconds ahead of the group's CyTube-synced position, but only while a movie (not a bumper/trailer/short) is playing. Toggleable in the existing ⚙ settings modal, default ON.

## Background: how CyTube sync works today

CyTube's own page JS (not this script) listens for a `mediaUpdate` socket event and uses it to keep the local player's position matched to the server's authoritative position — smoothing/correcting drift on its own schedule. This script never reimplements that logic; the existing desync ("Free watch", `⟳`) feature at `cytube.pc.user.js:575-651` only knows how to *locate and temporarily remove* CyTube's `mediaUpdate` listeners via `_getMediaUpdateListeners()` (handles both Socket.IO v2/v3 `_callbacks['$mediaUpdate']` and v4 `_events.mediaUpdate` storage), then restore them on resync.

## 1. Mechanism: intercept, don't fight

Rather than periodically nudging `video.currentTime` ourselves (which would fight CyTube's own correction loop), a small interceptor is prepended to the same listener array `_freezeSync`/`_thawSync` already locate. On each `mediaUpdate` event, before CyTube's own handler(s) run, the interceptor conditionally adds `SYNC_OFFSET_SEC` (0.5) to the payload's time field. CyTube then applies its normal smoothing/correction logic against that adjusted value — so the player naturally settles 0.5s ahead, using CyTube's own seek/smoothing behavior rather than ours.

```js
const SYNC_OFFSET_SEC = 0.5;

function installSyncOffsetInterceptor() {
    const loc = _getMediaUpdateListeners();
    if (!loc) { console.warn('[CyTube SC] Could not find mediaUpdate listeners to install sync offset'); return; }
    const original = loc.store === '_callbacks' ? socket._callbacks[loc.key] : socket._events[loc.key];
    const originalList = Array.isArray(original) ? original : [original];

    function interceptor(data) {
        if (isSyncOffsetEnabled() && _lineupCurrentMatchedFlatIndex !== -1 && typeof data?.currentTime === 'number') {
            data.currentTime += SYNC_OFFSET_SEC;
        }
        for (const fn of originalList) fn(data);
    }

    if (loc.store === '_callbacks') socket._callbacks[loc.key] = [interceptor];
    else socket._events[loc.key] = interceptor;
}
```

Called once at startup, after the socket is available (same point where the desync button/feature is wired up).

**Composes with desync for free:** `_freezeSync` saves-and-clears whatever is currently registered under the `mediaUpdate` key — which, after `installSyncOffsetInterceptor()` has run, is the interceptor (wrapping the real CyTube handlers). `_thawSync` restores exactly that. No changes needed to `_freezeSync`/`_thawSync`. While desynced, no `mediaUpdate` events reach anyone (interceptor included), so the offset simply has nothing to act on until resync — matching today's behavior.

**Payload field risk:** CyTube's `mediaUpdate` payload is expected to carry the position as `data.currentTime` (per CyTube's known socket protocol), but this hasn't been confirmed against a live payload from this specific server. Before wiring the mutation, log one real `mediaUpdate` payload (temporary `console.log` in a throwaway listener, removed after) to confirm the field name. The interceptor's `typeof data?.currentTime === 'number'` guard means a wrong/missing field name degrades to a silent no-op (offset never applies) rather than corrupting sync — never worth the risk of guessing wrong and breaking playback for everyone.

## 2. Movie vs. bumper detection

Reuses the existing `_lineupCurrentMatchedFlatIndex` (`cytube.pc.user.js:3115`), already maintained by the Tonight's Lineup feature as the authoritative "what's airing right now" signal, matched against the scheduled lineup. `!== -1` means the current title matched a scheduled feature (a movie); `-1` means unmatched (bumper, trailer, or anything not on the schedule).

This is a lagging/best-effort signal — it can take a few seconds to resolve after a title change, and returns `-1` for the entire session if TMDB/lineup matching isn't configured. Accepted trade-off (per design discussion): reusing this existing signal avoids adding a second, redundant classification mechanism. In the worst case (unmatched), the offset simply doesn't apply and playback behaves exactly as it does today.

## 3. Settings toggle

New checkbox in the ⚙ settings modal (`openSettingsModal`, `cytube.pc.user.js:~2500-2603`), alongside the existing movie-links/lineup-timing toggles:

- Label: "Sync ~0.5s ahead during movies"
- Storage key: `LS_SYNC_OFFSET = 'sc_sync_offset'`, values `'on'`/`'off'` via the existing `getKey`/`setKey` helpers, default `'on'`
- `isSyncOffsetEnabled()` reads this key, mirroring how other toggles (e.g. `LS_LINEUP_TIMING`) are read elsewhere in the script

No change to the offset magnitude (0.5s) via UI — only on/off, matching the approved design.

## Edge cases

- **Movie → bumper transition**: on the next `mediaUpdate` after `_lineupCurrentMatchedFlatIndex` flips to `-1`, the interceptor stops adding the offset; CyTube's own correction pulls the (now slightly-ahead) player back to the true bumper position over its normal smoothing — no special handling needed.
- **Bumper → movie transition**: same in reverse; CyTube seeks/smooths forward to the new (offset-adjusted) target using its own logic.
- **User manually desynced**: offset is inert (no `mediaUpdate` reaching the interceptor) until resync, exactly like CyTube's own sync is inert while desynced today.
- **Socket reconnect / listener re-registration**: if CyTube re-registers its `mediaUpdate` listener after a reconnect (replacing the interceptor), the offset would silently stop applying until the next page load re-runs `installSyncOffsetInterceptor()`. Acceptable — matches the existing script's general assumption of one listener registration per page load, same as `_freezeSync`/`_thawSync`.

## Testing

Manual, in a live cytu.be room (no automated test suite exists for this userscript):
1. During a scheduled movie, confirm the player settles ~0.5s ahead of other viewers' reported position (compare against a second client/tab desynced with the toggle off, or against chat timing).
2. During a bumper/trailer between features, confirm no offset is applied (matches other viewers within normal sync tolerance).
3. Toggle off in settings, confirm playback matches group position exactly (no offset) during a movie.
4. Enter/exit desync (Free watch) during a movie with the offset ON, confirm resync re-establishes the 0.5s-ahead position afterward.
5. Confirm console shows no errors if `_getMediaUpdateListeners()` fails to locate the listeners (e.g. a future CyTube update changes socket.io internals) — should warn and leave sync fully unmodified.
