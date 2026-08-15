    /* ==========================================================
       DESYNC — temporarily pause CyTube's sync (shared state)
       Used by the floating "free watch" button AND the chat
       right-click "jump movie to this message" menu.
    ========================================================== */

    const _desync = { active: false, saved: null, btn: null, anchorPos: null, anchorWall: null, markerTimer: null };

    function _getMediaUpdateListeners() {
        // Socket.IO v2/v3 stores listeners under _callbacks['$eventName']
        // Socket.IO v4 stores them under _events or via listeners()
        const key = '$mediaUpdate';
        if (socket._callbacks?.[key]) return { store: '_callbacks', key };
        if (socket._events?.mediaUpdate) return { store: '_events', key: 'mediaUpdate' };
        return null;
    }

    function _freezeSync() {
        const loc = _getMediaUpdateListeners();
        if (!loc) {
            console.warn('[CyTube SC] Could not find mediaUpdate listeners to freeze');
            return;
        }
        if (loc.store === '_callbacks') {
            _desync.saved = socket._callbacks[loc.key].slice();
            socket._callbacks[loc.key] = [];
        } else {
            _desync.saved = socket._events[loc.key];
            delete socket._events[loc.key];
        }
        console.log('[CyTube SC] Sync frozen — removed', _desync.saved?.length ?? 1, 'mediaUpdate listener(s)');
    }

    function _thawSync() {
        if (!_desync.saved) return;
        const loc = _getMediaUpdateListeners();
        if (loc?.store === '_callbacks') {
            socket._callbacks[loc.key] = _desync.saved;
        } else {
            socket._events = socket._events || {};
            socket._events['mediaUpdate'] = _desync.saved;
        }
        _desync.saved = null;
        console.log('[CyTube SC] Sync restored');
        // Trigger immediate resync
        if (typeof socket !== 'undefined' && socket) {
            socket.emit('playerReady');
        }
    }

    // Single entry point for changing desync state — keeps the button UI in sync
    // whether the toggle came from the button or the chat seek menu.
    function setDesynced(on) {
        if (typeof socket === 'undefined' || !socket) return;
        if (on === _desync.active) return;
        _desync.active = on;
        if (on) {
            // Anchor captured BEFORE freezing so it reflects the still-live position.
            _desync.anchorPos = getPlayerTimeSec();
            _desync.anchorWall = Date.now();
            _freezeSync();
        } else {
            _thawSync();
            _desync.anchorPos = null;
            _desync.anchorWall = null;
        }
        const btn = _desync.btn;
        if (btn) {
            btn.classList.toggle('sc-desync-active', on);
            btn.title = on ? 'Free watch ON — click to re-sync'
                           : 'Free watch — click to watch freely, click again to re-sync';
        }
        // Force the floating button row visible: immediately on entering desync (so
        // the active desync button is never hidden by idle-fade), and once more on
        // exit (gapHide's own guard stops re-hiding it early while still desynced).
        if (_gapShow) _gapShow();
        // Keep video.js's own control bar (the scrubber) from idle-fading while
        // desynced — see the body.sc-desynced override in the stylesheet.
        document.body.classList.toggle('sc-desynced', on);
        clearInterval(_desync.markerTimer);
        _desync.markerTimer = on ? setInterval(updateSyncMarker, 500) : null;
        updateSyncMarker();
    }

    function initDesyncButton() {
        const btn = document.createElement('button');
        btn.id = 'sc-desync-btn';
        btn.textContent = '⟳';
        btn.title = 'Free watch — click to watch freely, click again to re-sync';
        document.body.appendChild(btn);
        _desync.btn = btn;
        btn.addEventListener('click', () => setDesynced(!_desync.active));
    }
