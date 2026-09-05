    /* ==========================================================
       CHAT FORMATTING TOOLBAR — a small pop-up toolbar of CyTube
       chat-markup shortcuts, opened by an "Aa" button that sits one
       slot inboard of the floating #sc-emote-proxy emote button
       (same fixed-position / per-layout-offset pattern as that button
       and grammar-check's #sc-spellcheck-toggle).

       Two kinds of action, both operating on #sc-chat-textarea:
         - WRAP pairs  (_italic_  *bold*  `mono`  ~~strike~~):
             no selection -> insert the pair, caret parked between them
             selection    -> wrap it, keep the inner text selected
             selection already wrapped by that exact pair -> unwrap
         - LINE / MESSAGE prefixes ("> " greentext, "/me ", "/sp "):
             prepend to the caret's line ("> ") or the whole message
             ("/me ", "/sp "); click again to remove it.

       After every action a synthetic 'input' event fires and focus
       returns to the textarea, so core's auto-grow + emote-mirror
       (06-chat-textarea-install.js / 11-chat-input-and-emotes.js)
       stay in sync and the toolbar can stay open for several applies.
       Closes on outside pointerdown (the chat textarea excepted, so
       you can retweak a selection), Esc, or a second toggle click.
    ========================================================== */

    const SC_FMT_WRAPS = [
        { id: 'italic', label: 'I',  title: 'Italic  _text_',          marker: '_' },
        { id: 'bold',   label: 'B',  title: 'Bold  *text*',            marker: '*' },
        { id: 'mono',   label: '<>', title: 'Monospace  `text`',       marker: '`' },
        { id: 'strike', label: 'S',  title: 'Strikethrough  ~~text~~', marker: '~~' },
    ];
    const SC_FMT_PREFIXES = [
        { id: 'green', label: '>',   title: 'Greentext  > line',   prefix: '> ',   scope: 'line' },
        { id: 'me',    label: '/me', title: 'Action text  /me …',  prefix: '/me ', scope: 'message' },
        { id: 'sp',    label: '/sp', title: 'Spoiler  /sp …',      prefix: '/sp ', scope: 'message' },
    ];

    function scFmtTextarea() {
        return document.getElementById('sc-chat-textarea');
    }

    // Common tail for every edit: let core react to the change ('input'),
    // then restore focus and the caller's chosen selection range.
    function scFmtCommit(ta, selStart, selEnd) {
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.focus();
        ta.selectionStart = selStart;
        ta.selectionEnd = selEnd;
    }

    function scFmtApplyWrap(marker) {
        const ta = scFmtTextarea();
        if (!ta) return;
        const v = ta.value;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const m = marker;
        const mLen = m.length;

        // Selection sits between an existing pair -> strip the pair (toggle off).
        if (start !== end && start >= mLen &&
            v.slice(start - mLen, start) === m &&
            v.slice(end, end + mLen) === m) {
            ta.value = v.slice(0, start - mLen) + v.slice(start, end) + v.slice(end + mLen);
            scFmtCommit(ta, start - mLen, end - mLen);
            return;
        }
        // Selection *includes* the pair (…text… plus its markers) -> strip from inside.
        if (end - start >= 2 * mLen &&
            v.slice(start, start + mLen) === m &&
            v.slice(end - mLen, end) === m) {
            ta.value = v.slice(0, start) + v.slice(start + mLen, end - mLen) + v.slice(end);
            scFmtCommit(ta, start, end - 2 * mLen);
            return;
        }

        if (start === end) {
            // No selection: drop the pair, park the caret between the markers.
            ta.value = v.slice(0, start) + m + m + v.slice(end);
            scFmtCommit(ta, start + mLen, start + mLen);
        } else {
            // Wrap the selection, keep the inner text selected for chaining.
            ta.value = v.slice(0, start) + m + v.slice(start, end) + m + v.slice(end);
            scFmtCommit(ta, start + mLen, end + mLen);
        }
    }

    function scFmtApplyPrefix(prefix, scope) {
        const ta = scFmtTextarea();
        if (!ta) return;
        const v = ta.value;
        const selStart = ta.selectionStart;
        const selEnd = ta.selectionEnd;
        // Affected span starts after the previous newline (line) or at 0 (message).
        const at = scope === 'line' ? v.lastIndexOf('\n', selStart - 1) + 1 : 0;
        const rest = v.slice(at);

        if (rest.startsWith(prefix)) {
            // Toggle off.
            ta.value = v.slice(0, at) + rest.slice(prefix.length);
            const clamp = (p) => Math.max(at, p - prefix.length);
            scFmtCommit(ta, clamp(selStart), clamp(selEnd));
        } else {
            ta.value = v.slice(0, at) + prefix + rest;
            scFmtCommit(ta, selStart + prefix.length, selEnd + prefix.length);
        }
    }

    /* ---------- toolbar UI ---------- */

    let scFmtBarEl = null;
    let scFmtToggleEl = null;

    function scFmtOutside(e) {
        if (scFmtBarEl.contains(e.target) || scFmtToggleEl.contains(e.target)) return;
        if (e.target && e.target.id === 'sc-chat-textarea') return; // let the user re-select
        scFmtCloseBar();
    }
    function scFmtEsc(e) {
        if (e.key === 'Escape') { scFmtCloseBar(); const ta = scFmtTextarea(); if (ta) ta.focus(); }
    }
    function scFmtOpenBar() {
        if (!scFmtBarEl) return;
        scFmtBarEl.hidden = false;
        scFmtToggleEl.setAttribute('aria-expanded', 'true');
        document.addEventListener('pointerdown', scFmtOutside, true);
        document.addEventListener('keydown', scFmtEsc, true);
    }
    function scFmtCloseBar() {
        if (scFmtBarEl) scFmtBarEl.hidden = true;
        if (scFmtToggleEl) scFmtToggleEl.setAttribute('aria-expanded', 'false');
        document.removeEventListener('pointerdown', scFmtOutside, true);
        document.removeEventListener('keydown', scFmtEsc, true);
    }

    function scFmtBuildButton(spec, onClick) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'sc-fmt-btn';
        b.dataset.fmt = spec.id;
        b.textContent = spec.label;
        b.title = spec.title;
        b.setAttribute('aria-label', spec.title);
        b.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            onClick();
        });
        return b;
    }

    function installFormatToolbar() {
        const ta = document.getElementById('sc-chat-textarea');
        if (!ta) return false;
        if (document.getElementById('sc-format-toggle')) return true;

        const toggle = document.createElement('button');
        toggle.id = 'sc-format-toggle';
        toggle.type = 'button';
        toggle.textContent = 'Aa';
        toggle.title = 'Text formatting';
        toggle.setAttribute('aria-label', 'Text formatting');
        toggle.setAttribute('aria-expanded', 'false');

        const bar = document.createElement('div');
        bar.id = 'sc-format-bar';
        bar.hidden = true;
        bar.setAttribute('role', 'toolbar');
        bar.setAttribute('aria-label', 'Chat text formatting');

        SC_FMT_WRAPS.forEach((spec) => {
            bar.appendChild(scFmtBuildButton(spec, () => scFmtApplyWrap(spec.marker)));
        });
        const sep = document.createElement('span');
        sep.className = 'sc-fmt-sep';
        sep.setAttribute('aria-hidden', 'true');
        bar.appendChild(sep);
        SC_FMT_PREFIXES.forEach((spec) => {
            bar.appendChild(scFmtBuildButton(spec, () => scFmtApplyPrefix(spec.prefix, spec.scope)));
        });

        toggle.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (bar.hidden) scFmtOpenBar();
            else { scFmtCloseBar(); ta.focus(); }
        });

        scFmtBarEl = bar;
        scFmtToggleEl = toggle;
        document.body.appendChild(bar);
        document.body.appendChild(toggle);
        return true;
    }

    // The textarea is installed by core's boot MutationObserver, normally
    // before this scRegisterInit callback runs on 'load' -- but retry a few
    // times in case it isn't in the DOM yet (same pattern as grammar-check's
    // initSpellcheckToggle).
    function initFormatToolbar() {
        if (installFormatToolbar()) return;
        let tries = 0;
        const timer = setInterval(() => {
            if (installFormatToolbar() || ++tries > 20) clearInterval(timer);
        }, 150);
    }

    scRegisterInit(initFormatToolbar);
