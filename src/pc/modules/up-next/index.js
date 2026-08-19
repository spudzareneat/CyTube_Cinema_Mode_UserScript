    /* ==========================================================
       UP NEXT — small top-bar button that reveals the channel's
       "CyTube Schedule & Queue" dashboard (bot.420grindhouseserver.com),
       a community-run bot that is NOT part of this script and not
       something this repo controls. The button lives in the same
       floating top-bar row as #sc-trivia-btn/#sc-poster-toggle
       (movie-title-links/tonights-lineup modules) rather than the
       chat-header icon row -- see POSITIONING below for why. The
       panel-toggle/outside-click-to-close shell mirrors
       initPollWatcher/initUserCount (core/14-chat-panel-chrome.js).

       This module originally surfaced CyTube's own native #queue list,
       gated on the seeplaylist channel permission. Live testing showed
       the channel's real "upcoming queue" feature is this bot dashboard
       instead -- it shows real scheduled clock times (not just relative
       durations) and, unlike CyTube's native queue, isn't gated behind
       any CyTube rank/permission. So the panel embeds the bot's own
       page directly via iframe rather than scraping CyTube's DOM.

       "Is the feature on" means "is the bot reachable". That's checked
       once via GM_xmlhttpRequest before ever creating a visible iframe,
       rather than relying on the iframe's own load/error events --
       cross-origin <iframe> error events are notoriously unreliable for
       network-level failures (Chrome still fires 'load' for its own
       internal error page in many failure cases), so a real HTTP round
       trip is the only trustworthy signal here. Checked once at init,
       not re-polled -- there's no live "went down mid-session" handling;
       repeatedly re-probing/reloading an embedded iframe isn't worth the
       cost the way the old permission recheck (a cheap DOM/property
       read) was.

       POSITIONING: #sc-trivia-btn (movie-title-links/index.js) is
       removed and re-created on every media change, present only when
       the current video has a matched IMDb id -- there's no persistent
       "trivia is off" state to read, just its live DOM presence. Rather
       than duplicate movie-title-links' title-change lifecycle, this
       module just watches for #sc-trivia-btn's presence directly:
       - No trivia button: up-next's default CSS position (style.css)
         deliberately duplicates trivia's own base slot
         (calc(var(--sc-chat-w) + 1vw + 150px) horizontal / 150px
         vertical, see imdb-trivia/style.css's #sc-trivia-btn rule) so
         it takes that exact spot with no gap.
       - Trivia button present: its live measured position (viewport
         px, not a formula) is used to slide up-next just outside it --
         a real layout measurement is robust across horizontal/vertical
         layouts and any future trivia-button width change, where a
         second hardcoded formula would drift out of sync with the
         first.
    ========================================================== */

    const UPNEXT_BOT_URL = 'https://bot.420grindhouseserver.com';
    const UPNEXT_TRIVIA_GAP_PX = 6;

    // Same Promise-wrapped GM_xmlhttpRequest shape already used elsewhere in
    // this repo for a reachability/data probe (see tonights-lineup/index.js's
    // lineupGmFetch) -- not shared code, just the same established idiom.
    function upnextProbe(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'HEAD',
                url,
                timeout: 8000,
                onload: res => (res.status >= 200 && res.status < 400) ? resolve() : reject(res),
                onerror: reject,
                ontimeout: reject,
            });
        });
    }

    function initUpNext() {
        // document.body always exists by the time init functions run
        // (scRegisterInit callbacks fire from waitForBody's 'load' handler,
        // core/16-boot.js) -- no element-wait needed here, unlike the old
        // #sc-chat-header/#queue version this replaced.
        _initUpNext();
    }

    function _initUpNext() {
        const btn = document.createElement('button');
        btn.id = 'sc-upnext-btn';
        btn.title = 'Upcoming queue';
        btn.textContent = 'UP NEXT';
        btn.style.display = 'none'; // hidden until the bot proves reachable
        document.body.appendChild(btn);

        // Head bar (title + close button) matches #sc-trivia-head/
        // #sc-trivia-close's exact shape (imdb-trivia/index.js) -- it's a
        // same-page DOM element sitting above the iframe, so it receives
        // clicks normally; the iframe's cross-origin content has no bearing
        // on that, only stacking/layout on our own page does.
        const panel = document.createElement('div');
        panel.id = 'sc-upnext-panel';
        panel.style.display = 'none';
        panel.innerHTML = `
            <div id="sc-upnext-head">
                <span id="sc-upnext-title">Up Next</span>
                <button id="sc-upnext-close" type="button">✕</button>
            </div>
            <div id="sc-upnext-body"></div>`;
        document.body.appendChild(panel);

        const frameHost = panel.querySelector('#sc-upnext-body');

        let panelOpen = false;
        let frameCreated = false;

        // Lazy-create the iframe on first open rather than eagerly at init,
        // so a viewer who never opens the panel never pays for a background
        // iframe load -- the reachability probe below is enough on its own
        // to decide button visibility.
        const ensureFrame = () => {
            if (frameCreated) return;
            frameCreated = true;
            const iframe = document.createElement('iframe');
            iframe.id = 'sc-upnext-frame';
            iframe.title = 'Upcoming queue';
            iframe.src = UPNEXT_BOT_URL;
            frameHost.appendChild(iframe);
        };

        // Sit just outside #sc-trivia-btn when it exists (measured live, not
        // formula-matched -- see POSITIONING above); otherwise fall back to
        // the CSS default, which deliberately mirrors trivia's own base slot.
        const positionNearTrivia = () => {
            const trivia = document.getElementById('sc-trivia-btn');
            if (trivia) {
                const rightPx = window.innerWidth - trivia.getBoundingClientRect().left + UPNEXT_TRIVIA_GAP_PX;
                btn.style.right = rightPx + 'px';
            } else {
                btn.style.right = ''; // CSS default (trivia's own slot)
            }
            panel.style.right = btn.style.right;
        };

        const closePanel = () => {
            panel.style.display = 'none';
            panelOpen = false;
            btn.classList.remove('sc-upnext-btn-active');
        };

        btn.addEventListener('click', () => {
            panelOpen = !panelOpen;
            if (panelOpen) {
                ensureFrame();
                panel.style.display = 'flex';
                btn.classList.add('sc-upnext-btn-active');
            } else {
                closePanel();
            }
        });

        panel.querySelector('#sc-upnext-close').addEventListener('click', closePanel);

        // Close on outside click
        document.addEventListener('click', e => {
            if (panelOpen && !btn.contains(e.target) && !panel.contains(e.target)) closePanel();
        });

        // #sc-trivia-btn is removed/recreated by movie-title-links on every
        // media change, always as a direct document.body.appendChild (same
        // as every other floating top-bar button here, never nested) -- so
        // childList on body alone catches it without subtree:true, which
        // would otherwise re-fire (and force a layout read in
        // positionNearTrivia) on every chat message and userlist update.
        positionNearTrivia();
        new MutationObserver(positionNearTrivia)
            .observe(document.body, { childList: true });

        upnextProbe(UPNEXT_BOT_URL).then(() => {
            btn.style.display = '';
        }).catch(() => {
            // Bot unreachable -- this is the "feature turned off" case for this
            // module. Leave the button hidden and drop the panel/listeners'
            // target entirely; there's nothing left for them to show.
            panel.remove();
        });
    } // end _initUpNext

    scRegisterInit(initUpNext);
