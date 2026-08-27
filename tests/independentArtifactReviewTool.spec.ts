import { describe, expect, it } from 'vitest';

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
    const schema = tool?.inputSchema as {
      safeParse(value: unknown): { success: boolean };
    };
    expect(schema.safeParse({ artifact_id: '11111111-1111-4111-8111-111111111111' }).success).toBe(true);
    expect(schema.safeParse({ artifact_id: 'not-an-artifact' }).success).toBe(false);
    expect(schema.safeParse({ artifact_id: '11111111-1111-4111-8111-111111111111', score: 5 }).success).toBe(true);
  });
});
