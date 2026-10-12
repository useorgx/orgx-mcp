import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

describe('pinned OrgX delegation source', () => {
  it('checks generated source and fails when either code or shared fixtures drift', () => {
    expect(() => execFileSync(process.execPath, [resolve(process.cwd(), 'scripts/check-mcp-domain-contracts.mjs')], { stdio: 'pipe' })).not.toThrow();
    const temp = mkdtempSync(resolve(tmpdir(), 'mcp-delegation-generator-'));
    try {
      for (const path of ['scripts/check-mcp-domain-contracts.mjs', 'src/generated/durableDelegation.ts', 'src/generated/durableDelegation.manifest.json', 'tests/fixtures/durable-delegation-v2.json', 'src/generated/scaffoldWorkflow.ts', 'src/generated/scaffoldWorkflow.manifest.json', 'tests/fixtures/scaffold-workflow-v1.json', 'src/generated/entityVocabulary.ts', 'src/generated/entityVocabulary.manifest.json', 'tests/fixtures/entity-vocabulary-v1.json']) {
        mkdirSync(dirname(resolve(temp, path)), { recursive: true });
        copyFileSync(resolve(process.cwd(), path), resolve(temp, path));
      }
      const run = () => execFileSync(process.execPath, [resolve(temp, 'scripts/check-mcp-domain-contracts.mjs')], { stdio: 'pipe' });
      expect(() => run()).not.toThrow();
      const generated = resolve(temp, 'src/generated/durableDelegation.ts');
      const source = readFileSync(generated, 'utf8');
      writeFileSync(generated, source.replace("receipt.jobStatus !== 'running'", "receipt.jobStatus !== 'queued'"));
      expect(() => run()).toThrow(/generated contract drift/);
      writeFileSync(generated, source);
      const vocabulary = resolve(temp, 'src/generated/entityVocabulary.ts');
      const vocabularySource = readFileSync(vocabulary, 'utf8');
      writeFileSync(vocabulary, vocabularySource.replace("  'workspace',", "  'tenant',"));
      expect(() => run()).toThrow(/entity_vocabulary_v1 generated contract drift/);
      writeFileSync(vocabulary, vocabularySource);
      writeFileSync(resolve(temp, 'tests/fixtures/durable-delegation-v2.json'), '[]');
      expect(() => run()).toThrow(/generated contract drift/);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});
