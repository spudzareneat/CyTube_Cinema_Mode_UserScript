// docs/customizer.js
//
// Browser port of scripts/assemble.mjs's dependency-resolution / topo-sort /
// concatenation / header-templating logic, using fetch() against raw GitHub
// content instead of fs.readFileSync against the local checkout.
//
// KEEP IN SYNC BY HAND with scripts/assemble.mjs. There is no shared module
// between the Node build tooling and this static page — no build step, by
// design (plain HTML/vanilla JS only). If you change resolution, ordering,
// concatenation, or header-fill logic in one file, change it in the other.

const RAW_BASE = 'https://raw.githubusercontent.com/spudzareneat/CyTube_Cinema_Mode_UserScript/main/';

// ---- assembly logic (mirrors scripts/assemble.mjs) ------------------------

// Escapes a CSS string for safe interpolation into a JS template literal
// (`injectCSS('id', \`...\`)`  below). No current CSS file contains a
// backtick, `${`, or a backslash escape sequence, but CSS `content:`
// properties commonly use backslash escapes for icon glyphs (e.g.
// `content: "\2192"`), so this guards every future CSS edit that flows
// through here. Backslashes must be escaped FIRST, before the other two
// replacements, since those replacements themselves introduce backslashes
// that must not be re-escaped.
// KEEP IN SYNC BY HAND with scripts/assemble.mjs's identical helper.
function escapeCssForTemplateLiteral(css) {
    return css.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function resolveSelectedModules(manifest, selectedIds) {
    const byId = new Map(manifest.modules.map((m) => [m.id, m]));
    const resolvedIds = new Set();
    const queue = [...selectedIds];
    while (queue.length) {
        const id = queue.shift();
        if (resolvedIds.has(id)) continue;
        const mod = byId.get(id);
        if (!mod) throw new Error(`assemble: unknown module id "${id}"`);
        resolvedIds.add(id);
        for (const depId of mod.dependsOn || []) {
            if (!resolvedIds.has(depId)) queue.push(depId);
        }
    }
    return [...resolvedIds].map((id) => byId.get(id));
}

function topoSort(modules) {
    const byId = new Map(modules.map((m) => [m.id, m]));
    const inDegree = new Map(modules.map((m) => [m.id, 0]));
    const dependents = new Map(modules.map((m) => [m.id, []]));
    for (const mod of modules) {
        for (const depId of mod.dependsOn || []) {
            if (!byId.has(depId)) continue;
            dependents.get(depId).push(mod.id);
            inDegree.set(mod.id, inDegree.get(mod.id) + 1);
        }
    }
    const queue = modules.filter((m) => inDegree.get(m.id) === 0).map((m) => m.id);
    const orderedIds = [];
    while (queue.length) {
        const id = queue.shift();
        orderedIds.push(id);
        for (const nextId of dependents.get(id)) {
            inDegree.set(nextId, inDegree.get(nextId) - 1);
            if (inDegree.get(nextId) === 0) queue.push(nextId);
        }
    }
    if (orderedIds.length !== modules.length) {
        throw new Error('assemble: cyclic dependency detected among selected modules');
    }
    return orderedIds.map((id) => byId.get(id));
}

function fillHeaderTemplate(templateSrc, { version, grants, connects }) {
    const grantLines = grants.map((g) => `// @grant        ${g}`).join('\r\n');
    const connectLines = connects.map((c) => `// @connect      ${c}`).join('\r\n');
    return templateSrc.replace('{{VERSION}}', version).replace('{{GRANTS}}', grantLines).replace('{{CONNECTS}}', connectLines);
}

function normalize(text) {
    return text.replace(/\s+$/, '') + '\r\n';
}

async function fetchRaw(relPath) {
    const res = await fetch(RAW_BASE + relPath);
    if (!res.ok) throw new Error(`failed to fetch ${relPath}: HTTP ${res.status}`);
    return res.text();
}

// Resolves selectedIds + transitive deps, topo-sorts, fetches every needed
// file in one parallel batch, then concatenates in the same locked-first /
// topo order and header-fills exactly as scripts/assemble.mjs does.
async function assemble(manifest, selectedIds) {
    const selectedModules = resolveSelectedModules(manifest, selectedIds);
    const orderedModules = topoSort(selectedModules);

    const lockedOrdered = orderedModules.filter((m) => m.locked);
    const unlockedOrdered = orderedModules.filter((m) => !m.locked);
    const emissionOrder = [...lockedOrdered, ...unlockedOrdered];

    const grants = [...new Set(orderedModules.flatMap((m) => m.grants || []))];
    const connects = [...new Set(orderedModules.flatMap((m) => m.connects || []))];

    const allPaths = [manifest.headerTemplate, ...emissionOrder.flatMap((m) => [...(m.files || []), ...(m.cssFiles || [])])];
    const uniquePaths = [...new Set(allPaths)];
    const texts = new Map(await Promise.all(uniquePaths.map(async (p) => [p, await fetchRaw(p)])));

    const filledHeader = fillHeaderTemplate(texts.get(manifest.headerTemplate), {
        version: manifest.baseVersion,
        grants,
        connects,
    });

    const chunks = [];
    for (const mod of emissionOrder) {
        for (const file of mod.files || []) {
            chunks.push(normalize(texts.get(file)));
        }
        if (mod.cssFiles && mod.cssFiles.length) {
            const css = mod.cssFiles.map((f) => normalize(texts.get(f))).join('\r\n');
            chunks.push(`injectCSS('${mod.id}', \`${escapeCssForTemplateLiteral(css)}\`);\r\n`);
        }
    }

    return filledHeader + '\r\n(function () {\r\n    \'use strict\';\r\n\r\n' + chunks.join('') + '\r\n})();\r\n';
}

// ---- UI wiring --------------------------------------------------------

let manifest = null;
let byId = new Map();
const selected = new Set();
let lastBuiltScript = null;

function transitiveDeps(id, seen = new Set()) {
    const mod = byId.get(id);
    for (const depId of (mod && mod.dependsOn) || []) {
        if (!seen.has(depId)) {
            seen.add(depId);
            transitiveDeps(depId, seen);
        }
    }
    return seen;
}

function isRequiredByOthers(id) {
    for (const otherId of selected) {
        if (otherId !== id && transitiveDeps(otherId).has(id)) return true;
    }
    return false;
}

function onToggle(id) {
    const mod = byId.get(id);
    if (!mod || mod.locked) return; // core: locked checkbox, no-op safeguard
    if (selected.has(id)) {
        if (isRequiredByOthers(id)) return; // checkbox should already be disabled
        selected.delete(id);
    } else {
        selected.add(id);
        for (const depId of transitiveDeps(id)) selected.add(depId);
    }
    render();
}

function groupByCategory(modules) {
    const groups = new Map();
    for (const mod of modules) {
        const cat = mod.category || 'Other';
        if (!groups.has(cat)) groups.set(cat, []);
        groups.get(cat).push(mod);
    }
    return groups;
}

function render() {
    const list = document.getElementById('module-list');
    list.innerHTML = '';

    for (const [category, modules] of groupByCategory(manifest.modules)) {
        const section = document.createElement('fieldset');
        section.className = 'module-category';

        const legend = document.createElement('legend');
        legend.textContent = category;
        section.appendChild(legend);

        for (const mod of modules) {
            const disabled = mod.locked || isRequiredByOthers(mod.id);
            const row = document.createElement('label');
            row.className = 'module-row' + (disabled ? ' module-row-disabled' : '');

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = selected.has(mod.id);
            checkbox.disabled = disabled;
            checkbox.addEventListener('change', () => onToggle(mod.id));

            const label = document.createElement('span');
            label.textContent = mod.name;
            if (disabled && !mod.locked) {
                const requiredBy = [...selected].filter((otherId) => otherId !== mod.id && transitiveDeps(otherId).has(mod.id));
                const names = requiredBy.map((id) => byId.get(id).name).join(', ');
                label.title = `Required by: ${names}`;
                const hint = document.createElement('small');
                hint.textContent = ` (required by ${names})`;
                label.appendChild(hint);
            }

            row.appendChild(checkbox);
            row.appendChild(label);
            section.appendChild(row);
        }

        list.appendChild(section);
    }
}

// ---- companion scripts (standalone siblings, no assembly) -------------

function renderCompanions(companions) {
    const list = document.getElementById('companion-list');
    list.innerHTML = '';
    if (!companions || !companions.length) return;

    const section = document.createElement('fieldset');
    section.className = 'module-category';

    const legend = document.createElement('legend');
    legend.textContent = 'Standalone scripts';
    section.appendChild(legend);

    for (const comp of companions) {
        // A plain div, not a <label>, because this row also contains a
        // <button> -- nesting a button inside a label risks the label's
        // implicit click-forwarding double-firing the checkbox toggle.
        // The checkbox + text are wrapped in their own inner <label>
        // instead, matching the main picker's click-to-toggle feel.
        const row = document.createElement('div');
        row.className = 'module-row companion-row';

        const toggleLabel = document.createElement('label');
        toggleLabel.className = 'companion-toggle';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `companion-${comp.id}`;

        const textWrap = document.createElement('span');
        textWrap.className = 'companion-text';
        const name = document.createElement('span');
        name.className = 'companion-name';
        name.textContent = comp.name;
        const desc = document.createElement('small');
        desc.textContent = comp.description;
        textWrap.appendChild(name);
        textWrap.appendChild(desc);

        toggleLabel.appendChild(checkbox);
        toggleLabel.appendChild(textWrap);

        const downloadBtn = document.createElement('button');
        downloadBtn.type = 'button';
        downloadBtn.className = 'btn companion-download-btn';
        downloadBtn.textContent = 'Download';
        downloadBtn.disabled = !checkbox.checked;
        downloadBtn.addEventListener('click', async (evt) => {
            evt.preventDefault();
            downloadBtn.disabled = true;
            downloadBtn.textContent = 'Downloading…';
            try {
                const res = await fetch(RAW_BASE + comp.file);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const text = await res.text();
                const blob = new Blob([text], { type: 'text/javascript' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = comp.file;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
                downloadBtn.textContent = 'Download';
            } catch (err) {
                downloadBtn.textContent = 'Download failed';
                setStatus(`Failed to download ${comp.file}: ${err.message}`, true);
            } finally {
                downloadBtn.disabled = !checkbox.checked;
            }
        });

        // Checkbox gates the button (mirrors the main picker's checkbox
        // pattern) but each row's download is otherwise fully independent --
        // no shared build/assembly step for companions.
        checkbox.addEventListener('change', () => {
            downloadBtn.disabled = !checkbox.checked;
        });

        row.appendChild(toggleLabel);
        row.appendChild(downloadBtn);
        section.appendChild(row);
    }

    list.appendChild(section);
}

function setStatus(text, isError) {
    const status = document.getElementById('status');
    status.textContent = text;
    status.className = isError ? 'status status-error' : 'status';
}

async function init() {
    setStatus('Loading manifest…');
    const res = await fetch('manifest.json');
    manifest = await res.json();
    byId = new Map(manifest.modules.map((m) => [m.id, m]));

    for (const mod of manifest.modules) {
        if (mod.locked || mod.defaultOn) selected.add(mod.id);
    }
    for (const id of [...selected]) {
        for (const depId of transitiveDeps(id)) selected.add(depId);
    }

    render();
    renderCompanions(manifest.companions);
    setStatus('Pick your features, then click "Build my script".');

    document.getElementById('build-btn').addEventListener('click', async () => {
        const downloadBtn = document.getElementById('download-btn');
        const copyBtn = document.getElementById('copy-btn');
        downloadBtn.disabled = true;
        copyBtn.disabled = true;
        setStatus('Building… fetching module source from GitHub.');
        try {
            lastBuiltScript = await assemble(manifest, [...selected]);
            downloadBtn.disabled = false;
            copyBtn.disabled = false;
            setStatus(`Built successfully (${selected.size} module${selected.size === 1 ? '' : 's'}). Ready to download or copy.`);
        } catch (err) {
            setStatus(`Build failed: ${err.message}`, true);
        }
    });

    document.getElementById('download-btn').addEventListener('click', () => {
        if (!lastBuiltScript) return;
        const blob = new Blob([lastBuiltScript], { type: 'text/javascript' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'cytube.pc.custom.user.js';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    });

    document.getElementById('copy-btn').addEventListener('click', async () => {
        if (!lastBuiltScript) return;
        await navigator.clipboard.writeText(lastBuiltScript);
        setStatus('Copied to clipboard.');
    });
}

init().catch((err) => setStatus(`Failed to load manifest: ${err.message}`, true));
