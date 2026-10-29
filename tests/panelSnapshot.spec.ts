import { describe, expect, it, vi } from 'vitest';

import { buildPanelSnapshot, readPanelSnapshot } from '../src/panelSurface';

const workspace = { id: '11111111-1111-4111-8111-111111111111', name: 'Acme' };
const decisionId = '22222222-2222-4222-8222-222222222222';
const foreignDecisionId = '33333333-3333-4333-8333-333333333333';
const acceptedArtifactId = '44444444-4444-4444-8444-444444444444';
const humanApproverId = '55555555-5555-4555-8555-555555555555';

function decision(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: workspace.id,
    status: 'pending',
    question: `Decision ${id}`,
    title: `Decision ${id}`,
    updated_at: '2026-09-30T10:00:00.000Z',
    created_at: '2026-09-29T10:00:00.000Z',
    ...overrides,
  };
}

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    id: acceptedArtifactId,
    workspace_id: workspace.id,
    status: 'approved',
    approved_by_user_id: humanApproverId,
    approved_at: '2026-09-30T09:00:00.000Z',
    title: 'Accepted release proof',
    ...overrides,
  };
}

function build(input: Partial<Parameters<typeof buildPanelSnapshot>[0]> = {}) {
  return buildPanelSnapshot({
    workspace,
    userId: humanApproverId,
    decisions: [],
    artifacts: [],
    generatedAt: '2026-09-30T10:00:00.000Z',
    ...input,
  });
}

describe('panel snapshot builder', () => {
  it('includes only records explicitly scoped to the session workspace', () => {
    const snapshot = build({
      decisions: [
        decision(decisionId),
        decision(foreignDecisionId, { workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
        decision('66666666-6666-4666-8666-666666666666', { workspace_id: undefined }),
      ],
      artifacts: [
        artifact(),
        artifact({ id: '77777777-7777-4777-8777-777777777777', workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
        artifact({ id: '88888888-8888-4888-8888-888888888888', workspace_id: undefined }),
      ],
    });

    expect(snapshot.queue.map((row: { id: string }) => row.id)).toContain(decisionId);
    expect(snapshot.queue.map((row: { id: string }) => row.id)).not.toContain(foreignDecisionId);
    expect(snapshot.proof.last_accepted?.artifact_id).toBe(acceptedArtifactId);
  });

  it('marks a cross-workspace focus unavailable without substituting the default queue item', () => {
    const snapshot = build({
      decisions: [
        decision(decisionId),
        decision(foreignDecisionId, { workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
      ],
      focus: { type: 'decision', id: foreignDecisionId },
    });

    expect(snapshot.selection).toBe('unavailable');
    expect(snapshot.focus).toBeNull();
    expect(snapshot.queue[0]?.id).toBe(decisionId);
  });

  it('does not return workspace records when there is no authorized workspace', () => {
    const snapshot = build({ workspace: null, decisions: [decision(decisionId)], artifacts: [artifact()] });

    expect(snapshot.state).toBe('no_workspace');
    expect(snapshot.workspace).toBeNull();
    expect(snapshot.queue).toEqual([]);
    expect(snapshot.proof.last_accepted).toBeNull();
  });

  it('does not expose evidence bodies, notes, emails, costs, prompts, or token-like fields', () => {
    const privateMarkers = [
      'PRIVATE_EVIDENCE_BODY_92A',
      'PRIVATE_REJECTION_NOTE_4B1',
      'person@example.test',
      'PRIVATE_COST_17.50',
      'PRIVATE_PROMPT_6F2',
      'PRIVATE_ACCESS_TOKEN_83C',
    ];
    const snapshot = build({
      decisions: [
        decision(decisionId, {
          evidence: [{ title: 'Release checklist', body: privateMarkers[0] }],
          rejection_note: privateMarkers[1],
          owner_email: privateMarkers[2],
          estimated_cost: privateMarkers[3],
          prompt: privateMarkers[4],
          access_token: privateMarkers[5],
        }),
      ],
      artifacts: [artifact({ body: privateMarkers[0], review_note: privateMarkers[1] })],
      focus: { type: 'decision', id: decisionId },
    });
    const serialized = JSON.stringify(snapshot);

    for (const marker of privateMarkers) expect(serialized).not.toContain(marker);
  });

  it('counts only approved artifacts with a UUID human approver and valid approval time as accepted', () => {
    const accepted = artifact();
    const snapshot = build({
      artifacts: [
        accepted,
        artifact({ id: '66666666-6666-4666-8666-666666666666', approved_by_user_id: 'system:precision-judge' }),
        artifact({ id: '77777777-7777-4777-8777-777777777777', approved_by_user_id: null }),
        artifact({ id: '88888888-8888-4888-8888-888888888888', approved_by_user_id: humanApproverId, approved_at: 'not-a-date' }),
        artifact({ id: '99999999-9999-4999-8999-999999999999', status: 'in_review' }),
      ],
    });

    expect(snapshot.proof.last_accepted?.artifact_id).toBe(acceptedArtifactId);
  });

  it('caps the queue at three, evidence at five, and displayed titles at 80 characters', () => {
    const decisions = Array.from({ length: 5 }, (_, index) =>
      decision(`00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, {
        title: `decision-${index}-` + 'd'.repeat(100),
        evidence: Array.from({ length: 8 }, (_, evidenceIndex) => ({
          title: `evidence-${evidenceIndex}-` + 'e'.repeat(100),
          body: `body-${evidenceIndex}`,
        })),
      })
    );
    const snapshot = build({ decisions, focus: { type: 'decision', id: decisions[0].id } });

    expect(snapshot.queue).toHaveLength(3);
    expect(snapshot.queue.every((row: { title: string }) => row.title.length <= 80)).toBe(true);
    expect(snapshot.focus.evidence).toHaveLength(5);
    expect(snapshot.focus.evidence.every((item: { title: string }) => item.title.length <= 80)).toBe(true);
  });
});

describe('panel snapshot reads', () => {
  it('scopes canonical queue rows by workspace reference and calls each reader with the authorized workspace', async () => {
    const readPending = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        decisions: [
          {
            ...decision(decisionId),
            type: 'decision_queue',
            review_packet: {
              question: 'Release?',
              references: [{ type: 'workspace', id: workspace.id }],
            },
          },
          {
            ...decision(foreignDecisionId),
            type: 'decision_queue',
            review_packet: {
              references: [{ type: 'workspace', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
            },
          },
        ],
      },
    });
    const readArtifacts = vi.fn().mockResolvedValue({
      meta: { workspaceId: workspace.id },
      data: [artifact()],
    });
    const readDecision = vi.fn();

    const snapshot = await readPanelSnapshot({
      workspace,
      userId: humanApproverId,
      readPending,
      readDecision,
      readArtifacts,
    });

    expect(readPending).toHaveBeenCalledWith(workspace.id);
    expect(readArtifacts).toHaveBeenCalledWith(workspace.id);
    expect(readDecision).not.toHaveBeenCalled();
    expect(snapshot.queue.map((row: { id: string }) => row.id)).toEqual([decisionId]);
    expect(snapshot.proof.last_accepted?.artifact_id).toBe(acceptedArtifactId);
  });

  it('uses exact scoped lookup for a focus hint and keeps an unauthorized hint unavailable', async () => {
    const readPending = vi.fn().mockResolvedValue({ ok: true, data: { decisions: [
      {
        ...decision(decisionId),
        type: 'decision_queue',
        review_packet: { references: [{ type: 'workspace', id: workspace.id }] },
      },
    ] } });
    const readArtifacts = vi.fn().mockResolvedValue({ meta: { workspaceId: workspace.id }, data: [] });
    const readDecision = vi.fn(async (id: string, workspaceId: string) => ({
      ...decision(id, { workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
      id,
      workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      requested_workspace: workspaceId,
    }));

    const snapshot = await readPanelSnapshot({
      workspace,
      userId: humanApproverId,
      readPending,
      readDecision,
      readArtifacts,
    }, { type: 'decision', id: foreignDecisionId });

    expect(readDecision).toHaveBeenCalledWith(foreignDecisionId, workspace.id);
    expect(snapshot.selection).toBe('unavailable');
    expect(snapshot.focus).toBeNull();
    expect(snapshot.queue.map((row: { id: string }) => row.id)).toEqual([decisionId]);
  });
});
