# Tonight's Lineup (Coming Attractions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the PC userscript's static "Coming Attractions" poster strip with a live weekend lineup scraped from r/420Grindhouse — day tabs, themed sections, now-playing highlight, and ETA countdowns — ported from the Android Grindhouse app.

**Architecture:** Everything lands in the single existing file `cytube.pc.user.js` (a monolithic Tampermonkey userscript, no build step, no ES modules). Four new comment-delimited sections are added — Reddit Fetch & Parse, Section Themes, Lineup Data, Lineup Screen — reusing this script's *existing* `lookupMovie()`, `showNowPlayingCard()`, `lastMovieTitle`, `parseMovieFilename()`, `getCurrentMediaSeconds()`, and `getPlayerTimeSec()` instead of duplicating them. The existing "Coming Attractions" button is rewired from toggling a strip to opening/closing the new full-screen overlay.

**Tech Stack:** Vanilla JS (ES2020+), `GM_xmlhttpRequest` (Tampermonkey), `localStorage`, no test framework (Node's built-in `assert` used for one-off verification of pure functions, matching this repo's existing `working/*-test.mjs` probe convention).

## Global Constraints

- Single-file architecture: all new code goes inline into `cytube.pc.user.js`, following its existing block-comment-per-feature convention. No new files except one throwaway verification probe in `working/`.
- `localStorage` keys use the `sc_` prefix (existing convention: `LS_TMDB = 'sc_tmdb_key'`, etc.). The lineup cache key is `sc_lineup_cache_v1`.
- Subreddit source is hardcoded to `r/420Grindhouse` — not configurable (matches the Android app and this script's own `@match` targets).
- No TV/D-pad paging (`stepLineupSection` from the Android app is out of scope) — PC sections stack with native scroll.
- Per-section color/font theming is wanted (confirmed in brainstorming) — port `sectionThemes.js` as-is.
- No new test runner/build step is introduced — this repo has none today. Pure-function logic is verified with a standalone Node script using `assert` from the standard library.
- New global identifiers that are generic English words (`slugify`, `formatEta`, `buildBase`/`buildItem`, `fallbackView`, `decodeHtmlEntities`) are prefixed `lineup*` to avoid collisions in the 4000+ line single-scope IIFE. More distinctive names (`fetchTonightsSchedule`, `getTonightsLineup`, `showLineupScreen`, `hideLineupScreen`, `getSectionTheme`, `getMotdPosterImages`) are left unprefixed — confirmed via grep that none of these names currently exist in the file.
- Indentation inside the IIFE is 4 spaces per level; all new code must match.

---

### Task 1: Reddit schedule fetch + parse + timing helpers

**Files:**
- Modify: `cytube.pc.user.js` (header, and new section before the `POSTER STRIP` comment block)
- Create: `working/lineup-parse-verify.mjs`

**Interfaces:**
- Consumes: `GM_xmlhttpRequest` (already granted in the userscript header)
- Produces: `fetchTonightsSchedule(): Promise<{postId, title, publishedAt, days: [{day, sections: [{name, slug, items: [{title, year, display}]}], date}]}>`, `lineupFormatEta(hour24, minute, precision): string`, `lineupMedianGapSeconds(observedGaps: number[]): number|null`, `lineupDayAnchorPacific(dateStr: string): Date`, `lineupPacificDateString(now?: Date): string` — all consumed by Task 3.

- [ ] **Step 1: Add the Reddit connect permission to the userscript header**

In `cytube.pc.user.js`, find the `@connect` list (currently lines 10-16):

```
// @connect      api.themoviedb.org
// @connect      en.wikipedia.org
// @connect      raw.githubusercontent.com
// @connect      api.languagetool.org
// @connect      caching.graphql.imdb.com
// @connect      cdnjs.cloudflare.com
// @connect      api.imgbb.com
```

Add a new line after `api.imgbb.com`:

```
// @connect      www.reddit.com
```

- [ ] **Step 2: Insert the new "TONIGHT'S LINEUP — Reddit Fetch & Parse" section**

Find this comment block (currently around line 2148):

```
    /* ==========================================================
       POSTER STRIP — toggle show/hide the MOTD poster images
    ========================================================== */
```

Immediately **before** it, insert (4-space base indentation, matching the surrounding IIFE):

```js
    /* ==========================================================
       TONIGHT'S LINEUP -- Reddit schedule fetch + parse.
       r/420Grindhouse's Atom feed (https://www.reddit.com/r/420Grindhouse/.rss) is
       reachable with a browser UA and no login (the .json endpoints 403 the same
       way generic bots get blocked elsewhere; .rss doesn't). The pinned schedule
       post sorts FIRST in the feed regardless of nominal sort order -- "find this
       week's post" is just "take entry #1", no slug/title matching needed.

       The post body is a fixed markdown->HTML shape: an intro paragraph, then
       repeating <p><strong>Day</strong></p> headers (Friday/Saturday/Sunday, a
       closed 3-name set) each followed by 2-4 <p><strong>Section Name</strong>
       </p> + <ul><li>Title (Year)</li>...</ul> pairs. Two independent layers of
       HTML-entity escaping are present: the Atom feed XML-escapes the whole
       content blob, and Reddit's own markdown renderer separately entity-encodes
       special characters (apostrophes, etc.) within it -- lineupDecodeHtmlEntities
       is applied once, up front, so everything downstream works on plain text/tags.
       Ported from the Android Grindhouse app's web/src/lineup/{reddit,timing}.js.
    ========================================================== */

    const LINEUP_FEED_URL = 'https://www.reddit.com/r/420Grindhouse/.rss';
    const LINEUP_DAY_NAMES = ['Friday', 'Saturday', 'Sunday'];

    function lineupSlugify(name) {
        return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    }

    function lineupDecodeHtmlEntities(s) {
        return s
            .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
            .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
            .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    }

    // The first <entry> in the feed is the pinned post. Returns null if the feed has
    // no entries or is missing a required field.
    function lineupParseFirstEntry(feedXml) {
        const start = feedXml.indexOf('<entry>');
        if (start === -1) return null;
        const end = feedXml.indexOf('</entry>', start);
        if (end === -1) return null;
        const entry = feedXml.slice(start, end + '</entry>'.length);
        const idM = entry.match(/<id>([^<]+)<\/id>/);
        const titleM = entry.match(/<title>([^<]+)<\/title>/);
        const contentM = entry.match(/<content type="html">([\s\S]*?)<\/content>/);
        if (!idM || !titleM || !contentM) return null;
        const pubM = entry.match(/<published>([^<]+)<\/published>/);
        return {
            postId: idM[1],
            title: lineupDecodeHtmlEntities(titleM[1]),
            publishedAt: pubM ? pubM[1] : null,
            contentHtml: lineupDecodeHtmlEntities(contentM[1]),
        };
    }

    // Parses "Weekend Grindhouse Schedule - Fri 7/10 - Sun 7/12" into real calendar
    // dates. Only Friday's month/day is read from the title -- Saturday and Sunday are
    // always +1/+2 days from Friday. The year comes from the post's own publishedAt
    // timestamp, not system "now" -- except a December post for a January weekend,
    // where the weekend is next year.
    function lineupParseDateRange(title, publishedAt) {
        const m = title && title.match(/Fri\D*(\d{1,2})\/(\d{1,2})/i);
        if (!m || !publishedAt) return null;
        const pub = new Date(publishedAt);
        if (isNaN(pub.getTime())) return null;
        const friMonth = parseInt(m[1], 10), friDay = parseInt(m[2], 10);
        const pubMonth = pub.getMonth() + 1;
        const year = (pubMonth === 12 && friMonth === 1) ? pub.getFullYear() + 1 : pub.getFullYear();
        const fri = Date.UTC(year, friMonth - 1, friDay);
        const toStr = (ms) => new Date(ms).toISOString().slice(0, 10);
        return { fri: toStr(fri), sat: toStr(fri + 86400000), sun: toStr(fri + 2 * 86400000) };
    }

    // Each <li> is "Title (Year)", sometimes with a leading bold label or a trailing
    // "aka Other Title" -- stripped for the (title, year) pair used for TMDB
    // lookup/matching; `display` keeps the full original text.
    function lineupParseListItems(ulInnerHtml) {
        const items = [];
        const liRe = /<li>([\s\S]*?)<\/li>/g;
        let lm;
        while ((lm = liRe.exec(ulInnerHtml))) {
            const display = lm[1].replace(/<strong>[^<]*<\/strong>\s*/, '').replace(/<[^>]+>/g, '').trim();
            const withoutAka = display.replace(/\s+aka\s+.+$/i, '');
            const ym = withoutAka.match(/^(.*)\s\((\d{4})\)$/);
            if (ym) items.push({ title: ym[1].trim(), year: ym[2], display });
        }
        return items;
    }

    // Walks the post body in document order, assigning each <ul> of films to the most
    // recently seen section name, and each section to the most recently seen day.
    function lineupParseSchedule(contentHtml) {
        const days = [];
        let currentDay = null;
        let pendingSectionName = null;
        const re = /<strong>([^<]*)<\/strong>|<ul>([\s\S]*?)<\/ul>/g;
        let m;
        while ((m = re.exec(contentHtml))) {
            if (m[1] !== undefined) {
                const text = m[1].trim();
                if (LINEUP_DAY_NAMES.includes(text)) {
                    currentDay = { day: text, sections: [] };
                    days.push(currentDay);
                    pendingSectionName = null;
                } else {
                    pendingSectionName = text;
                }
            } else if (currentDay && pendingSectionName) {
                const items = lineupParseListItems(m[2]);
                if (items.length) currentDay.sections.push({ name: pendingSectionName, slug: lineupSlugify(pendingSectionName), items });
                pendingSectionName = null;
            }
        }
        return days;
    }

    function lineupGmFetch(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
                onload: resolve,
                onerror: reject,
            });
        });
    }

    // Fetches and fully parses the current schedule post. Throws on any failure
    // (network, missing entry, unparseable date range, zero days/sections parsed) --
    // the caller (lineupEnsureSchedule, Task 3) catches this and falls back to the
    // Now/Next-only view built from live changeMedia data.
    async function fetchTonightsSchedule() {
        const res = await lineupGmFetch(LINEUP_FEED_URL);
        if (!res || res.status !== 200) throw new Error('Reddit feed HTTP ' + (res && res.status));
        const entry = lineupParseFirstEntry(res.responseText);
        if (!entry) throw new Error('no entries found in feed');
        const dateRange = lineupParseDateRange(entry.title, entry.publishedAt);
        if (!dateRange) throw new Error('could not parse weekend date range from title: ' + entry.title);
        const days = lineupParseSchedule(entry.contentHtml);
        if (!days.length) throw new Error('no days parsed from schedule post');
        const dateByDay = { Friday: dateRange.fri, Saturday: dateRange.sat, Sunday: dateRange.sun };
        return {
            postId: entry.postId,
            title: entry.title,
            publishedAt: entry.publishedAt,
            days: days.map(d => ({ ...d, date: dateByDay[d.day] || null })),
        };
    }

    /* ==========================================================
       TONIGHT'S LINEUP -- timing/ETA model.
       Precision decays honestly the further out an estimate is: 'exact' (current
       feature's remaining runtime + one learned bumper gap), 'approx' (further out,
       compounding uncertainty), 'late' (tail of the night -- running order only).
    ========================================================== */

    function lineupFormatEta(hour24, minute, precision) {
        if (precision === 'late') return 'LATE';
        const period = hour24 >= 12 ? 'PM' : 'AM';
        let h = hour24 % 12;
        if (h === 0) h = 12;
        const mm = String(minute).padStart(2, '0');
        const prefix = precision === 'approx' ? '~' : '≈';
        return `${prefix} ${h}:${mm} ${period}`;
    }

    // Running median of observed bumper-gap durations (seconds) between features.
    function lineupMedianGapSeconds(observedGaps) {
        if (!observedGaps.length) return null;
        const sorted = [...observedGaps].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    // Pacific-timezone offset (minutes) of the UTC instant `d`. Noon is never within a
    // couple hours of a DST transition (those happen at 2am local), so a single
    // read-back is safe -- no iteration needed.
    function lineupPacificOffsetMinutes(d) {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Los_Angeles', hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).formatToParts(d);
        const get = (t) => parts.find(p => p.type === t).value;
        const hour = parseInt(get('hour'), 10) % 24;
        const asUTC = Date.UTC(+get('year'), +get('month') - 1, +get('day'), hour, +get('minute'), +get('second'));
        return (asUTC - d.getTime()) / 60000;
    }

    // The UTC instant that is Noon Pacific on the given 'YYYY-MM-DD' calendar date --
    // the per-day showtime anchor, used as the walk-forward start point for whichever
    // day is selected, not just Friday.
    function lineupDayAnchorPacific(dateStr) {
        const [y, m, d] = dateStr.split('-').map(Number);
        const guess = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
        const offsetMinutes = lineupPacificOffsetMinutes(guess);
        return new Date(guess.getTime() - offsetMinutes * 60000);
    }

    // Today's Pacific calendar date as 'YYYY-MM-DD' -- used to pick the default day
    // tab (isToday) and to decide whether "now playing" should even be searched for.
    function lineupPacificDateString(now = new Date()) {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(now);
        const get = (t) => parts.find(p => p.type === t).value;
        return `${get('year')}-${get('month')}-${get('day')}`;
    }

```

- [ ] **Step 3: Write the parser verification probe**

Create `working/lineup-parse-verify.mjs`:

```js
// One-off probe verifying the Reddit schedule parser logic added to cytube.pc.user.js
// against a synthetic-but-realistic Atom feed sample (same double-escaping shape
// documented in that section's header comment: Reddit's markdown renderer
// entity-encodes special chars, then the Atom feed XML-escapes the whole content
// blob on top of that). This is a throwaway probe, not a permanent test suite --
// mirrors the convention of the other working/*-test.mjs scripts in this repo.
// Run: node working/lineup-parse-verify.mjs
import assert from 'node:assert/strict';

// ---- copies of the pure parser functions from cytube.pc.user.js ----
function lineupSlugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function lineupDecodeHtmlEntities(s) {
    return s
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function lineupParseFirstEntry(feedXml) {
    const start = feedXml.indexOf('<entry>');
    if (start === -1) return null;
    const end = feedXml.indexOf('</entry>', start);
    if (end === -1) return null;
    const entry = feedXml.slice(start, end + '</entry>'.length);
    const idM = entry.match(/<id>([^<]+)<\/id>/);
    const titleM = entry.match(/<title>([^<]+)<\/title>/);
    const contentM = entry.match(/<content type="html">([\s\S]*?)<\/content>/);
    if (!idM || !titleM || !contentM) return null;
    const pubM = entry.match(/<published>([^<]+)<\/published>/);
    return {
        postId: idM[1],
        title: lineupDecodeHtmlEntities(titleM[1]),
        publishedAt: pubM ? pubM[1] : null,
        contentHtml: lineupDecodeHtmlEntities(contentM[1]),
    };
}
function lineupParseDateRange(title, publishedAt) {
    const m = title && title.match(/Fri\D*(\d{1,2})\/(\d{1,2})/i);
    if (!m || !publishedAt) return null;
    const pub = new Date(publishedAt);
    if (isNaN(pub.getTime())) return null;
    const friMonth = parseInt(m[1], 10), friDay = parseInt(m[2], 10);
    const pubMonth = pub.getMonth() + 1;
    const year = (pubMonth === 12 && friMonth === 1) ? pub.getFullYear() + 1 : pub.getFullYear();
    const fri = Date.UTC(year, friMonth - 1, friDay);
    const toStr = (ms) => new Date(ms).toISOString().slice(0, 10);
    return { fri: toStr(fri), sat: toStr(fri + 86400000), sun: toStr(fri + 2 * 86400000) };
}
function lineupParseListItems(ulInnerHtml) {
    const items = [];
    const liRe = /<li>([\s\S]*?)<\/li>/g;
    let lm;
    while ((lm = liRe.exec(ulInnerHtml))) {
        const display = lm[1].replace(/<strong>[^<]*<\/strong>\s*/, '').replace(/<[^>]+>/g, '').trim();
        const withoutAka = display.replace(/\s+aka\s+.+$/i, '');
        const ym = withoutAka.match(/^(.*)\s\((\d{4})\)$/);
        if (ym) items.push({ title: ym[1].trim(), year: ym[2], display });
    }
    return items;
}
function lineupParseSchedule(contentHtml) {
    const days = [];
    let currentDay = null;
    let pendingSectionName = null;
    const re = /<strong>([^<]*)<\/strong>|<ul>([\s\S]*?)<\/ul>/g;
    let m;
    while ((m = re.exec(contentHtml))) {
        if (m[1] !== undefined) {
            const text = m[1].trim();
            if (['Friday', 'Saturday', 'Sunday'].includes(text)) {
                currentDay = { day: text, sections: [] };
                days.push(currentDay);
                pendingSectionName = null;
            } else {
                pendingSectionName = text;
            }
        } else if (currentDay && pendingSectionName) {
            const items = lineupParseListItems(m[2]);
            if (items.length) currentDay.sections.push({ name: pendingSectionName, slug: lineupSlugify(pendingSectionName), items });
            pendingSectionName = null;
        }
    }
    return days;
}

// ---- build a synthetic Atom entry with the same double-escaping the real feed has ----
function xmlEscape(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Raw HTML as Reddit's markdown renderer would emit it, with its own entity-encoding
// already applied to the apostrophe (the "two independent layers" the real feed has).
const innerHtml = [
    '<p>Here&#x27;s the weekend lineup!</p>',
    '<p><strong>Friday</strong></p>',
    '<p><strong>Main Feature</strong></p>',
    '<ul><li>Don&#x27;t Look Now (1973)</li><li>The Thing (1982)</li></ul>',
    '<p><strong>Late Night Bumps</strong></p>',
    '<ul><li>Basket Case (1982)</li></ul>',
    '<p><strong>Saturday</strong></p>',
    '<p><strong>Main Feature</strong></p>',
    '<ul><li>Re-Animator (1985)</li></ul>',
].join('');

const feedXml = `<feed xmlns="http://www.w3.org/2005/Atom">
<entry>
<id>t3_abc123</id>
<title>Weekend Grindhouse Schedule - Fri 7/10 - Sun 7/12</title>
<published>2026-07-08T12:00:00+00:00</published>
<content type="html">${xmlEscape(innerHtml)}</content>
</entry>
</feed>`;

// ---- run + assert ----
const entry = lineupParseFirstEntry(feedXml);
assert.ok(entry, 'expected an entry to be parsed');
assert.equal(entry.postId, 't3_abc123');
assert.equal(entry.title, 'Weekend Grindhouse Schedule - Fri 7/10 - Sun 7/12');
assert.equal(entry.contentHtml.includes("Here's the weekend lineup!"), true, 'apostrophe should be decoded');

const dateRange = lineupParseDateRange(entry.title, entry.publishedAt);
assert.deepEqual(dateRange, { fri: '2026-07-10', sat: '2026-07-11', sun: '2026-07-12' });

const days = lineupParseSchedule(entry.contentHtml);
assert.equal(days.length, 2, 'expected Friday + Saturday');
assert.equal(days[0].day, 'Friday');
assert.equal(days[0].sections.length, 2);
assert.equal(days[0].sections[0].name, 'Main Feature');
assert.equal(days[0].sections[0].slug, 'main-feature');
assert.deepEqual(days[0].sections[0].items[0], { title: "Don't Look Now", year: '1973', display: "Don't Look Now (1973)" });
assert.equal(days[0].sections[0].items[1].title, 'The Thing');
assert.equal(days[0].sections[1].name, 'Late Night Bumps');
assert.equal(days[0].sections[1].items[0].title, 'Basket Case');
assert.equal(days[1].day, 'Saturday');
assert.equal(days[1].sections[0].items[0].title, 'Re-Animator');

console.log('All lineup parser checks passed.');
```

- [ ] **Step 4: Run the verification probe**

Run: `node working/lineup-parse-verify.mjs`
Expected output: `All lineup parser checks passed.` with exit code 0. If an `AssertionError` is thrown, fix the corresponding function in `cytube.pc.user.js` (keep both copies in sync) and re-run.

- [ ] **Step 5: Commit**

```bash
git add cytube.pc.user.js working/lineup-parse-verify.mjs
git commit -m "Add Reddit schedule fetch/parse + timing helpers for Tonight's Lineup"
```

---

### Task 2: Section themes

**Files:**
- Modify: `cytube.pc.user.js` (insert after Task 1's section, still before `POSTER STRIP`)

**Interfaces:**
- Consumes: nothing new
- Produces: `getSectionTheme(slug): {font: string|null, color: string, wash: string}`, `lineupEnsureThemeFontsLoaded(): void` — both consumed by Task 4.

- [ ] **Step 1: Insert the section-themes block**

Immediately after Task 1's new code (still before the `POSTER STRIP` comment block), insert:

```js
    /* ==========================================================
       TONIGHT'S LINEUP -- per-section font + color theme.
       Each of the 9 recurring section names (a slow-changing, closed set) gets its
       own Google Font + accent color, tying a grouping's header and its background
       wash together. Fonts are loaded once via a single combined Google Fonts CSS2
       request. Ported from the Android app's web/src/lineup/sectionThemes.js.
    ========================================================== */

    const LINEUP_THEMES = {
        'funky-cheese-friday':          { font: 'Boogaloo',           color: '#e0a92a', wash: '#2b210a' },
        'friday-grindhouse-a-go-go':    { font: 'Chewy',               color: '#ec4899', wash: '#2a0e1c' },
        'friday-night-freak-show':      { font: 'Creepster',           color: '#52c41a', wash: '#0f2109' },
        'psychedelic-saturday':         { font: "'Rubik Wet Paint'",   color: '#a855f7', wash: '#200c2b' },
        'saturday-prime-time-drive-in': { font: 'Monoton',             color: '#22d3ee', wash: '#06232a' },
        'red-light-saturday-night':     { font: "'Vast Shadow'",       color: '#ef4444', wash: '#2b0a0a' },
        'the-sunday-classics':          { font: 'Cinzel',              color: '#b8b8b8', wash: '#1c1c1c' },
        'sunday-slop-o-rama':           { font: 'Eater',               color: '#a3b125', wash: '#1c1f08' },
        'last-call-sunday-night':       { font: "'Bungee Shade'",      color: '#6366f1', wash: '#12102b' },
    };
    // Any future/unrecognized section name falls back to the script's normal font and
    // a neutral wash, rather than an unstyled or broken-looking block.
    const LINEUP_DEFAULT_THEME = { font: null, color: '#9aa0a8', wash: '#14141a' };

    function getSectionTheme(slug) {
        return LINEUP_THEMES[slug] || LINEUP_DEFAULT_THEME;
    }

    const LINEUP_FONT_FAMILIES = ['Boogaloo', 'Chewy', 'Creepster', 'Rubik+Wet+Paint', 'Monoton', 'Vast+Shadow', 'Cinzel', 'Eater', 'Bungee+Shade'];
    const LINEUP_FONTS_LINK_ID = 'sc-lineup-theme-fonts';

    // Idempotent -- safe to call on every showLineupScreen(); only injects the <link>
    // once per page load (checked by id).
    function lineupEnsureThemeFontsLoaded() {
        if (document.getElementById(LINEUP_FONTS_LINK_ID)) return;
        const link = document.createElement('link');
        link.id = LINEUP_FONTS_LINK_ID;
        link.rel = 'stylesheet';
        link.href = `https://fonts.googleapis.com/css2?${LINEUP_FONT_FAMILIES.map(f => `family=${f}`).join('&')}&display=swap`;
        document.head.appendChild(link);
    }

```

- [ ] **Step 2: Verify the userscript still loads without a syntax error**

Run: `node --check cytube.pc.user.js`
Expected: no output, exit code 0 (this only validates JS syntax, not the `// ==UserScript==` header block, which `node --check` ignores as a comment).

- [ ] **Step 3: Commit**

```bash
git add cytube.pc.user.js
git commit -m "Add per-section color/font theming for Tonight's Lineup"
```

---

### Task 3: Lineup data layer

**Files:**
- Modify: `cytube.pc.user.js` (insert after Task 2's section; also modify `injectMovieLinks` around line 1628 to hook bumper-gap learning)

**Interfaces:**
- Consumes: `fetchTonightsSchedule()`, `lineupFormatEta()`, `lineupMedianGapSeconds()`, `lineupDayAnchorPacific()`, `lineupPacificDateString()` (Task 1); `lookupMovie(title, year)`, `lastMovieTitle`, `parseMovieFilename(raw)`, `getCurrentMediaSeconds()`, `getPlayerTimeSec()`, `hasKey(id)`, `LS_TMDB` (all pre-existing)
- Produces: `getTonightsLineup(): Promise<{listTitle, fallback, days: [{day, date, isToday, sections: [{name, slug, items}]}]}>`, `getMotdPosterImages(): [{src, title}]` — both consumed by Task 4.

- [ ] **Step 1: Insert the lineup data layer**

Immediately after Task 2's new code (still before the `POSTER STRIP` comment block), insert:

```js
    /* ==========================================================
       TONIGHT'S LINEUP -- data interface consumed by the lineup screen (below).
       Fetches + caches the Reddit schedule post once per session (persisted to
       localStorage across page reloads, keyed by the post's own id -- self-heals
       whenever the pinned post rolls over to next week's), locates "now" within
       TODAY's day only, and projects the next LINEUP_MAX_ESTIMATED_AHEAD upcoming
       films' ETA from TMDB runtimes plus a learned median bumper-gap, anchored at
       that day's Noon-Pacific showtime start. Falls back to the current title plus
       the static admin-curated MOTD poster art if the fetch fails and no usable
       cache exists. Ported from the Android app's web/src/lineup/data.js.
    ========================================================== */

    const LS_LINEUP_CACHE = 'sc_lineup_cache_v1';
    const LINEUP_CACHE_MAX_AGE_MS = 20 * 60 * 60 * 1000; // background-revalidate if older than this
    const LINEUP_FALLBACK_TITLE = 'Coming Attractions';
    const LINEUP_MAX_ESTIMATED_AHEAD = 4; // only the next N upcoming films get any time estimate at all

    let _lineupScheduleCache = null;     // {postId, title, publishedAt, days, fetchedAt} or null
    let _lineupFetchFailed = false;      // sticky for the session once Reddit is unreachable AND no cache at all
    let _lineupRevalidating = false;
    let _lineupObservedGaps = [];        // durations (s) of changeMedia items that didn't match the schedule
    let _lineupLastUnmatchedStart = null; // Date.now() when the current unmatched (bumper) item started

    function lineupReadCache() {
        try {
            const raw = localStorage.getItem(LS_LINEUP_CACHE);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }
    function lineupWriteCache(schedule) {
        try { localStorage.setItem(LS_LINEUP_CACHE, JSON.stringify({ ...schedule, fetchedAt: Date.now() })); }
        catch (e) { /* storage full/unavailable -- in-memory cache for this session still works */ }
    }

    function lineupAllScheduleTitles() {
        if (!_lineupScheduleCache) return [];
        return _lineupScheduleCache.days.flatMap(d => d.sections.flatMap(s => s.items));
    }

    // Learn bumper-gap duration live: a currently-playing title that doesn't match
    // anything in tonight's schedule is a bumper; the time between it starting and the
    // next (matched-or-not) title change is one observed gap sample. Called from
    // injectMovieLinks (Step 2 below) with the same deduped rawTitle that function
    // already tracks in lastMovieTitle.
    function lineupObserveTitleChange(rawTitle) {
        const title = rawTitle ? parseMovieFilename(rawTitle).title : null;
        const matchesSchedule = !!(title && _lineupScheduleCache &&
            lineupAllScheduleTitles().some(s => s.title.toLowerCase() === title.toLowerCase()));
        if (rawTitle && !matchesSchedule && _lineupScheduleCache) {
            _lineupLastUnmatchedStart = Date.now();
        } else if (_lineupLastUnmatchedStart) {
            _lineupObservedGaps.push((Date.now() - _lineupLastUnmatchedStart) / 1000);
            _lineupLastUnmatchedStart = null;
        }
    }

    async function lineupRefetchAndCache() {
        if (_lineupRevalidating) return;
        _lineupRevalidating = true;
        try {
            const result = await fetchTonightsSchedule();
            _lineupScheduleCache = result;
            lineupWriteCache(result);
        } catch (e) {
            // Keep whatever we already had -- a failed background revalidation is
            // silent; _lineupFetchFailed only matters when we have nothing at all.
        } finally {
            _lineupRevalidating = false;
        }
    }

    async function lineupEnsureSchedule() {
        if (_lineupScheduleCache || _lineupFetchFailed) return;
        const cached = lineupReadCache();
        if (cached) {
            _lineupScheduleCache = cached;
            if (Date.now() - (cached.fetchedAt || 0) > LINEUP_CACHE_MAX_AGE_MS) lineupRefetchAndCache(); // fire-and-forget
            return;
        }
        try {
            const result = await fetchTonightsSchedule();
            _lineupScheduleCache = result;
            lineupWriteCache(result);
        } catch (e) {
            _lineupFetchFailed = true;
        }
    }

    // Poster images in the MOTD are 125x175 -- keep portrait-ish images, skip wide
    // banners. Used both by the fallback view below and by the Coming Attractions
    // toggle button's "is there anything to show" check (Task 5).
    function getMotdPosterImages() {
        const motd = document.getElementById('motdrow');
        if (!motd) return [];
        return [...motd.querySelectorAll('img')].filter(img => {
            const w = parseInt(img.getAttribute('width') || 0);
            const h = parseInt(img.getAttribute('height') || 0);
            return h >= 100 && w <= 200;
        }).map(img => ({ src: img.src, title: img.title || img.alt || '' }));
    }

    // Every item's TMDB/IMDb-enriched fields, in the exact shape showNowPlayingCard
    // (line ~1566) already consumes.
    function lineupBuildItem(info, title, year) {
        return {
            cleanTitle: info.cleanTitle || title,
            cleanYear: info.cleanYear || year,
            poster: info.poster || null,
            backdrop: info.backdrop || null,
            overview: info.overview || '',
            rating: info.rating ?? null,
            runtime: info.runtime ?? null,
            genres: info.genres || [],
            parentalGuide: info.parentalGuide || null,
            killCount: info.killCount ?? null,
            imdbId: info.imdbId || null,
        };
    }

    // Fallback when Reddit is unreachable and no cache exists at all: the current item
    // (if known and it looks like a real feature, not a short/bumper) plus the same
    // admin-curated MOTD poster art the old strip showed (display-only -- no real
    // title/overview to show for those, so clicking does nothing). Shaped as a single
    // pseudo-day/section so the screen's fallback renderer doesn't need to know this
    // differs from the real day/section structure.
    async function lineupFallbackView() {
        const items = [];
        if (lastMovieTitle) {
            const { title, year } = parseMovieFilename(lastMovieTitle);
            const info = await lookupMovie(title, year);
            // Skip likely bumpers/shorts: if TMDB is configured and confidently found
            // nothing for this exact title, it's probably not a real feature. Without a
            // TMDB key at all there's no way to tell, so default to showing it.
            if (!hasKey(LS_TMDB) || info.cleanTitle) {
                items.push({ ...lineupBuildItem(info, title, year), isNowPlaying: true, etaLabel: '' });
            }
        }
        getMotdPosterImages().forEach((img) => {
            items.push({
                cleanTitle: img.title, cleanYear: null,
                poster: img.src, backdrop: null, overview: '',
                isNowPlaying: false, etaLabel: '', clickable: false,
            });
        });
        return {
            listTitle: LINEUP_FALLBACK_TITLE, fallback: true,
            days: [{ day: 'Tonight', date: null, isToday: true, sections: [{ name: '', slug: null, items }] }],
        };
    }

    // Flattens a day's sections into one ordered list (for locating "now" and walking
    // ETAs across section boundaries), then re-nests the built items back into their
    // sections.
    function lineupBuildDaySections(day, isTodayFlag, infosByKey) {
        const flat = [];
        day.sections.forEach((section, si) => {
            section.items.forEach(item => flat.push({ section, si, item }));
        });

        const currentTitle = isTodayFlag && lastMovieTitle
            ? parseMovieFilename(lastMovieTitle).title : '';
        const currentFlatIndex = currentTitle
            ? flat.findIndex(f => f.item.title.toLowerCase() === currentTitle.toLowerCase())
            : -1;

        // Pre-show cold start: the first film of ANY day that hasn't started yet gets
        // one coarse "starts around then" guess, anchored on that day's own real
        // Noon-Pacific showtime.
        const anchor = lineupDayAnchorPacific(day.date);
        const isColdStart = currentFlatIndex === -1 && Date.now() < anchor.getTime();

        const learnedGap = lineupMedianGapSeconds(_lineupObservedGaps) ?? 600; // 10-min cold-start default
        let cumulative = currentFlatIndex !== -1
            ? Math.max(0, getCurrentMediaSeconds() - getPlayerTimeSec()) : 0;

        const builtFlat = flat.map((f, idx) => {
            const info = infosByKey.get(f.item.title + '|' + f.item.year) || {};
            const base = lineupBuildItem(info, f.item.title, f.item.year);
            if (idx === currentFlatIndex) return { ...base, isNowPlaying: true, etaLabel: '' };
            if (isColdStart && idx === 0) {
                return { ...base, isNowPlaying: false, etaLabel: lineupFormatEta(anchor.getHours(), anchor.getMinutes(), 'approx') };
            }
            if (currentFlatIndex === -1 || idx < currentFlatIndex) {
                return { ...base, isNowPlaying: false, etaLabel: '' }; // no live anchor, or already aired earlier today
            }
            const offset = idx - currentFlatIndex;
            cumulative += learnedGap; // a bumper precedes this feature
            let etaLabel = '';
            if (offset <= LINEUP_MAX_ESTIMATED_AHEAD) {
                const precision = offset === 1 ? 'exact' : 'approx';
                const eta = new Date(Date.now() + cumulative * 1000);
                etaLabel = lineupFormatEta(eta.getHours(), eta.getMinutes(), precision);
            }
            cumulative += info.runtime ? info.runtime * 60 : 0;
            return { ...base, isNowPlaying: false, etaLabel };
        });

        return day.sections.map((section, si) => ({
            name: section.name, slug: section.slug,
            items: builtFlat.filter((_, idx) => flat[idx].si === si),
        }));
    }

    async function getTonightsLineup() {
        await lineupEnsureSchedule();
        if (!_lineupScheduleCache) return lineupFallbackView();

        const allItems = lineupAllScheduleTitles();
        const infos = await Promise.all(allItems.map(({ title, year }) => lookupMovie(title, year)));
        const infosByKey = new Map(allItems.map((item, i) => [item.title + '|' + item.year, infos[i]]));

        const todayStr = lineupPacificDateString();
        const days = _lineupScheduleCache.days.map((day) => ({
            day: day.day, date: day.date, isToday: day.date === todayStr,
            sections: lineupBuildDaySections(day, day.date === todayStr, infosByKey),
        }));
        return { listTitle: _lineupScheduleCache.title || LINEUP_FALLBACK_TITLE, fallback: false, days };
    }

```

- [ ] **Step 2: Hook bumper-gap learning into `injectMovieLinks`**

Find `injectMovieLinks` (currently around line 1622-1629):

```js
    function injectMovieLinks(titleEl) {
        const rawTitle = titleEl.textContent.trim()
            .replace(/^currently\s+playing[:\s]*/i, '')
            .replace(/^now\s+playing[:\s]*/i, '').trim();

        if (!rawTitle || rawTitle === lastMovieTitle || rawTitle.length < 2) return;
        lastMovieTitle = rawTitle;
        _currentImdbId = null;
```

Add one line right after `lastMovieTitle = rawTitle;`:

```js
    function injectMovieLinks(titleEl) {
        const rawTitle = titleEl.textContent.trim()
            .replace(/^currently\s+playing[:\s]*/i, '')
            .replace(/^now\s+playing[:\s]*/i, '').trim();

        if (!rawTitle || rawTitle === lastMovieTitle || rawTitle.length < 2) return;
        lastMovieTitle = rawTitle;
        lineupObserveTitleChange(rawTitle);
        _currentImdbId = null;
```

This reuses the same deduped title-change signal (`rawTitle === lastMovieTitle` guard above already prevents re-firing for an unchanged title) instead of adding a second, separately-parsed listener on the `changeMedia` socket event.

- [ ] **Step 3: Verify syntax**

Run: `node --check cytube.pc.user.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add cytube.pc.user.js
git commit -m "Add Tonight's Lineup data layer (schedule cache, ETA/now-playing, fallback)"
```

---

### Task 4: Lineup screen UI

**Files:**
- Modify: `cytube.pc.user.js` (insert after Task 3's section, still before `POSTER STRIP`)

**Interfaces:**
- Consumes: `getTonightsLineup()`, `getSectionTheme(slug)`, `lineupEnsureThemeFontsLoaded()` (earlier tasks); `showNowPlayingCard(data, opts)` (pre-existing, line ~1566)
- Produces: `showLineupScreen(): void`, `hideLineupScreen(): void` — both consumed by Task 5.

- [ ] **Step 1: Insert the lineup screen**

Immediately after Task 3's new code (still before the `POSTER STRIP` comment block), insert:

```js
    /* ==========================================================
       TONIGHT'S LINEUP -- full-screen schedule overlay, opened from the Coming
       Attractions toggle (Task 5). Friday/Saturday/Sunday day tabs switch which day
       is shown; within a day, every section renders stacked and native page-scroll
       moves between them (no D-pad paging -- this is mouse/keyboard, unlike the
       Android TV build this was ported from). OK/click on a film opens the existing
       Now-Playing card in browse mode. Ported from the Android app's
       web/src/lineup/screen.js, with the TV-only paging path removed.
    ========================================================== */

    let _lineupLastData = null;   // most recent getTonightsLineup() result, so tab switches don't refetch
    let _lineupActiveDay = null;  // currently selected day name

    function lineupEnsureScreenDom() {
        lineupEnsureThemeFontsLoaded();
        let screen = document.getElementById('sc-lineup-screen');
        if (screen) return screen;
        screen = document.createElement('div');
        screen.id = 'sc-lineup-screen';
        screen.innerHTML = `
            <button id="sc-lineup-close" type="button">✕</button>
            <div id="sc-lineup-header"></div>
            <div id="sc-lineup-subtitle">Titles/times may be subject to change.</div>
            <nav id="sc-lineup-daytabs"></nav>
            <div id="sc-lineup-body"></div>`;
        screen.querySelector('#sc-lineup-close').addEventListener('click', hideLineupScreen);
        document.body.appendChild(screen);
        return screen;
    }

    function lineupRenderLoading(screen) {
        screen.querySelector('#sc-lineup-daytabs').innerHTML = '';
        screen.querySelector('#sc-lineup-body').innerHTML =
            '<div id="sc-lineup-loading">Fetching tonight’s lineup…</div>';
    }

    function lineupItemButton(item) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sc-lineup-item'
            + (item.isNowPlaying ? ' sc-lineup-item-current' : '')
            + (item.clickable === false ? ' sc-lineup-item-static' : '');
        const titleText = `${item.cleanTitle}${item.cleanYear ? ` (${item.cleanYear})` : ''}`;
        const etaText = item.isNowPlaying ? 'NOW PLAYING' : (item.etaLabel || '');
        // Titles are shown IN the poster box only when there's no art to identify the
        // film by -- when real poster art is present, no title text is shown at all;
        // click still opens the Now-Playing card with the full title if needed.
        btn.innerHTML = `
            <div class="sc-lineup-poster" style="${item.poster ? `background-image:url(${item.poster})` : ''}">
                ${!item.poster ? `<div class="sc-lineup-poster-fallback">${titleText}</div>` : ''}
                ${etaText ? `<div class="sc-lineup-eta">${etaText}</div>` : ''}
            </div>`;
        // Static fallback posters are display-only (item.clickable === false) -- they
        // have no real title/overview to show, so click does nothing for them.
        if (item.clickable !== false) {
            btn.addEventListener('click', () => showNowPlayingCard(item, { autoHide: false }));
        }
        return btn;
    }

    // One section's grouping. Named theme sections repeat every week (a slow-changing,
    // closed set), so each gets its own Google Font + accent color tying its header
    // and background together.
    function lineupSectionEl(section, index, total) {
        const el = document.createElement('div');
        el.className = 'sc-lineup-section';
        const theme = getSectionTheme(section.slug);
        el.style.setProperty('--sc-lineup-wash', theme.wash);
        if (section.name) {
            const name = document.createElement('div');
            name.className = 'sc-lineup-section-name';
            name.style.setProperty('color', theme.color, 'important');
            if (theme.font) name.style.setProperty('font-family', `${theme.font}, cursive`, 'important');
            name.innerHTML = `${section.name}${total > 1 ? `<span class="sc-lineup-section-count">${index + 1} / ${total}</span>` : ''}`;
            el.appendChild(name);
        }
        const rail = document.createElement('div');
        rail.className = 'sc-lineup-rail';
        section.items.forEach(item => rail.appendChild(lineupItemButton(item)));
        el.appendChild(rail);
        return el;
    }

    function lineupRenderDayTabs(screen, days) {
        const tabs = screen.querySelector('#sc-lineup-daytabs');
        tabs.innerHTML = '';
        days.forEach((d) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sc-lineup-daytab' + (d.day === _lineupActiveDay ? ' sc-lineup-daytab-active' : '');
            btn.textContent = d.day;
            btn.addEventListener('click', () => lineupShowDay(screen, d.day));
            tabs.appendChild(btn);
        });
    }

    function lineupRenderBody(screen, days) {
        const body = screen.querySelector('#sc-lineup-body');
        body.innerHTML = '';
        const day = days.find(d => d.day === _lineupActiveDay) || days[0];
        if (!day || !day.sections.length) {
            body.innerHTML = '<div id="sc-lineup-loading">No lineup available right now.</div>';
            return;
        }
        day.sections.forEach((section, i) => body.appendChild(lineupSectionEl(section, i, day.sections.length)));
    }

    function lineupShowDay(screen, day) {
        _lineupActiveDay = day;
        const tabs = [...screen.querySelectorAll('.sc-lineup-daytab')];
        tabs.forEach(t => t.classList.toggle('sc-lineup-daytab-active', t.textContent === day));
        lineupRenderBody(screen, _lineupLastData.days);
    }

    // Degraded view when Reddit is unreachable: the current title (if known) plus the
    // static Coming Attractions art, as one flat rail -- no tabs, no sections, since
    // there's no real day/section structure to show in this mode.
    function lineupRenderFallback(screen, data) {
        screen.querySelector('#sc-lineup-daytabs').innerHTML = '';
        const body = screen.querySelector('#sc-lineup-body');
        body.innerHTML = '';
        const items = (data.days && data.days[0] && data.days[0].sections[0] && data.days[0].sections[0].items) || [];
        if (!items.length) {
            body.innerHTML = '<div id="sc-lineup-loading">No lineup available right now.</div>';
            return;
        }
        const section = document.createElement('div');
        section.className = 'sc-lineup-section sc-lineup-section-fallback';
        const rail = document.createElement('div');
        rail.className = 'sc-lineup-rail';
        items.forEach(item => rail.appendChild(lineupItemButton(item)));
        section.appendChild(rail);
        body.appendChild(section);
    }

    function lineupRenderItems(screen, data) {
        const header = screen.querySelector('#sc-lineup-header');
        if (header) header.textContent = (data && data.listTitle) || 'Grindhouse Lineup';
        _lineupLastData = data;
        if (!data || data.fallback) { lineupRenderFallback(screen, data || { days: [] }); return; }
        const days = data.days || [];
        // Recomputed fresh on every open so a manual tab switch from a PRIOR open
        // doesn't linger -- opening the screen always starts back on today's day (or
        // the first day, before the weekend starts).
        _lineupActiveDay = (days.find(d => d.isToday) || days[0] || {}).day || null;
        lineupRenderDayTabs(screen, days);
        lineupRenderBody(screen, days);
    }

    function showLineupScreen() {
        const screen = lineupEnsureScreenDom();
        screen.classList.add('sc-lineup-visible');
        lineupRenderLoading(screen);
        getTonightsLineup()
            .then(data => lineupRenderItems(screen, data))
            .catch(() => { lineupRenderItems(screen, { fallback: true, days: [] }); });
    }

    function hideLineupScreen() {
        const screen = document.getElementById('sc-lineup-screen');
        if (screen) screen.classList.remove('sc-lineup-visible');
        _topBarIsOpen = false;
        const toggleBtn = document.getElementById('sc-poster-toggle');
        if (toggleBtn) toggleBtn.classList.remove('sc-poster-toggle-active');
    }

```

Note: `hideLineupScreen` references `_topBarIsOpen` (declared at line ~2152, in the `POSTER STRIP`/top-bar section right after this new block) — safe because `let` bindings in the same top-level IIFE scope are all resolved at call time, not declaration time, and this function is never called before the top bar is initialized during page load.

- [ ] **Step 2: Verify syntax**

Run: `node --check cytube.pc.user.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add cytube.pc.user.js
git commit -m "Add Tonight's Lineup full-screen overlay UI"
```

---

### Task 5: Wire the Coming Attractions button, retire the old strip, update CSS

**Files:**
- Modify: `cytube.pc.user.js`

**Interfaces:**
- Consumes: `showLineupScreen()`, `hideLineupScreen()` (Task 4); `getMotdPosterImages()` (Task 3); pre-existing `_topBarWake`, `_topBarIsOpen`
- Produces: nothing new (this task rewires existing DOM/CSS)

- [ ] **Step 1: Replace `initPosterStrip()`**

Find the function (currently starting around line 2251):

```js
    function initPosterStrip() {
        const motd = document.getElementById('motdrow');
        if (!motd) return;

        // Build the poster strip container from MOTD images
        const imgs = [...motd.querySelectorAll('img')].filter(img => {
            // Read HTML attributes (not rendered dimensions — motdrow is hidden so rendered = 0)
            const w = parseInt(img.getAttribute('width') || 0);
            const h = parseInt(img.getAttribute('height') || 0);
            // Poster images in the MOTD are 125x175 — keep portrait-ish images, skip wide banners
            return h >= 100 && w <= 200;
        });
        if (!imgs.length) return;
```

...through its closing brace, which is right before the `/* ====... POLL / ANNOUNCEMENT WATCHER` comment block (currently ending around line 2388). Replace the **entire function body** (everything from `function initPosterStrip() {` to its matching closing `}`) with:

```js
    function initPosterStrip() {
        if (document.getElementById('sc-poster-toggle')) return;
        if (!getMotdPosterImages().length) return;

        // Toggle button — injected below the video title
        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'sc-poster-toggle';
        toggleBtn.textContent = "Coming Attractions";
        toggleBtn.title = 'Show/hide weekend lineup';
        toggleBtn.addEventListener('click', () => {
            const isOpen = document.getElementById('sc-lineup-screen')?.classList.contains('sc-lineup-visible');
            if (isOpen) {
                hideLineupScreen();
            } else {
                showLineupScreen();
                toggleBtn.classList.add('sc-poster-toggle-active');
                _topBarIsOpen = true;
                if (_topBarWake) _topBarWake();
            }
        });
        document.body.appendChild(toggleBtn);
    }
```

Also rename the section's header comment (currently around line 2148, right before `let _topBarWake`) from:

```js
    /* ==========================================================
       POSTER STRIP — toggle show/hide the MOTD poster images
    ========================================================== */
```

to:

```js
    /* ==========================================================
       COMING ATTRACTIONS — toggle button for the Tonight's Lineup screen
       (the full lineup screen and its data layer live in the "TONIGHT'S LINEUP"
       sections above).
    ========================================================== */
```

- [ ] **Step 2: Fix the `initPosterStrip` call-site guard**

Find (currently around line 2680):

```js
            // Hard fallback — if observer never fires, try once after 2s
            setTimeout(() => {
                if (!document.getElementById('sc-poster-strip')) initPosterStrip();
            }, 2000);
```

Change `sc-poster-strip` to `sc-poster-toggle` (the element `initPosterStrip` now actually creates):

```js
            // Hard fallback — if observer never fires, try once after 2s
            setTimeout(() => {
                if (!document.getElementById('sc-poster-toggle')) initPosterStrip();
            }, 2000);
```

- [ ] **Step 3: Remove the old poster-strip/zoom CSS**

Find this block (currently lines 2991-3052, right after the `#motdrow { display: none !important; }` rule):

```css
            /* ===== POSTER STRIP ===== */
            #sc-poster-strip {
                display: none !important; /* hidden by default */
                position: fixed !important;
                top: 20px !important;   /* drops down from the header bar */
                left: 0 !important;
                z-index: 19500 !important;
                width: 80vw !important;
                background: rgba(0,0,0,0.93) !important;
                padding: 8px 12px !important;
                overflow-x: auto !important;
                overflow-y: hidden !important;
                white-space: nowrap !important;
                border-bottom: 1px solid rgba(255,255,255,0.12) !important;
                scrollbar-width: thin !important;
                scrollbar-color: rgba(255,255,255,0.2) transparent !important;
            }
            body.sc-vertical #sc-poster-strip {
                width: 100vw !important;
                top: 20px !important;
                bottom: auto !important;
            }
            #sc-poster-strip.sc-poster-visible {
                display: block !important;
            }
            .sc-poster-thumb {
                height: 110px !important;
                width: auto !important;
                border-radius: 4px !important;
                margin-right: 6px !important;
                opacity: 0.82 !important;
                transition: opacity 0.15s !important;
                vertical-align: top !important;
                cursor: pointer !important;
                display: inline-block !important;
                flex-shrink: 0 !important;
            }
            .sc-poster-thumb:hover { opacity: 1 !important; }

            #sc-poster-zoom {
                display: none;
                position: fixed !important;
                z-index: 99990 !important;
                pointer-events: none !important;
                border-radius: 4px !important;
                box-shadow: 0 0 0 rgba(0,0,0,0) !important;
                border: 1px solid rgba(255,255,255,0.0) !important;
                /* transition animates position, size, shadow, border together */
                transition:
                    top 0.22s cubic-bezier(0.22, 1, 0.36, 1),
                    left 0.22s cubic-bezier(0.22, 1, 0.36, 1),
                    width 0.22s cubic-bezier(0.22, 1, 0.36, 1),
                    height 0.22s cubic-bezier(0.22, 1, 0.36, 1),
                    box-shadow 0.22s ease,
                    border-color 0.22s ease,
                    border-radius 0.22s ease !important;
            }
            #sc-poster-zoom.sc-zoom-expanded {
                box-shadow: 0 12px 48px rgba(0,0,0,0.92) !important;
                border-color: rgba(255,255,255,0.2) !important;
                border-radius: 6px !important;
            }

```

Delete this entire block. **Keep** the `/* ===== MOTD — keep hidden, we extract images ourselves ===== */` rule directly above it, and **keep** the `/* Toggle button — right side of the header bar, same line as the title */` `#sc-poster-toggle { position: fixed ... }` rule directly below it — neither is part of the deleted block.

- [ ] **Step 4: Add the new lineup screen CSS**

In the same place the old block was removed from (Step 3), insert:

```css
            /* ===== TONIGHT'S LINEUP SCREEN ===== */
            #sc-lineup-screen {
                position: fixed !important; inset: 0 !important;
                z-index: 20500 !important;
                background: rgba(6,4,8,0.97) !important;
                opacity: 0 !important; pointer-events: none !important;
                transition: opacity 0.25s ease !important;
                overflow-y: auto !important;
                font-family: system-ui, sans-serif !important;
                padding: 40px 6% 60px !important;
            }
            #sc-lineup-screen.sc-lineup-visible { opacity: 1 !important; pointer-events: auto !important; }
            #sc-lineup-close {
                position: fixed !important; top: 20px !important; right: 24px !important;
                z-index: 20600 !important;
                background: rgba(255,255,255,0.08) !important; border: none !important;
                color: #fff !important; width: 34px !important; height: 34px !important;
                border-radius: 50% !important; font-size: 16px !important; cursor: pointer !important;
            }
            #sc-lineup-close:hover { background: rgba(255,255,255,0.18) !important; }
            #sc-lineup-header {
                color: #fff !important; font-size: 28px !important; font-weight: 800 !important;
                margin-bottom: 4px !important;
            }
            #sc-lineup-subtitle {
                color: rgba(255,255,255,0.45) !important; font-size: 12px !important;
                margin-bottom: 20px !important;
            }
            #sc-lineup-daytabs { display: flex !important; gap: 10px !important; margin-bottom: 24px !important; }
            .sc-lineup-daytab {
                background: rgba(255,255,255,0.08) !important; border: 1px solid rgba(255,255,255,0.14) !important;
                color: rgba(255,255,255,0.7) !important; padding: 6px 18px !important;
                border-radius: 999px !important; font-size: 13px !important; cursor: pointer !important;
                text-transform: uppercase !important; letter-spacing: 0.06em !important;
            }
            .sc-lineup-daytab-active { background: rgba(255,255,255,0.9) !important; color: #111 !important; font-weight: 700 !important; }
            #sc-lineup-loading { color: rgba(255,255,255,0.5) !important; font-size: 15px !important; padding: 40px 0 !important; }
            .sc-lineup-section {
                background: var(--sc-lineup-wash, #14141a) !important;
                border-radius: 12px !important; padding: 18px 20px !important; margin-bottom: 18px !important;
            }
            .sc-lineup-section-name {
                font-size: 20px !important; font-weight: 700 !important; color: #fff !important;
                margin-bottom: 12px !important; display: flex !important; align-items: baseline !important; gap: 10px !important;
            }
            .sc-lineup-section-count { font-size: 12px !important; color: rgba(255,255,255,0.4) !important; font-family: system-ui, sans-serif !important; }
            .sc-lineup-rail { display: flex !important; gap: 12px !important; flex-wrap: wrap !important; }
            .sc-lineup-item {
                background: none !important; border: none !important; padding: 0 !important; cursor: pointer !important;
                width: 130px !important; flex-shrink: 0 !important;
            }
            .sc-lineup-poster {
                width: 130px !important; height: 182px !important; border-radius: 6px !important;
                background-size: cover !important; background-position: center !important;
                background-color: #222 !important; position: relative !important;
                box-shadow: 0 6px 20px rgba(0,0,0,0.5) !important;
                transition: transform 0.15s ease !important;
            }
            .sc-lineup-item:hover .sc-lineup-poster { transform: scale(1.04) !important; }
            .sc-lineup-item-current .sc-lineup-poster { outline: 2px solid var(--np-accent, #ff5b73) !important; }
            .sc-lineup-item-static { cursor: default !important; }
            .sc-lineup-poster-fallback {
                position: absolute !important; inset: 0 !important; display: flex !important;
                align-items: center !important; justify-content: center !important; text-align: center !important;
                color: rgba(255,255,255,0.8) !important; font-size: 12px !important; padding: 8px !important;
            }
            .sc-lineup-eta {
                position: absolute !important; left: 4px !important; right: 4px !important; bottom: 4px !important;
                background: rgba(0,0,0,0.75) !important; color: #fff !important; font-size: 10px !important;
                text-align: center !important; border-radius: 3px !important; padding: 2px 0 !important;
                letter-spacing: 0.04em !important;
            }
            .sc-lineup-item-current .sc-lineup-eta { background: var(--np-accent, #ff5b73) !important; }

```

- [ ] **Step 5: Verify syntax**

Run: `node --check cytube.pc.user.js`
Expected: no output, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add cytube.pc.user.js
git commit -m "Wire Coming Attractions button to Tonight's Lineup screen, retire old poster strip"
```

---

### Task 6: Manual end-to-end verification

**Files:** none (verification only; fix inline in `cytube.pc.user.js` if any check below fails, then re-run the failed check)

- [ ] **Step 1: Install the updated script and load a real session**

Open Tampermonkey's dashboard, update the `cytube.pc.user.js` source from the working tree (or re-import the file), and open `https://cytu.be/r/420Grindhouse` (or `https://cytu.be/r/testing`) in the browser.

- [ ] **Step 2: Verify the button and live fetch**

Click **Coming Attractions**. Expected: the full-screen overlay opens, shows "Fetching tonight's lineup…" briefly, then renders day tabs (Friday/Saturday/Sunday) with today's day selected and its sections stacked, each with a distinct color/font per the section name. Open the browser console and confirm no uncaught errors.

- [ ] **Step 3: Verify caching**

Reload the page and click **Coming Attractions** again. Expected: the screen renders immediately (no "Fetching…" flash), confirming `localStorage['sc_lineup_cache_v1']` was read instead of refetching. Inspect that key in DevTools → Application → Local Storage to confirm its shape matches `{postId, title, publishedAt, days, fetchedAt}`.

- [ ] **Step 4: Verify now-playing + click-through**

While a film from tonight's schedule is playing, open the lineup screen. Expected: that film's poster shows a "NOW PLAYING" badge and an accent outline. Click it — expected: the existing Now-Playing card opens (not auto-hiding, since `autoHide: false` was passed) with poster/backdrop/overview/rating/runtime/genres and, if configured, parental-guide chips and kill count.

- [ ] **Step 5: Verify ETA labels**

With the schedule loaded, confirm the next 1-4 upcoming films in today's flat running order show an ETA label (`≈ H:MM AM/PM` for the very next one, `~ H:MM AM/PM` for the following few), and films beyond that show no label. Films already aired earlier today (before "now") show no label either.

- [ ] **Step 6: Verify the close button and dim/wake interaction**

Click the ✕ in the top-right of the overlay. Expected: it closes, the **Coming Attractions** button loses its active-state color, and the existing top-bar auto-dim/wake behavior (mouse near the top of the video) resumes normally afterward.

- [ ] **Step 7: Verify the offline/no-cache fallback**

In DevTools → Application → Local Storage, delete the `sc_lineup_cache_v1` key. In DevTools → Network, set throttling to "Offline" (or block `www.reddit.com` via a request-blocking rule). Reload the page and click **Coming Attractions**. Expected: one flat unsectioned row appears containing the current title (if a real feature is playing) plus whatever MOTD poster art is configured — no day tabs, no crash. Restore network access afterward.

- [ ] **Step 8: Verify vertical-monitor mode**

Toggle vertical mode (however this script's existing vertical-mode switch is triggered — check `isVerticalMonitor()` call sites if unsure) and repeat Step 2. Expected: the full-screen overlay still covers the viewport correctly and the **Coming Attractions** button remains reachable in its vertical-mode position (`body.sc-vertical #sc-poster-toggle`, top:0/right:0).

- [ ] **Step 9: Bump the version number and commit**

Update the `@version` line in the userscript header (currently `4.6.3`) to the next patch version, and update the matching `console.log('[SC] cytube.pc v...` line to match. Then:

```bash
git add cytube.pc.user.js
git commit -m "Bump version for Tonight's Lineup release"
```
