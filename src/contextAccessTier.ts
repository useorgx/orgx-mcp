import { callOrgxApiJson, type OrgxApiEnv } from './orgxApi';

export type HydrationAccessTier = 'free' | 'paid';

export type HydrationAccessContext = {
  tier: HydrationAccessTier;
  plan: string;
};

type CachedHydrationAccessContext = HydrationAccessContext & {
  expiresAt: number;
};

type HydratedEntry = Record<string, unknown>;

const DEFAULT_MAX_CHARS = 20_000;
const MIN_MAX_CHARS = 1_000;
const FREE_TIER_MAX_CHARS = 4_000;
const PAID_TIER_MAX_CHARS = 50_000;
const HYDRATION_ACCESS_CACHE_TTL_MS = 5 * 60 * 1000;
const PAID_PLANS = new Set([
  'starter',
  'team',
  'pro',
  'enterprise',
  'enterprise_plus',
  'enterprise-pro',
]);
const FREE_TIER_HYDRATED_FIELDS = [
  'id',
  'title',
  'name',
  'status',
  'entity_type',
  'artifact_type',
  'artifact_url',
  'external_url',
  '_link',
] as const;
const hydrationAccessContextCache = new Map<
  string,
  CachedHydrationAccessContext
>();

function normalizePlan(plan: unknown): string {
  if (typeof plan !== 'string') return 'free';
  const normalized = plan.trim().toLowerCase();
  return normalized.length > 0 ? normalized : 'free';
}

function isPaidPlan(plan: string) {
  return PAID_PLANS.has(plan);
}

function clampMaxChars(value: number, limit: number) {
  return Math.max(MIN_MAX_CHARS, Math.min(value, limit));
}

function compactHydratedValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const compact: Record<string, unknown> = {};
  for (const key of FREE_TIER_HYDRATED_FIELDS) {
    if (key in record && record[key] != null) {
      compact[key] = record[key];
    }
  }
  return compact;
}

function getCachedHydrationAccessContext(
  userId: string
): HydrationAccessContext | null {
  const cached = hydrationAccessContextCache.get(userId);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    hydrationAccessContextCache.delete(userId);
    return null;
  }
  return {
    tier: cached.tier,
    plan: cached.plan,
  };
}

function setCachedHydrationAccessContext(
  userId: string,
  value: HydrationAccessContext
) {
  hydrationAccessContextCache.set(userId, {
    ...value,
    expiresAt: Date.now() + HYDRATION_ACCESS_CACHE_TTL_MS,
  });
}

export function resetHydrationAccessContextCache() {
  hydrationAccessContextCache.clear();
}

export function resolveHydrationMaxChars(
  requestedMaxChars: number | null | undefined,
  tier: HydrationAccessTier
) {
  const requested =
    typeof requestedMaxChars === 'number' && Number.isFinite(requestedMaxChars)
      ? requestedMaxChars
      : DEFAULT_MAX_CHARS;
  const limit = tier === 'free' ? FREE_TIER_MAX_CHARS : PAID_TIER_MAX_CHARS;
  return clampMaxChars(requested, limit);
}

export function applyHydrationAccessTier(params: {
  hydrated: HydratedEntry[];
  maxChars: number;
  tier: HydrationAccessTier;
  truncated: boolean;
}) {
  const transformed =
    params.tier === 'paid'
      ? params.hydrated
      : params.hydrated.map((entry) => ({
          ...entry,
          hydrated: compactHydratedValue(entry.hydrated),
        }));

  const hydrated: HydratedEntry[] = [];
  let usedChars = 0;
  let truncated = params.truncated;

  for (const entry of transformed) {
    const size = JSON.stringify(entry).length;
    if (usedChars + size > params.maxChars) {
      truncated = true;
      break;
    }
    usedChars += size;
    hydrated.push(entry);
  }

  return { hydrated, truncated, usedChars };
}

export async function resolveHydrationAccessContext(
  env: OrgxApiEnv,
  userId: string
): Promise<HydrationAccessContext> {
  const cached = getCachedHydrationAccessContext(userId);
  if (cached) return cached;

  try {
    const response = await callOrgxApiJson(
      env,
      '/api/billing/usage',
      { method: 'GET' },
      { userId }
    );
    const payload = (await response.json()) as { plan?: unknown };
    const plan = normalizePlan(payload.plan);
    const resolved: HydrationAccessContext = {
      tier: isPaidPlan(plan) ? 'paid' : 'free',
      plan,
    };
    setCachedHydrationAccessContext(userId, resolved);
    return resolved;
  } catch {
    const fallback: HydrationAccessContext = {
      tier: 'free',
      plan: 'free',
    };
    setCachedHydrationAccessContext(userId, fallback);
    return fallback;
  }
}
