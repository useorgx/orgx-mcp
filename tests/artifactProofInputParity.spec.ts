import { describe, expect, it } from 'vitest';
import { ArtifactProofPredecessorSchema, normalizeProofRevisionDescription } from '../src/proofRevisionDescription';
import { modalityProofInputSchema } from '../src/modalityProofInput';
import * as generated from '../src/generated/artifactProofInput';
import fixtures from './fixtures/artifact-proof-input-v1.json';

describe('producer proof input compatibility', () => {
  it.each(fixtures.filter((fixture) => fixture.mode !== 'verification'))('$name', (fixture) => {
    for (const contract of [{ ArtifactProofPredecessorSchema, normalizeProofRevisionDescription, ArtifactModalityProofInputSchema: modalityProofInputSchema }, generated]) {
    let actual;
    try {
      const data = fixture.mode === 'revision' ? contract.normalizeProofRevisionDescription(fixture.input as never)
        : fixture.mode === 'predecessor' ? contract.ArtifactProofPredecessorSchema.parse(fixture.input)
        : contract.ArtifactModalityProofInputSchema.parse(fixture.input);
      actual = { ok: true, data };
    } catch (error) {
      const failure = error as Error;
      actual = { ok: false, name: failure.name, message: failure.message };
    }
    expect(actual).toEqual('mcp' in fixture ? fixture.mcp : undefined);
    }
  });
});
