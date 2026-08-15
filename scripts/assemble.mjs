// scripts/assemble.mjs
//
// Dependency-free module assembler for the CyTube PC userscript.
// Given a manifest (src/pc/manifest.json) and a list of selected module
// ids, resolves dependencies, topologically sorts, and concatenates the
// selected modules' JS/CSS into a single Tampermonkey-ready .user.js
// source string.
//
// No npm packages — only Node's built-in fs/path. This file is imported
// by scripts/build-dev-bundle.mjs (Node, local dev builds).
//
// docs/customizer.js is a hand-ported browser twin of this logic (fetch()
// instead of fs.readFileSync, no Node built-ins) for the GitHub Pages
// customizer site. There is no shared module between the two — no build
// step, by design. KEEP IN SYNC BY HAND: any change to dependency
// resolution, topo-sort, concatenation, or header-fill logic here must be
// mirrored in docs/customizer.js.

import fs from 'node:fs';
import path from 'node:path';

// Escapes a CSS string for safe interpolation into a JS template literal
// (`injectCSS('id', \`...\`)`  below). No current CSS file contains a
// backtick, `${`, or a backslash escape sequence, but CSS `content:`
// properties commonly use backslash escapes for icon glyphs (e.g.
// `content: "\2192"`), so this guards every future CSS edit that flows
// through here. Backslashes must be escaped FIRST, before the other two
// replacements, since those replacements themselves introduce backslashes
// that must not be re-escaped.
// KEEP IN SYNC BY HAND with docs/customizer.js's identical helper.
function escapeCssForTemplateLiteral(css) {
    return css.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/**
 * Resolves `selectedIds` plus their transitive `dependsOn` into a list of
 * module objects (order not yet meaningful — topoSort handles that).
 */
function resolveSelectedModules(manifest, selectedIds) {
    const byId = new Map(manifest.modules.map((m) => [m.id, m]));
    const resolvedIds = new Set();
    const queue = [...selectedIds];

    while (queue.length) {
        const id = queue.shift();
        if (resolvedIds.has(id)) continue;

        const mod = byId.get(id);
        if (!mod) {
            throw new Error(`assemble: unknown module id "${id}" (not present in manifest.modules)`);
        }

        resolvedIds.add(id);
        for (const depId of mod.dependsOn || []) {
            if (!resolvedIds.has(depId)) queue.push(depId);
        }
    }

    return [...resolvedIds].map((id) => byId.get(id));
}

/**
 * Topologically sorts `modules` (an array of manifest module objects)
 * using Kahn's algorithm, so every module appears after everything it
 * `dependsOn`. Throws if a cycle is detected.
 */
function topoSort(modules) {
    const byId = new Map(modules.map((m) => [m.id, m]));
    const inDegree = new Map(modules.map((m) => [m.id, 0]));
    const dependents = new Map(modules.map((m) => [m.id, []]));

    for (const mod of modules) {
        for (const depId of mod.dependsOn || []) {
            if (!byId.has(depId)) continue; // dep outside the selected set; nothing to order against
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
        const unresolved = modules.map((m) => m.id).filter((id) => !orderedIds.includes(id));
        throw new Error(`assemble: cyclic dependency detected among modules: ${unresolved.join(', ')}`);
    }

    return orderedIds.map((id) => byId.get(id));
}

/**
 * Fills header.template.js's {{VERSION}}, {{GRANTS}}, {{CONNECTS}}
 * placeholders. Every other header field is left as-is in the template
 * (it's reused verbatim from the original script header).
 */
function fillHeaderTemplate(templateSrc, { version, grants, connects }) {
    const grantLines = grants.map((g) => `// @grant        ${g}`).join('\r\n');
    const connectLines = connects.map((c) => `// @connect      ${c}`).join('\r\n');

    return templateSrc
        .replace('{{VERSION}}', version)
        .replace('{{GRANTS}}', grantLines)
        .replace('{{CONNECTS}}', connectLines);
}

/**
 * Reads `filePath` (resolved against baseDir) as utf8 text, trims trailing
 * whitespace/newlines, and returns it with exactly one trailing CRLF, so
 * concatenating multiple files back-to-back always yields a clean
 * single-newline separation regardless of how each source file happens to
 * end.
 */
function readNormalized(baseDir, relPath) {
    const abs = path.join(baseDir, relPath);
    const raw = fs.readFileSync(abs, 'utf8');
    return raw.replace(/\s+$/, '') + '\r\n';
}

/**
 * Assembles a full .user.js source string for `selectedIds` (plus their
 * transitive dependencies) drawn from `manifest`.
 *
 * @param {object} manifest - parsed src/pc/manifest.json
 * @param {string[]} selectedIds - module ids the user picked
 * @param {{baseDir: string}} options - baseDir that manifest-relative
 *   paths (files, cssFiles, headerTemplate) are resolved against
 *   (normally the repo root).
 * @returns {string} the assembled userscript source
 */
export function assemble(manifest, selectedIds, { baseDir }) {
    const selectedModules = resolveSelectedModules(manifest, selectedIds);
    const orderedModules = topoSort(selectedModules);

    // Locked (core) modules always emit before optional modules, regardless
    // of where they land in topological order — matches the spec's
    // "each core JS file -> each optional module's JS file" sequencing.
    const lockedOrdered = orderedModules.filter((m) => m.locked);
    const unlockedOrdered = orderedModules.filter((m) => !m.locked);
    const emissionOrder = [...lockedOrdered, ...unlockedOrdered];

    const grants = [...new Set(orderedModules.flatMap((m) => m.grants || []))];
    const connects = [...new Set(orderedModules.flatMap((m) => m.connects || []))];

    const headerTemplateSrc = fs.readFileSync(path.join(baseDir, manifest.headerTemplate), 'utf8');
    const filledHeader = fillHeaderTemplate(headerTemplateSrc, {
        version: manifest.baseVersion,
        grants,
        connects,
    });

    const chunks = [];
    for (const mod of emissionOrder) {
        for (const file of mod.files || []) {
            chunks.push(readNormalized(baseDir, file));
        }
        if (mod.cssFiles && mod.cssFiles.length) {
            const css = mod.cssFiles.map((f) => readNormalized(baseDir, f)).join('\r\n');
            chunks.push(`injectCSS('${mod.id}', \`${escapeCssForTemplateLiteral(css)}\`);\r\n`);
        }
    }

    return filledHeader + '\r\n(function () {\r\n    \'use strict\';\r\n\r\n' + chunks.join('') + '\r\n})();\r\n';
}
