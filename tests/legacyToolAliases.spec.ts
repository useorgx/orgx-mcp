import { createHash } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OAUTH_SCOPES_SUPPORTED } from '../src/authorizationPolicy';
import {
  CONTRACT_TOOL_DEFINITIONS,
  getKnownToolContract,
  resolveContractToolInvocationSecuritySchemes,
} from '../src/contractTools';
import {
  DEPRECATED_TOOL_IDS,
  DEPRECATION_SUNSET_AT_ISO,
  LEGACY_TOOL_ALIASES,
  resolveDeprecatedToolCall,
  resolveLegacyToolAlias,
} from '../src/deprecatedTools';
import { handleMcpRequest } from '../src/mcpTransport';
import { SECURITY_SCHEMES } from '../src/toolDefinitions';
import { WIDGET_BUILD_VERSION } from '../src/generated/widgetBuildInfo';
import { createEmptyMcpActivationState } from '../src/mcpActivationTracker';
import { createEmptySessionToolStats } from '../src/sessionSummary';
import { TOOL_PROFILE_NAMES } from '../src/toolProfiles';
import { createEmptyMcpSessionReentryState } from '../src/welcomeBackContext';

/**
 * Legacy tool names that a v2-core tool fully covers run as thin aliases of
 * that canonical tool (src/deprecatedTools.ts LEGACY_TOOL_ALIASES). These
 * tests pin two things:
 *   1. Every listed surface is unchanged: tools/list per profile is hashed
 *      tool by tool, so any change to a name, schema, annotation, _meta or
 *      description shows up as a snapshot diff.
 *   2. Each alias resolves to its canonical implementation (one upstream
 *      call, made by the canonical code path) and carries the deprecation
 *      warning metadata the transport-level deprecated routes already emit.
 */

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
  captureMessage: vi.fn(),
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
  resolveAnonymousDistinctId: () => 'legacy-tool-alias-test',
}));

const USER_ID = 'alias-user';
const ORGX_USER_ID = '33333333-3333-4333-8333-333333333333';
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const PLAN_SESSION_ID = '44444444-4444-4444-8444-444444444444';
const STUDIO_CONTENT_ID = '55555555-5555-4555-8555-555555555555';
const ALL_SCOPES = OAUTH_SCOPES_SUPPORTED.join(' ');

type HarnessOptions = {
  profile: string;
  scope?: string;
  userId?: string | null;
};

async function createHarness(options: HarnessOptions) {
  const { OrgXMcp } = await import('../src/index');
  const worker = Object.create(OrgXMcp.prototype) as Record<string, any>;
  const userId = options.userId === undefined ? USER_ID : options.userId;
  worker.props = {
    ...(userId ? { userId, orgxUserId: ORGX_USER_ID } : {}),
    email: 'alias-user@example.com',
    scope: options.scope ?? ALL_SCOPES,
    workspace_id: WORKSPACE_ID,
    profile: options.profile,
  };
  worker.ctx = {
    id: { toString: () => 'legacy-tool-alias-session' },
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

  apiMocks.callOrgxApiJson.mockImplementation(async () =>
    Response.json({ ok: true, data: {} })
  );

  await worker._doInit();

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: 'orgx-legacy-tool-alias-test',
    version: '1.0.0',
  });
  await worker.server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server: worker.server, worker };
}

async function closeHarness(
  harness: Awaited<ReturnType<typeof createHarness>>
) {
  await Promise.allSettled([harness.client.close(), harness.server.close()]);
}

afterEach(() => {
  vi.restoreAllMocks();
  apiMocks.callOrgxApiJson.mockReset();
  apiMocks.callOrgxApiRaw.mockReset();
  apiMocks.fetchContextPack.mockReset();
  apiMocks.fetchContextCapsule.mockReset();
  apiMocks.captureWorkerPosthogEvent.mockReset();
});

const ALIAS_DESCRIPTION_SUFFIX = / Alias of ([a-z_]+) \([^)]*\)\.$/;

/**
 * The one intended change to a listed descriptor is an "Alias of <canonical>"
 * sentence appended to an alias's description. Strip it (after checking it
 * names the right canonical tool) so the snapshot proves everything else,
 * including the rest of that description, is byte-identical to before.
 */
function withoutAliasNote(tool: { name: string; description?: string }) {
  const alias = resolveLegacyToolAlias(tool.name);
  if (!alias) return tool;
  const match = tool.description?.match(ALIAS_DESCRIPTION_SUFFIX);
  expect(match?.[1]).toBe(alias.canonicalToolId);
  return {
    ...tool,
    description: tool.description!.replace(ALIAS_DESCRIPTION_SUFFIX, ''),
  };
}

function hashListedTool(tool: { name: string; description?: string }): string {
  // Widget resource URIs carry the widget build version; normalize it so the
  // snapshot only moves when the tool contract itself changes.
  const normalized = JSON.stringify(withoutAliasNote(tool))
    .split(WIDGET_BUILD_VERSION)
    .join('<widget-build>');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

describe('listed tool surfaces', () => {
  for (const profile of TOOL_PROFILE_NAMES) {
    it(`profile "${profile}" lists byte-identical tool descriptors`, async () => {
      const harness = await createHarness({ profile });
      try {
        const { tools } = await harness.client.listTools();
        const hashes = Object.fromEntries(
          tools
            .map((tool) => [tool.name, hashListedTool(tool)] as const)
            .sort(([a], [b]) => a.localeCompare(b))
        );
        expect(hashes).toMatchSnapshot();
      } finally {
        await closeHarness(harness);
      }
    });
  }
});

const ALIAS_IDS = Object.keys(LEGACY_TOOL_ALIASES).sort();

function canonicalDefinition(toolId: string) {
  const definition = CONTRACT_TOOL_DEFINITIONS.find((tool) => tool.id === toolId);
  if (!definition) throw new Error(`missing canonical tool ${toolId}`);
  return definition;
}

describe('legacy tool alias contract', () => {
  it('aliases exactly the tools a v2-core tool fully covers', () => {
    expect(ALIAS_IDS).toEqual([
      'improve_plan',
      'start_plan_session',
      'validate_studio_content',
    ]);
  });

  it('never aliases a decision approval path', () => {
    const decisionTools = [
      'approve_decision',
      'reject_decision',
      'approve_agent_work',
      'orgx_decide',
      'orgx_widget_decide',
      'get_pending_decisions',
      'remember_decision',
      'create_decision',
    ];
    for (const toolId of decisionTools) {
      expect(resolveLegacyToolAlias(toolId)).toBeNull();
    }
    for (const alias of Object.values(LEGACY_TOOL_ALIASES)) {
      expect(decisionTools).not.toContain(alias.canonicalToolId);
    }
  });

  it.each(ALIAS_IDS)(
    '%s maps every legacy argument onto its canonical tool without loss',
    (legacyToolId) => {
      const alias = LEGACY_TOOL_ALIASES[legacyToolId]!;
      const legacy = getKnownToolContract(legacyToolId);
      const canonical = canonicalDefinition(alias.canonicalToolId);
      const legacyKeys = Object.keys(legacy?.inputSchema ?? {});
      const canonicalKeys = new Set(Object.keys(canonical.inputSchema));
      expect(legacyKeys.length).toBeGreaterThan(0);
      for (const key of legacyKeys) {
        expect(canonicalKeys.has(key), `${alias.canonicalToolId} accepts ${key}`).toBe(true);
      }

      const legacyArgs = Object.fromEntries(
        legacyKeys.map((key) => [key, `value-${key}`])
      );
      const mapped = alias.mapArgs(legacyArgs);
      expect(mapped).toMatchObject(legacyArgs);
      expect(mapped.action).toBe(alias.canonicalAction);
    }
  );

  it.each(ALIAS_IDS)(
    '%s keeps the same auth requirement as its canonical invocation',
    (legacyToolId) => {
      const alias = LEGACY_TOOL_ALIASES[legacyToolId]!;
      const legacy = getKnownToolContract(legacyToolId);
      const canonical = canonicalDefinition(alias.canonicalToolId);
      expect(
        resolveContractToolInvocationSecuritySchemes(
          alias.canonicalToolId,
          alias.mapArgs({}),
          canonical.securitySchemes
        )
      ).toEqual(legacy?.securitySchemes);
    }
  );

  it.each(ALIAS_IDS)(
    '%s resolves at the transport without a rename and carries a routed deprecation warning',
    (legacyToolId) => {
      const alias = LEGACY_TOOL_ALIASES[legacyToolId]!;
      const args = { session_id: PLAN_SESSION_ID };
      const resolved = resolveDeprecatedToolCall(legacyToolId, args);
      expect(resolved.resolvedToolId).toBe(legacyToolId);
      expect(resolved.resolvedArgs).toBe(args);
      expect(resolved.warning).toEqual({
        deprecatedToolId: legacyToolId,
        replacementToolId: alias.canonicalToolId,
        replacementAction: alias.canonicalAction,
        routed: true,
      });
      expect(DEPRECATED_TOOL_IDS).toContain(legacyToolId);
    }
  );

  it('adds the deprecation headers to an alias call and forwards it unchanged', async () => {
    let received: any = null;
    const handler = {
      fetch: vi.fn(async (req: Request) => {
        received = await req.json();
        return Response.json({ ok: true });
      }),
    };
    const response = await handleMcpRequest(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          method: 'tools/call',
          params: {
            name: 'start_plan_session',
            arguments: { feature_name: 'Alias planning' },
          },
        }),
      }),
      {},
      { waitUntil: vi.fn() } as any,
      handler,
      vi.fn(async () => ({}))
    );

    expect(received?.params).toEqual({
      name: 'start_plan_session',
      arguments: { feature_name: 'Alias planning' },
    });
    expect(response.headers.get('x-orgx-deprecated-tool')).toBe(
      'start_plan_session'
    );
    expect(response.headers.get('x-orgx-replacement-tool')).toBe('orgx_plan');
    expect(response.headers.get('x-orgx-replacement-action')).toBe('start');
    expect(response.headers.get('x-orgx-deprecation-routed')).toBe('true');
    expect(response.headers.get('x-orgx-deprecation-sunset-at')).toBe(
      DEPRECATION_SUNSET_AT_ISO
    );
    expect(response.headers.get('Warning')).toContain(
      'start_plan_session is deprecated; use orgx_plan (action=start).'
    );
  });
});

describe('legacy tool aliases run the canonical implementation', () => {
  function planApiResponse(path: string) {
    if (path === '/api/plan-sessions') {
      return Response.json({
        id: PLAN_SESSION_ID,
        title: 'Alias planning',
        feature_name: 'Alias planning',
        status: 'active',
      });
    }
    if (path === '/api/plan-sessions/improve') {
      return Response.json({
        session_id: PLAN_SESSION_ID,
        suggestions: [{ section: 'Scope', suggestion: 'Name the owner.' }],
      });
    }
    return Response.json({ ok: true, data: { valid: true, errors: [] } });
  }

  async function callBoth(
    legacy: { name: string; arguments: Record<string, unknown> },
    canonical: { name: string; arguments: Record<string, unknown> }
  ) {
    const harness = await createHarness({ profile: 'full' });
    try {
      apiMocks.callOrgxApiJson.mockImplementation(
        async (_env: unknown, path: string) => planApiResponse(path)
      );
      const executeContractTool = vi.spyOn(
        harness.worker as any,
        'executeContractTool'
      );
      const executePlanSessionTool = vi.spyOn(
        harness.worker as any,
        'executePlanSessionTool'
      );

      // Both calls should see the same session state: no first-call welcome.
      harness.worker._isNewSession = false;
      const legacyResult = await harness.client.callTool(legacy);
      const legacyContractCalls = executeContractTool.mock.calls.map((call) => [
        call[0],
        call[1],
      ]);
      const legacyPlanCalls = executePlanSessionTool.mock.calls.map((call) => [
        call[0],
        call[1],
      ]);
      const legacyApiCalls = apiMocks.callOrgxApiJson.mock.calls.map((call) => [
        call[1],
        call[2]?.body ? JSON.parse(String(call[2].body)) : undefined,
      ]);

      executeContractTool.mockClear();
      executePlanSessionTool.mockClear();
      apiMocks.callOrgxApiJson.mockClear();

      const canonicalResult = await harness.client.callTool(canonical);
      const canonicalApiCalls = apiMocks.callOrgxApiJson.mock.calls.map(
        (call) => [
          call[1],
          call[2]?.body ? JSON.parse(String(call[2].body)) : undefined,
        ]
      );

      return {
        legacyResult,
        canonicalResult,
        legacyContractCalls,
        legacyPlanCalls,
        legacyApiCalls,
        canonicalApiCalls,
      };
    } finally {
      await closeHarness(harness);
    }
  }

  it('start_plan_session runs orgx_plan action=start', async () => {
    const run = await callBoth(
      {
        name: 'start_plan_session',
        arguments: { feature_name: 'Alias planning', initial_plan: '# Plan' },
      },
      {
        name: 'orgx_plan',
        arguments: {
          action: 'start',
          feature_name: 'Alias planning',
          initial_plan: '# Plan',
        },
      }
    );

    expect(run.legacyResult.isError).not.toBe(true);
    expect(run.legacyContractCalls).toEqual([
      [
        'orgx_plan',
        { feature_name: 'Alias planning', initial_plan: '# Plan', action: 'start' },
      ],
    ]);
    expect(run.legacyPlanCalls).toEqual([
      [
        'start_plan_session',
        { feature_name: 'Alias planning', initial_plan: '# Plan', action: 'start' },
      ],
    ]);
    expect(run.legacyApiCalls).toHaveLength(1);
    expect(run.legacyApiCalls).toEqual(run.canonicalApiCalls);
    expect(run.legacyResult.structuredContent).toEqual(
      run.canonicalResult.structuredContent
    );
    expect(run.legacyResult.content).toEqual(run.canonicalResult.content);
  });

  it('improve_plan runs orgx_plan action=improve', async () => {
    const run = await callBoth(
      {
        name: 'improve_plan',
        arguments: { session_id: PLAN_SESSION_ID, plan_content: '# Draft' },
      },
      {
        name: 'orgx_plan',
        arguments: {
          action: 'improve',
          session_id: PLAN_SESSION_ID,
          plan_content: '# Draft',
        },
      }
    );

    expect(run.legacyResult.isError).not.toBe(true);
    expect(run.legacyContractCalls).toEqual([
      [
        'orgx_plan',
        { session_id: PLAN_SESSION_ID, plan_content: '# Draft', action: 'improve' },
      ],
    ]);
    expect(run.legacyPlanCalls.map(([toolId]) => toolId)).toEqual([
      'improve_plan',
    ]);
    expect(run.legacyApiCalls).toHaveLength(1);
    expect(run.legacyApiCalls).toEqual(run.canonicalApiCalls);
    expect(run.legacyResult.structuredContent).toEqual(
      run.canonicalResult.structuredContent
    );
    expect(run.legacyResult.content).toEqual(run.canonicalResult.content);
  });

  it('validate_studio_content runs orgx_act type=studio_content action=validate', async () => {
    const spec = { format: 'carousel', slides: 3 };
    const run = await callBoth(
      {
        name: 'validate_studio_content',
        arguments: { id: STUDIO_CONTENT_ID, spec, note: 'Check slide count' },
      },
      {
        name: 'orgx_act',
        arguments: {
          type: 'studio_content',
          id: STUDIO_CONTENT_ID,
          action: 'validate',
          spec,
          note: 'Check slide count',
        },
      }
    );

    expect(run.legacyResult.isError).not.toBe(true);
    // orgx_act delegates to the validation implementation directly; the
    // alias does not loop back through the legacy registration.
    expect(run.legacyContractCalls.map(([toolId]) => toolId)).toEqual([
      'orgx_act',
      'validate_studio_content',
    ]);
    expect(run.legacyApiCalls).toEqual([
      [
        `/api/entities/studio_content/${STUDIO_CONTENT_ID}/validate`,
        {
          spec,
          note: 'Check slide count',
          reason: 'Check slide count',
          user_id: USER_ID,
        },
      ],
    ]);
    expect(run.legacyApiCalls).toEqual(run.canonicalApiCalls);
    expect(run.legacyResult.structuredContent).toEqual(
      run.canonicalResult.structuredContent
    );
    expect(run.legacyResult.content).toEqual(run.canonicalResult.content);
  });

  it('checks the legacy auth requirement, with the legacy message, before running the canonical tool', async () => {
    const harness = await createHarness({
      profile: 'full',
      scope: 'initiatives:read',
    });
    try {
      const executeContractTool = vi.spyOn(
        harness.worker as any,
        'executeContractTool'
      );
      const result = await harness.worker.executeLegacyToolAlias(
        'start_plan_session',
        { feature_name: 'Blocked planning' },
        SECURITY_SCHEMES.entityWriteRequiresAuth,
        'use planning features',
        null
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error?.code).toBe('insufficient_scope');
      expect(JSON.stringify(result.content)).toContain('use planning features');
      expect(executeContractTool).not.toHaveBeenCalled();
      expect(apiMocks.callOrgxApiJson).not.toHaveBeenCalled();
    } finally {
      await closeHarness(harness);
    }
  });

  it('keeps alias names off every profile that did not already list them', async () => {
    for (const profile of ['v2', 'chatgpt', 'claude-plugin', 'planner']) {
      const harness = await createHarness({ profile });
      try {
        const names = (await harness.client.listTools()).tools.map(
          (tool) => tool.name
        );
        for (const aliasId of ALIAS_IDS) {
          expect(names).not.toContain(aliasId);
        }
      } finally {
        await closeHarness(harness);
      }
    }
  });
});
