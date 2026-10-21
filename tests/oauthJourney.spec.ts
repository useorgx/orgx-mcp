import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureWorkerPosthogEvent } from '../src/posthogTelemetry';
import { captureOAuthJourney, handleConsentTrace } from '../src/oauthJourney';
import { safeOAuthDestination } from '../src/oauthJourneyContract';
import { sanitizeWorkerTelemetryProperties } from '../src/workerTelemetryPrivacy';

vi.mock('../src/posthogTelemetry', () => ({ captureWorkerPosthogEvent: vi.fn() }));
const account = '11111111-1111-4111-8111-111111111111';
const attempt = '22222222-2222-4222-8222-222222222222';
const origin = 'https://mcp.useorgx.test';
const request = () => new Request(`${origin}/oauth/consent-trace`);
const journey = { pairingAttemptId: attempt, pairingStartedAt: Date.now() - 1000 };
const identity = { orgxUserId: account, ...journey };

function trace(body: Record<string, unknown>, source = origin) {
  return new Request(`${origin}/oauth/consent-trace`, { method: 'POST',
    headers: { origin: source, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
function env(state: Record<string, unknown> | null = journey, who: Record<string, unknown> | null = identity) {
  return { OAUTH_KV: { get: vi.fn(async (key: string) => {
    const value = key.startsWith('auth_state:') ? state : who;
    return value ? JSON.stringify(value) : null;
  }) } as unknown as KVNamespace };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('OAuth journey privacy and truthful outcomes', () => {
  it('uses only a verified account and separate attempt, preserving timing and destination without secrets', () => {
    captureOAuthJourney({ env: {}, request: request(), journey, identity,
      stage: 'client_return_issued', destination: 'https://user:password@chatgpt.com/connector_platform_oauth_redirect?code=secret#private' });
    const capture = vi.mocked(captureWorkerPosthogEvent).mock.calls[0][0];
    expect(capture).toMatchObject({ distinctId: account, event: 'mcp_pairing_step',
      properties: { pairing_attempt_id: attempt, stage: 'client_return_issued', event_outcome: 'attempt',
        destination_host: 'chatgpt.com', destination_path: '/connector_platform_oauth_redirect', elapsed_ms: expect.any(Number) } });
    expect(JSON.stringify(capture)).not.toMatch(/password|secret|private|state_key/);
  });
  it('normalizes unknown registered paths instead of exporting path credentials', () => {
    expect(safeOAuthDestination('https://example.com/private-token/oauth/callback?code=secret'))
      .toEqual({ destination_host: 'example.com', destination_path: '/other' });
    expect(sanitizeWorkerTelemetryProperties({ destination_path: '/private-token', destination_host: 'host?secret',
      pairing_attempt_id: 'not-a-uuid', state_key: 'secret', email: 'user@example.com' })).toEqual({});
  });
  it.each(['consent_failed', 'consent_expired', 'consent_denied'] as const)('does not mark %s successful', (stage) => {
    captureOAuthJourney({ env: {}, request: request(), journey, identity, stage });
    expect(vi.mocked(captureWorkerPosthogEvent).mock.calls[0][0].properties?.event_outcome).toBe('failure');
  });
  it('keeps unresolved Clerk identifiers anonymous and preserves optout', () => {
    captureOAuthJourney({ env: {}, request: request(), journey,
      identity: { orgxUserId: 'user_clerk', telemetryOptOut: true }, stage: 'consent_viewed' });
    expect(captureWorkerPosthogEvent).toHaveBeenCalledWith(expect.objectContaining({ distinctId: `mcp:${attempt}`, optOut: true }));
  });
});

describe('same-origin consent breadcrumbs', () => {
  it('loads identity and attempt from KV, ignoring forged browser account/correlation', async () => {
    const response = await handleConsentTrace(trace({ state_key: 'opaque-state', stage: 'consent_reviewed',
      orgxUserId: 'attacker', pairing_attempt_id: 'forged', reason: 'arbitrary-secret' }), env());
    expect(response.status).toBe(204);
    expect(captureWorkerPosthogEvent).toHaveBeenCalledWith(expect.objectContaining({ distinctId: account,
      properties: expect.objectContaining({ pairing_attempt_id: attempt, stage: 'consent_reviewed' }) }));
    expect(JSON.stringify(vi.mocked(captureWorkerPosthogEvent).mock.calls)).not.toMatch(/opaque-state|attacker|forged|arbitrary-secret/);
  });
  it('attributes expiry from the remaining verified identity, never a browser claimed identity', async () => {
    expect((await handleConsentTrace(trace({ state_key: 'expired', stage: 'consent_viewed' }), env(null))).status).toBe(410);
    expect(captureWorkerPosthogEvent).toHaveBeenCalledWith(expect.objectContaining({ distinctId: account,
      properties: expect.objectContaining({ stage: 'consent_expired', reason: 'session_expired' }) }));
  });
  it('rejects cross-origin and oversized input before capture', async () => {
    const storage = env();
    expect((await handleConsentTrace(trace({ state_key: 'state', stage: 'consent_viewed' }, 'https://attacker.example'), storage)).status).toBe(403);
    expect(storage.OAUTH_KV.get).not.toHaveBeenCalled();
    expect((await handleConsentTrace(trace({ state_key: 'state', stage: 'consent_viewed', secret: 'x'.repeat(3000) }), storage)).status).toBe(413);
    expect(captureWorkerPosthogEvent).not.toHaveBeenCalled();
  });
  it('remains compatible with pre-rollout state without an attempt ID', async () => {
    expect((await handleConsentTrace(trace({ state_key: 'old-state', stage: 'consent_viewed' }), env({}, { orgxUserId: account }))).status).toBe(204);
    expect(vi.mocked(captureWorkerPosthogEvent).mock.calls[0][0].properties).not.toHaveProperty('pairing_attempt_id');
  });
});
