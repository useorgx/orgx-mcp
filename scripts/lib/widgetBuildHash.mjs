/**
 * widgetBuildHash.mjs — the one definition of the widget build version.
 *
 * Both scripts/generate-widget-build-info.mjs and tests/widgetBuildVersion.spec.ts
 * need this hash, and each used to carry its own copy of the walk-and-digest
 * logic. Two copies of a rule that must agree exactly is a drift waiting to
 * happen, so the rule lives here and both import it.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Files under public/widgets that are themselves generated from the others.
 *
 * `_manifest.json` is written from the widgets this hash already walks, so
 * folding it back in would hash the same bytes twice and couple the build
 * version to the manifest's own formatting. Excluding it loses nothing.
 *
 * It used to carry a `generatedAt` timestamp too, which made the version
 * change on every build even when no widget had — `pnpm verify` dirtied the
 * tree and the version test failed until the file was committed again. The
 * timestamp is gone, and the manifest is reproducible on its own.
 */
export const DERIVED_WIDGET_FILES = new Set(['_manifest.json']);

/**
 * Directories under public/widgets that hold derived files. `inline/` is the
 * minified copy of the shared files (scripts/lib/inlineAssets.mjs), a pure
 * function of sources this hash already covers.
 */
export const DERIVED_WIDGET_DIRS = new Set(['inline']);

export function collectWidgetFiles(dir, root = dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name !== '.DS_Store')
    .sort((a, b) => a.name.localeCompare(b.name));

  const files = [];
  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir === root && DERIVED_WIDGET_DIRS.has(entry.name)) continue;
      files.push(...collectWidgetFiles(absolutePath, root));
      continue;
    }
    if (entry.isFile() && !DERIVED_WIDGET_FILES.has(entry.name)) {
      files.push(absolutePath);
    }
  }
  return files;
}

export function computeWidgetBuildVersion(root = process.cwd()) {
  const widgetRoot = resolve(root, 'public/widgets');
  const hash = createHash('sha256');
  for (const filePath of collectWidgetFiles(widgetRoot)) {
    hash.update(relative(root, filePath));
    hash.update('\0');
    hash.update(readFileSync(filePath));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}
