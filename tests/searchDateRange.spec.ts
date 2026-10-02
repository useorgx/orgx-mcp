import { toolCallSchema } from '../src/openaiOutputSchemas/shared';
import { canonicalizeToolCallGuidance } from '../src/toolGuidance';
import { describe, expect, it } from 'vitest';
import { parseSearchDateRange } from '../src/searchDateRange';
import { buildEntityCollectionSearchParams } from '../src/entityCollectionSearch';
import { buildOrgxSearchNextCall, normalizeEntitySearchPage } from '../src/orgxSearch';
describe('server-side search creation bounds', () => {
  it('normalizes zoned inputs and forwards bounds to the collection API', () => {
    const range = parseSearchDateRange({ created_from: '2026-10-02T07:00-05:00', created_to: '2026-10-02T13:00Z' });
    const params = buildEntityCollectionSearchParams({ type: 'task', createdFrom: range.created_from, createdTo: range.created_to, limit: 1 });
    expect(params.get('created_from')).toBe('2026-10-02T12:00:00.000Z');
    expect(params.get('created_to')).toBe('2026-10-02T13:00:00.000Z');
  });
  it.each(['2026-02-30T00:00Z', '2026-10-02', '2026-10-02T07:00', 'secret-value'])('rejects malformed bounds without echoing them: %s', value => {
    expect(() => parseSearchDateRange({ created_to: value })).toThrow(/created_to must/);
    try { parseSearchDateRange({ created_to: value }); } catch (error) { expect(String(error)).not.toContain(value); }
  });
  it('rejects reversed ranges and allows an inclusive point in time', () => {
    expect(() => parseSearchDateRange({ created_from: '2026-10-02T00:00Z', created_to: '2026-10-01T00:00Z' })).toThrow(/end time/);
    expect(() => parseSearchDateRange({ created_from: '2026-10-02T00:00Z', created_to: '2026-10-02T00:00Z' })).not.toThrow();
  });
  it('retains both bounds in the exact next-page call', () => {
    const page = normalizeEntitySearchPage({ data: [{ id: 'one' }], pagination: { total: 2, has_more: true, next_cursor: 'two' } }, { limit: 1 });
    const args = { type: 'task', created_from: '2026-10-01T00:00Z', created_to: '2026-10-02T00:00Z', limit: 1 };
    expect(buildOrgxSearchNextCall(args, page.pagination)).toEqual({ tool: 'orgx_search', args: { ...args, cursor: 'two' } });
  });
});



it('preserves creation bounds through output schemas and legacy guidance', () => {
  const dates = { created_from: '2026-10-01T00:00Z', created_to: '2026-10-02T00:00Z' };
  expect(toolCallSchema.parse({ tool: 'orgx_search', args: { ...dates, cursor: 'next' } }).args).toEqual({ ...dates, cursor: 'next' });
  expect(canonicalizeToolCallGuidance({ tool: 'query_org_memory', args: { query: 'launch', ...dates } }, new Set(['orgx_search']))).toEqual({ tool: 'orgx_search', args: { query: 'launch', ...dates } });
});
