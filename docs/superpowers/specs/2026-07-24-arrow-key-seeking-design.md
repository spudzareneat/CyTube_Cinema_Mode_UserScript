# Arrow-key / space-bar seeking, clamped to live sync

Date: 2026-07-24

## Goal

Add YouTube-style keyboard seeking to the movie player:
- **Left arrow**: rewind 5 seconds.
- **Right arrow**: advance 5 seconds, but never past the group's live synced position.
- Using either arrow enables the existing desync ("Free watch", `⟳`) mode.
- **Space bar**: snap back to the live synced position and exit desync mode.

Builds entirely on the existing desync machinery (`_desync`, `setDesynced`, `_freezeSync`/`_thawSync`, `⟳` button) around `cytube.pc.user.js:575-642`. No new UI elements.

## 1. Sync anchor tracking

The `_desync` state object gains two fields, populated only while desynced:

```js
const _desync = { active: false, saved: null, btn: null, anchorPos: null, anchorWall: null };
```

`setDesynced(true)` captures the anchor immediately before calling `_freezeSync()`:
```js
_desync.anchorPos = getPlayerTimeSec();
_desync.anchorWall = Date.now();
```
`setDesynced(false)` clears both back to `null` after `_thawSync()`.

New helper, placed near `getPlayerTimeSec()`:
```js
function getSyncedTimeNow() {
    if (!_desync.active) return getPlayerTimeSec();
    if (_desync.anchorPos == null) return getPlayerTimeSec();
    return _desync.anchorPos + (Date.now() - _desync.anchorWall) / 1000;
}
```

This mirrors the "assume uninterrupted playback since a captured anchor" extrapolation already used by `seekTargetForMsgTime()` (`cytube.pc.user.js:686-693`) for the chat-to-movie seek feature — same trade-off, same precedent: if the room leader pauses or the queue advances while desynced, the estimate can drift. Accepted, matching existing behavior elsewhere in the script.

## 2. Keydown handler

A new listener, added alongside the existing `'t'`/`'i'`/`Escape` handler at `cytube.pc.user.js:2251`, using the same typing-guard (`TEXTAREA`/`INPUT`/`isContentEditable` → ignore):

- **ArrowLeft**:
  1. `preventDefault()`.
  2. `target = Math.max(0, getPlayerTimeSec() - 5)`.
  3. If not already desynced, `setDesynced(true)` (captures the anchor from the pre-seek position).
  4. `seekPlayerTo(target)`.

- **ArrowRight**:
  1. `preventDefault()`.
  2. If not desynced: no-op (already at the live edge — matches the "reached live, do nothing" behavior chosen during design).
  3. If desynced: `syncedNow = getSyncedTimeNow()`; `target = Math.min(getPlayerTimeSec() + 5, syncedNow)`; `seekPlayerTo(target)`.
  4. If `target >= syncedNow - 0.15` (small epsilon for float/timer drift), auto-call `setDesynced(false)` — catching up to live exits desync mode automatically.

- **Space** (`' '` / `Spacebar`):
  1. `preventDefault()`.
  2. If desynced: `const t = getSyncedTimeNow(); setDesynced(false); seekPlayerTo(t);` — thaw first (restores CyTube's own listeners and emits `playerReady` for an immediate server resync), then explicitly seek to the last-known live estimate so the jump is instant rather than waiting on the next server update.
  3. If not desynced: no-op. (Space is fully repurposed for resync here — it does not toggle play/pause.)

No changes needed to `setDesynced()`'s button-UI toggling — it already flips `.sc-desync-active` and the tooltip text, so the `⟳` button reflects arrow/space-triggered desync exactly like a manual click.

## Edge cases

- No video element / player not ready: `getPlayerTimeSec()`/`seekPlayerTo()` already null-guard (return `null`/`false`); the handler effectively no-ops.
- Holding an arrow key down: each `keydown` (including OS auto-repeat) is handled independently — cheap, no debouncing needed.
- Rapid left-then-right presses near the live edge: clamping is recomputed fresh on every keypress from `getSyncedTimeNow()`, so there's no stale-state risk.

## Testing

Manual, in a live cytu.be room (no automated test suite exists for this userscript):
1. Left arrow rewinds 5s per press and turns the `⟳` button active.
2. Right arrow cannot seek past the live position; repeated presses catch up and auto-deactivate `⟳`.
3. Space bar, pressed from anywhere in the rewound range, snaps immediately to live and deactivates `⟳`.
4. All three keys are ignored while focus is in the chat textarea or any input/contentEditable field.
