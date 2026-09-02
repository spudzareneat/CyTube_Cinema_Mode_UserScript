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

       REACHABILITY: originally this tried a GM_xmlhttpRequest probe
       before ever showing the button, to hide it when the bot's "off".
       Live testing found that fundamentally doesn't work here: a
       cross-origin fetch() from cytu.be to the bot 404s/fails outright
       (confirmed live -- "Failed to fetch"), and GM_xmlhttpRequest fared
       no better even with a browser User-Agent and retries -- whatever's
       fronting the bot (Cloudflare, confirmed via its /cdn-cgi/rum
       beacon) rejects cross-origin *scripted* requests to it, unrelated
       to whether the bot itself is actually up. Loading the SAME url in
       an <iframe> works fine, because a frame navigation isn't a
       scripted cross-origin request the way fetch/XHR is -- so this
       module can't reliably know "is it on" *before* trying to show it;
       it can only find out by trying, the same way a plain iframe embed
       always has. The button is therefore shown unconditionally, and
       "off" is instead handled inside the panel: ensureFrame() races the
       iframe's load event against a timeout and shows a fallback message
       if neither a real load nor content shows up in time.

       WAKE/IDLE-DIM: this button IS in core's getDimEls() idle-fade
       group (14-chat-panel-chrome.js), same as #sc-trivia-btn -- it fades
       to opacity:0/pointer-events:none 3.5s after the last qualifying
       mousemove. Confirmed live that a plain hover-then-pause-then-click
       reliably lands on an already-dimmed, unclickable button (neither
       this module nor imdb-trivia previously integrated with the
       _topBarIsOpen/_topBarWake guard tonights-lineup's full-screen
       overlay uses to stay visible while in use). Two things prevent
       that here:
       - While the panel is open, _topBarIsOpen is held true, which
         short-circuits dim() entirely (14-chat-panel-chrome.js's own
         `if (_topBarIsOpen || !playing) return;`). This matters even
         more than it does for tonights-lineup's overlay: most of this
         panel's area is the bot's cross-origin iframe, whose mouse
         activity our page's mousemove listener can never see at all, so
         the normal "activity keeps it awake" mechanism wouldn't apply
         even while someone's actively reading the schedule inside it.
       - While merely hovering the (still closed) button -- deciding
         whether to click -- a periodic _topBarWake() ping keeps it from
         fading out mid-decision, since a stationary hover fires no
         further mousemove events for the document-level listener to
         react to.
       Like tonights-lineup's own _topBarIsOpen = false on close, this
       doesn't reference-count against other _topBarIsOpen users -- if
       tonights-lineup's screen were somehow also open when this panel
       closes, this would clear its protection too. Same limitation
       tonights-lineup itself already has in reverse; not solved here.

       POSITIONING: the top-bar row, left to right, is
       [● Pop-ups] [Trivia] [UP NEXT] [Coming Attractions]. The two
       trivia buttons (movie-title-links / imdb-trivia / trivia-popup)
       come and go with the current video's IMDb match; #sc-poster-toggle
       ("Coming Attractions", tonights-lineup) is effectively always
       present and is the row's fixed right end. So up-next anchors off
       #sc-poster-toggle -- its live measured position (viewport px, not
       a formula) is used to slide up-next just to its left, which is
       robust across horizontal/vertical layouts and any future width
       change of that button. #sc-trivia-btn / #sc-trivia-popup-btn then
       sit further left again via their own fixed offsets (in
       imdb-trivia / trivia-popup style.css), sized to clear UP NEXT.
       When #sc-poster-toggle is absent (a build without tonights-lineup)
       up-next falls back to its default CSS slot.
    ========================================================== */

    const UPNEXT_BOT_URL = 'https://bot.420grindhouseserver.com';
    const UPNEXT_ROW_GAP_PX = 6;
    const UPNEXT_LOAD_TIMEOUT_MS = 10000;
    const UPNEXT_HOVER_WAKE_INTERVAL_MS = 1500; // well under the 3.5s dim delay

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
            <div id="sc-upnext-body"><div class="sc-upnext-loading">Loading…</div></div>`;
        document.body.appendChild(panel);

        const frameHost = panel.querySelector('#sc-upnext-body');

        let panelOpen = false;
        let frameCreated = false;

        // Lazy-create the iframe on first open rather than eagerly at init,
        // so a viewer who never opens the panel never pays for a background
        // iframe load. See REACHABILITY above for why this races load
        // against a timeout instead of trusting a pre-flight check.
        const ensureFrame = () => {
            if (frameCreated) return;
            frameCreated = true;

            const iframe = document.createElement('iframe');
            iframe.id = 'sc-upnext-frame';
            iframe.title = 'Upcoming queue';
            iframe.style.display = 'none';

            let settled = false;
            const showFrame = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                frameHost.querySelector('.sc-upnext-loading')?.remove();
                iframe.style.display = 'block';
            };
            const showError = () => {
                if (settled) return;
                settled = true;
                frameHost.innerHTML = '<div class="sc-upnext-error">Schedule unavailable right now.</div>';
            };
            iframe.addEventListener('load', showFrame);
            iframe.addEventListener('error', showError);
            const timeoutId = setTimeout(showError, UPNEXT_LOAD_TIMEOUT_MS);

            iframe.src = UPNEXT_BOT_URL;
            frameHost.appendChild(iframe);
        };

        // Sit just left of #sc-poster-toggle ("Coming Attractions") --
        // measured live (viewport px, not a formula) so it stays robust
        // across horizontal/vertical layouts and any future width change of
        // that button. See POSITIONING above. When it's absent (a build
        // without tonights-lineup) fall back to the CSS default slot.
        const positionInRow = () => {
            const anchor = document.getElementById('sc-poster-toggle');
            if (anchor) {
                const rightPx = window.innerWidth - anchor.getBoundingClientRect().left + UPNEXT_ROW_GAP_PX;
                btn.style.right = rightPx + 'px';
            } else {
                btn.style.right = ''; // CSS default
            }
            panel.style.right = btn.style.right;
        };

        const closePanel = () => {
            panel.style.display = 'none';
            panelOpen = false;
            btn.classList.remove('sc-upnext-btn-active');
            _topBarIsOpen = false; // see WAKE/IDLE-DIM above
        };

        btn.addEventListener('click', () => {
            panelOpen = !panelOpen;
            if (panelOpen) {
                ensureFrame();
                panel.style.display = 'flex';
                btn.classList.add('sc-upnext-btn-active');
                _topBarIsOpen = true; // see WAKE/IDLE-DIM above
                if (_topBarWake) _topBarWake();
            } else {
                closePanel();
            }
        });

        panel.querySelector('#sc-upnext-close').addEventListener('click', closePanel);

        // Keep the button awake while the user is hovering it deciding
        // whether to click -- see WAKE/IDLE-DIM above for why a stationary
        // hover alone doesn't already do this.
        let hoverWakeTimer = null;
        btn.addEventListener('mouseenter', () => {
            if (_topBarWake) _topBarWake();
            if (hoverWakeTimer) return;
            hoverWakeTimer = setInterval(() => { if (_topBarWake) _topBarWake(); }, UPNEXT_HOVER_WAKE_INTERVAL_MS);
        });
        btn.addEventListener('mouseleave', () => {
            clearInterval(hoverWakeTimer);
            hoverWakeTimer = null;
        });

        // Close on outside click
        document.addEventListener('click', e => {
            if (panelOpen && !btn.contains(e.target) && !panel.contains(e.target)) closePanel();
        });

        // #sc-poster-toggle is a direct document.body child (like every
        // floating top-bar button here, never nested) added once at init --
        // childList on body alone catches its arrival without subtree:true,
        // which would otherwise re-fire (and force a layout read in
        // positionInRow) on every chat message and userlist update. The
        // trivia buttons appearing/disappearing per media change also fire
        // this, harmlessly recomputing the same anchor.
        positionInRow();
        new MutationObserver(positionInRow)
            .observe(document.body, { childList: true });

        // #sc-poster-toggle's own `right` is calc(var(--sc-chat-w) + 1vw),
        // which tracks window resize live; our cached inline px `right`
        // doesn't, so re-measure on resize too (rAF-coalesced so a drag
        // doesn't thrash layout). Chat-panel drag-resize changes
        // --sc-chat-w without a resize event -- UP NEXT stays put there
        // until the next body mutation re-syncs it, same as before.
        let _rafPending = false;
        window.addEventListener('resize', () => {
            if (_rafPending) return;
            _rafPending = true;
            requestAnimationFrame(() => { _rafPending = false; positionInRow(); });
        });
    } // end _initUpNext

    scRegisterInit(initUpNext);
