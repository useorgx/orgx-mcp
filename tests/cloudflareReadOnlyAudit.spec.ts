import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_ID, API_ENDPOINT, DEADLINE_MS, MAX_RESPONSE_BYTES, OUTPUT_PATH,
  QUERY, SCRIPT_NAME, WINDOW_MS, auditCloudflareMetrics, formatAuditSummary,
} from '../scripts/cloudflare-read-only-audit.mjs';

const NOW = Date.parse('2026-11-16T16:00:00Z');
const TOKEN = 'private-token-fixture';
const metrics = { requests: 123, errors: 2, subrequests: 170, cpuTimeP50: 45, cpuTimeP99: 900 };
const fixture = () => ({ data: { viewer: { accounts: [{
  totals: [{ sum: { requests: metrics.requests, errors: metrics.errors, subrequests: metrics.subrequests },
    quantiles: { cpuTimeP50: metrics.cpuTimeP50, cpuTimeP99: metrics.cpuTimeP99 } }],
  outcomes: [{ dimensions: { status: 'success' }, sum: { requests: 121, errors: 0 } },
    { dimensions: { status: 'exception' }, sum: { requests: 2, errors: 2 } }],
}] } } });
const call = (body: unknown, status = 200) => auditCloudflareMetrics({ token: TOKEN, now: NOW,
  fetchImpl: vi.fn(async () => Response.json(body, { status })) });

describe('fixed Cloudflare numeric aggregate read', () => {
  it('makes one fixed read-only query with a one-hour window and no redirects', async () => {
    const fetchImpl = vi.fn(async () => Response.json(fixture()));
    const report = await auditCloudflareMetrics({ token: TOKEN, now: NOW, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(API_ENDPOINT);
    expect(url).toBe('https://api.cloudflare.com/client/v4/graphql');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init.body))).toEqual({ query: QUERY, variables: {
      accountTag: ACCOUNT_ID, scriptName: SCRIPT_NAME,
      start: new Date(NOW - WINDOW_MS).toISOString(), end: new Date(NOW).toISOString(),
    } });
    expect(QUERY).toMatch(/^query /);
    expect(QUERY).not.toMatch(/\b(?:mutation|logs|url|headers|requestId|clientIP|tool|arguments|output)\b/i);
    expect(QUERY).toContain('limit: 1');
    expect(QUERY).toContain('limit: 16');
    expect(report.status).toBe('observed');
    expect(report.metrics).toEqual(metrics);
    expect(formatAuditSummary(report)).toContain('not end-to-end tool latency');
  });

  it('retains only whitelisted numeric aggregates and fixed operational labels', async () => {
    const payload = fixture() as any;
    payload.rawRequest = { url: 'private-business-url-fixture', authorization: TOKEN };
    payload.data.viewer.accounts[0].outcomes.push({
      dimensions: { status: 'private-business-status-fixture', clientIP: 'private-ip-fixture' },
      sum: { requests: 1, errors: 0 },
    });
    const report = await call(payload);
    const saved = JSON.stringify(report) + formatAuditSummary(report);
    for (const secret of [TOKEN, 'private-business-url-fixture', 'private-business-status-fixture', 'private-ip-fixture']) {
      expect(saved).not.toContain(secret);
    }
    expect(report.outcomes).toContainEqual({ label: 'Other status', requests: 1, errors: 0 });
  });

  it.each([401, 403])('reports HTTP %s access refusal without retaining the API body', async (status) => {
    const report = await call({ errors: [{ message: `private-provider-error-fixture ${TOKEN}` }] }, status);
    expect(report.status).toBe('permission_denied');
    expect(Object.values(report.metrics)).toEqual([null, null, null, null, null]);
    expect(JSON.stringify(report)).not.toMatch(/private-provider-error-fixture|private-token-fixture/);
    expect(formatAuditSummary(report)).toContain('Unknown');
  });

  it('rejects partial GraphQL data when permission errors accompany it', async () => {
    const report = await call({ ...fixture(), errors: [{ message: `not authorized: ${TOKEN} private-provider-error-fixture` }] });
    expect(report.status).toBe('permission_denied');
    expect(Object.values(report.metrics).every((value) => value === null)).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/private-provider-error-fixture|private-token-fixture/);
  });

  it('keeps unsupported queries and missing credentials distinct from observations', async () => {
    expect((await call({ errors: [{ message: 'Cannot query field private-field-fixture' }] })).status).toBe('query_refused');
    const fetchImpl = vi.fn();
    const missing = await auditCloudflareMetrics({ token: '', now: NOW, fetchImpl });
    expect(missing.reason).toBe('credential_unavailable');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(Object.values(missing.metrics).every((value) => value === null)).toBe(true);
  });

  it('does not turn absent rows or values into zero', async () => {
    const empty = await call({ data: { viewer: { accounts: [{ totals: [], outcomes: [] }] } } });
    expect(empty.status).toBe('no_data');
    expect(Object.values(empty.metrics).every((value) => value === null)).toBe(true);
    const payload = fixture() as any;
    delete payload.data.viewer.accounts[0].totals[0].sum.errors;
    const partial = await call(payload);
    expect(partial.status).toBe('partial');
    expect(partial.metrics.errors).toBeNull();
    expect(partial.metrics.requests).toBe(123);
  });

  it('rejects an oversized response before EOF and cancels it', async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1)); }, cancel,
    })));
    const report = await auditCloudflareMetrics({ token: TOKEN, now: NOW, fetchImpl });
    expect(report.reason).toBe('response_byte_limit');
    expect(cancel).toHaveBeenCalledOnce();
    expect(report.metrics.requests).toBeNull();
  });

  it('reads tiny chunks with one deadline race and no raw-field retention', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ ...fixture(), private: '界'.repeat(1_000) }));
    let offset = 0;
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) controller.close();
        else controller.enqueue(bytes.subarray(offset, ++offset));
      },
    })));
    const race = vi.spyOn(Promise, 'race');
    try {
      const report = await auditCloudflareMetrics({ token: TOKEN, now: NOW, fetchImpl });
      expect(report.metrics).toEqual(metrics);
      expect(JSON.stringify(report)).not.toContain('界');
      expect(race).toHaveBeenCalledOnce();
    } finally { race.mockRestore(); }
  });

  it('times out stalled headers and cancels a late response without printing an exception', async () => {
    let deliver!: (response: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { deliver = resolve; }));
    const cancel = vi.fn();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = auditCloudflareMetrics({ token: TOKEN, now: NOW, fetchImpl });
      await vi.advanceTimersByTimeAsync(DEADLINE_MS);
      expect((await pending).reason).toBe('audit_deadline');
      deliver(new Response(new ReadableStream({ cancel })));
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    } finally { vi.useRealTimers(); }
  });

  it('times out stalled bodies without waiting for a stalled cancellation', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream({ cancel });
    const fetchImpl = vi.fn(async () => new Response(body));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = auditCloudflareMetrics({ token: TOKEN, now: NOW, fetchImpl });
      await vi.waitFor(() => expect(body.locked).toBe(true));
      await vi.advanceTimersByTimeAsync(DEADLINE_MS);
      expect((await pending).reason).toBe('audit_deadline');
      expect(cancel).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});

const workflow = load(readFileSync(new URL('../.github/workflows/cloudflare-read-only-audit.yml', import.meta.url), 'utf8')) as any;
function assertAuditPolicy(value: any) {
  assert.deepEqual(value.on, { workflow_dispatch: null });
  assert.deepEqual(value.permissions, { contents: 'read' });
  assert.equal(value.env, undefined);
  assert.deepEqual(Object.keys(value.jobs), ['audit']);
  const job = value.jobs.audit;
  assert.equal(job.if, "${{ github.event_name == 'workflow_dispatch' && github.repository == 'useorgx/orgx-mcp' && github.ref == 'refs/heads/main' }}");
  assert.equal(job.environment, 'production');
  assert.equal(job['timeout-minutes'], 3);
  assert.equal(job.env, undefined);
  assert.equal(job.steps.length, 5);
  assert.equal(job.steps[0].run.trim(), "set -euo pipefail\ntest \"$GITHUB_REF\" = 'refs/heads/main'\ntest \"$GITHUB_REPOSITORY\" = 'useorgx/orgx-mcp'");
  assert.equal(job.steps[1].uses, 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');
  assert.deepEqual(job.steps[1].with, { ref: '${{ github.sha }}', 'persist-credentials': false });
  assert.equal(job.steps[2].uses, 'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38');
  assert.deepEqual(job.steps[2].with, { 'node-version': '22', 'package-manager-cache': false });
  assert.equal(job.steps[3].run, 'node scripts/cloudflare-read-only-audit.mjs');
  assert.equal(job.steps[3]['timeout-minutes'], 1);
  assert.deepEqual(job.steps[3].env, { CLOUDFLARE_API_TOKEN: '${{ secrets.CF_API_TOKEN }}' });
  assert.equal(job.steps[4].uses, 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02');
  assert.equal(job.steps[4].if, 'always()');
  assert.deepEqual(job.steps[4].with, { name: 'cloudflare-aggregate-metrics', path: OUTPUT_PATH, 'if-no-files-found': 'ignore', 'retention-days': 1 });
  const outsideAudit = structuredClone(value); delete outsideAudit.jobs.audit.steps[3].env;
  assert.doesNotMatch(JSON.stringify(outsideAudit), /secrets\./);
  assert.doesNotMatch(JSON.stringify(value), /wrangler|workflow_call|pull_request_target|inputs\./);
}

describe('read-only Cloudflare audit workflow admission', () => {
  it('binds the existing token only to the fixed main-branch audit step', () => assertAuditPolicy(workflow));
  it.each([
    (value: any) => { value.jobs.audit.if = '${{ github.ref != null }}'; },
    (value: any) => { value.on.workflow_dispatch = { inputs: { query: { type: 'string' } } }; },
    (value: any) => { value.jobs.audit.steps[1].with.ref = '${{ github.ref }}'; },
    (value: any) => { value.jobs.audit.steps[1].with['persist-credentials'] = true; },
    (value: any) => { value.jobs.audit.env = { CLOUDFLARE_API_TOKEN: '${{ secrets.CF_API_TOKEN }}' }; },
    (value: any) => { value.jobs.audit.steps[3].run = 'pnpm wrangler deploy'; },
    (value: any) => { value.jobs.audit.steps[4].with.path = 'artifacts/**'; },
    (value: any) => { value.permissions = { contents: 'write' }; },
  ])('rejects a broadened workflow policy %#', (mutate) => {
    const changed = structuredClone(workflow); mutate(changed);
    expect(() => assertAuditPolicy(changed)).toThrow();
  });
});
