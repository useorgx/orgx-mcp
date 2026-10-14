import { describe, expect, it } from 'vitest';
import fixture from './fixtures/trail-reviewed-inspection.json';
import { projectWorkReceiptDetail, RECEIPT_OPERATION_OUTPUT_SCHEMAS } from '../src/receiptOperationTools';
import { portableReceiptInput } from '../src/portableReceiptInput';

describe('pinned Trail reviewed wire conformance', () => {
  it('reads the exact synthetic exported outcome and criteria while preserving producer authority', () => {
    expect(fixture.source_commit).toBe('f193c0da017f18a55e961ecb48d8eb8eaa9949e9');
    expect(portableReceiptInput.safeParse(fixture.wire).success).toBe(true);
    const detail=RECEIPT_OPERATION_OUTPUT_SCHEMAS.orgx_get_work_receipt.parse(projectWorkReceiptDetail({receipt:fixture.wire}));
    expect(detail.producer_claims).toEqual({outcome_status:'blocked',verification_status:'passed',acceptance_status:'pending'});
    expect(detail.criteria.map((c)=>[c.id,c.status])).toEqual([['c1','met'],['c2','unmet']]);
    expect(detail.human_judgment).toBeNull();expect(detail.receipt_review_revision).toBeNull();
    expect(detail.receipt_assessment.acceptance_status).toBe('awaiting_human_review');
    expect(fixture.wire.extensions['org.orgx.trail/v1'].local_review.authority).toBe('local_only');
  });
  it('keeps a later authenticated judgment and its document revision separate from local producer corrections', () => {
    const detail=RECEIPT_OPERATION_OUTPUT_SCHEMAS.orgx_get_work_receipt.parse(projectWorkReceiptDetail({receipt:fixture.wire,
      receipt_review_revision:'server-revision-2',human_judgment:{outcome_status:'failed',actor_id:'synthetic-reviewer',decided_at:'2026-10-14T12:00:00Z',scope:'receipt_document',reviewed_receipt_id:'ledger-synthetic',reviewed_receipt_revision:'server-revision-2'}}));
    expect(detail.producer_claims.outcome_status).toBe('blocked');expect(detail.human_judgment?.outcome_status).toBe('failed');
    expect(detail.human_judgment?.reviewed_receipt_revision).toBe('server-revision-2');
    expect(fixture.original.outcome.status).toBe('succeeded');expect(fixture.original.outcome.acceptance.status).toBe('pending');
  });
});
