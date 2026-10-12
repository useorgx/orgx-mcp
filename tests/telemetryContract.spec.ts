import { describe, it, expect } from 'vitest';
import { canonicalAccountId, posthogProfile, telemetryAudience, safeCorrelation, invocationOutcome } from '../src/telemetryContract';
describe('shared telemetry contract', () => {
  it('rejects external identities and never guesses audience', () => {
    expect(canonicalAccountId('user_abc')).toBeUndefined(); expect(canonicalAccountId('a@example.com')).toBeUndefined();
    expect(telemetryAudience('hope@useorgx.com')).toBe('unknown'); expect(telemetryAudience('test')).toBe('test');
    expect(posthogProfile({ email: 'a@example.com', token: 'secret', telemetry_audience: 'staff' })).toEqual({ email: 'a@example.com', identity_namespace: 'orgx_account' });
  });
  it('leaves loading values and absent classification untouched, with explicit clearing only', () => {
    expect(posthogProfile({ email: null, name: null, plan: '', telemetry_audience: undefined })).toEqual({ identity_namespace: 'orgx_account' });
    expect(posthogProfile({ telemetry_audience: 'unknown' })).not.toHaveProperty('telemetry_audience');
    expect(posthogProfile({ telemetry_audience: 'internal', name: 'Existing Person' })).toMatchObject({ telemetry_audience: 'internal', name: 'Existing Person' });
    expect(posthogProfile({}, { clearProperties: ['name'] })).toMatchObject({ name: null });
  });
  it('accepts only bounded correlation and observed business success', () => {
    expect(safeCorrelation('customer-private-data', 'uuid')).toBeUndefined(); expect(safeCorrelation('0'.repeat(32), 'trace')).toBeUndefined();
    expect(invocationOutcome('error', true)).toBe('failure'); expect(invocationOutcome('success', false)).toBe('unknown');
    expect(invocationOutcome('success', true)).toBe('success');
  });
});
