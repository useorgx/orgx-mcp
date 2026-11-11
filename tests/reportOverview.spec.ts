import { describe, expect, it, vi } from 'vitest';

import { projectChronicleOverview } from '../src/reportOverview';
import { executeReceiptOperation } from '../src/receiptOperationTools';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const large = 'large proof body '.repeat(1000);

describe('compact reporting projections', () => {
  it('preserves counts, proof states and coverage while removing duplicated detail', () => {
    const data = { chronicle: {
      workspaceId, period: 'week', summary: 'Work moved.',
      metrics: { pendingDecisions: 0 },
      dataGaps: ['Receipts were unavailable.'],
      decisionChronology: [{ id: 'd1', summary: large }],
      rollups: [{ period: 'week', pendingDecisions: 0, resolvedDecisionHighlights: [{ summary: large }] }],
      artifactLedger: [{ id: 'a1', title: 'Artifact', version: 3, preview_markdown: large, metadata: { content: large } }],
      continuity: { metrics: { records: 120 }, events: [{ id: 'event', entityId: 'a1', proofState: 'verified', summary: 'First proof.\n\n' + large }] },
    } };
    const overview = projectChronicleOverview(data);
    expect(overview).toMatchObject({ chronicle: {
      metrics: { pendingDecisions: 0 }, dataGaps: data.chronicle.dataGaps,
      decisionChronology: [{ id: 'd1', summary: '', summary_truncated: true }],
      rollups: [{ period: 'week', pendingDecisions: 0 }],
      artifactLedger: [{ id: 'a1', version: 3 }],
      continuity: { metrics: { records: 120 }, events: [{ id: 'event', entityId: 'a1', proofState: 'verified', summary: 'First proof.', summary_truncated: true }] },
      overview: { fullCall: { tool: 'orgx_get_operator_brief', args: { workspace_id: workspaceId, period: 'week', detail: 'full' } } },
    } });
    expect(JSON.stringify(overview).length).toBeLessThan(1200);
    expect(data.chronicle.artifactLedger[0]?.preview_markdown).toBe(large);
  });

  it('keeps ledger scope and detail links without changing totals or receipt authority', async () => {
    const data = {
      results: [{ receipt_id: 'r1', summary: 'Receipt proof.\n\n' + large, receipt_assessment: { verification_status: 'verified' } }],
      total: 75,
    };
    const request = vi.fn().mockResolvedValue({ data });
    const args = { view: 'receipts', query: 'repo:team/project', limit: 1 };
    const overview = await executeReceiptOperation('orgx_list_work_receipts', args, { workspaceId, request });
    expect(overview).toMatchObject({
      total: 75,
      results: [{ receipt_id: 'r1', summary: 'Receipt proof.', summary_truncated: true, receipt_assessment: { verification_status: 'verified' } }],
    });
    expect(overview.next_calls).toEqual(expect.arrayContaining([
      { tool: 'orgx_list_work_receipts', args: { ...args, workspace_id: workspaceId, detail: 'full' } },
    ]));
    const full = await executeReceiptOperation('orgx_list_work_receipts', { ...args, detail: 'full' }, { workspaceId, request });
    expect(full.results).toEqual(data.results);
    expect(request.mock.calls[0]).toEqual(request.mock.calls[1]);
  });
});
