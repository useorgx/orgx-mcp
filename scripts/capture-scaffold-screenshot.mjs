#!/usr/bin/env node
/**
 * Capture a settled screenshot of the scaffold streaming widget for visual
 * comparison against the 3D Blender port.
 *
 * Usage:
 *   node scripts/capture-scaffold-screenshot.mjs
 *
 * Outputs:
 *   public/widgets-3d/scaffold_widget_html.png   (dark mode, settled widget)
 *   public/widgets-3d/scaffold_widget_html_light.png
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.cwd());
const outDir = join(root, 'public', 'widgets-3d');
mkdirSync(outDir, { recursive: true });

const URL = 'http://localhost:9099/widgets/scaffold-streaming.html';
const SHOTS = [
  { theme: 'dark',  out: join(outDir, 'scaffold_widget_html.png') },
  { theme: 'light', out: join(outDir, 'scaffold_widget_html_light.png') },
];

const browser = await chromium.launch();
for (const shot of SHOTS) {
  const ctx = await browser.newContext({
    colorScheme: shot.theme,
    viewport: { width: 720, height: 1400 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'load' });
  // Force theme attribute for explicit control even if media query is wrong
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), shot.theme);
  // Wait for skeleton to clear / cards to render. Demo mode populates after EventSource fails.
  await page.waitForTimeout(8000);
  // Snap the .shell element to crop tightly
  const shell = await page.locator('.shell').first();
  await shell.screenshot({ path: shot.out, omitBackground: false });
  console.log(`✓ ${shot.theme} → ${shot.out}`);
  await ctx.close();
}
await browser.close();
