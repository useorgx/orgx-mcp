#!/usr/bin/env node
/**
 * validate.mjs — SSIM + perceptual delta between an HTML widget reference and
 * its 3D Blender port. Generates a side-by-side, a delta heat-map, and a
 * report.json with summary metrics.
 *
 * Usage:
 *   node --import tsx scripts/3d-widgets/validate.mjs --widget=scaffold
 *
 * Outputs (under public/widgets-3d/):
 *   <widget>.diff.png          delta heat-map
 *   <widget>.report.json       { ssim, mae, max_delta, ... }
 *   compare_<widget>_v3.png    side-by-side (HTML | 3D | diff)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';

const ROOT = resolve(process.cwd());

const { values: argv } = parseArgs({
  options: {
    widget: { type: 'string', default: 'scaffold' },
    threshold: { type: 'string', default: '0.95' },
  },
});

const W = argv.widget;
const HTML_PATH = join(ROOT, 'public', 'widgets-3d', WIDGET_HTML_NAMES[W] || `${W}_html.png`);
const B3D_PATH  = join(ROOT, 'public', 'widgets-3d', WIDGET_3D_NAMES[W] || `${W}.png`);
const DIFF_PATH = join(ROOT, 'public', 'widgets-3d', `${W}.diff.png`);
const COMP_PATH = join(ROOT, 'public', 'widgets-3d', `compare_${W}_v3.png`);
const REPORT    = join(ROOT, 'public', 'widgets-3d', `${W}.report.json`);

// Different widgets emit slightly different filename conventions.
function WIDGET_HTML_NAMES() {}
WIDGET_HTML_NAMES.scaffold = 'scaffold_widget_html.png';
WIDGET_HTML_NAMES['agent-status'] = 'agent_status_html.png';
WIDGET_HTML_NAMES['initiative-pulse'] = 'initiative_pulse_html.png';

function WIDGET_3D_NAMES() {}
WIDGET_3D_NAMES.scaffold = 'scaffold.png';
WIDGET_3D_NAMES['agent-status'] = 'agent_status.png';
WIDGET_3D_NAMES['initiative-pulse'] = 'initiative_pulse.png';

// Resolve actual paths (the destructure above won't pick the correct names
// because the lookup tables are functions; do it explicitly):
const htmlName = (
  W === 'scaffold' ? 'scaffold_widget_html.png' :
  W === 'agent-status' ? 'agent_status_html.png' :
  W === 'initiative-pulse' ? 'initiative_pulse_html.png' :
  `${W}_html.png`
);
const b3dName = (
  W === 'scaffold' ? 'scaffold.png' :
  W === 'agent-status' ? 'agent_status.png' :
  W === 'initiative-pulse' ? 'initiative_pulse.png' :
  `${W}.png`
);
const HTML = join(ROOT, 'public', 'widgets-3d', htmlName);
const B3D  = join(ROOT, 'public', 'widgets-3d', b3dName);

console.log(`[validate] HTML: ${HTML}`);
console.log(`[validate] 3D:   ${B3D}`);

// Load + normalize both to the same dimensions
const htmlInfo = await sharp(HTML).metadata();
const b3dInfo = await sharp(B3D).metadata();
const TARGET_W = Math.min(htmlInfo.width, b3dInfo.width);
const TARGET_H = Math.min(htmlInfo.height, b3dInfo.height);

// Force both to RGB (no alpha) so we compare in the same color space and
// our raw pixel offsets line up.
const htmlBuf = await sharp(HTML)
  .resize(TARGET_W, TARGET_H, { fit: 'fill' })
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const b3dBuf = await sharp(B3D)
  .resize(TARGET_W, TARGET_H, { fit: 'fill' })
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const channels = 3;
const a = htmlBuf.data, b = b3dBuf.data;
const N = TARGET_W * TARGET_H;

// Compute per-pixel delta (Euclidean in RGB, then normalized 0..1)
const diff = Buffer.alloc(N * 3);
let sumDelta = 0;
let maxDelta = 0;
for (let i = 0, p = 0; i < N; i++) {
  const ai = i * channels;
  const bi = i * channels;
  const dr = a[ai] - b[bi];
  const dg = a[ai + 1] - b[bi + 1];
  const db = a[ai + 2] - b[bi + 2];
  const d = Math.sqrt(dr * dr + dg * dg + db * db) / Math.sqrt(3 * 255 * 255);
  sumDelta += d;
  if (d > maxDelta) maxDelta = d;
  // Heat-map: green→yellow→red
  const c = Math.min(1, d * 3);
  diff[p++] = Math.round(255 * c);
  diff[p++] = Math.round(255 * (1 - c) * 0.6 + 60);
  diff[p++] = Math.round(60);
}
const meanDelta = sumDelta / N;

// SSIM via a simple sliding-window approach (8x8 blocks, no Gaussian)
function rgbLuminance(arr, idx, channels) {
  return 0.2126 * arr[idx] + 0.7152 * arr[idx + 1] + 0.0722 * arr[idx + 2];
}
function ssimRow(yStart, yEnd) {
  const win = 8;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  let total = 0, count = 0;
  for (let y = yStart; y < yEnd - win; y += win) {
    for (let x = 0; x < TARGET_W - win; x += win) {
      let sumA = 0, sumB = 0;
      for (let j = 0; j < win; j++) {
        for (let i = 0; i < win; i++) {
          const idx = ((y + j) * TARGET_W + (x + i)) * channels;
          sumA += rgbLuminance(a, idx, channels);
          sumB += rgbLuminance(b, idx, channels);
        }
      }
      const muA = sumA / (win * win);
      const muB = sumB / (win * win);
      let varA = 0, varB = 0, cov = 0;
      for (let j = 0; j < win; j++) {
        for (let i = 0; i < win; i++) {
          const idx = ((y + j) * TARGET_W + (x + i)) * channels;
          const lA = rgbLuminance(a, idx, channels) - muA;
          const lB = rgbLuminance(b, idx, channels) - muB;
          varA += lA * lA;
          varB += lB * lB;
          cov  += lA * lB;
        }
      }
      varA /= win * win;
      varB /= win * win;
      cov  /= win * win;
      const num = (2 * muA * muB + c1) * (2 * cov + c2);
      const den = (muA * muA + muB * muB + c1) * (varA + varB + c2);
      total += num / den;
      count += 1;
    }
  }
  return { total, count };
}
let totalSSIM = 0, blocks = 0;
const rowsPerBatch = Math.max(8, Math.floor(TARGET_H / 8));
for (let y = 0; y < TARGET_H; y += rowsPerBatch) {
  const r = ssimRow(y, Math.min(TARGET_H, y + rowsPerBatch));
  totalSSIM += r.total;
  blocks += r.count;
}
const ssim = blocks > 0 ? totalSSIM / blocks : 0;

// Save the diff heatmap
await sharp(diff, { raw: { width: TARGET_W, height: TARGET_H, channels: 3 } })
  .png()
  .toFile(DIFF_PATH);

// Save side-by-side: HTML | 3D | DIFF.
// Resize each input to (TARGET_W, TARGET_H) so the composite dimensions match.
const htmlNorm = await sharp(HTML).resize(TARGET_W, TARGET_H, { fit: 'fill' }).png().toBuffer();
const b3dNorm = await sharp(B3D).resize(TARGET_W, TARGET_H, { fit: 'fill' }).png().toBuffer();
await sharp({
  create: { width: TARGET_W * 3 + 40, height: TARGET_H, channels: 3, background: { r: 4, g: 7, b: 15 } },
})
  .composite([
    { input: htmlNorm, top: 0, left: 0 },
    { input: b3dNorm, top: 0, left: TARGET_W + 20 },
    { input: DIFF_PATH, top: 0, left: TARGET_W * 2 + 40 },
  ])
  .png()
  .toFile(COMP_PATH);

const report = {
  widget: W,
  ssim,
  mean_delta: meanDelta,
  max_delta: maxDelta,
  resolution: { w: TARGET_W, h: TARGET_H },
  threshold: parseFloat(argv.threshold),
  passed: ssim >= parseFloat(argv.threshold),
  generatedAt: new Date().toISOString(),
};
writeFileSync(REPORT, JSON.stringify(report, null, 2));

console.log(`[validate] ${W}: SSIM = ${ssim.toFixed(4)}, mean Δ = ${(meanDelta * 100).toFixed(2)}%, max Δ = ${(maxDelta * 100).toFixed(2)}%`);
console.log(`[validate] threshold=${argv.threshold} → ${report.passed ? 'PASS' : 'FAIL'}`);
console.log(`[validate] diff:    ${DIFF_PATH}`);
console.log(`[validate] compare: ${COMP_PATH}`);
console.log(`[validate] report:  ${REPORT}`);

process.exit(report.passed ? 0 : 1);
