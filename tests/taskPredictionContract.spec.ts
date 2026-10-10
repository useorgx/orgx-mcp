import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CONTRACT_TOOL_DEFINITIONS } from '../src/contractTools';
import { getToolOutputSchema } from '../src/openaiOutputSchemas';
import { buildTaskPredictionRequest, TASK_PREDICTIONS_V1_PATH } from '../src/taskPredictionContract';
import { TASK_PREDICTION_INPUT, TASK_PREDICTION_RESPONSE, TASK_PREDICTION_WORKSPACE_ID } from './fixtures/taskPrediction';

describe('task prediction request contract', () => {
  it('binds one pre-action prediction to the exact agreed set version and stable retry key', () => {
    const built = buildTaskPredictionRequest({ ...TASK_PREDICTION_INPUT, expected_outcome: '  Tests pass  ',
      idempotency_key: '  stable-retry  ' }, { workspaceId: TASK_PREDICTION_WORKSPACE_ID });
    expect(built).toEqual({ ok: true, path: TASK_PREDICTIONS_V1_PATH, idempotencyKey: 'stable-retry', body: {
      workspace_id: TASK_PREDICTION_WORKSPACE_ID,
      task_id: TASK_PREDICTION_INPUT.task_id,
      expectation_set_id: TASK_PREDICTION_INPUT.expectation_set_id,
      expectation_set_version: 3,
      expected_outcome: 'Tests pass', confidence: 0.9,
      criteria_predictions: TASK_PREDICTION_INPUT.criteria_predictions,
    } });
  });

  it.each([
    ['idempotency_key', undefined], ['idempotency_key', '   '], ['idempotency_key', 'x'.repeat(201)],
    ['task_id', 'not-a-uuid'], ['expectation_set_id', undefined],
    ['expectation_set_version', 0], ['expectation_set_version', 1.5],
    ['expected_outcome', ' '], ['expected_outcome', 'x'.repeat(501)],
    ['confidence', -0.1], ['confidence', 1.1], ['confidence', Number.NaN],
    ['criteria_predictions', []],
    ['criteria_predictions', [{ criterion_id: 'check', predicted: 'unknown', confidence: 0.8 }]],
    ['criteria_predictions', [{ criterion_id: 'check', predicted: 'met', confidence: Infinity }]],
    ['criteria_predictions', [{ criterion_id: 'check', predicted: 'met', confidence: 0.8 },
      { criterion_id: ' check ', predicted: 'unmet', confidence: 0.3 }]],
    ['criteria_predictions', Array.from({ length: 51 }, (_, i) => ({ criterion_id: `check-${i}`, predicted: 'met', confidence: 0.5 }))],
  ])('rejects invalid %s before calling the API', (field, value) => {
    const result = buildTaskPredictionRequest({ ...TASK_PREDICTION_INPUT, [field]: value }, { workspaceId: TASK_PREDICTION_WORKSPACE_ID });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field.split('.')[0]).toBe(field);
  });

  it('rejects workspace mismatch inputs that cannot be bound to a workspace UUID', () => {
    expect(buildTaskPredictionRequest(TASK_PREDICTION_INPUT, { workspaceId: 'other' })).toMatchObject({ ok: false, field: 'workspace_id' });
  });

  it('advertises both modes without requiring metric fields for task predictions', () => {
    const definition = CONTRACT_TOOL_DEFINITIONS.find((tool) => tool.id === 'orgx_expect')!;
    const input = z.object(definition.inputSchema);
    expect(input.parse(TASK_PREDICTION_INPUT)).toEqual(TASK_PREDICTION_INPUT);
    expect(input.safeParse({ ...TASK_PREDICTION_INPUT, mode: 'arbitrary_metric' }).success).toBe(false);
    expect(input.safeParse({ ...TASK_PREDICTION_INPUT, confidence: 2 }).success).toBe(false);
    expect(input.safeParse({ metric: 'orgx.run_receipt_coverage.v1', window_starts_at: '2026-10-10T14:00:00Z',
      window_ends_at: '2026-10-11T14:00:00Z' }).success).toBe(true);
  });

  it('declares the exact pending prediction and rejects unsupported assurance claims', () => {
    const output = getToolOutputSchema('orgx_expect')!;
    expect(output.safeParse({ _v2_tool: 'orgx_expect', prediction: TASK_PREDICTION_RESPONSE, replayed: false,
      idempotency_key: TASK_PREDICTION_INPUT.idempotency_key }).success).toBe(true);
    expect(output.safeParse({ prediction: { ...TASK_PREDICTION_RESPONSE, state: 'verified' } }).success).toBe(false);
    expect(output.safeParse({ prediction: { ...TASK_PREDICTION_RESPONSE, contract_hash: 'invalid' } }).success).toBe(false);
    expect(output.safeParse({ prediction: { ...TASK_PREDICTION_RESPONSE, confidence: 2 } }).success).toBe(false);
  });
});
