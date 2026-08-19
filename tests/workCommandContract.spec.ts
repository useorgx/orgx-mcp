import { describe, expect, it } from 'vitest';

import {
  COMPLETE_WORK_V1_PATH,
  CREATE_WORK_V1_PATH,
  EVENTS_STREAM_V1_PATH,
  buildCompleteWorkCommandRequest,
  buildCreateWorkCommandRequest,
  buildEventsTailRequest,
} from '../src/workCommandContract';

const WORKSPACE_ID = '7af01a51-49b1-47d8-98b9-91a198debca8';
const INITIATIVE_ID = '11111111-1111-4111-8111-111111111111';
const WORKSTREAM_ID = '22222222-2222-4222-8222-222222222222';
const MILESTONE_ID = '33333333-3333-4333-8333-333333333333';
const TASK_ID = '44444444-4444-4444-8444-444444444444';
const COMMAND_ID = '55555555-5555-4555-8555-555555555555';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('buildCreateWorkCommandRequest', () => {
  const baseArgs = {
    title: 'Wire the receipts adapter',
    initiative_id: INITIATIVE_ID,
    workstream_id: WORKSTREAM_ID,
    milestone_id: MILESTONE_ID,
  };

  it('builds the strict create-work body with expected_aggregate_version 0', () => {
    const built = buildCreateWorkCommandRequest(
      {
        ...baseArgs,
        description: 'Adapter + fallback',
        priority: 'high',
        due_date: '2026-08-30',
        metadata: { source: 'mcp' },
        estimated_cost_cents: 250,
        command_id: COMMAND_ID,
        idempotency_key: 'create-work:retry-1',
      },
      { workspaceId: WORKSPACE_ID }
    );

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.path).toBe(CREATE_WORK_V1_PATH);
    expect(built.idempotencyKey).toBe('create-work:retry-1');
    expect(built.idempotencyKeyGenerated).toBe(false);
    expect(built.body).toEqual({
      workspace_id: WORKSPACE_ID,
      command_id: COMMAND_ID,
      expected_aggregate_version: 0,
      title: 'Wire the receipts adapter',
      description: 'Adapter + fallback',
      initiative_id: INITIATIVE_ID,
      workstream_id: WORKSTREAM_ID,
      milestone_id: MILESTONE_ID,
      priority: 'high',
      due_date: '2026-08-30',
      metadata: { source: 'mcp' },
      estimated_cost_cents: 250,
    });
  });

  it('generates command_id and Idempotency-Key when omitted', () => {
    const built = buildCreateWorkCommandRequest(baseArgs, {
      workspaceId: WORKSPACE_ID,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.idempotencyKeyGenerated).toBe(true);
    expect(built.idempotencyKey).toMatch(UUID_RE);
    expect(built.body.command_id).toMatch(UUID_RE);
    // route defaults mirrored so the strict schema accepts the body
    expect(built.body.priority).toBe('medium');
    expect(built.body.metadata).toEqual({});
    expect(built.body.estimated_cost_cents).toBe(0);
  });

  it.each([
    ['initiative_id', { ...baseArgs, initiative_id: undefined }],
    ['workstream_id', { ...baseArgs, workstream_id: undefined }],
    ['milestone_id', { ...baseArgs, milestone_id: 'not-a-uuid' }],
    ['title', { ...baseArgs, title: '   ' }],
  ])('rejects a missing/invalid %s', (field, args) => {
    const built = buildCreateWorkCommandRequest(args as never, {
      workspaceId: WORKSPACE_ID,
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.field).toBe(field);
  });

  it('rejects a non-zero expected_aggregate_version — create targets a new aggregate', () => {
    const built = buildCreateWorkCommandRequest(
      { ...baseArgs, expected_aggregate_version: 3 },
      { workspaceId: WORKSPACE_ID }
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.field).toBe('expected_aggregate_version');
    expect(built.message).toContain('must be 0');
  });

  it('rejects an invalid due_date instead of forwarding it', () => {
    const built = buildCreateWorkCommandRequest(
      { ...baseArgs, due_date: 'next friday' },
      { workspaceId: WORKSPACE_ID }
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.field).toBe('due_date');
  });
});

describe('buildCompleteWorkCommandRequest', () => {
  const baseArgs = {
    task_id: TASK_ID,
    expected_updated_at: '2026-08-19T11:22:33.000Z',
    expected_aggregate_version: 4,
  };

  it('builds the strict complete-work body with the concurrency tokens', () => {
    const built = buildCompleteWorkCommandRequest(
      {
        ...baseArgs,
        summary: 'Shipped and verified',
        evidence: { prs: ['https://github.com/useorgx/orgx/pull/1'] },
        cost_cents: 125,
        idempotency_key: 'complete-work:retry-1',
      },
      { workspaceId: WORKSPACE_ID }
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.path).toBe(COMPLETE_WORK_V1_PATH);
    expect(built.idempotencyKey).toBe('complete-work:retry-1');
    expect(built.body).toEqual({
      workspace_id: WORKSPACE_ID,
      task_id: TASK_ID,
      expected_updated_at: '2026-08-19T11:22:33.000Z',
      expected_aggregate_version: 4,
      summary: 'Shipped and verified',
      evidence: { prs: ['https://github.com/useorgx/orgx/pull/1'] },
      cost_cents: 125,
    });
  });

  it('accepts an offset timestamp and generates a key when omitted', () => {
    const built = buildCompleteWorkCommandRequest(
      { ...baseArgs, expected_updated_at: '2026-08-19T11:22:33+02:00' },
      { workspaceId: WORKSPACE_ID }
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.idempotencyKeyGenerated).toBe(true);
    expect(built.idempotencyKey).toMatch(UUID_RE);
    expect(built.body.evidence).toEqual({});
    expect(built.body.cost_cents).toBe(0);
  });

  it('requires expected_updated_at with a timezone — no guessed concurrency tokens', () => {
    for (const bad of [undefined, '2026-08-19', '2026-08-19T11:22:33']) {
      const built = buildCompleteWorkCommandRequest(
        { ...baseArgs, expected_updated_at: bad },
        { workspaceId: WORKSPACE_ID }
      );
      expect(built.ok).toBe(false);
      if (built.ok) continue;
      expect(built.field).toBe('expected_updated_at');
    }
  });

  it('requires a non-negative integer expected_aggregate_version', () => {
    for (const bad of [undefined, -1, 1.5, '4']) {
      const built = buildCompleteWorkCommandRequest(
        { ...baseArgs, expected_aggregate_version: bad },
        { workspaceId: WORKSPACE_ID }
      );
      expect(built.ok).toBe(false);
      if (built.ok) continue;
      expect(built.field).toBe('expected_aggregate_version');
    }
  });

  it('requires task_id as a UUID', () => {
    const built = buildCompleteWorkCommandRequest(
      { ...baseArgs, task_id: 'task-42' },
      { workspaceId: WORKSPACE_ID }
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.field).toBe('task_id');
  });
});

describe('buildEventsTailRequest', () => {
  it('builds a workspace-scoped cursor-page GET path', () => {
    const built = buildEventsTailRequest(
      {
        limit: 25,
        cursor: 'cursor-abc',
        event_type: 'work.created,work.completed',
        aggregate_type: 'work_item',
      },
      { workspaceId: WORKSPACE_ID }
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const url = new URL(`https://example.com${built.path}`);
    expect(url.pathname).toBe(EVENTS_STREAM_V1_PATH);
    expect(url.searchParams.get('workspace_id')).toBe(WORKSPACE_ID);
    expect(url.searchParams.get('limit')).toBe('25');
    expect(url.searchParams.get('cursor')).toBe('cursor-abc');
    expect(url.searchParams.get('event_type')).toBe(
      'work.created,work.completed'
    );
    expect(url.searchParams.get('aggregate_type')).toBe('work_item');
  });

  it('accepts after as a cursor alias and omits unset filters', () => {
    const built = buildEventsTailRequest(
      { after: 'cursor-xyz' },
      { workspaceId: WORKSPACE_ID }
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const url = new URL(`https://example.com${built.path}`);
    expect(url.searchParams.get('cursor')).toBe('cursor-xyz');
    expect(url.searchParams.has('limit')).toBe(false);
    expect(url.searchParams.has('event_type')).toBe(false);
    expect(url.searchParams.has('aggregate_type')).toBe(false);
  });

  it('rejects an out-of-range limit before hitting the API', () => {
    for (const bad of [0, 101, 2.5]) {
      const built = buildEventsTailRequest(
        { limit: bad },
        { workspaceId: WORKSPACE_ID }
      );
      expect(built.ok).toBe(false);
      if (built.ok) continue;
      expect(built.field).toBe('limit');
    }
  });

  it('rejects an invalid aggregate_type', () => {
    const built = buildEventsTailRequest(
      { aggregate_type: 'Work Item!' },
      { workspaceId: WORKSPACE_ID }
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.field).toBe('aggregate_type');
  });

  it('requires a workspace UUID', () => {
    const built = buildEventsTailRequest({}, { workspaceId: 'not-a-uuid' });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.field).toBe('workspace_id');
  });
});
