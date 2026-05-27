import { describe, expect, it } from 'vitest';

import {
  evaluateLoopReliabilityReceipt,
  normalizeLoopValidationRung,
} from '../src/loopReliabilityValidation';

describe('loop reliability receipt validation', () => {
  it('marks a cheapest-valid validation receipt promotable when proof is complete', () => {
    expect(
      evaluateLoopReliabilityReceipt({
        loop_validation: true,
        validation_rung: 'single-domain-fixture',
        artifact_type: 'sales.strategy',
        agent_type: 'sales',
        business_outcome: 'Start founder-led sales with a validated ICP and offer.',
        verification_status: 'passed',
        model_tier: 'standard',
        budget_mode: 'cheapest_valid',
        max_cost_usd: 0.5,
        evidence: {
          links: ['https://useorgx.com/artifacts/sales-strategy'],
        },
      })
    ).toEqual({
      rung: 'single_domain_fixture',
      applies: true,
      promotable: true,
      missing: [],
      warnings: [],
      next_required_action: null,
    });
  });

  it('blocks promotion when validation receipts omit routing, outcome, or verification proof', () => {
    const result = evaluateLoopReliabilityReceipt({
      loop_validation: true,
      validation_rung: 'overnight_canary',
      artifact_type: 'ops.operator_brief',
      agent_type: 'operations',
      evidence: { notes: 'Brief generated but no URL yet.' },
    });

    expect(result.promotable).toBe(false);
    expect(result.missing).toEqual(
      expect.arrayContaining([
        'business_outcome',
        'verification_status',
        'model_tier=standard',
        'budget_mode=cheapest_valid',
      ])
    );
    expect(result.next_required_action).toContain('Add missing loop receipt fields');
  });

  it('warns when calibrated expansion is still pinned to cheapest valid', () => {
    const result = evaluateLoopReliabilityReceipt({
      validation_rung: 'calibrated_auto_route_expansion',
      artifact_type: 'orchestration.next_initiative',
      agent_type: 'orchestrator',
      business_outcome: 'Choose the next company initiative from calibrated evidence.',
      verification_status: 'passed',
      budget_mode: 'cheapest_valid',
      artifact_id: 'artifact_123',
    });

    expect(result.applies).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.promotable).toBe(false);
    expect(result.warnings[0]).toContain('auto-route candidates');
  });

  it('normalizes human rung labels', () => {
    expect(normalizeLoopValidationRung('dry-run spawn')).toBe('dry_run_spawn');
    expect(normalizeLoopValidationRung('overnight_canary')).toBe(
      'overnight_canary'
    );
    expect(normalizeLoopValidationRung('unknown')).toBeNull();
  });
});
