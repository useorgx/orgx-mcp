import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AUTHORIZATION_PRESETS } from '../src/authorizationPolicy';
import { createEmptyMcpActivationState } from '../src/mcpActivationTracker';
import {
  buildPanelSnapshot,
  handlePanelSnapshot,
  PANEL_EVIDENCE_TITLE_MAX,
  PANEL_OPTION_LABEL_MAX,
  PANEL_TITLE_MAX,
  summarizePanelProof,
  type PanelSurfaceHost,
} from '../src/panelSurface';
import { createEmptyMcpSessionReentryState } from '../src/welcomeBackContext';

const apiMocks = vi.hoisted(() => ({
  callOrgxApiJson: vi.fn(),
  callOrgxApiRaw: vi.fn(),
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
  return { ...actual, callOrgxApiJson: apiMocks.callOrgxApiJson, callOrgxApiRaw: apiMocks.callOrgxApiRaw };
});
vi.mock('../src/posthogTelemetry', () => ({
  captureWorkerPosthogEvent: apiMocks.captureWorkerPosthogEvent,
  resolveAnonymousDistinctId: () => 'panel-test',
}));

const SESSION_WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '99999999-9999-4999-8999-999999999999';
const ORGX_USER = '33333333-3333-4333-8333-333333333333';
const INIT = '22222222-2222-4222-8222-222222222222';
const D1 = '3f1c2a9e-6b7d-4c1e-9a2b-1d2e3f4a5b6c';
const D2 = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
const D3 = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e';
const D4 = 'c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f';
const SECRET_TOKEN = 'wat_secret_single_use_token_value';
const EVIDENCE_BODY = 'FULL EVIDENCE BODY that must never reach the snapshot';

function packet(id: string, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'orgx.human-review-packet.v1',
    id: `pkt-${id}`,
    headDecisionId: id,
    question: `Question for ${id}?`,
    current: { state: 'pending', owner: null, blocked: false },
    recommendation: {
      status: 'ready',
      action: 'Approve',
      rationale: 'A long private rationale that is not part of the panel.',
      provenance: { provider: 'anthropic', model: 'x', runId: 'r', generatedAt: null },
    },
    evidence: Array.from({ length: 7 }, (_, index) => ({
      id: `ev-${index}`,
      title: `Evidence ${index} ${'x'.repeat(index === 0 ? 120 : 4)}`,
      summary: EVIDENCE_BODY,
      sourceUrl: index === 0 ? 'https://github.com/acme/repo/actions/runs/1' : index === 1 ? 'javascript:alert(1)' : null,
      sourcePointer: null,
      confidence: 0.9,
      freshness: null,
    })),
    consequences: { approve: 'The deploy job starts.', change: null, reject: 'The agent revises.', defer: null },
    references: [{ id: INIT, type: 'initiative', label: 'Release initiative', href: null }],
    createdAt: '2026-09-28T10:00:00.000Z',
    updatedAt: '2026-09-29T10:00:00.000Z',
    ...extra,
  };
}

function decision(id: string, urgency: string, createdAt: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    short_id: id.slice(0, 6),
    type: 'decision_queue',
    agent_id: 'eli',
    agent_name: 'Eli',
    summary: `Decision ${id} ${'long title '.repeat(30)}`,
    urgency,
    created_at: createdAt,
    context: { initiative_id: INIT, run_id: 'run-1' },
    options: [],
    review_packet: packet(id),
    widget_actionable: true,
    note: 'private rejection note',
    owner_email: 'owner@example.com',
    cost_cents: 1234,
    ...extra,
  };
}

const DECISIONS = [
  decision(D1, 'medium', '2026-09-27T10:00:00.000Z'),
  decision(D2, 'critical', '2026-09-30T10:00:00.000Z'),
  decision(D3, 'high', '2026-09-29T10:00:00.000Z'),
  decision(D4, 'low', '2026-09-20T10:00:00.000Z'),
];

function artifact(id: string, status: string, approver: unknown, approvedAt: string | null) {
  const record: Record<string, unknown> = {
    id,
    name: `Artifact ${id.slice(0, 4)} ${'t'.repeat(200)}`,
    status,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: approvedAt ?? '2026-09-01T00:00:00.000Z',
    description: 'artifact body that is not part of the panel',
  };
  if (approver !== undefined) {
    record.approved_by_user_id = approver;
    record.approved_at = approvedAt;
  }
  return record;
}

const ART_HUMAN = 'a1111111-1111-4111-8111-111111111111';
const ART_JUDGE = 'a2222222-2222-4222-8222-222222222222';
const ART_NULL = 'a3333333-3333-4333-8333-333333333333';
const ART_REVIEW = 'a4444444-4444-4444-8444-444444444444';
const ART_MEMBER = 'a5555555-5555-4555-8555-555555555555';

describe('buildPanelSnapshot', () => {
  it('orders the queue by urgency, keeps three, and focuses the most urgent', () => {
    const snapshot = buildPanelSnapshot({
      workspace: { id: SESSION_WS, name: 'Acme' },
      decisions: DECISIONS,
      artifacts: [],
    });
    expect(snapshot.schema).toBe('orgx.panel.v1');
    expect(snapshot.queue.map((item) => item.id)).toEqual([D2, D3, D1]);
    expect(snapshot.attention).toEqual({ pending: 4, oldest_at: '2026-09-20T10:00:00.000Z', blocking: false });
    expect(snapshot.focus?.id).toBe(D2);
    expect(snapshot.focus?.url).toBe(`https://useorgx.com/initiatives/${INIT}?focus=decisions&decision=${D2}`);
    expect(snapshot.selection).toEqual({ requested_id: null, status: 'default' });
  });

  it('clips titles, keeps at most five evidence titles, and drops non-https sources', () => {
    const snapshot = buildPanelSnapshot({ workspace: { id: SESSION_WS, name: 'Acme' }, decisions: DECISIONS, artifacts: [] });
    for (const item of snapshot.queue) expect(Array.from(item.title).length).toBeLessThanOrEqual(PANEL_TITLE_MAX);
    expect(snapshot.queue[0]!.title.endsWith('…')).toBe(true);
    expect(snapshot.focus!.evidence).toHaveLength(5);
    expect(snapshot.focus!.evidence_total).toBe(7);
    for (const item of snapshot.focus!.evidence) {
      expect(Array.from(item.title).length).toBeLessThanOrEqual(PANEL_EVIDENCE_TITLE_MAX);
    }
    expect(snapshot.focus!.evidence[0]!.source_url).toBe('https://github.com/acme/repo/actions/runs/1');
    expect(snapshot.focus!.evidence[1]!.source_url).toBeNull();
    expect(snapshot.focus!.consequence_if_approved).toBe('The deploy job starts.');
  });

  it('carries the options, multiselect flag and widget actions the server lists, clipped', () => {
    const snapshot = buildPanelSnapshot({
      workspace: { id: SESSION_WS, name: 'Acme' },
      decisions: [
        decision(D2, 'critical', '2026-09-30T10:00:00.000Z', {
          options: [
            { id: 'eu', label: 'EU', description: 'not carried' },
            { id: 'us', label: `US ${'x'.repeat(200)}` },
            'Third as a string',
          ],
          selection: 'multi',
        }),
        decision(D3, 'high', '2026-09-29T10:00:00.000Z', {
          widget_actions: [
            { action: 'approve', option_id: 'ship', label: 'Ship it' },
            { action: 'approve', option_id: 'wait', label: 'Wait' },
            { action: 'reject', label: 'Push back' },
            { action: 'mystery', label: 'Dropped' },
          ],
        }),
        decision(D1, 'medium', '2026-09-27T10:00:00.000Z'),
      ],
      artifacts: [],
    });
    expect(snapshot.focus!.options.map((o) => o.id)).toEqual(['eu', 'us', 'option-3']);
    expect(snapshot.focus!.options[2]!.label).toBe('Third as a string');
    expect(Array.from(snapshot.focus!.options[1]!.label).length).toBeLessThanOrEqual(PANEL_OPTION_LABEL_MAX);
    expect(JSON.stringify(snapshot.focus)).not.toContain('not carried');
    expect(snapshot.focus!.multiselect).toBe(true);
    expect(snapshot.focus!.widget_actions).toBeNull();
    expect(snapshot.queue.map((item) => item.option_count)).toEqual([3, 2, 0]);

    const second = buildPanelSnapshot({
      workspace: { id: SESSION_WS, name: 'Acme' },
      decisions: [decision(D3, 'high', '2026-09-29T10:00:00.000Z', {
        widget_actions: [
          { action: 'approve', option_id: 'ship', label: 'Ship it' },
          { action: 'reject', label: 'Push back' },
          { action: 'mystery', label: 'Dropped' },
        ],
      })],
      artifacts: [],
    });
    expect(second.focus!.widget_actions).toEqual([
      { kind: 'option', label: 'Ship it', option_id: 'ship' },
      { kind: 'reject', label: 'Push back', option_id: null },
    ]);
    expect(second.focus!.multiselect).toBe(false);
  });

  it('never carries evidence bodies, rationale, notes, emails, costs or tokens', () => {
    const snapshot = buildPanelSnapshot({
      workspace: { id: SESSION_WS, name: 'Acme' },
      decisions: DECISIONS,
      artifacts: [artifact(ART_HUMAN, 'approved', ORGX_USER, '2026-09-30T00:00:00.000Z')],
      viewerUserIds: [ORGX_USER],
    });
    const text = JSON.stringify(snapshot);
    for (const forbidden of [EVIDENCE_BODY, 'private rationale', 'private rejection note', 'owner@example.com', '1234', 'cost', 'token', 'artifact body', 'run-1']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('shows the selected decision, and an unknown selection as unavailable instead of another item', () => {
    const selected = buildPanelSnapshot({
      workspace: { id: SESSION_WS, name: 'Acme' },
      decisions: DECISIONS,
      artifacts: [],
      focus: { type: 'decision', id: D4 },
    });
    expect(selected.focus?.id).toBe(D4);
    expect(selected.selection.status).toBe('selected');
    const unknown = buildPanelSnapshot({
      workspace: { id: SESSION_WS, name: 'Acme' },
      decisions: DECISIONS,
      artifacts: [],
      focus: { type: 'decision', id: '00000000-0000-4000-8000-000000000000' },
    });
    expect(unknown.focus).toBeNull();
    expect(unknown.selection).toEqual({ requested_id: '00000000-0000-4000-8000-000000000000', status: 'unavailable' });
  });

  it('reports a failed decision read as degraded and no workspace as no_workspace', () => {
    expect(buildPanelSnapshot({ workspace: { id: SESSION_WS, name: null }, decisions: null, artifacts: [] })).toMatchObject({
      state: 'degraded',
      degraded: ['decisions_unavailable'],
      queue: [],
    });
    expect(buildPanelSnapshot({ workspace: null, decisions: DECISIONS, artifacts: [] })).toMatchObject({
      state: 'no_workspace',
      queue: [],
      focus: null,
    });
  });
});

describe('panel proof: accepted means approved by a person', () => {
  it('does not count precision-judge, null approvers or in_review as accepted', () => {
    const proof = summarizePanelProof(
      [
        artifact(ART_JUDGE, 'approved', 'system:precision-judge', '2026-09-30T00:00:00.000Z'),
        artifact(ART_NULL, 'approved', null, '2026-09-30T00:00:00.000Z'),
        artifact(ART_REVIEW, 'in_review', null, null),
      ],
      { userIds: [ORGX_USER] }
    );
    expect(proof.last_accepted).toBeNull();
    expect(proof.completed_unaccepted).toBe(3);
    expect(proof.approver_known).toBe(true);
  });

  it('names the latest human acceptance and who made it', () => {
    const proof = summarizePanelProof(
      [
        artifact(ART_MEMBER, 'approved', '44444444-4444-4444-8444-444444444444', '2026-09-29T00:00:00.000Z'),
        artifact(ART_HUMAN, 'approved', ORGX_USER, '2026-09-30T00:00:00.000Z'),
        artifact(ART_JUDGE, 'approved', 'system:precision-judge', '2026-10-01T00:00:00.000Z'),
      ],
      { userIds: [ORGX_USER] }
    );
    expect(proof.last_accepted).toMatchObject({
      artifact_id: ART_HUMAN,
      accepted_by: 'you',
      accepted_at: '2026-09-30T00:00:00.000Z',
      url: `https://useorgx.com/artifacts/${ART_HUMAN}`,
    });
    expect(Array.from(proof.last_accepted!.title).length).toBeLessThanOrEqual(PANEL_TITLE_MAX);
    expect(proof.completed_unaccepted).toBe(1);
  });

  it('says proof_unavailable instead of guessing when the API omits approved_by_user_id', () => {
    const snapshot = buildPanelSnapshot({
      workspace: { id: SESSION_WS, name: 'Acme' },
      decisions: [],
      artifacts: [artifact(ART_HUMAN, 'approved', undefined, null), artifact(ART_REVIEW, 'in_review', undefined, null)],
    });
    expect(snapshot.proof.last_accepted).toBeNull();
    expect(snapshot.proof.completed_unaccepted).toBe(1);
    expect(snapshot.degraded).toEqual(['proof_unavailable']);
  });
});

function fakeHost(overrides: Partial<PanelSurfaceHost> = {}) {
  const host: PanelSurfaceHost = {
    authRequired: vi.fn(() => null),
    viewerUserIds: vi.fn(() => ['session-user', ORGX_USER]),
    sessionWorkspace: vi.fn(() => ({ id: SESSION_WS, name: 'Acme' })),
    inferWorkspace: vi.fn(async () => null),
    fetchPendingDecisions: vi.fn(async () => ({
      ok: true,
      data: {
        decisions: DECISIONS,
        _widget_meta: { approval_tokens: { [D2]: SECRET_TOKEN, [D4]: 'tok-not-visible' }, token_ttl_seconds: 900 },
      },
    })),
    fetchArtifacts: vi.fn(async () => [artifact(ART_HUMAN, 'approved', ORGX_USER, '2026-09-30T00:00:00.000Z')]),
    run: vi.fn((runner) => runner()),
    ...overrides,
  };
  return host;
}

describe('handlePanelSnapshot', () => {
  it('reads the session workspace only and ignores an injected workspace_id', async () => {
    const host = fakeHost();
    const result = await handlePanelSnapshot(host, { workspace_id: OTHER_WS, focus: undefined });
    expect(host.fetchPendingDecisions).toHaveBeenCalledWith({ workspaceId: SESSION_WS, limit: 25 });
    expect(host.fetchArtifacts).toHaveBeenCalledWith({ workspaceId: SESSION_WS, limit: 50 });
    expect(JSON.stringify(result.structuredContent)).not.toContain(OTHER_WS);
  });

  it('puts approval tokens in result _meta for visible decisions only, never in structuredContent', async () => {
    const result = await handlePanelSnapshot(fakeHost(), {});
    expect(JSON.stringify(result.structuredContent)).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(result.content)).not.toContain(SECRET_TOKEN);
    expect(result._meta?.['orgx/widgetApproval']).toEqual({
      approval_tokens: { [D2]: SECRET_TOKEN },
      token_ttl_seconds: 900,
    });
  });

  it('passes the auth-required response through untouched', async () => {
    const authResult = { content: [{ type: 'text', text: 'Sign in' }], isError: true, _meta: { 'mcp/www_authenticate': ['Bearer x'] } };
    const host = fakeHost({ authRequired: vi.fn(() => authResult as never) });
    await expect(handlePanelSnapshot(host, {})).resolves.toBe(authResult);
    expect(host.fetchPendingDecisions).not.toHaveBeenCalled();
    expect(host.run).not.toHaveBeenCalled();
  });

  it('infers the workspace read-only when the session has none, and says no_workspace otherwise', async () => {
    const inferred = fakeHost({
      sessionWorkspace: vi.fn(() => null),
      inferWorkspace: vi.fn(async () => ({ id: SESSION_WS, name: 'Acme' })),
    });
    await handlePanelSnapshot(inferred, {});
    expect(inferred.fetchPendingDecisions).toHaveBeenCalledWith({ workspaceId: SESSION_WS, limit: 25 });

    const none = fakeHost({ sessionWorkspace: vi.fn(() => null) });
    const result = await handlePanelSnapshot(none, {});
    expect(result.structuredContent).toMatchObject({ state: 'no_workspace', workspace: null });
    expect(none.fetchPendingDecisions).not.toHaveBeenCalled();
    expect(result._meta).toBeUndefined();
  });

  it('keeps the last good parts when one read fails', async () => {
    const result = await handlePanelSnapshot(
      fakeHost({ fetchArtifacts: vi.fn(async () => { throw new Error('down'); }) }),
      {}
    );
    expect(result.structuredContent).toMatchObject({ state: 'ok', degraded: ['proof_unavailable'] });
  });
});

// ---------------------------------------------------------------------------
// The real worker: session scoping and no session side effects.
// ---------------------------------------------------------------------------

async function createWorker() {
  const { OrgXMcp } = await import('../src/index');
  const worker = Object.create(OrgXMcp.prototype) as Record<string, any>;
  worker.props = {
    profile: 'chatgpt',
    userId: 'panel-user',
    orgxUserId: ORGX_USER,
    scope: AUTHORIZATION_PRESETS.operate.scopes.join(' '),
  };
  worker.ctx = {
    id: { toString: () => 'panel-session' },
    storage: { get: vi.fn(async () => undefined), put: vi.fn(async () => undefined), sql: { exec: vi.fn(() => []) } },
    waitUntil: vi.fn((promise: Promise<unknown>) => promise),
  };
  worker.env = {
    ORGX_API_URL: 'https://api.useorgx.test',
    ORGX_WEB_URL: 'https://useorgx.test',
    MCP_SERVER_URL: 'https://mcp.useorgx.test',
    MCP_JWT_SECRET: 'test-only-secret',
    LIVE_FEED: {},
    OAUTH_KV: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) },
  };
  worker.sessionContext = { workspaceId: SESSION_WS, workspaceName: 'Acme', initiativeId: undefined };
  worker.sessionAuth = {};
  worker.sessionSqlInitialized = false;
  worker.mcpActivationState = createEmptyMcpActivationState();
  worker.mcpSessionReentryState = createEmptyMcpSessionReentryState();
  worker._isNewSession = false;
  worker.widgetDebugEvents = [];
  worker.toolResultGuidanceInstalled = false;
  worker.fetchEntityCollection = vi.fn(async () => [
    artifact(ART_JUDGE, 'approved', 'system:precision-judge', '2026-09-30T00:00:00.000Z'),
  ]);

  apiMocks.callOrgxApiJson.mockImplementation(async (_env: unknown, path: string, init?: RequestInit) => {
    if (path === '/api/tools/execute') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.tool_id === 'get_pending_decisions') {
        return Response.json({
          ok: true,
          data: {
            decisions: DECISIONS,
            total_pending: DECISIONS.length,
            _widget_meta: { approval_tokens: { [D2]: SECRET_TOKEN }, token_ttl_seconds: 900 },
          },
        });
      }
    }
    return Response.json({});
  });

  await worker._doInit();
  const spy = vi.spyOn(worker as never, 'maybeUpdateSessionInitiativeContext' as never);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'panel-test', version: '1.0.0' });
  await worker.server.connect(serverTransport);
  await client.connect(clientTransport);
  return { worker, client, spy };
}

describe('orgx_panel_snapshot on the worker', () => {
  afterEach(() => {
    apiMocks.callOrgxApiJson.mockReset();
    vi.restoreAllMocks();
  });

  it('lists the tool with its entrypoints and returns a valid snapshot scoped to the session', async () => {
    const { worker, client, spy } = await createWorker();
    const listed = await client.listTools();
    const tool = listed.tools.find((entry) => entry.name === 'orgx_panel_snapshot');
    expect(tool?._meta?.['openai/ui']).toEqual({ entrypoints: [{ type: 'global' }, { type: 'thread' }] });
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.outputSchema).toBeDefined();
    expect(Object.keys((tool?.inputSchema as { properties: Record<string, unknown> }).properties)).not.toContain('workspace_id');

    const sessionBefore = structuredClone(worker.sessionContext);
    const result = await client.callTool({ name: 'orgx_panel_snapshot', arguments: { workspace_id: OTHER_WS } });

    expect(result.isError).not.toBe(true);
    const executeCall = apiMocks.callOrgxApiJson.mock.calls.find((call) => call[1] === '/api/tools/execute');
    const body = JSON.parse(String(executeCall?.[2]?.body));
    expect(body).toMatchObject({
      tool_id: 'get_pending_decisions',
      args: { workspace_id: SESSION_WS, _widget_meta_channel: true },
      user_id: ORGX_USER,
    });
    expect(worker.fetchEntityCollection).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'artifact', workspaceId: SESSION_WS })
    );
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.schema).toBe('orgx.panel.v1');
    expect(structured.workspace).toEqual({ id: SESSION_WS, name: 'Acme' });
    expect(structured.proof).toEqual({ last_accepted: null, completed_unaccepted: 1 });
    expect(JSON.stringify(structured)).not.toContain(SECRET_TOKEN);
    expect(structured.live).toBeUndefined();
    expect((result._meta as Record<string, any>)['orgx/widgetApproval'].approval_tokens).toEqual({ [D2]: SECRET_TOKEN });
    expect(spy).not.toHaveBeenCalled();
    expect(worker.sessionContext).toEqual(sessionBefore);
    // Pays the cold import of the whole worker when run on its own.
  }, 20000);

  it('returns the existing auth-required response when signed out', async () => {
    const { worker, client } = await createWorker();
    worker.props = { profile: 'chatgpt' };
    worker.sessionAuth = {};
    const result = await client.callTool({ name: 'orgx_panel_snapshot', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as Record<string, any>).error.code).toBe('authentication_required');
    expect((result._meta as Record<string, unknown>)['mcp/www_authenticate']).toBeDefined();
    expect(apiMocks.callOrgxApiJson.mock.calls.some((call) => call[1] === '/api/tools/execute')).toBe(false);
  });
});
