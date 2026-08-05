import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const screenshotDirectory = resolve(root, 'public/screenshots');
const submissionForm = readFileSync(
  resolve(root, 'docs/anthropic-submission-form.md'),
  'utf8'
);
const directoryGuide = readFileSync(
  resolve(root, 'docs/anthropic-directory.md'),
  'utf8'
);
const packageJson = JSON.parse(
  readFileSync(resolve(root, 'package.json'), 'utf8')
) as { scripts?: Record<string, string> };

const screenshotPairs = [
  {
    file: 'anthropic-memory-search-response.png',
    prompt: 'What did we decide about Search Copilot readiness?',
  },
  {
    file: 'anthropic-agent-status-response.png',
    prompt: 'Show me what the OrgX agents are doing right now.',
  },
  {
    file: 'anthropic-initiative-pulse-response.png',
    prompt: 'Give me the pulse for the Search Copilot Readiness initiative.',
  },
  {
    file: 'anthropic-morning-brief-response.png',
    prompt: "Give me today's morning brief.",
  },
] as const;

describe('Anthropic response screenshot pack', () => {
  it('contains exactly four submission response PNGs at reviewer resolution', () => {
    const responsePngs = readdirSync(screenshotDirectory)
      .filter((file) => /^anthropic-.*-response\.png$/.test(file))
      .sort();

    expect(responsePngs).toEqual(
      screenshotPairs.map(({ file }) => file).sort()
    );

    for (const { file } of screenshotPairs) {
      const png = readFileSync(resolve(screenshotDirectory, file));
      expect(png.subarray(0, 8).toString('hex'), file).toBe(
        '89504e470d0a1a0a'
      );
      expect(png.readUInt32BE(16), `${file} width`).toBeGreaterThanOrEqual(1000);
      expect(png.readUInt32BE(20), `${file} height`).toBeGreaterThanOrEqual(1000);
    }
  });

  it('documents each production asset with its exact paired prompt', () => {
    for (const { file, prompt } of screenshotPairs) {
      const productionUrl = `https://mcp.useorgx.com/screenshots/${file}`;
      expect(submissionForm).toContain(productionUrl);
      expect(submissionForm).toContain(prompt);
      expect(directoryGuide).toContain(productionUrl);
      expect(directoryGuide).toContain(prompt);
    }

    expect(packageJson.scripts?.['screenshots:anthropic']).toBe(
      'node scripts/render-anthropic-review-screenshots.mjs'
    );
  });

  it('does not claim generic or broken demo captures as submission screenshots', () => {
    for (const oldAsset of [
      '/screenshots/command-center.png',
      '/screenshots/canvas.png',
      '/screenshots/agent-demo.png',
      '/screenshots/morning-brief.png',
    ]) {
      expect(submissionForm).not.toContain(oldAsset);
    }
  });
});
