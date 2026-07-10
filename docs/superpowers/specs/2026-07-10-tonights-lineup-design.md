# Tonight's Lineup (Coming Attractions) — PC userscript port

Date: 2026-07-10
Source: ported from the Android app at `C:\Repos\android_GrindhouseTV\web\src\lineup\` (`reddit.js`, `data.js`, `screen.js`, `sectionThemes.js`)

## Goal

Replace the PC script's current "Coming Attractions" button — which just toggles a strip of static admin-curated MOTD poster images — with a live weekend lineup scraped from r/420Grindhouse, matching the richer experience already shipped in the Android app: day tabs (Fri/Sat/Sun), themed sections, now-playing highlight, and ETA countdowns for upcoming films.

## Architecture

Four new sections added to `cytube.pc.user.js`, following the file's existing block-comment-per-feature convention. This is a single monolithic userscript with no build step — new code is inlined, not split into separate files/modules like the Android app.

### 1. Reddit Schedule Fetch & Parse
Port of `reddit.js`'s pure parsing functions (`parseFirstEntry`, `parseDateRange`, `parseListItems`, `parseSchedule`) essentially verbatim — they have no DOM/native dependency. `fetchTonightsSchedule()` is rewritten to fetch via `GM_xmlhttpRequest` (wrapped in a promise, matching the existing call-site pattern at lines 715/866/1355/1390/1940/1958) instead of the app's `nativeHttpGet`. Requires adding `// @connect www.reddit.com` to the userscript header (alongside the existing `@connect` list at lines 10-16).

### 2. Lineup Data
Port of `data.js`'s caching/ETA logic (`ensureSchedule`, `refetchAndCache`, `fallbackView`, `buildDaySections`, `getTonightsLineup`), rewired to this script's existing primitives instead of the app's separate modules:
- `lookupMovie(title, year)` (line 1448) instead of the app's `tmdb.js` — already returns `killCount`/`parentalGuide`/`poster`/`backdrop`/`overview`/`rating`/`runtime`/`genres`.
- `lastMovieTitle` (line 1343) + `parseMovieFilename()` (line 1252) instead of `movieState.lastMovieTitle`.
- `getCurrentMediaSeconds()` (line 1327, media duration) + `getPlayerTimeSec()` (line 600, live playhead) instead of the app's `mediatime.js` pair.
- The existing `changeMedia` socket handler (`initMediaWatcher`, line 1774) is extended to also feed the bumper-gap learning logic (an unmatched `changeMedia` title vs. tonight's schedule = a bumper; the gap between it and the next `changeMedia` is one learned sample), same approach as the app's `onSocket('changeMedia', ...)` in `data.js`.
- Cache key: `sc_lineup_cache_v1` in `localStorage`, matching this script's existing `sc_` prefix convention (`LS_TMDB`, `LS_MOVIE_LINKS`, etc. at lines 28-32).

### 3. Lineup Screen
New full-screen overlay (chosen over an enhanced bottom strip): close button, day tabs (Fri/Sat/Sun), sections stacked with native page-scroll (no D-pad paging needed — this is mouse/keyboard, unlike the Android TV mode). Each item is a poster tile; clicking it calls the *existing* `showNowPlayingCard()` (line 1566) — no new detail-card UI needed, it already renders poster/backdrop/overview/rating/runtime/genres/parentalGuide/killCount chips.

The existing "Coming Attractions" button (`toggleBtn`, line 2372) switches from toggling `initPosterStrip()`'s strip to opening/closing this overlay. `initPosterStrip()`'s MOTD-image extraction logic is kept and reused as the fallback source (see below), but its strip-toggle UI is retired.

### 4. Section Themes
Small color/font-per-slug map, ported from `sectionThemes.js`, keyed by the same slugified section names (`slugify()` in `reddit.js`, ported alongside it). Confirmed in brainstorming: per-section theming is wanted, matching the Android app's visual identity.

## Data flow

1. Click **Coming Attractions** → `showLineupScreen()` renders a loading state and calls `getTonightsLineup()`.
2. `ensureSchedule()` checks `localStorage['sc_lineup_cache_v1']`; if missing/stale (>20h old), fetches the Reddit `.rss` feed via `GM_xmlhttpRequest`, parses it, and caches the result.
3. `getTonightsLineup()` builds per-day/section items: looks up each film via `lookupMovie()`, marks "now playing" by matching `lastMovieTitle` against today's schedule, and computes ETA labels for the next 4 upcoming films using TMDB runtime + learned median bumper-gap, anchored at that day's Noon-Pacific start (`dayAnchorPacific`/`medianGapSeconds`, ported from the app's `timing.js`).
4. The overlay renders day tabs (defaulting to today) and that day's sections stacked, each themed per section slug.
5. Clicking a poster opens `showNowPlayingCard()` with that film's full data.

## Error handling / fallback

If Reddit is unreachable and no usable cache exists: show one flat, unsectioned row containing the current title (if `lastMovieTitle` looks like a real feature — same "skip if TMDB confidently found nothing" heuristic the app uses) plus whatever `initPosterStrip()`'s existing MOTD-image scan finds. This is a strict superset of today's behavior — worst case looks like what the script already does now, just inside the new overlay shell instead of the old strip.

## Testing

This repo has no test runner or build step — just standalone `.mjs` probe scripts (`imdb-*-test.mjs`) run manually for one-off verification, no `package.json`. No new test infra will be introduced. The Reddit parser functions are pure and could theoretically get `node --test` coverage like the Android app has, but that's new infra out of scope here. Verification: fetch a real live feed sample through the parser and manually check output, then exercise the full overlay in a real CyTube session (day tabs, now-playing highlight, ETA labels, click-through to the now-playing card, and the offline/no-cache fallback path).

## Out of scope

- TV-style D-pad section paging (`stepLineupSection` in the app) — PC has no D-pad, native scroll covers this.
- Making the subreddit source configurable — hardcoded to r/420Grindhouse, matching the Android app and this script's own audience.
- Changing the "Coming Attractions" button's label/position — only its click behavior changes.
