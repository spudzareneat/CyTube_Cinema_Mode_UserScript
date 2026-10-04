// scripts/test-popupvideo-button.mjs
//
// Assertions for the standalone Pop-up Video toggle hooks in
// src/popupvideo/watcher.js (scPopupBtnMount / scPopupBtnPaint): the toggle
// goes first in CyTube's #videocontrols, styled like its neighbours.
//   node scripts/test-popupvideo-button.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'popupvideo', 'watcher.js'), 'utf8');
const START = '// ── test marker: pv-button slice start ──';
const END = '// ── test marker: pv-button slice end ──';
const s = src.indexOf(START), e = src.indexOf(END);
if (s === -1 || e === -1 || e < s) {
    console.error('FAIL: could not locate the "pv-button" test-marker slice in src/popupvideo/watcher.js');
    process.exit(1);
}

let failed = 0;
function eq(label, actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        console.error(`FAIL: ${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
        failed++;
    }
}

function fakeEl() {
    const classes = new Set();
    return {
        id: '', type: '', title: '', innerHTML: '', children: [], style: { opacity: '' },
        get className() { return [...classes].join(' '); },
        set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
        classList: {
            add: c => classes.add(c),
            toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
            contains: c => classes.has(c),
        },
        insertBefore(node, ref) { const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(node); else this.children.splice(i, 0, node); },
        appendChild(node) { this.children.push(node); },
        get firstChild() { return this.children[0] || null; },
    };
}

function load(withControls) {
    const controls = fakeEl();
    const refresh = fakeEl(); refresh.id = 'mediarefresh';
    controls.appendChild(refresh);
    const body = fakeEl();
    const document = { body, getElementById: id => (withControls && id === 'videocontrols') ? controls : null };
    // eslint-disable-next-line no-new-func
    const api = new Function('document', `${src.slice(s, e)}\n;return { scPopupBtnMount, scPopupBtnPaint };`)(document);
    return { api, controls, body, refresh };
}

{
    const { api, controls, refresh } = load(true);
    const btn = fakeEl();
    api.scPopupBtnMount(btn);
    eq('mounted first in #videocontrols', controls.children.map(c => c.id), ['sc-pv-btn', 'mediarefresh']);
    eq('styled like the other video controls', btn.className, 'btn btn-sm btn-default');
    eq('type=button', btn.type, 'button');
    eq('own id (main module CSS never applies)', btn.id, 'sc-pv-btn');
    eq('refresh untouched', refresh.id, 'mediarefresh');

    api.scPopupBtnPaint(btn, false);
    eq('on: glyphicon speech bubble', btn.innerHTML, '<span class="glyphicon glyphicon-comment"></span>');
    eq('on: pressed (active)', btn.classList.contains('active'), true);
    eq('on: tooltip', btn.title, 'Pop-up trivia on — click to mute');
    eq('on: full opacity', btn.style.opacity, '');

    api.scPopupBtnPaint(btn, true);
    eq('muted: not pressed', btn.classList.contains('active'), false);
    eq('muted: dimmed', btn.style.opacity, '0.55');
    eq('muted: tooltip', btn.title, 'Pop-up trivia muted — click to resume');
}
{
    const { api, body } = load(false);
    const btn = fakeEl();
    api.scPopupBtnMount(btn);
    eq('no #videocontrols: falls back to a floating button on body', body.children.length, 1);
    eq('fallback class', btn.classList.contains('sc-pv-floating'), true);
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('PASS: popupvideo — toggle mounts in #videocontrols, styled + painted like CyTube controls');
