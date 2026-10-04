// scripts/test-popupvideo-build.mjs
//
// Builds the standalone Pop-up Video script in memory and checks: header,
// minimal contents, syntax, and that it boots / stands down in a stub DOM.
//   node scripts/test-popupvideo-build.mjs
import vm from 'node:vm';
import { buildPopupVideo, POPUPVIDEO_VERSION } from './build-popupvideo.mjs';

let failed = 0;
const ok = (label, cond) => { if (!cond) { console.error('FAIL:', label); failed++; } };

const src = buildPopupVideo();
ok('name', /\/\/ @name\s+Grindhouse Pop-up Video/.test(src));
ok('version', new RegExp(`// @version\\s+${POPUPVIDEO_VERSION.replace(/\./g, '\\.')}`).test(src));
ok('match 420Grindhouse', src.includes('// @match        https://cytu.be/r/420Grindhouse'));
ok('grant GM_xmlhttpRequest', /\/\/ @grant\s+GM_xmlhttpRequest/.test(src));
const connects = [...src.matchAll(/\/\/ @connect\s+(\S+)/g)].map(m => m[1]).sort();
ok('exactly the two connects', JSON.stringify(connects) === JSON.stringify(['caching.graphql.imdb.com', 'raw.githubusercontent.com']));
ok('no @require', !/\/\/ @require/.test(src));
// Included shared files legitimately mention main-script functions in comments,
// so check for definitions, not bare names.
for (const absent of ['showNowPlayingCard', 'openFixMatchModal', 'showTriviaCard', 'fetchTmdbPrimary', 'LINK_DEFS']) {
    ok(`does not define ${absent}`, !new RegExp('\\b(function|const|let)\\s+' + absent + '\\b').test(src));
}
ok('does not contain initMediaWatcher', !src.includes('initMediaWatcher'));
for (const present of ['SC_POPUPVIDEO_STANDALONE', 'imdbSearchTitle', 'parseMovieFilename', 'tpDueFact', 'tpCatchUpFact', 'pvWatcherBoot']) {
    ok(`contains ${present}`, src.includes(present));
}
try { new Function(src); } catch (e) { ok('syntax: ' + e.message, false); }

// Boot in a stub browser. Returns what the socket saw bound.
function boot({ marker }) {
    const listeners = {};
    const socketOn = [];
    const attrs = marker ? { 'data-sc-trivia-popup': '1' } : {};
    const el = () => ({ style: { setProperty() {} }, classList: { add() {}, toggle() {}, contains: () => false }, addEventListener() {}, appendChild() {}, remove() {}, setAttribute() {}, querySelector: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }) });
    const store = {};
    const ctx = {
        console, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
        localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
        GM_xmlhttpRequest() {},
        socket: { on: (ev) => socketOn.push(ev) },
        document: {
            head: el(), body: el(),
            documentElement: { getAttribute: k => attrs[k] ?? null, setAttribute: (k, v) => { attrs[k] = v; } },
            createElement: el, createElementNS: el, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
            addEventListener() {}, hasFocus: () => true,
        },
        window: null,
        innerWidth: 1920, innerHeight: 1080,
    };
    ctx.window = { addEventListener: (ev, fn) => { (listeners[ev] ||= []).push(fn); }, ...ctx };
    ctx.addEventListener = ctx.window.addEventListener;
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    for (const fn of listeners.load || []) fn();
    return { socketOn, attrs };
}

const solo = boot({ marker: false });
ok('runs alone: binds changeMedia', solo.socketOn.includes('changeMedia'));
ok('standalone never sets the stand-down marker', solo.attrs['data-sc-trivia-popup'] !== '1');
const withMain = boot({ marker: true });
ok('stands down when main script marker present', withMain.socketOn.length === 0);

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('PASS: popupvideo standalone build — header, contents, syntax, boot, stand-down');
