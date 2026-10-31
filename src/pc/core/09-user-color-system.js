    /* ==========================================================
       USER COLOR SYSTEM
    ========================================================== */

    function hashString(str) {
        let h = 5381;
        for (let i = 0; i < str.length; i++) { h = ((h << 5) + h) ^ str.charCodeAt(i); h |= 0; }
        return Math.abs(h);
    }
    // murmur3 finalizer -- scrambles every bit so hue and lightness tier
    // below come out independent of each other.
    function mixHash(h) {
        h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
        h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
        h ^= h >>> 16;
        return h >>> 0;
    }
    // [lightness, chroma] tiers, so two names that land on a similar hue
    // still differ in brightness. All bright enough for the dark chat bg.
    const USER_COLOR_TIERS = [[0.72, 0.17], [0.80, 0.15], [0.88, 0.12]];
    function usernameToColor(u) {
        // OKLCH, not HSL: HSL hue is perceptually lopsided (everything from
        // ~280-345 reads as "the same pink"), OKLCH hue steps look even.
        const m = mixHash(hashString(u));
        const hue = (m % 3600) / 10;
        const [l, c] = USER_COLOR_TIERS[(m >>> 12) % USER_COLOR_TIERS.length];
        return `oklch(${l} ${c} ${hue.toFixed(1)})`;
    }
