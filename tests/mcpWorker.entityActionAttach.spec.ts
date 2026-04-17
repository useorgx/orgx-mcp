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

  // Regression: save_artifact (deprecated) now routes through the attach payload
  // builder. Before the fix, save_artifact accepted the legacy enum
  // ('document'|'code'|'data'|'decision'|'analysis') and POSTed a shape the server
  // rejected with "Invalid option: expected one of project|initiative|...".
  // This confirms the new call path produces a valid attach payload regardless
  // of whether the caller passed a legacy category or a modern artifact_type.
  it('accepts a save_artifact-style legacy call via the attach builder', () => {
    expect(
      buildEntityActionAttachPayload({
        type: 'task',
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Agent session transcript',
        artifact_type: 'document', // legacy category, now treated as a free-form code
        external_url: 'https://example.com/transcript',
        preview_markdown: 'Session ABC produced this transcript.',
        metadata: { session_id: 'sess_abc', legacy_type: 'document' },
      })
    ).toEqual({
      entity_type: 'task',
      entity_id: '11111111-1111-4111-8111-111111111111',
      name: 'Agent session transcript',
      artifact_type: 'document',
      external_url: 'https://example.com/transcript',
      preview_markdown: 'Session ABC produced this transcript.',
      metadata: { session_id: 'sess_abc', legacy_type: 'document' },
    });
  });
});
