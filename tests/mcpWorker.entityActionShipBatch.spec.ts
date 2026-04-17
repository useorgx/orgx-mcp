import { describe, expect, it } from 'vitest';

import { buildEntityActionShipBatchPayload } from '../src/entityActionShipBatch';

describe('entity_action ship_batch payload builder', () => {
  it('builds a payload targeting specific subcomponent tasks', () => {
    const result = buildEntityActionShipBatchPayload({
      milestone_id: 'b11c5fa2-cafe-4a2a-babe-c0ffee000001',
      artifact: {
        name: 'Proof-chain redesign PR',
        artifact_type: 'eng.diff_pack',
        external_url: 'https://github.com/useorgx/orgx/pull/999',
        status: 'approved',
        preview_markdown: '## Summary\nShipped the redesign.',
      },
      quality_score: 4.5,
      task_ids: [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ],
      note: 'Shipped via #999',
    });

    expect(result.milestone_id).toBe(
      'b11c5fa2-cafe-4a2a-babe-c0ffee000001'
    );
    expect(result.body.artifact).toMatchObject({
      name: 'Proof-chain redesign PR',
      artifact_type: 'eng.diff_pack',
      external_url: 'https://github.com/useorgx/orgx/pull/999',
      status: 'approved',
    });
    expect(result.body.quality_score).toBe(4.5);
    expect(result.body.task_ids).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
    expect(result.body.note).toBe('Shipped via #999');
    expect(result.body.reason).toBe('Shipped via #999');
  });

  it('omits task_ids when caller wants to target all subcomponent tasks', () => {
    const result = buildEntityActionShipBatchPayload({
      milestone_id: 'b11c5fa2-cafe-4a2a-babe-c0ffee000001',
      artifact: {
        name: 'Proof-chain redesign PR',
        artifact_type: 'eng.diff_pack',
        artifact_url: 'orgx://artifacts/pr-999',
      },
    });
    expect(result.body.task_ids).toBeUndefined();
    expect(result.body.quality_score).toBeUndefined();
  });

  it('rejects an artifact without a URL', () => {
    expect(() =>
      buildEntityActionShipBatchPayload({
        milestone_id: 'b11c5fa2-cafe-4a2a-babe-c0ffee000001',
        artifact: {
          name: 'Bad artifact',
          artifact_type: 'eng.diff_pack',
        },
      })
    ).toThrow(/artifact_url or external_url/i);
  });

  it('rejects quality_score outside 0-5', () => {
    expect(() =>
      buildEntityActionShipBatchPayload({
        milestone_id: 'b11c5fa2-cafe-4a2a-babe-c0ffee000001',
        artifact: {
          name: 'Fine artifact',
          artifact_type: 'eng.diff_pack',
          external_url: 'https://example.com/pr',
        },
        quality_score: 7,
      })
    ).toThrow();
  });

  it('rejects non-uuid task_ids', () => {
    expect(() =>
      buildEntityActionShipBatchPayload({
        milestone_id: 'b11c5fa2-cafe-4a2a-babe-c0ffee000001',
        artifact: {
          name: 'Fine artifact',
          artifact_type: 'eng.diff_pack',
          external_url: 'https://example.com/pr',
        },
        task_ids: ['not-a-uuid'],
      })
    ).toThrow();
  });
});
