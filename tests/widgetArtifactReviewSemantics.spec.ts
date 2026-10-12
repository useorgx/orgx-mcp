import { describe, expect, it } from 'vitest';

import {
  enrichAgentStatusWithDurableEvidence,
  normalizeAgentStatusPayload,
} from '../src/agentStatusPayload';
import { artifactSchema, proofHandoffSchema } from '../src/openaiOutputSchemas/shared';
import { getToolOutputSchema } from '../src/openaiOutputSchemas';
import {
  buildWidgetProofCards,
  enrichAgentStatusWithArtifacts,
  enrichInitiativePulseWithArtifacts,
  enrichMorningBriefWithArtifacts,
  normalizeArtifactRecord,
} from '../src/widgetArtifactProof';

const record = (fields: Record<string, unknown> = {}) => ({
  id: 'artifact-1', title: 'Recorded artifact', status: 'in_review',
  artifact_type: 'eng.pull_request', entity_type: 'task', entity_id: 'task-1',
  initiative_id: 'initiative-1', updated_at: '2026-10-11T22:01:18.708484Z',
  version: 1, primary_url: 'https://useorgx.com/artifacts/artifact-1',
  primary_label: 'Review in OrgX', ...fields,
});

describe('canonical artifact review fields in MCP proof projections', () => {
  it.each([
    ['legacy absent flag', {}, true],
    ['legacy null flag', { reviewRequired: null }, true],
    ['recorded receipt', { purpose: 'receipt', reviewRequired: false, superseded_by: null }, false],
    ['draft evidence', { purpose: 'evidence', reviewRequired: false, status: 'draft' }, false],
    ['current deliverable', { purpose: 'deliverable', reviewRequired: true }, true],
    ['requested changes', { reviewRequired: true, status: 'changes_requested' }, true],
    ['approved deliverable', { reviewRequired: true, status: 'approved' }, false],
    ['passed quality is not a pending ruling', { reviewRequired: true, status: 'eval_passed' }, false],
    ['superseded eligible deliverable', { reviewRequired: true, superseded_by: 'new-current' }, false],
    ['superseded legacy record', { superseded_by: 'new-current' }, false],
    ['explicit superseded state', { reviewRequired: true, status: 'superseded' }, false],
    ['archived state', { reviewRequired: true, status: 'archived' }, false],
    ['current null successor', { reviewRequired: true, superseded_by: null }, true],
    ['empty successor is absent', { reviewRequired: true, superseded_by: '' }, true],
    ['malformed flag is not false authority', { reviewRequired: 'false' }, true],
  ] as const)('%s retains lifecycle and canonical eligibility', (_name, fields, expected) => {
    const input = record(fields);
    const card = buildWidgetProofCards([input])[0];
    expect(card.needs_review).toBe(expected);
    expect(card.status).toBe(input.status);
    expect(card.primary_label).toBe(expected ? 'Review in OrgX' : 'Open in OrgX');
  });

  it('never derives review suppression from producer markers, quality or completed task text', () => {
    const card = buildWidgetProofCards([record({
      metadata: { source_tool: 'orgx_complete_work_with_proof', atomic_unit_type: 'completion_proof', purpose: 'evidence', reviewRequired: false },
      verification: { eval: { score: 0.99 } }, task_status: 'done',
    })])[0];
    expect(card).toMatchObject({ status: 'in_review', needs_review: true, eval_score: 0.99 });
    expect(card).not.toHaveProperty('reviewRequired');
    expect(card).not.toHaveProperty('purpose');
  });

  it('preserves descriptive metadata while canonical top-level fields control the card', () => {
    const input = record({ purpose: 'evidence', reviewRequired: false, superseded_by: null,
      metadata: { purpose: 'deliverable', reviewRequired: true, source_tool: 'producer' } });
    expect(normalizeArtifactRecord(input)).toMatchObject({ purpose: 'evidence', reviewRequired: false, superseded_by: null, metadata: input.metadata });
    expect(buildWidgetProofCards([input])[0]).toMatchObject({ purpose: 'evidence', reviewRequired: false, superseded_by: null, needs_review: false, metadata: input.metadata });
  });

  it('keeps a current card ahead of a superseded high-score row without rewriting history', () => {
    const old = record({ id: 'old', superseded_by: 'current', verification: { eval: { score: 0.99 } }, updated_at: '2026-10-11T22:02:00Z' });
    const current = record({ id: 'current', reviewRequired: true, verification: { eval: { score: 0.84 } } });
    const cards = buildWidgetProofCards([old, current]);
    expect(cards.map(card => card.id)).toEqual(['current', 'old']);
    expect(cards[1]).toMatchObject({ status: 'in_review', superseded_by: 'current', needs_review: false, eval_score: 0.99 });
  });

  it('keeps full status histograms and real decision/approval records while counting visible reviews', () => {
    const histogram = { total: 76, in_review: 38, eval_passed: 38, needs_review: 38 };
    const scope = { unit: 'review_packet', total: 14, kinds: ['decision', 'approval'] };
    const decisions = [{ id: 'real-decision', status: 'pending' }];
    const approvals = [{ id: 'real-approval', status: 'pending' }];
    const payload = enrichInitiativePulseWithArtifacts({
      initiative_id: 'initiative-1', name: 'Original initiative',
      tasks: [{ id: 'task-1' }], artifact_summary: histogram,
      pending_decisions: 14, pending_decisions_scope: scope,
      decision_requests: decisions, agent_run_approvals: approvals,
    }, [record({ purpose: 'receipt', reviewRequired: false, superseded_by: null })]);
    expect(payload.artifact_summary).toEqual(histogram);
    expect(payload.pending_decisions).toBe(14);
    expect(payload.pending_decisions_scope).toEqual(scope);
    expect(payload.decision_requests).toEqual(decisions);
    expect(payload.agent_run_approvals).toEqual(approvals);
    expect(payload.review_items).toEqual([]);
    expect(payload.proof_handoff).toMatchObject({ review_count: 0, review_count_scope: 'visible_proof_card', visible_review_count: 0 });
    expect((payload.proof_handoff as { primary_prompt: string }).primary_prompt).toContain('visible proof cards only');
    expect((payload.visible_artifact_summary as Record<string, unknown>).needs_review).toBe(0);
  });

  it('does not claim a hidden human deliverable is covered by a zero visible-review count', () => {
    const artifacts = [
      ...Array.from({ length: 5 }, (_, i) => record({ id: `receipt-${i}`, reviewRequired: false, verification: { eval: { score: 0.9 } } })),
      record({ id: 'hidden-human', reviewRequired: true }),
    ];
    const payload = enrichInitiativePulseWithArtifacts({ initiative_id: 'initiative-1', tasks: [{ id: 'task-1' }] }, artifacts);
    expect(payload.proof_cards).toHaveLength(5);
    expect(payload.artifact_summary).toMatchObject({ needs_review: 1, total: 6 });
    expect(payload.proof_handoff).toMatchObject({ review_count: 0, review_count_scope: 'visible_proof_card' });
  });

  it('filters morning-brief review items without changing raw status counts or genuine queues', () => {
    const histogram = { total: 50, in_review: 20, approved: 30 };
    const decisions = [{ id: 'decision', status: 'pending' }];
    const approvals = [{ id: 'approval', status: 'pending' }];
    const payload = enrichMorningBriefWithArtifacts({ artifact_summary: histogram, pending_decisions: 2,
      decision_requests: decisions, agent_run_approvals: approvals }, [
      record({ id: 'receipt', purpose: 'receipt', reviewRequired: false }),
      record({ id: 'old', reviewRequired: true, superseded_by: 'new' }),
      record({ id: 'human', purpose: 'deliverable', reviewRequired: true }),
      record({ id: 'accepted-human', purpose: 'deliverable', reviewRequired: true, status: 'approved' }),
    ]);
    expect(payload.artifact_summary).toEqual(histogram);
    expect((payload.review_items as { id: string }[]).map(item => item.id)).toEqual(['human']);
    expect(payload.proof_handoff).toMatchObject({ review_count: 1, review_count_scope: 'available_artifact', proof_count: 50 });
    expect(payload.pending_decisions).toBe(2);
    expect(payload.decision_requests).toEqual(decisions);
    expect(payload.agent_run_approvals).toEqual(approvals);
    expect((payload.proof_cards as { id: string; status: string }[]).find(item => item.id === 'old')?.status).toBe('in_review');
  });

  it('retains canonical flags and revision witnesses through the real durable-agent projection order', () => {
    const artifact = record({ task_id: 'task-1', purpose: 'receipt', reviewRequired: false, superseded_by: null,
      created_by_id: 'engineering-agent', created_at: '2026-10-11T22:00:00Z' });
    const tasks = [{ id: 'task-1', status: 'done', assigned_agent_id: 'engineering-agent', updated_at: '2026-10-11T22:02:00Z' }];
    const data = { agents: [{ agent_id: 'engineering-agent', agent_name: 'Eli', current_tasks: tasks }] };
    const output = normalizeAgentStatusPayload(enrichAgentStatusWithDurableEvidence(
      enrichAgentStatusWithArtifacts(data, [artifact]), tasks, [artifact], Date.parse('2026-10-11T22:03:00Z')));
    const agent = (output.agents as Record<string, unknown>[])[0];
    const expected = { id: 'artifact-1', status: 'in_review', purpose: 'receipt', reviewRequired: false,
      superseded_by: null, updated_at: artifact.updated_at, version: 1 };
    expect(agent.latest_artifact).toMatchObject(expected);
    expect((agent.artifacts as unknown[])[0]).toMatchObject(expected);
    expect((agent.proof_cards as unknown[])[0]).toMatchObject({ ...expected, needs_review: false });
  });

  it('keeps forged producer times out of normalized native artifact revision witnesses', () => {
    const input = record({ updated_at: undefined, created_at: undefined,
      metadata: { updated_at: '2035-10-11T22:01:00Z', created_at: '2035-10-11T22:00:00Z' } });
    expect(normalizeArtifactRecord(input)).toMatchObject({ updated_at: null, created_at: null, metadata: input.metadata });
    expect(buildWidgetProofCards([input])[0]).toMatchObject({ updated_at: null, created_at: null, metadata: input.metadata });
  });

  it('does not promote producer times through the real durable artifact snapshot', () => {
    const artifact = record({ task_id: 'task-1', updated_at: undefined, created_at: undefined,
      purpose: 'receipt', reviewRequired: false, created_by_id: 'engineering-agent',
      metadata: { updated_at: '2035-10-11T22:01:00Z', created_at: '2035-10-11T22:00:00Z' } });
    const tasks = [{ id: 'task-1', assigned_agent_id: 'engineering-agent', status: 'in_progress' }];
    const current = record({ id: 'native-current', task_id: 'task-1', purpose: 'deliverable', reviewRequired: true,
      created_by_id: 'engineering-agent', created_at: '2026-10-11T22:00:00Z' });
    const output = normalizeAgentStatusPayload(enrichAgentStatusWithDurableEvidence(
      { agents: [{ agent_id: 'engineering-agent', current_tasks: tasks }] }, tasks, [artifact, current]));
    const agent = (output.agents as Record<string, unknown>[])[0];
    expect(agent.latest_artifact).toMatchObject({ id: 'native-current', updated_at: current.updated_at, reviewRequired: true });
    expect((agent.artifacts as unknown[])[0]).toMatchObject({ id: 'native-current', updated_at: current.updated_at });
    expect((agent.artifacts as Record<string, unknown>[]).find(row => row.id === 'artifact-1')).toMatchObject({
      id: 'artifact-1', updated_at: null, created_at: null, reviewRequired: false });
  });

  it('preserves canonical fields in the closed artifact and handoff output schemas', () => {
    const card = buildWidgetProofCards([record({ purpose: 'evidence', reviewRequired: false, superseded_by: 'new' })])[0];
    expect(artifactSchema.parse(card)).toMatchObject({ purpose: 'evidence', reviewRequired: false, superseded_by: 'new', needs_review: false, status: 'in_review' });
    expect(artifactSchema.parse({ id: 'legacy', purpose: null, reviewRequired: null, superseded_by: null })).toMatchObject({ purpose: null, reviewRequired: null, superseded_by: null });
    const payload = enrichInitiativePulseWithArtifacts({ initiative_id: 'initiative-1', tasks: [{ id: 'task-1' }] }, [record({ reviewRequired: false })]);
    expect(proofHandoffSchema.parse(payload.proof_handoff)).toMatchObject({ review_count_scope: 'visible_proof_card', review_count: 0 });
    const wirePayload = enrichInitiativePulseWithArtifacts({
      initiative_id: 'initiative-1', name: 'Current initiative', status: 'active',
      health_score: 80, progress_pct: 75, created_at: '2026-10-09T22:58:10Z',
      milestones: [], workstreams: [], blockers: [], pending_decisions: 14,
      tasks: [{ id: 'task-1', status: 'done', workstream_id: null, milestone_id: null }],
      workstream_summary: { total: 4, active: 3, paused: 0, completed: 1, blocked: 0 },
      completion_state: { all_tasks_complete: false, all_milestones_complete: false,
        all_workstreams_complete: false, has_pending_decisions: true,
        initiative_complete: false, stale_state_count: 0, stale_state: [] },
      lifecycle_stage: 'execution', initiative_short_id: 'INI-TEST',
      recent_artifacts: [], artifact_summary: { total: 76, in_review: 38, eval_passed: 38 },
      resolved_from_name: false, message: 'Current work', next_steps: [],
    }, [record({ purpose: 'receipt', reviewRequired: false, superseded_by: 'current' })]);
    const wire = getToolOutputSchema('get_initiative_pulse')!.parse(wirePayload);
    expect(wire).toMatchObject({ pending_decisions: 14,
      artifact_summary: { total: 76, in_review: 38, eval_passed: 38 },
      proof_cards: [{ purpose: 'receipt', reviewRequired: false, superseded_by: 'current', needs_review: false }],
      proof_handoff: { review_count_scope: 'visible_proof_card', review_count: 0 } });
  });

  it('does not confuse top-level string purpose with a nested review-contract descriptor', () => {
    expect(artifactSchema.safeParse({ id: 'artifact', purpose: { kind: 'evidence', reviewRequired: false } }).success).toBe(false);
    expect(artifactSchema.safeParse({ id: 'artifact', reviewRequired: 'false' }).success).toBe(false);
    expect(artifactSchema.safeParse({ id: 'artifact', purpose: 'future-purpose-kind' }).success).toBe(true);
  });
});
