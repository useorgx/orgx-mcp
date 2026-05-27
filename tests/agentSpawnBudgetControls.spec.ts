import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CONTRACT_TOOL_DEFINITIONS } from '../src/contractTools';
import {
  CHATGPT_TOOL_DEFINITIONS,
  CLIENT_INTEGRATION_TOOL_DEFINITIONS,
} from '../src/toolDefinitions';

function findChatGptTool(id: string) {
  const tool = CHATGPT_TOOL_DEFINITIONS.find((entry) => entry.id === id);
  expect(tool).toBeDefined();
  return tool!;
}

function findContractTool(id: string) {
  const tool = CONTRACT_TOOL_DEFINITIONS.find((entry) => entry.id === id);
  expect(tool).toBeDefined();
  return tool!;
}

function findClientIntegrationTool(id: string) {
  const tool = CLIENT_INTEGRATION_TOOL_DEFINITIONS.find(
    (entry) => entry.id === id
  );
  expect(tool).toBeDefined();
  return tool!;
}

describe('agent spawn budget and model controls', () => {
  it('accepts omitted routing controls for OrgX auto-routing', () => {
    const tool = findChatGptTool('spawn_agent_task');
    const schema = z.object(tool.inputSchema);

    const parsed = schema.safeParse({
      agent: 'engineering-agent',
      task: 'Open a PR or return a command-level blocker.',
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts explicit verification controls on spawn_agent_task', () => {
    const tool = findChatGptTool('spawn_agent_task');
    const schema = z.object(tool.inputSchema);

    const parsed = schema.safeParse({
      agent: 'engineering-agent',
      task: 'Open a PR or return a command-level blocker.',
      model_tier: 'standard',
      budget_mode: 'cheapest_valid',
      provider: 'openai',
      model: 'gpt-5.4-nano',
      max_cost_usd: 0.5,
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts the same routing controls on the v2 orgx_spawn contract', () => {
    const tool = findContractTool('orgx_spawn');
    const schema = z.object(tool.inputSchema);

    const parsed = schema.safeParse({
      action: 'spawn',
      agent_type: 'sales',
      title: 'Draft a first outbound wedge',
      instructions:
        'Return ICP, offer, target segment, sequence, objections, and send plan.',
      model_tier: 'standard',
      budget_mode: 'cheapest_valid',
      provider: 'auto',
      max_cost_usd: 0.25,
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts estimate-only routing checks on the v2 orgx_spawn contract', () => {
    const tool = findContractTool('orgx_spawn');
    const schema = z.object(tool.inputSchema);

    const parsed = schema.safeParse({
      action: 'estimate',
      agent_type: 'operations',
      title: 'Prepare the overnight canary budget envelope',
      model_tier: 'standard',
      budget_mode: 'cheapest_valid',
      provider: 'auto',
      max_cost_usd: 0.5,
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects negative per-task cost caps', () => {
    const tool = findChatGptTool('spawn_agent_task');
    const schema = z.object(tool.inputSchema);

    const parsed = schema.safeParse({
      agent: 'marketing-agent',
      task: 'Draft a launch note.',
      max_cost_usd: -1,
    });

    expect(parsed.success).toBe(false);
  });

  it('exposes estimate inputs on classify_task_model for legacy clients', () => {
    const tool = findClientIntegrationTool('classify_task_model');
    const schema = z.object(tool.inputSchema);

    const parsed = schema.safeParse({
      title: 'Audit autonomous loop receipts',
      domain: 'operations',
      model_tier: 'standard',
      budget_mode: 'cheapest_valid',
      provider: 'auto',
      max_cost_usd: 0.25,
      estimate_only: true,
    });

    expect(parsed.success).toBe(true);
  });

  it('describes estimate mode as non-dispatching cost context', () => {
    const tool = findContractTool('orgx_spawn');

    expect(tool.description).toContain('action="estimate"');
    expect(tool.description).toContain('without dispatching work');
    expect(tool.description).toContain('candidate routes');
  });
});
