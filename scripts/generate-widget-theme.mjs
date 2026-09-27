/**
 * generate-widget-theme.mjs
 *
 * Inlines the canonical widget theme into a TS module.
 *
 * The server-generated widgets (src/liveFeedWidget.ts, src/scaffoldWidget.ts)
 * emit self-contained HTML as MCP content blocks, so they cannot reference
 * shared/widget-theme.css the way the static widgets do — the serving layer's
 * asset inlining only runs for widget resources. Each therefore grew its own
 * hand-written copy of the --ox-* tokens, which drifted: the live feed widget
 * had --ox-border at rgba(0,0,0,.08) against the canonical rgba(15,23,42,.1).
 *
 * The Worker has no filesystem at runtime, so the CSS is baked into the bundle
 * here instead. public/widgets/shared/widget-theme.css stays the single source
 * of truth and this file is generated, never edited.
 *
 * Run: pnpm widget:theme (wired into prebuild/predev/pretest)
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = process.cwd();
const sourceFile = resolve(root, 'public/widgets/shared/widget-theme.css');
const outputFile = resolve(root, 'src/generated/widgetThemeCss.ts');

const css = readFileSync(sourceFile, 'utf8');

// Strip comments and collapse whitespace: this ships inside every live-feed
// content block, so the bytes are paid per tool call.
const minified = css
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s*([{}:;,>])\s*/g, '$1')
  .replace(/;\}/g, '}')
  .replace(/\s+/g, ' ')
  .trim();

// Escape for a TS template literal.
const escaped = minified
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${');

const banner = `/**
 * GENERATED FILE — do not edit.
 *
 * Source: public/widgets/shared/widget-theme.css
 * Regenerate: pnpm widget:theme
 *
 * The canonical OrgX widget theme, inlined for the server-generated widgets
 * that ship as self-contained HTML content blocks and so cannot link to the
 * shared stylesheet. See scripts/generate-widget-theme.mjs.
 */`;

mkdirSync(dirname(outputFile), { recursive: true });
writeFileSync(
  outputFile,
  `${banner}\n\nexport const WIDGET_THEME_CSS = \`${escaped}\`;\n`,
  'utf8'
);

console.log(
  `widget theme inlined: ${css.length} -> ${minified.length} bytes -> ${outputFile.replace(root + '/', '')}`
);
