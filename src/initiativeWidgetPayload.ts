type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function hasRenderableHierarchy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  const record = asRecord(value);
  if (!record) return false;
  return Array.isArray(record.workstreams) && record.workstreams.length > 0;
}

export function buildInitiativeListWidgetPayload(
  payload: Record<string, unknown>
): Record<string, unknown> | null {
  if (payload.type !== 'initiative') return null;

  const rows = Array.isArray(payload.data) ? payload.data : [];
  if (rows.length !== 1) return null;

  const initiative = asRecord(rows[0]);
  if (!initiative) return null;

  const hierarchy =
    payload.hierarchy ??
    initiative.hierarchy ??
    (Array.isArray(initiative.workstreams)
      ? {
          initiative,
          workstreams: initiative.workstreams,
        }
      : null);

  if (!hasRenderableHierarchy(hierarchy)) return null;

  return {
    ...payload,
    initiative,
    hierarchy,
    agent_assignment:
      payload.agent_assignment ?? initiative.agent_assignment ?? undefined,
    streams: payload.streams ?? initiative.streams ?? undefined,
  };
}
