import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { packetPayload, sha256 } from './agentic-scale-proof-lib.mjs';

const fixture = resolve('docs/benchmarks/agentic-scale-proof/fixtures/proof-packet.json');
const original = JSON.parse(await readFile(fixture, 'utf8'));
const cases = {
  tampered_content: (packet) => {
    packet.nodes[0].kind = 'outcome';
  },
  missing_evidence: (packet) => {
    delete packet.expected_evidence[0].observed_ref;
  },
  hidden_branch: (packet) => {
    packet.branches.push({ id: 'candidate-hidden', material: true });
  },
  stale_policy: (packet) => {
    packet.current_digests.policy = 'sha256:quality-policy-v3';
  },
  expired_assurance: (packet) => {
    packet.verified_at = '2026-08-28T16:00:00.000Z';
  },
  missing_outcome_observation: (packet) => {
    delete packet.expectation.observation_ref;
  },
};

for (const [name, mutate] of Object.entries(cases)) {
  const packet = structuredClone(original);
  mutate(packet);
  // Tamper tests intentionally preserve the old digest; semantic negative
  // tests receive a correct new digest so the verifier must catch semantics.
  if (name !== 'tampered_content') packet.content_digest = sha256(packetPayload(packet));
  const path = join(tmpdir(), `orgx-agentic-scale-${name}.json`);
  await writeFile(path, JSON.stringify(packet));

  for (const [implementation, command, args] of [
    ['javascript', process.execPath, ['scripts/verify-agentic-scale-proof.mjs', path]],
    ['python', 'python3', ['scripts/verify_agentic_scale_proof.py', path]],
  ]) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.status === 0) throw new Error(`${implementation} verifier accepted ${name}`);
  }
}

console.log(`Both verifier implementations rejected ${Object.keys(cases).length} adversarial packets.`);

