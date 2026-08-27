import { describe, expect, it } from 'vitest';

import {
  SUPPORTED_WIDGET_SURFACES,
  buildWidgetProofCards,
  buildWidgetProofHandoff,
  enrichAgentStatusWithArtifacts,
  enrichInitiativePulseWithArtifacts,
  enrichMorningBriefWithArtifacts,
  normalizeArtifactRecord,
} from '../src/widgetArtifactProof';

describe('widget artifact proof helpers', () => {
  it('normalizes artifact entity records', () => {
    expect(
      normalizeArtifactRecord({
        id: 'artifact-1',
        name: 'server.json manifest',
        status: 'approved',
        artifact_type: 'eng.config',
        preview_markdown: '```json\\n{}\\n```',
        entity_type: 'task',
        entity_id: 'task-1',
        created_by_type: 'agent',
        created_by_id: 'engineering-agent',
      })
    ).toMatchObject({
      id: 'artifact-1',
      title: 'server.json manifest',
      status: 'approved',
      artifact_type: 'eng.config',
      task_id: 'task-1',
      created_by_id: 'engineering-agent',
    });
  });

  it('ranks scored deliverables ahead of newer process notes in proof cards', () => {
    const cards = buildWidgetProofCards(
      [
        {
          id: 'artifact-note',
          title: 'Latest progress update',
          artifact_type: 'eng.progress_update',
          status: 'approved',
          created_at: '2026-08-27T00:02:00.000Z',
        },
        {
          id: 'artifact-proof',
          title: 'Verified launch receipt',
          artifact_type: 'eng.release',
          status: 'approved',
          created_at: '2026-08-26T23:00:00.000Z',
          verification: { eval: { score: 0.94 } },
        },
      ],
      { limit: 1 }
    );

    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('Verified launch receipt');
    expect(cards[0].eval_score).toBe(0.94);
  });

  it('maps initiative artifacts onto agent records by task linkage', () => {
    const payload = enrichAgentStatusWithArtifacts(
      {
        agents: [
          {
            agent_id: 'engineering-agent',
            agent_name: 'Eli',
            tasks: [{ id: 'task-1', title: 'Add server.json manifest' }],
          },
          {
            agent_id: 'marketing-agent',
            agent_name: 'Mark',
            tasks: [{ id: 'task-2', title: 'Draft connector description' }],
          },
        ],
      },
      [
        {
          id: 'artifact-1',
          name: 'server.json manifest',
          status: 'approved',
          artifact_type: 'eng.config',
          entity_type: 'task',
          entity_id: 'task-1',
        },
        {
          id: 'artifact-2',
          name: 'Connector description',
          status: 'in_review',
          artifact_type: 'mktg.copy',
          entity_type: 'task',
          entity_id: 'task-2',
        },
      ]
    );

    const agents = payload.agents as Array<Record<string, unknown>>;
    expect(agents[0].artifact_count).toBe(1);
    expect(agents[1].artifact_count).toBe(1);
    expect((agents[0].artifacts as Array<Record<string, unknown>>)[0].title).toBe(
      'server.json manifest'
    );
    expect((agents[1].proof_cards as Array<Record<string, unknown>>)[0]).toMatchObject({
      title: 'Connector description',
      needs_review: true,
      primary_url: 'https://useorgx.com/artifacts/artifact-2',
    });
    expect(
      ((agents[1].proof_handoff as Record<string, unknown>).surface_prompts as unknown[])
    ).toHaveLength(SUPPORTED_WIDGET_SURFACES.length);
  });

  it('adds recent artifacts to initiative pulse payloads', () => {
    const payload = enrichInitiativePulseWithArtifacts(
      {
        id: 'init-1',
        name: 'Ship MCP App Store Listing',
        workstreams: [
          {
            id: 'ws-1',
            milestones: [{ id: 'ms-1', tasks: [{ id: 'task-1' }, { id: 'task-2' }] }],
          },
        ],
      },
      [
        {
          id: 'artifact-1',
          name: 'server.json manifest',
          status: 'approved',
          entity_type: 'task',
          entity_id: 'task-1',
          initiative_id: 'init-1',
        },
        {
          id: 'artifact-2',
          name: 'DNS verification',
          status: 'approved',
          entity_type: 'task',
          entity_id: 'task-2',
          initiative_id: 'init-1',
        },
      ]
    );

    expect(payload.recent_artifacts).toHaveLength(2);
    expect(payload.artifact_summary).toMatchObject({
      total: 2,
      approved: 2,
      in_review: 0,
    });
    expect((payload.recent_artifacts as Array<Record<string, unknown>>)[0]).toMatchObject({
      primary_label: 'Open artifact',
      primary_url: 'https://useorgx.com/artifacts/artifact-1',
      live_url: 'https://useorgx.com/live/init-1',
    });
    expect((payload.proof_cards as Array<Record<string, unknown>>)[0]).toMatchObject({
      title: 'server.json manifest',
      primary_url: 'https://useorgx.com/artifacts/artifact-1',
      live_url: 'https://useorgx.com/live/init-1',
      created_by_name: 'OrgX',
      needs_review: false,
    });
    expect(payload.proof_handoff).toMatchObject({
      source: 'orgx-mcp-widget-proof-cards',
      preserve_tool_results: true,
      live_url: 'https://useorgx.com/live/init-1',
      proof_count: 2,
      quiet_cta: 'Make your agent work resumable.',
    });
  });

  it('carries the quiet CTA on proof handoffs exactly once, outside the prompts', () => {
    const handoff = buildWidgetProofHandoff({
      initiativeId: 'init-1',
      initiativeTitle: 'Quality Gates V2',
      proofCount: 2,
    });

    expect(handoff.quiet_cta).toBe('Make your agent work resumable.');
    // The CTA is a single footer field — never repeated in the continuation
    // prompts, so renderers show it at most once per card.
    expect(handoff.primary_prompt).not.toContain(
      'Make your agent work resumable.'
    );
    const occurrences = JSON.stringify(handoff).split(
      'Make your agent work resumable.'
    ).length - 1;
    expect(occurrences).toBe(1);
  });

  it('preserves upstream full artifact counts when enrichment only has a display window', () => {
    const payload = enrichInitiativePulseWithArtifacts(
      {
        id: 'init-1',
        name: 'Ship MCP App Store Listing',
        artifact_summary: {
          total: 20,
          approved: 19,
          in_review: 1,
          needs_review: 1,
        },
        workstreams: [
          {
            id: 'ws-1',
            milestones: [
              {
                id: 'ms-1',
                tasks: Array.from({ length: 8 }, (_, index) => ({
                  id: `task-${index + 1}`,
                })),
              },
            ],
          },
        ],
      },
      Array.from({ length: 8 }, (_, index) => ({
        id: `artifact-${index + 1}`,
        name: `Proof ${index + 1}`,
        status: index === 0 ? 'in_review' : 'approved',
        entity_type: 'task',
        entity_id: `task-${index + 1}`,
        initiative_id: 'init-1',
      }))
    );

    expect(payload.recent_artifacts).toHaveLength(5);
    expect(payload.proof_cards).toHaveLength(5);
    expect(payload.artifact_summary).toMatchObject({
      total: 20,
      approved: 19,
      in_review: 1,
      needs_review: 1,
    });
    expect(payload.proof_handoff).toMatchObject({
      proof_count: 20,
      visible_proof_count: 5,
      review_count: 1,
      visible_review_count: 1,
    });
  });

  it('distinguishes tracked artifacts from visible cards in handoff prompts', () => {
    const handoff = buildWidgetProofHandoff({
      initiativeId: 'init-1',
      initiativeTitle: 'Quality Gates V2',
      proofCount: 141,
      visibleProofCount: 5,
      reviewCount: 3,
      visibleReviewCount: 0,
    });

    expect(handoff).toMatchObject({
      proof_count: 141,
      visible_proof_count: 5,
      review_count: 3,
      visible_review_count: 0,
    });
    expect(handoff.primary_prompt).toContain(
      '5 visible proof cards from 141 tracked artifacts'
    );
    expect(handoff.primary_prompt).toContain(
      'The summary shows 3 tracked artifacts needing review'
    );
    expect(handoff.primary_prompt).not.toContain('141 proof cards');
    expect(handoff.primary_prompt).not.toContain('3 proof cards marked for review');
  });

  it('preserves proof-card creator identity from artifact metadata', () => {
    const payload = enrichInitiativePulseWithArtifacts(
      {
        id: 'init-1',
        name: 'Quality Gates V2',
        workstreams: [{ id: 'ws-1', tasks: [{ id: 'task-1' }, { id: 'task-2' }] }],
      },
      [
        {
          id: 'artifact-1',
          name: 'Codex proof bundle',
          status: 'approved',
          entity_type: 'task',
          entity_id: 'task-1',
          initiative_id: 'init-1',
          created_by_type: null,
          created_by_id: null,
          created_by_name: null,
          metadata: {
            source_client: 'codex',
            artifact_hash: 'sha256:abc123',
          },
        },
        {
          id: 'artifact-2',
          name: 'Founder review note',
          status: 'approved',
          entity_type: 'task',
          entity_id: 'task-2',
          initiative_id: 'init-1',
          created_by_type: 'human',
          created_by_id: 'user-1',
          metadata: {
            created_by_name: 'Hope Atina',
          },
        },
      ]
    );

    expect(payload.recent_artifacts).toHaveLength(2);
    expect((payload.recent_artifacts as Array<Record<string, unknown>>)[0]).toMatchObject({
      created_by_type: 'agent',
      created_by_id: null,
      created_by_name: 'Codex',
    });
    expect((payload.proof_cards as Array<Record<string, unknown>>)[0]).toMatchObject({
      title: 'Codex proof bundle',
      created_by_type: 'agent',
      created_by_id: null,
      created_by_name: 'Codex',
    });
    expect((payload.proof_cards as Array<Record<string, unknown>>)[1]).toMatchObject({
      title: 'Founder review note',
      created_by_type: 'human',
      created_by_id: 'user-1',
      created_by_name: 'Hope Atina',
    });
  });

  it('filters out artifacts owned by other initiatives from initiative pulse payloads', () => {
    const payload = enrichInitiativePulseWithArtifacts(
      {
        id: 'init-1',
        name: 'Current initiative',
        workstreams: [
          {
            id: 'ws-1',
            milestones: [{ id: 'ms-1', tasks: [{ id: 'task-1' }] }],
          },
        ],
      },
      [
        {
          id: 'artifact-1',
          name: 'Current initiative proof',
          status: 'approved',
          entity_type: 'task',
          entity_id: 'task-1',
          initiative_id: 'init-1',
        },
        {
          id: 'artifact-2',
          name: 'Foreign initiative proof',
          status: 'in_review',
          entity_type: 'task',
          entity_id: 'task-foreign',
          initiative_id: 'init-2',
        },
      ]
    );

    expect(payload.recent_artifacts).toHaveLength(1);
    expect(payload.proof_cards).toHaveLength(1);
    expect(payload.review_items).toHaveLength(0);
    expect((payload.recent_artifacts as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'artifact-1',
      live_url: 'https://useorgx.com/live/init-1',
    });
  });

  it('filters out task-owned artifacts when the task is outside the initiative hierarchy', () => {
    const payload = enrichInitiativePulseWithArtifacts(
      {
        id: 'init-1',
        name: 'Current initiative',
        workstreams: [
          {
            id: 'ws-1',
            milestones: [{ id: 'ms-1', tasks: [{ id: 'task-1' }] }],
          },
        ],
      },
      [
        {
          id: 'artifact-1',
          name: 'Hierarchy task proof',
          status: 'approved',
          entity_type: 'task',
          entity_id: 'task-1',
        },
        {
          id: 'artifact-2',
          name: 'Foreign task proof',
          status: 'changes_requested',
          entity_type: 'task',
          entity_id: 'task-foreign',
        },
      ]
    );

    expect(payload.recent_artifacts).toHaveLength(1);
    expect(payload.artifact_summary).toMatchObject({
      total: 1,
      approved: 1,
      in_review: 0,
      needs_review: 0,
    });
    expect((payload.recent_artifacts as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'artifact-1',
      entity_id: 'task-1',
      live_url: 'https://useorgx.com/live/init-1',
    });
  });

  it('adds overnight output and review items to morning briefs', () => {
    const payload = enrichMorningBriefWithArtifacts(
      { summary: 'Brief' },
      [
        { id: 'artifact-1', name: 'server.json manifest', status: 'approved' },
        { id: 'artifact-2', name: 'MCP Inspector test plan', status: 'in_review' },
      ]
    );

    expect(payload.artifacts_produced).toHaveLength(2);
    expect(payload.review_items).toHaveLength(1);
    expect(payload.artifact_summary).toMatchObject({
      total: 2,
      approved: 1,
      in_review: 1,
    });
    expect((payload.review_items as Array<Record<string, unknown>>)[0]).toMatchObject({
      primary_label: 'Open artifact',
      primary_url: 'https://useorgx.com/artifacts/artifact-2',
    });
    expect((payload.proof_cards as Array<Record<string, unknown>>)[1]).toMatchObject({
      title: 'MCP Inspector test plan',
      needs_review: true,
    });
  });

  it('keeps widget handoff metadata available even without artifacts', () => {
    const payload = enrichMorningBriefWithArtifacts(
      { summary: 'Brief', initiative_id: 'init-1' },
      []
    );

    expect(payload.proof_cards).toEqual([]);
    expect(payload.artifact_summary).toMatchObject({
      total: 0,
      approved: 0,
      in_review: 0,
      needs_review: 0,
    });
    expect(payload.proof_handoff).toMatchObject({
      live_url: 'https://useorgx.com/live/init-1',
      proof_count: 0,
      review_count: 0,
    });
  });

  it('ranks scored deliverables above newer process noise and carries the AQ score', () => {
    const payload = enrichInitiativePulseWithArtifacts(
      {
        id: 'init-1',
        name: 'Earnings Analyst Agent',
        workstreams: [
          {
            id: 'ws-1',
            milestones: [{ id: 'ms-1', tasks: [{ id: 'task-1' }, { id: 'task-2' }] }],
          },
        ],
      },
      [
        {
          id: 'deliverable-1',
          name: 'Earnings Analyst dashboard spec',
          status: 'in_review',
          artifact_type: 'design.component_spec',
          entity_type: 'task',
          entity_id: 'task-1',
          initiative_id: 'init-1',
          created_at: '2026-06-30T13:51:00.000Z',
          verification: { eval: { score: 0.86 } },
        },
        {
          id: 'blocker-1',
          name: 'design run blocked',
          status: 'in_review',
          artifact_type: 'design.structured_blocker',
          entity_type: 'task',
          entity_id: 'task-2',
          initiative_id: 'init-1',
          created_at: '2026-06-30T13:58:00.000Z',
          metadata: { structured_blocker: true },
        },
      ]
    );

    const proofCards = payload.proof_cards as Array<Record<string, unknown>>;
    // The scored deliverable leads even though the blocker is newer.
    expect(proofCards[0]).toMatchObject({
      id: 'deliverable-1',
      artifact_type: 'design.component_spec',
      eval_score: 0.86,
    });
    expect(proofCards[1]).toMatchObject({ id: 'blocker-1', eval_score: null });
    // Delivered count includes in-review work, not just terminally approved.
    expect(payload.artifact_summary).toMatchObject({
      total: 2,
      approved: 0,
      in_review: 2,
      delivered: 2,
    });
  });

  it('builds surface-specific continuation prompts from proof cards', () => {
    const proofCards = buildWidgetProofCards(
      [
        {
          id: 'artifact-1',
          title: 'Live onboarding proof',
          status: 'changes_requested',
          artifact_type: 'design.spec',
          task_id: 'task-1',
        },
      ],
      { initiativeId: 'init-1' }
    );
    const handoff = buildWidgetProofHandoff({
      initiativeId: 'init-1',
      initiativeTitle: 'High-converting onboarding',
      proofCount: proofCards.length,
      reviewCount: proofCards.filter((item) => item.needs_review).length,
    });

    expect(proofCards[0]).toMatchObject({
      needs_review: true,
      primary_url: 'https://useorgx.com/artifacts/artifact-1',
      task_url: 'https://useorgx.com/live/init-1?task=task-1',
    });
    expect(handoff.surface_prompts.map((item) => item.surface)).toEqual(
      SUPPORTED_WIDGET_SURFACES
    );
    expect(handoff.primary_prompt).toContain('preserve the tool result links');
  });
});
