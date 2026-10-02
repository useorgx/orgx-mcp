export type SearchDateRange = { created_from?: string; created_to?: string };
export const SEARCH_DATE_PROPERTIES = {
  created_from: { type: 'string', description: 'Inclusive creation-date lower bound, ISO 8601 with timezone. Retention limits still apply.' },
  created_to: { type: 'string', description: 'Inclusive creation-date upper bound, ISO 8601 with timezone.' },
} as const;

export class SearchFilterError extends Error {
  readonly code = 'invalid_search_filters';
}

function timestamp(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new SearchFilterError(`${field} must be an ISO date/time with a timezone.`);
  }
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const days = new Date(Date.UTC(2000 + year % 400, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > days || !Number.isFinite(Date.parse(value))) {
    throw new SearchFilterError(`${field} must be a valid date/time.`);
  }
  return new Date(value).toISOString();
}

/** Inclusive creation timestamps. Never substitute a device timezone on the server. */
export function parseSearchDateRange(input: Record<string, unknown>): SearchDateRange {
  const created_from = timestamp(input.created_from, 'created_from');
  const created_to = timestamp(input.created_to, 'created_to');
  if (created_from && created_to && created_from > created_to) {
    throw new SearchFilterError('Choose an end time at or after the start time.');
  }
  return { ...(created_from ? { created_from } : {}), ...(created_to ? { created_to } : {}) };
}

export function readSearchDateRange(params: URLSearchParams): SearchDateRange {
  return parseSearchDateRange({ created_from: params.get('created_from'), created_to: params.get('created_to') });
}

/** Apply predicates to the database request before ordering, ranking, or pagination. */
export function applySearchDateRange<T>(query: T, range: SearchDateRange, column = 'created_at'): T {
  type Filterable = { gte(column: string, value: string): T; lte(column: string, value: string): T };
  let result = query;
  if (range.created_from) result = (result as T & Filterable).gte(column, range.created_from);
  if (range.created_to) result = (result as T & Filterable).lte(column, range.created_to);
  return result;
}

export function isInSearchDateRange(value: unknown, range: SearchDateRange): boolean {
  if (!range.created_from && !range.created_to) return true;
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) && (!range.created_from || time >= Date.parse(range.created_from)) &&
    (!range.created_to || time <= Date.parse(range.created_to));
}

export function retentionSearchDateRange(range: SearchDateRange, days: number | null, now = Date.now()): SearchDateRange {
  if (days === null) return range;
  const floor = new Date(now - days * 86_400_000).toISOString();
  return { ...range, created_from: range.created_from && range.created_from > floor ? range.created_from : floor };
}
