import { z } from 'zod';

import { jsonValueSchema } from './openaiOutputSchemas/shared';
import type { MetricExpectationBuildError } from './metricExpectationContract';
import { TaskPredictionInputShape, TaskPredictionRecordShape, duplicateCriterionPredictionIndexes } from './generated/taskPrediction';

export const TASK_PREDICTIONS_V1_PATH = '/api/v1/expectations/tasks';

export { CriterionPredictionSchema as criterionPredictionSchema } from './generated/taskPrediction';

export const taskPredictionInputShape = {
  ...TaskPredictionInputShape,
  criteria_predictions: TaskPredictionInputShape.criteria_predictions.superRefine((predictions, context) => {
    for (const index of duplicateCriterionPredictionIndexes(predictions)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'criterion_id'], message: 'Each criterion_id must occur once' });
    }
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
  ...TaskPredictionRecordShape,
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
