import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { EDGE_RATE_LIMIT_SCRIPT } from './edgeRateLimitScript';
import {
  resetBillingPlanCacheForTests,
  resolveBillingPlanContext,
} from './billingPlan';
import {
  durationMs,
  finalizeRateLimitDecision,
  type RateLimitTiming,
} from './rateLimitTiming';

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
  timing?: RateLimitTiming;
}

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const TIER_LIMITS: Record<Exclude<BillingTier, 'enterprise'>, number> = {
  free: 100,
  pro: 1000,
};
const BASE_ALLOWANCE = TIER_LIMITS.free;
const PRO_EXTRA_ALLOWANCE = TIER_LIMITS.pro - BASE_ALLOWANCE;
const TOKEN_USER_CACHE_TTL_MS = 60 * 1000; // 1 minute
const UPSTASH_COMMAND_TIMEOUT_MS = 750;
const MAX_MEMORY_BUCKETS = 2048;
const MAX_TOKEN_USER_CACHE_ENTRIES = 2048;
const MEMORY_SWEEP_INTERVAL_MS = 60_000;
let lastMemorySweepMs = 0;
let lastDegradationLogMs = 0;

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
  lastMemorySweepMs = 0;
  lastDegradationLogMs = 0;
}

function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  if (!header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

async function hashToken(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function buildSubjectKey(request: Request, token: string | null, userId: string | null): Promise<string> {
  if (token) return `token:sha256:${await hashToken(token)}`;
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
  const cacheKey = await hashToken(token);
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
      cacheTokenUser(cacheKey, {
        userId,
        expiresAt: Date.now() + TOKEN_USER_CACHE_TTL_MS,
      });
      return userId;
    } catch {
      cacheTokenUser(cacheKey, {
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

function cacheTokenUser(key: string, value: { userId: string | null; expiresAt: number }): void {
  if (!tokenUserCache.has(key) && tokenUserCache.size >= MAX_TOKEN_USER_CACHE_ENTRIES) {
    // This cache only avoids repeated billing identity I/O. Evicting it cannot
    // grant access or replenish a rate bucket.
    const oldestKey = tokenUserCache.keys().next().value;
    if (oldestKey !== undefined) tokenUserCache.delete(oldestKey);
  }
  tokenUserCache.set(key, value);
}

function buildRateHeaders(params: {
  tier: BillingTier;
  limit: number | null;
  remaining: number | null;
  resetAtSeconds: number;
  source: LimitSource;
  degraded?: boolean;
}): Record<string, string> {
  return {
    ...(params.degraded ? { 'X-RateLimit-Degraded': 'upstash_unavailable' } : {}),
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

async function runUpstashCommand(
  env: RateLimitEnv,
  command: Array<string | number>
): Promise<unknown> {
  const url = env.UPSTASH_REDIS_REST_URL?.trim();
  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) {
    throw new Error('upstash-not-configured');
  }

  const endpoint = url.replace(/\/+$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort('upstash command timeout'),
    UPSTASH_COMMAND_TIMEOUT_MS
  );
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('upstash-command-rejected');
    const body = (await response.json()) as { result?: unknown; error?: unknown };
    if (!body || body.error !== undefined) throw new Error('upstash-command-error');
    return body.result;
  } finally {
    // Include body delivery and parsing in the deadline, not only headers.
    clearTimeout(timeout);
  }
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
  const result = await runUpstashCommand(env, [
    'EVAL', EDGE_RATE_LIMIT_SCRIPT, 1, key, nowMs, WINDOW_MS, limit, crypto.randomUUID(),
  ]);
  if (!Array.isArray(result) || result.length !== 3) throw new Error('upstash-invalid-result');
  const [allowed, count, oldestMs] = result;
  if (
    (allowed !== 0 && allowed !== 1) ||
    !Number.isSafeInteger(count) || count < 1 ||
    !Number.isSafeInteger(oldestMs) || oldestMs < 0 ||
    (allowed === 1 && count > limit) || (allowed === 0 && count < limit)
  ) throw new Error('upstash-invalid-result');
  return {
    allowed: allowed === 1,
    remaining: Math.max(0, limit - count),
    resetAtSeconds: resetAtSecondsFromOldest(oldestMs, nowMs),
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
  if (nowMs - lastMemorySweepMs >= MEMORY_SWEEP_INTERVAL_MS || nowMs < lastMemorySweepMs) {
    for (const [bucketKey, values] of memoryBuckets) {
      if (!values.length || values[values.length - 1] <= startMs) memoryBuckets.delete(bucketKey);
    }
    lastMemorySweepMs = nowMs;
  }
  if (!memoryBuckets.has(key) && memoryBuckets.size >= MAX_MEMORY_BUCKETS) {
    // Keep active callers' limits intact. Evicting an active bucket would
    // allow attacker-controlled token/IP churn to replenish the allowance.
    return { allowed: false, remaining: 0, resetAtSeconds: resetAtSecondsFromOldest(null, nowMs) };
  }
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

async function checkLimitBucket(params: {
  env: RateLimitEnv;
  key: string;
  limit: number;
  nowMs: number;
}): Promise<{
  allowed: boolean;
  remaining: number;
  resetAtSeconds: number;
  source: Exclude<LimitSource, 'bypass'>;
  degraded: boolean;
  backendMs: number;
}> {
  const startedAt = performance.now();
  const hasUpstash =
    Boolean(params.env.UPSTASH_REDIS_REST_URL?.trim()) &&
    Boolean(params.env.UPSTASH_REDIS_REST_TOKEN?.trim());

  if (hasUpstash) {
    try {
      const result = await checkWithUpstash(params);
      return {
        ...result,
        source: 'upstash',
        degraded: false,
        backendMs: durationMs(startedAt),
      };
    } catch {
      // Fall back to local protection rather than making a slow/failed Redis
      // dependency the request bottleneck.
      const now = Date.now();
      if (now - lastDegradationLogMs >= 30_000 || now < lastDegradationLogMs) {
        console.warn('[rate-limit] Distributed admission unavailable', {
          source: 'memory', reason: 'upstash_unavailable',
        });
        lastDegradationLogMs = now;
      }
    }
  }

  return {
    ...checkWithMemory(params),
    source: 'memory',
    degraded: hasUpstash,
    backendMs: durationMs(startedAt),
  };
}

export async function checkEdgeRateLimit(
  request: Request,
  env: RateLimitEnv
): Promise<RateLimitDecision> {
  const startedAt = performance.now();
  if (request.method === 'OPTIONS') {
    return finalizeRateLimitDecision(
      {
        allowed: true,
        tier: 'free',
        source: 'bypass',
        headers: {},
      },
      {
        startedAt,
        identityMs: 0,
        billingMs: 0,
        backendMs: 0,
        strategy: 'preflight_bypass',
      }
    );
  }

  const token = extractBearerToken(request);
  const nowMs = Date.now();
  const bucketKey = await buildSubjectKey(request, token, null);
  const base = await checkLimitBucket({
    env,
    key: `mcp:rate:base:${bucketKey}`,
    limit: BASE_ALLOWANCE,
    nowMs,
  });

  // Most callers never approach the free allowance. Keep that hot path local:
  // identity unwrap and billing-plan I/O are only needed after it is exhausted.
  if (base.allowed) {
    return finalizeRateLimitDecision(
      {
        allowed: true,
        tier: 'free',
        source: base.source,
        headers: buildRateHeaders({
          tier: 'free',
          limit: BASE_ALLOWANCE,
          remaining: base.remaining,
          resetAtSeconds: base.resetAtSeconds,
          source: base.source,
          degraded: base.degraded,
        }),
      },
      {
        startedAt,
        identityMs: 0,
        billingMs: 0,
        backendMs: base.backendMs,
        strategy: 'base_allowance',
      }
    );
  }

  const identityStartedAt = performance.now();
  const userId = await resolveUserIdFromToken(token, env);
  const identityMs = durationMs(identityStartedAt);
  const billingStartedAt = performance.now();
  const { tier } = await resolveBillingPlanContext(env, userId);
  const billingMs = durationMs(billingStartedAt);

  if (tier === 'enterprise') {
    return finalizeRateLimitDecision(
      {
        allowed: true,
        tier,
        source: 'bypass',
        headers: buildRateHeaders({
          tier,
          limit: null,
          remaining: null,
          resetAtSeconds: Math.floor(Date.now() / 1000) + 3600,
          source: 'bypass',
          degraded: base.degraded,
        }),
      },
      {
        startedAt,
        identityMs,
        billingMs,
        backendMs: base.backendMs,
        strategy: 'enterprise_bypass',
      }
    );
  }

  if (tier === 'free') {
    return finalizeRateLimitDecision(
      {
        allowed: false,
        tier,
        source: base.source,
        retryAfterSeconds: Math.max(
          1,
          base.resetAtSeconds - Math.floor(nowMs / 1000)
        ),
        headers: buildRateHeaders({
          tier,
          limit: BASE_ALLOWANCE,
          remaining: 0,
          resetAtSeconds: base.resetAtSeconds,
          source: base.source,
          degraded: base.degraded,
        }),
      },
      {
        startedAt,
        identityMs,
        billingMs,
        backendMs: base.backendMs,
        strategy: 'free_limit',
      }
    );
  }

  const paid = await checkLimitBucket({
    env,
    key: `mcp:rate:paid:${bucketKey}`,
    limit: PRO_EXTRA_ALLOWANCE,
    nowMs,
  });
  return finalizeRateLimitDecision(
    {
      allowed: paid.allowed,
      tier: 'pro',
      source: paid.source,
      retryAfterSeconds: paid.allowed
        ? undefined
        : Math.max(1, paid.resetAtSeconds - Math.floor(nowMs / 1000)),
      headers: buildRateHeaders({
        tier: 'pro',
        limit: TIER_LIMITS.pro,
        remaining: paid.remaining,
        resetAtSeconds: paid.resetAtSeconds,
        source: paid.source,
        degraded: base.degraded || paid.degraded,
      }),
    },
    {
      startedAt,
      identityMs,
      billingMs,
      backendMs: base.backendMs + paid.backendMs,
      strategy: 'paid_allowance',
    }
  );
}
