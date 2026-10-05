import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTHORIZATION_PRESETS } from '../src/authorizationPolicy';
import { createEmptyMcpActivationState } from '../src/mcpActivationTracker';
import { createEmptyMcpSessionReentryState } from '../src/welcomeBackContext';

const apiMocks = vi.hoisted(() => ({ callOrgxApiJson: vi.fn() }));
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
vi.mock('../src/orgxApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/orgxApi')>(),
  callOrgxApiJson: apiMocks.callOrgxApiJson,
}));

const USER_ID = 'user_resume_review_fixture';
const ORGX_USER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_USER_ID = '44444444-4444-4444-8444-444444444444';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_RUN_ID = '55555555-5555-4555-8555-555555555555';
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const OPERATE_SCOPE = AUTHORIZATION_PRESETS.operate.scopes.join(' ');
const ownedRun = { id: RUN_ID, requester_id: ORGX_USER_ID, workspace_id: WORKSPACE_ID, status: 'paused' };

async function connectFixture(profile = 'claude-directory', scope = OPERATE_SCOPE) {
  const { OrgXMcp } = await import('../src/index');
  const worker = Object.create(OrgXMcp.prototype) as Record<string, any>;
  worker.props = {
    profile, userId: USER_ID, orgxUserId: ORGX_USER_ID,
    email: 'resume-reviewer@example.test', scope, workspace_id: WORKSPACE_ID,
  };
  worker.ctx = {
    id: { toString: () => `resume-ownership-${profile}` },
    storage: {
      get: vi.fn(async () => undefined), put: vi.fn(async () => undefined),
      sql: { exec: vi.fn(() => []) },
    },
    waitUntil: vi.fn((promise: Promise<unknown>) => promise),
  };
  worker.env = {
    ORGX_API_URL: 'https://api.useorgx.test', ORGX_WEB_URL: 'https://useorgx.test',
    ORGX_API_FALLBACK_URL: 'https://fallback.useorgx.test',
    ORGX_SERVICE_KEY: 'oxk-resume-ownership-test-service-key',
    ORGX_INTERNAL_SECRET: 'resume-ownership-test-signing-key',
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
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'resume-ownership-fixture', version: '1.0.0' });
  await worker.server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, worker };
}

let fixture: Awaited<ReturnType<typeof connectFixture>>;
let upstreamFetch: ReturnType<typeof vi.fn>;
function responseForOwnedLookup(rows: unknown = [ownedRun]) {
  apiMocks.callOrgxApiJson.mockImplementation(async (_env: unknown, path: string, init?: RequestInit) => {
    if (path.startsWith('/api/entities?')) return Response.json({ data: rows });
    if (path === `/api/agent-runs/${RUN_ID}/resume` && init?.method === 'POST') {
      return Response.json({ ok: true, run_id: RUN_ID, status: 'running', prior_status: 'paused', was_auto_closed: false });
    }
    if (path === '/api/internal/mcp/tool-invocations') return Response.json({ ok: true });
    throw new Error(`Unexpected upstream path in test: ${path}`);
  });
}
function businessPosts() {
  // General profiles retain invocation telemetry. It cannot resume a run and
  // is a separate contract from the business mutation this guard authorizes.
  return apiMocks.callOrgxApiJson.mock.calls.filter((call) =>
    call[2]?.method === 'POST' && call[1] !== '/api/internal/mcp/tool-invocations'
  );
}
async function expectDeniedWithoutPost(expectedCode: string, expectedStatus: number) {
  const result = await fixture.client.callTool({ name: 'resume_agent_run', arguments: { run_id: RUN_ID } });
  expect(result.isError, JSON.stringify(result.content)).toBe(true);
  expect(result.structuredContent).toMatchObject({ error: { code: expectedCode, status: expectedStatus } });
  expect(businessPosts()).toEqual([]);
  return result;
}

beforeAll(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  upstreamFetch = vi.fn(async () => new Response('No real network in ownership tests', { status: 503 }));
  vi.stubGlobal('fetch', upstreamFetch);
  fixture = await connectFixture();
}, 30000);

beforeEach(() => {
  apiMocks.callOrgxApiJson.mockReset();
  upstreamFetch.mockReset();
  upstreamFetch.mockImplementation(async () => new Response('No real network in ownership tests', { status: 503 }));
  fixture.worker.props.scope = OPERATE_SCOPE;
  responseForOwnedLookup();
});

afterAll(async () => {
  if (fixture) await Promise.allSettled([fixture.client.close(), fixture.worker.server.close()]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('resume_agent_run authenticates ownership before its mutation', () => {
  it('reads the exact owned run with the signed actor, then resumes it on the primary only', async () => {
    const result = await fixture.client.callTool({
      name: 'resume_agent_run', arguments: { run_id: RUN_ID, note: '  reviewer fixture resume  ' },
    });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: true, run_id: RUN_ID, status: 'running' });
    expect(apiMocks.callOrgxApiJson).toHaveBeenCalledTimes(2);
    const [lookup, mutation] = apiMocks.callOrgxApiJson.mock.calls;
    const lookupUrl = new URL(lookup![1], 'https://api.useorgx.test');
    expect(lookupUrl.pathname).toBe('/api/entities');
    expect(Object.fromEntries(lookupUrl.searchParams)).toEqual({ type: 'run', id: RUN_ID, limit: '1' });
    expect(lookup![2]?.method ?? 'GET').toBe('GET');
    for (const call of [lookup!, mutation!]) {
      expect(call[3]).toMatchObject({ userId: USER_ID, orgxUserId: ORGX_USER_ID, allowFallback: false });
    }
    expect(mutation![1]).toBe(`/api/agent-runs/${RUN_ID}/resume`);
    expect(mutation![2]?.method).toBe('POST');
    expect(JSON.parse(String(mutation![2]?.body))).toEqual({ note: 'reviewer fixture resume' });
  });

  it('does not let a caller-supplied actor replace the authenticated ownership identity', async () => {
    const result = await fixture.client.callTool({
      name: 'resume_agent_run', arguments: { run_id: RUN_ID, user_id: OTHER_USER_ID, owner_id: OTHER_USER_ID },
    });
    expect(result.isError).not.toBe(true);
    for (const call of apiMocks.callOrgxApiJson.mock.calls) {
      expect(call[3]).toMatchObject({ userId: USER_ID, orgxUserId: ORGX_USER_ID });
      expect(JSON.parse(String(call[2]?.body ?? '{}'))).not.toHaveProperty('user_id');
      expect(JSON.parse(String(call[2]?.body ?? '{}'))).not.toHaveProperty('owner_id');
    }
  });

  it.each([
    { label: 'no visible run', rows: [] },
    { label: 'different returned run ID', rows: [{ ...ownedRun, id: OTHER_RUN_ID }] },
    { label: 'different requester', rows: [{ ...ownedRun, requester_id: OTHER_USER_ID }] },
    { label: 'malformed returned row', rows: [null] },
  ])('denies $label without calling the resume endpoint', async ({ rows }) => {
    responseForOwnedLookup(rows);
    const result = await expectDeniedWithoutPost('entity_not_found', 404);
    expect(apiMocks.callOrgxApiJson).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(OTHER_USER_ID);
    expect(JSON.stringify(result)).not.toContain(OTHER_RUN_ID);
  });

  it.each([
    { label: 'missing data array', envelope: { ok: true } },
    { label: 'non-array data', envelope: { data: { ...ownedRun } } },
    { label: 'ambiguous multiple rows', envelope: { data: [ownedRun, { ...ownedRun, id: OTHER_RUN_ID }] } },
  ])('fails closed for $label without fallback or mutation', async ({ envelope }) => {
    apiMocks.callOrgxApiJson.mockResolvedValue(Response.json(envelope));
    await expectDeniedWithoutPost('run_ownership_verification_unavailable', 503);
    expect(apiMocks.callOrgxApiJson).toHaveBeenCalledTimes(1);
    expect(apiMocks.callOrgxApiJson.mock.calls[0]?.[3]).toMatchObject({ allowFallback: false });
  });

  it('fails closed when the primary ownership lookup throws', async () => {
    apiMocks.callOrgxApiJson.mockRejectedValue(new Error('Primary lookup fixture unavailable'));
    const result = await expectDeniedWithoutPost('run_ownership_verification_unavailable', 503);
    expect(apiMocks.callOrgxApiJson).toHaveBeenCalledTimes(1);
    expect(apiMocks.callOrgxApiJson.mock.calls[0]?.[3]).toMatchObject({ allowFallback: false });
    expect(JSON.stringify(result)).not.toContain('Primary lookup fixture unavailable');
  });

  it('uses the real HTTP actor-signing transport for both the ownership read and resume', async () => {
    const actual = await vi.importActual<typeof import('../src/orgxApi')>('../src/orgxApi');
    apiMocks.callOrgxApiJson.mockImplementation(actual.callOrgxApiJson);
    upstreamFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith('https://api.useorgx.test/api/entities?')) {
        return Response.json({ data: [ownedRun] });
      }
      if (url === `https://api.useorgx.test/api/agent-runs/${RUN_ID}/resume` && init?.method === 'POST') {
        return Response.json({ ok: true, run_id: RUN_ID, status: 'running', prior_status: 'paused' });
      }
      throw new Error('Unexpected HTTP request in ownership test');
    });
    const result = await fixture.client.callTool({ name: 'resume_agent_run', arguments: { run_id: RUN_ID } });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of upstreamFetch.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/api\.useorgx\.test\//);
      const headers = new Headers(init?.headers);
      expect(headers.get('X-Orgx-User-Id')).toBe(USER_ID);
      const signedActor = headers.get('X-Orgx-Actor-Token');
      expect(signedActor).toBeTruthy();
      const encoded = signedActor!.split('.')[0]!;
      const actor = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')));
      expect(actor).toMatchObject({ sub: USER_ID, orgx_user_id: ORGX_USER_ID, aud: 'orgx-api' });
      expect(actor.sub).not.toBe(OTHER_USER_ID);
    }
  });

  it('does not try the HTTP fallback or POST after a failed primary ownership read', async () => {
    const actual = await vi.importActual<typeof import('../src/orgxApi')>('../src/orgxApi');
    apiMocks.callOrgxApiJson.mockImplementation(actual.callOrgxApiJson);
    upstreamFetch.mockResolvedValue(new Response('Primary ownership fixture unavailable', { status: 503 }));
    await expectDeniedWithoutPost('run_ownership_verification_unavailable', 503);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    const [url, init] = upstreamFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/^https:\/\/api\.useorgx\.test\/api\/entities\?/);
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('does not replay a failed resume POST on the HTTP fallback', async () => {
    const actual = await vi.importActual<typeof import('../src/orgxApi')>('../src/orgxApi');
    apiMocks.callOrgxApiJson.mockImplementation(actual.callOrgxApiJson);
    upstreamFetch.mockImplementation(async (url: string) =>
      String(url).includes('/api/entities?')
        ? Response.json({ data: [ownedRun] })
        : new Response('Primary mutation fixture unavailable', { status: 503 })
    );
    const result = await fixture.client.callTool({ name: 'resume_agent_run', arguments: { run_id: RUN_ID } });
    expect(result.isError).toBe(true);
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
    expect(upstreamFetch.mock.calls.every(([url]) => String(url).startsWith('https://api.useorgx.test/'))).toBe(true);
  });

  it('rejects a malformed run UUID before any upstream request', async () => {
    const result = await fixture.client.callTool({ name: 'resume_agent_run', arguments: { run_id: 'not-a-run-uuid' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: 'invalid_input', status: 400 } });
    expect(apiMocks.callOrgxApiJson).not.toHaveBeenCalled();
  });

  it('rechecks the directory write grant after discovery, before ownership lookup', async () => {
    fixture.worker.props.scope = AUTHORIZATION_PRESETS.read.scopes.join(' ');
    await expectDeniedWithoutPost('insufficient_scope', 403);
    expect(apiMocks.callOrgxApiJson).not.toHaveBeenCalled();
  });

  it('does not discover the app-only mutation for a directory Read grant', async () => {
    const readFixture = await connectFixture('claude-directory', AUTHORIZATION_PRESETS.read.scopes.join(' '));
    try {
      const listed = await readFixture.client.listTools();
      expect(listed.tools.map((tool) => tool.name)).not.toContain('resume_agent_run');
      apiMocks.callOrgxApiJson.mockClear();
      const result = await readFixture.client.callTool({ name: 'resume_agent_run', arguments: { run_id: RUN_ID } });
      expect(result.isError).toBe(true);
      expect(apiMocks.callOrgxApiJson).not.toHaveBeenCalled();
    } finally {
      await Promise.allSettled([readFixture.client.close(), readFixture.worker.server.close()]);
    }
  });

  it('also enforces ownership on the existing v2 profile without changing its annotations', async () => {
    const v2Fixture = await connectFixture('v2');
    try {
      const listed = await v2Fixture.client.listTools();
      const resume = listed.tools.find((tool) => tool.name === 'resume_agent_run');
      expect(resume?.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
      responseForOwnedLookup([{ ...ownedRun, requester_id: OTHER_USER_ID }]);
      const result = await v2Fixture.client.callTool({ name: 'resume_agent_run', arguments: { run_id: RUN_ID } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: 'entity_not_found', status: 404 } });
      expect(businessPosts()).toEqual([]);
    } finally {
      await Promise.allSettled([v2Fixture.client.close(), v2Fixture.worker.server.close()]);
    }
  });
});
