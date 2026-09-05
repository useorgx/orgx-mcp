import { describe, expect, it } from 'vitest';

import { formatForLLM } from '../src/responseSummarizer';

describe('response summarizer v2 OrgX workflows', () => {
  it('summarizes orgx_search results with IDs and inspect next step', () => {
    const text = formatForLLM('orgx_search', {
      _v2_tool: 'orgx_search',
      type: 'initiative',
      query: 'Crane Treasury',
      count: 1,
      results: [
        {
          id: '8118276c-a332-4dc4-b5ee-9230ee766956',
          title: 'Crane Treasury GTM',
          status: 'active',
        },
      ],
    });

    expect(text).toContain('OrgX search: 1 initiative');
    expect(text).toContain('id:8118276c-a332-4dc4-b5ee-9230ee766956');
    expect(text).toContain('Next: call orgx_inspect');
    expect(text).not.toContain('Result with');
  });

  it('summarizes orgx_inspect around the hydrated entity instead of wrapper fields', () => {
    const text = formatForLLM('orgx_inspect', {
      _v2_tool: 'orgx_inspect',
      type: 'task',
      id: 'task-1',
      entity: {
        id: 'task-1',
        title: 'Send batch 2',
        status: 'in_progress',
        summary: 'Carry reply signal forward.',
      },
    });

    expect(text).toContain('OrgX task');
    expect(text).toContain('Send batch 2');
    expect(text).toContain('id:task-1');
    expect(text).toContain('Description: Carry reply signal forward.');
    expect(text).not.toContain('Result with');
  });

  it('mirrors orgx_inspect context packs into concise text for hookless clients', () => {
    const text = formatForLLM('orgx_inspect', {
      _v2_tool: 'orgx_inspect',
      type: 'initiative',
      id: 'init-1',
      entity: {
        id: 'init-1',
        title: 'Frontier model leverage',
        status: 'active',
      },
      context_pack: {
        schemaVersion: 'gf_v1',
        compiledAt: '2026-07-08T15:04:00.000Z',
        tools: ['orgx_search', 'orgx_inspect', 'recall_memory'],
        missingPermissions: ['billing.write'],
        recommendedNextActions: [
          {
            action: 'Inspect context pack in text channel',
            confidence: 'high',
          },
        ],
        frame: {
          anchor: {
            type: 'initiative',
            id: 'init-1',
            title: 'Frontier model leverage',
          },
          definitionOfDone: {
            expectedArtifacts: [
              { type: 'pull_request' },
              { type: 'verification_receipt' },
            ],
            checks: ['typecheck', 'focused tests'],
            source: 'declared',
          },
          artifacts: {
            expected: [{ type: 'pull_request' }],
            produced: [{ receiptId: 'receipt-1', type: 'pull_request' }],
          },
          blockers: [
            {
              title: 'MCP context not visible',
              description: 'Text channel omitted the pack.',
              status: 'open',
            },
          ],
          decisions: [
            {
              id: 'decision-1',
              choice: 'Use context pack text mirror',
              disposition: 'accepted',
              rationale: 'Hookless clients read text content first.',
            },
          ],
          expectations: [
            {
              id: 'expectation-pending',
              metricRegistryId: 'orgx.run_receipt_coverage.v1',
              state: 'pending',
              predicate: { operator: 'gte', threshold: 0.95 },
              minimumSampleSize: 20,
            },
            {
              id: 'expectation-met',
              metricRegistryId: 'orgx.run_receipt_coverage.v1',
              state: 'met',
              predicate: { operator: 'gte', threshold: 0.95 },
              minimumSampleSize: 20,
              observation: {
                numerator: 19,
                denominator: 20,
                value: 0.95,
              },
            },
            {
              id: 'expectation-cancelled',
              metricRegistryId: 'orgx.run_receipt_coverage.v1',
              state: 'cancelled',
            },
            {
              id: 'expectation-unsupported',
              metricRegistryId: 'orgx.arbitrary_metric.v1',
              state: 'met',
            },
          ],
          budget: {
            capCents: 800,
            spentCents: 150,
            remainingCents: 650,
          },
          risk: 'key',
          chronology: {
            lastRun: 'Session-token read tools were merged.',
            openLoops: ['Merge context text slice'],
          },
          coverage: {
            band: 'medium',
            ratio: 0.75,
            degraded: false,
          },
          earnedBoundary: {
            sentence: 'Session tools can read initiative context.',
          },
          degraded: false,
        },
      },
    });

    expect(text).toContain('Context pack:');
    expect(text).toContain('Working from: Frontier model leverage (as of 15:04)');
    expect(text).toContain(
      'Definition of done: 2 artifact(s) - pull_request, verification_receipt'
    );
    expect(text).toContain('Checks: typecheck, focused tests');
    expect(text).toContain('Boundary: Session tools can read initiative context.');
    expect(text).toContain('Confidence: medium 0.75');
    expect(text).toContain('Budget: $6.50 of $8.00 left');
    expect(text).toContain('Produced artifacts: 1 - pull_request');
    expect(text).toContain('Open blockers:');
    expect(text).toContain('MCP context not visible: Text channel omitted the pack.');
    expect(text).toContain('Decisions already made:');
    expect(text).toContain(
      '[accepted] Use context pack text mirror - because Hookless clients read text content first.'
    );
    expect(text).toContain(
      'Metric expectations (observations do not prove causation):'
    );
    expect(text).toContain(
      '[pending] orgx.run_receipt_coverage.v1 - gte 0.95; minimum sample 20'
    );
    expect(text).toContain(
      '[met] orgx.run_receipt_coverage.v1 - observed 19/20 (0.95); predicate gte 0.95'
    );
    expect(text).not.toContain('[cancelled]');
    expect(text).not.toContain('orgx.arbitrary_metric.v1');
    expect(text).toContain('Recommended next:');
    expect(text).toContain('Inspect context pack in text channel (high)');
    expect(text).toContain('Missing permissions: billing.write');
    expect(text).toContain(
      'Available tools: 3 (orgx_search, orgx_inspect, recall_memory)'
    );
    expect(text).not.toContain('schemaVersion');
    expect(text).not.toContain('compiledAt');
    expect(text).not.toContain('gf_v1');
  });

  it('mirrors bootstrap initiative context into the text channel', () => {
    const text = formatForLLM('orgx_bootstrap', {
      profile: 'executor',
      visible_tools_count: 12,
      workspace: { id: 'ws-1', name: 'OrgX' },
      initiative: { id: 'init-1' },
      context_pack: {
        compiledAt: '2026-08-21T18:30:00.000Z',
        frame: {
          anchor: { type: 'initiative', id: 'init-1', title: 'Revenue Spine' },
          decisions: [
            {
              id: 'decision-2',
              choice: 'Do not send without approval',
              disposition: 'rejected',
              rationale: 'Authority remains pending.',
            },
          ],
        },
      },
    });

    expect(text).toContain('OrgX contract ready. Profile: executor. Visible tools: 12.');
    expect(text).toContain('Workspace: OrgX.');
    expect(text).toContain('Initiative: init-1.');
    expect(text).toContain('Context pack:');
    expect(text).toContain('[rejected] Do not send without approval');
  });

  it('mirrors the exact workspace context capsule and its truth boundaries', () => {
    const text = formatForLLM('orgx_bootstrap', {
      profile: 'executor',
      visible_tools_count: 12,
      workspace: { id: 'ws-1', name: 'OrgX' },
      context_capsule: {
        schema_version: 'orgx.context-capsule/v1',
        capsule_id: 'capsule_123',
        as_of_global_sequence: 2491,
        current_intent: null,
        active_constraints: [],
        authoritative_decisions: [
          {
            ref: { system: 'orgx', type: 'decision', id: 'decision-1' },
            summary: 'Keep automatic receipts metadata-only.',
            provenance: 'accepted',
            status: 'approved',
          },
        ],
        applied_learnings: [],
        pending_expectations: [
          {
            ref: {
              system: 'orgx',
              type: 'metric_expectation',
              id: 'expectation-1',
            },
            summary: 'orgx.run_receipt_coverage.v1 gte 0.95',
            provenance: 'asserted',
            status: 'pending',
          },
        ],
        open_risks: [],
        recent_receipt_refs: [
          { system: 'orgx', type: 'execution_receipt', id: 'receipt-1' },
        ],
        omitted_counts: {
          authoritative_decisions: 2,
          applied_learnings: 0,
          pending_expectations: 0,
          open_risks: 0,
          recent_receipt_refs: 4,
        },
        content_digest: 'sha256:abc123',
      },
    });

    expect(text).toContain(
      'Context capsule capsule_123 (as of sequence 2491):'
    );
    expect(text).toContain(
      '[approved] Keep automatic receipts metadata-only.'
    );
    expect(text).toContain('Applied learnings: none returned in this bounded projection.');
    expect(text).toContain('Consistency: best-effort reads.');
    expect(text).toContain('Source coverage is incomplete or unknown.');
    expect(text).toContain(
      '[pending] orgx.run_receipt_coverage.v1 gte 0.95'
    );
    expect(text).toContain('Recent receipt refs: receipt-1');
    expect(text).toContain(
      'Omitted by budget: authoritative_decisions 2, recent_receipt_refs 4.'
    );
    expect(text).toContain('Digest: sha256:abc123');
  });

  it('describes coherent capsule sources without promoting the entity frame', () => {
    const text = formatForLLM('orgx_bootstrap', { context_capsule: {
      schema_version: 'orgx.context-capsule/v1', capsule_id: 'snapshot',
      projection_consistency: 'database_snapshot',
    } });
    expect(text).toContain('Capsule sources: one database snapshot.');
    expect(text).toContain('Additional entity-frame reads may be best-effort.');
    expect(text).toContain('Recheck permissions and required revisions');
    expect(text).toContain('Source coverage is incomplete or unknown.');
  });

  it('does not render an unknown context capsule schema', () => {
    const text = formatForLLM('orgx_bootstrap', {
      context_capsule: {
        schema_version: 'orgx.context-capsule/v0',
        capsule_id: 'stale',
      },
    });

    expect(text).not.toContain('Context capsule');
    expect(text).not.toContain('stale');
  });

  it('summarizes orgx_write creates with chainable entity IDs', () => {
    const text = formatForLLM('orgx_write', {
      _v2_tool: 'orgx_write',
      operation: 'create',
      type: 'initiative',
      data: {
        id: 'init-1',
        type: 'initiative',
        title: 'Crane Treasury GTM',
        status: 'active',
      },
    });

    expect(text).toContain('Created initiative');
    expect(text).toContain('id:init-1');
    expect(text).toContain('orgx_inspect type="initiative" id="init-1"');
    expect(text).toContain('orgx_write type="workstream" initiative_id="init-1"');
    expect(text).not.toContain('Result with');
  });

  it('labels idempotent orgx_write replay as reused existing', () => {
    const text = formatForLLM('orgx_write', {
      _v2_tool: 'orgx_write',
      operation: 'create',
      idempotent_replay: true,
      data: {
        id: 'init-existing',
        type: 'initiative',
        title: 'Crane Treasury GTM',
      },
    });

    expect(text).toContain('Reused existing initiative');
    expect(text).toContain('id:init-existing');
  });

  it('summarizes loop receipts with verification status', () => {
    const text = formatForLLM('orgx_submit_receipt', {
      _v2_tool: 'orgx_submit_receipt',
      receipt_id: 'receipt-1',
      summary: 'Batch 1 reply rewrote batch 2.',
      verification_status: 'passed',
      loop_validation: { promotable: true },
    });

    expect(text).toContain('OrgX receipt: Batch 1 reply rewrote batch 2.');
    expect(text).toContain('[passed]');
    expect(text).toContain('id:receipt-1');
    expect(text).toContain('promotable:true');
    expect(text).not.toContain('Result with');
  });
});
