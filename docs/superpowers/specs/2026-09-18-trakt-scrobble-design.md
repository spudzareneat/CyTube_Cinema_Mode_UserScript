# Trakt Scrobble module — design

Date: 2026-09-18 · Status: approved in chat, pending written-spec review

## Goal
An opt-in `trakt-scrobble` module for the PC userscript (`src/pc/`). When a viewer reaches the end of
a movie, a slick panel offers to log the viewing on trakt.tv, with an optional 1–10 rating. All
configuration — enable toggle, Trakt app keys, trigger threshold — lives in the existing Settings
modal (localStorage via `getKey`/`setKey`, like the TMDB and ImgBB keys). Nothing is hard-coded and no
key ships in the script.

## Decisions (agreed with the user)
- **Scope:** movies only. YouTube items and TV episodes are skipped.
- **Panel:** Scrobble / Not now, plus an optional 1–10 star rating sent with the watch.
- **Trigger:** playback progress reaching a threshold, default 90% of runtime, configurable.
- **"Config":** the Settings modal (runtime, per-user). The build customizer only decides whether the
  module is included in the bundle; the feature itself stays off until enabled in Settings.

## Architecture

### API usage
- One-shot `POST /sync/history` with `{ movies: [{ ids: { imdb }, watched_at }] }`, then
  `POST /sync/ratings` if a rating was chosen. All calls via `GM_xmlhttpRequest` to `api.trakt.tv`
  with headers `Content-Type: application/json`, `trakt-api-version: 2`, `trakt-api-key: <client id>`,
  and `Authorization: Bearer <access>` where required.
- Rejected: the live `/scrobble/start|pause|stop` session model. The prompt is after-the-fact, so
  start/pause tracking adds nothing, and `/scrobble/stop` carries its own >=80% and 409-on-repeat
  semantics. Deduplication is handled locally instead (see Trigger).

### Auth — device-code flow
1. `POST /oauth/device/code {client_id}` → `device_code`, `user_code`, `verification_url`,
   `expires_in`, `interval`.
2. Panel shows the code and a link to trakt.tv/activate; poll `POST /oauth/device/token
   {code, client_id, client_secret}` every `interval` seconds until success, expiry or Cancel.
3. Store `{ access, refresh, expiresAt, clientId }` as JSON in localStorage (`sc_trakt_token`).
4. Refresh via `POST /oauth/token` (grant_type `refresh_token`) when within one day of `expiresAt`,
   or once on a 401. If the stored `clientId` differs from the current setting, discard the token.
- The user supplies their own Trakt app **Client ID + Client Secret** (Settings). Connecting happens
  inline in the panel; no new settings row type is needed.
- Same visibility caveat as existing keys: values sit in page localStorage.

### Files
- **New:** `src/pc/modules/trakt-scrobble/index.js`, `style.css` — modeled on `trivia-popup`
  (heartbeat poll, `scRegisterInit`, `scRegisterSetting`, `injectCSS`). `LS_*` constants are declared
  in the module file, not in `core/02-keys-and-helpers.js`.
- **`src/pc/manifest.json`:** module `trakt-scrobble` — `category: "Movie Info"`, `defaultOn: true`,
  `dependsOn: ["core", "movie-title-links"]` (needs `_currentImdbId` / `_npData`),
  `grants: ["GM_xmlhttpRequest"]`, `connects: ["api.trakt.tv"]`, a `features[]` list, and a note that
  it is off by default in Settings.
- **`docs/manifest.json`:** mirror the module entry as other modules are mirrored; bump `baseVersion`
  4.13.18 → 4.13.19 in **both** manifests (Tampermonkey only reloads the dev script on a version
  change); rebuild with `scripts/build-dev-bundle.mjs`. Check `docs/customizer.js` for anything
  per-module that needs a matching entry.
- **`src/pc/core/15-settings-modal-shell.js`:** one-line change in `textRowHtml` —
  `type="${r.mask ? 'password' : 'text'}"` — so the Client Secret row can set `mask: true`.
  This file has uncommitted edits already; keep the change surgical.

### Settings rows (registered with `scRegisterSetting`, `order` 13+; 12 is imdb-link-preview)
| id | type | storage key | notes |
|---|---|---|---|
| `sc-input-trakt-enabled` | checkbox, opt-in (`'on'`) | `sc_trakt_enabled` | master toggle, default off |
| `sc-input-trakt-clientid` | text + Test button | `sc_trakt_client_id` | Test = `GET /movies/trending?limit=1` with `trakt-api-key`: 200 valid, 401/403 invalid, network error → error message. Link to trakt.tv/oauth/applications |
| `sc-input-trakt-secret` | text, `mask: true` | `sc_trakt_client_secret` | used for device-token exchange and refresh |
| `sc-input-trakt-threshold` | number 50–100, default 90 | `sc_trakt_threshold` | percent of runtime that triggers the panel; clamped like the Movie Lead Time field |

### Trigger logic
A heartbeat (~3 s, poll-per-use like `trivia-popup`, so toggling the setting takes effect
immediately) shows the panel once when **all** hold:
- feature enabled in Settings;
- `!isYouTubeMedia()`;
- `_currentImdbId` is set;
- `getPlayerVideoEl()` reports finite `duration >= 10 min` (guards against shorts and bumpers) and
  `currentTime / duration >= threshold`;
- the imdbId was not already handled within the last 12 h (fixed TTL from the moment the panel was shown).

Dedupe state is one slot in localStorage, `sc_trakt_prompted` = `{ imdbId, ts, outcome }`
(`outcome`: `shown` | `scrobbled` | `skipped`). Reloads or re-joins during the credits therefore do
not re-prompt; a rewatch the next day does. At trigger time a snapshot `{ imdbId, title, year, poster }`
is taken from `_npData`, so a queue advance while the panel is open cannot corrupt the submission.
Late joiners and seekers still trigger the panel (they can choose "Not now"); this is deliberate.

### Panel (`#sc-trakt-panel`)
Deliberately **not** the VH1 pop-up-video look of `trivia-popup`. A quiet, modern card:
- **Placement:** anchored to the bottom-right corner of the video area (positioned inside the player
  wrapper, with a small inset), not the browser viewport, so it sits on the picture and follows
  resizes/fullscreen of the player. Falls back to viewport bottom-right if the wrapper is not found.
- **Look:** dark (~`rgba(14,14,18,0.78)`), semi-transparent with `backdrop-filter: blur`, a hairline
  light border, soft shadow, ~12px radius, light text. Clean system UI font stack
  (`"Inter", "Segoe UI", system-ui, -apple-system, sans-serif`) — no comic/display fonts. One restrained
  accent colour for the primary button and the selected stars. Gentle fade/slide-in, fade-out on close.
- **Lifetime:** stays on screen for **60 seconds**, then fades out on its own. A thin progress line
  along the bottom edge counts the minute down. The countdown pauses while the pointer is over the
  card or while it is in the connect / submitting states, so it never disappears mid-action. An
  auto-dismiss records outcome `shown` (so it will not re-prompt within the TTL); "Not now"/Esc record
  `skipped`.

States:
- **prompt** — poster, title/year, "Log this on Trakt?", 10-star row (clicking the selected star
  clears it), [Scrobble to Trakt] [Not now], and a small "Disconnect" link that clears the token.
- **submitting** → **success** ("Logged ✓" + link to the Trakt movie page, auto-dismiss ~6 s) or
  **error** (message + Retry).
- **needs-config** — enabled but Client ID/Secret missing: short message pointing to Settings.
- **connect** — large device code, trakt.tv/activate link, expiry countdown, Cancel. On success it
  continues straight into the pending scrobble.
- **not found** — Trakt returns a non-empty `not_found.movies`: "Trakt couldn't match this movie",
  no retry.
"Not now" or Esc records outcome `skipped`; the success state auto-dismisses after ~6 s (the 60 s
lifetime applies to the prompt state).

## Testing
- Pure helpers sit between `// ── test marker: … ──` comments (repo convention; there is no runner)
  and are exercised by a new `scripts/test-trakt-scrobble.mjs`, run with `node`, in the style of
  `scripts/test-imdb-link-preview.mjs`:
  - `shouldPrompt({...})` — threshold, minimum duration, TTL, already-handled cases;
  - `tokenNeedsRefresh(token, now)`;
  - `buildHistoryPayload(snapshot, rating, now)`;
  - `interpretSyncResponse(json)` — added vs. `not_found`.
- Manual, using the dev bundle on `cytu.be/r/testing`: enable + keys → Test button valid/invalid;
  seek a movie to 91% → panel appears; full connect flow against a real Trakt app; the watch (and
  rating) show up in trakt.tv history; reload at 95% → no re-prompt; YouTube item → nothing;
  toggling the setting off mid-movie → nothing.

## Out of scope (v1)
TV episodes, YouTube items, live start/pause scrobbling, verifying real watch time, per-movie or
global "don't ask again", check-in, watchlist sync.

## Implementation notes
Execute Subagent-Driven (the user's standing default). Subagents must verify `pwd`, HEAD and branch
first. Beyond the surgical settings-shell edit and the manifest additions, do not touch the files that
already have uncommitted changes.

## Addendum (2026-09-19)
Settings section, connection test and a manual card.
- **Settings section.** The four Trakt rows are now one "Trakt" section, orders 13-18: a section
  header (13), the enable toggle (14), Client ID (15), Client Secret (16), a "Test connection"
  action row (17) and the prompt-point threshold (18). The old per-field Test button on the Client
  ID row is gone.
- **Shell row types.** The shared settings shell gained two generic row types: `section` (a header
  with a label and note) and `action` (a button with a status line and a detail area under it; the
  handler receives `{ getValue, setStatus, setDetail, isOpen }`, and an optional cancel handler
  turns the button into Cancel while it runs). Save ignores both.
- **Connect & verify.** The button saves the typed Client ID and Secret, then validates the Client ID
  against a public endpoint. If a stored token is usable and `/users/settings` answers with a
  username it stops at "Connected as <name>". Otherwise it starts a device sign-in: the code and the
  activate link appear under the button, the status counts down the code's lifetime, and the poll
  stops on Cancel or when Settings is closed. It ends with connected / denied / expired / "check the
  Client Secret" / cancelled. A non-https `verification_url` falls back to trakt.tv/activate.
- **Alt+S manual card.** The hotkey (bare Alt+S, works while typing in chat, needs the feature
  enabled) opens the card for the current movie regardless of the threshold or the 12 h TTL, and
  pressing it again closes the card. A manual card writes nothing to the already-handled slot,
  except `'shown'` when the movie is already past the prompt point (so Esc doesn't let the auto card
  re-pop) and `'scrobbled'` after a successful log. "Skip" on a manual card records nothing. With no
  IMDb match yet the card says "No movie matched yet"; without keys it shows the needs-config view.
