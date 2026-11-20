import { z } from 'zod';

const recordType = z.enum(['initiative', 'workstream', 'task']);
const recordId = z.string().uuid();
const recommendationTarget = z.object({
  entityType: recordType,
  key: recordId,
  metadata: z.object({ nextTaskId: recordId.nullish() }).nullish(),
});

export const recommendationContextCall = z.object({
  tool: z.literal('orgx_inspect'),
  args: z.object({ type: recordType, id: recordId }),
});

/** A ranked item's id identifies the recommendation. Its key identifies the work record. */
export function inspectRecommendedWork(nextAction: unknown): z.infer<typeof recommendationContextCall> | null {
  const parsed = recommendationTarget.safeParse(nextAction);
  if (!parsed.success) return null;
  const { entityType, key, metadata } = parsed.data;
  const taskId = entityType === 'workstream' && metadata?.nextTaskId;
  return {
    tool: 'orgx_inspect',
    args: taskId ? { type: 'task', id: taskId } : { type: entityType, id: key },
  };
}
