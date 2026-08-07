import { describe, expect, it } from 'vitest';

import {
  buildEntityActionAttachPayload,
  withAttachSourceClient,
} from '../src/entityActionAttach';

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
        agent_type: 'marketing',
        company_stage: 'founder_led_company',
        business_outcome: 'Launch the founder-led onboarding campaign',
        owner: 'marketing-agent',
        review_date: '2026-05-27',
        verification: ['brief reviewed', 'channel hypothesis named'],
      })
    ).toEqual({
      entity_type: 'workstream',
      entity_id: '7af01a51',
      initiative_id: '8a6a6df1',
      name: 'Launch brief',
      artifact_type: 'launch.launch_brief',
      artifact_url: 'https://example.com/artifacts/launch-brief.md',
      status: 'approved',
      metadata: {
        source: 'mcp',
        artifact_contract: {
          agent_type: 'marketing',
          company_stage: 'founder_led_company',
          business_outcome: 'Launch the founder-led onboarding campaign',
          owner: 'marketing-agent',
          review_date: '2026-05-27',
          verification: ['brief reviewed', 'channel hypothesis named'],
        },
      },
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
  // Regression: the worker resolves source_client from the initialize handshake
  // and injected it at the top level of the POST body. /api/client/artifacts
  // validates with a .strict() schema that has no source_client key, so the
  // server rejected its own injected field:
  //   "Unrecognized key: source_client"
  // Attribution belongs in metadata, which is an open record on both the
  // contract and the work_artifacts table.
  describe('source_client attribution', () => {
    // Mirrors CREATE_SCHEMA in orgx: lib/server/artifacts/clientContract.ts.
    // That schema is .strict(), so any key outside this set is a 400.
    const SERVER_ACCEPTED_KEYS = new Set([
      'id',
      'artifact_id',
      'entity_type',
      'entity_id',
      'initiative_id',
      'name',
      'artifact_type',
      'description',
      'artifact_url',
      'external_url',
      'preview_markdown',
      'status',
      'metadata',
      'created_by_type',
      'created_by_id',
    ]);

    const basePayload = buildEntityActionAttachPayload({
      type: 'task',
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Attach receipt',
      artifact_type: 'eng.diff_pack',
      external_url: 'https://example.com/artifacts/receipt',
    });

    it('carries attribution in metadata, never at the top level', () => {
      const body = withAttachSourceClient(basePayload, 'claude');

      expect(body).not.toHaveProperty('source_client');
      expect(body.metadata).toEqual({ source_client: 'claude' });
    });

    it('produces a body the strict server contract accepts', () => {
      const body = withAttachSourceClient(basePayload, 'claude');

      expect(
        Object.keys(body).filter((key) => !SERVER_ACCEPTED_KEYS.has(key))
      ).toEqual([]);
    });

    it('preserves caller metadata alongside attribution', () => {
      const payload = buildEntityActionAttachPayload({
        type: 'task',
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Attach receipt',
        artifact_type: 'eng.diff_pack',
        external_url: 'https://example.com/artifacts/receipt',
        metadata: { session_id: 'sess_abc' },
      });

      expect(withAttachSourceClient(payload, 'cursor').metadata).toEqual({
        session_id: 'sess_abc',
        source_client: 'cursor',
      });
    });

    it('leaves the payload untouched when attribution is unresolved', () => {
      for (const unresolved of [null, undefined, '']) {
        expect(withAttachSourceClient(basePayload, unresolved)).toBe(
          basePayload
        );
      }
    });
  });
});
