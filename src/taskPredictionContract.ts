import { z } from 'zod';

import { jsonValueSchema } from './openaiOutputSchemas/shared';
import type { MetricExpectationBuildError } from './metricExpectationContract';

export const TASK_PREDICTIONS_V1_PATH = '/api/v1/expectations/tasks';

export const criterionPredictionSchema = z.object({
  criterion_id: z.string().trim().min(1).max(200),
  predicted: z.enum(['met', 'unmet']),
  confidence: z.number().finite().min(0).max(1),
}).strict();

export const taskPredictionInputShape = {
  task_id: z.string().uuid(),
  expectation_set_id: z.string().uuid(),
  expectation_set_version: z.number().int().positive(),
  expected_outcome: z.string().trim().min(1).max(500),
  confidence: z.number().finite().min(0).max(1),
  criteria_predictions: z.array(criterionPredictionSchema).min(1).max(50)
    .superRefine((predictions, context) => {
      const seen = new Set<string>();
      predictions.forEach((prediction, index) => {
        if (seen.has(prediction.criterion_id)) context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'criterion_id'],
          message: 'Each criterion_id must occur once',
        });
        seen.add(prediction.criterion_id);
      });
    }),
};

const requestSchema = z.object({
  workspace_id: z.string().uuid(),
  ...taskPredictionInputShape,
}).strict();

// lib/server/expectations/taskPrediction.ts in the app returns the original
// pending prediction on both registration and idempotent replay.
export const taskPredictionOutputSchema = z.object({
  ...requestSchema.shape,
  id: z.string().uuid(),
  owner_id: z.string().uuid(),
  initiative_id: z.string().uuid(),
  contract_hash: z.string().regex(/^[0-9a-f]{64}$/),
  registered_at: z.string().datetime({ offset: true }),
  state: z.literal('pending'),
}).catchall(jsonValueSchema);

export type RegisterTaskPredictionRequest = {
  ok: true;
  path: typeof TASK_PREDICTIONS_V1_PATH;
  idempotencyKey: string;
  body: z.infer<typeof requestSchema>;
};

/** Bind a prediction to the persisted, agreed task criteria before work acts. */
export function buildTaskPredictionRequest(
  args: Record<string, unknown>,
  options: { workspaceId: string }
): RegisterTaskPredictionRequest | MetricExpectationBuildError {
  const key = typeof args.idempotency_key === 'string' ? args.idempotency_key.trim() : '';
  if (!key || key.length > 200) return {
    ok: false, field: 'idempotency_key',
    message: 'Task predictions require an idempotency_key of 1 to 200 characters; reuse it when retrying.',
  };
  const body = {
    workspace_id: options.workspaceId,
    ...Object.fromEntries(Object.keys(taskPredictionInputShape).map((field) => [field, args[field]])),
  };
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, field: issue.path.join('.'), message: issue.message };
  }
  return { ok: true, path: TASK_PREDICTIONS_V1_PATH, idempotencyKey: key, body: parsed.data };
}
