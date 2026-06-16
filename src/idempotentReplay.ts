type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

export function readEntityIdempotencyKey(entity: unknown): string | null {
  const record = asRecord(entity);
  if (!record) return null;

  const direct =
    cleanString(record.idempotency_key) ?? cleanString(record.idempotencyKey);
  if (direct) return direct;

  const metadata = asRecord(record.metadata);
  if (!metadata) return null;
  const metadataDirect =
    cleanString(metadata.idempotency_key) ??
    cleanString(metadata.idempotencyKey);
  if (metadataDirect) return metadataDirect;

  const scaffold = asRecord(metadata.scaffold);
  return (
    cleanString(scaffold?.idempotency_key) ??
    cleanString(scaffold?.idempotencyKey)
  );
}

export function entityMatchesIdempotencyKey(
  entity: unknown,
  idempotencyKey: string | null | undefined
): boolean {
  const key = cleanString(idempotencyKey);
  if (!key) return false;
  return readEntityIdempotencyKey(entity) === key;
}
