    /* ==========================================================
       CHAT TEXTAREA INSTALLATION
    ========================================================== */

    function installChatTextarea() {
        const originalInput = document.getElementById('chatline');
        if (!originalInput) return false;
        if (document.getElementById('sc-chat-textarea')) return true;

        originalInput.style.cssText = `
            position: absolute !important; width: 1px !important; height: 1px !important;
            opacity: 0 !important; pointer-events: none !important; top: -9999px !important;`;

        const textarea = document.createElement('textarea');
        textarea.id = 'sc-chat-textarea';
        textarea.placeholder = 'Type a message…';
        textarea.spellcheck = true; textarea.lang = 'en'; textarea.rows = 2;
        textarea.setAttribute('autocorrect', 'on');
        textarea.setAttribute('autocapitalize', 'sentences');

        // Drag handle above the textarea — lets the user pick a fixed height,
        // which then overrides the auto-grow-while-typing behavior below.
        const taResizer = document.createElement('div');
        taResizer.id = 'sc-chat-ta-resizer';

        originalInput.parentElement.insertBefore(taResizer, originalInput.nextSibling);
        originalInput.parentElement.insertBefore(textarea, taResizer.nextSibling);

        const taHeightMax = () => window.innerHeight * 0.5;
        let manualHeight = null;
        const savedTaH = parseFloat(getKey(LS_CHAT_TEXTAREA_H));
        if (Number.isFinite(savedTaH) && savedTaH >= 44 && savedTaH <= taHeightMax()) {
            manualHeight = savedTaH;
            textarea.style.height = manualHeight + 'px';
        }

        textarea.addEventListener('input', () => {
            tabCandidates = [];
            lastChatlineValue = originalInput.value;
            if (manualHeight == null) {
                textarea.style.height = 'auto';
                textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
            }
        });
        textarea.addEventListener('keydown', e => {
            handleTabComplete(textarea, e);
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                // Don't fire if a review modal is already open
                if (!document.getElementById('sc-modal-overlay')) {
                    attemptSend(textarea, originalInput);
                }
            }
        });
        originalInput.addEventListener('focus', () => textarea.focus());

        let taDragging = false, taStartY, taStartH;
        taResizer.addEventListener('mousedown', e => {
            e.preventDefault();
            taDragging = true;
            taStartY = e.clientY;
            taStartH = textarea.getBoundingClientRect().height;
            taResizer.classList.add('sc-resizing');
            document.body.style.userSelect = 'none';
        });
        window.addEventListener('mousemove', e => {
            if (!taDragging) return;
            const h = Math.min(taHeightMax(), Math.max(44, taStartH + (taStartY - e.clientY)));
            manualHeight = h;
            textarea.style.height = h + 'px';
        });
        window.addEventListener('mouseup', () => {
            if (!taDragging) return;
            taDragging = false;
            taResizer.classList.remove('sc-resizing');
            document.body.style.userSelect = '';
            setKey(LS_CHAT_TEXTAREA_H, String(manualHeight));
        });

        const chatwrap = document.getElementById('chatwrap');
        if (chatwrap) {
            chatwrap.addEventListener('click', e => {
                if (e.target === chatwrap || e.target.id === 'messagebuffer') textarea.focus();
            });
        }

        startEmoteWatcher(originalInput, textarea);
        return true;
    }
