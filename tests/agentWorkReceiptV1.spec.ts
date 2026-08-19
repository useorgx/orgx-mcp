import { describe, expect, it } from 'vitest';

import {
  AGENT_WORK_RECEIPT_SCHEMA_VERSION,
  AGENT_WORK_RECEIPTS_V1_PATH,
  SUBMIT_RECEIPT_EXTENSION_KEY,
  buildAgentWorkReceiptImportRequest,
  normalizeV1IdempotencyKey,
  shouldFallBackToLegacyReceipts,
} from '../src/agentWorkReceiptV1';

const WORKSPACE_ID = '7af01a51-49b1-47d8-98b9-91a198debca8';
const ISSUED_AT = '2026-08-19T12:00:00.000Z';

function build(
  args: Record<string, unknown>,
  overrides: Partial<Parameters<typeof buildAgentWorkReceiptImportRequest>[1]> = {}
) {
  return buildAgentWorkReceiptImportRequest(args, {
    workspaceId: WORKSPACE_ID,
    issuedAt: ISSUED_AT,
    receiptId: 'receipt-fixture',
    ...overrides,
  });
}

describe('buildAgentWorkReceiptImportRequest', () => {
  it('targets the hash-chained v1 import route', () => {
    expect(AGENT_WORK_RECEIPTS_V1_PATH).toBe('/api/v1/agent-work-receipts');
  });

  it('maps a fully populated tool input onto the AWR v0.1 shape', () => {
    const { body, warnings } = build({
      workspace_id: WORKSPACE_ID,
      receipt_type: 'proof',
      summary: 'Merged PR #142 unblocking the auth refactor',
      business_outcome: 'Auth refactor ships this week',
      entity_type: 'task',
      entity_id: '11111111-1111-4111-8111-111111111111',
      artifact_id: '22222222-2222-4222-8222-222222222222',
      artifact_type: 'eng.diff_pack',
      agent_type: 'engineering',
      verification_status: 'passed',
      status: 'completed',
      started_at: '2026-08-19T11:00:00.000Z',
      max_cost_usd: 5,
      idempotency_key: 'receipt-fixture',
      evidence: {
        prs: ['https://github.com/useorgx/orgx/pull/142'],
        test_runs: ['https://github.com/useorgx/orgx/actions/runs/1'],
        metrics: [{ name: 'tests_added', value: 12, unit: 'count' }],
        notes: 'All CI lanes green.',
      },
      _context: { client: { name: 'claude-code' } },
    }, { sourceClient: 'claude-code' });

    expect(warnings).toEqual([]);
    expect(body.workspace_id).toBe(WORKSPACE_ID);
    expect(body.idempotency_key).toBe('receipt-fixture');

    const receipt = body.receipt as Record<string, any>;
    expect(receipt.schema_version).toBe(AGENT_WORK_RECEIPT_SCHEMA_VERSION);
    expect(receipt.receipt_id).toBe('receipt-fixture');

    // intent
    expect(receipt.intent.summary).toBe(
      'Merged PR #142 unblocking the auth refactor'
    );
    expect(receipt.intent.objective).toBe('Auth refactor ships this week');
    expect(receipt.intent.metadata.receipt_type).toBe('proof');

    // actor carries agent_type + verbatim client runtime
    expect(receipt.actor).toEqual({
      type: 'agent',
      id: 'engineering',
      runtime: { name: 'claude-code' },
    });

    // authority stays unknown but records the spend cap honestly
    expect(receipt.authority.mode).toBe('unknown');
    expect(receipt.authority.status).toBe('unknown');
    expect(receipt.authority.scope.spend_limit).toEqual({
      currency: 'USD',
      amount: 5,
    });

    // synthesized action reflects the receipted work
    expect(receipt.actions).toEqual([
      {
        id: 'action-1',
        type: 'proof',
        summary: 'Merged PR #142 unblocking the auth refactor',
        status: 'completed',
        started_at: '2026-08-19T11:00:00.000Z',
        completed_at: ISSUED_AT,
      },
    ]);

    // artifact anchor becomes a first-class artifact entry
    expect(receipt.artifacts).toEqual([
      {
        id: '22222222-2222-4222-8222-222222222222',
        kind: 'eng.diff_pack',
        name: 'eng.diff_pack',
        ref: {
          system: 'orgx',
          type: 'artifact',
          id: '22222222-2222-4222-8222-222222222222',
        },
        role: 'output',
      },
    ]);

    // recognized evidence shapes become individual evidence entries
    expect(receipt.evidence.map((entry: any) => [entry.kind, entry.ref?.uri])).toEqual([
      ['pr', 'https://github.com/useorgx/orgx/pull/142'],
      ['test_run', 'https://github.com/useorgx/orgx/actions/runs/1'],
      ['note', undefined],
    ]);
    for (const entry of receipt.evidence) {
      expect(entry.observed_at).toBe(ISSUED_AT);
    }

    // metrics project into outcome.metrics
    expect(receipt.outcome).toEqual({
      status: 'succeeded',
      summary: 'Merged PR #142 unblocking the auth refactor',
      metrics: [{ name: 'tests_added', value: 12, unit: 'count' }],
    });

    // producer-reported verification claims require verifier + check
    expect(receipt.verification.status).toBe('passed');
    expect(receipt.verification.method).toBe('producer_reported');
    expect(receipt.verification.verifier).toEqual({
      type: 'agent',
      id: 'engineering',
    });
    expect(receipt.verification.verified_at).toBe(ISSUED_AT);
    expect(receipt.verification.checks).toEqual([
      {
        id: 'check-1',
        name: 'producer_reported_verification',
        status: 'passed',
        evidence_ids: ['evidence-1', 'evidence-2', 'evidence-3'],
      },
    ]);

    // entity anchor lands in lineage references
    expect(receipt.lineage).toEqual({
      parent_receipt_refs: [],
      references: [
        {
          relationship: 'attests_to',
          ref: {
            system: 'orgx',
            type: 'task',
            id: '11111111-1111-4111-8111-111111111111',
          },
        },
      ],
    });

    // cost is explicit about being unreported, never a measured zero
    expect(receipt.cost).toEqual({
      currency: 'USD',
      total: 0,
      estimated: true,
      metadata: { reported: false },
    });

    // timestamps honor started_at and derive duration
    expect(receipt.timestamps).toEqual({
      started_at: '2026-08-19T11:00:00.000Z',
      completed_at: ISSUED_AT,
      issued_at: ISSUED_AT,
      duration_ms: 3_600_000,
    });

    // nothing is dropped: full tool input preserved minus _context
    const extension = receipt.extensions[SUBMIT_RECEIPT_EXTENSION_KEY];
    expect(extension.tool).toBe('orgx_submit_receipt');
    expect(extension.source_client).toBe('claude-code');
    expect(extension.submitted_fields._context).toBeUndefined();
    expect(extension.submitted_fields.receipt_type).toBe('proof');
    expect(extension.submitted_fields.max_cost_usd).toBe(5);
    expect(extension.submitted_fields.evidence).toEqual({
      prs: ['https://github.com/useorgx/orgx/pull/142'],
      test_runs: ['https://github.com/useorgx/orgx/actions/runs/1'],
      metrics: [{ name: 'tests_added', value: 12, unit: 'count' }],
      notes: 'All CI lanes green.',
    });
  });

  it('produces every required AWR top-level member', () => {
    const { body } = build({ receipt_type: 'proof', summary: 'Did the thing' });
    const receipt = body.receipt as Record<string, unknown>;
    for (const member of [
      'schema_version',
      'receipt_id',
      'intent',
      'actor',
      'authority',
      'actions',
      'artifacts',
      'evidence',
      'outcome',
      'verification',
      'cost',
      'lineage',
      'human_interventions',
      'timestamps',
    ]) {
      expect(receipt[member], `receipt.${member} is required`).toBeDefined();
    }
    expect((receipt.actions as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect((receipt.evidence as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('synthesizes a producer attestation when no evidence is mappable', () => {
    const { body } = build({ receipt_type: 'proof', summary: 'Shipped it' });
    const receipt = body.receipt as Record<string, any>;
    expect(receipt.evidence).toEqual([
      {
        id: 'evidence-1',
        kind: 'producer_attestation',
        summary: 'Producer-reported: Shipped it',
        observed_at: ISSUED_AT,
      },
    ]);
    // no idempotency key was provided, so the body must not invent one
    expect(body.idempotency_key).toBeUndefined();
    // omitted verification stays unverified with no fabricated verifier
    expect(receipt.verification).toEqual({
      status: 'unverified',
      method: 'none',
      checks: [],
      evidence_ids: [],
    });
  });

  it('keeps legacy status semantics: omitted status records success', () => {
    const { body } = build({ receipt_type: 'proof', summary: 'Done' });
    const receipt = body.receipt as Record<string, any>;
    expect(receipt.outcome.status).toBe('succeeded');
    expect(receipt.actions[0].status).toBe('completed');
    expect(receipt.actions[0].completed_at).toBe(ISSUED_AT);
  });

  it.each([
    ['in_progress', 'running', 'unknown', false],
    ['failed', 'failed', 'failed', true],
    ['cancelled', 'skipped', 'cancelled', true],
  ])(
    'maps status %s to action %s / outcome %s',
    (status, actionStatus, outcomeStatus, hasCompletedAt) => {
      const { body } = build({ receipt_type: 'proof', summary: 'Work', status });
      const receipt = body.receipt as Record<string, any>;
      expect(receipt.actions[0].status).toBe(actionStatus);
      expect(receipt.outcome.status).toBe(outcomeStatus);
      expect(Boolean(receipt.actions[0].completed_at)).toBe(hasCompletedAt);
    }
  );

  it('maps blocked verification to inconclusive with a matching check', () => {
    const { body } = build({
      receipt_type: 'proof',
      summary: 'Blocked on CI',
      verification_status: 'blocked',
    });
    const receipt = body.receipt as Record<string, any>;
    expect(receipt.verification.status).toBe('inconclusive');
    expect(receipt.verification.checks[0].status).toBe('inconclusive');
  });

  it('drops an invalid started_at with a warning instead of failing validation', () => {
    const { body, warnings } = build({
      receipt_type: 'proof',
      summary: 'Work',
      started_at: 'yesterday around noon',
    });
    const receipt = body.receipt as Record<string, any>;
    expect(receipt.timestamps.started_at).toBe(ISSUED_AT);
    expect(receipt.timestamps.duration_ms).toBeUndefined();
    expect(warnings).toEqual([
      'started_at was not a valid RFC 3339 timestamp and was not forwarded; duration is recorded as unknown',
    ]);
  });

  it('drops a future started_at with a warning', () => {
    const { warnings } = build({
      receipt_type: 'proof',
      summary: 'Work',
      started_at: '2027-01-01T00:00:00.000Z',
    });
    expect(warnings).toEqual([
      'started_at was in the future and was not forwarded; duration is recorded as unknown',
    ]);
  });

  it('normalizes a legacy idempotency key to the v1 charset and reports it', () => {
    const { body, warnings } = build(
      {
        receipt_type: 'proof',
        summary: 'Work',
        idempotency_key: 'retry key #7 (second attempt)',
      },
      { receiptId: undefined }
    );
    expect(body.idempotency_key).toBe('retry-key--7--second-attempt-');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('idempotency_key was normalized');
    // deterministic: the same legacy key always maps to the same v1 key
    expect(normalizeV1IdempotencyKey('retry key #7 (second attempt)')).toEqual({
      key: 'retry-key--7--second-attempt-',
      changed: true,
    });
    // and the receipt id follows the (normalized) key so retries dedupe
    expect((body.receipt as Record<string, unknown>).receipt_id).toBe(
      'retry-key--7--second-attempt-'
    );
  });

  it('passes a v1-compatible idempotency key through unchanged', () => {
    expect(normalizeV1IdempotencyKey('agent:run/42.retry-1')).toEqual({
      key: 'agent:run/42.retry-1',
      changed: false,
    });
  });

  it('preserves unrecognized evidence keys via extensions and flags bad metrics', () => {
    const { body, warnings } = build({
      receipt_type: 'proof',
      summary: 'Work',
      evidence: {
        custom_scan: { finding_count: 3 },
        metrics: [{ name: '', value: 'twelve' }],
      },
    });
    const receipt = body.receipt as Record<string, any>;
    // the malformed metric is not projected...
    expect(receipt.outcome.metrics).toBeUndefined();
    expect(warnings.some((w) => w.includes('evidence.metrics'))).toBe(true);
    // ...but the raw evidence object survives verbatim in extensions
    expect(
      receipt.extensions[SUBMIT_RECEIPT_EXTENSION_KEY].submitted_fields.evidence
    ).toEqual({
      custom_scan: { finding_count: 3 },
      metrics: [{ name: '', value: 'twelve' }],
    });
  });
});

describe('shouldFallBackToLegacyReceipts', () => {
  it('falls back only on 404 and 401', () => {
    expect(shouldFallBackToLegacyReceipts(404)).toBe(true);
    expect(shouldFallBackToLegacyReceipts(401)).toBe(true);
    expect(shouldFallBackToLegacyReceipts(400)).toBe(false);
    expect(shouldFallBackToLegacyReceipts(403)).toBe(false);
    expect(shouldFallBackToLegacyReceipts(422)).toBe(false);
    expect(shouldFallBackToLegacyReceipts(500)).toBe(false);
    expect(shouldFallBackToLegacyReceipts(undefined)).toBe(false);
  });
});
