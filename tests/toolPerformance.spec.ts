import { describe, expect, it } from 'vitest';
import { readToolPerformance } from '../src/toolPerformance';

describe('tool performance response projection', () => {
  it('accepts only finite, nonnegative numeric measurements', () => {
    expect(readToolPerformance([{ result: { _meta: { 'orgx/performance': {
      tool_execution_ms: 1200, api_calls: 2, api_attempts: 3,
      api_fallbacks: 1, api_headers_ms: 900, api_body_ms: 20,
      api_failures: -1, api_timeouts: 'secret', raw_url: 'private',
    } } } }])).toEqual({
      tool_execution_ms: 1200, api_calls: 2, api_attempts: 3,
      api_fallbacks: 1, api_headers_ms: 900, api_body_ms: 20,
    });
    expect(readToolPerformance([null])).toEqual({});
    expect(readToolPerformance([{ _meta: { 'orgx/performance': {
      api_body_ms: Infinity, api_calls: NaN,
    } } }])).toEqual({});
  });

  it('never attributes several response records to a single tool', () => {
    const record = { result: { _meta: { 'orgx/performance': { api_calls: 1 } } } };
    expect(readToolPerformance([record, record])).toEqual({});
  });
});
