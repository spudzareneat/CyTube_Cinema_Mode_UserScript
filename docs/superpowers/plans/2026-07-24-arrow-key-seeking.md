# Arrow-Key / Space-Bar Seeking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add YouTube-style left/right arrow seeking (5s per press) and a space-bar "snap to live" shortcut to the movie player, using the existing desync ("Free watch") mechanism so you can never seek ahead of the group's synced position.

**Architecture:** Everything lands in the single existing file `cytube.pc.user.js` (a monolithic Tampermonkey userscript, no build step, no ES modules, no test framework). Two small edits: (1) extend the existing `_desync` state object and `setDesynced()` with a sync-position anchor plus a new `getSyncedTimeNow()` helper, next to the existing desync/seek code around line 575-693; (2) extend the existing global `keydown` listener (currently handling `t`/`i`/`Escape`, around line 2251) with `ArrowLeft`/`ArrowRight`/`Space` branches.

**Tech Stack:** Vanilla JS (ES2020+), no test framework — verified with `node --check` for syntax and manual testing in a live cytu.be room (matches this repo's existing convention: no automated UI tests, per `docs/superpowers/specs/2026-07-24-arrow-key-seeking-design.md`).

## Global Constraints

- Single-file architecture: all changes go inline into `cytube.pc.user.js`, following its existing block-comment-per-feature and 4-space indentation conventions. No new files.
- No new UI elements — the existing `⟳` desync button's active-state styling (already driven by `setDesynced()`) is the only visual indicator.
- Seek step is exactly 5 seconds per arrow press (confirmed in design).
- Right-arrow at the live edge (not desynced) is a no-op — it does not enter desync mode (confirmed in design).
- Catching up to the live edge via right-arrow while desynced auto-exits desync mode (confirmed in design).
- Space bar only acts while desynced (exits + snaps to live); it is a no-op when already synced — it does not toggle play/pause.
- All three keys must be ignored while focus is in a `TEXTAREA`/`INPUT`/`contentEditable` element, matching the existing `t`/`i`/`Escape` handler's guard.

---

### Task 1: Sync anchor tracking + `getSyncedTimeNow()` helper

**Files:**
- Modify: `cytube.pc.user.js:575` (the `_desync` state object)
- Modify: `cytube.pc.user.js:621-632` (`setDesynced()`)
- Modify: `cytube.pc.user.js:661-682` (insert `getSyncedTimeNow()` after `getPlayerTimeSec()`)

**Interfaces:**
- Consumes: pre-existing `getPlayerTimeSec()`, `_freezeSync()`, `_thawSync()`, `_desync` object (all in this same file, lines 575-693)
- Produces: `getSyncedTimeNow(): number|null` — returns the live player time when not desynced, or the wall-clock-extrapolated live position while desynced. Consumed by Task 2.

- [ ] **Step 1: Add anchor fields to `_desync`**

Find (currently line 575):

```js
    const _desync = { active: false, saved: null, btn: null };
```

Replace with:

```js
    const _desync = { active: false, saved: null, btn: null, anchorPos: null, anchorWall: null };
```

- [ ] **Step 2: Capture/clear the anchor in `setDesynced()`**

Find (currently lines 621-632):

```js
    function setDesynced(on) {
        if (typeof socket === 'undefined' || !socket) return;
        if (on === _desync.active) return;
        _desync.active = on;
        if (on) _freezeSync(); else _thawSync();
        const btn = _desync.btn;
        if (btn) {
            btn.classList.toggle('sc-desync-active', on);
            btn.title = on ? 'Free watch ON — click to re-sync'
                           : 'Free watch — click to watch freely, click again to re-sync';
        }
    }
```

Replace with:

```js
    function setDesynced(on) {
        if (typeof socket === 'undefined' || !socket) return;
        if (on === _desync.active) return;
        _desync.active = on;
        if (on) {
            // Anchor captured BEFORE freezing so it reflects the still-live position.
            _desync.anchorPos = getPlayerTimeSec();
            _desync.anchorWall = Date.now();
            _freezeSync();
        } else {
            _thawSync();
            _desync.anchorPos = null;
            _desync.anchorWall = null;
        }
        const btn = _desync.btn;
        if (btn) {
            btn.classList.toggle('sc-desync-active', on);
            btn.title = on ? 'Free watch ON — click to re-sync'
                           : 'Free watch — click to watch freely, click again to re-sync';
        }
    }
```

- [ ] **Step 3: Add `getSyncedTimeNow()`**

Find (currently lines 665-669):

```js
    function getPlayerTimeSec() {
        const v = getPlayerVideoEl();
        if (v && isFinite(v.currentTime)) return v.currentTime;
        return null;
    }
```

Immediately after it (still before `function seekPlayerTo(sec) {`), insert:

```js

    // The group's live synced position, right now. When not desynced this IS the
    // player's own time (CyTube keeps it live). While desynced, CyTube's own
    // mediaUpdate listeners are frozen (see _freezeSync), so we extrapolate forward
    // from the position captured at the moment desync began, assuming uninterrupted
    // playback — same trade-off seekTargetForMsgTime() below already makes for the
    // chat-to-movie seek feature.
    function getSyncedTimeNow() {
        if (!_desync.active) return getPlayerTimeSec();
        if (_desync.anchorPos == null) return getPlayerTimeSec();
        return _desync.anchorPos + (Date.now() - _desync.anchorWall) / 1000;
    }
```

- [ ] **Step 4: Verify syntax**

Run: `node --check cytube.pc.user.js`
Expected: no output, exit code 0.

- [ ] **Step 5: Manual sanity check in-browser**

In a live cytu.be room with a video playing, open the browser console and run:

```js
getSyncedTimeNow()
```

Expected: a number close to the visible playhead position. Then click the existing `⟳` Free Watch button to desync, wait ~5 seconds, and run `getSyncedTimeNow()` again — expected: a number roughly 5 seconds higher than when desync started (extrapolated live position), even though the actual video hasn't moved.

- [ ] **Step 6: Commit**

```bash
git add cytube.pc.user.js
git commit -m "Track a live-sync anchor so desynced state can compute the group's current position"
```

---

### Task 2: Arrow-key / space-bar keydown handling

**Files:**
- Modify: `cytube.pc.user.js:2251-2261` (extend the existing global `keydown` listener)

**Interfaces:**
- Consumes: `getPlayerTimeSec()`, `seekPlayerTo(sec)`, `setDesynced(on)`, `getSyncedTimeNow()` (Task 1 + pre-existing, all in this file)
- Produces: nothing new (terminal task — wires the feature end-to-end)

- [ ] **Step 1: Extend the keydown listener**

Find (currently lines 2250-2261):

```js
    // 'T' = trivia, 'I' = movie info card — from anywhere when not typing
    document.addEventListener('keydown', (e) => {
        const t = e.target;
        if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
        if (e.key === 't' || e.key === 'T') { toggleTriviaPanel(); return; }
        if (e.key === 'Escape') { hideTriviaCard(); hideNowPlayingCard(); hideLineupScreen(); return; }
        if (e.key === 'i' || e.key === 'I') {
            const card = document.getElementById('sc-np-card');
            if (card && card.classList.contains('sc-np-visible')) hideNowPlayingCard();
            else if (_npData) showNowPlayingCard(_npData, { autoHide: false });
        }
    });
```

Replace with:

```js
    // 'T' = trivia, 'I' = movie info card, arrows/space = YouTube-style seek — from
    // anywhere when not typing.
    const ARROW_SEEK_STEP_SEC = 5;
    document.addEventListener('keydown', (e) => {
        const t = e.target;
        if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
        if (e.key === 't' || e.key === 'T') { toggleTriviaPanel(); return; }
        if (e.key === 'Escape') { hideTriviaCard(); hideNowPlayingCard(); hideLineupScreen(); return; }
        if (e.key === 'i' || e.key === 'I') {
            const card = document.getElementById('sc-np-card');
            if (card && card.classList.contains('sc-np-visible')) hideNowPlayingCard();
            else if (_npData) showNowPlayingCard(_npData, { autoHide: false });
            return;
        }
        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            const pos = getPlayerTimeSec();
            if (pos == null) return;
            if (!_desync.active) setDesynced(true);
            seekPlayerTo(Math.max(0, pos - ARROW_SEEK_STEP_SEC));
            return;
        }
        if (e.key === 'ArrowRight') {
            e.preventDefault();
            if (!_desync.active) return; // already at the live edge — nothing to catch up to
            const pos = getPlayerTimeSec();
            const syncedNow = getSyncedTimeNow();
            if (pos == null || syncedNow == null) return;
            const target = Math.min(pos + ARROW_SEEK_STEP_SEC, syncedNow);
            seekPlayerTo(target);
            if (target >= syncedNow - 0.15) setDesynced(false);
            return;
        }
        if (e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            if (!_desync.active) return;
            const syncedNow = getSyncedTimeNow();
            setDesynced(false);
            if (syncedNow != null) seekPlayerTo(syncedNow);
        }
    });
```

- [ ] **Step 2: Verify syntax**

Run: `node --check cytube.pc.user.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Manual end-to-end test in a live room**

1. Load the userscript in a live cytu.be room with a video playing, focus somewhere on the page body (not chat input).
2. Press **Left arrow** several times: video rewinds 5s per press, and the `⟳` button turns active (desynced).
3. Press **Right arrow** repeatedly: video advances 5s per press; once it reaches the live position, the `⟳` button turns inactive again automatically (no more advancing needed/possible).
4. Press **Left arrow** again to rewind, then press **Space**: video jumps immediately back to the live position and `⟳` turns inactive.
5. Click into the chat textarea and press **Left/Right/Space**: confirm nothing happens to the video (keys are typed into chat instead, or space adds a literal space).
6. With the video at the live edge (not desynced), press **Right arrow**: confirm nothing happens and `⟳` stays inactive.

- [ ] **Step 4: Bump the userscript version header**

Find (currently `cytube.pc.user.js:4`):

```
// @version      4.7.0
```

Replace with:

```
// @version      4.7.1
```

Find (currently `cytube.pc.user.js:23`):

```js
    console.log('[SC] cytube.pc v4.7.0 loaded');
```

Replace with:

```js
    console.log('[SC] cytube.pc v4.7.1 loaded');
```

- [ ] **Step 5: Commit**

```bash
git add cytube.pc.user.js
git commit -m "Add YouTube-style arrow-key seeking and space-bar resync, clamped to live sync"
```
