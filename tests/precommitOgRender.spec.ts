import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('pre-commit og render wiring', () => {
  const packageJson = JSON.parse(
    readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
  );
  const hookScript = readFileSync(
    resolve(process.cwd(), '.githooks/pre-commit'),
    'utf8'
  );
  const setupScript = readFileSync(
    resolve(process.cwd(), 'scripts/setup-git-hooks.mjs'),
    'utf8'
  );
  const precommitScript = readFileSync(
    resolve(process.cwd(), 'scripts/precommit-og-render.mjs'),
    'utf8'
  );

  it('installs repo-managed hooks during prepare', () => {
    expect(packageJson.scripts.prepare).toBe('node scripts/setup-git-hooks.mjs');
    expect(setupScript).toContain("['config', 'core.hooksPath', '.githooks']");
  });

  it('routes pre-commit through the og render detector', () => {
    expect(hookScript).toContain('node scripts/precommit-og-render.mjs');
    expect(packageJson.scripts['precommit:og']).toBe(
      'node scripts/precommit-og-render.mjs'
    );
  });

  it('regenerates and stages social preview assets when widgets change', () => {
    expect(precommitScript).toContain('/^public\\/widgets\\//');
    expect(precommitScript).toContain("pnpm', ['og:render']");
    expect(precommitScript).toContain("public/screenshots/orgx-mcp-og.png");
    expect(precommitScript).toContain("public/screenshots/social-preview/scaffold-card.png");
  });
});
