import { createHash } from 'node:crypto';

export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
}

export function packetPayload(packet) {
  const { content_digest: _digest, ...payload } = packet;
  return payload;
}

export function verifyPacket(packet) {
  const failures = [];
  if (packet.schema !== 'orgx.agentic-scale-proof.v1') failures.push('unsupported_schema');
  if (sha256(packetPayload(packet)) !== packet.content_digest) failures.push('content_digest_mismatch');

  const missingEvidence = packet.expected_evidence
    .filter((item) => item.required && !item.observed_ref)
    .map((item) => item.id);
  if (missingEvidence.length > 0) failures.push(`missing_required_evidence:${missingEvidence.join(',')}`);

  const unaccountedBranches = packet.branches
    .filter((branch) => branch.material && (!branch.disposition || (branch.disposition === 'adopted' && !branch.selection_receipt_ref)))
    .map((branch) => branch.id);
  if (unaccountedBranches.length > 0) failures.push(`unaccounted_branches:${unaccountedBranches.join(',')}`);

  const assurance = packet.assurance;
  for (const dependency of Object.keys(assurance.digests)) {
    if (assurance.digests[dependency] !== packet.current_digests[dependency]) {
      failures.push(`stale_assurance:${dependency}`);
    }
  }
  if (Date.parse(assurance.expires_at) <= Date.parse(packet.verified_at)) failures.push('expired_assurance');
  if (!packet.expectation.observation_ref || packet.expectation.state !== 'outcome_realized') {
    failures.push('outcome_not_closed');
  }

  return { valid: failures.length === 0, failures };
}

