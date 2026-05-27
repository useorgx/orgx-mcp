export type RouteTaskBudgetCheck = {
  max_cost_usd: number | null;
  estimated_cost_usd: number | null;
  within_cap: boolean | null;
};

export type RouteTaskEstimateSummary = {
  recommended_tier: string | null;
  recommended_model: string | null;
  provider: string | null;
  estimated_tokens: number | null;
  estimated_cost_usd: number | null;
  budget_check: RouteTaskBudgetCheck;
  candidate_count: number;
  candidate_routes: unknown[];
};

function readString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function readCandidateRoutes(record: Record<string, unknown>): unknown[] {
  for (const key of [
    'candidate_routes',
    'candidateRoutes',
    'cost_frontier',
    'costFrontier',
    'routes',
  ]) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

export function buildRouteTaskEstimateSummary(
  data: Record<string, unknown>,
  request: Record<string, unknown> = {}
): RouteTaskEstimateSummary {
  const estimatedCostUsd = readNumber(data, [
    'estimated_cost_usd',
    'estimatedCostUsd',
    'estimated_cost',
    'estimatedCost',
    'cost_usd',
    'costUsd',
  ]);
  const maxCostUsd =
    readNumber(request, ['max_cost_usd', 'maxCostUsd']) ??
    readNumber(data, ['max_cost_usd', 'maxCostUsd']);
  const candidateRoutes = readCandidateRoutes(data);

  return {
    recommended_tier: readString(data, [
      'tier',
      'modelTier',
      'model_tier',
      'recommended_tier',
      'recommendedTier',
    ]),
    recommended_model: readString(data, [
      'model',
      'model_id',
      'modelId',
      'recommended_model',
      'recommendedModel',
    ]),
    provider: readString(data, ['provider', 'model_provider', 'modelProvider']),
    estimated_tokens: readNumber(data, [
      'estimated_tokens',
      'estimatedTokens',
      'expected_tokens',
      'expectedTokens',
      'tokens',
    ]),
    estimated_cost_usd: estimatedCostUsd,
    budget_check: {
      max_cost_usd: maxCostUsd,
      estimated_cost_usd: estimatedCostUsd,
      within_cap:
        maxCostUsd === null || estimatedCostUsd === null
          ? null
          : estimatedCostUsd <= maxCostUsd,
    },
    candidate_count: candidateRoutes.length,
    candidate_routes: candidateRoutes,
  };
}

export function formatRouteTaskEstimateSummary(
  summary: RouteTaskEstimateSummary
): string {
  const parts = ['Task route estimate'];
  if (summary.recommended_tier) parts.push(`tier: ${summary.recommended_tier}`);
  if (summary.recommended_model) parts.push(`model: ${summary.recommended_model}`);
  if (summary.estimated_cost_usd !== null) {
    parts.push(`est. cost: $${summary.estimated_cost_usd.toFixed(4)}`);
  }
  if (summary.budget_check.max_cost_usd !== null) {
    parts.push(
      summary.budget_check.within_cap === false
        ? `over cap $${summary.budget_check.max_cost_usd.toFixed(4)}`
        : `within cap $${summary.budget_check.max_cost_usd.toFixed(4)}`
    );
  }
  if (summary.candidate_count > 0) {
    parts.push(`${summary.candidate_count} candidate route(s)`);
  }
  return parts.join(' · ');
}
