import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

// These are reviewed deployment constants, never CLI/workflow/env inputs.
export const ACCOUNT_ID = '5e0f62b0acf89dd1493ff769187814c4';
export const SCRIPT_NAME = 'orgx-mcp-production';
export const API_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
export const WINDOW_MS = 60 * 60_000;
export const DEADLINE_MS = 10_000;
export const MAX_RESPONSE_BYTES = 65_536;
export const OUTPUT_PATH = 'artifacts/qa/cloudflare-metrics-audit/report.json';

// Documented Workers analytics fields. No log, request, URL, tool or identity fields.
export const QUERY = `query OrgXMcpAggregateAudit($accountTag: string, $scriptName: string, $start: string, $end: string) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      totals: workersInvocationsAdaptive(limit: 1, filter: {scriptName: $scriptName, datetime_geq: $start, datetime_leq: $end}) {
        sum { requests errors subrequests }
        quantiles { cpuTimeP50 cpuTimeP99 }
      }
      outcomes: workersInvocationsAdaptive(limit: 16, filter: {scriptName: $scriptName, datetime_geq: $start, datetime_leq: $end}) {
        sum { requests errors }
        dimensions { status }
      }
    }
  }
}`;

const OUTCOME_LABELS = Object.freeze({
  success: 'Worker completed', canceled: 'Client disconnected',
  exception: 'Unhandled exception', exceededResources: 'Resources exceeded',
  internalError: 'Internal error',
});
const emptyMetrics = () => ({ requests: null, errors: null, subrequests: null, cpuTimeP50: null, cpuTimeP99: null });
const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};

function baseReport(now) {
  return {
    schema: 'orgx.cloudflare.aggregate-audit.v1', status: 'unavailable',
    reason: 'not_observed', accountId: ACCOUNT_ID, scriptName: SCRIPT_NAME,
    window: { start: new Date(now - WINDOW_MS).toISOString(), end: new Date(now).toISOString() },
    metrics: emptyMetrics(), outcomes: [], outcomesMayBeTruncated: null,
    dataBoundary: 'Sampled numeric Worker aggregates only. No retained log contents or request/business data.',
    performanceBoundary: 'CPU quantiles retain Cloudflare provider units; they are not end-to-end tool latency.',
  };
}

function readMetrics(payload, report) {
  const raw = record(payload);
  if (Array.isArray(raw.errors) && raw.errors.length) {
    // Classify in memory, but never print or retain provider messages/payloads.
    const messages = raw.errors.map((error) => record(error).message).filter((message) => typeof message === 'string');
    const denied = messages.some((message) => /not authori[sz]ed|permission|forbidden|unauthori[sz]ed|authentication|authorization/i.test(message));
    return { ...report, status: denied ? 'permission_denied' : 'query_refused', reason: denied ? 'cloudflare_permission_denied' : 'cloudflare_query_refused' };
  }
  const accounts = record(record(raw.data).viewer).accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) return { ...report, reason: 'invalid_aggregate_response' };
  const { totals, outcomes } = record(accounts[0]);
  if (!Array.isArray(totals) || totals.length > 1 || !Array.isArray(outcomes) || outcomes.length > 16) {
    return { ...report, reason: 'invalid_aggregate_response' };
  }
  if (!totals.length) return { ...report, status: 'no_data', reason: 'no_matching_analytics_rows' };
  const sum = record(record(totals[0]).sum);
  const quantiles = record(record(totals[0]).quantiles);
  const metrics = {
    requests: number(sum.requests), errors: number(sum.errors), subrequests: number(sum.subrequests),
    cpuTimeP50: number(quantiles.cpuTimeP50), cpuTimeP99: number(quantiles.cpuTimeP99),
  };
  const groups = new Map();
  for (const outcome of outcomes) {
    const row = record(outcome);
    const status = record(row.dimensions).status;
    const label = typeof status === 'string' && Object.hasOwn(OUTCOME_LABELS, status) ? OUTCOME_LABELS[status] : 'Other status';
    const counts = record(row.sum);
    const requests = number(counts.requests), errors = number(counts.errors);
    // Missing values stay unknown, rather than becoming zero through addition.
    const prior = groups.get(label);
    groups.set(label, {
      label,
      requests: prior ? prior.requests === null || requests === null ? null : number(prior.requests + requests) : requests,
      errors: prior ? prior.errors === null || errors === null ? null : number(prior.errors + errors) : errors,
    });
  }
  const complete = Object.values(metrics).every((value) => value !== null);
  return {
    ...report, status: complete ? 'observed' : 'partial', reason: complete ? 'aggregates_observed' : 'some_metrics_unavailable',
    metrics, outcomes: [...groups.values()], outcomesMayBeTruncated: outcomes.length === 16,
  };
}

/** One fixed, read-only query. No retries, redirects, introspection or raw log reads. */
export async function auditCloudflareMetrics({ token, fetchImpl = fetch, now = Date.now() } = {}) {
  const report = baseReport(now);
  if (typeof token !== 'string' || !token.trim()) return { ...report, reason: 'credential_unavailable' };
  const controller = new AbortController();
  const expiresAt = performance.now() + DEADLINE_MS;
  let reader, ended = false, timer;
  const check = () => {
    if (controller.signal.aborted || performance.now() >= expiresAt) throw new Error('audit_deadline');
  };
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('audit_deadline')); }, DEADLINE_MS);
  });
  try {
    return await Promise.race([(async () => {
      const response = await fetchImpl(API_ENDPOINT, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { authorization: `Bearer ${token.trim()}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query: QUERY, variables: {
          accountTag: ACCOUNT_ID, scriptName: SCRIPT_NAME, start: report.window.start, end: report.window.end,
        } }),
      });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error('audit_deadline');
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        return { ...report, status: [401, 403].includes(response.status) ? 'permission_denied' : 'unavailable',
          reason: [401, 403].includes(response.status) ? 'cloudflare_api_access_denied' : 'cloudflare_http_error', httpStatus: response.status };
      }
      reader = response.body?.getReader();
      if (!reader) return { ...report, reason: 'empty_api_response' };
      const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
      let length = 0;
      for (;;) {
        check();
        const chunk = await reader.read();
        check();
        if (chunk.done) { ended = true; break; }
        if (length + chunk.value.byteLength > MAX_RESPONSE_BYTES) return { ...report, reason: 'response_byte_limit' };
        bytes.set(chunk.value, length); length += chunk.value.byteLength;
      }
      let payload;
      try { payload = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length))); }
      catch { return { ...report, reason: 'invalid_api_json' }; }
      return readMetrics(payload, report);
    })(), deadline]);
  } catch {
    return { ...report, reason: controller.signal.aborted || performance.now() >= expiresAt ? 'audit_deadline' : 'network_unavailable' };
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) {
      if (!ended) void reader.cancel('Aggregate audit finished').catch(() => undefined);
      reader.releaseLock();
    }
  }
}

export function formatAuditSummary(report) {
  const value = (number) => number === null ? 'Unknown' : String(number);
  return `## Cloudflare aggregate metrics audit\n\n` +
    `Status: **${report.status}** (${report.reason}).\n\n` +
    `Worker: ${SCRIPT_NAME}. Window: ${report.window.start} to ${report.window.end}.\n\n` +
    `| Measurement | Provider value |\n| --- | --- |\n` +
    `| Requests | ${value(report.metrics.requests)} |\n| Errors | ${value(report.metrics.errors)} |\n` +
    `| Subrequests | ${value(report.metrics.subrequests)} |\n| CPU time p50 | ${value(report.metrics.cpuTimeP50)} |\n` +
    `| CPU time p99 | ${value(report.metrics.cpuTimeP99)} |\n\n` +
    `${report.dataBoundary}\n\n${report.performanceBoundary}\n`;
}

async function main() {
  const report = await auditCloudflareMetrics({ token: process.env.CLOUDFLARE_API_TOKEN });
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(report, null, 2) + '\n');
  const summary = formatAuditSummary(report);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(`Cloudflare aggregate metrics audit: ${report.status} (${report.reason}).`);
  if (report.status !== 'observed') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Cloudflare aggregate metrics audit could not save its sanitized report.'); process.exitCode = 1; });
}
