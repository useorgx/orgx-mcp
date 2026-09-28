import { describe, expect, it } from 'vitest';

import { CANONICAL_OUTPUT_SCHEMAS } from '../src/openaiOutputSchemas/canonical';
import { conformSpawnPayload } from '../src/spawnOutput';

describe('conformSpawnPayload', () => {
  // The shape a successful task-less spawn returned on 2026-09-28.
  const live = {
    _v2_tool: 'orgx_spawn',
    _action: 'spawn',
    routed_tool: 'spawn_agent_task',
    run_id: 'run-1',
    run_short_id: 'r1',
    agent_id: 'operations-agent',
    agent_profile_id: undefined,
    status: 'running',
    job_id: 'job-1',
    dispatch_receipt: {
      dispatch: 'cloud_claimed',
      jobStatus: 'running',
      acceptedAt: '2026-09-28T03:00:00.000Z',
      publishId: null,
      reasonCode: 'reconciled_after_client_timeout',
      claimLatencyMs: 5700,
      workflowEnvironment: 'trigger',
      eventIds: ['run_1'],
    },
    delegation_contract: 'durable_delegation_v2',
    delegation_parent_run_id: 'env-1',
    managed_runtime: 'anthropic',
    some_future_field: { a: 1 },
    task_id: null,
  };

  it('satisfies the strict published schema', () => {
    const out = conformSpawnPayload(live);
    expect(() => CANONICAL_OUTPUT_SCHEMAS.orgx_spawn.parse(out)).not.toThrow();
    expect(out.dispatch_receipt).toEqual({
      dispatch: 'cloud_claimed',
      jobStatus: 'running',
      acceptedAt: '2026-09-28T03:00:00.000Z',
    });
    expect(out).toMatchObject({ run_id: 'run-1', delegation_parent_run_id: 'env-1', managed_runtime: 'anthropic' });
    expect(out).not.toHaveProperty('some_future_field');
    expect(out).not.toHaveProperty('task_id');
  });

  it('leaves a payload without a receipt alone', () => {
    const out = conformSpawnPayload({ _v2_tool: 'orgx_spawn', _action: 'estimate', routed_tool: 'classify_task_model', estimate_only: true });
    expect(() => CANONICAL_OUTPUT_SCHEMAS.orgx_spawn.parse(out)).not.toThrow();
    expect(out).not.toHaveProperty('dispatch_receipt');
  });

  it('repairs a null inside an array and drops a field of the wrong shape', () => {
    const out = conformSpawnPayload({
      _v2_tool: 'orgx_spawn',
      _action: 'spawn',
      routed_tool: 'spawn_agent_task',
      run_id: 'run-1',
      next_steps: ['Watch progress', null, 'Check status'],
      live_url: 42,
    });
    expect(() => CANONICAL_OUTPUT_SCHEMAS.orgx_spawn.parse(out)).not.toThrow();
    expect(out.next_steps).toEqual(['Watch progress', 'Check status']);
    expect(out).not.toHaveProperty('live_url');
    expect(out.run_id).toBe('run-1');
  });
});

