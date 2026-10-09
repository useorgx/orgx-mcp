import { describe, expect, it, vi } from 'vitest';

import { buildAgentWorkReceiptImportRequest } from '../src/agentWorkReceiptV1';
import { executeReceiptOperation, projectWorkReceiptDetail, RECEIPT_OPERATION_OUTPUT_SCHEMAS, RECEIPT_OPERATION_TOOLS } from '../src/receiptOperationTools';
import { buildPortableReceiptProof } from '../src/portableReceiptProof';

const workspaceId = '7af01a51-49b1-47d8-98b9-91a198debca8';
function receipt() {
  const { body } = buildAgentWorkReceiptImportRequest({ receipt_type: 'proof', summary: 'Shipped the login change', evidence: { links: ['https://example.com/proof'] }, verification_status: 'passed' }, { workspaceId, receiptId: 'portable-fixture', issuedAt: '2026-10-08T12:00:00.000Z' });
  return {
    ...body.receipt,
    schema_version: 'agent-work-receipt/v0.2',
    intent: { ...(body.receipt.intent as object), criteria: [{ id: 'c1', text: 'Login succeeds', source: 'requested' }] },
    outcome: { ...(body.receipt.outcome as object), acceptance: { status: 'accepted' }, criteria_results: [{ criterion_id: 'c1', status: 'met', evidence_ids: ['evidence-1'] }] },
    provenance: [{ path: '/outcome/status', basis: 'declared', confidence: 0.8 }],
    extensions: { 'org.orgx.review/v1': { version: 'org.orgx.review/v1', criteria: [{ criterion_id: 'c1' }], episodes: [], sources: [] } },
  };
}

describe('explicit receipt operations', () => {
  it('imports v0.2 and preserves identified criteria, provenance and extensions without promoting producer success', async () => {
    const document = receipt();
    const request = vi.fn().mockResolvedValue({ ok: true, receipt_id: 'ledger-id', external_receipt_id: 'portable-fixture', schema_version: document.schema_version, idempotent: false });
    const result = await executeReceiptOperation('orgx_submit_work_receipt', { receipt: document, idempotency_key: 'stable-1' }, { workspaceId, request });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0]).toBe('/api/v1/agent-work-receipts');
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ workspace_id: workspaceId, receipt: document, idempotency_key: 'stable-1' });
    expect(result.producer_claims).toEqual({ outcome_status: 'succeeded', verification_status: 'passed', acceptance_status: 'accepted' });
    expect(result.receipt_assessment).toMatchObject({ verification_status: 'producer_reported', acceptance_status: 'awaiting_human_review', outcome_status: null });
    expect(result.effects).toEqual({ receipt_stored: true, work_status_changed: false, authoritative_verification_changed: false, human_acceptance_changed: false });
    expect(RECEIPT_OPERATION_OUTPUT_SCHEMAS.orgx_submit_work_receipt.safeParse(result).success).toBe(true);
  });

  it('validates without a workspace and forwards the portable document, not an import envelope', async () => {
    const document = receipt();
    const request = vi.fn().mockResolvedValue({ ok: true, valid: true, persistence: { stored: false, import_requires_authentication: true } });
    await executeReceiptOperation('orgx_validate_work_receipt', { receipt: document }, { workspaceId: null, request });
    expect(request.mock.calls[0][0]).toBe('/api/v1/agent-work-receipts/validate');
    expect(request.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual(document);
  });

  it('does not downgrade an admission refusal into another write', async () => {
    const request = vi.fn().mockRejectedValue(Object.assign(new Error('reserved harness'), { status: 422 }));
    await expect(executeReceiptOperation('orgx_submit_work_receipt', { receipt: receipt() }, { workspaceId, request })).rejects.toThrow('reserved harness');
    expect(request).toHaveBeenCalledOnce();
  });

  it('blocks hidden operation selectors and requires workspace scope before ledger reads', async () => {
    const request = vi.fn();
    await expect(executeReceiptOperation('orgx_list_work_receipts', { action: 'resolve' }, { workspaceId, request })).rejects.toThrow();
    await expect(executeReceiptOperation('orgx_get_receipt_review_queue', {}, { workspaceId: null, request })).rejects.toThrow('authenticated workspace');
    expect(request).not.toHaveBeenCalled();
  });

  it('encodes opaque receipt IDs and arbitrary search filters without widening the endpoint', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, data: { results: [], total: 0, window_days: 120 } });
    await executeReceiptOperation('orgx_list_work_receipts', { query: 'repo:"team/repo" outcome:failed', limit: 10 }, { workspaceId, request });
    const url = new URL(request.mock.calls[0][0], 'https://useorgx.com');
    expect(url.pathname).toBe('/api/v1/work-ledger/receipts');
    expect(url.searchParams.get('q')).toBe('repo:"team/repo" outcome:failed');
    request.mockResolvedValueOnce({ ok: true, data: { receipt: receipt() } });
    await executeReceiptOperation('orgx_get_work_receipt', { receipt_id: 'run/1?query=%3F' }, { workspaceId, request });
    expect(request.mock.calls[1][0]).toContain('/receipts/run%2F1%3Fquery%3D%253F?');
  });

  it('projects evidence and criteria with bounded samples while retaining real totals and human verdict', () => {
    const document = receipt();
    const evidence = Array.from({ length: 20 }, (_, n) => ({ id: `e${n}`, kind: 'test_run', summary: 'test', ref: { uri: 'https://example.com/test' } }));
    const result = projectWorkReceiptDetail({ data: { receipt_id: 'ledger-id', receipt: { ...document, evidence }, receipt_assessment: { evidence_status: 'recorded', verification_status: 'producer_reported', acceptance_status: 'human_reviewed', outcome_status: 'failed' }, human_judgment: { outcome_status: 'failed', actor_id: 'human', decided_at: '2026-10-08T13:00:00Z' } } });
    expect(result.evidence_total).toBe(20);
    expect(result.evidence).toHaveLength(12);
    expect(result.human_judgment).toMatchObject({ outcome_status: 'failed' });
    expect(RECEIPT_OPERATION_OUTPUT_SCHEMAS.orgx_get_work_receipt.safeParse(result).success).toBe(true);
    expect(result.review_extension).toMatchObject({ present: true, basis: 'producer_reported', criteria_total: 1, episodes_total: 0, sources_total: 0 });
  });

  it('preserves the reviewed document revision separately from its stable receipt UUID', () => {
    const revision = '00000000-0000-4000-8000-000000000002';
    const result = projectWorkReceiptDetail({ data: {
      receipt_id: 'ledger-id', receipt_review_revision: revision, receipt: receipt(),
      human_judgment: { outcome_status: 'succeeded', actor_id: 'human', decided_at: '2026-10-09T00:00:00Z',
        scope: 'receipt_document', reviewed_receipt_id: 'ledger-id', reviewed_receipt_revision: revision },
    } });
    const parsed = RECEIPT_OPERATION_OUTPUT_SCHEMAS.orgx_get_work_receipt.parse(result);
    expect(parsed.receipt_review_revision).toBe(revision);
    expect(parsed.human_judgment?.reviewed_receipt_revision).toBe(revision);
    expect(parsed.human_judgment?.reviewed_receipt_id).toBe('ledger-id');
  });

  it('keeps a v0.2 workstream anchor without treating another system as OrgX', () => {
    const proof = buildPortableReceiptProof({
      lineage: { workstream_ref: { system: 'orgx', type: 'workstream', id: 'actual-workstream' },
        references: [{ ref: { system: 'unrelated-orgx-adapter', type: 'task', id: 'other-system-task' } }] },
      artifacts: [{ kind: 'document', ref: { system: 'not-orgx', type: 'artifact', id: 'other-system-artifact' } }],
    });
    expect(proof.anchor).toEqual({ entity_type: 'workstream', entity_id: 'actual-workstream', artifact_id: null });
    const precise = buildPortableReceiptProof({ lineage: {
      workstream_ref: { system: 'orgx', type: 'workstream', id: 'parent' },
      references: [{ ref: { system: 'orgx', type: 'task', id: 'actual-task' } }],
    } });
    expect(precise.anchor.entity_id).toBe('actual-task');
  });

  it('exposes five closed operations and no model judgment resolver', () => {
    expect(RECEIPT_OPERATION_TOOLS).toHaveLength(5);
    for (const tool of RECEIPT_OPERATION_TOOLS) {
      expect(tool.inputSchema).not.toHaveProperty('action');
      expect(tool.inputSchema).not.toHaveProperty('operation');
      expect(tool.inputSchema).not.toHaveProperty('approval_token');
      expect(RECEIPT_OPERATION_OUTPUT_SCHEMAS).toHaveProperty(tool.id);
    }
  });

  it('retains the source quotation, source check and distinct proof lenses for review criteria', () => {
    const document = receipt();
    document.extensions['org.orgx.review/v1'] = {
      version: 'org.orgx.review/v1', sources: [{ id: 'request', type: 'ticket', title: 'Login request' }],
      criteria: [{ criterion_id: 'c1', source_check: 'wrong', source_refs: [{ source_id: 'request', quote: 'Login without a password' }], lenses: { judged: { status: 'pass' }, measured: { status: 'fail', evidence_ids: ['evidence-1'] }, observed: { status: 'partial' }, outcome: { status: 'none' } } }],
      episodes: [{ id: 'retry', kind: 'retry', title: 'Fixed flaky login test', criterion_ids: ['c1'], evidence_ids: ['evidence-1'], commit: { sha: 'abc123' } }],
    } as typeof document.extensions['org.orgx.review/v1'];
    const result = projectWorkReceiptDetail({ receipt: document });
    expect(result.review_extension).toMatchObject({ basis: 'producer_reported', criteria: [{ criterion_id: 'c1', source_check: 'wrong', source_refs: [{ source_id: 'request', quote: 'Login without a password' }], lenses: { judged: { status: 'pass' }, measured: { status: 'fail', evidence_ids: ['evidence-1'] }, observed: { status: 'partial' }, outcome: { status: 'none' } } }], episodes: [{ commit_sha: 'abc123' }] });
  });

  it('includes v0.1 unnumbered acceptance criteria as unknown rather than inventing results', () => {
    const result = projectWorkReceiptDetail({ receipt: { schema_version: 'agent-work-receipt/v0.1', receipt_id: 'old', intent: { summary: 'Login', acceptance_criteria: ['Login succeeds'] } } });
    expect(result.criteria).toEqual([{ id: 'criterion-1', text: 'Login succeeds', status: 'unknown', evidence_ids: [],
      basis: 'producer_reported', confidence: null, kind: null, required: null, source: null, source_ref: null,
      source_label: null, review_state: null, lenses: null }]);
    expect(result.criteria_total).toBe(1);
  });

  it('retains producer confidence and source context without turning reported agreement into human acceptance', () => {
    const document = receipt();
    const result = RECEIPT_OPERATION_OUTPUT_SCHEMAS.orgx_get_work_receipt.parse(projectWorkReceiptDetail({ data: {
      receipt: { ...document,
        intent: { ...document.intent, objective: 'Users can sign in reliably', criteria: [{ ...document.intent.criteria[0], kind: 'behavior', required: true }] },
        outcome: { ...document.outcome, summary: 'The login check ran', criteria_results: [{ criterion_id: 'c1', status: 'met', confidence: 0.45, evidence_ids: ['evidence-1'] }] },
        extensions: { ...document.extensions, 'org.orgx.expectations/v1': { set_id: 'set-1', version: 2, agreed_at: '2026-10-08T12:00:00Z', agreed_by: 'claimed-human', contract_hash: 'hash-1', declared_at: '2026-10-08T11:00:00Z', criteria: [{ id: 'c1', source: 'learned', source_ref: 'promotion:1', source_label: 'Earlier login failure' }] } },
      },
      criteria: [{ id: 'c1', state: 'partial', lenses: { judged: { s: 'pass' }, measured: { s: 'fail', note: 'A test failed' }, observed: { s: 'none' }, outcome: { s: 'partial' } } }],
    } }));
    expect(result.objective).toBe('Users can sign in reliably');
    expect(result.outcome_summary).toBe('The login check ran');
    expect(result.criteria[0]).toMatchObject({ basis: 'producer_reported', confidence: 0.45, source: 'learned', source_ref: 'promotion:1', source_label: 'Earlier login failure', kind: 'behavior', required: true, status: 'met', review_state: 'partial', lenses: { measured: { status: 'fail', note: 'A test failed' } } });
    expect(result.reported_bar).toEqual({ basis: 'producer_reported', set_id: 'set-1', version: 2, agreed_at: '2026-10-08T12:00:00Z', agreed_by: 'claimed-human', contract_hash: 'hash-1', declared_at: '2026-10-08T11:00:00Z' });
    expect(result).not.toHaveProperty('bar');
    expect(result.human_judgment).toBeNull();
    expect(result.receipt_assessment).toMatchObject({ acceptance_status: 'awaiting_human_review', outcome_status: null });
  });

  it('bounds producer metadata and rejects invalid confidence rather than presenting it as certain', () => {
    for (const invalidConfidence of [-0.1, 1.1, Infinity, NaN, '0.8']) {
      const document = receipt();
      const result = RECEIPT_OPERATION_OUTPUT_SCHEMAS.orgx_get_work_receipt.parse(projectWorkReceiptDetail({ receipt: {
        ...document, intent: { ...document.intent, objective: 'o'.repeat(2500), criteria: [{ id: 'c1', text: 'Login', source: 's'.repeat(200), source_label: 'l'.repeat(800) }] },
        outcome: { ...document.outcome, summary: 'r'.repeat(2500), criteria_results: [{ criterion_id: 'c1', status: 'met', confidence: invalidConfidence }] },
        extensions: { 'org.orgx.expectations/v1': { version: -1, agreed_at: 'a'.repeat(300) } },
      } }));
      expect(result.criteria[0].confidence).toBeNull();
      expect(result.criteria[0].source).toHaveLength(120);
      expect(result.criteria[0].source_label).toHaveLength(512);
      expect(result.objective).toHaveLength(2000);
      expect(result.outcome_summary).toHaveLength(2000);
      expect(result.reported_bar?.version).toBeNull();
      expect(result.reported_bar?.agreed_at).toHaveLength(256);
    }
  });
});
