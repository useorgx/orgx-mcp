import { describe, expect, it } from 'vitest';

import {
  applyProbe,
  probeOrgxHealth,
  readUptimeSummary,
  recordProbe,
  UPTIME_TARGET,
} from '../src/uptimeProbe';

function memoryKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

describe('off-box uptime probe (plan v3 Stage 4)', () => {
  it('records a healthy probe with latency and release sha', async () => {
    let t = 1_000;
    const result = await probeOrgxHealth(
      'https://useorgx.test',
      (async () => {
        t += 120;
        return Response.json({ release: { sha: 'abc123' } });
      }) as unknown as typeof fetch,
      () => t
    );
    expect(result).toMatchObject({ ok: true, status: 200, latencyMs: 120, releaseSha: 'abc123' });
  });

  it('counts a thrown fetch as a failed probe, not a missing one', async () => {
    const result = await probeOrgxHealth(
      'https://useorgx.test',
      (async () => {
        throw new Error('connect ECONNREFUSED');
      }) as unknown as typeof fetch
    );
    expect(result).toMatchObject({ ok: false, status: 0 });
  });

  it('aggregates per day and publishes measured availability against the target', async () => {
    const kv = memoryKv();
    const at = (minute: number) =>
      new Date(Date.UTC(2026, 8, 23, 0, minute)).toISOString();
    for (let minute = 0; minute < 200; minute += 1) {
      await recordProbe(kv, {
        at: at(minute),
        ok: minute !== 7,
        status: minute === 7 ? 502 : 200,
        latencyMs: 100 + minute,
        releaseSha: 'sha-1',
      });
    }
    const summary = await readUptimeSummary(kv, 1, new Date(at(300)));
    expect(summary).toMatchObject({
      target: UPTIME_TARGET,
      probes: 200,
      ok: 199,
      availability: 0.995,
      meets_target: true,
      resolution_seconds: 60,
      release_sha: 'sha-1',
      recent_failures: [{ at: at(7), status: 502 }],
    });
    expect(summary.health_latency_ms.n).toBe(199);
    expect(summary.health_latency_ms.p50).toBeGreaterThan(100);
  });

  it('reports null availability rather than 100% when nothing was probed', async () => {
    const summary = await readUptimeSummary(memoryKv(), 7);
    expect(summary.availability).toBeNull();
    expect(summary.meets_target).toBeNull();
  });

  it('rolls a day over instead of mixing dates', () => {
    const first = applyProbe(null, {
      at: '2026-09-22T23:59:00.000Z', ok: true, status: 200, latencyMs: 1, releaseSha: null,
    });
    const next = applyProbe(first, {
      at: '2026-09-23T00:00:00.000Z', ok: true, status: 200, latencyMs: 1, releaseSha: null,
    });
    expect(next).toMatchObject({ date: '2026-09-23', probes: 1 });
  });
});
