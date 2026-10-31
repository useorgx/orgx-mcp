import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { backendSupportsAutonomousSpawn, checkAutonomousSpawnSupport } from '../src/autonomousDispatch';
import { CONTRACT_TOOL_DEFINITIONS } from '../src/contractTools';
import { CHATGPT_TOOL_DEFINITIONS } from '../src/toolDefinitions';
import { getWorkflowToolContract } from '../src/workflowTools';
import { buildOrgxSpawnForwardArgs, validateSpawnContract } from '../src/spawnContract';
import { normalizeDispatchContract, applyDispatchContractToArgs } from '../src/dispatchContract';

const catalog = (field: unknown) => ({ tools: [{ id: 'chatgpt.spawn_agent_task',
  parameters: { type: 'object', properties: { autonomous: field } } }] });

describe('autonomous spawn declaration', () => {
  const tools = [
    CONTRACT_TOOL_DEFINITIONS.find((tool) => tool.id === 'orgx_spawn')!,
    CHATGPT_TOOL_DEFINITIONS.find((tool) => tool.id === 'spawn_agent_task')!,
    getWorkflowToolContract('orgx_start_agent_task')!,
  ];
  it.each(tools)('accepts only the narrowing literal on $id', (tool) => {
    const field = (tool.inputSchema as Record<string, z.ZodTypeAny>).autonomous;
    expect(field).toBeDefined();
    expect(field.parse(true)).toBe(true);
    expect(field.parse(undefined)).toBeUndefined();
    for (const value of [false, 'true', 'user', 'autonomous', null, 1, {}]) {
      expect(field.safeParse(value).success).toBe(false);
    }
  });

  it('does not advertise autonomous mode on handoff or launch', () => {
    for (const id of ['orgx_handoff_task', 'orgx_launch_initiative']) {
      expect(getWorkflowToolContract(id)?.inputSchema).not.toHaveProperty('autonomous');
    }
    expect(CHATGPT_TOOL_DEFINITIONS.find((tool) => tool.id === 'handoff_task')?.inputSchema)
      .not.toHaveProperty('autonomous');
    expect(validateSpawnContract('handoff', { task_id: 't', agent_type: 'ops', autonomous: true }).ok).toBe(false);
    expect(validateSpawnContract('spawn', { task_id: 't', autonomous: false }).ok).toBe(false);
  });

  it('preserves the flag, exact route, cap, effects and task through canonical forwarding', () => {
    const tool = getWorkflowToolContract('orgx_start_agent_task')!;
    const args = { task_id: 'task-1', autonomous: true, runtime: 'cloud_openai',
      model: 'gpt-6-luna', provider: 'openai', model_tier: 'standard', max_cost_usd: 1,
      effects: { allowed: [] }, max_parallel: 1, idempotency_key: 'scheduled:1' };
    const canonical = tool.toCanonicalArgs(args);
    const normalized = normalizeDispatchContract(canonical);
    if (!normalized.contract) throw new Error('valid dispatch contract required');
    const bound = applyDispatchContractToArgs(canonical, normalized.contract, null);
    const { runtime: _runtime, ...forwarded } = args;
    expect(buildOrgxSpawnForwardArgs('spawn_agent_task', bound)).toMatchObject({
      ...forwarded, effects: { allowed: [], approval_required: [] },
      execution_target: 'cloud', sdk_backend: 'openai',
    });
    expect(validateSpawnContract(String(canonical.action), canonical).ok).toBe(true);
  });
});

describe('backend autonomous support witness', () => {
  it.each([{ type: 'boolean', enum: [true] }, { type: 'boolean', const: true }])(
    'accepts the literal-true backend declaration %j', (field) => {
      expect(backendSupportsAutonomousSpawn(catalog(field))).toBe(true);
    });
  it.each([undefined, { type: 'boolean' }, { type: 'boolean', enum: [true, false] },
    { type: 'boolean', const: false }, { type: 'string', enum: [true] },
    { type: 'boolean', enum: ['true'] }, { type: 'boolean', const: true, enum: [false] }])('refuses absent or wider contracts %j', (field) => {
      expect(backendSupportsAutonomousSpawn(catalog(field))).toBe(false);
    });
  it.each([null, {}, { tools: [] }, { tools: [{}] }])('refuses malformed discovery %j', (value) => {
    expect(backendSupportsAutonomousSpawn(value)).toBe(false);
  });
  it('does not cache support and fails closed on the next unavailable read', async () => {
    const load = vi.fn().mockResolvedValueOnce(catalog({ type: 'boolean', enum: [true] }))
      .mockRejectedValueOnce(new Error('offline'));
    expect(await checkAutonomousSpawnSupport({ autonomous: true }, load)).toEqual({ ok: true });
    expect(await checkAutonomousSpawnSupport({ autonomous: true }, load))
      .toMatchObject({ ok: false, details: { code: 'autonomous_dispatch_unsupported' } });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
