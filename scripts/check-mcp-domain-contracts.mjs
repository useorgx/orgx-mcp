#!/usr/bin/env node
/** Check the pinned portable contract; optional --orgx-root checks live source. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const contracts = [
  { name: 'durableDelegation', version: 'durable_delegation_v2', fixture: 'durable-delegation-v2' },
  { name: 'scaffoldWorkflow', version: 'scaffold_workflow_v1', fixture: 'scaffold-workflow-v1' },
  { name: 'entityVocabulary', version: 'entity_vocabulary_v1', fixture: 'entity-vocabulary-v1' },
];
for (const contract of contracts) {
  const generated = readFileSync(resolve(root, `src/generated/${contract.name}.ts`), 'utf8');
  const manifest = JSON.parse(readFileSync(resolve(root, `src/generated/${contract.name}.manifest.json`), 'utf8'));
  const fixture = readFileSync(resolve(root, `tests/fixtures/${contract.fixture}.json`), 'utf8');
  const boundary = generated.indexOf('\n\n');
  if (boundary < 0 || manifest.contract !== contract.version ||
    manifest.repository !== 'hopeatina/orgx' ||
    manifest.source !== `orgx/packages/contracts/src/${contract.name}.ts` ||
    !/^[0-9a-f]{64}$/.test(manifest.source_sha256) ||
    !generated.slice(0, boundary).includes(`source_sha256: ${manifest.source_sha256}`) ||
    !generated.slice(boundary + 2).trim() || JSON.parse(fixture).length === 0 ||
    sha256(generated.slice(boundary + 2)) !== manifest.source_sha256 ||
    sha256(fixture) !== manifest.fixture_sha256) {
    throw new Error(`${contract.version} generated contract drift; regenerate from the pinned OrgX source`);
  }
}
const args = process.argv.slice(2);
const index = args.indexOf('--orgx-root');
if (index >= 0) {
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('--orgx-root requires an OrgX checkout path');
  execFileSync(process.execPath, [resolve(args[index + 1], 'orgx/scripts/generate-mcp-domain-contracts.mjs'), '--check', '--mcp-root', root], { stdio: 'inherit' });
}
console.log('Pinned MCP domain contracts checked.');
