/**
 * Per-widget payload size budget.
 *
 * Measures what each widget actually costs a host: the MCP Apps resource
 * document after the serving pipeline (src/index.ts resources/read) has
 * rewritten asset URLs and inlined interaction-kit plus every referenced
 * MCP_APPS_SHARED_COMPONENT_PATHS module. That is the HTML Claude, Cursor and
 * other MCP Apps hosts receive, so it is the number that has to stay small.
 *
 * Budgets live in scripts/widget-payload-budgets.json (bytes of inlined HTML,
 * UTF-8). tests/widgetPayloadBudget.spec.ts fails when a widget is over its
 * budget or has none.
 *
 *   pnpm widget:payload            print the table, exit 1 if over budget
 *   pnpm widget:payload --update   rewrite the budgets from today's sizes
 *                                  (+ HEADROOM). Do this on purpose, in the
 *                                  change that grows a widget, and say why.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  MCP_APPS_SHARED_COMPONENT_PATHS,
  rewriteWidgetHtmlAssetUrls,
  sanitizeMcpAppsHtml,
  mcpAppsInlineAssetPath,
} from '../src/widgetConfig';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WIDGETS_DIR = resolve(ROOT, 'public/widgets');
export const BUDGETS_PATH = resolve(ROOT, 'scripts/widget-payload-budgets.json');
/** Production widget base: what the server rewrites relative URLs against. */
const WIDGET_BASE_URL = 'https://mcp.useorgx.com/widgets/';
/** Budget = today's size + this, rounded up to the next KiB. */
export const HEADROOM = 8 * 1024;
export const SDK_PATH = 'shared/mcp-apps-sdk.umd.js';

export interface WidgetPayload {
  /** Bytes of the inlined resource document (UTF-8). */
  bytes: number;
  /** Bytes of the widget's own HTML file. */
  htmlBytes: number;
  /** Inlined OrgX design kit (shared/kit/*). */
  kitBytes: number;
  /** Inlined MCP Apps SDK (shared/mcp-apps-sdk.umd.js). */
  sdkBytes: number;
  /** Shared modules inlined into this widget, in MCP_APPS_SHARED_COMPONENT_PATHS order. */
  inlined: string[];
}

export interface PayloadBudgets {
  about?: string;
  /** Max bytes of inlined resource HTML per widget. */
  widgets: Record<string, number>;
}

const ABOUT =
  'Max bytes of each widget\'s inlined MCP Apps resource (UTF-8), measured by scripts/widget-payload-sizes.ts and enforced by tests/widgetPayloadBudget.spec.ts. ' +
  'Set from measured sizes + 8 KiB headroom, rounded up to a KiB. Raise one only on purpose (pnpm widget:payload --update) in the change that grows the widget.';

const byteLength = (s: string) => Buffer.byteLength(s, 'utf8');
// What the worker inlines: the minified copy widget:build writes (inline/<path>).
const readShared = (path: string) => readFileSync(resolve(WIDGETS_DIR, mcpAppsInlineAssetPath(path)), 'utf8');

/** The widgets the build ships, from public/widgets/_manifest.json. */
export function manifestWidgets(): Record<string, { file: string }> {
  return JSON.parse(readFileSync(resolve(WIDGETS_DIR, '_manifest.json'), 'utf8')).widgets;
}

/**
 * The MCP Apps resource document for one widget, built the way
 * src/index.ts serves it (asset fetches replaced by local reads).
 */
export function inlineWidgetHtml(source: string, baseUrl = WIDGET_BASE_URL): { html: string; inlined: string[] } {
  const html = rewriteWidgetHtmlAssetUrls(source, baseUrl);
  const sharedComponents: Record<string, string | null> = {};
  for (const path of MCP_APPS_SHARED_COMPONENT_PATHS) {
    if (html.includes(path)) sharedComponents[path] = readShared(path);
  }
  const out = sanitizeMcpAppsHtml(html, {
    interactionKitCss: html.includes('interaction-kit.css') ? readShared('shared/interaction-kit.css') : null,
    interactionKitJs: html.includes('interaction-kit.js') ? readShared('shared/interaction-kit.js') : null,
    sharedComponents,
  });
  const inlined = Object.keys(sharedComponents).filter((p) => out.includes(`data-inline-asset="${p}"`));
  return { html: out, inlined };
}

export function measureWidgetPayloads(): Record<string, WidgetPayload> {
  const out: Record<string, WidgetPayload> = {};
  for (const [name, { file }] of Object.entries(manifestWidgets())) {
    const source = readFileSync(resolve(ROOT, file), 'utf8');
    const { html, inlined } = inlineWidgetHtml(source);
    const sum = (paths: string[]) => paths.reduce((n, p) => n + byteLength(readShared(p)), 0);
    out[name] = {
      bytes: byteLength(html),
      htmlBytes: byteLength(source),
      kitBytes: sum(inlined.filter((p) => p.startsWith('shared/kit/'))),
      sdkBytes: sum(inlined.filter((p) => p === SDK_PATH)),
      inlined,
    };
  }
  return out;
}

export function readBudgets(): PayloadBudgets {
  return JSON.parse(readFileSync(BUDGETS_PATH, 'utf8'));
}

const kib = (n: number) => `${(n / 1024).toFixed(1)} KB`;

/** One line per problem; empty when every widget is within its budget. */
export function checkWidgetPayloadBudgets(
  measured: Record<string, WidgetPayload>,
  budgets: PayloadBudgets,
): string[] {
  const errors: string[] = [];
  for (const [name, p] of Object.entries(measured)) {
    const budget = budgets.widgets[name];
    if (budget === undefined) {
      errors.push(
        `${name}: no payload budget. It inlines to ${p.bytes} B (${kib(p.bytes)}); add "${name}": ${budgetFor(p.bytes)} to scripts/widget-payload-budgets.json.`,
      );
    } else if (p.bytes > budget) {
      errors.push(
        `${name}: inlined MCP Apps payload is ${p.bytes} B (${kib(p.bytes)}), over its ${budget} B (${kib(budget)}) budget by ${p.bytes - budget} B. ` +
          `Inlined: ${p.inlined.join(', ')}. Load only the kit bundles the widget uses (shared/kit/ox-elements-*.js), ` +
          `or raise the budget on purpose in scripts/widget-payload-budgets.json (pnpm widget:payload --update).`,
      );
    }
  }
  for (const name of Object.keys(budgets.widgets)) {
    if (!(name in measured)) errors.push(`${name}: has a payload budget but no widget; remove it from scripts/widget-payload-budgets.json.`);
  }
  return errors;
}

export const budgetFor = (bytes: number) => Math.ceil((bytes + HEADROOM) / 1024) * 1024;

function main() {
  const measured = measureWidgetPayloads();
  if (process.argv.includes('--update')) {
    const widgets = Object.fromEntries(Object.entries(measured).map(([n, p]) => [n, budgetFor(p.bytes)]));
    writeFileSync(BUDGETS_PATH, `${JSON.stringify({ about: ABOUT, widgets }, null, 2)}\n`);
    console.log(`wrote ${Object.keys(widgets).length} budgets to scripts/widget-payload-budgets.json`);
  }
  let budgets: PayloadBudgets = { widgets: {} };
  try {
    budgets = readBudgets();
  } catch {
    /* first run */
  }
  const rows = Object.entries(measured).map(([name, p]) => [
    name,
    kib(p.bytes),
    budgets.widgets[name] ? kib(budgets.widgets[name]) : '-',
    kib(p.htmlBytes),
    kib(p.kitBytes),
    kib(p.sdkBytes),
    kib(p.bytes - p.sdkBytes),
    p.inlined
      .filter((x) => x.startsWith('shared/kit/ox-elements'))
      .map((x) => x.replace(/^shared\/kit\/ox-elements-?|\.js$/g, '') || 'all')
      .join(' ') || '-',
  ]);
  const head = ['widget', 'inlined', 'budget', 'html', 'kit', 'sdk', 'w/o sdk', 'kit bundles'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  for (const r of [head, ...rows]) console.log(r.map((c, i) => (i ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join('  '));
  const errors = checkWidgetPayloadBudgets(measured, budgets);
  for (const e of errors) console.error(`✗ ${e}`);
  if (errors.length) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
