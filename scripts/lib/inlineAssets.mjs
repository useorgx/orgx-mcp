/**
 * inlineAssets.mjs — minified copies of the shared files that MCP Apps
 * resources inline.
 *
 * The worker inlines every shared script and stylesheet a widget references
 * (MCP_APPS_SHARED_COMPONENT_PATHS, plus interaction-kit.css/js) into the
 * resource document, so their comments and whitespace were paid on every
 * widget render. `pnpm widget:build` now writes a minified copy of each to
 * public/widgets/inline/<path> and the worker inlines that copy; the source
 * under public/widgets/shared/ stays readable and is what standalone previews
 * and the gallery load.
 *
 * Minifier: esbuild, already installed through the direct `vite`
 * devDependency (no new dependency). Classic-script transform, so top-level
 * names (the globals other scripts read) are kept; output is deterministic for
 * a given esbuild version, so the manifest and widget:version stay stable.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
/** esbuild as vite (a direct devDependency) resolves it. */
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');

/** Where the minified copies live, relative to public/widgets. */
export const INLINE_DIR = 'inline';

/** The extra shared files the worker inlines besides MCP_APPS_SHARED_COMPONENT_PATHS. */
export const INTERACTION_KIT_PATHS = ['shared/interaction-kit.css', 'shared/interaction-kit.js'];

/**
 * Minify one shared file's source by its extension. Files that are already
 * minified (the vendored kit bundles, with their own CSS abbreviations) can
 * come out larger; those pass through unchanged.
 */
export function minifyInlineAsset(path, source) {
  const loader = path.endsWith('.css') ? 'css' : 'js';
  const { code } = esbuild.transformSync(source, {
    loader,
    minify: true,
    legalComments: 'none',
    charset: 'utf8',
    // Widgets run in current ChatGPT / Claude / editor webviews.
    target: loader === 'css' ? ['chrome111', 'safari16.4', 'firefox115'] : 'es2020',
  });
  const minified = code.trimEnd() + '\n';
  return Buffer.byteLength(minified) < Buffer.byteLength(source) ? minified : source;
}

/**
 * Write public/widgets/inline/<path> for every path; returns
 * [{ path, source, minified }] byte counts. Unchanged files are not rewritten.
 */
export function writeInlineAssets(widgetsDir, paths) {
  const results = [];
  for (const path of paths) {
    const sourceFile = join(widgetsDir, path);
    if (!existsSync(sourceFile)) continue;
    const source = readFileSync(sourceFile, 'utf8');
    const minified = minifyInlineAsset(path, source);
    const outFile = join(widgetsDir, INLINE_DIR, path);
    mkdirSync(dirname(outFile), { recursive: true });
    if (!existsSync(outFile) || readFileSync(outFile, 'utf8') !== minified) writeFileSync(outFile, minified);
    results.push({ path, source: Buffer.byteLength(source), minified: Buffer.byteLength(minified) });
  }
  return results;
}
