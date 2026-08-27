import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CLIENT_INTEGRATION_TOOL_DEFINITIONS } from '../src/toolDefinitions';

describe('request_independent_artifact_review tool contract', () => {
  const tool = CLIENT_INTEGRATION_TOOL_DEFINITIONS.find(
    (candidate) => candidate.id === 'request_independent_artifact_review'
  );

  it('exposes the artifact-bound independent review tool', () => {
    expect(tool).toBeDefined();
    expect(tool?.securitySchemes).toBeDefined();
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });

  it('requires a UUID artifact id and accepts no producer score', () => {
    const schema = z.object(tool?.inputSchema ?? {});
    expect(schema.safeParse({ artifact_id: '11111111-1111-4111-8111-111111111111' }).success).toBe(true);
    expect(schema.safeParse({ artifact_id: 'not-an-artifact' }).success).toBe(false);
    const parsed = schema.safeParse({
      artifact_id: '11111111-1111-4111-8111-111111111111',
      score: 5,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty('score');
  });
});
