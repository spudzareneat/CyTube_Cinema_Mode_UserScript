# Consolidate GIF Maker into a single source of truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `cytube.gifmaker.user.js` becomes the single GIF Maker implementation. `cytube.pc.user.js` loses its entire duplicated copy and instead consumes gifmaker's implementation through a small cross-userscript bridge, adapting button placement and title logic when gifmaker detects pc.user.js is also installed.

**Architecture:** `cytube.pc.user.js` publishes a bridge object on `unsafeWindow.__SC_GIF_BRIDGE__` (the real, shared page window — required because each Tampermonkey userscript runs in its own sandboxed `window`). `cytube.gifmaker.user.js` detects that object at boot, sets a `PC_MODE` flag, and branches its button placement, title-slug source, and ImgBB/Optimize inline UI accordingly. `cytube.pc.user.js`'s own GIF capture/encode/panel code (~1,070 lines of JS + ~320 lines of CSS) is deleted outright.

**Tech Stack:** Plain Tampermonkey userscripts (vanilla JS, `@grant GM_xmlhttpRequest`, `unsafeWindow`), no build step, no test framework.

## Global Constraints

- Installing `cytube.gifmaker.user.js` alone must behave **exactly** as it does today — same button in `#videocontrols`, same panel, same inline ImgBB/Optimize UI. This is the highest-priority constraint; every gifmaker.user.js change must be gated behind `PC_MODE` so the `PC_MODE === false` path is unchanged.
- Cross-script communication requires `unsafeWindow` (both scripts already have `@grant GM_xmlhttpRequest`, which makes `unsafeWindow` available with no header change). Plain `localStorage` (`sc_imgbb_key`, `sc_gif_optimize`) is already shared and needs no bridge.
- The record/GIF button must be **visible but disabled** (not hidden) during YouTube playback, in both standalone and PC mode.
- The bridge upgrade (standalone → PC mode after a late-loading pc.user.js is detected) is one-way only and must no-op if the GIF panel is already open.
- Verification convention for this repo: `node --check <file>.user.js` (syntax only) plus a careful read-through self-review. No automated tests exist.
- Do not touch `_gifTitleSlug()` (pc.user.js, becomes the bridge's title provider), `parseMovieFilename()`, `lastMovieTitle`, the Settings-modal ImgBB/Optimize fields, `validateImgbbKey()`, or `GAP_IDS` — all explicitly out of scope.

---

### Task 1: Add the bridge provider to `cytube.pc.user.js`

Purely additive — no deletions, nothing existing changes. Safe to land alone since gifmaker.user.js doesn't consume it until Task 2.

**Files:**
- Modify: `cytube.pc.user.js` (near line 40-48, the `LS_*`/`getKey`/toggle-helper block)

**Interfaces:**
- Produces: `unsafeWindow.__SC_GIF_BRIDGE__ = { version: 1, getTitleSlug(): string, openGifPanel: undefined|((startSec?: number) => void) }`. `openGifPanel` starts `undefined` and is filled in by gifmaker.user.js once it boots (Task 2).

- [ ] **Step 1: Insert the bridge object**

  Find this exact block in `cytube.pc.user.js` (currently lines 40-49):

  ```js
      const LS_GIF_OPTIMIZE = 'sc_gif_optimize'; // shared with cytube.gifmaker.user.js
      const getKey   = id => localStorage.getItem(id) || '';
      const setKey   = (id, v) => localStorage.setItem(id, v.trim());
      const hasKey   = id => !!getKey(id);
      const spellCheckEnabled  = () => getKey(LS_SPELLCHECK)  !== 'off';
      const movieLinksEnabled  = () => getKey(LS_MOVIE_LINKS) !== 'off';
      const lineupTimingEnabled = () => getKey(LS_LINEUP_TIMING) === 'on'; // opt-in, unlike the toggles above
      const gifOptimizeEnabled = () => getKey(LS_GIF_OPTIMIZE) !== 'off'; // default ON, like spellcheck/movielinks

      function getChatFontSize() {
  ```

  Replace it with:

  ```js
      const LS_GIF_OPTIMIZE = 'sc_gif_optimize'; // shared with cytube.gifmaker.user.js
      const getKey   = id => localStorage.getItem(id) || '';
      const setKey   = (id, v) => localStorage.setItem(id, v.trim());
      const hasKey   = id => !!getKey(id);
      const spellCheckEnabled  = () => getKey(LS_SPELLCHECK)  !== 'off';
      const movieLinksEnabled  = () => getKey(LS_MOVIE_LINKS) !== 'off';
      const lineupTimingEnabled = () => getKey(LS_LINEUP_TIMING) === 'on'; // opt-in, unlike the toggles above
      const gifOptimizeEnabled = () => getKey(LS_GIF_OPTIMIZE) !== 'off'; // default ON, like spellcheck/movielinks

      /* ==========================================================
         GIF MAKER INTEGRATION BRIDGE
         cytube.gifmaker.user.js owns the actual GIF capture/encode/
         panel implementation. This script exposes what gifmaker needs
         to adapt when both scripts are installed together: a
         TMDB-aware title slug, and a slot gifmaker fills in with its
         own openGifPanel once it boots. Two separate Tampermonkey
         sandboxes can't see each other's plain `window` properties,
         so this goes on unsafeWindow — the real, shared page window.
      ========================================================== */
      unsafeWindow.__SC_GIF_BRIDGE__ = {
          version: 1,
          getTitleSlug: () => _gifTitleSlug(),
          openGifPanel: undefined, // filled in by cytube.gifmaker.user.js once it boots
      };

      function getChatFontSize() {
  ```

  This is safe even though `_gifTitleSlug` is defined much later in the file (currently line 1237): it's a hoisted `function` declaration, and the arrow function here only resolves the reference when `getTitleSlug()` is actually *called* (long after full-script evaluation), not when this object literal is built.

- [ ] **Step 2: Verify**

  Run: `node --check cytube.pc.user.js`
  Expected: no output (syntax OK).

- [ ] **Step 3: Commit**

  ```bash
  git add cytube.pc.user.js
  git commit -m "Add GIF Maker integration bridge provider to cytube.pc.user.js"
  ```

---

### Task 2: Add `PC_MODE` detection and branching to `cytube.gifmaker.user.js`

The hardest self-review requirement: the "no bridge found" path must be byte-for-byte behavior-identical to today's standalone behavior. Every current standalone-only install must be unaffected.

**Files:**
- Modify: `cytube.gifmaker.user.js` (STORAGE section ~line 27, ImgBB/Optimize panel HTML ~lines 1238-1257, panel wiring ~lines 1264-1324, title-slug call site ~line 1812, RECORD BUTTON/BOOT sections ~lines 1867-1919)

**Interfaces:**
- Consumes: `unsafeWindow.__SC_GIF_BRIDGE__` as produced by Task 1 (`{ getTitleSlug(): string, openGifPanel: undefined|function }`).
- Produces: sets `window.__SC_GIF_BRIDGE__.openGifPanel = openGifPanel` (via `unsafeWindow`) once this script boots in PC mode, so pc.user.js's chat-seek menu (Task 3) can call it.

- [ ] **Step 1: Add PC-mode detection primitives near STORAGE**

  Find this exact block (currently lines 27-31):

  ```js
      const gifOptimizeEnabled = () => getKey(LS_GIF_OPTIMIZE) !== 'off'; // default ON

      /* ==========================================================
         PLAYER / MEDIA-TYPE DETECTION
      ========================================================== */
  ```

  Replace with:

  ```js
      const gifOptimizeEnabled = () => getKey(LS_GIF_OPTIMIZE) !== 'off'; // default ON

      /* ==========================================================
         PC-SCRIPT INTEGRATION BRIDGE
         cytube.pc.user.js (when installed) exposes a small object on
         the real page window (via unsafeWindow — two separate
         Tampermonkey sandboxes can't see each other's plain `window`
         properties) so this script can defer to its TMDB-aware title
         logic and match its floating-button placement instead of
         duplicating that functionality. Detection happens in
         waitForBody() at the bottom of this file; PC_MODE and
         _pcBridge are set there.
      ========================================================== */
      let PC_MODE = false;
      let _pcBridge = null;
      function readPcBridge() {
          const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
          const b = w.__SC_GIF_BRIDGE__;
          return (b && typeof b.getTitleSlug === 'function') ? b : null;
      }
      function activeTitleSlug() {
          if (PC_MODE && _pcBridge) {
              try { return _pcBridge.getTitleSlug() || ''; } catch (e) { return ''; }
          }
          return gifTitleSlug();
      }

      /* ==========================================================
         PLAYER / MEDIA-TYPE DETECTION
      ========================================================== */
  ```

- [ ] **Step 2: Make the ImgBB-key/Optimize-checkbox panel HTML conditional on `PC_MODE`**

  Find this exact block (currently lines 1238-1257 — the ImgBB row + Optimize row, wrapped in `sc-gif-card`):

  ```js
                  <div class="sc-gif-card">
                  <div class="sc-gif-imgbb-row" id="sc-gif-imgbb-row">
                      <button type="button" class="sc-gif-imgbb-header" id="sc-gif-imgbb-header" aria-expanded="false">
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
                  <div class="sc-gif-optimize-row">
                      <input type="checkbox" id="sc-gif-optimize" ${gifOptimizeEnabled() ? 'checked' : ''} />
                      <label for="sc-gif-optimize">Optimize GIF before upload</label>
                  </div>
                  </div>
  ```

  Replace with (wraps the whole thing in `${PC_MODE ? '' : \`...\`}` — omitted entirely in PC mode, where pc.user.js's Settings modal is the sole UI for these two shared-localStorage settings):

  ```js
                  ${PC_MODE ? '' : `
                  <div class="sc-gif-card">
                  <div class="sc-gif-imgbb-row" id="sc-gif-imgbb-row">
                      <button type="button" class="sc-gif-imgbb-header" id="sc-gif-imgbb-header" aria-expanded="false">
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
                  <div class="sc-gif-optimize-row">
                      <input type="checkbox" id="sc-gif-optimize" ${gifOptimizeEnabled() ? 'checked' : ''} />
                      <label for="sc-gif-optimize">Optimize GIF before upload</label>
                  </div>
                  </div>
                  `}
  ```

  Nested template literals (a backtick-delimited literal inside a `${...}` expression of an outer template literal) are valid JS — this is a single unbroken template literal for `panel.innerHTML` both before and after this change.

- [ ] **Step 3: Guard the now-possibly-absent ImgBB/Optimize element wiring**

  Because Step 2 makes those elements absent in PC mode, the three blocks of JS that immediately wire them up (right after `panel` is inserted) must not throw on missing elements.

  Find this exact block (currently lines 1264-1267):

  ```js
          const optimizeCheckbox = $('#sc-gif-optimize');
          optimizeCheckbox.addEventListener('change', () => {
              setKey(LS_GIF_OPTIMIZE, optimizeCheckbox.checked ? 'on' : 'off');
          });
  ```

  Replace with:

  ```js
          const optimizeCheckbox = $('#sc-gif-optimize');
          if (optimizeCheckbox) {
              optimizeCheckbox.addEventListener('change', () => {
                  setKey(LS_GIF_OPTIMIZE, optimizeCheckbox.checked ? 'on' : 'off');
              });
          }
  ```

  Find this exact block (currently lines 1278-1285):

  ```js
          const imgbbRow = $('#sc-gif-imgbb-row');
          const imgbbHeader = $('#sc-gif-imgbb-header');
          const imgbbToggle = $('#sc-gif-imgbb-toggle');
          imgbbHeader.addEventListener('click', () => {
              const open = imgbbRow.classList.toggle('sc-gif-imgbb-open');
              imgbbToggle.textContent = open ? '▾' : '▸';
              imgbbHeader.setAttribute('aria-expanded', String(open));
          });
  ```

  Replace with:

  ```js
          const imgbbRow = $('#sc-gif-imgbb-row');
          const imgbbHeader = $('#sc-gif-imgbb-header');
          const imgbbToggle = $('#sc-gif-imgbb-toggle');
          if (imgbbHeader) {
              imgbbHeader.addEventListener('click', () => {
                  const open = imgbbRow.classList.toggle('sc-gif-imgbb-open');
                  imgbbToggle.textContent = open ? '▾' : '▸';
                  imgbbHeader.setAttribute('aria-expanded', String(open));
              });
          }
  ```

  Find this exact block (currently lines 1305-1324):

  ```js
          const imgbbInput = $('#sc-gif-imgbb-key');
          const imgbbStatus = $('#sc-gif-imgbb-status');
          const imgbbTestBtn = $('#sc-gif-imgbb-test');
          imgbbInput.addEventListener('change', () => setKey(LS_IMGBB, imgbbInput.value.trim()));
          imgbbTestBtn.addEventListener('click', async () => {
              const key = imgbbInput.value.trim();
              if (!key) { imgbbStatus.textContent = 'Enter an API key first'; imgbbStatus.className = 'sc-gif-imgbb-status sc-test-bad'; return; }
              imgbbTestBtn.disabled = true;
              imgbbStatus.textContent = 'Checking…'; imgbbStatus.className = 'sc-gif-imgbb-status sc-test-pending';
              const verdict = await validateImgbbKey(key);
              imgbbTestBtn.disabled = false;
              if (verdict === 'valid') {
                  imgbbStatus.textContent = '✓ Valid API key'; imgbbStatus.className = 'sc-gif-imgbb-status sc-test-ok';
                  setKey(LS_IMGBB, key);
              } else if (verdict === 'invalid') {
                  imgbbStatus.textContent = '✗ Invalid API key'; imgbbStatus.className = 'sc-gif-imgbb-status sc-test-bad';
              } else {
                  imgbbStatus.textContent = '⚠ Couldn\'t reach ImgBB'; imgbbStatus.className = 'sc-gif-imgbb-status sc-test-bad';
              }
          });
  ```

  Replace with:

  ```js
          const imgbbInput = $('#sc-gif-imgbb-key');
          const imgbbStatus = $('#sc-gif-imgbb-status');
          const imgbbTestBtn = $('#sc-gif-imgbb-test');
          if (imgbbInput) {
              imgbbInput.addEventListener('change', () => setKey(LS_IMGBB, imgbbInput.value.trim()));
              imgbbTestBtn.addEventListener('click', async () => {
                  const key = imgbbInput.value.trim();
                  if (!key) { imgbbStatus.textContent = 'Enter an API key first'; imgbbStatus.className = 'sc-gif-imgbb-status sc-test-bad'; return; }
                  imgbbTestBtn.disabled = true;
                  imgbbStatus.textContent = 'Checking…'; imgbbStatus.className = 'sc-gif-imgbb-status sc-test-pending';
                  const verdict = await validateImgbbKey(key);
                  imgbbTestBtn.disabled = false;
                  if (verdict === 'valid') {
                      imgbbStatus.textContent = '✓ Valid API key'; imgbbStatus.className = 'sc-gif-imgbb-status sc-test-ok';
                      setKey(LS_IMGBB, key);
                  } else if (verdict === 'invalid') {
                      imgbbStatus.textContent = '✗ Invalid API key'; imgbbStatus.className = 'sc-gif-imgbb-status sc-test-bad';
                  } else {
                      imgbbStatus.textContent = '⚠ Couldn\'t reach ImgBB'; imgbbStatus.className = 'sc-gif-imgbb-status sc-test-bad';
                  }
              });
          }
      ```

  Note the "does an ImgBB key exist" check further down (`const hasImgbbKey = !!getKey(LS_IMGBB);`, which controls whether the result view shows an Upload button) reads directly from `localStorage` and needs **no change** — it works identically in both modes since the key is set by whichever UI owns it.

- [ ] **Step 4: Switch the title-slug call site to the PC-aware dispatcher**

  Find this exact line (currently line 1812):

  ```js
                  const slug = gifTitleSlug();
  ```

  Replace with:

  ```js
                  const slug = activeTitleSlug();
  ```

- [ ] **Step 5: Rewrite the RECORD BUTTON and BOOT sections for PC_MODE branching**

  Find this exact block — it is the entire remainder of the file from the RECORD BUTTON section comment through the closing `})();` (currently lines 1867-1919):

  ```js
      /* ==========================================================
         RECORD BUTTON — attached into CyTube's own #videocontrols
         .btn-group (the reload/fullscreen/voteskip row under the
         player), styled with CyTube's native .btn.btn-sm.btn-default
         so it reads as one of the built-in controls rather than an
         overlay.
      ========================================================== */
      function ensureRecordButton() {
          const group = document.getElementById('videocontrols');
          if (!group) return;
          let btn = document.getElementById('scgm-record-btn');
          if (!btn) {
              btn = document.createElement('button');
              btn.id = 'scgm-record-btn';
              btn.type = 'button';
              btn.className = 'btn btn-sm btn-default';
              btn.title = 'Make a GIF of this scene';
              btn.innerHTML = '<span class="glyphicon glyphicon-camera"></span>';
              btn.addEventListener('click', () => openGifPanel());
              group.appendChild(btn);
          } else if (btn.parentElement !== group) {
              group.appendChild(btn);
          }
      }

      function updateRecordButtonVisibility() {
          const btn = document.getElementById('scgm-record-btn');
          if (!btn) return;
          // .btn's own display: inline-block isn't !important, but setting the
          // inline override with importance here too costs nothing and avoids
          // ever depending on that staying true.
          btn.style.setProperty('display', isYouTubeMedia() ? 'none' : 'inline-block', 'important');
      }

      /* ==========================================================
         BOOT
      ========================================================== */
      function waitForBody() {
          if (!document.body) { requestAnimationFrame(waitForBody); return; }

          ensureRecordButton();
          updateRecordButtonVisibility();

          new MutationObserver(() => {
              ensureRecordButton();
              updateRecordButtonVisibility();
          }).observe(document.body, { childList: true, subtree: true });

          setInterval(updateRecordButtonVisibility, 800);
      }

      waitForBody();
  })();
  ```

  Replace with:

  ```js
      /* ==========================================================
         RECORD BUTTON
         Standalone (no cytube.pc.user.js detected): attached into
         CyTube's own #videocontrols .btn-group (the reload/fullscreen/
         voteskip row under the player), styled with CyTube's native
         .btn.btn-sm.btn-default so it reads as one of the built-in
         controls rather than an overlay.

         PC mode (cytube.pc.user.js detected): a floating #sc-gif-btn,
         matching cytube.pc.user.js's own former floating GIF button
         exactly (same id/style/position), so it participates in that
         script's existing auto-dim-on-inactivity system with no
         changes needed there.
      ========================================================== */
      function injectFloatingButtonCss() {
          if (document.getElementById('scgm-floatbtn-style')) return;
          const style = document.createElement('style');
          style.id = 'scgm-floatbtn-style';
          style.textContent = `
              #sc-gif-btn {
                  position: fixed !important;
                  z-index: 20002 !important;
                  background: rgba(255,255,255,0.08) !important;
                  color: rgba(255,255,255,0.55) !important;
                  border: 1px solid rgba(255,255,255,0.18) !important;
                  border-radius: 50% !important;
                  width: 28px !important; height: 28px !important;
                  padding: 0 !important; font-size: 14px !important;
                  cursor: pointer !important;
                  display: flex !important; align-items: center !important; justify-content: center !important;
                  transition: color 0.3s ease, background 0.3s ease, transform 0.3s ease, opacity 0.3s ease !important;
              }
              #sc-gif-btn.sc-bar-dim {
                  transform: translateX(60px) !important; opacity: 0 !important; pointer-events: none !important;
              }
              #sc-gif-btn:hover { color: white !important; background: rgba(255,255,255,0.22) !important; }
              body.sc-horizontal #sc-gif-btn {
                  bottom: 6px !important;
                  right: calc(var(--sc-chat-w) + 1vw + 80px) !important;
              }
              body.sc-vertical #sc-gif-btn {
                  bottom: calc(var(--sc-chat-h) + 1vh) !important;
                  right: 80px !important;
              }
              #sc-gif-btn:disabled {
                  opacity: 0.35 !important; cursor: default !important; pointer-events: none !important;
              }
          `;
          document.head.appendChild(style);
      }

      function ensureRecordButton() {
          if (PC_MODE) {
              if (document.getElementById('sc-gif-btn')) return;
              injectFloatingButtonCss();
              const btn = document.createElement('button');
              btn.id = 'sc-gif-btn';
              btn.textContent = '◉';
              btn.title = 'Make a GIF of this scene';
              btn.addEventListener('click', () => openGifPanel());
              document.body.appendChild(btn);
              return;
          }
          const group = document.getElementById('videocontrols');
          if (!group) return;
          let btn = document.getElementById('scgm-record-btn');
          if (!btn) {
              btn = document.createElement('button');
              btn.id = 'scgm-record-btn';
              btn.type = 'button';
              btn.className = 'btn btn-sm btn-default';
              btn.title = 'Make a GIF of this scene';
              btn.innerHTML = '<span class="glyphicon glyphicon-camera"></span>';
              btn.addEventListener('click', () => openGifPanel());
              group.appendChild(btn);
          } else if (btn.parentElement !== group) {
              group.appendChild(btn);
          }
      }

      function updateRecordButtonState() {
          const btn = document.getElementById(PC_MODE ? 'sc-gif-btn' : 'scgm-record-btn');
          if (!btn) return;
          btn.disabled = isYouTubeMedia();
      }

      /* ==========================================================
         BOOT
      ========================================================== */
      const PC_BRIDGE_POLL_MS = 50;
      const PC_BRIDGE_POLL_TIMEOUT_MS = 1500;

      function upgradeToPcMode(bridge) {
          if (PC_MODE) return;
          if (document.getElementById('sc-gif-panel')) return; // don't rip the DOM out from under an open panel
          const oldBtn = document.getElementById('scgm-record-btn');
          if (oldBtn) oldBtn.remove();
          PC_MODE = true;
          _pcBridge = bridge;
          bridge.openGifPanel = openGifPanel;
          ensureRecordButton();
          updateRecordButtonState();
      }

      function waitForBody() {
          if (!document.body) { requestAnimationFrame(waitForBody); return; }

          const bridge = readPcBridge();
          if (bridge) {
              PC_MODE = true;
              _pcBridge = bridge;
              bridge.openGifPanel = openGifPanel;
          }

          ensureRecordButton();
          updateRecordButtonState();

          if (!PC_MODE) {
              // cytube.pc.user.js may still be loading (both scripts run at
              // document-start with no guaranteed order) — poll briefly for
              // its bridge before settling permanently into standalone mode.
              let elapsed = 0;
              const pollTimer = setInterval(() => {
                  elapsed += PC_BRIDGE_POLL_MS;
                  const lateBridge = readPcBridge();
                  if (lateBridge) {
                      clearInterval(pollTimer);
                      upgradeToPcMode(lateBridge);
                  } else if (elapsed >= PC_BRIDGE_POLL_TIMEOUT_MS) {
                      clearInterval(pollTimer);
                  }
              }, PC_BRIDGE_POLL_MS);
          }

          new MutationObserver(() => {
              ensureRecordButton();
              updateRecordButtonState();
          }).observe(document.body, { childList: true, subtree: true });

          setInterval(updateRecordButtonState, 800);
      }

      waitForBody();
  })();
  ```

  Self-review point for whoever implements this: with no bridge present (`readPcBridge()` returns `null`), `PC_MODE` stays `false` for the entire page lifetime after the 1.5s poll window closes, `ensureRecordButton()` takes the exact original standalone branch, and `updateRecordButtonState()` operates on `#scgm-record-btn` exactly as `updateRecordButtonVisibility()` did before — just toggling `disabled` instead of `display`. Confirm this by reading the diff side-by-side with the original block above.

- [ ] **Step 6: Verify**

  Run: `node --check cytube.gifmaker.user.js`
  Expected: no output (syntax OK).

  Read through the full modified file once to confirm: with `PC_MODE` false throughout (simulate: no `__SC_GIF_BRIDGE__` on `unsafeWindow`), every behavior matches the pre-change file — button in `#videocontrols`, ImgBB/Optimize panel UI present, `gifTitleSlug()` used for filenames.

- [ ] **Step 7: Commit**

  ```bash
  git add cytube.gifmaker.user.js
  git commit -m "Add PC_MODE bridge detection and branching to cytube.gifmaker.user.js"
  ```

---

### Task 3: Repoint pc.user.js's chat-seek GIF entry through the bridge, remove its own floating button creation

The moment pc.user.js stops creating its own GIF button and defers entirely to whatever gifmaker.user.js decided in Task 2. Small and surgical — this is the point to manually test "both scripts installed" before Task 4 makes the dependency irreversible (see Manual Verification at the end of this plan).

**Files:**
- Modify: `cytube.pc.user.js` (chat-seek menu ~lines 793-801, `addFloatingButtons()` ~lines 1919-1922)

**Interfaces:**
- Consumes: `unsafeWindow.__SC_GIF_BRIDGE__.openGifPanel`, set by gifmaker.user.js (Task 2, Step 5) once it boots.

- [ ] **Step 1: Hide "Create a GIF from here" when gifmaker.user.js isn't installed, repoint it through the bridge when it is**

  Find this exact block (currently lines 793-801):

  ```js
          const gifItem = document.createElement('button');
          gifItem.type = 'button';
          gifItem.className = 'sc-seek-item';
          gifItem.innerHTML = `<span class="sc-seek-main">◉ Create a GIF from here</span>`;
          gifItem.addEventListener('click', () => {
              hideChatSeekMenu();
              openGifPanel(targetSec);
          });
          menu.appendChild(gifItem);
  ```

  Replace with:

  ```js
          const gifBridge = unsafeWindow.__SC_GIF_BRIDGE__;
          if (gifBridge && typeof gifBridge.openGifPanel === 'function') {
              const gifItem = document.createElement('button');
              gifItem.type = 'button';
              gifItem.className = 'sc-seek-item';
              gifItem.innerHTML = `<span class="sc-seek-main">◉ Create a GIF from here</span>`;
              gifItem.addEventListener('click', () => {
                  hideChatSeekMenu();
                  gifBridge.openGifPanel(targetSec);
              });
              menu.appendChild(gifItem);
          }
  ```

- [ ] **Step 2: Remove pc.user.js's own floating GIF button creation**

  Find this exact block (currently lines 1915-1923, inside `addFloatingButtons()`):

  ```js
          document.addEventListener('fullscreenchange', () => {
              fsBtn.style.display = document.fullscreenElement ? 'none' : '';
          });

          const gifBtn = document.createElement('button');
          gifBtn.id = 'sc-gif-btn'; gifBtn.textContent = '◉'; gifBtn.title = 'Make a GIF of this scene';
          gifBtn.addEventListener('click', openGifPanel);
          document.body.appendChild(gifBtn);
      }
  ```

  Replace with:

  ```js
          document.addEventListener('fullscreenchange', () => {
              fsBtn.style.display = document.fullscreenElement ? 'none' : '';
          });
      }
  ```

  `#sc-gif-btn` is now created exclusively by `cytube.gifmaker.user.js` (Task 2) when it detects PC mode — same id, so `GAP_IDS` (`cytube.pc.user.js`, unchanged, does a fresh `getElementById` lookup every dim cycle) keeps working with zero changes.

- [ ] **Step 3: Verify**

  Run: `node --check cytube.pc.user.js`
  Expected: no output (syntax OK).

- [ ] **Step 4: Commit**

  ```bash
  git add cytube.pc.user.js
  git commit -m "Repoint pc.user.js's GIF entry points through the gifmaker bridge"
  ```

---

### Task 4: Delete the dead GIF implementation from `cytube.pc.user.js`

**This must run after Task 3** — Task 3 removes the only remaining callers of `openGifPanel` inside pc.user.js, so this deletion is what those edits were staged for.

The deletion is **not one contiguous block**: `_gifTitleSlug()` (the bridge's title provider, added by Task 1's bridge object and explicitly out of scope for deletion) sits physically in the middle of the GIF-capture code being removed, between the low-level capture/encode helpers and `openGifPanel` itself. There are two separate deletions in the JS, plus one in the CSS.

Because Tasks 1-3 already edited this file, absolute line numbers will have shifted — **use content search (Grep), not the line numbers below**, to relocate each anchor before deleting.

**Files:**
- Modify: `cytube.pc.user.js`

**Interfaces:**
- None — this task only removes code. `_gifTitleSlug()` (kept) and `validateImgbbKey()` (kept, used by the Settings-modal ImgBB Test button) are untouched.

- [ ] **Step 1: Delete the GIF-capture/encode helper functions (before `_gifTitleSlug`)**

  Grep for `GIF CAPTURE` to find the current line number of this comment block (as of this plan's authoring, line 833):

  ```js
      /* ==========================================================
         GIF CAPTURE
         Grab the last N seconds of the scene as an animated GIF.

         CyTube's on-page <video> has no crossOrigin attribute, so its
         canvas is tainted. Instead we spin up a hidden crossOrigin clone
         of the same mp4 URL (the server sends permissive CORS), seek it to
         the window start, play it through, sample frames to a canvas, and
         hand the frames to gif.js (Web-Worker encoder). The on-page video
         is never touched — the user keeps watching while it encodes.
      ========================================================== */
  ```

  This is the **start** of the region to delete. Read forward from here. The region ends immediately before this comment (as of authoring, line 1235 — do NOT delete this comment or the function below it):

  ```js
      // Filesystem/URL-safe slug of the currently playing movie, e.g. "Blade-Runner-1982".
      // Falls back to '' when no title has been detected yet.
      function _gifTitleSlug() {
  ```

  Delete every line from the `/* ====... GIF CAPTURE` comment's opening line through the blank line immediately preceding the `// Filesystem/URL-safe slug...` comment (i.e., delete up through and including the closing `}` of `grabPreviewFrame()` and the blank line after it — everything up to but not including the `// Filesystem/URL-safe slug...` comment). This removes: `getGifWorkerUrl`, `getGifCtor`, `getGifsicleCtor`, the caption-drawing helpers (`getCaptionMeasureCtx`, `wrapCaptionAtSize`, `applyCaptionCtxStyle`, `drawCaptionBlockAdvanced`, `drawCaptions`), `computeFrameGeometry`, `captureGifFrames`, `encodeGif`, `_revokeGifResult`, `getScrubClone`, `destroyScrubClone`, `GIF_DEBUG`/`_glog`, and `grabPreviewFrame` — none of these are referenced anywhere outside this region (confirmed by grepping each name against the rest of the file).

  **Preserve** the `// Filesystem/URL-safe slug...` comment and the `_gifTitleSlug()` function body immediately after it, unchanged:

  ```js
      // Filesystem/URL-safe slug of the currently playing movie, e.g. "Blade-Runner-1982".
      // Falls back to '' when no title has been detected yet.
      function _gifTitleSlug() {
          if (!lastMovieTitle) return '';
          const { title, year } = parseMovieFilename(lastMovieTitle);
          let slug = title.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
          if (year) slug += '-' + year;
          return slug;
      }
  ```

- [ ] **Step 2: Delete `_fmtClockTenths`, the GIF-panel-only constants, and `openGifPanel` itself (after `_gifTitleSlug`)**

  Immediately after `_gifTitleSlug()`'s closing `}` (preserved in Step 1), the next content is the region to delete in this step. It starts with a blank line followed by:

  ```js
      function _fmtClockTenths(sec) {
          sec = Math.max(0, sec);
          const m = Math.floor(sec / 60);
          const s = sec % 60;
          return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
      }

      const MIN_CLIP_GAP = 0.1;
      const MAX_CLIP_LEN = 10;
      const FILMSTRIP_MARGIN = 3;
      const FILMSTRIP_MIN_WINDOW = 12;
      const FILMSTRIP_EDGE_PAD = 1;
      const FILMSTRIP_TILES = 10;
      const OVERVIEW_NUDGE_SEC = 1;
      const OVERVIEW_NUDGE_SEC_FAST = 10;
      const SELECTION_EDGE_ZONE_PX = 20;
      const SELECTION_AUTOSCROLL_STEP = 0.2;
      const SELECTION_AUTOSCROLL_INTERVAL_MS = 100;

      function openGifPanel(initialSec) {
  ```

  ...and the entire `openGifPanel` function body follows (over 600 lines: panel construction, drag handling, caption preview wiring, filmstrip/overview scrubber logic, the Make-GIF click handler, upload wiring). It ends with:

  ```js
          ensureFilmstripWindow();
          render('both');
      }
  ```

  Immediately followed (not to be deleted) by:

  ```js
      function addFloatingButtons() {
  ```

  Delete every line from the blank line right after `_gifTitleSlug()`'s closing `}`, through and including `openGifPanel`'s closing `}` shown above (the one right before `function addFloatingButtons() {`). None of `_fmtClockTenths`, `MIN_CLIP_GAP`, `MAX_CLIP_LEN`, `FILMSTRIP_MARGIN`, `FILMSTRIP_MIN_WINDOW`, `FILMSTRIP_EDGE_PAD`, `FILMSTRIP_TILES`, `OVERVIEW_NUDGE_SEC`, `OVERVIEW_NUDGE_SEC_FAST`, `SELECTION_EDGE_ZONE_PX`, `SELECTION_AUTOSCROLL_STEP`, or `SELECTION_AUTOSCROLL_INTERVAL_MS` are referenced anywhere outside this region (confirmed by grep).

  `addFloatingButtons()` itself (already edited in Task 3 to drop its `gifBtn` creation) is untouched by this step.

- [ ] **Step 3: Delete the dead GIF button + GIF panel CSS**

  Grep for `GIF BUTTON (matches desync/fs circular style)` to find the current line number of this comment (as of authoring, line 5092):

  ```css
              /* ===== GIF BUTTON (matches desync/fs circular style) ===== */
              #sc-gif-btn {
  ```

  This is the start of the region to delete. It runs through the `#sc-gif-btn` rules (now duplicated in `cytube.gifmaker.user.js`'s `injectFloatingButtonCss()`, added in Task 2) and the entire "GIF PANEL" CSS section that follows it (all the `.sc-gif-*` panel/filmstrip/caption styling — dead now that the panel markup itself is gone). It ends at the blank line immediately before this comment (as of authoring, line 5410 — do NOT delete this comment or anything after it):

  ```css
              /* ===== HORIZONTAL LAYOUT (widescreen) ===== */
  ```

  Delete every line from the `/* ===== GIF BUTTON...` comment's opening line through the blank line immediately preceding `/* ===== HORIZONTAL LAYOUT (widescreen) ===== */`.

- [ ] **Step 4: Remove the now-unused `@require`/`@connect` header entries and update the description**

  `gif.js` (`@require`), `cdnjs.cloudflare.com`, and `cdn.jsdelivr.net` (both `@connect`) were only used by the code deleted in Steps 1-2 (`getGifCtor`/`GIF` global, `getGifWorkerUrl`, `getGifsicleCtor`). Confirm with:

  ```bash
  grep -n "GIF(\|getGifCtor\|getGifWorkerUrl\|getGifsicleCtor\|GIFSICLE_URL" cytube.pc.user.js
  ```

  Expected: no matches. `api.imgbb.com` stays — `validateImgbbKey()` (used by the Settings-modal ImgBB Test button, untouched by this plan) still calls it.

  Find this exact block in the userscript header:

  ```js
  // @description  Fullscreen layout, LanguageTool grammar, inline error editor, tab-complete, movie links, IMDb trivia & parent guide, right-click chat-to-movie seek, scene-to-GIF capture with meme captions + ImgBB upload, Tonight's Lineup schedule overlay, resizable chat panel, vertical monitor support
  // @match        https://cytu.be/r/420Grindhouse
  // @match        https://cytu.be/r/testing
  // @grant        GM_xmlhttpRequest
  // @require      https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.js
  // @connect      api.themoviedb.org
  // @connect      en.wikipedia.org
  // @connect      raw.githubusercontent.com
  // @connect      api.languagetool.org
  // @connect      caching.graphql.imdb.com
  // @connect      cdnjs.cloudflare.com
  // @connect      cdn.jsdelivr.net
  // @connect      api.imgbb.com
  // @connect      www.reddit.com
  ```

  Replace with:

  ```js
  // @description  Fullscreen layout, LanguageTool grammar, inline error editor, tab-complete, movie links, IMDb trivia & parent guide, right-click chat-to-movie seek, Tonight's Lineup schedule overlay, resizable chat panel, vertical monitor support, integrates with cytube.gifmaker.user.js when installed
  // @match        https://cytu.be/r/420Grindhouse
  // @match        https://cytu.be/r/testing
  // @grant        GM_xmlhttpRequest
  // @connect      api.themoviedb.org
  // @connect      en.wikipedia.org
  // @connect      raw.githubusercontent.com
  // @connect      api.languagetool.org
  // @connect      caching.graphql.imdb.com
  // @connect      api.imgbb.com
  // @connect      www.reddit.com
  ```

- [ ] **Step 5: Verify**

  Run: `node --check cytube.pc.user.js`
  Expected: no output (syntax OK).

  Then confirm no dangling references remain:

  ```bash
  grep -n "openGifPanel\|captureGifFrames\|encodeGif\|uploadToImgbb\|getGifCtor\|getGifWorkerUrl\|getGifsicleCtor\|GIF_WORKER_URL\|GIFSICLE_URL\|sc-gif-panel\|sc-gif-filmstrip" cytube.pc.user.js
  ```

  Expected: no matches, **except** the bridge object's `openGifPanel: undefined` property (from Task 1) — that reference is intentional and must remain.

- [ ] **Step 6: Commit**

  ```bash
  git add cytube.pc.user.js
  git commit -m "Delete cytube.pc.user.js's duplicated GIF Maker implementation"
  ```

---

### Task 5: Version bumps and final cross-file consistency pass

**Files:**
- Modify: `cytube.gifmaker.user.js` (header `@version`, boot `console.log`)
- Modify: `cytube.pc.user.js` (header `@version`, boot `console.log`)

- [ ] **Step 1: Bump `cytube.gifmaker.user.js` to 1.4.0**

  Find:

  ```js
  // @version      1.3.0
  ```

  Replace:

  ```js
  // @version      1.4.0
  ```

  Find:

  ```js
      console.log('[GIFMaker] cytube.gifmaker v1.3.0 loaded');
  ```

  Replace:

  ```js
      console.log('[GIFMaker] cytube.gifmaker v1.4.0 loaded');
  ```

- [ ] **Step 2: Bump `cytube.pc.user.js` to 4.9.0**

  Find:

  ```js
  // @version      4.8.0
  ```

  Replace:

  ```js
  // @version      4.9.0
  ```

  Find:

  ```js
      console.log('[SC] cytube.pc v4.8.0 loaded');
  ```

  Replace:

  ```js
      console.log('[SC] cytube.pc v4.9.0 loaded');
  ```

- [ ] **Step 3: Final consistency grep across both files**

  ```bash
  grep -n "LS_IMGBB\|LS_GIF_OPTIMIZE\|sc-gif-btn\|__SC_GIF_BRIDGE__" cytube.pc.user.js cytube.gifmaker.user.js
  ```

  Confirm:
  - `LS_IMGBB` / `LS_GIF_OPTIMIZE`: both scripts still declare their own copy of these constants pointing at the same string keys (`sc_imgbb_key`, `sc_gif_optimize`) — this is intentional, not a duplication bug; it's how the shared-localStorage pattern already works for these two keys.
  - `sc-gif-btn`: created only in `cytube.gifmaker.user.js` (`ensureRecordButton`'s `PC_MODE` branch); referenced (not created) in `cytube.pc.user.js`'s `GAP_IDS` array only.
  - `__SC_GIF_BRIDGE__`: written once in `cytube.pc.user.js` (Task 1); read in `cytube.gifmaker.user.js` (`readPcBridge`, Task 2) and `cytube.pc.user.js`'s chat-seek menu (Task 3).

- [ ] **Step 4: Run both syntax checks one more time**

  ```bash
  node --check cytube.gifmaker.user.js
  node --check cytube.pc.user.js
  ```

  Expected: no output from either.

- [ ] **Step 5: Commit**

  ```bash
  git add cytube.gifmaker.user.js cytube.pc.user.js
  git commit -m "Bump versions for GIF Maker / pc.user.js bridge consolidation"
  ```

---

## Manual Verification (not automatable — no agent in this pipeline has browser access)

Three scenarios, in a Tampermonkey dev profile against a live CyTube video (`420Grindhouse` or `testing`):

1. **`cytube.gifmaker.user.js` only** (pc.user.js disabled/not installed): button appears in `#videocontrols` exactly as before; panel works identically; ImgBB/Optimize fields are visible inline in the panel; generated filenames use the raw-title slug; the button is visible-but-disabled (not hidden) during YouTube playback.
2. **Both scripts installed**: the button is the floating `#sc-gif-btn` style (not in `#videocontrols`); it participates in the existing auto-dim-on-inactivity behavior; the panel's ImgBB/Optimize fields are hidden (Settings-modal fields still work and affect the same shared keys); generated filenames use the TMDB-aware slug; the chat right-click "Create a GIF from here" menu item still works; the button is visible-but-disabled during YouTube playback. Also test the late-load case (disable one script, reload, then re-enable and reload again in the other order) to exercise the bounded upgrade poll.
3. **`cytube.pc.user.js` only** (gifmaker.user.js disabled/not installed): the chat-seek menu no longer shows "Create a GIF from here" at all; console is clean (no errors from the missing bridge consumer); Settings-modal ImgBB/Optimize fields still read/write their shared keys correctly even though nothing currently consumes them.
