# Curated Pop-up Video Trivia — design & rollout plan

## Context

The `trivia-popup` module (`src/pc/modules/trivia-popup/index.js`) shows VH1 Pop-up Video–style bubbles, but its facts are only what IMDb has (often thin for obscure grindhouse titles), are popped at random per-viewer gaps, and use a randomly chosen icon. Goal: a weekly server-side generator (Docker on the user's Ubuntu box, using the Claude Code CLI on the user's subscription — no per-token API billing) that reads the r/420Grindhouse weekend schedule, researches each movie from many sources, writes short cited facts with a fitting icon and a playback time, and publishes them as JSON to a public GitHub repo. The userscript plays those facts on a fixed timeline synced across all viewers, falling back to today's IMDb trivia when a movie has no curated file. A standalone Pop-up Video userscript comes last.

Decisions made with the user: standalone targets stock CyTube on the same channel; auto-publish but every fact must be cited (uncited dropped); fixed synced timeline; Approach A (Node orchestrator + per-movie `claude -p`); single new repo for code + data; maximize sources; standalone built last.

**Build order (each its own implementation plan via writing-plans, Subagent-Driven execution):**
1. Data contract + `trivia-popup` integration (this repo) — tested with a hand-written sample JSON.
2. Generator service (new repo `spudzareneat/grindhouse-popup-trivia`, must be **public** so raw.githubusercontent works unauthenticated — confirm with user before creating).
3. Standalone `cytube.popupvideo.user.js`.

First action after approval: save this design as `docs/superpowers/specs/2026-10-03-curated-popup-trivia-design.md`, commit **only that file** (working tree has unrelated WIP — stage by path), ask user to review, then invoke writing-plans for sub-project 1.

---

## 1. Data contract

`data/<imdbId>.json` in the new repo, served at `https://raw.githubusercontent.com/spudzareneat/grindhouse-popup-trivia/main/data/<id>.json`. 404 = not curated.

```json
{
  "schema": 1, "imdbId": "tt0055830", "title": "Carnival of Souls", "year": 1962,
  "runtimeSec": 4680, "generatedAt": "2026-10-03T09:00:00Z",
  "facts": [
    { "t": 312, "rank": 1, "anchor": "scene", "text": "…", "icon": "camera",
      "byline": null, "source": { "type": "web", "url": "https://…" } }
  ]
}
```

- `t` seconds into movie; `anchor` `scene` (known moment) | `spread` (filler placement); `rank` 1–3 (1 best).
- `source.type`: `imdb | driveintotals | wikipedia | wikidata | tmdb | transcript | web | interview`; `web`/`interview` require `url`.
- `text` ≤ 200 chars. No fact before 60s, ≥45s spacing, ~1 per 2–3 min.
- Frequency setting in timeline mode = rank filter: Frequent all, Occasional ≤2, Rare 1 (deterministic → viewers on the same setting stay synced).
- Icons: named set. Existing 14 SVGs renamed: `skull, tombstone, reel, saucer, alien, rocket, robot, radioactive, explosion, crosshair, knuckles, disco, boombox, sunglasses`. New (same black/red/bone + accent style): `joebob` (drive-in speaker), `money`, `camera`, `star`, `link`, `mic`, `censor`, `trophy`. Unknown key → random icon (forward-compatible).
- No index file (YAGNI).

## 2. `trivia-popup` integration (this repo) — sub-project 1

File: `src/pc/modules/trivia-popup/index.js` (+ `style.css` if icon sizing needs it).

- On movie change, `_tpResetForNewMovie(id)` first GM-fetches the curated JSON (session cache, same pattern as `_triviaCache` in `imdb-trivia`). Valid → **timeline mode**, skipping the IMDb/cast/known-for queue (generator already folded those in). 404/error/bad schema → existing path unchanged.
- Timeline mode driven by the existing `TP_POLL_MS` heartbeat reading `getPlayerVideoEl().currentTime` (core/12-playback-sync-and-seek.js): fire fact when playback crosses `t`, passes rank filter, not in seen-set (`_tpMarkSeen`/`_tpLoadSeenTexts` reused), and `currentTime ∈ [t, t+20s]`. Seek/late join skips past facts (no burst); pause delays. Existing gates (`popupTriviaEnabled`, `_tpMovieIsPlaying`, `document.hasFocus`) still apply.
- `TP_ICONS` array → named map; `showTriviaBubble(fact)` uses `fact.icon` when present, random otherwise. Keep `_tpRandomPosition`, pop sound, mute button as-is.
- Isolate loader + timeline scheduler + icon map into a self-contained block with no TV-UI dependencies (reused by the standalone in sub-project 3). Set a DOM marker (`data-sc-trivia-popup="1"` on `<html>` — not a window global, since Tampermonkey sandboxes each script's `window`) so the standalone can stand down.
- Update the frequency setting's `note` to explain rank filtering for curated movies.
- Tests: `scripts/test-trivia-timeline.mjs` (pattern of `scripts/test-emote-cache.mjs`) — crossing `t`, seek skip, rank filter, seen-dedup, schema validation/fallback. Live test with a hand-written sample JSON for one movie served from a branch of the new repo (or a gist) via a dev-only URL override.
- Bump version in both `src/pc/manifest.json` and `docs/manifest.json` on every testing rebuild (Tampermonkey won't reload otherwise).

## 3. Generator service (new repo) — sub-project 2

Node 22, no framework. Pipeline per run:

1. **Schedule** — fetch `https://www.reddit.com/r/420Grindhouse/.rss`; port `lineupParseEntries`, `lineupSelectCurrentEntry`, `lineupParseSchedule`, `lineupParseListItems`, `lineupDecodeHtmlEntities` from `src/pc/modules/tonights-lineup/index.js`.
2. **Resolve** title/year → tconst via IMDb GraphQL search (reuse query style from imdb-graphql-access memory). Skip if `data/<tt>.json` exists (unless `--force`); skip TV episodes.
3. **Gather (deterministic, free)** into a research bundle:
   - IMDb GraphQL: trivia, goofs, quotes, **connections** (references/spoofs/remakes/featured-in), alternate versions, crazy credits, soundtrack, filming locations, runtime, top cast + director with person trivia & known-for (queries from `trivia-popup`'s `fetchCastAndDirector`/`fetchPersonTrivia`/`fetchPersonKnownFor`).
   - Wikidata by IMDb id (P345): locations, budget/box office, based-on, follows/followed-by/remake-of, awards.
   - English Wikipedia article (via Wikidata sitelink), full text.
   - Drive-In Totals: CSV from `spudzareneat/DriveInTotals` `drivein_totals.csv` (`title,year,description`), matched on normalized title+year; split into several `joebob` pops, sign-off placed near end.
   - Joe Bob host transcripts from `driveintotals_scrapers/transcripts` (optional volume mount).
   - TMDB keywords/collection (optional `TMDB_API_KEY`).
4. **Research + write** — `claude -p` with only WebSearch/WebFetch allowed, JSON-only output. Prompt includes bundle, schema, icon list, citation rule, timestamp hunting, 15–40 fact target, no duplicates, and suggested sources: AFI Catalog, Media History Digital Library/Lantern (trade papers), Library of Congress NFR essays, TCM articles, rogerebert.com/period reviews, Blu-ray reviews describing commentaries, interviews, Fandom wikis (Last Drive-In, franchise wikis), Reddit threads (leads only, need better cite), BBFC/Video Nasties, The Numbers/Box Office Mojo, movie-locations.com, MST3K/RiffTrax/Trailers From Hell, Temple of Schlock, Kim Newman, Mondo Digital.
5. **Validate** — schema check; drop uncited/too-long/unknown-icon facts; enforce spacing; clamp `t` to runtime; sort. <5 good facts → one retry.
6. **Publish** — one commit per movie, push via deploy key.

Runtime: Dockerfile (node:22-slim + `npm i -g @anthropic-ai/claude-code` + git + supercronic); `.env`: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), `TMDB_API_KEY?`, `GIT_REMOTE`; deploy key mounted read-only. Cron Thu & Fri 03:00 local; movies processed sequentially with delay. CLI: `run`, `movie <tt|title>`, `--dry-run`, `--force`. Logs to stdout + end-of-run summary.

Errors: per-movie failure logged and skipped; feed failure → non-zero exit (next cron retries); CLI usage-limit → stop cleanly, finished movies already pushed.

Tests: fixture tests for RSS parser, resolver, Totals matcher, validator (good / uncited / bad icon / overlapping t). Claude call behind one function so it can be stubbed.

## 4. Standalone `cytube.popupvideo.user.js` — sub-project 3 (last)

- Generated, not hand-maintained (README marks hand-maintained standalones legacy): new `scripts/build-popupvideo.mjs` reusing `scripts/assemble.mjs` to concat `src/popupvideo/shim.js` (provides `getKey`, `_escHtml`, `scRegisterInit`, no-op `scRegisterSetting`, chat-width helpers returning 0) + movie identity (`core/01-movie-identity.js` + title→IMDb lookup from `movie-title-links`), `imdbQuery`, `fetchImdbTrivia`, video/YouTube helpers, and the shared popup engine. Plan phase decides exact file set; split tangled functions into shared small files rather than copying.
- Same timeline + IMDb fallback; bubbles placed over the video only; one floating "● Pop-ups" button (click = mute, gear = frequency) using the module's localStorage keys.
- Stands down if `<html data-sc-trivia-popup="1">` is present.
- Header: same `@match` list as other scripts, `@grant GM_xmlhttpRequest`, `@connect caching.graphql.imdb.com`, `@connect raw.githubusercontent.com`, update URLs. README install entry.

## Verification

- Sub-project 1: `node scripts/test-trivia-timeline.mjs` passes; `node scripts/build-dev-bundle.mjs` builds; live in browser on cytu.be: curated sample movie → bubbles fire at their `t` with named icons, seek skips, frequency filters by rank, reload doesn't repeat; uncurated movie → old IMDb behavior unchanged.
- Sub-project 2: unit tests pass; `docker compose run generator movie tt0055830 --dry-run` produces a valid file; full `run --dry-run` on the live feed; then a real push and the userscript picks it up.
- Sub-project 3: build emits the file; clean Tampermonkey profile on stock CyTube shows both modes; with full script also installed, only one bubble stream appears.
