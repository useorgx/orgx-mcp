import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

describe('tool catalog freshness', () => {
  it('docs/generated/tool-catalog.json matches the tool sources', () => {
    const catalogPath = path.join(rootDir, 'docs/generated/tool-catalog.json');
    expect(
      existsSync(catalogPath),
      'tool-catalog.json missing — run: pnpm catalog:generate'
    ).toBe(true);

    const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8')) as {
      sourceHash: string;
      tools: Array<{ id: string; securityScopes: string[] }>;
    };

    const hash = createHash('sha256');
    for (const file of [
      'src/toolDefinitions.ts',
      'src/flywheelTools.ts',
      'src/toolProfiles.ts',
      'src/authorizationPolicy.ts',
      'src/contractTools.ts',
      'scripts/generate-tool-catalog.ts',
    ]) {
      hash.update(readFileSync(path.join(rootDir, file), 'utf-8'));
    }
    const expected = hash.digest('hex').slice(0, 16);

    expect(
      catalog.sourceHash,
      'tool catalog is stale — run: pnpm catalog:generate (and catalog:sync:monorepo to refresh the orgx web repo copy)'
    ).toBe(expected);

    for (const tool of catalog.tools) {
      expect(
        tool.securityScopes,
        `${tool.id} repeats a scope in generated authorization metadata`
      ).toEqual([...new Set(tool.securityScopes)]);
    }
  });

  it('publishes the exact authorization policy used by the worker', async () => {
    const policyPath = path.join(
      rootDir,
      'docs/generated/authorization-policy.json'
    );
    expect(
      existsSync(policyPath),
      'authorization-policy.json missing — run: pnpm catalog:generate'
    ).toBe(true);

    const generated = JSON.parse(readFileSync(policyPath, 'utf-8'));
    const { AUTHORIZATION_POLICY } = await import(
      '../src/authorizationPolicy'
    );
    expect(generated).toEqual(AUTHORIZATION_POLICY);
  });
});
