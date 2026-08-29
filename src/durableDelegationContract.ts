/**
 * Durable delegation response contract.
 *
 * Delegated work is a state-changing operation. A successful HTTP response is
 * not sufficient evidence that it reached the canonical release: older API
 * planes accepted the request and returned a synthetic `api-*` parent run.
 * Require a versioned receipt that binds the durable task and child run.
 */

export const DURABLE_DELEGATION_CONTRACT = 'durable_delegation_v1';

export type DurableDelegationContractResult =
  | {
      ok: true;
      taskId: string;
      runId: string;
    }
  | {
      ok: false;
      message: string;
    };

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
 * Validate the response to spawn/handoff before the MCP server reports success.
 *
 * A missing contract is deliberately rejected: it means the request may have
 * hit an older deployment. We do not retry it against a fallback origin because
 * that could dispatch the same paid action in another data plane.
 */
export function validateDurableDelegationResponse(
  payload: unknown
): DurableDelegationContractResult {
  const envelope =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  const data =
    envelope?.data &&
    typeof envelope.data === 'object' &&
    !Array.isArray(envelope.data)
      ? (envelope.data as Record<string, unknown>)
      : envelope;

  if (!data) {
    return {
      ok: false,
      message:
        'Delegation was not confirmed by the canonical OrgX release. No durable delegation receipt was returned.',
    };
  }

  if (readNonEmptyString(data, 'delegation_contract') !== DURABLE_DELEGATION_CONTRACT) {
    return {
      ok: false,
      message:
        'Delegation was not confirmed by the canonical OrgX release. The upstream response did not provide the durable delegation contract.',
    };
  }

  const taskId = readNonEmptyString(data, 'task_id');
  const runId = readNonEmptyString(data, 'run_id');
  if (!taskId || !runId) {
    return {
      ok: false,
      message:
        'Delegation was not confirmed by the canonical OrgX release. Its durable task or run receipt is missing.',
    };
  }

  if (taskId === runId || taskId.startsWith('api-') || runId.startsWith('api-')) {
    return {
      ok: false,
      message:
        'Delegation was rejected because the upstream returned a synthetic execution identifier instead of distinct durable task and run receipts.',
    };
  }

  return { ok: true, taskId, runId };
}
