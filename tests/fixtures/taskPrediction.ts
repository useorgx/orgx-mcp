export const TASK_PREDICTION_WORKSPACE_ID = '7af01a51-49b1-47d8-98b9-91a198debca8';
export const TASK_PREDICTION_INPUT = {
  mode: 'task_prediction',
  task_id: '11111111-1111-4111-8111-111111111111',
  expectation_set_id: '22222222-2222-4222-8222-222222222222',
  expectation_set_version: 3,
  expected_outcome: 'The ledger contract tests pass for all five views',
  confidence: 0.9,
  criteria_predictions: [
    { criterion_id: 'ledger-search', predicted: 'met', confidence: 0.9 },
    { criterion_id: 'receipt-detail', predicted: 'met', confidence: 0.8 },
  ],
  idempotency_key: 'ledger-task-prediction:v3',
} as const;

// Exact response of lib/server/expectations/taskPrediction.ts in the app.
export const TASK_PREDICTION_RESPONSE = {
  workspace_id: TASK_PREDICTION_WORKSPACE_ID,
  task_id: TASK_PREDICTION_INPUT.task_id,
  expectation_set_id: TASK_PREDICTION_INPUT.expectation_set_id,
  expectation_set_version: TASK_PREDICTION_INPUT.expectation_set_version,
  expected_outcome: TASK_PREDICTION_INPUT.expected_outcome,
  confidence: TASK_PREDICTION_INPUT.confidence,
  criteria_predictions: TASK_PREDICTION_INPUT.criteria_predictions,
  id: '33333333-3333-4333-8333-333333333333',
  owner_id: '44444444-4444-4444-8444-444444444444',
  initiative_id: '55555555-5555-4555-8555-555555555555',
  contract_hash: 'a'.repeat(64),
  registered_at: '2026-10-09T14:00:00Z',
  state: 'pending',
} as const;
