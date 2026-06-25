import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import {
  resetBillingPlanCacheForTests,
  resolveBillingPlanContext,
} from './billingPlan';

type BillingTier = 'free' | 'pro' | 'enterprise';
type LimitSource = 'upstash' | 'memory' | 'bypass';

interface RateLimitEnv {
  ORGX_API_URL: string;
  ORGX_SERVICE_KEY: string;
  OAUTH_PROVIDER?: OAuthHelpers;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
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
const TOKEN_USER_CACHE_TTL_MS = 60 * 1000; // 1 minute
const UPSTASH_PIPELINE_TIMEOUT_MS = 750;

const tokenUserCache = new Map<
  string,
  { userId: string | null; expiresAt: number }
>();
const tokenUserInFlight = new Map<string, Promise<string | null>>();
const memoryBuckets = new Map<string, number[]>();

export function __resetEdgeRateLimitStateForTests() {
  resetBillingPlanCacheForTests();
  tokenUserCache.clear();
  tokenUserInFlight.clear();
  memoryBuckets.clear();
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
  const oauthProvider = env.OAUTH_PROVIDER;
  const cacheKey = hashToken(token);
  const cached = tokenUserCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.userId;
  }

  const inFlight = tokenUserInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const promise = (async () => {
    try {
      const tokenData = await oauthProvider.unwrapToken<{
        userId?: string;
        grant?: { props?: { userId?: string } };
      }>(token);
      const userId =
        tokenData?.grant?.props?.userId ?? tokenData?.userId ?? null;
      tokenUserCache.set(cacheKey, {
        userId,
        expiresAt: Date.now() + TOKEN_USER_CACHE_TTL_MS,
      });
      return userId;
    } catch {
      tokenUserCache.set(cacheKey, {
        userId: null,
        expiresAt: Date.now() + TOKEN_USER_CACHE_TTL_MS,
      });
      return null;
    } finally {
      tokenUserInFlight.delete(cacheKey);
    }
  })();

  tokenUserInFlight.set(cacheKey, promise);
  return promise;
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

function resetAtSecondsFromOldest(oldestMs: number | null, nowMs: number): number {
  const resetAtMs = oldestMs === null ? nowMs + WINDOW_MS : oldestMs + WINDOW_MS;
  return Math.floor(resetAtMs / 1000);
}

function parseUpstashCount(value: unknown): number {
  const count = Number(value ?? 0);
  if (!Number.isFinite(count)) {
    throw new Error('upstash-invalid-count');
  }
  return count;
}

function parseUpstashOldestMs(value: unknown): number | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const score = Number(value[1]);
  return Number.isFinite(score) ? score : null;
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
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort('upstash pipeline timeout'),
    UPSTASH_PIPELINE_TIMEOUT_MS
  );
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

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
  const windowResults = await runUpstashPipeline(env, [
    ['ZREMRANGEBYSCORE', key, '-inf', startMs],
    ['ZCARD', key],
    ['ZRANGE', key, 0, 0, 'WITHSCORES'],
  ]);

  const count = parseUpstashCount(windowResults?.[1]?.result);
  const oldestMs = parseUpstashOldestMs(windowResults?.[2]?.result);

  if (count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      resetAtSeconds: resetAtSecondsFromOldest(oldestMs, nowMs),
    };
  }

  const member = `${nowMs}-${Math.random().toString(36).slice(2, 10)}`;
  await runUpstashPipeline(env, [
    ['ZADD', key, nowMs, member],
    ['PEXPIRE', key, WINDOW_MS],
  ]);

  const nextCount = count + 1;
  return {
    allowed: true,
    remaining: Math.max(0, limit - nextCount),
    resetAtSeconds: resetAtSecondsFromOldest(oldestMs ?? nowMs, nowMs),
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
  const oldestMs = next.length > 0 ? next[0] : null;

  if (next.length >= limit) {
    memoryBuckets.set(key, next);
    return {
      allowed: false,
      remaining: 0,
      resetAtSeconds: resetAtSecondsFromOldest(oldestMs, nowMs),
    };
  }

  next.push(nowMs);
  memoryBuckets.set(key, next);
  const count = next.length;
  return {
    allowed: true,
    remaining: Math.max(0, limit - count),
    resetAtSeconds: resetAtSecondsFromOldest(oldestMs ?? nowMs, nowMs),
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
  const { tier } = await resolveBillingPlanContext(env, userId);

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
  const hasUpstash =
    Boolean(env.UPSTASH_REDIS_REST_URL?.trim()) &&
    Boolean(env.UPSTASH_REDIS_REST_TOKEN?.trim());

  if (hasUpstash) {
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
      // Fall back to local protection rather than making a slow/failed Redis
      // dependency the request bottleneck.
    }
  }

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
