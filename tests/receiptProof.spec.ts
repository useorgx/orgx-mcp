import { describe, expect, it } from 'vitest';

import { CONTRACT_TOOL_DEFINITIONS } from '../src/contractTools';
import { getToolOutputSchema } from '../src/openaiOutputSchemas';
import { buildReceiptProof, RECEIPT_PROOF_EVIDENCE_LIMIT } from '../src/receiptProof';
import { OUTPUT_TEMPLATE_URIS, WIDGET_RESOURCES, WIDGET_URIS } from '../src/toolDefinitions';

const LOOP_VALIDATION = {
  rung: null,
  applies: false,
  promotable: false,
  missing: ['business_outcome'],
  warnings: [],
  next_required_action: 'Add missing loop receipt fields: business_outcome.',
};

describe('receipt proof projection', () => {
  it('echoes the claimed anchor, outcome and evidence as typed rows', () => {
    const proof = buildReceiptProof({
      receipt_type: 'proof',
      entity_type: 'task',
      entity_id: '7f3c2a10-5b1e-4c3d-9a8f-2e6b4d1c0a99',
      artifact_type: 'pull_request',
      agent_type: 'engineering',
      business_outcome: '  Checkout   completes in under a second. ',
      model_tier: 'standard',
      summary: 'not part of the projection',
      evidence: {
        prs: ['https://github.com/acme/checkout/pull/2291', 'javascript:alert(1)'],
        deploys: 'https://checkout-git-2291.vercel.app/',
        test_runs: ['https://github.com/acme/checkout/actions/runs/1182'],
        metrics: [{ name: 'p95 latency', value: 812, unit: 'ms' }, { value: 3 }],
        links: ['ftp://example.com/x'],
        notes: 'Shared in #launch.',
      },
    });
    expect(proof).toEqual({
      receipt_type: 'proof',
      status: 'completed',
      anchor: { entity_type: 'task', entity_id: '7f3c2a10-5b1e-4c3d-9a8f-2e6b4d1c0a99', artifact_id: null },
      artifact_type: 'pull_request',
      agent_type: 'engineering',
      business_outcome: 'Checkout completes in under a second.',
      model_tier: 'standard',
      evidence: [
        { kind: 'pr', label: 'PR 2291 · acme/checkout', url: 'https://github.com/acme/checkout/pull/2291', value: null },
        { kind: 'deploy', label: 'Deploy · checkout-git-2291.vercel.app', url: 'https://checkout-git-2291.vercel.app/', value: null },
        { kind: 'test_run', label: 'Test run · github.com/runs/1182', url: 'https://github.com/acme/checkout/actions/runs/1182', value: null },
        { kind: 'metric', label: 'p95 latency', url: null, value: '812 ms' },
        { kind: 'note', label: 'Shared in #launch.', url: null, value: null },
      ],
      evidence_total: 5,
    });
  });

  it('caps the evidence list and keeps the true total beside it', () => {
    const prs = Array.from({ length: 19 }, (_, i) => `https://github.com/acme/app/pull/${i + 1}`);
    const proof = buildReceiptProof({ receipt_type: 'proof', evidence: { prs } });
    expect(proof.evidence).toHaveLength(RECEIPT_PROOF_EVIDENCE_LIMIT);
    expect(proof.evidence_total).toBe(19);
  });

  it('keeps an explicit terminal status and never invents one', () => {
    expect(buildReceiptProof({ receipt_type: 'proof', status: 'failed' }).status).toBe('failed');
    expect(buildReceiptProof({ receipt_type: 'proof', status: 'shipped' }).status).toBe('completed');
    expect(buildReceiptProof({ receipt_type: 'proof' }).evidence).toEqual([]);
  });
});

describe('orgx_submit_receipt output contract', () => {
  const schema = getToolOutputSchema('orgx_submit_receipt') as unknown as {
    safeParse(value: unknown): { success: boolean; error?: unknown };
  };

  it('accepts the v1 import response as the API returns it, with the proof echo', () => {
    // POST /api/v1/agent-work-receipts answers with these fields; the strict
    // schema used to reject external_receipt_id, schema_version, idempotent,
    // imported_at and pilot, so the SDK refused every successful v1 receipt.
    const result = schema.safeParse({
      ok: true,
      receipt_id: '3f9c1d2e-8a7b-4c6d-9e0f-1a2b3c4d5e6f',
      external_receipt_id: 'awr_01JABCDEF',
      schema_version: 'agent-work-receipt/v0.1',
      idempotent: false,
      imported_at: '2026-10-02T14:00:00Z',
      pilot: null,
      _v2_tool: 'orgx_submit_receipt',
      path: 'v1',
      summary: 'Merged PR 2291.',
      verification_status: 'passed',
      proof: buildReceiptProof({ receipt_type: 'proof', evidence: { prs: ['https://github.com/acme/app/pull/1'] } }),
      loop_validation: LOOP_VALIDATION,
    });
    expect(result.success).toBe(true);
  });

  it('accepts the legacy path with the proof echo', () => {
    const result = schema.safeParse({
      _v2_tool: 'orgx_submit_receipt',
      path: 'legacy',
      fallback_reason: 'missing_workspace_id',
      id: 'rcpt_8812',
      summary: 'Merged PR 2291.',
      proof: buildReceiptProof({ receipt_type: 'proof' }),
      loop_validation: LOOP_VALIDATION,
    });
    expect(result.success).toBe(true);
  });

  it('renders in the proof-receipt widget', () => {
    const tool = CONTRACT_TOOL_DEFINITIONS.find((entry) => entry.id === 'orgx_submit_receipt');
    expect(tool?._meta).toMatchObject({
      'openai/outputTemplate': OUTPUT_TEMPLATE_URIS.proofReceipt,
      ui: { resourceUri: WIDGET_URIS.proofReceipt },
    });
    expect(WIDGET_RESOURCES).toContainEqual({
      name: 'proof-receipt-widget',
      uri: WIDGET_URIS.proofReceipt,
      title: 'Receipt Widget',
    });
  });
});

describe('orgx_submit_receipt handler', () => {
  it('echoes the proof on both the v1 and legacy paths', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const worker = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8');
    expect(worker.match(/proof: buildReceiptProof\(args\),/g)).toHaveLength(2);
  });
});
