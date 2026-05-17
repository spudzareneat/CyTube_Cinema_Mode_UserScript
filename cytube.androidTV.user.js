// ==UserScript==
// @name         CyTube Fullscreen Video with Overlay Chat
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Make video fullscreen and overlay chat messages over it, hide user list
// @match        https://cytu.be/r/420Grindhouse
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    /* ---------- INPUTMODE SUPPRESSION ---------- */

    const applyInputMode = () => {
        const chatinput = document.getElementById("chatline");
        if (chatinput && chatinput.getAttribute("inputmode") !== "none") {
            chatinput.setAttribute("inputmode", "none");
        }

        const emoteInputs = document.getElementsByClassName("emotelist-search");
        for (const input of emoteInputs) {
            if (input.getAttribute("inputmode") !== "none") {
                input.setAttribute("inputmode", "none");
            }
        }
    };

    /* ---------- FULLSCREEN ---------- */

    function toggleFullscreen() {
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => { });
        } else {
            document.documentElement.requestFullscreen().catch(() => { });
        }
    }

    const updateFullscreenButtonVisibility = () => {
        const fsBtn = document.getElementById("fs-toggle-btn");
        if (!fsBtn) return;

        fsBtn.style.display = document.fullscreenElement ? "none" : "";
    };

    document.addEventListener("fullscreenchange", updateFullscreenButtonVisibility);

    const addFullscreenButton = () => {
        const emoteBtn = document.getElementById("emotelistbtn");
        if (!emoteBtn) return;

        if (document.getElementById("fs-toggle-btn")) return;

        const fsBtn = document.createElement("button");
        fsBtn.id = "fs-toggle-btn";
        fsBtn.textContent = "⛶";
        fsBtn.title = "Toggle Fullscreen";

        fsBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleFullscreen();
        });

        emoteBtn.parentElement.appendChild(fsBtn);
        updateFullscreenButtonVisibility();
    };

    /* ---------- Pause when not in focus ---------- */
    const pauseAllVideos = () => {
        document.querySelectorAll('video').forEach(v => {
            try {
                if (!v.paused) {
                    v.pause();
                    v.src = '';
                }
            } catch { }
        });
    };

    const addReloadButton = () => {
        const emoteBtn = document.getElementById("emotelistbtn");
        if (!emoteBtn) return;

        if (document.getElementById("reload-video-btn")) return;

        const btn = document.createElement("button");
        btn.id = "reload-video-btn";
        btn.textContent = "↻";
        btn.title = "Reload Video";

        btn.addEventListener("click", e => {
            e.stopPropagation();
            location.reload();
        });

        emoteBtn.parentElement.appendChild(btn);
    };

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            pauseAllVideos();
            addReloadButton();
        }
    });

    /* Reaction Cleanup */
    const applyEmotePickerIcon = () => {
        const btn = document.getElementById("emotelistbtn");
        if (!btn) return;

        // Prevent reapplying if CyTube rebuilds DOM
        if (btn.dataset.pickerApplied) return;

        btn.textContent = "▦";
        btn.title = "Emotes";
        btn.setAttribute("aria-label", "Emote Picker");

        btn.dataset.pickerApplied = "true";
    };
    // ---- USER COLOR SYSTEM ----

    // Simple deterministic hash
    function hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
            hash |= 0; // Convert to 32bit int
        }
        return Math.abs(hash);
    }

    // Convert username to bright HSL color
    function usernameToColor(username) {
        const hash = hashString(username);

        const hue = hash % 360;                  // 0–359
        const saturation = 75 + (hash % 15);     // 75–90%
        const lightness = 60 + (hash % 10);      // 60–70%

        return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
    }

    // Keep track of which users we’ve styled
    const styledUsers = new Set();

    function applyUserColors() {
        const userElements = document.querySelectorAll('#messagebuffer [class*="chat-msg-"]');

        userElements.forEach(el => {
            const userClass = [...el.classList].find(c => c.startsWith('chat-msg-'));
            if (!userClass) return;

            const username = userClass.replace('chat-msg-', '');
            const color = usernameToColor(username);

            const nameSpan = el.querySelector('.username');
            if (nameSpan) {
                nameSpan.style.color = color;
                nameSpan.style.fontWeight = "700";
            }
        });
    }

    function startUserColorObserver() {
        const buffer = document.getElementById('messagebuffer');
        if (!buffer) return false;

        const chatObserver = new MutationObserver(() => {
            applyUserColors();
        });

        chatObserver.observe(buffer, {
            childList: true,
            subtree: true
        });

        applyUserColors();
        return true;
    }

    /* ---------- DOM READY / OBSERVERS ---------- */

    const waitForBody = () => {
        if (!document.body) {
            requestAnimationFrame(waitForBody);
            return;
        }

        applyInputMode();
        addFullscreenButton();
        applyEmotePickerIcon();
        startUserColorObserver();
        const observer = new MutationObserver(() => {
            applyInputMode();
            addFullscreenButton();
            applyEmotePickerIcon();

            if (!document.getElementById('tv-color-init')) {
                if (startUserColorObserver()) {
                    const flag = document.createElement('div');
                    flag.id = 'tv-color-init';
                    flag.style.display = 'none';
                    document.body.appendChild(flag);
                }
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    };



    waitForBody();

    /* ---------- CSS / LAYOUT ---------- */

    window.addEventListener('load', () => {
        const style = document.createElement('style');
        style.textContent = `
            #videowrap {
                position: fixed !important;
                top: 0 !important;
                left: 0 !important;
                width: 80vw !important;
                height: 100vh !important;
                z-index: 9999 !important;
                background: black !important;
            }

            #videowrap .embed-responsive,
            #ytapiplayer {
                width: 80vw !important;
                height: 100vh !important;
            }

            nav.navbar,
            #motdrow,
            #drinkbarwrap,
            #announcements,
            #playlistrow,
            #resizewrap,
            footer,
            #userlist,
            #userlisttoggle,
            #rightcontrols,
            .modal-header,
            .timestamp,
            .modal-footer {
                display: none !important;
            }

            #chatwrap {
                position: fixed !important;
                top: 0 !important;
                right: 0 !important;
                width: 20vw !important;
                height: 100vh !important;
                z-index: 9999 !important;
                background: rgba(0,0,0,0.7) !important;
                overflow: hidden !important;
                padding-right: 5px !important;
            }

            #messagebuffer {
                height: calc(100% - 60px) !important;
                background: transparent !important;
                color: white !important;
                font-size: 14px !important;
                overflow-y: auto !important;
            }

            #chatline {
                background: rgba(255,255,255,0.1) !important;
                color: white !important;
                border: 1px solid rgba(255,255,255,0.3) !important;
                width: 100% !important;
            }

            #chatline::placeholder {
                color: rgba(255,255,255,0.7) !important;
            }

            .modal,
            .popover,
            .dropdown-menu {
                z-index: 20001 !important;
            }

            #emotelistbtn {
                position: fixed !important;
                bottom: 5px !important;
                right: 20vw !important;
                z-index: 20002 !important;
                background: rgba(0,0,0,0.7) !important;
                color: white !important;
                border: 1px solid rgba(255,255,255,0.3) !important;
            }

            #fs-toggle-btn {
                position: fixed !important;
                bottom: 5px !important;
                right: calc(20vw + 50px) !important;
                z-index: 20002 !important;
                background: rgba(0,0,0,0.7) !important;
                color: white !important;
                border: 1px solid rgba(255,255,255,0.3) !important;
                border-radius: 4px !important;
                padding: 3px 10px !important;
                font-size: 16px !important;
                cursor: pointer !important;
            }

            #fs-toggle-btn:focus {
                outline: 2px solid white !important;
            }

            .video-js .vjs-control-bar {
                bottom: 20px !important;
                width: 80% !important;
            }

            #videowrap-header {
                border: 0 !important;
                opacity: 0.5 !important;
            }

            #resize-video-smaller,
            #resize-video-larger {
                display: none !important;
            }

            .modal-dialog {
                margin: 0 auto !important;
            }

            body {
                background-image: none !important;
                background: #000 !important; /* or transparent */
            }
            #reload-video-btn {
                position: fixed !important;
                bottom: 5px !important;
                right: calc(20vw + 150px) !important;

                z-index: 20002 !important;
                background: rgba(0,0,0,0.7) !important;
                color: white !important;
                border: 1px solid rgba(255,255,255,0.3) !important;
                border-radius: 4px !important;
                padding: 3px 10px !important;
                font-size: 16px !important;
                cursor: pointer !important;
            }
        `;
        document.head.appendChild(style);
    });

})();
