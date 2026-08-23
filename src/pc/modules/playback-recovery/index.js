    /* ==========================================================
       PLAYBACK RECOVERY — auto-recover from MEDIA_ERR_NETWORK.
       On some hosts, a Range request that lands on a reused/stale
       keep-alive connection races the server tearing that connection
       down, and Firefox surfaces it to video.js as a fatal network
       error (video keeps playing fine right up until it happens --
       most commonly right after a page reload re-requests the movie).
       A full page reload always "fixes" it because it forces a brand
       new connection; this reproduces just that part -- reload the
       video element's source only -- instead of the whole page.
       Scoped to error.code === 2 (MEDIA_ERR_NETWORK) specifically:
       other MediaError codes (unsupported format, aborted, decode
       error) are a different problem class and retrying won't help.
    ========================================================== */
    (function initPlaybackRecovery() {
        const MEDIA_ERR_NETWORK = 2;
        const RETRY_DELAYS_MS = [1000, 2500, 5000];
        // Set on <body> for the whole time we're handling a network error --
        // hides video.js's own error-display overlay (message + its built-in
        // "x" close button) so our indicator is the only thing shown. Left
        // on through the give-up/click-to-retry state too, since our bottom-
        // right chip is what replaces it; only cleared once playback actually
        // recovers.
        const SUPPRESS_NATIVE_CLASS = 'sc-pr-native-hidden';

        let retryCount = 0;
        let retryTimer = null;
        let indicatorEl = null;
        // Tracks the in-flight loadedmetadata listener from the most recent
        // attemptReload() call, so a failed retry (which leaves its {once:true}
        // listener dangling -- it never fired, since 'error' came instead)
        // doesn't stack a duplicate on the next attempt.
        let pendingVideo = null;
        let pendingRecoveredListener = null;

        function ensureIndicator() {
            if (indicatorEl) return indicatorEl;
            const style = document.createElement('style');
            style.textContent = `
                /* Hide video.js's own error overlay (message + its built-in "x"
                   close button) while we're driving recovery -- our indicator
                   replaces it. Scoped to .vjs-error-display specifically so
                   other video.js modal dialogs (e.g. text-track settings) are
                   untouched. */
                body.${SUPPRESS_NATIVE_CLASS} .video-js .vjs-error-display {
                    display: none !important;
                }

                #sc-playback-recovery {
                    --sc-pr-accent: #5b9dff;
                    --sc-pr-accent-glow: rgba(91,157,255,0.35);
                    position: fixed !important;
                    z-index: 20005 !important;
                    display: flex !important; align-items: center !important; gap: 10px !important;
                    padding: 9px 18px 9px 14px !important;
                    background: linear-gradient(rgba(26,26,30,0.9), rgba(18,18,21,0.9)) !important;
                    backdrop-filter: blur(10px) saturate(1.4) !important;
                    -webkit-backdrop-filter: blur(10px) saturate(1.4) !important;
                    color: #f2f2f5 !important;
                    font: 500 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
                    letter-spacing: 0.1px !important;
                    border: 1px solid rgba(255,255,255,0.09) !important;
                    border-radius: 999px !important;
                    box-shadow: 0 8px 24px rgba(0,0,0,0.45), 0 0 0 1px rgba(0,0,0,0.2), 0 0 20px var(--sc-pr-accent-glow) !important;
                    opacity: 0 !important;
                    pointer-events: none !important;
                    cursor: default !important;
                    transition: opacity 0.28s cubic-bezier(.16,1,.3,1), transform 0.28s cubic-bezier(.16,1,.3,1) !important;
                    white-space: nowrap !important;
                }
                #sc-playback-recovery.sc-visible {
                    opacity: 1 !important;
                    pointer-events: auto !important;
                }

                /* INFO state (reconnecting) -- centered over the video, pop-in. */
                body.sc-horizontal #sc-playback-recovery:not(.sc-state-warn) {
                    top: 50vh !important; left: calc((99vw - var(--sc-chat-w)) / 2) !important;
                    right: auto !important; bottom: auto !important;
                }
                body.sc-vertical #sc-playback-recovery:not(.sc-state-warn) {
                    top: calc((97vh - var(--sc-chat-h)) / 2) !important; left: 50vw !important;
                    right: auto !important; bottom: auto !important;
                }
                #sc-playback-recovery:not(.sc-state-warn) {
                    transform: translate(-50%, -50%) scale(0.94) !important;
                }
                #sc-playback-recovery:not(.sc-state-warn).sc-visible {
                    transform: translate(-50%, -50%) scale(1) !important;
                }

                /* WARN state (gave up) -- bottom-right corner of the video, slide-in.
                   Matches #fs-toggle-btn's existing bottom-right-of-video offsets. */
                body.sc-horizontal #sc-playback-recovery.sc-state-warn {
                    top: auto !important; left: auto !important;
                    right: calc(var(--sc-chat-w) + 1vw + 14px) !important; bottom: 14px !important;
                }
                body.sc-vertical #sc-playback-recovery.sc-state-warn {
                    top: auto !important; left: auto !important;
                    right: 14px !important; bottom: calc(var(--sc-chat-h) + 15px) !important;
                }
                #sc-playback-recovery.sc-state-warn {
                    transform: translate(0, 10px) !important;
                }
                #sc-playback-recovery.sc-state-warn.sc-visible {
                    transform: translate(0, 0) !important;
                }

                #sc-playback-recovery.sc-state-warn { --sc-pr-accent: #ff6b57; --sc-pr-accent-glow: rgba(255,107,87,0.35); }
                #sc-playback-recovery.sc-clickable { cursor: pointer !important; }
                #sc-playback-recovery.sc-clickable:hover {
                    background: linear-gradient(rgba(34,34,39,0.92), rgba(22,22,26,0.92)) !important;
                    box-shadow: 0 8px 24px rgba(0,0,0,0.45), 0 0 0 1px rgba(0,0,0,0.2), 0 0 26px var(--sc-pr-accent-glow) !important;
                }

                .sc-pr-spinner {
                    flex: none !important;
                    width: 14px !important; height: 14px !important;
                    border-radius: 50% !important;
                    border: 2px solid rgba(255,255,255,0.18) !important;
                    border-top-color: var(--sc-pr-accent) !important;
                    animation: sc-pr-spin 0.8s linear infinite !important;
                }
                .sc-pr-icon {
                    flex: none !important;
                    width: 14px !important; height: 14px !important;
                    display: flex !important; align-items: center !important; justify-content: center !important;
                    color: var(--sc-pr-accent) !important;
                    font-size: 15px !important; line-height: 1 !important;
                }
                .sc-pr-text { color: #f2f2f5 !important; }
                .sc-pr-dots { flex: none !important; display: flex !important; gap: 4px !important; margin-left: 2px !important; }
                .sc-pr-dots i {
                    display: block !important;
                    width: 5px !important; height: 5px !important;
                    border-radius: 50% !important;
                    background: rgba(255,255,255,0.22) !important;
                    transition: background 0.2s ease !important;
                }
                .sc-pr-dots i.sc-pr-dot-on { background: var(--sc-pr-accent) !important; }

                @keyframes sc-pr-spin { to { transform: rotate(360deg); } }

                @media (prefers-reduced-motion: reduce) {
                    #sc-playback-recovery { transition: opacity 0.15s linear !important; }
                    #sc-playback-recovery:not(.sc-state-warn),
                    #sc-playback-recovery:not(.sc-state-warn).sc-visible {
                        transform: translate(-50%, -50%) scale(1) !important;
                    }
                    #sc-playback-recovery.sc-state-warn,
                    #sc-playback-recovery.sc-state-warn.sc-visible {
                        transform: translate(0, 0) !important;
                    }
                    .sc-pr-spinner { animation: none !important; border-top-color: rgba(255,255,255,0.18) !important; }
                }
            `;
            document.head.appendChild(style);

            const el = document.createElement('div');
            el.id = 'sc-playback-recovery';
            el.setAttribute('role', 'status');
            el.setAttribute('aria-live', 'polite');
            el.innerHTML = `
                <span class="sc-pr-icon-slot"></span>
                <span class="sc-pr-text"></span>
                <span class="sc-pr-dots"><i></i><i></i><i></i></span>
            `;
            document.body.appendChild(el);
            indicatorEl = el;
            return el;
        }

        // state: 'info' (reconnecting -- blue spinner, progress dots) or
        // 'warn' (gave up -- amber/red retry glyph, clickable, dots hidden).
        function showIndicator({ text, state, dotsOn, clickable, onClick }) {
            const el = ensureIndicator();
            el.classList.toggle('sc-state-warn', state === 'warn');
            el.querySelector('.sc-pr-text').textContent = text;

            const iconSlot = el.querySelector('.sc-pr-icon-slot');
            iconSlot.innerHTML = state === 'warn'
                ? '<span class="sc-pr-icon">⟳</span>'
                : '<span class="sc-pr-spinner"></span>';

            const dots = el.querySelectorAll('.sc-pr-dots i');
            dots.forEach((dot, i) => {
                dot.classList.toggle('sc-pr-dot-on', dotsOn != null && i < dotsOn);
            });
            el.querySelector('.sc-pr-dots').style.display = dotsOn != null ? 'flex' : 'none';

            el.classList.add('sc-visible');
            el.classList.toggle('sc-clickable', !!clickable);
            el.onclick = clickable ? onClick : null;
        }

        function hideIndicator() {
            if (indicatorEl) indicatorEl.classList.remove('sc-visible');
        }

        function attemptReload(video) {
            if (pendingVideo && pendingRecoveredListener) {
                pendingVideo.removeEventListener('loadedmetadata', pendingRecoveredListener);
            }
            const savedTime = video.currentTime;
            const wasPaused = video.paused;
            const onRecovered = () => {
                video.removeEventListener('loadedmetadata', onRecovered);
                pendingVideo = null;
                pendingRecoveredListener = null;
                try { video.currentTime = savedTime; } catch (e) {}
                if (!wasPaused) { video.play().catch(() => {}); }
                retryCount = 0;
                hideIndicator();
                document.body.classList.remove(SUPPRESS_NATIVE_CLASS);
            };
            pendingVideo = video;
            pendingRecoveredListener = onRecovered;
            video.addEventListener('loadedmetadata', onRecovered, { once: true });
            video.load();
        }

        function giveUp(video) {
            showIndicator({
                text: 'Playback error — tap to retry',
                state: 'warn',
                dotsOn: null,
                clickable: true,
                onClick: () => { retryCount = 0; scheduleRetry(video); },
            });
        }

        function scheduleRetry(video) {
            if (retryCount >= RETRY_DELAYS_MS.length) { giveUp(video); return; }
            const delay = RETRY_DELAYS_MS[retryCount];
            retryCount++;
            showIndicator({
                text: 'Reconnecting…',
                state: 'info',
                dotsOn: retryCount,
                clickable: false,
            });
            clearTimeout(retryTimer);
            retryTimer = setTimeout(() => attemptReload(video), delay);
        }

        function onNativeError(e) {
            const video = e.target;
            if (!video || video.tagName !== 'VIDEO') return;
            // Scope to the actual CyTube player -- excludes gifmaker's offscreen
            // preview/scrub <video> clones, which live outside #ytapiplayer.
            if (!video.closest || !video.closest('#ytapiplayer')) return;
            const err = video.error;
            if (!err || err.code !== MEDIA_ERR_NETWORK) return;
            document.body.classList.add(SUPPRESS_NATIVE_CLASS);
            scheduleRetry(video);
        }

        // 'error' on a media element doesn't bubble, so this has to be a
        // capture-phase listener on document (attachable from document-start,
        // before #ytapiplayer's <video> even exists yet).
        document.addEventListener('error', onNativeError, true);
    })();
