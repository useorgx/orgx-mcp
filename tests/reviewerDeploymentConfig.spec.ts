import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wranglerConfig = readFileSync(resolve(root, 'wrangler.toml'), 'utf8');

describe('reviewer deployment configuration', () => {
  it('routes the consent document through the Worker for session-bound CSP', () => {
    expect(wranglerConfig).toContain('run_worker_first = ["/consent.html"]');
  });

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

  it('binds telemetry source to the deployment full SHA independently of the release version', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/deploy.yml'), 'utf8');
    const deploy = workflow.slice(workflow.indexOf('      - name: Deploy to Cloudflare'),
      workflow.indexOf('      # Run-token and broker secrets sync AFTER'));
    expect(deploy).toContain('ORGX_SOURCE_REVISION: ${{ github.sha }}');
    expect(deploy).toContain('--var "ORGX_SOURCE_REVISION:$ORGX_SOURCE_REVISION"');
    expect(deploy).toContain('--var "SENTRY_RELEASE:$SENTRY_RELEASE"');
    expect(deploy).not.toContain('secrets.ORGX_SOURCE_REVISION');
  });
});
