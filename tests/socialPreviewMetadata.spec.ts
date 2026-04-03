import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('social preview metadata', () => {
  const publicIndex = readFileSync(
    resolve(process.cwd(), 'public/index.html'),
    'utf8'
  );
  const sharedIndex = readFileSync(
    resolve(process.cwd(), 'public/widgets/shared/index.html'),
    'utf8'
  );
  const previewPage = readFileSync(
    resolve(process.cwd(), 'public/og-preview.html'),
    'utf8'
  );
  const renderScript = readFileSync(
    resolve(process.cwd(), 'scripts/render-social-preview.mjs'),
    'utf8'
  );

  it('points public metadata at the dedicated orgx mcp social preview asset', () => {
    expect(publicIndex).toContain('https://mcp.useorgx.com/screenshots/orgx-mcp-og.png');
    expect(sharedIndex).toContain('https://mcp.useorgx.com/screenshots/orgx-mcp-og.png');
    expect(publicIndex).not.toContain('https://mcp.useorgx.com/control_tower.png');
    expect(sharedIndex).not.toContain('https://mcp.useorgx.com/control_tower.png');
  });

  it('composes the preview from generated widget screenshots', () => {
    expect(previewPage).toContain('/screenshots/social-preview/search-card.png');
    expect(previewPage).toContain('/screenshots/social-preview/scaffold-card.png');
    expect(previewPage).toContain('/screenshots/social-preview/decision-card.png');
  });

  it('captures live widget routes into reusable social preview assets', () => {
    expect(renderScript).toContain('/widgets/search-results.html?demo=true&theme=dark&embed=og-wide-search');
    expect(renderScript).toContain('/widgets/scaffolded-initiative.html?demo=true&theme=dark&embed=og-wide-scaffold');
    expect(renderScript).toContain('/widgets/decisions.html?demo=true&theme=dark&embed=og-decision');
    expect(renderScript).toContain("join(socialPreviewDir, 'search-card.png')");
    expect(renderScript).toContain("join(socialPreviewDir, 'scaffold-card.png')");
    expect(renderScript).toContain("join(socialPreviewDir, 'decision-card.png')");
  });
});
