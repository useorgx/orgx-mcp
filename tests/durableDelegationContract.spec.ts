import { describe, expect, it } from 'vitest';

import {
  DURABLE_DELEGATION_CONTRACT,
  validateDurableDelegationResponse,
} from '../src/durableDelegationContract';

describe('validateDurableDelegationResponse', () => {
  it('accepts a versioned receipt with distinct durable task and run IDs', () => {
    expect(
      validateDurableDelegationResponse({
        ok: true,
        data: {
          delegation_contract: DURABLE_DELEGATION_CONTRACT,
          task_id: 'task-123',
          run_id: 'run-456',
        },
      })
    ).toEqual({ ok: true, taskId: 'task-123', runId: 'run-456' });
  });

  it('rejects a stale response that lacks the contract version', () => {
    const result = validateDurableDelegationResponse({
      ok: true,
      data: { task_id: 'task-123', run_id: 'run-456' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/contract/i);
  });

  it('rejects synthetic api parents even when other fields are present', () => {
    const result = validateDurableDelegationResponse({
      delegation_contract: DURABLE_DELEGATION_CONTRACT,
      task_id: 'api-parent',
      run_id: 'run-456',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/synthetic/i);
  });

  it('rejects aliased task/run IDs and missing receipts', () => {
    expect(
      validateDurableDelegationResponse({
        delegation_contract: DURABLE_DELEGATION_CONTRACT,
        task_id: 'same-id',
        run_id: 'same-id',
      }).ok
    ).toBe(false);
    expect(validateDurableDelegationResponse({ ok: true }).ok).toBe(false);
  });
});
