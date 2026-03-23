import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CLIENT_INTEGRATION_TOOL_DEFINITIONS } from '../src/toolDefinitions';

const INITIATIVE_ID = 'aa6d16dc-d450-417f-8a17-fd89bd597195';
const RUN_ID = '4d601b64-2b7f-495c-a13a-fef3b1de1180';
const TASK_ID = '15f34642-4fc5-47a0-b604-f0056c1958c6';

function findTool(id: string) {
  const tool = CLIENT_INTEGRATION_TOOL_DEFINITIONS.find(
    (entry) => entry.id === id
  );
  expect(tool).toBeDefined();
  return tool!;
}

describe('MCP reporting tools', () => {
  it('registers the two control-plane write tools', () => {
    const ids = CLIENT_INTEGRATION_TOOL_DEFINITIONS.map((tool) => tool.id);
    expect(ids).toContain('orgx_emit_activity');
    expect(ids).toContain('orgx_apply_changeset');
  });

  it('validates emit activity progress bounds', () => {
    const emitTool = findTool('orgx_emit_activity');
    const schema = z.object(emitTool.inputSchema);

    const invalid = schema.safeParse({
      initiative_id: INITIATIVE_ID,
      run_id: RUN_ID,
      message: 'Out-of-range progress',
      progress_pct: 101,
    });

    expect(invalid.success).toBe(false);

    const valid = schema.safeParse({
      initiative_id: INITIATIVE_ID,
      run_id: RUN_ID,
      message: 'Working',
      progress_pct: 42,
    });

    expect(valid.success).toBe(true);
  });

  it('enforces operation-level rules for apply changeset', () => {
    const applyTool = findTool('orgx_apply_changeset');
    const schema = z.object(applyTool.inputSchema);

    const invalid = schema.safeParse({
      initiative_id: INITIATIVE_ID,
      run_id: RUN_ID,
      idempotency_key: 'mcp-invalid-op',
      operations: [
        {
          op: 'task.update',
          task_id: TASK_ID,
        },
      ],
    });

    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      const messages = invalid.error.issues.map((issue) => issue.message);
      expect(messages).toContain(
        'task.update requires at least one mutable field'
      );
    }

    const valid = schema.safeParse({
      initiative_id: INITIATIVE_ID,
      run_id: RUN_ID,
      idempotency_key: 'mcp-valid-op',
      operations: [
        {
          op: 'decision.create',
          title: 'Use two-tool contract',
          urgency: 'high',
        },
      ],
    });

    expect(valid.success).toBe(true);
  });
});
