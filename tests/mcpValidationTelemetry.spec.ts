import { afterEach, expect, it, vi } from 'vitest';
import { handleMcpRequest } from '../src/mcpTransport';
import { summarizeValidationIssues } from '../src/mcpValidationTelemetry';
afterEach(() => { vi.unstubAllGlobals(); });
it('exports bounded declared validation codes in the actual canonical invocation batch', async () => {
  const payloads: Array<{ batch: Array<{ properties: Record<string, unknown> }> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    payloads.push(JSON.parse(String(init?.body))); return Response.json({ status: 1 });
  }));
  const pending: Promise<unknown>[] = [];
  const ctx = { props: {}, waitUntil: (p: Promise<unknown>) => pending.push(p) };
  const raw = { jsonrpc: '2.0', id: 1, result: { isError: true, structuredContent: { ok: false, error: { code: 'invalid_input', details: { issues: [
    { code: 'invalid_type', path: ['private-customer-field'], message: 'private-customer-value' },
    { code: 'too_small', received: 'private-customer-value' },
  ] } } } } };
  const response = await handleMcpRequest(new Request('http://localhost/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'orgx_search', arguments: { query: 'offline-fixture' } } }) }),
    { POSTHOG_KEY: 'phc_offline_fixture' }, ctx, { fetch: async () => Response.json(raw) },
    async () => ({ userId: 'user_fixture', orgxUserId: '11111111-1111-4111-8111-111111111111', scope: 'mcp:all' }));
  expect(await response.json()).toEqual(raw);
  while (pending.length) await Promise.allSettled(pending.splice(0));
  expect(payloads).toHaveLength(1);
  expect(payloads[0].batch[0].properties).toMatchObject({ status: 'error', validation_issue_count: 2,
    validation_issue_codes: ['invalid_type', 'too_small'], validation_issues_truncated: false });
  expect(JSON.stringify(payloads)).not.toContain('private-customer');
});
it('does not invent details from raw prose and bounds structured issue inspection', () => {
  expect(summarizeValidationIssues('private-message')).toEqual({});
  const summary = summarizeValidationIssues(Array.from({ length: 100 }, () => ({ code: 'private-path' })));
  expect(summary).toEqual({ validationIssueCount: 20, validationIssueCodes: [], validationIssuesTruncated: true });
});
