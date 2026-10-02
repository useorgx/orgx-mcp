import { describe, expect, it } from 'vitest';
import { getOpenAiOutputSchema } from '../src/openaiOutputSchemas';

describe('approval list acceptance proof transport', () => {
  const response = {
    decisions: [], total_pending: 0,
    summary: { critical: 0, high: 0, medium: 0, low: 0 },
    message: 'No pending decisions',
  };

  it.each([
    null,
    { last_accepted: null, completed_unaccepted: null },
    { last_accepted: {
      artifact_id: 'artifact-1', title: 'Accepted output',
      accepted_at: '2026-10-02T12:00:00.000Z',
      accepted_by: 'you', url: 'https://useorgx.com/artifacts/artifact-1',
    }, completed_unaccepted: 2 },
  ])('accepts the app widget proof projection: %j', (proof) => {
    const result = getOpenAiOutputSchema('approve_agent_work')!.safeParse({ ...response, proof });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject({ proof });
  });

  it('keeps the ordinary model response compatible', () => {
    expect(getOpenAiOutputSchema('approve_agent_work')!.safeParse(response).success).toBe(true);
  });
});
