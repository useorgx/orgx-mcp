import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

import { createEmptyMcpActivationState } from '../src/mcpActivationTracker';
import { AUTHORIZATION_PRESETS } from '../src/authorizationPolicy';
import {
  CHATGPT_PUBLIC_SURFACE,
  CLAUDE_DIRECTORY_SURFACE,
} from '../src/toolProfiles';
import {
  createEmptyMcpSessionReentryState,
  MCP_SESSION_REENTRY_STORAGE_KEY,
} from '../src/welcomeBackContext';

const apiMocks = vi.hoisted(() => ({
  callOrgxApiJson: vi.fn(),
  callOrgxApiRaw: vi.fn(),
  fetchContextPack: vi.fn(),
  captureWorkerPosthogEvent: vi.fn(),
}));

vi.mock('agents/mcp', () => ({
  McpAgent: class McpAgent {
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
}));

vi.mock('../src/posthogTelemetry', () => ({
  captureWorkerPosthogEvent: apiMocks.captureWorkerPosthogEvent,
  resolveAnonymousDistinctId: () => 'directory-reviewer',
}));

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const INITIATIVE_ID = '22222222-2222-4222-8222-222222222222';

type WriteSpies = {
  storagePut: ReturnType<typeof vi.fn>;
  sqlExec: ReturnType<typeof vi.fn>;
  oauthPut: ReturnType<typeof vi.fn>;
  waitUntil: ReturnType<typeof vi.fn>;
  consoleInfo: ReturnType<typeof vi.spyOn>;
  consoleWarn: ReturnType<typeof vi.spyOn>;
  consoleError: ReturnType<typeof vi.spyOn>;
};

const CHATGPT_INFORMATIONAL_TOOL_CALLS = [
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

function successfulApiResponse(path: string, init?: RequestInit): Response {
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
  profile: 'chatgpt' | 'claude-directory'
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
    scope:
      profile === 'chatgpt'
        ? AUTHORIZATION_PRESETS.operate.scopes.join(' ')
        : AUTHORIZATION_PRESETS.read.scopes.join(' '),
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

  await worker._doInit();

  if (profile === 'claude-directory') {
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
  profile: 'chatgpt' | 'claude-directory';
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
    if (params.profile === 'chatgpt') {
      const reviewArtifact = listed.tools.find(
        (tool) => tool.name === 'review_artifact'
      );
      expect(reviewArtifact?.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(reviewArtifact?._meta?.['mcp/securitySchemes']).toEqual([
        { type: 'oauth2', scopes: ['initiatives:read'] },
      ]);
    }

    // The MCP framework can persist transport lifecycle state before tool
    // execution. Reset here so every assertion below is scoped to one tool
    // handler invocation. These spies intentionally cover worker-local effects
    // only: production upstream paths for four tools still record metered MCP
    // allowance usage and therefore advertise readOnlyHint=false.
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
      };
      const result = await client.callTool({
        name: call.name,
        arguments: call.arguments,
      });

      expect(result.isError, assertionLabel).not.toBe(true);
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
  it('executes all seven Claude directory tools without worker-local persistence or logging', async () => {
    const directoryTools = new Set<string>(CLAUDE_DIRECTORY_SURFACE);
    await expectNoWorkerLocalSideEffects({
      profile: 'claude-directory',
      expectedSurface: CLAUDE_DIRECTORY_SURFACE,
      calls: CHATGPT_INFORMATIONAL_TOOL_CALLS.filter((call) =>
        directoryTools.has(call.name)
      ),
    });
  });

  it('executes all nine submitted ChatGPT informational tools without worker-local persistence or logging', async () => {
    await expectNoWorkerLocalSideEffects({
      profile: 'chatgpt',
      expectedSurface: CHATGPT_PUBLIC_SURFACE,
      calls: CHATGPT_INFORMATIONAL_TOOL_CALLS,
    });
  });

  it('keeps a submitted stateful ChatGPT tool on the existing persistence path', async () => {
    const { client, server, spies } = await createSubmissionProfileHarness('chatgpt');
    try {
      for (const spy of Object.values(spies)) {
        spy.mockClear();
      }
      apiMocks.fetchContextPack.mockResolvedValueOnce({
        entity: { id: INITIATIVE_ID, type: 'initiative' },
        frame: {
          anchor: {
            id: INITIATIVE_ID,
            type: 'initiative',
            title: 'Directory review initiative',
          },
        },
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
      });
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining('Context pack:'),
          }),
        ])
      );
      expect(apiMocks.fetchContextPack).toHaveBeenCalledWith(
        expect.any(Object),
        'directory-reviewer',
        { type: 'initiative', id: INITIATIVE_ID }
      );
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
