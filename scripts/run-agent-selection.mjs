#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateSelectionThresholds,
  runLiveSelectionFromEnvironment,
} from './agent-selection-runner.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..');
const fixturePath = resolve(root, 'tests', 'fixtures', 'agentIntents.json');
const fixtureFile = JSON.parse(await readFile(fixturePath, 'utf8'));

const report = await runLiveSelectionFromEnvironment({
  fixtures: fixtureFile.fixtures,
});
const evaluation = evaluateSelectionThresholds(report, {
  expectedToolRate: Number(process.env.AGENT_SELECTION_EXPECTED_RATE ?? 0.7),
  forbiddenToolRate: Number(process.env.AGENT_SELECTION_FORBIDDEN_RATE ?? 0.1),
  argumentValidityRate: Number(
    process.env.AGENT_SELECTION_ARGUMENT_VALIDITY_RATE ?? 0.9
  ),
});
report.evaluation = evaluation;

const safeTimestamp = report.generated_at.replace(/[:.]/g, '-');
const outputPath = resolve(
  root,
  process.env.AGENT_SELECTION_REPORT_PATH ??
    `artifacts/agent-selection/agent-selection-${safeTimestamp}.json`
);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

process.stdout.write(
  `${JSON.stringify(
    {
      report_path: outputPath,
      profile: report.profile,
      providers: report.providers,
      metrics: report.metrics,
      evaluation,
    },
    null,
    2
  )}\n`
);

if (!evaluation.passed) process.exitCode = 1;
