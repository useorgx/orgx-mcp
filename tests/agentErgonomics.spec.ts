import { describe, expect, it } from 'vitest';

import {
  buildClientAwareContentBlocks,
  buildJsonFirstContentBlocks,
  diagnoseToolFailure,
  normalizeEntityCreatePayloadForAgents,
  normalizeRecordOutcomeArgs,
  normalizeRecordQualityScoreArgs,
} from '../src/agentErgonomics';

describe('agent ergonomics helpers', () => {
  it('puts machine JSON before widget HTML', () => {
    const blocks = buildJsonFirstContentBlocks({
      data: { ok: true, id: 'initiative-1' },
      summary: 'Initiative ready.',
      widgetHtml: '<!DOCTYPE html><html></html>',
    });

    expect(blocks[0]?.text).toBe('{"ok":true,"id":"initiative-1"}');
    expect(blocks[1]?.text).toBe('Initiative ready.');
    expect(blocks[2]?.text).toContain('<!DOCTYPE html>');
  });

  it('returns a concise visible result for Claude Code widget tools', () => {
    const blocks = buildClientAwareContentBlocks({
      data: { ok: true, large: 'x'.repeat(10_000) },
      summary: 'Initiative ready.',
      sourceClient: 'claude',
      widgetHtml: '<!DOCTYPE html><html></html>',
    });

    expect(blocks).toEqual([{ type: 'text', text: 'Initiative ready.' }]);
  });

  it('normalizes common entity create aliases without accepting arbitrary enums', () => {
    const task = normalizeEntityCreatePayloadForAgents(
      { type: 'task', priority: 'urgent', status: 'active' },
      'create_entity'
    );
    expect(task.entity.priority).toBe('high');
    expect(task.entity.status).toBe('in_progress');
    expect(task.warnings).toHaveLength(2);

    const milestone = normalizeEntityCreatePayloadForAgents(
      { type: 'milestone', status: 'active' },
      'entities[0]'
    );
    expect(milestone.entity.status).toBe('in_progress');

    const decision = normalizeEntityCreatePayloadForAgents(
      { type: 'decision', status: 'active' },
      'create_entity'
    );
    expect(decision.entity.status).toBe('pending');

    const blocker = normalizeEntityCreatePayloadForAgents(
      { type: 'blocker', status: 'active' },
      'create_entity'
    );
    expect(blocker.entity.status).toBe('open');

    const artifact = normalizeEntityCreatePayloadForAgents(
      { type: 'artifact', status: 'active' },
      'create_entity'
    );
    expect(artifact.entity.status).toBe('draft');
  });

  it('normalizes quality score aliases to the backend contract', () => {
    const normalized = normalizeRecordQualityScoreArgs({
      task_id: 'task-1',
      domain: 'engineering',
      score: 5,
      scored_by: 'auto',
      notes: 'Tests passed.',
    });

    expect(normalized.error).toBeUndefined();
    expect(normalized.body).toEqual({
      taskId: 'task-1',
      agentDomain: 'engineering',
      score: 5,
      scoredBy: 'auto',
      notes: 'Tests passed.',
    });
  });

  it('builds safe diagnostics with corrected retry payloads', () => {
    const diagnostic = diagnoseToolFailure({
      toolId: 'record_quality_score',
      error:
        '400 Bad Request: {"message":"agentDomain is required","authorization":"Bearer oxk-secret-value"}',
      args: { task_id: 'task-1', agent_domain: 'product', score: 4 },
    });

    expect(diagnostic.code).toBe('quality_score_contract_alias');
    expect(diagnostic.safe_to_retry).toBe(true);
    expect(diagnostic.corrected_payload).toMatchObject({
      taskId: 'task-1',
      agentDomain: 'product',
      score: 4,
    });
    expect(JSON.stringify(diagnostic)).not.toContain('oxk-secret-value');
  });

  it('does not leak backend schema details in diagnostics', () => {
    const diagnostic = diagnoseToolFailure({
      toolId: 'orgx_apply_changeset',
      error: 'column "command_center_id" does not exist',
    });

    expect(diagnostic.code).toBe('backend_changeset_compatibility');
    expect(JSON.stringify(diagnostic)).not.toContain('command_center_id');
    expect(diagnostic.reason).toContain('transactional changeset');
  });

  it('normalizes record_outcome camelCase aliases', () => {
    const normalized = normalizeRecordOutcomeArgs(
      {
        workspaceId: 'workspace-1',
        outcomeTypeKey: 'meeting_booked',
        outcomeValue: 1,
        sourceId: 'cal-1',
        occurredAt: '2026-04-27T18:00:00Z',
      },
      null
    );

    expect(normalized.workspaceId).toBe('workspace-1');
    expect(normalized.body).toMatchObject({
      workspace_id: 'workspace-1',
      outcome_type_key: 'meeting_booked',
      outcome_value: 1,
      source: 'manual',
      source_id: 'cal-1',
      occurred_at: '2026-04-27T18:00:00Z',
    });
  });
});
