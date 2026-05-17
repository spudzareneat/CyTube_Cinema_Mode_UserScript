# CyTube 420 Grindhouse — Cinematic Interface Script

A Tampermonkey userscript that transforms [CyTube](https://cytu.be) into a cinema-style viewing experience for **420 Grindhouse**. The video fills the screen, chat floats alongside it, and a suite of features makes watching and chatting together more fun.

---

## Screenshots

<!-- Add screenshots here -->

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

<!-- Add screenshot here -->

---

### Coming Attractions

A hidden poster strip that reveals the upcoming weekend lineup with a single click.

- A **"Coming Attractions"** button sits just below the currently-playing title bar
- Click it to reveal a horizontal scrollable strip of movie poster thumbnails pulled directly from the channel MOTD
- Hover over any poster for a smooth zoom-in preview (animates from thumbnail size up to a larger inset, anchored above the strip)
- Click any poster to open the full image in a new tab
- Strip is hidden by default — the button toggles it on and off
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

### Grammar & Spell Check (LanguageTool)

Before a message is sent, it is checked against the free [LanguageTool](https://languagetool.org) API. If issues are found, a review modal appears.

- Checks grammar, typos, and commonly confused words (`their/there/they're`, `your/you're`, `its/it's`, `to/too/two`, etc.)
- Usernames, URLs, and hashtags are masked so they are never flagged
- Readability warnings for ALL CAPS words, repeated characters (`aaaaaaa`), and excessive punctuation (`!!!`)
- Click any highlighted error in the preview to see suggestions — apply one, or dismiss it
- Press **Enter** to send the reviewed message, **Escape** to go back and edit
- Can be turned off entirely in the settings modal

<!-- Add screenshot here -->

---

### Enhanced Chat Input

The default single-line chat box is replaced with a multi-line auto-expanding textarea.

- Grows automatically as you type (up to 120 px), then scrolls
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

### Floating Controls

Three buttons are fixed to the screen at all times, positioned relative to the current layout mode:

| Button | Function |
|--------|----------|
| ⛶ | Toggle browser fullscreen |
| ▦ | Open the CyTube emote picker |
| ⚙ | Open the script settings modal |

---

### Settings Modal

A settings panel for managing API keys and preferences. It opens automatically on first run if no keys are stored. Keys are saved to `localStorage` — they are never hard-coded.

- TMDB API key field (with a direct link to get one)
- DoesTheDogDie API key field (with a direct link to get one)
- Toggle to enable or disable the grammar/spell check popup

<!-- Add screenshot here -->

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

---

## Supported Channels

The script activates only on these URLs:

```
https://cytu.be/r/420Grindhouse


To add additional channels, edit the `@match` lines in the script header.

---

## External Services Used

| Service | Purpose | Requires Key |
|---------|---------|-------------|
| [TMDB](https://www.themoviedb.org/) | Movie metadata, IMDb ID, Letterboxd ID | Yes (free) |
| [DoesTheDogDie](https://www.doesthedogdie.com/) | Content warnings | Yes (free) |
| [LanguageTool](https://languagetool.org/) | Grammar and spell check | No |
| [Wikipedia](https://en.wikipedia.org/) | Movie Wikipedia links | No |
| [lklynet/Kill-Count](https://github.com/lklynet/Kill-Count) | On-screen kill counts | No |