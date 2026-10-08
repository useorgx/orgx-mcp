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
 *   2. Shared-layer + protocol adherence — shared refs must be allowlisted,
 *      and widgets using shared/utils.js must load the official MCP Apps SDK.
 *   3. No reintroduced forks — any widget whose filename ends in
 *      `-stream.html` fails the build (they were collapsed into the
 *      main widgets via ?live=true data-source flags).
 *   4. Design-kit bundles — a widget that uses <ox-*> elements loads either
 *      shared/kit/ox-elements.js (all) or ox-elements-core.js followed by
 *      only the add-ons (footer / glyph / avatar) it uses. A missing or
 *      out-of-order bundle, or an add-on nothing uses, fails the build; a
 *      choice that is not the smallest one prints a warning.
 *
 * Payload size: every widget's inlined MCP Apps document has a byte budget
 * (scripts/widget-payload-budgets.json), enforced by
 * tests/widgetPayloadBudget.spec.ts and `pnpm widget:payload`.
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
import { createRequire } from 'node:module';

import { INLINE_DIR, INTERACTION_KIT_PATHS, writeInlineAssets } from './lib/inlineAssets.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const WIDGETS_DIR = join(REPO_ROOT, 'public', 'widgets');
const MANIFEST_PATH = join(WIDGETS_DIR, '_manifest.json');

// The browser and tests use the same typed ruling transitions.
const localRequire = createRequire(import.meta.url);
const esbuild = createRequire(localRequire.resolve('vite/package.json'))('esbuild');
esbuild.buildSync({ entryPoints: [join(REPO_ROOT, 'src/panelInteractionState.ts')],
  outfile: join(WIDGETS_DIR, 'shared/panel-interaction-state.js'), bundle: true,
  format: 'iife', globalName: 'OrgXPanelState', target: 'es2020' });

// ── Contract 1: canonical primary palette ─────────────────────────
// Must mirror the allowlist in tests/widgetPrimaryPalette.spec.ts.
// The build is the source of truth; the test now consumes the manifest.
const CANONICAL_PRIMARIES = {
  'agent-status': '191,255,0',
  'initiative-pulse': '0,201,167',
  'scaffolded-initiative': '99,102,241',
  'scaffold-streaming': '99,102,241',
  'task-spawned': '99,102,241',
  // Attention widgets: amber is only "needs you"; accent and primaries are lime.
  decisions: '191,255,0',
  'artifact-review': '191,255,0',
  'morning-brief': '0,201,167',
  'search-results': '0,201,167',
  'plan-session-live': '99,102,241',
  'entity-card': '0,201,167',
  'work-ledger': '0,201,167',
  index: '17,24,39',
  'workspace-map': '191,255,0',
  'orgx-panel': '191,255,0',
  'proof-receipt': '0,201,167',
};

// Widgets that are demo-only (gallery / preview) and therefore exempt
// from "bound-to-a-tool" checks but still must pass palette + shared-layer
// contracts. Streaming demos converge on the main widgets via ?live=true.
const DEMO_ONLY_WIDGETS = new Set([
  'index',
  'scaffold-streaming',
]);

// ── Contract 2: shared-layer allowlist ───────────────────────────
// Must match MCP_APPS_SHARED_COMPONENT_PATHS in src/widgetConfig.ts.
const SHARED_ALLOWLIST = new Set([
  'shared/kit/ox-tokens.css',
  'shared/kit/ox-elements.js',
  'shared/kit/ox-elements-core.js',
  'shared/kit/ox-elements-footer.js',
  'shared/kit/ox-elements-glyph.js',
  'shared/kit/ox-elements-avatar.js',
  'shared/agent-identity.js',
  'shared/tokens.css',
  'shared/widget-theme.css',
  'shared/widget-foundation.css',
  'shared/interaction-kit.css',
  'shared/interaction-kit.js',
  'shared/components.css',
  'shared/components/domain-accent.css',
  'shared/components/domain-accent.js',
  'shared/components/liveness-indicator.js',
  'shared/widget-state.js',
  'shared/live-machine.js',
  'shared/live-store.js',
  'shared/live-panel.js',
  'shared/utils.js',
  'shared/orgx-icons.js',
  'shared/mcp-apps-sdk.umd.js',
  'shared/widget-runtime.js',
  'shared/openai-extensions.js',
  'shared/panel-interaction-state.js',
  'shared/expectations.css',
  'shared/expectations.js',
  'shared/panel/panel.css',
  'shared/panel/panel-brand.js',
  'shared/panel/panel-launch.js',
  'shared/panel/panel-tour.js',
  'shared/panel/panel-views.js',
  'shared/panel/panel-live.js',
  'shared/panel/panel-start.js',
  'shared/panel/panel-receipts.js',
  'shared/panel/panel-app.js',
  'shared/demo-data.js',
]);

// Mirrors src/widgetConfig.ts MCP_APPS_SHARED_COMPONENT_PATHS. The build
// will fail if these drift — every runtime-inlined path must be on the
// allowlist (otherwise the server is inlining a module the widgets aren't
// allowed to import), and shared tokens/components that are inlined must
// be referenced by at least one widget somewhere.
const RUNTIME_INLINED_PATHS = new Set([
  'shared/kit/ox-tokens.css',
  'shared/kit/ox-elements.js',
  'shared/kit/ox-elements-core.js',
  'shared/kit/ox-elements-footer.js',
  'shared/kit/ox-elements-glyph.js',
  'shared/kit/ox-elements-avatar.js',
  'shared/agent-identity.js',
  'shared/tokens.css',
  'shared/widget-theme.css',
  'shared/components/domain-accent.css',
  'shared/components/domain-accent.js',
  'shared/components/liveness-indicator.js',
  'shared/widget-state.js',
  'shared/live-machine.js',
  'shared/live-store.js',
  'shared/live-panel.js',
  'shared/orgx-icons.js',
  'shared/mcp-apps-sdk.umd.js',
  'shared/widget-runtime.js',
  'shared/openai-extensions.js',
  'shared/panel-interaction-state.js',
  'shared/expectations.css',
  'shared/expectations.js',
  'shared/panel/panel.css',
  'shared/panel/panel-brand.js',
  'shared/panel/panel-launch.js',
  'shared/panel/panel-tour.js',
  'shared/panel/panel-views.js',
  'shared/panel/panel-live.js',
  'shared/panel/panel-start.js',
  'shared/panel/panel-receipts.js',
  'shared/panel/panel-app.js',
]);

// ── Contract 4: design-kit bundles ───────────────────────────────
// What each vendored kit bundle defines (see scripts/sync-ui-kit.mjs and the
// kit README). The add-ons reuse the core runtime, so core loads first.
const KIT_FULL = 'shared/kit/ox-elements.js';
const KIT_CORE = 'shared/kit/ox-elements-core.js';
const KIT_CORE_ELEMENTS = ['ox-state-chip', 'ox-attention-line', 'ox-receipt-row'];
const KIT_ADDONS = {
  'ox-footer': 'shared/kit/ox-elements-footer.js',
  'ox-glyph': 'shared/kit/ox-elements-glyph.js',
  'ox-avatar': 'shared/kit/ox-elements-avatar.js',
};
const KIT_ELEMENTS = [...KIT_CORE_ELEMENTS, ...Object.keys(KIT_ADDONS)];

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


function usesSharedUtils(html) {
  return /(?:from\s*['"][^'"]*shared\/utils\.js|<script\b[^>]*\bsrc=['"][^'"]*shared\/utils\.js)/i.test(
    html
  );
}

function detectProtocolBridge(html, refs) {
  if (
    refs.includes('shared/mcp-apps-sdk.umd.js') &&
    refs.includes('shared/widget-runtime.js')
  ) return 'official-sdk';
  if (refs.includes('shared/mcp-apps-sdk.umd.js')) return 'sdk-without-runtime';
  if (refs.includes('shared/widget-runtime.js')) return 'runtime-without-sdk';
  if (usesSharedUtils(html)) return 'shared-utils-without-sdk';
  if (/window\.openai|window\.parent\.postMessage|ui\/open-link/i.test(html)) {
    return 'legacy-inline';
  }
  return 'standalone';
}

/**
 * Kit elements the widget renders: `<ox-x` markup (HTML or JS strings) or
 * createElement('ox-x'). The avatar add-on also defines <ox-agent-card>, and
 * the shared identity helpers (OrgXAgentIdentity.avatar / .agentCard, see
 * shared/agent-identity.js) render both, so either counts as <ox-avatar>.
 */
const AVATAR_HELPERS = /<ox-agent-card\b|\b(?:OrgXAgentIdentity|identity)\.(?:avatar|agentCard)\(/;
function usedKitElements(html) {
  return KIT_ELEMENTS.filter(
    (el) =>
      new RegExp(`<${el}\\b|createElement\\(\\s*['"\`]${el}['"\`]`).test(html) ||
      (el === 'ox-avatar' && AVATAR_HELPERS.test(html))
  );
}

/** shared/kit/ox-elements*.js script tags, in document order. */
function kitScripts(html) {
  return [...html.matchAll(/<script\b[^>]*\bsrc=("|')([^"']*shared\/kit\/ox-elements[^"']*)\1/gi)].map((m) =>
    m[2].split(/[?#]/)[0].replace(/^(?:\.\/)+/, '')
  );
}

const kitBytes = (paths) => paths.reduce((n, p) => n + statSync(join(WIDGETS_DIR, p)).size, 0);

/** The smallest set of kit bundles that defines `used`, in load order. */
function smallestKit(used) {
  if (!used.length) return [];
  const split = [KIT_CORE, ...used.filter((el) => KIT_ADDONS[el]).map((el) => KIT_ADDONS[el])];
  return kitBytes(split) < kitBytes([KIT_FULL]) ? split : [KIT_FULL];
}

/**
 * A widget's own modules (shared/panel/*.js) render markup too, so the kit
 * check reads them along with the HTML.
 */
function widgetModuleSource(sharedRefs) {
  return sharedRefs
    .filter((ref) => ref.startsWith('shared/panel/') && ref.endsWith('.js'))
    .map((ref) => readFileSync(join(WIDGETS_DIR, ref), 'utf8'))
    .join('\n');
}

function validateKitBundles(widgetName, html, errors, warnings, moduleSource = '') {
  const used = usedKitElements(html + '\n' + moduleSource);
  const scripts = kitScripts(html);
  const fix = () => `Load: ${smallestKit(used).map((p) => `<script src="${p}"></script>`).join(' ') || 'nothing from shared/kit/ox-elements*'}`;
  if (!used.length) {
    if (scripts.length) errors.push(`[${widgetName}] loads ${scripts.join(', ')} but renders no <ox-*> element. Drop the script.`);
    return { used, scripts };
  }
  if (scripts.includes(KIT_FULL)) {
    if (scripts.length > 1) errors.push(`[${widgetName}] loads ox-elements.js and split kit bundles; pick one. ${fix()}`);
  } else {
    const core = scripts.indexOf(KIT_CORE);
    if (core === -1) {
      errors.push(`[${widgetName}] renders ${used.join(', ')} but loads no ox-elements.js or ox-elements-core.js. ${fix()}`);
    } else if (scripts.slice(0, core).length) {
      errors.push(`[${widgetName}] loads ${scripts.slice(0, core).join(', ')} before ox-elements-core.js; the add-ons need core first.`);
    }
    for (const el of used) {
      if (KIT_ADDONS[el] && !scripts.includes(KIT_ADDONS[el])) {
        errors.push(`[${widgetName}] renders <${el}> but does not load ${KIT_ADDONS[el]}. ${fix()}`);
      }
    }
    for (const [el, path] of Object.entries(KIT_ADDONS)) {
      if (scripts.includes(path) && !used.includes(el)) {
        errors.push(`[${widgetName}] loads ${path} but renders no <${el}>. Drop the script.`);
      }
    }
  }
  const best = smallestKit(used);
  if (kitBytes(scripts) > kitBytes(best)) {
    warnings.push(
      `[${widgetName}] kit bundles cost ${kitBytes(scripts)} B; ${best.join(' + ')} defines ${used.join(', ')} in ${kitBytes(best)} B. ${fix()}`
    );
  }
  return { used, scripts };
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


function validateProtocolBridge(widgetName, html, refs, errors) {
  const usesOfficialRuntime = refs.includes('shared/widget-runtime.js');
  const loadsOfficialSdk = refs.includes('shared/mcp-apps-sdk.umd.js');
  if (usesSharedUtils(html) && (!loadsOfficialSdk || !usesOfficialRuntime)) {
    errors.push(
      `[${widgetName}] imports shared/utils.js without the complete official widget runtime.\n` +
        `         Load shared/mcp-apps-sdk.umd.js and shared/widget-runtime.js before\n` +
        `         the widget module so host actions share one MCP Apps contract.`
    );
  }
  if (usesOfficialRuntime !== loadsOfficialSdk) {
    errors.push(
      `[${widgetName}] must load shared/mcp-apps-sdk.umd.js and shared/widget-runtime.js together.`
    );
  }
  if (
    usesOfficialRuntime &&
    /window\.parent\.postMessage|window\.openai\.(?:callTool|openExternal)/.test(html)
  ) {
    errors.push(
      `[${widgetName}] bypasses shared/widget-runtime.js with a direct host bridge call.\n` +
        `         Route tools, links, context, and sizing through OrgXWidgetRuntime.`
    );
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
  const warnings = [];
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
    validateProtocolBridge(widgetName, html, sharedRefs, errors);
    const kit = validateKitBundles(widgetName, html, errors, warnings, widgetModuleSource(sharedRefs));

    entries[widgetName] = {
      file: relative(REPO_ROOT, full),
      bytes: html.length,
      hash: sha256(html),
      primaryRgb: rgb,
      sharedRefs,
      protocolBridge: detectProtocolBridge(html, sharedRefs),
      kitElements: kit.used,
      kitBundles: kit.scripts,
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

  for (const warning of warnings) console.warn('  ! ' + warning);

  if (errors.length > 0) {
    console.error('widget build FAILED:\n');
    for (const err of errors) console.error('  ✗ ' + err);
    console.error(`\n${errors.length} error(s).`);
    process.exit(1);
  }

  // No build timestamp. It was the only part of this file that changed when
  // nothing else did, which left the tree dirty after any build and made the
  // manifest easy to sweep into an unrelated commit. Every other field is
  // derived from the widgets themselves, so the manifest is now reproducible.
  const manifest = {
    version: 2,
    allowlist: [...SHARED_ALLOWLIST].sort(),
    canonicalPrimaries: CANONICAL_PRIMARIES,
    widgets: entries,
  };

  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');

  // Minified copies of every shared file the worker inlines (see
  // scripts/lib/inlineAssets.mjs); the readable sources stay as they are.
  const inlined = writeInlineAssets(WIDGETS_DIR, [...RUNTIME_INLINED_PATHS, ...INTERACTION_KIT_PATHS]);
  const before = inlined.reduce((n, f) => n + f.source, 0);
  const after = inlined.reduce((n, f) => n + f.minified, 0);
  console.log(
    `✓ inlined assets minified — ${inlined.length} files, ${(before / 1024).toFixed(1)} KB -> ${(after / 1024).toFixed(1)} KB in ${relative(REPO_ROOT, join(WIDGETS_DIR, INLINE_DIR))}/`
  );

  const summary = Object.keys(entries).length + ' widgets';
  console.log(
    `✓ widget build OK — ${summary}, manifest at ${relative(REPO_ROOT, MANIFEST_PATH)}`
  );
}

main();
