import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wranglerConfig = readFileSync(resolve(root, 'wrangler.toml'), 'utf8');

describe('reviewer deployment configuration', () => {
  it('uses the healthy canonical production API while retaining fallback', () => {
    expect(wranglerConfig).not.toContain('next.useorgx.com');
    expect(
      wranglerConfig.match(/ORGX_API_URL = "https:\/\/useorgx\.com"/g)
    ).toHaveLength(2);
    expect(
      wranglerConfig.match(
        /ORGX_API_FALLBACK_URL = "https:\/\/orgx-api-fallback-brain-buffet\.vercel\.app"/g
      )
    ).toHaveLength(2);
  });
});
