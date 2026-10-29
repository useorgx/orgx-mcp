import {
  buildRouteTaskEstimateSummary,
  type RouteTaskEstimateSummary,
} from './routeTaskEstimate';

export type SpawnBudgetPreflight = {
  estimate: RouteTaskEstimateSummary;
  route_task: Record<string, unknown>;
};

export type SpawnBudgetPreflightEvaluation =
  | { ok: true; preflight: SpawnBudgetPreflight }
  | {
      ok: false;
      message: string;
      details: Record<string, unknown>;
    };

function pickString(
  args: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export function buildSpawnBudgetPreflightArgs(
  args: Record<string, unknown>
): Record<string, unknown> {
  const title =
    pickString(args, ['title', 'task', 'name']) ?? pickString(args, ['task_id']);
  const description = pickString(args, [
    'instructions',
    'context',
    'description',
    'task',
  ]);
  const domain =
    pickString(args, ['domain', 'agent_type']) ?? pickString(args, ['agent']);

  const routeArgs: Record<string, unknown> = {
    estimate_only: true,
    entity_type: 'task',
  };

  if (title) routeArgs.title = title;
  if (description) routeArgs.description = description;
  if (domain) routeArgs.domain = domain;

  for (const key of [
    'task_id',
    'initiative_id',
    'workspace_id',
    'command_center_id',
    'model_tier',
    'model',
    'provider',
    'runtime',
    'budget_mode',
    'max_cost_usd',
  ]) {
    if (args[key] !== undefined) routeArgs[key] = args[key];
  }

  return routeArgs;
}

export function evaluateSpawnBudgetPreflightResult(
  result: Record<string, unknown>,
  routeArgs: Record<string, unknown>
): SpawnBudgetPreflightEvaluation {
  if (result.ok === false) {
    return {
      ok: false,
      message:
        typeof result.error === 'string'
          ? `Budget preflight failed: ${result.error}`
          : 'Budget preflight failed before dispatch.',
      details: {
        code: 'budget_preflight_failed',
        route_task: routeArgs,
        result,
      },
    };
  }

  const routeData =
    result.data && typeof result.data === 'object'
      ? (result.data as Record<string, unknown>)
      : result;
  const estimate = buildRouteTaskEstimateSummary(routeData, routeArgs);
  const preflight: SpawnBudgetPreflight = {
    estimate,
    route_task: routeData,
  };

  const requestedModel = pickString(routeArgs, ['model']);
  const requestedProvider = pickString(routeArgs, ['provider']);
  const routeMismatch =
    (requestedModel && estimate.recommended_model !== requestedModel) ||
    (requestedProvider &&
      requestedProvider !== 'auto' &&
      estimate.provider !== requestedProvider);
  if (routeMismatch) {
    return {
      ok: false,
      message: 'Budget preflight could not price the requested route: the returned model or provider differs from the request.',
      details: {
        code: 'route_estimate_mismatch',
        requested_model: requestedModel,
        requested_provider: requestedProvider,
        budget_preflight: preflight,
      },
    };
  }
  if (
    (requestedModel || estimate.budget_check.max_cost_usd !== null) &&
    (estimate.estimated_cost_usd === null || estimate.estimated_cost_usd <= 0)
  ) {
    return {
      ok: false,
      message: `Budget preflight has no positive cost estimate for ${requestedModel ?? 'the selected route'}; dispatch cannot verify its spend cap.`,
      details: {
        code: 'route_estimate_unavailable',
        requested_model: requestedModel,
        requested_provider: requestedProvider,
        budget_preflight: preflight,
      },
    };
  }

  if (estimate.budget_check.within_cap === false) {
    return {
      ok: false,
      message: `Spawn blocked: estimated cost $${estimate.budget_check.estimated_cost_usd?.toFixed(
        4
      )} exceeds cap $${estimate.budget_check.max_cost_usd?.toFixed(4)}.`,
      details: {
        code: 'budget_cap_exceeded',
        // Typed remedy facts (see src/remedyErrors.ts): the cap that blocked
        // dispatch and the estimate it was compared against.
        limit: {
          ...(estimate.budget_check.max_cost_usd !== null && estimate.budget_check.max_cost_usd !== undefined
            ? { max_cost_usd: estimate.budget_check.max_cost_usd } : {}),
          ...(estimate.budget_check.estimated_cost_usd !== null && estimate.budget_check.estimated_cost_usd !== undefined
            ? { estimated_cost_usd: estimate.budget_check.estimated_cost_usd } : {}),
        },
        budget_preflight: preflight,
      },
    };
  }

  return {
    ok: true,
    preflight,
  };
}

// ---------------------------------------------------------------------------
// Workspace-cap enforcement (POST /api/client/spawn-gate).
//
// The route-task preflight above checks the PER-TASK ceiling (max_cost_usd vs
// the estimate). It does NOT check workspace daily/monthly spend caps — those
// require spend-to-date from the orgx DB. /api/client/spawn-gate composes the
// orgx-side enforceBudget primitive and returns a single allow/deny verdict, so
// the policy lives in orgx and this worker stays a thin caller. This is the
// runtime enforcement that closes the residual API-drain shape.
// ---------------------------------------------------------------------------

/**
 * Build the spawn-gate request body from the route args. Returns null when no
 * workspace is resolvable — workspace caps can't be enforced without one, so we
 * skip the call rather than send an unenforceable request.
 */
export function buildSpawnGateArgs(
  routeArgs: Record<string, unknown>,
  userId: string | null,
  preflight: SpawnBudgetPreflight
): Record<string, unknown> | null {
  const workspaceId =
    (typeof routeArgs.workspace_id === 'string' && routeArgs.workspace_id) ||
    (typeof routeArgs.command_center_id === 'string' &&
      routeArgs.command_center_id) ||
    null;
  if (!workspaceId) return null;

  const body: Record<string, unknown> = {
    workspace_id: workspaceId,
    user_id: userId,
  };
  for (const [src, dest] of [
    ['model_tier', 'tier'],
    ['max_cost_usd', 'max_cost_usd'],
    ['provider', 'provider'],
    ['domain', 'agent_id'],
  ] as const) {
    if (routeArgs[src] !== undefined) body[dest] = routeArgs[src];
  }
  // Carry the server's accepted quote across both gates. Never copy a caller's
  // computed_cost_cents: dropping this quote used to reprice an exact cheap
  // model as the unknown-tier precision fallback ($8).
  const quote = preflight.estimate;
  const costCents =
    quote.estimated_cost_usd === null
      ? null
      : Math.ceil(quote.estimated_cost_usd * 100);
  if (costCents !== null && Number.isSafeInteger(costCents) && costCents > 0) {
    body.computed_cost_cents = costCents;
  }
  if (quote.recommended_tier) body.tier = quote.recommended_tier;
  if (quote.provider) body.provider = quote.provider;
  return body;
}

export type SpawnGateEvaluation =
  | { ok: true }
  | { ok: false; message: string; details: Record<string, unknown> };

/**
 * Map a spawn-gate response to a verdict. Blocks only on an explicit
 * `allowed === false`; a malformed/own-shape response is treated as
 * non-blocking (the per-task ceiling already gated upstream, and the endpoint
 * itself fails closed when its budget store is unavailable). On `ok` the caller
 * keeps the original route-task preflight (with the real estimate).
 */
export function evaluateSpawnGateResult(
  result: Record<string, unknown>
): SpawnGateEvaluation {
  const decision = (
    result.data && typeof result.data === 'object' ? result.data : result
  ) as Record<string, unknown>;

  if (decision.allowed === false) {
    const reason =
      typeof decision.blockedReason === 'string'
        ? decision.blockedReason
        : 'cap_exceeded';
    return {
      ok: false,
      message: `Spawn blocked by workspace budget cap (${reason}).`,
      details: {
        code: 'workspace_budget_blocked',
        ...spawnGateRemedyFacts(decision),
        spawn_gate: decision,
      },
    };
  }

  return { ok: true };
}

/** Lift the cap and reset timing a spawn-gate denial names into typed remedy facts. */
function spawnGateRemedyFacts(decision: Record<string, unknown>): Record<string, unknown> {
  const limit = decision.limit ?? decision.cap ?? decision.capUsd ?? decision.cap_usd;
  const retryAfter = decision.retry_after_seconds ?? decision.retryAfterSeconds;
  return {
    ...(limit !== undefined && limit !== null ? { limit } : {}),
    ...(typeof retryAfter === 'number' && Number.isFinite(retryAfter) ? { retry_after_seconds: retryAfter } : {}),
  };
}
