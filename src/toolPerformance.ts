/** Numeric, content-free measurements carried from tool execution to transport. */
export const TOOL_PERFORMANCE_KEYS = [
  'tool_execution_ms', 'api_calls', 'api_attempts', 'api_fallbacks',
  'api_failures', 'api_timeouts', 'api_headers_ms', 'api_body_ms',
] as const;

export function readToolPerformance(records: unknown[]): Record<string, number> {
  if (records.length !== 1) return {};
  const asRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : {};
  const envelope = asRecord(records[0]);
  const result = asRecord(envelope.result ?? envelope);
  const values = asRecord(asRecord(result._meta)['orgx/performance']);
  if (!values || typeof values !== 'object' || Array.isArray(values)) return {};
  return Object.fromEntries(TOOL_PERFORMANCE_KEYS.flatMap((key) => {
    const value = values[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? [[key, value]] : [];
  }));
}
