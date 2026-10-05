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

const USER_ID = 'user_directory_proof_fixture';
const ORGX_USER_ID = '33333333-3333-4333-8333-333333333333';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const ARTIFACT_ID = '44444444-4444-4444-8444-444444444444';
const ATTACH_PATH = '/api/client/artifacts';
const VERIFY_PATH = `/api/entities/verify?type=task&id=${TASK_ID}`;
const COMPLETE_PATH = `/api/entities/task/${TASK_ID}/complete`;
const PROOF_PATHS = [ATTACH_PATH, VERIFY_PATH, COMPLETE_PATH];
const linkedArtifact = {
  artifact_type: 'eng.release_evidence',
  external_url: 'https://proof.example.test/release/fixture',
  name: 'Reviewer fixture release evidence',
  preview_markdown: 'Fixture evidence only; no production operation.',
};
const proofArguments = {
  type: 'task', id: TASK_ID, artifact: linkedArtifact,
  verification: ['Fixture verification receipt'], note: 'Complete reviewer fixture with linked proof',
};

async function connectFixture() {
  const { OrgXMcp } = await import('../src/index');
  const worker = Object.create(OrgXMcp.prototype) as Record<string, any>;
  worker.props = {
    profile: 'claude-directory', userId: USER_ID, orgxUserId: ORGX_USER_ID,
    email: 'proof-reviewer@example.test',
    scope: AUTHORIZATION_PRESETS.operate.scopes.join(' '), workspace_id: WORKSPACE_ID,
  };
  worker.ctx = {
    id: { toString: () => 'directory-proof-fixture' },
    storage: {
      get: vi.fn(async () => undefined), put: vi.fn(async () => undefined),
      sql: { exec: vi.fn(() => []) },
    },
    waitUntil: vi.fn((promise: Promise<unknown>) => promise),
  };
  worker.env = {
    ORGX_API_URL: 'https://api.useorgx.test', ORGX_WEB_URL: 'https://useorgx.test',
    ORGX_API_FALLBACK_URL: 'https://fallback.useorgx.test',
    ORGX_SERVICE_KEY: 'oxk-directory-proof-test-service-key',
    ORGX_INTERNAL_SECRET: 'directory-proof-test-signing-key',
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
  const client = new Client({ name: 'directory-proof-fixture', version: '1.0.0' });
  await worker.server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, worker };
}

let fixture: Awaited<ReturnType<typeof connectFixture>>;
let upstreamFetch: ReturnType<typeof vi.fn>;

function apiResponse(path: string, verification: Record<string, unknown> = { verified: true, blockers: [] }) {
  if (path === ATTACH_PATH) return Response.json({ ok: true, artifact_id: ARTIFACT_ID, status: 'in_review' });
  if (path === VERIFY_PATH) return Response.json({ verification });
  if (path === COMPLETE_PATH) return Response.json({ ok: true, id: TASK_ID, status: 'completed' });
  throw new Error(`Unexpected proof API fixture path: ${path}`);
}

async function callProof(argumentsOverride: Record<string, unknown> = {}) {
  return fixture.client.callTool({
    name: 'orgx_complete_with_proof', arguments: { ...proofArguments, ...argumentsOverride },
  });
}

beforeAll(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  upstreamFetch = vi.fn(async () => new Response('No real network in directory proof tests', { status: 503 }));
  vi.stubGlobal('fetch', upstreamFetch);
  fixture = await connectFixture();
}, 30000);

beforeEach(() => {
  apiMocks.callOrgxApiJson.mockReset();
  apiMocks.callOrgxApiJson.mockImplementation(async (_env: unknown, path: string) => apiResponse(path));
  upstreamFetch.mockReset();
  upstreamFetch.mockImplementation(async () => new Response('No real network in directory proof tests', { status: 503 }));
});

afterAll(async () => {
  if (fixture) await Promise.allSettled([fixture.client.close(), fixture.worker.server.close()]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('directory proof executes the canonical attachment and completion gates', () => {
  it('attaches linked proof in review, verifies it, and only then completes with the signed actor on the primary', async () => {
    const result = await callProof();
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: true, status: 'completed', proof_attached: true,
      entity_type: 'task', entity_id: TASK_ID, verification: { verified: true },
    });
    expect(apiMocks.callOrgxApiJson.mock.calls.map((call) => call[1])).toEqual(PROOF_PATHS);
    const [attach, verify, complete] = apiMocks.callOrgxApiJson.mock.calls;
    expect(attach![2]?.method).toBe('POST');
    expect(verify![2]?.method ?? 'GET').toBe('GET');
    expect(complete![2]?.method).toBe('POST');
    const attachment = JSON.parse(String(attach![2]?.body));
    expect(attachment).toMatchObject({
      entity_type: 'task', entity_id: TASK_ID, artifact_type: linkedArtifact.artifact_type,
      external_url: linkedArtifact.external_url, status: 'in_review',
      created_by_type: 'agent', created_by_id: USER_ID,
      metadata: {
        schema_validated: false, schema_validated_artifact: false,
        proof_state: 'in_review', quality_eval_state: 'missing',
        outcome_event_status: 'completion_claimed', next_action: 'verify_before_claiming_outcome',
        verification: proofArguments.verification,
        proof: { state: 'in_review', eval: { status: 'missing' }, outcome_status: 'completion_claimed' },
      },
    });
    expect(JSON.parse(String(complete![2]?.body))).toEqual({
      note: proofArguments.note, reason: proofArguments.note, user_id: USER_ID,
    });
    for (const call of apiMocks.callOrgxApiJson.mock.calls) {
      expect(call[3]).toMatchObject({
        userId: USER_ID, orgxUserId: ORGX_USER_ID, userEmail: 'proof-reviewer@example.test', allowFallback: false,
      });
    }
  });

  it('rejects empty, unlinked, untyped, approved, or fabricated proof metadata before any backend call', async () => {
    const invalidArtifacts = [
      {},
      { artifact_type: linkedArtifact.artifact_type },
      { external_url: linkedArtifact.external_url },
      { ...linkedArtifact, status: 'approved' },
      { ...linkedArtifact, metadata: { proof_state: 'approved', quality_eval_state: 'passed' } },
    ];
    for (const artifact of invalidArtifacts) {
      const result = await callProof({ artifact });
      expect(result.isError, JSON.stringify(result.content)).toBe(true);
      expect(apiMocks.callOrgxApiJson).not.toHaveBeenCalled();
    }
  });

  it('retains the attached proof and reports verifier blockers without final completion or treating ready=true as verified', async () => {
    for (const verification of [
      { verified: false, blockers: ['Proof still needs human review'] },
      { ready: true, blockers: ['No explicit verification result'] },
    ]) {
      apiMocks.callOrgxApiJson.mockClear();
      apiMocks.callOrgxApiJson.mockImplementation(async (_env: unknown, path: string) => apiResponse(path, verification));
      const result = await callProof();
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: false, proof_attached: true, verification,
        entity_type: 'task', entity_id: TASK_ID,
      });
      expect(JSON.stringify(result.content)).toContain(verification.blockers[0]);
      expect(apiMocks.callOrgxApiJson.mock.calls.map((call) => call[1])).toEqual([ATTACH_PATH, VERIFY_PATH]);
    }
  });

  it('uses the real actor-signing HTTP transport for every proof API request', async () => {
    const actual = await vi.importActual<typeof import('../src/orgxApi')>('../src/orgxApi');
    apiMocks.callOrgxApiJson.mockImplementation(actual.callOrgxApiJson);
    upstreamFetch.mockImplementation(async (url: string) => {
      const parsed = new URL(String(url));
      expect(parsed.origin).toBe('https://api.useorgx.test');
      return apiResponse(`${parsed.pathname}${parsed.search}`);
    });
    const result = await callProof();
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(upstreamFetch.mock.calls.map(([url]) => {
      const parsed = new URL(String(url));
      return `${parsed.pathname}${parsed.search}`;
    })).toEqual(PROOF_PATHS);
    for (const [_url, init] of upstreamFetch.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get('X-Orgx-User-Id')).toBe(USER_ID);
      const actorToken = headers.get('X-Orgx-Actor-Token');
      expect(actorToken).toBeTruthy();
      const encoded = actorToken!.split('.')[0]!;
      const actor = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')));
      expect(actor).toMatchObject({ sub: USER_ID, orgx_user_id: ORGX_USER_ID, aud: 'orgx-api' });
    }
  });

  it('stops at any unavailable primary proof endpoint without fallback, replay, or advancing the flow', async () => {
    const actual = await vi.importActual<typeof import('../src/orgxApi')>('../src/orgxApi');
    apiMocks.callOrgxApiJson.mockImplementation(actual.callOrgxApiJson);
    for (let failedIndex = 0; failedIndex < PROOF_PATHS.length; failedIndex += 1) {
      upstreamFetch.mockClear();
      upstreamFetch.mockImplementation(async (url: string) => {
        const parsed = new URL(String(url));
        expect(parsed.origin).toBe('https://api.useorgx.test');
        const path = `${parsed.pathname}${parsed.search}`;
        if (path === PROOF_PATHS[failedIndex]) return new Response('Primary fixture unavailable', { status: 503 });
        return apiResponse(path);
      });
      const result = await callProof();
      expect(result.isError, JSON.stringify(result.content)).toBe(true);
      expect(upstreamFetch.mock.calls.map(([url]) => {
        const parsed = new URL(String(url));
        return `${parsed.pathname}${parsed.search}`;
      })).toEqual(PROOF_PATHS.slice(0, failedIndex + 1));
      expect(result.structuredContent).not.toMatchObject({ ok: true, status: 'completed' });
    }
  });
});
