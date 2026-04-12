import { describe, expect, it } from 'vitest';

import {
  AUTONOMOUS_SESSION_BUDGET_LIMITS,
  autonomousSessionInputSchema,
  normalizeAutonomousSessionArgs,
} from '../src/autonomousSessionBudget';

describe('autonomous session budget guardrails', () => {
  const workspace_id = 'workspace-123';

  it('applies conservative defaults when optional caps are omitted', () => {
    const result = normalizeAutonomousSessionArgs({ workspace_id });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected valid defaults');

    expect(result.payload).toEqual({
      workspace_id,
      session_type: 'manual',
      max_cost_usd: AUTONOMOUS_SESSION_BUDGET_LIMITS.defaultMaxCostUsd,
      max_receipts: AUTONOMOUS_SESSION_BUDGET_LIMITS.defaultMaxReceipts,
      allowed_trust_levels:
        AUTONOMOUS_SESSION_BUDGET_LIMITS.defaultAllowedTrustLevels,
    });
  });

  it('allows low-budget read-only and draft dry runs', () => {
    const result = normalizeAutonomousSessionArgs({
      workspace_id,
      session_type: 'overnight',
      max_cost_usd: 0.5,
      max_receipts: 10,
      allowed_trust_levels: ['read_only', 'draft'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected low-budget settings to pass');

    expect(result.payload).toMatchObject({
      workspace_id,
      session_type: 'overnight',
      max_cost_usd: 0.5,
      max_receipts: 10,
      allowed_trust_levels: ['read_only', 'draft'],
    });
  });

  it('deduplicates allowed trust levels before forwarding upstream', () => {
    const result = normalizeAutonomousSessionArgs({
      workspace_id,
      allowed_trust_levels: ['read_only', 'read_only', 'draft'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected duplicate trust levels to pass');
    expect(result.payload.allowed_trust_levels).toEqual(['read_only', 'draft']);
  });

  it('rejects budgets over the MCP hard cost cap', () => {
    const result = normalizeAutonomousSessionArgs({
      workspace_id,
      max_cost_usd: AUTONOMOUS_SESSION_BUDGET_LIMITS.absoluteMaxCostUsd + 0.01,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected cost cap rejection');

    expect(result.error).toMatchObject({
      code: 'budget_cap_exceeded',
      status: 400,
    });
    expect(result.error.message).toContain('max_cost_usd must be <=');
  });

  it('rejects receipt counts over the MCP hard cap', () => {
    const result = normalizeAutonomousSessionArgs({
      workspace_id,
      max_receipts:
        AUTONOMOUS_SESSION_BUDGET_LIMITS.absoluteMaxReceipts + 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected receipt cap rejection');

    expect(result.error).toMatchObject({
      code: 'budget_cap_exceeded',
      status: 400,
    });
    expect(result.error.message).toContain('max_receipts must be <=');
  });

  it('rejects empty or unknown trust-level allow lists', () => {
    const empty = normalizeAutonomousSessionArgs({
      workspace_id,
      allowed_trust_levels: [],
    });
    const unknown = normalizeAutonomousSessionArgs({
      workspace_id,
      allowed_trust_levels: ['root'],
    });

    expect(empty.ok).toBe(false);
    expect(unknown.ok).toBe(false);

    if (empty.ok || unknown.ok) {
      throw new Error('expected invalid trust levels to fail');
    }
    expect(empty.error.code).toBe('invalid_autonomous_session_budget');
    expect(unknown.error.code).toBe('invalid_autonomous_session_budget');
  });

  it('keeps schema parsing aligned with the runtime hard caps', () => {
    expect(() =>
      autonomousSessionInputSchema.parse({
        workspace_id,
        max_cost_usd:
          AUTONOMOUS_SESSION_BUDGET_LIMITS.absoluteMaxCostUsd + 1,
      })
    ).toThrow();
    expect(() =>
      autonomousSessionInputSchema.parse({
        workspace_id,
        max_receipts:
          AUTONOMOUS_SESSION_BUDGET_LIMITS.absoluteMaxReceipts + 1,
      })
    ).toThrow();
  });
});
