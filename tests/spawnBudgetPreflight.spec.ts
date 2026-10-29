import { describe, expect, it } from 'vitest';

import {
  buildSpawnBudgetPreflightArgs,
  buildSpawnGateArgs,
  evaluateSpawnBudgetPreflightResult,
  evaluateSpawnGateResult,
} from '../src/spawnBudgetPreflight';

describe('spawn budget preflight', () => {
  const exactRoute = {
    workspace_id: 'workspace-1',
    model: 'gpt-6-luna',
    provider: 'openai',
    runtime: 'managed_openai',
    max_cost_usd: 1,
  };
  const lunaQuote = {
    ok: true,
    data: {
      tier: 'standard',
      recommended_model: 'gpt-6-luna',
      provider: 'openai',
      estimated_tokens: 50000,
      estimated_cost_usd: 0.02,
    },
  };

  it('carries the accepted exact-model quote into the workspace gate without changing the cap', () => {
    const routeArgs = buildSpawnBudgetPreflightArgs({
      ...exactRoute,
      computed_cost_cents: 0.001,
    });
    expect(routeArgs.runtime).toBe('managed_openai');
    const result = evaluateSpawnBudgetPreflightResult(lunaQuote, routeArgs);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected affordable exact route');
    expect(buildSpawnGateArgs(routeArgs, 'user-1', result.preflight)).toEqual({
      workspace_id: 'workspace-1',
      user_id: 'user-1',
      provider: 'openai',
      tier: 'standard',
      computed_cost_cents: 2,
      max_cost_usd: 1,
    });
  });

  it('blocks an exact route whose server estimate is unavailable instead of substituting a tier', () => {
    const result = evaluateSpawnBudgetPreflightResult({
      ok: true,
      data: { ...lunaQuote.data, estimated_cost_usd: null },
    }, exactRoute);
    expect(result).toMatchObject({ ok: false, details: { code: 'route_estimate_unavailable' } });
    if (!result.ok) expect(result.message).toContain('gpt-6-luna');
  });

  it.each([
    { recommended_model: 'gpt-6-astra' },
    { provider: 'anthropic' },
  ])('refuses a quote for a different requested route: %j', (differentRoute) => {
    expect(evaluateSpawnBudgetPreflightResult({
      ok: true, data: { ...lunaQuote.data, ...differentRoute },
    }, exactRoute)).toMatchObject({ ok: false, details: { code: 'route_estimate_mismatch' } });
  });

  it('retains the hard task ceiling on the same exact route', () => {
    expect(evaluateSpawnBudgetPreflightResult(lunaQuote, {
      ...exactRoute, max_cost_usd: 0.01,
    })).toMatchObject({ ok: false, details: { code: 'budget_cap_exceeded' } });
  });

  it('honors a workspace-cap denial even when the exact-model quote is affordable', () => {
    expect(evaluateSpawnBudgetPreflightResult(lunaQuote, exactRoute).ok).toBe(true);
    expect(evaluateSpawnGateResult({ ok: true, data: {
      allowed: false, blockedReason: 'daily_cap_exceeded',
      estimatedCents: 2, estimateSource: 'computed',
    } })).toMatchObject({ ok: false, details: { code: 'workspace_budget_blocked',
      spawn_gate: { blockedReason: 'daily_cap_exceeded' } } });
  });

  it('retains a conservative fallback when an uncapped auto-route has no computed price', () => {
    const routeArgs = { workspace_id: 'workspace-1', model_tier: 'precision' };
    const result = evaluateSpawnBudgetPreflightResult({ ok: true, data: {} }, routeArgs);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected conservative workspace gate');
    expect(buildSpawnGateArgs(routeArgs, 'user-1', result.preflight)).toEqual({
      workspace_id: 'workspace-1', user_id: 'user-1', tier: 'precision',
    });
  });

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
