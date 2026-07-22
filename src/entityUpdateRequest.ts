export interface EntityUpdateRequestInput {
  type: string;
  id: string;
  fields: Record<string, unknown>;
  idempotencyKey?: unknown;
}

export interface EntityUpdateRequest {
  path: string;
  init: RequestInit;
}

function normalizeIdempotencyKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Build an entity PATCH without mixing request controls into entity fields.
 *
 * The entities API validates every non-type/id body property as an entity field,
 * so retry controls must travel as headers. Fields supplied inside `fields` are
 * deliberately preserved (including invalid fields other than protected type/id
 * controls) for the API to validate.
 */
export function buildEntityUpdateRequest(
  input: EntityUpdateRequestInput
): EntityUpdateRequest {
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const headers = idempotencyKey
    ? { 'Idempotency-Key': idempotencyKey }
    : undefined;

  if (input.type === 'workspace') {
    return {
      path: `/api/workspaces/${encodeURIComponent(input.id)}`,
      init: {
        method: 'PATCH',
        ...(headers ? { headers } : {}),
        body: JSON.stringify(input.fields),
      },
    };
  }

  return {
    path: '/api/entities',
    init: {
      method: 'PATCH',
      ...(headers ? { headers } : {}),
      body: JSON.stringify({
        ...input.fields,
        type: input.type,
        id: input.id,
      }),
    },
  };
}
