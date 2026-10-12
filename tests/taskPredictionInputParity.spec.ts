import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { taskPredictionInputShape, taskPredictionOutputSchema } from '../src/taskPredictionContract';
import { RegisterTaskPredictionSchema, TaskPredictionSchema } from '../src/generated/taskPrediction';
import fixtures from './fixtures/task-prediction-v1.json';

const requestSchema = z.object({ workspace_id: z.string().uuid(), ...taskPredictionInputShape }).strict();
describe('task prediction input compatibility', () => {
  it.each([Number.NaN, Infinity, -Infinity])('refuses nonfinite confidence %s', (confidence) => {
    const request = { ...fixtures.find((fixture) => fixture.name === 'request accepted')!.input, confidence };
    expect(requestSchema.safeParse(request).success).toBe(false);
  });
  it.each(fixtures)('$name', (fixture) => {
    const schema = fixture.mode === 'request' ? requestSchema : taskPredictionOutputSchema;
    const parsed = schema.safeParse(fixture.input);
    const actual = parsed.success ? { ok: true, data: parsed.data } : { ok: false, issues: parsed.error.issues.map(({ code, path, message }) => ({ code, path, message })) };
    expect(actual).toEqual(fixture.mcp);
  });
  it('keeps strict canonical responses and the original per-index edge diagnostics', () => {
    const duplicate = fixtures.find((fixture) => fixture.name === 'duplicate response criteria')!.input;
    const coreProfile = TaskPredictionSchema.safeParse(duplicate);
    const edgeProfile = taskPredictionOutputSchema.safeParse(duplicate);
    expect(coreProfile.success).toBe(false);
    expect(edgeProfile.success).toBe(false);
    if (!coreProfile.success) expect(coreProfile.error.issues).toMatchObject([{ path: ['criteria_predictions'], message: 'Criterion predictions must be unique' }]);
    if (!edgeProfile.success) expect(edgeProfile.error.issues).toMatchObject([{ path: ['criteria_predictions', 1, 'criterion_id'], message: 'Each criterion_id must occur once' }]);
    const additive = fixtures.find((fixture) => fixture.name === 'additive response JSON')!.input;
    expect(TaskPredictionSchema.safeParse(additive).success).toBe(false);
    expect(taskPredictionOutputSchema.safeParse(additive).success).toBe(true);
    const request = fixtures.find((fixture) => fixture.name === 'unknown request authority field')!.input;
    expect(RegisterTaskPredictionSchema.safeParse(request).success).toBe(false);
    expect(requestSchema.safeParse(request).success).toBe(false);
  });
});
