/**
 * Durable delegation response contract.
 *
 * Delegation is successful only when the canonical release returns distinct
 * durable task/run/job IDs and evidence that the job was claimed for execution.
 */
import { DURABLE_DELEGATION_CONTRACT, readClaimedDelegationEvidence, type ClaimedDelegationEvidence } from './generated/durableDelegation';
export { DURABLE_DELEGATION_CONTRACT } from './generated/durableDelegation';

export type DurableDelegationContractResult =
  | ({ ok: true } & ClaimedDelegationEvidence)
  | { ok: true; reassigned: true; taskId: string; agentId: string }
  | {
      ok: false;
      message: string;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonEmptyString(
  record: Record<string, unknown>,
  key: string
): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * Validate spawn/handoff before MCP reports success. A missing or stale
 * contract is rejected without fallback because replay could duplicate paid work.
 */
export function validateDurableDelegationResponse(
  payload: unknown,
  reassignment?: { taskId: string }
): DurableDelegationContractResult {
  const envelope = asRecord(payload);
  const data = asRecord(envelope?.data) ?? envelope;
  if (!data) {
    return {
      ok: false,
      message:
        'Delegation was not confirmed by the canonical OrgX release. No durable delegation receipt was returned.',
    };
  }

  if (reassignment) {
    const taskId = readNonEmptyString(data, 'task_id');
    const agentId = readNonEmptyString(data, 'agent_id');
    if (taskId === reassignment.taskId && agentId && !data.run_id && !data.job_id) {
      return { ok: true, reassigned: true, taskId, agentId };
    }
    return { ok: false, message: 'Task reassignment was not confirmed for the requested task.' };
  }

  if (
    readNonEmptyString(data, 'delegation_contract') !==
    DURABLE_DELEGATION_CONTRACT
  ) {
    return {
      ok: false,
      message:
        'Delegation was not confirmed by the canonical OrgX release. The upstream response did not provide the claimed-dispatch contract.',
    };
  }

  const result = readClaimedDelegationEvidence(data);
  if (!result.ok) {
    const messages = {
      missing_ids: 'Delegation was not confirmed by the canonical OrgX release. Its durable run or job receipt is missing.',
      synthetic_ids: 'Delegation was rejected because the upstream returned a synthetic execution identifier instead of durable receipts.',
      unclaimed: 'Delegation was not confirmed because the durable job was not claimed for execution.',
    };
    return { ok: false, message: messages[result.reason] };
  }
  return { ok: true, ...result.evidence };
}
