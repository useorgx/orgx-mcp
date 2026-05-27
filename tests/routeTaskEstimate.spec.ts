import { describe, expect, it } from 'vitest';

import {
  buildRouteTaskEstimateSummary,
  formatRouteTaskEstimateSummary,
} from '../src/routeTaskEstimate';

describe('route task estimate summary', () => {
  it('normalizes backend estimate fields and checks the budget cap', () => {
    const summary = buildRouteTaskEstimateSummary(
      {
        modelTier: 'standard',
        recommendedModel: 'gpt-5.4-nano',
        modelProvider: 'openai',
        estimatedTokens: 4200,
        estimatedCostUsd: 0.084,
        candidateRoutes: [
          { model: 'gpt-5.4-nano', cost_usd: 0.084 },
          { model: 'gpt-5.4', cost_usd: 0.49 },
        ],
      },
      { max_cost_usd: 0.1 }
    );

    expect(summary).toEqual({
      recommended_tier: 'standard',
      recommended_model: 'gpt-5.4-nano',
      provider: 'openai',
      estimated_tokens: 4200,
      estimated_cost_usd: 0.084,
      budget_check: {
        max_cost_usd: 0.1,
        estimated_cost_usd: 0.084,
        within_cap: true,
      },
      candidate_count: 2,
      candidate_routes: [
        { model: 'gpt-5.4-nano', cost_usd: 0.084 },
        { model: 'gpt-5.4', cost_usd: 0.49 },
      ],
    });
  });

  it('flags estimates above cap without inventing missing cost data', () => {
    const summary = buildRouteTaskEstimateSummary(
      {
        tier: 'precision',
        estimated_cost_usd: 1.25,
      },
      { maxCostUsd: 0.5 }
    );

    expect(summary.budget_check).toEqual({
      max_cost_usd: 0.5,
      estimated_cost_usd: 1.25,
      within_cap: false,
    });
    expect(formatRouteTaskEstimateSummary(summary)).toContain('over cap $0.5000');
  });

  it('leaves budget fit unknown when the backend has no estimate', () => {
    const summary = buildRouteTaskEstimateSummary({ tier: 'balanced' }, {});

    expect(summary.estimated_cost_usd).toBeNull();
    expect(summary.budget_check.within_cap).toBeNull();
    expect(formatRouteTaskEstimateSummary(summary)).toBe(
      'Task route estimate · tier: balanced'
    );
  });
});
