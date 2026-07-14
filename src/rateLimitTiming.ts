export type RateLimitStrategy =
  | 'preflight_bypass'
  | 'base_allowance'
  | 'free_limit'
  | 'paid_allowance'
  | 'enterprise_bypass';

export interface RateLimitTiming {
  totalMs: number;
  identityMs: number;
  billingMs: number;
  backendMs: number;
  strategy: RateLimitStrategy;
}

export function durationMs(startedAt: number): number {
  return Math.max(0, Number((performance.now() - startedAt).toFixed(2)));
}

export function finalizeRateLimitDecision<
  const T extends { headers: Record<string, string> },
>(
  decision: T,
  params: {
    startedAt: number;
    identityMs: number;
    billingMs: number;
    backendMs: number;
    strategy: RateLimitStrategy;
  }
): T & { timing: RateLimitTiming } {
  const timing = {
    totalMs: durationMs(params.startedAt),
    identityMs: params.identityMs,
    billingMs: params.billingMs,
    backendMs: params.backendMs,
    strategy: params.strategy,
  };
  const serverTiming = [
    `edge_rate_limit;dur=${timing.totalMs}`,
    `rate_limit_backend;dur=${timing.backendMs}`,
    `rate_limit_identity;dur=${timing.identityMs}`,
    `rate_limit_billing;dur=${timing.billingMs}`,
  ].join(', ');

  return {
    ...decision,
    timing,
    headers: {
      ...decision.headers,
      'Server-Timing': serverTiming,
      'X-OrgX-RateLimit-Strategy': timing.strategy,
    },
  };
}
