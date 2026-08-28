    /* ==========================================================
       POP-UP TRIVIA BUBBLES — "VH1 Pop-up Video" style ambient
       trivia. Reuses the same fetchImdbTrivia()/_triviaCache and
       _escHtml() the imdb-trivia module already owns (hard dependency
       via manifest.json's dependsOn, so this file always loads after
       it) rather than re-fetching or re-declaring either. Also reuses
       _currentImdbId (core/01-movie-identity.js) and isYouTubeMedia()/
       getPlayerVideoEl() (core/12-playback-sync-and-seek.js).

       No pub/sub exists in this codebase for "movie changed" -- every
       module that cares just polls the shared _currentImdbId and
       diffs against its own last-seen value (same idiom imdb-trivia
       and last-aired already use). This module does the same on a
       lightweight heartbeat, which also doubles as the scheduler that
       decides when the next bubble is due.

       Settings here are poll-per-use, not event-driven (see
       core/15-settings-modal-shell.js -- Save just writes
       localStorage, nothing notifies running code), so
       popupTriviaEnabled() and the playback-eligibility check both get
       re-read every time a pop is attempted, not just once at boot --
       otherwise turning the toggle off mid-movie wouldn't stop
       already-scheduled popups.
    ========================================================== */

    const LS_TRIVIA_POPUP_ENABLED = 'sc_trivia_popup_enabled';
    const popupTriviaEnabled = () => getKey(LS_TRIVIA_POPUP_ENABLED) === 'on'; // opt-in, off by default

    const LS_TRIVIA_POPUP_FREQUENCY = 'sc_trivia_popup_frequency';
    const TP_FREQUENCY_DEFAULT = 'occasional';
    // Gap-between-pops ranges per tier -- read live (poll-per-use, like
    // popupTriviaEnabled()) each time a pop is scheduled, so changing the
    // setting mid-movie takes effect on the very next pop instead of
    // requiring a reload.
    const TP_FREQUENCY_TIERS = {
        frequent:   { min: 45 * 1000,     max: 90 * 1000 },
        occasional: { min: 3 * 60 * 1000, max: 6 * 60 * 1000 },
        rare:       { min: 8 * 60 * 1000, max: 15 * 60 * 1000 },
    };
    const _tpFrequencyTier = () => TP_FREQUENCY_TIERS[getKey(LS_TRIVIA_POPUP_FREQUENCY)] || TP_FREQUENCY_TIERS[TP_FREQUENCY_DEFAULT];

    const TP_POLL_MS     = 3000;            // heartbeat: detect movie change + drive the scheduler
    const TP_RETRY_MS    = 20 * 1000;       // recheck delay when blocked (paused/YouTube/setting off)
    const TP_VISIBLE_MS  = 20 * 1000;       // how long a bubble stays up before auto-dismissing
    const TP_EXIT_ANIM_MS = 300;             // must match style.css's .sc-tp-out transition-duration
    const TP_MAX_FACT_LEN = 280;             // skip trivia entries longer than this -- too much text to pop up legibly

    // undefined (not null) so "no movie identified yet" (_currentImdbId === null)
    // still counts as a change exactly once, on the very first tick.
    let _tpLastImdbId = undefined;
    let _tpQueue = [];       // shuffled remaining trivia strings for the current movie
    let _tpExhausted = false; // true once _tpQueue has been fully consumed for this movie -- no reshuffle/repeat
    let _tpPopTimer = null;
    let _tpBubbleEl = null;
    let _tpDismissTimer = null;

    function _tpShuffle(arr) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    /* ==========================================================
       SCHEDULER
    ========================================================== */

    function _tpResetForNewMovie(id) {
        clearTimeout(_tpPopTimer); _tpPopTimer = null;
        _tpDismissBubble(true); // hard-remove instantly -- stale trivia, no exit animation
        _tpQueue = [];
        _tpExhausted = false;
        if (!id) return; // not identified yet; next poll tick will retry

        fetchImdbTrivia(id).then(items => {
            if (id !== _tpLastImdbId) return; // movie changed again while this was in flight
            if (!items || !items.length) { _tpExhausted = true; return; }
            _tpQueue = _tpShuffle(items);
            _tpScheduleNextPop();
        });
    }

    function _tpScheduleNextPop() {
        clearTimeout(_tpPopTimer);
        if (_tpExhausted || !_tpQueue.length) { _tpExhausted = true; return; }
        const tier = _tpFrequencyTier();
        const gap = tier.min + Math.random() * (tier.max - tier.min);
        _tpPopTimer = setTimeout(_tpAttemptPop, gap);
    }

    function _tpMovieIsPlaying() {
        if (isYouTubeMedia()) return false;
        const v = getPlayerVideoEl();
        return !!v && !v.paused;
    }

    function _tpAttemptPop() {
        if (_currentImdbId !== _tpLastImdbId) return; // stale timer from a since-reset movie

        if (!popupTriviaEnabled() || !_tpMovieIsPlaying()) {
            // Blocked, not exhausted -- recheck soon without consuming a queue item.
            _tpPopTimer = setTimeout(_tpAttemptPop, TP_RETRY_MS);
            return;
        }

        // Skip (don't display, don't wait out a gap for) any entry too long to
        // read comfortably in a small popup -- keep pulling from the queue
        // until a short-enough one turns up or the queue runs dry.
        let fact = null;
        while (_tpQueue.length) {
            const candidate = _tpQueue.shift();
            if (candidate.length <= TP_MAX_FACT_LEN) { fact = candidate; break; }
        }
        if (!fact) { _tpExhausted = true; return; } // ran out (including all-too-long) -- no more for this movie

        showTriviaBubble(fact);
        _tpScheduleNextPop(); // arms the next pop, or flips _tpExhausted if that was the last one
    }

    function _tpMoviePollTick() {
        if (_currentImdbId !== _tpLastImdbId) {
            _tpLastImdbId = _currentImdbId;
            _tpResetForNewMovie(_tpLastImdbId);
        }
    }

    function triviaPopupBoot() {
        _tpMoviePollTick();
        setInterval(_tpMoviePollTick, TP_POLL_MS);
    }

    /* ==========================================================
       BUBBLE UI
    ========================================================== */

    // Corner-badge glyphs -- grindhouse-flavored, drawn from scratch (no
    // copied assets), black/red/bone palette. Each entry is just the glyph
    // markup; showTriviaBubble() wraps whichever one gets picked in the
    // shared black-circle-plus-red-ring backdrop below, so adding another
    // variant later is a one-line addition to this array.
    const TP_ICONS = [
        // Skull + blood drip
        `<path d="M30 10 C19 10 12 18 12 27 C12 33 15 38 19 41 L19 47 L24 47 L24 43 L27 43 L27 47 L33 47 L33 43 L36 43 L36 47 L41 47 L41 41 C45 38 48 33 48 27 C48 18 41 10 30 10 Z"
              fill="#f4f1ea" stroke="#000" stroke-width="2.5" stroke-linejoin="round"/>
         <circle cx="22" cy="26" r="5" fill="#000"/>
         <circle cx="38" cy="26" r="5" fill="#000"/>
         <polygon points="30,30 27,36 33,36" fill="#000"/>
         <path d="M39 16 C39 16 43 22 41 27 C40 30 36 30 35 27 C33 23 39 16 39 16 Z"
              fill="#c81d25" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/>`,
        // Cracked tombstone
        `<path d="M14 54 V30 C14 16 22 8 30 8 C38 8 46 16 46 30 V54 Z"
              fill="#f4f1ea" stroke="#000" stroke-width="2.5" stroke-linejoin="round"/>
         <path d="M30 12 L26 26 L34 30 L28 44 L33 54" stroke="#000" stroke-width="2" fill="none"/>
         <line x1="30" y1="18" x2="30" y2="26" stroke="#000" stroke-width="2"/>
         <line x1="26" y1="21" x2="34" y2="21" stroke="#000" stroke-width="2"/>`,
        // Film reel
        `<circle cx="30" cy="30" r="18" fill="#f4f1ea" stroke="#000" stroke-width="2.5"/>
         <circle cx="30" cy="30" r="4" fill="#000"/>
         <circle cx="30" cy="16" r="4.5" fill="#000"/>
         <circle cx="30" cy="44" r="4.5" fill="#000"/>
         <circle cx="18" cy="23" r="4.5" fill="#000"/>
         <circle cx="18" cy="37" r="4.5" fill="#000"/>
         <circle cx="42" cy="23" r="4.5" fill="#000"/>
         <circle cx="42" cy="37" r="4.5" fill="#000"/>`,

        // --- Sci-fi (toxic-green #39d98a accent) ---

        // Flying saucer
        `<ellipse cx="30" cy="33" rx="22" ry="8" fill="#d8d8d8" stroke="#000" stroke-width="2.5"/>
         <ellipse cx="30" cy="24" rx="11" ry="9" fill="#f4f1ea" stroke="#000" stroke-width="2.5"/>
         <circle cx="18" cy="36" r="2.2" fill="#39d98a" stroke="#000" stroke-width="1.2"/>
         <circle cx="30" cy="38" r="2.2" fill="#39d98a" stroke="#000" stroke-width="1.2"/>
         <circle cx="42" cy="36" r="2.2" fill="#39d98a" stroke="#000" stroke-width="1.2"/>`,
        // Bug-eyed alien head
        `<path d="M30 6 C14 6 6 20 8 32 C10 44 20 54 30 54 C40 54 50 44 52 32 C54 20 46 6 30 6 Z"
              fill="#f4f1ea" stroke="#000" stroke-width="2.5" stroke-linejoin="round"/>
         <ellipse cx="20" cy="27" rx="7" ry="10" fill="#000" transform="rotate(-15 20 27)"/>
         <ellipse cx="40" cy="27" rx="7" ry="10" fill="#000" transform="rotate(15 40 27)"/>
         <circle cx="20" cy="27" r="1.8" fill="#39d98a"/>
         <circle cx="40" cy="27" r="1.8" fill="#39d98a"/>`,
        // Rocket ship
        `<path d="M30 6 C24 6 20 14 20 24 V44 H40 V24 C40 14 36 6 30 6 Z"
              fill="#f4f1ea" stroke="#000" stroke-width="2.5" stroke-linejoin="round"/>
         <circle cx="30" cy="20" r="5" fill="#39d98a" stroke="#000" stroke-width="2"/>
         <polygon points="20,38 10,50 20,50" fill="#d8d8d8" stroke="#000" stroke-width="2" stroke-linejoin="round"/>
         <polygon points="40,38 50,50 40,50" fill="#d8d8d8" stroke="#000" stroke-width="2" stroke-linejoin="round"/>
         <path d="M24 44 C24 44 22 54 30 58 C38 54 36 44 36 44 Z"
              fill="#39d98a" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/>`,
        // Robot head
        `<rect x="14" y="16" width="32" height="28" rx="4" fill="#d8d8d8" stroke="#000" stroke-width="2.5"/>
         <line x1="30" y1="16" x2="30" y2="6" stroke="#000" stroke-width="2.5"/>
         <circle cx="30" cy="5" r="3" fill="#39d98a" stroke="#000" stroke-width="1.5"/>
         <circle cx="30" cy="28" r="7" fill="#000"/>
         <circle cx="30" cy="28" r="3" fill="#39d98a"/>
         <rect x="20" y="38" width="20" height="4" fill="#000"/>
         <circle cx="16" cy="20" r="2" fill="#3a2a1a"/>
         <circle cx="44" cy="20" r="2" fill="#3a2a1a"/>`,
        // Radioactive trefoil
        `<circle cx="30" cy="30" r="20" fill="#f4f1ea" stroke="#000" stroke-width="2.5"/>
         <path d="M30 30 L23 15 L37 15 Z" fill="#39d98a" stroke="#000" stroke-width="1.5" stroke-linejoin="round" transform="rotate(0 30 30)"/>
         <path d="M30 30 L23 15 L37 15 Z" fill="#39d98a" stroke="#000" stroke-width="1.5" stroke-linejoin="round" transform="rotate(120 30 30)"/>
         <path d="M30 30 L23 15 L37 15 Z" fill="#39d98a" stroke="#000" stroke-width="1.5" stroke-linejoin="round" transform="rotate(240 30 30)"/>
         <circle cx="30" cy="30" r="5" fill="#000"/>`,

        // --- Action (marquee-gold #e8b923 accent) ---

        // Explosion burst
        `<polygon points="30,4 35,19 48,12 41,25 56,30 41,35 48,48 35,41 30,56 25,41 12,48 19,35 4,30 19,25 12,12 25,19"
                 fill="#e8b923" stroke="#000" stroke-width="2.5" stroke-linejoin="round"/>
         <polygon points="30,16 33,24 40,20 36,27 44,30 36,33 40,40 33,36 30,44 27,36 20,40 25,33 16,30 25,27 20,20 27,25"
                 fill="#c81d25" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/>`,
        // Crosshair scope
        `<circle cx="30" cy="30" r="21" fill="#f4f1ea" stroke="#c81d25" stroke-width="4"/>
         <rect x="6" y="28" width="15" height="4" fill="#000"/>
         <rect x="39" y="28" width="15" height="4" fill="#000"/>
         <rect x="28" y="6" width="4" height="15" fill="#000"/>
         <rect x="28" y="39" width="4" height="15" fill="#000"/>
         <circle cx="30" cy="30" r="4" fill="#e8b923" stroke="#000" stroke-width="1.5"/>`,
        // Brass knuckles
        `<circle cx="14" cy="20" r="8" fill="#d8d8d8" stroke="#000" stroke-width="2.5"/>
         <circle cx="26" cy="18" r="8" fill="#d8d8d8" stroke="#000" stroke-width="2.5"/>
         <circle cx="38" cy="18" r="8" fill="#d8d8d8" stroke="#000" stroke-width="2.5"/>
         <circle cx="50" cy="20" r="8" fill="#d8d8d8" stroke="#000" stroke-width="2.5"/>
         <rect x="10" y="26" width="44" height="8" rx="3" fill="#3a2a1a" stroke="#000" stroke-width="2.5"/>`,

        // --- Comedy (marquee-gold #e8b923 accent) ---

        // Disco ball
        `<circle cx="30" cy="30" r="20" fill="#d8d8d8" stroke="#000" stroke-width="2.5"/>
         <path d="M12 30 H48 M13 20 H47 M13 40 H47 M20 12 V48 M30 10 V50 M40 12 V48"
              stroke="#000" stroke-width="1.5" fill="none"/>
         <polyline points="46,10 50,6" stroke="#e8b923" stroke-width="2.5" stroke-linecap="round"/>
         <polyline points="50,14 55,12" stroke="#e8b923" stroke-width="2.5" stroke-linecap="round"/>
         <polyline points="44,6 47,2" stroke="#e8b923" stroke-width="2.5" stroke-linecap="round"/>`,
        // Boombox
        `<rect x="6" y="18" width="48" height="30" rx="5" fill="#3a2a1a" stroke="#000" stroke-width="2.5"/>
         <circle cx="18" cy="33" r="10" fill="#f4f1ea" stroke="#000" stroke-width="2.5"/>
         <circle cx="18" cy="33" r="4" fill="#000"/>
         <circle cx="42" cy="33" r="10" fill="#f4f1ea" stroke="#000" stroke-width="2.5"/>
         <circle cx="42" cy="33" r="4" fill="#000"/>
         <rect x="24" y="10" width="12" height="8" rx="2" fill="#e8b923" stroke="#000" stroke-width="2"/>`,
        // Aviator sunglasses
        `<ellipse cx="18" cy="30" rx="12" ry="10" fill="#d8d8d8" stroke="#000" stroke-width="2.5"/>
         <ellipse cx="42" cy="30" rx="12" ry="10" fill="#d8d8d8" stroke="#000" stroke-width="2.5"/>
         <rect x="27" y="27" width="6" height="4" fill="#000"/>
         <line x1="6" y1="27" x2="0" y2="21" stroke="#000" stroke-width="3" stroke-linecap="round"/>
         <line x1="54" y1="27" x2="60" y2="21" stroke="#000" stroke-width="3" stroke-linecap="round"/>
         <polyline points="12,26 18,23" stroke="#e8b923" stroke-width="2.5" stroke-linecap="round"/>`,
    ];

    // Randomizes where the bubble lands, using its own *measured* rendered
    // size (boxWidthPx/boxHeightPx -- see showTriviaBubble, which appends it
    // to the DOM invisibly and measures before calling this) so the chosen
    // spot always keeps the whole box on-screen, never under the chat panel,
    // and never above the bottom third of the video, regardless of trivia
    // text length or screen size:
    //
    // - Horizontal: "left" is a % of viewport width, and CSS centers the box
    //   on that point via translateX(-50%) (see style.css), so half the
    //   box's own width has to fit on each side of the chosen point. The
    //   right-hand limit also subtracts the *actual* configured chat-panel
    //   width (getChatPanelWidth(), core's 04-channel-script-autoapprove.js
    //   -- drag-resizable, 12-34vw, default 19vw) so it can never land under
    //   the sidebar. In vertical layout the chat panel is stacked at the
    //   bottom instead of the right, so there's no sidebar to dodge
    //   horizontally there.
    // - Vertical: "bottom" is a vh offset; capped so the box's top edge
    //   never rises above the bottom third of the viewport (100/3 vh),
    //   however tall a particular trivia fact happens to render.
    function _tpRandomPosition(boxWidthPx, boxHeightPx) {
        const vertical = document.body.classList.contains('sc-vertical');
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const marginPx = 14;
        const chatWidthPx = vertical ? 0 : vw * (typeof getChatPanelWidth === 'function' ? getChatPanelWidth() : 19) / 100;
        const halfW = boxWidthPx / 2;

        let leftMinPct = 100 * (marginPx + halfW) / vw;
        let leftMaxPct = 100 * (vw - chatWidthPx - marginPx - halfW) / vw;
        if (leftMaxPct < leftMinPct) { // box wider than the available space -- just center it in what's there
            const mid = 100 * (vw - chatWidthPx) / (2 * vw);
            leftMinPct = leftMaxPct = mid;
        }

        const boxHeightVh = (boxHeightPx / vh) * 100;
        const bottomMin = 3;
        const bottomMax = Math.max(bottomMin + 2, (100 / 3) - boxHeightVh - 2);

        return {
            leftPct: leftMinPct + Math.random() * (leftMaxPct - leftMinPct),
            bottomVh: bottomMin + Math.random() * (bottomMax - bottomMin),
        };
    }

    /* ==========================================================
       POP SOUND -- synthesized (no audio file) via Web Audio API, so this
       adds a function, not a shipped asset. A single AudioContext is
       created lazily on first pop and reused after that (creating a fresh
       one per pop would be wasteful and can hit browser limits on
       concurrent contexts). Wrapped in try/catch since AudioContext can be
       unavailable/blocked in some environments -- silently skipping the
       sound is preferable to breaking the popup over it.
    ========================================================== */

    let _tpAudioCtx = null;
    function _tpGetAudioCtx() {
        if (!_tpAudioCtx) {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            _tpAudioCtx = new Ctor();
        }
        if (_tpAudioCtx.state === 'suspended') _tpAudioCtx.resume();
        return _tpAudioCtx;
    }

    // Short burst of filtered white noise -- the sharp "click" transient a
    // real pop needs at its onset, which a pure oscillator can't produce.
    function _tpNoiseBurst(ac, { start, dur, freq, q, peak }) {
        const size = Math.max(1, Math.floor(ac.sampleRate * dur));
        const buffer = ac.createBuffer(1, size, ac.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;
        const src = ac.createBufferSource();
        src.buffer = buffer;
        const bp = ac.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = freq;
        bp.Q.value = q;
        const gain = ac.createGain();
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(peak, start + 0.003);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        src.connect(bp).connect(gain).connect(ac.destination);
        src.start(start);
        src.stop(start + dur + 0.01);
    }

    // The squishy body after the click -- pitch bends up then settles back
    // down (a membrane snapping, not a straight sweep), through a lowpass
    // filter whose cutoff falls at the same time for a rubbery, muffled tail.
    function _tpBubbleTone(ac, { start, dur, freqStart, freqPeak, freqEnd, lpStart, lpEnd, q, peak }) {
        const osc = ac.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freqStart, start);
        osc.frequency.exponentialRampToValueAtTime(freqPeak, start + dur * 0.4);
        osc.frequency.exponentialRampToValueAtTime(freqEnd, start + dur);
        const lp = ac.createBiquadFilter();
        lp.type = 'lowpass';
        lp.Q.value = q;
        lp.frequency.setValueAtTime(lpStart, start);
        lp.frequency.exponentialRampToValueAtTime(lpEnd, start + dur);
        const gain = ac.createGain();
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(peak, start + 0.006);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        osc.connect(lp).connect(gain).connect(ac.destination);
        osc.start(start);
        osc.stop(start + dur + 0.02);
    }

    function _tpPlayPopSound() {
        try {
            const ac = _tpGetAudioCtx();
            const t = ac.currentTime;
            _tpNoiseBurst(ac, { start: t, dur: 0.02, freq: 1800, q: 2.5, peak: 0.55 });
            _tpBubbleTone(ac, { start: t, dur: 0.13, freqStart: 220, freqPeak: 600, freqEnd: 380, lpStart: 2600, lpEnd: 600, q: 8, peak: 0.3 });
        } catch (e) {}
    }

    function showTriviaBubble(fact) {
        _tpDismissBubble(true); // no double-stacking if one was somehow still up
        _tpPlayPopSound();

        _tpBubbleEl = document.createElement('div');
        _tpBubbleEl.id = 'sc-tp-bubble';
        const icon = TP_ICONS[Math.floor(Math.random() * TP_ICONS.length)];
        _tpBubbleEl.innerHTML = `
            <svg id="sc-tp-tail" viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">
                <circle cx="30" cy="30" r="27" fill="#000"/>
                <circle cx="30" cy="30" r="27" fill="none" stroke="#c81d25" stroke-width="3"/>
                ${icon}
            </svg>
            <div id="sc-tp-text">${_escHtml(fact)}</div>`;

        // Append first (still invisible -- opacity:0 until .sc-tp-in below)
        // so its real rendered width/height can be measured, then use that
        // to pick a position guaranteed to fit on-screen -- see
        // _tpRandomPosition()'s comment for exactly what it guarantees.
        document.body.appendChild(_tpBubbleEl);

        const pos = _tpRandomPosition(_tpBubbleEl.offsetWidth, _tpBubbleEl.offsetHeight);
        _tpBubbleEl.style.setProperty('left', pos.leftPct + '%', 'important');
        _tpBubbleEl.style.setProperty('bottom',
            document.body.classList.contains('sc-vertical')
                ? `calc(var(--sc-chat-h) + ${pos.bottomVh}vh)`
                : `${pos.bottomVh}vh`,
            'important');

        requestAnimationFrame(() => _tpBubbleEl && _tpBubbleEl.classList.add('sc-tp-in'));

        _tpBubbleEl.addEventListener('click', () => _tpDismissBubble(false));
        _tpBubbleEl.addEventListener('mouseenter', () => clearTimeout(_tpDismissTimer));
        _tpBubbleEl.addEventListener('mouseleave', _tpArmDismissTimer);
        _tpArmDismissTimer();
    }

    function _tpArmDismissTimer() {
        clearTimeout(_tpDismissTimer);
        _tpDismissTimer = setTimeout(() => _tpDismissBubble(false), TP_VISIBLE_MS);
    }

    function _tpDismissBubble(instant) {
        clearTimeout(_tpDismissTimer); _tpDismissTimer = null;
        if (!_tpBubbleEl) return;
        const el = _tpBubbleEl;
        _tpBubbleEl = null;
        if (instant) { el.remove(); return; }
        el.classList.add('sc-tp-out');
        setTimeout(() => el.remove(), TP_EXIT_ANIM_MS);
    }

    scRegisterSetting({
        id: 'sc-input-triviapopup',
        group: 'trivia-popup',
        label: 'Pop-up trivia bubbles during movies (Experimental)',
        note: 'Every few minutes, shows a small IMDb trivia fact somewhere in the bottom half of the screen for about 20 seconds, VH1 Pop-up Video style, then fades out. Off by default. Cycles without repeats and stops once all trivia for the current movie has been shown.',
        key: LS_TRIVIA_POPUP_ENABLED,
        defaultOn: false,
        order: 9,
    });
    scRegisterSetting({
        id: 'sc-input-triviapopupfreq',
        type: 'select',
        group: 'trivia-popup',
        label: 'Pop-up trivia frequency',
        note: 'How often a trivia bubble pops up during a movie.',
        key: LS_TRIVIA_POPUP_FREQUENCY,
        options: [
            { value: 'frequent', label: 'Frequent (45s – 90s)' },
            { value: 'occasional', label: 'Occasional (3 – 6 min, default)' },
            { value: 'rare', label: 'Rare (8 – 15 min)' },
        ],
        defaultValue: TP_FREQUENCY_DEFAULT,
        order: 10,
    });
    scRegisterInit(triviaPopupBoot);
