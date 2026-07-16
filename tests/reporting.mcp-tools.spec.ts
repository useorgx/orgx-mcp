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
  it('registers reporting and external question bridge tools', () => {
    const ids = CLIENT_INTEGRATION_TOOL_DEFINITIONS.map((tool) => tool.id);
    expect(ids).toContain('orgx_emit_activity');
    expect(ids).toContain('orgx_apply_changeset');
    expect(ids).toContain('orgx_request_attention');
    expect(ids).toContain('orgx_poll_attention');
    expect(ids).toContain('orgx_ack_attention');
    expect(ids).toContain('orgx_request_question');
    expect(ids).toContain('orgx_poll_question');
  });

  it.each([
    ['claude-code', 'AskUserQuestion'],
    ['codex', 'request_user_input'],
    ['cursor', 'ask_question'],
  ] as const)(
    'accepts a contextual %s question and preserves its continuation handle',
    (sourceClient, sourceTool) => {
      const requestTool = findTool('orgx_request_question');
      const schema = z.object(requestTool.inputSchema);

      const parsed = schema.safeParse({
        initiative_id: INITIATIVE_ID,
        correlation_id: `${sourceClient}-question-1`,
        source_client: sourceClient,
        source_tool: sourceTool,
        source_session_id: `${sourceClient}-session-1`,
        source_event_id: `${sourceClient}-event-1`,
        idempotency_key: `${sourceClient}-question-1`,
        question: 'Which direction should this work take?',
        context:
          'The current files and run remain preserved while the owner answers.',
        response_mode: 'single_select',
        options: [
          {
            id: 'direction-a',
            label: 'Direction A',
            description: 'Continue with the current system.',
          },
          {
            id: 'direction-b',
            label: 'Direction B',
            description: 'Switch to the alternate system.',
          },
        ],
        source_ref: {
          thread_id: `${sourceClient}-thread-1`,
        },
      });

      expect(parsed.success).toBe(true);
    }
  );

  it('validates durable question polling receipts', () => {
    const pollTool = findTool('orgx_poll_question');
    const schema = z.object(pollTool.inputSchema);

    expect(schema.safeParse({ question_id: RUN_ID }).success).toBe(true);
    expect(schema.safeParse({ question_id: 'not-a-uuid' }).success).toBe(false);
  });

  it.each([
    ['claude-code', 'permission', 'resume_session'],
    ['codex', 'question', 'reply_in_place'],
    ['cursor', 'recovery', 'followup_from_checkpoint'],
    ['opencode', 'approval', 'poll'],
  ] as const)(
    'accepts typed %s %s attention with %s continuation',
    (sourceClient, attentionKind, strategy) => {
      const requestTool = findTool('orgx_request_attention');
      const schema = z.object(requestTool.inputSchema);
      expect(
        schema.safeParse({
          initiative_id: INITIATIVE_ID,
          correlation_id: `${sourceClient}-${attentionKind}-1`,
          source_client: sourceClient,
          source_tool: 'native_attention_hook',
          source_session_id: `${sourceClient}-session-1`,
          idempotency_key: `${sourceClient}-${attentionKind}-1`,
          attention_kind: attentionKind,
          question: 'What should this native session do next?',
          context: 'The current checkpoint is preserved.',
          impact_if_delayed: 'This lane remains paused.',
          response_mode: 'confirmation',
          continuation: {
            strategy,
            session_handle: `${sourceClient}-session-1`,
          },
        }).success
      ).toBe(true);
    }
  );

  it('validates continuation acknowledgement receipts', () => {
    const pollSchema = z.object(findTool('orgx_poll_attention').inputSchema);
    const ackSchema = z.object(findTool('orgx_ack_attention').inputSchema);

    expect(pollSchema.safeParse({ attention_id: RUN_ID }).success).toBe(true);
    expect(
      ackSchema.safeParse({
        attention_id: RUN_ID,
        state: 'resumed',
        idempotency_key: 'resume-receipt-1',
        occurred_at: '2026-07-16T01:00:00.000Z',
      }).success
    ).toBe(true);
    expect(
      ackSchema.safeParse({
        attention_id: RUN_ID,
        state: 'working',
        idempotency_key: 'invalid-state',
      }).success
    ).toBe(false);
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
