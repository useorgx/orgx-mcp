/**
 * Off-box availability probe for the OrgX app (plan v3 Stage 4).
 *
 * The only independent monitor was a GitHub Action every 30 minutes, which
 * cannot measure any availability target tighter than about 99.3% a month:
 * one missed probe hides half an hour. The worker runs on Cloudflare, off the
 * VPS, and a cron trigger costs nothing extra, so it probes /api/health once
 * a minute, keeps a daily aggregate in KV, and publishes measured cells at
 * GET /status/uptime. Numbers there are measured, never proposed.
 */
export const UPTIME_TARGET = 0.995;
export const UPTIME_KEY_PREFIX = 'uptime:v1:';
const PROBE_TIMEOUT_MS = 10_000;
const MAX_LATENCY_SAMPLES = 1_440;
const MAX_FAILURES = 50;

export interface UptimeProbeResult {
  at: string;
  ok: boolean;
  status: number;
  latencyMs: number;
  releaseSha: string | null;
}

export interface UptimeDay {
  date: string;
  probes: number;
  ok: number;
  latencyMs: number[];
  lastReleaseSha: string | null;
  failures: Array<{ at: string; status: number }>;
}

interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export async function probeOrgxHealth(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now
): Promise<UptimeProbeResult> {
  const startedAt = now();
  const at = new Date(startedAt).toISOString();
  try {
    const response = await fetchImpl(new URL('/api/health', baseUrl), {
      headers: { accept: 'application/json', 'user-agent': 'orgx-uptime-probe/1' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const latencyMs = Math.max(0, now() - startedAt);
    let releaseSha: string | null = null;
    try {
      const body = (await response.json()) as { release?: { sha?: unknown } };
      releaseSha = typeof body.release?.sha === 'string' ? body.release.sha : null;
    } catch {
      releaseSha = null;
    }
    return { at, ok: response.status === 200, status: response.status, latencyMs, releaseSha };
  } catch {
    return { at, ok: false, status: 0, latencyMs: Math.max(0, now() - startedAt), releaseSha: null };
  }
}

export function applyProbe(day: UptimeDay | null, result: UptimeProbeResult): UptimeDay {
  const date = result.at.slice(0, 10);
  const base: UptimeDay =
    day && day.date === date
      ? day
      : { date, probes: 0, ok: 0, latencyMs: [], lastReleaseSha: null, failures: [] };
  return {
    date,
    probes: base.probes + 1,
    ok: base.ok + (result.ok ? 1 : 0),
    latencyMs: result.ok
      ? [...base.latencyMs, result.latencyMs].slice(-MAX_LATENCY_SAMPLES)
      : base.latencyMs,
    lastReleaseSha: result.releaseSha ?? base.lastReleaseSha,
    failures: result.ok
      ? base.failures
      : [...base.failures, { at: result.at, status: result.status }].slice(-MAX_FAILURES),
  };
}

export async function recordProbe(kv: KvLike, result: UptimeProbeResult): Promise<void> {
  const key = `${UPTIME_KEY_PREFIX}${result.at.slice(0, 10)}`;
  const existing = await kv.get(key);
  let day: UptimeDay | null = null;
  try {
    day = existing ? (JSON.parse(existing) as UptimeDay) : null;
  } catch {
    day = null;
  }
  await kv.put(key, JSON.stringify(applyProbe(day, result)), {
    expirationTtl: 60 * 60 * 24 * 100,
  });
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? null;
}

export function summarizeUptime(days: UptimeDay[], windowDays: number) {
  const probes = days.reduce((sum, day) => sum + day.probes, 0);
  const ok = days.reduce((sum, day) => sum + day.ok, 0);
  const latencies = days.flatMap((day) => day.latencyMs).sort((a, b) => a - b);
  const availability = probes > 0 ? ok / probes : null;
  return {
    metric: 'app_health_availability',
    target: UPTIME_TARGET,
    window_days: windowDays,
    resolution_seconds: 60,
    probes,
    ok,
    availability,
    meets_target: availability === null ? null : availability >= UPTIME_TARGET,
    health_latency_ms: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      n: latencies.length,
    },
    release_sha: [...days].reverse().find((day) => day.lastReleaseSha)?.lastReleaseSha ?? null,
    recent_failures: days.flatMap((day) => day.failures).slice(-10),
    measured_from: 'cloudflare_worker_cron',
  };
}

export async function readUptimeSummary(kv: KvLike, windowDays: number, now = new Date()) {
  const keys = Array.from({ length: windowDays }, (_, index) => {
    const date = new Date(now.getTime() - index * 86_400_000).toISOString().slice(0, 10);
    return `${UPTIME_KEY_PREFIX}${date}`;
  });
  const raw = await Promise.all(keys.map((key) => kv.get(key)));
  const days = raw
    .map((value) => {
      try {
        return value ? (JSON.parse(value) as UptimeDay) : null;
      } catch {
        return null;
      }
    })
    .filter((day): day is UptimeDay => day !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
  return summarizeUptime(days, windowDays);
}
