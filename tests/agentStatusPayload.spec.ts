import { describe, expect, it } from 'vitest';

import {
  enrichAgentStatusWithDurableEvidence,
  filterAgentStatusArtifactsByVisibleScope,
  normalizeAgentStatusPayload,
} from '../src/agentStatusPayload';

describe('normalizeAgentStatusPayload', () => {
  it('filters non-agent app entries and recomputes the fleet summary', () => {
    const result = normalizeAgentStatusPayload({
      agents: [
        {
          agent_id: 'product-agent',
          agent_name: 'Pace',
          status: 'idle',
        },
        {
          agent_id: 'chatgpt-app',
          agent_name: 'OrgX ChatGPT App',
          status: 'idle',
        },
        {
          agent_id: 'engineering-agent',
          agent_name: 'Eli',
          status: 'running',
        },
      ],
      summary: {
        total: 3,
        running: 1,
        queued: 0,
        blocked: 0,
        idle: 2,
      },
    });

    expect(result).toMatchObject({
      agents: [
        { agent_id: 'product-agent', agent_name: 'Pace', status: 'idle' },
        {
          agent_id: 'engineering-agent',
          agent_name: 'Eli',
          status: 'running',
        },
      ],
      summary: {
        total: 2,
        running: 1,
        queued: 0,
        blocked: 0,
        idle: 1,
      },
    });
  });

  it('merges alias agent records into a single display agent', () => {
    const result = normalizeAgentStatusPayload({
      agents: [
        {
          agent_id: 'product-agent',
          agent_name: 'Pace',
          role: 'Product',
          status: 'idle',
          current_tasks: [{ id: 'task-1', title: 'Primary roadmap pass' }],
        },
        {
          agent_id: 'product-onboarding',
          agent_name: 'Pace',
          role: 'Product',
          status: 'running',
          blockers: ['Waiting on approval'],
        },
      ],
    });

    expect(result).toMatchObject({
      agents: [
        {
          agent_name: 'Pace',
          role: 'Product',
          status: 'running',
          current_tasks: [{ id: 'task-1', title: 'Primary roadmap pass' }],
          blockers: ['Waiting on approval'],
        },
      ],
      summary: {
        total: 1,
        running: 1,
        queued: 0,
        blocked: 0,
        idle: 0,
      },
    });
  });

  it('preserves a completed task lane and marks an old heartbeat as stalled', () => {
    const result = normalizeAgentStatusPayload({
      agents: [
        {
          agent_id: 'engineering-agent',
          agent_name: 'Eli',
          status: 'in_progress',
          last_heartbeat_at: '2020-01-01T00:00:00.000Z',
          tasks: [
            { id: 'task-active', title: 'Current repair', status: 'in_progress' },
            { id: 'task-done', title: 'Shipped repair', status: 'completed' },
          ],
        },
      ],
    });

    expect(result).toMatchObject({
      agents: [
        {
          status: 'stalled',
          completed_count: 1,
          completed_tasks: [{ id: 'task-done', title: 'Shipped repair', status: 'completed' }],
        },
      ],
      summary: { stalled: 1, completed: 1 },
    });
  });

  it('projects a fresh claimed task as active with durable identifiers', () => {
    const now = Date.parse('2026-08-29T10:00:00.000Z');
    const result = enrichAgentStatusWithDurableEvidence(
      {
        agents: [
          {
            agent_id: 'design-agent',
            agent_name: 'Dana',
            domain: 'design',
            status: 'idle',
          },
        ],
      },
      [
        {
          id: 'task-dana',
          status: 'in_progress',
          assigned_agent_id: 'design-agent',
          run_id: 'run-dana',
          job_id: 'job-dana',
          last_heartbeat_at: '2026-08-29T09:59:30.000Z',
        },
      ],
      [],
      now
    );

    expect(result.agents).toEqual([
      expect.objectContaining({
        status: 'running',
        activity_state: 'active',
        observability_state: 'fresh',
        status_source: 'durable_task',
        task_id: 'task-dana',
        run_id: 'run-dana',
        job_id: 'job-dana',
        artifact_count: 0,
      }),
    ]);
  });

  it('surfaces a stale task/artifact conflict instead of silently reporting idle', () => {
    const now = Date.parse('2026-08-29T10:00:00.000Z');
    const result = enrichAgentStatusWithDurableEvidence(
      {
        agents: [
          {
            agent_id: 'design-agent',
            agent_name: 'Dana',
            domain: 'design',
            status: 'idle',
          },
        ],
      },
      [
        {
          id: 'task-dana',
          status: 'in_progress',
          assigned_agent_id: 'design-agent',
          run_id: 'run-dana',
          job_id: 'job-dana',
          updated_at: '2026-08-29T09:00:00.000Z',
        },
      ],
      [
        {
          id: 'artifact-dana',
          title: 'Agent review surface',
          status: 'in_review',
          task_id: 'task-dana',
          created_at: '2026-08-29T09:30:00.000Z',
          verification: { eval: { score: 0.92 } },
        },
      ],
      now
    );

    expect(result.agents).toEqual([
      expect.objectContaining({
        status: 'stalled',
        activity_state: 'stalled',
        observability_state: 'stale',
        stale_reason: 'active_task_conflicts_with_delivered_artifact',
        reconciliation_required: true,
        task_id: 'task-dana',
        run_id: 'run-dana',
        job_id: 'job-dana',
        artifact_count: 1,
        latest_artifact: expect.objectContaining({
          id: 'artifact-dana',
          task_id: 'task-dana',
          eval_score: 0.92,
        }),
      }),
    ]);
  });

  it('uses unknown when an active task has no freshness evidence', () => {
    const result = enrichAgentStatusWithDurableEvidence(
      {
        agents: [
          {
            agent_id: 'engineering-agent',
            agent_name: 'Eli',
            status: 'idle',
          },
        ],
      },
      [
        {
          id: 'task-eli',
          status: 'in_progress',
          assigned_agent_id: 'engineering-agent',
          run_id: 'run-eli',
          job_id: 'job-eli',
        },
      ],
      [],
      Date.parse('2026-08-29T10:00:00.000Z')
    );

    expect(result.agents).toEqual([
      expect.objectContaining({
        status: 'unknown',
        activity_state: 'unknown',
        observability_state: 'unknown',
        stale_reason: 'active_task_missing_freshness_evidence',
      }),
    ]);
  });

  it('projects terminal task and artifact evidence as done', () => {
    const result = enrichAgentStatusWithDurableEvidence(
      {
        agents: [
          {
            agent_id: 'product-agent',
            agent_name: 'Pace',
            status: 'idle',
          },
        ],
      },
      [
        {
          id: 'task-pace',
          status: 'completed',
          assigned_agent_id: 'product-agent',
          run_id: 'run-pace',
          job_id: 'job-pace',
          completed_at: '2026-08-29T09:00:00.000Z',
        },
      ],
      [
        {
          id: 'artifact-pace',
          task_id: 'task-pace',
          title: 'Evaluation rubric',
          status: 'approved',
        },
      ]
    );

    expect(result.agents).toEqual([
      expect.objectContaining({
        status: 'done',
        activity_state: 'terminal',
        observability_state: 'terminal',
        artifact_count: 1,
        latest_artifact: expect.objectContaining({ id: 'artifact-pace' }),
      }),
    ]);
  });


  it('derives the domain from the agent id for a legacy run artifact', () => {
    const result = enrichAgentStatusWithDurableEvidence(
      {
        agents: [
          {
            agent_id: 'design-agent',
            agent_name: 'Dana',
            status: 'idle',
          },
        ],
      },
      [
        {
          id: 'task-dana',
          status: 'in_progress',
          updated_at: '2026-08-29T09:51:07.000Z',
        },
      ],
      [
        {
          id: 'artifact-dana',
          title: 'Trust Progress UX Specification',
          artifact_type: 'design.document',
          entity_type: 'initiative',
          entity_id: 'initiative-trust',
          status: 'in_review',
          created_at: '2026-08-29T09:52:42.000Z',
          metadata: {
            source_run_id: 'run-dana',
          },
          verification: { eval: { score: 0.92 } },
        },
      ],
      Date.parse('2026-08-29T10:00:00.000Z')
    );

    expect(result.agents).toEqual([
      expect.objectContaining({
        status: 'stalled',
        artifact_count: 1,
        artifact_attribution_state: 'matched',
        run_id: 'run-dana',
        run_id_state: 'known',
        job_id: null,
        job_id_state: 'unknown',
        latest_artifact: expect.objectContaining({
          id: 'artifact-dana',
          run_id: 'run-dana',
          eval_score: 0.92,
        }),
      }),
    ]);
  });


  it('scopes legacy initiative-entity artifacts without leaking another workspace', () => {
    const data = {
      agents: [
        {
          agent_id: 'design-agent',
          initiative_id: 'initiative-visible',
          tasks: [
            {
              task_id: 'task-visible',
              initiative_id: 'initiative-visible',
            },
          ],
        },
      ],
    };

    expect(
      filterAgentStatusArtifactsByVisibleScope(data, [
        {
          id: 'artifact-visible-initiative',
          entity_type: 'initiative',
          entity_id: 'initiative-visible',
        },
        {
          id: 'artifact-visible-task',
          entity_type: 'task',
          entity_id: 'task-visible',
        },
        {
          id: 'artifact-other-workspace',
          entity_type: 'initiative',
          entity_id: 'initiative-private',
        },
      ]).map((artifact) => artifact.id)
    ).toEqual(['artifact-visible-initiative', 'artifact-visible-task']);
  });

});
