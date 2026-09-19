# Simkl Scrobble module — design

Date: 2026-09-19 · Status: implemented on `feat/simkl-scrobble` (live browser testing pending)

Supersedes `2026-09-18-trakt-scrobble-design.md`. The module is the same end-of-movie "log this?" card
(`src/pc/modules/simkl-scrobble/`); only the service behind it changed.

## Why
Around 2026-07-30 Trakt made API-app creation VIP-only and disabled apps created on free accounts, so a
free user can no longer get a Client ID/Secret. Simkl still offers free app registration, so the module
was switched to Simkl rather than kept on a dead path.

## What Simkl gives us
- **Free app registration** at simkl.com/settings/developer (app type "TV, devices & command line").
- **Device-code sign-in needs only the Client ID** (`POST /oauth2/device`, poll `POST /oauth2/token`); no
  client secret exists anywhere in the script or in Settings.
- **Tokens:** access token about 7 days, refresh token about 180 days; refreshed when within a day of expiry
  or once on a 401.
- **One call logs and rates:** `POST /sync/history` with `{ movies: [{ ids: { imdb }, watched_at, rating? }] }`.
  Simkl allows 1 POST per second and 500 requests per day on free accounts, so the rating rides in the
  same call and a POST that follows a refresh or a 429 waits about a second first.
- **Already watched = no-op:** a movie already in the user's history comes back with `added.movies` 0 and
  nothing in `not_found`. That is treated as success ("Already on your Simkl history").
- **Deep link:** `GET https://api.simkl.com/redirect?to=simkl&imdb=tt…&client_id=…&app-name=…&app-version=…`
  301-redirects to the movie's simkl.com page (no token needed); it backs the "View on Simkl" link.
- **API rules we follow:** requests are user-initiated only (the card asks first; nothing is sent in the
  background), and the "View on Simkl" link is the required attribution.

## Decisions (agreed with the user)
- **Replace Trakt**, don't support both.
- **Client ID entered in Settings only** — no built-in default ID, no secret.
- **No Letterboxd export** for now (see findings below).
- Unchanged from the Trakt design: opt-in, movies only, default 90% prompt point, Alt+Shift+S manual card,
  poll-per-use settings, 12 h "already handled" slot.
- Hotkey is Alt+Shift+S (bare Alt+S is Firefox's History-menu accelerator).

## Letterboxd findings
Letterboxd's API is private / by request only, and the community tools around it are fragile HTML
scrapers. Its official CSV import accepts `imdbID` + `WatchedDate`, so a possible later addition is a
local watch log in the script plus an "Export CSV for Letterboxd" button. Not built.

## Layout
- `simkl-helpers` slice (pure, unit-tested): thresholds, eligibility, token math, `/sync/history` payload and
  reply interpretation, `simklAuthQuery`, `simklItemUrl`, `simklVerificationLink` (https-only sign-in link).
- `simkl-client` slice (tested with a fake `GM_xmlhttpRequest`): requests, token store, device auth, submit,
  Connect & verify. Tests: `scripts/test-simkl-scrobble.mjs`.
- Panel, heartbeat and the five Settings rows (order 13–17: section, enable toggle, Client ID,
  Test connection, threshold) sit outside the slices.
- Manifest: `grants` `GM_xmlhttpRequest` + `GM_info` (app-version / User-Agent), `connects` `api.simkl.com`.

## Known limits
- Free accounts can't log rewatches: `allow_rewatch` is PRO/VIP only, so a second watch of a logged movie
  shows as "Already on your Simkl history".
- Simkl asks for a `User-Agent`; whether `GM_xmlhttpRequest` really sends ours is unverified until a live
  test. The `app-name` / `app-version` query parameters carry the same identity either way.
- Simkl has no deny signal in the device flow: declining just leaves the code pending, so the card (and the
  Settings test) time out on their own when the code expires.
- Live browser testing (Connect & verify, a real end-of-movie log, the deep link) is still to do.
