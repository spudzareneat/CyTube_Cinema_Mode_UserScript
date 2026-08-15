// scripts/build-dev-bundle.mjs
//
// Local dev helper: builds a full-featured (every module selected) bundle
// from src/pc/manifest.json and writes it to cytube.pc.dev.user.js at the
// repo root, so a maintainer can `node scripts/build-dev-bundle.mjs` and
// paste the result straight into Tampermonkey without needing the
// (not-yet-built) customizer web page.
//
// Dependency-free — plain Node fs/path only. Run with:
//   node scripts/build-dev-bundle.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemble } from './assemble.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

const manifestPath = path.join(repoRoot, 'src/pc/manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const selectedIds = manifest.modules.map((m) => m.id);

const bundle = assemble(manifest, selectedIds, { baseDir: repoRoot });

const outPath = path.join(repoRoot, 'cytube.pc.dev.user.js');
fs.writeFileSync(outPath, bundle);

console.log(`Wrote ${outPath} (${selectedIds.length} module${selectedIds.length === 1 ? '' : 's'}: ${selectedIds.join(', ')})`);
