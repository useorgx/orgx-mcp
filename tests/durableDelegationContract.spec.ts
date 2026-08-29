import { describe, expect, it } from 'vitest';

import {
  DURABLE_DELEGATION_CONTRACT,
  validateDurableDelegationResponse,
} from '../src/durableDelegationContract';

const claimedData = {
  delegation_contract: DURABLE_DELEGATION_CONTRACT,
  task_id: 'task-123',
  run_id: 'run-456',
  job_id: 'job-789',
  dispatch_receipt: {
    dispatch: 'inline_claimed',
    jobStatus: 'running',
    acceptedAt: '2026-08-29T00:00:00.000Z',
  },
};

describe('validateDurableDelegationResponse', () => {
  it('accepts distinct durable IDs with a claimed job receipt', () => {
    expect(
      validateDurableDelegationResponse({ ok: true, data: claimedData })
    ).toMatchObject({
      ok: true,
      taskId: 'task-123',
      runId: 'run-456',
      jobId: 'job-789',
      dispatchReceipt: {
        dispatch: 'inline_claimed',
        jobStatus: 'running',
      },
    });
  });

  it('rejects stale and synthetic contracts', () => {
    expect(
      validateDurableDelegationResponse({
        data: { ...claimedData, delegation_contract: 'durable_delegation_v1' },
      }).ok
    ).toBe(false);
    expect(
      validateDurableDelegationResponse({
        data: { ...claimedData, task_id: 'api-parent' },
      }).ok
    ).toBe(false);
  });

  it('rejects missing job evidence', () => {
    expect(
      validateDurableDelegationResponse({
        data: { ...claimedData, job_id: undefined },
      }).ok
    ).toBe(false);
    expect(
      validateDurableDelegationResponse({
        data: { ...claimedData, dispatch_receipt: undefined },
      }).ok
    ).toBe(false);
  });

  it('rejects queued or rejected dispatches', () => {
    expect(
      validateDurableDelegationResponse({
        data: {
          ...claimedData,
          dispatch_receipt: {
            dispatch: 'cloud_enqueued',
            jobStatus: 'queued',
          },
        },
      }).ok
    ).toBe(false);
    expect(
      validateDurableDelegationResponse({
        data: {
          ...claimedData,
          dispatch_receipt: {
            dispatch: 'dispatch_rejected',
            jobStatus: 'queued',
          },
        },
      }).ok
    ).toBe(false);
  });
});
