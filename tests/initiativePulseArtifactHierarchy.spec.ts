import { describe, expect, it } from 'vitest';
import { enrichInitiativePulseWithArtifacts } from '../src/widgetArtifactProof';

const hierarchy = {
  initiative_id: 'initiative-1', name: 'Living Work Memory',
  workstreams: [{ id: 'workstream-1', name: 'Engineering' }],
  milestones: [{ id: 'milestone-1', name: 'Phase 1', workstream_id: 'workstream-1' }],
  tasks: [{ id: 'task-1', title: 'Capture receipts', status: 'completed', workstream_id: 'workstream-1', milestone_id: 'milestone-1' }],
  continuity: { progress: { completed: 4, total: 36, pct: 11 } },
};
const oldDirect = {
  id: 'old-direct', name: 'Draft PR', status: 'in_review',
  entity_type: 'initiative', entity_id: 'initiative-1',
  created_at: '2026-10-10T00:23:00Z', updated_at: '2026-10-10T00:23:00Z',
};
const currentTask = {
  id: 'current-task', name: 'Receipt proof', status: 'in_review', version: 3,
  artifact_type: 'eng.test_report', entity_type: 'task', entity_id: 'task-1',
  created_at: '2026-10-09T00:00:00Z', updated_at: '2026-10-10T16:20:00Z',
  description: '\nFull receipt proof\n\n- current revision\n',
  content: { checks: ['scope', 'revision'], passed: true },
  verification: { eval: { score: 0.93, passed: true }, evidence: ['receipt-1'] },
  metadata: { review_notes: ['Keep the full receipt'], format: 'markdown' },
};
function rows(payload: Record<string, unknown>, key = 'recent_artifacts') {
  return payload[key] as Array<Record<string, unknown>>;
}

describe('initiative pulse current descendant proofs', () => {
  it('keeps current task proofs when an older app returns only direct initiative enrichment', () => {
    const summary = { total: 39, in_review: 26, eval_passed: 13 };
    const result = enrichInitiativePulseWithArtifacts({
      ...hierarchy, recent_artifacts: [currentTask], artifact_summary: summary,
    }, [oldDirect]);
    expect(rows(result).map((row) => row.id)).toEqual(['current-task', 'old-direct']);
    expect(result.artifact_summary).toEqual(summary);
    expect(result.artifact_summary).not.toHaveProperty('delivered');
    expect(result.continuity).toEqual(hierarchy.continuity);
    expect(rows(result)[0]).toMatchObject({
      entity_type: 'task', entity_id: 'task-1', initiative_id: 'initiative-1',
      workstream_id: 'workstream-1', milestone_id: 'milestone-1', task_id: 'task-1',
      context: { initiative: { id: 'initiative-1', title: 'Living Work Memory' },
        workstream: { id: 'workstream-1', title: 'Engineering' },
        milestone: { id: 'milestone-1', title: 'Phase 1' },
        task: { id: 'task-1', title: 'Capture receipts' } },
    });
  });

  it('preserves the newest raw content, review notes, evaluation, and version when deduplicating', () => {
    const stale = { ...currentTask, status: 'draft', version: 1,
      updated_at: '2026-10-10T00:23:00Z', description: 'Old draft',
      content: 'Old content', verification: { eval: { score: 0.2 } },
      metadata: { review_notes: ['Old review'] } };
    const result = enrichInitiativePulseWithArtifacts({
      ...hierarchy, recent_artifacts: [currentTask], proof_cards: [stale],
    }, [stale]);
    expect(rows(result)).toHaveLength(1);
    for (const row of [rows(result)[0], rows(result, 'proof_cards')[0]]) {
      expect(row).toMatchObject({ status: 'in_review', version: 3,
        updated_at: currentTask.updated_at, description: currentTask.description,
        content: currentTask.content, verification: currentTask.verification,
        metadata: currentTask.metadata });
    }
  });

  it('leaves a newer version’s omitted body and review evidence unknown', () => {
    const result = enrichInitiativePulseWithArtifacts({ ...hierarchy, recent_artifacts: [currentTask] }, [{
      id: currentTask.id, name: currentTask.name, entity_type: 'task', entity_id: 'task-1',
      status: 'approved', version: 4, updated_at: '2026-10-10T17:00:00Z',
    }]);
    for (const row of [rows(result)[0], rows(result, 'proof_cards')[0]]) {
      expect(row).toMatchObject({ status: 'approved', version: 4 });
      expect(row).not.toHaveProperty('content');
      expect(row).not.toHaveProperty('verification');
      expect(row).not.toHaveProperty('description');
      expect(row.metadata).not.toHaveProperty('review_notes');
    }
  });

  it('unions rich fields only for an identical authoritative update and compatible version', () => {
    const compact = { id: currentTask.id, name: currentTask.name, entity_type: 'task', entity_id: 'task-1',
      status: currentTask.status, version: currentTask.version, updated_at: currentTask.updated_at };
    const result = enrichInitiativePulseWithArtifacts({ ...hierarchy, recent_artifacts: [compact] }, [currentTask]);
    for (const row of [rows(result)[0], rows(result, 'proof_cards')[0]]) {
      expect(row).toMatchObject({ version: 3, content: currentTask.content, verification: currentTask.verification,
        description: currentTask.description, metadata: currentTask.metadata });
    }
  });

  it('does not treat an unchanged mutable version as proof of current review evidence', () => {
    const result = enrichInitiativePulseWithArtifacts({ ...hierarchy, recent_artifacts: [currentTask] }, [{
      id: currentTask.id, name: currentTask.name, entity_type: 'task', entity_id: 'task-1',
      status: 'in_review', version: 3, updated_at: '2026-10-10T17:00:00Z',
    }]);
    expect(rows(result)[0]).not.toHaveProperty('verification');
    expect(rows(result)[0]).not.toHaveProperty('content');
    expect(rows(result)[0].metadata).not.toHaveProperty('review_notes');
  });

  it('does not borrow an omitted version from an older projection', () => {
    const result = enrichInitiativePulseWithArtifacts({ ...hierarchy, recent_artifacts: [currentTask] }, [{
      id: currentTask.id, name: currentTask.name, entity_type: 'task', entity_id: 'task-1',
      status: 'in_review', updated_at: '2026-10-10T17:00:00Z',
    }]);
    expect(rows(result)[0]).not.toHaveProperty('version');
    expect(rows(result)[0]).not.toHaveProperty('verification');
    expect(rows(result)[0]).not.toHaveProperty('content');
  });

  it('uses the explicit newer version at the same clock without borrowing previous evidence', () => {
    const result = enrichInitiativePulseWithArtifacts({ ...hierarchy, recent_artifacts: [currentTask] }, [{
      id: currentTask.id, name: currentTask.name, entity_type: 'task', entity_id: 'task-1',
      status: 'in_review', version: 4, updated_at: currentTask.updated_at,
    }]);
    expect(rows(result)[0]).toMatchObject({ version: 4, updated_at: currentTask.updated_at });
    expect(rows(result)[0]).not.toHaveProperty('verification');
    expect(rows(result)[0]).not.toHaveProperty('content');
    expect(rows(result)[0].metadata).not.toHaveProperty('review_notes');
  });

  it('selects a later same-version native update within the same millisecond without inheriting its predecessor', () => {
    const older = { ...currentTask, updated_at: '2026-10-10T16:20:00.000001Z' };
    const newer = { id: currentTask.id, name: 'Current receipt', entity_type: 'task', entity_id: 'task-1',
      status: 'in_review', version: 3, updated_at: '2026-10-10T16:20:00.000002Z', description: 'Current body' };
    const result = enrichInitiativePulseWithArtifacts({ ...hierarchy, recent_artifacts: [older] }, [newer]);
    for (const row of [rows(result)[0], rows(result, 'proof_cards')[0]]) {
      expect(row).toMatchObject({ title: 'Current receipt', updated_at: newer.updated_at, description: 'Current body' });
      expect(row).not.toHaveProperty('content');
      expect(row).not.toHaveProperty('verification');
      expect(row.metadata).not.toHaveProperty('review_notes');
    }
  });

  it('orders native fractions chronologically and uses them to break scored-proof priority ties', () => {
    const result = enrichInitiativePulseWithArtifacts(hierarchy, [
      { ...oldDirect, id: 'a-old-scored', artifact_type: 'eng.release', verification: { eval: { score: 0.94 } }, updated_at: '2026-10-10T16:20:00.000001Z' },
      { ...oldDirect, id: 'z-new-scored', artifact_type: 'eng.release', verification: { eval: { score: 0.94 } }, updated_at: '2026-10-10T16:20:00.000002Z' },
      { ...oldDirect, id: 'b-process', artifact_type: 'eng.progress_update', updated_at: '2026-10-10T16:20:00.000003Z' },
    ]);
    expect(rows(result).map((row) => row.id)).toEqual(['b-process', 'z-new-scored', 'a-old-scored']);
    expect(rows(result, 'proof_cards').map((row) => row.id)).toEqual(['z-new-scored', 'a-old-scored', 'b-process']);
  });

  it('treats equivalent offsets and padded fractions as equal instants with deterministic ID ties', () => {
    const result = enrichInitiativePulseWithArtifacts(hierarchy, [
      { ...oldDirect, id: 'z-equal', updated_at: '2026-10-10T16:20:00.000002Z' },
      { ...oldDirect, id: 'a-equal', updated_at: '2026-10-10T18:20:00.000002000+02:00' },
    ]);
    expect(rows(result).map((row) => row.id)).toEqual(['a-equal', 'z-equal']);
    expect(rows(result, 'proof_cards').map((row) => row.id)).toEqual(['a-equal', 'z-equal']);
  });

  it('retains the authenticated current title for an exact same-ID same-revision tie', () => {
    const current = { ...currentTask, name: 'Authenticated current title', updated_at: '2026-10-10T16:20:00.000002Z' };
    const result = enrichInitiativePulseWithArtifacts({ ...hierarchy, recent_artifacts: [current] }, [{
      ...current, name: 'Supplemental projection title',
    }]);
    expect(rows(result)).toHaveLength(1);
    expect(rows(result)[0].title).toBe('Authenticated current title');
  });

  it('preserves an explicitly cleared current field instead of resurrecting an older value', () => {
    const cleared = { ...currentTask, content: null, verification: null };
    const result = enrichInitiativePulseWithArtifacts({ ...hierarchy, recent_artifacts: [cleared] }, [{
      ...currentTask, updated_at: '2026-10-10T00:23:00Z',
    }]);
    expect(rows(result)[0]).toMatchObject({ content: null, verification: null });
  });

  it('uses current metadata content rather than an older top-level content projection', () => {
    const newer = { ...currentTask, content: undefined, updated_at: '2026-10-10T17:00:00Z',
      metadata: { content: { receipts: ['current-receipt'] }, review_notes: ['Current review'] } };
    const result = enrichInitiativePulseWithArtifacts({ ...hierarchy, recent_artifacts: [currentTask] }, [newer]);
    expect(rows(result)[0]).toMatchObject({ content: newer.metadata.content, metadata: newer.metadata });
  });

  it('admits native descendant references without optional initiative metadata and rejects forged ownership', () => {
    const result = enrichInitiativePulseWithArtifacts(hierarchy, [
      currentTask,
      { ...oldDirect, id: 'milestone-proof', entity_type: 'milestone', entity_id: 'milestone-1' },
      { ...oldDirect, id: 'workstream-proof', entity_type: 'workstream', entity_id: 'workstream-1' },
      { ...oldDirect, id: 'foreign-task', entity_type: 'task', entity_id: 'foreign-task', initiative_id: 'initiative-1',
        metadata: { source_initiative_id: 'initiative-1', task_id: 'task-1' } },
      { id: 'metadata-only', metadata: { entity_type: 'task', entity_id: 'task-1', initiative_id: 'initiative-1' } },
      { ...oldDirect, id: 'wrong-native-type', entity_type: 'task', entity_id: 'workstream-1' },
      { ...currentTask, id: 'wrong-initiative', initiative_id: 'foreign-initiative' },
    ]);
    expect(rows(result).map((row) => row.id)).toEqual(['current-task', 'milestone-proof', 'workstream-proof']);
    expect(rows(result, 'proof_cards')).toHaveLength(3);
  });

  it('keeps authenticated legacy pulse cards without trusting unscoped fetched rows', () => {
    const result = enrichInitiativePulseWithArtifacts({ ...hierarchy,
      recent_artifacts: [{ id: 'legacy-current', name: 'Current projection', updated_at: currentTask.updated_at }],
    }, [{ id: 'legacy-fetch', name: 'Unscoped fetched projection', initiative_id: 'initiative-1' }]);
    expect(rows(result).map((row) => row.id)).toEqual(['legacy-current']);
  });

  it('retains server-scoped decision attachments without trusting a fetched decision claim', () => {
    const decision = { ...oldDirect, id: 'decision-proof', entity_type: 'decision', entity_id: 'decision-1',
      context: { initiative: { id: 'initiative-1', title: 'Living Work Memory' } } };
    const result = enrichInitiativePulseWithArtifacts({ ...hierarchy, recent_artifacts: [decision] }, [{
      ...decision, id: 'unverified-decision-proof', entity_id: 'foreign-decision',
    }, { ...currentTask, id: 'foreign-task-context', entity_id: 'foreign-task', context: decision.context }]);
    expect(rows(result).map((row) => row.id)).toEqual(['decision-proof']);
    expect(rows(result)[0]).toMatchObject({ entity_type: 'decision', entity_id: 'decision-1', context: decision.context });
  });

  it('sorts recent revisions chronologically while retaining scored deliverable priority in proof cards', () => {
    const result = enrichInitiativePulseWithArtifacts(hierarchy, [
      { ...oldDirect, id: 'scored-proof', artifact_type: 'eng.release', verification: { eval: { score: 0.95 } } },
      { ...currentTask, id: 'current-process', artifact_type: 'eng.progress_update', verification: null },
      { ...oldDirect, id: 'newly-created', created_at: '2026-10-10T15:00:00Z', updated_at: '2026-10-10T15:00:00Z' },
    ]);
    expect(rows(result).map((row) => row.id)).toEqual(['current-process', 'newly-created', 'scored-proof']);
    expect(rows(result, 'proof_cards').map((row) => row.id)).toEqual(['scored-proof', 'newly-created', 'current-process']);
  });

  it('labels bounded available and visible counts without replacing exact upstream counters', () => {
    const fetched = Array.from({ length: 8 }, (_, index) => ({ ...oldDirect, id: `proof-${index}` }));
    const summary = { total: 39, in_review: 26, eval_passed: 13, delivered: 3 };
    const full = enrichInitiativePulseWithArtifacts({ ...hierarchy, artifact_summary: summary }, fetched);
    expect(full.artifact_summary).toEqual(summary);
    expect(full.visible_artifact_summary).toMatchObject({ total: 5, in_review: 5, unit: 'visible_proof_card' });
    const partial = enrichInitiativePulseWithArtifacts(hierarchy, fetched);
    expect(partial.artifact_summary).toEqual({ total: 8, approved: 0, in_review: 8, needs_review: 8, unit: 'available_artifact' });
    expect(partial.proof_handoff).toMatchObject({ proof_count: 8, visible_proof_count: 5, proof_count_scope: 'available_artifact' });
    expect((partial.proof_handoff as { primary_prompt: string }).primary_prompt).toContain('5 visible proof cards from 8 available artifacts');
  });
});
