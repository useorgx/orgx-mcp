export type OrgxSearchArgs = Record<string, unknown>;

export type EntitySearchPagination = {
  total: number | null;
  limit: number;
  offset: number;
  has_more: boolean;
  next_offset: number | null;
  next_cursor: string | null;
  previous_cursor: string | null;
};

export type EntitySearchPage = {
  records: Array<Record<string, unknown>>;
  pagination: EntitySearchPagination;
};

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

export type EntityStatusFilterResult = {
  records: Array<Record<string, unknown>>;
  dropped: number;
};

/**
 * Enforce explicit lifecycle and risk filters at the MCP boundary.
 * The upstream API stores at-risk state in risk_level and has historically
 * ignored the status alias, so callers must never receive contradictory rows.
 */
export function filterEntitySearchRecords(
  records: Array<Record<string, unknown>>,
  requestedStatus?: string | null
): EntityStatusFilterResult {
  const status = nonEmptyString(requestedStatus);
  if (!status) return { records, dropped: 0 };

  const filtered = records.filter((record) =>
    status === 'at_risk'
      ? record.risk_level === 'at_risk'
      : record.status === status
  );
  return {
    records: filtered,
    dropped: records.length - filtered.length,
  };
}

export function normalizeEntitySearchPage(
  payload: unknown,
  request: { limit?: number; offset?: number }
): EntitySearchPage {
  const root =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const records = Array.isArray(root.data)
    ? root.data.filter(
        (record): record is Record<string, unknown> =>
          Boolean(record && typeof record === 'object' && !Array.isArray(record))
      )
    : [];
  const rawPagination =
    root.pagination &&
    typeof root.pagination === 'object' &&
    !Array.isArray(root.pagination)
      ? (root.pagination as Record<string, unknown>)
      : {};
  const limit =
    finiteNonNegative(rawPagination.limit) ??
    finiteNonNegative(request.limit) ??
    Math.max(records.length, 20);
  const offset =
    finiteNonNegative(rawPagination.offset) ??
    finiteNonNegative(request.offset) ??
    0;
  const total = finiteNonNegative(rawPagination.total);
  const inferredHasMore = total !== null && offset + records.length < total;
  const hasMore =
    rawPagination.has_more === true ||
    (rawPagination.has_more !== false && inferredHasMore);
  const nextOffset = hasMore
    ? finiteNonNegative(rawPagination.next_offset) ?? offset + limit
    : null;

  return {
    records,
    pagination: {
      total,
      limit,
      offset,
      has_more: hasMore,
      next_offset: nextOffset,
      next_cursor: hasMore
        ? nonEmptyString(rawPagination.next_cursor)
        : null,
      previous_cursor: nonEmptyString(rawPagination.previous_cursor),
    },
  };
}

const SEARCH_ARG_KEYS = [
  'query',
  'type',
  'status',
  'initiative_id',
  'workspace_id',
  'limit',
  'fields',
  'session_id',
] as const;

export function buildOrgxSearchNextCall(
  args: OrgxSearchArgs,
  pagination: EntitySearchPagination
): { tool: 'orgx_search'; args: OrgxSearchArgs } | null {
  if (!pagination.has_more) return null;
  const nextArgs: OrgxSearchArgs = {};
  for (const key of SEARCH_ARG_KEYS) {
    if (args[key] !== undefined) nextArgs[key] = args[key];
  }
  nextArgs.limit = pagination.limit;
  if (pagination.next_cursor) {
    nextArgs.cursor = pagination.next_cursor;
  } else if (pagination.next_offset !== null) {
    nextArgs.offset = pagination.next_offset;
  } else {
    return null;
  }
  return { tool: 'orgx_search', args: nextArgs };
}

export function buildBroadSearchPagination(limit: number, returned: number) {
  return {
    mode: 'relevance_window' as const,
    total: null,
    limit,
    offset: 0,
    returned,
    has_more: false,
    next_offset: null,
    next_cursor: null,
    previous_cursor: null,
    exhaustive: false,
  };
}

