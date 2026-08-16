# CyTube 420 Grindhouse — Cinematic Interface Script

A Tampermonkey userscript that transforms [CyTube](https://cytu.be) into a cinema-style viewing experience for **420 Grindhouse**. The video fills the screen, chat floats alongside it, and a suite of features makes watching and chatting together more fun.

---

## Screenshots

<img width="1910" height="965" alt="Screenshot 2026-05-18 191350(1)" src="https://github.com/user-attachments/assets/fd61fa98-e2a5-4424-90bd-e886e3a7aef3" />

---

## Features

### Cinematic Layout

The script hides all the standard CyTube chrome (navbar, playlist, userlist, footer, announcements) and repositions the video and chat for a clean viewing experience.

**Widescreen (horizontal) mode**
- Video occupies 80% of the screen width, full height
- Chat panel floats on the right in the remaining 20%

**Portrait (vertical) mode**
- Automatically detected when your monitor is taller than it is wide
- Video fills the top 55% of the screen
- Chat panel sits below it at the bottom 42%
- The script polls for orientation changes and switches layouts on the fly

**Resizable chat panel**
- Drag the thin handle on the chat panel's free edge — left/right in widescreen mode (resizes width), up/down in portrait mode (resizes height)
- The chosen size is remembered per layout and restored on reload

<!-- Add screenshot here -->

---

### Tonight's Lineup (Coming Attractions)

A full-screen schedule overlay that shows off the whole weekend's programming, not just what's currently playing.

- A **"Coming Attractions"** button sits just below the currently-playing title bar — click it to open the **Tonight's Lineup** screen
- Styled like a ticket stub, with day tabs (e.g. Fri/Sat/Sun) for browsing across the whole weekend
- Each themed block of the night gets its own section name, font, and accent color, with a horizontal rail of movie posters pulled from TMDB
- Titles that have already played are shown dimmed and grayed out
- Click any poster to open the full movie info card
- An optional experimental setting ("Coming Attractions live timing," off by default — see Settings Modal below) adds a **NOW PLAYING** badge on the current title and estimated start-time badges on upcoming ones
- Falls back to a simple flat strip with no day tabs if the schedule source can't be reached
- Adapts to both horizontal and vertical layout modes

<!-- Add screenshot here -->

---

### Movie Info Bar

When a new title starts playing, the script parses the filename and looks up the movie automatically. A row of icon links appears next to the title.

| Icon | Service | Requires |
|------|---------|----------|
| **i** | IMDb | TMDB API key |
| **L** | Letterboxd | TMDB API key |
| **W** | Wikipedia | None |

A stats bar fades in at the bottom-left of the video and auto-hides after 12 seconds showing:

- **Kill count** — on-screen kills pulled from the [lklynet/Kill-Count](https://github.com/lklynet/Kill-Count) database
- **Content warnings** from IMDb's Parent's Guide — color-coded severity per category (sex & nudity, violence & gore, profanity, alcohol/drugs/smoking, frightening scenes; red = severe, yellow = moderate, green = mild)

Filename parsing handles formats like `White.Fire.[1984].mkv` cleanly. YouTube bumpers and intros are detected and skipped automatically.

<!-- Add screenshot here -->

---

### IMDb Trivia

When a recognized movie is playing, a **Trivia** button appears (or press **T**) to pop open a scrollable panel of behind-the-scenes trivia facts pulled live from IMDb — up to 30 per title, cached so reopening it is instant. Press **Escape** to close the trivia panel.

<!-- Add screenshot here -->

---

### Grammar & Spell Check (LanguageTool)

Before a message is sent, it is checked against the free [LanguageTool](https://languagetool.org) API. If issues are found, a review modal appears.

- Checks grammar, typos, and commonly confused words (`their/there/they're`, `your/you're`, `its/it's`, `to/too/two`, etc.)
- Usernames, URLs, and hashtags are masked so they are never flagged
- Readability warnings for ALL CAPS words, repeated characters (`aaaaaaa`), and excessive punctuation (`!!!`)
- Click any highlighted error in the preview to see suggestions — apply one, or dismiss it
- Press **Enter** to send the reviewed message, **Escape** to go back and edit
- Can be turned off entirely in the settings modal

<img width="395" height="206" alt="Screenshot 2026-05-18 193930" src="https://github.com/user-attachments/assets/505064ee-1573-48ae-a0c3-83beaf7be811" />


---

### Enhanced Chat Input

The default single-line chat box is replaced with a multi-line auto-expanding textarea.

- Grows automatically as you type (up to 120 px), then scrolls
- Drag the handle above the box to set a fixed height instead — it's remembered on reload and stays put while typing
- **Enter** to send, **Shift+Enter** for a new line
- Native browser spellcheck enabled
- Works seamlessly with CyTube's emote picker — emote insertions mirror into the new textarea automatically

---

### Tab Autocomplete

Press **Tab** while typing to complete a username. Press it again to cycle through additional matches.

- Pulls names from the userlist and from recent chat messages
- Automatically prefixes `@` when completing at the start of a message
- Cycles through all matches in order

---

### Per-User Chat Colors

Every username in the chat buffer is assigned a consistent, deterministic color based on a hash of the name. Colors are high-saturation and bright enough to read on the dark background. Bolded for legibility.

---

### GIF Maker

Capture any scene as an animated GIF, straight from the player — no external tools.

> GIF Maker is an optional module — check it in the customizer (see Setup below) to include it in your build. The floating **◉** button and the ImgBB API key field / Optimize toggle in the Settings Modal described here only appear when the module is selected.

- Click the **◉** floating button to open the GIF maker
- **Lock in the start and end** of the clip with live preview thumbnails of each frame — use **⤓ Now** to grab the current playback position, or nudge each mark by ±0.5s
- Live **duration** readout, plus **FPS** and **Width** controls to balance quality vs. size
- **Shape** options force a consistent **4:3** output — *Crop* (center-crop) or *Bars* (letterbox), or keep the video's *Native* ratio. The preview thumbnails reframe to show exactly what you'll get
- **Meme captions** — type separate top and bottom text lines, choose white or yellow lettering (with a bold black outline), and set each line's size as a percentage of the frame. Drag the handle dot on the start/end preview thumbnails to position each caption anywhere on the frame — the preview updates live and matches exactly what gets baked into the final GIF
- Animated spinners while frames are captured and the GIF is encoded (encoding runs in a Web Worker so the page never freezes)
- When done: **⬇ Download** the GIF, or **☁ Upload** it to [ImgBB](https://imgbb.com/) and get a shareable direct link with a **⧉ Copy link** button — ready to paste into chat

> Frame capture reads the video pixels directly, so it works on the channel's hosted movie files. YouTube and other iframe/streaming (HLS) sources can't be captured.

<!-- Add screenshot here -->

---

### Chat Image Embeds

Direct image links posted in chat (postimg.cc, imgur, Discord CDN, etc.) show up as an inline thumbnail instead of a bare link.

> Chat Images is an optional module — check it in the customizer (see Setup below) to include it in your build. Once included, it's governed by the Settings Modal's "Auto-embed image links in chat" toggle.

- Hover a thumbnail to see the original filename as a tooltip
- Click **🔗** on an embed to flip that one instance between the thumbnail and the plain link, without affecting anything else
- Click **🚫** on an embed to ban that exact image — it collapses to a plain link everywhere it's already been posted, and never embeds again on future reposts of the same URL. A **↩ unban** link sits right next to a banned image's link if you change your mind
- Bans are personal — stored in your own browser, not shared with anyone else in the channel

---

### Subtitle Sync

Load a local `.srt` or `.vtt` file and sync it to the currently playing video, with a live offset control for files that aren't quite aligned.

> Subtitle Sync is an optional module — check it in the customizer (see Setup below) to include it in your build. Once included, it adds the floating **CC** button described in Floating Controls below. Not available for YouTube playback — native `<video>` only.

- Click **CC** to open the Subtitles panel, then choose a `.srt` or `.vtt` file — cues render using the browser's native caption rendering, so sync tracks playback exactly
- Nudge the offset ±100ms with the **−100ms** / **+100ms** buttons, or type an exact value and click **Set**
- Nudge the offset from anywhere with **[** / **]** (±100ms) or **Shift+[** / **Shift+]** (±1000ms) — ignored while typing in chat or another input
- **Clear subtitles** removes the loaded track; subtitles also clear automatically whenever the channel changes media
- Nothing is uploaded or shared — the file and its offset are session-local to your browser

---

### Movie Lead Time

Keeps your playback a few seconds ahead of the group's synced position during movies, cushioning against your own buffering — if playback stalls, the next sync correction settles you back to "group position + lead" instead of all the way down to the bare group position.

> Movie Lead Time is an optional module — check it in the customizer (see Setup below) to include it in your build. Once included, it adds a **Movie lead time (seconds ahead of sync)** number field (0–10, default 2) to the Settings Modal. Not applied during YouTube playback.

---

### Chat-to-Movie Seek

**Right-click any chat message** for two options based on roughly when that message was posted (minus a 5-second lead-in):
- **⤺ Jump movie to...** desyncs you from the group stream and rewinds to that moment
- **◉ Create a GIF from here** opens the GIF Maker with its start mark already scrubbed to that moment (requires the GIF Maker module)

Messages from a previous movie are detected and don't offer either option.

---

### Floating Controls

A row of buttons is fixed to the screen at all times, positioned relative to the current layout mode:

| Button | Function |
|--------|----------|
| ⛶ | Toggle browser fullscreen |
| ▦ | Open the CyTube emote picker |
| ⟳ | Free watch — desync from the group stream, click again to re-sync |
| ◉ | Open the GIF maker (requires the GIF Maker module) |
| CC | Open the Subtitles panel (requires the Subtitle Sync module) |
| ⚙ | Open the script settings modal |

---

### Settings Modal

A settings panel for managing API keys and preferences. It opens automatically on first run if no keys are stored. Keys are saved to `localStorage` — they are never hard-coded.

- TMDB API key field (with a direct link to get one)
- ImgBB API key field for GIF uploads (with a direct link to get one)
- Toggle to enable or disable the grammar/spell check popup
- Chat font size slider
- Toggle for experimental **Coming Attractions live timing** (NOW PLAYING / ETA badges in Tonight's Lineup — requires a TMDB key, off by default, still being tuned)

> Some fields are module-conditional: the ImgBB API key field and "Optimize GIFs before upload" toggle only appear when GIF Maker is included in your build, "Auto-embed image links in chat" only appears when Chat Images is included, and "Movie lead time" only appears when Movie Lead Time is included. Unchecking a module in the customizer removes its fields from the modal entirely, rather than just disabling them.

<img width="357" height="355" alt="Screenshot 2026-05-18 191527" src="https://github.com/user-attachments/assets/69fa3a59-e05d-4237-8ce1-0a93ae9a8407" />

---

## Setup

### 1. Install a userscript manager

You need a browser extension that can run userscripts. The most common options:

- [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge, Safari) — recommended
- [Violentmonkey](https://violentmonkey.github.io/) (Chrome, Firefox)
- [Greasemonkey](https://www.greasespot.net/) (Firefox)

### 2. Build and install your script

The main script is no longer a single file you copy-paste — it's assembled to order by a customizer page, so you only ship the features you actually want.

1. Visit the customizer: **https://spudzareneat.github.io/CyTube_Cinema_Mode_UserScript/**
   > This is the standard GitHub Pages URL for this repo (it serves the `docs/` folder). If the page 404s, GitHub Pages hasn't been enabled for the repo yet — that's a one-time setting under the repo's **Settings → Pages** that only the repo owner can flip; it isn't something you can fix locally. (Whether this particular branch's changes are live there depends on whether it has been pushed and merged — not something that can be confirmed from here.)
2. Under **Features**, check whichever optional modules you want. **Core** is always included and can't be unchecked; every optional module — Movie Title Links, IMDb Trivia, Tonight's Lineup, Grammar Check, Chat Images, GIF Maker, Subtitle Sync, and Movie Lead Time — is checked by default and can be unchecked individually (see their sections above for what each does).
3. Click **Build my script**, then **Download** (or **Copy to clipboard**) — this produces one `cytube.pc.custom.user.js` file for your chosen module combination.
4. Open Tampermonkey's dashboard, click **Create a new script**, and paste in (or drag in) the downloaded file. Save with **Ctrl+S** (or **Cmd+S**).
5. Navigate to `https://cytu.be/r/420Grindhouse` — the script runs automatically.

> **Note on phase-2 features:** emote-mirror, emote-relocation, chat-seek, chat-timestamps, channel-emoji, poll-watcher, user-count-panel, and chat-resizer are still bundled inside **Core** for now — they aren't independently toggleable on the customizer yet. A future update may split them out into their own selectable modules the same way the others already have been.

> **Legacy standalone scripts:** The original single-purpose scripts this project shipped before the customizer existed — `cytube.gifmaker.user.js`, `cytube.chatimages.user.js`, `cytube.subtitles.user.js`, and `cytube.rename-title.user.js` — still live at the repo root for anyone who'd rather install one individually the old way (each is still a self-contained Tampermonkey script). They're kept around as-is, but they are **unsupported and legacy going forward**: they won't receive further updates, and future module work targets only the customizer-built script. The supported path is checking the equivalent module in the customizer, as described above.

### 3. Enter your API keys (first run)

A settings modal will appear automatically the first time you visit the channel. You can re-open it any time via the **⚙** button.

Both keys below are free and optional, but the TMDB key unlocks the movie info features:

#### TMDB API Key
Unlocks IMDb links, Letterboxd links, kill counts, and IMDb Parent's Guide content warnings.

1. Create a free account at [themoviedb.org](https://www.themoviedb.org/)
2. Go to **Settings → API**: `https://www.themoviedb.org/settings/api`
3. Request an API key — choose "Personal / Developer" use
4. Copy the **API Key (v3 auth)** value and paste it into the settings modal

#### ImgBB API Key
Optional — enables the **☁ Upload** button in the GIF maker to host a GIF and give you a shareable link.

1. Create a free account at [imgbb.com](https://imgbb.com/)
2. Go to `https://api.imgbb.com/` and click **Add** / **Get API key**
3. Copy the key and paste it into the settings modal (no app registration required)

---

## Supported Channels

The script targets `https://cytu.be/r/420Grindhouse`. To add additional channels, edit the `@match` lines in the script header.

---

## Vibe Coded with Claude

This project was 100% vibe coded using [Claude](https://claude.ai) by Anthropic. Every feature, bug fix, and line of CSS was written through natural language conversation with Claude Code — no manual coding required.

---

## External Services Used

| Service | Purpose | Requires Key |
|---------|---------|-------------|
| [TMDB](https://www.themoviedb.org/) | Movie metadata, IMDb ID, Letterboxd ID | Yes (free) |
| [LanguageTool](https://languagetool.org/) | Grammar and spell check | No |
| [Wikipedia](https://en.wikipedia.org/) | Movie Wikipedia links | No |
| [lklynet/Kill-Count](https://github.com/lklynet/Kill-Count) | On-screen kill counts | No |
| [ImgBB](https://imgbb.com/) | GIF hosting / shareable links | Yes (free) |
| [cdnjs.cloudflare.com](https://cdnjs.com/) | Serves gif.js (GIF encoding library, GIF Maker module) | No |
| [cdn.jsdelivr.net](https://www.jsdelivr.com/) | Serves gifsicle (GIF optimization library, GIF Maker module) | No |
