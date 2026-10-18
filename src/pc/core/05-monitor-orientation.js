    /* ==========================================================
       MONITOR / ORIENTATION DETECTION
    ========================================================== */

    function isVerticalMonitor() {
        // Prefer screen.orientation: Brave's fingerprinting protection can
        // report screen.width/height of a different (landscape) display
        // while orientation.type still reflects the monitor we're on.
        const type = window.screen.orientation && window.screen.orientation.type;
        if (type) return type.startsWith('portrait');
        return window.screen.height > window.screen.width;
    }
    function applyMonitorLayout() {
        const wasVert = document.body.classList.contains('sc-vertical');
        const isVert  = isVerticalMonitor();
        document.body.classList.toggle('sc-vertical',   isVert);
        document.body.classList.toggle('sc-horizontal', !isVert);
        if (wasVert !== isVert) {
            const buf = document.getElementById('messagebuffer');
            if (buf) setTimeout(() => { buf.scrollTop = buf.scrollHeight; }, 200);
        }
    }
    function startMonitorWatcher() {
        applyMonitorLayout();
        setInterval(applyMonitorLayout, 800);
    }

    /* ==========================================================
       ROUNDED VIDEO CORNERS — YouTube-style softened corners on the
       picture itself. A plain border-radius on the <video> would round
       its element box, but the picture is usually letterboxed inside
       it (object-fit: contain), so the rounding would land in the
       invisible black bars. Instead compute the actual picture rect
       from videoWidth/videoHeight and clip to that with a rounded
       inset(). Re-measured on a slow poll (the <video> element gets
       swapped on media change, and the panel resizer changes its size
       without a window resize) plus window resize; the style is only
       rewritten when the value actually changes. Bars burned into the
       video file itself can't be detected, so those stay square.
       YouTube media (iframe, no <video>) is left alone.
    ========================================================== */
    const VIDEO_CORNER_RADIUS_PX = 12;

    function applyRoundedVideoCorners() {
        const v = getPlayerVideoEl();
        if (!v || !v.videoWidth || !v.videoHeight) return;
        const ew = v.clientWidth, eh = v.clientHeight;
        if (!ew || !eh) return;
        const scale = Math.min(ew / v.videoWidth, eh / v.videoHeight);
        const insetX = Math.max(0, (ew - v.videoWidth * scale) / 2);
        const insetY = Math.max(0, (eh - v.videoHeight * scale) / 2);
        const clip = `inset(${insetY.toFixed(1)}px ${insetX.toFixed(1)}px round ${VIDEO_CORNER_RADIUS_PX}px)`;
        if (v.style.clipPath !== clip) v.style.clipPath = clip;
    }
    function initRoundedVideoCorners() {
        applyRoundedVideoCorners();
        setInterval(applyRoundedVideoCorners, 1000);
        window.addEventListener('resize', applyRoundedVideoCorners);
    }
