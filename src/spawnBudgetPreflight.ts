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

  if (estimate.budget_check.within_cap === false) {
    return {
      ok: false,
      message: `Spawn blocked: estimated cost $${estimate.budget_check.estimated_cost_usd?.toFixed(
        4
      )} exceeds cap $${estimate.budget_check.max_cost_usd?.toFixed(4)}.`,
      details: {
        code: 'budget_cap_exceeded',
        budget_preflight: preflight,
      },
    };
  }

  return {
    ok: true,
    preflight,
  };
}
