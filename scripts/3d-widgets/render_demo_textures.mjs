#!/usr/bin/env node
/**
 * render_demo_textures.mjs
 *
 * Generates crisp text/decal PNGs for the cinematic OrgX MCP demo scene.
 * Blender owns depth, bevels, lighting, and camera motion; these decals own
 * readable text so the video remains legible during movement.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';

const ROOT = resolve(process.cwd());

const { values: argv } = parseArgs({
  options: {
    outDir: { type: 'string', default: 'public/widgets-3d/demo-scene/textures' },
  },
});

const OUT_DIR = resolve(ROOT, argv.outDir);
mkdirSync(OUT_DIR, { recursive: true });

const FONT = '-apple-system, BlinkMacSystemFont, Inter, Helvetica Neue, Arial, sans-serif';
const MONO = 'JetBrains Mono, SF Mono, Menlo, ui-monospace, monospace';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrapText(text, maxChars) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function tspans(lines, x, y, lineHeight, attrs = '') {
  return lines
    .map((line, i) => `<tspan x="${x}" y="${y + i * lineHeight}" ${attrs}>${esc(line)}</tspan>`)
    .join('');
}

async function renderTextPlate(name, {
  width,
  height,
  title,
  eyebrow,
  body,
  footer,
  accent = '#00c9a7',
  titleSize = 34,
  bodySize = 25,
  monoSize = 17,
  padding = 34,
  bodyMaxChars = 62,
}) {
  const bodyLines = body ? wrapText(body, bodyMaxChars) : [];
  const titleLines = title ? wrapText(title, Math.max(18, Math.floor(bodyMaxChars * 0.7))) : [];
  const footerLines = footer ? wrapText(footer, bodyMaxChars) : [];
  const titleStart = eyebrow ? padding + 46 : padding + 8;
  const bodyStart = titleStart + titleLines.length * (titleSize * 1.18) + 24;
  const footerStart = bodyStart + bodyLines.length * (bodySize * 1.45) + 30;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="transparent"/>
  ${eyebrow ? `<text x="${padding}" y="${padding + 2}" font-family="${MONO}" font-size="${monoSize}" font-weight="700" letter-spacing="2.4" fill="rgba(255,255,255,0.46)" dominant-baseline="hanging">${esc(eyebrow.toUpperCase())}</text>` : ''}
  ${title ? `<text font-family="${FONT}" font-size="${titleSize}" font-weight="750" fill="#f8fafc">${tspans(titleLines, padding, titleStart, titleSize * 1.18)}</text>` : ''}
  ${body ? `<text font-family="${FONT}" font-size="${bodySize}" font-weight="500" fill="rgba(255,255,255,0.72)">${tspans(bodyLines, padding, bodyStart, bodySize * 1.45)}</text>` : ''}
  ${footer ? `<text font-family="${MONO}" font-size="${monoSize}" font-weight="700" letter-spacing="1.4" fill="${accent}">${tspans(footerLines, padding, footerStart, monoSize * 1.65)}</text>` : ''}
  <circle cx="${width - padding - 18}" cy="${padding + 18}" r="7" fill="${accent}" opacity="0.95"/>
</svg>`;

  const out = join(OUT_DIR, `${name}.png`);
  await sharp(Buffer.from(svg)).png().toFile(out);
  return {
    path: relative(ROOT, out),
    width,
    height,
  };
}

async function renderBadge(name, label, {
  width = 360,
  height = 74,
  accent = '#00c9a7',
  text = '#dffcf7',
}) {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="transparent"/>
  <circle cx="34" cy="${height / 2}" r="9" fill="${accent}"/>
  <text x="58" y="${height / 2 + 1}" font-family="${MONO}" font-size="18" font-weight="800" letter-spacing="2.2" fill="${text}" dominant-baseline="middle">${esc(label.toUpperCase())}</text>
</svg>`;
  const out = join(OUT_DIR, `${name}.png`);
  await sharp(Buffer.from(svg)).png().toFile(out);
  return { path: relative(ROOT, out), width, height };
}

const textures = {};

textures.projectTitle = await renderTextPlate('project-title', {
  width: 900,
  height: 90,
  title: 'OrgX / MCP Demo Workspace',
  bodyMaxChars: 46,
  titleSize: 34,
  padding: 18,
  accent: '#00c9a7',
});

textures.userPrompt = await renderTextPlate('user-prompt', {
  width: 960,
  height: 250,
  eyebrow: 'user prompt',
  title: 'Scaffold the launch initiative',
  body: 'Use OrgX MCP to turn this goal into workstreams, owners, milestones, and a live proof widget I can inspect immediately.',
  footer: 'orgx.scaffold_initiative',
  accent: '#6366f1',
});

textures.assistantPlan = await renderTextPlate('assistant-plan', {
  width: 1040,
  height: 300,
  eyebrow: 'orgx mcp response',
  title: 'Initiative structure assembled',
  body: 'Workstreams, agent ownership, task proof, and live-room links are now organized into a durable execution surface.',
  footer: '18 entities - 3 workstreams - live widget ready',
  accent: '#00c9a7',
});

textures.portalLabel = await renderBadge('portal-label', 'live scaffold widget', {
  width: 420,
  height: 72,
  accent: '#00c9a7',
});

textures.composer = await renderTextPlate('composer', {
  width: 980,
  height: 120,
  title: 'Ask OrgX to open the execution room...',
  bodyMaxChars: 58,
  titleSize: 25,
  padding: 24,
  accent: '#00c9a7',
});

textures.finalLabel = await renderTextPlate('final-label', {
  width: 760,
  height: 130,
  eyebrow: 'orgx world',
  title: 'Every action produces an artifact',
  body: 'The conversation becomes a navigable operating surface.',
  bodyMaxChars: 44,
  titleSize: 30,
  bodySize: 20,
  padding: 22,
  accent: '#00c9a7',
});

const manifest = {
  generatedAt: new Date().toISOString(),
  textures,
};

const manifestPath = join(OUT_DIR, 'manifest.json');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`demo textures -> ${relative(ROOT, OUT_DIR)}`);
console.log(`manifest -> ${relative(ROOT, manifestPath)}`);
