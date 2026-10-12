import { it, expect, vi, afterEach } from 'vitest';
import { exportPosthogDiagnostic, diagnosticHealth } from '../src/posthogDiagnostics';
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('defaults off and sends only fixed diagnostic text and canonical correlation to OTLP', async () => {
  const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(null)); vi.stubGlobal('fetch', fetchMock);
  await exportPosthogDiagnostic({ service: 'orgx-mcp', key: 'phc_fixture' }, 'mcp_invocation_failed'); expect(fetchMock).not.toHaveBeenCalled();
  await exportPosthogDiagnostic({ service: 'orgx-mcp', key: 'phc_fixture', enabled: true }, 'mcp_invocation_failed', { userId: '11111111-1111-4111-8111-111111111111', requestId: 'sentinel_private_value', traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) });
  const [url, init] = fetchMock.mock.calls[0]; const body = JSON.parse(String(init?.body));
  expect(url).toBe('https://us.i.posthog.com/i/v1/logs'); expect(JSON.stringify(body)).not.toContain('sentinel_private_value');
  const log = body.resourceLogs[0].scopeLogs[0].logRecords[0]; expect(log.body.stringValue).toBe('mcp_invocation_failed');
  expect(log.attributes).toContainEqual({ key: 'posthogDistinctId', value: { stringValue: '11111111-1111-4111-8111-111111111111' } });
  expect(log.traceId).toBe('a'.repeat(32));
});
it('caps concurrent diagnostics, drops overflow and isolates export failure', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2040-01-01'));
  const failed = diagnosticHealth.failed, dropped = diagnosticHealth.dropped;
  vi.stubGlobal('fetch', vi.fn((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('private-secret'))))));
  const pending = Array.from({ length: 10 }, () => exportPosthogDiagnostic({ service: 'orgx-mcp', key: 'phc_fixture', enabled: true }, 'mcp_invocation_failed'));
  await vi.advanceTimersByTimeAsync(2000); await Promise.all(pending);
  expect(diagnosticHealth.failed - failed).toBe(4); expect(diagnosticHealth.dropped - dropped).toBe(6);
});
