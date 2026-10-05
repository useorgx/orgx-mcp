import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTHORIZATION_PRESETS } from '../src/authorizationPolicy';
import { createEmptyMcpActivationState } from '../src/mcpActivationTracker';
import { createEmptyMcpSessionReentryState } from '../src/welcomeBackContext';

const apiMocks = vi.hoisted(() => ({ callOrgxApiJson: vi.fn(), fetchContextPreparation: vi.fn() }));
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
vi.mock('../src/contextPack', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/contextPack')>(),
  fetchContextPreparation: apiMocks.fetchContextPreparation,
}));

const USER_ID = 'user_bootstrap_review_fixture';
const ORGX_USER_ID = '33333333-3333-4333-8333-333333333333';
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE_ID = '44444444-4444-4444-8444-444444444444';
const INITIATIVE_ID = '22222222-2222-4222-8222-222222222222';
const ownedWorkspace = { id: WORKSPACE_ID, type: 'workspace', name: 'Owned directory fixture' };
const priorContext = {
  workspaceId: OTHER_WORKSPACE_ID, workspaceName: 'Prior authorized fixture',
  initiativeId: '55555555-5555-4555-8555-555555555555',
};

async function connectFixture(profile = 'claude-directory') {
  const { OrgXMcp } = await import('../src/index');
  const worker = Object.create(OrgXMcp.prototype) as Record<string, any>;
  worker.props = {
    profile, userId: USER_ID, orgxUserId: ORGX_USER_ID,
    email: 'bootstrap-reviewer@example.test', scope: AUTHORIZATION_PRESETS.operate.scopes.join(' '),
  };
  const storagePut = vi.fn(async () => undefined);
  const sqlExec = vi.fn(() => []);
  worker.ctx = {
    id: { toString: () => `bootstrap-access-${profile}` },
    storage: { get: vi.fn(async () => undefined), put: storagePut, sql: { exec: sqlExec } },
    waitUntil: vi.fn((promise: Promise<unknown>) => promise),
  };
  worker.env = {
    ORGX_API_URL: 'https://api.useorgx.test', ORGX_WEB_URL: 'https://useorgx.test',
    ORGX_API_FALLBACK_URL: 'https://fallback.useorgx.test',
    ORGX_SERVICE_KEY: 'oxk-bootstrap-access-test-service-key',
    ORGX_INTERNAL_SECRET: 'bootstrap-access-test-signing-key',
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
  // Observation only: keep the real method, including its directory suppression.
  const saveContext = vi.spyOn(worker, 'saveSessionContext');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'bootstrap-access-fixture', version: '1.0.0' });
  await worker.server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, worker, saveContext, storagePut, sqlExec };
}

let fixture: Awaited<ReturnType<typeof connectFixture>>;
let upstreamFetch: ReturnType<typeof vi.fn>;
let lookupEnvelope: unknown;
let lookupFailure: Error | null;
let inferredWorkspace: { id: string; name: string } | null;
let fallbackWorkspaces: Record<string, unknown>[];

function guardedLookups() {
  return apiMocks.callOrgxApiJson.mock.calls.filter((call) => call[3]?.allowFallback === false);
}
function lookupParams(call: unknown[]) {
  return Object.fromEntries(new URL(String(call[1]), 'https://api.useorgx.test').searchParams);
}
async function callBootstrap(arguments_: Record<string, unknown>) {
  return fixture.client.callTool({ name: 'orgx_bootstrap', arguments: arguments_ });
}
function expectContextUnchanged(before: Record<string, unknown>) {
  expect(fixture.worker.sessionContext).toEqual(before);
  expect(fixture.saveContext).not.toHaveBeenCalled();
  expect(fixture.storagePut).not.toHaveBeenCalled();
  expect(fixture.sqlExec).not.toHaveBeenCalled();
  expect(apiMocks.fetchContextPreparation).not.toHaveBeenCalled();
}

beforeAll(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  upstreamFetch = vi.fn(async () => new Response('No real network in workspace access tests', { status: 503 }));
  vi.stubGlobal('fetch', upstreamFetch);
  fixture = await connectFixture();
}, 30000);

beforeEach(() => {
  fixture.worker.sessionContext = {};
  fixture.saveContext.mockClear();
  fixture.storagePut.mockClear();
  fixture.sqlExec.mockClear();
  upstreamFetch.mockReset();
  upstreamFetch.mockImplementation(async () => new Response('No real network in workspace access tests', { status: 503 }));
  lookupEnvelope = { data: [ownedWorkspace] };
  lookupFailure = null;
  inferredWorkspace = null;
  fallbackWorkspaces = [];
  apiMocks.fetchContextPreparation.mockReset();
  apiMocks.fetchContextPreparation.mockResolvedValue({ context_pack: null, context_capsule: null, context_delivery: null });
  apiMocks.callOrgxApiJson.mockReset();
  apiMocks.callOrgxApiJson.mockImplementation(async (_env: unknown, path: string, _init?: RequestInit, actor?: { allowFallback?: boolean }) => {
    if (actor?.allowFallback === false) {
      if (lookupFailure) throw lookupFailure;
      return Response.json(lookupEnvelope);
    }
    if (path === '/api/client/bootstrap?source_client=mcp') {
      return Response.json({ data: inferredWorkspace ? { workspace: inferredWorkspace } : {} });
    }
    if (path.startsWith('/api/entities?')) {
      const params = new URL(path, 'https://api.useorgx.test').searchParams;
      if (params.get('type') === 'initiative') return Response.json({ data: [{ id: INITIATIVE_ID, workspace_id: WORKSPACE_ID, title: 'Fixture initiative' }] });
      if (params.get('id')) return Response.json({ data: [] });
      return Response.json({ data: fallbackWorkspaces });
    }
    if (path === '/api/internal/mcp/tool-invocations') return Response.json({ ok: true });
    throw new Error(`Unexpected fixture API request: ${path}`);
  });
});

afterAll(async () => {
  if (fixture) await Promise.allSettled([fixture.client.close(), fixture.worker.server.close()]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Claude directory bootstrap workspace authorization', () => {
  it.each([
    { label: 'explicit workspace_id', arguments: { workspace_id: WORKSPACE_ID } },
    { label: 'explicit command_center_id alias', arguments: { command_center_id: WORKSPACE_ID } },
  ])('verifies $label against the exact signed actor before binding or preparing context', async ({ arguments: args }) => {
    const result = await callBootstrap(args);
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(guardedLookups()).toHaveLength(1);
    expect(lookupParams(guardedLookups()[0]!)).toEqual({ type: 'workspace', id: WORKSPACE_ID, limit: '1' });
    expect(guardedLookups()[0]?.[2]?.method ?? 'GET').toBe('GET');
    expect(guardedLookups()[0]?.[3]).toMatchObject({ userId: USER_ID, orgxUserId: ORGX_USER_ID, allowFallback: false });
    expect(fixture.worker.sessionContext).toMatchObject({ workspaceId: WORKSPACE_ID, workspaceName: ownedWorkspace.name });
    expect(result.structuredContent).toMatchObject({ workspace: { id: WORKSPACE_ID, name: ownedWorkspace.name } });
    expect(fixture.saveContext).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchContextPreparation).toHaveBeenCalledExactlyOnceWith(fixture.worker.env, USER_ID, WORKSPACE_ID, undefined);
    expect(apiMocks.callOrgxApiJson.mock.invocationCallOrder[0]).toBeLessThan(fixture.saveContext.mock.invocationCallOrder[0]!);
    expect(fixture.saveContext.mock.invocationCallOrder[0]).toBeLessThan(apiMocks.fetchContextPreparation.mock.invocationCallOrder[0]!);
    expect(fixture.storagePut).not.toHaveBeenCalled();
    expect(fixture.sqlExec).not.toHaveBeenCalled();
  });

  it('rechecks a currently bound workspace before preparing its context', async () => {
    fixture.worker.sessionContext = { workspaceId: WORKSPACE_ID, workspaceName: ownedWorkspace.name };
    const result = await callBootstrap({});
    expect(result.isError).not.toBe(true);
    expect(guardedLookups()).toHaveLength(1);
    expect(lookupParams(guardedLookups()[0]!)).toEqual({ type: 'workspace', id: WORKSPACE_ID, limit: '1' });
    expect(fixture.saveContext).not.toHaveBeenCalled();
    expect(apiMocks.fetchContextPreparation).toHaveBeenCalledWith(fixture.worker.env, USER_ID, WORKSPACE_ID, undefined);
    expect(apiMocks.callOrgxApiJson.mock.calls.some((call) => String(call[1]).startsWith('/api/client/bootstrap'))).toBe(false);
  });

  it.each(['client bootstrap', 'workspace collection fallback'])('checks an ID inferred from %s rather than trusting the candidate', async (source) => {
    if (source === 'client bootstrap') inferredWorkspace = { id: WORKSPACE_ID, name: 'Unverified candidate name' };
    else fallbackWorkspaces = [{ ...ownedWorkspace, name: 'Unverified fallback name', is_default: true }];
    const result = await callBootstrap({});
    expect(result.isError).not.toBe(true);
    expect(guardedLookups()).toHaveLength(1);
    expect(lookupParams(guardedLookups()[0]!)).toEqual({ type: 'workspace', id: WORKSPACE_ID, limit: '1' });
    expect(fixture.worker.sessionContext).toMatchObject({ workspaceId: WORKSPACE_ID, workspaceName: ownedWorkspace.name });
    expect(apiMocks.fetchContextPreparation).toHaveBeenCalledWith(fixture.worker.env, USER_ID, WORKSPACE_ID, undefined);
  });

  it('verifies the workspace inferred from an initiative parent before binding the initiative', async () => {
    const result = await callBootstrap({ initiative_id: INITIATIVE_ID });
    expect(result.isError).not.toBe(true);
    expect(guardedLookups()).toHaveLength(1);
    expect(lookupParams(guardedLookups()[0]!)).toEqual({ type: 'workspace', id: WORKSPACE_ID, limit: '1' });
    expect(fixture.worker.sessionContext).toMatchObject({ workspaceId: WORKSPACE_ID, initiativeId: INITIATIVE_ID });
    expect(apiMocks.fetchContextPreparation).toHaveBeenCalledWith(fixture.worker.env, USER_ID, WORKSPACE_ID, INITIATIVE_ID);
  });

  it.each([
    { label: 'invisible workspace', envelope: { data: [] } },
    { label: 'mismatched workspace ID', envelope: { data: [{ ...ownedWorkspace, id: OTHER_WORKSPACE_ID }] } },
    { label: 'null workspace row', envelope: { data: [null] } },
    { label: 'array workspace row', envelope: { data: [[]] } },
  ])('denies an $label and preserves the previous workspace and initiative', async ({ envelope }) => {
    fixture.worker.sessionContext = structuredClone(priorContext);
    lookupEnvelope = envelope;
    const result = await callBootstrap({ workspace_id: WORKSPACE_ID });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: 'entity_not_found', status: 404 } });
    expectContextUnchanged(priorContext);
    expect(guardedLookups()).toHaveLength(1);
    expect(apiMocks.callOrgxApiJson.mock.calls).toHaveLength(1);
  });

  it.each(['currently bound', 'client-inferred', 'collection-inferred', 'initiative-inferred'])('also rejects an inaccessible %s workspace before any binding/context read', async (source) => {
    if (source === 'currently bound') fixture.worker.sessionContext = structuredClone(priorContext);
    if (source === 'client-inferred') inferredWorkspace = { id: WORKSPACE_ID, name: 'Unverified candidate' };
    if (source === 'collection-inferred') fallbackWorkspaces = [{ ...ownedWorkspace, is_default: true }];
    const before = structuredClone(fixture.worker.sessionContext);
    lookupEnvelope = { data: [] };
    const result = await callBootstrap(source === 'initiative-inferred' ? { initiative_id: INITIATIVE_ID } : {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: 'entity_not_found', status: 404 } });
    expectContextUnchanged(before);
  });

  it.each([
    { label: 'missing data', envelope: { ok: true } },
    { label: 'non-array data', envelope: { data: ownedWorkspace } },
    { label: 'ambiguous rows', envelope: { data: [ownedWorkspace, { ...ownedWorkspace, id: OTHER_WORKSPACE_ID }] } },
  ])('fails closed on $label before changing context', async ({ envelope }) => {
    fixture.worker.sessionContext = structuredClone(priorContext);
    lookupEnvelope = envelope;
    const result = await callBootstrap({ workspace_id: WORKSPACE_ID });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: 'workspace_access_verification_unavailable', status: 503 } });
    expectContextUnchanged(priorContext);
    expect(guardedLookups()).toHaveLength(1);
  });

  it('fails closed if the primary workspace access lookup throws', async () => {
    fixture.worker.sessionContext = structuredClone(priorContext);
    lookupFailure = new Error('Primary workspace fixture unavailable');
    const result = await callBootstrap({ workspace_id: WORKSPACE_ID });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: 'workspace_access_verification_unavailable', status: 503 } });
    expectContextUnchanged(priorContext);
    expect(JSON.stringify(result)).not.toContain('Primary workspace fixture unavailable');
  });

  it('does not issue an exact-ID authorization lookup or prepare context when no candidate exists', async () => {
    const result = await callBootstrap({});
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ workspace: null, initiative: null });
    expect(guardedLookups()).toHaveLength(0);
    expect(apiMocks.callOrgxApiJson.mock.calls.every((call) => !new URL(String(call[1]), 'https://api.useorgx.test').searchParams.has('id'))).toBe(true);
    expectContextUnchanged({});
  });

  it('checks the actual signed HTTP actor and exact ID on the primary origin', async () => {
    const actual = await vi.importActual<typeof import('../src/orgxApi')>('../src/orgxApi');
    apiMocks.callOrgxApiJson.mockImplementation(actual.callOrgxApiJson);
    upstreamFetch.mockResolvedValue(Response.json({ data: [ownedWorkspace] }));
    const result = await callBootstrap({ workspace_id: WORKSPACE_ID, user_id: 'user_spoofed_fixture' });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    const [url, init] = upstreamFetch.mock.calls[0]!;
    const requestUrl = new URL(String(url));
    expect(requestUrl.origin).toBe('https://api.useorgx.test');
    expect(Object.fromEntries(requestUrl.searchParams)).toEqual({ type: 'workspace', id: WORKSPACE_ID, limit: '1' });
    const headers = new Headers(init?.headers);
    expect(headers.get('X-Orgx-User-Id')).toBe(USER_ID);
    const actorToken = headers.get('X-Orgx-Actor-Token');
    expect(actorToken).toBeTruthy();
    const actor = JSON.parse(atob(actorToken!.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/')));
    expect(actor).toMatchObject({ sub: USER_ID, orgx_user_id: ORGX_USER_ID, aud: 'orgx-api' });
  });

  it('uses no HTTP fallback and retains the prior context when the primary returns 503', async () => {
    fixture.worker.sessionContext = structuredClone(priorContext);
    const actual = await vi.importActual<typeof import('../src/orgxApi')>('../src/orgxApi');
    apiMocks.callOrgxApiJson.mockImplementation(actual.callOrgxApiJson);
    upstreamFetch.mockResolvedValue(new Response('Primary workspace fixture unavailable', { status: 503 }));
    const result = await callBootstrap({ workspace_id: WORKSPACE_ID });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: 'workspace_access_verification_unavailable', status: 503 } });
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect(String(upstreamFetch.mock.calls[0]?.[0])).toMatch(/^https:\/\/api\.useorgx\.test\/api\/entities\?/);
    expectContextUnchanged(priorContext);
  });

  it.each(['v2', 'chatgpt', 'claude-plugin'])('preserves the existing %s bootstrap path without a directory guard', async (profile) => {
    const other = await connectFixture(profile);
    try {
      apiMocks.callOrgxApiJson.mockClear();
      other.saveContext.mockClear();
      const result = await other.client.callTool({ name: 'orgx_bootstrap', arguments: { workspace_id: WORKSPACE_ID } });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(guardedLookups()).toHaveLength(0);
      const workspaceReads = apiMocks.callOrgxApiJson.mock.calls.filter((call) => String(call[1]).startsWith('/api/entities?'));
      expect(workspaceReads).toHaveLength(1);
      expect(lookupParams(workspaceReads[0]!)).toEqual({ type: 'workspace', id: WORKSPACE_ID, limit: '1' });
      expect(other.worker.sessionContext.workspaceId).toBe(WORKSPACE_ID);
      expect(other.saveContext).toHaveBeenCalledTimes(1);
      expect(apiMocks.fetchContextPreparation).toHaveBeenCalledWith(other.worker.env, USER_ID, WORKSPACE_ID, undefined);
    } finally {
      await Promise.allSettled([other.client.close(), other.worker.server.close()]);
    }
  });
});
