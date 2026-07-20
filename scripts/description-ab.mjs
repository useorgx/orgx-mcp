#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateSelectionThresholds,
  fetchMcpToolsList,
  fixturesForProfile,
  providersFromEnvironment,
  runSelectionSuite,
} from './agent-selection-runner.mjs';

if (process.env.RUN_AGENT_SELECTION_TESTS !== '1') {
  throw new Error(
    'Description A/B calls live model providers. Set RUN_AGENT_SELECTION_TESTS=1 to authorize it.'
  );
}
if (!process.env.AGENT_SELECTION_DESCRIPTION_VARIANTS) {
  throw new Error(
    'Set AGENT_SELECTION_DESCRIPTION_VARIANTS to a JSON file containing {"variants":[{"id":"candidate","descriptions":{"tool_id":"..."}}]}.'
  );
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..');
const fixtureFile = JSON.parse(
  await readFile(resolve(root, 'tests', 'fixtures', 'agentIntents.json'), 'utf8')
);
const variantFile = JSON.parse(
  await readFile(resolve(root, process.env.AGENT_SELECTION_DESCRIPTION_VARIANTS), 'utf8')
);
if (!Array.isArray(variantFile.variants) || variantFile.variants.length === 0) {
  throw new Error('Description variant file must include a non-empty variants array.');
}

const profile = process.env.AGENT_SELECTION_PROFILE ?? 'v2';
const manifest = await fetchMcpToolsList({
  endpoint:
    process.env.MCP_SELECTION_URL ?? 'https://mcp.useorgx.com/mcp',
  profile,
  accessToken: process.env.MCP_ACCESS_TOKEN,
});
const providers = providersFromEnvironment();
const profileFixtures = fixturesForProfile(fixtureFile.fixtures, profile);
const variants = [
  { id: 'baseline', descriptions: {} },
  ...variantFile.variants,
];
const reports = [];

for (const variant of variants) {
  const tools = manifest.tools.map((tool) => ({
    ...tool,
    description: variant.descriptions?.[tool.name] ?? tool.description,
  }));
  const report = await runSelectionSuite({
    fixtures: profileFixtures,
    tools,
    providers,
    iterations: Number(process.env.AGENT_SELECTION_ITERATIONS ?? 10),
    concurrency: Number(process.env.AGENT_SELECTION_CONCURRENCY ?? 3),
    profile,
    manifest: {
      variant_id: variant.id,
      endpoint: manifest.endpoint,
      tools_list_response_bytes: manifest.tools_list_response_bytes,
    },
  });
  reports.push({
    variant_id: variant.id,
    metrics: report.metrics,
    evaluation: evaluateSelectionThresholds(report),
    report,
  });
}

const summary = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  profile,
  variants: reports.map(({ variant_id, metrics, evaluation }) => ({
    variant_id,
    top_1_accuracy: metrics.top_1_accuracy,
    forbidden_confusion_rate: metrics.forbidden_confusion_rate,
    argument_validity_rate: metrics.argument_validity_rate,
    calls_per_success: metrics.calls_per_success,
    p95_latency_ms: metrics.latency_ms.p95,
    request_bytes: metrics.bytes.request_total,
    evaluation,
  })),
  reports: reports.map(({ report }) => report),
};
const safeTimestamp = summary.generated_at.replace(/[:.]/g, '-');
const outputPath = resolve(
  root,
  process.env.AGENT_SELECTION_REPORT_PATH ??
    `artifacts/agent-selection/description-ab-${safeTimestamp}.json`
);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ report_path: outputPath, ...summary }, null, 2)}\n`);
