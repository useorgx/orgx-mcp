import { describe, expect, it } from 'vitest';

import { extractRunCostTelemetry } from '../src/runCostTelemetry';

describe('extractRunCostTelemetry', () => {
  it('returns empty for null/undefined/non-object', () => {
    expect(extractRunCostTelemetry(null)).toEqual({});
    expect(extractRunCostTelemetry(undefined)).toEqual({});
    expect(extractRunCostTelemetry({} as Record<string, unknown>)).toEqual({});
  });

  it('reads snake_case top-level fields', () => {
    expect(
      extractRunCostTelemetry({ tokens_used: 1234, cost_usd: 0.05, estimated_cost_usd: 0.06 })
    ).toEqual({ tokensUsed: 1234, costUsd: 0.05, estimatedCostUsd: 0.06 });
  });

  it('reads camelCase + bare cost aliases', () => {
    expect(extractRunCostTelemetry({ tokensUsed: 10, cost: 0.01 })).toEqual({
      tokensUsed: 10,
      costUsd: 0.01,
    });
  });

  it('falls back to total_tokens and a usage nest', () => {
    expect(
      extractRunCostTelemetry({ usage: { total_tokens: 999, cost_usd: 0.02 } })
    ).toEqual({ tokensUsed: 999, costUsd: 0.02 });
    expect(extractRunCostTelemetry({ total_tokens: 500 })).toEqual({ tokensUsed: 500 });
  });

  it('reads an economics nest for cost', () => {
    expect(
      extractRunCostTelemetry({ economics: { cost_usd: 0.09, estimated_cost_usd: 0.1 } })
    ).toEqual({ costUsd: 0.09, estimatedCostUsd: 0.1 });
  });

  it('ignores non-finite / non-numeric values', () => {
    expect(
      extractRunCostTelemetry({ tokens_used: 'lots', cost_usd: NaN, total_tokens: Infinity })
    ).toEqual({});
  });

  it('omits fields that are absent (no zero-filling)', () => {
    const r = extractRunCostTelemetry({ tokens_used: 42 });
    expect(r).toEqual({ tokensUsed: 42 });
    expect('costUsd' in r).toBe(false);
  });
});
