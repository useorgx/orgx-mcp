/**
 * Per-run token/cost telemetry extraction (A6/A7).
 *
 * The MCP worker recorded latency for every tool invocation but never the
 * actual token spend or cost of an agent run — so the cost dashboards had only
 * estimates, never realized spend. This pulls realized tokens/cost out of a
 * tool-execute response (whatever shape the backend returns it in) so they can
 * ride the existing telemetry event. Pure and defensive: unknown shapes yield
 * an empty result, never a throw.
 */

export interface RunCostTelemetry {
  tokensUsed?: number;
  costUsd?: number;
  estimatedCostUsd?: number;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * Extract realized token/cost telemetry from a tool-execute response `data`
 * object, tolerant of the common field names and a `usage` / `economics` nest.
 */
export function extractRunCostTelemetry(
  data: Record<string, unknown> | null | undefined
): RunCostTelemetry {
  const d = asRecord(data);
  const usage = asRecord(d.usage);
  const economics = asRecord(d.economics);

  const tokensUsed =
    num(d.tokens_used) ??
    num(d.total_tokens) ??
    num(d.tokensUsed) ??
    num(usage.total_tokens) ??
    num(usage.tokens);

  const costUsd =
    num(d.cost_usd) ??
    num(d.costUsd) ??
    num(d.cost) ??
    num(economics.cost_usd) ??
    num(usage.cost_usd) ??
    num(usage.cost);

  const estimatedCostUsd =
    num(d.estimated_cost_usd) ??
    num(d.estimatedCostUsd) ??
    num(economics.estimated_cost_usd);

  const result: RunCostTelemetry = {};
  if (tokensUsed !== undefined) result.tokensUsed = tokensUsed;
  if (costUsd !== undefined) result.costUsd = costUsd;
  if (estimatedCostUsd !== undefined) result.estimatedCostUsd = estimatedCostUsd;
  return result;
}
