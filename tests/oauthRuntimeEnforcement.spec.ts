import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AUTHORIZATION_PRESETS } from '../src/authorizationPolicy';
import { createEmptyMcpActivationState } from '../src/mcpActivationTracker';
import { attachRequestToolProfile } from '../src/requestToolProfile';
import { createEmptySessionToolStats } from '../src/sessionSummary';
import { CLAUDE_DIRECTORY_SURFACE } from '../src/toolProfiles';
import { createEmptyMcpSessionReentryState } from '../src/welcomeBackContext';

const apiMocks = vi.hoisted(() => ({
  callOrgxApiJson: vi.fn(),
  callOrgxApiRaw: vi.fn(),
  fetchContextPack: vi.fn(),
  fetchContextCapsule: vi.fn(),
  captureWorkerPosthogEvent: vi.fn(),
}));

vi.mock('agents/mcp', () => ({
  McpAgent: class McpAgent {
    static serve() {
      return { fetch: vi.fn(async () => new Response(null, { status: 501 })) };
    }

    static serveSSE() {
      return { fetch: vi.fn(async () => new Response(null, { status: 501 })) };
    }
  },
}));

vi.mock('../src/oauth', () => ({ OAuthState: class OAuthState {} }));

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
  fetchContextCapsule: apiMocks.fetchContextCapsule,
}));

vi.mock('../src/posthogTelemetry', () => ({
  captureWorkerPosthogEvent: apiMocks.captureWorkerPosthogEvent,
  resolveAnonymousDistinctId: () => 'oauth-runtime-test',
}));

const USER_ID = 'oauth-user';
const ORGX_USER_ID = '33333333-3333-4333-8333-333333333333';
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const INITIATIVE_ID = '22222222-2222-4222-8222-222222222222';

function successfulApiResponse(path: string, init?: RequestInit): Response {
  if (path.startsWith('/api/initiatives/')) {
    return Response.json({
      id: INITIATIVE_ID,
      title: 'OAuth-scoped initiative',
      status: 'active',
    });
  }
  if (path === '/api/entities') {
    return Response.json({
      type: 'decision',
      data: { id: 'decision-1', title: 'Scoped decision' },
    });
  }
  if (path === '/api/v1/expectations') {
    return Response.json({
      expectation: {
        id: '44444444-4444-4444-8444-444444444444',
        workspace_id: WORKSPACE_ID,
        state: 'pending',
      },
      replayed: false,
    });
  }
  if (path === '/api/tools/execute') {
    const request = JSON.parse(String(init?.body ?? '{}')) as {
      tool_id?: string;
      args?: { task_id?: string };
    };
    const isDelegation =
      request.tool_id === 'spawn_agent_task' ||
      request.tool_id === 'handoff_task';
    return Response.json({
      ok: true,
      data: isDelegation
        ? {
            delegation_contract: 'durable_delegation_v2',
            task_id: request.args?.task_id ?? 'task-created-by-delegation',
            run_id: 'run-created-by-delegation',
            job_id: 'job-created-by-delegation',
            dispatch_receipt: {
              dispatch: 'inline_claimed',
              jobStatus: 'running',
            },
          }
        : request.tool_id === 'get_pending_decisions'
        ? { decisions: [] }
        : { results: [] },
    });
  }
  return Response.json({ ok: true, data: {} });
}

type HarnessOptions = {
  scope: string;
  profile?: string;
  authSource?: string;
  negotiateProfile?: boolean;
};

async function createHarness(options: HarnessOptions) {
  const { OrgXMcp } = await import('../src/index');
  const worker = Object.create(OrgXMcp.prototype) as Record<string, any>;
  const props: Record<string, unknown> = {
    userId: USER_ID,
    orgxUserId: ORGX_USER_ID,
    email: 'oauth-user@example.com',
    scope: options.scope,
    workspace_id: WORKSPACE_ID,
    ...(options.authSource ? { authSource: options.authSource } : {}),
  };

  if (options.negotiateProfile) {
    const requestContext = { props };
    attachRequestToolProfile(
      new Request(
        `https://mcp.useorgx.test/mcp?profile=${encodeURIComponent(
          options.profile ?? 'v2'
        )}`
      ),
      requestContext
    );
    worker.props = requestContext.props;
  } else {
    worker.props = { ...props, profile: options.profile ?? 'v2' };
  }

  worker.ctx = {
    id: { toString: () => 'oauth-runtime-session' },
    storage: {
      get: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
      sql: { exec: vi.fn(() => []) },
    },
    waitUntil: vi.fn((promise: Promise<unknown>) => promise),
  };
  worker.env = {
    ORGX_API_URL: 'https://api.useorgx.test',
    ORGX_WEB_URL: 'https://useorgx.test',
    MCP_SERVER_URL: 'https://mcp.useorgx.test',
    MCP_JWT_SECRET: 'test-only-secret',
    OAUTH_KV: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    },
  };
  worker.sessionContext = {};
  worker.sessionAuth = {};
  worker.sessionSqlInitialized = false;
  worker.mcpActivationState = createEmptyMcpActivationState();
  worker.mcpSessionReentryState = createEmptyMcpSessionReentryState();
  worker.sessionToolStats = createEmptySessionToolStats();
  worker.sessionFlushScheduleId = null;
  worker.sessionToolObservationInstalled = false;
  worker.schedule = vi.fn(async () => undefined);
  worker.observeSessionToolCall = vi.fn();
  worker._isNewSession = false;
  worker.widgetDebugEvents = [];
  worker.toolResultGuidanceInstalled = false;

  worker.fetchEntityRecord = vi.fn(async (type: string, id: string) => ({
    id,
    type,
    title: `Scoped ${type}`,
  }));
  worker.fetchEntityCollectionPage = vi.fn(async (params: { type: string }) => ({
    records: [{ id: `${params.type}-1`, type: params.type, title: 'Scoped result' }],
    pagination: {
      has_more: false,
      next_cursor: null,
      limit: 10,
      offset: 0,
    },
  }));
  worker.fetchEntityCollection = vi.fn(async () => []);
  worker.fetchBroadOrgxSearch = vi.fn(async () => []);
  worker.executePlanSessionTool = vi.fn(async () => ({
    content: [{ type: 'text', text: 'Plan action accepted' }],
    structuredContent: { ok: true },
  }));

  apiMocks.callOrgxApiJson.mockImplementation(
    async (_env: unknown, path: string, init?: RequestInit) =>
      successfulApiResponse(path, init)
  );
  apiMocks.fetchContextPack.mockResolvedValue({
    entity: { id: INITIATIVE_ID, type: 'initiative' },
    related: [],
  });
  apiMocks.fetchContextCapsule.mockResolvedValue({
    schema_version: 'orgx.context-capsule/v1',
    capsule_id: 'capsule_workspace',
  });

  await worker._doInit();

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: 'orgx-oauth-runtime-enforcement-test',
    version: '1.0.0',
  });
  await worker.server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server: worker.server, worker };
}

async function closeHarness(harness: Awaited<ReturnType<typeof createHarness>>) {
  await Promise.allSettled([harness.client.close(), harness.server.close()]);
}

function errorCode(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  return (result.structuredContent as { error?: { code?: string } } | undefined)
    ?.error?.code;
}

afterEach(() => {
  vi.restoreAllMocks();
  apiMocks.callOrgxApiJson.mockReset();
  apiMocks.callOrgxApiRaw.mockReset();
  apiMocks.fetchContextPack.mockReset();
  apiMocks.fetchContextCapsule.mockReset();
  apiMocks.captureWorkerPosthogEvent.mockReset();
});

describe('OAuth scope enforcement through the live MCP registry', () => {
  it('tails material context changes through the live read-only MCP surface', async () => {
    const harness = await createHarness({
      scope: AUTHORIZATION_PRESETS.read.scopes.join(' '),
    });
    try {
      apiMocks.callOrgxApiJson.mockImplementation(
        async (_env: unknown, path: string, init?: RequestInit) => {
          if (path.startsWith('/api/v1/events/stream?')) {
            return Response.json({
              data: [
                {
                  eventType: 'expectation.registered',
                  globalSequence: 2492,
                },
              ],
              meta: {
                afterSequence: 2491,
                nextAfterSequence: 2492,
                hasMore: false,
                delivery: 'sequence_tail',
              },
            });
          }
          return successfulApiResponse(path, init);
        }
      );

      const result = await harness.client.callTool({
        name: 'orgx_tail',
        arguments: {
          capsule_id: 'capsule_0123456789abcdef01234567',
          after_sequence: 2491,
          workspace_id: WORKSPACE_ID,
        },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        _v2_tool: 'orgx_tail',
        capsule_id: 'capsule_0123456789abcdef01234567',
        after_sequence: 2491,
        next_after_sequence: 2492,
        has_more: false,
        material_changes: [
          {
            eventType: 'expectation.registered',
            globalSequence: 2492,
          },
        ],
        coverage: {
          supported_event_types: [
            'decision.approved',
            'decision.superseded',
            'autonomy.lease_changed',
            'blocker.opened',
            'blocker.resolved',
            'blocker.dismissed',
            'expectation.registered',
            'expectation.resolved',
            'learning.applied',
          ],
          supported_change_classes: [
            'decision.accepted',
            'decision.superseded',
            'authority.changed',
            'blocker.opened',
            'blocker.resolved',
            'expectation.registered',
            'expectation.resolved',
            'learning.applied',
          ],
          unavailable_change_classes: [
            'constraint.added_or_revoked',
            'incident.opened',
          ],
        },
      });
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('not ledger-backed yet'),
          }),
        ])
      );

      const tailCall = apiMocks.callOrgxApiJson.mock.calls.find(([, path]) =>
        String(path).startsWith('/api/v1/events/stream?')
      );
      expect(tailCall).toBeTruthy();
      const url = new URL(`https://api.useorgx.test${String(tailCall?.[1])}`);
      expect(url.searchParams.get('workspace_id')).toBe(WORKSPACE_ID);
      expect(url.searchParams.get('after_sequence')).toBe('2491');
      expect(url.searchParams.get('event_type')).toBe(
        'decision.approved,decision.superseded,autonomy.lease_changed,blocker.opened,blocker.resolved,blocker.dismissed,expectation.registered,expectation.resolved,learning.applied'
      );
    } finally {
      await closeHarness(harness);
    }
  });

  it('registers the exact receipt-coverage expectation with workspace-write authority', async () => {
    const harness = await createHarness({ scope: 'initiatives:write' });
    try {
      const result = await harness.client.callTool({
        name: 'orgx_expect',
        arguments: {
          metric: 'orgx.run_receipt_coverage.v1',
          workspace_id: WORKSPACE_ID,
          window_starts_at: '2026-08-22T03:00:00.000Z',
          window_ends_at: '2026-08-23T03:00:00.000Z',
          idempotency_key: 'receipt-coverage:oauth-test',
        },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        expectation: {
          workspace_id: WORKSPACE_ID,
          state: 'pending',
        },
        replayed: false,
        idempotency_key: 'receipt-coverage:oauth-test',
      });
      const expectationCall = apiMocks.callOrgxApiJson.mock.calls.find(
        ([, path]) => path === '/api/v1/expectations'
      );
      expect(expectationCall).toBeTruthy();
      const init = expectationCall?.[2] as RequestInit | undefined;
      expect(init?.headers).toEqual({
        'Idempotency-Key': 'receipt-coverage:oauth-test',
      });
      expect(expectationCall?.[3]).toMatchObject({ allowFallback: false });
      expect(JSON.parse(String(init?.body ?? '{}'))).toMatchObject({
        workspace_id: WORKSPACE_ID,
        subject_ref: { type: 'workspace', id: WORKSPACE_ID },
        metric_ref: {
          registry_id: 'orgx.run_receipt_coverage.v1',
          query_version: '1',
          parameters: {
            workspace_id: WORKSPACE_ID,
            capture_path: 'automatic_session_summary',
            exclude_benchmark: true,
            receipt_deadline_seconds: 60,
          },
        },
        predicate: { operator: 'gte', threshold: 0.95 },
        minimum_sample_size: 20,
      });
    } finally {
      await closeHarness(harness);
    }
  });

  it('advertises no private tools or initiative resource for an explicit empty grant', async () => {
    const harness = await createHarness({ scope: '' });
    try {
      // With zero authorized registrations the SDK omits the tools capability
      // entirely, so tools/list and tools/call both fail as unknown methods.
      await expect(harness.client.listTools()).rejects.toThrow(/not found/i);
      await expect(
        harness.client.callTool({ name: 'orgx_search', arguments: {} })
      ).rejects.toThrow(/not found/i);
      await expect(
        harness.client.readResource({ uri: `orgx://initiative/${INITIATIVE_ID}` })
      ).rejects.toThrow(/not found/i);
      expect(apiMocks.callOrgxApiJson).not.toHaveBeenCalled();
    } finally {
      await closeHarness(harness);
    }
  });

  it('lists the Read surface but blocks write actions inside polymorphic tools', async () => {
    const harness = await createHarness({
      scope: AUTHORIZATION_PRESETS.read.scopes.join(' '),
    });
    try {
      const names = (await harness.client.listTools()).tools.map(
        (tool) => tool.name
      );
      expect(names).toContain('orgx_search');
      expect(names).toContain('orgx_spawn');
      expect(names).toContain('orgx_decide');
      expect(names).not.toContain('approve_decision');
      expect(names).not.toContain('scaffold_initiative');

      const readResult = await harness.client.callTool({
        name: 'orgx_search',
        arguments: { query: 'continuity' },
      });
      expect(readResult.isError).not.toBe(true);

      const blockedSpawn = await harness.client.callTool({
        name: 'orgx_spawn',
        arguments: {
          action: 'spawn',
          title: 'Unauthorized dispatch',
          instructions: 'Do not run',
        },
      });
      expect(blockedSpawn.isError).toBe(true);
      expect(errorCode(blockedSpawn)).toBe('insufficient_scope');
    } finally {
      await closeHarness(harness);
    }
  });

  it('requires both write domains before orgx_spawn can hand off a task', async () => {
    const missingInitiativeWrite = await createHarness({
      scope: 'agents:write',
    });
    try {
      expect(
        (await missingInitiativeWrite.client.listTools()).tools.map(
          (tool) => tool.name
        )
      ).toContain('orgx_spawn');
      const blocked = await missingInitiativeWrite.client.callTool({
        name: 'orgx_spawn',
        arguments: {
          action: 'handoff',
          task_id: '44444444-4444-4444-8444-444444444444',
          agent_type: 'engineering',
        },
      });
      expect(blocked.isError).toBe(true);
      expect(errorCode(blocked)).toBe('insufficient_scope');
      expect(apiMocks.callOrgxApiJson).not.toHaveBeenCalled();
    } finally {
      await closeHarness(missingInitiativeWrite);
    }

    const fullyAuthorized = await createHarness({
      scope: 'agents:write initiatives:write',
    });
    try {
      const handedOff = await fullyAuthorized.client.callTool({
        name: 'orgx_spawn',
        arguments: {
          action: 'handoff',
          task_id: '44444444-4444-4444-8444-444444444444',
          agent_type: 'engineering',
        },
      });
      expect(handedOff.isError).not.toBe(true);
      const handoffCall = apiMocks.callOrgxApiJson.mock.calls.find(
        ([, path, init]) =>
          path === '/api/tools/execute' &&
          JSON.parse(String(init?.body ?? '{}')).tool_id === 'handoff_task'
      );
      expect(handoffCall).toBeTruthy();
    } finally {
      await closeHarness(fullyAuthorized);
    }
  });

  it('enforces a narrow decision grant from tools/list through tools/call', async () => {
    const harness = await createHarness({ scope: 'decisions:read' });
    try {
      const names = (await harness.client.listTools()).tools.map(
        (tool) => tool.name
      );
      expect(names).toContain('orgx_search');
      expect(names).toContain('orgx_inspect');
      expect(names).toContain('orgx_decide');
      expect(names).not.toContain('query_org_memory');
      expect(names).not.toContain('get_agent_status');

      const decisionSearch = await harness.client.callTool({
        name: 'orgx_search',
        arguments: { type: 'decision' },
      });
      expect(decisionSearch.isError).not.toBe(true);

      const initiativeSearch = await harness.client.callTool({
        name: 'orgx_search',
        arguments: { type: 'initiative' },
      });
      expect(initiativeSearch.isError).toBe(true);
      expect(errorCode(initiativeSearch)).toBe('insufficient_scope');

      const baseDecision = await harness.client.callTool({
        name: 'orgx_inspect',
        arguments: {
          type: 'decision',
          id: 'decision-1',
          hydrate_context: false,
        },
      });
      expect(baseDecision.isError).not.toBe(true);

      const hydratedDecision = await harness.client.callTool({
        name: 'orgx_inspect',
        arguments: { type: 'decision', id: 'decision-1' },
      });
      expect(hydratedDecision.isError).toBe(true);
      expect(errorCode(hydratedDecision)).toBe('insufficient_scope');
    } finally {
      await closeHarness(harness);
    }
  });

  it('enforces the selected write domain inside orgx_write', async () => {
    const harness = await createHarness({ scope: 'decisions:write' });
    try {
      expect(
        (await harness.client.listTools()).tools.map((tool) => tool.name)
      ).toContain('orgx_write');

      const blockedInitiative = await harness.client.callTool({
        name: 'orgx_write',
        arguments: {
          type: 'initiative',
          title: 'Wrong write domain',
          workspace_id: WORKSPACE_ID,
        },
      });
      expect(blockedInitiative.isError).toBe(true);
      expect(errorCode(blockedInitiative)).toBe('insufficient_scope');

      const decision = await harness.client.callTool({
        name: 'orgx_write',
        arguments: {
          type: 'decision',
          title: 'Scoped decision',
          summary: 'Written with decisions:write only',
        },
      });
      expect(decision.isError).not.toBe(true);
      const entityCall = apiMocks.callOrgxApiJson.mock.calls.find(
        ([, path, init]) =>
          path === '/api/entities' &&
          JSON.parse(String(init?.body ?? '{}')).type === 'decision'
      );
      expect(entityCall).toBeTruthy();
    } finally {
      await closeHarness(harness);
    }
  });

  it('keeps a memory-only custom grant out of initiative resources', async () => {
    const harness = await createHarness({ scope: 'memory:read' });
    try {
      const names = (await harness.client.listTools()).tools.map(
        (tool) => tool.name
      );
      expect(names).toContain('query_org_memory');
      expect(names).toContain('recall_memory');
      expect(names).not.toContain('get_initiative_pulse');
      await expect(
        harness.client.readResource({ uri: `orgx://initiative/${INITIATIVE_ID}` })
      ).rejects.toThrow(/not found/i);
    } finally {
      await closeHarness(harness);
    }
  });

  it('reads initiative resources only with initiatives:read and forwards actor identity', async () => {
    const harness = await createHarness({ scope: 'initiatives:read' });
    try {
      const result = await harness.client.readResource({
        uri: `orgx://initiative/${INITIATIVE_ID}`,
      });
      expect(result.contents[0]).toMatchObject({
        uri: `orgx://initiative/${INITIATIVE_ID}`,
        mimeType: 'text/markdown',
      });

      const resourceCall = apiMocks.callOrgxApiJson.mock.calls.find(
        ([, path]) => path === `/api/initiatives/${INITIATIVE_ID}`
      );
      expect(resourceCall?.[3]).toEqual({
        userId: USER_ID,
        userEmail: 'oauth-user@example.com',
        orgxUserId: ORGX_USER_ID,
      });
    } finally {
      await closeHarness(harness);
    }
  });

  it('fails external full closed while preserving provably internal full discovery', async () => {
    const external = await createHarness({
      scope: AUTHORIZATION_PRESETS.operate.scopes.join(' '),
      profile: 'full',
      negotiateProfile: true,
    });
    try {
      const names = (await external.client.listTools()).tools.map(
        (tool) => tool.name
      );
      expect(external.worker.props.profile).toBe('read-only');
      expect(names.sort()).toEqual([...CLAUDE_DIRECTORY_SURFACE].sort());
      expect(names).not.toContain('account_status');
    } finally {
      await closeHarness(external);
    }

    const internal = await createHarness({
      scope: 'mcp:run',
      profile: 'full',
      authSource: 'run_token',
      negotiateProfile: true,
    });
    try {
      const names = (await internal.client.listTools()).tools.map(
        (tool) => tool.name
      );
      expect(internal.worker.props.profile).toBe('full');
      expect(names).toContain('account_status');
      expect(names).toContain('orgx_apply_changeset');
    } finally {
      await closeHarness(internal);
    }
  });

  it('uses initiatives:write for plan mutations and decision scopes for decision actions', async () => {
    const planningRead = await createHarness({ scope: 'initiatives:read' });
    try {
      expect(
        (await planningRead.client.listTools()).tools.map((tool) => tool.name)
      ).toContain('orgx_plan');

      const resumed = await planningRead.client.callTool({
        name: 'orgx_plan',
        arguments: { action: 'resume' },
      });
      expect(resumed.isError).not.toBe(true);

      const blockedStart = await planningRead.client.callTool({
        name: 'orgx_plan',
        arguments: { action: 'start', feature_name: 'Unauthorized planning' },
      });
      expect(blockedStart.isError).toBe(true);
      expect(errorCode(blockedStart)).toBe('insufficient_scope');
      expect(planningRead.worker.executePlanSessionTool).not.toHaveBeenCalled();
    } finally {
      await closeHarness(planningRead);
    }

    const planning = await createHarness({ scope: 'initiatives:write' });
    try {
      expect(
        (await planning.client.listTools()).tools.map((tool) => tool.name)
      ).toContain('orgx_plan');
      const result = await planning.client.callTool({
        name: 'orgx_plan',
        arguments: { action: 'start', feature_name: 'Scoped planning' },
      });
      expect(result.isError).not.toBe(true);
      expect(planning.worker.executePlanSessionTool).toHaveBeenCalledWith(
        'start_plan_session',
        expect.objectContaining({ action: 'start' }),
        [{ type: 'oauth2', scopes: ['initiatives:write'] }]
      );
    } finally {
      await closeHarness(planning);
    }

    const decisionsRead = await createHarness({ scope: 'decisions:read' });
    try {
      const listed = await decisionsRead.client.callTool({
        name: 'orgx_decide',
        arguments: { action: 'list_pending' },
      });
      expect(listed.isError).not.toBe(true);

      const blockedRemember = await decisionsRead.client.callTool({
        name: 'orgx_decide',
        arguments: { action: 'remember', decision: 'Keep the scope narrow' },
      });
      expect(blockedRemember.isError).toBe(true);
      expect(errorCode(blockedRemember)).toBe('insufficient_scope');
    } finally {
      await closeHarness(decisionsRead);
    }

    const decisionsWrite = await createHarness({ scope: 'decisions:write' });
    try {
      const remembered = await decisionsWrite.client.callTool({
        name: 'orgx_decide',
        arguments: { action: 'remember', decision: 'Use decision scope' },
      });
      expect(remembered.isError).not.toBe(true);
      const entityCall = apiMocks.callOrgxApiJson.mock.calls.find(
        ([, path]) => path === '/api/entities'
      );
      expect(entityCall).toBeTruthy();
    } finally {
      await closeHarness(decisionsWrite);
    }
  });

  it('publishes a ChatGPT-loadable scaffold_initiative descriptor', async () => {
    const harness = await createHarness({
      scope: AUTHORIZATION_PRESETS.operate.scopes.join(' '),
      profile: 'chatgpt',
    });
    try {
      const descriptor = (await harness.client.listTools()).tools.find(
        (tool) => tool.name === 'scaffold_initiative'
      );

      expect(descriptor).toBeDefined();
      expect(descriptor?._meta).toMatchObject({
        'openai/visibility': 'public',
        'openai/outputTemplate': expect.any(String),
        ui: {
          resourceUri: expect.any(String),
          visibility: ['model', 'app'],
        },
      });

      // Keep public descriptors beneath an explicit host-compatibility budget.
      // The previous 14.9 KB descriptor was present in OrgX tools/list but was
      // silently omitted from ChatGPT's callable schema set.
      const descriptorBytes = Buffer.byteLength(
        JSON.stringify(descriptor),
        'utf8'
      );
      expect(descriptorBytes).toBeLessThanOrEqual(8 * 1024);

      const properties = (descriptor?.inputSchema as {
        properties?: Record<string, unknown>;
      } | undefined)?.properties ?? {};
      expect(Object.keys(properties)).toEqual(
        expect.arrayContaining([
          'title',
          'workspace_id',
          'objective_ids',
          'mode',
          'response_mode',
          'workstreams',
          'source_evidence',
          'external_sync',
          '_context',
        ])
      );
      expect(properties.workstreams).toMatchObject({ type: 'array' });
    } finally {
      await closeHarness(harness);
    }
  });
});
