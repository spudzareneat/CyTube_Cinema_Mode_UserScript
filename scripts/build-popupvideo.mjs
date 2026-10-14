// scripts/build-popupvideo.mjs
//
// Builds cytube.popupvideo.user.js -- the standalone Pop-up Video userscript --
// from the same source files as the main script, via scripts/assemble.mjs.
//   node scripts/build-popupvideo.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemble } from './assemble.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

export const POPUPVIDEO_VERSION = '1.2.0';

export const POPUPVIDEO_MANIFEST = {
    headerTemplate: 'src/popupvideo/header.template.js',
    baseVersion: POPUPVIDEO_VERSION,
    modules: [
        { id: 'pv-shim', locked: true, files: ['src/popupvideo/shim.js'], grants: ['GM_xmlhttpRequest'], connects: ['caching.graphql.imdb.com', 'raw.githubusercontent.com'] },
        { id: 'pv-identity', locked: true, dependsOn: ['pv-shim'], files: ['src/pc/core/01-movie-identity.js', 'src/pc/shared/player-helpers.js'] },
        { id: 'pv-imdb', dependsOn: ['pv-identity'], files: ['src/pc/shared/imdb-resolve.js', 'src/pc/shared/imdb-trivia-fetch.js'] },
        { id: 'pv-popup', dependsOn: ['pv-imdb'], files: ['src/pc/modules/trivia-popup/index.js'], cssFiles: ['src/pc/modules/trivia-popup/style.css'] },
        { id: 'pv-watcher', dependsOn: ['pv-popup'], files: ['src/popupvideo/watcher.js'], cssFiles: ['src/popupvideo/style.css'] },
    ],
};

export function buildPopupVideo() {
    return assemble(POPUPVIDEO_MANIFEST, POPUPVIDEO_MANIFEST.modules.map(m => m.id), { baseDir: repoRoot });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const out = path.join(repoRoot, 'cytube.popupvideo.user.js');
    fs.writeFileSync(out, buildPopupVideo());
    console.log(`Wrote ${out} (v${POPUPVIDEO_VERSION})`);
}
