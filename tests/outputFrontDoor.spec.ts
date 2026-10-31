import { describe, expect, it } from 'vitest';
import { artifactOutputFrontDoorSchema, canonicalOutputFrontDoor } from '../src/outputFrontDoor';
import { outputFrontDoor } from './fixtures/outputFrontDoor';

const envelope = (frontDoor: unknown, source = 'canonical') => ({ reviewContractSource: source, reviewContract: { schemaVersion: 'artifact_review_contract.v1', frontDoor } });

describe('canonical output front door', () => {
  it('preserves recorded zero and unknown measurements', () => {
    expect(canonicalOutputFrontDoor(envelope(outputFrontDoor()))?.receipt).toMatchObject({ costUsd: 0, expertMinutes: 0, qualityBar: null });
  });
  it('requires canonical review provenance and never admits artifact metadata', () => {
    expect(canonicalOutputFrontDoor(envelope(outputFrontDoor(), 'entity_fallback'))).toBeNull();
    expect(canonicalOutputFrontDoor({ reviewContract: { metadata: { output_front_door: outputFrontDoor() } } })).toBeNull();
  });
  it.each([
    (door: ReturnType<typeof outputFrontDoor>) => ({ ...door, inventedServerClaim: true }),
    (door: ReturnType<typeof outputFrontDoor>) => ({ ...door, context: { ...door.context, team: 'Invented' } }),
    (door: ReturnType<typeof outputFrontDoor>) => ({ ...door, context: undefined }),
    (door: ReturnType<typeof outputFrontDoor>) => ({ ...door, decisions: [...door.decisions, ...door.decisions, ...door.decisions, ...door.decisions] }),
    (door: ReturnType<typeof outputFrontDoor>) => ({ ...door, decisions: [{ ...door.decisions[0], href: 'javascript:alert(1)' }] }),
    (door: ReturnType<typeof outputFrontDoor>) => ({ ...door, files: [{ ...door.files[0], href: '/artifacts/other' }] }),
    (door: ReturnType<typeof outputFrontDoor>) => ({ ...door, receipt: { ...door.receipt, href: '/console/runs/other' } }),
    (door: ReturnType<typeof outputFrontDoor>) => ({ ...door, receipt: { ...door.receipt, costUsd: Infinity } }),
    (door: ReturnType<typeof outputFrontDoor>) => ({ ...door, context: { ...door.context, runId: null } }),
    (door: ReturnType<typeof outputFrontDoor>) => ({ ...door, receipt: { ...door.receipt, runId: null, href: null } }),
    (door: ReturnType<typeof outputFrontDoor>) => ({ ...door, receipt: { ...door.receipt, runId: door.decisions[0].id, href: `/console/runs/${door.decisions[0].id}` } }),
    (door: ReturnType<typeof outputFrontDoor>) => ({ ...door, files: [...door.files, ...door.files] }),
  ])('rejects malformed blocks without weakening the existing review', (mutate) => {
    expect(artifactOutputFrontDoorSchema.safeParse(mutate(outputFrontDoor())).success).toBe(false);
    expect(canonicalOutputFrontDoor(envelope(mutate(outputFrontDoor())))).toBeNull();
  });
});
