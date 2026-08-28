import { describe, expect, it } from 'vitest';

import {
  buildBroadSearchPagination,
  buildOrgxSearchNextCall,
  filterEntitySearchRecords,
  normalizeEntitySearchPage,
} from '../src/orgxSearch';

describe('orgx search pagination', () => {
  it('preserves API cursor pagination in the exact canonical next call', () => {
    const page = normalizeEntitySearchPage(
      {
        data: [{ id: 't-1' }, { id: 't-2' }],
        pagination: {
          total: 5,
          limit: 2,
          offset: 0,
          has_more: true,
          next_cursor: 'cursor-2',
        },
      },
      { limit: 2, offset: 0 }
    );

    expect(page.pagination).toMatchObject({
      total: 5,
      limit: 2,
      has_more: true,
      next_cursor: 'cursor-2',
    });
    expect(
      buildOrgxSearchNextCall(
        { type: 'task', status: 'active', limit: 2, offset: 0 },
        page.pagination
      )
    ).toEqual({
      tool: 'orgx_search',
      args: { type: 'task', status: 'active', limit: 2, cursor: 'cursor-2' },
    });
  });

  it('infers offset continuation only when the API reports a larger total', () => {
    const page = normalizeEntitySearchPage(
      { data: [{ id: 'i-1' }, { id: 'i-2' }], pagination: { total: 5 } },
      { limit: 2, offset: 0 }
    );
    expect(page.pagination).toMatchObject({
      has_more: true,
      next_offset: 2,
      next_cursor: null,
    });
  });

  it('labels mixed relevance results as bounded and non-exhaustive', () => {
    expect(buildBroadSearchPagination(20, 7)).toEqual({
      mode: 'relevance_window',
      total: null,
      limit: 20,
      offset: 0,
      returned: 7,
      has_more: false,
      next_offset: null,
      next_cursor: null,
      previous_cursor: null,
      exhaustive: false,
    });
  });

  it('enforces the at-risk alias and exact lifecycle status filters', () => {
    const records = [
      { id: 'risk', status: 'blocked', risk_level: 'at_risk' },
      { id: 'healthy', status: 'active', risk_level: 'on_track' },
      { id: 'unknown', status: 'draft', risk_level: 'unknown' },
    ];

    expect(filterEntitySearchRecords(records, 'at_risk')).toEqual({
      records: [{ id: 'risk', status: 'blocked', risk_level: 'at_risk' }],
      dropped: 2,
    });
    expect(filterEntitySearchRecords(records, 'active')).toEqual({
      records: [{ id: 'healthy', status: 'active', risk_level: 'on_track' }],
      dropped: 2,
    });
    expect(filterEntitySearchRecords(records, null)).toEqual({
      records,
      dropped: 0,
    });
  });
});
