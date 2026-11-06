import { describe, expect, it } from 'vitest';
import { enrichAgentStatusWithDurableEvidence } from '../src/agentStatusPayload';
import { buildPanelWork } from '../src/panelSurface';

describe('saved work versus execution', () => {
  it('does not call assigned todo work queued execution', () => {
    const data = enrichAgentStatusWithDurableEvidence({ agents: [{ agent_id: 'marketing-agent', agent_name: 'Mark', status: 'idle' }] },
      [{ id: 'saved-task', title: 'Receipt package', status: 'todo', assigned_agent_id: 'marketing-agent' }], []);
    expect(data.agents).toMatchObject([{ status: 'planned', activity_state: 'planned' }]);
    // The task list, not a fabricated Working row, supplies the panel's work.
    const work = buildPanelWork({ agents: [{ agent_name: 'Mark', status: 'planned', tasks: [{ id: 'saved-task', title: 'Receipt package', status: 'todo' }] }] });
    expect(work.items).toMatchObject([{ id: 'saved-task', state: 'planned', title: 'Receipt package' }]);
  });
  it('keeps a held child held after entity enrichment', () => {
    const data = enrichAgentStatusWithDurableEvidence({ agents: [{ agent_id: 'marketing-agent', agent_name: 'Mark', status: 'blocked',
      tasks: [{ id: 'task', title: 'Receipt package', status: 'held', stored_status: 'todo', blocker: 'Initiative is paused.' }] }] },
      [{ id: 'task', title: 'Receipt package', status: 'todo', assigned_agent_id: 'marketing-agent' }], []);
    expect(buildPanelWork(data).items).toMatchObject([{ state: 'held', blocker: 'Initiative is paused.' }]);
  });
  it('does not invent a Working task for a queued agent without an execution reference', () => {
    expect(buildPanelWork({ agents: [{ agent_name: 'Pace', status: 'queued' }] }).items).toEqual([]);
  });
});
