import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';

import {
  enrichAgentStatusWithDurableEvidence,
  normalizeAgentStatusPayload,
} from '../src/agentStatusPayload';
import { getToolOutputSchema } from '../src/openaiOutputSchemas';
import { installToolResultGuidanceWrapper } from '../src/toolResultRegistration';

/**
 * Fields the app adds to payloads this worker forwards (hopeatina/orgx,
 * claude/qa-backend): the canonical pending-decision scope, the morning
 * brief's named failed sources, agent-status task reconciliation, and the
 * artifact review contract's reviewAction. Every payload below is built from
 * the app's producer code and sent through the real registration path, so
 * the server's Zod validator and the client's advertised JSON Schema both run.
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const INITIATIVE_ID = '22222222-2222-4222-8222-222222222222';

// lib/server/decisions/pendingDecisionScope.ts, loadPendingDecisionScope.
const workspaceScope = {
  level: 'workspace',
  workspace_id: WORKSPACE_ID,
  initiative_id: null,
  kinds: ['decision', 'approval'],
  urgency: 'all',
  includes_system: false,
  unit: 'review_packet',
  total: 26,
  capped: false,
};

// The widget channel appends Action Gateway items (chatgptWidgetDecide.ts).
const widgetScope = {
  ...workspaceScope,
  kinds: ['decision', 'approval', 'action'],
  total: 27,
};

// The initiative pulse counts one initiative with no workspace id.
const initiativeScope = {
  ...workspaceScope,
  level: 'initiative',
  workspace_id: null,
  initiative_id: INITIATIVE_ID,
  total: 3,
};

// chatgptApp.ts getPendingDecisions: total_pending is the scope's total and
// never the page's length (limit 2 here, 26 in scope).
const pendingList = {
  decisions: [
    {
      id: 'decision-1', short_id: 'decision', type: 'decision_queue',
      agent_id: null, agent_name: 'OrgX System', summary: 'Ship the pricing page?',
      urgency: 'high', created_at: '2026-10-02T12:00:00.000Z',
      context: { initiative_id: INITIATIVE_ID }, options: [],
    },
    {
      id: 'approval-1', short_id: 'approval', type: 'approval',
      agent_id: 'engineering-agent', agent_name: 'Eli', summary: 'Merge the fix',
      urgency: 'medium', created_at: '2026-10-02T11:00:00.000Z',
      context: { run_id: 'run-1' }, options: [],
    },
  ],
  total_pending: 26,
  pending_decisions_scope: workspaceScope,
  summary: { critical: 0, high: 10, medium: 14, low: 2 },
  message: 'You have 26 decisions pending.',
};

const realBriefDegradedSources = [
  { source: 'pending_decision_count', label: 'Pending decision count', reason: 'query_failed' },
  { source: 'operator_chronicle', label: 'Operator chronicle', reason: 'unavailable' },
];

// app/api/flywheel/briefs/route.ts plus what get_morning_brief adds.
const healthyBrief = {
  workspace_id: WORKSPACE_ID,
  session_summary: null,
  intelligence: {
    learnings_total: 4, learnings_applied: 2, trust_promotions: 0,
    attributed_value: 0, decisions_resolved_30d: 5, initiatives_completed_30d: 1,
  },
  exceptions: [], trust_events: [], top_receipts: [],
  artifacts_produced: [], review_items: [], top_priorities: [],
  pending_decisions: 26,
  pending_decisions_scope: workspaceScope,
  brief_markdown: '# Morning brief',
  source_tool: 'get_operator_chronicle',
  dataGaps: ['Coverage: showing the latest 200 tasks.'],
  degraded_sources: [],
  message: 'Morning brief ready',
};

// A real failure: the count failed to load and the chronicle was unavailable.
const degradedBrief = {
  ...healthyBrief,
  pending_decisions: null,
  pending_decisions_scope: null,
  degraded_sources: realBriefDegradedSources,
  degraded: ['operator_chronicle_unavailable'],
  data_gaps: [
    'Pending decision count could not be loaded.',
    'Operator chronicle could not be loaded.',
  ],
};

// compactBriefFallback: no count, the brief itself named as the failed source.
const fallbackBrief = {
  workspace_id: WORKSPACE_ID, session_summary: null,
  intelligence: healthyBrief.intelligence,
  exceptions: [], trust_events: [], top_receipts: [], artifacts_produced: [],
  review_items: [], top_priorities: [], brief_markdown: null,
  source_tool: 'get_operator_chronicle', dataGaps: ['brief_route_timeout'],
  message: 'Brief summary is refreshing', generated_at: '2026-10-03T00:00:00.000Z',
  degraded_sources: [{ source: 'morning_brief', label: 'Morning brief', reason: 'timeout' }],
  degraded: ['brief_route_timeout'],
  data_gaps: ['Morning brief did not answer in time.'],
};

function pulse(scope: unknown) {
  return {
    initiative_id: INITIATIVE_ID, name: 'Pricing launch', status: 'active',
    health_score: 70, progress_pct: 40, created_at: '2026-09-01T00:00:00Z',
    milestones: [], workstreams: [], blockers: [], pending_decisions: 3,
    workstream_summary: { total: 0, active: 0, paused: 0, completed: 0, blocked: 0 },
    completion_state: {
      all_tasks_complete: false, all_milestones_complete: false,
      all_workstreams_complete: false, has_pending_decisions: true,
      initiative_complete: false, stale_state_count: 0, stale_state: [],
    },
    lifecycle_stage: 'execution', initiative_short_id: 'INI-PRICE',
    recent_artifacts: [], artifact_summary: null, resolved_from_name: false,
    pending_decisions_scope: scope,
    message: 'Pricing launch is on track.',
    next_steps: ['Review the decisions waiting on you'],
  };
}

// lib/artifacts/reviewContract.ts deriveArtifactReviewContract, as served by
// GET /api/artifacts/:id: every field, with the nulls an unscored artifact
// without a ruling note carries.
function reviewContract(purpose: Record<string, unknown>) {
  return {
    schemaVersion: 'artifact_review_contract.v1',
    purpose,
    modality: { kind: 'document', label: 'Document' },
    modalityGate: {
      state: 'not_required', label: 'Not required', blocksAdvance: false,
      reason: 'No modality proof is required.', missingFields: [],
    },
    lifecycle: { state: 'in_review', label: 'In review', terminal: false },
    quality: {
      state: 'unscored', required: false, score: null, previousScore: null,
      threshold: 0.85,
      thresholdSource: { kind: 'default', profileName: null, profileScope: null, profileVersion: null },
      isFresh: false, blocksAdvance: false,
      reason: 'No current scored quality evaluation is recorded.',
      runId: null, anatomy: null, findings: [],
    },
    ruling: {
      state: 'pending', label: 'Pending', note: null, actorKind: 'unknown',
      actorLabel: null, at: null,
    },
    outcome: {
      state: 'unobserved', label: 'No outcome observed', count: 0,
      latestKind: null, observedAt: null, source: null,
    },
    lineage: { state: 'current', version: 1, parentId: null, supersededBy: null, items: [] },
    evidence: {
      confidence: null, gradedLayers: 0, domain: null, stackSource: null,
      provisional: false, barVersion: null, judgeModel: null,
      evalLinkage: {
        currentEvalRunId: null, latestJudgedEvalRunId: null,
        selectedJudgedEvalRunIds: [], selectedMeasuredEvalRunIds: [],
        latestJudgedBelongsToCurrentEval: null,
      },
      layers: [], measured: [], observations: [], outcomes: [], relationships: [],
    },
    workflow: {
      artifactStatus: 'in_review', canAdvance: false,
      headline: 'Waiting on your review', reason: 'A deliverable needs a ruling.',
      tone: 'attention',
    },
    authority: { canReview: true, canRerun: true, canOverride: false, canEditPolicy: false },
    counts: {
      artifactRecords: 1, versions: 1, qualityRuns: 0, rulings: 0,
      outcomeObservations: 0, evidenceRefs: 0,
    },
  };
}

function reviewEnvelope(purpose: Record<string, unknown>) {
  return {
    artifact: {
      id: 'artifact-1', name: 'Pricing page copy', status: 'in_review',
      artifact_type: 'marketing.copy', created_at: '2026-10-02T10:00:00.000Z',
    },
    reviewContract: reviewContract(purpose),
    reviewContractSource: 'canonical',
  };
}

// The app's get_agent_status task after reconcileTaskWithAgentRun.
const STALE = '2026-10-02T09:00:00.000Z';
const now = Date.parse('2026-10-03T00:00:00.000Z');

function agentStatus(agentStatusValue: 'stalled' | 'blocked', blocker: string) {
  const reconciled = {
    task_id: 'task-1', title: 'Rewrite pricing page', status: agentStatusValue,
    stored_status: 'in_progress', priority: 'high', initiative_id: INITIATIVE_ID,
    workstream_id: null, milestone_id: null, updated_at: STALE, blocker,
  };
  return {
    agents: [{
      agent_id: 'marketing-agent', agent_name: 'Mara', current_task: 'Rewrite pricing page',
      status: agentStatusValue, progress: null, blockers: [blocker], started_at: STALE,
      last_heartbeat_at: STALE, stalled_minutes: 900, run_id: 'run-1',
      initiative_id: INITIATIVE_ID, execution_target: 'cloud',
      tasks: [reconciled], current_tasks: [reconciled], active_tasks: [],
      pending_task_count: 0, blocked_task_count: agentStatusValue === 'blocked' ? 1 : 0,
    }],
    summary: { total: 1 },
    stalled_agents: [],
    message: 'Agent status.',
  };
}

// The task entity row workstream_tasks returns for the same task: still the
// stored value the app reconciled away.
const storedEntityRow = {
  id: 'task-1', title: 'Rewrite pricing page', status: 'in_progress',
  assigned_agent_id: 'marketing-agent', initiative_id: INITIATIVE_ID,
  updated_at: STALE,
};

async function callThroughRegistration(name: string, payload: unknown) {
  const server = new McpServer({ name: 'backend-fields-contract', version: '1.0.0' });
  installToolResultGuidanceWrapper(server, null);
  server.registerTool(
    name,
    { description: `${name} contract probe`, inputSchema: {} },
    async () => ({
      content: [{ type: 'text' as const, text: 'Result ready' }],
      structuredContent: payload as Record<string, unknown>,
    })
  );
  const client = new Client({ name: 'strict-reader', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    // listTools caches the advertised output schema; callTool then checks
    // structuredContent against it, as a strict MCP client does.
    await client.listTools();
    return await client.callTool({ name, arguments: {} });
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

describe('pending decision scope on every decision list', () => {
  it.each([
    ['orgx_decide', pendingList],
    ['approve_agent_work', pendingList],
    ['orgx_decide', { ...pendingList, pending_decisions_scope: widgetScope, total_pending: 27 }],
    ['approve_agent_work', { ...pendingList, pending_decisions_scope: widgetScope, total_pending: 27 }],
    ['approve_agent_work', {
      ...pendingList,
      proof: { last_accepted: null, completed_unaccepted: 2 },
    }],
  ])('%s delivers total_pending and pending_decisions_scope', async (name, payload) => {
    const result = await callThroughRegistration(name, payload);
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(result.structuredContent).toEqual(payload);
  });

  it('get_pending_decisions has no output contract, so the app payload passes through', async () => {
    expect(getToolOutputSchema('get_pending_decisions')).toBeUndefined();
    const result = await callThroughRegistration('get_pending_decisions', pendingList);
    expect(result.structuredContent).toEqual(pendingList);
  });

  it('accepts a scope value the app adds later', async () => {
    const payload = {
      ...pendingList,
      pending_decisions_scope: {
        ...workspaceScope, level: 'team', kinds: ['decision', 'meeting'],
        urgency: 'medium', unit: 'decision_row',
      },
    };
    const result = await callThroughRegistration('orgx_decide', payload);
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(result.structuredContent).toEqual(payload);
  });

  it('rejects a scope whose structure breaks the app type', () => {
    const schema = getToolOutputSchema('orgx_decide')!;
    const { capped: _capped, ...withoutCapped } = workspaceScope;
    for (const scope of [
      { ...workspaceScope, total: '26' },
      { ...workspaceScope, kinds: 'decision' },
      { ...workspaceScope, kinds: [7] },
      { ...workspaceScope, includes_system: 'no' },
      withoutCapped,
      null,
    ]) {
      expect(
        schema.safeParse({ ...pendingList, pending_decisions_scope: scope }).success,
        JSON.stringify(scope)
      ).toBe(false);
    }
  });
});

describe('morning brief count and source health', () => {
  it.each([
    ['a healthy brief', healthyBrief],
    ['a brief with named failed sources', degradedBrief],
    ['the compact timeout fallback', fallbackBrief],
  ])('get_morning_brief delivers %s', async (_label, payload) => {
    const result = await callThroughRegistration('get_morning_brief', payload);
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(result.structuredContent).toEqual(payload);
  });

  it('accepts a failure reason the app adds later', async () => {
    const payload = {
      ...degradedBrief,
      degraded_sources: [{ source: 'pr_receipts', label: 'PR receipts', reason: 'rate_limited' }],
    };
    const result = await callThroughRegistration('get_morning_brief', payload);
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(result.structuredContent).toEqual(payload);
  });

  it('rejects a source gap or count whose structure breaks the app type', () => {
    const schema = getToolOutputSchema('get_morning_brief')!;
    for (const change of [
      { degraded_sources: [{ source: 'x', label: 'X' }] },
      { degraded_sources: [{ source: 'x', label: 'X', reason: 3 }] },
      { degraded_sources: { source: 'x', label: 'X', reason: 'timeout' } },
      { pending_decisions: '26' },
    ]) {
      expect(schema.safeParse({ ...degradedBrief, ...change }).success, JSON.stringify(change)).toBe(false);
    }
  });
});

describe('initiative pulse pending decision scope', () => {
  it.each([
    ['get_initiative_pulse', initiativeScope],
    ['get_initiative_pulse', null],
    ['track_project_progress', initiativeScope],
  ])('%s delivers pending_decisions_scope %j', async (name, scope) => {
    const payload = pulse(scope);
    const result = await callThroughRegistration(name, payload);
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(result.structuredContent).toEqual(payload);
  });
});

describe('agent status task reconciliation', () => {
  it.each([
    ['stalled', 'The agent has sent no heartbeat for 15 hours, so its run is paused. Restart or cancel it.'],
    ['blocked', 'Waiting on billing credentials'],
  ] as const)('keeps a %s task, its stored_status and blocker through the worker', async (status, blocker) => {
    const payload = normalizeAgentStatusPayload(
      enrichAgentStatusWithDurableEvidence(
        agentStatus(status, blocker), [storedEntityRow], [], now
      )
    );
    const agent = (payload.agents as Record<string, unknown>[])[0];
    const expected = expect.objectContaining({
      task_id: 'task-1', status, stored_status: 'in_progress', blocker,
    });
    // The stored entity row must not put the task back to in_progress.
    expect(agent.tasks).toEqual([expected]);
    expect(agent.current_tasks).toEqual([expected]);
    expect(agent.active_tasks).toEqual([]);
    expect(agent.status).toBe(status);

    const result = await callThroughRegistration('get_agent_status', payload);
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      agents: [{ status, current_tasks: [{ task_id: 'task-1', status, stored_status: 'in_progress', blocker }] }],
    });
  });

  it('still applies an entity row that has moved past the stored value', () => {
    const payload = enrichAgentStatusWithDurableEvidence(
      agentStatus('stalled', 'No heartbeat'),
      [{ ...storedEntityRow, status: 'completed', updated_at: '2026-10-02T23:00:00.000Z' }],
      [],
      now
    );
    const agent = (payload.agents as Record<string, unknown>[])[0];
    expect(agent.completed_tasks).toEqual([
      expect.objectContaining({ id: 'task-1', status: 'completed' }),
    ]);
  });
});

describe('artifact review contract purpose', () => {
  it.each([
    ['sign', { kind: 'deliverable', label: 'Deliverable', reviewRequired: true, reviewAction: 'sign' }],
    ['resolve', { kind: 'blocker', label: 'Blocker', reviewRequired: false, reviewAction: 'resolve' }],
    ['inspect', { kind: 'evidence', label: 'Evidence', reviewRequired: false, reviewAction: 'inspect' }],
    // The app before this change: purpose without reviewAction.
    ['absent', { kind: 'deliverable', label: 'Deliverable', reviewRequired: true }],
  ])('review_artifact delivers a canonical contract with reviewAction %s', async (_action, purpose) => {
    const payload = reviewEnvelope(purpose);
    const result = await callThroughRegistration('review_artifact', payload);
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(result.structuredContent).toEqual(payload);
  });

  it('accepts a purpose kind and reviewAction the app adds later', async () => {
    const payload = reviewEnvelope({
      kind: 'checklist', label: 'Checklist', reviewRequired: true, reviewAction: 'countersign',
    });
    const result = await callThroughRegistration('review_artifact', payload);
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(result.structuredContent).toEqual(payload);
  });

  it('rejects a purpose whose structure breaks the app type', () => {
    const schema = getToolOutputSchema('review_artifact')!;
    for (const purpose of [
      { kind: 'deliverable', reviewAction: true },
      { kind: 'deliverable', reviewRequired: 'yes' },
      { kind: 7 },
    ]) {
      expect(schema.safeParse(reviewEnvelope(purpose)).success, JSON.stringify(purpose)).toBe(false);
    }
  });
});

describe('the top-level envelope stays closed', () => {
  it.each([
    ['orgx_decide', pendingList],
    ['approve_agent_work', pendingList],
    ['get_morning_brief', healthyBrief],
    ['get_initiative_pulse', pulse(initiativeScope)],
    ['review_artifact', reviewEnvelope({ kind: 'deliverable' })],
  ])('%s still rejects an undeclared top-level field', async (name, payload) => {
    expect(getToolOutputSchema(name)!.safeParse({ ...payload, invented_field: 1 }).success).toBe(false);
    const result = await callThroughRegistration(name, { ...payload, invented_field: 1 });
    expect(result.isError).toBe(true);
  });
});
