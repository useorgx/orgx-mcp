import { describe, expect, it } from 'vitest';

import { buildEntityActionAttachPayload } from '../src/entityActionAttach';

describe('entity_action attach payload builder', () => {
  it('builds a payload for an attach action', () => {
    expect(
      buildEntityActionAttachPayload({
        type: 'task',
        id: '12345678',
        name: 'Implementation notes',
        artifact_type: 'eng.diff_pack',
        external_url: 'https://example.com/artifacts/impl-notes',
        created_by_type: 'agent',
        created_by_id: 'user_123',
      })
    ).toEqual({
      entity_type: 'task',
      entity_id: '12345678',
      name: 'Implementation notes',
      artifact_type: 'eng.diff_pack',
      external_url: 'https://example.com/artifacts/impl-notes',
      created_by_type: 'agent',
      created_by_id: 'user_123',
    });
  });

  it('allows workstream attachments with explicit initiative context', () => {
    expect(
      buildEntityActionAttachPayload({
        type: 'workstream',
        id: '7af01a51',
        initiative_id: '8a6a6df1',
        name: 'Launch brief',
        artifact_type: 'launch.launch_brief',
        artifact_url: 'https://example.com/artifacts/launch-brief.md',
        status: 'approved',
        metadata: { source: 'mcp' },
      })
    ).toEqual({
      entity_type: 'workstream',
      entity_id: '7af01a51',
      initiative_id: '8a6a6df1',
      name: 'Launch brief',
      artifact_type: 'launch.launch_brief',
      artifact_url: 'https://example.com/artifacts/launch-brief.md',
      status: 'approved',
      metadata: { source: 'mcp' },
    });
  });

  it('rejects unsupported entity types', () => {
    expect(() =>
      buildEntityActionAttachPayload({
        type: 'artifact',
        id: '12345678',
        name: 'Bad target',
        artifact_type: 'shared.project_handbook',
        external_url: 'https://example.com',
      } as never)
    ).toThrow(/invalid_enum_value/i);
  });

  it('requires a content URL', () => {
    expect(() =>
      buildEntityActionAttachPayload({
        type: 'task',
        id: '12345678',
        name: 'Missing URL',
        artifact_type: 'eng.diff_pack',
      } as never)
    ).toThrow(/artifact_url or external_url/i);
  });
});
