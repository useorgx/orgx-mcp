import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { packetPayload, sha256 } from './agentic-scale-proof-lib.mjs';

const output = resolve(process.argv[2] ?? 'docs/benchmarks/agentic-scale-proof/fixtures/proof-packet.json');
const digests = {
  subject: 'sha256:accepted-artifact-commit-d0e1e73',
  context: 'sha256:context-manifest-v2',
  policy: 'sha256:quality-policy-v2',
  evaluator: 'sha256:reference-evaluator-v1',
  runtime: 'sha256:node-22-linux-x64',
  evidence: 'sha256:evidence-manifest-v2',
  independence: 'sha256:cross-language-verifier-set-v1',
};

const packet = {
  schema: 'orgx.agentic-scale-proof.v1',
  fixture_class: 'synthetic_contract_fixture',
  episode_id: 'episode-agentic-scale-proof-fixture',
  verified_at: '2026-08-26T16:00:00.000Z',
  nodes: [
    { id: 'intent-1', kind: 'commitment', source_ref: 'fixture://intent' },
    { id: 'decision-1', kind: 'decision', source_ref: 'fixture://decision' },
    { id: 'effect-1', kind: 'effect', source_ref: 'fixture://effect' },
    { id: 'acceptance-1', kind: 'acceptance', source_ref: 'fixture://acceptance' },
    { id: 'observation-1', kind: 'observation', source_ref: 'fixture://observation' },
  ],
  edges: [
    ['intent-1', 'decision-1'],
    ['decision-1', 'effect-1'],
    ['effect-1', 'acceptance-1'],
    ['acceptance-1', 'observation-1'],
  ],
  expected_evidence: [
    { id: 'authorization', required: true, observed_ref: 'fixture://authorization' },
    { id: 'native-receipt', required: true, observed_ref: 'fixture://receipt' },
    { id: 'external-effect', required: true, observed_ref: 'fixture://effect' },
    { id: 'acceptance', required: true, observed_ref: 'fixture://acceptance' },
    { id: 'outcome-observation', required: true, observed_ref: 'fixture://observation' },
  ],
  branches: [
    { id: 'candidate-a', material: true, disposition: 'rejected' },
    { id: 'candidate-b', material: true, disposition: 'adopted', selection_receipt_ref: 'fixture://selection' },
  ],
  assurance: {
    id: 'assurance-v2',
    digests,
    issued_at: '2026-08-26T15:00:00.000Z',
    expires_at: '2026-08-27T15:00:00.000Z',
  },
  current_digests: digests,
  expectation: {
    id: 'expectation-1',
    state: 'outcome_realized',
    observation_ref: 'fixture://observation',
  },
  transparency: {
    registration_ref: 'local-fixture-only',
    external_checkpoint: false,
  },
};
packet.content_digest = sha256(packetPayload(packet));

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(packet, null, 2)}\n`);
console.log(output);

