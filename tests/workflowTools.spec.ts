import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  EXTENDED_WORKFLOW_TOOL_ADAPTERS,
  getWorkflowToolContract,
  resolveWorkflowInvocationSecuritySchemes,
  WORKFLOW_OUTPUT_SCHEMAS,
  WORKFLOW_TOOL_ADAPTERS,
} from '../src/workflowTools';
import { SECURITY_SCHEMES } from '../src/toolDefinitions';

const UUID = '11111111-1111-4111-8111-111111111111';
const PLAN = { initiative: { title: 'Delivery' }, workstreams: [{ name: 'Engineering', milestones: [{ title: 'Release', tasks: [{ title: 'Implement' }] }] }] };

function adapter(id: string) {
  const tool = getWorkflowToolContract(id);
  expect(tool, `Missing workflow operation ${id}`).toBeDefined();
  return tool!;
}

function parse(id: string, args: Record<string, unknown>) {
  return z.object(adapter(id).inputSchema).strict().parse(args);
}

describe('fixed workflow operation contracts', () => {
  it('admits the video specification required by core studio validation and keeps it on the validate action', () => {
    const tool = adapter('orgx_validate_studio_content');
    const spec = { template: 'custom', content: { title: 'Release walkthrough', scenes: [] }, aspectRatio: '16:9' };
    const input = parse(tool.id, { id: UUID, spec });
    expect(tool.toCanonicalArgs(input)).toEqual({ id: UUID, spec, type: 'studio_content', action: 'validate' });
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    expect(() => parse(tool.id, { id: UUID, spec: { content: {} } })).toThrow();
    expect(() => parse(tool.id, { id: UUID, spec: { template: 'custom', content: 'not structured content' } })).toThrow();
    expect(() => parse(tool.id, { id: UUID, spec, action: 'render' })).toThrow();
  });

  it('enumerates every default operation except the separately owned receipt tool', () => {
    expect(WORKFLOW_TOOL_ADAPTERS).toHaveLength(35);
    const tools = [...WORKFLOW_TOOL_ADAPTERS, ...EXTENDED_WORKFLOW_TOOL_ADAPTERS];
    expect(new Set(tools.map((tool) => tool.id)).size).toBe(tools.length);
    for (const tool of tools) {
      expect(tool.inputSchema).not.toHaveProperty('action');
      expect(tool.inputSchema).not.toHaveProperty('operation');
      expect(tool.inputSchema).not.toHaveProperty('mode');
      expect(tool.inputSchema).not.toHaveProperty('launch_after_create');
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.securitySchemes).not.toHaveLength(0);
    }
  });

  it('cannot widen a projected operation with unknown discriminators, state or identity', () => {
    const tool = adapter('orgx_create_task');
    const canonical = tool.toCanonicalArgs({ title: 'Write docs', workstream_id: UUID,
      action: 'delete', operation: 'update', type: 'decision', status: 'approved',
      user_id: 'someone-else', force: true, _context: { client: { name: 'chatgpt' } },
    });
    expect(canonical).toEqual({ title: 'Write docs', workstream_id: UUID, operation: 'create', type: 'task', _context: { client: { name: 'chatgpt' } } });
    expect(() => parse(tool.id, { title: 'Write docs', workstream_id: UUID, action: 'delete' })).toThrow();
    expect(() => parse(tool.id, { title: 'Write docs' })).toThrow();
  });

  it('uses named receipt operations instead of a hidden read router inside entity search', () => {
    const search = adapter('orgx_search');
    expect(search.toCanonicalArgs(parse(search.id, { type: 'task', query: 'login', limit: 10 })))
      .toEqual({ type: 'task', query: 'login', limit: 10, scope: 'entities' });
    for (const selector of [{ scope: 'work_ledger' }, { view: 'review' }, { receipt_id: UUID }, { workstream_id: UUID }]) {
      expect(() => parse(search.id, selector)).toThrow();
      expect(search.toCanonicalArgs(selector)).toEqual({ scope: 'entities' });
    }
    expect(search.description).not.toMatch(/orgx_recommend|orgx_bootstrap/);
    expect(adapter('orgx_inspect').description).not.toMatch(/orgx_recommend|orgx_bootstrap/);
    expect(adapter('orgx_get_workspace_context')._meta['openai/toolInvocation/invoking']).not.toMatch(/bootstrap/i);
  });

  it('prevents status, review and execution-policy writes through content patches', () => {
    expect(parse('orgx_update_work', { type: 'task', id: UUID, fields: { title: 'Updated', metadata: { notes: 'For review', tags: ['docs'] } } })).toBeDefined();
    for (const fields of [{}, { status: 'completed' }, { owner_id: UUID }, { metadata: { approval: 'approved' } }, { metadata: { live: { visibility: 'public' } } }, { metadata: { execution_policy: { enabled: true } } }]) {
      expect(() => parse('orgx_update_work', { type: 'task', id: UUID, fields })).toThrow();
    }
    expect(() => parse('orgx_update_work', { type: 'decision', id: UUID, fields: { title: 'Bypass' } })).toThrow();
  });

  it('requires existing tasks for start and both task and specialist for handoff', () => {
    expect(() => parse('orgx_start_agent_task', { title: 'Ad hoc' })).toThrow();
    expect(() => parse('orgx_handoff_task', { task_id: UUID })).toThrow();
    expect(adapter('orgx_handoff_task').toCanonicalArgs(parse('orgx_handoff_task', { task_id: UUID, agent_type: 'engineering' }))).toMatchObject({ action: 'handoff' });
    for (const toolId of ['orgx_handoff_task', 'orgx_launch_initiative', 'orgx_pause_work', 'orgx_resume_work', 'orgx_retry_work', 'orgx_cancel_work']) {
      expect(resolveWorkflowInvocationSecuritySchemes(toolId, { task_id: UUID, agent_type: 'engineering', level: 'task', id: UUID })).toEqual(SECURITY_SCHEMES.handoffRequiresAuth);
    }
  });

  it('separates fixed permission and classification checks from dispatch', () => {
    for (const toolId of ['orgx_estimate_agent_task', 'orgx_check_agent_delegation', 'orgx_classify_agent_task']) {
      expect(adapter(toolId).annotations.readOnlyHint).toBe(true);
      expect(resolveWorkflowInvocationSecuritySchemes(toolId, { action: 'spawn', task: { task_id: UUID }, title: 'Read', agent_type: 'engineering' })).toEqual(SECURITY_SCHEMES.agentReadRequiresAuth);
      expect(adapter(toolId).toCanonicalArgs({ action: 'spawn', task: { task_id: UUID }, title: 'Read', agent_type: 'engineering' }).action).not.toBe('spawn');
    }
    expect(adapter('orgx_estimate_agent_task').toCanonicalArgs(parse('orgx_estimate_agent_task', { task: { task_id: UUID } }))).toEqual({ task_id: UUID, action: 'estimate' });
    expect(() => parse('orgx_estimate_agent_task', { task: {} })).toThrow();
  });

  it('accepts the scaffold widget launch payload and fixes its initiative target', () => {
    const tool = adapter('orgx_launch_initiative');
    const args = parse(tool.id, { initiative_id: UUID });
    expect(tool.toCanonicalArgs(args)).toEqual({ id: UUID, type: 'initiative', action: 'launch' });
    expect(tool.toCanonicalArgs({ ...args, id: 'another-id', type: 'task', action: 'delete' })).toEqual({ id: UUID, type: 'initiative', action: 'launch' });
    expect(() => parse(tool.id, { id: UUID })).toThrow();
    expect(resolveWorkflowInvocationSecuritySchemes(tool.id, args)).toEqual(SECURITY_SCHEMES.handoffRequiresAuth);
  });

  it('preserves the authoritative revision contract when saving a plan', () => {
    const tool = adapter('orgx_save_plan');
    expect(() => parse(tool.id, { session_id: UUID, plan_content: '# Plan' })).toThrow();
    const args = parse(tool.id, { session_id: UUID, plan_content: '# Plan', expected_version: 3, edit_summary: 'Added acceptance criteria' });
    expect(tool.backendRequest!(args)).toEqual({ method: 'POST', path: '/api/v1/workflows/save-plan',
      body: { session_id: UUID, plan: '# Plan', expected_version: 3, edit_summary: 'Added acceptance criteria' }, headers: undefined,
    });
    expect(tool.annotations.idempotentHint).toBe(false);
    expect(adapter('orgx_record_plan_edit').toCanonicalArgs({ session_id: UUID, edit_summary: 'Feedback', plan_content: '# Overwrite' })).toEqual({ session_id: UUID, edit_summary: 'Feedback', action: 'record_edit' });
  });

  it('completes the current plan revision through the scoped service and reports attachment failures separately', () => {
    const tool = adapter('orgx_complete_plan');
    const base = { session_id: `orgx://plan_session/${UUID}`, plan_content: '# Final plan', expected_version: 3 };
    expect(() => parse(tool.id, { session_id: UUID, plan_content: '# Stale final plan' })).toThrow();
    expect(() => parse(tool.id, { ...base, idempotency_key: 'no-write-replay' })).toThrow();
    expect(() => parse(tool.id, { ...base, attach_to: { entity_type: 'task', entity_id: UUID } })).toThrow();
    expect(() => parse(tool.id, { ...base, plan_content: '   ' })).toThrow();
    const args = parse(tool.id, { ...base, workspace_id: UUID, attach_to: [{ entity_type: 'task', entity_id: UUID }] });
    expect(tool.backendRequest!(args)).toEqual({ method: 'POST', path: '/api/v1/workflows/complete-plan', body: args });
    expect(tool.annotations.idempotentHint).toBe(false);
    const completed = {
      data: { id: UUID, session_id: UUID, uuid: UUID, uri: `orgx://plan_session/${UUID}`,
        accepted_id_forms: ['uuid', 'orgx://plan_session/<uuid>'], plan_version: 4,
        plan_ref: { type: 'plan_session', id: UUID, workspace_id: UUID, version: 4 },
        title: 'Plan', feature_name: null, current_plan: '# Final plan', status: 'completed', updated_at: '2026-10-09T00:00:00Z',
        partial: true, context_attachments: { requested: 1, attached_count: 0, skipped_count: 0,
          errors: [{ entity_type: 'task', entity_id: UUID, error: 'Target changed while attaching' }] },
      }, meta: { apiVersion: '1', workspaceId: UUID },
    };
    expect(WORKFLOW_OUTPUT_SCHEMAS.orgx_complete_plan.parse(completed)).toEqual(completed);
    expect(() => WORKFLOW_OUTPUT_SCHEMAS.orgx_complete_plan.parse({ ...completed, data: { ...completed.data, status: 'active' } })).toThrow();
  });

  it('keeps an optional plan-create replay key in the header and out of saved plan content', () => {
    const tool = adapter('orgx_start_plan');
    expect(tool.backendRequest!(parse(tool.id, { title: 'Plan', workspace_id: UUID, idempotency_key: 'create-plan-once' }))).toEqual({
      method: 'POST', path: '/api/v1/workflows/save-plan',
      body: { title: 'Plan', plan: '', workspace_id: UUID }, headers: { 'Idempotency-Key': 'create-plan-once' },
    });
    expect(tool.backendRequest!(parse(tool.id, { title: 'Unkeyed plan' })).headers).toBeUndefined();
    expect(tool.annotations.idempotentHint).toBe(false);
    expect(() => parse('orgx_save_plan', { session_id: UUID, plan_content: '# Plan', expected_version: 1, idempotency_key: 'cannot-replay-updates' })).toThrow();
  });

  it('requires a declared hierarchy and retry key while fixing creation to private', () => {
    const tool = adapter('orgx_create_initiative_hierarchy');
    expect(() => parse(tool.id, { plan: PLAN })).toThrow();
    expect(() => parse(tool.id, { plan: { ...PLAN, force: true }, idempotency_key: 'fixture-key' })).toThrow();
    const args = parse(tool.id, { plan: PLAN, workspace_id: UUID, idempotency_key: 'fixture-key' });
    const request = tool.backendRequest!({ ...args, action: 'launch', mode: 'launch', visibility: 'public', user_id: UUID });
    expect(request).toEqual({ method: 'POST', path: '/api/v1/workflows/scaffold-initiative',
      body: { workspace_id: UUID, plan: PLAN, visibility: 'private' }, headers: { 'Idempotency-Key': 'fixture-key' },
    });
    expect(adapter('orgx_validate_initiative_plan').annotations.readOnlyHint).toBe(true);
    expect(tool._meta).toHaveProperty('openai/outputTemplate');
  });

  it('does not permit attaching self-approved proof or incomplete URL-only previews', () => {
    const base = { type: 'task', id: UUID, name: 'Deliverable', artifact_type: 'eng.pull_request', location: { external_url: 'https://example.com/proof' } };
    const tool = adapter('orgx_attach_artifact');
    expect(tool.toCanonicalArgs(parse(tool.id, base))).toMatchObject({ status: 'in_review', external_url: 'https://example.com/proof' });
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    expect(tool.description).toMatch(/automatic evaluation.*external model providers.*model costs/);
    expect(() => parse(tool.id, { ...base, status: 'approved' })).toThrow();
    expect(() => parse('orgx_complete_work_with_proof', { type: 'task', id: UUID, artifact: { artifact_type: 'eng.pull_request', preview_markdown: '# Claimed proof' } })).toThrow();
    expect(() => parse('orgx_complete_work_with_proof', { type: 'task', id: UUID, artifact: { artifact_type: 'eng.pull_request', external_url: 'https://example.com/proof', status: 'approved' } })).toThrow();
  });

  it('opens full human review without a model-supplied ruling', () => {
    const tool = adapter('orgx_open_decision_review');
    expect(() => parse(tool.id, { decision_id: UUID, action: 'approve' })).toThrow();
    expect(tool.backendRequest!({ decision_id: UUID, action: 'approve', reason: 'Bypass', workspace_id: UUID })).toEqual({ method: 'GET', path: `/api/v1/workflows/decision-review/${UUID}?workspace_id=${UUID}&widget_meta=1` });
    expect(resolveWorkflowInvocationSecuritySchemes(tool.id, { decision_id: UUID })).toEqual(SECURITY_SCHEMES.decisionReadRequiresAuth);
  });

  it('checks operation-status resource domain instead of an unrelated decision grant', () => {
    expect(resolveWorkflowInvocationSecuritySchemes('orgx_get_operation_status', { operation_id: `run:${UUID}` })).toEqual(SECURITY_SCHEMES.agentReadRequiresAuth);
    expect(resolveWorkflowInvocationSecuritySchemes('orgx_get_operation_status', { kind: 'command', id: UUID })).toEqual(SECURITY_SCHEMES.entityReadRequiresAuth);
    expect(resolveWorkflowInvocationSecuritySchemes('orgx_get_operation_status', { kind: 'decision', id: UUID })).toEqual(SECURITY_SCHEMES.decisionReadRequiresAuth);
  });

  it('binds an exact transition path and a supported target instead of legacy action aliases', () => {
    const tool = adapter('orgx_reassign_streams_work');
    expect(() => parse(tool.id, { type: 'workstream', id: UUID })).toThrow();
    expect(tool.backendRequest!(parse(tool.id, { type: 'initiative', id: UUID }))).toEqual({ method: 'POST', path: `/api/entities/initiative/${UUID}/reassign_streams`, body: {}, headers: undefined });
    expect(() => parse('orgx_start_work', { type: 'decision', id: UUID })).toThrow();
  });

  it('validates the direct plan service envelope including a partial edit-history failure', () => {
    const result = { data: { id: UUID, session_id: UUID, uuid: UUID, uri: `orgx://plan_session/${UUID}`, accepted_id_forms: ['uuid', 'orgx://plan_session/<uuid>'], plan_version: 4,
      plan_ref: { type: 'plan_session', id: UUID, workspace_id: UUID, version: 4 }, title: 'Plan', feature_name: null, current_plan: '# Saved', status: 'active', updated_at: '2026-10-08T00:00:00Z',
      edit_record: { status: 'failed', message: 'Saved, edit history unavailable' },
    }, meta: { apiVersion: '1', workspaceId: UUID } };
    expect(WORKFLOW_OUTPUT_SCHEMAS.orgx_save_plan!.parse(result)).toEqual(result);
    expect(() => WORKFLOW_OUTPUT_SCHEMAS.orgx_save_plan!.parse({ ...result, human_approval_token: 'must-never-be-model-visible' })).toThrow();
  });
});


it('keeps entity lifecycle completion distinct from the versioned ledger command', () => {
  expect(getWorkflowToolContract('orgx_complete_work')).toBeUndefined();
  const lifecycle = adapter('orgx_complete_entity');
  expect(lifecycle.toCanonicalArgs(parse(lifecycle.id, { type: 'task', id: UUID })))
    .toMatchObject({ action: 'complete', type: 'task', id: UUID });
  expect(() => parse(lifecycle.id, { task_id: UUID, expected_updated_at: '2026-10-08T00:00:00Z', expected_aggregate_version: 1 })).toThrow();
});
