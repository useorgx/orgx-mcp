import { describe, expect, it } from 'vitest';

import {
  AUTOMATIC_SESSION_CAPTURE_PATH,
  METRIC_EXPECTATIONS_V1_PATH,
  RUN_RECEIPT_COVERAGE_REGISTRY_ID,
  buildMetricExpectationRequest,
} from '../src/metricExpectationContract';

const WORKSPACE_ID = '7af01a51-49b1-47d8-98b9-91a198debca8';

describe('buildMetricExpectationRequest', () => {
  const baseArgs = {
    metric: RUN_RECEIPT_COVERAGE_REGISTRY_ID,
    window_starts_at: '2026-08-22T03:00:00.000Z',
    window_ends_at: '2026-08-23T03:00:00.000Z',
  };

  it('builds the exact receipt-coverage expectation with honest defaults', () => {
    const built = buildMetricExpectationRequest(
      { ...baseArgs, idempotency_key: 'receipt-coverage:2026-08-22' },
      { workspaceId: WORKSPACE_ID }
    );

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.path).toBe(METRIC_EXPECTATIONS_V1_PATH);
    expect(built.idempotencyKey).toBe('receipt-coverage:2026-08-22');
    expect(built.body).toEqual({
      workspace_id: WORKSPACE_ID,
      subject_ref: { type: 'workspace', id: WORKSPACE_ID },
      metric_ref: {
        registry_id: RUN_RECEIPT_COVERAGE_REGISTRY_ID,
        query_version: '1',
        parameters: {
          workspace_id: WORKSPACE_ID,
          capture_path: AUTOMATIC_SESSION_CAPTURE_PATH,
          exclude_benchmark: true,
          receipt_deadline_seconds: 60,
        },
      },
      predicate: { operator: 'gte', threshold: 0.95 },
      window: {
        starts_at: '2026-08-22T03:00:00.000Z',
        ends_at: '2026-08-23T03:00:00.000Z',
      },
      minimum_sample_size: 20,
      evaluation_interval_seconds: 300,
    });
  });

  it('accepts bounded observer parameters and generates a retry key', () => {
    const built = buildMetricExpectationRequest(
      {
        ...baseArgs,
        threshold: 0.99,
        minimum_sample_size: 100,
        receipt_deadline_seconds: 120,
        evaluation_interval_seconds: 600,
      },
      { workspaceId: WORKSPACE_ID }
    );

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.idempotencyKeyGenerated).toBe(true);
    expect(built.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(built.body.predicate.threshold).toBe(0.99);
    expect(built.body.minimum_sample_size).toBe(100);
    expect(built.body.metric_ref.parameters.receipt_deadline_seconds).toBe(120);
    expect(built.body.evaluation_interval_seconds).toBe(600);
  });

  it('rejects unsupported observers instead of accepting natural-language matching', () => {
    const built = buildMetricExpectationRequest(
      { ...baseArgs, metric: 'github.pr_merge.v1' },
      { workspaceId: WORKSPACE_ID }
    );

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.field).toBe('metric');
    expect(built.message).toContain('no other observer is registered');
  });

  it.each([
    ['workspace_id', baseArgs, 'not-a-uuid'],
    [
      'window_starts_at',
      { ...baseArgs, window_starts_at: 'tomorrow' },
      WORKSPACE_ID,
    ],
    [
      'window_ends_at',
      { ...baseArgs, window_ends_at: baseArgs.window_starts_at },
      WORKSPACE_ID,
    ],
    ['threshold', { ...baseArgs, threshold: 1.01 }, WORKSPACE_ID],
    [
      'minimum_sample_size',
      { ...baseArgs, minimum_sample_size: 0 },
      WORKSPACE_ID,
    ],
    [
      'receipt_deadline_seconds',
      { ...baseArgs, receipt_deadline_seconds: 3601 },
      WORKSPACE_ID,
    ],
    [
      'evaluation_interval_seconds',
      { ...baseArgs, evaluation_interval_seconds: 59 },
      WORKSPACE_ID,
    ],
  ])('rejects invalid %s before calling the API', (field, args, workspaceId) => {
    const built = buildMetricExpectationRequest(args, { workspaceId });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.field).toBe(field);
  });
});
