#!/usr/bin/env node
/**
 * Build a fresh scaffold widget from current source, populate it with demo
 * workstreams, and capture a settled high-res screenshot for visual parity.
 *
 * Outputs:
 *   public/widgets-3d/scaffold_widget_html.png         (dark, settled)
 *   public/widgets-3d/scaffold_widget_html_light.png   (light, settled)
 *   public/widgets-3d/scaffold-fresh.html              (the rebuilt source)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(process.cwd());
const outDir = join(root, 'public', 'widgets-3d');
mkdirSync(outDir, { recursive: true });

const { buildScaffoldWidget } = await import(join(root, 'src/scaffoldWidget.ts'));

const html = buildScaffoldWidget({
  sessionId: 'demo',
  streamBaseUrl: 'http://localhost:9099',
  initiativeTitle: 'OrgX Production Launch',
  liveUrl: 'https://useorgx.com/live/demo',
});

const htmlPath = join(outDir, 'scaffold-fresh.html');
writeFileSync(htmlPath, html);
console.log('✓ wrote', htmlPath);

// Demo data — closely mirror what scaffoldWidget.ts demo loop emits, so the
// 3D port matches the same contents.
const DEMO_EVENTS = [
  { type: 'entity.created', entityType: 'workstream', entity: { title: 'SSE Infrastructure', domain: 'engineering' } },
  { type: 'entity.created', entityType: 'milestone',  entity: { title: 'LiveFeedDO shipped' } },
  { type: 'entity.created', entityType: 'milestone',  entity: { title: 'Stream coalescing + replay' } },
  { type: 'entity.created', entityType: 'workstream', entity: { title: 'Widget Polish', domain: 'design' } },
  { type: 'entity.created', entityType: 'milestone',  entity: { title: 'Production visual parity' } },
  { type: 'entity.created', entityType: 'milestone',  entity: { title: 'Domain-colored card accents' } },
  { type: 'entity.created', entityType: 'workstream', entity: { title: 'Go-to-Market', domain: 'marketing' } },
  { type: 'entity.created', entityType: 'milestone',  entity: { title: 'Product Hunt launch' } },
  { type: 'entity.created', entityType: 'milestone',  entity: { title: 'Demo video + landing page' } },
];

const browser = await chromium.launch();

for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({
    colorScheme: theme,
    viewport: { width: 720, height: 1500 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  // Use ?demo=true so the widget's built-in demo loop fires and populates the
  // panel with sample workstreams without needing an SSE server.
  await page.goto(`http://localhost:9099/widgets-3d/scaffold-fresh.html?demo=true`, { waitUntil: 'load' });
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);

  // Demo loop runs ~10s. Wait for it to reach the complete state.
  await page.waitForTimeout(11000);

  const shell = page.locator('.shell').first();
  const out = join(outDir, theme === 'dark' ? 'scaffold_widget_html.png' : 'scaffold_widget_html_light.png');
  await shell.screenshot({ path: out });
  console.log(`✓ ${theme} → ${out}`);
  await ctx.close();
}

await browser.close();
