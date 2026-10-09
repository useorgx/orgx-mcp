import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AUTHORIZATION_PRESETS } from '../src/authorizationPolicy';
import { WIDGET_OUTPUT_SCHEMAS } from '../src/openaiOutputSchemas/widgets';
import { createEmptyMcpActivationState } from '../src/mcpActivationTracker';
import {
  buildPanelSnapshot,
  handlePanelSnapshot,
  PANEL_EVIDENCE_TITLE_MAX,
  PANEL_OPTION_LABEL_MAX,
  PANEL_TITLE_MAX,
  normalizeAppProof,
  summarizePanelProof,
  type PanelSnapshot,
  type PanelSurfaceHost,
  panelAsker,
  buildPanelWork,
} from '../src/panelSurface';
import { createEmptyMcpSessionReentryState } from '../src/welcomeBackContext';

const apiMocks = vi.hoisted(() => ({
  callOrgxApiJson: vi.fn(),
  callOrgxApiRaw: vi.fn(),
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
  it('orders the whole queue by urgency and focuses the most urgent', () => {
    const snapshot = buildPanelSnapshot({
      workspace: { id: SESSION_WS, name: 'Acme' },
      decisions: DECISIONS,
      artifacts: [],
    });
    expect(snapshot.schema).toBe('orgx.panel.v1');
    expect(snapshot.queue.map((item) => item.id)).toEqual([D2, D3, D1, D4]);
    expect(snapshot.attention).toEqual({ pending: 4, oldest_at: '2026-09-20T10:00:00.000Z', blocking: false });
    expect(snapshot.focus?.id).toBe(D2);
    // The decision page (the initiative page never read ?decision=).
    expect(snapshot.focus?.url).toBe(`https://useorgx.com/decisions/${D2}`);
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
    // The provisional list becomes the contract: one option is the approval, Push back keeps its label.
    expect(second.focus!.widget_actions).toEqual({
      kind: 'decision',
      actions: ['approve', 'reject'],
      labels: { approve: 'Ship it', reject: 'Push back' },
      reject_requires_reason: true,
      answer: null,
      selection: {
        mode: 'single',
        options: [{ id: 'ship', label: 'Ship it', description: null, implied_action: null, requires_reason: false }],
        min: 1,
        max: 1,
        required_for: ['approve'],
      },
    });
    expect(second.focus!.multiselect).toBe(false);
  });

  it('carries the app widget_actions contract, clipped, with the item kind', () => {
    const contract = {
      kind: 'decision',
      actions: ['approve', 'reject'],
      labels: { approve: 'Confirm selection', reject: `Request changes ${'x'.repeat(80)}` },
      reject_requires_reason: true,
      answer: { required_for: ['approve', 'bogus'], max_length: 5000 },
      selection: {
        mode: 'multiple',
        options: [
          { id: 'eu', label: 'EU', description: 'd'.repeat(400), implied_action: null, requires_reason: false },
          { id: 'us', label: 'US', description: null, implied_action: 'approve', requires_reason: true },
          { id: 'x'.repeat(121), label: 'Too long an id', description: null, implied_action: null, requires_reason: false },
          { id: 'stop', label: 'Stop', description: null, implied_action: 'reject', requires_reason: false },
        ],
        min: 1,
        max: 9,
        required_for: ['approve', 'reject'],
      },
    };
    const snapshot = buildPanelSnapshot({
      workspace: { id: SESSION_WS, name: 'Acme' },
      decisions: [decision(D2, 'critical', '2026-09-30T10:00:00.000Z', { widget_actions: contract })],
      artifacts: [],
    });
    const actions = snapshot.focus!.widget_actions!;
    expect(snapshot.focus!.kind).toBe('decision');
    expect(actions.labels.approve).toBe('Confirm selection');
    expect(Array.from(actions.labels.reject).length).toBeLessThanOrEqual(40);
    expect(actions.answer).toEqual({ required_for: ['approve'], max_length: 2000 });
    expect(actions.selection!.options.map((o) => o.id)).toEqual(['eu', 'us', 'stop']);
    expect(Array.from(actions.selection!.options[0]!.description!).length).toBeLessThanOrEqual(140);
    expect(actions.selection!.options[1]).toMatchObject({ implied_action: 'approve', requires_reason: true });
    expect(actions.selection).toMatchObject({ mode: 'multiple', min: 1, max: 3, required_for: ['approve', 'reject'] });
    expect(snapshot.queue[0]!.widget_actions).toEqual(actions);
    expect(snapshot.queue[0]!.option_count).toBe(3);
    expect(WIDGET_OUTPUT_SCHEMAS.orgx_panel_snapshot.safeParse(snapshot).success).toBe(true);
  });

  it('includes agent-run approvals and gateway actions with their own kind and link', () => {
    const RUN = 'e5555555-5555-4555-8555-555555555555';
    const ACTION = 'f6666666-6666-4666-8666-666666666666';
    const snapshot = buildPanelSnapshot({
      workspace: { id: SESSION_WS, name: 'Acme' },
      decisions: [
        { id: D2, type: 'approval', agent_name: 'Agent', summary: 'Resume the import run?', urgency: 'high', created_at: '2026-09-30T10:00:00.000Z', context: { run_id: RUN } },
        {
          id: ACTION,
          type: 'action',
          agent_name: 'Mark',
          summary: 'send_email (gmail.send)',
          urgency: 'critical',
          created_at: '2026-09-30T11:00:00.000Z',
          context: { mission_id: 'm-1' },
          options: [],
          widget_actions: { kind: 'action', actions: ['approve', 'reject'], labels: { approve: 'Approve', reject: 'Deny' }, reject_requires_reason: false, answer: null, selection: null },
        },
      ],
      artifacts: [],
    });
    expect(snapshot.queue.map((item) => [item.title, item.kind, item.url])).toEqual([
      ['send_email (gmail.send)', 'action', 'https://useorgx.com/decisions?status=pending'],
      ['Resume the import run?', 'approval', `https://useorgx.com/runs/${RUN}`],
    ]);
    expect(snapshot.focus).toMatchObject({ id: ACTION, kind: 'action', question: 'send_email (gmail.send)' });
    expect(snapshot.focus!.widget_actions!.labels.reject).toBe('Deny');
    expect(snapshot.queue[1]!.widget_actions).toBeNull();
    expect(WIDGET_OUTPUT_SCHEMAS.orgx_panel_snapshot.safeParse(snapshot).success).toBe(true);
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

describe('panel proof from the app acceptance ledger', () => {
  const base = { workspace: { id: SESSION_WS, name: 'Acme' }, decisions: [] as unknown[] };

  it('prefers the ledger proof over the artifact read and rebuilds the link', () => {
    const snapshot = buildPanelSnapshot({
      ...base,
      artifacts: [artifact(ART_JUDGE, 'approved', 'system:precision-judge', null)],
      appProof: {
        last_accepted: {
          artifact_id: ART_HUMAN,
          title: 'Release checklist v3',
          accepted_at: '2026-09-30T00:00:00.000Z',
          accepted_by: 'you',
          url: 'https://evil.example/phish',
        },
        completed_unaccepted: 2,
      },
    });
    expect(snapshot.proof).toEqual({
      last_accepted: {
        artifact_id: ART_HUMAN,
        title: 'Release checklist v3',
        accepted_at: '2026-09-30T00:00:00.000Z',
        accepted_by: 'you',
        url: `https://useorgx.com/artifacts/${ART_HUMAN}`,
      },
      completed_unaccepted: 2,
    });
    expect(snapshot.degraded).toEqual([]);
  });

  it('says proof_unavailable when the app could not read the ledger', () => {
    const snapshot = buildPanelSnapshot({
      ...base,
      artifacts: [artifact(ART_HUMAN, 'approved', ORGX_USER, '2026-09-30T00:00:00.000Z')],
      appProof: null,
    });
    expect(snapshot.proof.last_accepted).toBeNull();
    expect(snapshot.degraded).toEqual(['proof_unavailable']);
  });

  it('treats an unknown count as zero and a malformed record as unavailable', () => {
    expect(normalizeAppProof({ last_accepted: null, completed_unaccepted: null })).toEqual({
      last_accepted: null,
      completed_unaccepted: 0,
    });
    expect(normalizeAppProof({ last_accepted: { artifact_id: 'not-a-uuid' } })).toBeNull();
    expect(normalizeAppProof({ last_accepted: 'yes' })).toBeNull();
  });

  it('falls back to the artifact read when the app sends no proof', () => {
    const snapshot = buildPanelSnapshot({
      ...base,
      artifacts: [artifact(ART_HUMAN, 'approved', ORGX_USER, '2026-09-30T00:00:00.000Z')],
      viewerUserIds: [ORGX_USER],
    });
    expect(snapshot.proof.last_accepted).toMatchObject({ artifact_id: ART_HUMAN, accepted_by: 'you' });
  });
});

// A token for a decision the snapshot does not carry must never reach the widget.
const OTHER_DECISION = 'd9999999-9999-4999-8999-999999999999';

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
        _widget_meta: { approval_tokens: { [D2]: SECRET_TOKEN, [OTHER_DECISION]: 'tok-not-visible' }, token_ttl_seconds: 900 },
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
      if (body.tool_id === 'get_agent_status') {
        return Response.json({
          ok: true,
          data: {
            agents: [
              { agent_id: 'engineering-agent', agent_name: 'Eli', status: 'running', current_tasks: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Reconcile telemetry', status: 'in_progress' }] },
              { agent_id: 'design-agent', agent_name: 'Dana', status: 'blocked', current_activity: 'Waiting on a decision' },
              { agent_id: 'product-agent', agent_name: 'Pace', status: 'idle' },
            ],
          },
        });
      }
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

  it('reads In progress through the same agent-status read and projection as get_agent_status, only when asked', async () => {
    const { worker, client, spy } = await createWorker();
    const enrich = vi.spyOn(worker as never, 'maybeEnrichWithArtifactProof' as never);
    const sessionBefore = structuredClone(worker.sessionContext);
    apiMocks.callOrgxApiJson.mockClear();
    apiMocks.callOrgxApiRaw.mockClear();
    worker.fetchEntityCollection.mockClear();

    const rejected = await client.callTool({ name: 'orgx_panel_snapshot', arguments: { view: 'work', workspace_id: OTHER_WS } });
    expect(rejected.isError).toBe(true);
    expect(apiMocks.callOrgxApiJson).not.toHaveBeenCalled();
    expect(apiMocks.callOrgxApiRaw).not.toHaveBeenCalled();
    expect(worker.fetchEntityCollection).not.toHaveBeenCalled();
    expect(enrich).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(worker.sessionContext).toEqual(sessionBefore);

    const plain = await client.callTool({ name: 'orgx_panel_snapshot', arguments: {} });
    expect((plain.structuredContent as Record<string, unknown>).work).toBeUndefined();
    const toolIds = () => apiMocks.callOrgxApiJson.mock.calls
      .filter((call) => call[1] === '/api/tools/execute')
      .map((call) => JSON.parse(String(call[2]?.body)).tool_id);
    expect(toolIds()).not.toContain('get_agent_status');

    const result = await client.callTool({ name: 'orgx_panel_snapshot', arguments: { view: 'work' } });
    expect(result.isError).not.toBe(true);
    const statusCall = apiMocks.callOrgxApiJson.mock.calls.find(
      (call) => call[1] === '/api/tools/execute' && JSON.parse(String(call[2]?.body)).tool_id === 'get_agent_status'
    );
    // The session workspace, never an injected one; the same user identity as the decisions read.
    expect(JSON.parse(String(statusCall?.[2]?.body))).toMatchObject({ args: { workspace_id: SESSION_WS }, user_id: ORGX_USER });
    expect(enrich).toHaveBeenCalledWith(expect.objectContaining({ toolId: 'get_agent_status', args: { workspace_id: SESSION_WS } }));
    expect(worker.fetchEntityCollection).toHaveBeenCalledWith(expect.objectContaining({ type: 'task', workspaceId: SESSION_WS }));

    const work = (result.structuredContent as Record<string, any>).work;
    expect(work.status).toBe('ok');
    expect(work.items.map((i: { agent: string; state: string }) => `${i.agent}:${i.state}`)).toEqual(['Dana:blocked', 'Eli:running']);
    expect(WIDGET_OUTPUT_SCHEMAS.orgx_panel_snapshot.safeParse(result.structuredContent).success).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect(worker.sessionContext).toEqual(sessionBefore);
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
    apiMocks.callOrgxApiJson.mockClear();
    apiMocks.callOrgxApiRaw.mockClear();
    worker.fetchEntityCollection.mockClear();
    const rejected = await client.callTool({ name: 'orgx_panel_snapshot', arguments: { workspace_id: OTHER_WS } });
    expect(rejected.isError).toBe(true);
    expect(apiMocks.callOrgxApiJson).not.toHaveBeenCalled();
    expect(apiMocks.callOrgxApiRaw).not.toHaveBeenCalled();
    expect(worker.fetchEntityCollection).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(worker.sessionContext).toEqual(sessionBefore);

    const result = await client.callTool({ name: 'orgx_panel_snapshot', arguments: {} });
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
    // Its own live feed: the session workspace, refreshed by re-reading the panel.
    expect(structured.live).toMatchObject({
      feedType: 'panel',
      feedId: SESSION_WS,
      refreshTool: 'orgx_panel_snapshot',
      refreshArgs: {},
    });
    expect(structured.live.streamUrl).toContain(`/live-feed/panel/${SESSION_WS}/stream?t=`);
    expect(body.usage_class).toBe('live_refresh');
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

describe('orgx_widget_decide refusals on the worker', () => {
  afterEach(() => {
    apiMocks.callOrgxApiJson.mockReset();
    vi.restoreAllMocks();
  });

  const widgetActions = {
    kind: 'decision',
    actions: ['approve', 'reject'],
    labels: { approve: 'Send answer', reject: 'Decline' },
    reject_requires_reason: false,
    answer: { required_for: ['approve'], max_length: 2000 },
    selection: null,
  };

  it('passes the app refusal code and widget_actions through to the widget, and sends kind and answer', async () => {
    const { client } = await createWorker();
    const execute = apiMocks.callOrgxApiJson.getMockImplementation()!;
    apiMocks.callOrgxApiJson.mockImplementation(async (env: unknown, path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (path === '/api/tools/execute' && body.tool_id === 'widget_decide') {
        return Response.json({ ok: false, error: 'Type an answer to send.', data: { code: 'answer_required', widget_actions: widgetActions } });
      }
      return execute(env, path, init);
    });
    const result = await client.callTool({
      name: 'orgx_widget_decide',
      arguments: { decision_id: D2, kind: 'decision', action: 'approve', answer: '', approval_token: 'tok' },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: 'answer_required', message: 'Type an answer to send.', details: { widget_actions: widgetActions } },
    });
    const call = apiMocks.callOrgxApiJson.mock.calls.find((entry) => JSON.parse(String(entry[2]?.body ?? '{}')).tool_id === 'widget_decide');
    expect(JSON.parse(String(call![2]!.body)).args).toMatchObject({ decision_id: D2, kind: 'decision', action: 'approve', approval_token: 'tok' });
  }, 20000);

  it('reads the code from the message when the app drops data on failure', async () => {
    const { client } = await createWorker();
    const execute = apiMocks.callOrgxApiJson.getMockImplementation()!;
    apiMocks.callOrgxApiJson.mockImplementation(async (env: unknown, path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (path === '/api/tools/execute' && body.tool_id === 'widget_decide') {
        return Response.json({ ok: false, error: 'This decision was already settled.' });
      }
      return execute(env, path, init);
    });
    const result = await client.callTool({
      name: 'orgx_widget_decide',
      arguments: { decision_id: D2, kind: 'action', action: 'approve', approval_token: 'tok' },
    });
    expect(result.structuredContent).toMatchObject({ error: { code: 'decision_already_resolved' } });
  }, 20000);
});

describe('panel asker and work view', () => {
  it('names the asking agent in the decisions widget order and drops OrgX itself', () => {
    expect(panelAsker({ agent_name: 'Eli - Engineering' })).toBe('Eli - Engineering');
    expect(panelAsker({ agent_name: 'Eli' }, { owner: 'Pace' })).toBe('Pace');
    expect(panelAsker({ domain: 'design' })).toBe('design');
    expect(panelAsker({ agent_name: 'OrgX System' })).toBeNull();
    expect(panelAsker({})).toBeNull();
    expect(panelAsker({ domain: 'engineering', source: 'system' })).toBeNull();
  });

  it('carries the asker on queue items and the focus, valid against the output schema', () => {
    const decisions = [{ ...(DECISIONS[0] as Record<string, unknown>), agent_name: 'Mark - Marketing' }, ...DECISIONS.slice(1)];
    const snapshot = buildPanelSnapshot({ workspace: { id: SESSION_WS, name: 'Acme' }, decisions, artifacts: [] });
    const item = snapshot.queue.find((q) => q.id === (decisions[0] as { id: string }).id)!;
    expect(item.asker).toBe('Mark - Marketing');
    expect(WIDGET_OUTPUT_SCHEMAS.orgx_panel_snapshot.safeParse(snapshot).success).toBe(true);
  });

  it('builds In progress rows, blocked first, without idle or system agents', () => {
    const work = buildPanelWork({
      agents: [
        { agent_name: 'Pace', status: 'idle' },
        { agent_name: 'OrgX ChatGPT App', status: 'running' },
        { agent_name: 'Eli', status: 'running', current_tasks: [
          { id: '11111111-1111-4111-8111-111111111111', title: 'Reconcile telemetry', status: 'in_progress' },
          { id: 'task-done', title: 'Shipped repair', status: 'completed' },
        ] },
        { agent_name: 'Dana', status: 'blocked', current_activity: 'Waiting on a decision' },
        { agent_name: 'Sage', status: 'queued', current_tasks: [{ id: 'q1', title: 'ICP list' }] },
      ],
    });
    expect(work.status).toBe('ok');
    expect(work.items.map((i) => [i.agent, i.state, i.title])).toEqual([
      ['Dana', 'blocked', 'Waiting on a decision'],
      ['Eli', 'running', 'Reconcile telemetry'],
      ['Sage', 'queued', 'ICP list'],
    ]);
    expect(work.items[1]!.url).toBe('https://useorgx.com/tasks/11111111-1111-4111-8111-111111111111');
  });

  it('reports a failed agent-status read as unavailable, not as nothing running', () => {
    expect(buildPanelWork(null)).toEqual({ status: 'unavailable', items: [], total: 0 });
    expect(buildPanelWork({ agents: 'nope' } as unknown as Record<string, unknown>).status).toBe('unavailable');
  });

  it('reads agent status only when the panel asks for the work view', async () => {
    const fetchAgentStatus = vi.fn(async () => ({ agents: [{ agent_name: 'Eli', status: 'running', current_tasks: [{ id: 't', title: 'Build' }] }] }));
    const host = fakeHost({ fetchAgentStatus });
    const plain = await handlePanelSnapshot(host, {});
    expect(fetchAgentStatus).not.toHaveBeenCalled();
    expect((plain.structuredContent as Record<string, unknown>).work).toBeUndefined();
    const withWork = await handlePanelSnapshot(host, { view: 'work' });
    expect(fetchAgentStatus).toHaveBeenCalledWith({ workspaceId: SESSION_WS });
    const snap = withWork.structuredContent as unknown as PanelSnapshot;
    expect(snap.work).toMatchObject({ status: 'ok', total: 1 });
    expect(WIDGET_OUTPUT_SCHEMAS.orgx_panel_snapshot.safeParse(snap).success).toBe(true);
  });

  it('keeps the decision queue when the agent-status read fails', async () => {
    const host = fakeHost({ fetchAgentStatus: vi.fn(async () => { throw new Error('down'); }) });
    const snap = (await handlePanelSnapshot(host, { view: 'work' })).structuredContent as unknown as PanelSnapshot;
    expect(snap.state).toBe('ok');
    expect(snap.queue.length).toBeGreaterThan(0);
    expect(snap.work).toEqual({ status: 'unavailable', items: [], total: 0 });
  });
});
