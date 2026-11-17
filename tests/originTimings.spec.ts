import { describe, expect, it } from 'vitest';
import { addOriginTimings, originTimingPerformance, readOriginTimings } from '../src/originTimings';

describe('fixed numeric origin timings', () => {
  it('projects only known canonical stages and omits missing ones', () => {
    expect(readOriginTimings('orgx_mcp_identity;dur=12.25, private_goal;dur=99, orgx_mcp_total;dur=50'))
      .toEqual({ identity: 12.25, total: 50 });
    expect(readOriginTimings(null)).toEqual({});
    expect(readOriginTimings('orgx_mcp_private;dur=12')).toEqual({});
  });
  it.each(['-1', 'Infinity', 'NaN', '1e2', '300001', '00', '.5', '1.2345', '"12"', 'secret'])
  ('drops a noncanonical, negative, nonfinite or excessive duration %s', (duration) => {
    expect(readOriginTimings(`orgx_mcp_total;dur=${duration}`)).toEqual({});
  });
  it('discards ambiguous duplicates, including malformed duplicates, without losing independent phases', () => {
    for (const duplicate of ['dur=5', 'dur=secret', 'dur=1;dur=2']) {
      expect(readOriginTimings(`orgx_mcp_total;dur=10, orgx_mcp_total;${duplicate}, orgx_mcp_identity;dur=0`))
        .toEqual({ identity: 0 });
      expect(readOriginTimings(`orgx_mcp_total;${duplicate}, orgx_mcp_total;dur=10`))
        .toEqual({});
    }
    expect(readOriginTimings('orgx_mcp_total;dur=10;desc="private"')).toEqual({});
    expect(readOriginTimings('other;desc="private,orgx_mcp_total;dur=10,private"')).toEqual({});
  });
  it('bounds header processing and includes the canonical maximum', () => {
    expect(readOriginTimings(`orgx_mcp_total;dur=1,${'x'.repeat(8192)}`)).toEqual({});
    expect(readOriginTimings('orgx_mcp_total;dur=300000')).toEqual({ total: 300000 });
  });
  it('keeps sums and sample counts per phase without treating them as a wall-clock duration', () => {
    const totals = {};
    addOriginTimings(totals, 'orgx_mcp_identity;dur=20,orgx_mcp_total;dur=100');
    addOriginTimings(totals, 'orgx_mcp_total;dur=150');
    expect(originTimingPerformance(totals)).toEqual({
      origin_identity_ms: 20, origin_identity_count: 1,
      origin_total_ms: 250, origin_total_count: 2,
    });
    expect(originTimingPerformance(undefined)).toEqual({});
  });
});
