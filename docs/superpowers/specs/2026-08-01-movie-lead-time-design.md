# Configurable lead time ahead of sync during movies

Date: 2026-08-01

## Goal

Let the local player run a user-configurable number of seconds ahead of the group's CyTube-synced position, but only during movies (not YouTube). Purpose: cushion against the user's own buffering/lag — if they briefly stall, the next sync correction pushes them back up to "group position + lead" instead of merely "group position."

Supersedes the never-implemented `2026-07-24-sync-ahead-offset-design.md` (fixed 0.5s, on/off toggle, gated on Tonight's Lineup movie-match). This design keeps that spec's interceptor mechanism (still valid, nothing in the codebase since has invalidated it — confirmed via grep, none of `SYNC_OFFSET_SEC`/`installSyncOffsetInterceptor`/`isSyncOffsetEnabled` exist yet) but changes two things per this session's discussion:

1. **Configurable magnitude** (0–10s, default 2s) instead of a fixed 0.5s toggle.
2. **Simpler gating**: `!isYouTubeMedia()` instead of the lineup-match signal. Chosen over the stricter bumper/trailer-excluding version because it has no dependency on TMDB/lineup matching being configured or successfully resolving — it always works. Bumpers/trailers between movies will also get the lead offset under this design; accepted trade-off.

## 1. Mechanism: intercept, don't fight

Unchanged from the prior spec's validated approach. CyTube's own page JS listens for a `mediaUpdate` socket event and uses it to correct the local player's position to the server's authoritative position. This script never reimplements that correction logic — instead, a small interceptor is prepended to the same listener array that `_freezeSync`/`_thawSync` (the existing "Free watch" desync feature, `cytube.pc.user.js:613-699`) already know how to locate via `_getMediaUpdateListeners()` (handles both Socket.IO v2/v3 `_callbacks['$mediaUpdate']` and v4 `_events.mediaUpdate` storage).

On each `mediaUpdate` event, before CyTube's own handler(s) run, the interceptor conditionally adds the configured lead (seconds) to the payload's `currentTime` field. CyTube then applies its own normal smoothing/correction logic against that adjusted value, so the player naturally settles the configured amount ahead using CyTube's own seek/smoothing behavior rather than a second, competing correction loop.

```js
const LS_MOVIE_LEAD = 'sc_movie_lead_sec';
const MOVIE_LEAD_MIN = 0, MOVIE_LEAD_MAX = 10, MOVIE_LEAD_DEFAULT = 2;

function getMovieLeadSec() {
    const v = parseInt(getKey(LS_MOVIE_LEAD), 10);
    return (Number.isFinite(v) && v >= MOVIE_LEAD_MIN && v <= MOVIE_LEAD_MAX) ? v : MOVIE_LEAD_DEFAULT;
}

function installMovieLeadInterceptor() {
    const loc = _getMediaUpdateListeners();
    if (!loc) return false; // caller retries later — CyTube's own listener may not exist yet
    const original = loc.store === '_callbacks' ? socket._callbacks[loc.key] : socket._events[loc.key];
    const originalList = Array.isArray(original) ? original : (original ? [original] : []);

    function interceptor(data) {
        try {
            const lead = getMovieLeadSec();
            if (lead > 0 && !isYouTubeMedia() && typeof data?.currentTime === 'number') {
                data.currentTime += lead;
            }
        } catch (e) {}
        for (const fn of originalList) fn(data);
    }

    if (loc.store === '_callbacks') socket._callbacks[loc.key] = [interceptor];
    else socket._events[loc.key] = interceptor;
    return true;
}
```

Installed once at startup: poll for `socket` + existing `mediaUpdate` listeners the same way `watchMovieTitle()` polls for the header element (interval retry, ~14 tries / 1500ms, then give up) — this guarantees CyTube's own listener is already registered by the time we wrap it, rather than racing its init.

**Composes with desync for free:** `_freezeSync` saves-and-clears whatever is currently registered under the `mediaUpdate` key — which, after `installMovieLeadInterceptor()` has run, is the interceptor (wrapping the real CyTube handler(s)). `_thawSync` restores exactly that, no changes needed to either function. While desynced, no `mediaUpdate` events reach anyone (interceptor included), so the lead offset has nothing to act on until resync — matching today's desync behavior exactly.

**Payload field risk (carried over from the prior spec, still unverified):** CyTube's `mediaUpdate` payload is expected to carry the position as `data.currentTime`, but this hasn't been confirmed against a live payload from this specific server. The `typeof data?.currentTime === 'number'` guard means a wrong/missing field name degrades to a silent no-op (lead never applies) rather than corrupting sync for anyone. Verify against a live payload during manual testing (temporary `console.log` in the interceptor, removed before shipping) before trusting the feature works.

## 2. Settings: plain number input, 0 = off

New row in the ⚙ settings modal (`openSettingsModal`, `cytube.pc.user.js:~1804-2001`), styled like the existing "Chat font size" row (label + bare input, no checkbox):

```html
<div class="sc-settings-group sc-settings-toggle-group">
    <label class="sc-settings-label">
        Movie lead time: <span id="sc-lead-val">${leadSec}s</span> ahead of sync
        <span class="sc-settings-note">Keeps you a few seconds ahead of the group during movies (not YouTube) — cushions against your own buffering. 0 = off.</span>
    </label>
    <input id="sc-input-leadsec" class="sc-settings-input" type="number" min="0" max="10" step="1" value="${leadSec}" style="width:5em" />
</div>
```

On save: `const leadSec = clamp(parseInt(input.value, 10), 0, 10); setKey(LS_MOVIE_LEAD, String(leadSec));` — clamp defensively even though the `<input min max>` constrains normal UI entry, since a `type="number"` field can still be typed out of range in most browsers before blur.

No separate enable/disable checkbox — typing `0` disables it, matching how the user asked to configure this ("just let me type the number in").

## Edge cases

- **Movie → YouTube transition**: on the next `mediaUpdate` after `isYouTubeMedia()` flips true, the interceptor stops adding the lead; CyTube's own correction pulls the (now slightly-ahead) player back to the true position over its normal smoothing — no special handling needed.
- **YouTube → movie transition**: same in reverse.
- **Bumpers/trailers between movies**: lead offset still applies (this design's accepted trade-off vs. the stricter lineup-gated alternative).
- **User manually desynced (Free watch)**: offset is inert until resync, exactly like CyTube's own sync is inert while desynced today.
- **Socket reconnect / listener re-registration**: if CyTube re-registers its `mediaUpdate` listener after a reconnect (replacing the interceptor), the lead would silently stop applying until the next page load re-runs `installMovieLeadInterceptor()`. Acceptable — matches this script's existing general assumption of one listener registration per page load, same as `_freezeSync`/`_thawSync`.
- **Setting changed mid-movie**: takes effect on the very next `mediaUpdate` tick since `getMovieLeadSec()` is read live from localStorage on every interceptor call — no reload needed.

## Testing

Manual, in a live cytu.be room (no automated test suite exists for this userscript):
1. Temporarily log one real `mediaUpdate` payload to confirm the `currentTime` field name before relying on it.
2. During a movie with lead set to 2s, confirm the player settles ~2s ahead of other viewers' reported position.
3. During YouTube playback, confirm no lead is applied (matches group position within normal sync tolerance).
4. Set lead to 0 in settings, confirm playback matches group position exactly during a movie.
5. Enter/exit desync (Free watch) during a movie with lead > 0, confirm resync re-establishes the lead-ahead position afterward.
6. Confirm console shows no errors if `_getMediaUpdateListeners()` fails to locate the listeners — should warn and leave sync fully unmodified.
