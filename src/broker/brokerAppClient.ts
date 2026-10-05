/**
 * The broker's two calls to the OrgX app (steps 2 and 3 of the gateway):
 *
 *   POST /api/internal/broker/run-status   is the run still active?
 *   POST /api/internal/broker/vendor-token  one connection's upstream
 *
 * Both authenticate with the `mcp-broker` scoped service key
 * (ORGX_BROKER_SERVICE_KEY, admitted only on /api/internal/broker/*) and carry
 * the harness's broker token in the body, which the app re-verifies. The
 * worker never touches the database or a refresh token.
 *
 * Answers are cached in this isolate's memory only: run status for a few
 * seconds, an upstream (vendor URL and auth headers) for at most a minute.
 * Nothing here is ever logged. Any failure to reach the app fails closed.
 */

import type { BrokerTokenPayload } from './brokerToken';

export interface BrokerAppEnv {
  ORGX_API_URL?: string;
  ORGX_BROKER_SERVICE_KEY?: string;
}

export type BrokerToolPolicy = {
  groups: { low: Permission; key: Permission; high: Permission };
  tools: Record<string, Permission>;
};
type Permission = 'allow' | 'ask' | 'deny';

export type BrokerUpstream = {
  url: string;
  headers: Record<string, string>;
  catalogId: string | null;
  policy: BrokerToolPolicy;
};

export type RunStatus = { active: true } | { active: false; reason: string };

export type AppError = { error: string; status: number };

const RUN_STATUS_MAX_CACHE_MS = 10_000;
const UPSTREAM_MAX_CACHE_MS = 60_000;
const APP_TIMEOUT_MS = 8_000;

type Cached<T> = { value: T; until: number };

export interface BrokerAppCache {
  runStatus: Map<string, Cached<RunStatus>>;
  upstream: Map<string, Cached<BrokerUpstream>>;
}

export function createBrokerAppCache(): BrokerAppCache {
  return { runStatus: new Map(), upstream: new Map() };
}

/** Per-isolate cache shared by requests; tests pass their own. */
const isolateCache = createBrokerAppCache();

const DEFAULT_POLICY: BrokerToolPolicy = {
  groups: { low: 'allow', key: 'ask', high: 'ask' },
  tools: {},
};

function permission(value: unknown, fallback: Permission): Permission {
  return value === 'allow' || value === 'ask' || value === 'deny' ? value : fallback;
}

function parsePolicy(value: unknown): BrokerToolPolicy {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const groups = raw.groups && typeof raw.groups === 'object' ? (raw.groups as Record<string, unknown>) : {};
  const tools = raw.tools && typeof raw.tools === 'object' ? (raw.tools as Record<string, unknown>) : {};
  return {
    groups: {
      low: permission(groups.low, DEFAULT_POLICY.groups.low),
      key: permission(groups.key, DEFAULT_POLICY.groups.key),
      high: permission(groups.high, DEFAULT_POLICY.groups.high),
    },
    tools: Object.fromEntries(
      Object.entries(tools).flatMap(([name, p]) =>
        p === 'allow' || p === 'ask' || p === 'deny' ? [[name, p]] : []
      )
    ),
  };
}

function prune<T>(map: Map<string, Cached<T>>, now: number) {
  if (map.size < 512) return;
  for (const [key, entry] of map) if (entry.until <= now) map.delete(key);
}

export class BrokerAppClient {
  constructor(
    private readonly env: BrokerAppEnv,
    private readonly deps: {
      fetch?: typeof fetch;
      now?: () => number;
      cache?: BrokerAppCache;
    } = {}
  ) {}

  private get cache() {
    return this.deps.cache ?? isolateCache;
  }

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  private async post(path: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
    const base = (this.env.ORGX_API_URL ?? '').replace(/\/+$/, '');
    const key = this.env.ORGX_BROKER_SERVICE_KEY?.trim();
    if (!base || !key) return { status: 503, json: { error: 'broker_unconfigured' } };
    try {
      const response = await (this.deps.fetch ?? fetch)(`${base}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(APP_TIMEOUT_MS),
      });
      const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: response.status, json };
    } catch {
      return { status: 503, json: { error: 'app_unreachable' } };
    }
  }

  /** Step 2: is the token's run still active? Cached a few seconds per jti. */
  async runStatus(token: string, payload: BrokerTokenPayload): Promise<RunStatus | AppError> {
    const now = this.now();
    const cached = this.cache.runStatus.get(payload.jti);
    if (cached && cached.until > now) return cached.value;
    const { status, json } = await this.post('/api/internal/broker/run-status', { run_token: token });
    if (status !== 200 || typeof json.active !== 'boolean') {
      return { error: typeof json.error === 'string' ? json.error : 'run_status_unavailable', status: status === 401 ? 401 : 503 };
    }
    const value: RunStatus = json.active
      ? { active: true }
      : { active: false, reason: typeof json.reason === 'string' ? json.reason : 'run_inactive' };
    const ttl = Math.min(Number(json.cache_ttl_seconds) * 1000 || 0, RUN_STATUS_MAX_CACHE_MS);
    prune(this.cache.runStatus, now);
    if (ttl > 0) this.cache.runStatus.set(payload.jti, { value, until: now + ttl });
    return value;
  }

  /**
   * Step 3: the vendor upstream for one connection. `forceRefresh` asks the
   * app to refresh the vendor token (the vendor just answered 401) and skips
   * the cache.
   */
  async upstream(
    token: string,
    payload: BrokerTokenPayload,
    connectionId: string,
    variant: string | null,
    forceRefresh = false
  ): Promise<BrokerUpstream | AppError> {
    const now = this.now();
    const key = `${payload.jti}|${connectionId}|${variant ?? ''}`;
    const cached = this.cache.upstream.get(key);
    if (!forceRefresh && cached && cached.until > now) return cached.value;
    const { status, json } = await this.post('/api/internal/broker/vendor-token', {
      run_token: token,
      connection_id: connectionId,
      ...(variant ? { variant } : {}),
      ...(forceRefresh ? { force_refresh: true } : {}),
    });
    const upstream = json.upstream as { url?: unknown; headers?: unknown } | undefined;
    if (status !== 200 || !upstream || typeof upstream.url !== 'string') {
      this.cache.upstream.delete(key);
      return { error: typeof json.error === 'string' ? json.error : 'upstream_unavailable', status: status === 200 ? 503 : status };
    }
    const headers: Record<string, string> = {};
    if (upstream.headers && typeof upstream.headers === 'object') {
      for (const [name, value] of Object.entries(upstream.headers as Record<string, unknown>)) {
        if (typeof value === 'string') headers[name] = value;
      }
    }
    const value: BrokerUpstream = {
      url: upstream.url,
      headers,
      catalogId: typeof json.catalog_id === 'string' ? json.catalog_id : null,
      policy: parsePolicy(json.policy),
    };
    const ttl = Math.min(Number(json.cache_ttl_seconds) * 1000 || 0, UPSTREAM_MAX_CACHE_MS);
    prune(this.cache.upstream, now);
    if (ttl > 0) this.cache.upstream.set(key, { value, until: now + ttl });
    return value;
  }

  /** Forget a connection's upstream (after the vendor rejected it). */
  forget(payload: BrokerTokenPayload, connectionId: string, variant: string | null) {
    this.cache.upstream.delete(`${payload.jti}|${connectionId}|${variant ?? ''}`);
  }
}

export function isAppError(value: unknown): value is AppError {
  return Boolean(value && typeof value === 'object' && 'error' in (value as object) && 'status' in (value as object));
}
