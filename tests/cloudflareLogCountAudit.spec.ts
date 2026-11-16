import { describe, expect, it, vi } from 'vitest';
import { auditCloudflare } from '../scripts/cloudflare-read-only-audit.mjs';
import {
  COUNTS_ENDPOINT, KEYS_ENDPOINT, LEVEL_LIMIT, CREDENTIAL_NEEDLE,
  auditCloudflareLogCounts, formatLogCountSummary, logAuditRequests,
} from '../scripts/cloudflare-log-count-audit.mjs';

const NOW = Date.parse('2026-11-16T16:00:00Z');
const TOKEN = 'private-token-fixture';
const keys = () => ({ success: true, result: [
  { key: '$metadata.service', type: 'string', lastSeenAt: NOW },
  { key: '$metadata.level', type: 'string', lastSeenAt: NOW },
] });
const aggregate = (alias: string, rows: unknown[]) => ({ success: true, result: {
  run: { status: 'COMPLETED', dry: true, userId: 'private-user-fixture', query: { name: 'private-query-fixture' } },
  statistics: { abr_level: 1, elapsed: 0.1, rows_read: 12, bytes_read: 120 },
  calculations: [{ alias, calculation: 'count', aggregates: rows, series: [] }],
} });
const levels = () => aggregate('stored_events', [
  { value: 10, count: 10, sampleInterval: 1, groups: [{ key: '$metadata.level', value: 'info' }] },
  { value: 2, count: 2, sampleInterval: 2, groups: [{ key: '$metadata.level', value: 'error' }] },
]);
const credentials = () => aggregate('credential_indicators', [{ value: 0, count: 0, sampleInterval: 1, groups: [] }]);
function sequence(payloads: unknown[] = [keys(), levels(), credentials()]) {
  let next = 0;
  const fetchImpl = vi.fn(async () => {
    if (next >= payloads.length) throw new Error('Unexpected extra request');
    const item = payloads[next++];
    return item instanceof Response ? item : Response.json(item);
  });
  return { fetchImpl, run: () => auditCloudflareLogCounts({ token: TOKEN, now: NOW, fetchImpl }) };
}

describe('bounded retained-log aggregate audit', () => {
  it('verifies exact keys before only worker-scoped, dry calculation queries', async () => {
    const { fetchImpl, run } = sequence();
    const report = await run();
    expect(report.status).toBe('observed');
    expect(report.keysVerified).toEqual({ worker: true, level: true });
    expect(report.levels).toEqual([
      { level: 'info', matchingEvents: 10, sampleInterval: 1, queryAbrLevel: 1 },
      { level: 'error', matchingEvents: 2, sampleInterval: 2, queryAbrLevel: 1 },
    ]);
    expect(report.credentialIndicators).toEqual({ matchingEvents: 0, sampleInterval: 1, queryAbrLevel: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const requests = logAuditRequests(NOW);
    for (const [i, endpoint] of [KEYS_ENDPOINT, COUNTS_ENDPOINT, COUNTS_ENDPOINT].entries()) {
      const [url, init] = fetchImpl.mock.calls[i] as unknown as [string, RequestInit];
      expect(url).toBe(endpoint);
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('error');
      expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
      const body = JSON.parse(String(init.body));
      expect(body).toEqual([requests.keys, requests.levels, requests.credentials][i]);
      const params = i === 0 ? body : body.parameters;
      expect(params.datasets).toEqual(['cloudflare-workers']);
      expect(params.filters).toEqual([{ key: '$metadata.service', operation: 'eq', type: 'string', value: 'orgx-mcp-production' }]);
      if (i > 0) {
        expect(body).toMatchObject({ dry: true, view: 'calculations', ignoreSeries: true, chart: false, chartType: 'aggregate' });
        expect(body.timeframe).toEqual({ from: NOW - 3_600_000, to: NOW });
        expect(params.calculations).toEqual([{ operator: 'count', alias: i === 1 ? 'stored_events' : 'credential_indicators' }]);
      }
    }
    expect(requests.credentials.parameters.needle).toEqual({ value: CREDENTIAL_NEEDLE, isRegex: true, matchCase: false });
    expect(formatLogCountSummary(report)).toContain('zero does not prove absence');
  });

  it('discards echoed query metadata, arbitrary key strings, event contents and unknown group values', async () => {
    const payload = levels() as any;
    payload.result.events = { events: [{ source: `private-business-fixture ${TOKEN}` }] };
    payload.result.calculations[0].aggregates[0].groups[0].value = 'private-level-fixture';
    const report = await sequence([keys(), payload, credentials()]).run();
    expect(report.levels[0].level).toBe('other');
    const output = JSON.stringify(report) + formatLogCountSummary(report);
    expect(output).not.toMatch(/private-(user|query|business|token|level)-fixture/);
    expect(report.coverageBoundary).toContain('not proof of a leak');
  });

  it.each([
    [],
    [{ key: '$metadata.level', type: 'string' }],
    [{ key: '$metadata.service', type: 'string' }, { key: '$metadata.service', type: 'string' }],
    [{ key: '$metadata.service', type: 'string' }, { key: '$metadata.level', type: 'number' }],
    [{ key: '$metadata.service', type: 'string' }, { key: '$metadata.level.private-fixture', type: 'string' }],
  ])('stops on absent, malformed or unverified keys without broadening the query %#', async (rows) => {
    const { run, fetchImpl } = sequence([{ success: true, result: rows }]);
    const report = await run();
    expect(report.reason).toBe('field_keys_unverified');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(report.credentialIndicators.matchingEvents).toBeNull();
    expect(JSON.stringify(report)).not.toContain('private-fixture');
  });

  it.each([401, 403])('reports denied HTTP %s as unknown and cancels without reading its body', async (status) => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const { run, fetchImpl } = sequence([new Response(body, { status })]);
    const report = await run();
    expect(report.status).toBe('permission_denied');
    expect(report.levels).toEqual([]);
    expect(report.credentialIndicators.matchingEvents).toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('sanitizes REST permission errors and preserves prior observed counts when a later read is denied', async () => {
    const denied = { success: false, errors: [{ message: `permission denied: ${TOKEN} private-api-error-fixture` }] };
    const report = await sequence([keys(), levels(), denied]).run();
    expect(report.status).toBe('permission_denied');
    expect(report.levels).toHaveLength(2);
    expect(report.credentialIndicators.matchingEvents).toBeNull();
    expect(JSON.stringify(report) + formatLogCountSummary(report)).not.toMatch(/private-token-fixture|private-api-error-fixture/);
  });

  it('does not convert missing counts or sampling information to zero', async () => {
    const payload = levels() as any;
    delete payload.result.calculations[0].aggregates[0].value;
    const { run, fetchImpl } = sequence([keys(), payload]);
    const report = await run();
    expect(report.reason).toBe('invalid_count_response');
    expect(report.levels).toEqual([]);
    expect(report.credentialIndicators.matchingEvents).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('preserves an explicit zero count with unknown sampling as partial, not proof of absence', async () => {
    const payload = credentials();
    payload.result.calculations[0].aggregates = [{ value: 0, count: 0, sampleInterval: 0, groups: [] }];
    const report = await sequence([keys(), levels(), payload]).run();
    expect(report.status).toBe('partial');
    expect(report.reason).toBe('log_sampling_unverified');
    expect(report.credentialIndicators).toEqual({ matchingEvents: 0, sampleInterval: null, queryAbrLevel: 1 });
    expect(formatLogCountSummary(report)).toContain('zero does not prove absence');
  });

  it('retains provider ABR level zero while keeping absent sampling metadata unknown', async () => {
    const payload = credentials() as any;
    payload.result.statistics.abr_level = 0;
    delete payload.result.calculations[0].aggregates[0].sampleInterval;
    const report = await sequence([keys(), levels(), payload]).run();
    expect(report.status).toBe('partial');
    expect(report.credentialIndicators).toEqual({ matchingEvents: 0, sampleInterval: null, queryAbrLevel: 0 });
  });

  it.each(['STARTED', 'not-dry'])('requires completed, nonpersistent query execution: %s', async (mode) => {
    const payload = levels();
    if (mode === 'STARTED') payload.result.run.status = 'STARTED';
    else payload.result.run.dry = false;
    const { run, fetchImpl } = sequence([keys(), payload]);
    expect((await run()).reason).toBe('query_not_completed');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('marks a capped group result partial instead of claiming complete coverage', async () => {
    const payload = levels();
    payload.result.calculations[0].aggregates = Array.from({ length: LEVEL_LIMIT }, () => ({
      value: 1, count: 1, sampleInterval: 1, groups: [{ key: '$metadata.level', value: 'info' }],
    }));
    const report = await sequence([keys(), payload, credentials()]).run();
    expect(report.status).toBe('partial');
    expect(report.levelsMayBeTruncated).toBe(true);
  });

  it('rejects oversized actual response bytes before EOF and cancels the stream', async () => {
    const cancel = vi.fn();
    const { run, fetchImpl } = sequence([new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(65_537)); }, cancel,
    }))]);
    expect((await run()).reason).toBe('response_byte_limit');
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('shares one deadline across sequential reads and does not wait for stalled cancellation', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    let index = 0;
    const fetchImpl = vi.fn(async () => {
      if (index++ === 0) {
        await new Promise((resolve) => setTimeout(resolve, 7_000));
        return Response.json(keys());
      }
      return new Response(new ReadableStream({ cancel }));
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = auditCloudflareLogCounts({ token: TOKEN, now: NOW, fetchImpl });
      await vi.advanceTimersByTimeAsync(7_000);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(3_000);
      expect((await pending).reason).toBe('audit_deadline');
      expect(cancel).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('cancels a late header response after timeout without retaining its error or contents', async () => {
    let deliver!: (value: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { deliver = resolve; }));
    const cancel = vi.fn();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = auditCloudflareLogCounts({ token: TOKEN, now: NOW, fetchImpl });
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await pending).reason).toBe('audit_deadline');
      deliver(new Response(new ReadableStream({ cancel })));
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    } finally { vi.useRealTimers(); }
  });

  it('does not dispatch any read without the existing credential', async () => {
    const fetchImpl = vi.fn();
    const report = await auditCloudflareLogCounts({ token: '', now: NOW, fetchImpl });
    expect(report.reason).toBe('credential_unavailable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('the existing CLI orchestration returns separate numeric coverage and fails closed when logs are denied', async () => {
    const metrics = { data: { viewer: { accounts: [{
      totals: [{ sum: { requests: 1, errors: 0, subrequests: 1 }, quantiles: { cpuTimeP50: 1, cpuTimeP99: 2 } }], outcomes: [],
    }] } } };
    const { fetchImpl } = sequence([metrics, new Response('private-error-fixture', { status: 403 })]);
    const report = await auditCloudflare({ token: TOKEN, now: NOW, fetchImpl });
    expect(report.status).toBe('observed');
    expect(report.auditComplete).toBe(false);
    expect(report.retainedLogs.status).toBe('permission_denied');
    expect(JSON.stringify(report)).not.toContain('private-error-fixture');
  });
});
