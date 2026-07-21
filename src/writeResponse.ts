type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : null;
}

function readId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * Give every orgx_write response the same chainable identity envelope.
 *
 * The entities API correctly returns the created row under `data`, while a
 * few relationship writers also echo its fields at the top level. MCP callers
 * should not need to know which storage path created the entity. Keeping the
 * original payload and adding `id` / `entity_id` makes the UUID available to
 * both structured clients and the concise text formatter.
 */
export function canonicalizeOrgxWriteResponse(
  result: RecordLike,
  type: unknown,
): RecordLike {
  const data = asRecord(result.data);
  const entity = asRecord(result.entity);
  const existing = asRecord(result.existing);
  const id =
    readId(result.id) ??
    readId(result.entity_id) ??
    readId(data?.id) ??
    readId(entity?.id) ??
    readId(existing?.id);

  return {
    ...result,
    ...(typeof type === "string" && type.trim().length > 0
      ? { type: type.trim() }
      : {}),
    ...(id ? { id, entity_id: id } : {}),
  };
}
