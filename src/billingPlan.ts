import { mapPlanToAccountTier, type AccountTier } from './accountTools';
import { callOrgxApiJson, type OrgxApiEnv } from './orgxApi';

export type BillingPlanContext = {
  plan: string;
  tier: AccountTier;
  source: 'api' | 'fallback';
};

const BILLING_PLAN_CACHE_TTL_MS = 5 * 60 * 1000;

const billingPlanCache = new Map<
  string,
  { value: BillingPlanContext; expiresAt: number }
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

function getCachedPlan(key: string): BillingPlanContext | null {
  const cached = billingPlanCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    billingPlanCache.delete(key);
    return null;
  }
  return cached.value;
}

function setCachedPlan(key: string, value: BillingPlanContext): void {
  billingPlanCache.set(key, {
    value,
    expiresAt: Date.now() + BILLING_PLAN_CACHE_TTL_MS,
  });
}

async function fetchBillingPlanContext(
  env: OrgxApiEnv,
  userId: string
): Promise<BillingPlanContext> {
  const response = await callOrgxApiJson(
    env,
    '/api/billing/usage',
    { method: 'GET' },
    { userId }
  );
  const usage = (await response.json()) as { plan?: unknown };
  const plan = normalizeBillingPlan(usage.plan);
  return {
    plan,
    tier: mapPlanToAccountTier(plan),
    source: 'api',
  };
}

export async function resolveBillingPlanContext(
  env: OrgxApiEnv,
  userId: string | null | undefined
): Promise<BillingPlanContext> {
  const normalizedUserId = typeof userId === 'string' ? userId.trim() : '';
  if (!normalizedUserId) {
    return { plan: 'free', tier: 'free', source: 'fallback' };
  }

  const key = cacheKey(env, normalizedUserId);
  const cached = getCachedPlan(key);
  if (cached) return cached;

  const inFlight = billingPlanInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = fetchBillingPlanContext(env, normalizedUserId)
    .then((value) => {
      setCachedPlan(key, value);
      return value;
    })
    .catch((): BillingPlanContext => {
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
