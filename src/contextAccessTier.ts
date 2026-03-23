import { callOrgxApiJson, type OrgxApiEnv } from './orgxApi';

export type HydrationAccessTier = 'free' | 'paid';

export type HydrationAccessContext = {
  tier: HydrationAccessTier;
  plan: string;
};

type HydratedEntry = Record<string, unknown>;

const DEFAULT_MAX_CHARS = 20_000;
const MIN_MAX_CHARS = 1_000;
const FREE_TIER_MAX_CHARS = 4_000;
const PAID_TIER_MAX_CHARS = 50_000;
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
  try {
    const response = await callOrgxApiJson(
      env,
      '/api/billing/usage',
      { method: 'GET' },
      { userId }
    );
    const payload = (await response.json()) as { plan?: unknown };
    const plan = normalizePlan(payload.plan);
    return {
      tier: isPaidPlan(plan) ? 'paid' : 'free',
      plan,
    };
  } catch {
    return {
      tier: 'free',
      plan: 'free',
    };
  }
}
