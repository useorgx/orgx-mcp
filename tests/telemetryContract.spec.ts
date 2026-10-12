import { describe, it, expect } from 'vitest';
import { canonicalAccountId, posthogProfile, telemetryAudience, safeCorrelation, invocationOutcome } from '../src/telemetryContract';
describe('shared telemetry contract', () => {
  it('rejects external identities and never guesses audience', () => {
    expect(canonicalAccountId('user_abc')).toBeUndefined(); expect(canonicalAccountId('a@example.com')).toBeUndefined();
    expect(telemetryAudience('hope@useorgx.com')).toBe('unknown'); expect(telemetryAudience('test')).toBe('test');
    expect(posthogProfile({ email: 'a@example.com', token: 'secret', telemetry_audience: 'staff' })).toEqual({ email: 'a@example.com', telemetry_audience: 'unknown', identity_namespace: 'orgx_account' });
  });
  it('accepts only bounded correlation and observed business success', () => {
    expect(safeCorrelation('customer-private-data', 'uuid')).toBeUndefined(); expect(safeCorrelation('0'.repeat(32), 'trace')).toBeUndefined();
    expect(invocationOutcome('error', true)).toBe('failure'); expect(invocationOutcome('success', false)).toBe('unknown');
    expect(invocationOutcome('success', true)).toBe('success');
  });
});
