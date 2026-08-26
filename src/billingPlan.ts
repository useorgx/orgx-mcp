import { mapPlanToAccountTier, type AccountTier } from './accountTools';
import { callOrgxApiJson, type OrgxApiEnv } from './orgxApi';

export type BillingPlanContext = {
  plan: string;
  tier: AccountTier;
  source: 'api' | 'fallback' | 'stale';
};

const BILLING_PLAN_CACHE_TTL_MS = 5 * 60 * 1000;
const BILLING_PLAN_STALE_IF_ERROR_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BILLING_PLAN_TIMEOUT_MS = 1_000;

const billingPlanCache = new Map<
  string,
  { value: BillingPlanContext; expiresAt: number; staleUntil: number }
>();
const billingPlanInFlight = new Map<string, Promise<BillingPlanContext>>();

export function normalizeBillingPlan(plan: unknown): string {
  if (typeof plan !== 'string') return 'free';
  const normalized = plan.trim().toLowerCase();
  return normalized.length > 0 ? normalized : 'free';
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

function getCachedPlan(
  key: string,
  opts: { allowStale?: boolean } = {}
): BillingPlanContext | null {
  const cached = billingPlanCache.get(key);
  if (!cached) return null;
  const now = Date.now();
  if (cached.expiresAt <= now) {
    if (opts.allowStale && cached.staleUntil > now) {
      return { ...cached.value, source: 'stale' };
    }
    if (cached.staleUntil <= now) {
      billingPlanCache.delete(key);
    }
    return null;
  }
  return cached.value;
}

function getStaleCachedPlan(key: string): BillingPlanContext | null {
  const cached = getCachedPlan(key, { allowStale: true });
  return cached?.source === 'stale' ? cached : null;
}

function setCachedPlan(key: string, value: BillingPlanContext): void {
  const expiresAt = Date.now() + BILLING_PLAN_CACHE_TTL_MS;
  billingPlanCache.set(key, {
    value,
    expiresAt,
    staleUntil: expiresAt + BILLING_PLAN_STALE_IF_ERROR_MS,
  });
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
    const usage = (await response.json()) as { plan?: unknown };
    const plan = normalizeBillingPlan(usage.plan);
    return {
      plan,
      tier: mapPlanToAccountTier(plan),
      source: 'api',
    };
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
    return { plan: 'free', tier: 'free', source: 'fallback' };
  }

  const key = scopedCacheKey(env, normalizedUserId, scope);
  const cached = getCachedPlan(key);
  if (cached) return cached;

  const inFlight = billingPlanInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = fetchBillingPlanContext(env, normalizedUserId, scope)
    .then((value) => {
      setCachedPlan(key, value);
      return value;
    })
    .catch((): BillingPlanContext => {
      const stale = getStaleCachedPlan(key);
      if (stale) return stale;
      return { plan: 'free', tier: 'free', source: 'fallback' };
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
