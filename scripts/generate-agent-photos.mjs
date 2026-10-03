#!/usr/bin/env node
/**
 * Generate the small agent headshots that <ox-avatar> shows in photo mode
 * (the kit default) from the 1024 px originals in public/.
 *
 *   public/avatars/agents/photo/<agent>-<48|96|192>.webp
 *   served as https://mcp.useorgx.com/avatars/agents/photo/<agent>-<size>.webp
 *
 * Each crop is a face-centred square measured by hand on the originals:
 * the top of the hair and the chin set the head height, the square is 1.4x
 * that, and the eyes land a little above the middle. Every square stays clear
 * of the sparkle watermark in the bottom-right corner (centre 968,968, radius
 * about 24 px), so neither the square nor the circle shows it; the script
 * fails if a crop would include it.
 *
 * Needs ImageMagick 6+ with WebP (`convert -list format | grep WEBP`).
 * Run: node scripts/generate-agent-photos.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public/avatars/agents/photo');
const SIZES = [48, 96, 192];
const SOURCE_SIZE = 1024;
const SPARKLE = { x: 968, y: 968, r: 26 };

/** agent -> [original, top of hair, chin, face centre x] in source pixels. */
const FACES = {
  pace: ['product_orchestrator.png', 128, 624, 480],
  eli: ['engineering_autopilot.png', 128, 688, 474],
  mark: ['launch_captain.png', 70, 640, 486],
  sage: ['pipeline_intelligence.png', 96, 720, 518],
  orion: ['control_tower.png', 96, 586, 528],
  dana: ['design_codex.png', 80, 650, 506],
  xandy: ['xandy_orchestrator.png', 42, 554, 528],
};

export function cropFor([, top, chin, cx]) {
  const size = Math.round((chin - top) * 1.4);
  const clamp = (v) => Math.max(0, Math.min(SOURCE_SIZE - size, v));
  const y = clamp(Math.round(top - size * 0.08));
  const x = clamp(Math.round(cx - size / 2));
  return { size, x, y };
}

mkdirSync(out, { recursive: true });
for (const [agent, face] of Object.entries(FACES)) {
  const { size, x, y } = cropFor(face);
  const sparkleInside =
    SPARKLE.x + SPARKLE.r > x && SPARKLE.x - SPARKLE.r < x + size && SPARKLE.y + SPARKLE.r > y && SPARKLE.y - SPARKLE.r < y + size;
  if (sparkleInside) throw new Error(`${agent}: the crop includes the watermark; adjust FACES`);
  for (const px of SIZES) {
    const file = join(out, `${agent}-${px}.webp`);
    execFileSync('convert', [
      join(root, 'public', face[0]),
      '-crop', `${size}x${size}+${x}+${y}`, '+repage',
      '-filter', 'Lanczos', '-resize', `${px}x${px}`,
      '-strip', '-quality', px <= 48 ? '86' : '80', '-define', 'webp:method=6',
      file,
    ]);
    console.log(`${agent}-${px}.webp ${statSync(file).size} B (crop ${size}px at ${x},${y})`);
  }
}
