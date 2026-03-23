import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { callOrgxApiJson } from './orgxApi';

type BillingTier = 'free' | 'pro' | 'enterprise';
type LimitSource = 'upstash' | 'memory' | 'bypass';

interface RateLimitEnv {
  ORGX_API_URL: string;
  ORGX_SERVICE_KEY: string;
  OAUTH_PROVIDER?: OAuthHelpers;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
}

interface UsageResponse {
  plan?: unknown;
}

export interface RateLimitDecision {
  allowed: boolean;
  tier: BillingTier;
  headers: Record<string, string>;
  source: LimitSource;
  retryAfterSeconds?: number;
}

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const TIER_LIMITS: Record<Exclude<BillingTier, 'enterprise'>, number> = {
  free: 100,
  pro: 1000,
};
const TIER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const tierCache = new Map<
  string,
  { tier: BillingTier; plan: string; expiresAt: number }
>();
const memoryBuckets = new Map<string, number[]>();

function normalizePlanToTier(plan: string | null | undefined): BillingTier {
  const normalized = (plan ?? 'free').trim().toLowerCase();
  if (
    normalized === 'enterprise' ||
    normalized === 'enterprise_plus' ||
    normalized === 'enterprise-pro'
  ) {
    return 'enterprise';
  }
  if (
    normalized === 'pro' ||
    normalized === 'team' ||
    normalized === 'starter' ||
    normalized === 'growth' ||
    normalized === 'scale'
  ) {
    return 'pro';
  }
  return 'free';
}

function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  if (!header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

function hashToken(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

function buildSubjectKey(request: Request, token: string | null, userId: string | null): string {
  if (token) return `token:${hashToken(token)}`;
  if (userId) return `user:${userId}`;
  const ip =
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'anonymous';
  return `ip:${ip}`;
}

async function resolveUserIdFromToken(
  token: string | null,
  env: RateLimitEnv
): Promise<string | null> {
  if (!token || !env.OAUTH_PROVIDER) return null;
  try {
    const tokenData = await env.OAUTH_PROVIDER.unwrapToken<{
      userId?: string;
      grant?: { props?: { userId?: string } };
    }>(token);
    return tokenData?.grant?.props?.userId ?? tokenData?.userId ?? null;
  } catch {
    return null;
  }
}

async function resolveTier(
  env: RateLimitEnv,
  userId: string | null
): Promise<{ tier: BillingTier; plan: string }> {
  if (!userId) return { tier: 'free', plan: 'free' };

  const cached = tierCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return { tier: cached.tier, plan: cached.plan };
  }

  try {
    const response = await callOrgxApiJson(
      env,
      '/api/billing/usage',
      { method: 'GET' },
      { userId }
    );
    const data = (await response.json()) as UsageResponse;
    const plan =
      typeof data.plan === 'string' && data.plan.trim().length > 0
        ? data.plan.trim().toLowerCase()
        : 'free';
    const tier = normalizePlanToTier(plan);
    tierCache.set(userId, { tier, plan, expiresAt: Date.now() + TIER_CACHE_TTL_MS });
    return { tier, plan };
  } catch {
    return { tier: 'free', plan: 'free' };
  }
}

function buildRateHeaders(params: {
  tier: BillingTier;
  limit: number | null;
  remaining: number | null;
  resetAtSeconds: number;
  source: LimitSource;
}): Record<string, string> {
  return {
    'X-RateLimit-Tier': params.tier,
    'X-RateLimit-Limit':
      params.limit === null ? 'unlimited' : String(params.limit),
    'X-RateLimit-Remaining':
      params.remaining === null ? 'unlimited' : String(Math.max(0, params.remaining)),
    'X-RateLimit-Reset': String(params.resetAtSeconds),
    'X-RateLimit-Source': params.source,
  };
}

async function runUpstashPipeline(
  env: RateLimitEnv,
  commands: Array<Array<string | number>>
): Promise<Array<{ result?: unknown }>> {
  const url = env.UPSTASH_REDIS_REST_URL?.trim();
  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) {
    throw new Error('upstash-not-configured');
  }

  const endpoint = `${url.replace(/\/+$/, '')}/pipeline`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`upstash-pipeline-${response.status}:${text}`);
  }

  return (await response.json()) as Array<{ result?: unknown }>;
}

async function checkWithUpstash(params: {
  env: RateLimitEnv;
  key: string;
  limit: number;
  nowMs: number;
}): Promise<{
  allowed: boolean;
  remaining: number;
  resetAtSeconds: number;
}> {
  const { env, key, limit, nowMs } = params;
  const startMs = nowMs - WINDOW_MS;
  const member = `${nowMs}-${Math.random().toString(36).slice(2, 10)}`;

  const results = await runUpstashPipeline(env, [
    ['ZREMRANGEBYSCORE', key, '-inf', startMs],
    ['ZADD', key, nowMs, member],
    ['ZCARD', key],
    ['PEXPIRE', key, WINDOW_MS],
  ]);

  const count = Number(results?.[2]?.result ?? 0);
  if (!Number.isFinite(count)) {
    throw new Error('upstash-invalid-count');
  }

  const allowed = count <= limit;
  const remaining = Math.max(0, limit - count);
  return {
    allowed,
    remaining,
    resetAtSeconds: Math.floor((nowMs + WINDOW_MS) / 1000),
  };
}

function checkWithMemory(params: {
  key: string;
  limit: number;
  nowMs: number;
}): {
  allowed: boolean;
  remaining: number;
  resetAtSeconds: number;
} {
  const { key, limit, nowMs } = params;
  const startMs = nowMs - WINDOW_MS;
  const bucket = memoryBuckets.get(key) ?? [];
  const next = bucket.filter((ts) => ts > startMs);
  next.push(nowMs);
  memoryBuckets.set(key, next);
  const count = next.length;
  const allowed = count <= limit;
  const remaining = Math.max(0, limit - count);
  return {
    allowed,
    remaining,
    resetAtSeconds: Math.floor((nowMs + WINDOW_MS) / 1000),
  };
}

export async function checkEdgeRateLimit(
  request: Request,
  env: RateLimitEnv
): Promise<RateLimitDecision> {
  if (request.method === 'OPTIONS') {
    return {
      allowed: true,
      tier: 'free',
      source: 'bypass',
      headers: {},
    };
  }

  const token = extractBearerToken(request);
  const userId = await resolveUserIdFromToken(token, env);
  const { tier } = await resolveTier(env, userId);

  if (tier === 'enterprise') {
    return {
      allowed: true,
      tier,
      source: 'bypass',
      headers: buildRateHeaders({
        tier,
        limit: null,
        remaining: null,
        resetAtSeconds: Math.floor(Date.now() / 1000) + 3600,
        source: 'bypass',
      }),
    };
  }

  const limit = TIER_LIMITS[tier];
  const nowMs = Date.now();
  const bucketKey = buildSubjectKey(request, token, userId);
  const redisKey = `mcp:rate:${tier}:${bucketKey}`;

  try {
    const upstash = await checkWithUpstash({
      env,
      key: redisKey,
      limit,
      nowMs,
    });
    return {
      allowed: upstash.allowed,
      tier,
      source: 'upstash',
      retryAfterSeconds: upstash.allowed
        ? undefined
        : Math.max(1, upstash.resetAtSeconds - Math.floor(nowMs / 1000)),
      headers: buildRateHeaders({
        tier,
        limit,
        remaining: upstash.remaining,
        resetAtSeconds: upstash.resetAtSeconds,
        source: 'upstash',
      }),
    };
  } catch {
    const memory = checkWithMemory({ key: redisKey, limit, nowMs });
    return {
      allowed: memory.allowed,
      tier,
      source: 'memory',
      retryAfterSeconds: memory.allowed
        ? undefined
        : Math.max(1, memory.resetAtSeconds - Math.floor(nowMs / 1000)),
      headers: buildRateHeaders({
        tier,
        limit,
        remaining: memory.remaining,
        resetAtSeconds: memory.resetAtSeconds,
        source: 'memory',
      }),
    };
  }
}
