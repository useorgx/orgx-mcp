import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AUTHORIZATION_PRESETS } from '../src/authorizationPolicy';
import { CLAUDE_DIRECTORY_TOOL_ADAPTERS } from '../src/claudeDirectoryTools';
import { createEmptyMcpActivationState } from '../src/mcpActivationTracker';
import { createEmptyMcpSessionReentryState } from '../src/welcomeBackContext';

vi.mock('agents/mcp', () => ({
  McpAgent: class {
    static serve() { return { fetch: vi.fn(async () => new Response(null, { status: 501 })) }; }
    static serveSSE() { return { fetch: vi.fn(async () => new Response(null, { status: 501 })) }; }
  },
}));
vi.mock('../src/oauth', () => ({ OAuthState: class {} }));
vi.mock('@sentry/cloudflare', () => ({
  captureException: vi.fn(), captureMessage: vi.fn(),
  wrapMcpServerWithSentry: <T>(server: T) => server,
  withSentry: <T>(_options: unknown, worker: T) => worker,
}));
vi.mock('@cloudflare/workers-oauth-provider', () => ({
  default: class { async fetch() { return new Response(null, { status: 501 }); } },
}));

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const ENTITY_ID = '22222222-2222-4222-8222-222222222222';
const OPERATE_SCOPE = AUTHORIZATION_PRESETS.operate.scopes.join(' ');

const workflowCalls = [
  { name: 'orgx_create_entity', target: 'orgx_write', arguments: {
    type: 'task', title: 'Directory verification fixture', workspace_id: WORKSPACE_ID,
    workstream_id: ENTITY_ID, milestone_id: ENTITY_ID, metadata: { purpose: 'review' },
    idempotency_key: 'directory-create-fixture',
  }, fixed: { operation: 'create' } },
  { name: 'orgx_update_entity', target: 'orgx_write', arguments: {
    type: 'task', id: ENTITY_ID, fields: { title: 'Updated review fixture' },
    idempotency_key: 'directory-update-fixture',
  }, fixed: { operation: 'update' } },
  { name: 'orgx_start_plan', target: 'orgx_plan', arguments: {
    feature_name: 'Directory review', initial_plan: '# Review plan',
    workspace_id: WORKSPACE_ID, idempotency_key: 'directory-plan-fixture',
  }, fixed: { action: 'start' } },
  { name: 'orgx_read_plan', target: 'orgx_plan', arguments: { session_id: ENTITY_ID }, fixed: { action: 'resume' } },
  { name: 'orgx_improve_plan', target: 'orgx_plan', arguments: {
    session_id: ENTITY_ID, plan_content: '# Improved review plan', idempotency_key: 'directory-improve-fixture',
  }, fixed: { action: 'improve' } },
  { name: 'orgx_record_plan_edit', target: 'orgx_plan', arguments: {
    session_id: ENTITY_ID, edit_summary: 'Added verification evidence', idempotency_key: 'directory-edit-fixture',
  }, fixed: { action: 'record_edit' } },
  { name: 'orgx_complete_plan', target: 'orgx_plan', arguments: {
    session_id: ENTITY_ID, plan_content: '# Accepted review plan',
    attach_to: { entity_type: 'task', entity_id: ENTITY_ID }, idempotency_key: 'directory-complete-plan-fixture',
  }, fixed: { action: 'complete' } },
  { name: 'orgx_check_delegation', target: 'orgx_spawn', arguments: {
    action: 'estimate', title: 'Review fixture only', workspace_id: WORKSPACE_ID,
    agent_type: 'engineering', max_cost_usd: 0,
  } },
  { name: 'orgx_delegate_work', target: 'orgx_spawn', arguments: {
    action: 'handoff', task_id: ENTITY_ID, workspace_id: WORKSPACE_ID,
    agent_type: 'engineering', instructions: 'Review fixture only', max_cost_usd: 0,
    idempotency_key: 'directory-delegation-fixture',
  } },
  { name: 'orgx_list_pending_decisions', target: 'orgx_decide', arguments: {
    initiative_id: ENTITY_ID, workspace_id: WORKSPACE_ID,
  }, fixed: { action: 'list_pending' } },
  { name: 'orgx_record_decision', target: 'orgx_decide', arguments: {
    action: 'remember', decision: 'Use the populated review workspace', context: 'Independent reviewer verification',
    initiative_id: ENTITY_ID, workspace_id: WORKSPACE_ID, idempotency_key: 'directory-decision-fixture',
  } },
  { name: 'orgx_open_decision_review', target: 'orgx_decide', arguments: {
    action: 'reject', decision_id: ENTITY_ID, reason: 'Review fixture rationale', workspace_id: WORKSPACE_ID,
  } },
  { name: 'orgx_complete_with_proof', target: 'orgx_act', arguments: {
    type: 'task', id: ENTITY_ID,
    artifact: { artifact_type: 'eng.pull_request', external_url: 'https://github.com/useorgx/orgx-mcp/pull/462' },
    verification: ['Fixture verification only'], idempotency_key: 'directory-proof-fixture',
  }, fixed: { action: 'complete_with_proof' } },
  { name: 'orgx_change_entity_state', target: 'orgx_act', arguments: {
    type: 'task', id: ENTITY_ID, action: 'block', note: 'Review fixture prerequisite missing',
    idempotency_key: 'directory-block-fixture',
  } },
] satisfies Array<{
  name: string; target: string; arguments: Record<string, unknown>; fixed?: Record<string, unknown>;
}>;

let client: Client;
let worker: Record<string, any>;
let canonicalCalls: ReturnType<typeof vi.spyOn>;
let backendEntry: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Network disabled in directory workflow tests', { status: 503 })));

  const { OrgXMcp } = await import('../src/index');
  worker = Object.create(OrgXMcp.prototype);
  worker.props = {
    profile: 'claude-directory', userId: 'directory-workflow-fixture',
    orgxUserId: '33333333-3333-4333-8333-333333333333',
    scope: OPERATE_SCOPE, workspace_id: WORKSPACE_ID,
  };
  worker.ctx = {
    id: { toString: () => 'directory-workflow-fixture' },
    storage: {
      get: vi.fn(async () => undefined), put: vi.fn(async () => undefined),
      sql: { exec: vi.fn(() => []) },
    },
    waitUntil: vi.fn((promise: Promise<unknown>) => promise),
  };
  worker.env = {
    ORGX_API_URL: 'https://api.useorgx.test', ORGX_WEB_URL: 'https://useorgx.test',
    MCP_SERVER_URL: 'https://mcp.useorgx.test', MCP_JWT_SECRET: 'test-only-secret',
    OAUTH_KV: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) },
  };
  worker.sessionContext = {};
  worker.sessionAuth = {};
  worker.sessionSqlInitialized = false;
  worker.mcpActivationState = createEmptyMcpActivationState();
  worker.mcpSessionReentryState = createEmptyMcpSessionReentryState();
  worker._isNewSession = false;
  worker.widgetDebugEvents = [];
  worker.toolResultGuidanceInstalled = false;
  await worker._doInit();

  // Keep the actual canonical entry point, including invocation-time OAuth.
  // Stop before business execution: these tests must never create real data,
  // contact a provider, or spend money to prove adapter and authorization parity.
  canonicalCalls = vi.spyOn(worker, 'executeContractTool');
  backendEntry = vi.fn(async () => ({
    content: [{ type: 'text', text: 'Canonical workflow test receipt' }],
    structuredContent: { ok: true, fixture: true },
  }));
  worker.withOrgx = backendEntry;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'directory-workflow-contract', version: '1.0.0' });
  await worker.server.connect(serverTransport);
  await client.connect(clientTransport);
}, 30000);

afterAll(async () => {
  if (client && worker?.server) await Promise.allSettled([client.close(), worker.server.close()]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Claude directory canonical workflow adapters', () => {
  it('covers every new operation adapter with a bounded SDK call', () => {
    expect(workflowCalls.map((call) => call.name).sort()).toEqual(
      CLAUDE_DIRECTORY_TOOL_ADAPTERS.map((tool) => tool.id).sort()
    );
  });

  it.each(workflowCalls)('$name preserves the workflow fields and canonical operation', async (call) => {
    canonicalCalls.mockClear();
    backendEntry.mockClear();
    const result = await client.callTool({ name: call.name, arguments: call.arguments });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(canonicalCalls).toHaveBeenCalledTimes(1);
    expect(canonicalCalls.mock.calls[0]?.[0]).toBe(call.target);
    expect(canonicalCalls.mock.calls[0]?.[1]).toMatchObject({ ...call.arguments, ...call.fixed });
    expect(backendEntry).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({ ok: true, fixture: true });
  });

  it.each([
    ['orgx_create_entity', 'operation', 'update', 'create'],
    ['orgx_update_entity', 'operation', 'create', 'update'],
    ['orgx_start_plan', 'action', 'resume', 'start'],
    ['orgx_read_plan', 'action', 'complete', 'resume'],
    ['orgx_list_pending_decisions', 'action', 'approve', 'list_pending'],
    ['orgx_complete_with_proof', 'action', 'delete', 'complete_with_proof'],
  ])('%s cannot be widened by a supplied %s discriminator', (id, key, supplied, expected) => {
    const adapter = CLAUDE_DIRECTORY_TOOL_ADAPTERS.find((tool) => tool.id === id)!;
    expect(adapter.toCanonicalArgs({ [key!]: supplied })[key!]).toBe(expected);
    expect(adapter.inputSchema).not.toHaveProperty(key!);
  });

  it.each([
    { name: 'orgx_check_delegation', arguments: { action: 'spawn', title: 'Must not dispatch' } },
    { name: 'orgx_delegate_work', arguments: { action: 'estimate', title: 'Must not become a read' } },
    { name: 'orgx_record_decision', arguments: { action: 'approve', decision: 'Must not approve' } },
    { name: 'orgx_open_decision_review', arguments: { action: 'create', decision_id: ENTITY_ID } },
    { name: 'orgx_change_entity_state', arguments: { type: 'task', id: ENTITY_ID, action: 'delete' } },
    { name: 'orgx_change_entity_state', arguments: { type: 'task', id: ENTITY_ID, action: 'complete' } },
    { name: 'orgx_complete_with_proof', arguments: { type: 'decision', id: ENTITY_ID, artifact: {} } },
    { name: 'orgx_update_entity', arguments: { type: 'task', id: ENTITY_ID } },
    { name: 'orgx_update_entity', arguments: { type: 'task', id: ENTITY_ID, fields: {} } },
    { name: 'orgx_update_entity', arguments: { type: 'task', id: ENTITY_ID, fields: { status: 'done' } } },
    { name: 'orgx_update_entity', arguments: { type: 'task', id: ENTITY_ID, fields: { title: 'Hidden state update', status: 'approved' } } },
    { name: 'orgx_update_entity', arguments: { type: 'decision', id: ENTITY_ID, fields: { title: 'Bypassed approval' } } },
    { name: 'orgx_update_entity', arguments: { type: 'blocker', id: ENTITY_ID, fields: { description: 'Unsupported patch' } } },
    { name: 'orgx_create_entity', arguments: { type: 'decision', title: 'Bypassed decision workflow' } },
    { name: 'orgx_create_entity', arguments: { type: 'studio_content', title: 'Unreviewed studio workflow' } },
    { name: 'orgx_start_plan', arguments: {} },
    { name: 'orgx_improve_plan', arguments: { session_id: ENTITY_ID } },
    { name: 'orgx_complete_with_proof', arguments: { type: 'task', id: ENTITY_ID } },
  ])('$name rejects an invalid operation before entering its canonical handler', async (call) => {
    canonicalCalls.mockClear();
    backendEntry.mockClear();
    const result = await client.callTool({ name: call.name, arguments: call.arguments });
    expect(result.isError, JSON.stringify(result.content)).toBe(true);
    expect(canonicalCalls).not.toHaveBeenCalled();
    expect(backendEntry).not.toHaveBeenCalled();
  });

  it('cannot create a terminal record by smuggling a status into the create operation', async () => {
    canonicalCalls.mockClear();
    backendEntry.mockClear();
    const call = workflowCalls.find((entry) => entry.name === 'orgx_create_entity')!;
    const result = await client.callTool({
      name: call.name,
      arguments: { ...call.arguments, operation: 'update', id: ENTITY_ID, status: 'done' },
    });
    expect(result.isError).not.toBe(true);
    expect(canonicalCalls.mock.calls[0]?.[1]).toMatchObject({ operation: 'create' });
    expect(canonicalCalls.mock.calls[0]?.[1]).not.toHaveProperty('status');
    expect(canonicalCalls.mock.calls[0]?.[1]).not.toHaveProperty('id');
  });

  it('rechecks a reduced OAuth grant after tools were discovered', async () => {
    canonicalCalls.mockClear();
    backendEntry.mockClear();
    const call = workflowCalls.find((entry) => entry.name === 'orgx_update_entity')!;
    worker.props.scope = AUTHORIZATION_PRESETS.read.scopes.join(' ');
    try {
      const result = await client.callTool({ name: call.name, arguments: call.arguments });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: 'insufficient_scope', status: 403,
          details: { required_scopes: ['initiatives:write'] },
        },
      });
      expect(backendEntry).not.toHaveBeenCalled();
    } finally {
      worker.props.scope = OPERATE_SCOPE;
    }
  });

  it('requires both agent and initiative write grants for a handoff', async () => {
    backendEntry.mockClear();
    worker.props.scope = AUTHORIZATION_PRESETS.operate.scopes.filter((scope) => scope !== 'initiatives:write').join(' ');
    const call = workflowCalls.find((entry) => entry.name === 'orgx_delegate_work')!;
    try {
      const result = await client.callTool({ name: call.name, arguments: call.arguments });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: 'insufficient_scope', status: 403,
          details: { required_scopes: ['agents:write', 'initiatives:write'] },
        },
      });
      expect(backendEntry).not.toHaveBeenCalled();
    } finally {
      worker.props.scope = OPERATE_SCOPE;
    }
  });
});
