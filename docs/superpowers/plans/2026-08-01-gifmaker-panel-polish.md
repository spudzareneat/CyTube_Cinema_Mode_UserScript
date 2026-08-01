# GIF Maker Panel Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three small visual tightening fixes to the GIF Maker panel: make the Start/End thumbnails bigger (legibility), tighten the overview scrubber's bar-to-label spacing (compactness, without changing the bar's own height), and make the caption input group's top/bottom breathing room symmetric.

**Architecture:** Pure CSS edits to `cytube.gifmaker.user.js`'s `injectPanelCss()` template literal — no HTML or JS changes.

**Tech Stack:** Tampermonkey userscript (vanilla JS, no build step).

## Global Constraints

- No automated test framework in this repo — verification is `node --check cytube.gifmaker.user.js` (syntax only) plus a code-reading self-review.
- `.sc-gif-overview-track`'s `height: 16px` must not change — only the spacing around it.
- No JS or HTML changes — this plan is CSS-only.

---

### Task 1: Bigger thumbnails, tighter scrubber, symmetric caption padding

**Files:**
- Modify: `cytube.gifmaker.user.js` (CSS block only)

**Interfaces:** None — pure styling, no new selectors, functions, or elements.

- [ ] **Step 1: Remove the width cap on the Start/End thumbnails**

An earlier fix capped `.sc-gif-marks` to 420px (centered) to save vertical height after the panel widened to 600px. The user now wants the thumbnails bigger — legibility (the timecode labels and ±.5/Now buttons) matters more than the height saved. Removing the cap lets each thumbnail grow to roughly half the Trim card's full content width (~281px wide at 4:3, up from ~191px).

Find this exact line:
```js
            .sc-gif-marks { display: flex !important; gap: 10px !important; max-width: 420px !important; margin: 0 auto !important; }
```
Replace with:
```js
            .sc-gif-marks { display: flex !important; gap: 10px !important; }
```

- [ ] **Step 2: Tighten the overview scrubber's bar-to-label spacing**

Find this exact line:
```js
            .sc-gif-overview { display: flex !important; flex-direction: column !important; gap: 4px !important; margin-bottom: 2px !important; }
```
Replace with:
```js
            .sc-gif-overview { display: flex !important; flex-direction: column !important; gap: 2px !important; }
```
(The `.sc-gif-overview-track` rule immediately below this one, which sets `height: 16px`, is untouched — only the gap between the track and its label row, and the redundant `margin-bottom` that the Trim card's own `gap: 8px` already made unnecessary, are removed.)

- [ ] **Step 3: Give the caption input group symmetric top/bottom breathing room**

The captions card gives 12px of space above the TOP TEXT input (the card's own top padding), but BOTTOM TEXT only has the captions column's normal 8px `gap` before the color-radio row beneath it — no equivalent 12px pause. Add 4px of margin specifically after the bottom caption input so the total space after it (8px gap + 4px margin = 12px) matches the 12px above the top input.

Find this exact line:
```js
                            <input type="text" id="sc-gif-cap-bottom" class="sc-gif-cap-input" placeholder="BOTTOM TEXT (optional)" maxlength="120">
```
Replace with:
```js
                            <input type="text" id="sc-gif-cap-bottom" class="sc-gif-cap-input sc-gif-cap-bottom-input" placeholder="BOTTOM TEXT (optional)" maxlength="120">
```

Find this exact block:
```js
            .sc-gif-cap-input:hover, .sc-gif-cap-input:focus { border-color: rgba(255,176,32,0.5) !important; }
            .sc-gif-cap-input::placeholder { color: rgba(244,244,242,0.34) !important; }
```
Replace with:
```js
            .sc-gif-cap-input:hover, .sc-gif-cap-input:focus { border-color: rgba(255,176,32,0.5) !important; }
            .sc-gif-cap-bottom-input { margin-bottom: 4px !important; }
            .sc-gif-cap-input::placeholder { color: rgba(244,244,242,0.34) !important; }
```

- [ ] **Step 4: Verify syntax**

Run: `node --check cytube.gifmaker.user.js`
Expected: no output, exit code 0.

- [ ] **Step 5: Self-review**

Trace through and confirm:
1. `.sc-gif-marks` no longer has `max-width`/`margin` — it fills its container's full width, same as before the earlier cap was added.
2. `.sc-gif-overview-track`'s `height: 16px` line is untouched (still present, still 16px) — only the wrapping `.sc-gif-overview` rule's `gap`/`margin-bottom` changed.
3. `#sc-gif-cap-bottom` now carries both `class="sc-gif-cap-input sc-gif-cap-bottom-input"` — confirm the existing `sc-gif-cap-input` class (and everything it controls: background, border, padding, transition) is still present, `sc-gif-cap-bottom-input` is additive.
4. `.sc-gif-cap-bottom-input { margin-bottom: 4px !important; }` only targets the bottom caption input — `#sc-gif-cap-top` is unaffected.
5. No unrelated line was touched — this diff should be exactly the 4 edits above.

- [ ] **Step 6: Manual browser verification**

Load the userscript in a Tampermonkey dev profile against a live CyTube video (`420Grindhouse` or `testing` room). Open the GIF Maker and confirm: the Start/End thumbnails are visibly larger and their timecode labels/±.5/Now buttons have comfortable room; the overview scrubber's time labels sit noticeably closer under the bar without the bar itself changing height; there's a small but visible extra gap between the BOTTOM TEXT input and the White/Yellow color radios below it, roughly matching the gap above the TOP TEXT input at the top of the card.

- [ ] **Step 7: Commit**

```bash
git add cytube.gifmaker.user.js
git commit -m "Polish GIF Maker panel: bigger thumbnails, tighter scrubber spacing, symmetric caption padding"
```
