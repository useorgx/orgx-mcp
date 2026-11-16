import { describe, expect, it, vi } from 'vitest';
import {
  COUNTS_ENDPOINT, RETAINED_DEADLINE_MS, WARNING_CATEGORIES,
  auditCloudflareLogCounts, formatLogCountSummary, logAuditRequests,
} from '../scripts/cloudflare-log-count-audit.mjs';

const NOW = Date.parse('2026-11-16T17:00:00Z');
const fieldKeys = (message = true) => ({ success: true, result: [
  { key: '$metadata.service', type: 'string' }, { key: '$metadata.level', type: 'string' },
  ...(message ? [{ key: '$metadata.message', type: 'string' }] : []),
] });
const count = (alias: string, value: number | null = 0, sampleInterval: number | null = 1, groups: unknown[] = []) => ({
  success: true, result: { run: { status: 'COMPLETED', dry: true }, statistics: { abr_level: 1 },
    calculations: [{ alias, aggregates: [{ value, sampleInterval, groups }] }] },
});
const initial = (message = true) => [fieldKeys(message), count('stored_events', 10, 1, [{ key: '$metadata.level', value: 'warn' }]), count('credential_indicators')];
const warnings = () => WARNING_CATEGORIES.map(({ id }, index) => count(`warning_${id}`, index + 1));
function run(payloads: unknown[] = [...initial(), ...warnings()]) {
  let index = 0;
  const fetchImpl = vi.fn(async () => {
    if (index >= payloads.length) throw new Error('Unexpected extra request');
    const payload = payloads[index++];
    return payload instanceof Response ? payload : Response.json(payload);
  });
  return { fetchImpl, result: auditCloudflareLogCounts({ token: 'private-token-fixture', now: NOW, fetchImpl }) };
}

describe('fixed content-free warning categories', () => {
  it('issues only eight ungrouped count reads with exact worker, warn and verified message filters', async () => {
    const { result, fetchImpl } = run();
    const report = await result;
    expect(report.status).toBe('observed');
    expect(WARNING_CATEGORIES).toHaveLength(8);
    expect(fetchImpl).toHaveBeenCalledTimes(11);
    const requests = logAuditRequests(NOW);
    for (const [index, category] of WARNING_CATEGORIES.entries()) {
      const [endpoint, init] = fetchImpl.mock.calls[index + 3] as unknown as [string, RequestInit];
      expect(endpoint).toBe(COUNTS_ENDPOINT);
      expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
      const body = JSON.parse(String(init.body));
      expect(body).toEqual(requests.warnings[index]);
      expect(body).toMatchObject({ view: 'calculations', dry: true, chartType: 'aggregate', ignoreSeries: true,
        limit: 1, timeframe: { from: NOW - 3_600_000, to: NOW }, parameters: {
          datasets: ['cloudflare-workers'], filterCombination: 'and', groupBys: [], limit: 1,
          calculations: [{ operator: 'count', alias: `warning_${category.id}` }], filters: [
            { key: '$metadata.service', operation: 'eq', type: 'string', value: 'orgx-mcp-production' },
            { key: '$metadata.level', operation: 'eq', type: 'string', value: 'warn' },
            { key: '$metadata.message', operation: 'regex', type: 'string', value: category.pattern },
          ],
        } });
      expect(report.warningCategories[index]).toEqual({ id: category.id, label: category.label,
        matchingEvents: index + 1, sampleInterval: 1, queryAbrLevel: 1 });
    }
    expect(formatLogCountSummary(report)).toContain('categories can overlap');
    expect(report.warningBoundary).toContain('must not be reconciled with older reports');
  });

  it.each([
    ['api_fallback_attempt', '[orgx-api] trying fallback'],
    ['api_fallback_recovered', '[orgx-api] fallback succeeded'],
    ['distributed_admission', '[rate-limit] Distributed admission unavailable'],
    ['auth_rejected', '[auth] Bearer token invalid or expired'],
    ['auth_rejected', '[auth] Tool blocked due to insufficient_scope'],
    ['auth_rejected', '[auth] Tool blocked due to missing_authentication'],
    ['profiles_restricted', '[mcp:profiles] External full profile request; failing closed to read-only surface'],
    ['profiles_restricted', '[mcp:profiles] Unknown tool profile; failing closed to read-only surface'],
    ['session_storage', '[mcp:session] Failed to load session auth'],
    ['session_storage', '[mcp:client-info] failed to read handshake clientInfo'],
    ['telemetry', '[mcp:telemetry] failed to persist tool invocation'],
    ['telemetry', '[telemetry] PostHog capture rejected'],
    ['reads_widgets_transport', '[panel] agent status read failed'],
    ['reads_widgets_transport', '[mcp] recovered transient Durable Object transport failure'],
    ['reads_widgets_transport', '{"component":"live-feed-do","event":"poll_failed"}'],
  ])('recognizes public source warning %s: %s', (id, message) => {
    const category = WARNING_CATEGORIES.find((entry) => entry.id === id)!;
    expect(new RegExp(category.pattern).test(message)).toBe(true);
    expect(new RegExp(category.pattern).test('private-business-message')).toBe(false);
  });

  it('keeps existing observations but makes no warning query when the exact message key is absent', async () => {
    const { result, fetchImpl } = run(initial(false));
    const report = await result;
    expect(report.status).toBe('partial');
    expect(report.reason).toBe('warning_message_key_unverified');
    expect(report.keysVerified.message).toBe(false);
    expect(report.credentialIndicators.matchingEvents).toBe(0);
    expect(report.warningCategories.every((row) => row.matchingEvents === null)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('preserves explicit warning zero with unknown sampling as partial and discards unexpected content', async () => {
    const replies = warnings();
    const payload = count('warning_api_fallback_attempt', 0, null) as any;
    payload.result.events = [{ message: 'private-business-message private-token-fixture' }];
    payload.result.run.query = { name: 'private-query-name' };
    replies[0] = payload;
    const report = await run([...initial(), ...replies]).result;
    expect(report.status).toBe('partial');
    expect(report.reason).toBe('log_sampling_unverified');
    expect(report.warningCategories[0].matchingEvents).toBe(0);
    expect(report.warningCategories[0].sampleInterval).toBeNull();
    expect(JSON.stringify(report) + formatLogCountSummary(report)).not.toMatch(/private-(business|token|query)/);
  });

  it('never turns absent aggregate rows into zero or accepts arbitrary message groups', async () => {
    const empty = count('warning_api_fallback_attempt');
    empty.result.calculations[0].aggregates = [];
    const report = await run([...initial(), empty]).result;
    expect(report.reason).toBe('no_warning_aggregate_rows');
    expect(report.warningCategories[0].matchingEvents).toBeNull();
    const grouped = count('warning_api_fallback_attempt', 1, 1, [{ key: '$metadata.message', value: 'private-message' }]);
    const groupedReport = await run([...initial(), grouped]).result;
    expect(groupedReport.reason).toBe('invalid_count_response');
    expect(JSON.stringify(groupedReport)).not.toContain('private-message');
  });

  it('preserves preceding categories and leaves later values unknown when a warning read is denied', async () => {
    const { result, fetchImpl } = run([...initial(), warnings()[0], new Response('private-provider-error', { status: 403 })] as any);
    const report = await result;
    expect(report.status).toBe('permission_denied');
    expect(report.warningCategories[0].matchingEvents).toBe(1);
    expect(report.warningCategories.slice(1).every((row) => row.matchingEvents === null)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(report)).not.toContain('private-provider-error');
  });

  it('bounds all retained reads including warnings to one 30-second deadline and cancels a stalled body', async () => {
    const replies = [...initial(), warnings()[0]];
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    let index = 0;
    const fetchImpl = vi.fn(async () => {
      if (index < replies.length) {
        if (index === 3) await new Promise((resolve) => setTimeout(resolve, 27_000));
        return Response.json(replies[index++]);
      }
      return new Response(new ReadableStream({ cancel }));
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = auditCloudflareLogCounts({ token: 'private-token-fixture', now: NOW, fetchImpl });
      await vi.advanceTimersByTimeAsync(27_000);
      expect(fetchImpl).toHaveBeenCalledTimes(5);
      await vi.advanceTimersByTimeAsync(RETAINED_DEADLINE_MS - 27_000);
      const report = await pending;
      expect(report.reason).toBe('audit_deadline');
      expect(report.warningCategories[0].matchingEvents).toBe(1);
      expect(report.warningCategories[1].matchingEvents).toBeNull();
      expect(cancel).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});
