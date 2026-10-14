import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { buildFailureDetails, diagnoseToolFailure } from '../src/agentErgonomics';
import { idempotencyKeySchema, installIdempotencyKeyGuard, requiresIdempotencyKey } from '../src/idempotencyKeys';
import { callOrgxApiJson, OrgXApiError, parseBackendErrorStructure, parseRetryAfterSeconds } from '../src/orgxApi';
import { getPublicOperationContract } from '../src/publicOperationContracts';
import {
  buildRemedy,
  markTransportFailure,
  REMEDY_CODES,
  RemedyError,
  type FailureDiagnostic,
  type RemedyCode,
  type RemedyFacts,
} from '../src/remedyErrors';
import { canonicalizeToolCallGuidance } from '../src/toolGuidance';
import { resolveProfileToolSet, V2_PUBLIC_SURFACE } from '../src/toolProfiles';
import { withTypedRemedy } from '../src/typedToolErrors';
import { isWidgetOnlyTool } from '../src/widgetToolContract';

const UUID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const v2 = resolveProfileToolSet('v2')!;

/** Reads that record metered usage are annotated as writes but change no work. */
const METERED_READS = new Set(['orgx_search', 'orgx_get_next_actions', 'orgx_get_agent_status', 'orgx_get_initiative_progress']);

const MUTATING_V2_TOOLS = V2_PUBLIC_SURFACE.filter((id) => {
  if (isWidgetOnlyTool(id) || METERED_READS.has(id)) return false;
  return getPublicOperationContract(id)?.annotations?.readOnlyHint === false;
}).sort();

/** Representative arguments per write so remedies can reference the target. */
const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  orgx_start_plan: { title: 'Plan', workspace_id: WORKSPACE, idempotency_key: 'k-1' },
  orgx_save_plan: { session_id: UUID, plan_content: '# Plan', expected_version: 3, idempotency_key: 'k-1' },
  orgx_complete_plan: { session_id: UUID, plan_content: '# Plan', expected_version: 3, idempotency_key: 'k-1' },
  orgx_record_plan_edit: { session_id: UUID, edit_summary: 'Note', idempotency_key: 'k-1' },
  orgx_create_initiative_hierarchy: { plan: {}, workspace_id: WORKSPACE, idempotency_key: 'k-1' },
  orgx_create_initiative: { title: 'Launch', workspace_id: WORKSPACE, idempotency_key: 'k-1' },
  orgx_create_workstream: { title: 'Eng', initiative_id: UUID, idempotency_key: 'k-1' },
  orgx_create_milestone: { title: 'M1', workstream_id: UUID, initiative_id: UUID, idempotency_key: 'k-1' },
  orgx_create_task: { title: 'T1', workstream_id: UUID, idempotency_key: 'k-1' },
  orgx_update_work: { type: 'task', id: UUID, fields: { title: 'x' }, idempotency_key: 'k-1' },
  orgx_start_agent_task: { task_id: UUID, agent_type: 'engineering', idempotency_key: 'k-1' },
  orgx_handoff_task: { task_id: UUID, agent_type: 'design', idempotency_key: 'k-1' },
  orgx_launch_initiative: { initiative_id: UUID, idempotency_key: 'k-1' },
  orgx_pause_work: { level: 'task', id: UUID, idempotency_key: 'k-1' },
  orgx_resume_work: { level: 'task', id: UUID, idempotency_key: 'k-1' },
  orgx_retry_work: { level: 'run', id: UUID, idempotency_key: 'k-1' },
  orgx_cancel_work: { level: 'initiative', id: UUID, idempotency_key: 'k-1' },
  orgx_capture_decision: { decision: 'Use PostHog', initiative_id: UUID, workspace_id: WORKSPACE, idempotency_key: 'k-1' },
  orgx_attach_artifact: { type: 'task', id: UUID, name: 'PR', artifact_type: 'eng.pull_request', location: { external_url: 'https://example.com' }, idempotency_key: 'k-1' },
  orgx_request_independent_artifact_review: { artifact_id: UUID, idempotency_key: 'k-1' },
  orgx_complete_work_with_proof: { type: 'task', id: UUID, artifact: { artifact_type: 'doc', external_url: 'https://example.com' }, idempotency_key: 'k-1' },
  orgx_submit_work_receipt: { receipt: { receipt_id: 'producer:receipt:1' }, workspace_id: WORKSPACE, idempotency_key: 'k-1' },
};

const FACT_VARIANTS: RemedyFacts[] = [
  {},
  { decision_id: UUID, approver: { name: 'Dana', role: 'workspace_admin' }, requested_scope: 'initiatives:write' },
  { operation_id: `command:${UUID}`, retry_after_seconds: 30, limit: { max_cost_usd: 1 }, current_version: 4 },
];

function expectSuggestionsOnV2(diagnostic: FailureDiagnostic, label: string) {
  for (const call of diagnostic.suggested_next_calls ?? []) {
    expect(v2.has(call.tool), `${label}: ${call.tool} is not on the v2 profile`).toBe(true);
    expect(isWidgetOnlyTool(call.tool), `${label}: ${call.tool} is widget-only`).toBe(false);
    // The same canonicalizer that filters live results must keep the call
    // exactly: it names an available tool and satisfies its advertised schema.
    const kept = canonicalizeToolCallGuidance(call, null, 'v2');
    expect(kept, `${label}: ${JSON.stringify(call)} does not satisfy its advertised schema`).toEqual(call);
  }
}

describe('typed remedy suggestions', () => {
  it('enumerates the current v2 writes', () => {
    expect(MUTATING_V2_TOOLS).toEqual(Object.keys(SAMPLE_ARGS).sort());
  });

  for (const code of REMEDY_CODES) {
    it(`${code}: every suggested_next_calls entry names a v2 tool with schema-valid arguments`, () => {
      const contexts: Array<[string, Record<string, unknown> | undefined]> = [
        ['orgx_get_workspace_context', undefined],
        ...MUTATING_V2_TOOLS.map((id) => [id, SAMPLE_ARGS[id]] as [string, Record<string, unknown>]),
      ];
      for (const [toolId, args] of contexts) {
        // A missing-key remedy only exists for tools whose schema requires one.
        if (code === 'idempotency_key_required' && !requiresIdempotencyKey(getPublicOperationContract(toolId)!.inputSchema)) continue;
        for (const facts of FACT_VARIANTS) {
          const diagnostic = buildRemedy(code, { toolId, args, facts });
          expect(diagnostic.code).toBe(code);
          expect(diagnostic.reason.length).toBeGreaterThan(20);
          expect(typeof diagnostic.safe_to_retry).toBe('boolean');
          if (code === 'idempotency_key_required') {
            // Echoes the caller's own (otherwise valid) arguments plus a fresh key;
            // schema validity of the echo is covered end to end below.
            const { idempotency_key: _key, ...rest } = args ?? {};
            expect(diagnostic.suggested_next_calls).toEqual([{ tool: toolId, args: { ...rest, idempotency_key: diagnostic.example_idempotency_key } }]);
            expect(v2.has(toolId)).toBe(true);
            continue;
          }
          expectSuggestionsOnV2(diagnostic, `${code}/${toolId}/${JSON.stringify(facts)}`);
        }
      }
    });
  }

  it('never suggests a retired router or an alternative route around a denial', () => {
    for (const code of REMEDY_CODES) {
      for (const id of MUTATING_V2_TOOLS) {
        const diagnostic = buildRemedy(code, { toolId: id, args: SAMPLE_ARGS[id], facts: FACT_VARIANTS[2] });
        expect(JSON.stringify(diagnostic)).not.toMatch(/orgx_decide\b|orgx_bootstrap|"list_pending"/);
      }
    }
    for (const id of MUTATING_V2_TOOLS) {
      expect(buildRemedy('forbidden', { toolId: id, args: SAMPLE_ARGS[id] }).suggested_next_calls).toEqual([]);
    }
  });

  it('every literal suggestion in the remedy sources names a v2 tool', () => {
    const sources = ['src/remedyErrors.ts', 'src/agentErgonomics.ts', 'src/typedToolErrors.ts', 'src/idempotencyKeys.ts'];
    for (const file of sources) {
      const text = readFileSync(resolve(__dirname, '..', file), 'utf8');
      for (const [, tool] of text.matchAll(/tool:\s*'([a-z_]+)'/g)) {
        expect(v2.has(tool!), `${file} suggests ${tool}`).toBe(true);
      }
    }
  });

  it('suggests only v2 tools across a corpus of real failure shapes', () => {
    const corpus: Array<Parameters<typeof diagnoseToolFailure>[0]> = [];
    for (const id of MUTATING_V2_TOOLS) {
      const args = SAMPLE_ARGS[id];
      for (const status of [402, 403, 404, 409, 412, 423, 429, 500, 502, 503, 504]) {
        corpus.push({ toolId: id, args, mutating: true, error: new OrgXApiError('Upstream said no', 'internal', status) });
      }
      for (const backendCode of ['approval_required', 'version_conflict', 'lease_expired', 'budget_cap_exceeded', 'rate_limit_exceeded', 'permission_denied', 'idempotency_conflict']) {
        corpus.push({ toolId: id, args, mutating: true, error: new OrgXApiError('x', 'internal', 400, { backendCode, backendDetails: { decision_id: UUID, approver_role: 'admin', operation_id: `run:${UUID}` } }) });
      }
      corpus.push({ toolId: id, args, mutating: true, error: markTransportFailure(new OrgXApiError('The request took too long. Please try again.', 'timeout'), 'timeout') });
      corpus.push({ toolId: id, args, mutating: true, error: 'Approval required before launch' });
      corpus.push({ toolId: id, args, mutating: true, error: new RemedyError('stale_lease', 'Lease expired', { lease_holder: 'agent-b' }) });
    }
    for (const input of corpus) expectSuggestionsOnV2(diagnoseToolFailure(input), `${input.toolId}/${String(input.error)}`);
  });
});

describe('typed remedy classification', () => {
  it('reports approval_required with the approver, requested scope and decision review', () => {
    const error = new OrgXApiError('This launch needs approval', 'internal', 403, {
      backendCode: 'approval_required',
      backendDetails: { decision_id: UUID, approver: { id: 'user-9', name: 'Dana', role: 'workspace_admin' }, requested_scope: 'initiatives:write' },
    });
    const diagnostic = diagnoseToolFailure({ toolId: 'orgx_launch_initiative', error, args: SAMPLE_ARGS.orgx_launch_initiative, mutating: true });
    expect(diagnostic).toMatchObject({
      code: 'approval_required', safe_to_retry: false,
      approver: { id: 'user-9', name: 'Dana', role: 'workspace_admin' }, requested_scope: 'initiatives:write',
    });
    expect(diagnostic.suggested_next_calls).toEqual([
      { tool: 'orgx_open_decision_review', args: { decision_id: UUID } },
      { tool: 'orgx_list_pending_decisions', args: { initiative_id: UUID } },
    ]);
    expect(diagnostic.remedy).toContain('Dana (workspace_admin)');
  });

  it('prefers the structured backend code over HTTP status and message text', () => {
    const error = new OrgXApiError('approval required', 'internal', 409, { backendCode: 'lease_held', backendDetails: { lease_holder: 'agent-b' } });
    const diagnostic = diagnoseToolFailure({ toolId: 'orgx_update_work', error, args: SAMPLE_ARGS.orgx_update_work, mutating: true });
    expect(diagnostic).toMatchObject({ code: 'stale_lease', lease_holder: 'agent-b' });
    expect(diagnostic.suggested_next_calls).toEqual([{ tool: 'orgx_inspect', args: { type: 'task', id: UUID } }]);
  });

  it('maps a plan revision conflict to stale_version with refresh instructions', () => {
    const error = new OrgXApiError('Plan changed', 'internal', 409, { backendDetails: { current_version: 5 } });
    const diagnostic = diagnoseToolFailure({ toolId: 'orgx_save_plan', error, args: SAMPLE_ARGS.orgx_save_plan, mutating: true });
    expect(diagnostic).toMatchObject({ code: 'stale_version', current_version: 5, safe_to_retry: false });
    expect(diagnostic.remedy).toMatch(/new idempotency_key/);
    expect(diagnostic.suggested_next_calls).toEqual([{ tool: 'orgx_read_plan', args: { session_id: UUID } }]);
  });

  it('reports limits and retry_after_seconds for budget and rate limits', () => {
    const budget = diagnoseToolFailure({ toolId: 'orgx_start_agent_task', args: SAMPLE_ARGS.orgx_start_agent_task, mutating: true,
      error: 'Spawn blocked: estimated cost exceeds cap.', code: 'budget_cap_exceeded', status: 402,
      details: { limit: { max_cost_usd: 0.5, estimated_cost_usd: 0.9 } } });
    expect(budget).toMatchObject({ code: 'budget_exhausted', limit: { max_cost_usd: 0.5, estimated_cost_usd: 0.9 }, safe_to_retry: false });
    expect(budget.suggested_next_calls?.map((call) => call.tool)).toEqual(['orgx_estimate_agent_task', 'orgx_check_execution_readiness']);

    const rate = diagnoseToolFailure({ toolId: 'orgx_create_task', mutating: true, args: SAMPLE_ARGS.orgx_create_task,
      error: new OrgXApiError('Slow down', 'internal', 429, { retryAfterSeconds: 42, backendDetails: { limit: 120 } }) });
    expect(rate).toMatchObject({ code: 'rate_limited', retry_after_seconds: 42, limit: 120, safe_to_retry: true });
    expect(buildFailureDetails({ toolId: 'orgx_create_task', error: new OrgXApiError('x', 'i', 429) })).toMatchObject({ retry_after_seconds: 60 });
  });

  it('marks unconfirmed writes outcome_unknown with a reconciliation path, but not reads', () => {
    const timeout = () => markTransportFailure(new OrgXApiError('The request took too long. Please try again.', 'timeout'), 'timeout');
    const write = diagnoseToolFailure({ toolId: 'orgx_start_agent_task', error: timeout(), args: SAMPLE_ARGS.orgx_start_agent_task, mutating: true,
      details: { command_id: UUID } });
    expect(write).toMatchObject({ code: 'outcome_unknown', safe_to_retry: true });
    expect(write.remedy).toContain('"k-1"');
    expect(write.suggested_next_calls).toEqual([
      { tool: 'orgx_get_operation_status', args: { operation_id: `command:${UUID}` } },
      { tool: 'orgx_inspect', args: { type: 'task', id: UUID } },
    ]);
    const receipt = diagnoseToolFailure({ toolId: 'orgx_submit_work_receipt', error: new OrgXApiError('down', 'i', 503), args: SAMPLE_ARGS.orgx_submit_work_receipt, mutating: true });
    expect(receipt.suggested_next_calls).toEqual([{ tool: 'orgx_get_work_receipt', args: { receipt_id: 'producer:receipt:1', workspace_id: WORKSPACE } }]);
    expect(diagnoseToolFailure({ toolId: 'orgx_search', error: timeout(), mutating: false }).code).not.toBe('outcome_unknown');
  });

  it('keeps forbidden free of alternative routes', () => {
    const diagnostic = diagnoseToolFailure({ toolId: 'orgx_create_task', mutating: true, args: SAMPLE_ARGS.orgx_create_task,
      error: new OrgXApiError('Access denied. Please check your authentication.', 'internal', 403, { backendDetails: { required_scope: 'initiatives:write' } }) });
    expect(diagnostic).toMatchObject({ code: 'forbidden', safe_to_retry: false, requested_scope: 'initiatives:write', suggested_next_calls: [] });
  });

  it('uses message matching only when nothing structured identifies the failure', () => {
    expect(diagnoseToolFailure({ toolId: 'orgx_launch_initiative', error: 'Launch requires human approval' }).code).toBe('approval_required');
    // The retired catch-all matched any message containing "approval".
    expect(diagnoseToolFailure({ toolId: 'orgx_inspect', error: 'Approval history is unavailable' }).code).toBe('tool_execution_failed');
    expect(diagnoseToolFailure({ toolId: 'orgx_create_task', error: 'socket hang up' }).code).toBe('tool_execution_failed');
  });

  it('prefers an origin RemedyError over every other signal', () => {
    const error = new RemedyError('budget_exhausted', 'Workspace monthly cap reached', { limit: { monthly_usd: 100 }, retry_after_seconds: 3600 });
    expect(diagnoseToolFailure({ toolId: 'orgx_start_agent_task', error, status: 403 })).toMatchObject({
      code: 'budget_exhausted', limit: { monthly_usd: 100 }, retry_after_seconds: 3600,
    });
  });
});

describe('structured API error parsing', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads backend codes and details from either error shape', () => {
    expect(parseBackendErrorStructure({ error: { code: 'APPROVAL_REQUIRED', message: 'x', approver_role: 'admin' } }))
      .toEqual({ backendCode: 'approval_required', backendDetails: { approver_role: 'admin' } });
    expect(parseBackendErrorStructure({ code: 'version_conflict', error: 'Plan changed', details: { current_version: 7 } }))
      .toEqual({ backendCode: 'version_conflict', backendDetails: { current_version: 7 } });
    expect(parseBackendErrorStructure({ error: 'plain' })).toEqual({});
    expect(parseRetryAfterSeconds('30')).toBe(30);
    expect(parseRetryAfterSeconds(new Date(Date.UTC(2026, 0, 1, 0, 1)).toUTCString(), Date.UTC(2026, 0, 1))).toBe(60);
    expect(parseRetryAfterSeconds('soon')).toBeUndefined();
  });

  it('carries the structured code and Retry-After through the API client', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      { error: { code: 'rate_limited', message: 'Too many writes', limit: 60 } },
      { status: 429, headers: { 'retry-after': '17' } },
    )));
    const error = await callOrgxApiJson({ ORGX_API_URL: 'https://api.example.test', ORGX_SERVICE_KEY: 'oxk-test-service-key' }, '/api/test', { method: 'POST', body: '{}' })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(OrgXApiError);
    expect(error).toMatchObject({ statusCode: 429, backendCode: 'rate_limited', retryAfterSeconds: 17, message: 'Too many writes' });
    expect(diagnoseToolFailure({ toolId: 'orgx_create_task', error, mutating: true })).toMatchObject({ code: 'rate_limited', retry_after_seconds: 17, limit: 60 });
  });
});

describe('typed remedies on compatibility error results', () => {
  const failure = (code: string, status: number, details: Record<string, unknown> = {}): CallToolResult => ({
    isError: true, content: [{ type: 'text', text: 'Spawn blocked' }],
    structuredContent: { error: { code, status, message: 'Spawn blocked', details } },
  });

  it('upgrades a structured upstream code and keeps it as upstream_code', () => {
    const result = withTypedRemedy(failure('workspace_budget_blocked', 424, { limit: 100 }), { toolId: 'orgx_start_agent_task', args: SAMPLE_ARGS.orgx_start_agent_task });
    const error = (result.structuredContent as any).error;
    expect(error.code).toBe('budget_exhausted');
    expect(error.details).toMatchObject({ upstream_code: 'workspace_budget_blocked', limit: 100, retryable: false, diagnostic: { code: 'budget_exhausted', limit: 100 } });
  });

  it('leaves OAuth challenges and untyped failures unchanged', () => {
    for (const code of ['insufficient_scope', 'authentication_required']) {
      const original = failure(code, 403);
      expect(withTypedRemedy(original, { toolId: 'orgx_create_task' })).toBe(original);
    }
    const untyped = failure('invalid_input', 400);
    expect(withTypedRemedy(untyped, { toolId: 'orgx_create_task' })).toBe(untyped);
  });
});

describe('required idempotency keys', () => {
  it('every v2 write requires idempotency_key in its advertised schema', () => {
    const missing = MUTATING_V2_TOOLS.filter((id) => !requiresIdempotencyKey(getPublicOperationContract(id)!.inputSchema));
    expect(missing).toEqual([]);
    expect(MUTATING_V2_TOOLS).toEqual(expect.arrayContaining([
      'orgx_create_initiative', 'orgx_create_workstream', 'orgx_create_milestone', 'orgx_create_task', 'orgx_create_initiative_hierarchy',
      'orgx_update_work', 'orgx_start_agent_task', 'orgx_handoff_task', 'orgx_launch_initiative',
      'orgx_pause_work', 'orgx_resume_work', 'orgx_retry_work', 'orgx_cancel_work', 'orgx_capture_decision',
      'orgx_attach_artifact', 'orgx_complete_work_with_proof', 'orgx_submit_work_receipt',
      'orgx_save_plan', 'orgx_complete_plan', 'orgx_record_plan_edit',
    ]));
  });

  async function connectGuarded(authorize?: (name: string) => CallToolResult | null) {
    const server = new McpServer({ name: 'idempotency-guard', version: '1' });
    installIdempotencyKeyGuard(server, authorize ? { authorize } : {});
    const handler = vi.fn(async (args: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: 'ok' }], structuredContent: { ok: true, args } }));
    server.registerTool('orgx_create_task', {
      description: 'Create a task.',
      inputSchema: { title: z.string().min(1), workstream_id: z.string().uuid(), idempotency_key: idempotencyKeySchema },
    }, handler as any);
    const client = new Client({ name: 'idempotency-guard-client', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { server, client, handler };
  }

  it('returns a structured idempotency_key_required remedy and writes nothing', async () => {
    const { server, client, handler } = await connectGuarded();
    try {
      const { tools } = await client.listTools();
      expect(tools[0]?.inputSchema.required).toContain('idempotency_key');
      const result = await client.callTool({ name: 'orgx_create_task', arguments: { title: 'T', workstream_id: UUID } });
      expect(result.isError).toBe(true);
      expect(handler).not.toHaveBeenCalled();
      const error = (result.structuredContent as any).error;
      expect(error).toMatchObject({ code: 'idempotency_key_required', status: 400 });
      expect(error.details).toMatchObject({ field: 'idempotency_key', retryable: true, diagnostic: { required_field: 'idempotency_key' } });
      const example = error.details.diagnostic.example_idempotency_key;
      expect(example).toMatch(/^mcp:create_task:/);
      expect(error.details.suggested_next_calls).toEqual([{ tool: 'orgx_create_task', args: { title: 'T', workstream_id: UUID, idempotency_key: example } }]);

      const blank = await client.callTool({ name: 'orgx_create_task', arguments: { title: 'T', workstream_id: UUID, idempotency_key: '  ' } });
      expect((blank.structuredContent as any).error.code).toBe('idempotency_key_required');
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });

  it('keeps the normal validation error when other fields are invalid too', async () => {
    const { server, client, handler } = await connectGuarded();
    try {
      const result = await client.callTool({ name: 'orgx_create_task', arguments: { title: 'T', workstream_id: 'not-a-uuid' } });
      expect(result.isError).toBe(true);
      expect(handler).not.toHaveBeenCalled();
      expect(JSON.stringify(result.content)).toMatch(/workstream_id/);
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });

  it('runs authorization before the key check and passes keyed calls through', async () => {
    const denied: CallToolResult = { isError: true, content: [{ type: 'text', text: 'grant' }], structuredContent: { error: { code: 'insufficient_scope', message: 'grant' } } };
    const { server, client, handler } = await connectGuarded(() => denied);
    try {
      const unkeyed = await client.callTool({ name: 'orgx_create_task', arguments: { title: 'T', workstream_id: UUID } });
      expect((unkeyed.structuredContent as any).error.code).toBe('insufficient_scope');
      const keyed = await client.callTool({ name: 'orgx_create_task', arguments: { title: 'T', workstream_id: UUID, idempotency_key: 'create-once' } });
      expect(keyed.isError).not.toBe(true);
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0]?.[0]).toMatchObject({ idempotency_key: 'create-once' });
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });
});

// Keep the code list explicit so a new remedy cannot ship untested.
const _exhaustive: Record<RemedyCode, true> = {
  approval_required: true, stale_version: true, stale_lease: true, budget_exhausted: true, rate_limited: true,
  outcome_unknown: true, forbidden: true, idempotency_key_required: true, idempotency_key_conflict: true,
};
void _exhaustive;
