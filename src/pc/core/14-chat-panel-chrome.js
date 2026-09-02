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
            document.getElementById('sc-trivia-popup-btn'),
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

        // Returns the currently-relevant poll well, or null.
        const currentWell = () => pollwrap.querySelector('.well.active') || pollwrap.querySelector('.well');

        const renderPanel = () => {
            const well = currentWell();
            if (!well) { panel.innerHTML = ''; return; }

            // Extract just the useful parts: heading + options
            const h = well.querySelector('h3')?.textContent?.trim() || '';

            // Time/author label
            const label = well.querySelector('.label')?.textContent?.trim() || '';
            const author = well.querySelector('.label')?.getAttribute('title') || '';

            panel.innerHTML =
                '<div class="sc-poll-header"></div>' +
                '<div class="sc-poll-options"></div>' +
                (label ? '<div class="sc-poll-meta"></div>' : '');
            panel.querySelector('.sc-poll-header').textContent = h;
            if (label) panel.querySelector('.sc-poll-meta').textContent = (author ? author + ' · ' : '') + label;

            // Rebuild each option as a real clickable <button>. The vote
            // count comes straight from CyTube's own option <button> text
            // (a number, or "?" for a hidden/obscured poll). Clicking an
            // option forwards to that real button (see the panel click
            // handler in _initPollWatcher) so CyTube's bound handler emits
            // the `vote` socket event; the resulting `updatePoll` mutates
            // #pollwrap and the MutationObserver below re-renders with the
            // new counts.
            const optionsWrap = panel.querySelector('.sc-poll-options');
            [...well.querySelectorAll('.option')].forEach((o, i) => {
                const voteBtn = o.querySelector('button');
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'sc-poll-option';
                b.dataset.idx = String(i);

                const countTxt = voteBtn ? voteBtn.textContent.trim() : '';
                if (countTxt) {
                    const c = document.createElement('span');
                    c.className = 'sc-poll-count';
                    c.textContent = countTxt;
                    b.appendChild(c);
                }

                // Label = the option's own nodes minus its leading vote
                // button, cloned so CyTube-built <a> links are preserved
                // verbatim (then hardened with target/rel).
                const lbl = document.createElement('span');
                lbl.className = 'sc-poll-label';
                [...o.childNodes].forEach(n => {
                    if (n === voteBtn) return;
                    lbl.appendChild(n.cloneNode(true));
                });
                lbl.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
                b.appendChild(lbl);

                optionsWrap.appendChild(b);
            });
        };

        const hasPollContent = () => {
            // CyTube marks open polls with .well.active
            // Fall back to any .well with content if no active class
            const activeWell = currentWell();
            return !!(activeWell && activeWell.textContent.trim().length > 10);
        };

        // Vote by forwarding the click to CyTube's own option <button> —
        // its bound handler emits the `vote` socket event. Links inside an
        // option label open normally instead of voting.
        panel.addEventListener('click', e => {
            const optBtn = e.target.closest('.sc-poll-option');
            if (!optBtn || !panel.contains(optBtn)) return;
            if (e.target.closest('a')) return;
            const well = currentWell();
            if (!well) return;
            const realBtn = well.querySelectorAll('.option')[Number(optBtn.dataset.idx)]?.querySelector('button');
            if (realBtn) realBtn.click();
        });

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
        const btn = document.createElement('div');
        btn.id = 'sc-usercount-btn';
        header.appendChild(btn);

        const connectedBtn = document.createElement('button');
        connectedBtn.id = 'sc-usercount-connected';
        connectedBtn.className = 'sc-usercount-part';
        connectedBtn.title = 'Connected';
        btn.appendChild(connectedBtn);

        const onlineBtn = document.createElement('button');
        onlineBtn.id = 'sc-usercount-online';
        onlineBtn.className = 'sc-usercount-part';
        onlineBtn.title = 'Online';
        btn.appendChild(onlineBtn);

        // Create users panel
        const panel = document.createElement('div');
        panel.id = 'sc-users-panel';
        document.body.appendChild(panel);

        let activeMode = null; // 'connected' | 'online' | null
        let lastTotal = 0;

        // CyTube structure: <span>(rank icon)</span>[<span>(afk icon)</span>]<span>Name</span>
        // Idle/AFK users (.userlist_afk) get an extra icon span before the name,
        // so the username is always the LAST span, not a fixed index.
        const readItemUsername = (item) => {
            const spans = item.querySelectorAll('span');
            return spans[spans.length - 1]?.textContent?.trim() || '';
        };

        const getUserItems = () => [...document.querySelectorAll('#userlist .userlist_item')];

        const sortByName = (a, b) => a.toLowerCase().localeCompare(b.toLowerCase());

        // "Connected" (🗨) = actively chatting -- excludes idle/AFK users.
        const getConnectedUsers = () => getUserItems()
            .filter(item => !item.classList.contains('userlist_afk'))
            .map(readItemUsername)
            .filter(Boolean)
            .sort(sortByName);

        // "Online" (👁) = everyone in the userlist, idle or not. Active users
        // are grouped first, idle users after, each sorted alphabetically.
        const getOnlineUsers = () => {
            const all = getUserItems()
                .map(item => ({ name: readItemUsername(item), afk: item.classList.contains('userlist_afk') }))
                .filter(u => u.name);
            const active = all.filter(u => !u.afk).sort((a, b) => sortByName(a.name, b.name));
            const idle = all.filter(u => u.afk).sort((a, b) => sortByName(a.name, b.name));
            return [...active, ...idle];
        };

        const updateCount = () => {
            const connected = getConnectedUsers().length;
            // Prefer CyTube's own count (accurate, socket-driven)
            const cytubCount = document.getElementById('usercount');
            const raw = cytubCount?.textContent?.match(/\d+/)?.[0];
            const total = raw ? parseInt(raw) : connected;
            lastTotal = total;
            connectedBtn.textContent = `🗨 ${connected}`;
            onlineBtn.textContent = `👁 ${total}`;
        };

        // data-name only lives in jQuery's internal .data() cache, not as a real
        // HTML attribute, so a rendered username has to be matched back to its
        // native item by re-reading the same visible span readItemUsername reads.
        const findUserItem = (name) => {
            const items = [...document.querySelectorAll('#userlist .userlist_item')];
            return items.find(item => readItemUsername(item) === name) || null;
        };

        // CyTube never adds these buttons for the local user's own item, so their
        // absence (both null) is the source of truth for "is this me" — no separate
        // CLIENT.name check needed.
        const getUserActionButtons = (item) => {
            const dropdown = item.querySelector('.user-dropdown');
            if (!dropdown) return { ignoreBtn: null, pmBtn: null };
            const buttons = [...dropdown.querySelectorAll('button')];
            const ignoreBtn = buttons.find(b => /^(Ignore|Unignore) User$/.test(b.textContent.trim())) || null;
            const pmBtn = buttons.find(b => b.textContent.trim() === 'Private Message') || null;
            return { ignoreBtn, pmBtn };
        };

        let expandedRow = null;

        const collapseActions = () => {
            if (!expandedRow) return;
            const actions = expandedRow.nextElementSibling;
            if (actions && actions.classList.contains('sc-users-panel-actions')) actions.remove();
            expandedRow = null;
        };

        const renderPanel = () => {
            const users = activeMode === 'online'
                ? getOnlineUsers()
                : getConnectedUsers().map(name => ({ name, afk: false }));
            expandedRow = null;
            const headerText = activeMode === 'online' ? `${users.length} of ${lastTotal} online` : `${users.length} connected`;
            panel.innerHTML = `
                <div class="sc-users-panel-header">${headerText}</div>
                ${users.map(u => {
                    const color = resolveUserColor(u.name);
                    const emoji = getExternalUserEmoji(u.name);
                    const emojiHtml = emoji ? `<span class="sc-users-panel-emoji">${emoji}</span>` : '';
                    const item = findUserItem(u.name);
                    const { ignoreBtn, pmBtn } = item ? getUserActionButtons(item) : { ignoreBtn: null, pmBtn: null };
                    const actionableClass = (ignoreBtn || pmBtn) ? ' sc-users-panel-actionable' : '';
                    const afkClass = u.afk ? ' sc-users-panel-afk' : '';
                    return `<div class="sc-users-panel-name${actionableClass}${afkClass}" style="color:${color}">${emojiHtml}${u.name}</div>`;
                }).join('')}
            `;

            [...panel.querySelectorAll('.sc-users-panel-name')].forEach((row, i) => {
                const username = users[i].name;
                row.addEventListener('click', () => {
                    const item = findUserItem(username);
                    if (!item) return;
                    const { ignoreBtn, pmBtn } = getUserActionButtons(item);
                    if (!ignoreBtn && !pmBtn) return;

                    const wasExpanded = expandedRow === row;
                    collapseActions();
                    if (wasExpanded) return;

                    const actions = document.createElement('div');
                    actions.className = 'sc-users-panel-actions';

                    if (ignoreBtn) {
                        const ignoreToggle = document.createElement('button');
                        ignoreToggle.textContent = ignoreBtn.textContent.trim();
                        ignoreToggle.addEventListener('click', () => {
                            ignoreBtn.click();
                            ignoreToggle.textContent = ignoreBtn.textContent.trim();
                        });
                        actions.appendChild(ignoreToggle);
                    }

                    if (pmBtn) {
                        const pmToggle = document.createElement('button');
                        pmToggle.textContent = 'Private Message';
                        pmToggle.addEventListener('click', () => {
                            pmBtn.click();
                            closePanel();
                        });
                        actions.appendChild(pmToggle);
                    }

                    row.after(actions);
                    expandedRow = row;
                });
            });
        };

        const closePanel = () => {
            panel.style.display = 'none';
            connectedBtn.classList.remove('sc-users-active');
            onlineBtn.classList.remove('sc-users-active');
            activeMode = null;
        };

        const openPanel = (mode, modeBtn) => {
            activeMode = mode;
            renderPanel();
            panel.style.display = 'block';
            connectedBtn.classList.toggle('sc-users-active', modeBtn === connectedBtn);
            onlineBtn.classList.toggle('sc-users-active', modeBtn === onlineBtn);
        };

        const handleModeClick = (mode, modeBtn) => e => {
            e.stopPropagation();
            if (activeMode === mode) {
                closePanel();
            } else {
                openPanel(mode, modeBtn);
            }
        };

        connectedBtn.addEventListener('click', handleModeClick('connected', connectedBtn));
        onlineBtn.addEventListener('click', handleModeClick('online', onlineBtn));

        document.addEventListener('click', e => {
            if (activeMode && !panel.contains(e.target) && !connectedBtn.contains(e.target) && !onlineBtn.contains(e.target)) {
                closePanel();
            }
        });

        // Update count and panel when userlist changes
        const ul = document.getElementById('userlist');
        if (ul) {
            new MutationObserver(muts => {
                updateCount();
                if (!activeMode) return;
                // Clicking Ignore in our panel calls the native button's own click
                // handler, which mutates that button's text node inside its
                // .user-dropdown -- a childList change under #userlist that isn't a
                // join/leave. Re-rendering on it would wipe the actions row (and its
                // just-flipped label) we're mid-update on, so only real userlist
                // changes outside any .user-dropdown should trigger a re-render.
                const relevant = muts.some(m => !m.target.closest || !m.target.closest('.user-dropdown'));
                if (relevant) renderPanel();
            }).observe(ul, { childList: true, subtree: true });
        }

        // Also watch CyTube's usercount element for socket-driven updates
        const uc = document.getElementById('usercount');
        if (uc) {
            new MutationObserver(() => {
                updateCount();
                if (activeMode === 'online') renderPanel();
            }).observe(uc, { childList: true, subtree: true, characterData: true });
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
