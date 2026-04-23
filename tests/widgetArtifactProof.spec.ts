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
      needs_review: false,
    });
    expect(payload.proof_handoff).toMatchObject({
      source: 'orgx-mcp-widget-proof-cards',
      preserve_tool_results: true,
      live_url: 'https://useorgx.com/live/init-1',
      proof_count: 2,
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
