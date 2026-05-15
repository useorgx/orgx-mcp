import { describe, expect, it } from 'vitest';

import {
  buildFirstAgentWorkState,
  deriveScaffoldIdempotencyKey,
  normalizeExternalSyncRequest,
  normalizeScaffoldObjectiveAliases,
  resolveScaffoldMode,
} from '../src/scaffoldControl';

describe('scaffold control helpers', () => {
  it('resolves staged modes while preserving launch_after_create compatibility', () => {
    expect(resolveScaffoldMode({}).mode).toBe('launch');
    expect(resolveScaffoldMode({ launch_after_create: false })).toMatchObject({
      mode: 'scaffold',
      launchAfterCreate: false,
    });
    expect(
      resolveScaffoldMode({ mode: 'draft', launch_after_create: true })
    ).toMatchObject({
      mode: 'draft',
      launchAfterCreate: false,
      warnings: [
        expect.objectContaining({
          code: 'legacy_launch_after_create_ignored',
        }),
      ],
    });
  });

  it('normalizes objective_ids aliases recursively without leaking objective_ids', () => {
    const normalized = normalizeScaffoldObjectiveAliases({
      title: 'Launch',
      objective_ids: ['objective-1'],
      workstreams: [
        {
          title: 'Engineering',
          objective_ids: ['objective-2'],
          milestones: [
            {
              title: 'Ship',
              objective_ids: ['objective-3'],
              tasks: [{ title: 'Build', objective_ids: ['objective-4'] }],
            },
          ],
        },
      ],
    });

    expect(normalized.warnings).toEqual([]);
    expect(normalized.args).toMatchObject({
      goal_ids: ['objective-1'],
      workstreams: [
        {
          goal_ids: ['objective-2'],
          milestones: [
            {
              goal_ids: ['objective-3'],
              tasks: [{ goal_ids: ['objective-4'] }],
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(normalized.args)).not.toContain('objective_ids');
  });

  it('derives stable idempotency keys and honors explicit keys', () => {
    const base = {
      args: {
        title: 'Launch',
        workstreams: [{ title: 'Engineering' }],
      },
      workspaceId: 'workspace-1',
      ownerId: 'user-1',
    };

    expect(deriveScaffoldIdempotencyKey(base)).toBe(
      deriveScaffoldIdempotencyKey(base)
    );
    expect(
      deriveScaffoldIdempotencyKey({
        ...base,
        args: { ...base.args, idempotency_key: 'custom-key-123' },
      })
    ).toBe('custom-key-123');
  });

  it('normalizes external sync requests and exposes first agent work state', () => {
    expect(
      normalizeExternalSyncRequest({
        targets: ['linear', 'jira', 'unknown'],
        linearProjectId: 'linear-project',
      })
    ).toEqual({
      targets: ['linear', 'jira'],
      mode: 'project_and_tasks',
      linear_project_id: 'linear-project',
    });

    expect(
      buildFirstAgentWorkState({
        mode: 'launch',
        initiativeId: 'init-1',
        launch: { attempted: true, ok: true },
        streams: {
          total: 1,
          items: [{ id: 'stream-1', current_job_id: 'job-1' }],
        },
      })
    ).toMatchObject({
      status: 'work_started',
      initiative_id: 'init-1',
      first_stream_id: 'stream-1',
      current_job_id: 'job-1',
    });
  });
});
