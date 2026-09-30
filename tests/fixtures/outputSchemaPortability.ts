/**
 * Paths in an advertised JSON Schema where `additionalProperties` is the
 * boolean `true`. Several MCP clients warn on or reject that unconstrained
 * position, so published output schemas express openness with a typed
 * catchall instead.
 */
export function findBooleanAdditionalProperties(
  value: unknown,
  path = '$'
): string[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const matches = record.additionalProperties === true ? [path] : [];
  for (const [key, child] of Object.entries(record)) {
    matches.push(...findBooleanAdditionalProperties(child, `${path}.${key}`));
  }
  return matches;
}
