import { describe, expect, it, vi } from 'vitest';
import { prepareSearchResult } from '../src/searchResultDelivery';

describe('search result delivery contract', () => {
  it.each(['orgx_search', 'query_org_memory'])('keeps %s results out of summary-only host failures', (tool) => {
    const payload = { query: 'private query', results: [{ title: 'Private title', type: 'task' }] };
    const observe = vi.fn();
    const result = prepareSearchResult(tool, { structuredContent: payload, _meta: { existing: true } }, observe);
    expect(result.structuredContent).toBe(payload);
    expect(result._meta).toEqual({ existing: true, 'orgx/searchPayload': payload });
    expect(observe.mock.calls[0][0]).toMatchObject({ failed: false, telemetry: { search_outcome: 'results', search_result_count: 1 } });
    expect(JSON.stringify(observe.mock.calls)).not.toMatch(/private/i);
  });
  it('records a malformed success as a contract failure, never an empty search', () => {
    const observe = vi.fn();
    const result = prepareSearchResult('orgx_search', { structuredContent: { query: 'launch' } }, observe);
    expect(result).toMatchObject({ isError: true, structuredContent: { ok: false, error: { code: 'invalid_search_response' } } });
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ failed: true, errorKind: 'invalid_search_response' }));
  });
  it('treats empty results as healthy and leaves explicit failures untouched', () => {
    const empty = prepareSearchResult('orgx_search', { structuredContent: { results: [] } });
    expect(empty).not.toHaveProperty('isError');
    const error = { isError: true, structuredContent: { error: 'failure' } };
    expect(prepareSearchResult('orgx_search', error)).toBe(error);
  });
  it('leaves work-ledger and unrelated tool contracts untouched', () => {
    const observe = vi.fn();
    const ledger = { structuredContent: { scope: 'work_ledger', entries: [] } };
    expect(prepareSearchResult('orgx_search', ledger, observe)).toBe(ledger);
    expect(prepareSearchResult('orgx_inspect', ledger, observe)).toBe(ledger);
    expect(observe).not.toHaveBeenCalled();
  });
  it.each([{ decisions: [] }, { recommendations: [] }, { next_action: { label: 'Review' } }])('preserves shared memory template modes: %j', payload => {
    expect(prepareSearchResult('query_org_memory', { structuredContent: payload })).not.toHaveProperty('isError');
  });
});
