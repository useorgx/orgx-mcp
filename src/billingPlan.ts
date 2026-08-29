import { mapPlanToAccountTier, type AccountTier } from './accountTools';
import { callOrgxApiJson, type OrgxApiEnv } from './orgxApi';

export type BillingPlanContext = {
  plan: string;
  tier: AccountTier;
  available: boolean;
  source: 'api' | 'cache' | 'unavailable';
  origin: string | null;
  reason?: BillingPlanUnavailableReason;
  retryable?: boolean;
};

export type BillingPlanUnavailableReason =
  | 'identity_missing'
  | 'timeout'
  | 'invalid_response'
  | 'upstream_error';

const BILLING_PLAN_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_BILLING_PLAN_TIMEOUT_MS = 5_000;

const billingPlanCache = new Map<
  string,
  { value: BillingPlanContext; expiresAt: number }
>();
const billingPlanInFlight = new Map<string, Promise<BillingPlanContext>>();

const KNOWN_BILLING_PLANS = new Set([
  'free',
  'starter',
  'pro',
  'team',
  'growth',
  'scale',
  'enterprise',
  'enterprise_plus',
  'enterprise-pro',
]);

export function normalizeBillingPlan(plan: unknown): string | null {
  if (typeof plan !== 'string') return null;
  const normalized = plan.trim().toLowerCase();
  return KNOWN_BILLING_PLANS.has(normalized) ? normalized : null;
}

function cacheKey(env: Pick<OrgxApiEnv, 'ORGX_API_URL'>, userId: string): string {
  return `${env.ORGX_API_URL.trim()}::${userId}`;
}

export type BillingPlanScope = {
  userEmail?: string | null;
  orgxUserId?: string | null;
  workspaceId?: string | null;
};

function scopedCacheKey(
  env: Pick<OrgxApiEnv, 'ORGX_API_URL'>,
  userId: string,
  scope: BillingPlanScope
): string {
  return [
    cacheKey(env, userId),
    scope.orgxUserId?.trim() ?? '',
    scope.userEmail?.trim().toLowerCase() ?? '',
    scope.workspaceId?.trim() ?? '',
  ].join('::');
}

function getCachedPlan(key: string): BillingPlanContext | null {
  const cached = billingPlanCache.get(key);
  if (!cached) return null;
  const now = Date.now();
  if (cached.expiresAt <= now) {
    billingPlanCache.delete(key);
    return null;
  }
  return { ...cached.value, source: 'cache' };
}

function setCachedPlan(key: string, value: BillingPlanContext): void {
  const expiresAt = Date.now() + BILLING_PLAN_CACHE_TTL_MS;
  billingPlanCache.set(key, {
    value,
    expiresAt,
  });
}

function unavailableBillingPlan(
  reason: BillingPlanUnavailableReason,
  origin: string | null = null
): BillingPlanContext {
  return {
    plan: 'unknown',
    tier: 'free',
    available: false,
    source: 'unavailable',
    origin,
    reason,
    retryable: true,
  };
}

function classifyBillingPlanError(
  error: unknown,
  signal: AbortSignal
): BillingPlanUnavailableReason {
  if (
    signal.aborted ||
    (error instanceof DOMException && error.name === 'AbortError')
  ) {
    return 'timeout';
  }
  if (error instanceof SyntaxError) return 'invalid_response';
  return 'upstream_error';
}

async function fetchBillingPlanContext(
  env: OrgxApiEnv,
  userId: string,
  scope: BillingPlanScope
): Promise<BillingPlanContext> {
  const configuredTimeoutMs = Number(env.ORGX_BILLING_PLAN_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
      ? Math.floor(configuredTimeoutMs)
      : DEFAULT_BILLING_PLAN_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort('billing plan lookup deadline exceeded'),
    timeoutMs
  );

  try {
    const workspaceId = scope.workspaceId?.trim();
    const path = workspaceId
      ? `/api/billing/usage?workspace_id=${encodeURIComponent(workspaceId)}`
      : '/api/billing/usage';
    const response = await callOrgxApiJson(
      env,
      path,
      { method: 'GET', signal: controller.signal },
      {
        userId,
        userEmail: scope.userEmail,
        orgxUserId: scope.orgxUserId,
      }
    );
    let usage: { plan?: unknown };
    try {
      usage = (await response.json()) as { plan?: unknown };
    } catch {
      return unavailableBillingPlan(
        'invalid_response',
        response.headers?.get?.('x-orgx-upstream-origin') ?? null
      );
    }
    const plan = normalizeBillingPlan(usage.plan);
    const origin = response.headers?.get?.('x-orgx-upstream-origin') ?? null;
    if (!plan) return unavailableBillingPlan('invalid_response', origin);
    return {
      plan,
      tier: mapPlanToAccountTier(plan),
      available: true,
      source: 'api',
      origin,
    };
  } catch (error) {
    return unavailableBillingPlan(
      classifyBillingPlanError(error, controller.signal)
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveBillingPlanContext(
  env: OrgxApiEnv,
  userId: string | null | undefined,
  scope: BillingPlanScope = {}
): Promise<BillingPlanContext> {
  const normalizedUserId = typeof userId === 'string' ? userId.trim() : '';
  if (!normalizedUserId) {
    return unavailableBillingPlan('identity_missing');
  }

  const key = scopedCacheKey(env, normalizedUserId, scope);
  const cached = getCachedPlan(key);
  if (cached) return cached;

  const inFlight = billingPlanInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = fetchBillingPlanContext(env, normalizedUserId, scope)
    .then((value) => {
      if (value.available && value.source === 'api') setCachedPlan(key, value);
      return value;
    })
    .catch((error): BillingPlanContext => {
      return unavailableBillingPlan(
        error instanceof SyntaxError ? 'invalid_response' : 'upstream_error'
      );
    })
    .finally(() => {
      billingPlanInFlight.delete(key);
    });

  billingPlanInFlight.set(key, promise);
  return promise;
}

/**
 * @internal test helper
 */
export function resetBillingPlanCacheForTests(): void {
  billingPlanCache.clear();
  billingPlanInFlight.clear();
}
