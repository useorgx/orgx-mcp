import { summarizeSearchPayload, type SearchTelemetry } from './searchTelemetry';
import { normalizeMemorySearchPayload } from './orgxSearch';

const SEARCH_TOOLS = new Set(['orgx_search', 'query_org_memory']);

type SearchResult = {
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  content?: unknown;
};

export type SearchDeliveryObservation = {
  failed: boolean;
  errorKind?: 'invalid_search_response' | 'search_backend_error';
  telemetry: SearchTelemetry;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Preserve the model contract, with a widget-only recovery channel. */
export function prepareSearchResult<T extends SearchResult | null | undefined>(
  toolId: string,
  result: T,
  observe?: (value: SearchDeliveryObservation) => void
): T {
  if (!SEARCH_TOOLS.has(toolId) || !result) return result;
  const root = record(result.structuredContent);
  const rawPayload = Array.isArray(root?.results) ? root : record(root?.data) ?? root;
  const payload = rawPayload ? normalizeMemorySearchPayload(rawPayload) : null;
  // The work ledger uses its own template/contract, not the search widget.
  if (payload?.scope === 'work_ledger') return result;
  const failed = result.isError === true || root?.ok === false || Boolean(root?.error) ||
    payload?.ok === false || Boolean(payload?.error);
  const sharedRows = toolId === 'query_org_memory'
    ? Array.isArray(payload?.decisions) ? payload.decisions :
      Array.isArray(payload?.recommendations) ? payload.recommendations :
      record(payload?.next_action) ? [payload!.next_action] : null
    : null;
  const telemetry = summarizeSearchPayload(sharedRows ? { ...payload, results: sharedRows } : payload, payload?.type ?? payload?.scope);
  const invalid = !failed && telemetry.search_outcome === 'missing_results';
  const observation: SearchDeliveryObservation = {
    failed: failed || invalid,
    ...(failed ? { errorKind: 'search_backend_error' as const } :
      invalid ? { errorKind: 'invalid_search_response' as const } : {}),
    telemetry,
  };
  try { observe?.(observation); } catch { /* telemetry cannot break search */ }
  if (failed) return result;
  if (invalid) {
    return {
      ...result,
      isError: true,
      structuredContent: {
        ok: false,
        error: { code: 'invalid_search_response', message: 'OrgX returned an incomplete search response. Retry the search.' },
      },
      content: [{ type: 'text', text: 'OrgX returned an incomplete search response. Retry the search.' }],
    } as T;
  }
  return { ...result, _meta: { ...result._meta, 'orgx/searchPayload': payload } } as T;
}
