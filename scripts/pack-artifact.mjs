/**
 * pack-artifact.mjs (canonical orgx-mcp)
 *
 * Assembles the publishable mcp-artifact the orgx monorepo consumes instead of
 * vendoring this worker's source:
 *
 *   dist/mcp-artifact/
 *     tool-catalog.json   (from pnpm catalog:generate)
 *     widgets/            (from pnpm widget:build → public/widgets)
 *     VERSION             (git sha + ISO timestamp)
 *
 * Run after `pnpm widget:build && pnpm catalog:generate`. CI uploads
 * dist/mcp-artifact/ as a release asset; the monorepo pulls it via
 * scripts/sync-mcp-artifact.mjs.
 */

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(rootDir, 'dist');
const outDir = path.join(distDir, 'mcp-artifact');

function fail(msg) {
  console.error(`[pack-artifact] ${msg}`);
  process.exit(1);
}

const catalogPath = path.join(distDir, 'tool-catalog.json');
if (!existsSync(catalogPath)) {
  fail('dist/tool-catalog.json missing — run `pnpm catalog:generate` first.');
}
const widgetsSrc = path.join(rootDir, 'public', 'widgets');
if (!existsSync(widgetsSrc)) {
  fail('public/widgets missing — run `pnpm widget:build` first.');
}

// Clean + recreate the bundle dir.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// 1) catalog
cpSync(catalogPath, path.join(outDir, 'tool-catalog.json'));

// 2) widgets bundle
cpSync(widgetsSrc, path.join(outDir, 'widgets'), { recursive: true });

// 3) VERSION stamp
let sha = 'unknown';
try {
  sha = execSync('git rev-parse HEAD', { cwd: rootDir }).toString().trim();
} catch {
  // CI without git context — leave 'unknown'; the consumer pins by release tag.
}
const sourceHash = (() => {
  try {
    return JSON.parse(readFileSync(catalogPath, 'utf-8')).sourceHash ?? null;
  } catch {
    return null;
  }
})();

writeFileSync(
  path.join(outDir, 'VERSION'),
  JSON.stringify(
    { commit: sha, sourceHash, packedAt: new Date().toISOString() },
    null,
    2,
  ) + '\n',
);

console.log(`[pack-artifact] OK — ${outDir} (commit ${sha.slice(0, 12)})`);
