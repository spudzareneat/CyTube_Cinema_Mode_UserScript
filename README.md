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
- **Content warnings** from DoesTheDogDie — dog/cat deaths, jump scares, nudity, sexual violence, spiders, eye trauma, clowns, needles, decapitation, and more

Filename parsing handles formats like `White.Fire.[1984].mkv` cleanly. YouTube bumpers and intros are detected and skipped automatically.

<!-- Add screenshot here -->

---

### IMDb Trivia & Parent Guide

When a recognized movie is playing, a **Trivia** button appears (or press **T**) to pop open a scrollable panel of behind-the-scenes trivia facts pulled live from IMDb — up to 30 per title, cached so reopening it is instant. Separately, the stats bar under the title shows IMDb's Parent's Guide content as color-coded severity dots per category (red = severe, yellow = moderate, green = mild), so content concerns are visible at a glance without leaving the player. Press **Escape** to close the trivia panel.

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

> Requires installing **`cytube.gifmaker.user.js`** as a separate userscript (see Setup below) — it owns the actual capture/encode/upload logic. When it's installed alongside `cytube.pc.user.js`, the GIF button becomes the floating **◉** button described here, and the ImgBB API key field / Optimize toggle move into `cytube.pc.user.js`'s Settings Modal instead of appearing inline in the GIF panel. Installed on its own, `cytube.gifmaker.user.js` still works standalone, with those fields inline and the record button in the video's own control bar.

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

### Chat-to-Movie Seek

**Right-click any chat message** for two options based on roughly when that message was posted (minus a 5-second lead-in):
- **⤺ Jump movie to...** desyncs you from the group stream and rewinds to that moment
- **◉ Create a GIF from here** opens the GIF Maker with its start mark already scrubbed to that moment (requires `cytube.gifmaker.user.js`)

Messages from a previous movie are detected and don't offer either option.

---

### Floating Controls

A row of buttons is fixed to the screen at all times, positioned relative to the current layout mode:

| Button | Function |
|--------|----------|
| ⛶ | Toggle browser fullscreen |
| ▦ | Open the CyTube emote picker |
| ⟳ | Free watch — desync from the group stream, click again to re-sync |
| ◉ | Open the GIF maker (requires `cytube.gifmaker.user.js`) |
| ⚙ | Open the script settings modal |

---

### Settings Modal

A settings panel for managing API keys and preferences. It opens automatically on first run if no keys are stored. Keys are saved to `localStorage` — they are never hard-coded.

- TMDB API key field (with a direct link to get one)
- DoesTheDogDie API key field (with a direct link to get one)
- ImgBB API key field for GIF uploads (with a direct link to get one)
- Toggle to enable or disable the grammar/spell check popup
- Chat font size slider
- Toggle for experimental **Coming Attractions live timing** (NOW PLAYING / ETA badges in Tonight's Lineup — requires a TMDB key, off by default, still being tuned)

<img width="357" height="355" alt="Screenshot 2026-05-18 191527" src="https://github.com/user-attachments/assets/69fa3a59-e05d-4237-8ce1-0a93ae9a8407" />

---

## Setup

### 1. Install a userscript manager

You need a browser extension that can run userscripts. The most common options:

- [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge, Safari) — recommended
- [Violentmonkey](https://violentmonkey.github.io/) (Chrome, Firefox)
- [Greasemonkey](https://www.greasespot.net/) (Firefox)

### 2. Install the script

1. Open Tampermonkey's dashboard and click **Create a new script**
2. Delete the placeholder content and paste in the full contents of `cytube.pc.user.js`
3. Save with **Ctrl+S** (or **Cmd+S**)
4. Navigate to `https://cytu.be/r/420Grindhouse` — the script runs automatically

### 2b. Install GIF Maker (optional, recommended)

GIF capture lives in its own userscript. Repeat the steps above with `cytube.gifmaker.user.js` to add it:

1. Open Tampermonkey's dashboard and click **Create a new script**
2. Delete the placeholder content and paste in the full contents of `cytube.gifmaker.user.js`
3. Save with **Ctrl+S** (or **Cmd+S**)

It can run alone or alongside `cytube.pc.user.js`. With both installed, the GIF button becomes the floating **◉** button and the ImgBB key / Optimize toggle move into `cytube.pc.user.js`'s Settings Modal (see GIF Maker above).

### 3. Enter your API keys (first run)

A settings modal will appear automatically the first time you visit the channel. You can re-open it any time via the **⚙** button.

Both keys are free and optional, but unlock the movie info features:

#### TMDB API Key
Unlocks IMDb links, Letterboxd links, kill counts, and DoesTheDogDie lookups.

1. Create a free account at [themoviedb.org](https://www.themoviedb.org/)
2. Go to **Settings → API**: `https://www.themoviedb.org/settings/api`
3. Request an API key — choose "Personal / Developer" use
4. Copy the **API Key (v3 auth)** value and paste it into the settings modal

#### DoesTheDogDie API Key
Unlocks content warnings (animal deaths, jump scares, nudity, etc.).

1. Create a free account at [doesthedogdie.com](https://www.doesthedogdie.com/)
2. Go to your **Profile** page: `https://www.doesthedogdie.com/profile`
3. Locate your API key in the profile settings
4. Copy it and paste it into the settings modal

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
| [DoesTheDogDie](https://www.doesthedogdie.com/) | Content warnings | Yes (free) |
| [LanguageTool](https://languagetool.org/) | Grammar and spell check | No |
| [Wikipedia](https://en.wikipedia.org/) | Movie Wikipedia links | No |
| [lklynet/Kill-Count](https://github.com/lklynet/Kill-Count) | On-screen kill counts | No |
| [ImgBB](https://imgbb.com/) | GIF hosting / shareable links | Yes (free) |
