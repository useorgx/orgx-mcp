#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const DEFAULT_BASE_URL = 'https://mcp.useorgx.com';
const DEFAULT_ITERATIONS = 10;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OUT = 'docs/benchmarks/mcp-performance-latest.json';

function readArg(name) {
  const prefix = `--${name}=`;
  const entry = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : undefined;
}

function readInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function percentile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, index)]);
}

function summarize(samples) {
  const latencies = samples
    .filter((sample) => sample.ok)
    .map((sample) => sample.latency_ms);
  const statuses = samples.reduce((acc, sample) => {
    const key = String(sample.status ?? 'error');
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const successCount = samples.filter((sample) => sample.ok).length;
  const totalBytes = samples.reduce(
    (sum, sample) => sum + (sample.response_bytes ?? 0),
    0
  );

  return {
    count: samples.length,
    success_count: successCount,
    success_rate: samples.length === 0 ? 0 : successCount / samples.length,
    statuses,
    min_ms: percentile(latencies, 0),
    p50_ms: percentile(latencies, 0.5),
    p95_ms: percentile(latencies, 0.95),
    p99_ms: percentile(latencies, 0.99),
    max_ms: percentile(latencies, 1),
    avg_ms:
      latencies.length === 0
        ? null
        : Math.round(
            latencies.reduce((sum, latency) => sum + latency, 0) /
              latencies.length
          ),
    avg_response_bytes:
      samples.length === 0 ? 0 : Math.round(totalBytes / samples.length),
  };
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      latency_ms: Math.round(performance.now() - startedAt),
      response_bytes: Buffer.byteLength(body),
    };
  } catch (error) {
    return {
      ok: false,
      status: 'exception',
      latency_ms: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.name : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function measureScenario(scenario, iterations, timeoutMs) {
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const request = scenario.request(index);
    samples.push(await fetchWithTimeout(request.url, request.init, timeoutMs));
  }
  return {
    name: scenario.name,
    description: scenario.description,
    target_p95_ms: scenario.target_p95_ms,
    samples,
    summary: summarize(samples),
  };
}

function jsonRpcBody(method, params, id) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    ...(params ? { params } : {}),
  });
}

const baseUrl = new URL(
  readArg('base-url') ?? process.env.MCP_BENCHMARK_BASE_URL ?? DEFAULT_BASE_URL
);
const iterations = readInt(
  readArg('iterations') ?? process.env.MCP_BENCHMARK_ITERATIONS,
  DEFAULT_ITERATIONS
);
const timeoutMs = readInt(
  readArg('timeout-ms') ?? process.env.MCP_BENCHMARK_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS
);
const outPath = resolve(
  readArg('out') ?? process.env.MCP_BENCHMARK_OUT ?? DEFAULT_OUT
);
const authToken = process.env.MCP_BENCHMARK_AUTH_TOKEN?.trim();

const publicHeaders = { 'content-type': 'application/json' };
const authHeaders = authToken
  ? { ...publicHeaders, authorization: `Bearer ${authToken}` }
  : null;

const scenarios = [
  {
    name: 'health',
    description: 'Edge health endpoint without MCP JSON-RPC overhead.',
    target_p95_ms: 150,
    request: () => ({
      url: new URL('/health', baseUrl).toString(),
      init: { method: 'GET' },
    }),
  },
  {
    name: 'server_json',
    description: 'Public server metadata discovery.',
    target_p95_ms: 100,
    request: () => ({
      url: new URL('/server.json', baseUrl).toString(),
      init: { method: 'GET' },
    }),
  },
  {
    name: 'public_tools_list',
    description: 'Unauthenticated public MCP tools/list discovery.',
    target_p95_ms: 150,
    request: (index) => ({
      url: new URL('/public', baseUrl).toString(),
      init: {
        method: 'POST',
        headers: publicHeaders,
        body: jsonRpcBody('tools/list', undefined, `public-tools-${index}`),
      },
    }),
  },
];

if (authHeaders) {
  scenarios.push({
    name: 'auth_tools_list',
    description: 'Authenticated MCP tools/list through the normal /mcp path.',
    target_p95_ms: 250,
    request: (index) => ({
      url: new URL('/mcp', baseUrl).toString(),
      init: {
        method: 'POST',
        headers: authHeaders,
        body: jsonRpcBody('tools/list', undefined, `auth-tools-${index}`),
      },
    }),
  });
}

const results = [];
for (const scenario of scenarios) {
  results.push(await measureScenario(scenario, iterations, timeoutMs));
}

const report = {
  generated_at: new Date().toISOString(),
  base_url: baseUrl.toString().replace(/\/$/, ''),
  iterations,
  timeout_ms: timeoutMs,
  node: process.version,
  authenticated_scenarios:
    authHeaders === null
      ? {
          skipped: true,
          reason:
            'Set MCP_BENCHMARK_AUTH_TOKEN to include authenticated /mcp scenarios.',
        }
      : { skipped: false },
  targets: {
    health_p95_ms: 150,
    server_json_p95_ms: 100,
    public_tools_list_p95_ms: 150,
    auth_tools_list_p95_ms: 250,
    scaffold_fast_ack_p95_ms: 1500,
  },
  scenarios: results,
};

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(`MCP benchmark: ${report.base_url}`);
console.log(`iterations=${iterations} timeout_ms=${timeoutMs}`);
for (const scenario of results) {
  const s = scenario.summary;
  const status = s.success_rate === 1 ? 'ok' : 'check';
  console.log(
    `${status.padEnd(5)} ${scenario.name.padEnd(20)} p50=${String(
      s.p50_ms
    ).padStart(4)}ms p95=${String(s.p95_ms).padStart(4)}ms max=${String(
      s.max_ms
    ).padStart(4)}ms success=${Math.round(s.success_rate * 100)}%`
  );
}
console.log(`wrote ${outPath}`);
