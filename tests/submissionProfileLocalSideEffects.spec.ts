import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

import { createEmptyMcpActivationState } from '../src/mcpActivationTracker';
import { AUTHORIZATION_PRESETS } from '../src/authorizationPolicy';
import {
  CHATGPT_PUBLIC_SURFACE,
  CLAUDE_DIRECTORY_SURFACE,
  LEGACY_CLAUDE_DIRECTORY_SURFACE,
  TOOL_PROFILES,
} from '../src/toolProfiles';
import { buildAgentWorkReceiptImportRequest } from '../src/agentWorkReceiptV1';
import { WORKFLOW_TOOL_ADAPTERS } from '../src/workflowTools';
import { RECEIPT_OPERATION_TOOLS } from '../src/receiptOperationTools';
import {
  createEmptyMcpSessionReentryState,
  MCP_SESSION_REENTRY_STORAGE_KEY,
} from '../src/welcomeBackContext';

const apiMocks = vi.hoisted(() => ({
  callOrgxApiJson: vi.fn(),
  callOrgxApiRaw: vi.fn(),
  fetchContextPack: vi.fn(),
  fetchContextPreparation: vi.fn(),
  captureWorkerPosthogEvent: vi.fn(),
}));

vi.mock('agents/mcp', () => ({
  McpAgent: class McpAgent {
    async getInitializeRequest() { return (this as any).ctx.storage.get('initializeRequest'); }
    async updateProps(props: unknown) {
      await (this as any).ctx.storage.put('props', props ?? {});
      (this as any).props = props;
    }
    static serve() {
      return {
        fetch: vi.fn(async () => new Response(null, { status: 501 })),
      };
    }

    static serveSSE() {
      return {
        fetch: vi.fn(async () => new Response(null, { status: 501 })),
      };
    }
  },
}));

vi.mock('../src/oauth', () => ({
  OAuthState: class OAuthState {},
}));

vi.mock('@sentry/cloudflare', () => ({
  captureException: vi.fn(),
  wrapMcpServerWithSentry: <T>(server: T) => server,
  withSentry: <T>(_options: unknown, worker: T) => worker,
}));

vi.mock('@cloudflare/workers-oauth-provider', () => ({
  default: class OAuthProvider {
    async fetch() {
      return new Response(null, { status: 501 });
    }
  },
}));

vi.mock('../src/orgxApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/orgxApi')>();
  return {
    ...actual,
    callOrgxApiJson: apiMocks.callOrgxApiJson,
    callOrgxApiRaw: apiMocks.callOrgxApiRaw,
  };
});

vi.mock('../src/contextPack', () => ({
  fetchContextPack: apiMocks.fetchContextPack,
  fetchContextPreparation: apiMocks.fetchContextPreparation,
}));

vi.mock('../src/posthogTelemetry', () => ({
  captureWorkerPosthogEvent: apiMocks.captureWorkerPosthogEvent,
  resolveAnonymousDistinctId: () => 'directory-reviewer',
}));

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const INITIATIVE_ID = '22222222-2222-4222-8222-222222222222';
const PLAN_ID = '44444444-4444-4444-8444-444444444444';
const ARTIFACT_ID = '55555555-5555-4555-8555-555555555555';
const RECEIPT_DOCUMENT = buildAgentWorkReceiptImportRequest({
  receipt_type: 'proof', summary: 'Login test passed',
  evidence: { links: ['https://example.com/test'] }, verification_status: 'passed',
}, { workspaceId: WORKSPACE_ID, receiptId: 'informational-receipt', issuedAt: '2026-10-08T12:00:00.000Z' }).body.receipt;

type SubmissionProfile = 'chatgpt' | 'claude-directory' | 'legacy' | 'claude-directory-legacy';

type WriteSpies = {
  storagePut: ReturnType<typeof vi.fn>;
  sqlExec: ReturnType<typeof vi.fn>;
  oauthPut: ReturnType<typeof vi.fn>;
  waitUntil: ReturnType<typeof vi.fn>;
  consoleInfo: ReturnType<typeof vi.spyOn>;
  consoleWarn: ReturnType<typeof vi.spyOn>;
  consoleError: ReturnType<typeof vi.spyOn>;
};

const LEGACY_INFORMATIONAL_TOOL_CALLS = [
  {
    name: 'orgx_search',
    label: 'orgx_search mixed relevance -> metered upstream path',
    arguments: {
      query: 'Search Copilot readiness',
      workspace_id: WORKSPACE_ID,
      limit: 10,
    },
  },
  {
    name: 'orgx_search',
    label: 'orgx_search typed collection',
    arguments: {
      type: 'initiative',
      workspace_id: WORKSPACE_ID,
      limit: 10,
    },
  },
  {
    name: 'orgx_inspect',
    arguments: { type: 'initiative', id: INITIATIVE_ID },
  },
  {
    name: 'orgx_inspect',
    label: 'orgx_inspect -> resume_plan_session',
    arguments: { type: 'plan_session', id: INITIATIVE_ID },
  },
  {
    name: 'orgx_recommend',
    arguments: {
      mode: 'morning_brief',
      period: 'week',
      workspace_id: WORKSPACE_ID,
    },
  },
  {
    name: 'orgx_recommend',
    label: 'orgx_recommend -> recommend_next_action',
    arguments: { workspace_id: WORKSPACE_ID },
  },
  {
    name: 'get_agent_status',
    arguments: { workspace_id: WORKSPACE_ID },
  },
  {
    name: 'get_initiative_pulse',
    arguments: { initiative_id: INITIATIVE_ID },
  },
  {
    name: 'review_artifact',
    arguments: { workspace_id: WORKSPACE_ID },
  },
  {
    name: 'get_morning_brief',
    arguments: { workspace_id: WORKSPACE_ID },
  },
  {
    name: 'get_operator_chronicle',
    arguments: { workspace_id: WORKSPACE_ID, period: 'week' },
  },
  {
    name: 'check_execution_readiness',
    arguments: { workspace_id: WORKSPACE_ID },
  },
] as const;

const SHARED_INFORMATIONAL_TOOL_CALLS = [
  { name: 'orgx_get_workspace_context', arguments: { workspace_id: WORKSPACE_ID } },
  ...LEGACY_INFORMATIONAL_TOOL_CALLS.filter((call) => ['orgx_search', 'orgx_inspect'].includes(call.name)),
  { name: 'orgx_get_operator_brief', arguments: { workspace_id: WORKSPACE_ID, period: 'week' } },
  { name: 'orgx_get_next_actions', arguments: { workspace_id: WORKSPACE_ID } },
  { name: 'orgx_get_agent_status', arguments: { workspace_id: WORKSPACE_ID } },
  { name: 'orgx_get_initiative_progress', arguments: { initiative_id: INITIATIVE_ID } },
  { name: 'orgx_get_operation_status', arguments: { operation_id: `command:${PLAN_ID}` } },
  { name: 'orgx_check_execution_readiness', arguments: { workspace_id: WORKSPACE_ID } },
  { name: 'orgx_read_plan', arguments: { session_id: PLAN_ID, workspace_id: WORKSPACE_ID } },
  { name: 'orgx_validate_initiative_plan', arguments: { workspace_id: WORKSPACE_ID, plan: { initiative: { title: 'Login' }, workstreams: [{ name: 'Engineering' }] } } },
  { name: 'orgx_estimate_agent_task', arguments: { task: { title: 'Implement login' }, workspace_id: WORKSPACE_ID } },
  { name: 'orgx_list_pending_decisions', arguments: { workspace_id: WORKSPACE_ID } },
  { name: 'orgx_open_decision_review', arguments: { decision_id: PLAN_ID, workspace_id: WORKSPACE_ID } },
  { name: 'orgx_open_artifact_review', label: 'orgx_open_artifact_review empty queue', arguments: { workspace_id: WORKSPACE_ID } },
  { name: 'orgx_open_artifact_review', label: 'orgx_open_artifact_review explicit artifact', arguments: { artifact_id: ARTIFACT_ID, workspace_id: WORKSPACE_ID } },
  { name: 'orgx_validate_work_receipt', arguments: { receipt: RECEIPT_DOCUMENT } },
  { name: 'orgx_get_work_receipt', arguments: { workspace_id: WORKSPACE_ID, receipt_id: 'informational-receipt' } },
  { name: 'orgx_list_work_receipts', arguments: { workspace_id: WORKSPACE_ID } },
  { name: 'orgx_get_receipt_review_queue', arguments: { workspace_id: WORKSPACE_ID } },
] as const;

const METERED_INFORMATIONAL_OPERATIONS = [
  'orgx_search', 'orgx_get_next_actions', 'orgx_get_agent_status', 'orgx_get_initiative_progress',
] as const;

function successfulApiResponse(path: string, init?: RequestInit): Response {
  const workflowMeta = { apiVersion: '1', workspaceId: WORKSPACE_ID };
  if (path.startsWith('/api/v1/workflows/workspace-context')) {
    return Response.json({ data: { workspace: { id: WORKSPACE_ID, name: 'Directory review' }, references: [] }, meta: workflowMeta });
  }
  if (path.startsWith('/api/v1/workflows/read-plan')) {
    return Response.json({ data: {
      id: PLAN_ID, session_id: PLAN_ID, uuid: PLAN_ID, uri: `orgx://plan_session/${PLAN_ID}`,
      accepted_id_forms: ['uuid', 'orgx://plan_session/<uuid>'], plan_version: 1,
      plan_ref: { type: 'plan_session', id: PLAN_ID, workspace_id: WORKSPACE_ID, version: 1 },
      title: 'Login', feature_name: null, current_plan: '# Login', status: 'active', updated_at: '2026-10-08T12:00:00Z',
    }, meta: workflowMeta });
  }
  if (path === '/api/v1/workflows/validate-initiative-plan') {
    return Response.json({ data: { valid: true, plan_digest: `sha256:${'a'.repeat(64)}`, findings: [] }, meta: workflowMeta });
  }
  if (path.startsWith('/api/v1/workflows/decision-review/')) {
    return Response.json({ data: { decision_id: PLAN_ID, decision: { id: PLAN_ID }, review_url: `https://useorgx.test/decisions/${PLAN_ID}`, requires_human_review: true }, meta: workflowMeta,
      _widget_meta: { approval_tokens: { [PLAN_ID]: 'hidden-decision-review-token' } },
    });
  }
  if (path.startsWith('/api/v1/workflows/artifact-review/')) {
    return Response.json({ data: { artifact: { id: ARTIFACT_ID, name: 'Login proof', status: 'in_review' }, reviewContract: null, reviewContractSource: 'canonical' }, meta: workflowMeta });
  }
  if (path === '/api/v1/agent-work-receipts/validate') {
    return Response.json({ ok: true, valid: true, persistence: { stored: false, import_requires_authentication: true } });
  }
  if (path.startsWith('/api/v1/work-ledger/receipts/')) {
    return Response.json({ ok: true, data: { receipt_id: 'ledger-receipt', receipt: RECEIPT_DOCUMENT,
      _widget_meta: { receipt_approval_tokens: { 'informational-receipt': 'hidden-receipt-review-token' }, token_ttl_seconds: 900 },
    } });
  }
  if (path.startsWith('/api/v1/work-ledger/receipts?')) {
    return Response.json({ ok: true, data: { results: [], total: 0, window_days: 120, query: { text: '', filters: {} }, receipts: 0, workstreams: 0 } });
  }
  if (path.startsWith('/api/v1/work-ledger/review?')) {
    return Response.json({ ok: true, data: { items: [], total: 0, criteria_proposals: [], queue_limit: 200, queue_truncated: false, window_days: 120 } });
  }
  if (path === '/api/client/route-task') {
    return Response.json({ ok: true, data: { model_tier: 'balanced', complexity: 'moderate' } });
  }
  if (path === '/api/tools/execute') {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      tool_id?: string;
    };
    if (body.tool_id === 'get_agent_status') {
      return Response.json({ ok: true, data: { agents: [] } });
    }
    if (body.tool_id === 'get_initiative_pulse') {
      return Response.json({
        ok: true,
        data: {
          initiative_id: INITIATIVE_ID,
          status: 'on_track',
          blockers: [],
        },
      });
    }
    if (body.tool_id === 'recommend_next_action') {
      return Response.json({ ok: true, data: { recommendations: [] } });
    }
    if (body.tool_id === 'query_org_memory') {
      return Response.json({ ok: true, data: { results: [] } });
    }
    if (body.tool_id === 'get_pending_decisions') {
      return Response.json({ ok: true, data: { decisions: [], total_pending: 0, message: 'No pending decisions' } });
    }
    if (body.tool_id === 'command_status') {
      return Response.json({ ok: true, data: { kind: 'command', id: PLAN_ID, state: 'succeeded', next_poll_after_ms: null } });
    }
  }

  if (path.startsWith('/api/operator/chronicle')) {
    return Response.json({
      ok: true,
      data: {
        headline: 'Directory review chronicle',
        reportingNarrative: {
          briefMarkdown: '# Directory review chronicle',
        },
      },
    });
  }

  if (path.startsWith('/api/flywheel/briefs')) {
    return Response.json({
      session_id: 'directory-review-session',
      receipts: [],
      exceptions: [],
    });
  }

  if (path.startsWith('/api/cross-pollination/context')) {
    return Response.json({
      artifacts: [],
      decisions: [],
      memories: [],
      _meta: {
        userId: 'directory-reviewer',
        domain: null,
        query: null,
        initiativeId: INITIATIVE_ID,
        retrievedAt: '2026-08-05T00:00:00.000Z',
      },
    });
  }

  if (path.startsWith('/api/entities?')) {
    return Response.json({ data: [] });
  }

  if (path.startsWith('/api/client/credentials/status')) {
    return Response.json({ ok: true, data: { ready: true, missing: [] } });
  }

  return Response.json({});
}

async function createSubmissionProfileHarness(
  profile: SubmissionProfile
) {
  const { OrgXMcp } = await import('../src/index');
  const worker = Object.create(OrgXMcp.prototype) as Record<string, any>;
  const storagePut = vi.fn(async () => undefined);
  const sqlExec = vi.fn(() => []);
  const oauthPut = vi.fn(async () => undefined);
  const waitUntil = vi.fn((promise: Promise<unknown>) => promise);
  const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
  const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

  worker.props = {
    profile,
    userId: 'directory-reviewer',
    orgxUserId: '33333333-3333-4333-8333-333333333333',
    scope: AUTHORIZATION_PRESETS.operate.scopes.join(' '),
    workspace_id: WORKSPACE_ID,
  };
  worker.ctx = {
    id: { toString: () => 'directory-review-session' },
    storage: {
      get: vi.fn(async () => undefined),
      put: storagePut,
      sql: { exec: sqlExec },
    },
    waitUntil,
  };
  worker.env = {
    ORGX_API_URL: 'https://api.useorgx.test',
    ORGX_WEB_URL: 'https://useorgx.test',
    MCP_SERVER_URL: 'https://mcp.useorgx.test',
    MCP_JWT_SECRET: 'test-only-secret',
    OAUTH_KV: {
      get: vi.fn(async () => null),
      put: oauthPut,
    },
  };
  worker.sessionContext = {};
  worker.sessionAuth = {};
  worker.sessionSqlInitialized = false;
  worker.mcpActivationState = createEmptyMcpActivationState();
  worker.mcpSessionReentryState = createEmptyMcpSessionReentryState();
  worker._isNewSession = false;
  worker.widgetDebugEvents = [];
  worker.toolResultGuidanceInstalled = false;

  worker.fetchEntityRecord = vi.fn(async () => ({
    id: INITIATIVE_ID,
    type: 'initiative',
    title: 'Directory review initiative',
  }));
  worker.fetchEntityCollectionPage = vi.fn(async () => ({
    records: [
      {
        id: INITIATIVE_ID,
        type: 'initiative',
        title: 'Directory review initiative',
      },
    ],
    pagination: {
      has_more: false,
      next_cursor: null,
      limit: 10,
      offset: 0,
    },
  }));
  worker.fetchEntityCollection = vi.fn(async () => []);

  apiMocks.callOrgxApiJson.mockImplementation(
    async (_env: unknown, path: string, init?: RequestInit) =>
      successfulApiResponse(path, init)
  );
  apiMocks.fetchContextPack.mockResolvedValue({
    entity: { id: INITIATIVE_ID, type: 'initiative' },
    related: [],
  });
  apiMocks.fetchContextPreparation.mockResolvedValue({
    context_pack: { entity: { id: INITIATIVE_ID, type: 'initiative' }, related: [] },
    context_capsule: {
      schema_version: 'orgx.context-capsule/v1',
      capsule_id: 'capsule_workspace',
    },
    context_delivery: { base_verified: false, mode: 'full' },
  });

  await worker._doInit();

  if (profile === 'claude-directory' || profile === 'claude-directory-legacy') {
    // Directory initialization may read existing protocol/session state, but
    // it must not create, mirror, or log OrgX state of its own.
    expect(storagePut).not.toHaveBeenCalled();
    expect(sqlExec).not.toHaveBeenCalled();
    expect(oauthPut).not.toHaveBeenCalled();
    expect(apiMocks.captureWorkerPosthogEvent).not.toHaveBeenCalled();
    expect(consoleInfo).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  }

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: 'orgx-submission-profile-local-side-effect-test',
    version: '1.0.0',
  });
  await worker.server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    server: worker.server,
    worker,
    spies: {
      storagePut,
      sqlExec,
      oauthPut,
      waitUntil,
      consoleInfo,
      consoleWarn,
      consoleError,
    } satisfies WriteSpies,
  };
}

async function expectNoWorkerLocalSideEffects(params: {
  profile: SubmissionProfile;
  expectedSurface: readonly string[];
  calls: ReadonlyArray<{
    name: string;
    label?: string;
    arguments: Record<string, unknown>;
  }>;
}) {
  const { client, server, worker, spies } = await createSubmissionProfileHarness(
    params.profile
  );

  try {
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
      [...params.expectedSurface].sort()
    );
    if (params.profile === 'chatgpt' || params.profile === 'claude-directory') {
      for (const id of METERED_INFORMATIONAL_OPERATIONS) {
        expect(listed.tools.find((tool) => tool.name === id)?.annotations?.readOnlyHint, id).toBe(false);
      }
      const reviewArtifact = listed.tools.find(
        (tool) => tool.name === 'orgx_open_artifact_review'
      );
      expect(reviewArtifact?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(reviewArtifact?._meta?.['mcp/securitySchemes']).toEqual([
        { type: 'oauth2', scopes: ['initiatives:read'] },
      ]);
    } else {
      for (const id of ['orgx_search', 'orgx_recommend', 'get_agent_status', 'get_initiative_pulse']) {
        expect(listed.tools.find((tool) => tool.name === id)?.annotations?.readOnlyHint, id).toBe(false);
      }
    }

    // The MCP framework can persist transport lifecycle state before tool
    // execution. Reset here so every assertion below is scoped to one tool
    // handler invocation. These spies intentionally cover worker-local effects
    // only: production upstream paths for four tools still record metered MCP
    // allowance usage and therefore advertise readOnlyHint=false.
    worker._isNewSession = true;
    for (const spy of Object.values(spies)) {
      spy.mockClear();
    }
    apiMocks.captureWorkerPosthogEvent.mockClear();

    for (const call of params.calls) {
      const assertionLabel = call.label ?? call.name;
      const stateBefore = {
        sessionContext: structuredClone(worker.sessionContext),
        sessionAuth: structuredClone(worker.sessionAuth),
        activation: structuredClone(worker.mcpActivationState),
        reentry: structuredClone(worker.mcpSessionReentryState),
        debugEvents: structuredClone(worker.widgetDebugEvents),
        toolStats: structuredClone(worker.sessionToolStats),
        flushScheduleId: worker.sessionFlushScheduleId,
        isNewSession: worker._isNewSession,
      };
      const apiCallsBefore = apiMocks.callOrgxApiJson.mock.calls.length;
      const result = await client.callTool({
        name: call.name,
        arguments: call.arguments,
      }).catch((error: unknown) => {
        throw new Error(`${assertionLabel}: ${String(error)}`, { cause: error });
      });

      expect(result.isError, `${assertionLabel}: ${JSON.stringify(result.content)}`).not.toBe(true);
      expect(result.content.length, assertionLabel).toBeGreaterThan(0);
      expect(spies.storagePut, assertionLabel).not.toHaveBeenCalled();
      expect(spies.sqlExec, assertionLabel).not.toHaveBeenCalled();
      expect(spies.oauthPut, assertionLabel).not.toHaveBeenCalled();
      expect(spies.waitUntil, assertionLabel).not.toHaveBeenCalled();
      expect(
        apiMocks.captureWorkerPosthogEvent,
        assertionLabel
      ).not.toHaveBeenCalled();
      expect(spies.consoleInfo, assertionLabel).not.toHaveBeenCalled();
      expect(spies.consoleWarn, assertionLabel).not.toHaveBeenCalled();
      expect(spies.consoleError, assertionLabel).not.toHaveBeenCalled();
      expect(worker.sessionContext, assertionLabel).toEqual(
        stateBefore.sessionContext
      );
      expect(worker.sessionAuth, assertionLabel).toEqual(stateBefore.sessionAuth);
      expect(worker.mcpActivationState, assertionLabel).toEqual(
        stateBefore.activation
      );
      expect(worker.mcpSessionReentryState, assertionLabel).toEqual(
        stateBefore.reentry
      );
      expect(worker.widgetDebugEvents, assertionLabel).toEqual(
        stateBefore.debugEvents
      );
      expect(worker.sessionToolStats, assertionLabel).toEqual(stateBefore.toolStats);
      expect(worker.sessionFlushScheduleId, assertionLabel).toBe(stateBefore.flushScheduleId);
      expect(worker._isNewSession, assertionLabel).toBe(stateBefore.isNewSession);

      // Suppression is local to the worker. These public reads still execute
      // the existing metered backend tool, so readOnlyHint must remain false.
      const meteredDelegate = ({
        orgx_get_next_actions: 'recommend_next_action', orgx_recommend: 'recommend_next_action',
        orgx_get_agent_status: 'get_agent_status', get_agent_status: 'get_agent_status',
        orgx_get_initiative_progress: 'get_initiative_pulse', get_initiative_pulse: 'get_initiative_pulse',
      } as Record<string, string>)[call.name];
      const isNextAction = call.name !== 'orgx_recommend' || call.arguments.mode !== 'morning_brief';
      if (meteredDelegate && isNextAction) {
        const upstreamCalls = apiMocks.callOrgxApiJson.mock.calls.slice(apiCallsBefore);
        expect(upstreamCalls, assertionLabel).toEqual(expect.arrayContaining([
          expect.arrayContaining(['/api/tools/execute', expect.objectContaining({ body: expect.stringContaining(`"tool_id":"${meteredDelegate}"`) })]),
        ]));
      }

      // Partition every call so a later zero-write result cannot hide an
      // earlier mutation.
      for (const spy of Object.values(spies)) {
        spy.mockClear();
      }
      apiMocks.captureWorkerPosthogEvent.mockClear();
    }
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
    spies.consoleInfo.mockRestore();
    spies.consoleWarn.mockRestore();
    spies.consoleError.mockRestore();
  }
}

describe('submission profile worker-local side-effect suppression', () => {
  // Drives informational tools through the full worker surface; see the note in
  // tests/widgetSharedComponentInlining.spec.ts on why the budget is explicit.
  it('covers every shared informational operation, including metered compatibility reads', () => {
    const expected = [
      ...WORKFLOW_TOOL_ADAPTERS.filter((tool) => tool.annotations.readOnlyHint || METERED_INFORMATIONAL_OPERATIONS.includes(tool.id as typeof METERED_INFORMATIONAL_OPERATIONS[number])).map((tool) => tool.id),
      ...RECEIPT_OPERATION_TOOLS.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.id),
    ];
    expect([...new Set(SHARED_INFORMATIONAL_TOOL_CALLS.map((call) => call.name))].sort()).toEqual(expected.sort());
  });

  it('keeps all shared Claude informational operations free of worker-local persistence and logging', async () => {
    await expectNoWorkerLocalSideEffects({
      profile: 'claude-directory',
      expectedSurface: CLAUDE_DIRECTORY_SURFACE,
      calls: SHARED_INFORMATIONAL_TOOL_CALLS,
    });
  }, 20000);

  it('keeps all shared ChatGPT informational operations free of worker-local persistence and logging', async () => {
    await expectNoWorkerLocalSideEffects({
      profile: 'chatgpt',
      expectedSurface: CHATGPT_PUBLIC_SURFACE,
      calls: SHARED_INFORMATIONAL_TOOL_CALLS,
    });
  }, 20000);

  it('preserves informational legacy aliases without worker-local persistence or logging', async () => {
    await expectNoWorkerLocalSideEffects({
      profile: 'legacy',
      expectedSurface: TOOL_PROFILES.legacy.tools!,
      calls: LEGACY_INFORMATIONAL_TOOL_CALLS,
    });
  }, 20000);

  it('preserves the explicit Claude legacy informational inventory without local effects', async () => {
    const legacyTools = new Set<string>(LEGACY_CLAUDE_DIRECTORY_SURFACE);
    await expectNoWorkerLocalSideEffects({
      profile: 'claude-directory-legacy',
      expectedSurface: TOOL_PROFILES['claude-directory-legacy'].tools!,
      calls: LEGACY_INFORMATIONAL_TOOL_CALLS.filter((call) => legacyTools.has(call.name)),
    });
  }, 20000);

  it('keeps stateful legacy bootstrap on the existing persistence path', async () => {
    const { client, server, spies } = await createSubmissionProfileHarness('legacy');
    try {
      for (const spy of Object.values(spies)) {
        spy.mockClear();
      }
      apiMocks.fetchContextPack.mockClear();
      apiMocks.fetchContextPreparation.mockClear();
      apiMocks.fetchContextPreparation.mockResolvedValueOnce({
        context_pack: {
          entity: { id: INITIATIVE_ID, type: 'initiative' },
          frame: {
            anchor: {
              id: INITIATIVE_ID,
              type: 'initiative',
              title: 'Directory review initiative',
            },
          },
        },
        context_capsule: {
          schema_version: 'orgx.context-capsule/v1',
          capsule_id: 'capsule_workspace',
        },
        context_delivery: { base_verified: false, mode: 'full' },
      });

      const result = await client.callTool({
        name: 'orgx_bootstrap',
        arguments: {
          workspace_id: WORKSPACE_ID,
          initiative_id: INITIATIVE_ID,
        },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        workspace: { id: WORKSPACE_ID },
        initiative: { id: INITIATIVE_ID },
        context_pack: {
          entity: { id: INITIATIVE_ID, type: 'initiative' },
        },
        context_capsule: {
          schema_version: 'orgx.context-capsule/v1',
          capsule_id: 'capsule_workspace',
        },
      });
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('Context pack:'),
          }),
        ])
      );
      expect(apiMocks.fetchContextPreparation).toHaveBeenCalledExactlyOnceWith(
        expect.any(Object),
        'directory-reviewer',
        WORKSPACE_ID,
        INITIATIVE_ID
      );
      expect(apiMocks.fetchContextPack).not.toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({
        context_delivery: { base_verified: false, mode: 'full' },
      });
      expect(spies.waitUntil).toHaveBeenCalled();
      expect(spies.storagePut).toHaveBeenCalledWith(
        MCP_SESSION_REENTRY_STORAGE_KEY,
        expect.any(Object)
      );
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
      spies.consoleInfo.mockRestore();
      spies.consoleWarn.mockRestore();
      spies.consoleError.mockRestore();
    }
  });
});
