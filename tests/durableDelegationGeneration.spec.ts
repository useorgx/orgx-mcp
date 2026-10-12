import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync } from 'node:fs';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

describe('pinned OrgX delegation source', () => {
  it('checks generated source and fails when either code or shared fixtures drift', () => {
    expect(() => execFileSync(process.execPath, [resolve(process.cwd(), 'scripts/check-mcp-domain-contracts.mjs')], { stdio: 'pipe' })).not.toThrow();
    const temp = mkdtempSync(resolve(tmpdir(), 'mcp-delegation-generator-'));
    try {
      for (const path of ['scripts/check-mcp-domain-contracts.mjs', 'src/generated/durableDelegation.ts', 'src/generated/durableDelegation.manifest.json', 'tests/fixtures/durable-delegation-v2.json', 'src/generated/scaffoldWorkflow.ts', 'src/generated/scaffoldWorkflow.manifest.json', 'tests/fixtures/scaffold-workflow-v1.json', 'src/generated/entityVocabulary.ts', 'src/generated/entityVocabulary.manifest.json', 'tests/fixtures/entity-vocabulary-v1.json', 'src/generated/artifactProofInput.ts', 'src/generated/artifactProofInput.manifest.json', 'tests/fixtures/artifact-proof-input-v1.json', 'src/generated/taskPrediction.ts', 'src/generated/taskPrediction.manifest.json', 'tests/fixtures/task-prediction-v1.json']) {
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
      const proof = resolve(temp, 'src/generated/artifactProofInput.ts');
      const proofSource = readFileSync(proof, 'utf8');
      writeFileSync(proof, proofSource.replace('expected_version: z.number().int().positive()', 'expected_version: z.number().int().nonnegative()'));
      expect(() => run()).toThrow(/artifact_proof_input_v1 generated contract drift/);
      writeFileSync(proof, proofSource);
      const prediction = resolve(temp, 'src/generated/taskPrediction.ts');
      const predictionSource = readFileSync(prediction, 'utf8');
      writeFileSync(prediction, predictionSource.replace('.min(1).max(50)', '.min(0).max(50)'));
      expect(() => run()).toThrow(/task_prediction_v1 generated contract drift/);
      writeFileSync(prediction, predictionSource);
      const proofFixture = resolve(temp, 'tests/fixtures/artifact-proof-input-v1.json');
      const fixtureSource = readFileSync(proofFixture, 'utf8');
      const manifestFile = resolve(temp, 'src/generated/artifactProofInput.manifest.json');
      const manifestSource = readFileSync(manifestFile, 'utf8');
      const manifest = JSON.parse(manifestSource);
      const invalidFixture = '{}';
      writeFileSync(proofFixture, invalidFixture);
      writeFileSync(manifestFile, JSON.stringify({ ...manifest, fixture_sha256: createHash('sha256').update(invalidFixture).digest('hex') }));
      expect(() => run()).toThrow(/artifact_proof_input_v1 generated contract drift/);
      writeFileSync(proofFixture, fixtureSource);
      writeFileSync(manifestFile, manifestSource);
      writeFileSync(resolve(temp, 'tests/fixtures/durable-delegation-v2.json'), '[]');
      expect(() => run()).toThrow(/generated contract drift/);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});
