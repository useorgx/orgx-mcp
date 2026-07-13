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

  it('keeps private activity telemetry closed-world', () => {
    expect(findTool('orgx_emit_activity').annotations).toMatchObject({
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    });
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

  it('accepts runtime provenance and chokepoint payloads for live surfacing', () => {
    const emitTool = findTool('orgx_emit_activity');
    const schema = z.object(emitTool.inputSchema);

    const parsed = schema.safeParse({
      initiative_id: INITIATIVE_ID,
      correlation_id: 'codex-cloud-stall',
      source_client: 'codex',
      message: 'Codex Cloud stopped emitting heartbeats',
      phase: 'blocked',
      level: 'warn',
      runtime: {
        source_runtime: 'codex_cloud',
        source_system: 'codex',
        provider: 'openai',
        execution_target: 'cloud',
        adapter: 'codex-cloud',
        job_id: 'job-codex-cloud-1',
      },
      chokepoint: {
        kind: 'stall',
        tier: 'attention',
        title: 'Codex Cloud run stalled',
        reason: 'No progress event has arrived within the expected window.',
        suggested_actions: ['Inspect the cloud run heartbeat.'],
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts all supported runtime source clients', () => {
    const emitTool = findTool('orgx_emit_activity');
    const schema = z.object(emitTool.inputSchema);

    for (const sourceClient of [
      'openclaw',
      'codex',
      'claude-code',
      'chatgpt',
      'cursor',
      'web-ui',
      'api',
    ]) {
      const parsed = schema.safeParse({
        initiative_id: INITIATIVE_ID,
        correlation_id: `source-${sourceClient}`,
        source_client: sourceClient,
        message: `Runtime event from ${sourceClient}`,
      });

      expect(parsed.success).toBe(true);
    }
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

  it('accepts runtime provenance on apply changeset for decision surfacing', () => {
    const applyTool = findTool('orgx_apply_changeset');
    const schema = z.object(applyTool.inputSchema);

    const parsed = schema.safeParse({
      initiative_id: INITIATIVE_ID,
      correlation_id: 'managed-decision-runtime',
      source_client: 'chatgpt',
      idempotency_key: 'mcp-runtime-decision',
      runtime: {
        source_runtime: 'orgx_managed',
        source_system: 'chatgpt',
        provider: 'openai',
        execution_target: 'cloud',
        adapter: 'managed-agent',
        job_id: 'managed-job-1',
      },
      operations: [
        {
          op: 'decision.create',
          title: 'Choose provider recovery',
          summary: 'Managed runtime needs a recovery choice.',
          urgency: 'urgent',
          options: ['retry Codex Cloud', 'switch to Anthropic', 'pause lane'],
          blocking: true,
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });
});
