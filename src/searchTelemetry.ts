const ENTITY_TYPES = new Set([
  'agent',
  'artifact',
  'decision',
  'initiative',
  'milestone',
  'objective',
  'plan_session',
  'run',
  'task',
  'workspace',
  'workstream',
]);

const SEARCH_SCOPES = new Set([
  'all',
  'artifacts',
  'decisions',
  'initiatives',
]);

export type SearchTelemetry = {
  search_outcome: 'results' | 'empty' | 'missing_results';
  search_result_count: number | null;
  search_results_by_type: Record<string, number>;
  search_missing_title_count: number | null;
  search_scope: string;
  search_mode: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeLabel(value: unknown, allowed: Set<string>): string {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.trim().toLowerCase().replace(/-/g, '_');
  return allowed.has(normalized) ? normalized : 'other';
}

function hasDisplayTitle(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  const nested = [record.entity, record.record, record.data]
    .map(asRecord)
    .find(Boolean);
  return [
    record.title,
    record.name,
    record.label,
    record.display_name,
    record.displayName,
    record.entity_title,
    record.entityTitle,
    record.initiative_title,
    record.artifact_title,
    nested?.title,
    nested?.name,
    nested?.label,
  ].some(
    (candidate) =>
      typeof candidate === 'string' &&
      candidate.trim().length > 0 &&
      !/^untitled$/i.test(candidate.trim())
  );
}

export function summarizeSearchPayload(
  payload: unknown,
  requestedScope?: unknown,
  fallbackMode = 'unknown'
): SearchTelemetry {
  const root = asRecord(payload);
  const results = Array.isArray(root?.results) ? root.results : null;
  const resultsByType: Record<string, number> = {};
  for (const result of results ?? []) {
    const record = asRecord(result);
    const type = safeLabel(record?.type ?? record?.entity_type, ENTITY_TYPES);
    resultsByType[type] = (resultsByType[type] ?? 0) + 1;
  }

  const rawMode = root?.search_mode ?? fallbackMode;
  const mode =
    rawMode === 'typed_collection' ||
    rawMode === 'mixed_relevance' ||
    rawMode === 'memory_hybrid'
      ? rawMode
      : 'unknown';

  return {
    search_outcome:
      results === null
        ? 'missing_results'
        : results.length > 0
          ? 'results'
          : 'empty',
    search_result_count: results?.length ?? null,
    search_results_by_type: resultsByType,
    search_missing_title_count:
      results === null
        ? null
        : results.filter((result) => !hasDisplayTitle(result)).length,
    search_scope: safeLabel(root?.scope ?? requestedScope, SEARCH_SCOPES),
    search_mode: mode,
  };
}

export function classifySearchFailure(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  const normalized = message.toLowerCase();
  if (
    /workspace.{0,32}(missing|unavailable|context)/.test(normalized) ||
    /active workspace|could not identify.{0,24}workspace/.test(normalized)
  ) {
    return 'workspace_context_missing';
  }
  if (/auth|unauthorized|forbidden|\b401\b|\b403\b/.test(normalized)) {
    return 'auth_required';
  }
  if (/timeout|timed out|abort/.test(normalized)) return 'timeout';
  if (/invalid|must be|is required/.test(normalized)) return 'invalid_input';
  return 'search_backend_error';
}
