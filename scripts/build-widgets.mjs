#!/usr/bin/env node
/**
 * build-widgets.mjs
 *
 * Widget build pipeline — Stage A of the widget design system.
 *
 * Walks every HTML file in public/widgets/, validates it against three
 * contracts, and emits a manifest that downstream consumers (serving
 * pipeline, parity tests, design-system dashboard) can trust as the
 * single source of truth:
 *
 *   1. Palette parity — widget's base :root --ox-primary-rgb must match
 *      the canonical per-widget palette.
 *   2. Shared-layer adherence — every <link>/<script src> ref into
 *      shared/components/ must point to a module on the inlining
 *      allowlist (MCP_APPS_SHARED_COMPONENT_PATHS).
 *   3. No reintroduced forks — any widget whose filename ends in
 *      `-stream.html` fails the build (they were collapsed into the
 *      main widgets via ?live=true data-source flags).
 *
 * The manifest is written to public/widgets/_manifest.json and is the
 * output artifact the runtime serving layer will read in Stage C.
 *
 * Run: pnpm build:widgets
 *      npm run build:widgets
 *
 * Exits non-zero on any validation failure so it can gate CI + precommit.
 */

import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const WIDGETS_DIR = join(REPO_ROOT, 'public', 'widgets');
const MANIFEST_PATH = join(WIDGETS_DIR, '_manifest.json');

// ── Contract 1: canonical primary palette ─────────────────────────
// Must mirror the allowlist in tests/widgetPrimaryPalette.spec.ts.
// The build is the source of truth; the test now consumes the manifest.
const CANONICAL_PRIMARIES = {
  'agent-status': '191,255,0',
  'initiative-pulse': '0,201,167',
  'scaffolded-initiative': '99,102,241',
  'scaffold-streaming': '99,102,241',
  'task-spawned': '99,102,241',
  decisions: '251,191,36',
  'artifact-review': '251,191,36',
  'morning-brief': '0,201,167',
  'search-results': '0,201,167',
  'plan-session-live': '99,102,241',
  'daily-brief': '99,102,241',
  index: '17,24,39',
};

// Widgets that are demo-only (gallery / preview) and therefore exempt
// from "bound-to-a-tool" checks but still must pass palette + shared-layer
// contracts. Streaming demos converge on the main widgets via ?live=true.
const DEMO_ONLY_WIDGETS = new Set(['index', 'scaffold-streaming']);

// ── Contract 2: shared-layer allowlist ───────────────────────────
// Must match MCP_APPS_SHARED_COMPONENT_PATHS in src/widgetConfig.ts.
const SHARED_ALLOWLIST = new Set([
  'shared/tokens.css',
  'shared/widget-foundation.css',
  'shared/interaction-kit.css',
  'shared/interaction-kit.js',
  'shared/components.css',
  'shared/components/domain-accent.css',
  'shared/components/domain-accent.js',
  'shared/components/liveness-indicator.js',
  'shared/utils.js',
  'shared/icons.js',
  'shared/mcp-apps-sdk.umd.js',
  'shared/demo-data.js',
]);

// Mirrors src/widgetConfig.ts MCP_APPS_SHARED_COMPONENT_PATHS. The build
// will fail if these drift — every runtime-inlined path must be on the
// allowlist (otherwise the server is inlining a module the widgets aren't
// allowed to import), and shared tokens/components that are inlined must
// be referenced by at least one widget somewhere.
const RUNTIME_INLINED_PATHS = new Set([
  'shared/tokens.css',
  'shared/components/domain-accent.css',
  'shared/components/domain-accent.js',
  'shared/components/liveness-indicator.js',
]);

// ── Parse helpers ─────────────────────────────────────────────────

function normalizeRgb(raw) {
  return raw.replace(/\s+/g, '');
}

function extractPrimaryRgb(html) {
  const styleBlocks = html.match(/<style[^>]*>[\s\S]*?<\/style>/gi) ?? [];
  const combined = styleBlocks.join('\n');
  const match = combined.match(/--ox-primary-rgb\s*:\s*([0-9,\s]+)\s*;/);
  return match ? normalizeRgb(match[1]) : null;
}

function extractSharedRefs(html) {
  // Capture external <link href=...> and <script src=...> refs pointing
  // into shared/ (anything under public/widgets/shared/). We skip data:
  // URIs and absolute URLs to other origins.
  const refs = new Set();
  const patterns = [
    /<link\b[^>]*\bhref=("|')([^"']*shared\/[^"']+)\1/gi,
    /<script\b[^>]*\bsrc=("|')([^"']*shared\/[^"']+)\1/gi,
  ];
  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(html))) {
      const raw = m[2].split(/[?#]/)[0];
      const cleaned = raw.replace(/^(?:\.\/)+/, '');
      if (!cleaned || cleaned.startsWith('http')) continue;
      refs.add(cleaned);
    }
  }
  return [...refs].sort();
}

function sha256(input) {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

// ── Validators ────────────────────────────────────────────────────

function validatePalette(widgetName, rgb, errors) {
  const expected = CANONICAL_PRIMARIES[widgetName];
  if (expected === undefined) {
    errors.push(
      `[${widgetName}] widget is not in CANONICAL_PRIMARIES — add it to scripts/build-widgets.mjs`
    );
    return;
  }
  if (!rgb) {
    errors.push(`[${widgetName}] missing :root --ox-primary-rgb in <style>`);
    return;
  }
  if (rgb !== expected) {
    errors.push(
      `[${widgetName}] --ox-primary-rgb is ${rgb}, expected ${expected}`
    );
  }
}

function validateSharedRefs(widgetName, refs, errors) {
  for (const ref of refs) {
    if (!SHARED_ALLOWLIST.has(ref)) {
      errors.push(
        `[${widgetName}] references shared module not on allowlist: ${ref}\n` +
          `         Add it to SHARED_ALLOWLIST in scripts/build-widgets.mjs AND to\n` +
          `         MCP_APPS_SHARED_COMPONENT_PATHS in src/widgetConfig.ts.`
      );
    }
  }
}

function validateNoStreamForks(widgetName, errors) {
  if (widgetName.endsWith('-stream')) {
    errors.push(
      `[${widgetName}] *-stream.html forks are no longer allowed.\n` +
        `         Merge the streaming behavior into the corresponding main widget\n` +
        `         via a ?live=true data-source flag, then delete this file.`
    );
  }
}

/**
 * `@import url(...)` inside a <style> block does NOT get URL-rewritten by
 * the MCP Apps serving pipeline (the rewriter explicitly skips <style>
 * and <script> bodies). When the widget is served as a ui:// resource to
 * Claude's sandbox, the relative `./shared/...` path fails to resolve,
 * the stylesheet never loads, and the widget renders unstyled.
 *
 * The safe pattern is a top-level `<link rel="stylesheet" href="...">`
 * which DOES get rewritten to an absolute URL. This rule forbids any
 * `@import url()` pointing into `shared/` inside widget HTML.
 */
function validateNoSharedAtImport(widgetName, html, errors) {
  const styleBlocks = html.match(/<style[^>]*>[\s\S]*?<\/style>/gi) ?? [];
  for (const block of styleBlocks) {
    const matches = [...block.matchAll(/@import\s+url\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi)];
    for (const m of matches) {
      const target = m[1];
      if (/\bshared\//.test(target)) {
        errors.push(
          `[${widgetName}] uses @import url('${target}') inside <style> — Claude's widget\n` +
            `         sandbox cannot resolve relative paths in <style> blocks. Replace with\n` +
            `         <link rel="stylesheet" href="${target.replace(/^\.\//, '')}" /> in <head>.`
        );
      }
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────

function listWidgetFiles() {
  return readdirSync(WIDGETS_DIR)
    .filter((name) => name.endsWith('.html'))
    .filter((name) => {
      const full = join(WIDGETS_DIR, name);
      return statSync(full).isFile();
    })
    .sort();
}

function main() {
  const files = listWidgetFiles();
  const errors = [];
  const entries = {};

  for (const file of files) {
    const widgetName = file.replace(/\.html$/, '');
    const full = join(WIDGETS_DIR, file);
    const html = readFileSync(full, 'utf8');

    validateNoStreamForks(widgetName, errors);
    validateNoSharedAtImport(widgetName, html, errors);

    const rgb = extractPrimaryRgb(html);
    validatePalette(widgetName, rgb, errors);

    const sharedRefs = extractSharedRefs(html);
    validateSharedRefs(widgetName, sharedRefs, errors);

    entries[widgetName] = {
      file: relative(REPO_ROOT, full),
      bytes: html.length,
      hash: sha256(html),
      primaryRgb: rgb,
      sharedRefs,
      demoOnly: DEMO_ONLY_WIDGETS.has(widgetName),
    };
  }

  // Ensure every allowlisted widget (from CANONICAL_PRIMARIES) still
  // has a corresponding file. Catches "someone deleted a widget but
  // forgot to remove its entry."
  for (const name of Object.keys(CANONICAL_PRIMARIES)) {
    if (!(name in entries)) {
      errors.push(
        `[${name}] CANONICAL_PRIMARIES has an entry with no matching HTML file`
      );
    }
  }

  // Every runtime-inlined path must be on the shared allowlist AND must
  // appear in at least one widget's sharedRefs — otherwise the server is
  // doing dead inlining work.
  for (const path of RUNTIME_INLINED_PATHS) {
    if (!SHARED_ALLOWLIST.has(path)) {
      errors.push(
        `RUNTIME_INLINED_PATHS has "${path}" but SHARED_ALLOWLIST does not.\n` +
          `         Add it to both (scripts/build-widgets.mjs and src/widgetConfig.ts).`
      );
    }
    const anyReferences = Object.values(entries).some((e) =>
      e.sharedRefs.includes(path)
    );
    if (!anyReferences) {
      errors.push(
        `Runtime-inlined path "${path}" is not referenced by any widget.\n` +
          `         Either remove it from MCP_APPS_SHARED_COMPONENT_PATHS or add a widget <link>/<script>.`
      );
    }
  }

  if (errors.length > 0) {
    console.error('widget build FAILED:\n');
    for (const err of errors) console.error('  ✗ ' + err);
    console.error(`\n${errors.length} error(s).`);
    process.exit(1);
  }

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    allowlist: [...SHARED_ALLOWLIST].sort(),
    canonicalPrimaries: CANONICAL_PRIMARIES,
    widgets: entries,
  };

  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  const summary = Object.keys(entries).length + ' widgets';
  console.log(
    `✓ widget build OK — ${summary}, manifest at ${relative(REPO_ROOT, MANIFEST_PATH)}`
  );
}

main();
