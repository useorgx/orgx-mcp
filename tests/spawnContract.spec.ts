import { describe, expect, it } from 'vitest';

import {
  buildOrgxSpawnForwardArgs,
  buildSpawnGuardForwardArgs,
  validateSpawnContract,
} from '../src/spawnContract';

describe('validateSpawnContract', () => {
  it('spawn: accepts task_id, or title + instructions; rejects neither', () => {
    expect(validateSpawnContract('spawn', { task_id: 't1' }).ok).toBe(true);
    expect(validateSpawnContract('spawn', { title: 'x', instructions: 'do x' }).ok).toBe(true);
    expect(validateSpawnContract('spawn', { title: 'x' }).ok).toBe(false); // missing instructions
    const r = validateSpawnContract('spawn', {});
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/task_id.*title.*instructions/i);
  });

  it('defaults action to spawn when omitted', () => {
    expect(validateSpawnContract('', {}).ok).toBe(false);
    expect(validateSpawnContract('', { task_id: 't1' }).ok).toBe(true);
  });

  it('handoff: requires task_id AND agent_type', () => {
    expect(validateSpawnContract('handoff', { task_id: 't', agent_type: 'eng' }).ok).toBe(true);
    expect(validateSpawnContract('handoff', { task_id: 't' }).ok).toBe(false);
    expect(validateSpawnContract('handoff', { agent_type: 'eng' }).ok).toBe(false);
  });

  it('guard: requires agent_type', () => {
    expect(validateSpawnContract('guard', { agent_type: 'eng' }).ok).toBe(true);
    expect(validateSpawnContract('guard', {}).ok).toBe(false);
  });

  it('classify/estimate: require title or task_id', () => {
    expect(validateSpawnContract('classify', { title: 'x' }).ok).toBe(true);
    expect(validateSpawnContract('estimate', { task_id: 't' }).ok).toBe(true);
    expect(validateSpawnContract('classify', {}).ok).toBe(false);
    expect(validateSpawnContract('estimate', {}).ok).toBe(false);
  });

  it('ignores whitespace-only strings (treats them as missing)', () => {
    expect(validateSpawnContract('guard', { agent_type: '   ' }).ok).toBe(false);
  });

  it('passes unknown actions through (handled elsewhere)', () => {
    expect(validateSpawnContract('something_else', {}).ok).toBe(true);
  });
});

describe('buildOrgxSpawnForwardArgs', () => {
  it('maps orgx_spawn ad-hoc spawn fields to spawn_agent_task args', () => {
    expect(
      buildOrgxSpawnForwardArgs('spawn_agent_task', {
        action: 'spawn',
        agent_type: 'engineering',
        title: 'Draft migration runbook',
        instructions: 'Use the existing rollback checklist.',
        initiative_id: 'init-1',
        expected_artifacts: ['Migration runbook', 'Rollback checklist'],
        model_tier: 'standard',
        budget_mode: 'cheapest_valid',
      })
    ).toEqual({
      agent: 'engineering-agent',
      task: 'Draft migration runbook',
      context: 'Use the existing rollback checklist.',
      initiative_id: 'init-1',
      expected_artifacts: ['Migration runbook', 'Rollback checklist'],
      model_tier: 'standard',
      budget_mode: 'cheapest_valid',
    });
  });

  it('preserves task bindings for app-side context hydration', () => {
    expect(
      buildOrgxSpawnForwardArgs('spawn_agent_task', {
        action: 'spawn',
        task_id: 'task-1',
        workstream_id: 'workstream-1',
        milestone_id: 'milestone-1',
        initiative_id: 'init-1',
        workspace_id: 'workspace-1',
      })
    ).toEqual({
      task_id: 'task-1',
      workstream_id: 'workstream-1',
      milestone_id: 'milestone-1',
      initiative_id: 'init-1',
      workspace_id: 'workspace-1',
      task: 'Execute task task-1',
    });
  });

  it('maps orgx_spawn handoff fields to handoff_task args', () => {
    expect(
      buildOrgxSpawnForwardArgs('handoff_task', {
        action: 'handoff',
        task_id: 'task-1',
        agent_type: 'ops',
        instructions: 'Take over the incident runbook.',
      })
    ).toEqual({
      task_id: 'task-1',
      agent: 'operations-agent',
      note: 'Take over the incident runbook.',
    });
  });
});

describe('buildSpawnGuardForwardArgs', () => {
  it('maps task_id to the app SpawnRequest taskId contract', () => {
    expect(
      buildSpawnGuardForwardArgs({
        action: 'guard',
        task_id: 'task-1',
        domain: 'engineering',
        workspace_id: 'workspace-1',
        model_tier: 'standard',
      })
    ).toEqual({
      action: 'guard',
      taskId: 'task-1',
      domain: 'engineering',
      workspace_id: 'workspace-1',
      model_tier: 'standard',
    });
  });

  it('preserves a canonical taskId and all unrelated guard fields', () => {
    expect(
      buildSpawnGuardForwardArgs({
        task_id: 'legacy-task',
        taskId: 'canonical-task',
        domain: 'product',
        taskTitle: 'Existing title',
        user_id: 'user-1',
      })
    ).toEqual({
      taskId: 'canonical-task',
      domain: 'product',
      taskTitle: 'Existing title',
      user_id: 'user-1',
    });
  });
});
