import { describe, expect, it } from 'vitest';

import {
  classifySearchFailure,
  summarizeSearchPayload,
} from '../src/searchTelemetry';

describe('search telemetry summaries', () => {
  it('counts outcomes, result types, and missing display titles without retaining content', () => {
    const privateTitle = 'Private calibration initiative';
    const summary = summarizeSearchPayload(
      {
        scope: 'initiatives',
        search_mode: 'mixed_relevance',
        query: 'private search query',
        results: [
          { id: 'private-id-1', type: 'initiative', title: privateTitle },
          { id: 'private-id-2', type: 'initiative', title: 'Untitled' },
          { id: 'private-id-3', type: 'task', entity: { name: 'Nested title' } },
        ],
      },
      'all'
    );

    expect(summary).toEqual({
      search_outcome: 'results',
      search_result_count: 3,
      search_results_by_type: { initiative: 2, task: 1 },
      search_missing_title_count: 1,
      search_scope: 'initiatives',
      search_mode: 'mixed_relevance',
    });
    expect(JSON.stringify(summary)).not.toContain(privateTitle);
    expect(JSON.stringify(summary)).not.toContain('private-id');
    expect(JSON.stringify(summary)).not.toContain('private search query');
  });

  it('distinguishes an empty result page from a missing results payload', () => {
    expect(summarizeSearchPayload({ results: [] }).search_outcome).toBe('empty');
    expect(summarizeSearchPayload({ query: 'no rows' }).search_outcome).toBe(
      'missing_results'
    );
  });

  it('reduces backend failures to stable diagnostic classes', () => {
    expect(classifySearchFailure('Active workspace context missing')).toBe('workspace_context_missing');
    expect(classifySearchFailure('OrgX could not identify an active workspace')).toBe(
      'workspace_context_missing'
    );
    expect(classifySearchFailure(new Error('request timed out'))).toBe('timeout');
    expect(classifySearchFailure('database password: secret')).toBe(
      'search_backend_error'
    );
  });
});
