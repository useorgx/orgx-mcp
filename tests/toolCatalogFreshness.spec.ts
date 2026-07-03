import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

// Must match INLINE_TOOL_METADATA in scripts/generate-tool-catalog.ts.
// Drift between these two lists silently breaks the freshness gate.
const INLINE_TOOL_IDS = [
  'orgx_bootstrap',
  'orgx_inspect',
  'orgx_search',
  'orgx_recommend',
  'orgx_write',
  'orgx_attach',
  'orgx_act',
  'orgx_emit_activity',
  'orgx_plan',
  'orgx_spawn',
  'orgx_decide',
  'orgx_submit_receipt',
  'approve_agent_work',
  'account_status',
  'account_upgrade',
  'account_usage_report',
];

describe('tool catalog freshness', () => {
  it('docs/generated/tool-catalog.json matches the tool sources', () => {
    const catalogPath = path.join(rootDir, 'docs/generated/tool-catalog.json');
    expect(
      existsSync(catalogPath),
      'tool-catalog.json missing — run: pnpm catalog:generate'
    ).toBe(true);

    const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8')) as {
      sourceHash: string;
    };

    const hash = createHash('sha256');
    for (const file of [
      'src/toolDefinitions.ts',
      'src/flywheelTools.ts',
      'src/toolProfiles.ts',
      'src/contractTools.ts',
    ]) {
      hash.update(readFileSync(path.join(rootDir, file), 'utf-8'));
    }
    hash.update(INLINE_TOOL_IDS.join(','));
    const expected = hash.digest('hex').slice(0, 16);

    expect(
      catalog.sourceHash,
      'tool catalog is stale — run: pnpm catalog:generate (and catalog:sync:monorepo to refresh the orgx web repo copy)'
    ).toBe(expected);
  });
});
