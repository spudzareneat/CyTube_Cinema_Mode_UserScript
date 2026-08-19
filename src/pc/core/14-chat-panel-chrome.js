    /* ==========================================================
       TOP-BAR / GAP-BUTTON DIM-ON-IDLE — generic chrome-dimming shared by
       every floating button (poster toggle, movie links, trivia, fs/desync/
       gif/settings), not specific to any one optional feature. Stays here
       in core rather than moving with any of them: 08-desync.js reads
       _gapShow directly, and the tonights-lineup module's initPosterStrip
       reads _topBarWake/_topBarIsOpen (both safe -- core always loads).
    ========================================================== */

    // Global wake/dim control — exposed so initPosterStrip (tonights-lineup
    // module) can call wake()
    let _topBarWake = null;
    let _topBarIsOpen = false;
    // Exposed so setDesynced() can force the floating buttons (fs/desync/gif/settings)
    // visible the moment desync starts, and re-poke them on resync.
    let _gapShow = null;

    function initTopBar() {
        // Gradient overlay — pointer-events:none so it never blocks clicks
        const bar = document.createElement('div');
        bar.id = 'sc-top-bar';
        document.body.appendChild(bar);

        let idleTimer  = null;
        let playing    = false; // true once the video has actually started

        // All elements that get .sc-bar-dim when the bar fades
        const getDimEls = () => [
            bar,
            document.getElementById('videowrap-header'),
            document.getElementById('sc-poster-toggle'),
            document.getElementById('sc-movie-links'),
            document.getElementById('sc-trivia-btn'),
            document.getElementById('sc-upnext-btn'),
        ].filter(Boolean);

        const dim = () => {
            if (_topBarIsOpen || !playing) return;
            getDimEls().forEach(el => el.classList.add('sc-bar-dim'));
        };

        const wake = () => {
            getDimEls().forEach(el => el.classList.remove('sc-bar-dim'));
            clearTimeout(idleTimer);
            if (!_topBarIsOpen && playing) idleTimer = setTimeout(dim, 3500);
        };
        _topBarWake = wake;

        // Start the countdown only when a video element starts playing
        const onVideoPlay = () => {
            if (playing) return; // already started once
            playing = true;
            clearTimeout(idleTimer);
            idleTimer = setTimeout(dim, 4000); // 4s after play starts
        };

        // Watch for video play events — video element may not exist yet at init
        const bindVideoEvents = () => {
            document.querySelectorAll('video').forEach(v => {
                if (!v._scPlayBound) {
                    v._scPlayBound = true;
                    v.addEventListener('play', onVideoPlay);
                }
            });
        };

        // Re-check whenever DOM changes (video element may be injected later)
        bindVideoEvents();
        new MutationObserver(bindVideoEvents)
            .observe(document.body, { childList: true, subtree: true });

        // Mouse near top of video area wakes the bar
        document.addEventListener('mousemove', (e) => {
            if (e.clientY < 60 && e.clientX < window.innerWidth * (isVerticalMonitor() ? 1 : 0.8)) {
                wake();
            }
        });
    }

    function initGapButtonDim() {
        const GAP_IDS = ['fs-toggle-btn', 'sc-desync-btn', 'sc-gif-btn', 'sc-settings-btn', 'scsub-trigger-btn'];
        let gapTimer = null;

        const gapShow = () => {
            clearTimeout(gapTimer);
            GAP_IDS.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.classList.remove('sc-bar-dim');
            });
            gapTimer = setTimeout(gapHide, 2500);
        };

        const gapHide = () => {
            if (_desync.active) return; // keep the desync button visible while desynced
            GAP_IDS.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.classList.add('sc-bar-dim');
            });
        };
        _gapShow = gapShow;

        document.addEventListener('mousemove', (e) => {
            const vw = document.getElementById('videowrap');
            if (!vw) return;
            const r = vw.getBoundingClientRect();
            const overVideo = e.clientX >= r.left && e.clientX <= r.right &&
                              e.clientY >= r.top  && e.clientY <= r.bottom;
            // Also keep visible when hovering the buttons themselves
            const overBtn = GAP_IDS.some(id => e.target.closest && e.target.closest('#' + id));
            if (overVideo || overBtn) gapShow();
        });

        // Start visible, hide after 4s of no video-area activity
        gapTimer = setTimeout(gapHide, 4000);
    }


    /* ==========================================================
       POLL / ANNOUNCEMENT WATCHER
    ========================================================== */

    function initPollWatcher() {
        // pollwrap may not exist yet or may be empty — watch for it
        const tryInit = () => {
            const pollwrap = document.getElementById('pollwrap');
            if (!pollwrap) {
                // Not in DOM yet, watch body
                const bodyObs = new MutationObserver(() => {
                    if (document.getElementById('pollwrap')) {
                        bodyObs.disconnect();
                        tryInit();
                    }
                });
                bodyObs.observe(document.body, { childList: true, subtree: true });
                return;
            }
            _initPollWatcher(pollwrap);
        };
        tryInit();
    }

    function _initPollWatcher(pollwrap) {

        // Create the notification button — only shown when poll has content
        const header = document.getElementById('sc-chat-header');
        if (!header) return;
        const btn = document.createElement('button');
        btn.id = 'sc-poll-btn';
        btn.title = 'Channel announcement / poll';
        btn.textContent = 'POLL';
        header.appendChild(btn);

        // Create the floating panel
        const panel = document.createElement('div');
        panel.id = 'sc-poll-panel';
        panel.style.display = 'none';
        document.body.appendChild(panel);

        let panelOpen = false;

        const renderPanel = () => {
            // Clone pollwrap content so we can restyle without affecting original
            const well = pollwrap.querySelector('.well.active') || pollwrap.querySelector('.well');
            if (!well) { panel.innerHTML = ''; return; }

            // Extract just the useful parts: heading + options
            const h = well.querySelector('h3')?.textContent?.trim() || '';
            const opts = [...well.querySelectorAll('.option')].map(o => {
                // Get text without the vote count button text
                const btn = o.querySelector('button');
                const text = o.textContent.replace(btn?.textContent || '', '').trim();
                // Preserve links
                const links = [...o.querySelectorAll('a')].map(a =>
                    `<a href="${a.href}" target="_blank" rel="noopener noreferrer">${a.textContent}</a>`
                );
                let html = o.innerHTML.replace(/<button[^>]*>.*?<\/button>/i, '').trim();
                return `<div class="sc-poll-option">${html}</div>`;
            });

            // Time/author label
            const label = well.querySelector('.label')?.textContent?.trim() || '';
            const author = well.querySelector('.label')?.getAttribute('title') || '';

            panel.innerHTML = `
                <div class="sc-poll-header">${h}</div>
                <div class="sc-poll-options">${opts.join('')}</div>
                ${label ? `<div class="sc-poll-meta">${author ? author + ' · ' : ''}${label}</div>` : ''}
            `;
        };

        const hasPollContent = () => {
            // CyTube marks open polls with .well.active
            // Fall back to any .well with content if no active class
            const activeWell = pollwrap.querySelector('.well.active') || pollwrap.querySelector('.well');
            return !!(activeWell && activeWell.textContent.trim().length > 10);
        };

        const updateBtn = () => {
            const hasContent = hasPollContent();
            btn.style.display = hasContent ? '' : 'none';
            if (!hasContent && panelOpen) {
                panel.style.display = 'none';
                panelOpen = false;
                btn.classList.remove('sc-poll-btn-active');
            }
        };

        btn.addEventListener('click', () => {
            panelOpen = !panelOpen;
            if (panelOpen) {
                renderPanel();
                panel.style.display = 'block';
                btn.classList.add('sc-poll-btn-active');
            } else {
                panel.style.display = 'none';
                btn.classList.remove('sc-poll-btn-active');
            }
        });

        // Close on outside click
        document.addEventListener('click', e => {
            if (panelOpen && !btn.contains(e.target) && !panel.contains(e.target)) {
                panel.style.display = 'none';
                panelOpen = false;
                btn.classList.remove('sc-poll-btn-active');
            }
        });

        // Watch for poll changes
        new MutationObserver(() => {
            updateBtn();
            if (panelOpen) renderPanel();
        }).observe(pollwrap, { childList: true, subtree: true, characterData: true });

        updateBtn();
    } // end _initPollWatcher

    /* ==========================================================
       USER COUNT PANEL
    ========================================================== */

    function initChatHeader() {
        if (document.getElementById('sc-chat-header')) return;
        const header = document.createElement('div');
        header.id = 'sc-chat-header';
        document.body.appendChild(header);
    }

    /* ==========================================================
       CHAT PANEL RESIZER
       Drags --sc-chat-w (horizontal layout) / --sc-chat-h (vertical layout)
       live, then persists the result so it survives reload.
    ========================================================== */

    function initChatResizer() {
        if (document.getElementById('sc-chat-resizer')) return;
        const handle = document.createElement('div');
        handle.id = 'sc-chat-resizer';
        document.body.appendChild(handle);

        const root = document.documentElement;
        let dragging = false, mode, startX, startY, startW, startH;

        handle.addEventListener('mousedown', e => {
            e.preventDefault();
            dragging = true;
            mode = document.body.classList.contains('sc-vertical') ? 'vertical' : 'horizontal';
            startX = e.clientX; startY = e.clientY;
            startW = getChatPanelWidth();
            startH = getChatPanelHeight();
            handle.classList.add('sc-resizing');
            document.body.style.userSelect = 'none';
        });

        window.addEventListener('mousemove', e => {
            if (!dragging) return;
            if (mode === 'horizontal') {
                const deltaVw = (startX - e.clientX) / window.innerWidth * 100; // drag left = wider
                const w = Math.min(CHAT_PANEL_W_MAX, Math.max(CHAT_PANEL_W_MIN, startW + deltaVw));
                root.style.setProperty('--sc-chat-w', w + 'vw');
            } else {
                const deltaVh = (startY - e.clientY) / window.innerHeight * 100; // drag up = taller
                const h = Math.min(CHAT_PANEL_H_MAX, Math.max(CHAT_PANEL_H_MIN, startH + deltaVh));
                root.style.setProperty('--sc-chat-h', h + 'vh');
            }
        });

        window.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('sc-resizing');
            document.body.style.userSelect = '';
            if (mode === 'horizontal') {
                setKey(LS_CHAT_PANEL_W, String(parseFloat(root.style.getPropertyValue('--sc-chat-w')) || getChatPanelWidth()));
            } else {
                setKey(LS_CHAT_PANEL_H, String(parseFloat(root.style.getPropertyValue('--sc-chat-h')) || getChatPanelHeight()));
            }
        });
    }

    function initUserCount() {
        const header = document.getElementById('sc-chat-header');
        if (!header) return;
        const btn = document.createElement('button');
        btn.id = 'sc-usercount-btn';
        header.appendChild(btn);

        // Create users panel
        const panel = document.createElement('div');
        panel.id = 'sc-users-panel';
        document.body.appendChild(panel);

        let open = false;

        const getUsers = () => {
            const items = [...document.querySelectorAll('#userlist .userlist_item')];
            return items
                .map(item => {
                    // CyTube structure: <span>(rank icon)</span><span (optional class)>Name</span>
                    // Get the second span which always contains the username
                    const spans = item.querySelectorAll('span');
                    const nameSpan = spans.length >= 2 ? spans[1] : spans[0];
                    return nameSpan?.textContent?.trim() || '';
                })
                .filter(Boolean)
                .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        };

        const updateCount = () => {
            const connected = getUsers().length;
            // Prefer CyTube's own count (accurate, socket-driven)
            const cytubCount = document.getElementById('usercount');
            const raw = cytubCount?.textContent?.match(/\d+/)?.[0];
            const total = raw ? parseInt(raw) : connected;
            btn.innerHTML =
                `<span class="sc-usercount-part" title="Connected">🗨 ${connected}</span>` +
                `<span class="sc-usercount-part" title="Total users">👁 ${total}</span>`;
        };

        const renderPanel = () => {
            const users = getUsers();
            panel.innerHTML = `
                <div class="sc-users-panel-header">${users.length} connected</div>
                ${users.map(u => {
                    const color = resolveUserColor(u);
                    const emoji = getExternalUserEmoji(u);
                    const emojiHtml = emoji ? `<span class="sc-users-panel-emoji">${emoji}</span>` : '';
                    return `<div class="sc-users-panel-name" style="color:${color}">${emojiHtml}${u}</div>`;
                }).join('')}
            `;
        };

        const closePanel = () => {
            panel.style.display = 'none';
            btn.classList.remove('sc-users-active');
            open = false;
        };

        btn.addEventListener('click', e => {
            e.stopPropagation();
            open = !open;
            if (open) {
                renderPanel();
                panel.style.display = 'block';
                btn.classList.add('sc-users-active');
            } else {
                closePanel();
            }
        });

        document.addEventListener('click', e => {
            if (open && !panel.contains(e.target) && e.target !== btn) closePanel();
        });

        // Update count and panel when userlist changes
        const ul = document.getElementById('userlist');
        if (ul) {
            new MutationObserver(() => {
                updateCount();
                if (open) renderPanel();
            }).observe(ul, { childList: true, subtree: true });
        }

        // Also watch CyTube's usercount element for socket-driven updates
        const uc = document.getElementById('usercount');
        if (uc) {
            new MutationObserver(updateCount)
                .observe(uc, { childList: true, subtree: true, characterData: true });
        }

        updateCount();
    }

    // Chat/UI text face -- Inter, tuned for legibility at small sizes (tall x-height,
    // open counters). Loaded once up front since chat is visible from page load,
    // unlike the tonights-lineup module's own on-demand section-theme fonts
    // (lineupEnsureThemeFontsLoaded). Core, not lineup-specific -- waitForBody below
    // calls this unconditionally, so it must exist in every build regardless of which
    // optional modules are selected.
    const CHAT_FONT_LINK_ID = 'sc-chat-font';
    function ensureChatFontLoaded() {
        if (document.getElementById(CHAT_FONT_LINK_ID)) return;
        const link = document.createElement('link');
        link.id = CHAT_FONT_LINK_ID;
        link.rel = 'stylesheet';
        link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap';
        document.head.appendChild(link);
    }
