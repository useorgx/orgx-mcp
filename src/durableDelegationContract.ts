/**
 * Durable delegation response contract.
 *
 * Delegation is successful only when the canonical release returns distinct
 * durable task/run/job IDs and evidence that the job was claimed for execution.
 */
export const DURABLE_DELEGATION_CONTRACT = 'durable_delegation_v2';

export type DurableDelegationContractResult =
  | {
      ok: true;
      taskId: string;
      runId: string;
      jobId: string;
      dispatchReceipt: Record<string, unknown>;
    }
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
  payload: unknown
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

  const taskId = readNonEmptyString(data, 'task_id');
  const runId = readNonEmptyString(data, 'run_id');
  const jobId = readNonEmptyString(data, 'job_id');
  if (!taskId || !runId || !jobId) {
    return {
      ok: false,
      message:
        'Delegation was not confirmed by the canonical OrgX release. Its durable task, run, or job receipt is missing.',
    };
  }

  if (
    taskId === runId ||
    taskId.startsWith('api-') ||
    runId.startsWith('api-') ||
    jobId.startsWith('api-')
  ) {
    return {
      ok: false,
      message:
        'Delegation was rejected because the upstream returned a synthetic execution identifier instead of durable receipts.',
    };
  }

  const dispatchReceipt = asRecord(data.dispatch_receipt);
  if (
    dispatchReceipt?.dispatch !== 'inline_claimed' ||
    dispatchReceipt.jobStatus !== 'running'
  ) {
    return {
      ok: false,
      message:
        'Delegation was not confirmed because the durable job was not claimed for execution.',
    };
  }

  return { ok: true, taskId, runId, jobId, dispatchReceipt };
}
