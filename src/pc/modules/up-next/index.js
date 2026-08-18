    /* ==========================================================
       UP NEXT — small chat-header button that reveals CyTube's native
       upcoming-queue list (#queue), which this script otherwise hides
       visually. Sibling of initPollWatcher/_initPollWatcher and
       initUserCount (core/14-chat-panel-chrome.js): same element-wait,
       button+panel construction, outside-click-to-close, and
       MutationObserver-driven refresh idioms, reused here rather than
       reinvented.

       Gated on canSeeQueue() -- CyTube's own seeplaylist channel
       permission -- so the button only appears for users who could
       already see this list natively; this just surfaces it without
       the layout cost of CyTube's own always-expanded queue UI.
    ========================================================== */

    // Playlist titles are free-form text any user at/above the channel's
    // playlist-add rank can set arbitrarily (e.g. via "add custom/raw file"),
    // unlike usernames (server-constrained to [\w-]) -- must be escaped before
    // going into panel.innerHTML in renderPanel() below, or a title like
    // "<img src=x onerror=...>" would execute. Same small-helper shape used
    // elsewhere in this repo for the same purpose (imdb-trivia/index.js,
    // grammar-check/index.js, etc.).
    function _upnextEscHtml(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function canSeeQueue() {
        try {
            const rank = _uw.CLIENT && typeof _uw.CLIENT.rank === 'number' ? _uw.CLIENT.rank : -Infinity;
            const need = _uw.CHANNEL && _uw.CHANNEL.perms && typeof _uw.CHANNEL.perms.seeplaylist === 'number'
                ? _uw.CHANNEL.perms.seeplaylist : Infinity;
            return rank >= need;
        } catch (e) { return false; }
    }

    function initUpNext() {
        // #sc-chat-header and #queue are both core/native elements that may
        // not be in the DOM yet at module-init time -- watch body until both
        // exist, mirroring initPollWatcher's tryInit/MutationObserver pattern
        // (14-chat-panel-chrome.js:121-139).
        const tryInit = () => {
            const header = document.getElementById('sc-chat-header');
            const queue = document.getElementById('queue');
            if (!header || !queue) {
                const bodyObs = new MutationObserver(() => {
                    if (document.getElementById('sc-chat-header') && document.getElementById('queue')) {
                        bodyObs.disconnect();
                        tryInit();
                    }
                });
                bodyObs.observe(document.body, { childList: true, subtree: true });
                return;
            }
            _initUpNext(header, queue);
        };
        tryInit();
    }

    function _initUpNext(header, queue) {
        const btn = document.createElement('button');
        btn.id = 'sc-upnext-btn';
        btn.title = 'Upcoming queue';
        btn.textContent = 'UP NEXT';
        header.appendChild(btn);

        // Create the floating panel
        const panel = document.createElement('div');
        panel.id = 'sc-upnext-panel';
        panel.style.display = 'none';
        document.body.appendChild(panel);

        let panelOpen = false;

        const renderPanel = () => {
            const entries = [...queue.querySelectorAll('.queue_entry')];
            if (!entries.length) {
                panel.innerHTML = '<div class="sc-upnext-empty">Nothing queued</div>';
                return;
            }
            panel.innerHTML = entries.map(entry => {
                const title = _upnextEscHtml(entry.querySelector('.qe_title')?.textContent?.trim() || '');
                const time = _upnextEscHtml(entry.querySelector('.qe_time')?.textContent?.trim() || '');
                const isNowPlaying = entry.classList.contains('queue_active');
                const row = `<div class="sc-upnext-row"><span class="sc-upnext-title">${title}</span><span class="sc-upnext-time">${time}</span></div>`;
                return isNowPlaying
                    ? `<div class="sc-upnext-entry sc-upnext-nowplaying"><div class="sc-upnext-nowplaying-label">Now Playing</div>${row}</div>`
                    : `<div class="sc-upnext-entry">${row}</div>`;
            }).join('');
        };

        const updateBtn = () => {
            const canSee = canSeeQueue();
            btn.style.display = canSee ? '' : 'none';
            if (!canSee && panelOpen) {
                panel.style.display = 'none';
                panelOpen = false;
                btn.classList.remove('sc-upnext-btn-active');
            }
        };

        btn.addEventListener('click', () => {
            panelOpen = !panelOpen;
            if (panelOpen) {
                renderPanel();
                panel.style.display = 'block';
                btn.classList.add('sc-upnext-btn-active');
                // #queue holds the WHOLE playlist, including already-played
                // entries above .queue_active -- jump straight to Now Playing
                // on open so a long-running playlist doesn't open scrolled to
                // stale history. Only on open (not on background refreshes
                // from the MutationObserver below), and after display:block
                // so the row has layout to scroll to.
                panel.querySelector('.sc-upnext-nowplaying')?.scrollIntoView({ block: 'start' });
            } else {
                panel.style.display = 'none';
                btn.classList.remove('sc-upnext-btn-active');
            }
        });

        // Close on outside click
        document.addEventListener('click', e => {
            if (panelOpen && !btn.contains(e.target) && !panel.contains(e.target)) {
                panel.style.display = 'none';
                panelOpen = false;
                btn.classList.remove('sc-upnext-btn-active');
            }
        });

        // Watch for queue changes
        new MutationObserver(() => {
            updateBtn();
            if (panelOpen) renderPanel();
        }).observe(queue, { childList: true, subtree: true, characterData: true });

        // Permission rank can change live (e.g. a channel admin adjusts the
        // seeplaylist requirement) without necessarily mutating #queue's DOM
        // at all -- there's no existing socket-event hook in this codebase
        // for permission changes to piggyback on instead, so poll.
        setInterval(updateBtn, 5000);

        updateBtn();
    } // end _initUpNext

    scRegisterInit(initUpNext);
