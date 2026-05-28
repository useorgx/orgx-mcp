import { describe, expect, it } from 'vitest';

import {
  buildSpawnBudgetPreflightArgs,
  evaluateSpawnBudgetPreflightResult,
} from '../src/spawnBudgetPreflight';

describe('spawn budget preflight', () => {
  it('builds route-task estimate input without forcing explicit routing controls', () => {
    expect(
      buildSpawnBudgetPreflightArgs({
        agent: 'engineering-agent',
        task: 'Open a PR or return a structured blocker.',
        context: 'Use the repo canary.',
      })
    ).toEqual({
      estimate_only: true,
      entity_type: 'task',
      title: 'Open a PR or return a structured blocker.',
      description: 'Use the repo canary.',
      domain: 'engineering-agent',
    });
  });

  it('threads validation routing controls into the preflight estimate', () => {
    expect(
      buildSpawnBudgetPreflightArgs({
        agent_type: 'sales',
        title: 'Draft the founder-led sales strategy',
        instructions: 'Return ICP, offer, sequence, objections, and send plan.',
        model_tier: 'standard',
        budget_mode: 'cheapest_valid',
        provider: 'auto',
        max_cost_usd: 0.25,
      })
    ).toMatchObject({
      estimate_only: true,
      entity_type: 'task',
      title: 'Draft the founder-led sales strategy',
      description: 'Return ICP, offer, sequence, objections, and send plan.',
      domain: 'sales',
      model_tier: 'standard',
      budget_mode: 'cheapest_valid',
      provider: 'auto',
      max_cost_usd: 0.25,
    });
  });

  it('blocks dispatch when the estimate exceeds an explicit cap', () => {
    const routeArgs = {
      title: 'Run the canary',
      max_cost_usd: 0.1,
    };
    const result = evaluateSpawnBudgetPreflightResult(
      {
        ok: true,
        data: {
          modelTier: 'precision',
          recommendedModel: 'gpt-5.4',
          estimatedCostUsd: 0.42,
        },
      },
      routeArgs
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected budget block');
    expect(result.details.code).toBe('budget_cap_exceeded');
    expect(result.message).toContain('exceeds cap $0.1000');
  });

  it('allows dispatch when the preflight estimate fits the cap', () => {
    const result = evaluateSpawnBudgetPreflightResult(
      {
        ok: true,
        data: {
          modelTier: 'standard',
          recommendedModel: 'gpt-5.4-nano',
          modelProvider: 'openai',
          estimatedCostUsd: 0.08,
        },
      },
      { max_cost_usd: 0.1 }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected allowed preflight');
    expect(result.preflight.estimate.budget_check.within_cap).toBe(true);
  });
});
