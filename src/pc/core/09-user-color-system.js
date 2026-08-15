    /* ==========================================================
       USER COLOR SYSTEM
    ========================================================== */

    function hashString(str) {
        let h = 5381;
        for (let i = 0; i < str.length; i++) { h = ((h << 5) + h) ^ str.charCodeAt(i); h |= 0; }
        return Math.abs(h);
    }
    function usernameToColor(u) {
        // Golden angle multiplication spreads hues maximally apart so
        // no two nearby hash values share a similar colour.
        const hue = (hashString(u) * 137.508) % 360;
        return `hsl(${hue.toFixed(1)}, 72%, 70%)`;
    }
