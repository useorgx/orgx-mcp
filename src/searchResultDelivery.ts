import { summarizeSearchPayload, type SearchTelemetry } from './searchTelemetry';
import { normalizeMemorySearchPayload } from './orgxSearch';
import { buildSearchRecovery } from './searchRecovery';

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

/** Classify every delivery path identically, without retaining user text. */
export function readSearchDelivery(toolId: string, result: SearchResult | null | undefined) {
  if (!SEARCH_TOOLS.has(toolId) || !result) return null;
  const root = record(result.structuredContent);
  const rawPayload = Array.isArray(root?.results) ? root : record(root?.data) ?? root;
  const payload = rawPayload ? normalizeMemorySearchPayload(rawPayload) : null;
  // The work ledger uses its own template/contract, not the search widget.
  if (payload?.scope === 'work_ledger') return null;
  // Legacy memory also returns hydrated entities without search rows.
  // Preserve that API-owned contract rather than inventing a failure.
  if (toolId === 'query_org_memory' && !Array.isArray(payload?.results) &&
      !Array.isArray(payload?.decisions) && !Array.isArray(payload?.recommendations) &&
      !payload?.next_action && result.isError !== true && root?.ok !== false &&
      !root?.error && payload?.ok !== false && !payload?.error) return null;
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
  return { payload, observation };
}

/** Preserve the model contract, with recovery shared by model and widget. */
export function prepareSearchResult<T extends SearchResult | null | undefined>(
  toolId: string,
  result: T,
  observe?: (value: SearchDeliveryObservation) => void,
  args: Record<string, unknown> = {}
): T {
  const delivery = readSearchDelivery(toolId, result);
  if (!delivery || !result) return result;
  const { payload, observation } = delivery;
  const { telemetry } = observation;
  const failed = observation.errorKind === 'search_backend_error';
  const invalid = observation.errorKind === 'invalid_search_response';
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
  const recovery = toolId === 'orgx_search' && telemetry.search_outcome === 'empty'
    ? buildSearchRecovery(args, payload?.search_mode === 'typed_collection') : null;
  const content = recovery && Array.isArray(result.content)
    ? [...result.content, { type: 'text', text: [recovery.message, recovery.hint,
      recovery.next_call ? `Suggested next call: ${JSON.stringify(recovery.next_call)}` : ''].filter(Boolean).join('\n') }]
    : result.content;
  return { ...result, content, _meta: { ...result._meta, 'orgx/searchPayload':
    recovery ? { ...payload, search_guidance: recovery } : payload } } as T;
}
