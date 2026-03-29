import { describe, expect, it } from 'vitest';

import {
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
  });

  it('adds recent artifacts to initiative pulse payloads', () => {
    const payload = enrichInitiativePulseWithArtifacts(
      { id: 'init-1', name: 'Ship MCP App Store Listing' },
      [
        { id: 'artifact-1', name: 'server.json manifest', status: 'approved' },
        { id: 'artifact-2', name: 'DNS verification', status: 'approved' },
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
  });
});
